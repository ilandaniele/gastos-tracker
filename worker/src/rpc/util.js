// Helpers compartidos por los módulos de la API de escritura (src/rpc/*.js).
//
// Config por tenant: llamar() (src/rpc.js) le pasa a cada handler un `env` con `env.cfg` (ver src/tenantcfg.js).
// Los helpers de fecha aceptan ese env (o directamente una zona IANA); sin cfg (informes.js, pending.js, que
// siguen siendo solo de 'ilan') usan America/Montevideo, igual que antes.
export const TZ_DEFECTO = 'America/Montevideo';
export const tzDe = (x) => (typeof x === 'string' && x ? x : (x && x.cfg && x.cfg.tz) || TZ_DEFECTO);
// Moneda LOCAL del tenant (la otra siempre es USD). Sin cfg: 'UYU' (comportamiento original).
export const monedaLocal = (x) => (x && x.cfg && x.cfg.moneda) || 'UYU';
// 'YYYY-MM-DD' de hoy en la zona del tenant.
export const hoy = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: tzDe(x) }).format(new Date());
// 'HH:MM' (24 h) de ahora en la zona del tenant.
export const ahoraHM = (x) => new Intl.DateTimeFormat('en-GB', { timeZone: tzDe(x), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
// Fuente de verdad por defecto de un módulo cuando settings no dice nada: el tenant original ('ilan') sigue
// atado al Sheet hasta que lo corta a mano; cualquier cuenta nueva nace sobre D1 (no tiene Sheet).
export const fuenteDefecto = (tenant) => (tenant === 'ilan' ? 'sheet' : 'd1');
export const idDe = (d) => { const n = parseInt(d && (d.row != null ? d.row : d.id), 10); if (!Number.isFinite(n) || n < 1) throw new Error('Fila inválida'); return n; };

// SOLO TESTS LOCALES: `wrangler dev --var FX_TEST_RATES:'{"ARS":1000}'` fija la cotización USD->moneda sin
// salir a internet. Nunca en wrangler.toml ni en producción. Devuelve null si no hay override para esa moneda.
export function fxOverride(env, moneda) {
  if (!env || !env.FX_TEST_RATES) return null;
  try {
    const v = Number(JSON.parse(env.FX_TEST_RATES)[moneda]);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

// Cuota diaria de Gemini por cuenta (control de costo y abuso). Una fila en settings ('gemini_uso' = 'YYYY-MM-DD:n',
// día en la zona de la cuenta) con upsert atómico: una escritura por llamada. Las fotos pesan más que el texto.
// Límite por día: GEMINI_LIMITE_DIA (var/secret) si existe; si no 600 para 'ilan' y 60 (≈15 fotos) para el resto.
export const PESO_GEMINI_FOTO = 4;
export async function usarGemini(env, peso) {
  const tenant = env && env.tenant;
  if (!tenant || !env.DB) return { ok: true }; // informes/pending (solo ilan) no pasan por acá
  const envLim = parseInt(env.GEMINI_LIMITE_DIA, 10);
  const limite = Number.isFinite(envLim) && envLim > 0 ? envLim : (tenant === 'ilan' ? 600 : 60);
  const dia = hoy(env);
  const fila = await env.DB.prepare(
    `INSERT INTO settings (tenant_id, clave, valor) VALUES (?1, 'gemini_uso', ?2 || ':' || ?3)
     ON CONFLICT (tenant_id, clave) DO UPDATE SET valor = CASE
       WHEN substr(valor, 1, 10) = ?2 THEN ?2 || ':' || (CAST(substr(valor, 12) AS INTEGER) + ?3)
       ELSE ?2 || ':' || ?3 END
     RETURNING valor`
  ).bind(tenant, dia, peso).first();
  const usado = parseInt(String(fila && fila.valor || '').slice(11), 10) || 0;
  if (usado > limite) return { ok: false, error: 'Llegaste al límite diario de escaneos con IA. Probá mañana o cargalo a mano.' };
  return { ok: true };
}
