-- Contadores diarios de uso del asistente Claude (por usuario)
CREATE TABLE IF NOT EXISTS claude_daily_usage (
  user_id INTEGER NOT NULL,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  PRIMARY KEY (user_id, usage_date)
);

-- Preferencias del usuario para el asistente Claude
CREATE TABLE IF NOT EXISTS claude_user_settings (
  user_id INTEGER PRIMARY KEY,
  limits_notice_seen_at TIMESTAMPTZ
);
