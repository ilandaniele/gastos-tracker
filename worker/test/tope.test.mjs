// Tope de gastos por cuenta (src/rpc.js). Contra `wrangler dev --local` con --var GASTOS_MAX_CUENTA:3 --var GASTOS_TOPE_SIEMPRE:1
// más las variables de cuenta.test.mjs, y la base sembrada como paso2. Uso: node test/tope.test.mjs URL
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

const j0 = await (await post('/login', { email: 'tope@example.com' })).json();
const r0 = await f(new URL(j0.dev_link).pathname, { method: 'POST', headers: { Origin: B } });
const C = (r0.headers.getSetCookie().find((c) => c.startsWith('sid=')) || '').split(';')[0];
await post('/api/config', { pais: 'AR', moneda: 'ARS', tz: 'America/Argentina/Buenos_Aires', medios: ['Efectivo ARS'], categorias: ['Comida', 'Otros'] }, { Cookie: C, Origin: B });
const gasto = (n) => rpc(C, 'addExpenseSafe', { item: 'Gasto ' + n, amount: 10, currency: 'ARS', card: 'Efectivo ARS', category: 'Comida' });

let primero;
await t('hasta el tope (3) deja cargar; el siguiente se rechaza con un mensaje claro', async () => {
  for (let i = 1; i <= 3; i++) { const g = await gasto(i); assert.equal(g.ok, true, 'gasto ' + i); if (i === 1) primero = g.row; }
  const j = await gasto(4);
  assert.equal(j.ok, false);
  assert.match(j.error, /máximo de 3 gastos/);
});

await t('addBatch también respeta el tope', async () => {
  const j = await rpc(C, 'addBatch', [{ item: 'x', amount: 1, currency: 'ARS', card: 'Efectivo ARS', category: 'Comida' }], 'Comercio');
  assert.equal(j.ok, false);
});

await t('borrar un gasto libera lugar', async () => {
  const d = await rpc(C, 'deleteExpenseSafe', { row: primero, item: 'Gasto 1' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal((await gasto(5)).ok, true);
});

await t('el dueño no tiene tope', async () => {
  for (let i = 0; i < 4; i++) {
    const j = await rpc('vk=y', 'addExpenseSafe', { item: 'Dueño ' + i, amount: 1, currency: 'UYU', card: 'Efectivo UYU', category: 'Comida' });
    assert.notEqual(j.error && /máximo de/.test(j.error), true, JSON.stringify(j));
  }
});

console.log(out.join('\n'));
console.log(`\n${out.length - fallas}/${out.length} OK`);
process.exitCode = fallas ? 1 : 0;
