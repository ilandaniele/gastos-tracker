// Convierte el volcado de Apps Script (?action=exportAll) en sentencias SQL para D1.
// Lo usan el importador de línea de comandos (scripts/import.mjs) y el sync del Worker,
// así hay una sola lógica de carga.
//
// El SQL sale en GRUPOS (gastos de un mes, tareas, compras, ...). Cada grupo se borra y se
// recarga entero, así repetirlo no duplica nada. El sync automático compara la huella de
// cada grupo con la guardada (tabla sync_state) y solo escribe los que cambiaron: el plan
// gratis de D1 limita las filas escritas por día y reescribir todo cada 15 min no alcanza.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const q = (s) => s == null || s === '' ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v))) ? 'NULL' : String(Number(v));
const b = (v) => v ? '1' : '0';
const mesDe = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}`;

// INSERT de varias filas por sentencia: D1 limita las consultas por invocación,
// así que se agrupan. Los valores van como literales ya escapados.
function insertar(out, tabla, cols, filas, porSentencia = 40) {
  for (let i = 0; i < filas.length; i += porSentencia) {
    out.push(`INSERT INTO ${tabla} (${cols.join(', ')}) VALUES\n` + filas.slice(i, i + porSentencia).map((f) => '(' + f.join(', ') + ')').join(',\n'));
  }
}

// Módulos cuya fuente de verdad ya es D1 (ver rpc.js): no se borran ni se recargan
// desde el Sheet, para no pisar lo que se escribió directo en D1.
const GRUPOS_DE_MODULO = { compras: ['purchases'] };

export async function huella(sql) {
  const bytes = new TextEncoder().encode(sql.join(';\n'));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function buildGroups(data, { tenant = 'ilan', saltear = [] } = {}) {
  const T = `'${tenant}'`;
  const grupos = [];
  const grupo = (key) => { const sql = []; grupos.push({ key, sql }); return sql; };
  const saltadas = new Set(saltear.flatMap((m) => GRUPOS_DE_MODULO[m] || []));
  const parcial = !!data.parcial;
  for (const m of data.months) if (!m.ok) throw new Error(`Mes ${m.tab} falló en el volcado: ${m.error}`);

  // Gastos y totales: un grupo por mes. En carga completa se limpia antes todo lo del
  // tenant, por si un mes ya no existe en el Sheet.
  if (!parcial) {
    const g = grupo('limpieza');
    g.push(`DELETE FROM expenses WHERE tenant_id = ${T}`, `DELETE FROM month_totals WHERE tenant_id = ${T}`);
  }
  let nGastos = 0;
  for (const m of data.months) {
    const mes = mesDe(m.year, m.month);
    const t = m.totals || {};
    const g = grupo('gastos:' + mes);
    g.push(`DELETE FROM expenses WHERE tenant_id = ${T} AND mes = '${mes}'`, `DELETE FROM month_totals WHERE tenant_id = ${T} AND mes = '${mes}'`);
    insertar(g, 'month_totals', ['tenant_id', 'mes', 'tab', 'uyu', 'usd', 'mixed_uyu', 'mixed_usd'],
      [[T, q(mes), q(m.tab), n(t.uyu), n(t.usd), n(t.uyuInUyu), n(t.uyuInUsd)]]);
    const gastos = [];
    for (const e of m.expenses) {
      const cats = String(e.category || '').split(' + ').map((s) => s.trim()).filter(Boolean);
      const real = ISO.test(e.fecha || '');
      gastos.push([T, q(mes), q(m.tab), n(e.row), q(e.item), n(e.amount), q(e.currency),
        e.fixed ? n(e.uyuRaw) : 'NULL', e.fixed ? n(e.usdRaw) : 'NULL', q(e.card), b(e.fixed), b(e.credito), b(e.ahorro),
        q(e.category), q(cats[0]), q(cats[1]), q(e.fecha), n(e.cotizacion), q(e.notas), q(e.grupo), q(e.grupoNombre),
        q(real ? e.fecha : `${mes}-01`), q(real ? 'hoja' : 'mes')]);
    }
    nGastos += gastos.length;
    insertar(g, 'expenses', ['tenant_id', 'mes', 'tab', 'src_row', 'concepto', 'monto', 'moneda', 'uyu_raw', 'usd_raw', 'medio_pago', 'es_fijo', 'es_credito', 'es_ahorro',
      'categoria', 'cat1', 'cat2', 'fecha', 'cotizacion', 'notas', 'grupo', 'grupo_nombre', 'fecha_efectiva', 'fecha_origen'], gastos);
  }

  const ingresos = data.ingresos || [], ahorros = data.ahorros || [];
  const tareas = data.tareas || [], compras = data.compras || [], habitos = data.habitos || [], pais = data.pais || [];

  let g = grupo('ingresos');
  g.push(`DELETE FROM incomes WHERE tenant_id = ${T}`);
  insertar(g, 'incomes', ['tenant_id', 'src_row', 'fecha', 'concepto', 'monto', 'moneda', 'notas'],
    ingresos.map((i) => [T, n(i.row), q(i.fecha), q(i.concepto), n(i.monto), q(i.moneda), q(i.notas)]));

  g = grupo('ahorros');
  g.push(`DELETE FROM savings WHERE tenant_id = ${T}`);
  insertar(g, 'savings', ['tenant_id', 'src_row', 'fecha', 'tipo', 'entidad', 'ticker', 'cantidad', 'precio_usd', 'comision_usd', 'monto', 'moneda', 'invertido_usd', 'notas'],
    ahorros.map((s) => [T, n(s.row), q(s.fecha), q(s.tipo), q(s.entidad), q(s.ticker), n(s.cantidad), n(s.precioUsd), n(s.comisionUsd), n(s.monto), q(s.moneda), n(s.invertidoUsd), q(s.notas)]));

  g = grupo('tareas');
  g.push(`DELETE FROM tasks WHERE tenant_id = ${T}`);
  insertar(g, 'tasks', ['tenant_id', 'src_row', 'creada', 'tipo', 'categoria', 'subcategoria', 'texto', 'fecha', 'hora', 'notas', 'completada', 'fecha_completada',
    'recurrente', 'objetivo', 'contador', 'periodo', 'ultimo_reset', 'importancia', 'archivada', 'orden', 'subtareas'],
  tareas.map((t) => [T, n(t.row), q(t.creada), q(t.tipo), q(t.categoria), q(t.subcategoria), q(t.texto), q(t.fecha), q(t.hora), q(t.notas), b(t.completada), q(t.fechaCompletada),
    b(t.recurrente), n(t.objetivo), n(t.contador), q(t.periodo), q(t.ultimoReset), q(t.importancia), b(t.archivada), n(t.orden), q(JSON.stringify(t.subtareas || []))]));

  if (!saltadas.has('purchases')) {
    g = grupo('compras');
    g.push(`DELETE FROM purchases WHERE tenant_id = ${T}`);
    insertar(g, 'purchases', ['tenant_id', 'src_row', 'creada', 'texto', 'comprado', 'fecha_comprado'],
      compras.map((c) => [T, n(c.row), q(c.creada), q(c.texto), b(c.comprado), q(c.fechaComprado)]));
  }

  const dias = [], log = [];
  for (const h of habitos) {
    for (const d of h.days || []) {
      if (!d.hasData) continue;
      dias.push([T, q(d.date), q(h.tab), q(d.levante), q(d.acoste), n(d.hsSueno), n(d.trabajo), n(d.avance), n(d.animo), q(d.ejercicio), n(d.ejercicioMin),
        q(d.medite), n(d.mediteMin), q(d.lei), n(d.abordajes), n(d.agua), n(d.mast), q(d.notas)]);
    }
    for (const l of h.log || []) {
      log.push([T, q(l.date), q(l.hora), q(l.kind), q(l.detalle), q(l.macro), q(l.tipo), q(l.procesado), n(l.kcal), n(l.ml), n(l.min), q(l.ingredientes)]);
    }
  }
  g = grupo('habitos');
  g.push(`DELETE FROM habit_days WHERE tenant_id = ${T}`, `DELETE FROM habit_log WHERE tenant_id = ${T}`);
  insertar(g, 'habit_days', ['tenant_id', 'fecha', 'tab', 'levante', 'acoste', 'hs_sueno', 'trabajo', 'avance', 'animo', 'ejercicio', 'ejercicio_min', 'medite', 'medite_min', 'lei', 'abordajes', 'agua', 'mast', 'notas'], dias);
  insertar(g, 'habit_log', ['tenant_id', 'fecha', 'hora', 'kind', 'detalle', 'macro', 'tipo', 'procesado', 'kcal', 'ml', 'min', 'ingredientes'], log);

  const pm = [], pv = [];
  for (const p of pais) {
    const mes = mesDe(p.year, p.month);
    pm.push([T, q(mes), n(p.deudaAntesUsd)]);
    for (const e of p.entradas || []) pv.push([T, q(mes), q(p.tab), n(e.row), q(e.fecha), q(e.tipo), q(e.detalle), n(e.usd), n(e.cotiz), n(e.ars), q(e.quien), q(e.categoria)]);
  }
  g = grupo('pais');
  g.push(`DELETE FROM foreign_movements WHERE tenant_id = ${T}`, `DELETE FROM foreign_months WHERE tenant_id = ${T}`);
  insertar(g, 'foreign_months', ['tenant_id', 'mes', 'deuda_antes_usd'], pm);
  insertar(g, 'foreign_movements', ['tenant_id', 'mes', 'tab', 'src_row', 'fecha', 'tipo', 'detalle', 'usd', 'cotizacion', 'monto_local', 'quien', 'categoria'], pv);

  const cfg = data.config || {};
  g = grupo('config');
  g.push(`DELETE FROM config WHERE tenant_id = ${T}`);
  insertar(g, 'config', ['tenant_id', 'clave', 'valor'], Object.entries(cfg).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [T, q(k), q(v)]));

  return {
    grupos,
    counts: { months: data.months.length, expenses: nGastos, incomes: ingresos.length, savings: ahorros.length, tareas: tareas.length, compras: compras.length,
      habit_days: dias.length, habit_log: log.length, pais_movs: pv.length, config: Object.keys(cfg).length, parcial }
  };
}

const logImport = (tenant, fuente, parcial, c) =>
  `INSERT INTO import_log (at, source, months, expenses, incomes, savings) VALUES ('${new Date().toISOString()}', ${q(fuente + (parcial ? ' (parcial)' : ''))}, ${c.months}, ${c.expenses}, ${c.incomes}, ${c.savings})`;

// Carga completa (importador de línea de comandos): todo, sin comparar huellas.
export function buildStatements(data, { tenant = 'ilan', fuente = 'apps-script exportAll', saltear = [] } = {}) {
  const { grupos, counts } = buildGroups(data, { tenant, saltear });
  const statements = grupos.flatMap((g) => g.sql);
  statements.push(logImport(tenant, fuente, !!data.parcial, counts));
  return { statements, counts };
}

// Sync del Worker: solo los grupos cuya huella cambió. Devuelve las sentencias a correr y
// lo que hay que anotar en sync_state; si no cambió nada, no hay sentencias.
// El plan gratis permite ~50 consultas por invocación: si no entran todos los grupos
// cambiados, los que faltan quedan sin huella y se cargan en la próxima corrida.
export async function buildDelta(data, previas, { tenant = 'ilan', fuente = 'cron', saltear = [], presupuesto = 40 } = {}) {
  const { grupos, counts } = buildGroups(data, { tenant, saltear });
  const statements = [];
  const nuevas = [];
  const cambiados = [];
  const pendientes = [];
  for (const g of grupos) {
    const h = await huella(g.sql);
    if (previas[g.key] === h) continue;
    if (cambiados.length && statements.length + g.sql.length + 2 > presupuesto) { pendientes.push(g.key); continue; }
    statements.push(...g.sql);
    nuevas.push([g.key, h]);
    cambiados.push(g.key);
  }
  for (const [k, h] of nuevas) {
    statements.push(`INSERT INTO sync_state (tenant_id, grupo, huella) VALUES ('${tenant}', ${q(k)}, '${h}') ON CONFLICT (tenant_id, grupo) DO UPDATE SET huella = excluded.huella`);
  }
  if (cambiados.length) statements.push(logImport(tenant, fuente, !!data.parcial, counts));
  return { statements, counts: { ...counts, gruposCambiados: cambiados, gruposPendientes: pendientes } };
}
