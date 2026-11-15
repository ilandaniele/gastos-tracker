// Tests de exportar y borrar la cuenta (src/datos.js). Contra un `wrangler dev --local` con las migraciones 0001-0009 y:
//   --var VIEW_KEY:y --var APP_KEY:x --var ACCESS_AUD:x --var DEV_MOSTRAR_LINK:1
// y la base sembrada igual que para paso2 (settings de 'ilan' con los módulos en d1). Uso: node test/cuenta.test.mjs URL
import assert from 'node:assert/strict';

const B = process.argv[2] || 'http://127.0.0.1:8843';
const out = [];
let fallas = 0;
const t = async (nombre, fn) => {
  try { await fn(); out.push('OK   ' + nombre); } catch (e) { fallas++; out.push('FAIL ' + nombre + ' -> ' + e.message); }
};
const f = (p, o = {}) => fetch(B + p, { redirect: 'manual', ...o });
const post = (p, body, h = {}) => f(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
const rpc = async (cookie, nombre, ...args) => (await post('/api/rpc/' + nombre, { args }, { Cookie: cookie })).json();
const ILAN = 'vk=y';

async function cuentaNueva(email) {
  const j = await (await post('/login', { email })).json();
  if (!j.dev_link) throw new Error('sin dev_link: ' + JSON.stringify(j));
  const r = await f(new URL(j.dev_link).pathname, { method: 'POST', headers: { Origin: B } });
  const sid = (r.headers.getSetCookie().find((c) => c.startsWith('sid=')) || '').split(';')[0];
  if (!sid) throw new Error('sin sid');
  return sid;
}
const MAIL_A = 'borrar.a@example.com', MAIL_B = 'queda.b@example.com';
const A = await cuentaNueva(MAIL_A);
const Bk = await cuentaNueva(MAIL_B);
for (const [c, nombre] of [[A, 'Pan de A'], [Bk, 'Pan de B']]) {
  await post('/api/config', { pais: 'AR', moneda: 'ARS', tz: 'America/Argentina/Buenos_Aires', medios: ['Efectivo ARS'], categorias: ['Comida', 'Otros'] }, { Cookie: c, Origin: B });
  const j = await rpc(c, 'addExpenseSafe', { item: nombre, amount: 100, currency: 'ARS', card: 'Efectivo ARS', category: 'Comida' });
  assert.equal(j.ok, true, JSON.stringify(j));
}

await t('/cuenta sin sesión redirige a /login; con sesión da 200, trae el mail y no se cachea', async () => {
  assert.equal((await f('/cuenta')).status, 302);
  const r = await f('/cuenta', { headers: { Cookie: A } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.match(await r.text(), /borrar\.a@example\.com/);
});

await t('exportar: sin sesión 401; con sesión baja solo los datos de la cuenta, como adjunto', async () => {
  assert.equal((await f('/api/cuenta/exportar')).status, 401);
  const r = await f('/api/cuenta/exportar', { headers: { Cookie: A } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Disposition') || '', /attachment/);
  const j = await r.json();
  assert.equal(j.cuenta.email, MAIL_A);
  const txt = JSON.stringify(j);
  assert.ok(txt.includes('Pan de A'));
  assert.ok(!txt.includes('Pan de B'), 'se coló un gasto de otra cuenta');
  assert.ok(!txt.includes('SECRETO_DE_ILAN'), 'se coló un gasto de ilan');
  assert.ok(Array.isArray(j.datos.expenses) && j.datos.expenses.length === 1);
});

await t('borrar: sin sesión 401, Origin ajeno 403, sin JSON 415', async () => {
  assert.equal((await post('/api/cuenta/borrar', { confirmar: MAIL_A })).status, 401);
  assert.equal((await post('/api/cuenta/borrar', { confirmar: MAIL_A }, { Cookie: A, Origin: 'https://malo.example' })).status, 403);
  assert.equal((await f('/api/cuenta/borrar', { method: 'POST', headers: { Cookie: A, 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
});

await t('borrar: con el mail equivocado o vacío no borra nada', async () => {
  for (const mal of ['', 'otro@example.com', MAIL_B]) {
    const r = await post('/api/cuenta/borrar', { confirmar: mal }, { Cookie: A });
    assert.equal(r.status, 400); assert.equal((await r.json()).ok, false);
  }
  const j = await (await f('/api/cuenta/exportar', { headers: { Cookie: A } })).json();
  assert.equal(j.datos.expenses.length, 1);
});

await t('borrar: la cuenta del dueño no se borra aunque se mande su mail', async () => {
  const r = await post('/api/cuenta/borrar', { confirmar: 'ilan.daniele@gmail.com' }, { Cookie: ILAN });
  assert.equal(r.status, 400);
  const g = await (await f('/api/expenses', { headers: { Cookie: ILAN } })).json();
  assert.ok(JSON.stringify(g).includes('SECRETO_DE_ILAN'), 'los datos de ilan desaparecieron');
});

await t('borrar: con el mail correcto (mayúsculas y espacios incluidos) borra todo y cierra la sesión', async () => {
  const r = await post('/api/cuenta/borrar', { confirmar: '  Borrar.A@Example.com ' }, { Cookie: A });
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  assert.match(r.headers.get('Set-Cookie') || '', /sid=;.*Max-Age=0/);
  assert.equal((await f('/api/expenses', { headers: { Cookie: A } })).status, 401, 'la sesión sigue viva');
  assert.equal((await f('/cuenta', { headers: { Cookie: A } })).status, 302);
});

await t('borrar: no toca a otra cuenta ni a ilan', async () => {
  const j = await (await f('/api/cuenta/exportar', { headers: { Cookie: Bk } })).json();
  assert.equal(j.cuenta.email, MAIL_B);
  assert.equal(j.datos.expenses.length, 1);
  assert.ok(JSON.stringify(j).includes('Pan de B'));
  const g = await (await f('/api/expenses', { headers: { Cookie: ILAN } })).json();
  assert.ok(JSON.stringify(g).includes('SECRETO_DE_ILAN'));
});

await t('borrar: el mail se puede volver a registrar y la cuenta nueva arranca vacía', async () => {
  const A2 = await cuentaNueva(MAIL_A);
  const j = await (await f('/api/cuenta/exportar', { headers: { Cookie: A2 } })).json();
  assert.equal(j.cuenta.email, MAIL_A);
  assert.equal(j.datos.expenses.length, 0);
  assert.ok(!JSON.stringify(j).includes('Pan de A'), 'volvieron datos de la cuenta borrada');
});

console.log(out.join('\n'));
console.log(`\n${out.length - fallas}/${out.length} OK`);
process.exitCode = fallas ? 1 : 0;
