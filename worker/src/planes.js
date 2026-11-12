// Planes y precios (sin dependencias del resto del Worker). Modelo: períodos prepagos. Cada pago aprobado suma
// 1 mes o 12 meses a tenants.plan_hasta; pasada esa fecha la cuenta vuelve sola a 'gratis'.
//
// Los precios NO están en el código: salen de la variable PLAN_PRECIOS (JSON), por ejemplo
//   {"mes":{"USD":4.99,"UYU":199,"ARS":6000},"anio":{"USD":49,"UYU":1990,"ARS":60000}}
// Sin PLAN_PRECIOS no se puede pagar nada: /plan muestra "Próximamente" y todas las cuentas siguen en gratis.

export const PERIODOS = { mes: '+1 month', anio: '+12 months' };
export const ETIQUETA_PERIODO = { mes: 'Mensual', anio: 'Anual' };

// Límite diario de escaneos con IA por plan (el de ilan y GEMINI_LIMITE_DIA se resuelven en usarGemini).
export const LIMITE_GEMINI = { gratis: 60, pro: 300 };

export const PROVEEDORES = ['stripe', 'mercadopago', 'manual'];
export const ETIQUETA_PROVEEDOR = { stripe: 'Tarjeta (Stripe)', mercadopago: 'Mercado Pago', manual: 'Transferencia bancaria' };

// Mercado Pago solo cobra en estas monedas.
const MONEDAS_MP = ['ARS', 'BRL', 'CLP', 'COP', 'MXN', 'PEN', 'UYU'];

// 'pro' mientras plan_hasta sea futuro; todo lo demás es 'gratis'. `fila` = {plan, plan_hasta} de tenants.
export function planEfectivo(fila, ahoraIso) {
  const ahora = ahoraIso || new Date().toISOString();
  return fila && fila.plan === 'pro' && typeof fila.plan_hasta === 'string' && fila.plan_hasta > ahora ? 'pro' : 'gratis';
}

// PLAN_PRECIOS validado: { mes: {USD: n, ...}, anio: {...} }. Descarta lo que no sea moneda de 3 letras con monto
// positivo y razonable. {} si falta o está mal formado.
export function preciosDe(env) {
  const out = {};
  let crudo = null;
  try { crudo = env && env.PLAN_PRECIOS ? JSON.parse(env.PLAN_PRECIOS) : null; } catch { crudo = null; }
  if (!crudo || typeof crudo !== 'object') return out;
  for (const p of Object.keys(PERIODOS)) {
    const t = crudo[p];
    if (!t || typeof t !== 'object') continue;
    const limpio = {};
    for (const [mon, monto] of Object.entries(t)) {
      if (/^[A-Z]{3}$/.test(mon) && typeof monto === 'number' && Number.isFinite(monto) && monto > 0 && monto <= 1e7) limpio[mon] = monto;
    }
    if (Object.keys(limpio).length) out[p] = limpio;
  }
  return out;
}

// Qué proveedores hay configurados (con sus secretos). Manual solo necesita las instrucciones para mostrar.
export function proveedorActivo(env, prov) {
  if (!env) return false;
  if (prov === 'stripe') return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  if (prov === 'mercadopago') return !!(env.MP_ACCESS_TOKEN && env.MP_WEBHOOK_SECRET);
  if (prov === 'manual') return !!env.PLAN_MANUAL_INFO;
  return false;
}

// Moneda y monto a cobrar: la de la cuenta si hay precio en esa moneda, si no USD. Mercado Pago exige moneda propia.
export function ofertaDe(precios, periodo, prov, monedaCuenta) {
  const t = precios[periodo];
  if (!t) return null;
  const mon = t[monedaCuenta] ? monedaCuenta : (t.USD ? 'USD' : null);
  if (!mon) return null;
  if (prov === 'mercadopago' && !MONEDAS_MP.includes(mon)) return null;
  return { moneda: mon, monto: t[mon] };
}

// { mes: {stripe: {moneda, monto}, ...}, anio: {...} } con solo lo que realmente se puede cobrar hoy.
export function ofertas(env, monedaCuenta) {
  const precios = preciosDe(env);
  const out = {};
  for (const p of Object.keys(PERIODOS)) {
    for (const prov of PROVEEDORES) {
      if (!proveedorActivo(env, prov)) continue;
      const o = ofertaDe(precios, p, prov, monedaCuenta);
      if (o) (out[p] = out[p] || {})[prov] = o;
    }
  }
  return out;
}

// Registra el pago y suma el período en UNA transacción (batch de D1): o entran las dos escrituras o ninguna.
// Idempotente: si id_externo ya existe, el INSERT no cambia filas y el UPDATE (condicionado a changes()) tampoco.
// -> { ok, aplicado } | { ok:false, error }
export async function activarPlan(env, tenant, periodo, pago) {
  const mod = PERIODOS[periodo];
  if (!mod) return { ok: false, error: 'Período inválido' };
  if (!tenant || !pago || !pago.idExterno) return { ok: false, error: 'Faltan datos del pago' };
  const ahora = new Date().toISOString().slice(0, 19) + 'Z';
  const [ins, upd] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO pagos (tenant_id, proveedor, id_externo, periodo, monto, moneda, creado)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ?1)`
    ).bind(tenant, pago.proveedor, pago.idExterno, periodo, pago.monto == null ? null : Number(pago.monto), pago.moneda || null, ahora),
    env.DB.prepare(
      `UPDATE tenants SET plan = 'pro',
         plan_hasta = strftime('%Y-%m-%dT%H:%M:%SZ', MAX(COALESCE(plan_hasta, ?2), ?2), ?3)
       WHERE id = ?1 AND changes() > 0`
    ).bind(tenant, ahora, mod)
  ]);
  const nuevo = ins.meta && ins.meta.changes > 0;
  if (!nuevo) {
    // O ya estaba aplicado (reintento del webhook) o la cuenta no existe.
    const hay = await env.DB.prepare(`SELECT 1 AS x FROM pagos WHERE id_externo = ?`).bind(pago.idExterno).first();
    return hay ? { ok: true, aplicado: false } : { ok: false, error: 'Cuenta inexistente' };
  }
  return { ok: !!(upd.meta && upd.meta.changes > 0), aplicado: true };
}

// --- página /plan --------------------------------------------------------------------------------------------------
export const CSP_PLAN = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const jsonEnScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c')
  .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
  .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

// datos: { propia, plan, hasta, ofertas, contacto, manualInfo, aviso }
export function paginaPlan(datos) {
  const inicial = jsonEnScript({
    propia: !!datos.propia, plan: datos.plan, hasta: datos.hasta || null, ofertas: datos.ofertas || {},
    contacto: datos.contacto || '', manualInfo: datos.manualInfo || '', aviso: datos.aviso || '',
    etiquetas: { periodo: ETIQUETA_PERIODO, proveedor: ETIQUETA_PROVEEDOR }
  });
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Plan · Gastos</title>
<style>
:root{--bg:#f4f4f2;--card:#fff;--ink:#1c1c1a;--mut:#6b6b66;--line:#d9d9d3;--acc:#1f6f54;--acc-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121413;--card:#1c1f1d;--ink:#ecece8;--mut:#9a9a93;--line:#34383a;--acc:#4cb68f;--acc-ink:#0c1511}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:460px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:18px 0 6px}p{margin:8px 0;color:var(--mut)}
.estado{padding:10px 12px;border:1px solid var(--line);border-radius:10px;color:var(--ink)}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 18px;background:var(--acc);color:var(--acc-ink);width:100%;margin-top:8px}
button.sec{background:none;color:var(--ink);border:1px solid var(--line)}
a{color:var(--acc)}#msg{min-height:1.4em;color:var(--ink)}#manual{white-space:pre-wrap;color:var(--ink)}
[hidden]{display:none!important}
</style></head><body><main>
<h1>⭐ Plan</h1>
<p id="estado" class="estado"></p>
<div id="aviso" hidden></div>
<div id="pagar" hidden>
<h2>Elegí el período</h2>
<div id="periodos"></div>
<div id="provs" hidden><h2>Medio de pago</h2><div id="botones"></div></div>
<p id="manual" hidden></p>
</div>
<div id="proximamente" hidden><p>Por ahora el servicio es gratuito. Cuando haya plan pago vas a poder verlo y contratarlo acá.</p></div>
<p id="msg" role="status" aria-live="polite"></p>
<p><a href="/app">← Volver</a></p>
</main>
<script>
(function () {
  var E = ${inicial};
  var $ = function (id) { return document.getElementById(id); };
  function msg(t) { $('msg').textContent = t || ''; }
  var fmt = function (o) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: o.moneda }).format(o.monto); } catch (e) { return o.monto + ' ' + o.moneda; } };
  var el = function (tag, txt, cls) { var n = document.createElement(tag); if (txt) n.textContent = txt; if (cls) n.className = cls; return n; };

  if (E.propia) { $('estado').textContent = 'Esta es la cuenta del dueño: sin límites.'; return; }
  var hasta = E.hasta ? new Date(E.hasta) : null;
  $('estado').textContent = E.plan === 'pro'
    ? 'Plan Pro activo' + (hasta ? ' hasta el ' + hasta.toLocaleDateString() : '') + '.'
    : 'Plan gratis' + (hasta ? ' (el Pro venció el ' + hasta.toLocaleDateString() + ')' : '') + '.';
  if (E.aviso === 'ok') { $('aviso').hidden = false; $('aviso').appendChild(el('p', 'Gracias. Si ya pagaste, el plan se activa en cuanto el proveedor nos confirme (suele ser inmediato). Recargá en un momento.')); }
  if (E.aviso === 'cancelado') { $('aviso').hidden = false; $('aviso').appendChild(el('p', 'Cancelaste el pago. No se cobró nada.')); }

  var periodos = Object.keys(E.ofertas);
  if (!periodos.length) { $('proximamente').hidden = false; return; }
  $('pagar').hidden = false;
  var elegido = null;
  function mostrarProveedores(p) {
    elegido = p;
    $('botones').textContent = '';
    $('manual').hidden = true;
    Object.keys(E.ofertas[p]).forEach(function (prov) {
      var b = el('button', E.etiquetas.proveedor[prov] + ' · ' + fmt(E.ofertas[p][prov]), 'sec');
      b.type = 'button';
      b.addEventListener('click', function () { pagar(prov, p); });
      $('botones').appendChild(b);
    });
    $('provs').hidden = false;
  }
  periodos.forEach(function (p) {
    var b = el('button', E.etiquetas.periodo[p]);
    b.type = 'button';
    b.addEventListener('click', function () { mostrarProveedores(p); });
    $('periodos').appendChild(b);
  });
  function pagar(prov, p) {
    msg('');
    if (prov === 'manual') {
      $('manual').hidden = false;
      $('manual').textContent = E.manualInfo + (E.contacto ? '\\n\\nMandá el comprobante a ' + E.contacto + ' desde el mail de tu cuenta y activamos el plan.' : '');
      return;
    }
    msg('Abriendo el pago…');
    fetch('/api/pagos/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proveedor: prov, periodo: p }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok && j.url) { location.href = j.url; } else { msg((j && j.error) || 'No se pudo iniciar el pago.'); } })
      .catch(function () { msg('No se pudo iniciar el pago. Probá de nuevo.'); });
  }
})();
</script></body></html>`;
}
