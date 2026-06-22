const db = require("../db");
const { ROLES } = require("../constants/roles");

/**
 * Sin correo o sin verificar → rol Deshabilitado.
 * Con correo (aunque no verificado) → siguen en la intranet (is_intranet_user = TRUE).
 * Sin correo → fuera de la intranet (is_intranet_user = FALSE).
 */
async function syncUnverifiedUsersToDisabled() {
  const sql = `
    UPDATE users
    SET role = $1,
        is_intranet_user = (email IS NOT NULL AND BTRIM(email) <> '')
    WHERE (
      email IS NULL
      OR BTRIM(email) = ''
      OR COALESCE(email_confirmed, FALSE) = FALSE
    )
    AND (
      role IS DISTINCT FROM $1
      OR is_intranet_user IS DISTINCT FROM (email IS NOT NULL AND BTRIM(email) <> '')
    )
    RETURNING id
  `;

  const result = await db.query(sql, [ROLES.DESHABILITADO]);
  return result.rowCount || 0;
}

module.exports = { syncUnverifiedUsersToDisabled };
