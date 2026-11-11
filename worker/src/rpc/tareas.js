// Módulo tareas. Contrato: ver src/rpc.js y src/rpc/compras.js (ejemplo completo).
// Port de las funciones de Tareas de Apps Script (Code.gs, sección "Tareas"): mismos nombres,
// mismos argumentos, misma forma de respuesta. `row` = id de D1.
//
// Datos: tabla tasks (subtareas en JSON en la columna `subtareas`) y tabla config, que reemplaza
// a las Script Properties: TASKS_CATEGORIAS_V1, TASKS_SUBCATS_V1, TASKS_CAT_EMOJIS_V1,
// TASKS_CAT_COMPLETADAS_V1, TASKS_CAT_SUSPENDIDAS_V1, TASKS_SUBCAT_SUSPENDIDAS_V1, TASKS_UI_STATE_V1.
import { hoy, idDe } from './util.js';

export const MODULO = 'tareas';

const TAB = 'Tareas';
const TIPOS = ['Tarea', 'Cita'];
const IMPORTANCIAS = ['Alta', 'Media', 'Baja'];
const IMPORTANCIA_DEFAULT = 'Media';
const PERIODOS = ['Diario', 'Semanal', 'Mensual'];
const CATEGORIAS_DEFAULT = ['Salud', 'Trabajo', 'Personal', 'Hogar', 'Finanzas', 'Otros'];
const CAT_EMOJIS_DEFAULT = { 'Salud': '🩺', 'Trabajo': '💼', 'Personal': '🙋', 'Hogar': '🏠', 'Finanzas': '💵', 'Otros': '📌' };
const CATEGORIA_LEN_MAX = 24;
const CAT_EMOJI_LEN_MAX = 8;
const SUBTAREAS_MAX = 30;
const SUBTAREA_LEN_MAX = 80;

const K_CATS = 'TASKS_CATEGORIAS_V1';
const K_SUBCATS = 'TASKS_SUBCATS_V1';
const K_EMOJIS = 'TASKS_CAT_EMOJIS_V1';
const K_COMPLETADAS = 'TASKS_CAT_COMPLETADAS_V1';
const K_SUSPENDIDAS = 'TASKS_CAT_SUSPENDIDAS_V1';
const K_SUBSUSP = 'TASKS_SUBCAT_SUSPENDIDAS_V1';
const K_UI = 'TASKS_UI_STATE_V1';
const CLAVES = [K_CATS, K_SUBCATS, K_EMOJIS, K_COMPLETADAS, K_SUSPENDIDAS, K_SUBSUSP, K_UI];

// ---- Utilidades ---------------------------------------------------------------------------
const sa = (s) => String(s == null ? '' : s).replace(/[áéíóúÁÉÍÓÚñÑ]/g, (c) => ({ 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'Á': 'a', 'É': 'e', 'Í': 'i', 'Ó': 'o', 'Ú': 'u', 'ñ': 'n', 'Ñ': 'n' })[c]).toLowerCase().trim();
const mismo = (a, b) => sa(a) === sa(b);
const toNumber = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const bool = (v) => v === true || String(v) === 'true';

// Fechas ISO sin zona: se opera en UTC sobre el YYYY-MM-DD para no depender de la zona del runtime.
const utc = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const isoDe = (ms) => new Date(ms).toISOString().slice(0, 10);
const sumarDias = (iso, n) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return isoDe(Date.UTC(y, m - 1, d + n)); };
const diaSemana = (iso) => new Date(utc(iso)).getUTCDay();
const lunesDe = (iso) => { const d = diaSemana(iso); return sumarDias(iso, -(d === 0 ? 6 : d - 1)); };
function fechaValida(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// Clave comparable del período: dos fechas con la misma clave caen en el mismo día/semana/mes.
function clavePeriodo(iso, periodo) {
  if (periodo === 'Diario') return iso.slice(0, 10);
  if (periodo === 'Mensual') return iso.slice(0, 7);
  return lunesDe(iso);
}

// Próxima fecha (hoy inclusive) de una Cita recurrente a partir de su fecha ancla.
function citaProximaFecha(ancla, periodo, hoyIso) {
  if (periodo === 'Diario') return hoyIso;
  if (periodo === 'Mensual') {
    const dia = +ancla.slice(8, 10);
    const y = +hoyIso.slice(0, 4), m = +hoyIso.slice(5, 7);
    let cand = Date.UTC(y, m - 1, dia);
    if (cand < utc(hoyIso)) cand = Date.UTC(y, m, dia);
    return isoDe(cand);
  }
  const delta = (diaSemana(ancla) - diaSemana(hoyIso) + 7) % 7;
  return sumarDias(hoyIso, delta);
}

function parseSubtareas(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => (x && typeof x === 'object') ? { t: String(x.t || '').trim(), d: x.d === true } : null)
      .filter((x) => x && x.t)
      .map((x) => ({ t: x.t.slice(0, SUBTAREA_LEN_MAX), d: x.d }))
      .slice(0, SUBTAREAS_MAX);
  } catch (e) { return []; }
}

// ---- Config (reemplaza a las Script Properties) --------------------------------------------
async function leerConfig(env, T) {
  const r = await env.DB.prepare(`SELECT clave, valor FROM config WHERE tenant_id = ? AND clave IN (${CLAVES.map(() => '?').join(',')})`).bind(T, ...CLAVES).all();
  const raw = {};
  for (const f of r.results) raw[f.clave] = f.valor;
  const json = (k) => { try { return raw[k] ? JSON.parse(raw[k]) : null; } catch (e) { return null; } };
  const arr = (k) => { const a = json(k); return Array.isArray(a) ? a.map(String) : []; };
  const cats = json(K_CATS);
  const subs = json(K_SUBCATS);
  const emo = json(K_EMOJIS);
  const ui = json(K_UI);
  return {
    categorias: (Array.isArray(cats) && cats.length) ? cats : CATEGORIAS_DEFAULT.slice(),
    subcats: (subs && typeof subs === 'object' && !Array.isArray(subs)) ? subs : {},
    emojis: Object.assign({}, CAT_EMOJIS_DEFAULT, (emo && typeof emo === 'object' && !Array.isArray(emo)) ? emo : {}),
    completadas: arr(K_COMPLETADAS),
    suspendidas: arr(K_SUSPENDIDAS),
    subSusp: arr(K_SUBSUSP),
    uiState: (ui && typeof ui === 'object') ? {
      colapsadas: Array.isArray(ui.colapsadas) ? ui.colapsadas.map(String) : [],
      subColapsadas: Array.isArray(ui.subColapsadas) ? ui.subColapsadas.map(String) : [],
      detallesAbiertos: (ui.detallesAbiertos && typeof ui.detallesAbiertos === 'object') ? ui.detallesAbiertos : {}
    } : { colapsadas: [], subColapsadas: [], detallesAbiertos: {} }
  };
}

const setCfg = (env, T, clave, valor) => env.DB.prepare(`INSERT INTO config (tenant_id, clave, valor) VALUES (?, ?, ?)
  ON CONFLICT (tenant_id, clave) DO UPDATE SET valor = excluded.valor`).bind(T, clave, JSON.stringify(valor));
const categoriaValida = (cfg, raw) => cfg.categorias.find((c) => mismo(c, raw)) || null;

// Mismas respuestas que Apps Script: categorías + emojis + completadas + suspendidas.
const respCats = (c) => ({ ok: true, categorias: c.categorias, categoriaEmojis: c.emojis, categoriaCompletadas: c.completadas, categoriaSuspendidas: c.suspendidas });

// ---- Filas ----------------------------------------------------------------------------------
const COLS = 'id, creada, tipo, categoria, subcategoria, texto, fecha, hora, notas, completada, fecha_completada, recurrente, objetivo, contador, periodo, ultimo_reset, importancia, archivada, orden, subtareas';

async function fuenteD1(env, T) {
  const r = await env.DB.prepare(`SELECT valor FROM settings WHERE tenant_id = ? AND clave = 'fuente_tareas'`).bind(T).first();
  return !!r && r.valor === 'd1';
}

// Filas tal como las arma _tasksRows de Apps Script, con el reinicio de contadores de las
// recurrentes al leer. Si el módulo manda D1 el reinicio se persiste; si manda el Sheet, D1 es una
// copia que el sync pisa, así que el reinicio solo se calcula en memoria.
async function leerFilas(env, T, cfg) {
  const r = await env.DB.prepare(`SELECT ${COLS} FROM tasks WHERE tenant_id = ? ORDER BY id`).bind(T).all();
  const h = hoy();
  const out = [];
  const resets = [];
  for (const x of r.results) {
    if (!String(x.texto || '').trim()) continue;
    const tipo = TIPOS.find((t) => mismo(t, x.tipo)) || 'Tarea';
    const recurrente = !!x.recurrente;
    const periodo = PERIODOS.find((p) => mismo(p, x.periodo)) || 'Semanal';
    let contador = toNumber(x.contador) || 0;
    let completada = !!x.completada;
    let fechaCompletada = x.fecha_completada || '';
    let archivada = !!x.archivada;
    let ultimoReset = x.ultimo_reset ? String(x.ultimo_reset).slice(0, 10) : '';
    if (recurrente && tipo === 'Tarea') {
      const vencido = !ultimoReset || clavePeriodo(ultimoReset, periodo) !== clavePeriodo(h, periodo);
      if (vencido) {
        contador = 0;
        ultimoReset = h;
        const reactivar = completada;
        if (reactivar) { completada = false; fechaCompletada = ''; archivada = false; }
        resets.push({ id: x.id, reactivar });
      }
    }
    let fecha = x.fecha ? String(x.fecha).slice(0, 10) : '';
    if (recurrente && tipo === 'Cita' && fecha && fechaValida(fecha)) fecha = citaProximaFecha(fecha, periodo, h);
    out.push({
      row: x.id,
      creada: x.creada ? String(x.creada).slice(0, 10) : '',
      tipo,
      categoria: cfg.categorias.find((c) => mismo(c, x.categoria)) || 'Otros',
      texto: String(x.texto).trim(),
      fecha,
      hora: String(x.hora || '').trim(),
      notas: String(x.notas || '').trim(),
      completada,
      fechaCompletada: fechaCompletada ? String(fechaCompletada).slice(0, 10) : '',
      recurrente, objetivo: toNumber(x.objetivo) || 0, contador, periodo,
      ultimoReset,
      subcategoria: String(x.subcategoria || '').trim(),
      subtareas: parseSubtareas(x.subtareas),
      importancia: IMPORTANCIAS.find((i) => mismo(i, x.importancia)) || IMPORTANCIA_DEFAULT,
      archivada,
      orden: toNumber(x.orden)
    });
  }
  if (resets.length && await fuenteD1(env, T)) {
    await env.DB.batch(resets.map((rs) => rs.reactivar
      ? env.DB.prepare(`UPDATE tasks SET contador = 0, ultimo_reset = ?, completada = 0, fecha_completada = NULL, archivada = 0 WHERE tenant_id = ? AND id = ?`).bind(h, T, rs.id)
      : env.DB.prepare(`UPDATE tasks SET contador = 0, ultimo_reset = ? WHERE tenant_id = ? AND id = ?`).bind(h, T, rs.id)));
  }
  return out;
}

async function getTasksData(env, T) {
  const cfg = await leerConfig(env, T);
  const tareas = await leerFilas(env, T, cfg);
  return {
    ok: true, tab: TAB, tareas, tipos: TIPOS, categorias: cfg.categorias, periodos: PERIODOS, hoy: hoy(),
    subcategorias: cfg.subcats, categoriaEmojis: cfg.emojis, categoriaCompletadas: cfg.completadas,
    categoriaSuspendidas: cfg.suspendidas, subcatSuspendidas: cfg.subSusp, importancias: IMPORTANCIAS, uiState: cfg.uiState
  };
}

async function getComprasData(env, T) {
  const r = await env.DB.prepare(`SELECT id, creada, texto, comprado, fecha_comprado FROM purchases WHERE tenant_id = ? ORDER BY id`).bind(T).all();
  return { ok: true, tab: 'Compras', items: r.results.map((x) => ({ row: x.id, creada: x.creada || '', texto: x.texto, comprado: !!x.comprado, fechaComprado: x.fecha_comprado || '' })) };
}

const VACIA = 'Esa fila está vacía — recargá las tareas e intentá de nuevo';
async function fila(env, T, id) {
  const r = await env.DB.prepare(`SELECT ${COLS} FROM tasks WHERE tenant_id = ? AND id = ?`).bind(T, id).first();
  if (!r || !String(r.texto || '').trim()) throw new Error(VACIA);
  return r;
}

// Normaliza lo que manda el cliente (_normTask).
function normTask(cfg, p) {
  const tipo = TIPOS.find((t) => mismo(t, String(p.tipo || '').trim())) || 'Tarea';
  const categoria = categoriaValida(cfg, String(p.categoria || '').trim()) || 'Otros';
  const subcategoria = String(p.subcategoria || '').trim().slice(0, 40);
  const texto = String(p.texto || '').trim();
  if (!texto) throw new Error('Falta el texto de la tarea');

  const fechaRaw = String(p.fecha || '').trim();
  if (tipo === 'Cita' && !fechaRaw) throw new Error('Una cita necesita fecha');
  if (fechaRaw && !fechaValida(fechaRaw)) throw new Error('Fecha inválida');
  const hora = String(p.hora || '').trim();
  if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new Error('Hora inválida (HH:mm)');

  const recurrente = bool(p.recurrente);
  let objetivo = 0, periodo = '', contador = null;
  if (recurrente) {
    periodo = PERIODOS.find((x) => mismo(x, String(p.periodo || '').trim())) || 'Semanal';
    if (tipo === 'Tarea') {
      objetivo = toNumber(p.objetivo);
      if (objetivo == null || objetivo <= 0) throw new Error('Poné cuántas veces (objetivo) para la tarea recurrente');
      if (p.contador !== undefined && p.contador !== '') contador = Math.max(0, toNumber(p.contador) || 0);
    }
  }

  let subtareas = [];
  if (Array.isArray(p.subtareas)) {
    subtareas = p.subtareas
      .map((x) => {
        if (typeof x === 'string') return { t: x.trim(), d: false };
        if (x && typeof x === 'object') return { t: String(x.t || '').trim(), d: x.d === true };
        return null;
      })
      .filter((x) => x && x.t)
      .map((x) => ({ t: x.t.slice(0, SUBTAREA_LEN_MAX), d: x.d }))
      .slice(0, SUBTAREAS_MAX);
  }
  const importancia = IMPORTANCIAS.find((i) => mismo(i, String(p.importancia || '').trim())) || IMPORTANCIA_DEFAULT;
  return {
    tipo, categoria, subcategoria, texto, fecha: fechaRaw ? fechaRaw.slice(0, 10) : '', hora,
    notas: String(p.notas || '').trim(), recurrente, objetivo, periodo, contador, subtareas, importancia
  };
}

// Registra una subcategoría nueva en la lista de sugerencias (la llama el guardado de una tarea).
async function subcatRegistrar(env, T, cfg, categoria, subcategoria) {
  const cat = categoriaValida(cfg, categoria);
  const nombre = String(subcategoria || '').trim();
  if (!cat || !nombre) return;
  const lista = cfg.subcats[cat] || [];
  if (!lista.some((x) => mismo(x, nombre))) {
    lista.push(nombre);
    cfg.subcats[cat] = lista;
    await setCfg(env, T, K_SUBCATS, cfg.subcats).run();
  }
}

const VALORES = (e, o) => [
  o.creada, e.tipo, e.categoria, e.subcategoria || null, e.texto, e.fecha || null, e.hora || null, e.notas || null,
  o.completada ? 1 : 0, o.fechaCompletada || null,
  e.recurrente ? 1 : 0, e.recurrente ? e.objetivo : null, e.recurrente ? (o.contador != null ? o.contador : 0) : null,
  e.recurrente ? e.periodo : null, e.recurrente ? (o.ultimoReset || hoy()) : null,
  e.importancia || IMPORTANCIA_DEFAULT, o.archivada ? 1 : 0, o.orden != null ? o.orden : null, JSON.stringify(e.subtareas || [])
];

export const HANDLERS = {
  // ---- Lectura ----------------------------------------------------------------------------
  getTasksSafe: { escribe: false, run: async (env, T) => {
    try { return await getTasksData(env, T); } catch (err) { return { ok: false, error: err.message }; }
  } },
  getTareasPanelDataSafe: { escribe: false, run: async (env, T) => {
    try { return { ok: true, tareas: await getTasksData(env, T), compras: await getComprasData(env, T) }; }
    catch (err) { return { ok: false, error: err.message }; }
  } },

  // ---- Estado de la pantalla --------------------------------------------------------------
  saveTasksUiStateSafe: { escribe: true, run: async (env, T, [p]) => {
    p = p || {};
    const estado = {
      colapsadas: Array.isArray(p.colapsadas) ? p.colapsadas.map(String).slice(0, 60) : [],
      subColapsadas: Array.isArray(p.subColapsadas) ? p.subColapsadas.map(String).slice(0, 120) : [],
      detallesAbiertos: (p.detallesAbiertos && typeof p.detallesAbiertos === 'object') ? p.detallesAbiertos : {}
    };
    await setCfg(env, T, K_UI, estado).run();
    return { ok: true };
  } },

  // ---- Tareas -----------------------------------------------------------------------------
  addTaskSafe: { escribe: true, run: async (env, T, [d]) => {
    const cfg = await leerConfig(env, T);
    const e = normTask(cfg, d || {});
    const v = VALORES(e, { creada: hoy() });
    const r = await env.DB.prepare(`INSERT INTO tasks (tenant_id, creada, tipo, categoria, subcategoria, texto, fecha, hora, notas, completada, fecha_completada,
        recurrente, objetivo, contador, periodo, ultimo_reset, importancia, archivada, orden, subtareas)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(T, ...v).run();
    if (e.subcategoria) await subcatRegistrar(env, T, cfg, e.categoria, e.subcategoria);
    return { ok: true, tab: TAB, row: r.meta.last_row_id, written: e };
  } },

  updateTaskSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const id = idDe(d);
    const cfg = await leerConfig(env, T);
    const e = normTask(cfg, d);
    const cur = await fila(env, T, id);
    const yaEra = !!cur.recurrente;
    const v = VALORES(e, {
      creada: cur.creada || hoy(), completada: !!cur.completada, fechaCompletada: cur.fecha_completada,
      contador: e.contador != null ? e.contador : (yaEra ? (toNumber(cur.contador) || 0) : 0),
      ultimoReset: yaEra ? cur.ultimo_reset : '',
      archivada: !!cur.archivada,
      orden: mismo(e.categoria, cur.categoria) ? toNumber(cur.orden) : null
    });
    await env.DB.prepare(`UPDATE tasks SET creada = ?, tipo = ?, categoria = ?, subcategoria = ?, texto = ?, fecha = ?, hora = ?, notas = ?, completada = ?, fecha_completada = ?,
        recurrente = ?, objetivo = ?, contador = ?, periodo = ?, ultimo_reset = ?, importancia = ?, archivada = ?, orden = ?, subtareas = ?
        WHERE tenant_id = ? AND id = ?`).bind(...v, T, id).run();
    if (e.subcategoria) await subcatRegistrar(env, T, cfg, e.categoria, e.subcategoria);
    return { ok: true, tab: TAB, row: id, written: e };
  } },

  toggleTaskSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const id = idDe(d);
    const completada = bool(d.completada);
    const archivar = bool(d.archivar);
    await fila(env, T, id);
    await env.DB.prepare(`UPDATE tasks SET completada = ?, fecha_completada = ?, archivada = ? WHERE tenant_id = ? AND id = ?`)
      .bind(completada ? 1 : 0, completada ? hoy() : null, completada && archivar ? 1 : 0, T, id).run();
    return { ok: true, tab: TAB, row: id, completada };
  } },

  deleteTaskSafe: { escribe: true, run: async (env, T, [d]) => {
    const id = idDe(d || {});
    const cur = await env.DB.prepare(`SELECT texto FROM tasks WHERE tenant_id = ? AND id = ?`).bind(T, id).first();
    if (!cur || !String(cur.texto || '').trim()) throw new Error('Esa fila ya está vacía');
    await env.DB.prepare(`DELETE FROM tasks WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
    return { ok: true, tab: TAB, deleted: String(cur.texto) };
  } },

  deleteCompletedTasksInSubcategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const categoria = String(d.categoria || '').trim();
    const subcategoria = String(d.subcategoria || '').trim();
    if (!categoria || !subcategoria) throw new Error('Falta categoría o subcategoría');
    const r = await env.DB.prepare(`SELECT id, categoria, subcategoria FROM tasks WHERE tenant_id = ? AND completada = 1`).bind(T).all();
    const ids = r.results.filter((x) => mismo(x.categoria, categoria) && mismo(x.subcategoria, subcategoria)).map((x) => x.id);
    if (ids.length) await env.DB.batch(ids.map((id) => env.DB.prepare(`DELETE FROM tasks WHERE tenant_id = ? AND id = ?`).bind(T, id)));
    return { ok: true, borradas: ids.length };
  } },

  bumpTaskSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const id = idDe(d);
    const dr = toNumber(d.delta);
    const delta = dr == null ? 1 : dr;
    const cur = await fila(env, T, id);
    if (!cur.recurrente) throw new Error('Esa tarea no es recurrente');
    const contador = Math.max(0, (toNumber(cur.contador) || 0) + delta);
    await env.DB.prepare(`UPDATE tasks SET contador = ? WHERE tenant_id = ? AND id = ?`).bind(contador, T, id).run();
    return { ok: true, tab: TAB, row: id, contador };
  } },

  toggleSubtaskSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const id = idDe(d);
    const index = parseInt(d.index, 10);
    if (!Number.isFinite(index) || index < 0) throw new Error('Índice inválido');
    const completada = bool(d.completada);
    const cur = await fila(env, T, id);
    const subtareas = parseSubtareas(cur.subtareas);
    if (!subtareas[index]) throw new Error('Esa subtarea ya no existe — recargá las tareas');
    subtareas[index].d = completada;
    await env.DB.prepare(`UPDATE tasks SET subtareas = ? WHERE tenant_id = ? AND id = ?`).bind(JSON.stringify(subtareas), T, id).run();
    return { ok: true, tab: TAB, row: id, subtareas };
  } },

  moveTaskToCategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const id = idDe(d);
    const cfg = await leerConfig(env, T);
    const categoria = categoriaValida(cfg, d.categoria);
    if (!categoria) throw new Error('Categoría inválida');
    await fila(env, T, id);
    // El orden manual era relativo a la columna vieja: se limpia.
    await env.DB.prepare(`UPDATE tasks SET categoria = ?, orden = NULL WHERE tenant_id = ? AND id = ?`).bind(categoria, T, id).run();
    return { ok: true, tab: TAB, row: id, categoria };
  } },

  reorderTasksInCategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const categoria = categoriaValida(cfg, d.categoria);
    if (!categoria) throw new Error('Categoría inválida');
    const filas = Array.isArray(d.filas) ? d.filas.map((x) => parseInt(x, 10)) : null;
    if (!filas || !filas.length || filas.some((r) => !Number.isFinite(r) || r < 1)) throw new Error('Falta el orden');
    const r = await env.DB.prepare(`SELECT id, categoria, texto FROM tasks WHERE tenant_id = ?`).bind(T).all();
    const porId = new Map(r.results.map((x) => [x.id, x]));
    const stmts = [];
    filas.forEach((id, i) => {
      const x = porId.get(id);
      // Fila vacía, inexistente, o ya de otra categoría: se salta en vez de pisarla.
      if (!x || !String(x.texto || '').trim() || !mismo(x.categoria, categoria)) return;
      stmts.push(env.DB.prepare(`UPDATE tasks SET orden = ? WHERE tenant_id = ? AND id = ?`).bind(i + 1, T, id));
    });
    if (stmts.length) await env.DB.batch(stmts);
    return { ok: true };
  } },

  // ---- Categorías -------------------------------------------------------------------------
  addTaskCategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const nombre = String(d.nombre || '').trim();
    if (!nombre) throw new Error('Falta el nombre de la categoría');
    if (nombre.length > CATEGORIA_LEN_MAX) throw new Error('Nombre demasiado largo (máx ' + CATEGORIA_LEN_MAX + ' caracteres)');
    const emoji = String(d.emoji || '').trim().slice(0, CAT_EMOJI_LEN_MAX) || '📌';
    const cfg = await leerConfig(env, T);
    if (cfg.categorias.some((c) => mismo(c, nombre))) throw new Error('Ya existe esa categoría');
    cfg.categorias.push(nombre);
    cfg.emojis[nombre] = emoji;
    await env.DB.batch([setCfg(env, T, K_CATS, cfg.categorias), setCfg(env, T, K_EMOJIS, cfg.emojis)]);
    return respCats(cfg);
  } },

  renameTaskCategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const antes = categoriaValida(cfg, d.antes);
    if (!antes) throw new Error('Esa categoría no existe');
    const despues = String(d.despues || '').trim();
    if (!despues) throw new Error('Falta el nombre nuevo');
    if (despues.length > CATEGORIA_LEN_MAX) throw new Error('Nombre demasiado largo (máx ' + CATEGORIA_LEN_MAX + ' caracteres)');
    const emojiNuevo = String(d.emoji || '').trim().slice(0, CAT_EMOJI_LEN_MAX);
    const idx = cfg.categorias.findIndex((c) => mismo(c, antes));
    if (idx === -1) throw new Error('Esa categoría no existe');
    if (cfg.categorias.some((c, i) => i !== idx && mismo(c, despues))) throw new Error('Ya existe una categoría con ese nombre');
    cfg.categorias[idx] = despues;
    const stmts = [setCfg(env, T, K_CATS, cfg.categorias)];

    const emojiActual = cfg.emojis[antes] || '📌';
    delete cfg.emojis[antes];
    cfg.emojis[despues] = emojiNuevo || emojiActual;
    stmts.push(setCfg(env, T, K_EMOJIS, cfg.emojis));

    if (cfg.subcats[antes] !== undefined) {
      cfg.subcats[despues] = cfg.subcats[antes];
      delete cfg.subcats[antes];
      stmts.push(setCfg(env, T, K_SUBCATS, cfg.subcats));
    }
    const iC = cfg.completadas.findIndex((c) => mismo(c, antes));
    if (iC !== -1) { cfg.completadas[iC] = despues; stmts.push(setCfg(env, T, K_COMPLETADAS, cfg.completadas)); }
    const iS = cfg.suspendidas.findIndex((c) => mismo(c, antes));
    if (iS !== -1) { cfg.suspendidas[iS] = despues; stmts.push(setCfg(env, T, K_SUSPENDIDAS, cfg.suspendidas)); }

    // Las tareas que ya tenían la categoría pasan al nombre nuevo.
    const r = await env.DB.prepare(`SELECT id, categoria FROM tasks WHERE tenant_id = ?`).bind(T).all();
    for (const x of r.results) {
      if (mismo(x.categoria, antes)) stmts.push(env.DB.prepare(`UPDATE tasks SET categoria = ? WHERE tenant_id = ? AND id = ?`).bind(despues, T, x.id));
    }
    await env.DB.batch(stmts);
    return respCats(cfg);
  } },

  deleteTaskCategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const nombre = categoriaValida(cfg, d.nombre);
    if (!nombre) throw new Error('Esa categoría no existe');
    if (mismo(nombre, 'Otros')) throw new Error('"Otros" no se puede borrar');
    cfg.categorias = cfg.categorias.filter((c) => !mismo(c, nombre));
    const stmts = [setCfg(env, T, K_CATS, cfg.categorias)];
    if (cfg.subcats[nombre] !== undefined) { delete cfg.subcats[nombre]; stmts.push(setCfg(env, T, K_SUBCATS, cfg.subcats)); }
    if (cfg.emojis[nombre] !== undefined) { delete cfg.emojis[nombre]; stmts.push(setCfg(env, T, K_EMOJIS, cfg.emojis)); }
    cfg.completadas = cfg.completadas.filter((c) => !mismo(c, nombre));
    stmts.push(setCfg(env, T, K_COMPLETADAS, cfg.completadas));
    cfg.suspendidas = cfg.suspendidas.filter((c) => !mismo(c, nombre));
    stmts.push(setCfg(env, T, K_SUSPENDIDAS, cfg.suspendidas));
    await env.DB.batch(stmts);
    // Las tareas que la tenían no se tocan: al leerse caen solas en "Otros".
    return respCats(cfg);
  } },

  toggleTaskCategoryCompletedSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const nombre = categoriaValida(cfg, d.nombre);
    if (!nombre) throw new Error('Esa categoría no existe');
    const completada = !!d.completada;
    const actual = cfg.completadas.filter((c) => !mismo(c, nombre));
    if (completada) actual.push(nombre);
    const stmts = [setCfg(env, T, K_COMPLETADAS, actual)];
    let susp = cfg.suspendidas;
    // Mutuamente excluyente con suspendida.
    if (completada && susp.some((c) => mismo(c, nombre))) {
      susp = susp.filter((c) => !mismo(c, nombre));
      stmts.push(setCfg(env, T, K_SUSPENDIDAS, susp));
    }
    await env.DB.batch(stmts);
    return { ok: true, categoriaCompletadas: actual, categoriaSuspendidas: susp };
  } },

  toggleTaskCategorySuspendedSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const nombre = categoriaValida(cfg, d.nombre);
    if (!nombre) throw new Error('Esa categoría no existe');
    const suspendida = !!d.suspendida;
    const actual = cfg.suspendidas.filter((c) => !mismo(c, nombre));
    if (suspendida) actual.push(nombre);
    const stmts = [setCfg(env, T, K_SUSPENDIDAS, actual)];
    let comp = cfg.completadas;
    if (suspendida && comp.some((c) => mismo(c, nombre))) {
      comp = comp.filter((c) => !mismo(c, nombre));
      stmts.push(setCfg(env, T, K_COMPLETADAS, comp));
    }
    await env.DB.batch(stmts);
    return { ok: true, categoriaSuspendidas: actual, categoriaCompletadas: comp };
  } },

  moveTaskCategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const nombre = categoriaValida(cfg, d.nombre);
    if (!nombre) throw new Error('Esa categoría no existe');
    const dir = String(d.direccion || '').trim();
    if (dir !== 'up' && dir !== 'down') throw new Error('Dirección inválida');
    const lista = cfg.categorias;
    const idx = lista.findIndex((c) => mismo(c, nombre));
    if (idx === -1) throw new Error('Esa categoría no existe');
    const destino = dir === 'up' ? idx - 1 : idx + 1;
    if (destino < 0 || destino >= lista.length) return { ok: true, categorias: lista };
    const tmp = lista[destino]; lista[destino] = lista[idx]; lista[idx] = tmp;
    await setCfg(env, T, K_CATS, lista).run();
    return { ok: true, categorias: lista };
  } },

  reorderTaskCategoriesSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const orden = Array.isArray(d.orden) ? d.orden.map(String) : null;
    if (!orden || !orden.length) throw new Error('Falta el orden');
    const cfg = await leerConfig(env, T);
    const actual = cfg.categorias;
    // Tiene que ser la MISMA lista, solo reordenada.
    if (actual.map(sa).sort().join('|') !== orden.map(sa).sort().join('|')) throw new Error('El orden no coincide con las categorías actuales');
    const final = orden.map((c) => actual.find((x) => mismo(x, c)));
    await setCfg(env, T, K_CATS, final).run();
    return { ok: true, categorias: final };
  } },

  // ---- Subcategorías ----------------------------------------------------------------------
  addTaskSubcategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const cat = categoriaValida(cfg, d.categoria);
    if (!cat) throw new Error('Categoría inválida');
    const nombre = String(d.nombre || '').trim();
    if (!nombre) throw new Error('Falta el nombre de la subcategoría');
    if (nombre.length > 40) throw new Error('Nombre demasiado largo (máx 40 caracteres)');
    const lista = cfg.subcats[cat] || [];
    if (lista.some((x) => mismo(x, nombre))) throw new Error('Ya existe esa subcategoría');
    lista.push(nombre);
    cfg.subcats[cat] = lista;
    await setCfg(env, T, K_SUBCATS, cfg.subcats).run();
    return { ok: true, subcategorias: cfg.subcats };
  } },

  renameTaskSubcategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const cat = categoriaValida(cfg, d.categoria);
    if (!cat) throw new Error('Categoría inválida');
    const antes = String(d.antes || '').trim();
    const despues = String(d.despues || '').trim();
    if (!antes || !despues) throw new Error('Faltan nombres');
    if (despues.length > 40) throw new Error('Nombre demasiado largo (máx 40 caracteres)');
    const lista = cfg.subcats[cat] || [];
    const idx = lista.findIndex((x) => mismo(x, antes));
    if (idx === -1) throw new Error('No existe esa subcategoría');
    if (lista.some((x, i) => i !== idx && mismo(x, despues))) throw new Error('Ya existe una subcategoría con ese nombre');
    lista[idx] = despues;
    cfg.subcats[cat] = lista;
    const stmts = [setCfg(env, T, K_SUBCATS, cfg.subcats)];
    const claveAntes = cat + '|' + antes;
    const iS = cfg.subSusp.indexOf(claveAntes);
    if (iS !== -1) { cfg.subSusp[iS] = cat + '|' + despues; stmts.push(setCfg(env, T, K_SUBSUSP, cfg.subSusp)); }
    const r = await env.DB.prepare(`SELECT id, categoria, subcategoria FROM tasks WHERE tenant_id = ?`).bind(T).all();
    for (const x of r.results) {
      if (mismo(x.categoria, cat) && mismo(x.subcategoria, antes)) stmts.push(env.DB.prepare(`UPDATE tasks SET subcategoria = ? WHERE tenant_id = ? AND id = ?`).bind(despues, T, x.id));
    }
    await env.DB.batch(stmts);
    return { ok: true, subcategorias: cfg.subcats, subcatSuspendidas: cfg.subSusp };
  } },

  deleteTaskSubcategorySafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const cat = categoriaValida(cfg, d.categoria);
    if (!cat) throw new Error('Categoría inválida');
    const nombre = String(d.nombre || '').trim();
    cfg.subcats[cat] = (cfg.subcats[cat] || []).filter((x) => !mismo(x, nombre));
    cfg.subSusp = cfg.subSusp.filter((c) => c !== cat + '|' + nombre);
    // Las tareas que la tenían conservan el texto suelto.
    await env.DB.batch([setCfg(env, T, K_SUBSUSP, cfg.subSusp), setCfg(env, T, K_SUBCATS, cfg.subcats)]);
    return { ok: true, subcategorias: cfg.subcats, subcatSuspendidas: cfg.subSusp };
  } },

  toggleTaskSubcategorySuspendedSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const cfg = await leerConfig(env, T);
    const cat = categoriaValida(cfg, d.categoria);
    if (!cat) throw new Error('Categoría inválida');
    const sub = String(d.subcategoria || '').trim();
    if (!sub) throw new Error('Falta la subcategoría');
    const clave = cat + '|' + sub;
    const actual = cfg.subSusp.filter((c) => c !== clave);
    if (d.suspendida) actual.push(clave);
    await setCfg(env, T, K_SUBSUSP, actual).run();
    return { ok: true, subcatSuspendidas: actual };
  } }
};

// Filas (con el mismo armado que getTasksData) para src/pending.js: citas y tareas de hoy.
export async function leerTareas(env, T) {
  return leerFilas(env, T, await leerConfig(env, T));
}
