// Importa el volcado de Apps Script (?action=exportAll) a D1.
//
//   node scripts/import.mjs --fetch            baja el volcado (usa APPS_SCRIPT_URL y APP_KEY del entorno)
//   node scripts/import.mjs --file export.json usa un volcado ya bajado
//   agregar --apply para ejecutarlo contra D1 remoto; sin eso solo genera el SQL
//
// Es repetible: borra lo del tenant y vuelve a cargar todo en una sola pasada,
// así importar dos veces no duplica nada. Mientras Apps Script siga siendo la
// fuente de verdad, se puede correr las veces que haga falta.
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TENANT = 'ilan';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

async function load() {
  if (val('--file')) return JSON.parse(readFileSync(val('--file'), 'utf8'));
  if (!flag('--fetch')) throw new Error('Usar --fetch o --file <export.json>');
  const base = process.env.APPS_SCRIPT_URL, k = process.env.APP_KEY;
  if (!base || !k) throw new Error('Faltan APPS_SCRIPT_URL y APP_KEY en el entorno');
  const u = new URL(base);
  u.searchParams.set('action', 'exportAll');
  u.searchParams.set('k', k);
  const r = await fetch(u, { redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('Respuesta no es JSON (¿clave mala?): ' + text.slice(0, 120)); }
}

const q = (s) => s == null || s === '' ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v))) ? 'NULL' : String(Number(v));
const b = (v) => v ? '1' : '0';

function buildSql(data) {
  const out = [];
  for (const t of ['expenses', 'month_totals', 'incomes', 'savings', 'tasks', 'purchases', 'habit_days', 'habit_log', 'foreign_movements', 'foreign_months']) out.push(`DELETE FROM ${t} WHERE tenant_id = '${TENANT}';`);
  let ne = 0, nm = 0;
  for (const m of data.months) {
    if (!m.ok) throw new Error(`Mes ${m.tab} falló en el volcado: ${m.error}`);
    const mes = `${m.year}-${String(m.month + 1).padStart(2, '0')}`;
    nm++;
    const t = m.totals || {};
    out.push(`INSERT INTO month_totals (tenant_id, mes, tab, uyu, usd, mixed_uyu, mixed_usd) VALUES ('${TENANT}', '${mes}', ${q(m.tab)}, ${n(t.uyu)}, ${n(t.usd)}, ${n(t.uyuInUyu)}, ${n(t.uyuInUsd)});`);
    for (const e of m.expenses) {
      const cats = String(e.category || '').split(' + ').map((s) => s.trim()).filter(Boolean);
      ne++;
      out.push(`INSERT INTO expenses (tenant_id, mes, tab, src_row, concepto, monto, moneda, uyu_raw, usd_raw, medio_pago, es_fijo, es_credito, es_ahorro, categoria, cat1, cat2, fecha, cotizacion, notas, grupo, grupo_nombre) VALUES ('${TENANT}', '${mes}', ${q(m.tab)}, ${n(e.row)}, ${q(e.item)}, ${n(e.amount)}, ${q(e.currency)}, ${e.fixed ? n(e.uyuRaw) : 'NULL'}, ${e.fixed ? n(e.usdRaw) : 'NULL'}, ${q(e.card)}, ${b(e.fixed)}, ${b(e.credito)}, ${b(e.ahorro)}, ${q(e.category)}, ${q(cats[0])}, ${q(cats[1])}, ${q(e.fecha)}, ${n(e.cotizacion)}, ${q(e.notas)}, ${q(e.grupo)}, ${q(e.grupoNombre)});`);
    }
  }
  for (const i of data.ingresos) {
    out.push(`INSERT INTO incomes (tenant_id, src_row, fecha, concepto, monto, moneda, notas) VALUES ('${TENANT}', ${n(i.row)}, ${q(i.fecha)}, ${q(i.concepto)}, ${n(i.monto)}, ${q(i.moneda)}, ${q(i.notas)});`);
  }
  for (const s of data.ahorros) {
    out.push(`INSERT INTO savings (tenant_id, src_row, fecha, tipo, entidad, ticker, cantidad, precio_usd, comision_usd, monto, moneda, invertido_usd, notas) VALUES ('${TENANT}', ${n(s.row)}, ${q(s.fecha)}, ${q(s.tipo)}, ${q(s.entidad)}, ${q(s.ticker)}, ${n(s.cantidad)}, ${n(s.precioUsd)}, ${n(s.comisionUsd)}, ${n(s.monto)}, ${q(s.moneda)}, ${n(s.invertidoUsd)}, ${q(s.notas)});`);
  }
  const tareas = data.tareas || [], compras = data.compras || [], habitos = data.habitos || [], pais = data.pais || [];
  for (const t of tareas) {
    out.push(`INSERT INTO tasks (tenant_id, src_row, creada, tipo, categoria, subcategoria, texto, fecha, hora, notas, completada, fecha_completada, recurrente, objetivo, contador, periodo, ultimo_reset, importancia, archivada, orden, subtareas) VALUES ('${TENANT}', ${n(t.row)}, ${q(t.creada)}, ${q(t.tipo)}, ${q(t.categoria)}, ${q(t.subcategoria)}, ${q(t.texto)}, ${q(t.fecha)}, ${q(t.hora)}, ${q(t.notas)}, ${b(t.completada)}, ${q(t.fechaCompletada)}, ${b(t.recurrente)}, ${n(t.objetivo)}, ${n(t.contador)}, ${q(t.periodo)}, ${q(t.ultimoReset)}, ${q(t.importancia)}, ${b(t.archivada)}, ${n(t.orden)}, ${q(JSON.stringify(t.subtareas || []))});`);
  }
  for (const c of compras) {
    out.push(`INSERT INTO purchases (tenant_id, src_row, creada, texto, comprado, fecha_comprado) VALUES ('${TENANT}', ${n(c.row)}, ${q(c.creada)}, ${q(c.texto)}, ${b(c.comprado)}, ${q(c.fechaComprado)});`);
  }
  let nd = 0, nl = 0;
  for (const h of habitos) {
    for (const d of h.days || []) {
      if (!d.hasData) continue;
      nd++;
      out.push(`INSERT INTO habit_days (tenant_id, fecha, tab, levante, acoste, hs_sueno, trabajo, avance, animo, ejercicio, ejercicio_min, medite, medite_min, lei, abordajes, agua, mast, notas) VALUES ('${TENANT}', ${q(d.date)}, ${q(h.tab)}, ${q(d.levante)}, ${q(d.acoste)}, ${n(d.hsSueno)}, ${n(d.trabajo)}, ${n(d.avance)}, ${n(d.animo)}, ${q(d.ejercicio)}, ${n(d.ejercicioMin)}, ${q(d.medite)}, ${n(d.mediteMin)}, ${q(d.lei)}, ${n(d.abordajes)}, ${n(d.agua)}, ${n(d.mast)}, ${q(d.notas)});`);
    }
    for (const l of h.log || []) {
      nl++;
      out.push(`INSERT INTO habit_log (tenant_id, fecha, hora, kind, detalle, macro, tipo, procesado, kcal, ml, min, ingredientes) VALUES ('${TENANT}', ${q(l.date)}, ${q(l.hora)}, ${q(l.kind)}, ${q(l.detalle)}, ${q(l.macro)}, ${q(l.tipo)}, ${q(l.procesado)}, ${n(l.kcal)}, ${n(l.ml)}, ${n(l.min)}, ${q(l.ingredientes)});`);
    }
  }
  let nf = 0;
  for (const p of pais) {
    const mes = `${p.year}-${String(p.month + 1).padStart(2, '0')}`;
    out.push(`INSERT INTO foreign_months (tenant_id, mes, deuda_antes_usd) VALUES ('${TENANT}', '${mes}', ${n(p.deudaAntesUsd)});`);
    for (const e of p.entradas || []) {
      nf++;
      out.push(`INSERT INTO foreign_movements (tenant_id, mes, tab, src_row, fecha, tipo, detalle, usd, cotizacion, monto_local, quien, categoria) VALUES ('${TENANT}', '${mes}', ${q(p.tab)}, ${n(e.row)}, ${q(e.fecha)}, ${q(e.tipo)}, ${q(e.detalle)}, ${n(e.usd)}, ${n(e.cotiz)}, ${n(e.ars)}, ${q(e.quien)}, ${q(e.categoria)});`);
    }
  }
  out.push(`INSERT INTO import_log (at, source, months, expenses, incomes, savings) VALUES ('${new Date().toISOString()}', 'apps-script exportAll', ${nm}, ${ne}, ${data.ingresos.length}, ${data.ahorros.length});`);
  return { sql: out.join('\n') + '\n', counts: { months: nm, expenses: ne, incomes: data.ingresos.length, savings: data.ahorros.length, tareas: tareas.length, compras: compras.length, habit_days: nd, habit_log: nl, pais_movs: nf } };
}

const data = await load();
if (!data.ok) throw new Error('El volcado dijo: ' + (data.error || JSON.stringify(data).slice(0, 200)));
const { sql, counts } = buildSql(data);
const outFile = val('--out') || join(here, 'import.generated.sql');
writeFileSync(outFile, sql);
console.log('SQL generado:', outFile, counts);
if (flag('--apply')) {
  const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(wrangler, ['--yes', 'wrangler@4', 'd1', 'execute', 'gastos-db', '--remote', '--file', outFile],
    { cwd: join(here, '..'), stdio: 'inherit', shell: process.platform === 'win32' });
  console.log('Aplicado a D1.');
}
