-- Cuentas propias (multi-tenant): una fila por cliente, login por magic link, sesiones por cookie.
-- Del token del mail y del sid de la cookie solo se guarda el hash SHA-256 (hex): con la base a la vista
-- no se puede entrar. El valor en claro viaja una vez (mail / cookie) y no se persiste en ningún lado.

CREATE TABLE IF NOT EXISTS tenants (
  id               TEXT PRIMARY KEY,           -- 'ilan' (el original) o 't_' + 12 hex
  email            TEXT UNIQUE NOT NULL,       -- en minúsculas
  creado           TEXT,                       -- ISO 8601
  pais             TEXT,
  moneda           TEXT,
  tz               TEXT,
  onboarding_listo INTEGER NOT NULL DEFAULT 0
);

-- expira = creado + 15 min. No hay columna "creado": el rate limit de pedirLink() cuenta las filas con
-- expira > ahora - 45 min (= pedidas en la última hora), y se purgan las de más de 2 horas.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expira     INTEGER NOT NULL,                 -- epoch en segundos
  usado      INTEGER NOT NULL DEFAULT 0,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email, expira);
CREATE INDEX IF NOT EXISTS idx_login_tokens_ip ON login_tokens (ip, expira);

CREATE TABLE IF NOT EXISTS sesiones (
  sid_hash  TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  creado    INTEGER NOT NULL,                  -- epoch en segundos
  expira    INTEGER NOT NULL,
  ua        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sesiones_tenant ON sesiones (tenant_id);

INSERT OR IGNORE INTO tenants (id, email, creado, onboarding_listo)
VALUES ('ilan', 'ilan.daniele@gmail.com', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1);
