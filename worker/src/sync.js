// Convierte el volcado de Apps Script (?action=exportAll) en sentencias SQL para D1.
// Lo usan el importador de línea de comandos (scripts/import.mjs) y el cron del Worker,
// así hay una sola lógica de carga.
//
// Todo es "borrar lo del tenant y volver a cargar", así que repetirlo no duplica nada.
// En modo parcial (cron) los gastos y totales solo se reemplazan para los meses que
// vienen en el volcado; el resto de las tablas se reemplaza entero porque es chico.

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

export function buildStatements(data, { tenant = 'ilan', fuente = 'apps-script exportAll' } = {}) {
  const T = `'${tenant}'`;
  const out = [];
  const parcial = !!data.parcial;
  for (const m of data.months) if (!m.ok) throw new Error(`Mes ${m.tab} falló en el volcado: ${m.error}`);
  const meses = data.months.map((m) => mesDe(m.year, m.month));

  // Gastos y totales: todo, o solo los meses del volcado.
  if (parcial) {
    if (meses.length) {
      const lista = meses.map((x) => `'${x}'`).join(', ');
      out.push(`DELETE FROM expenses WHERE tenant_id = ${T} AND mes IN (${lista})`);
      out.push(`DELETE FROM month_totals WHERE tenant_id = ${T} AND mes IN (${lista})`);
    }
  } else {
    out.push(`DELETE FROM expenses WHERE tenant_id = ${T}`);
    out.push(`DELETE FROM month_totals WHERE tenant_id = ${T}`);
  }
  for (const t of ['incomes', 'savings', 'tasks', 'purchases', 'habit_days', 'habit_log', 'foreign_movements', 'foreign_months', 'config']) {
    out.push(`DELETE FROM ${t} WHERE tenant_id = ${T}`);
  }

  const totales = [], gastos = [];
  for (const m of data.months) {
    const mes = mesDe(m.year, m.month);
    const t = m.totals || {};
    totales.push([T, q(mes), q(m.tab), n(t.uyu), n(t.usd), n(t.uyuInUyu), n(t.uyuInUsd)]);
    for (const e of m.expenses) {
      const cats = String(e.category || '').split(' + ').map((s) => s.trim()).filter(Boolean);
      const real = ISO.test(e.fecha || '');
      gastos.push([T, q(mes), q(m.tab), n(e.row), q(e.item), n(e.amount), q(e.currency),
        e.fixed ? n(e.uyuRaw) : 'NULL', e.fixed ? n(e.usdRaw) : 'NULL', q(e.card), b(e.fixed), b(e.credito), b(e.ahorro),
        q(e.category), q(cats[0]), q(cats[1]), q(e.fecha), n(e.cotizacion), q(e.notas), q(e.grupo), q(e.grupoNombre),
        q(real ? e.fecha : `${mes}-01`), q(real ? 'hoja' : 'mes')]);
    }
  }
  insertar(out, 'month_totals', ['tenant_id', 'mes', 'tab', 'uyu', 'usd', 'mixed_uyu', 'mixed_usd'], totales);
  insertar(out, 'expenses', ['tenant_id', 'mes', 'tab', 'src_row', 'concepto', 'monto', 'moneda', 'uyu_raw', 'usd_raw', 'medio_pago', 'es_fijo', 'es_credito', 'es_ahorro',
    'categoria', 'cat1', 'cat2', 'fecha', 'cotizacion', 'notas', 'grupo', 'grupo_nombre', 'fecha_efectiva', 'fecha_origen'], gastos);

  const ingresos = data.ingresos || [], ahorros = data.ahorros || [];
  insertar(out, 'incomes', ['tenant_id', 'src_row', 'fecha', 'concepto', 'monto', 'moneda', 'notas'],
    ingresos.map((i) => [T, n(i.row), q(i.fecha), q(i.concepto), n(i.monto), q(i.moneda), q(i.notas)]));
  insertar(out, 'savings', ['tenant_id', 'src_row', 'fecha', 'tipo', 'entidad', 'ticker', 'cantidad', 'precio_usd', 'comision_usd', 'monto', 'moneda', 'invertido_usd', 'notas'],
    ahorros.map((s) => [T, n(s.row), q(s.fecha), q(s.tipo), q(s.entidad), q(s.ticker), n(s.cantidad), n(s.precioUsd), n(s.comisionUsd), n(s.monto), q(s.moneda), n(s.invertidoUsd), q(s.notas)]));

  const tareas = data.tareas || [], compras = data.compras || [], habitos = data.habitos || [], pais = data.pais || [];
  insertar(out, 'tasks', ['tenant_id', 'src_row', 'creada', 'tipo', 'categoria', 'subcategoria', 'texto', 'fecha', 'hora', 'notas', 'completada', 'fecha_completada',
    'recurrente', 'objetivo', 'contador', 'periodo', 'ultimo_reset', 'importancia', 'archivada', 'orden', 'subtareas'],
  tareas.map((t) => [T, n(t.row), q(t.creada), q(t.tipo), q(t.categoria), q(t.subcategoria), q(t.texto), q(t.fecha), q(t.hora), q(t.notas), b(t.completada), q(t.fechaCompletada),
    b(t.recurrente), n(t.objetivo), n(t.contador), q(t.periodo), q(t.ultimoReset), q(t.importancia), b(t.archivada), n(t.orden), q(JSON.stringify(t.subtareas || []))]));
  insertar(out, 'purchases', ['tenant_id', 'src_row', 'creada', 'texto', 'comprado', 'fecha_comprado'],
    compras.map((c) => [T, n(c.row), q(c.creada), q(c.texto), b(c.comprado), q(c.fechaComprado)]));

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
  insertar(out, 'habit_days', ['tenant_id', 'fecha', 'tab', 'levante', 'acoste', 'hs_sueno', 'trabajo', 'avance', 'animo', 'ejercicio', 'ejercicio_min', 'medite', 'medite_min', 'lei', 'abordajes', 'agua', 'mast', 'notas'], dias);
  insertar(out, 'habit_log', ['tenant_id', 'fecha', 'hora', 'kind', 'detalle', 'macro', 'tipo', 'procesado', 'kcal', 'ml', 'min', 'ingredientes'], log);

  const pm = [], pv = [];
  for (const p of pais) {
    const mes = mesDe(p.year, p.month);
    pm.push([T, q(mes), n(p.deudaAntesUsd)]);
    for (const e of p.entradas || []) pv.push([T, q(mes), q(p.tab), n(e.row), q(e.fecha), q(e.tipo), q(e.detalle), n(e.usd), n(e.cotiz), n(e.ars), q(e.quien), q(e.categoria)]);
  }
  insertar(out, 'foreign_months', ['tenant_id', 'mes', 'deuda_antes_usd'], pm);
  insertar(out, 'foreign_movements', ['tenant_id', 'mes', 'tab', 'src_row', 'fecha', 'tipo', 'detalle', 'usd', 'cotizacion', 'monto_local', 'quien', 'categoria'], pv);

  const cfg = data.config || {};
  insertar(out, 'config', ['tenant_id', 'clave', 'valor'], Object.entries(cfg).map(([k, v]) => [T, q(k), q(v)]));

  const nGastos = gastos.length;
  out.push(`INSERT INTO import_log (at, source, months, expenses, incomes, savings) VALUES ('${new Date().toISOString()}', ${q(fuente + (parcial ? ' (parcial)' : ''))}, ${data.months.length}, ${nGastos}, ${ingresos.length}, ${ahorros.length})`);

  return {
    statements: out,
    counts: { months: data.months.length, expenses: nGastos, incomes: ingresos.length, savings: ahorros.length, tareas: tareas.length, compras: compras.length,
      habit_days: dias.length, habit_log: log.length, pais_movs: pv.length, config: Object.keys(cfg).length, parcial }
  };
}
