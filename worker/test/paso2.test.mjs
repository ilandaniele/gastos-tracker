// Tests de integración del paso 2 multi-tenant (config por cuenta). Ver docs/MULTI-TENANT-PASO2.md.
//
// Necesita un `wrangler dev --local` levantado contra una base local con las migraciones 0001-0007, con:
//   --var VIEW_KEY:y --var APP_KEY:x --var ACCESS_AUD:x --var DEV_MOSTRAR_LINK:1
//   --var FX_TEST_RATES:'{"ARS":1000,"MXN":18}' --var GEMINI_API_KEY:mentira --var GEMINI_LIMITE_DIA:8
// y la base sembrada con: settings de 'ilan' con todos los módulos en d1 (fuente_<modulo> = 'd1') y un gasto
// 'SECRETO_DE_ILAN'. Uso: node test/paso2.test.mjs http://127.0.0.1:PUERTO
import assert from 'node:assert/strict';

const B = process.argv[2] || 'http://127.0.0.1:8843';
const out = [];
let fallas = 0;
const t = async (nombre, fn) => {
  try { await fn(); out.push('OK   ' + nombre); } catch (e) { fallas++; out.push('FAIL ' + nombre + ' -> ' + e.message); }
};
const f = (p, o = {}) => fetch(B + p, { redirect: 'manual', ...o });
const post = (p, body, h = {}) => f(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const rpc = async (cookie, nombre, ...args) => (await post('/api/rpc/' + nombre, { args }, { Cookie: cookie })).json();
const getJ = async (p, cookie) => (await f(p, { headers: { Cookie: cookie } })).json();
const ILAN = 'vk=y';
const hoyEn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const CARDS_ILAN = ['Débito UYU', 'Crédito OCA', 'Crédito Itaú UYU', 'Crédito Itaú USD', 'Débito USD', 'Efectivo UYU', 'Efectivo USD'];
const CSP_ONBOARDING = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Sesión nueva por magic link (DEV_MOSTRAR_LINK devuelve el link en la respuesta).
async function cuentaNueva(email) {
  const j = await (await post('/login', { email })).json();
  if (!j.dev_link) throw new Error('sin dev_link: ' + JSON.stringify(j));
  const r = await f(new URL(j.dev_link).pathname, { method: 'POST', headers: { Origin: B } });
  const sid = (r.headers.getSetCookie().find((c) => c.startsWith('sid=')) || '').split(';')[0];
  if (!sid) throw new Error('sin sid');
  return sid;
}
const opcionesDe = (html, id) => {
  const m = html.match(new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)</select>'));
  return m ? [...m[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((x) => x[1].replace(/&amp;/g, '&')) : null;
};
const gastosDe = async (cookie, q = '') => (await getJ('/api/expenses' + q, cookie)).rows;

// ---------------------------------------------------------------- ilan: defaults idénticos
await t('ilan: GET /api/config = defaults (UY, UYU, Montevideo, sus 7 medios, onboarding listo)', async () => {
  const j = await getJ('/api/config', ILAN);
  assert.equal(j.ok, true);
  assert.equal(j.config.pais, 'UY'); assert.equal(j.config.moneda, 'UYU'); assert.equal(j.config.tz, 'America/Montevideo');
  assert.deepEqual(j.config.medios, CARDS_ILAN);
  assert.equal(j.config.onboarding_listo, true);
  assert.equal(j.config.categorias[j.config.categorias.length - 1], 'Otros');
  assert.deepEqual(j.config.modulos, { accesosRapidos: true, pais: true, personal: true });
});
await t('ilan: /app 200 (no va al onboarding), mismos medios en el mismo orden, fecha de hoy en Montevideo', async () => {
  const r = await f('/app', { headers: { Cookie: ILAN } }); const h = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual(opcionesDe(h, 'fCard'), CARDS_ILAN);
  assert.deepEqual(opcionesDe(h, 'expCard'), CARDS_ILAN);
  assert.ok(h.includes(hoyEn('America/Montevideo')));
});
await t('ilan: gasto sin fecha queda con hoy de Montevideo, UYU, sin cotización inventada', async () => {
  const j = await rpc(ILAN, 'addExpenseSafe', { item: 'Pan ilan hoy', amount: 100, currency: 'UYU', card: 'Débito UYU', cotizacion: 40 });
  assert.equal(j.ok, true, JSON.stringify(j));
  const g = (await gastosDe(ILAN)).find((x) => x.concepto === 'Pan ilan hoy');
  assert.equal(g.moneda, 'UYU'); assert.equal(g.fecha, hoyEn('America/Montevideo')); assert.equal(g.medio_pago, 'Débito UYU');
});
await t('ilan: POST /api/config sin Origin propio 403, sin JSON 415', async () => {
  assert.equal((await post('/api/config', {}, { Cookie: ILAN, Origin: 'https://evil.com' })).status, 403);
  assert.equal((await f('/api/config', { method: 'POST', headers: { Cookie: ILAN, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});

// ---------------------------------------------------------------- cuenta nueva: onboarding
let A, M, U;
await t('cuenta nueva: /app redirige 302 a /onboarding', async () => {
  A = await cuentaNueva('ar.cliente@ejemplo.com');
  const r = await f('/app', { headers: { Cookie: A } });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/onboarding');
});
await t('cuenta nueva: GET /onboarding 200 con CSP, no-store, Referrer-Policy same-origin', async () => {
  const r = await f('/onboarding', { headers: { Cookie: A } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), CSP_ONBOARDING);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /<html/);
});
await t('sin sesión: /onboarding redirige a /login; POST /api/config 403', async () => {
  const r = await f('/onboarding'); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login');
  const p = await post('/api/config', { pais: 'AR', moneda: 'ARS', tz: 'America/Argentina/Buenos_Aires', medios: ['x'], categorias: [] });
  assert.equal(p.status, 403); assert.equal((await p.json()).ok, false);
});
await t('cuenta nueva: GET /api/config con onboarding_listo=false', async () => {
  const j = await getJ('/api/config', A); assert.equal(j.ok, true); assert.equal(j.config.onboarding_listo, false);
  assert.deepEqual(j.config.modulos, { accesosRapidos: false, pais: false, personal: false });
});

const BASE_AR = {
  pais: 'ar', moneda: 'ars', tz: 'America/Argentina/Buenos_Aires',
  medios: ['Débito ARS', 'Efectivo ARS', 'Tarjeta Visa', 'Débito USD'],
  categorias: ['Otros', 'Comida', 'Transporte', 'Salud', 'Hogar'],
  modulos: { accesosRapidos: true, pais: false }
};
const esperar400 = async (body, re, nombre) => {
  const r = await post('/api/config', body, { Cookie: A });
  const j = await r.json();
  assert.equal(r.status, 400, nombre + ': ' + JSON.stringify(j)); assert.equal(j.ok, false); assert.match(j.error, re);
};
await t('POST /api/config inválido: moneda que no es de 3 letras -> 400 con mensaje claro', async () => {
  await esperar400({ ...BASE_AR, moneda: 'PESO' }, /Moneda inválida/, 'PESO');
  await esperar400({ ...BASE_AR, moneda: 'A1' }, /Moneda inválida/, 'A1');
});
await t('POST /api/config inválido: zona horaria -> 400', async () => {
  await esperar400({ ...BASE_AR, tz: 'Marte/Base_Alfa' }, /Zona horaria inválida/, 'tz');
});
await t('POST /api/config inválido: medios repetidos (mayúsculas/tildes) -> 400', async () => {
  await esperar400({ ...BASE_AR, medios: ['Débito ARS', 'debito ars'] }, /repetido/, 'dup');
});
await t('POST /api/config inválido: más de 20 medios -> 400', async () => {
  await esperar400({ ...BASE_AR, medios: Array.from({ length: 21 }, (_, i) => 'Medio ' + i) }, /máximo 20/, '21');
});
await t('POST /api/config inválido: medio con < > -> 400; país inválido -> 400; sin medios -> 400', async () => {
  await esperar400({ ...BASE_AR, medios: ['<b>x</b>'] }, /< ni >/, 'html');
  await esperar400({ ...BASE_AR, pais: 'ARG' }, /País inválido/, 'pais');
  await esperar400({ ...BASE_AR, medios: [] }, /al menos uno/, 'vacío');
  await esperar400({ ...BASE_AR, modulos: { personal: 'si' } }, /"personal" tiene que ser true o false/, 'personal');
});
await t('POST /api/config: Origin ajeno 403, Content-Type no JSON 415, > 20KB 413, JSON roto 400', async () => {
  assert.equal((await post('/api/config', BASE_AR, { Cookie: A, Origin: 'https://evil.com' })).status, 403);
  assert.equal((await f('/api/config', { method: 'POST', headers: { Cookie: A, 'Content-Type': 'text/plain' }, body: JSON.stringify(BASE_AR) })).status, 415);
  assert.equal((await post('/api/config', { ...BASE_AR, relleno: 'x'.repeat(21 * 1024) }, { Cookie: A })).status, 413);
  assert.equal((await post('/api/config', '{"pais":', { Cookie: A })).status, 400);
  assert.equal((await getJ('/api/config', A)).config.onboarding_listo, false, 'nada de eso guardó');
});
await t('POST /api/config válido: 200, normaliza mayúsculas y pone "Otros" al final', async () => {
  const r = await post('/api/config', BASE_AR, { Cookie: A, Origin: B }); const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.config.pais, 'AR'); assert.equal(j.config.moneda, 'ARS');
  assert.deepEqual(j.config.categorias, ['Comida', 'Transporte', 'Salud', 'Hogar', 'Otros']);
  assert.equal(j.config.onboarding_listo, true);
  const g = await getJ('/api/config', A); assert.deepEqual(g.config.medios, BASE_AR.medios);
  // catRules: solo reglas de las categorías elegidas (Comida, Transporte, Salud, Hogar); nada de Viajes, Ropa...
  assert.ok(g.config.catRules.length > 0);
  assert.ok(g.config.catRules.every((x) => g.config.categorias.includes(x.cat)), JSON.stringify(g.config.catRules.map((x) => x.cat)));
  assert.deepEqual(g.config.modulos, { accesosRapidos: true, pais: false, personal: false });
});
await t('módulos: accesosRapidos/personal se guardan; sin "modulos" en el body se conservan', async () => {
  let r = await post('/api/config', { ...BASE_AR, modulos: { accesosRapidos: false, pais: false, personal: true } }, { Cookie: A });
  assert.equal(r.status, 200, await r.text());
  assert.deepEqual((await getJ('/api/config', A)).config.modulos, { accesosRapidos: false, pais: false, personal: true });
  const { modulos, ...sinModulos } = BASE_AR;
  r = await post('/api/config', sinModulos, { Cookie: A }); assert.equal(r.status, 200);
  assert.deepEqual((await getJ('/api/config', A)).config.modulos, { accesosRapidos: false, pais: false, personal: true });
  r = await post('/api/config', BASE_AR, { Cookie: A }); assert.equal(r.status, 200);
  assert.deepEqual((await getJ('/api/config', A)).config.modulos, { accesosRapidos: true, pais: false, personal: true });
});
await t('después del onboarding: /app 200 con los medios de la cuenta y su fecha', async () => {
  const r = await f('/app', { headers: { Cookie: A } }); const h = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual(opcionesDe(h, 'fCard'), BASE_AR.medios);
  assert.ok(h.includes(hoyEn('America/Argentina/Buenos_Aires')));
  assert.match(h, /"moneda":"ARS"/);
});
await t('moneda inmutable: cambiarla después del onboarding -> 400; mismo body con la misma moneda -> 200', async () => {
  await esperar400({ ...BASE_AR, moneda: 'MXN' }, /no se puede cambiar/, 'mxn');
  const r = await post('/api/config', { ...BASE_AR, medios: [...BASE_AR.medios, 'Mercado Pago'] }, { Cookie: A });
  assert.equal(r.status, 200);
  assert.equal((await getJ('/api/config', A)).config.moneda, 'ARS');
});

// ---------------------------------------------------------------- gastos en ARS / MXN
await t('ARS: gasto sin fecha -> moneda ARS, fecha de hoy en Buenos Aires, cotización 1000 (FX_TEST_RATES)', async () => {
  const j = await rpc(A, 'addExpenseSafe', { item: 'Supermercado Coto', amount: 5000, currency: 'ARS', card: 'debito ars' });
  assert.equal(j.ok, true, JSON.stringify(j));
  const g = (await gastosDe(A)).find((x) => x.concepto === 'Supermercado Coto');
  assert.equal(g.moneda, 'ARS'); assert.equal(g.medio_pago, 'Débito ARS');
  assert.equal(g.fecha, hoyEn('America/Argentina/Buenos_Aires')); assert.equal(g.cotizacion, 1000);
  assert.equal(g.es_credito, 0);
});
await t('ARS: gasto con medio en USD -> moneda USD, cotización 1000', async () => {
  const j = await rpc(A, 'addExpenseSafe', { item: 'Netflix', amount: 10, currency: 'USD', card: 'Débito USD', date: '2026-11-05' });
  assert.equal(j.ok, true, JSON.stringify(j));
  const g = (await gastosDe(A)).find((x) => x.concepto === 'Netflix');
  assert.equal(g.moneda, 'USD'); assert.equal(g.cotizacion, 1000); assert.equal(g.fecha, '2026-11-05');
});
await t('ARS: medio de pago que no está en la lista -> error', async () => {
  const j = await rpc(A, 'addExpenseSafe', { item: 'X', amount: 1, currency: 'ARS', card: 'Crédito OCA', date: '2026-11-05' });
  assert.equal(j.ok, false); assert.match(j.error, /Medio de pago "Crédito OCA" no encontrado/);
});
await t('ARS: /api/months suma en ARS; /api/categories y filtro moneda=ARS funcionan', async () => {
  const mes = hoyEn('America/Argentina/Buenos_Aires').slice(0, 7);
  const m = (await getJ('/api/months', A)).months.find((x) => x.mes === mes);
  assert.ok(m && m.uyu >= 5000, JSON.stringify(m));
  const c = await getJ('/api/categories', A); assert.equal(c.ok, true); assert.ok(c.categories.length > 0);
  const soloArs = await gastosDe(A, '?moneda=ARS'); assert.ok(soloArs.length >= 1 && soloArs.every((x) => x.moneda === 'ARS'));
  const soloUyu = await gastosDe(A, '?moneda=UYU'); assert.ok(soloUyu.length >= 2, 'UYU no es filtro para ARS: devuelve todo');
});
await t('ARS: getDashboardData responde con totales en ARS', async () => {
  const j = await rpc(A, 'getDashboardData', '2026-11');
  assert.equal(j.ok === false, false, JSON.stringify(j).slice(0, 300));
});
await t('ARS: ahorros usan la cotización ARS (moneda local en monedas)', async () => {
  const s = await rpc(A, 'getSavingsDataSafe');
  assert.notEqual(s.ok, false, JSON.stringify(s).slice(0, 300));
  assert.ok(JSON.stringify(s.monedas || []).includes('ARS'), JSON.stringify(s.monedas));
});

await t('MXN: cuenta nueva configurada en México; gasto -> MXN, fecha de Ciudad de México, cotización 18', async () => {
  M = await cuentaNueva('mx.cliente@ejemplo.com');
  const r = await post('/api/config', { pais: 'MX', moneda: 'MXN', tz: 'America/Mexico_City', medios: ['Débito MXN', 'Efectivo MXN', 'Crédito USD'], categorias: ['Comida', 'Otros'] }, { Cookie: M });
  assert.equal(r.status, 200, await r.text());
  const j = await rpc(M, 'addExpenseSafe', { item: 'Tacos', amount: 250, currency: 'MXN', card: 'Efectivo MXN' });
  assert.equal(j.ok, true, JSON.stringify(j));
  const g = (await gastosDe(M)).find((x) => x.concepto === 'Tacos');
  assert.equal(g.moneda, 'MXN'); assert.equal(g.fecha, hoyEn('America/Mexico_City')); assert.equal(g.cotizacion, 18);
});
await t('MXN: tarjeta de crédito en USD queda es_credito=1 y moneda USD', async () => {
  const j = await rpc(M, 'addExpenseSafe', { item: 'Vuelo', amount: 300, currency: 'USD', card: 'Crédito USD', date: '2026-11-03' });
  assert.equal(j.ok, true, JSON.stringify(j));
  const g = (await gastosDe(M)).find((x) => x.concepto === 'Vuelo');
  assert.equal(g.moneda, 'USD'); assert.equal(g.es_credito, 1);
});

await t('USD como moneda local: cotización 1 y medios sin moneda local duplicada', async () => {
  U = await cuentaNueva('usd.cliente@ejemplo.com');
  const r = await post('/api/config', { pais: 'EC', moneda: 'USD', tz: 'America/Guayaquil', medios: ['Débito USD', 'Efectivo USD'], categorias: [] }, { Cookie: U });
  assert.equal(r.status, 200, await r.text());
  const j = await rpc(U, 'addExpenseSafe', { item: 'Almuerzo', amount: 12, currency: 'USD', card: 'Efectivo USD', date: '2026-11-04' });
  assert.equal(j.ok, true, JSON.stringify(j));
  const g = (await gastosDe(U)).find((x) => x.concepto === 'Almuerzo');
  assert.equal(g.moneda, 'USD'); assert.equal(g.cotizacion, 1);
});
await t('USD como moneda local: todo va al bucket local (uyu) y el de USD queda en 0 (sin doble conteo)', async () => {
  const j = await rpc(U, 'addExpenseSafe', { item: 'Taxi', amount: 8, currency: 'USD', card: 'Débito USD', date: '2026-11-05' });
  assert.equal(j.ok, true, JSON.stringify(j));
  const d = await rpc(U, 'getDashboardData', '2026-11');
  assert.equal(d.totals.uyu, 20, JSON.stringify(d.totals)); assert.equal(d.totals.usd, 0);
  assert.equal(d.totals.uyuInUyu, 20); assert.equal(d.totals.uyuInUsd, 20);
  assert.ok(d.byCategory.every((c) => c.usd === 0), JSON.stringify(d.byCategory));
  assert.equal(d.byCategory.reduce((s, c) => s + c.uyu, 0), 20);
  const m = (await getJ('/api/months', U)).months.find((x) => x.mes === '2026-11');
  assert.equal(m.uyu, 20, JSON.stringify(m)); assert.equal(m.usd, 0);
  const l = await getJ('/api/expenses?mes=2026-11', U); assert.equal(l.uyu, 20); assert.equal(l.usd, 0);
  const c = await getJ('/api/categories?mes=2026-11', U);
  assert.ok(c.categories.every((x) => x.usd === 0), JSON.stringify(c.categories));
  assert.equal(c.categories.reduce((s, x) => s + x.uyu, 0), 20);
  assert.equal((await gastosDe(U, '?moneda=USD')).length, 2);
});
await t('USD como moneda local: saldo de ahorros en el bucket local; el de USD null', async () => {
  const a = await rpc(U, 'addSavingsSafe', { fecha: '2026-11-02', tipo: 'Banco', entidad: 'Banco X', monto: 1000, moneda: 'USD' });
  assert.notEqual(a.ok, false, JSON.stringify(a));
  const s = await rpc(U, 'getSavingsDataSafe');
  assert.notEqual(s.ok, false, JSON.stringify(s).slice(0, 300));
  assert.deepEqual(s.monedas, ['USD']);
  // 1000 en el banco menos los gastos del mes que no son en efectivo (Taxi 8; el Almuerzo fue en efectivo).
  const esperado = hoyEn('America/Guayaquil').slice(0, 7) === '2026-11' ? 992 : 1000;
  assert.equal(s.saldo.uyu, esperado, JSON.stringify(s.saldo)); assert.equal(s.saldo.usd, null); assert.equal(s.saldo.gastosUsd, 0);
});

// ---------------------------------------------------------------- "Se paga el mes siguiente" (pagaDespues)
await t('pagaDespues: débito + pagaDespues:true queda es_credito=1 y no suma al mes; sin el flag suma', async () => {
  const antes = (await getJ('/api/expenses?mes=2026-10', A)).uyu;
  let j = await rpc(A, 'addExpenseSafe', { item: 'Heladera en cuotas', amount: 70000, currency: 'ARS', card: 'Débito ARS', date: '2026-10-10', pagaDespues: true });
  assert.equal(j.ok, true, JSON.stringify(j)); assert.equal(j.written && j.written.pagaDespues, true);
  j = await rpc(A, 'addExpenseSafe', { item: 'Verdulería', amount: 3000, currency: 'ARS', card: 'Débito ARS', date: '2026-10-11' });
  assert.equal(j.ok, true, JSON.stringify(j));
  const rows = await gastosDe(A, '?mes=2026-10');
  assert.equal(rows.find((x) => x.concepto === 'Heladera en cuotas').es_credito, 1);
  assert.equal(rows.find((x) => x.concepto === 'Verdulería').es_credito, 0);
  assert.equal((await getJ('/api/expenses?mes=2026-10', A)).uyu - antes, 3000);
  const tot = (await rpc(A, 'getMonthlyTotals'));
  assert.ok(!JSON.stringify(tot).includes('73000'), 'el total no incluye la heladera');
  const d = await rpc(A, 'getDashboardData', '2026-10');
  const h = (d.expenses || d.variables || []).find((x) => x.item === 'Heladera en cuotas');
  if (h) assert.equal(h.credito, true);
});
await t('pagaDespues en la edición: true -> es_credito=1; sin el flag vuelve a lo que diga el medio', async () => {
  const g = (await gastosDe(A, '?mes=2026-10')).find((x) => x.concepto === 'Verdulería');
  let j = await rpc(A, 'updateExpenseSafe', { row: g.id, expectedItem: 'Verdulería', item: 'Verdulería', amount: 3000, card: 'Débito ARS', date: '2026-10-11', pagaDespues: true });
  assert.notEqual(j.ok, false, JSON.stringify(j));
  assert.equal((await gastosDe(A, '?mes=2026-10')).find((x) => x.id === g.id).es_credito, 1);
  j = await rpc(A, 'updateExpenseSafe', { row: g.id, expectedItem: 'Verdulería', item: 'Verdulería', amount: 3000, card: 'Débito ARS', date: '2026-10-11' });
  assert.notEqual(j.ok, false, JSON.stringify(j));
  assert.equal((await gastosDe(A, '?mes=2026-10')).find((x) => x.id === g.id).es_credito, 0);
});
await t('pagaDespues que no es true (string "true", 1) no cambia nada', async () => {
  const j = await rpc(A, 'addExpenseSafe', { item: 'Kiosco', amount: 500, currency: 'ARS', card: 'Débito ARS', date: '2026-10-12', pagaDespues: 'true' });
  assert.equal(j.ok, true);
  assert.equal((await gastosDe(A, '?mes=2026-10')).find((x) => x.concepto === 'Kiosco').es_credito, 0);
});

// ---------------------------------------------------------------- aislamiento
await t('aislamiento: cada cuenta ve solo sus gastos y su config', async () => {
  const a = (await gastosDe(A)).map((x) => x.concepto), m = (await gastosDe(M)).map((x) => x.concepto), i = (await gastosDe(ILAN)).map((x) => x.concepto);
  assert.ok(a.includes('Supermercado Coto') && !a.includes('Tacos') && !a.includes('SECRETO_DE_ILAN'), JSON.stringify(a));
  assert.ok(m.includes('Tacos') && !m.includes('Supermercado Coto') && !m.includes('SECRETO_DE_ILAN'), JSON.stringify(m));
  assert.ok(i.includes('SECRETO_DE_ILAN') && !i.includes('Tacos') && !i.includes('Supermercado Coto'), JSON.stringify(i));
  assert.equal((await getJ('/api/config', M)).config.moneda, 'MXN');
  assert.equal((await getJ('/api/config', ILAN)).config.moneda, 'UYU');
});
await t('aislamiento: la config de M no cambia al guardar la de A; ilan sigue con sus defaults', async () => {
  await post('/api/config', { ...BASE_AR, medios: ['Débito ARS'] }, { Cookie: A });
  assert.deepEqual((await getJ('/api/config', M)).config.medios, ['Débito MXN', 'Efectivo MXN', 'Crédito USD']);
  assert.deepEqual((await getJ('/api/config', ILAN)).config.medios, CARDS_ILAN);
});
await t('aislamiento: A no puede editar un gasto de M por id', async () => {
  const g = (await gastosDe(M)).find((x) => x.concepto === 'Tacos');
  const j = await rpc(A, 'updateExpenseSafe', { row: g.id, expectedItem: 'Tacos', item: 'Hackeado', amount: 1, card: 'Débito ARS' });
  assert.equal(j.ok, false);
  assert.ok((await gastosDe(M)).some((x) => x.concepto === 'Tacos'));
});
await t('/api/props (antes GET /api/config) sigue dando la tabla config', async () => {
  const j = await getJ('/api/props', ILAN); assert.equal(j.ok, true); assert.ok(Array.isArray(j.config));
});

await t('Gemini: cuota diaria por cuenta (GEMINI_LIMITE_DIA:8 y GEMINI_API_KEY de mentira): 2 fotos pasan, la 3ª se corta', async () => {
  const r1 = await rpc(A, 'scanTicket', 'AAAA'); const r2 = await rpc(A, 'scanTicket', 'AAAA'); const r3 = await rpc(A, 'scanTicket', 'AAAA');
  assert.doesNotMatch(r1.error || '', /límite diario/); assert.doesNotMatch(r2.error || '', /límite diario/);
  assert.equal(r3.ok, false); assert.match(r3.error, /límite diario/);
  const rm = await rpc(A, 'scanMealSafe', 'AAAA', '12:00'); assert.match(rm.error, /límite diario/);
  assert.doesNotMatch((await rpc(M, 'scanTicket', 'AAAA')).error || '', /límite diario/); // la cuota es por cuenta
});

console.log(out.join('\n'));
console.log(`\n${out.length - fallas}/${out.length} OK`);
process.exitCode = fallas ? 1 : 0;
