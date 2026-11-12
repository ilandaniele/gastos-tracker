-- Push por cuenta: una fila por dispositivo suscripto. El push va vacío (sin payload), así que solo hace falta el
-- endpoint; no se guardan claves. 'ultimo' = 'tipo:YYYY-MM-DD' del último aviso mandado (evita repetirlo).
CREATE TABLE IF NOT EXISTS push_subs (
  tenant_id TEXT NOT NULL,
  hash      TEXT NOT NULL,
  endpoint  TEXT NOT NULL,
  creada    TEXT NOT NULL,
  ultimo    TEXT,
  PRIMARY KEY (tenant_id, hash)
);
