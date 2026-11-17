// Proveedores de pago detrás de una interfaz común. Sin dependencias del resto del Worker (solo fetch y WebCrypto).
//
//   crearCheckout(env, prov, {tenant, email, periodo, oferta, base}) -> { ok, url } | { ok:false, error }
//   leerWebhook(env, prov, req, texto)  -> { ok, evento } | { ok:false, status, error }
//       evento = { ignorar:true } | { tenant, periodo, idExterno, proveedor, monto, moneda }
//
// El webhook NUNCA confía en el cuerpo sin verificar: Stripe y Mercado Pago firman con HMAC-SHA256 y Mercado Pago
// además se vuelve a consultar por API (el pago se lee de ahí, no del aviso). 'manual' no tiene webhook: lo activa
// el dueño con POST /api/plan/activar (X-Sync-Key).
import { PERIODOS, ETIQUETA_PERIODO } from './planes.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacHex(secreto, texto) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(texto)));
}

// Comparación en tiempo casi constante (strings hex del mismo largo).
function iguales(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Las URLs de la API se pueden redirigir a un servidor de prueba solo en local (DEV_MOSTRAR_LINK).
const apiBase = (env, nombre, real) => (env.DEV_MOSTRAR_LINK && env[nombre]) || real;

// Monedas sin centavos en Stripe (el monto va sin multiplicar por 100).
const SIN_DECIMALES = ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];

// Mercado Pago (Orders) solo admite letras, números, "-" y "_" en external_reference (máx 64). Las preferencias viejas
// usaban "|": se siguen leyendo para no perder un pago que estaba en vuelo.
const REF_SEP = '_';
const armarRef = (tenant, periodo) => tenant + REF_SEP + periodo;
function leerRef(ref) {
  const s = String(ref || '');
  const i = Math.max(s.lastIndexOf(REF_SEP), s.lastIndexOf('|'));
  if (i < 1) return null;
  const periodo = s.slice(i + 1);
  return PERIODOS[periodo] ? { tenant: s.slice(0, i), periodo } : null;
}

async function pedirJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return { ok: r.ok, status: r.status, json: j };
}

// --- Stripe ------------------------------------------------------------------------------------------------------
async function stripeCheckout(env, { tenant, email, periodo, oferta, base }) {
  const centavos = SIN_DECIMALES.includes(oferta.moneda) ? Math.round(oferta.monto) : Math.round(oferta.monto * 100);
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('client_reference_id', tenant);
  if (email) f.set('customer_email', email);
  f.set('line_items[0][quantity]', '1');
  f.set('line_items[0][price_data][currency]', oferta.moneda.toLowerCase());
  f.set('line_items[0][price_data][unit_amount]', String(centavos));
  f.set('line_items[0][price_data][product_data][name]', 'Gastos Pro · ' + ETIQUETA_PERIODO[periodo]);
  f.set('metadata[tenant]', tenant);
  f.set('metadata[periodo]', periodo);
  f.set('success_url', base + '/plan?pago=ok');
  f.set('cancel_url', base + '/plan?pago=cancelado');
  const r = await pedirJson(apiBase(env, 'STRIPE_API_BASE', 'https://api.stripe.com') + '/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: f.toString()
  });
  if (!r.ok || !r.json || typeof r.json.url !== 'string') {
    console.error('stripe checkout falló:', r.status, r.json && r.json.error && r.json.error.type);
    return { ok: false, error: 'No se pudo iniciar el pago con tarjeta' };
  }
  return { ok: true, url: r.json.url };
}

// Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>]". HMAC-SHA256(secreto, "<t>.<cuerpo>"), tolerancia 5 minutos.
async function stripeWebhook(env, req, texto) {
  const cab = req.headers.get('Stripe-Signature') || '';
  const partes = cab.split(',').map((p) => p.trim().split('='));
  const t = (partes.find((p) => p[0] === 't') || [])[1];
  const firmas = partes.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || !firmas.length || !/^\d+$/.test(t)) return { ok: false, status: 400, error: 'Firma ausente' };
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return { ok: false, status: 400, error: 'Firma vencida' };
  const esperada = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + '.' + texto);
  if (!firmas.some((f) => iguales(f, esperada))) return { ok: false, status: 400, error: 'Firma inválida' };
  let ev;
  try { ev = JSON.parse(texto); } catch { return { ok: false, status: 400, error: 'JSON inválido' }; }
  const tipo = ev && ev.type;
  if (tipo !== 'checkout.session.completed' && tipo !== 'checkout.session.async_payment_succeeded') return { ok: true, evento: { ignorar: true } };
  const s = ev.data && ev.data.object;
  if (!s || s.payment_status !== 'paid') return { ok: true, evento: { ignorar: true } };
  const periodo = s.metadata && s.metadata.periodo;
  const tenant = s.client_reference_id || (s.metadata && s.metadata.tenant);
  if (!tenant || !PERIODOS[periodo]) return { ok: true, evento: { ignorar: true } };
  const div = SIN_DECIMALES.includes(String(s.currency || '').toUpperCase()) ? 1 : 100;
  return {
    ok: true,
    evento: {
      tenant, periodo, proveedor: 'stripe', idExterno: 'stripe:' + s.id,
      monto: typeof s.amount_total === 'number' ? s.amount_total / div : null, moneda: String(s.currency || '').toUpperCase() || null
    }
  };
}

// --- Mercado Pago ------------------------------------------------------------------------------------------------
async function mpCheckout(env, { tenant, email, periodo, oferta, base }) {
  // Orders exige payer.email y no tiene campo de moneda: cobra en la de la cuenta de Mercado Pago.
  if (!email) return { ok: false, error: 'No se pudo iniciar el pago con Mercado Pago' };
  const monto = oferta.monto.toFixed(2);
  const body = {
    type: 'online',
    processing_mode: 'manual',
    capture_mode: 'automatic_async',
    total_amount: monto,
    external_reference: armarRef(tenant, periodo),
    payer: { email },
    config: { online: { success_url: base + '/plan?pago=ok', failure_url: base + '/plan?pago=cancelado', pending_url: base + '/plan?pago=ok', auto_return: 'approved' } },
    items: [{ title: 'Gastos Pro · ' + ETIQUETA_PERIODO[periodo], quantity: 1, unit_price: monto }]
  };
  const r = await pedirJson(apiBase(env, 'MP_API_BASE', 'https://api.mercadopago.com') + '/v1/orders', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body)
  });
  const url = r.json && r.json.checkout_url;
  if (!r.ok || typeof url !== 'string') {
    console.error('mercadopago checkout falló:', r.status);
    return { ok: false, error: 'No se pudo iniciar el pago con Mercado Pago' };
  }
  // Si la cuenta de Mercado Pago cobra en otra moneda que la del precio, no se manda al cliente a pagar un monto equivocado.
  const mon = String(r.json.currency || '').toUpperCase();
  if (mon && mon !== oferta.moneda) {
    console.error('mercadopago: la cuenta cobra en', mon, 'y el precio es en', oferta.moneda);
    return { ok: false, error: 'No se pudo iniciar el pago con Mercado Pago' };
  }
  return { ok: true, url };
}

// Aviso de Mercado Pago: POST con ?data.id=<id>&type=order (Orders) o type=payment (API vieja de preferencias).
// x-signature = "ts=<ms>,v1=<hex>" sobre el manifiesto "id:<data.id en minúscula>;request-id:<x-request-id>;ts:<ts>;".
// Con la firma buena se consulta la orden (o el pago) a la API: el estado se lee de ahí, no del aviso.
async function mpWebhook(env, req, texto, url) {
  const cab = req.headers.get('x-signature') || '';
  const reqId = req.headers.get('x-request-id') || '';
  const partes = cab.split(',').map((p) => p.trim().split('='));
  const ts = (partes.find((p) => p[0] === 'ts') || [])[1];
  const v1 = (partes.find((p) => p[0] === 'v1') || [])[1];
  let dataId = url.searchParams.get('data.id') || '';
  if (!dataId) { try { const b = JSON.parse(texto); dataId = String(b && b.data && b.data.id || ''); } catch { dataId = ''; } }
  if (!ts || !v1 || !/^\d+$/.test(ts) || !/^[A-Za-z0-9_-]{1,64}$/.test(dataId)) return { ok: false, status: 400, error: 'Firma ausente' };
  const esperada = await hmacHex(env.MP_WEBHOOK_SECRET, 'id:' + dataId.toLowerCase() + ';request-id:' + reqId + ';ts:' + ts + ';');
  if (!iguales(v1, esperada)) return { ok: false, status: 400, error: 'Firma inválida' };
  // Los avisos de otros temas (merchant_order, etc.) se confirman sin hacer nada.
  let tipo = url.searchParams.get('type') || url.searchParams.get('topic') || '';
  if (!tipo) { try { const b = JSON.parse(texto); tipo = String(b && b.type || ''); } catch { tipo = ''; } }
  const base = apiBase(env, 'MP_API_BASE', 'https://api.mercadopago.com');
  const auth = { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN };
  if (tipo === 'order') {
    const r = await pedirJson(base + '/v1/orders/' + encodeURIComponent(dataId), { headers: auth });
    if (!r.ok || !r.json) return { ok: false, status: 502, error: 'No se pudo confirmar el pago' }; // MP reintenta
    const o = r.json;
    if (o.status !== 'processed') return { ok: true, evento: { ignorar: true } };
    const ref = leerRef(o.external_reference);
    if (!ref) return { ok: true, evento: { ignorar: true } };
    const pagado = Number(o.total_paid_amount);
    return {
      ok: true,
      evento: {
        tenant: ref.tenant, periodo: ref.periodo, proveedor: 'mercadopago', idExterno: 'mercadopago:order:' + String(o.id || dataId),
        monto: Number.isFinite(pagado) ? pagado : null, moneda: o.currency || o.currency_id || null
      }
    };
  }
  if (tipo && tipo !== 'payment') return { ok: true, evento: { ignorar: true } };
  const r = await pedirJson(base + '/v1/payments/' + encodeURIComponent(dataId), { headers: auth });
  if (!r.ok || !r.json) return { ok: false, status: 502, error: 'No se pudo confirmar el pago' }; // MP reintenta
  const p = r.json;
  if (p.status !== 'approved') return { ok: true, evento: { ignorar: true } };
  const ref = leerRef(p.external_reference);
  if (!ref) return { ok: true, evento: { ignorar: true } };
  return {
    ok: true,
    evento: {
      tenant: ref.tenant, periodo: ref.periodo, proveedor: 'mercadopago', idExterno: 'mercadopago:' + String(p.id || dataId),
      monto: typeof p.transaction_amount === 'number' ? p.transaction_amount : null, moneda: p.currency_id || null
    }
  };
}

// --- interfaz pública --------------------------------------------------------------------------------------------
export async function crearCheckout(env, prov, datos) {
  try {
    if (prov === 'stripe') return await stripeCheckout(env, datos);
    if (prov === 'mercadopago') return await mpCheckout(env, datos);
  } catch (e) {
    console.error('checkout falló:', prov, String(e && e.message || e));
    return { ok: false, error: 'No se pudo iniciar el pago' };
  }
  return { ok: false, error: 'Medio de pago no disponible' };
}

export async function leerWebhook(env, prov, req, texto, url) {
  try {
    if (prov === 'stripe') return await stripeWebhook(env, req, texto);
    if (prov === 'mercadopago') return await mpWebhook(env, req, texto, url);
  } catch (e) {
    console.error('webhook falló:', prov, String(e && e.message || e));
    return { ok: false, status: 500, error: 'Falló el webhook' };
  }
  return { ok: false, status: 404, error: 'No encontrado' };
}
