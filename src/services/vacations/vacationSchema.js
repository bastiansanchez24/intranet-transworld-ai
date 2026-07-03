const db = require("../../db");

/**
 * Asegura el schema del módulo de vacaciones de forma idempotente al arrancar
 * la app (mismo patrón que asegurarColumnaNoticiasDestacada en app.js).
 * La fuente canónica es migrations/007_vacation_module.sql.
 */

const DDL_STATEMENTS = [
  // users — campos laborales
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_country VARCHAR(2) NOT NULL DEFAULT 'CL' CHECK (employment_country IN ('CL', 'PE'))`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS idx_users_employment_country ON users (employment_country)`,
  `CREATE INDEX IF NOT EXISTS idx_users_hire_date ON users (hire_date) WHERE hire_date IS NOT NULL`,

  // vacation_periods
  `CREATE TABLE IF NOT EXISTS vacation_periods (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    country_code    VARCHAR(2) NOT NULL CHECK (country_code IN ('CL', 'PE')),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    entitled_days   NUMERIC(5,2) NOT NULL,
    used_days       NUMERIC(5,2) NOT NULL DEFAULT 0,
    adjusted_days   NUMERIC(5,2) NOT NULL DEFAULT 0,
    expires_at      DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, period_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vacation_periods_user ON vacation_periods (user_id)`,

  // enum vacation_request_status
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vacation_request_status') THEN
       CREATE TYPE vacation_request_status AS ENUM ('pending','approved','rejected','cancelled','in_progress','completed');
     END IF;
   END$$`,

  // vacation_requests
  `CREATE TABLE IF NOT EXISTS vacation_requests (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    country_code       VARCHAR(2) NOT NULL CHECK (country_code IN ('CL', 'PE')),
    vacation_period_id INTEGER REFERENCES vacation_periods(id) ON DELETE SET NULL,
    start_date         DATE NOT NULL,
    end_date           DATE NOT NULL,
    business_days      NUMERIC(5,2),
    calendar_days      INTEGER,
    status             vacation_request_status NOT NULL DEFAULT 'pending',
    requester_notes    TEXT,
    reviewer_notes     TEXT,
    reviewed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date >= start_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vacation_requests_user ON vacation_requests (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_vacation_requests_status ON vacation_requests (status)`,
  `CREATE INDEX IF NOT EXISTS idx_vacation_requests_dates ON vacation_requests (start_date, end_date)`,

  // vacation_request_period_allocations — desglose FIFO por período al aprobar
  `CREATE TABLE IF NOT EXISTS vacation_request_period_allocations (
    vacation_request_id INTEGER NOT NULL REFERENCES vacation_requests(id) ON DELETE CASCADE,
    vacation_period_id  INTEGER NOT NULL REFERENCES vacation_periods(id) ON DELETE CASCADE,
    days                NUMERIC(5,2) NOT NULL CHECK (days > 0),
    PRIMARY KEY (vacation_request_id, vacation_period_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vacation_request_period_allocations_period
    ON vacation_request_period_allocations (vacation_period_id)`,

  // vacation_balance_adjustments
  `CREATE TABLE IF NOT EXISTS vacation_balance_adjustments (
    id                 SERIAL PRIMARY KEY,
    vacation_period_id INTEGER NOT NULL REFERENCES vacation_periods(id) ON DELETE CASCADE,
    adjusted_by        INTEGER NOT NULL REFERENCES users(id),
    days_delta         NUMERIC(5,2) NOT NULL,
    reason             TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vacation_balance_adjustments_period ON vacation_balance_adjustments (vacation_period_id)`,

  // public_holidays
  `CREATE TABLE IF NOT EXISTS public_holidays (
    id            SERIAL PRIMARY KEY,
    country_code  VARCHAR(2) NOT NULL CHECK (country_code IN ('CL', 'PE')),
    holiday_date  DATE NOT NULL,
    name          VARCHAR(200) NOT NULL,
    is_recurring  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (country_code, holiday_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_public_holidays_country_date ON public_holidays (country_code, holiday_date)`,
];

// Feriados legales 2025-2026 (subconjunto principal). Admin puede editar en UI.
const SEED_HOLIDAYS = [
  // Chile 2025
  ["CL", "2025-01-01", "Año Nuevo"],
  ["CL", "2025-04-18", "Viernes Santo"],
  ["CL", "2025-04-19", "Sábado Santo"],
  ["CL", "2025-05-01", "Día del Trabajo"],
  ["CL", "2025-05-21", "Día de las Glorias Navales"],
  ["CL", "2025-06-20", "Día Nacional de los Pueblos Indígenas"],
  ["CL", "2025-06-29", "San Pedro y San Pablo"],
  ["CL", "2025-07-16", "Virgen del Carmen"],
  ["CL", "2025-08-15", "Asunción de la Virgen"],
  ["CL", "2025-09-18", "Independencia Nacional"],
  ["CL", "2025-09-19", "Día de las Glorias del Ejército"],
  ["CL", "2025-10-12", "Encuentro de Dos Mundos"],
  ["CL", "2025-10-31", "Día de las Iglesias Evangélicas"],
  ["CL", "2025-11-01", "Día de Todos los Santos"],
  ["CL", "2025-12-08", "Inmaculada Concepción"],
  ["CL", "2025-12-25", "Navidad"],
  // Chile 2026
  ["CL", "2026-01-01", "Año Nuevo"],
  ["CL", "2026-04-03", "Viernes Santo"],
  ["CL", "2026-04-04", "Sábado Santo"],
  ["CL", "2026-05-01", "Día del Trabajo"],
  ["CL", "2026-05-21", "Día de las Glorias Navales"],
  ["CL", "2026-06-29", "San Pedro y San Pablo"],
  ["CL", "2026-07-16", "Virgen del Carmen"],
  ["CL", "2026-08-15", "Asunción de la Virgen"],
  ["CL", "2026-09-18", "Independencia Nacional"],
  ["CL", "2026-09-19", "Día de las Glorias del Ejército"],
  ["CL", "2026-10-12", "Encuentro de Dos Mundos"],
  ["CL", "2026-10-31", "Día de las Iglesias Evangélicas"],
  ["CL", "2026-11-01", "Día de Todos los Santos"],
  ["CL", "2026-12-08", "Inmaculada Concepción"],
  ["CL", "2026-12-25", "Navidad"],
  // Perú 2025
  ["PE", "2025-01-01", "Año Nuevo"],
  ["PE", "2025-04-17", "Jueves Santo"],
  ["PE", "2025-04-18", "Viernes Santo"],
  ["PE", "2025-05-01", "Día del Trabajo"],
  ["PE", "2025-06-29", "San Pedro y San Pablo"],
  ["PE", "2025-07-23", "Día de la Fuerza Aérea"],
  ["PE", "2025-07-28", "Fiestas Patrias"],
  ["PE", "2025-07-29", "Fiestas Patrias"],
  ["PE", "2025-08-06", "Batalla de Junín"],
  ["PE", "2025-08-30", "Santa Rosa de Lima"],
  ["PE", "2025-10-08", "Combate de Angamos"],
  ["PE", "2025-11-01", "Día de Todos los Santos"],
  ["PE", "2025-12-08", "Inmaculada Concepción"],
  ["PE", "2025-12-09", "Batalla de Ayacucho"],
  ["PE", "2025-12-25", "Navidad"],
  // Perú 2026
  ["PE", "2026-01-01", "Año Nuevo"],
  ["PE", "2026-04-02", "Jueves Santo"],
  ["PE", "2026-04-03", "Viernes Santo"],
  ["PE", "2026-05-01", "Día del Trabajo"],
  ["PE", "2026-06-29", "San Pedro y San Pablo"],
  ["PE", "2026-07-28", "Fiestas Patrias"],
  ["PE", "2026-07-29", "Fiestas Patrias"],
  ["PE", "2026-08-06", "Batalla de Junín"],
  ["PE", "2026-08-30", "Santa Rosa de Lima"],
  ["PE", "2026-10-08", "Combate de Angamos"],
  ["PE", "2026-11-01", "Día de Todos los Santos"],
  ["PE", "2026-12-08", "Inmaculada Concepción"],
  ["PE", "2026-12-09", "Batalla de Ayacucho"],
  ["PE", "2026-12-25", "Navidad"],
];

async function ensureVacationSchema() {
  for (const stmt of DDL_STATEMENTS) {
    await db.query(stmt);
  }
  await seedHolidays();
}

async function seedHolidays() {
  if (!SEED_HOLIDAYS.length) return;

  const countries = SEED_HOLIDAYS.map(([country]) => country);
  const dates = SEED_HOLIDAYS.map(([, date]) => date);
  const names = SEED_HOLIDAYS.map(([, , name]) => name);

  await db.query(
    `INSERT INTO public_holidays (country_code, holiday_date, name)
     SELECT country_code, holiday_date, name
     FROM UNNEST($1::varchar[], $2::date[], $3::varchar[])
       AS t(country_code, holiday_date, name)
     ON CONFLICT (country_code, holiday_date) DO NOTHING`,
    [countries, dates, names],
  );
}

module.exports = { ensureVacationSchema };
