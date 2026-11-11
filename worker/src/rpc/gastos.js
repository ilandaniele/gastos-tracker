// Módulo gastos. Contrato: ver src/rpc.js y src/rpc/compras.js (ejemplo completo).
// Port de Code.gs: addExpenseSafe, addBatch, updateExpenseSafe, deleteExpenseSafe, setExpenseCategory,
// getDashboardData, getMonthlyTotals y scanTicket. Misma forma de respuesta que Apps Script;
// `row` = id de D1 (en el Sheet era la fila de la hoja).
//
// Diferencias de diseño respecto del Sheet:
//   - "Mes" ya no es una pestaña sino expenses.mes ('2026-11'); `tab` ('Noviembre 2026') se deriva del mes.
//   - Fechas reales: `fecha` (la ingresada), `fecha_efectiva` (= fecha) y fecha_origen 'manual'.
//   - month_totals se recalcula desde expenses en cada escritura (misma regla que _calcMonthTotals).
//   - Cotización automática: fetch HTTP (sin GOOGLEFINANCE) con cache de 10 min en settings.cotiz_usd_cache.
//   - scanTicket usa env.GEMINI_API_KEY (secreto del Worker; reemplaza a la propiedad GEMINI_KEY de Apps Script).
import { hoy, idDe, fuenteDefecto } from './util.js';
import CFG from '../form-config.json';

export const MODULO = 'gastos';

// ---- Constantes (Code.gs) -------------------------------------------------------------------
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const FIXED_LABELS = ['Alquiler', 'Gastos comunes', 'Tributos domiciliarios', 'Antel Internet', 'Luz', 'Itau paquete', 'Itaú paquete', 'Sandra Psicologa',
  'Antel móvil', 'Viandas', 'Ble', 'BlueCross', 'Gimnasio', 'Itaú Crédito', 'Oca'];
const CARDS = ['Débito UYU', 'Crédito OCA', 'Crédito Itaú UYU', 'Crédito Itaú USD', 'Débito USD', 'Efectivo UYU', 'Efectivo USD'];
const COTIZ_FALLBACK = 40.25;
const COTIZ_TTL_MS = 10 * 60 * 1000;
const CAT_SEP = ' + ';
const CAT_MAX = 20;
const CAT_AHORRO = 'Acciones/Bonos/Ahorros';
const CATEGORIES = CFG.categorias;
const CATS_SOCIALES = CFG.catsSociales;
const CAT_RULES = CFG.catRules.map((r) => [new RegExp(r.source, r.flags), r.cat]);
// Los fijos "reales" de un mes nuevo son los de la plantilla (FIXED_LABELS) más los que se hayan sumado
// a la tabla fija desde que existe la plantilla actual; los de meses viejos son basura de otros layouts.
const FIJOS_DESDE = '2026-05';
const MES_ORDEN_SIN_FILA = 999999999;

// ---- Helpers --------------------------------------------------------------------------------
const stripAccents = (s) => String(s || '').replace(/[áéíóúÁÉÍÓÚñÑ]/g, (c) => ({ 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'Á': 'a', 'É': 'e', 'Í': 'i', 'Ó': 'o', 'Ú': 'u', 'ñ': 'n', 'Ñ': 'n' })[c]).toLowerCase().trim();
const toNumber = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const r2 = (n) => Math.round(n * 100) / 100;
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const esTarjetaCredito = (h) => /cr[eé]dito|\boca\b/i.test(String(h || ''));
const esAhorro = (c) => /ahorro|acciones|bonos/i.test(String(c || ''));
const monedaDeTarjeta = (h) => /usd|d[oó]lar/i.test(String(h || '')) ? 'USD' : 'UYU';
const mesActual = () => hoy().slice(0, 7);

const tabDeMes = (mes) => `${MONTH_NAMES[parseInt(mes.slice(5, 7), 10) - 1]} ${mes.slice(0, 4)}`;
// "Mayo 2026" -> '2026-05'; null si no es nombre de mes.
function mesDeTab(name) {
  const m = String(name || '').trim().match(/^(\S+) (\d{4})$/);
  if (!m) return null;
  const idx = MONTH_NAMES.indexOf(m[1]);
  return idx < 0 ? null : `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' real (sin pasar por Date de UTC); sin fecha = hoy en Montevideo.
function normFecha(date) {
  if (date == null || date === '') return hoy();
  const s = String(date).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('Fecha inválida: ' + date);
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error('Fecha inválida: ' + date);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(d);
}

// ---- Categorías (clasificador de Code.gs con las reglas de form-config.json) ------------------
function splitCategorias(str) {
  const out = [];
  String(str || '').split('+').forEach((p) => { const c = p.trim(); if (c && out.indexOf(c) < 0) out.push(c); });
  return out;
}
function joinCategorias(arr) {
  const out = [];
  (arr || []).forEach((c) => { const s = String(c || '').trim(); if (s && out.indexOf(s) < 0) out.push(s); });
  return out.slice(0, CAT_MAX).join(CAT_SEP);
}
function classifyItems(item) {
  if (!item) return ['Otros'];
  const s = String(item).trim();
  const hits = [];
  for (const [re, cat] of CAT_RULES) if (re.test(s) && hits.indexOf(cat) < 0) hits.push(cat);
  if (!hits.length) return ['Otros'];
  if (hits[0] === CAT_AHORRO) return [CAT_AHORRO];
  const sociales = hits.filter((c) => CATS_SOCIALES.indexOf(c) >= 0);
  if (!sociales.length) return [hits[0]];
  const otra = hits.find((c) => CATS_SOCIALES.indexOf(c) < 0 && c !== CAT_AHORRO);
  return sociales.concat(otra ? [otra] : []).slice(0, 2);
}
function resolverCategorias(item, category, category2, categories) {
  const valida = (c) => CATEGORIES.indexOf(c) >= 0;
  if (categories) {
    const lista = splitCategorias(categories).filter(valida);
    if (lista.length) return joinCategorias(lista);
  }
  const auto = classifyItems(item);
  let lista;
  if (auto[0] !== 'Otros') lista = auto.slice();
  else if (category && category !== 'Transporte') lista = splitCategorias(category);
  else lista = ['Otros'];
  const extra = String(category2 || '').trim();
  if (extra && valida(extra) && lista.indexOf(extra) < 0) lista.push(extra);
  return joinCategorias(lista);
}

// ---- Cotización USD/UYU ------------------------------------------------------------------------
const cotizValida = (v) => Number.isFinite(v) && v > 20 && v < 100;
async function traerJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// Fuentes HTTP en orden; la primera con un valor razonable gana.
const FUENTES_COTIZ = [
  ['open.er-api.com', async () => (await traerJson('https://open.er-api.com/v6/latest/USD')).rates.UYU],
  ['currency-api', async () => (await traerJson('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json')).usd.uyu],
  ['currency-api (pages)', async () => (await traerJson('https://latest.currency-api.pages.dev/v1/currencies/usd.json')).usd.uyu]
];
async function traerCotizacion() {
  for (const [nombre, f] of FUENTES_COTIZ) {
    try { const v = Number(await f()); if (cotizValida(v)) return { rate: r6(v), source: nombre }; } catch { /* siguiente fuente */ }
  }
  return null;
}
// Orden: cache fresca (10 min) > fuente HTTP > cache vieja > fallback fijo.
export async function cotizacionAuto(env, T) {
  const fila = await env.DB.prepare(`SELECT valor FROM settings WHERE tenant_id = ? AND clave = 'cotiz_usd_cache'`).bind(T).first();
  let cache = null;
  try { cache = fila && JSON.parse(fila.valor); } catch { cache = null; }
  if (cache && cotizValida(cache.rate) && Date.now() - cache.at < COTIZ_TTL_MS) return { rate: cache.rate, source: cache.source + ' (cache)' };
  const nueva = await traerCotizacion();
  if (nueva) {
    try {
      await env.DB.prepare(`INSERT INTO settings (tenant_id, clave, valor) VALUES (?, 'cotiz_usd_cache', ?) ON CONFLICT (tenant_id, clave) DO UPDATE SET valor = excluded.valor`)
        .bind(T, JSON.stringify({ rate: nueva.rate, at: Date.now(), source: nueva.source })).run();
    } catch { /* la cache es opcional */ }
    return nueva;
  }
  if (cache && cotizValida(cache.rate)) return { rate: cache.rate, source: cache.source + ' (cache vieja)' };
  return { rate: COTIZ_FALLBACK, source: 'fallback' };
}

// ---- Totales (misma regla que _calcMonthTotals) --------------------------------------------------
// `rows` en orden de hoja: la cotización "última vista" depende del orden de la tabla variable.
function calcTotales(rows) {
  let fixedUyu = 0, fixedUsd = 0, varUyu = 0, varUsd = 0, mixedUyu = 0, lastCotiz = null;
  const rc = (v) => { const c = toNumber(v); return c && c > 20 ? c : null; };
  const fijas = [], vars = [];
  for (const r of rows) {
    if (r.es_fijo) {
      const u = r.uyu_raw || 0, d = r.usd_raw || 0;
      if ((!u && !d) || r.es_ahorro) continue;
      fijas.push({ uyu: u, usd: d, cotiz: rc(r.cotizacion) });
    } else {
      const c = rc(r.cotizacion);
      if (c) lastCotiz = c;
      if (!r.monto || r.es_credito || r.es_ahorro) continue; // tarjeta de crédito y ahorro no entran al total
      const usd = r.moneda === 'USD';
      vars.push({ uyu: usd ? 0 : r.monto, usd: usd ? r.monto : 0, cotiz: c });
    }
  }
  const fallback = lastCotiz || COTIZ_FALLBACK;
  fijas.forEach((r) => { fixedUyu += r.uyu; fixedUsd += r.usd; mixedUyu += r.uyu + r.usd * (r.cotiz || fallback); });
  vars.forEach((r) => { varUyu += r.uyu; varUsd += r.usd; mixedUyu += r.uyu + r.usd * (r.cotiz || fallback); });
  return {
    uyu: fixedUyu + varUyu, usd: fixedUsd + varUsd,
    mixedUyu: Math.round(mixedUyu), mixedUsd: Math.round(mixedUyu / fallback * 100) / 100,
    fixedUyu, fixedUsd, varUyu, varUsd, lastCotiz
  };
}

const ORDEN_HOJA = `es_fijo DESC, COALESCE(src_row, ${MES_ORDEN_SIN_FILA}), id`;

async function filasDelMes(env, T, mes) {
  const r = await env.DB.prepare(`SELECT * FROM expenses WHERE tenant_id = ? AND mes = ? ORDER BY ${ORDEN_HOJA}`).bind(T, mes).all();
  return r.results;
}

// Recalcula month_totals de un mes desde expenses (y lo crea si no existía).
async function recalcularMes(env, T, mes) {
  const t = calcTotales(await filasDelMes(env, T, mes));
  await env.DB.prepare(`INSERT INTO month_totals (tenant_id, mes, tab, uyu, usd, mixed_uyu, mixed_usd) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (tenant_id, mes) DO UPDATE SET tab = excluded.tab, uyu = excluded.uyu, usd = excluded.usd, mixed_uyu = excluded.mixed_uyu, mixed_usd = excluded.mixed_usd`)
    .bind(T, mes, tabDeMes(mes), r6(t.uyu), r6(t.usd), t.mixedUyu, t.mixedUsd).run();
  return t;
}

// ---- Lectura: fila de D1 -> objeto del dashboard ---------------------------------------------------
const fechaIso = (f) => (/^\d{4}-\d{2}-\d{2}$/.test(f || '') ? f : '');
function aGasto(r) {
  if (r.es_fijo) {
    const uyu = r.uyu_raw || 0, usd = r.usd_raw || 0;
    return {
      row: r.id, item: r.concepto, amount: usd ? usd : uyu, currency: usd ? 'USD' : 'UYU', card: '', category: r.categoria || '',
      fecha: fechaIso(r.fecha), cotizacion: r.cotizacion == null ? null : r.cotizacion, notas: '', fixed: true, uyuRaw: uyu, usdRaw: usd, ahorro: !!r.es_ahorro
    };
  }
  const g = {
    row: r.id, item: r.concepto, amount: r.monto, currency: r.moneda, card: r.medio_pago || '', credito: !!r.es_credito, ahorro: !!r.es_ahorro,
    category: r.categoria || '', fecha: fechaIso(r.fecha), cotizacion: r.cotizacion == null ? null : r.cotizacion, notas: r.notas || ''
  };
  if (r.grupo) { g.grupo = r.grupo; g.grupoNombre = r.grupo_nombre || ''; }
  return g;
}
// Fecha descendente; a igual fecha, el cargado más tarde (id mayor) arriba. Sin fecha al fondo.
function ordenarPorFechaDesc(filas) {
  return filas.slice().sort((a, b) => {
    const fa = a.fecha || '', fb = b.fecha || '';
    if (fa !== fb) return fb.localeCompare(fa);
    return (b.row || 0) - (a.row || 0);
  });
}

// El mes en curso existe aunque no tenga datos (en el Sheet el trigger diario crea la hoja).
async function asegurarMesActual(env, T) {
  const mes = mesActual();
  await env.DB.prepare(`INSERT OR IGNORE INTO month_totals (tenant_id, mes, tab, uyu, usd, mixed_uyu, mixed_usd) VALUES (?, ?, ?, 0, 0, 0, 0)`).bind(T, mes, tabDeMes(mes)).run();
}
async function gastosEsD1(env, T) {
  const f = await env.DB.prepare(`SELECT valor FROM settings WHERE tenant_id = ? AND clave = 'fuente_gastos'`).bind(T).first();
  return f ? f.valor === 'd1' : fuenteDefecto(T) === 'd1';
}

// ---- Lectores ------------------------------------------------------------------------------------
async function getDashboardData(env, T, [month]) {
  const actual = mesActual();
  const mes = (month && mesDeTab(month)) ? mesDeTab(month) : actual;
  const tabName = tabDeMes(mes);
  const [filasR, mtR] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM expenses WHERE tenant_id = ? AND mes = ? ORDER BY ${ORDEN_HOJA}`).bind(T, mes),
    env.DB.prepare(`SELECT mes FROM month_totals WHERE tenant_id = ? AND mes = ?`).bind(T, mes)
  ]);
  const filas = filasR.results;
  if (mes !== actual && !mtR.results.length && !filas.length) return { ok: false, error: 'Tab "' + tabName + '" no existe' };
  const mt = calcTotales(filas);

  const fixedRows = filas.filter((r) => r.es_fijo && (r.uyu_raw || r.usd_raw)).map(aGasto);
  const varRows = filas.filter((r) => !r.es_fijo && r.monto).map(aGasto);

  const catSums = {};
  for (const v of fixedRows.concat(varRows)) {
    if (v.credito || esAhorro(v.category)) continue;
    const cats = splitCategorias(v.category);
    for (const key of (cats.length ? cats : ['Otros'])) {
      if (!catSums[key]) catSums[key] = { name: key, uyu: 0, usd: 0 };
      if (v.fixed) { catSums[key].uyu += v.uyuRaw; catSums[key].usd += v.usdRaw; }
      else if (v.currency === 'USD') catSums[key].usd += v.amount;
      else catSums[key].uyu += v.amount;
    }
  }
  const catFallback = mt.mixedUsd && mt.mixedUyu ? mt.mixedUyu / mt.mixedUsd : COTIZ_FALLBACK;
  const byCategory = Object.values(catSums)
    .map((c) => ({ name: c.name, uyu: r2(c.uyu), usd: r2(c.usd) }))
    .sort((a, b) => (b.uyu + b.usd * catFallback) - (a.uyu + a.usd * catFallback));

  const cardSums = {};
  for (const v of varRows) {
    const key = v.card + '|' + v.currency;
    if (!cardSums[key]) cardSums[key] = { name: v.card, currency: v.currency, amount: 0 };
    cardSums[key].amount += v.amount;
  }
  const byCard = Object.values(cardSums).sort((a, b) => b.amount - a.amount);

  return {
    ok: true, tab: tabName, cotizacion: mt.lastCotiz, variableCount: varRows.length,
    totals: { uyu: r2(mt.uyu), usd: r2(mt.usd), uyuInUyu: mt.mixedUyu, uyuInUsd: mt.mixedUsd, fixedUyu: r2(mt.fixedUyu), fixedUsd: r2(mt.fixedUsd), varUyu: r2(mt.varUyu), varUsd: r2(mt.varUsd) },
    byCategory, byCard, expenses: ordenarPorFechaDesc(fixedRows.concat(varRows))
  };
}

// Meses disponibles + total en UYU de los últimos 12 (del más viejo al más nuevo).
async function getMonthlyTotals(env, T) {
  const actual = mesActual();
  const r = await env.DB.prepare(`SELECT mes, tab, mixed_uyu FROM month_totals WHERE tenant_id = ? ORDER BY mes`).bind(T).all();
  const lista = r.results.slice();
  if (!lista.some((m) => m.mes === actual)) {
    if (await gastosEsD1(env, T)) await asegurarMesActual(env, T);
    lista.push({ mes: actual, tab: tabDeMes(actual), mixed_uyu: 0 });
    lista.sort((a, b) => (a.mes < b.mes ? -1 : 1));
  }
  const recent = lista.length - 12;
  const months = lista.map((m, idx) => {
    const out = { tab: m.tab || tabDeMes(m.mes), year: parseInt(m.mes.slice(0, 4), 10), month: parseInt(m.mes.slice(5, 7), 10) - 1, total: null };
    if (idx < recent) return out; // fuera del gráfico: solo el nombre para el selector
    const t = Number(m.mixed_uyu);
    out.total = Number.isFinite(t) ? t : 0;
    return out;
  });
  return { ok: true, months, current: tabDeMes(actual) };
}

// ---- Escritura: alta ---------------------------------------------------------------------------------
// ctx: cache por invocación (cotización, etiquetas de fijos, tarjetas por mes) para que un lote no repita lecturas.
const nuevoCtx = () => ({ rate: null, fijas: null, tarjetas: {} });

async function resolverCotizacion(env, T, ctx, cotInput) {
  const manual = toNumber(cotInput);
  if (manual !== null) return { cotizacion: manual, cotizSource: 'manual' };
  if (!ctx.rate) ctx.rate = await cotizacionAuto(env, T);
  return { cotizacion: ctx.rate.rate, cotizSource: ctx.rate.source };
}

async function etiquetasFijas(env, T, ctx) {
  if (!ctx.fijas) {
    const r = await env.DB.prepare(`SELECT DISTINCT concepto FROM expenses WHERE tenant_id = ? AND es_fijo = 1 AND mes >= ?`).bind(T, FIJOS_DESDE).all();
    const vistos = new Set(FIXED_LABELS);
    ctx.fijas = FIXED_LABELS.concat(r.results.map((x) => x.concepto).filter((c) => c && !vistos.has(c) && vistos.add(c)));
  }
  return ctx.fijas;
}

// findFixedRow: exacto (sin acentos) gana; si no, el texto tipeado es prefijo (>= 4) de una etiqueta de la plantilla.
function buscarFijo(etiquetas, item, existentes) {
  const target = stripAccents(item);
  if (!target) return null;
  const candidatas = existentes.map((e) => e.concepto).concat(etiquetas);
  for (const l of candidatas) if (stripAccents(l) === target) return l;
  if (target.length >= 4) {
    for (const l of candidatas) {
      const n = stripAccents(l);
      if (n.indexOf(target) === 0 && FIXED_LABELS.some((f) => stripAccents(f) === n)) return l;
    }
  }
  return null;
}

async function tarjetaCanonica(env, T, ctx, mes, card) {
  const t = stripAccents(card);
  const c = CARDS.find((x) => stripAccents(x) === t);
  if (c) return c;
  if (!ctx.tarjetas[mes]) {
    const r = await env.DB.prepare(`SELECT DISTINCT medio_pago FROM expenses WHERE tenant_id = ? AND mes = ? AND es_fijo = 0 AND medio_pago IS NOT NULL`).bind(T, mes).all();
    ctx.tarjetas[mes] = r.results.map((x) => x.medio_pago);
  }
  const e = ctx.tarjetas[mes].find((x) => stripAccents(x) === t);
  if (e) return e;
  throw new Error('Medio de pago "' + card + '" no encontrado');
}

const COLS_ALTA = ['tenant_id', 'mes', 'tab', 'src_row', 'concepto', 'monto', 'moneda', 'uyu_raw', 'usd_raw', 'medio_pago', 'es_fijo', 'es_credito', 'es_ahorro',
  'categoria', 'cat1', 'cat2', 'fecha', 'cotizacion', 'notas', 'grupo', 'grupo_nombre', 'fecha_efectiva', 'fecha_origen'];

// Valida y prepara un alta. Devuelve {mes, fijo, stmt?, resultado} sin escribir las filas variables
// (así el lote las manda juntas); los fijos hacen su upsert en el momento (leen el estado del mes).
async function planAlta(env, T, ctx, data, grupo) {
  const d = data || {};
  const item = d.item == null ? '' : String(d.item).trim();
  const amt = toNumber(d.amount);
  if (!item || amt === null || amt <= 0 || !d.currency || !d.card) throw new Error('Faltan campos requeridos o monto inválido: item, amount>0, currency, card');
  const { cotizacion, cotizSource } = await resolverCotizacion(env, T, ctx, d.cotizacion);
  const fecha = normFecha(d.date);
  const mes = fecha.slice(0, 7), tab = tabDeMes(mes);
  const currency = String(d.currency);

  // --- Gasto fijo: pisa el monto del mes (UYU o USD según la moneda) de la fila de la tabla de fijos.
  const etiquetas = await etiquetasFijas(env, T, ctx);
  const existentes = (await env.DB.prepare(`SELECT * FROM expenses WHERE tenant_id = ? AND mes = ? AND es_fijo = 1`).bind(T, mes).all()).results;
  const label = buscarFijo(etiquetas, item, existentes);
  if (label) {
    const usdMoneda = currency.toUpperCase() === 'USD';
    const ex = existentes.find((e) => stripAccents(e.concepto) === stripAccents(label)) || null;
    const prev = ex ? (usdMoneda ? ex.usd_raw : ex.uyu_raw) : 0;
    const uyu = usdMoneda ? (ex ? ex.uyu_raw || 0 : 0) : amt;
    const usd = usdMoneda ? amt : (ex ? ex.usd_raw || 0 : 0);
    const cat = joinCategorias(classifyItems(label));
    const cats = splitCategorias(cat);
    const cotizFila = usdMoneda ? cotizacion : (ex ? ex.cotizacion : null);
    const monto = usd ? usd : uyu, moneda = usd ? 'USD' : 'UYU';
    let id;
    if (ex) {
      await env.DB.prepare(`UPDATE expenses SET monto = ?, moneda = ?, uyu_raw = ?, usd_raw = ?, categoria = ?, cat1 = ?, cat2 = ?, es_ahorro = ?, fecha = ?, fecha_efectiva = ?, fecha_origen = 'manual', cotizacion = ?
                            WHERE tenant_id = ? AND id = ?`)
        .bind(monto, moneda, uyu, usd, cat, cats[0] || null, cats[1] || null, esAhorro(cat) ? 1 : 0, fecha, fecha, cotizFila == null ? null : cotizFila, T, ex.id).run();
      id = ex.id;
    } else {
      const r = await env.DB.prepare(`INSERT INTO expenses (${COLS_ALTA.join(', ')}) VALUES (${COLS_ALTA.map(() => '?').join(', ')})`)
        .bind(T, mes, tab, null, label, monto, moneda, uyu, usd, null, 1, 0, esAhorro(cat) ? 1 : 0, cat, cats[0] || null, cats[1] || null, fecha, cotizFila == null ? null : cotizFila, null, null, null, fecha, 'manual').run();
      id = r.meta.last_row_id;
    }
    return {
      mes, fijo: true, hecho: true,
      resultado: { tab, row: id, fixed: true, cotizSource, written: { item: label, amount: amt, currency: currency.toUpperCase(), prevAmount: prev > 0 ? prev : 0, cotizacion, category: cat, fecha } }
    };
  }

  // --- Gasto variable: el medio de pago decide la moneda y si es tarjeta de crédito.
  const card = await tarjetaCanonica(env, T, ctx, mes, String(d.card).trim());
  const categoria = resolverCategorias(item, d.category, d.category2, d.categories);
  const cats = splitCategorias(categoria);
  const notes = d.notes ? String(d.notes).trim() : '';
  const stmt = env.DB.prepare(`INSERT INTO expenses (${COLS_ALTA.join(', ')}) VALUES (${COLS_ALTA.map(() => '?').join(', ')})`)
    .bind(T, mes, tab, null, item, amt, monedaDeTarjeta(card), null, null, card, 0, esTarjetaCredito(card) ? 1 : 0, esAhorro(categoria) ? 1 : 0,
      categoria, cats[0] || null, cats[1] || null, fecha, cotizacion, notes || null, grupo ? grupo.id : null, grupo ? grupo.nombre : null, fecha, 'manual');
  return {
    mes, fijo: false, hecho: false, stmt,
    resultado: { tab, cotizSource, written: { item, amount: amt, currency, card, category: categoria, cotizacion: cotizacion || null, notes: notes || null } }
  };
}

async function addExpense(env, T, data) {
  const ctx = nuevoCtx();
  const plan = await planAlta(env, T, ctx, data, null);
  if (!plan.hecho) {
    const [r] = await env.DB.batch([plan.stmt]);
    plan.resultado = { tab: plan.resultado.tab, row: r.meta.last_row_id, cotizSource: plan.resultado.cotizSource, written: plan.resultado.written };
  }
  await recalcularMes(env, T, plan.mes);
  return plan.resultado;
}

// Varios gastos de una vez (guardar un ticket escaneado). `group` = nombre del comercio: los
// ítems quedan agrupados como un mismo ticket (expenses.grupo / grupo_nombre).
async function addBatch(env, T, [items, group]) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'No items' };
  const ctx = nuevoCtx();
  const nombre = String(group || '').replace(/\s+/g, ' ').trim();
  const grupo = nombre ? { id: crypto.randomUUID().slice(0, 8), nombre } : null;
  const errors = [];
  const stmts = [];
  const meses = new Set();
  let saved = 0, failed = 0, lastTab = '';
  for (const it of items) {
    try {
      const plan = await planAlta(env, T, ctx, it, grupo);
      if (plan.fijo) { meses.add(plan.mes); } // los fijos no se agrupan (no son del ticket)
      else { stmts.push(plan.stmt); meses.add(plan.mes); }
      lastTab = plan.resultado.tab || lastTab;
      saved++;
    } catch (e) {
      failed++;
      errors.push(((it && it.item) || '?') + ': ' + (e && e.message || e));
    }
  }
  // Todos los variables en una sola tanda (D1 limita las consultas por invocación).
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  for (const mes of meses) await recalcularMes(env, T, mes);
  return { ok: true, saved, failed, tab: lastTab, errors };
}

// ---- Escritura: edición, borrado y categoría ---------------------------------------------------------------
async function filaVariable(env, T, id, esperado, month) {
  const r = await env.DB.prepare(`SELECT * FROM expenses WHERE tenant_id = ? AND id = ?`).bind(T, id).first();
  if (!r) throw new Error('Esa fila ya no existe — recargá e intentá de nuevo');
  if (month && mesDeTab(month) && mesDeTab(month) !== r.mes) throw new Error('Ese gasto ya no está en "' + String(month).trim() + '" — recargá e intentá de nuevo');
  if (r.es_fijo) throw new Error('Esa fila no es de la tabla variable');
  if (stripAccents(r.concepto) !== stripAccents(esperado)) throw new Error('La fila ' + id + ' dice "' + r.concepto + '", no "' + esperado + '" — recargá e intentá de nuevo');
  return r;
}

async function deleteExpense(env, T, [data]) {
  const p = data || {};
  const id = idDe(p);
  const esperado = String(p.item || '').trim();
  if (!esperado) throw new Error('Falta el ítem esperado (seguridad)');
  const r = await filaVariable(env, T, id, esperado, p.month);
  await env.DB.prepare(`DELETE FROM expenses WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
  await recalcularMes(env, T, r.mes);
  return { ok: true, tab: tabDeMes(r.mes), row: id, deleted: r.concepto };
}

async function updateExpense(env, T, [data]) {
  const p = data || {};
  const id = idDe(p);
  const expectedItem = String(p.expectedItem || '').trim();
  if (!expectedItem) throw new Error('Falta el ítem esperado (seguridad)');
  const item = String(p.item || '').trim();
  const amt = toNumber(p.amount);
  if (!item || amt === null || amt <= 0) throw new Error('Faltan campos requeridos o monto inválido');
  const card0 = String(p.card || '').trim();
  if (!card0) throw new Error('Falta el medio de pago');
  const r = await filaVariable(env, T, id, expectedItem, p.month);
  const ctx = nuevoCtx();
  const card = await tarjetaCanonica(env, T, ctx, r.mes, card0);
  const cotiz = toNumber(p.cotizacion);
  const categoria = joinCategorias(splitCategorias(p.category));
  const cats = splitCategorias(categoria);
  const notes = String(p.notes || '').trim();
  // Fecha nueva: si cambia de mes el gasto se mueve a ese mes (las fechas son reales).
  let fecha = r.fecha, fechaEf = r.fecha_efectiva, origen = r.fecha_origen, mes = r.mes;
  if (p.date) {
    fecha = fechaEf = normFecha(p.date);
    origen = 'manual';
    mes = fecha.slice(0, 7);
  }
  await env.DB.prepare(`UPDATE expenses SET mes = ?, tab = ?, concepto = ?, monto = ?, moneda = ?, medio_pago = ?, es_credito = ?, es_ahorro = ?,
                          categoria = ?, cat1 = ?, cat2 = ?, fecha = ?, fecha_efectiva = ?, fecha_origen = ?, cotizacion = ?, notas = ?
                        WHERE tenant_id = ? AND id = ?`)
    .bind(mes, tabDeMes(mes), item, amt, monedaDeTarjeta(card), card, esTarjetaCredito(card) ? 1 : 0, esAhorro(categoria) ? 1 : 0,
      categoria, cats[0] || null, cats[1] || null, fecha, fechaEf, origen, cotiz, notes || null, T, id).run();
  await recalcularMes(env, T, mes);
  if (mes !== r.mes) await recalcularMes(env, T, r.mes);
  return { ok: true, tab: tabDeMes(mes), row: id, written: { item, amount: amt, card, category: categoria, cotizacion: cotiz, notes: p.notes || '', date: p.date || '' } };
}

// setExpenseCategory(month, row, item, category): solo toca la categoría (una o varias separadas por " + ").
async function setExpenseCategory(env, T, [month, rowRaw, item, category]) {
  const row = parseInt(rowRaw, 10);
  const partes = splitCategorias(category);
  if (!Number.isFinite(row) || !item || !partes.length) return { ok: false, error: 'Faltan month/row/item/category' };
  if (partes.length > CAT_MAX) return { ok: false, error: 'Máximo ' + CAT_MAX + ' categorías' };
  const mala = partes.find((c) => !CATEGORIES.includes(c));
  if (mala) return { ok: false, error: 'Categoría inválida: ' + mala };
  const cat = joinCategorias(partes);
  const r = await env.DB.prepare(`SELECT * FROM expenses WHERE tenant_id = ? AND id = ?`).bind(T, row).first();
  if (!r || (month && mesDeTab(month) && mesDeTab(month) !== r.mes)) return { ok: false, error: 'No existe la hoja' };
  if (r.es_fijo) return { ok: false, error: 'Esa fila no es de la tabla variable' };
  if (stripAccents(r.concepto) !== stripAccents(item)) return { ok: false, error: 'La fila ' + row + ' dice "' + r.concepto + '"' };
  await env.DB.prepare(`UPDATE expenses SET categoria = ?, cat1 = ?, cat2 = ?, es_ahorro = ? WHERE tenant_id = ? AND id = ?`)
    .bind(cat, partes[0] || null, partes[1] || null, esAhorro(cat) ? 1 : 0, T, row).run();
  await recalcularMes(env, T, r.mes);
  return { ok: true, tab: tabDeMes(r.mes), row, item: r.concepto, antes: r.categoria || '', ahora: cat };
}

// ---- OCR de tickets (Gemini) --------------------------------------------------------------------------------
// Secreto requerido: GEMINI_API_KEY (wrangler secret put GEMINI_API_KEY). Sin él devuelve ok:false.
async function scanTicket(env, T, [base64Image]) {
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: 'Falta GEMINI_API_KEY' };
  if (!base64Image) return { ok: false, error: 'No se recibió imagen' };
  const prompt = 'Analizá esta foto de un ticket de comercio en Uruguay. Por cada línea de producto/servicio comprado extraé: ' +
    'name (nombre item, máximo 40 chars, sin código de barras), ' +
    'amount (precio FINAL en UYU después de aplicar descuentos visibles por item, número positivo), ' +
    'category (UNA de estas exactas: Transporte, Comida, Bebida/Bar, Salud, Suscripciones, Entretenimiento, Hogar, Limpieza, Ropa, Regalos, Gimnasio, Servicios, Viajes, Acciones/Bonos/Ahorros, Otros). ' +
    'REGLAS: ' +
    '1. IGNORÁ líneas de total, subtotal, IVA, cambio, redondeo, descuento general, propina. ' +
    '2. Si hay descuento aplicado a un item específico (ej "2x1", "20% off", "ahorro $X"), restalo del precio. ' +
    '3. Si una bebida está en restaurant/bar → Bebida/Bar. Si es en supermercado → Comida. ' +
    '4. Productos limpieza (jabón, lavandina, papel higiénico, esponja) → Limpieza. ' +
    '4b. Viajes es para gastos de viajar: pasajes, vuelos, hotel, hostel, Airbnb, excursiones, ' +
    'free shop, alquiler de auto, peajes de ruta. Un ómnibus o taxi urbano del día a día es Transporte, no Viajes. ' +
    '5. Si no podés leer una línea, omitila — NO inventes. ' +
    '6. store = nombre del comercio como figura en el ticket (ej "Tienda Inglesa", "Devoto"), "" si no se lee. ' +
    '7. supermarket = true SOLO si es un supermercado/autoservicio/almacén con muchos productos de compra (Tienda Inglesa, Disco, Devoto, Géant, Ta-Ta, Macro Mercado, Frigorífico, etc.); false para restaurantes, bares, farmacias, ropa, transporte y el resto. ' +
    'Devolvé SOLO JSON válido con shape {"store":string,"supermarket":boolean,"items":[{"name":string,"amount":number,"category":string},...]}.';
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: String(base64Image) } }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'object',
        properties: {
          store: { type: 'string' }, supermarket: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' }, category: { type: 'string' } }, required: ['name', 'amount', 'category'] } }
        },
        required: ['items']
      },
      temperature: 0.1
    }
  };
  const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(50000)
  });
  const texto = await resp.text();
  if (resp.status !== 200) return { ok: false, error: 'Gemini HTTP ' + resp.status + ': ' + texto.substring(0, 400) };
  const data = JSON.parse(texto);
  const out = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!out) return { ok: false, error: 'Respuesta Gemini vacía: ' + texto.substring(0, 400) };
  const parsed = JSON.parse(out);
  const items = (parsed.items || []).filter((it) => it && it.name && it.amount > 0);
  return { ok: true, items, store: String(parsed.store || '').trim(), supermarket: parsed.supermarket === true };
}

// Lectores que reusa src/informes.js (reporte mensual por mail / web).
export { tabDeMes, splitCategorias };

// Envuelve un handler con la forma "Safe" de Apps Script: los errores salen como { ok:false, error }.
// (llamar() en rpc.js ya lo hace, pero así addExpenseSafe devuelve { ok:true, ...resultado }.)
export const HANDLERS = {
  addExpenseSafe: { escribe: true, run: async (env, T, [d]) => ({ ok: true, ...(await addExpense(env, T, d)) }) },
  addBatch: { escribe: true, run: addBatch },
  updateExpenseSafe: { escribe: true, run: updateExpense },
  deleteExpenseSafe: { escribe: true, run: deleteExpense },
  setExpenseCategory: { escribe: true, run: setExpenseCategory },
  getDashboardData: { escribe: false, run: getDashboardData },
  getMonthlyTotals: { escribe: false, run: getMonthlyTotals },
  scanTicket: { escribe: false, run: scanTicket }
};
