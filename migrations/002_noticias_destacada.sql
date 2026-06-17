-- Noticia destacada en el home (solo una activa a la vez)
ALTER TABLE noticias
  ADD COLUMN IF NOT EXISTS destacada BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_noticias_destacada ON noticias (destacada)
  WHERE destacada = true;
