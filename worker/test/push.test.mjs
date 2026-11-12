// Tests de integración de los avisos push por cuenta (src/push.js, migración 0008).
//
// Necesita un `wrangler dev --local` levantado contra una base local con las migraciones 0001-0008, con:
//   --var VIEW_KEY:y --var APP_KEY:x --var ACCESS_AUD:x --var DEV_MOSTRAR_LINK:1
//   --var PUSH_DEV_SIN_ENVIO:1 --var VAPID_PRIVATE_JWK:falsa --var VAPID_PUBLIC_KEY:<clave pública cualquiera>
// (PUSH_DEV_SIN_ENVIO evita salir a internet; con DEV_MOSTRAR_LINK el tick acepta {"ahora": ISO} para simular la hora.)
// Uso: node test/push.test.mjs http://127.0.0.1:PUERTO
import assert from 'node:assert/strict';

const B = process.argv[2] || 'http://127.0.0.1:8870';
const out = [];
let fallas = 0;
const t = async (nombre, fn) => {
  try { await fn(); out.push('OK   ' + nombre); } catch (e) { fallas++; out.push('FAIL ' + nombre + ' -> ' + e.message); }
};
const f = (p, o = {}) => fetch(B + p, { redirect: 'manual', ...o });
const post = (p, body, h = {}) => f(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ILAN = 'vk=y';
const EP = (n) => 'https://fcm.googleapis.com/fcm/send/dispositivo-' + n;
const BASE_BA = {
  pais: 'ar', moneda: 'ars', tz: 'America/Argentina/Buenos_Aires',
  medios: ['Débito ARS', 'Efectivo ARS'], categorias: ['Otros', 'Comida'], modulos: { accesosRapidos: false, pais: false }
};

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
const sub = async (cookie, endpoint) => post('/api/push/suscribir', { endpoint }, { Cookie: cookie });
const tick = async (ahora, clave = 'x') => (await post('/api/push/tick', ahora ? { ahora } : {}, { 'X-Sync-Key': clave })).json();
const aviso = async (cookie) => (await post('/api/push/aviso', {}, { Cookie: cookie })).json();

// ---------------------------------------------------------------- estáticos de la PWA
await t('estáticos públicos: manifest, service worker e íconos sin sesión', async () => {
  const m = await f('/manifest.webmanifest'); assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  const j = await m.json(); assert.equal(j.start_url, '/app'); assert.equal(j.display, 'standalone');
  const sw = await f('/sw.js'); assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.match(await sw.text(), /showNotification/);
  for (const [p, min] of [['/icon-192.png', 1000], ['/icon-512.png', 5000]]) {
    const r = await f(p); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
    const b = new Uint8Array(await r.arrayBuffer());
    assert.ok(b.length > min, p + ' pesa ' + b.length);
    assert.deepEqual([...b.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
  assert.equal((await post('/sw.js', {})).status, 405);
});

// ---------------------------------------------------------------- página y clave pública
let A, B2, C;
await t('/avisos: sin sesión redirige a /login; con sesión 200 con CSP propia; ilan ve que usa la app de siempre', async () => {
  const sin = await f('/avisos'); assert.equal(sin.status, 302); assert.equal(sin.headers.get('location'), '/login');
  A = await cuentaNueva('push.a@ejemplo.com', BASE_BA);
  const r = await f('/avisos', { headers: { Cookie: A } }); assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /worker-src 'self'/); assert.match(csp, /manifest-src 'self'/); assert.match(csp, /default-src 'none'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const h = await r.text(); assert.match(h, /"propia":false/); assert.match(h, /"configurado":true/);
  const il = await (await f('/avisos', { headers: { Cookie: ILAN } })).text(); assert.match(il, /"propia":true/);
});
await t('/api/push/vapid: exige sesión y devuelve la clave pública', async () => {
  assert.equal((await f('/api/push/vapid')).status, 401);
  const j = await (await f('/api/push/vapid', { headers: { Cookie: A } })).json();
  assert.equal(j.ok, true); assert.ok(j.key && j.key.length > 20);
});

// ---------------------------------------------------------------- suscripciones
await t('suscribir: sin sesión 401, Origin ajeno 403, sin JSON 415, JSON roto 400', async () => {
  assert.equal((await post('/api/push/suscribir', { endpoint: EP(1) })).status, 401);
  assert.equal((await post('/api/push/suscribir', { endpoint: EP(1) }, { Cookie: A, Origin: 'https://evil.com' })).status, 403);
  assert.equal((await f('/api/push/suscribir', { method: 'POST', headers: { Cookie: A, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post('/api/push/suscribir', '{no es json', { Cookie: A })).status, 400);
});
await t('suscribir: endpoint inválido o de un host que no es push service -> 400 (anti SSRF)', async () => {
  for (const e of ['http://fcm.googleapis.com/fcm/send/x', 'https://evil.com/fcm/send/x', 'https://127.0.0.1/x',
    'https://localhost/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.com/x', 'https://evilpush.apple.com.evil.io/x', 'no-es-url', '', null, 5,
    'https://fcm.googleapis.com/' + 'a'.repeat(2100)]) {
    const r = await sub(A, e); const j = await r.json();
    assert.equal(r.status, 400, String(e).slice(0, 50) + ' -> ' + JSON.stringify(j)); assert.equal(j.ok, false);
  }
});
await t('suscribir: hosts reales de FCM, Mozilla, Apple y Windows valen', async () => {
  C = await cuentaNueva('push.c@ejemplo.com', BASE_BA);
  for (const e of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc', 'https://wns2-par02p.notify.windows.com/w/?token=abc']) {
    const j = await (await sub(C, e)).json(); assert.equal(j.ok, true, e + ' ' + JSON.stringify(j));
  }
  assert.equal((await (await post('/api/push/desuscribir', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }, { Cookie: C })).json()).ok, true);
});
await t('suscribir: ilan no usa este camino (400); re-suscribir el mismo dispositivo no cuenta doble; tope de 5', async () => {
  const il = await sub(ILAN, EP(1)); assert.equal(il.status, 400);
  for (let i = 1; i <= 5; i++) assert.equal((await (await sub(A, EP(i))).json()).ok, true);
  assert.equal((await (await sub(A, EP(3))).json()).ok, true, 're-suscribir uno existente');
  const sexto = await sub(A, EP(6)); const j = await sexto.json();
  assert.equal(sexto.status, 400); assert.match(j.error, /máximo de 5/);
  assert.equal((await (await post('/api/push/desuscribir', { endpoint: EP(5) }, { Cookie: A })).json()).ok, true);
  assert.equal((await (await sub(A, EP(6))).json()).ok, true, 'tras desactivar uno entra otro');
  assert.equal((await (await post('/api/push/desuscribir', { endpoint: EP(6) }, { Cookie: A })).json()).ok, true);
  assert.equal((await post('/api/push/desuscribir', { endpoint: 5 }, { Cookie: A })).status, 400);
});
await t('un dispositivo solo avisa a la última cuenta que lo activó', async () => {
  B2 = await cuentaNueva('push.b@ejemplo.com', BASE_BA);
  assert.equal((await (await sub(B2, EP(1))).json()).ok, true);
  // A tenía EP(1)..EP(4): ahora EP(1) es de B2. Se comprueba con el tick de más abajo (A manda a 3 dispositivos).
});

// ---------------------------------------------------------------- tick
await t('tick: exige X-Sync-Key y POST', async () => {
  assert.equal((await post('/api/push/tick', {})).status, 401);
  assert.equal((await post('/api/push/tick', {}, { 'X-Sync-Key': 'mala' })).status, 401);
  assert.equal((await f('/api/push/tick', { headers: { 'X-Sync-Key': 'x' } })).status, 405);
  assert.equal((await post('/api/push/tick', {}, { Cookie: ILAN })).status, 401, 'la sesión de ilan no vale: es del cron');
});
await t('tick: 08:00 locales no manda nada; 07:00 locales (Buenos Aires = 10:00Z) manda solo si hay tareas', async () => {
  const x = await tick('2027-03-10T11:00:00Z'); assert.equal(x.ok, true); assert.equal(x.enviados, 0);
  // Cuenta A sin tareas pendientes: a las 07:00 no se avisa nada (y no se vuelve a consultar en esa hora).
  const y = await tick('2027-03-10T10:00:00Z'); assert.equal(y.enviados, 0, JSON.stringify(y));
  assert.equal((await aviso(A)).titulo, undefined);
});
await t('tick: con una tarea vencida avisa a TODOS los dispositivos de la cuenta, una sola vez por día', async () => {
  const r = await (await post('/api/rpc/addTaskSafe', { args: [{ tipo: 'Tarea', texto: 'Pagar la luz', fecha: '2020-01-01' }] }, { Cookie: B2 })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const e of [2, 3]) assert.equal((await (await sub(B2, EP(10 + e))).json()).ok, true);
  const x = await tick('2027-03-11T10:00:00Z');
  assert.equal(x.avisadas, 1, JSON.stringify(x)); assert.equal(x.enviados, 3, 'B2 tiene 3 dispositivos: ' + JSON.stringify(x));
  const a = await aviso(B2);
  assert.match(a.titulo, /Tareas de hoy/); assert.match(a.cuerpo, /Pagar la luz/); assert.equal(a.url, '/app');
  const otra = await aviso(A); assert.equal(otra.titulo, undefined, 'el aviso de B2 no se ve desde A');
  const dos = await tick('2027-03-11T10:15:00Z'); assert.equal(dos.enviados, 0, 'mismo día: no repite ' + JSON.stringify(dos));
  const manana = await tick('2027-03-12T10:00:00Z'); assert.equal(manana.enviados, 3, 'otro día: vuelve a avisar');
});
await t('tick: el día 1 a las 09:00 locales sale el aviso del reporte del mes anterior', async () => {
  // El reporte sale a todas las cuentas con avisos (A: 3 dispositivos, B2: 3, C: 3), tengan o no tareas.
  const x = await tick('2027-03-01T12:00:00Z'); assert.equal(x.enviados, 9, JSON.stringify(x));
  const a = await aviso(B2); assert.match(a.titulo, /Reporte/); assert.match(a.cuerpo, /febrero 2027/); assert.equal(a.url, '/informe/mensual');
  assert.equal((await tick('2027-03-01T12:30:00Z')).enviados, 0, 'no repite');
  assert.equal((await tick('2027-03-02T12:00:00Z')).enviados, 0, 'el día 2 no hay reporte');
});
await t('tick: la hora es LOCAL de cada cuenta (Tokio 07:00 = 22:00Z del día anterior)', async () => {
  const J = await cuentaNueva('push.jp@ejemplo.com', { ...BASE_BA, pais: 'jp', moneda: 'jpy', tz: 'Asia/Tokyo' });
  assert.equal((await (await post('/api/rpc/addTaskSafe', { args: [{ tipo: 'Tarea', texto: 'Hanko', fecha: '2020-01-01' }] }, { Cookie: J })).json()).ok, true);
  assert.equal((await (await sub(J, EP(40))).json()).ok, true);
  assert.equal((await tick('2027-04-10T15:00:00Z')).enviados, 0, '15:00Z es medianoche en Tokio');
  assert.equal((await tick('2027-04-10T22:00:00Z')).enviados, 1);
  assert.match((await aviso(J)).cuerpo, /Hanko/);
});
await t('tick: ilan nunca entra (sus avisos siguen en el Worker de la PWA)', async () => {
  const x = await tick('2027-05-01T10:00:00Z'); assert.ok(x.cuentas >= 3);
  assert.equal((await aviso(ILAN)).titulo, undefined);
});
await t('tick: dispositivo desuscripto deja de recibir', async () => {
  await post('/api/push/desuscribir', { endpoint: EP(12) }, { Cookie: B2 });
  const x = await tick('2027-06-15T10:00:00Z'); assert.equal(x.enviados, 2, 'B2 pasó de 3 a 2 dispositivos: ' + JSON.stringify(x));
});
await t('tick: sin "ahora" usa el reloj real (responde ok)', async () => {
  const x = await tick(); assert.equal(x.ok, true);
});

console.log(out.join('\n'));
console.log(fallas ? '\n' + fallas + ' FALLAS' : '\nTodo OK (' + out.length + ')');
process.exit(fallas ? 1 : 0);
