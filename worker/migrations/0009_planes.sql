-- Planes y pagos (docs/MULTI-TENANT.md, "Planes y pagos"). Modelo de períodos prepagos: cada pago aprobado
-- suma 1 mes o 12 meses a plan_hasta. Pasada esa fecha la cuenta vuelve sola a 'gratis' (no hay nada que cancelar).
ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'gratis';
ALTER TABLE tenants ADD COLUMN plan_hasta TEXT;   -- ISO UTC 'YYYY-MM-DDTHH:MM:SSZ'; NULL = nunca tuvo plan pago

-- Un renglón por pago aprobado. id_externo = '<proveedor>:<id del pago en el proveedor>' y es UNIQUE:
-- los webhooks se reintentan, y así un mismo pago nunca suma dos veces.
CREATE TABLE IF NOT EXISTS pagos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  proveedor   TEXT NOT NULL,
  id_externo  TEXT NOT NULL UNIQUE,
  periodo     TEXT NOT NULL,        -- 'mes' | 'anio'
  monto       REAL,
  moneda      TEXT,
  creado      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pagos_tenant ON pagos (tenant_id);
