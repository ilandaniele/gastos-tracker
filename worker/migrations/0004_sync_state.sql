-- Huella por grupo de datos para que el sync solo escriba lo que cambió
-- (el plan gratis de D1 limita las filas escritas por día).
CREATE TABLE IF NOT EXISTS sync_state (
  tenant_id TEXT NOT NULL DEFAULT 'ilan',
  grupo     TEXT NOT NULL,
  huella    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, grupo)
);
