-- Paso 2 multi-tenant: config de la cuenta (JSON con medios, categorías, módulos; ver src/tenantcfg.js).
-- NULL = defaults (para 'ilan', su config de siempre).
ALTER TABLE tenants ADD COLUMN config TEXT;
