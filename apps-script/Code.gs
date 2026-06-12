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
  const topCategorias = Object.keys(byCat).map(name => ({
    name: name, uyu: round2(byCat[name].uyu), usd: round2(byCat[name].usd), count: byCat[name].count
  })).sort((a, b) => (b.uyu + b.usd * FX) - (a.uyu + a.usd * FX)).slice(0, 5);

  // Top items por monto (UYU equivalente)
  const topItems = items.slice().sort((a, b) => (b.uyu + b.usd * FX) - (a.uyu + a.usd * FX))
    .slice(0, 5)
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
    topItems: topItems,
    sameCotizBatches: sameCotizBatches
  };
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
