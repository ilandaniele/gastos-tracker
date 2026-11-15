// Ícono elegido a mano en un gasto (src/rpc/gastos.js: limpiarIcono, addExpense, updateExpense, aGasto).
// Contra `wrangler dev --local` con las variables de cuenta.test.mjs. Uso: node test/icono.test.mjs URL
import assert from 'node:assert/strict';

const B = process.argv[2] || 'http://127.0.0.1:8877';
const out = [];
let fallas = 0;
const t = async (nombre, fn) => {
  try { await fn(); out.push('OK   ' + nombre); } catch (e) { fallas++; out.push('FAIL ' + nombre + ' -> ' + e.message); }
};
const f = (p, o = {}) => fetch(B + p, { redirect: 'manual', ...o });
const post = (p, body, h = {}) => f(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
const rpc = async (cookie, nombre, ...args) => (await post('/api/rpc/' + nombre, { args }, { Cookie: cookie })).json();

const j0 = await (await post('/login', { email: 'icono@example.com' })).json();
const r0 = await f(new URL(j0.dev_link).pathname, { method: 'POST', headers: { Origin: B } });
const C = (r0.headers.getSetCookie().find((c) => c.startsWith('sid=')) || '').split(';')[0];
await post('/api/config', { pais: 'AR', moneda: 'ARS', tz: 'America/Argentina/Buenos_Aires', medios: ['Efectivo ARS'], categorias: ['Comida', 'Mascotas', 'Otros'] }, { Cookie: C, Origin: B });
const base = { amount: 10, currency: 'ARS', card: 'Efectivo ARS', category: 'Comida' };
const alta = (extra) => rpc(C, 'addExpenseSafe', { ...base, ...extra });
const hoy = new Date().toISOString().slice(0, 7);
const lista = async () => {
  const d = await rpc(C, 'getDashboardData');
  return d.expenses || [];
};
const buscar = async (row) => (await lista()).find((e) => e.row === row);

let row;
await t('alta con ícono: se guarda y vuelve en el dashboard', async () => {
  const j = await alta({ item: 'Croquetas', icono: '🐶' });
  assert.equal(j.ok, true, JSON.stringify(j));
  row = j.row;
  assert.equal((await buscar(row)).icono, '🐶');
});

await t('alta sin ícono: el campo no aparece (automático)', async () => {
  const j = await alta({ item: 'Pan' });
  assert.equal(j.ok, true);
  assert.equal('icono' in (await buscar(j.row)), false);
});

await t('editar sin mandar icono no lo toca', async () => {
  const j = await rpc(C, 'updateExpenseSafe', { row, expectedItem: 'Croquetas', item: 'Croquetas', amount: 12, card: 'Efectivo ARS', category: 'Comida' });
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal((await buscar(row)).icono, '🐶');
});

await t('editar con otro emoji lo cambia (también secuencias con ZWJ y teclas)', async () => {
  for (const ic of ['🐱', '👨‍👩‍👧', '🏋️', '1️⃣']) {
    const j = await rpc(C, 'updateExpenseSafe', { row, expectedItem: 'Croquetas', item: 'Croquetas', amount: 12, card: 'Efectivo ARS', category: 'Comida', icono: ic });
    assert.equal(j.ok, true, ic + ' ' + JSON.stringify(j));
    assert.equal((await buscar(row)).icono, ic);
  }
});

await t("icono '' vuelve al automático", async () => {
  const j = await rpc(C, 'updateExpenseSafe', { row, expectedItem: 'Croquetas', item: 'Croquetas', amount: 12, card: 'Efectivo ARS', category: 'Comida', icono: '' });
  assert.equal(j.ok, true);
  assert.equal('icono' in (await buscar(row)), false);
});

await t('valores hostiles se rechazan y no se guardan', async () => {
  for (const malo of ['<script>alert(1)</script>', '"><img src=x>', 'abc', 'x'.repeat(40), '😀'.repeat(20), "'", String.fromCharCode(92), '🙂<']) {
    const j = await alta({ item: 'Hostil', icono: malo });
    assert.equal(j.ok, false, JSON.stringify(malo));
    assert.match(j.error, /Ícono inválido/);
    const k = await rpc(C, 'updateExpenseSafe', { row, expectedItem: 'Croquetas', item: 'Croquetas', amount: 12, card: 'Efectivo ARS', category: 'Comida', icono: malo });
    assert.equal(k.ok, false, 'edición ' + JSON.stringify(malo));
  }
  assert.equal((await lista()).some((e) => e.item === 'Hostil'), false);
  assert.equal('icono' in (await buscar(row)), false);
});

console.log(out.join('\n'));
console.log(`\n${out.length - fallas}/${out.length} OK`);
process.exitCode = fallas ? 1 : 0;
