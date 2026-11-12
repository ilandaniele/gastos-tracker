// Tests de planes y pagos (src/planes.js, src/pagos.js, migración 0009) con proveedores SIMULADOS: nunca se llama
// a Stripe ni a Mercado Pago de verdad. El test levanta un servidor falso que hace de las dos APIs.
//
// Necesita un `wrangler dev --local` levantado contra una base local con las migraciones 0001-0009, con:
//   --var VIEW_KEY:y --var APP_KEY:x --var ACCESS_AUD:x --var DEV_MOSTRAR_LINK:1
//   --var STRIPE_SECRET_KEY:sk_test_falsa --var STRIPE_WEBHOOK_SECRET:whsec_falsa
//   --var MP_ACCESS_TOKEN:mp_falso --var MP_WEBHOOK_SECRET:mp_secreto_falso
//   --var STRIPE_API_BASE:http://127.0.0.1:<PUERTO_FALSO> --var MP_API_BASE:http://127.0.0.1:<PUERTO_FALSO>
//   --var PLAN_MANUAL_INFO:'Transferí a la cuenta 123' --var CONTACT_EMAIL:contacto@ejemplo.com
//   --var 'PLAN_PRECIOS:{"mes":{"USD":4.99,"ARS":6000,"UYU":199},"anio":{"USD":49,"ARS":60000}}'
// Uso: node test/planes.test.mjs http://127.0.0.1:PUERTO [PUERTO_FALSO=8899]
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { planEfectivo, preciosDe, ofertaDe, ofertas } from '../src/planes.js';
import { usarGemini } from '../src/rpc/util.js';

const B = process.argv[2] || 'http://127.0.0.1:8870';
const PUERTO_FALSO = Number(process.argv[3] || 8899);
const STRIPE_SECRET = 'whsec_falsa', MP_SECRET = 'mp_secreto_falso';
const out = [];
let fallas = 0;
const t = async (nombre, fn) => {
  try { await fn(); out.push('OK   ' + nombre); } catch (e) { fallas++; out.push('FAIL ' + nombre + ' -> ' + e.message); }
};
const f = (p, o = {}) => fetch(B + p, { redirect: 'manual', ...o });
const post = (p, body, h = {}) => f(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ILAN = 'vk=y';
const hmac = (s, txt) => crypto.createHmac('sha256', s).update(txt).digest('hex');

// ------------------------------------------------------------------ servidor falso de Stripe / Mercado Pago
const visto = { stripe: [], mpPref: [], mpPagos: {} };
const falso = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      visto.stripe.push({ auth: req.headers.authorization, form: new URLSearchParams(cuerpo) });
      return json({ id: 'cs_test_1', url: 'https://checkout.stripe.example/c/cs_test_1' });
    }
    if (req.method === 'POST' && req.url === '/checkout/preferences') {
      visto.mpPref.push({ auth: req.headers.authorization, body: JSON.parse(cuerpo) });
      return json({ id: 'pref1', init_point: 'https://www.mercadopago.example/checkout/pref1' });
    }
    const m = req.url.match(/^\/v1\/payments\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const p = visto.mpPagos[m[1]];
      return p ? json(p) : json({ message: 'not found' }, 404);
    }
    json({ error: 'ruta falsa' }, 404);
  });
});
await new Promise((ok) => falso.listen(PUERTO_FALSO, '127.0.0.1', ok));

async function cuentaNueva(email, cfg) {
  const j = await (await post('/login', { email })).json();
  if (!j.dev_link) throw new Error('sin dev_link: ' + JSON.stringify(j));
  const r = await f(new URL(j.dev_link).pathname, { method: 'POST', headers: { Origin: B } });
  const sid = (r.headers.getSetCookie().find((c) => c.startsWith('sid=')) || '').split(';')[0];
  if (!sid) throw new Error('sin sid');
  if (cfg) {
    const c = await post('/api/config', cfg, { Cookie: sid });
    if (c.status !== 200) throw new Error('config: ' + (await c.text()));
  }
  return sid;
}
const CFG_ARS = { pais: 'ar', moneda: 'ars', tz: 'America/Argentina/Buenos_Aires', medios: ['Débito ARS', 'Efectivo ARS'], categorias: ['Otros', 'Comida'], modulos: { accesosRapidos: false, pais: false } };
// El estado de la página viene embebido: "var E = {...};"
const estadoPlan = async (cookie, q = '') => {
  const r = await f('/plan' + q, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const h = await r.text();
  const m = h.match(/var E = (\{.*\});\n/);
  assert.ok(m, 'sin estado embebido');
  return { E: JSON.parse(m[1]), r, h };
};
const DIA = 86400000;

// ------------------------------------------------------------------ unitarios
await t('planEfectivo: pro solo con plan_hasta en el futuro', () => {
  const ahora = '2026-06-01T00:00:00Z';
  assert.equal(planEfectivo(null, ahora), 'gratis');
  assert.equal(planEfectivo({ plan: 'gratis', plan_hasta: '2027-01-01T00:00:00Z' }, ahora), 'gratis');
  assert.equal(planEfectivo({ plan: 'pro', plan_hasta: null }, ahora), 'gratis');
  assert.equal(planEfectivo({ plan: 'pro', plan_hasta: '2026-05-31T23:59:59Z' }, ahora), 'gratis');
  assert.equal(planEfectivo({ plan: 'pro', plan_hasta: '2026-06-01T00:00:01Z' }, ahora), 'pro');
});

await t('preciosDe / ofertaDe / ofertas: validan, caen a USD y Mercado Pago exige su moneda', () => {
  assert.deepEqual(preciosDe({}), {});
  assert.deepEqual(preciosDe({ PLAN_PRECIOS: 'no es json' }), {});
  const p = preciosDe({ PLAN_PRECIOS: JSON.stringify({ mes: { USD: 5, ars: 1, EUR: -3, MXN: 'x' }, anio: 'raro', otro: { USD: 1 } }) });
  assert.deepEqual(p, { mes: { USD: 5 } });
  const pr = { mes: { USD: 5, UYU: 200 } };
  assert.deepEqual(ofertaDe(pr, 'mes', 'stripe', 'UYU'), { moneda: 'UYU', monto: 200 });
  assert.deepEqual(ofertaDe(pr, 'mes', 'stripe', 'CLP'), { moneda: 'USD', monto: 5 });
  assert.equal(ofertaDe(pr, 'mes', 'mercadopago', 'CLP'), null);       // cae a USD y MP no cobra USD
  assert.deepEqual(ofertaDe(pr, 'mes', 'mercadopago', 'UYU'), { moneda: 'UYU', monto: 200 });
  assert.equal(ofertaDe(pr, 'anio', 'stripe', 'UYU'), null);           // sin precio anual
  assert.deepEqual(ofertas({ PLAN_PRECIOS: '{"mes":{"USD":5}}' }, 'USD'), {}); // sin proveedores configurados
});

await t('usarGemini: límite por plan (gratis 60, pro 300, ilan 600) y GEMINI_LIMITE_DIA manda', async () => {
  const contador = () => { let usado = 0; return { prepare: () => ({ bind: (_t, dia, peso) => ({ first: async () => ({ valor: dia + ':' + (usado += peso) }) }) }) }; };
  const correr = async (env, n) => { const DB = contador(); let ult; for (let i = 0; i < n; i++) ult = await usarGemini({ DB, ...env }, 1); return ult; };
  const cfg = (plan) => ({ tz: 'UTC', plan });
  assert.equal((await correr({ tenant: 'x', cfg: cfg('gratis') }, 60)).ok, true);
  assert.equal((await correr({ tenant: 'x', cfg: cfg('gratis') }, 61)).ok, false);
  assert.equal((await correr({ tenant: 'x', cfg: cfg('pro') }, 300)).ok, true);
  assert.equal((await correr({ tenant: 'x', cfg: cfg('pro') }, 301)).ok, false);
  assert.equal((await correr({ tenant: 'x', cfg: cfg('pro'), GEMINI_LIMITE_DIA_PRO: '5' }, 6)).ok, false);
  assert.equal((await correr({ tenant: 'ilan', cfg: cfg('gratis') }, 600)).ok, true);
  assert.equal((await correr({ tenant: 'x', cfg: cfg('gratis'), GEMINI_LIMITE_DIA: '3' }, 4)).ok, false);
});

// ------------------------------------------------------------------ página
let A, tenantA;
await t('/plan: sin sesión a /login; cuenta nueva ve gratis y las ofertas en su moneda; ilan ve cuenta del dueño', async () => {
  const sin = await f('/plan'); assert.equal(sin.status, 302); assert.equal(sin.headers.get('location'), '/login');
  A = await cuentaNueva('plan.a@ejemplo.com', CFG_ARS);
  const { E, r } = await estadoPlan(A);
  assert.equal(E.plan, 'gratis'); assert.equal(E.hasta, null); assert.equal(E.propia, false);
  assert.deepEqual(Object.keys(E.ofertas).sort(), ['anio', 'mes']);
  assert.deepEqual(E.ofertas.mes.stripe, { moneda: 'ARS', monto: 6000 });
  assert.deepEqual(E.ofertas.mes.mercadopago, { moneda: 'ARS', monto: 6000 });
  assert.deepEqual(E.ofertas.anio.stripe, { moneda: 'ARS', monto: 60000 });
  assert.ok(E.ofertas.mes.manual);
  assert.equal(E.manualInfo, 'Transferí a la cuenta 123'); assert.equal(E.contacto, 'contacto@ejemplo.com');
  const csp = r.headers.get('content-security-policy'); assert.match(csp, /default-src 'none'/); assert.match(csp, /form-action 'none'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const il = await estadoPlan(ILAN); assert.equal(il.E.propia, true);
});

await t('/plan?pago=ok y cualquier otro valor: el aviso solo admite ok o cancelado', async () => {
  assert.equal((await estadoPlan(A, '?pago=ok')).E.aviso, 'ok');
  assert.equal((await estadoPlan(A, '?pago=cancelado')).E.aviso, 'cancelado');
  assert.equal((await estadoPlan(A, '?pago=%3Cscript%3E')).E.aviso, '');
});

// ------------------------------------------------------------------ checkout
await t('checkout: sin sesión 401, origen ajeno 403, ilan 400, proveedor/periodo inválidos 400, no JSON 415', async () => {
  assert.equal((await post('/api/pagos/checkout', { proveedor: 'stripe', periodo: 'mes' })).status, 401);
  assert.equal((await post('/api/pagos/checkout', { proveedor: 'stripe', periodo: 'mes' }, { Cookie: A, Origin: 'https://malo.example' })).status, 403);
  assert.equal((await post('/api/pagos/checkout', { proveedor: 'stripe', periodo: 'mes' }, { Cookie: ILAN })).status, 400);
  for (const b of [{ proveedor: 'manual', periodo: 'mes' }, { proveedor: 'paypal', periodo: 'mes' }, { proveedor: 'stripe', periodo: 'semana' }, { proveedor: 'stripe' }, null]) {
    assert.equal((await post('/api/pagos/checkout', b, { Cookie: A })).status, 400, JSON.stringify(b));
  }
  const r = await f('/api/pagos/checkout', { method: 'POST', headers: { Cookie: A, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  assert.equal((await post('/api/pagos/checkout', 'x'.repeat(2000), { Cookie: A })).status, 413);
});

await t('checkout Stripe: el monto sale del servidor (ARS 6000 -> 600000 centavos) y se devuelve la URL del proveedor', async () => {
  // El cliente intenta colar su propio monto: se ignora.
  const r = await post('/api/pagos/checkout', { proveedor: 'stripe', periodo: 'mes', monto: 1, moneda: 'USD' }, { Cookie: A });
  assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.url, 'https://checkout.stripe.example/c/cs_test_1');
  const v = visto.stripe.at(-1);
  assert.equal(v.auth, 'Bearer sk_test_falsa');
  assert.equal(v.form.get('mode'), 'payment');
  assert.equal(v.form.get('line_items[0][price_data][unit_amount]'), '600000');
  assert.equal(v.form.get('line_items[0][price_data][currency]'), 'ars');
  assert.equal(v.form.get('metadata[periodo]'), 'mes');
  assert.equal(v.form.get('customer_email'), 'plan.a@ejemplo.com');
  assert.equal(v.form.get('success_url'), B + '/plan?pago=ok');
  tenantA = v.form.get('client_reference_id');
  assert.ok(tenantA && tenantA !== 'ilan');
});

await t('checkout Mercado Pago: preferencia con external_reference "<cuenta>|<periodo>", notification_url y monto del servidor', async () => {
  const r = await post('/api/pagos/checkout', { proveedor: 'mercadopago', periodo: 'anio' }, { Cookie: A });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'https://www.mercadopago.example/checkout/pref1');
  const v = visto.mpPref.at(-1);
  assert.equal(v.auth, 'Bearer mp_falso');
  assert.equal(v.body.items[0].unit_price, 60000); assert.equal(v.body.items[0].currency_id, 'ARS');
  assert.equal(v.body.external_reference, tenantA + '|anio');
  assert.equal(v.body.notification_url, B + '/api/pagos/webhook/mercadopago');
});

await t('checkout: Mercado Pago no se ofrece si la moneda de la cuenta cae a USD (MP no cobra USD)', async () => {
  const C = await cuentaNueva('plan.usd@ejemplo.com', { pais: 'us', moneda: 'usd', tz: 'America/New_York', medios: ['Card USD'], categorias: ['Otros'], modulos: { accesosRapidos: false, pais: false } });
  const { E } = await estadoPlan(C);
  assert.ok(E.ofertas.mes.stripe); assert.equal(E.ofertas.mes.mercadopago, undefined);
  assert.equal((await post('/api/pagos/checkout', { proveedor: 'mercadopago', periodo: 'mes' }, { Cookie: C })).status, 400);
});

// ------------------------------------------------------------------ webhook Stripe
const eventoStripe = (extra = {}) => ({
  id: 'evt_1', type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_1', client_reference_id: tenantA, payment_status: 'paid', amount_total: 600000, currency: 'ars', metadata: { tenant: tenantA, periodo: 'mes' }, ...extra } }
});
const firmaStripe = (texto, ts = Math.floor(Date.now() / 1000), secreto = STRIPE_SECRET) => `t=${ts},v1=${hmac(secreto, ts + '.' + texto)}`;
const hookStripe = (ev, firma) => { const texto = JSON.stringify(ev); return post('/api/pagos/webhook/stripe', texto, { 'Stripe-Signature': firma || firmaStripe(texto) }); };

let hasta1;
await t('webhook Stripe: firma mala, vencida o ausente = 400 y no activa nada', async () => {
  const ev = eventoStripe(); const texto = JSON.stringify(ev);
  assert.equal((await post('/api/pagos/webhook/stripe', texto)).status, 400);
  assert.equal((await post('/api/pagos/webhook/stripe', texto, { 'Stripe-Signature': firmaStripe(texto, undefined, 'otro-secreto') })).status, 400);
  assert.equal((await post('/api/pagos/webhook/stripe', texto, { 'Stripe-Signature': firmaStripe(texto, Math.floor(Date.now() / 1000) - 3600) })).status, 400);
  assert.equal((await post('/api/pagos/webhook/stripe', texto, { 'Stripe-Signature': firmaStripe(texto).replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).status, 400);
  assert.equal((await estadoPlan(A)).E.plan, 'gratis');
});

await t('webhook Stripe: pago aprobado activa Pro por 1 mes; el reintento no suma dos veces', async () => {
  const r = await hookStripe(eventoStripe());
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, aplicado: true });
  const { E } = await estadoPlan(A);
  assert.equal(E.plan, 'pro');
  hasta1 = Date.parse(E.hasta);
  const dias = (hasta1 - Date.now()) / DIA;
  assert.ok(dias > 27.9 && dias < 31.1, 'dias=' + dias);
  const r2 = await hookStripe(eventoStripe()); // mismo cs_test_1
  assert.deepEqual(await r2.json(), { ok: true, aplicado: false });
  assert.equal(Date.parse((await estadoPlan(A)).E.hasta), hasta1);
});

await t('webhook Stripe: un pago nuevo con plan vigente suma 12 meses DESPUÉS del vencimiento actual', async () => {
  const ev = eventoStripe({ id: 'cs_test_2', metadata: { tenant: tenantA, periodo: 'anio' } });
  const r = await hookStripe(ev); assert.deepEqual(await r.json(), { ok: true, aplicado: true });
  const dias = (Date.parse((await estadoPlan(A)).E.hasta) - hasta1) / DIA;
  assert.ok(dias >= 364.9 && dias <= 366.1, 'dias=' + dias);
});

await t('webhook Stripe: sin pagar, otro tipo de evento, período inválido o cuenta inexistente no activan', async () => {
  const antes = (await estadoPlan(A)).E.hasta;
  const sinPagar = await (await hookStripe(eventoStripe({ id: 'cs_x1', payment_status: 'unpaid' }))).json(); assert.equal(sinPagar.ignorado, true);
  const otro = await (await hookStripe({ ...eventoStripe({ id: 'cs_x2' }), type: 'charge.refunded' })).json(); assert.equal(otro.ignorado, true);
  const malo = await (await hookStripe(eventoStripe({ id: 'cs_x3', metadata: { tenant: tenantA, periodo: 'siglo' } }))).json(); assert.equal(malo.ignorado, true);
  const fantasma = await hookStripe(eventoStripe({ id: 'cs_x4', client_reference_id: 'no-existe', metadata: { periodo: 'mes' } }));
  assert.equal(fantasma.status, 200); assert.equal((await fantasma.json()).aplicado, false);
  assert.equal((await estadoPlan(A)).E.hasta, antes);
});

// ------------------------------------------------------------------ webhook Mercado Pago
const hookMp = (id, { tipo = 'payment', firmaOk = true, reqId = 'req-123', ts = String(Date.now()) } = {}) => {
  const v1 = firmaOk ? hmac(MP_SECRET, `id:${String(id).toLowerCase()};request-id:${reqId};ts:${ts};`) : 'f'.repeat(64);
  return post(`/api/pagos/webhook/mercadopago?data.id=${id}&type=${tipo}`, { action: 'payment.updated', data: { id: String(id) } }, { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': reqId });
};
let hastaMp;
await t('webhook Mercado Pago: firma mala 400; pago aprobado (confirmado por API) activa; reintento no suma', async () => {
  const B2 = await cuentaNueva('plan.mp@ejemplo.com', CFG_ARS);
  const ref = await post('/api/pagos/checkout', { proveedor: 'mercadopago', periodo: 'mes' }, { Cookie: B2 });
  assert.equal(ref.status, 200);
  const externa = visto.mpPref.at(-1).body.external_reference;
  visto.mpPagos['5001'] = { id: 5001, status: 'approved', external_reference: externa, transaction_amount: 6000, currency_id: 'ARS' };
  assert.equal((await hookMp(5001, { firmaOk: false })).status, 400);
  assert.equal((await estadoPlan(B2)).E.plan, 'gratis');
  const r = await hookMp(5001); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, aplicado: true });
  const { E } = await estadoPlan(B2); assert.equal(E.plan, 'pro'); hastaMp = E.hasta;
  assert.deepEqual(await (await hookMp(5001)).json(), { ok: true, aplicado: false });
  assert.equal((await estadoPlan(B2)).E.hasta, hastaMp);
});

await t('webhook Mercado Pago: pago pendiente o de otro tema se ignora; pago inexistente = 502 (MP reintenta)', async () => {
  const B3 = await cuentaNueva('plan.mp2@ejemplo.com', CFG_ARS);
  await post('/api/pagos/checkout', { proveedor: 'mercadopago', periodo: 'mes' }, { Cookie: B3 });
  const externa = visto.mpPref.at(-1).body.external_reference;
  visto.mpPagos['5002'] = { id: 5002, status: 'pending', external_reference: externa, transaction_amount: 6000, currency_id: 'ARS' };
  visto.mpPagos['5003'] = { id: 5003, status: 'approved', external_reference: 'sin-separador', transaction_amount: 6000, currency_id: 'ARS' };
  assert.equal((await (await hookMp(5002)).json()).ignorado, true);
  assert.equal((await (await hookMp(5003)).json()).ignorado, true);
  assert.equal((await (await hookMp(5002, { tipo: 'merchant_order' })).json()).ignorado, true);
  assert.equal((await hookMp(9999)).status, 502);
  assert.equal((await estadoPlan(B3)).E.plan, 'gratis');
});

await t('webhooks: GET 405, proveedor desconocido o manual 404, cuerpo enorme 413', async () => {
  assert.equal((await f('/api/pagos/webhook/stripe')).status, 405);
  assert.equal((await post('/api/pagos/webhook/paypal', {})).status, 404);
  assert.equal((await post('/api/pagos/webhook/manual', {})).status, 404);
  assert.equal((await post('/api/pagos/webhook/stripe', 'x'.repeat(70000))).status, 413);
});

// ------------------------------------------------------------------ activación manual
await t('/api/plan/activar: exige X-Sync-Key; mail inexistente 404; activa; la misma ref no suma dos veces', async () => {
  const M = await cuentaNueva('plan.manual@ejemplo.com', CFG_ARS);
  const body = { email: 'Plan.Manual@ejemplo.com', periodo: 'mes', ref: 'transf-0001', monto: 6000, moneda: 'ARS' };
  assert.equal((await post('/api/plan/activar', body)).status, 401);
  assert.equal((await post('/api/plan/activar', body, { 'X-Sync-Key': 'mala' })).status, 401);
  assert.equal((await post('/api/plan/activar', { ...body, email: 'nadie@ejemplo.com' }, { 'X-Sync-Key': 'x' })).status, 404);
  assert.equal((await post('/api/plan/activar', { ...body, periodo: 'siglo' }, { 'X-Sync-Key': 'x' })).status, 400);
  assert.equal((await post('/api/plan/activar', { ...body, ref: '' }, { 'X-Sync-Key': 'x' })).status, 400);
  assert.equal((await f('/api/plan/activar', { headers: { 'X-Sync-Key': 'x' } })).status, 405);
  const r = await post('/api/plan/activar', body, { 'X-Sync-Key': 'x' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, aplicado: true });
  const h1 = (await estadoPlan(M)).E; assert.equal(h1.plan, 'pro');
  assert.deepEqual(await (await post('/api/plan/activar', body, { 'X-Sync-Key': 'x' })).json(), { ok: true, aplicado: false });
  assert.equal((await estadoPlan(M)).E.hasta, h1.hasta);
});

// ------------------------------------------------------------------ cfg pública no filtra el plan
await t('el plan no se filtra por /api/config (cfgPublica) y el form sigue andando para ilan y cuentas nuevas', async () => {
  const c = await (await f('/api/config', { headers: { Cookie: A } })).json();
  assert.equal(c.config.plan, undefined); assert.equal(c.config.planHasta, undefined);
  assert.equal((await f('/app', { headers: { Cookie: A } })).status, 200);
  assert.equal((await f('/app', { headers: { Cookie: ILAN } })).status, 200);
});

falso.close();
console.log(out.join('\n'));
console.log(fallas ? `\n${fallas} FALLA(S)` : `\n${out.length}/${out.length} OK`);
process.exit(fallas ? 1 : 0);
