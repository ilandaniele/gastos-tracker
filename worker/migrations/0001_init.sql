-- Esquema inicial: gastos, ingresos y ahorros importados del Sheet.
-- Cada tabla lleva tenant_id desde el día uno (hoy siempre 'ilan') para que
-- pasar a varios clientes no obligue a migrar los datos.
-- Los importes son REAL a propósito: se copian tal cual del Sheet para poder
-- comparar totales. Pasar a centavos enteros queda para cuando el Sheet deje
-- de ser la fuente de verdad.

CREATE TABLE expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT    NOT NULL DEFAULT 'ilan',
  mes           TEXT    NOT NULL,            -- '2026-11'
  tab           TEXT    NOT NULL,            -- 'Noviembre 2026' (hoja de origen)
  src_row       INTEGER,                     -- fila en la hoja, solo para trazar
  concepto      TEXT    NOT NULL,
  monto         REAL    NOT NULL,            -- el que muestra la app (un solo importe)
  moneda        TEXT    NOT NULL,            -- 'UYU' | 'USD'
  uyu_raw       REAL,                        -- solo filas fijas: pueden traer UYU y USD a la vez
  usd_raw       REAL,
  medio_pago    TEXT,                        -- columna de tarjeta/medio de la tabla variable
  es_fijo       INTEGER NOT NULL DEFAULT 0,
  es_credito    INTEGER NOT NULL DEFAULT 0,  -- tarjeta de crédito: no suma, solo su pago
  es_ahorro     INTEGER NOT NULL DEFAULT 0,  -- ahorro/inversión: fuera de los totales
  categoria     TEXT,                        -- tal cual: 'Cita + Comida'
  cat1          TEXT,
  cat2          TEXT,
  fecha         TEXT,                        -- 'YYYY-MM-DD' o vacío
  cotizacion    REAL,
  notas         TEXT,
  grupo         TEXT,                        -- ticket agrupado (_tickets)
  grupo_nombre  TEXT
);
CREATE INDEX idx_expenses_tenant_mes ON expenses (tenant_id, mes);
CREATE INDEX idx_expenses_cat1 ON expenses (tenant_id, cat1);
CREATE INDEX idx_expenses_fecha ON expenses (tenant_id, fecha);

CREATE TABLE month_totals (
  tenant_id TEXT NOT NULL DEFAULT 'ilan',
  mes       TEXT NOT NULL,
  tab       TEXT NOT NULL,
  uyu       REAL, usd REAL,                  -- totales según el Sheet (para verificar)
  mixed_uyu REAL, mixed_usd REAL,
  PRIMARY KEY (tenant_id, mes)
);

CREATE TABLE incomes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'ilan',
  src_row   INTEGER,
  fecha     TEXT,
  concepto  TEXT NOT NULL,
  monto     REAL NOT NULL,
  moneda    TEXT NOT NULL,
  notas     TEXT
);
CREATE INDEX idx_incomes_tenant_fecha ON incomes (tenant_id, fecha);

CREATE TABLE savings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL DEFAULT 'ilan',
  src_row       INTEGER,
  fecha         TEXT,
  tipo          TEXT,                        -- Acción | Banco | Bono
  entidad       TEXT,
  ticker        TEXT,
  cantidad      REAL,
  precio_usd    REAL,
  comision_usd  REAL,
  monto         REAL,
  moneda        TEXT,
  invertido_usd REAL,
  notas         TEXT
);
CREATE INDEX idx_savings_tenant ON savings (tenant_id, fecha);

CREATE TABLE import_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  source      TEXT NOT NULL,
  months      INTEGER, expenses INTEGER, incomes INTEGER, savings INTEGER
);
