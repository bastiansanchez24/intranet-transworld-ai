/**
 * Estados de una solicitud de vacaciones (enum vacation_request_status en BD)
 * y etiquetas legibles en español para la UI.
 */
const VACATION_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
};

const ALL_VACATION_STATUSES = Object.values(VACATION_STATUS);

const VACATION_STATUS_LABELS = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  cancelled: "Cancelada",
  in_progress: "En curso",
  completed: "Completada",
};

/** Clase CSS de badge por estado (ver views/RRHH/vacaciones) */
const VACATION_STATUS_BADGE = {
  pending: "vac-badge vac-badge-pending",
  approved: "vac-badge vac-badge-approved",
  rejected: "vac-badge vac-badge-rejected",
  cancelled: "vac-badge vac-badge-cancelled",
  in_progress: "vac-badge vac-badge-progress",
  completed: "vac-badge vac-badge-completed",
};

/** Estados que ocupan saldo / bloquean solapamientos */
const VACATION_ACTIVE_STATUSES = [
  VACATION_STATUS.PENDING,
  VACATION_STATUS.APPROVED,
  VACATION_STATUS.IN_PROGRESS,
];

const COUNTRY = {
  CL: "CL",
  PE: "PE",
};

const COUNTRY_LABELS = {
  CL: "Chile",
  PE: "Perú",
};

const COUNTRY_FLAGS = {
  CL: "",
  PE: "",
};

function vacationStatusLabel(status) {
  return VACATION_STATUS_LABELS[status] || status;
}

function vacationStatusBadge(status) {
  return VACATION_STATUS_BADGE[status] || "vac-badge";
}

function countryLabel(code) {
  return COUNTRY_LABELS[code] || code;
}

function countryFlag(code) {
  return COUNTRY_FLAGS[code] || "";
}

module.exports = {
  VACATION_STATUS,
  ALL_VACATION_STATUSES,
  VACATION_STATUS_LABELS,
  VACATION_STATUS_BADGE,
  VACATION_ACTIVE_STATUSES,
  COUNTRY,
  COUNTRY_LABELS,
  COUNTRY_FLAGS,
  vacationStatusLabel,
  vacationStatusBadge,
  countryLabel,
  countryFlag,
};
