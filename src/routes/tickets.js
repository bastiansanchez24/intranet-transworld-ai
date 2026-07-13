const express = require("express");
const router = express.Router();
const db = require("../db");
const { sendMail } = require("../services/mailer");
const requireRole = require("../middlewares/requireRole");
const { isAdministrador } = require("../constants/roles");
const multer = require('multer');
const {
  ticketStatusToDb,
  ticketStatusFromDb,
  ticketPriorityToDb,
  mapTicketReplyForView,
} = require("../utils/schemaMappers");
const fileStorage = require('../services/fileStorage');
const holidayService = require("../services/vacations/holidayService");
const {
  countBusinessMinutes,
  formatBusinessDuration,
  getSantiagoDateOnly,
} = require("../utils/businessHours");

const storage = multer.memoryStorage();
const upload = multer({ storage });

const TICKET_LIST_SQL = `
      SELECT t.id,
             t.title,
             t.category,
             t.priority,
             t.status,
             t.requester_name,
             t.requester_email,
             t.read_by_admin,
             t.read_by_user,
             t.assigned_to,
             t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago' AS created_at,
             (SELECT MAX(created_at) FROM ticket_replies WHERE ticket_id = t.id) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago' AS fecha_ultima_respuesta
      FROM support_tickets t
`;

const EMAIL_SUPPORT = "soporte@transworld.cl";
const NOTIFICATION_COUNT_TTL_MS = 30 * 1000;

function getNotificationCacheKey(user) {
  const scope = isAdministrador(user.role) ? "admin" : user.email || user.username;
  return `${isAdministrador(user.role) ? "admin" : "user"}:${scope || "anonymous"}`;
}

function invalidateNotificationCount(req) {
  if (req.session) delete req.session.ticketNotifications;
}

// ==========================================
// HELPER: HTML DE CORREO
// ==========================================
function generarHtmlCorreo(mensaje, adjuntosJSON) {
  const previewText = mensaje.replace(/\n/g, " ").substring(0, 130) + "...";

  let html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff;">
  
  <div style="display: none; max-height: 0px; overflow: hidden; opacity: 0; font-size: 0px; line-height: 0px; color: #ffffff;">
    ${previewText}
  </div>

  <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.5; max-width: 650px; margin: 0 auto; padding: 15px;">
    <p>${mensaje.replace(/\n/g, "<br>")}</p>`;

  let archivos = [];
  try {
    if (adjuntosJSON) archivos = JSON.parse(adjuntosJSON);
  } catch (e) {}

  if (archivos.length > 0) {
    html += `<div style="margin-top: 20px; padding: 15px; background-color: #f8f9fa; border: 1px solid #e9ecef; border-radius: 5px;">`;
    html += `<p style="font-weight: bold; margin-top: 0; margin-bottom: 10px;">Archivos Adjuntos:</p>`;
    html += `<ul style="list-style-type: none; padding: 0; margin: 0;">`;

    archivos.forEach((a) => {
      let label = "Archivo";
      if (a.tipo === "image") {
        label = "Imagen";
      }
      if (a.tipo === "video") {
        label = "Video";
      }

      html += `<li style="margin-bottom: 8px;">
        <strong>[${label}]:</strong> 
        <a href="${a.url}" target="_blank" style="color: #0056b3; text-decoration: underline; font-weight: bold;">
          ${a.nombre || "Ver archivo"}
        </a>
      </li>`;
    });

    html += `</ul></div>`;
  }

  html += `
  </div>
</body>
</html>`;
  return html;
}

function generarTextoCorreo(mensaje, adjuntosJSON) {
  let texto = mensaje;
  let archivos = [];
  try {
    if (adjuntosJSON) archivos = JSON.parse(adjuntosJSON);
  } catch (e) {}
  if (archivos.length > 0) {
    texto += `\n\n--- Adjuntos ---`;
    archivos.forEach((a) => {
      texto += `\n[${a.tipo}]: ${a.nombre} -> ${a.url}`;
    });
  }
  return texto;
}

// ==========================================
// RUTAS DEL MÓDULO
// ==========================================

router.get("/", (req, res) => {
  res.render("sistemas/index", { titulo: "Sistemas", user: req.session.user });
});

router.get("/tickets/notificaciones/count", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.json({ count: 0 });

  res.set("Cache-Control", "no-store");
  const userEmail = user.email || user.username;
  const cacheKey = getNotificationCacheKey(user);
  const cached = req.session.ticketNotifications;
  if (
    cached &&
    cached.key === cacheKey &&
    cached.expiresAt > Date.now()
  ) {
    return res.json({ count: cached.count, cached: true });
  }

  try {
    let sql = "";
    let params = [];

    if (isAdministrador(user.role)) {
      sql = `SELECT COUNT(*) FROM support_tickets WHERE read_by_admin = FALSE`;
    } else {
      sql = `SELECT COUNT(*) FROM support_tickets WHERE (requester_email = $1 OR requester_name = $1) AND read_by_user = FALSE`;
      params = [userEmail];
    }

    const { rows } = await db.query(sql, params);
    const count = parseInt(rows[0].count, 10) || 0;
    req.session.ticketNotifications = {
      key: cacheKey,
      count,
      expiresAt: Date.now() + NOTIFICATION_COUNT_TTL_MS,
    };
    res.json({ count, cached: false });
  } catch (err) {
    console.error("Error contando notificaciones:", err);
    res.json({ count: 0 });
  }
});

router.get("/tickets", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/login");

  const userEmail = user.email || user.username;

  let sql = "";
  let params = [];

  if (isAdministrador(user.role)) {
    sql = `${TICKET_LIST_SQL} ORDER BY t.created_at DESC`;
  } else {
    sql = `${TICKET_LIST_SQL} WHERE t.requester_email = $1 OR t.requester_name = $1 ORDER BY t.created_at DESC`;
    params = [userEmail];
  }

  try {
    const { rows: results } = await db.query(sql, params);

    let holidaySet = new Set();
    const ticketsWithResponse = results.filter(
      (t) => t.created_at && t.fecha_ultima_respuesta,
    );
    if (ticketsWithResponse.length > 0) {
      const rangeStart = ticketsWithResponse.reduce((min, t) => {
        const d = getSantiagoDateOnly(new Date(t.created_at));
        return d < min ? d : min;
      }, getSantiagoDateOnly(new Date(ticketsWithResponse[0].created_at)));
      const rangeEnd = ticketsWithResponse.reduce((max, t) => {
        const d = getSantiagoDateOnly(new Date(t.fecha_ultima_respuesta));
        return d > max ? d : max;
      }, getSantiagoDateOnly(new Date(ticketsWithResponse[0].fecha_ultima_respuesta)));
      holidaySet = await holidayService.getHolidaySet("CL", rangeStart, rangeEnd);
    }

    const tickets = results.map((ticket) => {
      if (!ticket.created_at || !ticket.fecha_ultima_respuesta) {
        return { ...ticket, tiempo_respuesta: "-", tiempo_respuesta_minutos: null };
      }
      const minutos = countBusinessMinutes(
        ticket.created_at,
        ticket.fecha_ultima_respuesta,
        holidaySet,
      );
      return {
        ...ticket,
        tiempo_respuesta: formatBusinessDuration(minutos),
        tiempo_respuesta_minutos: minutos,
      };
    });

    res.render("sistemas/tickets", {
      titulo: "Soporte",
      tickets,
      user: user,
      extraCss: ["/css/tickets.css"],
      extraJs: ["/js/tickets-list.js"],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error consultando tickets");
  }
});

router.get("/tickets/nuevo", (req, res) => {
  res.render("sistemas/ticket_nuevo", {
    titulo: "Abrir Nuevo Ticket",
    user: req.session.user,
    extraCss: ["/css/tickets.css"],
  });
});

router.post("/tickets/crear", async (req, res) => {
  const title = req.body.title ?? req.body.titulo;
  const description = req.body.description ?? req.body.descripcion;
  const category = req.body.category ?? req.body.categoria;
  const priority = ticketPriorityToDb(req.body.priority ?? req.body.prioridad);
  const { adjuntos_data } = req.body;
  if (!req.session.user) return res.redirect("/login");

  try {
    const { rows: userRows } = await db.query(
      "SELECT first_name, last_name, email FROM users WHERE id = $1",
      [req.session.user.id],
    );
    const u = userRows[0];
    const requesterName =
      u.first_name + (u.last_name ? " " + u.last_name : "");
    const requesterEmail = u.email;

    const sql = `
      INSERT INTO support_tickets (title, description, category, priority, status, requester_name, requester_email, attachments, read_by_admin, read_by_user) 
      VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, FALSE, TRUE) 
      RETURNING id
    `;

    const { rows } = await db.query(sql, [
      title,
      description,
      category,
      priority,
      requesterName,
      requesterEmail,
      adjuntos_data || "[]",
    ]);
    const nuevoId = rows[0].id;

    if (process.env.ADMIN_NOTIFY_EMAIL) {
      let mensajeBase = `Ticket generado por ${requesterName}\n\nTitulo: ${title}\n\nDescripción: ${description}`;
      sendMail({
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `Nuevo Ticket #${nuevoId}: ${title}`,
        text: generarTextoCorreo(mensajeBase, adjuntos_data),
        html: generarHtmlCorreo(mensajeBase, adjuntos_data),
        bcc: EMAIL_SUPPORT,
      }).catch(console.error);
    }
    res.redirect(`/sistemas/tickets/${nuevoId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al procesar el ticket.");
  }
});

router.get("/tickets/signature", async (req, res) => {
  if (!req.session.user)
    return res.status(403).json({ error: "No autorizado" });
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "tickets_adjuntos";
    return res.json({ timestamp, folder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error firma" });
  }
});

// UPLOAD: recibir archivos y guardarlos localmente
router.post('/tickets/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.session || !req.session.user) return res.status(403).json({ error: 'No autorizado' });
    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });

    const result = await fileStorage.saveFile(req.file.buffer, 'tickets_adjuntos', req.file.originalname);
    const tipo = req.file.mimetype.startsWith('video/') ? 'video' : req.file.mimetype.startsWith('image/') ? 'image' : 'raw';

    return res.json({ secure_url: result.secure_url, public_id: result.public_id, resource_type: tipo });
  } catch (err) {
    console.error('Error subiendo archivo ticket:', err);
    return res.status(500).json({ error: 'Error subiendo archivo' });
  }
});

// ADMIN: ACTUALIZAR TICKET
router.post(
  "/tickets/:id/actualizar",
  requireRole.administrador(),
  async (req, res) => {
    const { id } = req.params;
    const category = req.body.category ?? req.body.categoria;
    const priority = ticketPriorityToDb(req.body.priority ?? req.body.prioridad);
    const status = ticketStatusToDb(req.body.status ?? req.body.estado);
    const { mensaje_respuesta, adjuntos_data } = req.body;

    let sql = `UPDATE support_tickets SET category = $1, priority = $2, status = $3`;
    if (status === "pending_close") sql += `, resolved_at = NOW()`;
    else if (status === "closed") sql += `, closed_at = NOW()`;
    else if (status === "open")
      sql += `, resolved_at = NULL, closed_at = NULL`;
    sql += ` WHERE id = $4`;

    try {
      await db.query(sql, [category, priority, status, id]);

      const tieneMensaje =
        mensaje_respuesta && mensaje_respuesta.trim().length > 0;
      const tieneAdjuntos = adjuntos_data && adjuntos_data.length > 2;

      if (tieneMensaje || tieneAdjuntos || status === "pending_close") {
        if (tieneMensaje || tieneAdjuntos) {
          await db.query(
            `INSERT INTO ticket_replies (ticket_id, message, sender, attachments, created_at) VALUES ($1, $2, $3, $4, NOW())`,
            [id, mensaje_respuesta, "Support", adjuntos_data || "[]"],
          );
        }

        await db.query(
          "UPDATE support_tickets SET read_by_user = FALSE WHERE id = $1",
          [id],
        );

        const { rows: ticket } = await db.query(
          "SELECT requester_email, title FROM support_tickets WHERE id = $1",
          [id],
        );
        if (ticket.length > 0) {
          let asunto = `Actualización Ticket #${id}: ${ticket[0].title}`;
          let cuerpo = `Hola,\n\nSe ha actualizado tu ticket. Nuevo estado: ${ticketStatusFromDb(status).toUpperCase()}.\n`;
          if (tieneMensaje) cuerpo += `\nMensaje: "${mensaje_respuesta}"`;

          sendMail({
            to: ticket[0].requester_email,
            subject: asunto,
            text: generarTextoCorreo(cuerpo, adjuntos_data),
            html: generarHtmlCorreo(cuerpo, adjuntos_data),
            bcc: EMAIL_SUPPORT,
          }).catch(console.error);
        }
      }
      res.redirect(`/sistemas/tickets/${id}`);
    } catch (err) {
      console.error(err);
      res.status(500).send("Error actualizando ticket");
    }
  },
);

// USUARIO: CONFIRMAR SOLUCIÓN
router.post("/tickets/:id/confirmar", async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;
  try {
    const { rows } = await db.query(
      "SELECT requester_email FROM support_tickets WHERE id = $1",
      [id],
    );
    if (rows.length === 0 || rows[0].requester_email !== user.email)
      return res.status(403).send("No tienes permiso.");

    await db.query(
      `UPDATE support_tickets SET status = 'closed', closed_at = NOW(), auto_closed = FALSE WHERE id = $1`,
      [id],
    );
    res.redirect(`/sistemas/tickets/${id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// USUARIO: RECHAZAR SOLUCIÓN
router.post("/tickets/:id/rechazar", async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;
  try {
    const { rows } = await db.query(
      "SELECT requester_email, title FROM support_tickets WHERE id = $1",
      [id],
    );
    if (rows.length === 0 || rows[0].requester_email !== user.email)
      return res.status(403).send("No tienes permiso.");

    await db.query(
      `UPDATE support_tickets SET status = 'open', resolved_at = NULL, read_by_admin = FALSE WHERE id = $1`,
      [id],
    );
    await db.query(
      `INSERT INTO ticket_replies (ticket_id, message, sender, created_at) VALUES ($1, $2, $3, NOW())`,
      [
        id,
        "El usuario ha rechazado la solución y el ticket se ha reabierto.",
        "System",
      ],
    );

    if (process.env.ADMIN_NOTIFY_EMAIL) {
      sendMail({
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `Ticket Reabierto #${id}: ${rows[0].title}`,
        text: `El usuario rechazó la solución y reabrió el ticket ${id}`,
        html: generarHtmlCorreo(
          `El usuario rechazó la solución y reabrió el ticket ${id}`,
          null,
        ),
        bcc: EMAIL_SUPPORT,
      }).catch(console.error);
    }
    res.redirect(`/sistemas/tickets/${id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// USUARIO/ADMIN: RESPONDER TICKET
router.post("/tickets/:id/responder", async (req, res) => {
  const { id } = req.params;
  const { mensaje_respuesta, adjuntos_data } = req.body;
  const user = req.session.user;

  try {
    const { rows: results } = await db.query(
      `SELECT requester_email, title FROM support_tickets WHERE id = $1`,
      [id],
    );
    if (results.length === 0)
      return res.status(404).send("Ticket no encontrado");
    const ticket = results[0];

    const isAdmin = isAdministrador(user.role);
    const isOwner = user.email === ticket.requester_email;
    if (!isAdmin && !isOwner) return res.status(403).send("Sin permiso.");

    let remitenteNombre = isAdmin
      ? "Soporte"
      : user.username || user.first_name;
    let emailDestino = isAdmin
      ? ticket.requester_email
      : process.env.ADMIN_NOTIFY_EMAIL;
    let asuntoEmail = `Nueva respuesta Ticket #${id}: ${ticket.title}`;

    await db.query(
      `INSERT INTO ticket_replies (ticket_id, message, sender, attachments, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      [id, mensaje_respuesta, isAdmin ? "Support" : remitenteNombre, adjuntos_data || "[]"],
    );

    if (isAdmin) {
      await db.query("UPDATE support_tickets SET read_by_user = FALSE WHERE id = $1", [
        id,
      ]);
    } else {
      await db.query("UPDATE support_tickets SET read_by_admin = FALSE WHERE id = $1", [
        id,
      ]);
    }

    if (emailDestino) {
      let cuerpo = `Nueva respuesta de ${remitenteNombre}:\n\n${mensaje_respuesta}`;
      sendMail({
        to: emailDestino,
        subject: asuntoEmail,
        text: generarTextoCorreo(cuerpo, adjuntos_data),
        html: generarHtmlCorreo(cuerpo, adjuntos_data),
        bcc: EMAIL_SUPPORT,
      }).catch(console.error);
    }

    res.redirect(`/sistemas/tickets/${id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error procesando respuesta.");
  }
});

// ADMIN: TOMAR TICKET
router.post("/tickets/:id/tomar", requireRole.administrador(), async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: userRows } = await db.query(
      "SELECT first_name, last_name FROM users WHERE id = $1",
      [req.session.user.id],
    );
    let adminName = "Soporte TI";
    if (userRows.length > 0) {
      adminName =
        userRows[0].first_name +
        (userRows[0].last_name ? " " + userRows[0].last_name : "");
    }

    await db.query("UPDATE support_tickets SET assigned_to = $1 WHERE id = $2", [
      adminName,
      id,
    ]);
    res.json({ success: true, asignado_a: adminName });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, error: "Error al asignar el ticket" });
  }
});

// DETALLE TICKET
router.get("/tickets/:id", async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;

  const sqlTicket = `
    SELECT id, title, description, category, priority, status,
           requester_name, requester_email, attachments, read_by_admin, read_by_user,
           assigned_to, auto_closed,
           created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago' AS created_at,
           resolved_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago' AS fecha_resolucion,
           closed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago' AS fecha_cierre
    FROM support_tickets WHERE id = $1
  `;

  const sqlRespuestas = `
    SELECT id, message, sender, file_url, file_name, file_type, attachments, 
           created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago' AS fecha 
    FROM ticket_replies 
    WHERE ticket_id = $1 
    ORDER BY created_at ASC
  `;

  try {
    const { rows: ticketResults } = await db.query(sqlTicket, [id]);
    if (ticketResults.length === 0)
      return res.status(404).render("404", { titulo: "No encontrado" });

    const userEmail = user.email || user.username;
    if (
      !isAdministrador(user.role) &&
      ticketResults[0].requester_email !== user.email
    )
      return res.status(403).send("No tienes permisos.");

    const { rows: respuestasResults } = await db.query(sqlRespuestas, [id]);

    if (isAdministrador(user.role)) {
      await db.query("UPDATE support_tickets SET read_by_admin = TRUE WHERE id = $1", [
        id,
      ]);
    } else {
      await db.query("UPDATE support_tickets SET read_by_user = TRUE WHERE id = $1", [
        id,
      ]);
    }
    invalidateNotificationCount(req);

    const isModal = req.query.modal === 'true';

    res.render("sistemas/tickets_detalle", {
      titulo: `Ticket #${id}`,
      ticket: ticketResults[0],
      respuestas: respuestasResults.map(mapTicketReplyForView),
      user: user,
      layout: isModal ? false : "layout",
      isModal: isModal,
      extraCss: isModal ? [] : ["/css/tickets.css"],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

module.exports = router;
