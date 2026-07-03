-- migrations/009_vacation_period_allocations.sql
-- Registra el desglose FIFO por período al aprobar solicitudes, para liberar
-- correctamente el saldo al cancelar solicitudes que consumieron varios períodos.

BEGIN;

CREATE TABLE IF NOT EXISTS vacation_request_period_allocations (
  vacation_request_id INTEGER NOT NULL REFERENCES vacation_requests(id) ON DELETE CASCADE,
  vacation_period_id  INTEGER NOT NULL REFERENCES vacation_periods(id) ON DELETE CASCADE,
  days                NUMERIC(5,2) NOT NULL CHECK (days > 0),
  PRIMARY KEY (vacation_request_id, vacation_period_id)
);

CREATE INDEX IF NOT EXISTS idx_vacation_request_period_allocations_period
  ON vacation_request_period_allocations (vacation_period_id);

COMMIT;
