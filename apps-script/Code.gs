// === Expense Webhook for "Registro de gastos" ===
// Setup: Sheet → Extensions → Apps Script → paste this → Deploy as Web App
// "Execute as: Me" + "Who has access: Anyone with link"
// Required scopes: Spreadsheet, UrlFetch (Gemini OCR), Properties. If UrlFetch fails with
// permission error, run scanTicket() once from editor → grant scope → redeploy.

// === CONSTANTS ===
const SHEET_ID = '1kEcFTH2XgS5KF9qh3PFcq1HItDnmf_gXpohfQW8V3RI';
const TEMPLATE_TAB = 'Mayo 2026';
const SCRATCH_TAB = '_rate_scratch';
const RATE_CACHE_KEY = 'usd_rate_v1';
const RATE_CACHE_TTL_SEC = 600; // 10 min
const COTIZ_FALLBACK = 40.25;
const FIXED_TABLE_MAX_ROWS = 20;
const IMG_MAX_PX = 1280;
const VAR_HEADER_LABEL = 'Lugar / Actividad';

const MONTH_NAMES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
];

// Fixed-table labels (Mayo 2026 layout). Match is case + accent insensitive.
const FIXED_LABELS = [
  'Alquiler','Gastos comunes','Tributos domiciliarios','Antel Internet','Luz',
  'Itau paquete','Itaú paquete','Sandra Psicologa','Antel móvil','Viandas','Ble',
  'BlueCross','Gimnasio','Itaú Crédito','Oca'
];

const CATEGORIES = [
  'Transporte','Comida','Bebida/Bar','Salud','Suscripciones','Entretenimiento',
  'Hogar','Limpieza','Ropa','Regalos','Gimnasio','Servicios','Otros'
];

const CARDS = ['Débito UYU','Crédito OCA','Crédito Itaú UYU','Crédito Itaú USD','Débito USD'];

// === HABITOS: constantes ===
const HABIT_PREFIX = 'Hábitos ';
const HABIT_DAY_HEADERS = ['Fecha','Levanté','Acosté','Hs sueño','Hs trabajo','Avance','Ánimo','Ejercicio','Min ejerc.','Agua (ml)','Masturbación','Notas'];

// Mapa campo del form -> nombre de header en la hoja.
// Las columnas se resuelven POR NOMBRE, no por posición: si movés o insertás
// columnas a mano en el Sheet, el código las sigue encontrando.
const HABIT_FIELD_MAP = {
  levante:      'Levanté',
  acoste:       'Acosté',
  hsSueno:      'Hs sueño',
  trabajo:      'Hs trabajo',
  avance:       'Avance',
  animo:        'Ánimo',
  ejercicio:    'Ejercicio',
  ejercicioMin: 'Min ejerc.',
  agua:         'Agua (ml)',
  mast:         'Masturbación',
  notas:        'Notas'
};
const HABIT_MEAL_TITLE = 'REGISTRO DEL DÍA (comidas y agua)';
const HABIT_MEAL_HEADERS = ['Fecha','Hora','Detalle','Macro','Tipo','Procesado','Registro','ml','kcal','Ingredientes'];

// Envases de agua. El label se elige por cantidad cuando se carga un ml libre.
const WATER_GOAL_ML = 2400;   // objetivo diario de agua

const WATER_PRESETS = [
  { label: 'Taza',           ml: 200,  icon: '☕' },
  { label: 'Vaso',           ml: 250,  icon: '🥛' },
  { label: 'Vaso grande',    ml: 350,  icon: '🥛' },
  { label: 'Media botella',  ml: 500,  icon: '🍶' },
  { label: 'Botella',        ml: 750,  icon: '🍶' },
  { label: 'Botella 1L',     ml: 1000, icon: '💧' },
  { label: 'Botella 1,5L',   ml: 1500, icon: '💧' }
];
const HABIT_DAY_HEADER_ROW = 2;     // 1-indexed
const HABIT_DAY_FIRST_ROW = 3;      // 1-indexed
const HABIT_MEAL_TITLE_ROW = 36;    // 1-indexed (deja 31 dias + margen)
const HABIT_MEAL_HEADER_ROW = 37;
const HABIT_MEAL_FIRST_ROW = 38;

// Reglas regex para clasificar comidas (accent-insensitive, lowercase)
const MEAL_RULES = [
  { macro: 'Proteína',       re: /carne|pollo|milanesa|milanga|huevo|pescado|atun|salmon|lomo|bife|asado|cerdo|jamon|queso|lenteja|garbanzo|poroto|yogur|proteina|whey|tofu|hamburguesa|churrasco|pechuga|nuez|almendra|mani/ },
  { macro: 'Carbo',          re: /pan|arroz|pasta|fideo|tallarin|pure|papa|batata|tostada|cereal|avena|tortilla|pizza|empanada|noqui|nioqui|polenta|galleta|sandwich|wrap|medialuna|panqueque|budin|masa|harina|choclo/ },
  { macro: 'Verdura',        re: /ensalada|verdura|tomate|lechuga|zanahoria|brocoli|espinaca|zapallo|pepino|morron|cebolla|acelga|repollo|remolacha|berenjena|zucchini|calabaza|rucula|palta/ },
  { macro: 'Fruta',          re: /manzana|banana|naranja|frutilla|pera|uva|kiwi|mandarina|fruta|durazno|melon|sandia|anana|ciruela|higo|arandano|mango/ },
  { macro: 'Ultraprocesado', re: /alfajor|helado|chocolate|snack|papita|gaseosa|coca|sprite|fanta|factura|bizcocho|galletita|dulce|torta|caramelo|chip|donut|oreo|chizito|palito|golosina|cheetos|nachos|pancho|hot ?dog|frita/ },
  { macro: 'Bebida',         re: /^cafe|^mate|^te$|^agua|jugo|cerveza|vino|fernet|whisky|licuado|smoothie|gatorade|powerade|infusion|capuchino|latte/ }
];

// === doGet route table ===
const ROUTES = {
  createMonth: p => {
    if (!p.month) throw new Error('Falta param "month"');
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const existed = !!ss.getSheetByName(p.month);
    const sheet = getOrCreateMonthTab(ss, p.month);
    // Si ya existía pero no está al frente, moverlo. createMonth = "asegurar que está
    // creado Y al frente" — útil para arreglar tabs creados antes del fix.
    let movedToFront = false;
    if (existed && sheet.getIndex() !== 1) {
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(1);
      movedToFront = true;
    }
    return { ok: true, action: 'createMonth', tab: p.month, alreadyExisted: existed, movedToFront };
  },
  testRate: () => testRateSources(),
  dash: () => getDashboardData(),
  // === HABITOS ===
  habitsData: p => getHabitsData(p.month || currentHabitTab()),
  habitDay: p => upsertHabitDay(p),
  addMeal: p => addMealEntry(p),
  habitToday: p => getHabitDay(p.date || null),
  updateMeal: p => updateMealRow(p),
  deleteMeal: p => deleteMealRow(p),
  habitPending: p => habitPending(p),
  addWater: p => addWaterEntry(p),
  updateWater: p => updateWaterEntry(p),
  deleteWater: p => deleteWaterEntry(p),
  clearHabitDay: p => clearHabitDay(p.date, p.confirm),
  createHabitMonth: p => {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const name = p.month || currentHabitTab();
    getOrCreateHabitTab(ss, name);
    return { ok: true, tab: name };
  },
  classifyMealTest: p => ({ ok: true, input: p.text, result: classifyMeal(p.text, p.hora) }),
  repairHabits: p => repairHabitFormats(p.month),
  resetHabits: p => resetHabitMonth(p.month, p.confirm),
  migrateHabits: p => {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(p.month || currentHabitTab());
    if (!sheet) return { ok: false, error: 'Hoja no existe' };
    return { ok: true, ...migrateHabitSheet(sheet) };
  },
  setKey: p => {
    if (!p.key) throw new Error('Falta param "key"');
    PropertiesService.getScriptProperties().setProperty('GEMINI_KEY', p.key);
    return { ok: true, msg: 'Key guardada en Script Properties' };
  },
  hasKey: () => {
    const k = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
    return { ok: true, hasKey: !!k, keyLen: k ? k.length : 0 };
  },
  classifyMonth: p => classifyMonth(p.month || currentMonthTab()),
  classifyAll: () => classifyAllPastMonths(),
  // Tabla fija: agrega columna "Categoría" + completa con classifyItem(label)
  classifyFixedMonth: p => classifyFixedMonth(p.month || currentMonthTab()),
  classifyAllFixed: () => classifyAllFixedMonths(),
  // Limpia tabs huérfanos tipo "Sheet23", "Sheet24" (solo si están vacíos)
  cleanupOrphans: () => cleanupOrphanSheets(),
  // Reporte de cierre de mes: filas sin cotización/categoría, top categorías, top items, batches sospechosos
  auditMonth: p => auditMonth(p.month || currentMonthTab()),
  // Reporte mensual por email
  sendReport: p => sendMonthlyReport(p.month, p.email),
  previewReport: p => ({ ok: true, html: buildMonthlyReportHtml(p.month || currentMonthTab()) }),
  installReportTrigger: () => installMonthlyReportTrigger(),
  removeReportTrigger: () => removeMonthlyReportTrigger(),
  // Debug: dump headers of a tab — ?action=inspectHeaders&month=Mayo%202026
  inspectHeaders: p => inspectHeaders(p.month || currentMonthTab()),
  // Diagnostic: verify UrlFetch (script.external_request) scope works — ?action=testFetch
  testFetch: () => {
    try {
      const resp = UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
      return { ok: true, urlFetchWorks: true, httpCode: resp.getResponseCode(),
               msg: 'Scope external_request OK — el scan de tickets debería funcionar.' };
    } catch (e) {
      return { ok: false, urlFetchWorks: false, error: e.message,
               msg: 'Scope external_request NO autorizado todavía.' };
    }
  }
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  // Action-based JSON endpoints
  if (p.action && ROUTES[p.action]) {
    try { return json(ROUTES[p.action](p)); }
    catch (err) { Logger.log('Route ' + p.action + ' error: ' + err.message); return json({ ok: false, error: err.message }); }
  }
  // Add-expense via query params
  if (p.item) {
    try { return json({ ok: true, ...addExpense(p) }); }
    catch (err) { Logger.log('addExpense error: ' + err.message); return json({ ok: false, error: err.message }); }
  }
  // No params → serve mobile webapp form
  return HtmlService.createHtmlOutput(formHtml())
    .setTitle('Agregar Gasto')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function formHtml() {
  const today = Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const t = HtmlService.createTemplateFromFile('form');
  t.today = today;
  return t.evaluate().getContent();
}

// Helper para incluir parciales HTML en templates de HtmlService
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// Wrapper for google.script.run — returns plain object (success or error)
function addExpenseSafe(data) {
  try {
    var result = addExpense(data);
    return { ok: true, ...result };
  } catch (err) {
    Logger.log('addExpenseSafe error: ' + err.message);
    return { ok: false, error: err.message };
  }
}

// === Auto-classify uncategorized rows ===
// Server-side classifier (mirror of dashboard CAT_RULES). Order matters — first match wins.
const CAT_RULES = [
  [/^(forros|preservativ|condon)/i, 'Salud'], // explicit before "jabón"
  [/medicamento|farmashop|farmacia|farmacity|an[aá]lisis|dentista|hospital|cl[ií]nica|bluecross|blue cross|aflusan|vozama|duspatalin|dumirox|drogu|polish/i, 'Salud'],
  [/bus|taxi|uber|cabify|didi|combi|buque|sube|bondi|nafta|shell|axion|colonia express|pasaje|vuelta|viaje/i, 'Transporte'],
  [/disco|devoto|tata|d[ií]a\b|panader|carnicer|frog|mac\b|mcdonald|burguer|pizza|empanad|asado|comida|almuerzo|cena|desayuno|merienda|alfajor|galletas|helado|chocolate|sandwich|tostado|rotiser|pollo|huevos|queso|le pain|borneo|chipa|medialunas|cubanitos|dulce|yogurt|pde|poke|hamburguesa|barbacoa|guelfi|martin asado|santi mart[ií]nez|coca\b|osobuco|rey pollo|el clon|el naranjo|sandwich|tata\b/i, 'Comida'],
  [/fernet|cerveza|bar\b|caf[eé]|pub|powerade|aquarius|jackson|gallaghers|cuba libre|campari|sidra|trago|whisky|vino|fenix|gu[eé]mes|guelfi|prisma|madison|bebida|alcohol|birra|fenet|alikal|chinamarket|key tarjeta|key 2|guardarropa/i, 'Bebida/Bar'],
  [/agua\b/i, 'Bebida/Bar'],
  [/claude|anthropic|gpt|chatgpt|github|copilot|fly\.io|fly io|openai|notion|spotify|netflix/i, 'Suscripciones'],
  [/cine|cultural|stand up|concert|alfabeta|libro|teatro|m[uú]sica|entrada|phonetec|baile|fiesta|cumple/i, 'Entretenimiento'],
  [/jab[oó]n|esponja|papel higi[eé]nico|skip|detergente|lavandina|trapo|escoba|limpieza|mercadito papel/i, 'Limpieza'],
  [/garrafa|adaptador|tapones|llave|ferreter|cesto|plancha|sanitaria|distribuidora|cintas|acolchado|almohada|cristales|maple|plantas|compu\b|ropero|tarjeta|chinamarket/i, 'Hogar'],
  [/zara|sweater|polo|gorra|conjunto|peluqueria|invictus|vinilo|reloj|ropa/i, 'Ropa'],
  [/regalo|jano regalo/i, 'Regalos'],
  [/gimnasio|gym\b|f[uú]tbol|escalada|acupuntura|proteina|prote\b|crea\b/i, 'Gimnasio'],
  [/alquiler|gastos comunes|tributos|antel|luz|^oca$|sandra|viandas|^ble$|sas|abitab|poliza|dgi|mart[ií]n vidal|ema\b|coaching|paquete banco|limpieza karina/i, 'Servicios']
];

function classifyItem(item) {
  if (!item) return 'Otros';
  const s = String(item).trim();
  for (const [re, cat] of CAT_RULES) {
    if (re.test(s)) return cat;
  }
  return 'Otros';
}

// Debug helper: dumps header row of a tab to see exactly what the sheet has.
function inspectHeaders(tabName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Tab no existe' };
  const range = sheet.getDataRange().getValues();
  const headerRow0 = findHeaderRow(range);
  if (headerRow0 < 0) return { ok: false, error: 'No se encontró "' + VAR_HEADER_LABEL + '"' };

  const maxCol = sheet.getMaxColumns();
  const fullHeaderRow = sheet.getRange(headerRow0 + 1, 1, 1, maxCol).getValues()[0];
  const headers = fullHeaderRow.map((h, i) => ({
    col: i + 1,
    raw: h,
    rawType: typeof h,
    rawLength: String(h || '').length,
    normalized: _normHeader(h),
    isCategoria: _normHeader(h).indexOf('categor') === 0
  }));
  const catCol = headers.find(h => h.isCategoria);
  return { ok: true, tab: tabName, headerRow1: headerRow0 + 1, sheetMaxCol: maxCol, dataRangeCols: range[headerRow0].length, headers: headers, foundCategoriaAtCol: catCol ? catCol.col : null };
}

// Classify all tabs that look like months. Skips scratch tabs + tabs without Categoría col.
// Note: classifyMonth's variable-table boundary scan already stops at "Categoría"/"Gastos totales"/"Cantidad"
// → Argentina trip sections (which appear after those markers) are never touched.
function classifyAllPastMonths() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();
  const monthRe = /^(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)\s+\d{4}$/i;
  const results = [];
  let totalClassified = 0, totalSkipped = 0;
  for (const sh of sheets) {
    const name = sh.getName();
    if (!monthRe.test(name)) continue; // skip scratch + non-month tabs
    try {
      const r = classifyMonth(name);
      results.push({ tab: name, ok: r.ok, classifiedCount: r.classifiedCount || 0, columnAdded: r.columnAdded || false, error: r.error || null });
      if (r.ok) totalClassified += (r.classifiedCount || 0);
      else totalSkipped++;
    } catch (e) {
      Logger.log('classifyAll ' + name + ' error: ' + e.message);
      results.push({ tab: name, ok: false, error: e.message });
      totalSkipped++;
    }
  }
  return { ok: true, totalClassified: totalClassified, totalSkipped: totalSkipped, results: results };
}

// Robust header normalize: strips accents, non-breaking spaces, weird whitespace, lowercases.
function _normHeader(h) {
  return _stripAccents(String(h || '').replace(/[\s ]+/g, ' ').trim());
}

// Find Categoría col over the FULL sheet width (not just getDataRange columns) —
// user may have added the col past the last data column where getDataRange doesn't reach.
function findCategoryColInSheet(sheet, headerRow0) {
  const maxCol = sheet.getMaxColumns();
  const fullHeaderRow = sheet.getRange(headerRow0 + 1, 1, 1, maxCol).getValues()[0];
  for (let c = 0; c < fullHeaderRow.length; c++) {
    const norm = _normHeader(fullHeaderRow[c]);
    if (norm.indexOf('categor') === 0 || norm === 'categoria') return c;
  }
  return -1;
}

// Returns 0-indexed col idx of "Categoría". If missing, adds it.
function ensureCategoryColumn(sheet, range, headerRow) {
  // 1. Try full-width scan first (catches cols past getDataRange)
  let catCol = findCategoryColInSheet(sheet, headerRow);
  if (catCol >= 0) return { col: catCol, added: false };

  // 2. Not found — find first empty header slot in the data range, or extend
  const headers = range[headerRow].map(h => String(h || '').trim());
  let target = headers.findIndex(h => !h);
  if (target < 0) target = headers.length;
  const sheetMaxCol = sheet.getMaxColumns();
  if (target >= sheetMaxCol) {
    sheet.insertColumnAfter(sheetMaxCol);
  }
  sheet.getRange(headerRow + 1, target + 1).setValue('Categoría');
  return { col: target, added: true };
}

function classifyMonth(tabName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Tab "' + tabName + '" no existe' };
  const range = sheet.getDataRange().getValues();

  const headerRow = findHeaderRow(range);
  if (headerRow < 0) return { ok: false, error: 'Header "' + VAR_HEADER_LABEL + '" no encontrado' };

  // Auto-add Categoría column if missing
  const catColInfo = ensureCategoryColumn(sheet, range, headerRow);
  const catCol = catColInfo.col;

  // Collect contiguous range of category-col updates → single setValues call
  const firstDataRow1 = headerRow + 2;
  const updates = [];
  const colValues = []; // 2D, single col, matches sheet rows from firstDataRow1
  let lastDataRow0Idx = headerRow;
  for (let i = headerRow + 1; i < range.length; i++) {
    const item = String(range[i][0] || '').trim();
    if (isBoundaryRow(item.toLowerCase())) break;
    if (!item) { colValues.push([null]); continue; }
    lastDataRow0Idx = i;
    const existing = String(range[i][catCol] || '').trim();
    if (existing) {
      colValues.push([existing]); // preserve
    } else {
      const cat = classifyItem(item);
      colValues.push([cat]);
      updates.push({ row: i + 1, item: item, category: cat });
    }
  }
  // Trim trailing nulls past last data row
  const usableLen = lastDataRow0Idx - headerRow;
  if (usableLen > 0) {
    const trimmed = colValues.slice(0, usableLen).map(r => r[0] === null ? [''] : r);
    sheet.getRange(firstDataRow1, catCol + 1, trimmed.length, 1).setValues(trimmed);
  }
  return { ok: true, tab: tabName, classifiedCount: updates.length, columnAdded: catColInfo.added, updates: updates };
}

// === Auto-clasificar tabla FIJA + agregar columna "Categoría" ===
// La tabla fija no tiene columna Categoría por default. Esto:
//  1) agrega header "Categoría" al lado de "Cotización"
//  2) completa cada fila con classifyItem(label)
// Idempotente: si ya existe la columna, solo rellena vacíos.

function ensureFixedCategoryColumn(sheet) {
  const range = sheet.getDataRange().getValues();
  if (!range.length) return { added: false, col: -1, headerRow: -1 };
  // Limita la búsqueda al área "antes" de la tabla variable
  const varHeaderRow0 = findHeaderRow(range);
  const fixedSearchEnd = varHeaderRow0 >= 0 ? varHeaderRow0 : Math.min(range.length, 16);
  // Header de la tabla fija: primera fila cuya celda A es "Gasto"
  let fixedHeaderRow0 = -1;
  for (let i = 0; i < fixedSearchEnd; i++) {
    if (String(range[i][0] || '').trim().toLowerCase() === 'gasto') { fixedHeaderRow0 = i; break; }
  }
  if (fixedHeaderRow0 < 0) return { added: false, col: -1, headerRow: -1, reason: 'No hay header "Gasto" en tabla fija (tab legacy?)' };
  const maxCol = sheet.getMaxColumns();
  const headerRow = sheet.getRange(fixedHeaderRow0 + 1, 1, 1, maxCol).getValues()[0];
  // ¿Ya existe Categoría en el header?
  for (let c = 0; c < headerRow.length; c++) {
    if (/^categor/i.test(String(headerRow[c]).trim())) {
      return { added: false, col: c + 1, headerRow: fixedHeaderRow0 + 1 };
    }
  }
  // Encontrar Cotización; Categoría va una columna después
  let cotizCol1 = -1;
  for (let c = 0; c < headerRow.length; c++) {
    if (/cotizaci/i.test(String(headerRow[c]))) { cotizCol1 = c + 1; break; }
  }
  let targetCol1;
  if (cotizCol1 > 0) {
    targetCol1 = cotizCol1 + 1;
  } else {
    // Sin Cotización: poner al final del header (después del último no-vacío)
    let lastNonEmpty = 0;
    for (let c = 0; c < headerRow.length; c++) if (String(headerRow[c] || '').trim()) lastNonEmpty = c + 1;
    targetCol1 = lastNonEmpty + 1;
  }
  sheet.getRange(fixedHeaderRow0 + 1, targetCol1).setValue('Categoría');
  return { added: true, col: targetCol1, headerRow: fixedHeaderRow0 + 1 };
}

// Clasifica las filas de la tabla fija de un mes (rellena Categoría usando classifyItem).
// No pisa categorías ya existentes. Skipea filas tipo "Total"/"Compras"/etc.
function classifyFixedMonth(tabName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Tab no existe: ' + tabName };
  const info = ensureFixedCategoryColumn(sheet);
  if (info.col < 0) return { ok: false, error: info.reason || 'No se encontró tabla fija', columnAdded: false, classifiedCount: 0 };
  const range = sheet.getDataRange().getValues();
  const varHeaderRow0 = findHeaderRow(range);
  const fixedEnd = varHeaderRow0 >= 0 ? varHeaderRow0 : range.length;
  // info.headerRow es 1-indexed; la fila siguiente en 0-indexed = info.headerRow
  const startRow0 = info.headerRow;
  const updates = [];
  let skipped = 0;
  for (let i = startRow0; i < fixedEnd; i++) {
    const label = String(range[i][0] || '').trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    if (lower.startsWith('total') || lower === 'compras' || lower.startsWith('gasto total')) break;
    const existingRaw = range[i].length > info.col - 1 ? range[i][info.col - 1] : '';
    const existing = String(existingRaw != null ? existingRaw : '').trim();
    if (existing) { skipped++; continue; }
    updates.push({ row1: i + 1, cat: classifyItem(label) });
  }
  for (const u of updates) sheet.getRange(u.row1, info.col).setValue(u.cat);
  return { ok: true, tab: tabName, columnAdded: info.added, classifiedCount: updates.length, skipped: skipped, col: info.col };
}

function classifyAllFixedMonths() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();
  const monthRe = /^(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)\s+\d{4}$/i;
  const results = [];
  let totalClassified = 0, columnsAdded = 0;
  for (const sh of sheets) {
    const name = sh.getName();
    if (!monthRe.test(name)) continue;
    try {
      const r = classifyFixedMonth(name);
      results.push({ tab: name, ok: r.ok, classifiedCount: r.classifiedCount || 0, columnAdded: r.columnAdded || false, error: r.error || null });
      totalClassified += r.classifiedCount || 0;
      if (r.columnAdded) columnsAdded++;
    } catch (e) {
      Logger.log('classifyAllFixed ' + name + ' error: ' + e.message);
      results.push({ tab: name, ok: false, error: e.message });
    }
  }
  return { ok: true, totalClassified: totalClassified, columnsAdded: columnsAdded, results: results };
}

// === Cleanup: borrar tabs huérfanos vacíos tipo "Sheet23", "Sheet24" ===
// Pueden aparecer si una operación (copyTo/setName) falla a medias o si
// el usuario clickea "+" sin querer. Solo borra los que están completamente vacíos.
function cleanupOrphanSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const orphanRe = /^Sheet\d+$/i;
  const sheets = ss.getSheets();
  const deleted = [], kept = [];
  for (const sh of sheets) {
    const name = sh.getName();
    if (!orphanRe.test(name)) continue;
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow === 0 && lastCol === 0) {
      ss.deleteSheet(sh);
      deleted.push(name);
    } else {
      // Tiene contenido — no borrar, listar para revisión manual
      kept.push({ name: name, lastRow: lastRow, lastCol: lastCol });
    }
  }
  return { ok: true, deleted: deleted, deletedCount: deleted.length, kept: kept };
}

// === Reporte de cierre de mes (auditMonth) ===
// Devuelve totales, filas faltantes, top categorías, top items y batches con misma
// cotización (posible bleed entre meses). Pensado para el cierre mensual recurrente.
function auditMonth(tabName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Tab no existe: ' + tabName };

  const range = sheet.getDataRange().getValues();
  const headerRow = findHeaderRow(range);
  if (headerRow < 0) return { ok: false, error: 'No se encontró header de tabla variable' };

  const headers = range[headerRow].map(h => String(h || '').trim());
  const cotizCol = headers.findIndex(h => /cotizaci/i.test(h));
  const catCol = headers.findIndex(h => /^categor/i.test(h));
  const uyuCols = [], usdCols = [];
  for (let c = 1; c < headers.length; c++) {
    const h = headers[c];
    // CORTAR al primer header vacío — la tabla variable termina ahí.
    // A la derecha puede haber otra tabla (ej. "Categoría | UYU | USD" para subtotales)
    // que NO debe sumarse fila por fila.
    if (!h) break;
    if (c === cotizCol || c === catCol) continue;
    if (/nota|deuda/i.test(h)) continue;
    if (/usd|d[oó]lares?$/i.test(h)) usdCols.push(c);
    else if (/uyu|cr[eé]dito oca|d[eé]bito uyu|pesos/i.test(h)) uyuCols.push(c);
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const missingCotiz = [], missingCat = [];
  const items = [];
  let sumUyu = 0, sumUsd = 0;
  let consecutiveEmpty = 0;
  for (let i = headerRow + 1; i < range.length; i++) {
    const row = range[i];
    const itemCell = String(row[0] || '').trim();
    if (!itemCell) {
      // Cortar si vienen 4+ filas vacías seguidas — fin de la tabla variable
      consecutiveEmpty++;
      if (consecutiveEmpty >= 4) break;
      continue;
    }
    consecutiveEmpty = 0;
    const lowerA = itemCell.toLowerCase();
    if (lowerA.startsWith('total') || lowerA.startsWith('gasto total') || isBoundaryRow(lowerA)) break;
    // Marcadores de viaje Argentina / otras tablas no-variables
    if (lowerA === 'ítem' || lowerA === 'item' || /deuda mama/i.test(lowerA)) break;
    if (row.some(c => /precio d[oó]lar/i.test(String(c || '')))) break;

    let rowUyu = 0, rowUsd = 0;
    for (const c of uyuCols) { const v = parseFloat(row[c]); if (isFinite(v)) rowUyu += v; }
    for (const c of usdCols) { const v = parseFloat(row[c]); if (isFinite(v)) rowUsd += v; }
    sumUyu += rowUyu;
    sumUsd += rowUsd;

    if (cotizCol >= 0) {
      const cot = row[cotizCol];
      if (cot === '' || cot == null || !isFinite(parseFloat(cot))) {
        missingCotiz.push({ row: i + 1, item: itemCell });
      }
    }
    const cat = catCol >= 0 ? String(row[catCol] || '').trim() : '';
    if (catCol >= 0 && !cat) missingCat.push({ row: i + 1, item: itemCell });

    items.push({
      row: i + 1, item: itemCell,
      uyu: rowUyu, usd: rowUsd, cat: cat,
      cotiz: cotizCol >= 0 ? row[cotizCol] : ''
    });
  }

  // Top categorías (ordenadas por monto en UYU equivalente, aproximando USD a UYU x40)
  const FX = 40;
  const byCat = {};
  for (const it of items) {
    const c = it.cat || 'Otros';
    if (!byCat[c]) byCat[c] = { uyu: 0, usd: 0, count: 0 };
    byCat[c].uyu += it.uyu; byCat[c].usd += it.usd; byCat[c].count++;
  }
  const allCategoriasSorted = Object.keys(byCat).map(name => ({
    name: name, uyu: round2(byCat[name].uyu), usd: round2(byCat[name].usd), count: byCat[name].count
  })).sort((a, b) => (b.uyu + b.usd * FX) - (a.uyu + a.usd * FX));
  const topCategorias = allCategoriasSorted.slice(0, 5);

  // Top items por monto (UYU equivalente) — devuelve 10 para reportes
  const topItems = items.slice().sort((a, b) => (b.uyu + b.usd * FX) - (a.uyu + a.usd * FX))
    .slice(0, 10)
    .map(it => ({ row: it.row, item: it.item, uyu: round2(it.uyu), usd: round2(it.usd), cat: it.cat }));

  // Detección de batches con misma cotización (posible bleed entre meses)
  const cotizGroups = {};
  for (const it of items) {
    const key = String(it.cotiz);
    if (!key || key === 'undefined' || key === 'null') continue;
    if (!isFinite(parseFloat(key))) continue;
    if (!cotizGroups[key]) cotizGroups[key] = [];
    cotizGroups[key].push(it.row);
  }
  const sameCotizBatches = Object.keys(cotizGroups)
    .filter(k => cotizGroups[k].length >= 5)
    .map(k => ({
      cotiz: parseFloat(k), count: cotizGroups[k].length,
      firstRow: cotizGroups[k][0], lastRow: cotizGroups[k][cotizGroups[k].length - 1]
    })).sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    ok: true,
    _v: 'audit-fix-rightside-table-v4',
    tab: tabName,
    itemCount: items.length,
    sumUyu: round2(sumUyu),
    sumUsd: round2(sumUsd),
    lastRowProcessed: items.length ? items[items.length - 1].row : null,
    _debug: {
      headers: headers,
      uyuCols: uyuCols,
      usdCols: usdCols,
      cotizCol: cotizCol,
      catCol: catCol,
      firstThreeItems: items.slice(0, 3)
    },
    consistencyOk: missingCotiz.length === 0 && missingCat.length === 0,
    missingCotiz: missingCotiz,
    missingCategory: missingCat,
    topCategorias: topCategorias,
    allCategorias: allCategoriasSorted,
    topItems: topItems,
    sameCotizBatches: sameCotizBatches
  };
}

// === Reporte mensual por email ===
// Genera y envía resumen del mes + comparativa con los 5 meses previos.
//  ?action=sendReport&month=Mayo+2026     → envía reporte ahora
//  ?action=installReportTrigger           → instala trigger automático día 28 9am
//  ?action=removeReportTrigger            → desinstala
//  ?action=previewReport&month=Mayo+2026  → devuelve el HTML (para inspección)

function _prevMonth(monthStr) {
  const m = String(monthStr).match(/^([A-Za-zÁÉÍÓÚáéíóú]+)\s+(\d{4})$/);
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex(n => n.toLowerCase() === m[1].toLowerCase());
  if (idx < 0) return null;
  const year = parseInt(m[2], 10);
  if (idx === 0) return MONTH_NAMES[11] + ' ' + (year - 1);
  return MONTH_NAMES[idx - 1] + ' ' + year;
}

function _fmtUyu(n) {
  if (!isFinite(n)) return '—';
  return '$ ' + Math.round(n).toLocaleString('es-UY');
}

function _fmtUsd(n) {
  if (!isFinite(n)) return '—';
  return 'US$ ' + (Math.round(n * 100) / 100).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _pctChange(curr, prev) {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function buildMonthlyReportHtml(currentMonth) {
  // Junta el mes actual + 5 previos
  const months = [currentMonth];
  for (let i = 1; i <= 5; i++) {
    const prev = _prevMonth(months[months.length - 1]);
    if (!prev) break;
    months.push(prev);
  }
  const monthlyData = months.map(m => {
    try { return { month: m, audit: auditMonth(m) }; }
    catch (e) { return { month: m, audit: { ok: false, error: e.message } }; }
  });
  const current = monthlyData[0];
  const previous = monthlyData.slice(1).filter(md => md.audit.ok);

  if (!current.audit.ok) {
    return '<html><body><p>Error en mes actual: ' + (current.audit.error || 'desconocido') + '</p></body></html>';
  }

  // Helper para buscar cualquier categoría (no solo top 5)
  const findCat = (audit, name) => {
    const list = (audit && audit.allCategorias) || (audit && audit.topCategorias) || [];
    return list.find(c => c.name === name);
  };

  let html = '<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.5;">';
  html += '<h1 style="color: #047857; border-bottom: 2px solid #047857; padding-bottom: 8px; margin: 0;">📊 Reporte de gastos — ' + current.month + '</h1>';

  // Total card
  html += '<div style="background: #d1fae5; padding: 20px; border-radius: 8px; margin: 16px 0; text-align: center;">';
  html += '<div style="font-size: 13px; color: #047857; text-transform: uppercase; letter-spacing: 0.5px;">Total variables del mes</div>';
  html += '<div style="font-size: 30px; font-weight: 700; color: #047857; margin-top: 4px;">' + _fmtUyu(current.audit.sumUyu) + '</div>';
  html += '<div style="font-size: 18px; color: #065f46; margin-top: 4px;">' + _fmtUsd(current.audit.sumUsd) + '</div>';
  html += '<div style="font-size: 12px; color: #047857; margin-top: 8px;">' + current.audit.itemCount + ' gastos · solo variables, no incluye fijos mensuales</div>';
  html += '</div>';

  // Comida focus (lo que más te importa)
  const comidaCurrent = findCat(current.audit, 'Comida');
  if (comidaCurrent) {
    const comidaPrev = previous.map(md => findCat(md.audit, 'Comida')).filter(c => c).map(c => c.uyu);
    const avgComida = comidaPrev.length ? comidaPrev.reduce((a, b) => a + b, 0) / comidaPrev.length : 0;
    const pctC = _pctChange(comidaCurrent.uyu, avgComida);
    html += '<div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #f59e0b;">';
    html += '<div style="font-size: 13px; color: #92400e; text-transform: uppercase; letter-spacing: 0.5px;">🍽 Gasto en Comida</div>';
    html += '<div style="font-size: 26px; font-weight: 700; color: #92400e; margin-top: 4px;">' + _fmtUyu(comidaCurrent.uyu) + '</div>';
    html += '<div style="font-size: 13px; color: #78350f; margin-top: 6px;">' + comidaCurrent.count + ' compras';
    if (avgComida > 0 && pctC !== null) {
      const sign = pctC >= 0 ? '+' : '';
      const color = pctC >= 10 ? '#dc2626' : (pctC <= -10 ? '#15803d' : '#92400e');
      html += ' · <span style="color: ' + color + '; font-weight: 600;">' + sign + pctC.toFixed(0) + '%</span> vs promedio últimos ' + comidaPrev.length + ' meses (' + _fmtUyu(avgComida) + ')';
    }
    html += '</div>';
    if (comidaPrev.length) {
      html += '<div style="margin-top: 12px; font-size: 12px; color: #78350f;">Histórico: ';
      const cells = [];
      for (let i = previous.length - 1; i >= 0; i--) {
        const c = findCat(previous[i].audit, 'Comida');
        cells.push(previous[i].month.split(' ')[0].substr(0, 3) + ' ' + _fmtUyu(c ? c.uyu : 0));
      }
      cells.push('<b>' + current.month.split(' ')[0].substr(0, 3) + ' ' + _fmtUyu(comidaCurrent.uyu) + '</b>');
      html += cells.join(' → ');
      html += '</div>';
    }
    html += '</div>';
  }

  // Comparación últimos 6 meses
  html += '<h2 style="margin-top: 32px;">Últimos 6 meses</h2>';
  html += '<table style="width: 100%; border-collapse: collapse;">';
  html += '<tr style="background: #f5f5f5;">';
  html += '<th style="text-align: left; padding: 10px; border-bottom: 2px solid #e5e5e5;">Mes</th>';
  html += '<th style="text-align: right; padding: 10px; border-bottom: 2px solid #e5e5e5;">UYU</th>';
  html += '<th style="text-align: right; padding: 10px; border-bottom: 2px solid #e5e5e5;">USD</th>';
  html += '<th style="text-align: right; padding: 10px; border-bottom: 2px solid #e5e5e5;"># Gastos</th>';
  html += '</tr>';
  for (const md of monthlyData) {
    if (!md.audit.ok) {
      html += '<tr><td colspan="4" style="padding: 8px; color: #999;">' + md.month + ' — sin datos</td></tr>';
      continue;
    }
    const isCurrent = md.month === current.month;
    const style = isCurrent ? 'background: #ecfdf5; font-weight: 700;' : '';
    html += '<tr style="' + style + '">';
    html += '<td style="padding: 10px; border-bottom: 1px solid #e5e5e5;">' + md.month + (isCurrent ? ' ←' : '') + '</td>';
    html += '<td style="text-align: right; padding: 10px; border-bottom: 1px solid #e5e5e5;">' + _fmtUyu(md.audit.sumUyu) + '</td>';
    html += '<td style="text-align: right; padding: 10px; border-bottom: 1px solid #e5e5e5;">' + _fmtUsd(md.audit.sumUsd) + '</td>';
    html += '<td style="text-align: right; padding: 10px; border-bottom: 1px solid #e5e5e5; color: #666;">' + md.audit.itemCount + '</td>';
    html += '</tr>';
  }
  html += '</table>';

  // Top categorías con tendencia
  html += '<h2 style="margin-top: 32px;">Top categorías</h2>';
  html += '<table style="width: 100%; border-collapse: collapse;">';
  for (const cat of (current.audit.topCategorias || [])) {
    const prevVals = previous.map(md => findCat(md.audit, cat.name)).filter(c => c).map(c => c.uyu);
    const avg = prevVals.length ? prevVals.reduce((a, b) => a + b, 0) / prevVals.length : 0;
    const pct = _pctChange(cat.uyu, avg);
    let badge = '';
    if (pct !== null) {
      if (pct >= 20) badge = ' <span style="background: #fef2f2; color: #dc2626; padding: 2px 6px; border-radius: 4px; font-size: 11px;">▲ ' + pct.toFixed(0) + '%</span>';
      else if (pct <= -20) badge = ' <span style="background: #f0fdf4; color: #15803d; padding: 2px 6px; border-radius: 4px; font-size: 11px;">▼ ' + Math.abs(pct).toFixed(0) + '%</span>';
    }
    html += '<tr>';
    html += '<td style="padding: 10px; border-bottom: 1px solid #e5e5e5;"><b>' + cat.name + '</b>' + badge + '</td>';
    html += '<td style="text-align: right; padding: 10px; border-bottom: 1px solid #e5e5e5;">' + _fmtUyu(cat.uyu);
    if (cat.usd > 0) html += '<br><span style="color: #666; font-size: 12px;">+ ' + _fmtUsd(cat.usd) + '</span>';
    html += '</td>';
    html += '<td style="text-align: right; padding: 10px; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 12px;">' + cat.count + ' gastos</td>';
    html += '</tr>';
  }
  html += '</table>';

  // Top 10 ítems individuales
  if (current.audit.topItems && current.audit.topItems.length) {
    html += '<h2 style="margin-top: 32px;">Top 10 gastos individuales</h2>';
    html += '<table style="width: 100%; border-collapse: collapse;">';
    html += '<tr style="background: #f5f5f5;">';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #e5e5e5;">#</th>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #e5e5e5;">Ítem</th>';
    html += '<th style="text-align: left; padding: 8px; border-bottom: 2px solid #e5e5e5;">Categoría</th>';
    html += '<th style="text-align: right; padding: 8px; border-bottom: 2px solid #e5e5e5;">Monto</th>';
    html += '</tr>';
    current.audit.topItems.forEach((it, i) => {
      html += '<tr>';
      html += '<td style="padding: 8px; border-bottom: 1px solid #e5e5e5; color: #666;">' + (i + 1) + '</td>';
      html += '<td style="padding: 8px; border-bottom: 1px solid #e5e5e5;">' + it.item + '</td>';
      html += '<td style="padding: 8px; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 12px;">' + (it.cat || '—') + '</td>';
      html += '<td style="text-align: right; padding: 8px; border-bottom: 1px solid #e5e5e5;">';
      if (it.uyu > 0) html += _fmtUyu(it.uyu);
      if (it.usd > 0) html += (it.uyu > 0 ? ' + ' : '') + _fmtUsd(it.usd);
      html += '</td></tr>';
    });
    html += '</table>';
  }

  // Recomendaciones
  html += '<h2 style="margin-top: 32px;">🎯 Dónde aflojar</h2>';
  html += '<ul style="line-height: 1.7;">';
  const recs = [];
  for (const cat of (current.audit.topCategorias || []).slice(0, 5)) {
    const prevVals = previous.map(md => findCat(md.audit, cat.name)).filter(c => c).map(c => c.uyu);
    const avg = prevVals.length ? prevVals.reduce((a, b) => a + b, 0) / prevVals.length : 0;
    if (avg > 0 && cat.uyu > avg * 1.3) {
      const pct = ((cat.uyu - avg) / avg * 100).toFixed(0);
      recs.push('<li><b>' + cat.name + '</b> está <span style="color: #dc2626;">' + pct + '% arriba</span> del promedio (avg ' + _fmtUyu(avg) + ' vs ahora ' + _fmtUyu(cat.uyu) + '). Identificá qué cambió este mes.</li>');
    }
  }
  if (comidaCurrent && comidaCurrent.uyu > 8000) {
    recs.push('<li><b>Comida</b> es tu mayor margen flexible — reducir 1-2 salidas o pedidos semanales puede bajar 3-5k UYU/mes.</li>');
  }
  const subs = findCat(current.audit, 'Suscripciones');
  if (subs && subs.usd > 0) {
    recs.push('<li><b>Suscripciones</b> · ' + _fmtUsd(subs.usd) + ' USD este mes. Revisá cuáles usás de verdad — cancelar 1-2 chicas libera ~5-10 USD/mes.</li>');
  }
  if (recs.length === 0) {
    recs.push('<li>Todo dentro de rango vs los meses previos. Mantené el ritmo.</li>');
  }
  html += recs.join('');
  html += '</ul>';

  // === Sección HÁBITOS (si hay hoja del mes) ===
  html += _buildHabitsEmailSection(currentMonth);

  html += '<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0 16px;">';
  html += '<p style="font-size: 11px; color: #888;">Reporte generado por el webhook de gastos. Trigger automático: día 5 de cada mes a las 9am (reporta el mes anterior).</p>';
  html += '</body></html>';
  return html;
}

// Sección de hábitos para el email mensual. Devuelve '' si no hay datos —
// nunca rompe el reporte de gastos.
function _buildHabitsEmailSection(expenseMonth) {
  try {
    const habitTab = HABIT_PREFIX + String(expenseMonth || '').trim();
    const d = getHabitsData(habitTab);
    if (!d || !d.ok || !d.daysTracked) return '';

    const a = d.avg || {}, t = d.totals || {}, c = d.correlations || {};
    const nn = (v, suf) => (v == null ? '—' : v + (suf || ''));

    let h = '<h2 style="margin-top: 36px;">🧘 Hábitos del mes</h2>';
    h += '<p style="color:#666;font-size:13px;margin-top:-8px;">' + d.daysTracked +
         ' días registrados · ' + d.totalMeals + ' comidas en el log</p>';

    h += '<table style="width:100%;border-collapse:collapse;margin-top:12px;">';
    const kpis = [
      ['😴 Sueño promedio', nn(a.sueno, ' hs')],
      ['💼 Trabajo total',  nn(t.trabajo, ' hs')],
      ['📈 Avance promedio', nn(a.avance, ' / 5')],
      ['🔥 Racha avance 4+', d.streak + ' días']
    ];
    if (a.animo != null) kpis.push(['🙂 Ánimo promedio', a.animo + ' / 5']);
    if (t.ejercicioDias) {
      const pctEx = Math.round(t.ejercicioDias / d.daysTracked * 100);
      kpis.push(['🏃 Días con ejercicio', t.ejercicioDias + ' de ' + d.daysTracked + ' (' + pctEx + '%)']);
      if (t.ejercicioMin) kpis.push(['⏱️ Minutos de ejercicio', t.ejercicioMin + ' min']);
    }
    if (a.agua != null) kpis.push(['💧 Agua promedio', Math.round(a.agua) + ' ml/día  (objetivo ' + WATER_GOAL_ML + ')']);
    if (t.mast) {
      const perWeek = Math.round(t.mast / Math.max(d.daysTracked, 1) * 7 * 10) / 10;
      kpis.push(['📊 Masturbación', t.mast + ' en el mes (~' + perWeek + '/semana)']);
    }
    for (const k of kpis) {
      h += '<tr>';
      h += '<td style="padding:9px;border-bottom:1px solid #e5e5e5;">' + k[0] + '</td>';
      h += '<td style="padding:9px;border-bottom:1px solid #e5e5e5;text-align:right;"><b>' + k[1] + '</b></td>';
      h += '</tr>';
    }
    h += '</table>';

    // Correlaciones (solo con muestra suficiente en ambos grupos)
    const corr = [];
    if (c.sleepGood && c.sleepBad && c.sleepGood.n >= 3 && c.sleepBad.n >= 3 &&
        c.sleepGood.avance != null && c.sleepBad.avance != null) {
      const diff = c.sleepGood.avance - c.sleepBad.avance;
      const arrow = diff > 0.4 ? ' — dormir más te está rindiendo' : (diff < -0.4 ? ' — la relación va al revés este mes' : ' — sin diferencia clara');
      corr.push('<li>Con <b>7+ hs de sueño</b> tu avance promedio es <b>' + c.sleepGood.avance +
                '</b> (' + c.sleepGood.n + ' días) vs <b>' + c.sleepBad.avance + '</b> con menos (' +
                c.sleepBad.n + ' días)' + arrow + '.</li>');
    }
    if (c.withUltraprocesado && c.withoutUltraprocesado &&
        c.withUltraprocesado.n >= 3 && c.withoutUltraprocesado.n >= 3 &&
        c.withUltraprocesado.avance != null && c.withoutUltraprocesado.avance != null) {
      corr.push('<li>Días <b>con ultraprocesados</b>: avance <b>' + c.withUltraprocesado.avance +
                '</b> (' + c.withUltraprocesado.n + ' días) vs <b>' + c.withoutUltraprocesado.avance +
                '</b> sin ellos (' + c.withoutUltraprocesado.n + ' días).</li>');
    }
    if (c.withEjercicio && c.withoutEjercicio &&
        c.withEjercicio.n >= 3 && c.withoutEjercicio.n >= 3 &&
        c.withEjercicio.avance != null && c.withoutEjercicio.avance != null) {
      corr.push('<li>Días <b>con ejercicio</b>: avance <b>' + c.withEjercicio.avance +
                '</b> (' + c.withEjercicio.n + ' días) vs <b>' + c.withoutEjercicio.avance +
                '</b> sin entrenar (' + c.withoutEjercicio.n + ' días)' +
                (c.withEjercicio.animo != null && c.withoutEjercicio.animo != null
                  ? ' · ánimo ' + c.withEjercicio.animo + ' vs ' + c.withoutEjercicio.animo : '') + '.</li>');
    }
    if (corr.length) {
      h += '<h3 style="margin-top:24px;font-size:15px;">🔍 Correlaciones</h3>';
      h += '<ul style="line-height:1.7;">' + corr.join('') + '</ul>';
    }

    // Macros
    if (d.byMacro && d.byMacro.length) {
      h += '<h3 style="margin-top:24px;font-size:15px;">🍽️ Composición de comidas</h3>';
      h += '<table style="width:100%;border-collapse:collapse;">';
      const totalM = d.byMacro.reduce((s, m) => s + m.count, 0) || 1;
      for (const m of d.byMacro) {
        const pct = Math.round(m.count / totalM * 100);
        h += '<tr>';
        h += '<td style="padding:7px;border-bottom:1px solid #f0f0f0;">' + m.name + '</td>';
        h += '<td style="padding:7px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;font-size:12px;">' +
             m.count + ' veces · ' + pct + '%</td>';
        h += '</tr>';
      }
      h += '</table>';
    }

    // Tipos de ejercicio
    if (d.byEjercicio && d.byEjercicio.length) {
      h += '<h3 style="margin-top:24px;font-size:15px;">🏃 Ejercicio</h3>';
      h += '<table style="width:100%;border-collapse:collapse;">';
      for (const e of d.byEjercicio) {
        h += '<tr><td style="padding:7px;border-bottom:1px solid #f0f0f0;">' + e.name + '</td>';
        h += '<td style="padding:7px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;font-size:12px;">' +
             e.count + ' días</td></tr>';
      }
      h += '</table>';
    }

    // Ajustes sugeridos
    const tips = [];
    if (a.sueno != null && a.sueno < 7) {
      tips.push('<li>Dormís <b>' + a.sueno + ' hs</b> en promedio. Subir a 7+ es la palanca más barata que tenés para el avance.</li>');
    }
    if (a.avance != null && a.avance < 3) {
      tips.push('<li>Avance promedio <b>' + a.avance + '/5</b>. Mirá los días de 4-5 y qué tuvieron en común (sueño, horario de arranque, comidas).</li>');
    }
    const up = (d.byMacro || []).find(m => m.name === 'Ultraprocesado');
    if (up && d.totalMeals && up.count / d.totalMeals > 0.25) {
      tips.push('<li><b>' + Math.round(up.count / d.totalMeals * 100) + '%</b> de tus comidas son ultraprocesadas. Bajar a menos del 15% es un objetivo concreto para el mes que viene.</li>');
    }
    if (t.ejercicioDias != null && d.daysTracked >= 10) {
      const pctEx = Math.round(t.ejercicioDias / d.daysTracked * 100);
      if (pctEx < 40) tips.push('<li>Entrenaste <b>' + t.ejercicioDias + ' de ' + d.daysTracked +
                                ' días</b> (' + pctEx + '%). Subir a 3-4 días por semana es un objetivo concreto.</li>');
      else tips.push('<li>Buen ritmo de ejercicio: <b>' + pctEx + '%</b> de los días registrados.</li>');
    }
    if (a.agua != null && a.agua < WATER_GOAL_ML) {
      const falta = WATER_GOAL_ML - Math.round(a.agua);
      tips.push('<li>Promedio de <b>' + Math.round(a.agua) + ' ml de agua</b> por día — te faltan <b>' +
                falta + ' ml</b> para los ' + WATER_GOAL_ML + ' ml que te propusiste (unos ' +
                Math.ceil(falta / 250) + ' vasos más por día).</li>');
    } else if (a.agua != null) {
      tips.push('<li>Agua: <b>' + Math.round(a.agua) + ' ml/día</b> de promedio, por encima de tu objetivo de ' + WATER_GOAL_ML + ' ml. ✓</li>');
    }
    if (t.trabajo != null && d.daysTracked >= 10) {
      const perDay = Math.round(t.trabajo / d.daysTracked * 10) / 10;
      tips.push('<li>Promedio de <b>' + perDay + ' hs/día</b> trabajadas sobre ' + d.daysTracked + ' días registrados.</li>');
    }
    if (tips.length) {
      h += '<h3 style="margin-top:24px;font-size:15px;">🎯 Ajustes para el mes que viene</h3>';
      h += '<ul style="line-height:1.7;">' + tips.join('') + '</ul>';
    }
    return h;
  } catch (e) {
    Logger.log('_buildHabitsEmailSection error: ' + e.message);
    return '';
  }
}

function sendMonthlyReport(monthOpt, emailOpt) {
  const month = monthOpt || currentMonthTab();
  // getEffectiveUser retorna el owner del script (ilan.daniele@gmail.com),
  // funciona aunque la webapp esté como "Anyone" sin login.
  // getActiveUser falla porque no hay user autenticado en requests anónimos.
  const email = emailOpt || Session.getEffectiveUser().getEmail();
  if (!email) throw new Error('No se pudo determinar email destinatario');
  const html = buildMonthlyReportHtml(month);
  MailApp.sendEmail({
    to: email,
    subject: '📊 Reporte de gastos — ' + month,
    htmlBody: html
  });
  return { ok: true, sentTo: email, month: month };
}

function installMonthlyReportTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'monthlyReportCron') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  ScriptApp.newTrigger('monthlyReportCron').timeBased().onMonthDay(5).atHour(9).create();
  return { ok: true, msg: 'Trigger instalado: día 5 de cada mes a las 9am (reporta mes anterior)', removedPrevious: removed };
}

function removeMonthlyReportTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'monthlyReportCron') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  return { ok: true, removed: removed };
}

function monthlyReportCron() {
  try {
    // Reporta el MES ANTERIOR (corre día 5 → junta datos completos del mes recién cerrado)
    const prevMonth = _prevMonth(currentMonthTab());
    const r = sendMonthlyReport(prevMonth, null);
    Logger.log('Monthly report sent: ' + JSON.stringify(r));
  } catch (e) {
    Logger.log('Monthly report cron failed: ' + e.message);
  }
}

// === Ticket OCR via Gemini Vision ===
function scanTicket(base64Image) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
    if (!key) return { ok: false, error: 'No hay GEMINI_KEY. Configurá con ?action=setKey&key=...' };
    if (!base64Image) return { ok: false, error: 'No se recibió imagen' };

    const prompt = 'Analizá esta foto de un ticket de comercio en Uruguay. Por cada línea de producto/servicio comprado extraé: ' +
      'name (nombre item, máximo 40 chars, sin código de barras), ' +
      'amount (precio FINAL en UYU después de aplicar descuentos visibles por item, número positivo), ' +
      'category (UNA de estas exactas: Transporte, Comida, Bebida/Bar, Salud, Suscripciones, Entretenimiento, Hogar, Limpieza, Ropa, Regalos, Gimnasio, Servicios, Otros). ' +
      'REGLAS: ' +
      '1. IGNORÁ líneas de total, subtotal, IVA, cambio, redondeo, descuento general, propina. ' +
      '2. Si hay descuento aplicado a un item específico (ej "2x1", "20% off", "ahorro $X"), restalo del precio. ' +
      '3. Si una bebida está en restaurant/bar → Bebida/Bar. Si es en supermercado → Comida. ' +
      '4. Productos limpieza (jabón, lavandina, papel higiénico, esponja) → Limpieza. ' +
      '5. Si no podés leer una línea, omitila — NO inventes. ' +
      'Devolvé SOLO JSON válido con shape {"items":[{"name":string,"amount":number,"category":string},...]}.';

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
        ]
      }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  amount: { type: 'number' },
                  category: { type: 'string' }
                },
                required: ['name', 'amount', 'category']
              }
            }
          },
          required: ['items']
        },
        temperature: 0.1
      }
    };

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code !== 200) {
      return { ok: false, error: 'Gemini HTTP ' + code + ': ' + resp.getContentText().substring(0, 400) };
    }
    const data = JSON.parse(resp.getContentText());
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!text) return { ok: false, error: 'Respuesta Gemini vacía: ' + JSON.stringify(data).substring(0, 400) };
    const parsed = JSON.parse(text);
    const items = (parsed.items || []).filter(function(it){ return it && it.name && it.amount > 0; });
    return { ok: true, items: items };
  } catch (err) {
    Logger.log('scanTicket error: ' + err.message);
    var m = String((err && err.message) || err);
    // Friendly message for the UrlFetch authorization gap
    if (/external_request|permission to call UrlFetchApp|do not have permission/i.test(m)) {
      m = 'Falta autorizar el scope UrlFetch (script.external_request). El script no puede ' +
          'llamar a Gemini hasta que autorices: editá appsscript.json → agregá oauthScopes → ' +
          'corré una función desde el editor → Allow → redeploy.';
    }
    return { ok: false, error: m };
  }
}

// === Batch add (used by scan-save-all flow) ===
function addBatch(items) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'No items' };
  let saved = 0, failed = 0;
  const errors = [];
  let lastTab = '';
  for (let i = 0; i < items.length; i++) {
    try {
      const r = addExpense(items[i]);
      lastTab = r.tab || lastTab;
      saved++;
    } catch (e) {
      failed++;
      errors.push(items[i].item + ': ' + e.message);
    }
  }
  return { ok: true, saved: saved, failed: failed, tab: lastTab, errors: errors };
}

// === Dashboard: reads current month tab and computes totals/breakdowns ===
function getDashboardData() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const tabName = currentMonthTab();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return { ok: false, error: 'Tab "' + tabName + '" no existe' };
    const range = sheet.getDataRange().getValues();

    // 1. Fixed table totals (rows with col A matching FIXED_LABELS — exact match only)
    let fixedUyu = 0, fixedUsd = 0;
    for (let i = 0; i < Math.min(FIXED_TABLE_MAX_ROWS, range.length); i++) {
      const label = _stripAccents(range[i][0]);
      if (!label) continue;
      if (FIXED_LABELS.some(f => _stripAccents(f) === label)) {
        const u = toNumber(range[i][1]); if (u !== null) fixedUyu += u;
        const s = toNumber(range[i][2]); if (s !== null) fixedUsd += s;
      }
    }

    // 2. Find variable table
    const headerRow = findHeaderRow(range);
    const headers = headerRow >= 0 ? range[headerRow].map(h => String(h || '').trim()) : [];
    const cardCols = []; // {col: idx, name: header}
    let cotizCol = -1, catCol = -1;
    for (let c = 1; c < headers.length; c++) {
      const h = headers[c];
      if (/cotizaci[oó]n/i.test(h)) { cotizCol = c; continue; }
      if (/categor/i.test(h)) { catCol = c; continue; }
      if (h && !/lugar|notas|notes/i.test(h)) cardCols.push({ col: c, name: h });
    }

    // 3. Walk variable rows until boundary
    const varRows = [];
    let varUyu = 0, varUsd = 0;
    let lastCotiz = null;
    if (headerRow >= 0) {
      for (let i = headerRow + 1; i < range.length; i++) {
        const cellA = String(range[i][0] || '').trim();
        if (!cellA) continue;
        if (isBoundaryRow(cellA.toLowerCase())) break;
        // Collect row data
        let rowAmount = 0, rowCurrency = 'UYU', rowCardName = '';
        for (let k = 0; k < cardCols.length; k++) {
          const v = parseFloat(range[i][cardCols[k].col]);
          if (isFinite(v) && v !== 0) {
            rowAmount = v;
            rowCardName = cardCols[k].name;
            // Heuristic: USD if header contains USD or has Dólar
            rowCurrency = /usd|d[oó]lar/i.test(rowCardName) ? 'USD' : 'UYU';
            if (rowCurrency === 'USD') varUsd += v;
            else varUyu += v;
            break;
          }
        }
        if (cotizCol >= 0) {
          const c = parseFloat(range[i][cotizCol]);
          if (isFinite(c) && c > 20) lastCotiz = c;
        }
        if (rowAmount) {
          varRows.push({
            item: cellA,
            amount: rowAmount,
            currency: rowCurrency,
            card: rowCardName,
            category: catCol >= 0 ? String(range[i][catCol] || '').trim() : ''
          });
        }
      }
    }

    // 4. Find "Gastos totales" / "Cantidad" row for Sheet-calculated totals
    let sheetUyu = null, sheetUsd = null, sheetMixedUyu = null, sheetMixedUsd = null;
    for (let i = 0; i < range.length; i++) {
      const a = String(range[i][0] || '').trim().toLowerCase();
      if (a === 'cantidad') {
        sheetUyu = parseFloat(range[i][1]);
        sheetUsd = parseFloat(range[i][2]);
        sheetMixedUyu = parseFloat(range[i][3]);
        sheetMixedUsd = parseFloat(range[i][4]);
        break;
      }
    }

    // 5. Subtotal categoría table
    const byCategory = [];
    let catHeaderRow = -1;
    for (let i = 0; i < range.length; i++) {
      const a = String(range[i][0] || '').trim().toLowerCase();
      const b = String(range[i][1] || '').trim().toLowerCase();
      if ((a === 'categoría' || a === 'categoria') && (b === 'uyu' || b === 'pesos')) {
        catHeaderRow = i; break;
      }
    }
    if (catHeaderRow >= 0) {
      for (let i = catHeaderRow + 1; i < Math.min(catHeaderRow + 20, range.length); i++) {
        const cat = String(range[i][0] || '').trim();
        if (!cat) break;
        const u = parseFloat(range[i][1]) || 0;
        const s = parseFloat(range[i][2]) || 0;
        if (u || s) byCategory.push({ name: cat, uyu: u, usd: s });
      }
      byCategory.sort((a, b) => b.uyu - a.uyu);
    } else if (catCol >= 0) {
      // Fallback: no side subtotal table -> compute categorias desde varRows
      // (para meses donde el usuario borro la tabla lateral Categoria|UYU|USD)
      const catSums = {};
      for (const v of varRows) {
        const key = v.category || 'Otros';
        if (!catSums[key]) catSums[key] = { name: key, uyu: 0, usd: 0 };
        if (v.currency === 'USD') catSums[key].usd += v.amount;
        else catSums[key].uyu += v.amount;
      }
      Object.values(catSums).forEach(c => byCategory.push(c));
      byCategory.sort((a, b) => (b.uyu + b.usd * 40) - (a.uyu + a.usd * 40));
    }

    // 6. By card (variable only — group sums)
    const cardSums = {};
    for (const v of varRows) {
      const key = v.card + '|' + v.currency;
      if (!cardSums[key]) cardSums[key] = { name: v.card, currency: v.currency, amount: 0 };
      cardSums[key].amount += v.amount;
    }
    const byCard = Object.values(cardSums).sort((a, b) => b.amount - a.amount);

    // 7. Last 8 expenses (reverse order)
    const recent = varRows.slice(-8).reverse();

    return {
      ok: true,
      tab: tabName,
      cotizacion: lastCotiz,
      variableCount: varRows.length,
      totals: {
        uyu: sheetUyu !== null && isFinite(sheetUyu) ? sheetUyu : (fixedUyu + varUyu),
        usd: sheetUsd !== null && isFinite(sheetUsd) ? sheetUsd : (fixedUsd + varUsd),
        uyuInUyu: sheetMixedUyu !== null && isFinite(sheetMixedUyu) ? sheetMixedUyu : null,
        uyuInUsd: sheetMixedUsd !== null && isFinite(sheetMixedUsd) ? sheetMixedUsd : null,
        fixedUyu: fixedUyu,
        fixedUsd: fixedUsd,
        varUyu: varUyu,
        varUsd: varUsd
      },
      byCategory: byCategory,
      byCard: byCard,
      recent: recent
    };
  } catch (err) {
    Logger.log('getDashboardData error: ' + err.message);
    return { ok: false, error: err.message };
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateMonthTab(ss, tabName) {
  let sheet = ss.getSheetByName(tabName);
  if (sheet) return sheet;
  // Tab doesn't exist — duplicate template
  const template = ss.getSheetByName(TEMPLATE_TAB);
  if (!template) throw new Error('Template tab "' + TEMPLATE_TAB + '" no encontrado para crear ' + tabName);
  sheet = template.copyTo(ss);
  // setName en try/catch: si falla, borrar el huérfano para no dejar basura tipo "Sheet25"
  try {
    sheet.setName(tabName);
  } catch (e) {
    try { ss.deleteSheet(sheet); } catch (_) {}
    throw new Error('No se pudo nombrar el tab "' + tabName + '" (¿ya existe con otro casing?): ' + e.message);
  }
  // Mover el nuevo tab a posición 1 (leftmost) — mantiene el invariante:
  // leftmost = mes más reciente, lo que el dashboard usa para etiquetar correctamente.
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(1);
  // Clear data: variable expense rows + fixed table amounts (keep labels + cotización)
  const range = sheet.getDataRange().getValues();
  // Find "Lugar / Actividad" header
  let headerRow = -1;
  for (let i = 0; i < range.length; i++) {
    if (String(range[i][0]).trim() === 'Lugar / Actividad') { headerRow = i; break; }
  }
  if (headerRow >= 0) {
    // Clear data rows below header (col A onwards)
    const numCols = sheet.getLastColumn();
    const lastRow = sheet.getMaxRows();
    const dataStartRow = headerRow + 2; // 1-indexed first data row
    if (lastRow >= dataStartRow) {
      sheet.getRange(dataStartRow, 1, lastRow - dataStartRow + 1, numCols).clearContent();
    }
  }
  // Clear fixed-table amounts (cols B, C). Preserve labels (A) + cotización (D).
  for (let i = 0; i < Math.min(FIXED_TABLE_MAX_ROWS, range.length); i++) {
    const label = _stripAccents(range[i][0]);
    if (!label) continue;
    if (FIXED_LABELS.some(f => _stripAccents(f) === label)) {
      sheet.getRange(i + 1, 2, 1, 2).clearContent();
    }
  }
  return sheet;
}

// Note: kept name "fetchBcuRate" for backwards compatibility — actually uses GOOGLEFINANCE.
function fetchBcuRate() {
  // 1. Try CacheService (TTL 10 min — avoids 800ms sleep on every save)
  try {
    const cached = CacheService.getScriptCache().get(RATE_CACHE_KEY);
    if (cached) {
      const v = parseFloat(cached);
      if (isFinite(v) && v > 20 && v < 100) return { rate: v, source: 'GOOGLEFINANCE (cache)' };
    }
  } catch (e) { Logger.log('Cache read fail: ' + e.message); }

  // 2. GOOGLEFINANCE via hidden scratch sheet
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let scratch = ss.getSheetByName(SCRATCH_TAB);
    if (!scratch) {
      scratch = ss.insertSheet(SCRATCH_TAB);
      scratch.hideSheet();
    }
    scratch.getRange('A1').setFormula('=GOOGLEFINANCE("CURRENCY:USDUYU")');
    SpreadsheetApp.flush();
    Utilities.sleep(800);
    const v = parseFloat(scratch.getRange('A1').getValue());
    if (isFinite(v) && v > 20 && v < 100) {
      try { CacheService.getScriptCache().put(RATE_CACHE_KEY, String(v), RATE_CACHE_TTL_SEC); }
      catch (e) { Logger.log('Cache write fail: ' + e.message); }
      return { rate: v, source: 'GOOGLEFINANCE' };
    }
  } catch (e) { Logger.log('fetchBcuRate fail: ' + e.message); }
  return null;
}

function testRateSources() {
  const out = { ok: true, googleFinance: null };
  try {
    const r = fetchBcuRate();
    out.googleFinance = r ? r.rate : null;
  } catch (e) {
    out.googleFinance = 'error: ' + e.message;
  }
  return out;
}

// === HELPERS (used across operations) ===
function _stripAccents(s) {
  return String(s || '').replace(/[áéíóúÁÉÍÓÚñÑ]/g, c => ({'á':'a','é':'e','í':'i','ó':'o','ú':'u','Á':'a','É':'e','Í':'i','Ó':'o','Ú':'u','ñ':'n','Ñ':'n'})[c]).toLowerCase().trim();
}

function toNumber(x) { const n = parseFloat(x); return isFinite(n) ? n : null; }

// Parsea fechas como LOCAL en vez de UTC — evita el bug de timezone donde
// `new Date('2026-06-01')` se interpreta como UTC midnight y rola al día anterior
// en zonas con UTC offset negativo (ej. Montevideo UTC-3).
function parseLocalDate(date) {
  if (!date) return new Date();
  if (date instanceof Date) return date;
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  return new Date(date);
}

function monthTabFor(date) {
  const d = parseLocalDate(date);
  if (isNaN(d.getTime())) throw new Error('Fecha inválida: ' + date);
  return MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
}

// Asegura una columna "Fecha" en el header del variable table.
// La agrega justo después del último header CONTIGUO del variable table
// (corta en el primer header vacío — a la derecha puede haber otra tabla
// tipo "Categoría|UYU|USD" para subtotales que NO es parte de la variable).
function ensureDateColumn(sheet, headers, headerRow1Indexed) {
  // Buscar Fecha en cualquier posición (puede haber quedado fuera de lugar)
  for (let c = 0; c < headers.length; c++) {
    if (/^fecha$/i.test(String(headers[c] || '').trim())) return c;
  }
  // Detectar fin del header contiguo de la variable table
  let endOfVariableHeader = 0;
  for (let c = 0; c < headers.length; c++) {
    const h = String(headers[c] || '').trim();
    if (!h) break;
    endOfVariableHeader = c + 1;
  }
  const targetCol1 = endOfVariableHeader + 1;
  sheet.getRange(headerRow1Indexed, targetCol1).setValue('Fecha');
  return targetCol1 - 1;
}

function currentMonthTab() { return monthTabFor(new Date()); }

function findHeaderRow(range, label) {
  const target = (label || VAR_HEADER_LABEL).trim();
  for (let i = 0; i < range.length; i++) {
    if (String(range[i][0] || '').trim() === target) return i;
  }
  return -1;
}

// Row is boundary if cellA (lowercased) starts with one of these markers — used to stop
// scanning the variable expense table. Excludes "gasto total" / "total fijos" wording.
function isBoundaryRow(cellALower) {
  if (!cellALower) return false;
  if (cellALower === 'categoría' || cellALower === 'categoria' || cellALower === 'cantidad') return true;
  if (cellALower.startsWith('gastos totales')) return true;
  if (cellALower.startsWith('total') && !cellALower.includes('gasto total') && !cellALower.includes('total fijos')) return true;
  return false;
}

// findFixedRow: returns 0-indexed row idx into fixed table, or -1.
// Strict: exact match wins. Else: TYPED-item is prefix of label (e.g. "Sandra" → "Sandra Psicologa").
// Does NOT allow label-is-prefix-of-typed (avoids "Ble Loco" overwriting "Ble").
function findFixedRow(range, item) {
  const target = _stripAccents(item);
  if (!target) return -1;
  let startsWithIdx = -1;
  for (let i = 0; i < Math.min(FIXED_TABLE_MAX_ROWS, range.length); i++) {
    const label = _stripAccents(range[i][0]);
    if (!label) continue;
    if (label === target) return i;
    // Only allow if label starts with target AND label is a known FIXED_LABEL
    if (startsWithIdx < 0 && label.indexOf(target) === 0 && target.length >= 4 &&
        FIXED_LABELS.some(f => _stripAccents(f) === label)) {
      startsWithIdx = i;
    }
  }
  return startsWithIdx;
}

function addExpense(data) {
  const { item, amount, currency, card, category, date, cotizacion: cotInput, notes } = data;
  const amt = toNumber(amount);
  if (!item || amt === null || amt <= 0 || !currency || !card) {
    throw new Error('Faltan campos requeridos o monto inválido: item, amount>0, currency, card');
  }

  // Serialize concurrent writes (two simultaneous saves can stomp insertRow positions)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('No se pudo obtener lock (timeout 15s)');
  try {
    return _doAddExpense({ item, amt, currency, card, category, date, cotInput, notes });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function _doAddExpense(p) {
  const { item, amt, currency, card, category, date, cotInput, notes } = p;
  // Resolve cotización: manual > cached rate > fallback
  let cotizacion = toNumber(cotInput);
  let cotizSource = cotizacion !== null ? 'manual' : null;
  if (cotizacion === null) {
    const fetched = fetchBcuRate();
    if (fetched && fetched.rate) { cotizacion = fetched.rate; cotizSource = fetched.source; }
    else { cotizacion = COTIZ_FALLBACK; cotizSource = 'fallback'; }
  }

  // IMPORTANTE: pasar el string crudo (no `new Date(date)`), porque `new Date('2026-06-01')`
  // se parsea como UTC midnight, y en zona Montevideo (UTC-3) `.getMonth()` retorna Mayo.
  // monthTabFor() maneja strings YYYY-MM-DD parseándolos como fecha local.
  const tabName = monthTabFor(date || new Date());
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = getOrCreateMonthTab(ss, tabName);
  const range = sheet.getDataRange().getValues();

  // === FIXED MATCH PATH ===
  // If item matches a fixed-table label → overwrite that row's UYU or USD cell.
  // Fixed table layout: col A=label, col B=UYU, col C=USD, col D=cotización.
  const fixedRowIdx = findFixedRow(range, item);
  if (fixedRowIdx >= 0) {
    const row1 = fixedRowIdx + 1;
    const currencyUpper = String(currency).toUpperCase();
    const targetCol = currencyUpper === 'USD' ? 3 : 2;
    const existingVal = sheet.getRange(row1, targetCol).getValue();
    const existingNum = (typeof existingVal === 'number' && existingVal > 0) ? existingVal : 0;
    sheet.getRange(row1, targetCol).setValue(amt);
    if (currencyUpper === 'USD' && cotizacion) sheet.getRange(row1, 4).setValue(cotizacion);
    // También escribe la categoría auto-detectada en la columna Categoría de la tabla fija
    // (la crea si no existe). Wrap en try/catch para que un fallo no rompa el write principal.
    let fixedCatWritten = null;
    try {
      const catInfo = ensureFixedCategoryColumn(sheet);
      if (catInfo.col > 0) {
        const label = String(range[fixedRowIdx][0]).trim();
        const cat = classifyItem(label);
        sheet.getRange(row1, catInfo.col).setValue(cat);
        fixedCatWritten = cat;
      }
    } catch (e) { Logger.log('fixed category write failed: ' + e.message); }
    return {
      tab: tabName, row: row1, fixed: true, cotizSource,
      written: { item: String(range[fixedRowIdx][0]).trim(), amount: amt, currency: currencyUpper, prevAmount: existingNum, cotizacion, category: fixedCatWritten }
    };
  }

  // === VARIABLE TABLE PATH ===
  const headerRow = findHeaderRow(range);
  if (headerRow < 0) throw new Error('Header "' + VAR_HEADER_LABEL + '" no encontrado en ' + tabName);
  const headers = range[headerRow].map(h => String(h || '').trim());

  // Find boundary row below header
  let totalRow = -1;
  let boundaryIsTotalSum = false;
  for (let i = headerRow + 1; i < range.length; i++) {
    const cellA = String(range[i][0]).trim().toLowerCase();
    if (!cellA) continue;
    if (cellA.startsWith('total') && !cellA.includes('gasto total') && !cellA.includes('total fijos')) {
      totalRow = i; boundaryIsTotalSum = true; break;
    }
    if (isBoundaryRow(cellA)) { totalRow = i; break; }
  }

  // Determine target row + insert
  let insertAt;
  let newTotalRow1Indexed = -1;
  if (totalRow > 0) {
    const totalRow1Indexed = totalRow + 1;
    sheet.insertRowBefore(totalRow1Indexed); // new empty row at where Total was
    insertAt = totalRow1Indexed; // new row 1-indexed position
    newTotalRow1Indexed = totalRow1Indexed + 1; // Total moved down by 1
  } else {
    // No boundary, append after last non-empty (or right after header if no data)
    let lastDataRow = -1; // 0-indexed; -1 = no data
    for (let i = headerRow + 1; i < range.length; i++) {
      if (range[i][0] !== '' && range[i][0] !== null) lastDataRow = i;
    }
    insertAt = lastDataRow < 0 ? (headerRow + 2) : (lastDataRow + 2); // 1-indexed
    sheet.insertRowBefore(insertAt);
  }

  // Find card column (exact + accent-insensitive)
  const targetCard = _stripAccents(card);
  let cardCol = headers.findIndex(h => _stripAccents(h) === targetCard);
  if (cardCol < 0) throw new Error('Medio de pago "' + card + '" no encontrado. Headers: ' + headers.filter(h => h).join(' | '));

  const cotizCol = headers.findIndex(h => /cotizaci[oó]n/i.test(h));
  const catCol = headers.findIndex(h => /categor/i.test(h));

  // Categoría: se detecta desde el TEXTO del ítem (classifyItem es la fuente principal).
  // El form mobile manda 'Transporte' por default → NO se confía en ese valor.
  //   • el texto matchea una regla              → esa categoría (el texto manda)
  //   • no matchea, pero pasaron algo ≠ default  → se respeta esa elección
  //   • no matchea y sin elección real           → 'Otros'
  const autoCat = classifyItem(item);
  let finalCategory;
  if (autoCat !== 'Otros') finalCategory = autoCat;
  else if (category && category !== 'Transporte') finalCategory = category;
  else finalCategory = 'Otros';

  // Build single row write (atomic — one round trip instead of 4)
  const numCols = headers.length;
  const row = new Array(numCols).fill('');
  row[0] = item;
  row[cardCol] = amt;
  if (cotizCol >= 0 && cotizacion) row[cotizCol] = cotizacion;
  if (catCol >= 0 && finalCategory) row[catCol] = finalCategory;
  if (notes && catCol >= 0 && catCol + 1 < numCols) row[catCol + 1] = notes;
  sheet.getRange(insertAt, 1, 1, numCols).setValues([row]);

  // Escribir la fecha en la columna "Fecha" del variable table (la crea si no existe)
  try {
    const fechaColIdx = ensureDateColumn(sheet, headers, headerRow + 1);
    if (fechaColIdx >= 0) {
      const dateObj = parseLocalDate(date);
      if (dateObj && !isNaN(dateObj.getTime())) {
        sheet.getRange(insertAt, fechaColIdx + 1).setValue(dateObj);
      }
    }
  } catch (e) { Logger.log('Fecha write failed: ' + e.message); }

  // Update Total row formulas to include the new row (only if boundary was a real "Total" with SUM formulas)
  if (newTotalRow1Indexed > 0 && boundaryIsTotalSum) {
    const firstDataRow1Indexed = headerRow + 2;
    const lastDataRow1Indexed = newTotalRow1Indexed - 1;
    // Rebuild SUM formulas for numeric columns. Skip col A (label), col G (cotización rate, not sum), col H (categoría text).
    // Mayo cols: B,C,D,E,F numeric. Abril cols: B,C,D,E,F numeric. Same structure.
    const numericCols = [2, 3, 4, 5, 6]; // B-F
    for (const col of numericCols) {
      const letter = String.fromCharCode(64 + col);
      const formula = '=SUM(' + letter + firstDataRow1Indexed + ':' + letter + lastDataRow1Indexed + ')';
      sheet.getRange(newTotalRow1Indexed, col).setFormula(formula);
    }
  }

  return {
    tab: tabName,
    row: insertAt,
    cotizSource: cotizSource,
    written: { item, amount: amt, currency, card, category: finalCategory, cotizacion: cotizacion || null, notes: notes || null }
  };
}


// ============================================================================
// === HABITOS: tracker diario (sueño, trabajo, avance, comidas) ==============
// ============================================================================

function habitTabFor(date) {
  const d = parseLocalDate(date) || new Date();
  return HABIT_PREFIX + MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
}

function currentHabitTab() { return habitTabFor(new Date()); }

// Parsea 'Hábitos Julio 2026' -> { monthIdx: 6, year: 2026 }
function _parseHabitTabName(tabName) {
  const rest = String(tabName || '').replace(HABIT_PREFIX, '').trim();
  const parts = rest.split(/\s+/);
  if (parts.length < 2) return null;
  const monthIdx = MONTH_NAMES.findIndex(m => _stripAccents(m) === _stripAccents(parts[0]));
  const year = parseInt(parts[1], 10);
  if (monthIdx < 0 || !isFinite(year)) return null;
  return { monthIdx: monthIdx, year: year };
}

// 'HH:MM' -> minutos desde medianoche. null si invalido.
function _parseHM(s) {
  if (s == null) return null;
  // Puede venir como Date (si Sheets lo interpretó como hora)
  if (Object.prototype.toString.call(s) === '[object Date]') {
    return s.getHours() * 60 + s.getMinutes();
  }
  const m = String(s).trim().match(/^(\d{1,2})[:.h](\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (!isFinite(h) || !isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

function _fmtHM(mins) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Horas dormidas: se acostó anoche (bedStr) y se levantó hoy (wakeStr).
// Maneja acostarse antes de medianoche (23:30) y después (00:15).
function _calcSleepHours(bedStr, wakeStr) {
  const bed = _parseHM(bedStr), wake = _parseHM(wakeStr);
  if (bed == null || wake == null) return null;
  let mins;
  if (bed >= 12 * 60) mins = (24 * 60 - bed) + wake;  // se acostó PM del día anterior
  else mins = wake - bed;                              // se acostó AM (madrugada del mismo día)
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

// Tipo de comida según la hora
function _mealTypeByHour(hora) {
  const m = _parseHM(hora);
  if (m == null) return '';
  const h = m / 60;
  if (h < 5) return 'Snack nocturno';
  if (h < 11) return 'Desayuno';
  if (h < 15) return 'Almuerzo';
  if (h < 19) return 'Merienda';
  return 'Cena';
}

// Clasifica una comida: regex primero, Gemini como fallback si no matchea.
function classifyMeal(text, hora) {
  const raw = String(text || '').trim();
  const t = _stripAccents(raw);
  const macros = [];
  for (const rule of MEAL_RULES) {
    if (rule.re.test(t)) macros.push(rule.macro);
  }
  const tipo = _mealTypeByHour(hora);
  if (macros.length) {
    const procesado = macros.indexOf('Ultraprocesado') >= 0 ? 'Alto'
                    : (macros.indexOf('Verdura') >= 0 || macros.indexOf('Fruta') >= 0) ? 'Bajo'
                    : 'Medio';
    return { macro: macros.join(' + '), tipo: tipo, procesado: procesado, source: 'regex' };
  }
  // Fallback Gemini — nunca debe romper el guardado
  try {
    const g = _classifyMealGemini(raw);
    if (g) return { macro: g.macro, tipo: tipo, procesado: g.procesado, source: 'gemini' };
  } catch (e) {
    Logger.log('classifyMeal gemini fallback failed: ' + e.message);
  }
  return { macro: 'Otros', tipo: tipo, procesado: 'Medio', source: 'default' };
}

function _classifyMealGemini(text) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key || !text) return null;
  const prompt = 'Clasifica esta comida en JSON estricto sin markdown. ' +
    'Campos: macro (uno o varios de: Proteína, Carbo, Verdura, Fruta, Ultraprocesado, Bebida, separados por " + ") ' +
    'y procesado (Bajo, Medio o Alto). Comida: "' + text + '". ' +
    'Responde SOLO el JSON, ejemplo: {"macro":"Proteína + Carbo","procesado":"Medio"}';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (resp.getResponseCode() !== 200) return null;
  const body = JSON.parse(resp.getContentText());
  let txt = body.candidates && body.candidates[0] && body.candidates[0].content &&
            body.candidates[0].content.parts[0].text;
  if (!txt) return null;
  txt = txt.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(txt);
  if (!parsed || !parsed.macro) return null;
  return { macro: String(parsed.macro), procesado: String(parsed.procesado || 'Medio') };
}

// Crea (o devuelve) la hoja de hábitos del mes, con las dos tablas listas.
function getOrCreateHabitTab(ss, tabName) {
  let sheet = ss.getSheetByName(tabName);
  if (sheet) {
    // Hoja de un mes anterior a que existieran algunas columnas: las agrega.
    try { migrateHabitSheet(sheet); } catch (e) { Logger.log('migrate day: ' + e.message); }
    try { migrateLogTable(sheet); } catch (e) { Logger.log('migrate log: ' + e.message); }
    return sheet;
  }

  sheet = ss.insertSheet(tabName);
  const parsed = _parseHabitTabName(tabName) || { monthIdx: new Date().getMonth(), year: new Date().getFullYear() };
  const daysInMonth = new Date(parsed.year, parsed.monthIdx + 1, 0).getDate();

  // --- Título + tabla diaria ---
  sheet.getRange(1, 1).setValue('HÁBITOS — ' + tabName.replace(HABIT_PREFIX, ''))
       .setFontWeight('bold').setFontSize(13);
  sheet.getRange(HABIT_DAY_HEADER_ROW, 1, 1, HABIT_DAY_HEADERS.length)
       .setValues([HABIT_DAY_HEADERS])
       .setFontWeight('bold').setBackground('#e8f0ee');

  // Pre-cargar las fechas del mes
  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) dates.push([new Date(parsed.year, parsed.monthIdx, d)]);
  sheet.getRange(HABIT_DAY_FIRST_ROW, 1, dates.length, 1)
       .setValues(dates).setNumberFormat('dd/MM/yyyy');

  // --- Tabla de comidas ---
  sheet.getRange(HABIT_MEAL_TITLE_ROW, 1).setValue(HABIT_MEAL_TITLE)
       .setFontWeight('bold').setFontSize(12);
  sheet.getRange(HABIT_MEAL_HEADER_ROW, 1, 1, HABIT_MEAL_HEADERS.length)
       .setValues([HABIT_MEAL_HEADERS])
       .setFontWeight('bold').setBackground('#fef3c7');

  // CRÍTICO: forzar formato TEXTO en las columnas de hora. Si se dejan en
  // formato automático, Sheets interpreta "07:15" como un Date de 1899 y al
  // releerlo aplica el offset LMT de Montevideo (-03:44:51) → devuelve 07:46.
  sheet.getRange(HABIT_DAY_FIRST_ROW, 2, 40, 2).setNumberFormat('@');
  sheet.getRange(HABIT_MEAL_FIRST_ROW, 2, 600, 1).setNumberFormat('@');

  // Formato
  sheet.setColumnWidth(1, 95);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(9, 260);
  sheet.setFrozenRows(HABIT_DAY_HEADER_ROW);
  return sheet;
}

// Lee la fila de headers de la tabla diaria y devuelve { headerNormalizado: colIdx0 }
function _habitHeaderMap(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), HABIT_DAY_HEADERS.length);
  const hdrs = sheet.getRange(HABIT_DAY_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const map = {};
  for (let i = 0; i < hdrs.length; i++) {
    const key = _stripAccents(String(hdrs[i] || '').trim());
    if (key) map[key] = i;
  }
  return map;
}

// Columna 1-indexed de un campo lógico. -1 si el header no existe.
function _habitColOf(hmap, field) {
  const header = HABIT_FIELD_MAP[field];
  if (!header) return -1;
  const idx = hmap[_stripAccents(header)];
  return (idx === undefined) ? -1 : idx + 1;
}

// Agrega a una hoja existente las columnas de HABIT_DAY_HEADERS que falten.
// Idempotente: si ya están todas, no toca nada.
function migrateHabitSheet(sheet) {
  // Rename 'Agua (vasos)' -> 'Agua (ml)' convirtiendo los valores (1 vaso = 250 ml).
  // Se hace antes de calcular los faltantes para no duplicar la columna.
  const pre = _habitHeaderMap(sheet);
  const oldAgua = pre[_stripAccents('Agua (vasos)')];
  if (oldAgua !== undefined && pre[_stripAccents('Agua (ml)')] === undefined) {
    const col = oldAgua + 1;
    sheet.getRange(HABIT_DAY_HEADER_ROW, col).setValue('Agua (ml)');
    const rng = sheet.getRange(HABIT_DAY_FIRST_ROW, col, 40, 1);
    const vals = rng.getValues();
    let touched = false;
    const out = vals.map(r => {
      const v = toNumber(r[0]);
      // Sólo convertir valores que parezcan cantidad de vasos (<= 30), no ml ya cargados
      if (v != null && v > 0 && v <= 30) { touched = true; return [v * 250]; }
      return [r[0]];
    });
    if (touched) rng.setValues(out);
  }

  // Rename 'Mast.' -> 'Masturbación' (mismo dato, solo la etiqueta)
  const pre2 = _habitHeaderMap(sheet);
  const oldMast = pre2[_stripAccents('Mast.')];
  if (oldMast !== undefined && pre2[_stripAccents('Masturbación')] === undefined) {
    sheet.getRange(HABIT_DAY_HEADER_ROW, oldMast + 1).setValue('Masturbación');
  }

  const hmap = _habitHeaderMap(sheet);
  const missing = HABIT_DAY_HEADERS.filter(h => hmap[_stripAccents(h)] === undefined);
  if (!missing.length) return { added: [] };

  // Insertar antes de "Notas" si existe, si no al final
  const notasIdx = hmap[_stripAccents('Notas')];
  let insertAt = (notasIdx === undefined)
    ? Object.keys(hmap).length + 1
    : notasIdx + 1;

  for (const h of missing) {
    if (_stripAccents(h) === _stripAccents('Notas')) continue; // Notas se maneja aparte
    sheet.insertColumnBefore(insertAt);
    sheet.getRange(HABIT_DAY_HEADER_ROW, insertAt)
         .setValue(h).setFontWeight('bold').setBackground('#e8f0ee');
    insertAt++;
  }
  // Si faltaba Notas, agregarla al final
  if (missing.some(h => _stripAccents(h) === _stripAccents('Notas'))) {
    const col = _habitHeaderMap(sheet);
    const last = Object.keys(col).length + 1;
    sheet.getRange(HABIT_DAY_HEADER_ROW, last)
         .setValue('Notas').setFontWeight('bold').setBackground('#e8f0ee');
  }
  return { added: missing };
}

// Encuentra la fila 1-indexed de una fecha en la tabla diaria. -1 si no está.
function _habitFindDayRow(sheet, dateStr) {
  const target = parseLocalDate(dateStr);
  if (!target) return -1;
  const tKey = target.getFullYear() + '-' + target.getMonth() + '-' + target.getDate();
  const n = 31;
  const vals = sheet.getRange(HABIT_DAY_FIRST_ROW, 1, n, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i][0];
    if (!v) continue;
    const d = Object.prototype.toString.call(v) === '[object Date]' ? v : parseLocalDate(v);
    if (!d) continue;
    if (d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() === tKey) return HABIT_DAY_FIRST_ROW + i;
  }
  return -1;
}

// Upsert de la fila del día: solo escribe los campos que vienen con valor.
// p: { date, levante, acoste, trabajo, avance, mast, animo, notas, mastDelta }
function upsertHabitDay(p) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const tabName = p.month || habitTabFor(dateStr);
  const sheet = getOrCreateHabitTab(ss, tabName);
  const hmap = _habitHeaderMap(sheet);

  let row = _habitFindDayRow(sheet, dateStr);
  if (row < 0) {
    row = HABIT_DAY_FIRST_ROW;
    const vals = sheet.getRange(HABIT_DAY_FIRST_ROW, 1, 33, 1).getValues();
    for (let i = 0; i < vals.length; i++) { if (!vals[i][0]) { row = HABIT_DAY_FIRST_ROW + i; break; } }
    sheet.getRange(row, 1).setValue(parseLocalDate(dateStr)).setNumberFormat('dd/MM/yyyy');
  }

  const nCols = Math.max(sheet.getLastColumn(), HABIT_DAY_HEADERS.length);
  const current = sheet.getRange(row, 1, 1, nCols).getValues()[0];
  const written = {};
  const colOf = f => _habitColOf(hmap, f);

  const setCell = (field, value, asText) => {
    const col = colOf(field);
    if (col < 0) return false;
    const rng = sheet.getRange(row, col);
    if (asText) rng.setNumberFormat('@');
    rng.setValue(value);
    return true;
  };
  const readCur = field => {
    const col = colOf(field);
    return col > 0 ? current[col - 1] : '';
  };

  // --- Horas (texto plano para esquivar el offset LMT de 1899) ---
  if (p.levante) { if (setCell('levante', p.levante, true)) written.levante = p.levante; }
  if (p.acoste)  { if (setCell('acoste',  p.acoste,  true)) written.acoste  = p.acoste;  }

  // --- Si se edita "acosté", recalcular el sueño del día SIGUIENTE ---
  if (p.acoste) {
    const cLev = colOf('levante'), cSue = colOf('hsSueno');
    if (cLev > 0 && cSue > 0) {
      const nextLev = _readHM(sheet.getRange(row + 1, cLev).getValue());
      if (nextLev) {
        const hsNext = _calcSleepHours(p.acoste, nextLev);
        if (hsNext != null) sheet.getRange(row + 1, cSue).setValue(hsNext);
      }
    }
  }

  // --- Hs sueño: acosté de AYER + levanté de HOY ---
  if (p.levante) {
    const acosteCol = colOf('acoste');
    let prevBed = null;
    if (row > HABIT_DAY_FIRST_ROW && acosteCol > 0) prevBed = sheet.getRange(row - 1, acosteCol).getValue();
    const hs = _calcSleepHours(_readHM(prevBed), p.levante);
    if (hs != null && setCell('hsSueno', hs)) written.hsSueno = hs;
  }

  // --- Numéricos simples ---
  const numFields = [
    ['trabajo', p.trabajo], ['avance', p.avance], ['animo', p.animo],
    ['ejercicioMin', p.ejercicioMin]
  ];
  for (const [field, raw] of numFields) {
    if (raw === undefined || raw === '' || raw === null) continue;
    const v = toNumber(String(raw).replace(',', '.'));
    if (v != null && setCell(field, v)) written[field] = v;
  }

  // --- Ejercicio (texto). El form manda el valor completo, así que reemplaza. ---
  if (p.ejercicio) {
    if (setCell('ejercicio', p.ejercicio)) written.ejercicio = p.ejercicio;
  }

  // --- Contadores con delta (agua, mast) ---
  const counters = [['agua', p.aguaDelta, p.agua], ['mast', p.mastDelta, p.mast]];
  for (const [field, delta, absolute] of counters) {
    if (delta !== undefined && delta !== '' && delta !== null) {
      const prev = toNumber(readCur(field)) || 0;
      let next = prev + (toNumber(delta) || 0);
      if (next < 0) next = 0;
      if (setCell(field, next)) written[field] = next;
    } else if (absolute !== undefined && absolute !== '' && absolute !== null) {
      const v = toNumber(absolute);
      if (v != null && setCell(field, v)) written[field] = v;
    }
  }

  // --- Notas. El form manda el texto completo, así que reemplaza. ---
  if (p.notas) {
    if (setCell('notas', p.notas)) written.notas = p.notas;
  }

  return { ok: true, tab: tabName, row: row, date: dateStr, written: written };
}

// Agrega una comida al log. p: { date, hora, comida, tipo }
function addMealEntry(p) {
  const comida = String(p.comida || p.item || '').trim();
  if (!comida) throw new Error('Falta el texto de la comida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const hora = p.hora || Utilities.formatDate(new Date(), 'America/Montevideo', 'HH:mm');
  const tabName = p.month || habitTabFor(dateStr);
  const sheet = getOrCreateHabitTab(ss, tabName);

  const cls = classifyMeal(comida, hora);
  const tipo = p.tipo || cls.tipo;
  // La foto (o una correccion manual) puede traer su propia clasificacion
  const macro     = (p.macro     !== undefined && p.macro     !== '') ? String(p.macro)     : cls.macro;
  const procesado = (p.procesado !== undefined && p.procesado !== '') ? String(p.procesado) : cls.procesado;
  const kcal      = (p.kcal      !== undefined && p.kcal      !== '') ? (toNumber(p.kcal) || '') : '';
  const ingr      = (p.ingredientes !== undefined) ? String(p.ingredientes || '') : '';

  const insertAt = _nextLogRow(sheet);

  // Formato ANTES de escribir: hora como texto plano (ver nota en getOrCreateHabitTab)
  sheet.getRange(insertAt, 2).setNumberFormat('@');
  sheet.getRange(insertAt, 1, 1, HABIT_MEAL_HEADERS.length).setValues([[
    parseLocalDate(dateStr), hora, comida, macro, tipo, procesado, 'Comida', '', kcal, ingr
  ]]);
  sheet.getRange(insertAt, 1).setNumberFormat('dd/MM/yyyy');

  return { ok: true, tab: tabName, row: insertAt,
           written: { comida: comida, hora: hora, macro: macro, tipo: tipo,
                      procesado: procesado, kcal: kcal, ingredientes: ingr,
                      source: (p.macro ? 'foto/manual' : cls.source) } };
}

// Estado de un día (para pre-cargar el form). Sin argumento = hoy.
function getHabitDay(dateOpt) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const dateStr = dateOpt || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
    const tabName = habitTabFor(dateStr);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return { ok: true, exists: false, date: dateStr, tab: tabName, meals: [], waters: [] };
    const row = _habitFindDayRow(sheet, dateStr);
    let day = null;
    if (row > 0) {
      const hmap = _habitHeaderMap(sheet);
      const nCols = Math.max(sheet.getLastColumn(), HABIT_DAY_HEADERS.length);
      const v = sheet.getRange(row, 1, 1, nCols).getValues()[0];
      const g = f => { const col = _habitColOf(hmap, f); return col > 0 ? v[col - 1] : ''; };
      day = {
        levante: _readHM(g('levante')),
        acoste:  _readHM(g('acoste')),
        hsSueno: toNumber(g('hsSueno')),
        trabajo: toNumber(g('trabajo')),
        avance:  toNumber(g('avance')),
        animo:   toNumber(g('animo')),
        ejercicio: String(g('ejercicio') || ''),
        ejercicioMin: toNumber(g('ejercicioMin')),
        agua: toNumber(g('agua')) || 0,
        mast: toNumber(g('mast')) || 0,
        notas: String(g('notas') || '')
      };
    }
    // Log del día: comidas y agua
    const meals = [], waters = [];
    const lastRow = sheet.getLastRow();
    if (lastRow >= HABIT_MEAL_FIRST_ROW) {
      const vals = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, HABIT_MEAL_HEADERS.length).getValues();
      const today = parseLocalDate(dateStr);
      const tKey = today.getFullYear() + '-' + today.getMonth() + '-' + today.getDate();
      for (let i = 0; i < vals.length; i++) {
        const r = vals[i];
        if (!r[0]) continue;
        const d = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0] : parseLocalDate(r[0]);
        if (!d) continue;
        if (d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() !== tKey) continue;
        // row = fila real en la hoja, sirve como id estable para editar/borrar
        const reg = String(r[6] || '').trim().toLowerCase();
        if (reg === 'agua') {
          waters.push({ row: HABIT_MEAL_FIRST_ROW + i, hora: _readHM(r[1]),
                        tipo: String(r[2] || ''), ml: toNumber(r[7]) || 0 });
        } else {
          meals.push({ row: HABIT_MEAL_FIRST_ROW + i, hora: _readHM(r[1]), comida: String(r[2] || ''),
                       macro: String(r[3] || ''), tipo: String(r[4] || ''), procesado: String(r[5] || ''),
                       kcal: toNumber(r[8]), ingredientes: String(r[9] || '') });
        }
      }
    }
    return { ok: true, exists: !!day, date: dateStr, tab: tabName, day: day, meals: meals, waters: waters };
  } catch (err) {
    Logger.log('getHabitDay error: ' + err.message);
    return { ok: false, error: err.message };
  }
}

function getHabitToday() { return getHabitDay(null); }

// Lee y agrega todos los datos del mes de hábitos
function readHabitMonth(tabName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return null;

  const hmap = _habitHeaderMap(sheet);
  const nCols = Math.max(sheet.getLastColumn(), HABIT_DAY_HEADERS.length);
  const days = [];
  const dayVals = sheet.getRange(HABIT_DAY_FIRST_ROW, 1, 33, nCols).getValues();
  for (const v of dayVals) {
    if (!v[0]) continue;
    const d = Object.prototype.toString.call(v[0]) === '[object Date]' ? v[0] : parseLocalDate(v[0]);
    if (!d) continue;
    const g = f => { const col = _habitColOf(hmap, f); return col > 0 ? v[col - 1] : ''; };
    const row = {
      date: Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM-dd'),
      dayNum: d.getDate(),
      levante: _readHM(g('levante')), acoste: _readHM(g('acoste')),
      hsSueno: toNumber(g('hsSueno')), trabajo: toNumber(g('trabajo')),
      avance: toNumber(g('avance')), animo: toNumber(g('animo')),
      ejercicio: String(g('ejercicio') || ''), ejercicioMin: toNumber(g('ejercicioMin')),
      agua: toNumber(g('agua')), mast: toNumber(g('mast')),
      notas: String(g('notas') || '')
    };
    row.hasData = !!(row.levante || row.acoste || row.trabajo != null || row.avance != null ||
                     row.animo != null || row.ejercicio || row.agua != null || row.mast != null);
    days.push(row);
  }

  const meals = [];
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const mv = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, HABIT_MEAL_HEADERS.length).getValues();
    for (const r of mv) {
      if (!r[0] || !String(r[2] || '').trim()) continue;
      if (String(r[6] || '').trim().toLowerCase() === 'agua') continue; // el agua no es comida
      const d = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0] : parseLocalDate(r[0]);
      meals.push({
        date: d ? Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM-dd') : '',
        hora: _readHM(r[1]), comida: String(r[2] || ''),
        macro: String(r[3] || ''), tipo: String(r[4] || ''), procesado: String(r[5] || ''),
        kcal: toNumber(r[8])
      });
    }
  }
  return { tab: tabName, days: days, meals: meals };
}

function _avg(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (!v.length) return null;
  return Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100;
}

// KPIs + correlaciones del mes
function getHabitsData(monthOpt) {
  try {
    const tabName = monthOpt || currentHabitTab();
    const data = readHabitMonth(tabName);
    if (!data) return { ok: false, error: 'Hoja "' + tabName + '" no existe todavía' };

    const filled = data.days.filter(d => d.hasData);
    const sleep = filled.map(d => d.hsSueno);
    const work  = filled.map(d => d.trabajo);
    const adv   = filled.map(d => d.avance);

    // Correlación: sueño >= 7hs vs < 7hs -> avance promedio
    const goodSleep = filled.filter(d => d.hsSueno != null && d.hsSueno >= 7 && d.avance != null);
    const badSleep  = filled.filter(d => d.hsSueno != null && d.hsSueno < 7  && d.avance != null);
    // Correlación: días con ultraprocesados vs sin
    const upDates = {};
    for (const m of data.meals) if (m.procesado === 'Alto') upDates[m.date] = true;
    const withUp    = filled.filter(d => upDates[d.date] && d.avance != null);
    const withoutUp = filled.filter(d => !upDates[d.date] && d.avance != null);

    // Macros del mes
    const macroCount = {};
    for (const m of data.meals) {
      for (const part of String(m.macro || '').split('+')) {
        const k = part.trim();
        if (k) macroCount[k] = (macroCount[k] || 0) + 1;
      }
    }
    const byMacro = Object.keys(macroCount)
      .map(k => ({ name: k, count: macroCount[k] }))
      .sort((a, b) => b.count - a.count);

    // Racha actual de días con avance >= 4
    let streak = 0;
    for (let i = filled.length - 1; i >= 0; i--) {
      if (filled[i].avance != null && filled[i].avance >= 4) streak++;
      else break;
    }

    // Correlación: días con ejercicio vs sin
    const withEx    = filled.filter(d => (d.ejercicio || (d.ejercicioMin || 0) > 0) && d.avance != null);
    const withoutEx = filled.filter(d => !d.ejercicio && !(d.ejercicioMin > 0) && d.avance != null);
    const exDays = filled.filter(d => d.ejercicio || (d.ejercicioMin || 0) > 0);
    const aguaVals = filled.map(d => d.agua).filter(x => x != null && x > 0);

    // Tipos de ejercicio más frecuentes
    const exCount = {};
    for (const d of exDays) {
      for (const part of String(d.ejercicio || '').split('+')) {
        const k = part.trim();
        if (k) exCount[k] = (exCount[k] || 0) + 1;
      }
    }
    const byEjercicio = Object.keys(exCount)
      .map(k => ({ name: k, count: exCount[k] }))
      .sort((a, b) => b.count - a.count);

    return {
      ok: true,
      tab: tabName,
      daysTracked: filled.length,
      totalMeals: data.meals.length,
      avg: {
        sueno: _avg(sleep),
        trabajo: _avg(work),
        avance: _avg(adv),
        animo: _avg(filled.map(d => d.animo)),
        agua: _avg(aguaVals)
      },
      totals: {
        trabajo: Math.round(work.filter(x => x != null).reduce((s, x) => s + x, 0) * 100) / 100,
        mast: filled.map(d => d.mast).filter(x => x != null).reduce((s, x) => s + x, 0),
        agua: aguaVals.reduce((s, x) => s + x, 0),
        ejercicioMin: filled.map(d => d.ejercicioMin).filter(x => x != null).reduce((s, x) => s + x, 0),
        ejercicioDias: exDays.length
      },
      streak: streak,
      byEjercicio: byEjercicio,
      correlations: {
        sleepGood: { n: goodSleep.length, avance: _avg(goodSleep.map(d => d.avance)) },
        sleepBad:  { n: badSleep.length,  avance: _avg(badSleep.map(d => d.avance)) },
        withUltraprocesado:    { n: withUp.length,    avance: _avg(withUp.map(d => d.avance)) },
        withoutUltraprocesado: { n: withoutUp.length, avance: _avg(withoutUp.map(d => d.avance)) },
        withEjercicio:    { n: withEx.length,    avance: _avg(withEx.map(d => d.avance)),    animo: _avg(withEx.map(d => d.animo)) },
        withoutEjercicio: { n: withoutEx.length, avance: _avg(withoutEx.map(d => d.avance)), animo: _avg(withoutEx.map(d => d.animo)) }
      },
      byMacro: byMacro,
      days: filled.map(d => ({ dayNum: d.dayNum, hsSueno: d.hsSueno, trabajo: d.trabajo, avance: d.avance, agua: d.agua, ejercicioMin: d.ejercicioMin })),
      recentMeals: data.meals.slice(-10).reverse()
    };
  } catch (err) {
    Logger.log('getHabitsData error: ' + err.message);
    return { ok: false, error: err.message };
  }
}

// Lee una celda de hora tolerando que Sheets la haya guardado como Date.
// Usa getHours/getMinutes en UTC para esquivar el offset LMT de 1899.
function _readHM(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'UTC', 'HH:mm');
  }
  return String(v).trim();
}

// Repara una hoja de hábitos existente: pone las columnas de hora en formato
// texto y reescribe los valores que quedaron como Date.
function repairHabitFormats(monthOpt) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = monthOpt || currentHabitTab();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Hoja "' + tabName + '" no existe' };

  let fixed = 0;
  // Tabla diaria: columnas de hora, resueltas por nombre
  const hmapR = _habitHeaderMap(sheet);
  const cLev = _habitColOf(hmapR, 'levante');
  const cAco = _habitColOf(hmapR, 'acoste');
  const firstHour = Math.min(cLev > 0 ? cLev : 2, cAco > 0 ? cAco : 3);
  const dayRange = sheet.getRange(HABIT_DAY_FIRST_ROW, firstHour, 40, 2);
  const dayVals = dayRange.getValues();
  const outDay = dayVals.map(r => r.map(v => {
    if (Object.prototype.toString.call(v) === '[object Date]') { fixed++; return _readHM(v); }
    return v === '' ? '' : String(v);
  }));
  dayRange.setNumberFormat('@');
  dayRange.setValues(outDay);

  // Log de comidas: col 2
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const n = lastRow - HABIT_MEAL_FIRST_ROW + 1;
    const mr = sheet.getRange(HABIT_MEAL_FIRST_ROW, 2, n, 1);
    const mv = mr.getValues();
    const outMeal = mv.map(r => {
      const v = r[0];
      if (Object.prototype.toString.call(v) === '[object Date]') { fixed++; return [_readHM(v)]; }
      return [v === '' ? '' : String(v)];
    });
    mr.setNumberFormat('@');
    mr.setValues(outMeal);
  }
  return { ok: true, tab: tabName, cellsFixed: fixed };
}

// Limpia los datos de una hoja de hábitos conservando estructura y fechas.
// Requiere confirm=SI para evitar borrados accidentales.
function resetHabitMonth(monthOpt, confirm) {
  if (String(confirm || '').toUpperCase() !== 'SI') {
    return { ok: false, error: 'Agregá &confirm=SI para confirmar el borrado' };
  }
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = monthOpt || currentHabitTab();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Hoja "' + tabName + '" no existe' };

  // Tabla diaria: limpiar todo menos la columna de fechas
  const nC = Math.max(sheet.getLastColumn(), HABIT_DAY_HEADERS.length);
  sheet.getRange(HABIT_DAY_FIRST_ROW, 2, 40, nC - 1).clearContent();
  const hm = _habitHeaderMap(sheet);
  for (const f of ['levante', 'acoste']) {
    const col = _habitColOf(hm, f);
    if (col > 0) sheet.getRange(HABIT_DAY_FIRST_ROW, col, 40, 1).setNumberFormat('@');
  }

  // Log de comidas: limpiar todo
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, HABIT_MEAL_HEADERS.length).clearContent();
  }
  sheet.getRange(HABIT_MEAL_FIRST_ROW, 2, 600, 1).setNumberFormat('@');
  return { ok: true, tab: tabName, msg: 'Datos limpiados (estructura y fechas conservadas)' };
}




// Devuelve si hay algo sin cargar en el dia, segun la hora.
// Pensado para que un atajo del celular lo consulte y solo muestre la
// notificacion cuando pending = true.
function habitPending(opts) {
  try {
    const now = new Date();
    const dateStr = Utilities.formatDate(now, 'America/Montevideo', 'yyyy-MM-dd');
    const hourNow = parseInt(Utilities.formatDate(now, 'America/Montevideo', 'HH'), 10);
    const minNow  = parseInt(Utilities.formatDate(now, 'America/Montevideo', 'mm'), 10);
    const tNow = hourNow + minNow / 60;

    const desde = (opts && opts.desde != null) ? Number(opts.desde) : 9;   // no molestar antes
    const hasta = (opts && opts.hasta != null) ? Number(opts.hasta) : 23;  // ni después

    const base = { ok: true, date: dateStr, hora: Utilities.formatDate(now, 'America/Montevideo', 'HH:mm') };
    if (tNow < desde || tNow > hasta) {
      return Object.assign(base, { pending: false, pendingNum: 0, title: '', msg: 'Fuera de la franja horaria' });
    }

    const day = getHabitDay(dateStr);
    if (!day || !day.ok) return Object.assign(base, { pending: false, pendingNum: 0, title: '', msg: 'Sin datos' });

    const d = day.day || {};
    const meals = day.meals || [];
    const waters = day.waters || [];
    const faltantes = [];

    // --- Sueño ---
    if (tNow >= 10 && !d.levante) faltantes.push('marcá a qué hora te levantaste');

    // --- Agua: ritmo esperado entre las 8 y las 22 ---
    const totalAgua = waters.reduce((s, w) => s + (w.ml || 0), 0);
    const ini = 8, fin = 22;
    let esperado = 0;
    if (tNow > ini) esperado = Math.round(WATER_GOAL_ML * Math.min((tNow - ini) / (fin - ini), 1));
    // Margen de un vaso para no ser molesto
    if (totalAgua < esperado - 250) {
      const faltan = esperado - totalAgua;
      faltantes.push('vas ' + totalAgua + ' ml de agua, deberías ir por ' + esperado +
                     ' (te faltan ~' + Math.ceil(faltan / 250) + ' vasos)');
    }

    // --- Comidas segun la hora ---
    const tipos = {};
    for (const m of meals) tipos[String(m.tipo || '').toLowerCase()] = true;
    if (tNow >= 11.5 && !tipos['desayuno']) faltantes.push('no cargaste el desayuno');
    if (tNow >= 15.5 && !tipos['almuerzo']) faltantes.push('no cargaste el almuerzo');
    if (tNow >= 22   && !tipos['cena'])     faltantes.push('no cargaste la cena');

    // --- Cierre del día ---
    if (tNow >= 21) {
      if (d.avance == null)  faltantes.push('falta el avance del día');
      if (d.trabajo == null) faltantes.push('faltan las horas trabajadas');
    }

    const pending = faltantes.length > 0;
    let title = '', msg = '';
    if (pending) {
      title = faltantes.length === 1 ? '🧘 Te falta algo' : '🧘 Te faltan ' + faltantes.length + ' cosas';
      // Mayúscula inicial en el primero
      msg = faltantes.map((f, i) => i === 0 ? f.charAt(0).toUpperCase() + f.slice(1) : f).join(' · ');
    } else {
      msg = 'Todo al día ✓';
    }

    return Object.assign(base, {
      pending: pending,
      pendingNum: pending ? 1 : 0,   // 1/0 para que el atajo lo compare fácil
      count: faltantes.length,
      title: title,
      msg: msg,
      faltantes: faltantes,
      agua: totalAgua,
      aguaEsperado: esperado,
      aguaObjetivo: WATER_GOAL_ML
    });
  } catch (err) {
    Logger.log('habitPending error: ' + err.message);
    return { ok: false, pending: false, pendingNum: 0, error: err.message };
  }
}


// Analiza una foto de comida con Gemini Vision y devuelve que es y que tiene.
// No guarda nada: el form muestra el resultado para revisar antes de agregar.
function scanMeal(base64Image, horaOpt) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
    if (!key) return { ok: false, error: 'No hay GEMINI_KEY configurada' };
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
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
        ]
      }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: {
          type: 'object',
          properties: {
            nombre: { type: 'string' },
            ingredientes: { type: 'string' },
            macro: { type: 'string' },
            procesado: { type: 'string' },
            kcal: { type: 'number' },
            confianza: { type: 'string' }
          },
          required: ['nombre', 'ingredientes', 'macro', 'procesado', 'kcal', 'confianza']
        },
        temperature: 0.1
      }
    };

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
    const resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      return { ok: false, error: 'Gemini HTTP ' + resp.getResponseCode() };
    }
    const parsed = JSON.parse(resp.getContentText());
    let txt = parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content &&
              parsed.candidates[0].content.parts[0].text;
    if (!txt) return { ok: false, error: 'Respuesta vacía de Gemini' };
    const r = JSON.parse(txt.replace(/```json|```/g, '').trim());

    if (!String(r.nombre || '').trim()) {
      return { ok: false, error: 'No se reconoció comida en la foto. Probá otra foto o escribilo a mano.' };
    }

    const hora = horaOpt || Utilities.formatDate(new Date(), 'America/Montevideo', 'HH:mm');
    return {
      ok: true,
      nombre: String(r.nombre).trim(),
      ingredientes: String(r.ingredientes || '').trim(),
      macro: String(r.macro || 'Otros').trim(),
      procesado: String(r.procesado || 'Medio').trim(),
      kcal: Math.round(Number(r.kcal) || 0),
      confianza: String(r.confianza || 'Media').trim(),
      tipo: _mealTypeByHour(hora),
      hora: hora
    };
  } catch (err) {
    Logger.log('scanMeal error: ' + err.message);
    return { ok: false, error: err.message };
  }
}

function scanMealSafe(base64Image, hora) {
  try { return scanMeal(base64Image, hora); }
  catch (err) { return { ok: false, error: err.message }; }
}

// ---- AGUA como registro de tomas -------------------------------------------

// Etiqueta segun la cantidad (para cuando se carga un ml libre)
function _waterLabel(ml) {
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

// Recalcula el total de agua del dia sumando el log y lo escribe en la
// columna "Agua (ml)" de la tabla diaria.
function _recalcWaterTotal(sheet, dateStr) {
  const target = parseLocalDate(dateStr);
  if (!target) return 0;
  const tKey = target.getFullYear() + '-' + target.getMonth() + '-' + target.getDate();

  let total = 0;
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const vals = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, HABIT_MEAL_HEADERS.length).getValues();
    for (const r of vals) {
      if (!r[0]) continue;
      if (String(r[6] || '').trim().toLowerCase() !== 'agua') continue;
      const d = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0] : parseLocalDate(r[0]);
      if (!d) continue;
      if (d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() !== tKey) continue;
      total += toNumber(r[7]) || 0;
    }
  }

  const hmap = _habitHeaderMap(sheet);
  const col = _habitColOf(hmap, 'agua');
  if (col > 0) {
    let row = _habitFindDayRow(sheet, dateStr);
    if (row > 0) sheet.getRange(row, col).setValue(total);
  }
  return total;
}

// Agrega una toma de agua. p: { date, ml, tipo, hora }
function addWaterEntry(p) {
  const ml = toNumber(String(p.ml != null ? p.ml : '').replace(',', '.'));
  if (ml == null || ml <= 0) throw new Error('Cantidad de agua inválida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const hora = p.hora || Utilities.formatDate(new Date(), 'America/Montevideo', 'HH:mm');
  const tabName = p.month || habitTabFor(dateStr);
  const sheet = getOrCreateHabitTab(ss, tabName);
  const tipo = String(p.tipo || '').trim() || _waterLabel(ml);

  const insertAt = _nextLogRow(sheet);
  sheet.getRange(insertAt, 2).setNumberFormat('@');
  sheet.getRange(insertAt, 1, 1, HABIT_MEAL_HEADERS.length).setValues([[
    parseLocalDate(dateStr), hora, tipo, '', 'Agua', '', 'Agua', ml, '', ''
  ]]);
  sheet.getRange(insertAt, 1).setNumberFormat('dd/MM/yyyy');

  const total = _recalcWaterTotal(sheet, dateStr);
  return { ok: true, tab: tabName, row: insertAt, total: total,
           written: { ml: ml, tipo: tipo, hora: hora } };
}

// Edita una toma. p: { row, ml, tipo, hora, date }
function updateWaterEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < HABIT_MEAL_FIRST_ROW) throw new Error('Fila inválida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = p.month || (p.date ? habitTabFor(p.date) : currentHabitTab());
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Hoja "' + tabName + '" no existe');

  const cur = sheet.getRange(row, 1, 1, HABIT_MEAL_HEADERS.length).getValues()[0];
  if (String(cur[6] || '').trim().toLowerCase() !== 'agua') throw new Error('Esa fila no es un registro de agua');

  let ml = (p.ml !== undefined && p.ml !== '') ? toNumber(String(p.ml).replace(',', '.')) : toNumber(cur[7]);
  if (ml == null || ml <= 0) throw new Error('Cantidad inválida');
  const hora = (p.hora !== undefined && p.hora !== '') ? String(p.hora).trim() : _readHM(cur[1]);
  const mlChanged = ml !== toNumber(cur[7]);
  const tipo = (p.tipo !== undefined && p.tipo !== '') ? String(p.tipo).trim()
             : (mlChanged ? _waterLabel(ml) : String(cur[2] || ''));

  sheet.getRange(row, 2).setNumberFormat('@');
  sheet.getRange(row, 2, 1, 7).setValues([[hora, tipo, '', 'Agua', '', 'Agua', ml]]);

  const dateStr = p.date || Utilities.formatDate(
    Object.prototype.toString.call(cur[0]) === '[object Date]' ? cur[0] : parseLocalDate(cur[0]),
    'America/Montevideo', 'yyyy-MM-dd');
  const total = _recalcWaterTotal(sheet, dateStr);
  return { ok: true, tab: tabName, row: row, total: total, written: { ml: ml, tipo: tipo, hora: hora } };
}

// Borra una toma de agua.
function deleteWaterEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < HABIT_MEAL_FIRST_ROW) throw new Error('Fila inválida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = p.month || (p.date ? habitTabFor(p.date) : currentHabitTab());
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Hoja "' + tabName + '" no existe');

  const cur = sheet.getRange(row, 1, 1, HABIT_MEAL_HEADERS.length).getValues()[0];
  if (String(cur[6] || '').trim().toLowerCase() !== 'agua') throw new Error('Esa fila no es un registro de agua');

  const d = Object.prototype.toString.call(cur[0]) === '[object Date]' ? cur[0] : parseLocalDate(cur[0]);
  const dateStr = p.date || Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM-dd');
  const ml = toNumber(cur[7]) || 0;
  const tipo = String(cur[2] || '');

  sheet.deleteRow(row);
  const total = _recalcWaterTotal(sheet, dateStr);
  return { ok: true, tab: tabName, deleted: tipo + ' (' + ml + ' ml)', total: total };
}

// Primera fila libre del log (mira la col A, que la usan comidas y agua)
function _nextLogRow(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < HABIT_MEAL_FIRST_ROW) return HABIT_MEAL_FIRST_ROW;
  const n = lastRow - HABIT_MEAL_FIRST_ROW + 1;
  const vals = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, n, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (!String(vals[i][0] || '').trim()) return HABIT_MEAL_FIRST_ROW + i;
  }
  return HABIT_MEAL_FIRST_ROW + n;
}

// Agrega al log las columnas Registro/ml si la hoja es de antes del cambio,
// y marca como "Comida" las filas viejas.
function migrateLogTable(sheet) {
  const hdrs = sheet.getRange(HABIT_MEAL_HEADER_ROW, 1, 1, HABIT_MEAL_HEADERS.length).getValues()[0];
  const norm = hdrs.map(h => _stripAccents(String(h || '').trim()));
  let changed = false;

  if (norm[2] === 'comida') { sheet.getRange(HABIT_MEAL_HEADER_ROW, 3).setValue('Detalle'); changed = true; }
  if (norm[6] !== 'registro') {
    sheet.getRange(HABIT_MEAL_HEADER_ROW, 7).setValue('Registro').setFontWeight('bold').setBackground('#fef3c7');
    changed = true;
  }
  if (norm[7] !== 'ml') {
    sheet.getRange(HABIT_MEAL_HEADER_ROW, 8).setValue('ml').setFontWeight('bold').setBackground('#fef3c7');
    changed = true;
  }
  if (norm[8] !== 'kcal') {
    sheet.getRange(HABIT_MEAL_HEADER_ROW, 9).setValue('kcal').setFontWeight('bold').setBackground('#fef3c7');
    changed = true;
  }
  if (norm[9] !== 'ingredientes') {
    sheet.getRange(HABIT_MEAL_HEADER_ROW, 10).setValue('Ingredientes').setFontWeight('bold').setBackground('#fef3c7');
    sheet.setColumnWidth(10, 260);
    changed = true;
  }
  sheet.getRange(HABIT_MEAL_TITLE_ROW, 1).setValue(HABIT_MEAL_TITLE);

  // Backfill: filas con detalle pero sin Registro -> son comidas viejas
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const n = lastRow - HABIT_MEAL_FIRST_ROW + 1;
    const rng = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, n, HABIT_MEAL_HEADERS.length);
    const vals = rng.getValues();
    let touched = false;
    const out = vals.map(r => {
      if (r[0] && String(r[2] || '').trim() && !String(r[6] || '').trim()) {
        r[6] = 'Comida'; touched = true;
      }
      return r;
    });
    if (touched) { rng.setValues(out); changed = true; }
  }
  return changed;
}

// Edita una comida ya cargada. p: { row, comida, hora, macro, tipo, month }
// - si cambia el texto y no mandan macro -> reclasifica
// - si cambia la hora -> recalcula el tipo (desayuno/almuerzo/...)
function updateMealRow(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < HABIT_MEAL_FIRST_ROW) throw new Error('Fila de comida inválida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = p.month || (p.date ? habitTabFor(p.date) : currentHabitTab());
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Hoja "' + tabName + '" no existe');

  const cur = sheet.getRange(row, 1, 1, HABIT_MEAL_HEADERS.length).getValues()[0];
  if (!String(cur[2] || '').trim()) throw new Error('Esa fila no tiene una comida cargada');

  const comida = (p.comida !== undefined && p.comida !== '') ? String(p.comida).trim() : String(cur[2]);
  const hora   = (p.hora   !== undefined && p.hora   !== '') ? String(p.hora).trim()   : _readHM(cur[1]);

  let macro = (p.macro !== undefined && p.macro !== '') ? String(p.macro).trim() : null;
  let tipo  = (p.tipo  !== undefined && p.tipo  !== '') ? String(p.tipo).trim()  : null;
  let procesado = String(cur[5] || '');

  const textChanged = comida !== String(cur[2]);
  if (macro === null && textChanged) {
    const cls = classifyMeal(comida, hora);
    macro = cls.macro;
    procesado = cls.procesado;
  } else if (macro === null) {
    macro = String(cur[3] || '');
  }
  if (tipo === null) tipo = _mealTypeByHour(hora) || String(cur[4] || '');

  sheet.getRange(row, 2).setNumberFormat('@');
  sheet.getRange(row, 2, 1, 5).setValues([[hora, comida, macro, tipo, procesado]]);

  return { ok: true, tab: tabName, row: row,
           written: { hora: hora, comida: comida, macro: macro, tipo: tipo, procesado: procesado } };
}

// Borra una comida. Elimina la fila entera para no dejar huecos en el log.
function deleteMealRow(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < HABIT_MEAL_FIRST_ROW) throw new Error('Fila de comida inválida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = p.month || (p.date ? habitTabFor(p.date) : currentHabitTab());
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Hoja "' + tabName + '" no existe');

  const cur = sheet.getRange(row, 1, 1, HABIT_MEAL_HEADERS.length).getValues()[0];
  const comida = String(cur[2] || '').trim();
  if (!comida) throw new Error('Esa fila ya está vacía');

  sheet.deleteRow(row);
  return { ok: true, tab: tabName, row: row, deleted: comida };
}

// Borra los datos de UN día (deja la fecha). Requiere confirm=SI.
function clearHabitDay(dateOpt, confirm) {
  if (String(confirm || '').toUpperCase() !== 'SI') {
    return { ok: false, error: 'Agregá confirm=SI para confirmar' };
  }
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const dateStr = dateOpt || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const tabName = habitTabFor(dateStr);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ok: false, error: 'Hoja "' + tabName + '" no existe' };

  const row = _habitFindDayRow(sheet, dateStr);
  let clearedMeals = 0;
  if (row > 0) {
    const nC = Math.max(sheet.getLastColumn(), HABIT_DAY_HEADERS.length);
    sheet.getRange(row, 2, 1, nC - 1).clearContent();
    const hm = _habitHeaderMap(sheet);
    for (const f of ['levante', 'acoste']) {
      const col = _habitColOf(hm, f);
      if (col > 0) sheet.getRange(row, col).setNumberFormat('@');
    }
  }
  // Borrar las comidas de ese día (de abajo hacia arriba para no correr los índices)
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const target = parseLocalDate(dateStr);
    const tKey = target.getFullYear() + '-' + target.getMonth() + '-' + target.getDate();
    const vals = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, 3).getValues();
    for (let i = vals.length - 1; i >= 0; i--) {
      const v = vals[i];
      if (!v[0] || !String(v[2] || '').trim()) continue;
      const d = Object.prototype.toString.call(v[0]) === '[object Date]' ? v[0] : parseLocalDate(v[0]);
      if (!d) continue;
      if (d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() === tKey) {
        sheet.deleteRow(HABIT_MEAL_FIRST_ROW + i);
        clearedMeals++;
      }
    }
  }
  return { ok: true, tab: tabName, date: dateStr, clearedMeals: clearedMeals };
}

// === Wrappers para google.script.run (siempre devuelven objeto plano) ===
function habitDaySafe(data) {
  try { return upsertHabitDay(data || {}); }
  catch (err) { Logger.log('habitDaySafe: ' + err.message); return { ok: false, error: err.message }; }
}

function addMealSafe(data) {
  try { return addMealEntry(data || {}); }
  catch (err) { Logger.log('addMealSafe: ' + err.message); return { ok: false, error: err.message }; }
}

function getHabitsDataSafe(month) {
  try { return getHabitsData(month); }
  catch (err) { return { ok: false, error: err.message }; }
}

function getHabitTodaySafe() {
  try { return getHabitToday(); }
  catch (err) { return { ok: false, error: err.message }; }
}

function getHabitDaySafe(dateStr) {
  try { return getHabitDay(dateStr); }
  catch (err) { return { ok: false, error: err.message }; }
}

function updateMealSafe(data) {
  try { return updateMealRow(data || {}); }
  catch (err) { Logger.log('updateMealSafe: ' + err.message); return { ok: false, error: err.message }; }
}

function deleteMealSafe(data) {
  try { return deleteMealRow(data || {}); }
  catch (err) { Logger.log('deleteMealSafe: ' + err.message); return { ok: false, error: err.message }; }
}

function addWaterSafe(data) {
  try { return addWaterEntry(data || {}); }
  catch (err) { Logger.log('addWaterSafe: ' + err.message); return { ok: false, error: err.message }; }
}

function updateWaterSafe(data) {
  try { return updateWaterEntry(data || {}); }
  catch (err) { Logger.log('updateWaterSafe: ' + err.message); return { ok: false, error: err.message }; }
}

function deleteWaterSafe(data) {
  try { return deleteWaterEntry(data || {}); }
  catch (err) { Logger.log('deleteWaterSafe: ' + err.message); return { ok: false, error: err.message }; }
}

function clearHabitDaySafe(dateStr) {
  try { return clearHabitDay(dateStr, 'SI'); }
  catch (err) { return { ok: false, error: err.message }; }
}
