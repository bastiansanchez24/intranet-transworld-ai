const TICKET_STATUS_TO_DB = {
  Abierto: "open",
  "En curso": "in_progress",
  "Pendiente de cierre": "pending_close",
  Cerrado: "closed",
};

const TICKET_STATUS_FROM_DB = {
  open: "Abierto",
  in_progress: "En curso",
  pending_close: "Pendiente de cierre",
  closed: "Cerrado",
};

const TICKET_PRIORITY_TO_DB = {
  Baja: "low",
  Media: "medium",
  Alta: "high",
};

const TICKET_PRIORITY_FROM_DB = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
};

const COURSE_STATUS_TO_DB = {
  "En curso": "in_progress",
  Evaluado: "evaluated",
};

const COURSE_STATUS_FROM_DB = {
  in_progress: "En curso",
  evaluated: "Evaluado",
};

function ticketStatusToDb(status) {
  return TICKET_STATUS_TO_DB[status] || status;
}

function ticketStatusFromDb(status) {
  return TICKET_STATUS_FROM_DB[status] || status;
}

function ticketPriorityToDb(priority) {
  return TICKET_PRIORITY_TO_DB[priority] || priority;
}

function ticketPriorityFromDb(priority) {
  return TICKET_PRIORITY_FROM_DB[priority] || priority;
}

function courseStatusToDb(status) {
  return COURSE_STATUS_TO_DB[status] || status;
}

function courseStatusFromDb(status) {
  return COURSE_STATUS_FROM_DB[status] || status;
}

const NOTICIA_VIEW_COLUMNS = `
  id, title, subtitle, slug, content, image, attachments, author,
  created_at, featured
`;

const EVENTO_VIEW_COLUMNS = `
  id, name, slug, description, image, created_at
`;

const APPLICATION_VIEW_COLUMNS = `
  id, name AS nombre, description AS descripcion, url_pc, url_apk, qr_apk, qr_ios,
  created_at AS fecha_creacion, updated_at AS ultima_actualizacion,
  changelog AS cambios, notified AS notificado
`;

const MATERIAL_VIEW_COLUMNS = `
  id, section AS seccion, name AS nombre, file_url AS archivo_url, public_id,
  resource_type AS tipo_recurso, created_at AS fecha_creacion
`;

const TICKET_SENDER_FROM_DB = {
  Support: "Soporte",
  System: "Sistema",
};

function mapTicketForView(row) {
  if (!row) return row;
  return {
    ...row,
    titulo: row.title ?? row.titulo,
    descripcion: row.description ?? row.descripcion,
    categoria: row.category ?? row.categoria,
    prioridad: ticketPriorityFromDb(row.priority ?? row.prioridad),
    estado: ticketStatusFromDb(row.status ?? row.estado),
    solicitante_nombre: row.requester_name ?? row.solicitante_nombre,
    solicitante_email: row.requester_email ?? row.solicitante_email,
    adjuntos: row.attachments ?? row.adjuntos,
    leido_admin: row.read_by_admin ?? row.leido_admin,
    leido_usuario: row.read_by_user ?? row.leido_usuario,
    asignado_a: row.assigned_to ?? row.asignado_a,
    fecha_creacion: row.fecha_creacion ?? row.created_at,
    fecha_resolucion: row.fecha_resolucion ?? row.resolved_at,
    fecha_cierre: row.fecha_cierre ?? row.closed_at,
    cierre_automatico: row.auto_closed ?? row.cierre_automatico,
  };
}

function ticketSenderFromDb(sender) {
  return TICKET_SENDER_FROM_DB[sender] || sender;
}

function mapTicketReplyForView(row) {
  if (!row) return row;
  return {
    ...row,
    mensaje: row.message ?? row.mensaje,
    remitente: ticketSenderFromDb(row.sender ?? row.remitente),
    archivo_url: row.file_url ?? row.archivo_url,
    archivo_nombre: row.file_name ?? row.archivo_nombre,
    archivo_tipo: row.file_type ?? row.archivo_tipo,
    adjuntos: row.attachments ?? row.adjuntos,
    fecha: row.fecha ?? row.created_at,
  };
}

function mapPersonaForView(row) {
  if (!row) return row;
  const photo = row.photo ?? row.foto;
  return {
    ...row,
    photo,
    foto: photo,
    birth_date: row.birth_date ?? row.fecha_nacimiento,
    work_area_id: row.work_area_id ?? row.area_trabajo_id,
    phone: row.phone ?? row.telefono,
    is_intranet_user: row.is_intranet_user ?? row.usuario_intranet,
    area: row.area ?? row.area_name,
  };
}

module.exports = {
  ticketStatusToDb,
  ticketStatusFromDb,
  ticketPriorityToDb,
  ticketPriorityFromDb,
  courseStatusToDb,
  courseStatusFromDb,
  NOTICIA_VIEW_COLUMNS,
  EVENTO_VIEW_COLUMNS,
  APPLICATION_VIEW_COLUMNS,
  MATERIAL_VIEW_COLUMNS,
  mapTicketForView,
  mapTicketReplyForView,
  mapPersonaForView,
};
