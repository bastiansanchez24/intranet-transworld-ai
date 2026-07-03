const db = require("../../db");
const { getStrategy } = require("./VacationEngine");
const {
  toDateOnly,
  addDays,
  fullYearsBetween,
} = require("../../utils/vacationDateUtils");

/**
 * Gestión de períodos de devengo y saldos.
 *
 * Modelo: un período por año laboral (aniversario de hire_date). Los años ya
 * cumplidos otorgan el derecho completo; el año en curso devenga proporcional.
 * Saldo de un período = entitled_days + adjusted_days - used_days.
 */

function periodAvailable(period) {
  return (
    Number(period.entitled_days) +
    Number(period.adjusted_days) -
    Number(period.used_days)
  );
}

/** Suma el aniversario (años) a una fecha date-only. */
function addYears(value, years) {
  const date = toDateOnly(value);
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  // Construye fecha sumando años; addDays maneja normalización si fuese 29/02.
  const target = `${y + years}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return toDateOnly(target) || target;
}

async function getUserVacationProfile(userId) {
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, employment_country, hire_date,
            manager_user_id
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Regenera/actualiza los períodos de un colaborador según su hire_date y país.
 * Idempotente: no duplica (UNIQUE user_id, period_start) y no pisa used/adjusted.
 */
async function recalculatePeriods(userId) {
  const user = await getUserVacationProfile(userId);
  if (!user || !user.hire_date || !user.employment_country) return;

  const country = user.employment_country;
  const strategy = getStrategy(country);
  const hire = toDateOnly(user.hire_date);
  const today = toDateOnly(new Date());
  const yearsComplete = fullYearsBetween(hire, today);

  // Períodos de años ya cumplidos (derecho completo).
  for (let k = 1; k <= yearsComplete; k += 1) {
    const periodStart = addYears(hire, k - 1);
    const periodEnd = addDays(addYears(hire, k), -1);
    const entitled = strategy.getAnnualEntitlement({ yearsOfService: k });
    const expires = strategy.getExpirationDate({ periodEnd });
    await upsertPeriod({
      userId,
      country,
      periodStart,
      periodEnd,
      entitledDays: entitled,
      expiresAt: expires,
    });
  }

  // Período en curso (año en progreso): devengo proporcional.
  const currentStart = addYears(hire, yearsComplete);
  const currentEnd = addDays(addYears(hire, yearsComplete + 1), -1);
  const proportional = strategy.getProportionalDays({
    hireDate: currentStart,
    referenceDate: today,
  });
  await upsertPeriod({
    userId,
    country,
    periodStart: currentStart,
    periodEnd: currentEnd,
    entitledDays: proportional,
    expiresAt: strategy.getExpirationDate({ periodEnd: currentEnd }),
    onlyRaiseEntitled: true,
  });
}

async function upsertPeriod({
  userId,
  country,
  periodStart,
  periodEnd,
  entitledDays,
  expiresAt,
  onlyRaiseEntitled = false,
}) {
  // onlyRaiseEntitled evita reducir el devengo del período en curso por redondeos.
  const entitledClause = onlyRaiseEntitled
    ? "GREATEST(vacation_periods.entitled_days, EXCLUDED.entitled_days)"
    : "EXCLUDED.entitled_days";

  await db.query(
    `INSERT INTO vacation_periods
       (user_id, country_code, period_start, period_end, entitled_days, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, period_start) DO UPDATE SET
       country_code = EXCLUDED.country_code,
       period_end   = EXCLUDED.period_end,
       entitled_days = ${entitledClause},
       expires_at   = EXCLUDED.expires_at,
       updated_at   = NOW()`,
    [userId, country, periodStart, periodEnd, entitledDays, expiresAt],
  );
}

/** Lista períodos de un usuario (más reciente primero). */
async function listPeriods(userId) {
  const { rows } = await db.query(
    `SELECT * FROM vacation_periods WHERE user_id = $1 ORDER BY period_start DESC`,
    [userId],
  );
  return rows;
}

/** Períodos vigentes (no vencidos), ordenados FIFO (más antiguo primero). */
async function listActivePeriodsFifo(userId, client = db) {
  const today = toDateOnly(new Date());
  const { rows } = await client.query(
    `SELECT * FROM vacation_periods
     WHERE user_id = $1 AND (expires_at IS NULL OR expires_at >= $2)
     ORDER BY period_start ASC`,
    [userId, today],
  );
  return rows;
}

/** Saldo disponible total (suma de períodos vigentes). */
async function getAvailableBalance(userId) {
  const periods = await listActivePeriodsFifo(userId);
  return periods.reduce((sum, p) => sum + periodAvailable(p), 0);
}

/** Resumen de saldos para la UI. */
async function getBalanceSummary(userId) {
  const periods = await listPeriods(userId);
  const today = toDateOnly(new Date());
  let entitled = 0;
  let used = 0;
  let adjusted = 0;
  let available = 0;
  let expiringSoon = 0;

  for (const p of periods) {
    const isActive = !p.expires_at || toDateOnly(p.expires_at) >= today;
    entitled += Number(p.entitled_days);
    used += Number(p.used_days);
    adjusted += Number(p.adjusted_days);
    if (isActive) {
      available += periodAvailable(p);
      // Vence dentro de 90 días
      if (p.expires_at) {
        const limit = addDays(today, 90);
        if (toDateOnly(p.expires_at) <= limit) {
          expiringSoon += periodAvailable(p);
        }
      }
    }
  }

  return {
    entitled: round2(entitled),
    used: round2(used),
    adjusted: round2(adjusted),
    available: round2(available),
    expiringSoon: round2(expiringSoon),
    periodsCount: periods.length,
    activePeriodsCount: periods.filter(
      (p) => !p.expires_at || toDateOnly(p.expires_at) >= today,
    ).length,
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Consume días de los períodos vigentes en orden FIFO (más antiguo primero).
 * Debe ejecutarse dentro de una transacción (client) tras bloquear con FOR UPDATE.
 * @returns {{ firstPeriodId: number|null, allocations: { periodId: number, days: number }[] }}
 */
async function consumeDaysFifo(client, userId, days) {
  let remaining = Number(days);
  let firstPeriodId = null;
  const allocations = [];

  const today = toDateOnly(new Date());
  // Bloquea los períodos vigentes para evitar condiciones de carrera al aprobar.
  const { rows: periods } = await client.query(
    `SELECT * FROM vacation_periods
     WHERE user_id = $1 AND (expires_at IS NULL OR expires_at >= $2)
     ORDER BY period_start ASC
     FOR UPDATE`,
    [userId, today],
  );
  for (const p of periods) {
    if (remaining <= 0.001) break;
    const avail = periodAvailable(p);
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    await client.query(
      `UPDATE vacation_periods SET used_days = used_days + $1, updated_at = NOW() WHERE id = $2`,
      [take, p.id],
    );
    if (firstPeriodId === null) firstPeriodId = p.id;
    allocations.push({ periodId: p.id, days: take });
    remaining -= take;
  }

  if (remaining > 0.001) {
    throw new Error("Saldo insuficiente al consumir días de vacaciones.");
  }
  return { firstPeriodId, allocations };
}

/** Persiste el desglose FIFO de una solicitud aprobada. */
async function savePeriodAllocations(client, requestId, allocations) {
  if (!allocations.length) return;
  for (const { periodId, days } of allocations) {
    await client.query(
      `INSERT INTO vacation_request_period_allocations
         (vacation_request_id, vacation_period_id, days)
       VALUES ($1, $2, $3)
       ON CONFLICT (vacation_request_id, vacation_period_id) DO UPDATE SET
         days = EXCLUDED.days`,
      [requestId, periodId, Number(days)],
    );
  }
}

/** Lee el desglose FIFO guardado al aprobar (vacío en solicitudes legacy). */
async function getPeriodAllocations(client, requestId) {
  const { rows } = await client.query(
    `SELECT vacation_period_id AS period_id, days
     FROM vacation_request_period_allocations
     WHERE vacation_request_id = $1
     ORDER BY vacation_period_id ASC`,
    [requestId],
  );
  return rows.map((row) => ({
    periodId: row.period_id,
    days: Number(row.days),
  }));
}

/** Libera días devueltos al cancelar una solicitud aprobada. */
async function releaseDays(client, periodId, days) {
  if (!periodId) return;
  await client.query(
    `UPDATE vacation_periods
     SET used_days = GREATEST(0, used_days - $1), updated_at = NOW()
     WHERE id = $2`,
    [Number(days), periodId],
  );
}

/** Libera el desglose FIFO completo de una solicitud cancelada. */
async function releaseAllocations(client, allocations) {
  for (const { periodId, days } of allocations) {
    await releaseDays(client, periodId, days);
  }
}

/** Aplica un ajuste manual de saldo + auditoría. */
async function applyAdjustment({ periodId, adjustedBy, daysDelta, reason }) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE vacation_periods
       SET adjusted_days = adjusted_days + $1, updated_at = NOW()
       WHERE id = $2`,
      [Number(daysDelta), periodId],
    );
    await client.query(
      `INSERT INTO vacation_balance_adjustments
         (vacation_period_id, adjusted_by, days_delta, reason)
       VALUES ($1, $2, $3, $4)`,
      [periodId, adjustedBy, Number(daysDelta), String(reason).trim()],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  periodAvailable,
  getUserVacationProfile,
  recalculatePeriods,
  listPeriods,
  listActivePeriodsFifo,
  getAvailableBalance,
  getBalanceSummary,
  consumeDaysFifo,
  savePeriodAllocations,
  getPeriodAllocations,
  releaseDays,
  releaseAllocations,
  applyAdjustment,
};
