// ================================
// Zona horaria y Configuración
// ================================
process.env.TZ = "America/Santiago";
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const db = require("./db");
const { sendMail } = require("./services/mailer");

// ================================
// Importación de Rutas
// ================================
const authRoutes = require("./routes/auth");
const indexRoutes = require("./routes/index");
const procesosRoutes = require("./routes/procesos");
const personasRoutes = require("./routes/RRHH");
const ticketsRoutes = require("./routes/tickets");
const marketingRoutes = require("./routes/marketing");
const docsRoutes = require("./routes/docs");
const noticiasRoutes = require("./routes/noticias");
const registroRoutes = require("./routes/registro");
const claudeRoutes = require("./routes/claude");
const { ROLES, normalizeRole, isAdministrador } = require("./constants/roles");
const { formatPageTitle } = require("./utils/pageTitle");
const { syncUnverifiedUsersToDisabled } = require("./utils/syncDisabledUsers");
const sharepointService = require("./services/sharepointService");
const { ensureVacationSchema } = require("./services/vacations/vacationSchema");
const vacationRequestService = require("./services/vacations/vacationRequestService");

// ================================
// Inicializar app
// ================================
const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET?.trim();

if (
  process.env.NODE_ENV === "production" ||
  process.env.TRUST_PROXY === "true"
) {
  app.set("trust proxy", 1);
}

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET es obligatorio. Configúralo en el archivo .env.");
}

// ================================
// Motor de vistas + layouts
// ================================
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(expressLayouts);
app.set("layout", "layout");
app.locals.formatPageTitle = formatPageTitle;

// ================================
// Middlewares Básicos
// ================================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Archivos multimedia y documentos desde SharePoint (/content/...)
app.use("/content", async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const relativePath = decodeURIComponent(req.path.replace(/^\//, ""));
  if (!relativePath) return next();

  try {
    const { buffer, contentType } =
      await sharepointService.downloadFile(relativePath);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=300");
    if (req.method === "HEAD") return res.end();
    return res.send(buffer);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).send("Archivo no encontrado");
    }
    console.error("[Content proxy] Error:", err.message || err);
    return res.status(502).send("Error al obtener el archivo");
  }
});

app.use(express.static(path.join(__dirname, "public")));
// FIX: Servir archivos estáticos desde <root>/public (donde vive public/uploads unificado)
app.use(express.static(path.join(__dirname, "..", "public")));

// ================================
// Sesiones
// ================================
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // ¡CLAVE! Renueva el tiempo de la cookie en cada petición al backend
    cookie: { maxAge: 1000 * 60 * 60 * 4 }, // Aumentamos la base a 4 horas por seguridad
  }),
);

// FIX: Unificado → <root>/public/uploads sirve /uploads/*
app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads")));

// ================================
// Variables Globales y Permisos
// ================================
app.use((req, res, next) => {
  const user = req.session.user;

  res.locals.usuario = req.session.user || null;

  if (user) {
    const role = normalizeRole(user.role);
    res.locals.userRole = role;
    res.locals.isAdministrador = isAdministrador(role);

    res.locals.can = {
      procedimientos_write: isAdministrador(role),
      protocolos_write: isAdministrador(role),
      reglamento_write: isAdministrador(role),
      noticias_write: isAdministrador(role),
      personas_write: isAdministrador(role),
      organigrama_write: isAdministrador(role),
      achs_write: isAdministrador(role),
      eventos_write: isAdministrador(role),
      tickets_reply: isAdministrador(role),
      apps_write: isAdministrador(role),
      cursos_write: isAdministrador(role),
      vacaciones_write: isAdministrador(role),
      vacaciones_request:
        role === ROLES.USUARIO || isAdministrador(role),
    };
    res.locals.unreadTickets = req.session.ticketNotifications?.count || 0;
  } else {
    res.locals.can = {};
    res.locals.unreadTickets = 0;
  }
  next();
});

// ================================
// Middleware de protección
// ================================
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect("/login");
}

// ================================
// Montaje de Rutas
// ================================
app.use("/", authRoutes); // Login/Registro (Públicas)
app.get("/registro-forms", (req, res) => {
  const filePath = path.join(__dirname, "views", "registro-forms.html");
  let html = fs.readFileSync(filePath, "utf8");
  const envPayload = JSON.stringify({
    EVENTO_SUPABASE_URL: process.env.EVENTO_SUPABASE_URL || "",
    EVENTO_SUPABASE_ANON_KEY: process.env.EVENTO_SUPABASE_ANON_KEY || "",
  });
  html = html.replace(
    /(<head[^>]*>)/i,
    `$1\n        <script>window.__ENV__ = ${envPayload};</script>`,
  );
  res.type("html").send(html);
});

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.post("/registro-forms/enviar-qr", async (req, res) => {
  console.log("[registro-forms] POST /enviar-qr recibido");
  try {
    const {
      email,
      nombre,
      empresa,
      cargo,
      eventoNombre,
      eventoFecha,
      bloque,
      registroId,
    } = req.body || {};

    const to = String(email || "").trim().toLowerCase();
    const id = String(registroId || "").trim();
    const nombreClean = String(nombre || "").trim();

    if (!to || !to.includes("@")) {
      return res.status(400).json({ ok: false, error: "Email inválido" });
    }
    if (!id || !nombreClean) {
      return res.status(400).json({ ok: false, error: "Datos incompletos" });
    }

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=jpeg&data=${encodeURIComponent(id)}`;
    const evento = String(eventoNombre || "Transworld Connect").trim();
    const fecha = String(eventoFecha || "").trim();
    const metaParts = [cargo, empresa, bloque]
      .map((v) => String(v || "").trim())
      .filter(Boolean);
    const meta = metaParts.join(" · ");
    const ticketShort = id.slice(0, 8).toUpperCase();

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0b1530;font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px;color:#ffffff;">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#a3e635;">Registro confirmado</p>
    <h1 style="margin:0 0 8px;font-size:28px;line-height:1.2;">¡Estás dentro, ${escapeHtml(nombreClean.split(" ")[0])}!</h1>
    <p style="margin:0 0 24px;color:rgba(255,255,255,0.75);font-size:15px;">
      Presenta este código QR en la entrada de <strong style="color:#fff;">${escapeHtml(evento)}</strong>${fecha ? ` · ${escapeHtml(fecha)}` : ""}.
    </p>
    <div style="background:#111d3d;border:1px solid rgba(163,230,53,0.35);border-radius:16px;padding:24px;text-align:center;">
      <img src="${qrUrl}" alt="Código QR de acceso" width="220" height="220" style="display:block;margin:0 auto 16px;border-radius:8px;background:#fff;padding:10px;">
      <p style="margin:0;font-size:14px;color:#fff;font-weight:bold;">${escapeHtml(nombreClean)}</p>
      ${meta ? `<p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.7);">${escapeHtml(meta)}</p>` : ""}
      <p style="margin:12px 0 0;font-size:12px;letter-spacing:0.08em;color:#a3e635;">ID ${escapeHtml(ticketShort)}</p>
    </div>
    <p style="margin:24px 0 0;font-size:12px;color:rgba(255,255,255,0.55);line-height:1.5;">
      Guarda este correo o descarga el QR desde la pantalla de confirmación. Si no solicitaste este registro, puedes ignorar el mensaje.
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.45);">Transworld Power &amp; Telcom SpA</p>
  </div>
</body>
</html>`;

    const text = [
      `Registro confirmado - ${evento}`,
      "",
      `Hola ${nombreClean},`,
      `Tu registro a ${evento}${fecha ? ` (${fecha})` : ""} fue exitoso.`,
      meta ? `Datos: ${meta}` : "",
      `ID: ${ticketShort}`,
      "",
      `Código QR: ${qrUrl}`,
      "",
      "Presenta este código QR en la entrada del evento.",
    ]
      .filter(Boolean)
      .join("\n");

    await sendMail({
      to,
      subject: `Tu QR de acceso · ${evento}`,
      text,
      html,
      skipFooter: true,
      senderName: "Transworld Connect",
    });

    console.log(`[registro-forms] QR enviado a ${to}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[registro-forms] Error enviando QR:", err.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "No se pudo enviar el correo" });
  }
});

app.use("/registro", registroRoutes);
// Rutas Protegidas
app.use("/", requireAuth, indexRoutes);
app.use("/procesos", requireAuth, procesosRoutes);
app.use("/RRHH", requireAuth, personasRoutes);
app.use("/sistemas", requireAuth, ticketsRoutes);
app.use("/marketing", requireAuth, marketingRoutes);
app.use("/docs", requireAuth, docsRoutes);
app.use("/noticias", requireAuth, noticiasRoutes);
app.use("/claude", requireAuth, claudeRoutes);

// Manejo de 404
app.use((req, res) => {
  res.status(404).render("404", { titulo: "Página no encontrada" });
});

// ==========================================
// TAREA 1: CERRAR TICKETS ANTIGUOS
// ==========================================
function iniciarTareaCierreTickets() {
  const ejecutarCierre = async () => {
    try {
      const sql = `
        UPDATE support_tickets 
        SET status = 'closed', closed_at = NOW(), auto_closed = TRUE
        WHERE status = 'pending_close' 
        AND resolved_at < (NOW() - INTERVAL '1 day')
      `;

      const result = await db.query(sql);
      const afectados = result.rowCount || result.affectedRows || 0;

      if (afectados > 0) {
        console.log(
          `[CRON] Se cerraron automáticamente ${afectados} tickets en "Pendiente de cierre" hace más de 1 día.`,
        );
      }
    } catch (err) {
      console.error("[CRON] Error en tarea automática de tickets:", err);
    }
  };

  // Ejecutar inmediatamente al iniciar el servidor para limpiar los tickets rezagados
  ejecutarCierre();

  // Y luego continuar ejecutando la revisión cada 1 hora
  setInterval(ejecutarCierre, 3600000);
}

// ==========================================
// TAREA 2: LIMPIEZA DE HISTORIAL
// ==========================================
function iniciarLimpiezaHistorial() {
  const ejecutarLimpieza = async () => {
    try {
      const sql = `
        DELETE FROM change_log 
        WHERE created_at < (NOW() - INTERVAL '5 days')
      `;

      const result = await db.query(sql);
      const borrados = result.rowCount || result.affectedRows || 0;

      if (borrados > 0) {
        console.log(
          `[CRON] Limpieza ejecutada: Se eliminaron ${borrados} registros antiguos.`,
        );
      }
    } catch (err) {
      console.error("[CRON] Error en tarea de limpieza de historial:", err);
    }
  };

  // Ejecutar inmediatamente al iniciar
  ejecutarLimpieza();

  // Y luego cada 12 horas
  setInterval(ejecutarLimpieza, 43200000);
}

// ==========================================
// TAREA 3: TRANSICIONES DE ESTADO DE VACACIONES
// ==========================================
function iniciarTransicionesVacaciones() {
  const ejecutar = async () => {
    try {
      const { inProgress, completed } =
        await vacationRequestService.runDailyStatusTransitions();
      if (inProgress > 0 || completed > 0) {
        console.log(
          `[CRON] Vacaciones: ${inProgress} en curso, ${completed} completadas.`,
        );
      }
    } catch (err) {
      console.error("[CRON] Error en transiciones de vacaciones:", err.message);
    }
  };

  ejecutar();
  // Cada 12 horas
  setInterval(ejecutar, 43200000);
}

// ================================
// INICIAR CRON JOBS
// ================================
iniciarTareaCierreTickets();
iniciarLimpiezaHistorial();

async function sincronizarUsuariosDeshabilitados() {
  try {
    const actualizados = await syncUnverifiedUsersToDisabled();
    if (actualizados > 0) {
      console.log(
        `[Usuarios] ${actualizados} colaborador(es) actualizados a Deshabilitado (sin correo o sin verificar).`,
      );
    }
  } catch (err) {
    console.error("[Usuarios] Error sincronizando roles:", err.message);
  }
}

// El correo es identificador único de usuario: la BD lo garantiza con un
// índice único (ignora mayúsculas/minúsculas y espacios).
async function asegurarCorreoUnico() {
  try {
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
      ON users (LOWER(TRIM(email)))
      WHERE email IS NOT NULL AND TRIM(email) <> ''
    `);
  } catch (err) {
    console.error(
      "[Usuarios] No se pudo asegurar el índice único de email (¿correos duplicados en la BD?):",
      err.message,
    );
  }
}

async function asegurarColumnaNoticiasDestacada() {
  try {
    await db.query(`
      ALTER TABLE news_articles
        ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_news_articles_featured ON news_articles (featured)
        WHERE featured = true
    `);
  } catch (err) {
    console.error(
      "[Noticias] No se pudo asegurar la columna destacada:",
      err.message,
    );
  }
}

// ================================
// INICIAR SERVIDOR
// ================================
async function asegurarSchemaVacaciones() {
  try {
    await ensureVacationSchema();
  } catch (err) {
    console.error(
      "[Vacaciones] No se pudo asegurar el schema del módulo:",
      err.message,
    );
  }
}

app.listen(PORT, () => {
  console.log(`Servidor de Intranet corriendo en puerto ${PORT}`);
});

// Migraciones y sincronización en background (no bloquean el arranque del servidor).
Promise.allSettled([
  asegurarCorreoUnico(),
  asegurarColumnaNoticiasDestacada(),
  sincronizarUsuariosDeshabilitados(),
  asegurarSchemaVacaciones(),
]).finally(() => {
  iniciarTransicionesVacaciones();
});
