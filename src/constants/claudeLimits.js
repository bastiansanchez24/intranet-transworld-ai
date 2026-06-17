const MAX_MESSAGES_PER_DAY = 30;
const MAX_FILES_PER_DAY = 5;
const CONTEXT_WINDOW_MESSAGES = 30;

const LIMITS_NOTICE = {
  title: "Asistente en marcha blanca",
  body:
    "Durante esta fase piloto el asistente tiene límites de uso diarios para garantizar un servicio estable para todos:",
  items: [
    `Hasta ${MAX_MESSAGES_PER_DAY} mensajes por día (incluye tus mensajes y las respuestas del asistente).`,
    `Hasta ${MAX_FILES_PER_DAY} archivos analizados por día (adjuntos en el chat y extracciones de documentos).`,
    "Los límites se reinician cada día. Cuando los alcances, podrás volver a usar el asistente al día siguiente.",
  ],
};

module.exports = {
  MAX_MESSAGES_PER_DAY,
  MAX_FILES_PER_DAY,
  CONTEXT_WINDOW_MESSAGES,
  LIMITS_NOTICE,
};
