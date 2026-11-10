-- Módulos: tareas, compras, hábitos, país secundario y ajustes por tenant.

CREATE TABLE settings (
  tenant_id TEXT NOT NULL DEFAULT 'ilan',
  clave     TEXT NOT NULL,
  valor     TEXT,
  PRIMARY KEY (tenant_id, clave)
);
-- País secundario configurable. Por defecto Argentina; la bandera sale del código ISO.
INSERT INTO settings (tenant_id, clave, valor) VALUES
  ('ilan', 'pais_codigo', 'AR'),
  ('ilan', 'pais_nombre', 'Argentina'),
  ('ilan', 'pais_moneda', 'ARS'),
  ('ilan', 'zona_horaria', 'America/Montevideo'),
  ('ilan', 'moneda_base', 'UYU');

CREATE TABLE tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id        TEXT NOT NULL DEFAULT 'ilan',
  src_row          INTEGER,
  creada           TEXT,
  tipo             TEXT,
  categoria        TEXT,
  subcategoria     TEXT,
  texto            TEXT NOT NULL,
  fecha            TEXT,
  hora             TEXT,
  notas            TEXT,
  completada       INTEGER NOT NULL DEFAULT 0,
  fecha_completada TEXT,
  recurrente       INTEGER NOT NULL DEFAULT 0,
  objetivo         REAL,
  contador         REAL,
  periodo          TEXT,
  ultimo_reset     TEXT,
  importancia      TEXT,
  archivada        INTEGER NOT NULL DEFAULT 0,
  orden            REAL,
  subtareas        TEXT                      -- JSON tal cual viene de la app
);
CREATE INDEX idx_tasks_tenant ON tasks (tenant_id, completada, fecha);

CREATE TABLE purchases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL DEFAULT 'ilan',
  src_row        INTEGER,
  creada         TEXT,
  texto          TEXT NOT NULL,
  comprado       INTEGER NOT NULL DEFAULT 0,
  fecha_comprado TEXT
);
CREATE INDEX idx_purchases_tenant ON purchases (tenant_id, comprado);

CREATE TABLE habit_days (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL DEFAULT 'ilan',
  fecha         TEXT NOT NULL,
  tab           TEXT,
  levante       TEXT, acoste TEXT,
  hs_sueno      REAL, trabajo REAL, avance REAL, animo REAL,
  ejercicio     TEXT, ejercicio_min REAL,
  medite        TEXT, medite_min REAL, lei TEXT,
  abordajes     REAL, agua REAL, mast REAL,
  notas         TEXT
);
CREATE INDEX idx_habit_days ON habit_days (tenant_id, fecha);

CREATE TABLE habit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL DEFAULT 'ilan',
  fecha       TEXT NOT NULL,
  hora        TEXT,
  kind        TEXT NOT NULL,                 -- comida | agua | ejercicio
  detalle     TEXT,
  macro       TEXT, tipo TEXT, procesado TEXT,
  kcal        REAL, ml REAL, min REAL,
  ingredientes TEXT
);
CREATE INDEX idx_habit_log ON habit_log (tenant_id, fecha, kind);

-- Movimientos del país secundario (cargas, gastos, pagos, transferencias).
CREATE TABLE foreign_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL DEFAULT 'ilan',
  mes          TEXT NOT NULL,
  tab          TEXT,
  src_row      INTEGER,
  fecha        TEXT,
  tipo         TEXT,
  detalle      TEXT,
  usd          REAL,
  cotizacion   REAL,
  monto_local  REAL,                         -- importe en la moneda local del país (hoy ARS)
  quien        TEXT,
  categoria    TEXT
);
CREATE INDEX idx_foreign ON foreign_movements (tenant_id, mes);

CREATE TABLE foreign_months (
  tenant_id       TEXT NOT NULL DEFAULT 'ilan',
  mes             TEXT NOT NULL,
  deuda_antes_usd REAL,
  PRIMARY KEY (tenant_id, mes)
);
