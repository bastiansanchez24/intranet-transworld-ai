-- Featured news article on home (only one active at a time)
-- Legacy Spanish names; superseded by 006_schema_english.sql on existing databases.
ALTER TABLE noticias
  ADD COLUMN IF NOT EXISTS destacada BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_noticias_destacada ON noticias (destacada)
  WHERE destacada = true;
