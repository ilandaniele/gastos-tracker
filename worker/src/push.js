// Avisos push por cuenta (multi-tenant). Reemplaza, para las cuentas nuevas, al Worker de la PWA (pwa/), que sigue
// atendiendo solo a 'ilan'.
//
// - La PWA es el propio /app (mismo origen que la cookie de sesión): manifest + service worker + /avisos viven acá.
// - Web Push SIN payload (RFC 8030 + VAPID): el push va vacío y el service worker pide el texto a POST /api/push/aviso
//   (con la cookie de sesión). Así no hay cifrado de payload (RFC 8291) y no se guardan claves de la suscripción.
// - Las suscripciones están en D1 (push_subs, una fila por dispositivo y cuenta).
// - El cron compartido de gastos-habitos llama cada 15 min a POST /api/push/tick (X-Sync-Key). Ahí se mira la hora
//   LOCAL de cada cuenta (tenants.tz): 07 h tareas y citas del día (solo si hay algo), y el día 1 a las 09 h el reporte
//   mensual. Un aviso por tipo y día por dispositivo (columna 'ultimo').
// - Seguridad: el endpoint de la suscripción lo elige el cliente, así que solo se aceptan https y hosts de los push
//   services conocidos (si no, el Worker sería un SSRF ciego con firma VAPID). Tope de 5 dispositivos por cuenta.
// - Cuota: el tick hace 1 lectura de D1 + por cuenta con aviso 1-2 lecturas y 1 batch de escritura, y manda a lo sumo
//   MAX_ENVIOS pushes (límite de subrequests por invocación); lo que sobra sale en el tick siguiente de esa misma hora.
import { ICONO_192, ICONO_512 } from './iconos.generated.js';
import { cfgDeFila } from './tenantcfg.js';
import { tasksPending } from './pending.js';
import { endpointValido, enviarPush, MAX_ENDPOINT } from './pushsend.js';

const ILAN = 'ilan';
export const MAX_DISPOSITIVOS = 5;
const MAX_ENVIOS = 30;
const MAX_CUENTAS = 12;

const enc = new TextEncoder();
export { endpointValido };
async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export const pushConfigurado = (env) => !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY);

// ---- Suscripciones (cuenta con sesión) ----------------------------------------------------------------------------
export async function suscribir(env, T, endpoint) {
  if (T === ILAN) return { ok: false, status: 400, error: 'Tu cuenta usa la app instalada de siempre para los avisos.' };
  if (!endpointValido(endpoint)) return { ok: false, status: 400, error: 'Suscripción inválida' };
  const hash = await sha256Hex(endpoint);
  const previas = await env.DB.prepare('SELECT hash FROM push_subs WHERE tenant_id = ?').bind(T).all();
  const yaEsta = previas.results.some((x) => x.hash === hash);
  if (!yaEsta && previas.results.length >= MAX_DISPOSITIVOS) {
    return { ok: false, status: 400, error: 'Llegaste al máximo de ' + MAX_DISPOSITIVOS + ' dispositivos con avisos. Desactivalos en alguno.' };
  }
  await env.DB.batch([
    // Un dispositivo recibe los avisos de UNA sola cuenta: la última con la que activó.
    env.DB.prepare('DELETE FROM push_subs WHERE hash = ? AND tenant_id != ?').bind(hash, T),
    env.DB.prepare(`INSERT INTO push_subs (tenant_id, hash, endpoint, creada) VALUES (?, ?, ?, ?)
                    ON CONFLICT (tenant_id, hash) DO UPDATE SET endpoint = excluded.endpoint`)
      .bind(T, hash, endpoint, new Date().toISOString())
  ]);
  return { ok: true };
}

export async function desuscribir(env, T, endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return { ok: false, status: 400, error: 'Suscripción inválida' };
  await env.DB.prepare('DELETE FROM push_subs WHERE tenant_id = ? AND hash = ?').bind(T, await sha256Hex(endpoint)).run();
  return { ok: true };
}

export async function cantidadDispositivos(env, T) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE tenant_id = ?').bind(T).first();
  return (r && r.n) || 0;
}

// Texto del último aviso de la cuenta (lo reclama el service worker). null si no hay.
export async function avisoDe(env, T) {
  const r = await env.DB.prepare(`SELECT valor FROM settings WHERE tenant_id = ? AND clave = 'push_aviso'`).bind(T).first();
  if (!r || !r.valor) return null;
  try {
    const a = JSON.parse(r.valor);
    // Un aviso viejo no se repite: si el push llegó tarde de otro motivo, mejor el texto genérico.
    if (!a || !a.titulo || Date.now() - (a.t || 0) > 6 * 3600 * 1000) return null;
    return { titulo: String(a.titulo), cuerpo: String(a.cuerpo || ''), url: String(a.url || '/app'), tag: String(a.tag || 'gastos') };
  } catch { return null; }
}

// ---- Tick del cron ------------------------------------------------------------------------------------------------
function partesLocales(tz, ahora) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(ahora).map((x) => [x.type, x.value]));
  return { fecha: p.year + '-' + p.month + '-' + p.day, dia: parseInt(p.day, 10), hora: parseInt(p.hour, 10) };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function mesPrevio(fecha) {
  const [y, m] = fecha.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return MESES[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

export async function tickPush(env, ahora) {
  if (!pushConfigurado(env)) return { ok: true, omitido: 'sin claves VAPID' };
  const filas = (await env.DB.prepare(
    `SELECT s.tenant_id AS id, s.hash, s.endpoint, s.ultimo, t.tz, t.pais, t.moneda, t.config, t.onboarding_listo
       FROM push_subs s JOIN tenants t ON t.id = s.tenant_id WHERE s.tenant_id != ?`).bind(ILAN).all()).results;
  const porCuenta = new Map();
  for (const f of filas) {
    if (!porCuenta.has(f.id)) porCuenta.set(f.id, { fila: f, subs: [] });
    porCuenta.get(f.id).subs.push(f);
  }
  const res = { ok: true, cuentas: porCuenta.size, avisadas: 0, enviados: 0, borrados: 0, errores: 0 };
  let procesadas = 0;
  for (const [T, { fila, subs }] of porCuenta) {
    if (procesadas >= MAX_CUENTAS || res.enviados >= MAX_ENVIOS) break;
    const cfg = cfgDeFila(T, fila);
    const loc = partesLocales(cfg.tz, ahora);
    let tipo = '';
    if (loc.hora === 7) tipo = 'tareas';
    else if (loc.hora === 9 && loc.dia === 1) tipo = 'informe';
    if (!tipo) continue;
    const clave = tipo + ':' + loc.fecha;
    const destino = subs.filter((s) => s.ultimo !== clave).slice(0, MAX_ENVIOS - res.enviados);
    if (!destino.length) continue;
    procesadas++;
    let aviso;
    if (tipo === 'tareas') {
      const est = await tasksPending({ ...env, cfg, tenant: T }, T);
      if (!est || est.pendingNum === 0) {
        // Nada que avisar hoy: se marca igual para no volver a consultar en cada tick de esa hora.
        await env.DB.prepare('UPDATE push_subs SET ultimo = ? WHERE tenant_id = ?').bind(clave, T).run();
        continue;
      }
      aviso = { titulo: '🗓️ Tareas de hoy', cuerpo: String(est.msg || 'Tenés pendientes para hoy').slice(0, 300), url: '/app', tag: 'tareas' };
    } else {
      aviso = { titulo: '📊 Reporte de gastos', cuerpo: 'Ya está el reporte de ' + mesPrevio(loc.fecha), url: '/informe/mensual', tag: 'informe' };
    }
    // El texto se deja ANTES de mandar el push: el service worker lo pide apenas llega.
    await env.DB.prepare(`INSERT INTO settings (tenant_id, clave, valor) VALUES (?, 'push_aviso', ?)
                          ON CONFLICT (tenant_id, clave) DO UPDATE SET valor = excluded.valor`)
      .bind(T, JSON.stringify({ ...aviso, t: Date.now() })).run();
    const enviadosOk = [], gone = [];
    for (const s of destino) {
      try {
        const r = await enviarPush(s.endpoint, env);
        if (r.ok) { enviadosOk.push(s.hash); res.enviados++; }
        else if (r.gone) { gone.push(s.hash); res.borrados++; }
        else res.errores++;
      } catch { res.errores++; }
    }
    const sentencias = [];
    for (const h of enviadosOk) sentencias.push(env.DB.prepare('UPDATE push_subs SET ultimo = ? WHERE tenant_id = ? AND hash = ?').bind(clave, T, h));
    for (const h of gone) sentencias.push(env.DB.prepare('DELETE FROM push_subs WHERE tenant_id = ? AND hash = ?').bind(T, h));
    if (sentencias.length) await env.DB.batch(sentencias);
    if (enviadosOk.length) res.avisadas++;
  }
  return res;
}

// ---- PWA: manifest, service worker y página de avisos ---------------------------------------------------------------
export const MANIFEST_APP = {
  name: 'Gastos', short_name: 'Gastos', start_url: '/app', scope: '/', display: 'standalone',
  background_color: '#f4f4f2', theme_color: '#1f6f54',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
};

export const SERVICE_WORKER_APP = `// El push viene vacío: se pide el texto al servidor (con la cookie de sesión). Siempre se muestra una notificación
// (texto genérico si el servidor no contesta): iOS penaliza a quien recibe un push y no notifica.
self.addEventListener('push', function (event) {
  event.waitUntil((async function () {
    var titulo = '🔔 Gastos', cuerpo = 'Tenés un aviso nuevo', url = '/app', tag = 'gastos';
    try {
      var r = await Promise.race([
        fetch('/api/push/aviso', { method: 'POST', cache: 'no-store', credentials: 'same-origin' }),
        new Promise(function (_, no) { setTimeout(function () { no(new Error('timeout')); }, 4000); })
      ]);
      var d = await r.json();
      if (d && d.titulo) { titulo = d.titulo; cuerpo = d.cuerpo || ''; url = d.url || url; tag = d.tag || tag; }
    } catch (e) {}
    await self.registration.showNotification(titulo, {
      body: cuerpo, icon: '/icon-192.png', badge: '/icon-192.png', tag: tag, renotify: true, data: { url: url }
    });
  })());
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var destino = (event.notification.data && event.notification.data.url) || '/app';
  if (destino.charAt(0) !== '/') destino = '/app';
  event.waitUntil((async function () {
    var todas = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < todas.length; i++) {
      if ('navigate' in todas[i] && 'focus' in todas[i]) { try { await todas[i].navigate(destino); } catch (e) {} return todas[i].focus(); }
    }
    if (clients.openWindow) return clients.openWindow(destino);
  })());
});
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
`;

export const CSP_AVISOS = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function paginaAvisos(opc) {
  const o = opc || {};
  const inicial = JSON.stringify({ propia: !!o.esIlan, configurado: !!o.configurado, max: MAX_DISPOSITIVOS })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Gastos">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>Avisos · Gastos</title>
<style>
:root{--bg:#f4f4f2;--card:#fff;--ink:#1c1c1a;--mut:#6b6b66;--line:#d9d9d3;--acc:#1f6f54;--acc-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121413;--card:#1c1f1d;--ink:#ecece8;--mut:#9a9a93;--line:#34383a;--acc:#4cb68f;--acc-ink:#0c1511}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:460px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:22px;margin:0 0 8px}p{margin:8px 0;color:var(--mut)}
ol{padding-left:20px;color:var(--ink)}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 18px;background:var(--acc);color:var(--acc-ink);width:100%;margin-top:12px}
button.sec{background:none;color:var(--mut);border:1px solid var(--line)}
a{color:var(--acc)}#msg{min-height:1.4em;color:var(--ink)}
[hidden]{display:none!important}
</style></head><body><main>
<h1>🔔 Avisos</h1>
<p>Te avisamos a las 7 de la mañana si tenés tareas o citas para hoy, y el día 1 de cada mes cuando está el reporte.</p>
<div id="ios" hidden>
<p><b>En iPhone</b> hay que instalar la app primero:</p>
<ol><li>Tocá <b>Compartir</b> (el cuadradito con la flecha).</li><li>Elegí <b>Agregar a inicio</b>.</li><li>Abrila desde el ícono nuevo y volvé a esta página (⚙️ Ajustes → 🔔 Avisos).</li></ol>
</div>
<div id="nosoporta" hidden><p>Este navegador no soporta notificaciones push.</p></div>
<div id="ilan" hidden><p>Tu cuenta usa la app instalada de siempre para los avisos.</p></div>
<div id="sinclaves" hidden><p>Los avisos todavía no están disponibles en este servidor.</p></div>
<div id="ctl" hidden>
<button id="on" type="button">Activar avisos en este dispositivo</button>
<button id="off" type="button" class="sec" hidden>Desactivar en este dispositivo</button>
</div>
<p id="msg" role="status" aria-live="polite"></p>
<p><a href="/app">← Volver</a></p>
</main>
<script>
(function () {
  var E = ${inicial};
  var $ = function (id) { return document.getElementById(id); };
  function msg(t) { $('msg').textContent = t || ''; }
  function b64ToU8(b) { var p = '='.repeat((4 - b.length % 4) % 4); var r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); var o = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; }
  var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (E.propia) { $('ilan').hidden = false; return; }
  if (!E.configurado) { $('sinclaves').hidden = false; return; }
  if (ios && !standalone) { $('ios').hidden = false; return; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { $('nosoporta').hidden = false; return; }
  var reg = null;
  function estado(sub) { $('on').hidden = !!sub; $('off').hidden = !sub; $('ctl').hidden = false; }
  function post(ruta, cuerpo) {
    return fetch(ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) }).then(function (r) { return r.json(); });
  }
  navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function (r) {
    reg = r; return r.pushManager.getSubscription();
  }).then(function (sub) {
    if (sub && Notification.permission === 'granted') { post('/api/push/suscribir', { endpoint: sub.endpoint }); }
    estado(sub && Notification.permission === 'granted');
  }).catch(function () { msg('No se pudo preparar los avisos.'); });
  $('on').addEventListener('click', async function () {
    try {
      var p = await Notification.requestPermission();
      if (p !== 'granted') { msg('No diste permiso para notificaciones.'); return; }
      var k = await (await fetch('/api/push/vapid')).json();
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(k.key) });
      var r = await post('/api/push/suscribir', { endpoint: sub.endpoint });
      if (!r.ok) { msg(r.error || 'No se pudo activar.'); return; }
      msg('Listo. Los avisos quedaron activados en este dispositivo.'); estado(true);
    } catch (e) { msg('No se pudo activar: ' + (e && e.message ? e.message : e)); }
  });
  $('off').addEventListener('click', async function () {
    try {
      var sub = await reg.pushManager.getSubscription();
      if (sub) { await post('/api/push/desuscribir', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      msg('Avisos desactivados en este dispositivo.'); estado(false);
    } catch (e) { msg('No se pudo desactivar.'); }
  });
})();
</script></body></html>`;
}

export const ICONOS = { '/icon-192.png': ICONO_192, '/icon-512.png': ICONO_512 };
export function iconoBytes(ruta) {
  const b64 = ICONOS[ruta];
  if (!b64) return null;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
