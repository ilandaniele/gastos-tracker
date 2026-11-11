// Módulo habitos (Hábitos + Comidas + Agua + Ejercicio). Contrato: ver src/rpc.js y src/rpc/compras.js.
// Porta a D1 las funciones de Apps Script (Code.gs): getHabitDaySafe, getHabitsDataSafe, habitDaySafe,
// addMealSafe, updateMealSafe, deleteMealSafe, clearHabitDaySafe, addWaterSafe, updateWaterSafe,
// deleteWaterSafe y scanMealSafe (Gemini).
//
// Modelo en D1 (ver migrations/0002_modulos.sql):
//   habit_days: una fila por fecha (campos del día). `row` que devuelve la API = id de la fila.
//   habit_log:  una fila por comida / agua / ejercicio (kind). `row` = id de la fila.
// El Sheet guardaba una hoja por mes ("Hábitos Julio 2026"); acá el mes sale de la fecha ISO y el
// nombre de la "hoja" (campo `tab` de las respuestas) se reconstruye con tabDe().
import { hoy } from './util.js';

export const MODULO = 'habitos';

// ---- Constantes y helpers (espejo de Code.gs) -----------------------------------------------

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const PREFIJO = 'Hábitos ';
const GEMINI_MODELO = 'gemini-2.5-flash';

// campo lógico del formulario -> columna de habit_days
const COL = {
  levante: 'levante', acoste: 'acoste', hsSueno: 'hs_sueno', trabajo: 'trabajo', avance: 'avance', animo: 'animo',
  ejercicio: 'ejercicio', ejercicioMin: 'ejercicio_min', medite: 'medite', mediteMin: 'medite_min', lei: 'lei',
  abordajes: 'abordajes', agua: 'agua', mast: 'mast', notas: 'notas'
};

const MEAL_RULES = [
  { macro: 'Proteína', re: /carne|pollo|milanesa|milanga|huevo|pescado|atun|salmon|lomo|bife|asado|cerdo|jamon|queso|lenteja|garbanzo|poroto|yogur|proteina|whey|tofu|hamburguesa|churrasco|pechuga|nuez|almendra|mani/ },
  { macro: 'Carbo', re: /pan|arroz|pasta|fideo|tallarin|pure|papa|batata|tostada|cereal|avena|tortilla|pizza|empanada|noqui|nioqui|polenta|galleta|sandwich|wrap|medialuna|panqueque|budin|masa|harina|choclo/ },
  { macro: 'Verdura', re: /ensalada|verdura|tomate|lechuga|zanahoria|brocoli|espinaca|zapallo|pepino|morron|cebolla|acelga|repollo|remolacha|berenjena|zucchini|calabaza|rucula|palta/ },
  { macro: 'Fruta', re: /manzana|banana|naranja|frutilla|pera|uva|kiwi|mandarina|fruta|durazno|melon|sandia|anana|ciruela|higo|arandano|mango/ },
  { macro: 'Ultraprocesado', re: /alfajor|helado|chocolate|snack|papita|gaseosa|coca|sprite|fanta|factura|bizcocho|galletita|dulce|torta|caramelo|chip|donut|oreo|chizito|palito|golosina|cheetos|nachos|pancho|hot ?dog|frita/ },
  { macro: 'Bebida', re: /^cafe|^mate|^te$|^agua|jugo|cerveza|vino|fernet|whisky|licuado|smoothie|gatorade|powerade|infusion|capuchino|latte/ }
];

const stripAcc = (s) => String(s || '').replace(/[áéíóúÁÉÍÓÚñÑ]/g, (c) => ({ 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'Á': 'a', 'É': 'e', 'Í': 'i', 'Ó': 'o', 'Ú': 'u', 'ñ': 'n', 'Ñ': 'n' })[c]).toLowerCase().trim();
const toNum = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const vacio = (v) => v === undefined || v === null || v === '';
const r2 = (n) => Math.round(n * 100) / 100;

// Normaliza cualquier forma de sí/no a "Sí"/"No" (o '' si no se entiende)
function siNo(v) {
  const s = stripAcc(v == null ? '' : v);
  if (!s) return '';
  if (['si', 'yes', 'y', '1', 'true', 'ok', 'x'].includes(s)) return 'Sí';
  if (['no', 'n', '0', 'false'].includes(s)) return 'No';
  return '';
}

// 'HH:MM' -> minutos desde medianoche. null si inválido.
function parseHM(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^(\d{1,2})[:.h](\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const fmtHM = (mins) => (mins == null ? '' : String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'));

// Horas dormidas de UNA noche (los dos datos viven en el mismo día). Si acostarse > levantarse cruzó la medianoche.
function calcSleepHours(bed, wake) {
  const b = parseHM(bed), w = parseHM(wake);
  if (b == null || w == null) return null;
  let mins = w - b;
  if (mins < 0) mins += 24 * 60;
  if (mins === 0) return null;
  return Math.round((mins / 60) * 100) / 100;
}
function bedWasPrevDay(bed, wake) {
  const b = parseHM(bed), w = parseHM(wake);
  return b != null && w != null && b > w;
}

function mealTypeByHour(hora) {
  const m = parseHM(hora);
  if (m == null) return '';
  const h = m / 60;
  if (h < 5) return 'Snack nocturno';
  if (h < 11) return 'Desayuno';
  if (h < 12) return 'Media mañana';
  if (h < 15.5) return 'Almuerzo';
  if (h < 19.5) return 'Merienda';
  return 'Cena';
}

function waterLabel(ml) {
  const n = Number(ml) || 0;
  if (n <= 150) return 'Sorbo';
  if (n <= 220) return 'Taza';
  if (n <= 300) return 'Vaso';
  if (n <= 420) return 'Vaso grande';
  if (n <= 600) return 'Media botella';
  if (n <= 880) return 'Botella';
  if (n <= 1200) return 'Botella 1L';
  return 'Botella grande';
}

const ahoraHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

// Fecha ISO válida (acepta 'YYYY-MM-DD...' como parseLocalDate); sin valor = hoy.
function fechaDe(d) {
  if (vacio(d)) return hoy();
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3]) return m[0];
  }
  throw new Error('Fecha inválida');
}
const tabDe = (fecha) => PREFIJO + MESES[+fecha.slice(5, 7) - 1] + ' ' + fecha.slice(0, 4);

// 'Hábitos Julio 2026' | '2026-07' | null -> { tab, ym:'2026-07' } (null = mes actual)
function mesDe(monthOpt) {
  if (vacio(monthOpt)) { const h = hoy(); return { tab: tabDe(h), ym: h.slice(0, 7) }; }
  const s = String(monthOpt).trim();
  const iso = s.match(/^(\d{4})-(\d{2})$/);
  if (iso && +iso[2] >= 1 && +iso[2] <= 12) return { tab: tabDe(iso[0] + '-01'), ym: iso[0] };
  const parts = s.replace(PREFIJO.trim(), '').trim().split(/\s+/);
  const mi = parts.length >= 2 ? MESES.findIndex((m) => stripAcc(m) === stripAcc(parts[0])) : -1;
  const y = parseInt(parts[1], 10);
  if (mi < 0 || !Number.isFinite(y)) return { tab: s, ym: null };
  return { tab: s, ym: y + '-' + String(mi + 1).padStart(2, '0') };
}

// ---- Acceso a D1 -------------------------------------------------------------------------------

const getDiaRow = (env, T, fecha) =>
  env.DB.prepare(`SELECT * FROM habit_days WHERE tenant_id = ? AND fecha = ? ORDER BY id LIMIT 1`).bind(T, fecha).first();

// Equivale a "existe la hoja del mes" en el Sheet: hay algún dato de ese mes.
async function mesExiste(env, T, ym) {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM habit_days WHERE tenant_id = ?1 AND fecha BETWEEN ?2 AND ?3)
          + (SELECT COUNT(*) FROM habit_log WHERE tenant_id = ?1 AND fecha BETWEEN ?2 AND ?3) AS n`)
    .bind(T, ym + '-01', ym + '-31').first();
  return r.n > 0;
}

const diaVacio = () => ({
  levante: '', acoste: '', hsSueno: null, acosteDiaAnterior: false, trabajo: null, avance: null, animo: null,
  ejercicio: '', ejercicioMin: null, medite: '', mediteMin: null, lei: '', abordajes: null, agua: 0, mast: 0, notas: ''
});

function diaDeRow(r) {
  const levante = String(r.levante || '').trim(), acoste = String(r.acoste || '').trim();
  return {
    levante, acoste,
    hsSueno: toNum(r.hs_sueno),
    acosteDiaAnterior: bedWasPrevDay(acoste, levante),
    trabajo: toNum(r.trabajo), avance: toNum(r.avance), animo: toNum(r.animo),
    ejercicio: String(r.ejercicio || ''), ejercicioMin: toNum(r.ejercicio_min),
    medite: siNo(r.medite), mediteMin: toNum(r.medite_min), lei: siNo(r.lei),
    abordajes: toNum(r.abordajes), agua: toNum(r.agua) || 0, mast: toNum(r.mast) || 0,
    notas: String(r.notas || '')
  };
}

// Inserta la fila del día si no existe (para totales que se escriben después).
const asegurarDiaStmt = (env, T, fecha) =>
  env.DB.prepare(`INSERT INTO habit_days (tenant_id, fecha, tab) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM habit_days WHERE tenant_id = ? AND fecha = ?)`)
    .bind(T, fecha, tabDe(fecha), T, fecha);

// Total de agua del día = suma del log, escrito en habit_days.agua.
async function recalcAgua(env, T, fecha) {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(ml), 0) AS t, COUNT(*) AS n FROM habit_log WHERE tenant_id = ? AND fecha = ? AND kind = 'agua'`).bind(T, fecha).first();
  const total = r.t || 0;
  const st = [];
  if (r.n > 0) st.push(asegurarDiaStmt(env, T, fecha));
  st.push(env.DB.prepare(`UPDATE habit_days SET agua = ? WHERE tenant_id = ? AND fecha = ?`).bind(total, T, fecha));
  await env.DB.batch(st);
  return total;
}

// Resumen del ejercicio del día: tipos unidos por " + " (sin repetir) y suma de minutos.
async function recalcEjercicio(env, T, fecha) {
  const r = await env.DB.prepare(`SELECT detalle, tipo, min FROM habit_log WHERE tenant_id = ? AND fecha = ? AND kind = 'ejercicio' ORDER BY id`).bind(T, fecha).all();
  const tipos = [], vistos = {};
  let min = 0;
  for (const x of r.results) {
    min += toNum(x.min) || 0;
    const tipo = String(x.detalle || x.tipo || '').trim(), key = stripAcc(tipo);
    if (tipo && !vistos[key]) { vistos[key] = true; tipos.push(tipo); }
  }
  const texto = tipos.join(' + ');
  const st = [];
  if (r.results.length) st.push(asegurarDiaStmt(env, T, fecha));
  st.push(env.DB.prepare(`UPDATE habit_days SET ejercicio = ?, ejercicio_min = ? WHERE tenant_id = ? AND fecha = ?`).bind(texto, min > 0 ? min : null, T, fecha));
  await env.DB.batch(st);
  return { texto, min, count: r.results.length };
}

// Verifica que la fila del log sea del tipo esperado (y del día que dice el cliente): sin esto un id
// desactualizado editaría o borraría el registro de otro día en silencio.
async function assertLogRow(env, T, row, fecha, esperado) {
  const cur = await env.DB.prepare(`SELECT * FROM habit_log WHERE tenant_id = ? AND id = ?`).bind(T, row).first();
  if (!cur) throw new Error('Esa fila está vacía — recargá el día e intentá de nuevo');
  const reg = String(cur.kind || '').trim().toLowerCase() || 'comida';
  if (reg !== esperado) throw new Error('Esa fila es un registro de "' + reg + '" y esperaba "' + esperado + '" — recargá el día e intentá de nuevo');
  if (fecha && cur.fecha !== fecha) throw new Error('Esa fila es de otro día — recargá el día e intentá de nuevo');
  return cur;
}

const filaId = (v, msg) => { const n = parseInt(v, 10); if (!Number.isFinite(n) || n < 1) throw new Error(msg); return n; };

// ---- Clasificación de comidas (regex + Gemini de respaldo) ---------------------------------------

async function geminiJson(env, body, ms) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELO}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms)
  });
  if (!resp.ok) return { http: resp.status };
  const j = await resp.json();
  const c = j.candidates && j.candidates[0];
  const txt = c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text;
  return { txt: txt || '' };
}

async function classifyMealGemini(env, text) {
  if (!env.GEMINI_API_KEY || !text) return null;
  const prompt = 'Clasifica esta comida en JSON estricto sin markdown. ' +
    'Campos: macro (uno o varios de: Proteína, Carbo, Verdura, Fruta, Ultraprocesado, Bebida, separados por " + ") ' +
    'y procesado (Bajo, Medio o Alto). Comida: "' + text + '". ' +
    'Responde SOLO el JSON, ejemplo: {"macro":"Proteína + Carbo","procesado":"Medio"}';
  const r = await geminiJson(env, { contents: [{ parts: [{ text: prompt }] }] }, 8000);
  if (!r.txt) return null;
  const parsed = JSON.parse(r.txt.replace(/```json|```/g, '').trim());
  if (!parsed || !parsed.macro) return null;
  return { macro: String(parsed.macro), procesado: String(parsed.procesado || 'Medio') };
}

async function classifyMeal(env, text, hora) {
  const raw = String(text || '').trim();
  const t = stripAcc(raw);
  const macros = [];
  for (const rule of MEAL_RULES) if (rule.re.test(t)) macros.push(rule.macro);
  const tipo = mealTypeByHour(hora);
  if (macros.length) {
    const procesado = macros.includes('Ultraprocesado') ? 'Alto' : (macros.includes('Verdura') || macros.includes('Fruta')) ? 'Bajo' : 'Medio';
    return { macro: macros.join(' + '), tipo, procesado, source: 'regex' };
  }
  try { // nunca debe romper el guardado
    const g = await classifyMealGemini(env, raw);
    if (g) return { macro: g.macro, tipo, procesado: g.procesado, source: 'gemini' };
  } catch (e) { /* cae al default */ }
  return { macro: 'Otros', tipo, procesado: 'Medio', source: 'default' };
}

// ---- Día: leer ---------------------------------------------------------------------------------------

async function getHabitDay(env, T, dateOpt) {
  const fecha = fechaDe(dateOpt), tab = tabDe(fecha);
  if (!(await mesExiste(env, T, fecha.slice(0, 7)))) return { ok: true, exists: false, date: fecha, tab, meals: [], waters: [], ejercicios: [] };

  const row = await getDiaRow(env, T, fecha);
  const day = row ? diaDeRow(row) : diaVacio();
  const log = await env.DB.prepare(`SELECT id, hora, kind, detalle, tipo, macro, procesado, kcal, ml, min, ingredientes FROM habit_log WHERE tenant_id = ? AND fecha = ? ORDER BY id`).bind(T, fecha).all();
  const meals = [], waters = [], ejercicios = [];
  for (const r of log.results) {
    const reg = String(r.kind || '').trim().toLowerCase();
    const hora = String(r.hora || '').trim();
    if (reg === 'agua') waters.push({ row: r.id, hora, tipo: String(r.detalle || r.tipo || ''), ml: toNum(r.ml) || 0 });
    else if (reg === 'ejercicio') ejercicios.push({ row: r.id, hora, tipo: String(r.detalle || r.tipo || ''), min: toNum(r.min) || 0 });
    else meals.push({ row: r.id, hora, comida: String(r.detalle || ''), macro: String(r.macro || ''), tipo: String(r.tipo || ''), procesado: String(r.procesado || ''), kcal: toNum(r.kcal), ingredientes: String(r.ingredientes || '') });
  }
  // Días cargados antes de que el ejercicio fuera una lista: texto y minutos en el día, sin filas de log.
  if (!ejercicios.length && row && (day.ejercicio || (day.ejercicioMin || 0) > 0)) {
    ejercicios.push({ row: null, hora: '', tipo: day.ejercicio || 'Ejercicio', min: day.ejercicioMin || 0, legacy: true });
  }
  return { ok: true, exists: true, date: fecha, tab, day, meals, waters, ejercicios };
}

// ---- Día: guardar campos (upsertHabitDay) --------------------------------------------------------

async function upsertDia(env, T, p, fecha) {
  const tab = tabDe(fecha);
  if (p.month && p.month !== tab) throw new Error('La fecha ' + fecha + ' no pertenece a "' + p.month + '"');
  const row = await getDiaRow(env, T, fecha);
  const cur = row || {};
  const next = {};   // campo lógico -> valor nuevo (null = vaciar)
  const written = {};
  const val = (f) => (f in next ? next[f] : cur[COL[f]]);
  const readHM = (f) => String(val(f) || '').trim();

  if (p.levante) { next.levante = String(p.levante); written.levante = p.levante; }
  if (p.acoste) { next.acoste = String(p.acoste); written.acoste = p.acoste; }

  // Hs sueño: se recalcula cada vez que se toca cualquiera de los dos, con el valor nuevo o el que ya estaba.
  if (p.levante || p.acoste) {
    const lev = p.levante || (row ? String(cur.levante || '').trim() : '');
    const aco = p.acoste || (row ? String(cur.acoste || '').trim() : '');
    if (lev && aco) {
      const hs = calcSleepHours(aco, lev);
      if (hs != null) { next.hsSueno = hs; written.hsSueno = hs; written.acosteDiaAnterior = bedWasPrevDay(aco, lev); }
    }
  }

  for (const [field, raw] of [['trabajo', p.trabajo], ['avance', p.avance], ['animo', p.animo], ['ejercicioMin', p.ejercicioMin], ['mediteMin', p.mediteMin]]) {
    if (vacio(raw)) continue;
    const v = toNum(String(raw).replace(',', '.'));
    if (v == null) throw new Error('Valor inválido para ' + field);
    if (field === 'trabajo' && (v < 0 || v > 24)) throw new Error('Las horas de trabajo tienen que estar entre 0 y 24');
    if ((field === 'avance' || field === 'animo') && (v < 1 || v > 5)) throw new Error(field + ' tiene que estar entre 1 y 5');
    next[field] = v; written[field] = v;
  }

  if (p.ejercicio) { next.ejercicio = String(p.ejercicio); written.ejercicio = p.ejercicio; }

  // Sí/no: "No" es un dato tan válido como "Sí" (el día ya se contestó).
  for (const [field, raw] of [['medite', p.medite], ['lei', p.lei]]) {
    if (vacio(raw)) continue;
    const v = siNo(raw);
    if (v) { next[field] = v; written[field] = v; }
  }

  // Contadores con delta (agua, mast, abordajes)
  for (const [field, delta, absolute] of [['agua', p.aguaDelta, p.agua], ['mast', p.mastDelta, p.mast], ['abordajes', p.abordajesDelta, p.abordajes]]) {
    if (!vacio(delta)) {
      const prev = toNum(val(field)) || 0;
      let n = prev + (toNum(delta) || 0);
      if (n < 0) n = 0;
      next[field] = n; written[field] = n;
    } else if (!vacio(absolute)) {
      const v = toNum(absolute);
      if (v != null) { next[field] = v; written[field] = v; }
    }
  }

  if (p.notas) { next.notas = String(p.notas); written.notas = p.notas; }

  // Vaciar campos explícitamente (el merge normal ignora los vacíos para no pisar lo cargado)
  if (p.clear) {
    const vaciados = [];
    for (const f of String(p.clear).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!COL[f]) continue;
      next[f] = null;
      vaciados.push(f);
      if (f === 'levante') { next.hsSueno = null; vaciados.push('hsSueno'); }
    }
    if (vaciados.length) written.cleared = vaciados;
  }

  const campos = Object.keys(next);
  let id = row ? row.id : null;
  if (campos.length) {
    if (row) {
      await env.DB.prepare(`UPDATE habit_days SET ${campos.map((f) => COL[f] + ' = ?').join(', ')} WHERE tenant_id = ? AND id = ?`)
        .bind(...campos.map((f) => next[f]), T, row.id).run();
    } else {
      const r = await env.DB.prepare(`INSERT INTO habit_days (tenant_id, fecha, tab, ${campos.map((f) => COL[f]).join(', ')}) VALUES (?, ?, ?, ${campos.map(() => '?').join(', ')})`)
        .bind(T, fecha, tab, ...campos.map((f) => next[f])).run();
      id = r.meta.last_row_id;
    }
  }
  return { ok: true, tab, row: id, date: fecha, written };
}

// ---- Agua y ejercicio: reemplazo de la foto completa del día --------------------------------------

async function replaceWater(env, T, p, fecha) {
  const tab = tabDe(fecha);
  if (p.month && p.month !== tab) throw new Error('La fecha ' + fecha + ' no pertenece a "' + p.month + '"');
  const raw = Array.isArray(p.waters) ? p.waters : [];
  if (raw.length > 100) throw new Error('Demasiadas tomas de agua para un solo día');
  const waters = raw.map((item, i) => {
    const src = item || {};
    const ml = toNum(String(src.ml != null ? src.ml : '').replace(',', '.'));
    if (ml == null || ml <= 0) throw new Error('Cantidad de agua inválida en la toma ' + (i + 1));
    const pt = parseHM(src.hora);
    return { ml, hora: pt == null ? ahoraHM() : fmtHM(pt), tipo: String(src.tipo || '').trim() || waterLabel(ml) };
  });
  const st = [env.DB.prepare(`DELETE FROM habit_log WHERE tenant_id = ? AND fecha = ? AND kind = 'agua'`).bind(T, fecha)];
  for (const w of waters) {
    st.push(env.DB.prepare(`INSERT INTO habit_log (tenant_id, fecha, hora, kind, detalle, tipo, ml) VALUES (?, ?, ?, 'agua', ?, ?, ?)`).bind(T, fecha, w.hora, w.tipo, w.tipo, w.ml));
  }
  await env.DB.batch(st);
  const total = await recalcAgua(env, T, fecha);
  return { ok: true, tab, date: fecha, total, waters };
}

function normEjercicio(src, idx) {
  const s = src || {};
  const donde = idx != null ? ' en la entrada ' + (idx + 1) : '';
  const tipo = String(s.tipo || s.ejercicio || s.detalle || '').trim();
  if (!tipo) throw new Error('Falta qué ejercicio hiciste' + donde);
  if (tipo.length > 120) throw new Error('El nombre del ejercicio es demasiado largo' + donde);
  let min = 0;
  const rawMin = s.min !== undefined ? s.min : s.minutos;
  if (!vacio(rawMin)) {
    const n = toNum(String(rawMin).replace(',', '.'));
    if (n == null || n < 0) throw new Error('Minutos de ejercicio inválidos' + donde);
    if (n > 1440) throw new Error('Un ejercicio no puede durar más de 24 horas' + donde);
    min = Math.round(n);
  }
  const pt = parseHM(s.hora);
  return { tipo, min, hora: pt == null ? ahoraHM() : fmtHM(pt) };
}

async function replaceEjercicios(env, T, p, fecha) {
  const tab = tabDe(fecha);
  if (p.month && p.month !== tab) throw new Error('La fecha ' + fecha + ' no pertenece a "' + p.month + '"');
  const raw = Array.isArray(p.ejercicios) ? p.ejercicios : [];
  if (raw.length > 30) throw new Error('Demasiados ejercicios para un solo día');
  const ejers = raw.map((item, i) => normEjercicio(item, i));
  const st = [env.DB.prepare(`DELETE FROM habit_log WHERE tenant_id = ? AND fecha = ? AND kind = 'ejercicio'`).bind(T, fecha)];
  for (const e of ejers) {
    st.push(env.DB.prepare(`INSERT INTO habit_log (tenant_id, fecha, hora, kind, detalle, tipo, min) VALUES (?, ?, ?, 'ejercicio', ?, ?, ?)`).bind(T, fecha, e.hora, e.tipo, e.tipo, e.min || null));
  }
  await env.DB.batch(st);
  const resumen = await recalcEjercicio(env, T, fecha);
  return { ok: true, tab, date: fecha, resumen, ejercicios: ejers };
}

// Confirma en una sola acción los campos del día y, si vinieron, las fotos completas de agua y ejercicio.
// Devuelve el día releído (ids de las filas pueden haber cambiado).
async function saveHabitDay(env, T, data) {
  const p = data || {};
  const fecha = fechaDe(p.date);
  p.date = fecha;
  const dayFields = ['levante', 'acoste', 'trabajo', 'avance', 'animo', 'ejercicio', 'ejercicioMin', 'medite', 'mediteMin', 'lei', 'notas', 'mast', 'abordajes'];
  const hasDayChanges = !!p.clear || dayFields.some((f) => p[f] !== undefined);
  let dayResult = { ok: true, tab: p.month || tabDe(fecha), date: fecha, written: {} };
  if (hasDayChanges) dayResult = await upsertDia(env, T, p, fecha);
  let waterResult = null;
  if (Array.isArray(p.waters)) waterResult = await replaceWater(env, T, p, fecha);
  // El ejercicio va DESPUÉS de la fila diaria: su resumen es la fuente de verdad y pisa cualquier 'ejercicio' suelto.
  let exResult = null;
  if (Array.isArray(p.ejercicios)) exResult = await replaceEjercicios(env, T, p, fecha);

  const fresh = await getHabitDay(env, T, fecha);
  if (!fresh || !fresh.ok) throw new Error((fresh && fresh.error) || 'No se pudo releer el día guardado');
  fresh.written = dayResult.written || {};
  if (waterResult) fresh.water = { total: waterResult.total, count: waterResult.waters.length };
  if (exResult) fresh.ejercicio = { min: exResult.resumen.min, count: exResult.ejercicios.length };
  return fresh;
}

// ---- Resumen del mes (getHabitsData) -------------------------------------------------------------

const avg = (arr) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null;
};
const sum = (arr) => arr.filter((x) => x != null).reduce((s, x) => s + x, 0);

async function getHabitsData(env, T, monthOpt) {
  const { tab, ym } = mesDe(monthOpt);
  if (!ym) return { ok: false, error: 'Hoja "' + tab + '" no existe todavía' };
  // En el Sheet la hoja del mes en curso siempre existe (se crea sola): acá el mes actual vale aunque esté vacío.
  if (ym !== hoy().slice(0, 7) && !(await mesExiste(env, T, ym))) return { ok: false, error: 'Hoja "' + tab + '" no existe todavía' };

  const desde = ym + '-01', hasta = ym + '-31';
  const dr = await env.DB.prepare(`SELECT * FROM habit_days WHERE tenant_id = ? AND fecha BETWEEN ? AND ? ORDER BY fecha, id`).bind(T, desde, hasta).all();
  const days = [];
  for (const r of dr.results) {
    const d = diaDeRow(r);
    const row = {
      date: r.fecha, dayNum: parseInt(r.fecha.slice(8, 10), 10),
      levante: d.levante, acoste: d.acoste, hsSueno: d.hsSueno, trabajo: d.trabajo, avance: d.avance, animo: d.animo,
      ejercicio: d.ejercicio, ejercicioMin: d.ejercicioMin, medite: d.medite, mediteMin: d.mediteMin, lei: d.lei,
      abordajes: d.abordajes, agua: toNum(r.agua), mast: toNum(r.mast), notas: d.notas
    };
    // agua y mast se comparan contra > 0: un 0 (al borrar la última toma) no marca el día como registrado.
    row.hasData = !!(row.levante || row.acoste || row.trabajo != null || row.avance != null || row.animo != null ||
      row.ejercicio || (row.ejercicioMin > 0) || row.medite || row.lei || (row.mediteMin > 0) ||
      (row.abordajes > 0) || (row.agua > 0) || (row.mast > 0));
    days.push(row);
  }
  const lr = await env.DB.prepare(`SELECT fecha, hora, detalle, macro, tipo, procesado, kcal FROM habit_log WHERE tenant_id = ? AND fecha BETWEEN ? AND ? AND kind NOT IN ('agua', 'ejercicio') ORDER BY id`).bind(T, desde, hasta).all();
  const meals = lr.results.filter((r) => String(r.detalle || '').trim())
    .map((r) => ({ date: r.fecha, hora: String(r.hora || '').trim(), comida: String(r.detalle || ''), macro: String(r.macro || ''), tipo: String(r.tipo || ''), procesado: String(r.procesado || ''), kcal: toNum(r.kcal) }));

  const filled = days.filter((d) => d.hasData);
  const sleep = filled.map((d) => d.hsSueno), work = filled.map((d) => d.trabajo), adv = filled.map((d) => d.avance);

  const goodSleep = filled.filter((d) => d.hsSueno != null && d.hsSueno >= 7 && d.avance != null);
  const badSleep = filled.filter((d) => d.hsSueno != null && d.hsSueno < 7 && d.avance != null);
  const upDates = {};
  for (const m of meals) if (m.procesado === 'Alto') upDates[m.date] = true;
  const withUp = filled.filter((d) => upDates[d.date] && d.avance != null);
  const withoutUp = filled.filter((d) => !upDates[d.date] && d.avance != null);

  // Calorías: sólo existen en las comidas con foto/kcal; el promedio es sobre los días que tienen al menos una.
  const kcalPorDia = {};
  for (const m of meals) {
    const k = toNum(m.kcal);
    if (k == null || k <= 0) continue;
    kcalPorDia[m.date] = (kcalPorDia[m.date] || 0) + k;
  }
  const diasConKcal = Object.keys(kcalPorDia);
  const kcalVals = diasConKcal.map((d) => kcalPorDia[d]);
  const kcalTotal = kcalVals.reduce((s, x) => s + x, 0);
  const mealsConKcal = meals.filter((m) => (toNum(m.kcal) || 0) > 0).length;

  const macroCount = {};
  for (const m of meals) for (const part of String(m.macro || '').split('+')) { const k = part.trim(); if (k) macroCount[k] = (macroCount[k] || 0) + 1; }
  const byMacro = Object.keys(macroCount).map((k) => ({ name: k, count: macroCount[k] })).sort((a, b) => b.count - a.count);

  // Racha actual de días con avance >= 4 (los días sin avance se saltean en vez de cortar la racha).
  let streak = 0;
  for (let i = filled.length - 1; i >= 0; i--) {
    if (filled[i].avance == null) continue;
    if (filled[i].avance >= 4) streak++; else break;
  }

  const hizoEj = (d) => d.ejercicio || (d.ejercicioMin || 0) > 0;
  const withEx = filled.filter((d) => hizoEj(d) && d.avance != null);
  const withoutEx = filled.filter((d) => !d.ejercicio && !(d.ejercicioMin > 0) && d.avance != null);
  const exDays = filled.filter(hizoEj);
  const aguaVals = filled.map((d) => d.agua).filter((x) => x != null && x > 0);

  const exCount = {};
  for (const d of exDays) for (const part of String(d.ejercicio || '').split('+')) { const k = part.trim(); if (k) exCount[k] = (exCount[k] || 0) + 1; }
  const byEjercicio = Object.keys(exCount).map((k) => ({ name: k, count: exCount[k] })).sort((a, b) => b.count - a.count);

  return {
    ok: true, tab, daysTracked: filled.length, totalMeals: meals.length,
    avg: { sueno: avg(sleep), trabajo: avg(work), avance: avg(adv), animo: avg(filled.map((d) => d.animo)), agua: avg(aguaVals), kcal: avg(kcalVals) },
    totals: {
      trabajo: Math.round(sum(work) * 100) / 100,
      mast: sum(filled.map((d) => d.mast)),
      agua: aguaVals.reduce((s, x) => s + x, 0),
      ejercicioMin: sum(filled.map((d) => d.ejercicioMin)),
      ejercicioDias: exDays.length,
      mediteDias: filled.filter((d) => d.medite === 'Sí').length,
      mediteMin: sum(filled.map((d) => d.mediteMin)),
      leiDias: filled.filter((d) => d.lei === 'Sí').length,
      abordajes: sum(filled.map((d) => d.abordajes)),
      abordajesDias: filled.filter((d) => (d.abordajes || 0) > 0).length,
      kcal: kcalTotal
    },
    kcalInfo: { dias: diasConKcal.length, comidas: mealsConKcal, totalComidas: meals.length, parcial: mealsConKcal < meals.length },
    streak, byEjercicio,
    correlations: {
      sleepGood: { n: goodSleep.length, avance: avg(goodSleep.map((d) => d.avance)) },
      sleepBad: { n: badSleep.length, avance: avg(badSleep.map((d) => d.avance)) },
      withUltraprocesado: { n: withUp.length, avance: avg(withUp.map((d) => d.avance)) },
      withoutUltraprocesado: { n: withoutUp.length, avance: avg(withoutUp.map((d) => d.avance)) },
      withEjercicio: { n: withEx.length, avance: avg(withEx.map((d) => d.avance)), animo: avg(withEx.map((d) => d.animo)) },
      withoutEjercicio: { n: withoutEx.length, avance: avg(withoutEx.map((d) => d.avance)), animo: avg(withoutEx.map((d) => d.animo)) }
    },
    byMacro,
    days: filled.map((d) => ({ dayNum: d.dayNum, hsSueno: d.hsSueno, trabajo: d.trabajo, avance: d.avance, agua: d.agua, ejercicioMin: d.ejercicioMin })),
    recentMeals: meals.slice(-10).reverse()
  };
}

// ---- Escaneo de comida con Gemini (scanMeal) -----------------------------------------------------

async function scanMeal(env, base64Image, horaOpt) {
  if (!env.GEMINI_API_KEY) return { ok: false, error: 'Falta GEMINI_API_KEY' };
  if (!base64Image) return { ok: false, error: 'No se recibió imagen' };
  const prompt = 'Analizá esta foto de comida o bebida. Devolvé: ' +
    'nombre (nombre corto del plato en español rioplatense, máximo 45 chars, ej "Milanesa con puré y ensalada"), ' +
    'ingredientes (lista de los componentes visibles, separados por coma, máximo 8), ' +
    'macro (uno o varios de: Proteína, Carbo, Verdura, Fruta, Ultraprocesado, Bebida — separados por " + ", ordenados por peso en el plato), ' +
    'procesado (Bajo si es comida casera/natural, Medio si tiene algo procesado, Alto si es ultraprocesado/frito/snack), ' +
    'kcal (estimación de calorías totales del plato tal como se ve en la porción de la foto, número entero), ' +
    'confianza (Alta, Media o Baja según qué tan seguro estás de identificar el plato). ' +
    'REGLAS: ' +
    '1. Estimá la porción por lo que se ve, no por una porción estándar. ' +
    '2. Si hay varios platos en la foto, describilos juntos como una sola comida. ' +
    '3. Si no es comida ni bebida, devolvé nombre "" y confianza "Baja". ' +
    '4. No inventes ingredientes que no se ven. ' +
    'Devolvé SOLO JSON válido.';
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: String(base64Image) } }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'object',
        properties: { nombre: { type: 'string' }, ingredientes: { type: 'string' }, macro: { type: 'string' }, procesado: { type: 'string' }, kcal: { type: 'number' }, confianza: { type: 'string' } },
        required: ['nombre', 'ingredientes', 'macro', 'procesado', 'kcal', 'confianza']
      },
      temperature: 0.1
    }
  };
  const g = await geminiJson(env, body, 30000);
  if (g.http) return { ok: false, error: 'Gemini HTTP ' + g.http };
  if (!g.txt) return { ok: false, error: 'Respuesta vacía de Gemini' };
  const r = JSON.parse(g.txt.replace(/```json|```/g, '').trim());
  if (!String(r.nombre || '').trim()) return { ok: false, error: 'No se reconoció comida en la foto. Probá otra foto o escribilo a mano.' };
  const hora = horaOpt || ahoraHM();
  return {
    ok: true,
    nombre: String(r.nombre).trim(),
    ingredientes: String(r.ingredientes || '').trim(),
    macro: String(r.macro || 'Otros').trim(),
    procesado: String(r.procesado || 'Medio').trim(),
    kcal: Math.round(Number(r.kcal) || 0),
    confianza: String(r.confianza || 'Media').trim(),
    tipo: mealTypeByHour(hora),
    hora
  };
}

// ---- Handlers -------------------------------------------------------------------------------------------

export const HANDLERS = {
  getHabitDaySafe: { escribe: false, run: async (env, T, [d]) => getHabitDay(env, T, d) },
  getHabitsDataSafe: { escribe: false, run: async (env, T, [m]) => getHabitsData(env, T, m) },
  // Requiere GEMINI_API_KEY (secret del Worker). No toca D1, así que no exige fuente 'd1'.
  scanMealSafe: { escribe: false, run: async (env, T, [img, hora]) => {
    try { return await scanMeal(env, img, hora); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  } },

  habitDaySafe: { escribe: true, run: async (env, T, [d]) => saveHabitDay(env, T, d || {}) },

  addMealSafe: { escribe: true, run: async (env, T, [d]) => {
    const p = d || {};
    const comida = String(p.comida || p.item || '').trim();
    if (!comida) throw new Error('Falta el texto de la comida');
    const fecha = fechaDe(p.date);
    const hora = p.hora || ahoraHM();
    // La foto (o una corrección manual) puede traer su propia clasificación: Gemini sólo si falta algo.
    const traeMacro = !vacio(p.macro), traeProc = !vacio(p.procesado);
    const cls = (traeMacro && traeProc) ? { macro: '', tipo: mealTypeByHour(hora), procesado: '', source: 'regex' } : await classifyMeal(env, comida, hora);
    const tipo = p.tipo || cls.tipo;
    const macro = traeMacro ? String(p.macro) : cls.macro;
    const procesado = traeProc ? String(p.procesado) : cls.procesado;
    const kcal = !vacio(p.kcal) ? (toNum(p.kcal) || '') : '';
    const ingr = p.ingredientes !== undefined ? String(p.ingredientes || '') : '';
    const r = await env.DB.prepare(`INSERT INTO habit_log (tenant_id, fecha, hora, kind, detalle, macro, tipo, procesado, kcal, ingredientes) VALUES (?, ?, ?, 'comida', ?, ?, ?, ?, ?, ?)`)
      .bind(T, fecha, hora, comida, macro, tipo, procesado, kcal === '' ? null : kcal, ingr).run();
    return { ok: true, tab: tabDe(fecha), row: r.meta.last_row_id,
      written: { comida, hora, macro, tipo, procesado, kcal, ingredientes: ingr, source: p.macro ? 'foto/manual' : cls.source } };
  } },

  // p: { row, comida, hora, macro, tipo, date } — si cambia el texto y no mandan macro reclasifica; si no mandan tipo lo saca de la hora.
  updateMealSafe: { escribe: true, run: async (env, T, [d]) => {
    const p = d || {};
    const id = filaId(p.row, 'Fila de comida inválida');
    const fecha = p.date ? fechaDe(p.date) : null;
    const cur = await assertLogRow(env, T, id, fecha, 'comida');
    if (!String(cur.detalle || '').trim()) throw new Error('Esa fila no tiene una comida cargada');
    const comida = !vacio(p.comida) ? String(p.comida).trim() : String(cur.detalle);
    const hora = !vacio(p.hora) ? String(p.hora).trim() : String(cur.hora || '').trim();
    let macro = !vacio(p.macro) ? String(p.macro).trim() : null;
    let tipo = !vacio(p.tipo) ? String(p.tipo).trim() : null;
    let procesado = String(cur.procesado || '');
    if (macro === null && comida !== String(cur.detalle)) {
      const cls = await classifyMeal(env, comida, hora);
      macro = cls.macro; procesado = cls.procesado;
    } else if (macro === null) macro = String(cur.macro || '');
    if (tipo === null) tipo = mealTypeByHour(hora) || String(cur.tipo || '');
    await env.DB.prepare(`UPDATE habit_log SET hora = ?, detalle = ?, macro = ?, tipo = ?, procesado = ? WHERE tenant_id = ? AND id = ?`)
      .bind(hora, comida, macro, tipo, procesado, T, id).run();
    return { ok: true, tab: tabDe(cur.fecha), row: id, written: { hora, comida, macro, tipo, procesado } };
  } },

  deleteMealSafe: { escribe: true, run: async (env, T, [d]) => {
    const p = d || {};
    const id = filaId(p.row, 'Fila de comida inválida');
    const fecha = p.date ? fechaDe(p.date) : null;
    const cur = await assertLogRow(env, T, id, fecha, 'comida');
    const comida = String(cur.detalle || '').trim();
    if (!comida) throw new Error('Esa fila ya está vacía');
    await env.DB.prepare(`DELETE FROM habit_log WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
    return { ok: true, tab: tabDe(cur.fecha), row: id, deleted: comida };
  } },

  // Borra los datos de UN día (campos + comidas, agua y ejercicio). La API de Apps Script ya pasaba confirm=SI.
  clearHabitDaySafe: { escribe: true, run: async (env, T, [dateStr]) => {
    const fecha = fechaDe(dateStr);
    const [, lr] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM habit_days WHERE tenant_id = ? AND fecha = ?`).bind(T, fecha),
      env.DB.prepare(`DELETE FROM habit_log WHERE tenant_id = ? AND fecha = ?`).bind(T, fecha)
    ]);
    return { ok: true, tab: tabDe(fecha), date: fecha, clearedMeals: lr.meta.changes || 0 };
  } },

  // Las tres siguientes existen en Apps Script pero el formulario actual no las llama (el agua viaja
  // dentro de habitDaySafe como foto completa); se portan por si algún cliente las usa.
  addWaterSafe: { escribe: true, run: async (env, T, [d]) => {
    const p = d || {};
    const ml = toNum(String(p.ml != null ? p.ml : '').replace(',', '.'));
    if (ml == null || ml <= 0) throw new Error('Cantidad de agua inválida');
    const fecha = fechaDe(p.date);
    const tab = tabDe(fecha);
    if (p.month && p.month !== tab) throw new Error('La fecha ' + fecha + ' no pertenece a "' + p.month + '"');
    const hora = p.hora || ahoraHM();
    const tipo = String(p.tipo || '').trim() || waterLabel(ml);
    const r = await env.DB.prepare(`INSERT INTO habit_log (tenant_id, fecha, hora, kind, detalle, tipo, ml) VALUES (?, ?, ?, 'agua', ?, ?, ?)`).bind(T, fecha, hora, tipo, tipo, ml).run();
    const total = await recalcAgua(env, T, fecha);
    return { ok: true, tab, row: r.meta.last_row_id, total, written: { ml, tipo, hora } };
  } },

  updateWaterSafe: { escribe: true, run: async (env, T, [d]) => {
    const p = d || {};
    const id = filaId(p.row, 'Fila inválida');
    const cur = await assertLogRow(env, T, id, p.date ? fechaDe(p.date) : null, 'agua');
    const ml = !vacio(p.ml) ? toNum(String(p.ml).replace(',', '.')) : toNum(cur.ml);
    if (ml == null || ml <= 0) throw new Error('Cantidad inválida');
    const hora = !vacio(p.hora) ? String(p.hora).trim() : String(cur.hora || '').trim();
    const tipo = !vacio(p.tipo) ? String(p.tipo).trim() : (ml !== toNum(cur.ml) ? waterLabel(ml) : String(cur.detalle || cur.tipo || ''));
    await env.DB.prepare(`UPDATE habit_log SET hora = ?, detalle = ?, tipo = ?, ml = ? WHERE tenant_id = ? AND id = ?`).bind(hora, tipo, tipo, ml, T, id).run();
    const total = await recalcAgua(env, T, cur.fecha);
    return { ok: true, tab: tabDe(cur.fecha), row: id, total, written: { ml, tipo, hora } };
  } },

  deleteWaterSafe: { escribe: true, run: async (env, T, [d]) => {
    const p = d || {};
    const id = filaId(p.row, 'Fila inválida');
    const cur = await assertLogRow(env, T, id, p.date ? fechaDe(p.date) : null, 'agua');
    await env.DB.prepare(`DELETE FROM habit_log WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
    const total = await recalcAgua(env, T, cur.fecha);
    return { ok: true, tab: tabDe(cur.fecha), deleted: String(cur.detalle || cur.tipo || '') + ' (' + (toNum(cur.ml) || 0) + ' ml)', total };
  } }
};

// Lectores que reusa src/pending.js (avisos de hábitos).
export { getHabitDay, parseHM };
