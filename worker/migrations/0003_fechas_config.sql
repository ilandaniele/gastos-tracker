-- Fechas completas y configuración de la app.
--
-- En el Sheet, 4.152 de 5.294 gastos (los meses viejos y todos los fijos) no tienen
-- fecha propia. Para poder filtrar y ordenar por fecha sin inventar nada:
--   fecha           = lo que dice el Sheet (puede estar vacía)
--   fecha_efectiva  = fecha real, o el día 1 de su mes si el Sheet no la trae
--   fecha_origen    = 'hoja' (real) | 'mes' (estimada por el mes)
ALTER TABLE expenses ADD COLUMN fecha_efectiva TEXT;
ALTER TABLE expenses ADD COLUMN fecha_origen TEXT;
UPDATE expenses SET
  fecha_efectiva = CASE WHEN fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN fecha ELSE mes || '-01' END,
  fecha_origen   = CASE WHEN fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN 'hoja' ELSE 'mes' END;
CREATE INDEX idx_expenses_fecha_efectiva ON expenses (tenant_id, fecha_efectiva);

-- Configuración que hoy vive en Script Properties (categorías de tareas, emojis,
-- subcategorías, estado de pantalla). Valor en texto; casi todo es JSON.
CREATE TABLE config (
  tenant_id TEXT NOT NULL DEFAULT 'ilan',
  clave     TEXT NOT NULL,
  valor     TEXT,
  PRIMARY KEY (tenant_id, clave)
);
