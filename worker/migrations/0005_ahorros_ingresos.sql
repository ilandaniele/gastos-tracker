-- Cache de cotizaciones para el módulo Ahorros (reemplaza CacheService + GOOGLEFINANCE de Apps Script).
-- Guarda el último precio conocido de cada ticker (en USD) y de cada tipo de cambio.
-- Sirve a la vez de cache (si es reciente no se vuelve a pedir) y de respaldo: si la fuente
-- externa falla se usa el último valor, igual que hacía el Sheet con la columna "Precio hoy".
-- Son datos de mercado, no del usuario, por eso no llevan tenant_id.
--   clave: 'px:NVDA' (precio de la acción en USD) | 'fx:EUR' (1 EUR en USD) | 'fx:USDUYU' (pesos por dólar)
--   at:    milisegundos epoch de cuándo se obtuvo
CREATE TABLE IF NOT EXISTS price_cache (
  clave       TEXT PRIMARY KEY,
  precio      REAL NOT NULL,
  moneda_orig TEXT,
  precio_orig REAL,
  at          INTEGER NOT NULL
);
