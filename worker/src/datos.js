// Datos de la cuenta en manos de la persona: descargar todo lo que cargó y borrar la cuenta, sin pasar por el dueño.
//
//   exportarCuenta(env, tenant)          -> objeto listo para JSON (todas las tablas de la cuenta)
//   borrarCuenta(env, tenant, email)     -> { ok } | { ok:false, error }  (la cuenta del dueño nunca se borra)
//   paginaCuenta({ email, dueno })       -> HTML de /cuenta
//
// Qué se conserva al borrar: solo la tabla pagos (monto, moneda, fecha, id del proveedor) sin mail ni nombre, porque
// los cobros hay que poder rastrearlos por impuestos y por contracargos, y porque su id_externo UNIQUE es lo que evita
// que un reintento tardío de un webhook vuelva a sumar un período. Después de borrar no queda nada que la una a una persona.
import { jsonEnScript } from './planes.js';

const ILAN = 'ilan';

// Tablas con una fila por dato de la cuenta (columna tenant_id). price_cache e import_log son datos de mercado y del dueño.
const TABLAS = [
  'expenses', 'month_totals', 'incomes', 'savings', 'settings', 'tasks', 'purchases', 'habit_days', 'habit_log',
  'foreign_movements', 'foreign_months', 'config', 'sync_state'
];
// Se borran con la cuenta pero no se exportan: son del funcionamiento (sesiones, dispositivos de avisos).
const TABLAS_SOLO_BORRAR = ['push_subs', 'sesiones'];

export async function exportarCuenta(env, tenant) {
  const ps = [
    env.DB.prepare('SELECT email, creado, pais, moneda, tz, plan, plan_hasta FROM tenants WHERE id = ?').bind(tenant),
    env.DB.prepare('SELECT proveedor, periodo, monto, moneda, creado FROM pagos WHERE tenant_id = ? ORDER BY id').bind(tenant),
    ...TABLAS.map((t) => env.DB.prepare(`SELECT * FROM ${t} WHERE tenant_id = ?`).bind(tenant))
  ];
  const r = await env.DB.batch(ps);
  const datos = {};
  TABLAS.forEach((t, i) => { datos[t] = r[i + 2].results; });
  return {
    exportado: new Date().toISOString(),
    cuenta: r[0].results[0] || null,
    pagos: r[1].results,
    datos
  };
}

export async function borrarCuenta(env, tenant, emailConfirmado) {
  // Doble cierre: la cuenta del dueño no se borra por esta vía y solo ids de cuentas propias ('t_' + hex).
  if (tenant === ILAN || !/^t_[0-9a-f]{12}$/.test(String(tenant))) return { ok: false, error: 'Esta cuenta no se puede borrar desde acá' };
  const fila = await env.DB.prepare('SELECT email FROM tenants WHERE id = ?').bind(tenant).first();
  if (!fila) return { ok: false, error: 'La cuenta no existe' };
  const escrito = String(emailConfirmado || '').trim().toLowerCase();
  if (!escrito || escrito !== String(fila.email).toLowerCase()) return { ok: false, error: 'El mail escrito no coincide con el de la cuenta' };
  // Un solo batch: o se borra todo o no se borra nada. tenants va al final.
  await env.DB.batch([
    ...[...TABLAS, ...TABLAS_SOLO_BORRAR].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).bind(tenant)),
    env.DB.prepare('DELETE FROM login_tokens WHERE email = ?').bind(fila.email),
    env.DB.prepare('DELETE FROM tenants WHERE id = ?').bind(tenant)
  ]);
  return { ok: true };
}

export const CSP_CUENTA = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function paginaCuenta(datos) {
  const inicial = jsonEnScript({ email: datos.email || '', dueno: !!datos.dueno });
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Mi cuenta · Gastos</title>
<style>
:root{--bg:#f4f4f2;--card:#fff;--ink:#1c1c1a;--mut:#6b6b66;--line:#d9d9d3;--acc:#1f6f54;--acc-ink:#fff;--mal:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121413;--card:#1c1f1d;--ink:#ecece8;--mut:#9a9a93;--line:#34383a;--acc:#4cb68f;--acc-ink:#0c1511;--mal:#f97066}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:460px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:22px 0 6px}p{margin:8px 0;color:var(--mut)}
input{font:inherit;width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);margin-top:6px}
button,a.boton{display:block;text-align:center;text-decoration:none;font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 18px;background:var(--acc);color:var(--acc-ink);width:100%;margin-top:10px}
button.peligro{background:none;color:var(--mal);border:1px solid var(--mal)}
button:disabled{opacity:.55}
a{color:var(--acc)}#msg{min-height:1.4em;color:var(--ink)}#msg.mal{color:var(--mal)}
[hidden]{display:none!important}
</style></head><body><main>
<h1>👤 Mi cuenta</h1>
<p id="mail"></p>
<h2>Descargar mis datos</h2>
<p>Un archivo JSON con todo lo que cargaste: gastos, ingresos, ahorros, tareas, compras, hábitos y ajustes.</p>
<a class="boton" id="bajar" href="/api/cuenta/exportar" download>Descargar mis datos</a>
<div id="borrar">
<h2>Borrar mi cuenta</h2>
<p>Se borra la cuenta y todo lo que cargaste. No se puede deshacer. Si querés conservar tus datos, descargalos antes. Los registros de pagos se guardan sin tu mail ni tu nombre.</p>
<label for="conf">Para confirmar, escribí el mail de tu cuenta</label>
<input id="conf" type="email" autocomplete="off" autocapitalize="none" spellcheck="false">
<button type="button" id="go" class="peligro" disabled>Borrar mi cuenta para siempre</button>
</div>
<p id="msg" role="status" aria-live="polite"></p>
<p><a href="/app">← Volver</a></p>
</main>
<script>
(function () {
  var E = ${inicial};
  var $ = function (id) { return document.getElementById(id); };
  $('mail').textContent = E.email ? 'Cuenta: ' + E.email : '';
  if (E.dueno) { $('borrar').hidden = true; }
  function msg(t, mal) { $('msg').textContent = t || ''; $('msg').className = mal ? 'mal' : ''; }
  var norm = function (s) { return String(s || '').trim().toLowerCase(); };
  $('conf').addEventListener('input', function () { $('go').disabled = !E.email || norm($('conf').value) !== norm(E.email); });
  $('go').addEventListener('click', function () {
    $('go').disabled = true; msg('Borrando…');
    fetch('/api/cuenta/borrar', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmar: $('conf').value }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { location.assign('/login'); return; }
        msg((j && j.error) || 'No se pudo borrar. Probá de nuevo.', true); $('go').disabled = false;
      })
      .catch(function () { msg('No se pudo borrar. Probá de nuevo.', true); $('go').disabled = false; });
  });
})();
</script></body></html>`;
}
