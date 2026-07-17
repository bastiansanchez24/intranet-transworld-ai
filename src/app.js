// ================================
// Zona horaria y Configuración
// ================================
process.env.TZ = "America/Santiago";
require("dotenv").config();

const express = require("express");
const compression = require("compression");
const path = require("path");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const db = require("./db");
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
const { enviarQrHandler } = require("./registro-forms/enviar-qr");
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
app.use(compression());
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

const staticOptions = { maxAge: "1d", etag: true };
app.use(express.static(path.join(__dirname, "public"), staticOptions));
// FIX: Servir archivos estáticos desde <root>/public (donde vive public/uploads unificado)
app.use(express.static(path.join(__dirname, "..", "public"), staticOptions));

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
app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads"), { maxAge: "7d", etag: true }));

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

// Registro de eventos: módulo autónomo (sin mailer/.env de la intranet)
app.get("/registro-forms", (req, res) => {
  res.sendFile(path.join(__dirname, "registro-forms", "registro-forms.html"));
});
app.post("/registro-forms/enviar-qr", enviarQrHandler);

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
