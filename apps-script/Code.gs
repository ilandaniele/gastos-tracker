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
  'Hogar','Limpieza','Ropa','Regalos','Gimnasio','Servicios','Viajes',
  'Acciones/Bonos/Ahorros','Otros'
];

const CARDS = ['Débito UYU','Crédito OCA','Crédito Itaú UYU','Crédito Itaú USD','Débito USD','Efectivo UYU','Efectivo USD'];

// Categorías ordenadas alfabéticamente para mostrar, con "Otros" al final:
// es el cajón de sastre y en el medio de la lista molesta más que ayuda.
function categoriasOrdenadas() {
  const resto = CATEGORIES.filter(c => c !== 'Otros')
    .sort((a, b) => a.localeCompare(b, 'es'));
  return CATEGORIES.indexOf('Otros') >= 0 ? resto.concat(['Otros']) : resto;
}

// CAT_RULES en un formato que se pueda mandar al cliente. Los regex no
// sobreviven a JSON, asi que van como source + flags y el form los rearma.
// De esta manera las reglas siguen viviendo en un solo lugar.
function catRulesSerializables() {
  return CAT_RULES.map(([re, cat]) => ({ source: re.source, flags: re.flags, cat: cat }));
}

// === HABITOS: constantes ===
const HABIT_PREFIX = 'Hábitos ';
const HABIT_DAY_HEADERS = ['Fecha','Levanté','Acosté','Hs sueño','Hs trabajo','Avance','Ánimo','Ejercicio','Min ejerc.','Medité','Min medit.','Leí','Abordajes','Agua (ml)','Masturbación','Notas'];

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
  medite:       'Medité',
  mediteMin:    'Min medit.',
  lei:          'Leí',
  abordajes:    'Abordajes',
  agua:         'Agua (ml)',
  mast:         'Masturbación',
  notas:        'Notas'
};
// Normaliza cualquier forma de sí/no a "Sí"/"No" (o '' si no se entiende)
function _siNo(v) {
  const s = _stripAccents(String(v == null ? '' : v)).toLowerCase().trim();
  if (!s) return '';
  if (['si', 'sí', 'yes', 'y', '1', 'true', 'ok', 'x'].indexOf(s) >= 0) return 'Sí';
  if (['no', 'n', '0', 'false'].indexOf(s) >= 0) return 'No';
  return '';
}

const HABIT_MEAL_TITLE = 'REGISTRO DEL DÍA (comidas, agua y ejercicio)';
// La columna 8 es la cantidad numérica del registro: ml si es agua, minutos si
// es ejercicio. Las comidas no la usan. La columna 7 (Registro) es la que
// distingue los tres tipos de fila.
const HABIT_MEAL_HEADERS = ['Fecha','Hora','Detalle','Macro','Tipo','Procesado','Registro','ml / min','kcal','Ingredientes'];

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
// La tabla diaria son 31 filas (3..33). Varios rangos usaban 40 por las
// dudas y se comian el titulo del log (36) y sus encabezados (37): un reset
// llegaba a borrarlos. Todo lo que toque la tabla diaria usa esta constante.
const HABIT_DAY_ROWS = 31;
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
  habitDay: p => saveHabitDayData(p),
  addMeal: p => addMealEntry(p),
  habitToday: p => getHabitDay(p.date || null),
  updateMeal: p => updateMealRow(p),
  deleteMeal: p => deleteMealRow(p),
  habitPending: p => habitPending(p),
  echoParams: p => ({ ok: true, p: p }),
  argData: p => getArgentinaData(p.month),
  ahorros: () => getSavingsData(),
  addAhorro: p => addSavingsEntry(p),
  updateAhorro: p => updateSavingsEntry(p),
  deleteAhorro: p => deleteSavingsEntry(p),
  addIngreso: p => addIngresoEntry(p),
  getIngresos: () => getIngresosData(),
  deleteIngreso: p => deleteIngresoEntry(p),
  // === TAREAS ===
  tareas: () => getTasksData(),
  addTarea: p => addTaskEntry(p),
  updateTarea: p => updateTaskEntry(p),
  toggleTarea: p => toggleTaskEntry(p),
  deleteTarea: p => deleteTaskEntry(p),
  bumpTarea: p => bumpTaskEntry(p),
  tasksPending: () => tasksPending(),
  sendTasksReport: p => sendDailyTasksEmail(p.email),
  installTasksTrigger: p => installDailyTasksTrigger(p.hour),
  removeTasksTrigger: () => removeDailyTasksTrigger(),
  precioAccion: p => {
    const px = fetchStockPrice(p.ticker);
    return px ? { ok: true, ticker: String(p.ticker).toUpperCase(), ...px }
              : { ok: false, error: 'No se pudo traer el precio de ' + p.ticker };
  },
  argAdd: p => addArgentinaEntry(p),
  argUpdate: p => updateArgentinaEntry(p),
  argDelete: p => deleteArgentinaEntry(p),
  argDeudaAntes: p => setArgDeudaAntes(p.month, p.usd),
  listSheets: () => listSheets(),
  deleteHabitSheet: p => deleteHabitSheetIfEmpty(p.month, p.confirm),
  reorderSheets: p => reorderSheets(String(p.dryRun || '') === '1'),
  addWater: p => addWaterEntry(p),
  addExercise: p => addExerciseEntry(p),
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
  // Fija o cambia la clave de acceso. Una vez puesta, para cambiarla hay que
  // mandar la vigente (el propio chequeo de doGet ya la exige).
  setAppKey: p => {
    if (!p.nueva) throw new Error('Falta param "nueva"');
    PropertiesService.getScriptProperties().setProperty('APP_KEY', String(p.nueva));
    return { ok: true, msg: 'Clave guardada', largo: String(p.nueva).length };
  },
  hasAppKey: () => ({ ok: true, tieneClave: !!_appKey() }),
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
  deleteExpense: p => deleteExpenseRow(p),
  // Debug: dump crudo de una region — ?action=dumpGrid&month=Agosto%202026&r=1&c=1&rows=40&cols=28
  dumpGrid: p => {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(p.month || currentMonthTab());
    if (!sheet) return { ok: false, error: 'No existe la hoja' };
    const r = parseInt(p.r || 1, 10), c = parseInt(p.c || 1, 10);
    const rows = Math.min(parseInt(p.rows || 40, 10), sheet.getMaxRows() - r + 1);
    const cols = Math.min(parseInt(p.cols || 28, 10), sheet.getMaxColumns() - c + 1);
    const vals = sheet.getRange(r, c, rows, cols).getValues().map(row => row.map(v => {
      if (v === '' || v === null) return '';
      if (Object.prototype.toString.call(v) === '[object Date]') {
        return 'D:' + Utilities.formatDate(v, 'America/Montevideo', 'yyyy-MM-dd HH:mm');
      }
      return v;
    }));
    return { ok: true, tab: sheet.getName(), from: [r, c], maxRows: sheet.getMaxRows(),
             maxCols: sheet.getMaxColumns(), lastRow: sheet.getLastRow(),
             lastCol: sheet.getLastColumn(), values: vals };
  },
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

// === Puerta de entrada ===
// El web app está publicado como "cualquiera con el link", que es lo que
// permite que el Worker y los Atajos le peguen sin sesión de Google. Para que
// ese link no alcance por sí solo, todo pide una clave que vive en Script
// Properties y que solo conoce la PWA.
//
// Si la clave no está configurada NO se exige nada: así una configuración a
// medias no deja a nadie afuera de sus propios datos.
function _appKey() {
  return PropertiesService.getScriptProperties().getProperty('APP_KEY') || '';
}
function _autorizado(p) {
  const need = _appKey();
  if (!need) return true;
  return String(p.k || p.key || '') === need;
}

function _paginaNoAutorizado() {
  return HtmlService.createHtmlOutput(
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'margin:0;padding:60px 28px;color:#111827;background:#f6f7f9}' +
    'h1{font-size:20px;margin:0 0 10px}p{color:#4b5563;line-height:1.5;font-size:15px}</style>' +
    '</head><body><h1>🔒 No autorizado</h1>' +
    '<p>Esta app es privada. Entrá desde el ícono de <b>Gastos</b> en tu pantalla de inicio.</p>' +
    '</body></html>')
    .setTitle('No autorizado')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doGet(e) {
  const p = (e && e.parameter) || {};

  if (!_autorizado(p)) {
    Logger.log('Acceso sin clave: ' + JSON.stringify(Object.keys(p)));
    if (p.action || p.item) return json({ ok: false, error: 'No autorizado' });
    return _paginaNoAutorizado();
  }

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
  // Las opciones y las reglas se generan desde el backend para que no haya
  // dos listas de categorías que se puedan desincronizar.
  t.categoryOptions = categoriasOrdenadas()
    .map(c => '<option>' + c + '</option>').join('');
  t.catRulesJson = JSON.stringify(catRulesSerializables());
  t.categoriasJson = JSON.stringify(categoriasOrdenadas());
  // El mapa de empresas vive solo en Code.gs; el form lo usa para armar el
  // selector y para saber de que dominio sacar el logo.
  t.tickersJson = JSON.stringify(TICKER_INFO);
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
  // Primero: la plata que va a ahorro no es consumo. Van en PLURAL a proposito:
  // en singular "bono" es el aguinaldo o un vale, y "accion" es accion de
  // gracias — los dos caian mal en esta categoria.
  [/acciones\b|bonos\b|broker|interactive brokers|ibkr|etf\b|cedear|nvda|nvidia|s&p ?500|sp500|inversi[oó]n|invertir|ahorro/i, 'Acciones/Bonos/Ahorros'],
  [/^(forros|preservativ|condon)/i, 'Salud'], // explicit before "jabón"
  [/medicamento|farmashop|farmacia|farmacity|an[aá]lisis|dentista|hospital|cl[ií]nica|bluecross|blue cross|aflusan|vozama|duspatalin|dumirox|drogu|polish/i, 'Salud'],
  // Viajes va ANTES que Transporte: classifyItem devuelve la primera regla que
  // matchea, y palabras como "pasaje" o "buque" caian en Transporte.
  [/pasaje|vuelo|aerol[ií]nea|avianca|latam|iberia|aeropuerto|hotel|hostel|airbnb|hospedaje|buquebus|colonia express|migraciones|pasaporte|tasa de embarque|equipaje|valija|excursi[oó]n|city tour|alquiler de auto|rent a car|peaje|free shop|seguro de viaje|viaje/i, 'Viajes'],
  [/bus|taxi|uber|cabify|didi|combi|sube|bondi|nafta|shell|axion|vuelta/i, 'Transporte'],
  [/disco|devoto|tata|d[ií]a\b|panader|carnicer|frog|mac\b|mcdonald|burguer|pizza|empanad|asado|comida|almuerzo|cena|desayuno|merienda|alfajor|galletas|helado|chocolate|sandwich|tostado|rotiser|pollo|huevos|queso|le pain|borneo|chipa|medialunas|cubanitos|dulce|yogurt|pde|poke|hamburguesa|barbacoa|guelfi|martin asado|coca\b|osobuco|rey pollo|el clon|el naranjo|sandwich|tata\b/i, 'Comida'],
  [/fernet|cerveza|bar\b|caf[eé]|pub|powerade|aquarius|jackson|gallaghers|cuba libre|campari|sidra|trago|whisky|vino|fenix|gu[eé]mes|guelfi|prisma|madison|bebida|alcohol|birra|fenet|alikal|chinamarket|key tarjeta|key 2|guardarropa/i, 'Bebida/Bar'],
  [/agua\b/i, 'Bebida/Bar'],
  [/claude|anthropic|gpt|chatgpt|github|copilot|fly\.io|fly io|openai|notion|spotify|netflix/i, 'Suscripciones'],
  [/cine|cultural|stand up|concert|alfabeta|libro|teatro|m[uú]sica|entrada|phonetec|baile|fiesta|cumple/i, 'Entretenimiento'],
  [/jab[oó]n|esponja|papel higi[eé]nico|skip|detergente|lavandina|trapo|escoba|limpieza|mercadito papel/i, 'Limpieza'],
  [/alquiler|garrafa|adaptador|tapones|llave|ferreter|cesto|plancha|sanitaria|distribuidora|cintas|acolchado|almohada|cristales|maple|plantas|compu\b|ropero|tarjeta|chinamarket/i, 'Hogar'],
  [/zara|sweater|polo|gorra|conjunto|peluqueria|invictus|vinilo|reloj|ropa/i, 'Ropa'],
  [/regalo|jano regalo/i, 'Regalos'],
  [/gimnasio|gym\b|f[uú]tbol|escalada|acupuntura|proteina|prote\b|crea\b|santi mart[ií]nez/i, 'Gimnasio'],
  [/gastos comunes|tributos|antel|luz|^oca$|sandra|viandas|^ble$|sas|abitab|poliza|dgi|mart[ií]n vidal|ema\b|coaching|paquete banco|limpieza karina/i, 'Servicios']
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
    h += '<p style="color:#666;font-size:13px;margin-top:-8px;">' + _plural(d.daysTracked, 'día registrado', 'días registrados') +
         ' · ' + _plural(d.totalMeals, 'comida', 'comidas') + ' en el log</p>';

    h += '<table style="width:100%;border-collapse:collapse;margin-top:12px;">';
    const kpis = [
      ['😴 Sueño promedio', nn(a.sueno, ' hs')],
      ['💼 Trabajo total',  nn(t.trabajo, ' hs')],
      ['📈 Avance promedio', nn(a.avance, ' / 5')],
      ['🔥 Racha avance 4+', _plural(d.streak, 'día', 'días')]
    ];
    if (a.animo != null) kpis.push(['🙂 Ánimo promedio', a.animo + ' / 5']);
    if (t.ejercicioDias) {
      const pctEx = Math.round(t.ejercicioDias / d.daysTracked * 100);
      kpis.push(['🏃 Días con ejercicio', t.ejercicioDias + ' de ' + d.daysTracked + '  (' + pctEx + '%)']);
      if (t.ejercicioMin) kpis.push(['⏱️ Minutos de ejercicio', t.ejercicioMin + ' min']);
    }
    if (t.mediteDias) {
      kpis.push(['🧘 Días que medité', t.mediteDias + ' de ' + d.daysTracked +
                 '  (' + Math.round(t.mediteDias / d.daysTracked * 100) + '%)' +
                 (t.mediteMin ? '  ·  ' + t.mediteMin + ' min' : '')]);
    }
    if (t.abordajes) {
      kpis.push(['🗣️ Abordajes', t.abordajes + '  ·  ' + t.abordajesDias + ' de ' + d.daysTracked +
                 ' días  (' + Math.round(t.abordajesDias / d.daysTracked * 100) + '%)']);
    }
    if (t.leiDias) {
      kpis.push(['📖 Días que leí', t.leiDias + ' de ' + d.daysTracked +
                 '  (' + Math.round(t.leiDias / d.daysTracked * 100) + '%)']);
    }
    if (a.agua != null) kpis.push(['💧 Agua promedio', Math.round(a.agua) + ' ml/día  (objetivo ' + WATER_GOAL_ML + ')']);
    const ki = d.kcalInfo || {};
    if (a.kcal != null && ki.dias) {
      kpis.push(['🔥 Calorías', Math.round(a.kcal) + ' kcal/día sobre ' + ki.dias +
                 ' día' + (ki.dias === 1 ? '' : 's') + ' con foto']);
    }
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
             _plural(m.count, 'vez', 'veces') + ' · ' + pct + '%</td>';
        h += '</tr>';
      }
      h += '</table>';
    }

    // Aclaración sobre las calorías: sólo se cuentan las comidas con foto
    if ((d.kcalInfo || {}).parcial && (d.kcalInfo || {}).comidas > 0) {
      h += '<p style="font-size:11px;color:#888;margin-top:4px;">Las calorías salen sólo de las ' +
           d.kcalInfo.comidas + ' comidas que cargaste con foto, de ' + d.kcalInfo.totalComidas +
           ' en total — tomalas como referencia parcial, no como el total del día.</p>';
    }

    // Tipos de ejercicio
    if (d.byEjercicio && d.byEjercicio.length) {
      h += '<h3 style="margin-top:24px;font-size:15px;">🏃 Ejercicio</h3>';
      h += '<table style="width:100%;border-collapse:collapse;">';
      for (const e of d.byEjercicio) {
        h += '<tr><td style="padding:7px;border-bottom:1px solid #f0f0f0;">' + e.name + '</td>';
        h += '<td style="padding:7px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;font-size:12px;">' +
             _plural(e.count, 'día', 'días') + '</td></tr>';
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
      'category (UNA de estas exactas: Transporte, Comida, Bebida/Bar, Salud, Suscripciones, Entretenimiento, Hogar, Limpieza, Ropa, Regalos, Gimnasio, Servicios, Viajes, Acciones/Bonos/Ahorros, Otros). ' +
      'REGLAS: ' +
      '1. IGNORÁ líneas de total, subtotal, IVA, cambio, redondeo, descuento general, propina. ' +
      '2. Si hay descuento aplicado a un item específico (ej "2x1", "20% off", "ahorro $X"), restalo del precio. ' +
      '3. Si una bebida está en restaurant/bar → Bebida/Bar. Si es en supermercado → Comida. ' +
      '4. Productos limpieza (jabón, lavandina, papel higiénico, esponja) → Limpieza. ' +
      '4b. Viajes es para gastos de viajar: pasajes, vuelos, hotel, hostel, Airbnb, excursiones, ' +
      'free shop, alquiler de auto, peajes de ruta. Un ómnibus o taxi urbano del día a día es Transporte, no Viajes. ' +
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
    const fx = _fixedTotals(range);
    const fixedUyu = fx.uyu, fixedUsd = fx.usd;

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

// Asegura una columna para un medio de pago (ej. "Efectivo UYU") en meses
// viejos que se crearon antes de que existiera esa tarjeta. A diferencia de
// ensureDateColumn esto SI inserta una columna fisica — no hay hueco libre
// reservado para tarjetas nuevas — pero Sheets corre solo las formulas y
// tablas a la derecha, igual que insertar una columna a mano.
function ensureCardColumn(sheet, headers, headerRow1Indexed, cardName) {
  const target = _stripAccents(cardName);
  for (let c = 0; c < headers.length; c++) {
    if (_stripAccents(headers[c]) === target) return c;
  }
  // Insertar antes de la primera columna especial (cotizacion/categoria/fecha/
  // notas); si todavia no existe ninguna, al final del bloque contiguo de headers.
  const skipRe = /cotizaci|categor|fecha|notas/i;
  let insertCol0 = -1;
  for (let c = 1; c < headers.length; c++) {
    const h = String(headers[c] || '').trim();
    if (!h) break;
    if (skipRe.test(h)) { insertCol0 = c; break; }
  }
  if (insertCol0 < 0) {
    let end = 0;
    for (let c = 0; c < headers.length; c++) {
      if (!String(headers[c] || '').trim()) break;
      end = c + 1;
    }
    insertCol0 = end;
  }
  sheet.insertColumnBefore(insertCol0 + 1);
  sheet.getRange(headerRow1Indexed, insertCol0 + 1).setValue(cardName);
  headers.splice(insertCol0, 0, cardName);
  return insertCol0;
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
// Borra un gasto de la tabla variable. Pide el nombre del ítem y lo compara
// con lo que hay en la fila: un número de fila equivocado borraría un gasto
// real sin que nadie se entere.
//
// NO usa deleteRow: la sección de Argentina vive al costado y borrar la fila
// entera le correría las filas. Se limpia el contenido de las columnas de la
// tabla variable y, si quedó un hueco en el medio, se compacta hacia arriba
// solo dentro de esas columnas.
function deleteExpenseRow(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row)) throw new Error('Fila inválida');
  const esperado = String(p.item || '').trim();
  if (!esperado) throw new Error('Falta el ítem esperado (seguridad)');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = p.month || currentMonthTab();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('No existe la hoja "' + tabName + '"');

  const range = sheet.getDataRange().getValues();
  const header0 = findHeaderRow(range);
  if (header0 < 0) throw new Error('No se encontró la tabla variable');
  const primera = header0 + 2;                        // 1-indexed
  if (row < primera) throw new Error('Esa fila no es de la tabla variable');

  let nCols = 0;
  for (let c = 0; c < range[header0].length; c++) if (String(range[header0][c] || '').trim()) nCols = c + 1;

  const actual = String(sheet.getRange(row, 1).getValue() || '').trim();
  if (_stripAccents(actual) !== _stripAccents(esperado)) {
    throw new Error('La fila ' + row + ' dice "' + actual + '", no "' + esperado + '"');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ultima = sheet.getLastRow();
    const alto = Math.max(1, ultima - primera + 1);
    const rng = sheet.getRange(primera, 1, alto, nCols);
    const vals = rng.getValues();
    const idx = row - primera;
    vals.splice(idx, 1);
    vals.push(new Array(nCols).fill(''));
    rng.setValues(vals);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: tabName, row: row, deleted: actual };
}

// Total de la tabla fija. Prioridad a la fila "Total fijos" de la propia hoja:
// es la que el usuario mantiene y la que decide qué entra y qué no (deja afuera
// "Itaú Crédito" y "Oca", que son resúmenes de tarjeta y duplicarían los gastos
// variables). Sumar por lista de etiquetas los contaba de más y encima no veía
// las filas que el usuario agrega o borra.
function _fixedTotals(range) {
  for (let i = 0; i < Math.min(FIXED_TABLE_MAX_ROWS, range.length); i++) {
    const label = _stripAccents(range[i][0]);
    if (label === 'total fijos') {
      return { uyu: toNumber(range[i][1]) || 0, usd: toNumber(range[i][2]) || 0, source: 'total fijos' };
    }
  }
  let uyu = 0, usd = 0;
  for (let i = 0; i < Math.min(FIXED_TABLE_MAX_ROWS, range.length); i++) {
    const label = _stripAccents(range[i][0]);
    if (!label) continue;
    if (FIXED_LABELS.some(f => _stripAccents(f) === label)) {
      const u = toNumber(range[i][1]); if (u !== null) uyu += u;
      const s = toNumber(range[i][2]); if (s !== null) usd += s;
    }
  }
  return { uyu: uyu, usd: usd, source: 'etiquetas' };
}

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

  // Find card column (exact + accent-insensitive); auto-crea la columna si es
  // una tarjeta conocida (ej. "Efectivo UYU") que este mes todavia no tiene
  // — mismo criterio que la columna Fecha, en vez de fallar.
  const targetCard = _stripAccents(card);
  let cardCol = headers.findIndex(h => _stripAccents(h) === targetCard);
  if (cardCol < 0) {
    if (!CARDS.some(c => _stripAccents(c) === targetCard)) {
      throw new Error('Medio de pago "' + card + '" no encontrado. Headers: ' + headers.filter(h => h).join(' | '));
    }
    cardCol = ensureCardColumn(sheet, headers, headerRow + 1, card);
  }

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
    // Columnas numéricas = las de medios de pago (todo menos label, cotización,
    // categoría, fecha, notas). Dinámico: agregar una tarjeta nueva (ej.
    // Efectivo) no rompe el total ni requiere tocar índices a mano.
    const skipRe = /cotizaci|categor|fecha|notas/i;
    for (let c = 1; c < headers.length; c++) {
      const h = headers[c];
      if (!h || skipRe.test(h)) continue;
      const col1 = c + 1;
      const letter = String.fromCharCode(64 + col1);
      const formula = '=SUM(' + letter + firstDataRow1Indexed + ':' + letter + lastDataRow1Indexed + ')';
      sheet.getRange(newTotalRow1Indexed, col1).setFormula(formula);
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
  // parseLocalDate devuelve Invalid Date (que no es falsy) ante basura, asi
  // que hay que chequear getTime. Sin esto se crea "Hábitos undefined NaN".
  let d = parseLocalDate(date);
  if (!d || isNaN(d.getTime())) d = new Date();
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

// Horas dormidas de UNA noche: los dos valores viven en la misma fila y
// describen el mismo dormir, el que terminó esa mañana.
//
// Antes "Acosté" se guardaba en el día en que uno se acostaba y el cálculo
// cruzaba filas adivinando con una heurística (PM = día anterior, AM = mismo
// día). Eso se rompía justamente en el caso normal: acostarse el 30 a las 23
// o el 31 a las 3 son la misma noche, la que termina el 31.
//
// Con los dos datos en la misma fila no hace falta adivinar nada: si la hora
// de acostarse es MAYOR que la de levantarse, se cruzó la medianoche.
//   23:00 -> 07:00  =  8 hs   (se acostó el día anterior)
//   03:00 -> 09:30  =  6,5 hs (se acostó ya pasada la medianoche)
function _calcSleepHours(bedStr, wakeStr) {
  const bed = _parseHM(bedStr), wake = _parseHM(wakeStr);
  if (bed == null || wake == null) return null;
  let mins = wake - bed;
  if (mins < 0) mins += 24 * 60;   // cruzó la medianoche
  if (mins === 0) return null;      // misma hora: no hay dato útil
  return Math.round((mins / 60) * 100) / 100;
}

// true si la hora de acostarse cae el día anterior al de levantarse
function _bedWasPrevDay(bedStr, wakeStr) {
  const bed = _parseHM(bedStr), wake = _parseHM(wakeStr);
  if (bed == null || wake == null) return false;
  return bed > wake;
}

// Tipo de comida según la hora.
// Las franjas salen de horarios rioplatenses: se almuerza tarde y se cena
// tarde. 'Media mañana' evita que un snack de las 11 quede como almuerzo.
function _mealTypeByHour(hora) {
  const m = _parseHM(hora);
  if (m == null) return '';
  const h = m / 60;
  if (h < 5)    return 'Snack nocturno';
  if (h < 11)   return 'Desayuno';
  if (h < 12)   return 'Media mañana';
  if (h < 15.5) return 'Almuerzo';
  if (h < 19.5) return 'Merienda';
  return 'Cena';
}

// Ventanas horarias para saber si ya comió, sin depender de la etiqueta
// (que el usuario puede editar a mano).
const MEAL_WINDOWS = {
  desayuno: [5, 11.5],
  almuerzo: [11.5, 16],
  cena:     [19, 24]
};

function _hasMealInWindow(meals, win) {
  for (const m of meals) {
    const mm = _parseHM(m.hora);
    if (mm == null) continue;
    const h = mm / 60;
    if (h >= win[0] && h < win[1]) return true;
  }
  return false;
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
  sheet.getRange(HABIT_DAY_FIRST_ROW, 2, HABIT_DAY_ROWS, 2).setNumberFormat('@');
  sheet.getRange(HABIT_MEAL_FIRST_ROW, 2, 600, 1).setNumberFormat('@');

  // Formato
  sheet.setColumnWidth(1, 95);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(9, 260);
  sheet.setFrozenRows(HABIT_DAY_HEADER_ROW);

  // Dejarla ordenada de entrada: insertSheet la mete donde caiga y termina
  // desparramando las hojas de hábitos entre los meses de gastos.
  try { reorderSheets(false); } catch (e) { Logger.log('reorder: ' + e.message); }
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
    const rng = sheet.getRange(HABIT_DAY_FIRST_ROW, col, HABIT_DAY_ROWS, 1);
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

  // NUNCA insertar columnas: insertColumnBefore corre TODA la hoja, y el log
  // de comidas/agua vive abajo en la misma hoja leyendose por posicion fija.
  // Insertar en el medio desplazaria Registro/ml/kcal y el agua dejaria de
  // encontrarse (el total del dia se escribiria en 0). Las columnas que
  // falten se agregan al final, que no mueve nada.
  let siguiente = 1;
  for (const k of Object.keys(hmap)) siguiente = Math.max(siguiente, hmap[k] + 2);

  for (const h of missing) {
    sheet.getRange(HABIT_DAY_HEADER_ROW, siguiente)
         .setValue(h).setFontWeight('bold').setBackground('#e8f0ee');
    siguiente++;
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
  // Si mandan month a mano, tiene que ser el mes de la fecha. Sin este chequeo
  // una fecha de julio con month=Junio terminaba escrita en una fila libre de
  // la hoja de junio, ensuciando el mes equivocado.
  if (p.month && p.month !== habitTabFor(dateStr)) {
    throw new Error('La fecha ' + dateStr + ' no pertenece a "' + p.month + '"');
  }
  const sheet = getOrCreateHabitTab(ss, tabName);
  const hmap = _habitHeaderMap(sheet);

  let row = _habitFindDayRow(sheet, dateStr);
  if (row < 0) {
    // Buscar una fila de fecha vacia. Si no hay ninguna NO se puede asumir
    // nada: caer a la primera fila pisaria los datos del dia 1 en silencio.
    let libre = -1;
    const vals = sheet.getRange(HABIT_DAY_FIRST_ROW, 1, HABIT_DAY_ROWS, 1).getValues();
    for (let i = 0; i < vals.length; i++) { if (!vals[i][0]) { libre = HABIT_DAY_FIRST_ROW + i; break; } }
    if (libre < 0) {
      throw new Error('No se encontró la fila del ' + dateStr + ' en "' + tabName +
                      '" y no hay filas libres. Revisá que la fecha corresponda a ese mes.');
    }
    row = libre;
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

  // --- Hs sueño: los dos valores salen de ESTA fila ---
  // Se recalcula cada vez que se toca cualquiera de los dos, tomando el valor
  // recién escrito o, si no vino en este guardado, el que ya estaba.
  if (p.levante || p.acoste) {
    const lev = p.levante || _readHM(readCur('levante'));
    const aco = p.acoste  || _readHM(readCur('acoste'));
    if (lev && aco) {
      const hs = _calcSleepHours(aco, lev);
      if (hs != null && setCell('hsSueno', hs)) {
        written.hsSueno = hs;
        written.acosteDiaAnterior = _bedWasPrevDay(aco, lev);
      }
    }
  }

  // --- Numéricos simples ---
  const numFields = [
    ['trabajo', p.trabajo], ['avance', p.avance], ['animo', p.animo],
    ['ejercicioMin', p.ejercicioMin], ['mediteMin', p.mediteMin]
  ];
  for (const [field, raw] of numFields) {
    if (raw === undefined || raw === '' || raw === null) continue;
    const v = toNumber(String(raw).replace(',', '.'));
    if (v == null) throw new Error('Valor inválido para ' + field);
    if (field === 'trabajo' && (v < 0 || v > 24)) {
      throw new Error('Las horas de trabajo tienen que estar entre 0 y 24');
    }
    if ((field === 'avance' || field === 'animo') && (v < 1 || v > 5)) {
      throw new Error(field + ' tiene que estar entre 1 y 5');
    }
    if (setCell(field, v)) written[field] = v;
  }

  // --- Ejercicio (texto). El form manda el valor completo, así que reemplaza. ---
  if (p.ejercicio) {
    if (setCell('ejercicio', p.ejercicio)) written.ejercicio = p.ejercicio;
  }

  // --- Sí/no: se guardan como "Sí"/"No" para que se lean en la hoja. Un "no"
  // es un dato tan válido como un "sí": significa que el día ya se contestó.
  for (const [field, raw] of [['medite', p.medite], ['lei', p.lei]]) {
    if (raw === undefined || raw === '' || raw === null) continue;
    const v = _siNo(raw);
    if (v && setCell(field, v)) written[field] = v;
  }

  // --- Contadores con delta (agua, mast) ---
  const counters = [['agua', p.aguaDelta, p.agua], ['mast', p.mastDelta, p.mast],
                    ['abordajes', p.abordajesDelta, p.abordajes]];
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

  // --- Vaciar campos explícitamente ---
  // El merge normal ignora los campos vacíos para no pisar lo ya cargado.
  // Eso hace imposible corregir un dato mal puesto, así que el form manda
  // en 'clear' los campos que el usuario dejó en blanco a propósito.
  if (p.clear) {
    const pedidos = String(p.clear).split(',').map(s => s.trim()).filter(s => s);
    const vaciados = [];
    for (const f of pedidos) {
      if (!HABIT_FIELD_MAP[f]) continue;
      const col = colOf(f);
      if (col < 0) continue;
      sheet.getRange(row, col).clearContent();
      vaciados.push(f);
      // Vaciar la hora de levantada invalida las horas de sueño calculadas
      if (f === 'levante') {
        const cs = colOf('hsSueno');
        if (cs > 0) { sheet.getRange(row, cs).clearContent(); vaciados.push('hsSueno'); }
      }
    }
    if (vaciados.length) written.cleared = vaciados;
  }

  return { ok: true, tab: tabName, row: row, date: dateStr, written: written };
}

// Agrega una comida al log. p: { date, hora, comida, tipo }
function addMealEntry(p) {
  const comida = String(p.comida || p.item || '').trim();
  if (!comida) throw new Error('Falta el texto de la comida');

  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const hora = p.hora || Utilities.formatDate(new Date(), 'America/Montevideo', 'HH:mm');
  const tabName = p.month || habitTabFor(dateStr);

  const cls = classifyMeal(comida, hora);
  const tipo = p.tipo || cls.tipo;
  // La foto (o una correccion manual) puede traer su propia clasificacion
  const macro     = (p.macro     !== undefined && p.macro     !== '') ? String(p.macro)     : cls.macro;
  const procesado = (p.procesado !== undefined && p.procesado !== '') ? String(p.procesado) : cls.procesado;
  const kcal      = (p.kcal      !== undefined && p.kcal      !== '') ? (toNumber(p.kcal) || '') : '';
  const ingr      = (p.ingredientes !== undefined) ? String(p.ingredientes || '') : '';

  // Lock alrededor de TODO: abrir la hoja, resolver la fila libre y escribir.
  // SpreadsheetApp cachea el estado del momento en que se abre el archivo, así
  // que abrirlo antes del lock hace que _nextLogRow lea un snapshot viejo y dos
  // altas simultáneas resuelvan la misma fila (comprobado: 6 altas en paralelo
  // devolvían filas 54,55,54,55,56,55 y se pisaban entre sí).
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let insertAt, sheet;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    sheet = getOrCreateHabitTab(ss, tabName);
    insertAt = _nextLogRow(sheet);
    sheet.getRange(insertAt, 2).setNumberFormat('@');
    sheet.getRange(insertAt, 1, 1, HABIT_MEAL_HEADERS.length).setValues([[
      parseLocalDate(dateStr), hora, comida, macro, tipo, procesado, 'Comida', '', kcal, ingr
    ]]);
    sheet.getRange(insertAt, 1).setNumberFormat('dd/MM/yyyy');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

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
    if (!sheet) return { ok: true, exists: false, date: dateStr, tab: tabName, meals: [], waters: [], ejercicios: [] };
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
        acosteDiaAnterior: _bedWasPrevDay(_readHM(g('acoste')), _readHM(g('levante'))),
        trabajo: toNumber(g('trabajo')),
        avance:  toNumber(g('avance')),
        animo:   toNumber(g('animo')),
        ejercicio: String(g('ejercicio') || ''),
        ejercicioMin: toNumber(g('ejercicioMin')),
        medite: _siNo(g('medite')),
        mediteMin: toNumber(g('mediteMin')),
        lei: _siNo(g('lei')),
        abordajes: toNumber(g('abordajes')),
        agua: toNumber(g('agua')) || 0,
        mast: toNumber(g('mast')) || 0,
        notas: String(g('notas') || '')
      };
    }
    // Log del día: comidas, agua y ejercicio
    const meals = [], waters = [], ejercicios = [];
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
        } else if (reg === 'ejercicio') {
          ejercicios.push({ row: HABIT_MEAL_FIRST_ROW + i, hora: _readHM(r[1]),
                            tipo: String(r[2] || ''), min: toNumber(r[7]) || 0 });
        } else {
          meals.push({ row: HABIT_MEAL_FIRST_ROW + i, hora: _readHM(r[1]), comida: String(r[2] || ''),
                       macro: String(r[3] || ''), tipo: String(r[4] || ''), procesado: String(r[5] || ''),
                       kcal: toNumber(r[8]), ingredientes: String(r[9] || '') });
        }
      }
    }
    // Días cargados antes de que el ejercicio fuera una lista: la fila diaria
    // tiene el texto y los minutos pero no hay filas en el log. Se devuelve como
    // una entrada sin fila para que el form la muestre y no se pierda; al
    // guardar cualquier cambio se reescribe como registro del log.
    if (!ejercicios.length && day && (day.ejercicio || (day.ejercicioMin || 0) > 0)) {
      ejercicios.push({ row: null, hora: '', tipo: day.ejercicio || 'Ejercicio',
                        min: day.ejercicioMin || 0, legacy: true });
    }

    return { ok: true, exists: !!day, date: dateStr, tab: tabName, day: day,
             meals: meals, waters: waters, ejercicios: ejercicios };
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
  const dayVals = sheet.getRange(HABIT_DAY_FIRST_ROW, 1, HABIT_DAY_ROWS, nCols).getValues();
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
      medite: _siNo(g('medite')), mediteMin: toNumber(g('mediteMin')), lei: _siNo(g('lei')),
      abordajes: toNumber(g('abordajes')),
      agua: toNumber(g('agua')), mast: toNumber(g('mast')),
      notas: String(g('notas') || '')
    };
    // agua y mast se comparan contra > 0: _recalcWaterTotal escribe 0 al
    // borrar la ultima toma, y un 0 no debe marcar el dia como registrado
    // (inflaba daysTracked y con eso todos los porcentajes del reporte).
    row.hasData = !!(row.levante || row.acoste || row.trabajo != null || row.avance != null ||
                     row.animo != null || row.ejercicio || (row.ejercicioMin > 0) ||
                     row.medite || row.lei || (row.mediteMin > 0) || (row.abordajes > 0) ||
                     (row.agua > 0) || (row.mast > 0));
    days.push(row);
  }

  const meals = [];
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const mv = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, HABIT_MEAL_HEADERS.length).getValues();
    for (const r of mv) {
      if (!r[0] || !String(r[2] || '').trim()) continue;
      const reg = String(r[6] || '').trim().toLowerCase();
      if (reg === 'agua' || reg === 'ejercicio') continue; // ni el agua ni el ejercicio son comida
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

// Plural simple: _plural(1,'vez','veces') -> '1 vez'
function _plural(n, sing, plur) { return n + ' ' + (Math.abs(n) === 1 ? sing : plur); }

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

    // Calorías: sólo existen en las comidas cargadas con foto, así que el
    // promedio se calcula sobre los días que tienen al menos una, y se
    // etiqueta como parcial para no leerlo como el total real del día.
    const kcalPorDia = {};
    for (const m of data.meals) {
      const k = toNumber(m.kcal);
      if (k == null || k <= 0) continue;
      kcalPorDia[m.date] = (kcalPorDia[m.date] || 0) + k;
    }
    const diasConKcal = Object.keys(kcalPorDia);
    const kcalVals = diasConKcal.map(d => kcalPorDia[d]);
    const kcalTotal = kcalVals.reduce((s, x) => s + x, 0);
    const mealsConKcal = data.meals.filter(m => (toNumber(m.kcal) || 0) > 0).length;

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

    // Racha actual de días con avance >= 4.
    // Los días sin avance cargado se saltean en vez de cortar la racha:
    // no haber registrado el dato no es lo mismo que haber tenido un mal día.
    let streak = 0;
    for (let i = filled.length - 1; i >= 0; i--) {
      if (filled[i].avance == null) continue;
      if (filled[i].avance >= 4) streak++;
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
        agua: _avg(aguaVals),
        kcal: _avg(kcalVals)
      },
      totals: {
        trabajo: Math.round(work.filter(x => x != null).reduce((s, x) => s + x, 0) * 100) / 100,
        mast: filled.map(d => d.mast).filter(x => x != null).reduce((s, x) => s + x, 0),
        agua: aguaVals.reduce((s, x) => s + x, 0),
        ejercicioMin: filled.map(d => d.ejercicioMin).filter(x => x != null).reduce((s, x) => s + x, 0),
        ejercicioDias: exDays.length,
        mediteDias: filled.filter(d => d.medite === 'Sí').length,
        mediteMin: filled.map(d => d.mediteMin).filter(x => x != null).reduce((s, x) => s + x, 0),
        leiDias: filled.filter(d => d.lei === 'Sí').length,
        abordajes: filled.map(d => d.abordajes).filter(x => x != null).reduce((s, x) => s + x, 0),
        abordajesDias: filled.filter(d => (d.abordajes || 0) > 0).length,
        kcal: kcalTotal
      },
      kcalInfo: {
        dias: diasConKcal.length,
        comidas: mealsConKcal,
        totalComidas: data.meals.length,
        parcial: mealsConKcal < data.meals.length
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
    // Sheets guarda una hora suelta como Date del 1899-12-30 EN LA ZONA DEL
    // SPREADSHEET. Formatear en UTC le sumaba el offset (~3h45 de LMT
    // Montevideo) en vez de cancelarlo: 07:15 se leia 10:59. Hay que
    // formatear en la misma zona, que ademas coincide con lo que hace
    // _parseHM (getHours/getMinutes sobre la zona del script).
    return Utilities.formatDate(v, 'America/Montevideo', 'HH:mm');
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
  // Tabla diaria: cada columna de hora se procesa POR SEPARADO. Antes se
  // tomaba un bloque de 2 columnas desde la menor, asumiendo que Levanté y
  // Acosté eran adyacentes; si el usuario movia una, la del medio (por
  // ejemplo "Hs sueño") se convertia a texto y quedaba inutilizable.
  const hmapR = _habitHeaderMap(sheet);
  for (const campo of ['levante', 'acoste']) {
    const col = _habitColOf(hmapR, campo);
    if (col < 0) continue;
    const rng = sheet.getRange(HABIT_DAY_FIRST_ROW, col, HABIT_DAY_ROWS, 1);
    const vals = rng.getValues();
    const out = vals.map(r => {
      const v = r[0];
      if (Object.prototype.toString.call(v) === '[object Date]') { fixed++; return [_readHM(v)]; }
      return [v === '' ? '' : String(v)];
    });
    rng.setNumberFormat('@');
    rng.setValues(out);
  }

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
  sheet.getRange(HABIT_DAY_FIRST_ROW, 2, HABIT_DAY_ROWS, nC - 1).clearContent();
  const hm = _habitHeaderMap(sheet);
  for (const f of ['levante', 'acoste']) {
    const col = _habitColOf(hm, f);
    if (col > 0) sheet.getRange(HABIT_DAY_FIRST_ROW, col, HABIT_DAY_ROWS, 1).setNumberFormat('@');
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
// Cierre del día. Devuelve qué falta contestar y un mensaje corto listo para
// una notificación. Entre medianoche y las 5 AM el día que se está cerrando es
// el de ayer: si son las 00:40 y todavía no cargó nada, lo que falta es la
// noche que recién termina, no el día nuevo.
function _habitPendingNoche(now, opts) {
  const hora = parseInt(Utilities.formatDate(now, 'America/Montevideo', 'HH'), 10);
  const objetivo = new Date(now.getTime());
  if (hora < 5) objetivo.setDate(objetivo.getDate() - 1);
  const dateStr = Utilities.formatDate(objetivo, 'America/Montevideo', 'yyyy-MM-dd');

  const base = { ok: true, modo: 'noche', date: dateStr,
                 hora: Utilities.formatDate(now, 'America/Montevideo', 'HH:mm') };

  const day = getHabitDay(dateStr);
  if (!day || !day.ok) return Object.assign(base, { pending: false, pendingNum: 0, title: '', msg: 'Sin datos' });
  const d = day.day || {};

  // El "levanté" de ese día se contesta a la mañana siguiente, así que de noche
  // no se pide: se pide el "acosté", que es lo que se sabe recién ahora.
  const faltantes = [];
  if (!d.acoste)                 faltantes.push('a qué hora te acostaste');
  if (!d.ejercicio && !(d.ejercicioMin > 0)) faltantes.push('si fuiste al gimnasio');
  if (!d.medite)                 faltantes.push('si meditaste');
  if (!d.lei)                    faltantes.push('si leíste');
  if (d.abordajes == null)       faltantes.push('a cuántas abordaste');
  if (d.mast == null)            faltantes.push('el contador');

  const pending = faltantes.length > 0;
  return Object.assign(base, {
    pending: pending,
    pendingNum: pending ? 1 : 0,
    count: faltantes.length,
    title: pending ? '🌙 Cerrá el día' : '🌙 Día cerrado',
    msg: pending
      ? 'Falta ' + faltantes.slice(0, 3).join(', ') +
        (faltantes.length > 3 ? ' y ' + (faltantes.length - 3) + ' cosa' + (faltantes.length - 3 > 1 ? 's' : '') + ' más' : '')
      : 'Todo cargado ✓',
    faltantes: faltantes,
    dia: { acoste: d.acoste || '', levante: d.levante || '', ejercicio: d.ejercicio || '',
           medite: d.medite || '', lei: d.lei || '', abordajes: d.abordajes,
           mast: d.mast, avance: d.avance }
  });
}

// A la mañana lo único que falta preguntar es a qué hora se levantó.
function _habitPendingManana(now) {
  const dateStr = Utilities.formatDate(now, 'America/Montevideo', 'yyyy-MM-dd');
  const base = { ok: true, modo: 'manana', date: dateStr,
                 hora: Utilities.formatDate(now, 'America/Montevideo', 'HH:mm') };
  const day = getHabitDay(dateStr);
  if (!day || !day.ok) return Object.assign(base, { pending: false, pendingNum: 0, title: '', msg: 'Sin datos' });
  const d = day.day || {};
  const pending = !d.levante;
  return Object.assign(base, {
    pending: pending, pendingNum: pending ? 1 : 0, count: pending ? 1 : 0,
    title: pending ? '☀️ ¿A qué hora te levantaste?' : '☀️ Ya cargado',
    msg: pending ? 'Cargá la hora para que salga el cálculo de sueño' : 'Levantada cargada ✓',
    faltantes: pending ? ['a qué hora te levantaste'] : [],
    dia: { levante: d.levante || '', acoste: d.acoste || '' }
  });
}

function habitPending(opts) {
  try {
    const now = new Date();
    const dateStr = Utilities.formatDate(now, 'America/Montevideo', 'yyyy-MM-dd');
    const hourNow = parseInt(Utilities.formatDate(now, 'America/Montevideo', 'HH'), 10);
    const minNow  = parseInt(Utilities.formatDate(now, 'America/Montevideo', 'mm'), 10);
    const tNow = hourNow + minNow / 60;

    const desde = (opts && opts.desde != null) ? Number(opts.desde) : 9;   // no molestar antes
    const hasta = (opts && opts.hasta != null) ? Number(opts.hasta) : 23;  // ni después

    // modo=noche: el cierre del día. Se usa de 23 a 3 AM y solo pregunta por lo
    // que se contesta al final: a qué hora se acostó, gimnasio, meditación,
    // lectura y el contador. Después de medianoche el día que cierra es el de
    // ayer, no el de hoy.
    const modo = String((opts && opts.modo) || '').toLowerCase();
    if (modo === 'noche')  return _habitPendingNoche(now, opts || {});
    if (modo === 'manana' || modo === 'mañana') return _habitPendingManana(now);

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

    // --- Comidas: se mira si hay algo cargado en la ventana horaria.
    // Usar la hora y no la etiqueta evita falsos avisos cuando el tipo se
    // editó a mano o cuando comió fuera del horario típico.
    if (tNow >= 11.5 && !_hasMealInWindow(meals, MEAL_WINDOWS.desayuno)) faltantes.push('no cargaste el desayuno');
    if (tNow >= 16   && !_hasMealInWindow(meals, MEAL_WINDOWS.almuerzo)) faltantes.push('no cargaste el almuerzo');
    if (tNow >= 22   && !_hasMealInWindow(meals, MEAL_WINDOWS.cena))     faltantes.push('no cargaste la cena');

    // --- Cierre del día ---
    if (tNow >= 21) {
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



// Borra una hoja de hábitos SOLO si no tiene ningún dato cargado. Sirve para
// limpiar hojas creadas de más (por una prueba o por tocar un mes futuro sin
// querer). Si encuentra cualquier dato, se niega y dice qué encontró.
function deleteHabitSheetIfEmpty(tabName, confirm) {
  if (String(confirm || '').toUpperCase() !== 'SI') {
    return { ok: false, error: 'Agregá confirm=SI' };
  }
  const name = String(tabName || '').trim();
  if (name.indexOf(HABIT_PREFIX) !== 0) {
    return { ok: false, error: 'Solo se pueden borrar hojas de hábitos' };
  }
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(name);
  if (!sheet) return { ok: false, error: 'No existe la hoja "' + name + '"' };

  const encontrado = [];

  // Tabla diaria: cualquier celda con contenido a la derecha de la fecha
  const nC = Math.max(sheet.getLastColumn(), HABIT_DAY_HEADERS.length);
  const dayVals = sheet.getRange(HABIT_DAY_FIRST_ROW, 2, HABIT_DAY_ROWS, nC - 1).getValues();
  for (const r of dayVals) {
    for (const v of r) {
      if (v !== '' && v !== null) { encontrado.push('dato en la tabla diaria'); break; }
    }
    if (encontrado.length) break;
  }

  // Log: cualquier fila con detalle
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const n = lastRow - HABIT_MEAL_FIRST_ROW + 1;
    const mv = sheet.getRange(HABIT_MEAL_FIRST_ROW, 3, n, 1).getValues();
    for (const r of mv) {
      if (String(r[0] || '').trim()) { encontrado.push('registros en el log'); break; }
    }
  }

  if (encontrado.length) {
    return { ok: false, error: 'La hoja "' + name + '" tiene ' + encontrado.join(' y ') + ' — no se borra' };
  }

  ss.deleteSheet(sheet);
  return { ok: true, deleted: name };
}


// ============================================================================
// === AHORROS: acciones, banco y bonos ======================================
// Los ahorros son acumulativos, no de un mes: una accion comprada en marzo se
// sigue teniendo en septiembre. Por eso viven en su propia hoja y no en un
// bloque del tab del mes como Argentina.
//
// Cada fila es un movimiento (una compra, un deposito). Las posiciones salen de
// agrupar: dos compras de NVDA son una sola posicion con el promedio ponderado.
// La valuacion de las acciones usa el precio del dia; el banco y los bonos
// valen lo que dice el monto.

const SAVINGS_TAB = 'Ahorros';
const INGRESOS_TAB = 'Ingresos';
const INGRESOS_HEADERS = ['Fecha', 'Concepto', 'Monto', 'Moneda', 'Notas'];
const INGRESOS_HEADER_ROW = 1;
const INGRESOS_FIRST_ROW = 2;
const INGRESOS_MAX_ROWS = 500;
const SAVINGS_TITLE = '💰 AHORROS';
// La comision tiene columna propia. Antes vivia implicita en la diferencia
// entre cantidad x precio y lo invertido, asi que no se podia ver cuanto se le
// estaba pagando al broker. La identidad que siempre cierra es:
//     Invertido USD = Cantidad x Precio USD + Comisión USD
const SAVINGS_HEADERS = ['Fecha', 'Tipo', 'Entidad', 'Ticker', 'Cantidad', 'Precio USD',
                         'Comisión USD', 'Monto', 'Moneda', 'Invertido USD',
                         'Precio hoy', 'Valor hoy USD', 'Notas'];
const SAVINGS_TIPOS = ['Acción', 'Banco', 'Bono'];
const SAVINGS_MONEDAS = ['USD', 'UYU'];
const SAVINGS_TITLE_ROW = 1;
const SAVINGS_TOTALS_ROW = 2;
// La ganancia se mide SOLO sobre las acciones: el banco y los bonos valen lo
// que pusiste, asi que meterlos en el promedio solo diluiria el porcentaje.
const SAVINGS_TOTAL_LABELS = ['Total (USD)', 'Total (UYU)', 'Invertido en acciones (USD)',
                              'Comisiones pagadas (USD)', 'Ganancia acciones (USD)',
                              'En acciones (USD)', 'En banco (USD)', 'En bonos (USD)',
                              'Cotización usada'];
const SAVINGS_HEADER_ROW = SAVINGS_TOTALS_ROW + SAVINGS_TOTAL_LABELS.length + 1;  // 9
const SAVINGS_FIRST_ROW = SAVINGS_HEADER_ROW + 1;                                 // 10
const SAVINGS_MAX_ROWS = 300;
const SAVINGS_PRICE_TTL_SEC = 900;   // 15 min: los precios no se mueven tanto

// Empresas conocidas: el ticker alcanza para sacar el nombre y el logo. Si el
// ticker no esta aca igual se puede cargar — solo se pierde el logo lindo.
const TICKER_INFO = {
  NVDA:  { nombre: 'NVIDIA',          dominio: 'nvidia.com' },
  AMD:   { nombre: 'AMD',             dominio: 'amd.com' },
  AAPL:  { nombre: 'Apple',           dominio: 'apple.com' },
  MSFT:  { nombre: 'Microsoft',       dominio: 'microsoft.com' },
  GOOGL: { nombre: 'Alphabet',        dominio: 'google.com' },
  GOOG:  { nombre: 'Alphabet',        dominio: 'google.com' },
  AMZN:  { nombre: 'Amazon',          dominio: 'amazon.com' },
  TSLA:  { nombre: 'Tesla',           dominio: 'tesla.com' },
  META:  { nombre: 'Meta',            dominio: 'meta.com' },
  NFLX:  { nombre: 'Netflix',         dominio: 'netflix.com' },
  INTC:  { nombre: 'Intel',           dominio: 'intel.com' },
  MELI:  { nombre: 'MercadoLibre',    dominio: 'mercadolibre.com' },
  CVX:   { nombre: 'Chevron',         dominio: 'chevron.com' },
  XOM:   { nombre: 'Exxon Mobil',     dominio: 'exxonmobil.com' },
  ORCL:  { nombre: 'Oracle',          dominio: 'oracle.com' },
  TTWO:  { nombre: 'Take-Two',        dominio: 'take2games.com' },
  NDAQ:  { nombre: 'Nasdaq Inc.',     dominio: 'nasdaq.com' },
  KO:    { nombre: 'Coca-Cola',       dominio: 'coca-cola.com' },
  DIS:   { nombre: 'Disney',          dominio: 'disney.com' },
  JPM:   { nombre: 'JPMorgan',        dominio: 'jpmorganchase.com' },
  V:     { nombre: 'Visa',            dominio: 'visa.com' },
  MA:    { nombre: 'Mastercard',      dominio: 'mastercard.com' },
  PYPL:  { nombre: 'PayPal',          dominio: 'paypal.com' },
  UBER:  { nombre: 'Uber',            dominio: 'uber.com' },
  ABNB:  { nombre: 'Airbnb',          dominio: 'airbnb.com' },
  PLTR:  { nombre: 'Palantir',        dominio: 'palantir.com' },
  SHOP:  { nombre: 'Shopify',         dominio: 'shopify.com' },
  SPOT:  { nombre: 'Spotify',         dominio: 'spotify.com' },
  AVGO:  { nombre: 'Broadcom',        dominio: 'broadcom.com' },
  TSM:   { nombre: 'TSMC',            dominio: 'tsmc.com' },
  MU:    { nombre: 'Micron',          dominio: 'micron.com' },
  QCOM:  { nombre: 'Qualcomm',        dominio: 'qualcomm.com' },
  ARM:   { nombre: 'ARM',             dominio: 'arm.com' },
  COIN:  { nombre: 'Coinbase',        dominio: 'coinbase.com' },
  SPY:   { nombre: 'S&P 500 (SPY)',   dominio: 'ssga.com' },
  VOO:   { nombre: 'S&P 500 (VOO)',   dominio: 'vanguard.com' },
  VTI:   { nombre: 'Total Market',    dominio: 'vanguard.com' },
  QQQ:   { nombre: 'Nasdaq 100',      dominio: 'invesco.com' }
};

function _tickerInfo(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  return TICKER_INFO[t] || null;
}

// Hoja de ahorros. Una sola para todo, no una por mes.
function getOrCreateSavingsTab(ss) {
  let sheet = ss.getSheetByName(SAVINGS_TAB);
  if (sheet) { _savingsMigrar(sheet); return sheet; }

  sheet = ss.insertSheet(SAVINGS_TAB);
  sheet.getRange(SAVINGS_TITLE_ROW, 1).setValue(SAVINGS_TITLE)
       .setFontWeight('bold').setFontSize(13);
  _savingsEscribirEtiquetas(sheet);
  sheet.getRange(SAVINGS_HEADER_ROW, 1, 1, SAVINGS_HEADERS.length)
       .setValues([SAVINGS_HEADERS]).setFontWeight('bold').setBackground('#dcfce7');
  sheet.setColumnWidth(1, 95);
  sheet.setColumnWidth(3, 170);
  sheet.setColumnWidth(SAVINGS_HEADERS.length, 200);
  sheet.setFrozenRows(SAVINGS_HEADER_ROW);
  try { reorderSheets(false); } catch (e) { Logger.log('reorder: ' + e.message); }
  return sheet;
}

// Autorepara encabezados y etiquetas si alguien los pisó a mano.
function _savingsMigrar(sheet) {
  const hdr = sheet.getRange(SAVINGS_HEADER_ROW, 1, 1, SAVINGS_HEADERS.length).getValues()[0];
  const falta = SAVINGS_HEADERS.some((h, i) => _stripAccents(String(hdr[i] || '')) !== _stripAccents(h));
  if (falta) {
    sheet.getRange(SAVINGS_HEADER_ROW, 1, 1, SAVINGS_HEADERS.length)
         .setValues([SAVINGS_HEADERS]).setFontWeight('bold').setBackground('#dcfce7');
  }
  sheet.getRange(SAVINGS_TITLE_ROW, 1).setValue(SAVINGS_TITLE);
  _savingsEscribirEtiquetas(sheet);

  // Al agregar filas de totales el header bajo de lugar y arriba quedo el
  // viejo. Se borra SOLO si es realmente un header huerfano: si ahi hubiera
  // datos de alguien, limpiar a ciegas se los comeria en silencio.
  const primerHueco = SAVINGS_TOTALS_ROW + SAVINGS_TOTAL_LABELS.length;
  for (let r = primerHueco; r < SAVINGS_HEADER_ROW; r++) {
    const fila = sheet.getRange(r, 1, 1, SAVINGS_HEADERS.length).getValues()[0];
    const esHeaderViejo = SAVINGS_HEADERS.every(
      (h, i) => _stripAccents(String(fila[i] || '')) === _stripAccents(h));
    const vacia = fila.every(v => v === '' || v == null);
    if (esHeaderViejo || vacia) sheet.getRange(r, 1, 1, SAVINGS_HEADERS.length).clearContent();
    else Logger.log('Ahorros: fila ' + r + ' tiene datos inesperados, no se toca');
  }
}

function _savingsEscribirEtiquetas(sheet) {
  const rng = sheet.getRange(SAVINGS_TOTALS_ROW, 1, SAVINGS_TOTAL_LABELS.length, 1);
  const cur = rng.getValues().map(r => String(r[0] || ''));
  if (cur.join('|') === SAVINGS_TOTAL_LABELS.join('|')) return;
  rng.setValues(SAVINGS_TOTAL_LABELS.map(l => [l])).setFontColor('#666').setFontSize(10);
  sheet.getRange(SAVINGS_TOTALS_ROW, 2, SAVINGS_TOTAL_LABELS.length, 1).setFontWeight('bold');
}

// El tipo tal como lo escribe la hoja puede venir sin tilde o en minuscula.
// Se lo lleva a la forma oficial apenas se lee, asi nadie mas abajo tiene que
// preocuparse por como estaba escrito.
function _savingsTipoCanon(raw) {
  const t = _stripAccents(String(raw || ''));
  return SAVINGS_TIPOS.find(x => _stripAccents(x) === t) || String(raw || '').trim();
}

function _savingsCupo(sheet) {
  return Math.max(0, Math.min(SAVINGS_MAX_ROWS, sheet.getMaxRows() - SAVINGS_FIRST_ROW + 1));
}

// Primera fila libre de la tabla (mira la fecha, col A)
function _savingsNextRow(sheet) {
  const cupo = _savingsCupo(sheet);
  if (!cupo) throw new Error('La hoja de ahorros no tiene filas libres');
  const vals = sheet.getRange(SAVINGS_FIRST_ROW, 1, cupo, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (!String(vals[i][0] || '').trim()) return SAVINGS_FIRST_ROW + i;
  }
  throw new Error('La hoja de ahorros llegó al máximo de ' + SAVINGS_MAX_ROWS + ' filas');
}

// Lee todos los movimientos cargados
function _savingsRows(sheet) {
  const cupo = _savingsCupo(sheet);
  if (!cupo) return [];
  const vals = sheet.getRange(SAVINGS_FIRST_ROW, 1, cupo, SAVINGS_HEADERS.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (!r[0] && !String(r[2] || '').trim()) continue;
    const d = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0] : parseLocalDate(r[0]);
    out.push({
      row: SAVINGS_FIRST_ROW + i,
      fecha: d ? Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM-dd') : '',
      tipo: _savingsTipoCanon(r[1]),
      entidad: String(r[2] || '').trim(),
      ticker: String(r[3] || '').trim().toUpperCase(),
      cantidad: toNumber(r[4]),
      precioUsd: toNumber(r[5]),
      comisionUsd: toNumber(r[6]) || 0,
      monto: toNumber(r[7]),
      moneda: String(r[8] || 'USD').trim().toUpperCase(),
      invertidoUsd: toNumber(r[9]) || 0,
      precioHoy: toNumber(r[10]),
      valorHoyUsd: toNumber(r[11]) || 0,
      notas: String(r[12] || '')
    });
  }
  return out;
}

// Precio del dia de un ticker. Yahoo devuelve de a un simbolo (el endpoint
// batch pide auth), asi que se cachea 15 min para no pegarle en cada pintada.
// Si falla, el llamador se queda con el ultimo precio que haya en la hoja: es
// preferible un total un poco viejo que un total en cero.
// Consulta cruda a Yahoo: precio y en que moneda cotiza.
function _yahooQuote(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                encodeURIComponent(symbol) + '?interval=1d&range=1d';
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());
    const meta = data && data.chart && data.chart.result && data.chart.result[0] &&
                 data.chart.result[0].meta;
    const precio = meta && toNumber(meta.regularMarketPrice);
    if (precio == null || precio <= 0) return null;
    return { precio: precio, moneda: String(meta.currency || 'USD').toUpperCase() };
  } catch (err) {
    Logger.log('_yahooQuote ' + symbol + ': ' + err.message);
    return null;
  }
}

// Igual que _yahooQuote pero para varios simbolos a la vez, en un solo
// round-trip (UrlFetchApp.fetchAll manda todas las requests en paralelo).
// _savingsRepaint pedia cada ticker uno detras del otro con _yahooQuote — con
// 8-10 acciones cargadas eso eran 8-10 round trips seguidos, la causa de que
// entrar a Ahorros tardara tanto.
function _yahooQuoteBatch(symbols) {
  const out = {};
  if (!symbols || !symbols.length) return out;
  const requests = symbols.map(s => ({
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=1d&range=1d',
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }));
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    Logger.log('_yahooQuoteBatch: ' + err.message);
    return out;
  }
  for (let i = 0; i < symbols.length; i++) {
    try {
      const resp = responses[i];
      if (!resp || resp.getResponseCode() !== 200) continue;
      const data = JSON.parse(resp.getContentText());
      const meta = data && data.chart && data.chart.result && data.chart.result[0] &&
                   data.chart.result[0].meta;
      const precio = meta && toNumber(meta.regularMarketPrice);
      if (precio == null || precio <= 0) continue;
      out[symbols[i]] = { precio: precio, moneda: String(meta.currency || 'USD').toUpperCase() };
    } catch (err) {
      Logger.log('_yahooQuoteBatch ' + symbols[i] + ': ' + err.message);
    }
  }
  return out;
}

// Cuanto vale 1 unidad de esa moneda en dolares. Yahoo sirve los tipos de
// cambio por el mismo endpoint (EURUSD=X), asi que no hace falta otra fuente.
function _fxAUsd(moneda) {
  const m = String(moneda || 'USD').toUpperCase();
  if (m === 'USD') return 1;
  const cache = CacheService.getScriptCache();
  const key = 'fx_' + m;
  try {
    const hit = cache.get(key);
    if (hit) return parseFloat(hit);
  } catch (e) {}
  const q = _yahooQuote(m + 'USD=X');
  if (!q || !q.precio) return null;
  try { cache.put(key, String(q.precio), SAVINGS_PRICE_TTL_SEC); } catch (e) {}
  return q.precio;
}

// Precio del dia de un ticker, SIEMPRE en dolares. Una accion que cotiza en
// otra moneda se convierte: sumar 2994 yenes como si fueran 2994 dolares
// inflaba el total unas 150 veces. Se cachea 15 min por ticker.
function fetchStockPrice(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  const cache = CacheService.getScriptCache();
  const key = 'px_' + t;
  try {
    const hit = cache.get(key);
    if (hit) {
      const c = JSON.parse(hit);
      return { precio: c.p, fuente: 'cache', moneda: c.m, monedaOriginal: c.o, precioOriginal: c.po };
    }
  } catch (e) {}

  const q = _yahooQuote(t);
  if (!q) return null;

  let precio = q.precio;
  if (q.moneda !== 'USD') {
    const fx = _fxAUsd(q.moneda);
    if (!fx) {
      Logger.log('fetchStockPrice ' + t + ': sin cambio para ' + q.moneda);
      return null;   // mejor sin precio que con un total inflado
    }
    precio = q.precio * fx;
  }

  const out = { precio: precio, fuente: 'yahoo', moneda: 'USD',
                monedaOriginal: q.moneda, precioOriginal: q.precio };
  try {
    cache.put(key, JSON.stringify({ p: precio, m: 'USD', o: q.moneda, po: q.precio }),
              SAVINGS_PRICE_TTL_SEC);
  } catch (e) {}
  return out;
}

// Precio (en dolares) de varios tickers a la vez. Mira el cache primero (15
// min) y solo sale a la red por los que faltan — y esos todos juntos con
// _yahooQuoteBatch, en vez de un fetchStockPrice() por ticker uno detras del
// otro. Igual con el tipo de cambio de las que no cotizan en USD.
function _fetchStockPricesBatch(tickers) {
  const out = {};
  const cache = CacheService.getScriptCache();
  const faltan = [];
  for (const t of tickers) {
    if (!t || out[t] !== undefined) continue;
    try {
      const hit = cache.get('px_' + t);
      if (hit) { out[t] = JSON.parse(hit).p; continue; }
    } catch (e) {}
    faltan.push(t);
  }
  if (!faltan.length) return out;

  const quotes = _yahooQuoteBatch(faltan);

  const monedas = {};
  for (const t of faltan) {
    const q = quotes[t];
    if (q && q.moneda !== 'USD') monedas[q.moneda] = true;
  }
  const fx = {};
  const monedasFaltan = [];
  for (const m of Object.keys(monedas)) {
    try {
      const hit = cache.get('fx_' + m);
      if (hit) { fx[m] = parseFloat(hit); continue; }
    } catch (e) {}
    monedasFaltan.push(m);
  }
  if (monedasFaltan.length) {
    const fxQuotes = _yahooQuoteBatch(monedasFaltan.map(m => m + 'USD=X'));
    for (const m of monedasFaltan) {
      const q = fxQuotes[m + 'USD=X'];
      if (q && q.precio) {
        fx[m] = q.precio;
        try { cache.put('fx_' + m, String(q.precio), SAVINGS_PRICE_TTL_SEC); } catch (e) {}
      }
    }
  }

  for (const t of faltan) {
    const q = quotes[t];
    if (!q) continue;
    let precio = q.precio;
    if (q.moneda !== 'USD') {
      const rate = fx[q.moneda];
      if (!rate) { Logger.log('_fetchStockPricesBatch ' + t + ': sin cambio para ' + q.moneda); continue; }
      precio = q.precio * rate;
    }
    out[t] = precio;
    try {
      cache.put('px_' + t, JSON.stringify({ p: precio, m: 'USD', o: q.moneda, po: q.precio }), SAVINGS_PRICE_TTL_SEC);
    } catch (e) {}
  }
  return out;
}

// Recalcula precio y valor de cada fila, y pinta los totales de arriba.
// Devuelve las filas ya valuadas para no tener que releer la hoja.
function _savingsRepaint(sheet) {
  const filas = _savingsRows(sheet);

  // Todos los tickers unicos de una, y sus precios pedidos en paralelo (ver
  // _fetchStockPricesBatch) en vez de un round-trip por ticker uno detras del
  // otro — eso era lo que hacia que entrar a Ahorros tardara tanto.
  const tickersUnicos = [];
  for (const f of filas) {
    if (f.tipo === 'Acción' && f.ticker && tickersUnicos.indexOf(f.ticker) === -1) tickersUnicos.push(f.ticker);
  }
  const preciosBatch = _fetchStockPricesBatch(tickersUnicos);
  const precios = {};
  for (const t of tickersUnicos) precios[t] = preciosBatch[t] != null ? preciosBatch[t] : null;

  let enAcciones = 0, enBanco = 0, enBonos = 0, invertidoAcciones = 0, comisiones = 0;
  const escribir = [];
  for (const f of filas) {
    let precioHoy = '', valor = 0;
    if (f.tipo === 'Acción') {
      // Sin precio nuevo se conserva el ultimo conocido, asi el total no se cae
      const px = precios[f.ticker] != null ? precios[f.ticker] : f.precioHoy;
      if (px != null && f.cantidad != null) { precioHoy = px; valor = f.cantidad * px; }
      else { valor = f.invertidoUsd; }
      enAcciones += valor;
      invertidoAcciones += f.invertidoUsd;
      comisiones += (f.comisionUsd || 0);
    } else {
      valor = f.invertidoUsd;
      if (f.tipo === 'Bono') enBonos += valor; else enBanco += valor;
    }
    f.precioHoy = precioHoy === '' ? null : precioHoy;
    f.valorHoyUsd = valor;
    escribir.push({ row: f.row, precioHoy: precioHoy, valor: valor });
  }

  for (const e of escribir) {
    sheet.getRange(e.row, 11, 1, 2).setValues([[e.precioHoy, e.valor]]);
  }

  const totalUsd = enAcciones + enBanco + enBonos;
  const gananciaUsd = enAcciones - invertidoAcciones;
  const cot = _savingsCotizacion();
  sheet.getRange(SAVINGS_TOTALS_ROW, 2, SAVINGS_TOTAL_LABELS.length, 1).setValues([
    [totalUsd], [totalUsd * cot], [invertidoAcciones], [comisiones], [gananciaUsd],
    [enAcciones], [enBanco], [enBonos], [cot]
  ]);

  return {
    filas: filas,
    totales: {
      totalUsd: totalUsd, totalUyu: totalUsd * cot, cotizacion: cot,
      enAcciones: enAcciones, enBanco: enBanco, enBonos: enBonos,
      invertidoAcciones: invertidoAcciones, comisionesUsd: comisiones,
      gananciaUsd: gananciaUsd,
      gananciaPct: _savingsPct(gananciaUsd, invertidoAcciones)
    }
  };
}

function _r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Porcentaje de ganancia. Sin nada invertido no hay porcentaje que calcular
// (dividir por cero daria Infinity y la app mostraria "∞%").
function _savingsPct(ganancia, invertido) {
  if (!invertido) return null;
  return Math.round((ganancia / invertido) * 1000) / 10;
}

function _savingsCotizacion() {
  try {
    const r = fetchBcuRate();
    if (r && r.rate) return r.rate;
  } catch (e) {}
  return COTIZ_FALLBACK;
}

// Agrupa los movimientos en posiciones: dos compras de NVDA son una sola
// posicion, con la cantidad sumada y el precio promedio ponderado.
function _savingsPosiciones(filas) {
  const mapa = {};
  for (const f of filas) {
    const clave = f.tipo === 'Acción' ? 'A|' + f.ticker
                                      : f.tipo + '|' + _stripAccents(f.entidad);
    if (!mapa[clave]) {
      const info = _tickerInfo(f.ticker);
      mapa[clave] = {
        clave: clave, tipo: f.tipo, ticker: f.ticker,
        nombre: f.entidad || (info && info.nombre) || f.ticker,
        dominio: info ? info.dominio : '',
        cantidad: 0, invertidoUsd: 0, valorHoyUsd: 0, comisionUsd: 0,
        precioHoy: f.precioHoy, movimientos: 0
      };
    }
    const p = mapa[clave];
    p.cantidad += (f.cantidad || 0);
    p.invertidoUsd += (f.invertidoUsd || 0);
    p.valorHoyUsd += (f.valorHoyUsd || 0);
    p.comisionUsd += (f.comisionUsd || 0);
    p.movimientos += 1;
    if (f.precioHoy != null) p.precioHoy = f.precioHoy;
  }
  return Object.keys(mapa).map(k => {
    const p = mapa[k];
    // Solo las acciones ganan o pierden: el banco y los bonos valen lo puesto
    p.gananciaUsd = p.tipo === 'Acción' ? p.valorHoyUsd - p.invertidoUsd : 0;
    p.gananciaPct = p.tipo === 'Acción' ? _savingsPct(p.gananciaUsd, p.invertidoUsd) : null;
    // Sin precio del dia se valua al costo, pero eso NO es "no se movio": no
    // sabemos cuanto vale. La app lo dice en vez de mostrar un +0% mentiroso.
    p.sinPrecio = p.tipo === 'Acción' && p.precioHoy == null;
    return p;
  }).sort((a, b) => b.valorHoyUsd - a.valorHoyUsd);
}

// Normaliza lo que manda el cliente. Una accion necesita ticker y cantidad;
// el banco y los bonos, un monto.
function _normSaving(p) {
  const tipoRaw = String(p.tipo || '').trim();
  const tipo = SAVINGS_TIPOS.find(t => _stripAccents(t) === _stripAccents(tipoRaw));
  if (!tipo) throw new Error('Tipo inválido: usá ' + SAVINGS_TIPOS.join(', '));

  const fecha = p.fecha || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  if (!parseLocalDate(fecha)) throw new Error('Fecha inválida');
  const notas = String(p.notas || '').trim();

  if (tipo === 'Acción') {
    const ticker = String(p.ticker || '').trim().toUpperCase();
    if (!ticker) throw new Error('Falta el ticker de la acción (NVDA, AMD, …)');
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) throw new Error('Ticker inválido: ' + ticker);
    const cantidad = toNumber(String(p.cantidad == null ? '' : p.cantidad).replace(',', '.'));
    if (cantidad == null || cantidad <= 0) throw new Error('Cantidad de acciones inválida');

    // Tres numeros que siempre tienen que cerrar:
    //     acciones (cantidad x precio) + comision = total gastado
    // Se puede cargar cualquier combinacion; del resto se deduce el que falte.
    const num = v => toNumber(String(v == null ? '' : v).replace(',', '.'));
    let precio = num(p.precioUsd);
    let comision = num(p.comisionUsd !== undefined ? p.comisionUsd : p.comision);
    let gastado = num(p.gastadoUsd !== undefined ? p.gastadoUsd : p.gastado);

    if (precio == null && gastado == null) {
      throw new Error('Poné el precio por acción o cuánto gastaste en total');
    }
    if (precio != null && precio < 0) throw new Error('Precio de compra inválido');
    if (comision != null && comision < 0) throw new Error('La comisión no puede ser negativa');
    if (gastado != null && gastado < 0) throw new Error('Lo gastado no puede ser negativo');

    if (precio != null && gastado != null) {
      // El precio por accion viene redondeado a centavos (lo redondea el form, y
      // tambien el resumen del broker). Multiplicado por una cantidad
      // fraccionada, ese redondeo se amplifica: 8,956358 acciones a 218,73
      // "sobran" un centavo contra el total real. La tolerancia tiene que
      // acompañar a la cantidad, no ser fija.
      const costo = cantidad * precio;
      const tol = 0.01 + cantidad * 0.005;
      if (comision == null) {
        if (gastado - costo < -tol) {
          throw new Error('Lo gastado (US$ ' + _r2(gastado) + ') es menor que las acciones (US$ ' +
                          _r2(costo) + '). Revisá el precio o el total.');
        }
        comision = Math.max(0, gastado - costo);
      } else if (Math.abs(costo + comision - gastado) > tol) {
        throw new Error('No cierra: US$ ' + _r2(costo) + ' de acciones + US$ ' + _r2(comision) +
                        ' de comisión dan US$ ' + _r2(costo + comision) +
                        ', no US$ ' + _r2(gastado));
      } else {
        // Cierran dentro de lo que explica el redondeo. Lo gastado y la
        // comision son plata exacta que el usuario conoce; el precio por accion
        // es el derivado, asi que se recalcula con precision completa y no
        // quedan centavos colgados en la hoja.
        precio = (gastado - comision) / cantidad;
      }
    } else if (precio != null) {
      comision = comision || 0;
      gastado = cantidad * precio + comision;
    } else {
      // Solo el total: se le resta la comision y recien ahi sale el precio por
      // accion. Sin restarla, la comision quedaria repartida en el precio y
      // ensuciaria la ganancia de ahi en adelante.
      comision = comision || 0;
      const costo = gastado - comision;
      if (costo <= 0) throw new Error('La comisión no puede ser mayor o igual a lo gastado');
      precio = costo / cantidad;
    }

    const info = _tickerInfo(ticker);
    return {
      fecha: fecha, tipo: tipo,
      entidad: String(p.entidad || '').trim() || (info ? info.nombre : ticker),
      ticker: ticker, cantidad: cantidad, precioUsd: precio, comisionUsd: comision,
      monto: '', moneda: 'USD', costoUsd: cantidad * precio,
      invertidoUsd: gastado, notas: notas
    };
  }

  const entidad = String(p.entidad || '').trim();
  if (!entidad) throw new Error(tipo === 'Banco' ? 'Falta el banco' : 'Falta el nombre del bono');
  const monto = toNumber(String(p.monto == null ? '' : p.monto).replace(',', '.'));
  if (monto == null || monto <= 0) throw new Error('Monto inválido');
  const moneda = SAVINGS_MONEDAS.indexOf(String(p.moneda || 'USD').toUpperCase()) >= 0
    ? String(p.moneda || 'USD').toUpperCase() : 'USD';
  const invertidoUsd = moneda === 'UYU' ? monto / _savingsCotizacion() : monto;
  return {
    fecha: fecha, tipo: tipo, entidad: entidad, ticker: '', cantidad: '', precioUsd: '',
    comisionUsd: '', monto: monto, moneda: moneda, invertidoUsd: invertidoUsd, notas: notas
  };
}

function _savingsEscribirFila(sheet, row, e) {
  sheet.getRange(row, 1, 1, 10).setValues([[
    parseLocalDate(e.fecha), e.tipo, e.entidad, e.ticker, e.cantidad,
    e.precioUsd, e.comisionUsd, e.monto, e.moneda, e.invertidoUsd
  ]]);
  sheet.getRange(row, 1).setNumberFormat('dd/MM/yyyy');
  sheet.getRange(row, SAVINGS_HEADERS.length).setValue(e.notas);
}

// Estado completo: movimientos, posiciones agrupadas y totales
function getSavingsData() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateSavingsTab(ss);
    const r = _savingsRepaint(sheet);

    // Saldo disponible: banco deposits minus current month expenses plus income
    const bancoRows = r.filas.filter(f => f.tipo === 'Banco');
    const hasBancoUyu = bancoRows.some(f => f.moneda === 'UYU');
    const hasBancoUsd = bancoRows.some(f => f.moneda === 'USD');
    const bancoUyu = bancoRows.filter(f => f.moneda === 'UYU').reduce((s, f) => s + (f.monto || 0), 0);
    const bancoUsd = bancoRows.filter(f => f.moneda === 'USD').reduce((s, f) => s + (f.monto || 0), 0);
    const mesActual = currentMonthTab();
    const expTotales = _monthExpenseTotals(mesActual);
    const ingTotales = _ingresosThisMonth();
    const saldoUyu = hasBancoUyu ? Math.round((bancoUyu - expTotales.uyu + ingTotales.uyu) * 100) / 100 : null;
    const saldoUsd = hasBancoUsd ? Math.round((bancoUsd - expTotales.usd + ingTotales.usd) * 100) / 100 : null;

    return {
      ok: true, tab: SAVINGS_TAB,
      movimientos: r.filas, posiciones: _savingsPosiciones(r.filas),
      totales: r.totales, tipos: SAVINGS_TIPOS, monedas: SAVINGS_MONEDAS,
      saldo: { uyu: saldoUyu, usd: saldoUsd, mesActual, gastosUyu: expTotales.uyu, gastosUsd: expTotales.usd, ingresosUyu: ingTotales.uyu, ingresosUsd: ingTotales.usd }
    };
  } catch (err) {
    Logger.log('getSavingsData: ' + err.message);
    return { ok: false, error: err.message };
  }
}

// Agrega un movimiento. p: { tipo, fecha, entidad, ticker, cantidad, precioUsd,
//                            monto, moneda, notas }
function addSavingsEntry(p) {
  const e = _normSaving(p || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let row, res;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateSavingsTab(ss);
    row = _savingsNextRow(sheet);
    _savingsEscribirFila(sheet, row, e);
    SpreadsheetApp.flush();
    res = _savingsRepaint(sheet);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: SAVINGS_TAB, row: row, written: e, totales: res.totales };
}

// Edita un movimiento ya cargado. p: { row, ...campos }
function updateSavingsEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < SAVINGS_FIRST_ROW) throw new Error('Fila inválida');
  const e = _normSaving(p || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let res;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateSavingsTab(ss);
    const cur = sheet.getRange(row, 1, 1, SAVINGS_HEADERS.length).getValues()[0];
    if (!cur[0] && !String(cur[2] || '').trim()) {
      throw new Error('Esa fila está vacía — recargá los ahorros e intentá de nuevo');
    }
    _savingsEscribirFila(sheet, row, e);
    SpreadsheetApp.flush();
    res = _savingsRepaint(sheet);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: SAVINGS_TAB, row: row, written: e, totales: res.totales };
}

// Borra un movimiento.
function deleteSavingsEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < SAVINGS_FIRST_ROW) throw new Error('Fila inválida');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let borrado, res;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateSavingsTab(ss);
    const cur = sheet.getRange(row, 1, 1, SAVINGS_HEADERS.length).getValues()[0];
    if (!cur[0] && !String(cur[2] || '').trim()) throw new Error('Esa fila ya está vacía');
    borrado = String(cur[2] || cur[3] || '');
    // Se limpia en vez de deleteRow para no correr las filas de abajo: el
    // cliente guarda el numero de fila como id.
    sheet.getRange(row, 1, 1, SAVINGS_HEADERS.length).clearContent();
    SpreadsheetApp.flush();
    res = _savingsRepaint(sheet);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: SAVINGS_TAB, deleted: borrado, totales: res.totales };
}


// === ARGENTINA: cargas de plata, gastos en ARS y deuda con mama =============
// ============================================================================
//
// Modelo: se carga plata a un pozo (300 USD mios, 200 de mama) y de ahi salen
// los gastos en pesos argentinos. La deuda con mama se lleva en USD, que es lo
// que ella presto, sin importar como se movio el peso despues.
//
// Todo vive en UNA sola tabla con columna "Tipo" (Carga | Gasto | Pago) en vez
// de tres tablas separadas. Motivo: la seccion va al costado de la tabla
// variable del mes, y borrar una fila con deleteRow correria tambien las filas
// de la tabla de al lado. Con una sola tabla el borrado se hace compactando
// hacia arriba SOLO dentro de las columnas de Argentina.

const ARG_TITLE = '🇦🇷 ARGENTINA';
const ARG_HEADERS = ['Fecha', 'Tipo', 'Detalle', 'USD', 'Cotización', 'ARS', 'De quién', 'Categoría'];
const ARG_TIPOS = ['Carga', 'Gasto', 'Pago'];
const ARG_QUIENES = ['Mía', 'Mamá'];
const ARG_NEW_TITLE_ROW = 1;   // solo para bloques nuevos; los existentes se buscan
const ARG_MAX_ROWS = 300;
const ARG_SEARCH_ROWS = 12;    // hasta que fila se busca el titulo

// Busca el bloque por su titulo en cualquier fila/columna y deduce el resto de
// las filas leyendo la hoja. Antes las filas eran constantes (titulo en la 1,
// header en la 7) y alcanzaba con que el usuario arrastrara el bloque para que
// el codigo escribiera encima del titulo o creara un bloque duplicado al lado.
function _findArgBlock(sheet) {
  const maxCol = sheet.getMaxColumns();
  const filas = Math.min(ARG_SEARCH_ROWS, sheet.getMaxRows());
  const zona = sheet.getRange(1, 1, filas, maxCol).getValues();
  let titleRow = -1, col = -1;
  for (let r = 0; r < zona.length && titleRow < 0; r++) {
    for (let c = 0; c < zona[r].length; c++) {
      if (String(zona[r][c] || '').indexOf('ARGENTINA') >= 0) { titleRow = r + 1; col = c + 1; break; }
    }
  }
  if (titleRow < 0) return null;

  // El header es la primera fila debajo del titulo que arranca con Fecha|Tipo
  const hasta = Math.min(titleRow + 15, sheet.getMaxRows());
  const abajo = sheet.getRange(titleRow, col, hasta - titleRow + 1, 2).getValues();
  let headerRow = -1;
  for (let i = 1; i < abajo.length; i++) {
    if (/^fecha$/i.test(String(abajo[i][0] || '').trim()) &&
        /^tipo$/i.test(String(abajo[i][1] || '').trim())) { headerRow = titleRow + i; break; }
  }
  if (headerRow < 0) return null;
  return { col: col, titleRow: titleRow, totalsRow: titleRow + 1,
           headerRow: headerRow, firstRow: headerRow + 1 };
}

// Devuelve el bloque, creandolo si no existe. Se ubica solo a la derecha de
// todo lo que ya haya en la hoja, asi no pisa las tablas viejas de viajes que
// algunos meses tienen a mano.
function getOrCreateArgBlock(sheet) {
  const found = _findArgBlock(sheet);
  if (found) return found;

  const col = Math.max(sheet.getLastColumn(), 10) + 2;
  const titleRow = ARG_NEW_TITLE_ROW;
  const headerRow = titleRow + ARG_TOTAL_LABELS.length + 2;   // una fila en blanco de respiro
  const blk = { col: col, titleRow: titleRow, totalsRow: titleRow + 1,
                headerRow: headerRow, firstRow: headerRow + 1 };

  sheet.getRange(titleRow, col).setValue(ARG_TITLE).setFontWeight('bold').setFontSize(13);
  _argEscribirEtiquetas(sheet, blk);
  sheet.getRange(headerRow, col, 1, ARG_HEADERS.length)
       .setValues([ARG_HEADERS]).setFontWeight('bold').setBackground('#dbeafe');

  sheet.setColumnWidth(col, 90);
  sheet.setColumnWidth(col + 2, 190);

  // Arrastra la deuda con mamá del mes anterior. Antes esta celda arrancaba
  // en blanco (0) en cada mes nuevo y había que copiarla a mano; si nadie se
  // acordaba, el mes "perdía el hilo" y mostraba deuda 0 aunque veníamos
  // debiendo (o nos debían) de antes. Solo corre acá, al crear el bloque por
  // primera vez: después de esto la celda vuelve a ser solo del usuario.
  const heredada = _argDeudaFinMesAnterior(sheet);
  if (heredada) {
    sheet.getRange(blk.totalsRow + ARG_IDX_DEUDA_ANTES, blk.col + 1).setValue(heredada);
  }
  return blk;
}

// Deuda final (USD) del bloque de Argentina del mes calendario anterior al de
// esta hoja, o 0 si no hay mes anterior, no tiene tab, o no tiene bloque.
function _argDeudaFinMesAnterior(sheet) {
  try {
    const prevName = _prevMonth(sheet.getName());
    if (!prevName) return 0;
    const prevSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(prevName);
    if (!prevSheet) return 0;
    const prevBlk = _findArgBlock(prevSheet);
    if (!prevBlk) return 0;
    const entradas = _argRows(prevSheet, prevBlk);
    const totales = _argTotales(entradas, _argLeerDeudaAntes(prevSheet, prevBlk));
    return totales.deudaUsd || 0;
  } catch (e) {
    Logger.log('_argDeudaFinMesAnterior: ' + e.message);
    return 0;
  }
}

// Cuántas filas de datos entran sin pasarse del final de la hoja
function _argCupo(sheet, blk) {
  return Math.max(0, Math.min(ARG_MAX_ROWS, sheet.getMaxRows() - blk.firstRow + 1));
}

function _argRows(sheet, blk) {
  const vals = sheet.getRange(blk.firstRow, blk.col, _argCupo(sheet, blk), ARG_HEADERS.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    const tipo = String(r[1] || '').trim();
    if (!tipo) continue;
    const d = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0] : parseLocalDate(r[0]);
    out.push({
      row: blk.firstRow + i,
      fecha: d && !isNaN(d.getTime()) ? Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM-dd') : '',
      tipo: tipo,
      detalle: String(r[2] || ''),
      usd: toNumber(r[3]),
      cotiz: toNumber(r[4]),
      ars: toNumber(r[5]),
      quien: String(r[6] || ''),
      categoria: String(r[7] || '')
    });
  }
  return out;
}

// Cada gasto dice de quién era la plata y a qué cotización. La deuda con mamá
// sale de sumar los dólares de los gastos hechos con plata suya, menos lo que
// ya se le devolvió. Las "cargas" ya no se usan pero se siguen sumando para no
// romper meses viejos que las tengan cargadas.
function _argTotales(entradas, deudaAntesOpt) {
  const deudaAntes = Math.round((toNumber(deudaAntesOpt) || 0) * 100) / 100;
  let gastadoArs = 0, gastadoUsd = 0, mamaUsd = 0, mioUsd = 0, pagadoUsd = 0;
  for (const e of entradas) {
    const t = _stripAccents(e.tipo).toLowerCase();
    const esMama = _stripAccents(e.quien).toLowerCase().indexOf('mama') >= 0;
    if (t === 'gasto') {
      gastadoArs += e.ars || 0;
      gastadoUsd += e.usd || 0;
      if (esMama) mamaUsd += e.usd || 0; else mioUsd += e.usd || 0;
    } else if (t === 'carga') {          // legacy
      if (esMama) mamaUsd += e.usd || 0; else mioUsd += e.usd || 0;
    } else if (t === 'pago') {
      pagadoUsd += e.usd || 0;
    }
  }
  const r2 = n => Math.round(n * 100) / 100;
  return {
    gastadoArs: Math.round(gastadoArs),
    gastadoUsd: r2(gastadoUsd),
    pusoMamaUsd: r2(mamaUsd),
    pusoMioUsd: r2(mioUsd),
    pagadoUsd: r2(pagadoUsd),
    deudaAntesUsd: deudaAntes,
    deudaUsd: r2(deudaAntes + mamaUsd - pagadoUsd)
  };
}

// La deuda con mamá no arranca de cero cada mes: viene arrastrada. La celda
// "Deuda de antes" es la única del bloque que escribe el usuario a mano; el
// código la lee y nunca la pisa.
const ARG_LBL_DEUDA_ANTES = 'Deuda de antes (USD)';
const ARG_TOTAL_LABELS = ['Gasté (ARS)', 'Gasté (USD)', ARG_LBL_DEUDA_ANTES,
                          'Le debo a mamá (USD)', 'Puse de lo mío (USD)'];
const ARG_IDX_DEUDA_ANTES = ARG_TOTAL_LABELS.indexOf(ARG_LBL_DEUDA_ANTES);

// Cuántas filas de totales entran entre el título y el header. En bloques que
// el usuario movió puede haber menos espacio del que asume el layout nuevo.
function _argFilasTotales(blk) {
  return Math.max(0, Math.min(ARG_TOTAL_LABELS.length, blk.headerRow - blk.totalsRow));
}

function _argLeerDeudaAntes(sheet, blk) {
  const n = _argFilasTotales(blk);
  if (!n) return 0;
  const labels = sheet.getRange(blk.totalsRow, blk.col, n, 2).getValues();
  for (const [lbl, val] of labels) {
    if (String(lbl || '').indexOf('antes') >= 0) return toNumber(val) || 0;
  }
  return 0;
}

// Las etiquetas se reescriben en cada pintada: los bloques viejos decían
// "Queda en el pozo" y quedarían mintiendo.
function _argEscribirEtiquetas(sheet, blk) {
  const n = _argFilasTotales(blk);
  if (!n) return;
  const esperadas = ARG_TOTAL_LABELS.slice(0, n);
  const rng = sheet.getRange(blk.totalsRow, blk.col, n, 1);
  const cur = rng.getValues().map(r => String(r[0] || ''));
  if (cur.join('|') === esperadas.join('|')) return;
  rng.setValues(esperadas.map(l => [l])).setFontColor('#666').setFontSize(10);
  sheet.getRange(blk.totalsRow, blk.col + 1, n, 1).setFontWeight('bold');
}

function _argPintarTotales(sheet, blk, t) {
  _argEscribirEtiquetas(sheet, blk);
  const valores = [t.gastadoArs, t.gastadoUsd, t.deudaUsd, t.pusoMioUsd];
  // Se escriben todas menos "Deuda de antes", que es del usuario
  const n = _argFilasTotales(blk);
  let vi = 0;
  for (let i = 0; i < n; i++) {
    if (i === ARG_IDX_DEUDA_ANTES) continue;
    if (vi >= valores.length) break;
    sheet.getRange(blk.totalsRow + i, blk.col + 1).setValue(valores[vi++]);
  }
}

// Lee el mes entero: entradas + totales
function getArgentinaData(monthOpt) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const tabName = monthOpt || currentMonthTab();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return { ok: false, error: 'No existe la hoja "' + tabName + '"' };

    const blk = _findArgBlock(sheet);
    if (!blk) {
      return { ok: true, tab: tabName, exists: false, entradas: [],
               totales: _argTotales([]), tipos: ARG_TIPOS, quienes: ARG_QUIENES,
               categorias: categoriasOrdenadas() };
    }
    const entradas = _argRows(sheet, blk);
    return { ok: true, tab: tabName, exists: true, col: blk.col, bloque: blk, entradas: entradas,
             totales: _argTotales(entradas, _argLeerDeudaAntes(sheet, blk)),
             tipos: ARG_TIPOS, quienes: ARG_QUIENES,
             categorias: categoriasOrdenadas() };
  } catch (err) {
    Logger.log('getArgentinaData: ' + err.message);
    return { ok: false, error: err.message };
  }
}


// Agrega una entrada. p: { month, fecha, tipo, detalle, usd, cotiz, ars, quien, categoria }
// - Gasto: se piden ARS y cotización; los USD salen de dividir, y "de quién"
//          dice si esa plata era propia o de mamá.
// - Pago:  se pide USD (lo que le devolviste a mamá).
// - Carga: legacy, ya no se ofrece en la app.
function addArgentinaEntry(p) {
  const tipoRaw = String(p.tipo || '').trim();
  const tipo = ARG_TIPOS.find(t => _stripAccents(t).toLowerCase() === _stripAccents(tipoRaw).toLowerCase());
  if (!tipo) throw new Error('Tipo inválido: usá Carga, Gasto o Pago');

  const num = v => (v === undefined || v === '' || v === null) ? null : toNumber(String(v).replace(',', '.'));
  let usd = num(p.usd), cotiz = num(p.cotiz), ars = num(p.ars);

  if (tipo === 'Carga') {
    if (usd == null || usd <= 0) throw new Error('Una carga necesita el monto en USD');
    if (ars == null && cotiz != null) ars = Math.round(usd * cotiz);
    if (ars == null) throw new Error('Falta la cotización o los ARS que recibiste');
  } else if (tipo === 'Gasto') {
    if (ars == null || ars <= 0) throw new Error('Un gasto necesita el monto en ARS');
    if (cotiz == null || cotiz <= 0) throw new Error('Falta la cotización del dólar');
    if (usd == null) usd = Math.round((ars / cotiz) * 100) / 100;
  } else {
    if (usd == null || usd <= 0) throw new Error('Un pago necesita el monto en USD');
  }

  const fecha = p.fecha || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const tabName = p.month || monthTabFor(fecha);

  // Quién: de quién era la plata. Un pago siempre es a mamá.
  const q = String(p.quien || '').trim();
  const quien = ARG_QUIENES.find(x => _stripAccents(x).toLowerCase() === _stripAccents(q).toLowerCase())
                || (tipo === 'Pago' ? 'Mamá' : 'Mía');

  // Lock por el mismo motivo que en el log de hábitos: buscar la fila libre y
  // escribir no es atómico, y la hoja se abre adentro para no leer un snapshot
  // viejo.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let insertAt, totales;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateMonthTab(ss, tabName);
    const blk = getOrCreateArgBlock(sheet);

    const existentes = _argRows(sheet, blk);
    insertAt = existentes.length ? existentes[existentes.length - 1].row + 1 : blk.firstRow;
    if (insertAt >= blk.firstRow + _argCupo(sheet, blk)) throw new Error('La sección de Argentina está llena');

    sheet.getRange(insertAt, blk.col, 1, ARG_HEADERS.length).setValues([[
      parseLocalDate(fecha), tipo, String(p.detalle || '').trim(),
      usd == null ? '' : usd, cotiz == null ? '' : cotiz, ars == null ? '' : ars,
      quien, tipo === 'Gasto' ? String(p.categoria || '').trim() : ''
    ]]);
    sheet.getRange(insertAt, blk.col).setNumberFormat('dd/MM/yyyy');
    SpreadsheetApp.flush();

    totales = _argTotales(_argRows(sheet, blk), _argLeerDeudaAntes(sheet, blk));
    _argPintarTotales(sheet, blk, totales);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return { ok: true, tab: tabName, row: insertAt, totales: totales,
           written: { tipo: tipo, detalle: p.detalle || '', usd: usd, cotiz: cotiz, ars: ars, quien: quien } };
}

// Edita una entrada existente. Sólo pisa los campos que llegan.
function updateArgentinaEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row)) throw new Error('Fila inválida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = p.month || currentMonthTab();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('No existe la hoja "' + tabName + '"');
  const blk = _findArgBlock(sheet);
  if (!blk) throw new Error('Esta hoja no tiene sección de Argentina');
  const col = blk.col;
  if (row < blk.firstRow) throw new Error('Fila inválida');

  const cur = sheet.getRange(row, col, 1, ARG_HEADERS.length).getValues()[0];
  if (!String(cur[1] || '').trim()) throw new Error('Esa fila está vacía — recargá y probá de nuevo');

  const num = v => (v === undefined || v === '' || v === null) ? null : toNumber(String(v).replace(',', '.'));
  const tipoRaw = String(p.tipo || '').trim();
  const tipo = tipoRaw
    ? (ARG_TIPOS.find(t => _stripAccents(t).toLowerCase() === _stripAccents(tipoRaw).toLowerCase()) || String(cur[1]))
    : String(cur[1]);

  let usd   = p.usd   !== undefined && p.usd   !== '' ? num(p.usd)   : toNumber(cur[3]);
  let cotiz = p.cotiz !== undefined && p.cotiz !== '' ? num(p.cotiz) : toNumber(cur[4]);
  let ars   = p.ars   !== undefined && p.ars   !== '' ? num(p.ars)   : toNumber(cur[5]);
  // Un gasto se carga en pesos: si cambian los pesos o la cotización, los
  // dólares se recalculan solos. En las cargas viejas es al revés.
  if (tipo === 'Gasto' && ars != null && cotiz != null && cotiz > 0) {
    usd = Math.round((ars / cotiz) * 100) / 100;
  } else if (tipo === 'Carga' && usd != null && cotiz != null &&
      (p.usd !== undefined || p.cotiz !== undefined) && p.ars === undefined) {
    ars = Math.round(usd * cotiz);
  }

  const fecha = p.fecha || (Object.prototype.toString.call(cur[0]) === '[object Date]'
    ? Utilities.formatDate(cur[0], 'America/Montevideo', 'yyyy-MM-dd') : String(cur[0] || ''));

  sheet.getRange(row, col, 1, ARG_HEADERS.length).setValues([[
    fecha ? parseLocalDate(fecha) : cur[0],
    tipo,
    p.detalle !== undefined ? String(p.detalle).trim() : String(cur[2] || ''),
    usd == null ? '' : usd, cotiz == null ? '' : cotiz, ars == null ? '' : ars,
    p.quien !== undefined ? String(p.quien).trim() : String(cur[6] || ''),
    p.categoria !== undefined ? String(p.categoria).trim() : String(cur[7] || '')
  ]]);
  sheet.getRange(row, col).setNumberFormat('dd/MM/yyyy');
  SpreadsheetApp.flush();

  const totales = _argTotales(_argRows(sheet, blk), _argLeerDeudaAntes(sheet, blk));
  _argPintarTotales(sheet, blk, totales);
  return { ok: true, tab: tabName, row: row, totales: totales };
}

// Borra una entrada COMPACTANDO hacia arriba sólo dentro de las columnas de
// Argentina. No se usa deleteRow: la seccion convive al costado de la tabla
// variable del mes y borrar la fila entera correria los gastos de al lado.
function deleteArgentinaEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row)) throw new Error('Fila inválida');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = p.month || currentMonthTab();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('No existe la hoja "' + tabName + '"');
  const blk = _findArgBlock(sheet);
  if (!blk) throw new Error('Esta hoja no tiene sección de Argentina');
  const col = blk.col;
  if (row < blk.firstRow) throw new Error('Fila inválida');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let borrado, totales;
  try {
    const cupo = _argCupo(sheet, blk);
    const rng = sheet.getRange(blk.firstRow, col, cupo, ARG_HEADERS.length);
    const vals = rng.getValues();
    const idx = row - blk.firstRow;
    if (idx < 0 || idx >= vals.length || !String(vals[idx][1] || '').trim()) {
      throw new Error('Esa fila ya está vacía — recargá y probá de nuevo');
    }
    borrado = String(vals[idx][2] || '') + ' (' + String(vals[idx][1] || '') + ')';
    vals.splice(idx, 1);
    vals.push(new Array(ARG_HEADERS.length).fill(''));
    rng.setValues(vals);
    sheet.getRange(blk.firstRow, col, cupo, 1).setNumberFormat('dd/MM/yyyy');
    SpreadsheetApp.flush();

    totales = _argTotales(_argRows(sheet, blk), _argLeerDeudaAntes(sheet, blk));
    _argPintarTotales(sheet, blk, totales);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: tabName, deleted: borrado, totales: totales };
}

// Fija la deuda que viene arrastrada de meses anteriores.
function setArgDeudaAntes(monthOpt, usdRaw) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabName = monthOpt || currentMonthTab();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('No existe la hoja "' + tabName + '"');
  const blk = getOrCreateArgBlock(sheet);
  _argEscribirEtiquetas(sheet, blk);
  const n = _argFilasTotales(blk);
  if (n <= ARG_IDX_DEUDA_ANTES) throw new Error('No hay lugar para la fila de deuda anterior');
  const usd = toNumber(String(usdRaw == null ? '' : usdRaw).replace(',', '.')) || 0;
  sheet.getRange(blk.totalsRow + ARG_IDX_DEUDA_ANTES, blk.col + 1).setValue(usd);
  SpreadsheetApp.flush();
  const totales = _argTotales(_argRows(sheet, blk), usd);
  _argPintarTotales(sheet, blk, totales);
  return { ok: true, tab: tabName, deudaAntesUsd: usd, totales: totales };
}

// === Wrappers para google.script.run ===
function getSavingsDataSafe() {
  try { return getSavingsData(); }
  catch (err) { Logger.log('getSavingsDataSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function addSavingsSafe(data) {
  try { return addSavingsEntry(data || {}); }
  catch (err) { Logger.log('addSavingsSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function updateSavingsSafe(data) {
  try { return updateSavingsEntry(data || {}); }
  catch (err) { Logger.log('updateSavingsSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function deleteSavingsSafe(data) {
  try { return deleteSavingsEntry(data || {}); }
  catch (err) { Logger.log('deleteSavingsSafe: ' + err.message); return { ok: false, error: err.message }; }
}

// === INGRESOS ===

function getOrCreateIngresosTab(ss) {
  var sheet = ss.getSheetByName(INGRESOS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(INGRESOS_TAB);
    sheet.getRange(INGRESOS_HEADER_ROW, 1, 1, INGRESOS_HEADERS.length).setValues([INGRESOS_HEADERS]);
    sheet.getRange(INGRESOS_HEADER_ROW, 1, 1, INGRESOS_HEADERS.length).setFontWeight('bold');
    reorderSheets(false);
  }
  return sheet;
}

function _ingresosRows(sheet) {
  var last = sheet.getLastRow();
  if (last < INGRESOS_FIRST_ROW) return [];
  var data = sheet.getRange(INGRESOS_FIRST_ROW, 1, last - INGRESOS_FIRST_ROW + 1, INGRESOS_HEADERS.length).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var d = data[i];
    if (!d[0]) continue;
    rows.push({
      row: INGRESOS_FIRST_ROW + i,
      fecha: d[0] instanceof Date ? Utilities.formatDate(d[0], 'America/Montevideo', 'yyyy-MM-dd') : String(d[0]),
      concepto: String(d[1] || '').trim(),
      monto: toNumber(d[2]) || 0,
      moneda: String(d[3] || 'UYU').toUpperCase(),
      notas: String(d[4] || '').trim()
    });
  }
  return rows;
}

function _ingresosNextRow(sheet) {
  var last = sheet.getLastRow();
  if (last < INGRESOS_HEADER_ROW) return INGRESOS_FIRST_ROW;
  for (var r = INGRESOS_FIRST_ROW; r <= last + 1; r++) {
    if (!sheet.getRange(r, 1).getValue()) return r;
  }
  return last + 1;
}

function getIngresosData() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = getOrCreateIngresosTab(ss);
  return { ok: true, ingresos: _ingresosRows(sheet) };
}

function addIngresoEntry(p) {
  var fecha = p.fecha || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  var concepto = String(p.concepto || '').trim();
  if (!concepto) throw new Error('Falta el concepto');
  var monto = toNumber(String(p.monto == null ? '' : p.monto).replace(',', '.'));
  if (!monto || monto <= 0) throw new Error('Monto inválido');
  var moneda = ['UYU', 'USD'].indexOf(String(p.moneda || 'UYU').toUpperCase()) >= 0
    ? String(p.moneda).toUpperCase() : 'UYU';
  var notas = String(p.notas || '').trim();
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = getOrCreateIngresosTab(ss);
  var row = _ingresosNextRow(sheet);
  sheet.getRange(row, 1, 1, INGRESOS_HEADERS.length).setValues([[
    parseLocalDate(fecha) || new Date(), concepto, monto, moneda, notas
  ]]);
  sheet.getRange(row, 1).setNumberFormat('dd/MM/yyyy');
  SpreadsheetApp.flush();
  return { ok: true, row: row };
}

function deleteIngresoEntry(p) {
  var row = parseInt(p.row, 10);
  if (!isFinite(row) || row < INGRESOS_FIRST_ROW) throw new Error('Fila inválida');
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = getOrCreateIngresosTab(ss);
  sheet.deleteRow(row);
  SpreadsheetApp.flush();
  return { ok: true };
}

function _ingresosThisMonth() {
  var result = { uyu: 0, usd: 0 };
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(INGRESOS_TAB);
  if (!sheet) return result;
  var rows = _ingresosRows(sheet);
  var tabName = currentMonthTab();
  var parts = tabName.split(' ');
  var mesNombre = parts[0];
  var mesAnio = parseInt(parts[1], 10);
  var mesIdx = MONTH_NAMES.indexOf(MONTH_NAMES.find(function(m) { return _stripAccents(m) === _stripAccents(mesNombre); }));
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var fecha = parseLocalDate(r.fecha);
    if (!fecha || isNaN(fecha.getTime())) continue;
    if (fecha.getMonth() === mesIdx && fecha.getFullYear() === mesAnio) {
      if (r.moneda === 'USD') result.usd += r.monto;
      else result.uyu += r.monto;
    }
  }
  return result;
}

// Solo lo que SALE DEL BANCO — usado únicamente para el saldo disponible
// (getSavingsData). Efectivo se excluye a propósito: pagar en cash no mueve
// un peso de ninguna cuenta bancaria, así que no puede descontar el saldo.
function _monthExpenseTotals(tabName) {
  var result = { uyu: 0, usd: 0 };
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return result;
  var range = sheet.getDataRange().getValues();

  // Fixed table totals (cols B=UYU, C=USD)
  var fixed = _fixedTotals(range);
  result.uyu += fixed.uyu;
  result.usd += fixed.usd;

  // Variable table
  var headerRow = findHeaderRow(range);
  if (headerRow < 0) return result;
  var headers = range[headerRow].map(function(h) { return String(h || '').trim(); });

  // Cards with "USD" in header → USD; others → UYU (skip non-amount columns,
  // y Efectivo porque no descuenta banco — ver comentario de la función)
  var skipRe = /cotizaci|categor|fecha|notas|efectivo/i;
  var usdCols = [], uyuCols = [];
  for (var c = 1; c < headers.length; c++) {
    var h = headers[c];
    if (!h || skipRe.test(h)) continue;
    if (/usd/i.test(h)) usdCols.push(c);
    else uyuCols.push(c);
  }

  for (var i = headerRow + 1; i < range.length; i++) {
    var label = String(range[i][0] || '').trim().toLowerCase();
    if (!label) continue;
    if (isBoundaryRow(label)) break;
    for (var j = 0; j < uyuCols.length; j++) {
      var v = toNumber(range[i][uyuCols[j]]);
      if (v !== null && v > 0) result.uyu += v;
    }
    for (var j = 0; j < usdCols.length; j++) {
      var v = toNumber(range[i][usdCols[j]]);
      if (v !== null && v > 0) result.usd += v;
    }
  }
  return result;
}

function addIngresoSafe(data) {
  try { return addIngresoEntry(data || {}); }
  catch (err) { Logger.log('addIngresoSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function getIngresosSafe() {
  try { return getIngresosData(); }
  catch (err) { return { ok: false, error: err.message }; }
}
function deleteIngresoSafe(data) {
  try { return deleteIngresoEntry(data || {}); }
  catch (err) { Logger.log('deleteIngresoSafe: ' + err.message); return { ok: false, error: err.message }; }
}

function getArgentinaDataSafe(month) {
  try { return getArgentinaData(month); }
  catch (err) { return { ok: false, error: err.message }; }
}
function addArgentinaSafe(data) {
  try { return addArgentinaEntry(data || {}); }
  catch (err) { Logger.log('addArgentinaSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function updateArgentinaSafe(data) {
  try { return updateArgentinaEntry(data || {}); }
  catch (err) { Logger.log('updateArgentinaSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function deleteArgentinaSafe(data) {
  try { return deleteArgentinaEntry(data || {}); }
  catch (err) { Logger.log('deleteArgentinaSafe: ' + err.message); return { ok: false, error: err.message }; }
}

// ============================================================================
// === TAREAS: to-dos y citas, con aviso por mail a la mañana =================
// ============================================================================
//
// Una sola tabla con columna "Tipo" (Tarea | Cita). Igual que en Ahorros, el
// borrado limpia contenido en vez de deleteRow: el cliente guarda el número
// de fila como id y correr las filas de abajo lo rompería.

const TASKS_TAB = 'Tareas';
// Subcategoría va al final (columna 15) en vez de al lado de Categoría para
// no correr los índices de todas las columnas que ya existían.
const TASKS_HEADERS = ['Fecha creada', 'Tipo', 'Categoría', 'Texto', 'Fecha', 'Hora', 'Notas', 'Completada', 'Fecha completada',
                       'Recurrente', 'Objetivo', 'Contador', 'Periodo', 'Último reset', 'Subcategoría'];
const TASKS_TIPOS = ['Tarea', 'Cita'];
// Fijas (como CATEGORIES de gastos) en vez de texto libre: así la pizarra
// tiene columnas estables en vez de una nueva por cada typo.
const TASKS_CATEGORIAS = ['Salud', 'Trabajo', 'Personal', 'Hogar', 'Finanzas', 'Otros'];
// Cada cuánto se reinicia el contador de una tarea recurrente.
const TASKS_PERIODOS = ['Diario', 'Semanal', 'Mensual'];
const TASKS_FIRST_ROW = 2;
const TASKS_MAX_ROWS = 500;

// Subcategorías: a diferencia de Categoría (fija), acá el usuario define las
// suyas — ej. dentro de "Trabajo": "Proyecto A", "Reuniones". Se guardan
// aparte (Script Properties, un JSON { categoria: [nombres...] }) en vez de
// derivarlas de las tareas ya cargadas, para poder crear una subcategoría
// vacía (o renombrarla) antes/después de tener tareas en ella.
const TASKS_SUBCATS_PROP = 'TASKS_SUBCATS_V1';

function _tasksSubcatsGet() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(TASKS_SUBCATS_PROP);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) { return {}; }
}
function _tasksSubcatsSet(obj) {
  PropertiesService.getScriptProperties().setProperty(TASKS_SUBCATS_PROP, JSON.stringify(obj));
}
function _tasksCategoriaValida(raw) {
  return TASKS_CATEGORIAS.find(c => _stripAccents(c) === _stripAccents(String(raw || ''))) || null;
}

function getTaskSubcategories() {
  return _tasksSubcatsGet();
}

// La llama tanto "agregar subcategoría" a mano como el guardado normal de una
// tarea (ver _normTask/addTaskEntry): escribir una tarea con una subcategoría
// nueva la da de alta sola, sin tener que pasar antes por la gestión.
function _tasksSubcatRegistrar(categoria, subcategoria) {
  const cat = _tasksCategoriaValida(categoria);
  const nombre = String(subcategoria || '').trim();
  if (!cat || !nombre) return;
  const obj = _tasksSubcatsGet();
  const lista = obj[cat] || [];
  if (!lista.some(x => _stripAccents(x) === _stripAccents(nombre))) {
    lista.push(nombre);
    obj[cat] = lista;
    _tasksSubcatsSet(obj);
  }
}

function addTaskSubcategory(p) {
  const cat = _tasksCategoriaValida(p.categoria);
  if (!cat) throw new Error('Categoría inválida');
  const nombre = String(p.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre de la subcategoría');
  if (nombre.length > 40) throw new Error('Nombre demasiado largo (máx 40 caracteres)');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const obj = _tasksSubcatsGet();
    const lista = obj[cat] || [];
    if (lista.some(x => _stripAccents(x) === _stripAccents(nombre))) {
      throw new Error('Ya existe esa subcategoría');
    }
    lista.push(nombre);
    obj[cat] = lista;
    _tasksSubcatsSet(obj);
    return { ok: true, subcategorias: obj };
  } finally {
    lock.releaseLock();
  }
}

// Renombra una subcategoría y actualiza también las tareas que ya la tenían
// cargada — si no, la pizarra les quedaría una columna vieja huérfana.
function renameTaskSubcategory(p) {
  const cat = _tasksCategoriaValida(p.categoria);
  if (!cat) throw new Error('Categoría inválida');
  const antes = String(p.antes || '').trim();
  const despues = String(p.despues || '').trim();
  if (!antes || !despues) throw new Error('Faltan nombres');
  if (despues.length > 40) throw new Error('Nombre demasiado largo (máx 40 caracteres)');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const obj = _tasksSubcatsGet();
    const lista = obj[cat] || [];
    const idx = lista.findIndex(x => _stripAccents(x) === _stripAccents(antes));
    if (idx === -1) throw new Error('No existe esa subcategoría');
    if (lista.some((x, i) => i !== idx && _stripAccents(x) === _stripAccents(despues))) {
      throw new Error('Ya existe una subcategoría con ese nombre');
    }
    lista[idx] = despues;
    obj[cat] = lista;
    _tasksSubcatsSet(obj);

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateTasksTab(ss);
    const cupo = _tasksCupo(sheet);
    if (cupo) {
      const rng = sheet.getRange(TASKS_FIRST_ROW, 1, cupo, TASKS_HEADERS.length);
      const vals = rng.getValues();
      let tocado = false;
      for (let i = 0; i < vals.length; i++) {
        if (!String(vals[i][3] || '').trim()) continue;
        if (_stripAccents(String(vals[i][2] || '')) === _stripAccents(cat) &&
            _stripAccents(String(vals[i][14] || '')) === _stripAccents(antes)) {
          vals[i][14] = despues;
          tocado = true;
        }
      }
      if (tocado) rng.setValues(vals);
    }
    return { ok: true, subcategorias: obj };
  } finally {
    lock.releaseLock();
  }
}

// Borra una subcategoría de la lista. Las tareas que ya la tenían NO se
// tocan — les queda el texto suelto, se pierde de la lista de sugerencias
// pero no desaparece de la tarea.
function deleteTaskSubcategory(p) {
  const cat = _tasksCategoriaValida(p.categoria);
  if (!cat) throw new Error('Categoría inválida');
  const nombre = String(p.nombre || '').trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const obj = _tasksSubcatsGet();
    const lista = obj[cat] || [];
    obj[cat] = lista.filter(x => _stripAccents(x) !== _stripAccents(nombre));
    _tasksSubcatsSet(obj);
    return { ok: true, subcategorias: obj };
  } finally {
    lock.releaseLock();
  }
}

function addTaskSubcategorySafe(data) {
  try { return addTaskSubcategory(data || {}); }
  catch (err) { return { ok: false, error: err.message }; }
}
function renameTaskSubcategorySafe(data) {
  try { return renameTaskSubcategory(data || {}); }
  catch (err) { return { ok: false, error: err.message }; }
}
function deleteTaskSubcategorySafe(data) {
  try { return deleteTaskSubcategory(data || {}); }
  catch (err) { return { ok: false, error: err.message }; }
}

function getOrCreateTasksTab(ss) {
  let sheet = ss.getSheetByName(TASKS_TAB);
  if (sheet) { _tasksMigrarHeaders(sheet); return sheet; }
  sheet = ss.insertSheet(TASKS_TAB);
  sheet.getRange(1, 1, 1, TASKS_HEADERS.length).setValues([TASKS_HEADERS])
       .setFontWeight('bold').setBackground('#dbeafe');
  sheet.setColumnWidth(4, 260);
  sheet.setColumnWidth(7, 220);
  sheet.setFrozenRows(1);
  try { reorderSheets(false); } catch (e) { Logger.log('reorder: ' + e.message); }
  return sheet;
}

// Repara el encabezado si le falta una columna nueva (ej. "Subcategoría" se
// agregó despues de que muchos ya tenían la hoja creada con 14 columnas).
// Solo AGREGA lo que falta al final — nunca toca ni corre las que ya había.
function _tasksMigrarHeaders(sheet) {
  const anchoActual = Math.max(sheet.getLastColumn(), TASKS_HEADERS.length);
  const hdr = sheet.getRange(1, 1, 1, anchoActual).getValues()[0];
  if (_stripAccents(String(hdr[TASKS_HEADERS.length - 1] || '')) ===
      _stripAccents(TASKS_HEADERS[TASKS_HEADERS.length - 1])) return;
  sheet.getRange(1, 1, 1, TASKS_HEADERS.length).setValues([TASKS_HEADERS])
       .setFontWeight('bold').setBackground('#dbeafe');
}

function _tasksCupo(sheet) {
  return Math.max(0, Math.min(TASKS_MAX_ROWS, sheet.getMaxRows() - TASKS_FIRST_ROW + 1));
}

// Primera fila libre (mira la columna Texto: Fecha es opcional en una tarea,
// Texto no lo es nunca).
function _tasksNextRow(sheet) {
  const cupo = _tasksCupo(sheet);
  if (!cupo) throw new Error('La hoja de tareas no tiene filas libres');
  const vals = sheet.getRange(TASKS_FIRST_ROW, 4, cupo, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (!String(vals[i][0] || '').trim()) return TASKS_FIRST_ROW + i;
  }
  throw new Error('La hoja de tareas llegó al máximo de ' + TASKS_MAX_ROWS + ' filas');
}

// Lunes de la semana de d (a medianoche, hora del script) — ancla estable
// para comparar "misma semana" sin depender de números de semana ISO.
function _tasksMondayOf(d) {
  const day = d.getDay(); // 0=domingo..6=sabado, en la zona del proyecto (America/Montevideo)
  const diff = day === 0 ? 6 : day - 1;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
}

// Clave comparable del "período" de una fecha: dos fechas con la misma clave
// están dentro del mismo día/semana/mes — se usa para saber si ya toca
// reiniciar el contador de una tarea recurrente.
function _tasksPeriodKey(d, periodo) {
  if (periodo === 'Diario') return Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM-dd');
  if (periodo === 'Mensual') return Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM');
  return Utilities.formatDate(_tasksMondayOf(d), 'America/Montevideo', 'yyyy-MM-dd'); // Semanal
}

function _tasksRows(sheet) {
  const cupo = _tasksCupo(sheet);
  if (!cupo) return [];
  const vals = sheet.getRange(TASKS_FIRST_ROW, 1, cupo, TASKS_HEADERS.length).getValues();
  const out = [];
  const ahora = new Date();
  const resets = []; // filas a las que hay que pisarles Contador/Último reset
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (!String(r[3] || '').trim()) continue;
    const dCreada = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0] : parseLocalDate(r[0]);
    const dFecha = r[4] ? (Object.prototype.toString.call(r[4]) === '[object Date]' ? r[4] : parseLocalDate(r[4])) : null;
    const dCompletada = r[8] ? (Object.prototype.toString.call(r[8]) === '[object Date]' ? r[8] : parseLocalDate(r[8])) : null;

    const recurrente = r[9] === true;
    const periodo = TASKS_PERIODOS.find(x => _stripAccents(x) === _stripAccents(String(r[12] || ''))) || 'Semanal';
    let objetivo = toNumber(r[10]) || 0;
    let contador = toNumber(r[11]) || 0;
    let dUltimoReset = r[13] ? (Object.prototype.toString.call(r[13]) === '[object Date]' ? r[13] : parseLocalDate(r[13])) : null;

    // Self-healing igual que la columna Fecha en gastos: si pasó el período
    // desde el último reset, se pisa el contador en la propia lectura — no
    // hace falta un cron aparte para "vaciar" tareas recurrentes.
    if (recurrente) {
      const vencido = !dUltimoReset || _tasksPeriodKey(dUltimoReset, periodo) !== _tasksPeriodKey(ahora, periodo);
      if (vencido) {
        contador = 0;
        dUltimoReset = ahora;
        resets.push({ row: TASKS_FIRST_ROW + i, contador: contador, ultimoReset: ahora });
      }
    }

    out.push({
      row: TASKS_FIRST_ROW + i,
      creada: dCreada ? Utilities.formatDate(dCreada, 'America/Montevideo', 'yyyy-MM-dd') : '',
      tipo: TASKS_TIPOS.find(t => _stripAccents(t) === _stripAccents(String(r[1] || ''))) || 'Tarea',
      categoria: TASKS_CATEGORIAS.find(c => _stripAccents(c) === _stripAccents(String(r[2] || ''))) || 'Otros',
      texto: String(r[3] || '').trim(),
      fecha: dFecha ? Utilities.formatDate(dFecha, 'America/Montevideo', 'yyyy-MM-dd') : '',
      // "15:30" como texto puede quedar mal interpretado como hora-del-dia si
      // la celda no está forzada a texto (formato viejo, o edición a mano en
      // la hoja) — Sheets lo guarda como fecha-serial y Apps Script lo lee
      // como un Date de 1899. Se recupera igual formateándolo en vez de
      // mostrar el Date crudo.
      hora: Object.prototype.toString.call(r[5]) === '[object Date]'
        ? Utilities.formatDate(r[5], 'America/Montevideo', 'HH:mm') : String(r[5] || '').trim(),
      notas: String(r[6] || '').trim(),
      completada: r[7] === true,
      fechaCompletada: dCompletada ? Utilities.formatDate(dCompletada, 'America/Montevideo', 'yyyy-MM-dd') : '',
      recurrente: recurrente, objetivo: objetivo, contador: contador, periodo: periodo,
      ultimoReset: dUltimoReset ? Utilities.formatDate(dUltimoReset, 'America/Montevideo', 'yyyy-MM-dd') : '',
      subcategoria: String(r[14] || '').trim()
    });
  }
  resets.forEach(function(rs) {
    sheet.getRange(rs.row, 12).setValue(rs.contador);
    sheet.getRange(rs.row, 14).setValue(rs.ultimoReset).setNumberFormat('dd/MM/yyyy');
  });
  return out;
}

// Normaliza lo que manda el cliente. Una cita necesita fecha (es LA cita);
// una tarea puede no tenerla (un pendiente sin vencimiento puntual). Solo
// una Tarea puede ser recurrente — una Cita es un momento puntual, no algo
// que se repite y se cuenta.
function _normTask(p) {
  const tipoRaw = String(p.tipo || '').trim();
  const tipo = TASKS_TIPOS.find(t => _stripAccents(t) === _stripAccents(tipoRaw)) || 'Tarea';
  const catRaw = String(p.categoria || '').trim();
  const categoria = TASKS_CATEGORIAS.find(c => _stripAccents(c) === _stripAccents(catRaw)) || 'Otros';
  // Texto libre, definida por el usuario — no hay una lista fija como con
  // Categoría (ver TASKS_SUBCATS_PROP). Guardarla acá la registra sola en la
  // lista de sugerencias (ver addTaskEntry/updateTaskEntry).
  const subcategoria = String(p.subcategoria || '').trim().slice(0, 40);
  const texto = String(p.texto || '').trim();
  if (!texto) throw new Error('Falta el texto de la tarea');

  const fechaRaw = String(p.fecha || '').trim();
  if (tipo === 'Cita' && !fechaRaw) throw new Error('Una cita necesita fecha');
  if (fechaRaw && isNaN(parseLocalDate(fechaRaw).getTime())) throw new Error('Fecha inválida');

  const hora = String(p.hora || '').trim();
  if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new Error('Hora inválida (HH:mm)');

  const recurrente = tipo === 'Tarea' && (p.recurrente === true || String(p.recurrente) === 'true');
  let objetivo = 0, periodo = '', contador = null;
  if (recurrente) {
    objetivo = toNumber(p.objetivo);
    if (objetivo == null || objetivo <= 0) throw new Error('Poné cuántas veces (objetivo) para la tarea recurrente');
    const perRaw = String(p.periodo || '').trim();
    periodo = TASKS_PERIODOS.find(x => _stripAccents(x) === _stripAccents(perRaw)) || 'Semanal';
    // Editable a mano desde el modal ("Van hechas"). Si no lo mandan (alta
    // nueva) queda null y el llamador decide el contador real.
    if (p.contador !== undefined && p.contador !== '') contador = Math.max(0, toNumber(p.contador) || 0);
  }

  return {
    tipo: tipo, categoria: categoria, subcategoria: subcategoria, texto: texto, fecha: fechaRaw || '', hora: hora,
    notas: String(p.notas || '').trim(), recurrente: recurrente, objetivo: objetivo,
    periodo: periodo, contador: contador
  };
}

function _tasksEscribirFila(sheet, row, e, opts) {
  opts = opts || {};
  const creada = opts.creada || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  // Contador y último-reset se preservan al editar (ver updateTaskEntry) — si
  // se activa recurrencia por primera vez arrancan de cero, desde hoy.
  const contador = opts.contador != null ? opts.contador : 0;
  const ultimoReset = e.recurrente
    ? (opts.ultimoReset || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd'))
    : '';
  // Forzar texto en Hora ANTES de escribir: sin esto Sheets interpreta "15:30"
  // como hora-del-día y lo guarda como fecha-serial (se lee de vuelta como un
  // Date de 1899, no como el string que se mandó).
  sheet.getRange(row, 6).setNumberFormat('@');
  sheet.getRange(row, 1, 1, TASKS_HEADERS.length).setValues([[
    parseLocalDate(creada), e.tipo, e.categoria, e.texto,
    e.fecha ? parseLocalDate(e.fecha) : '', e.hora, e.notas,
    opts.completada || false, opts.fechaCompletada ? parseLocalDate(opts.fechaCompletada) : '',
    e.recurrente, e.recurrente ? e.objetivo : '', e.recurrente ? contador : '',
    e.recurrente ? e.periodo : '', ultimoReset ? parseLocalDate(ultimoReset) : '', e.subcategoria || ''
  ]]);
  sheet.getRange(row, 1).setNumberFormat('dd/MM/yyyy');
  sheet.getRange(row, 14).setNumberFormat('dd/MM/yyyy');
  sheet.getRange(row, 5).setNumberFormat('dd/MM/yyyy');
  sheet.getRange(row, 9).setNumberFormat('dd/MM/yyyy');
}

function getTasksData() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateTasksTab(ss);
    const filas = _tasksRows(sheet);
    const hoy = Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
    return { ok: true, tab: TASKS_TAB, tareas: filas, tipos: TASKS_TIPOS, categorias: TASKS_CATEGORIAS,
             periodos: TASKS_PERIODOS, hoy: hoy, subcategorias: getTaskSubcategories() };
  } catch (err) {
    Logger.log('getTasksData: ' + err.message);
    return { ok: false, error: err.message };
  }
}

// Agrega una tarea/cita. p: { tipo, categoria, texto, fecha, hora, notas }
function addTaskEntry(p) {
  const e = _normTask(p || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let row;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateTasksTab(ss);
    row = _tasksNextRow(sheet);
    _tasksEscribirFila(sheet, row, e);
    if (e.subcategoria) _tasksSubcatRegistrar(e.categoria, e.subcategoria);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: TASKS_TAB, row: row, written: e };
}

// Edita una tarea/cita ya cargada. p: { row, ...campos }. Conserva cuándo se
// creó y si estaba completada — eso se toca aparte, con toggleTaskEntry.
function updateTaskEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < TASKS_FIRST_ROW) throw new Error('Fila inválida');
  const e = _normTask(p || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateTasksTab(ss);
    const cur = sheet.getRange(row, 1, 1, TASKS_HEADERS.length).getValues()[0];
    if (!String(cur[3] || '').trim()) throw new Error('Esa fila está vacía — recargá las tareas e intentá de nuevo');
    // El contador y el último reset solo se conservan si YA era recurrente —
    // si se prende recurrencia recién ahora, arranca de cero (ver _tasksEscribirFila).
    // Si el modal mandó un contador explícito ("Van hechas"), ese manda.
    const yaEraRecurrente = cur[9] === true;
    const contadorPrevio = yaEraRecurrente ? (toNumber(cur[11]) || 0) : 0;
    _tasksEscribirFila(sheet, row, e, {
      creada: cur[0], completada: cur[7] === true, fechaCompletada: cur[8] || '',
      contador: e.contador != null ? e.contador : contadorPrevio,
      ultimoReset: yaEraRecurrente ? cur[13] : ''
    });
    if (e.subcategoria) _tasksSubcatRegistrar(e.categoria, e.subcategoria);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: TASKS_TAB, row: row, written: e };
}

// Marca/desmarca completada — lo que dispara el checkbox, sin pasar por el modal.
function toggleTaskEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < TASKS_FIRST_ROW) throw new Error('Fila inválida');
  const completada = p.completada === true || String(p.completada) === 'true';
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateTasksTab(ss);
    const cur = sheet.getRange(row, 1, 1, TASKS_HEADERS.length).getValues()[0];
    if (!String(cur[3] || '').trim()) throw new Error('Esa fila está vacía — recargá las tareas e intentá de nuevo');
    sheet.getRange(row, 8).setValue(completada);
    sheet.getRange(row, 9).setValue(completada ? new Date() : '');
    if (completada) sheet.getRange(row, 9).setNumberFormat('dd/MM/yyyy');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: TASKS_TAB, row: row, completada: completada };
}

function deleteTaskEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < TASKS_FIRST_ROW) throw new Error('Fila inválida');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let borrado;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateTasksTab(ss);
    const cur = sheet.getRange(row, 1, 1, TASKS_HEADERS.length).getValues()[0];
    if (!String(cur[3] || '').trim()) throw new Error('Esa fila ya está vacía');
    borrado = String(cur[3] || '');
    sheet.getRange(row, 1, 1, TASKS_HEADERS.length).clearContent();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: TASKS_TAB, deleted: borrado };
}

// Suma (o resta, con delta negativo) al contador de una tarea recurrente —
// el botón "+1" de la tarjeta, sin pasar por el modal de editar. No deja
// bajar de cero; no hay techo, así que pasar el objetivo también vale (ej.
// "hoy hice una de más") y solo cambia cómo se ve la tarjeta.
function bumpTaskEntry(p) {
  const row = parseInt(p.row, 10);
  if (!isFinite(row) || row < TASKS_FIRST_ROW) throw new Error('Fila inválida');
  const deltaRaw = toNumber(p.delta);
  const delta = deltaRaw == null ? 1 : deltaRaw;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let contador;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateTasksTab(ss);
    const cur = sheet.getRange(row, 1, 1, TASKS_HEADERS.length).getValues()[0];
    if (!String(cur[3] || '').trim()) throw new Error('Esa fila está vacía — recargá las tareas e intentá de nuevo');
    if (cur[9] !== true) throw new Error('Esa tarea no es recurrente');
    contador = Math.max(0, (toNumber(cur[11]) || 0) + delta);
    sheet.getRange(row, 12).setValue(contador);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: TASKS_TAB, row: row, contador: contador };
}

function addTaskSafe(data) {
  try { return addTaskEntry(data || {}); }
  catch (err) { Logger.log('addTaskSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function updateTaskSafe(data) {
  try { return updateTaskEntry(data || {}); }
  catch (err) { Logger.log('updateTaskSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function toggleTaskSafe(data) {
  try { return toggleTaskEntry(data || {}); }
  catch (err) { Logger.log('toggleTaskSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function deleteTaskSafe(data) {
  try { return deleteTaskEntry(data || {}); }
  catch (err) { Logger.log('deleteTaskSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function bumpTaskSafe(data) {
  try { return bumpTaskEntry(data || {}); }
  catch (err) { Logger.log('bumpTaskSafe: ' + err.message); return { ok: false, error: err.message }; }
}
function getTasksSafe() {
  try { return getTasksData(); }
  catch (err) { return { ok: false, error: err.message }; }
}

// Lo que hay que resolver HOY: citas de hoy (con hora, ordenadas), tareas con
// vencimiento hoy, y lo vencido que quedó sin completar. Mismo cálculo para
// el mail de la mañana y para la tarjeta "Hoy" adentro de la app.
function _tasksDigestHoy() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = getOrCreateTasksTab(ss);
  const filas = _tasksRows(sheet).filter(f => !f.completada);
  const hoy = Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');

  const citasHoy = filas.filter(f => f.tipo === 'Cita' && f.fecha === hoy)
                        .sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
  const tareasHoy = filas.filter(f => f.tipo === 'Tarea' && f.fecha === hoy);
  const vencidas = filas.filter(f => f.fecha && f.fecha < hoy);
  const sinFecha = filas.filter(f => f.tipo === 'Tarea' && !f.fecha);

  return { hoy: hoy, citasHoy: citasHoy, tareasHoy: tareasHoy, vencidas: vencidas, sinFecha: sinFecha, pendientes: filas.length };
}

// Endpoint liviano para un atajo de iOS (mismo patrón que habitPending): una
// automatización a la mañana puede pegarle acá y mostrar una notificación
// nativa, como alternativa o complemento al mail.
function tasksPending() {
  const d = _tasksDigestHoy();
  const total = d.citasHoy.length + d.tareasHoy.length + d.vencidas.length;
  const partes = [];
  d.citasHoy.forEach(c => partes.push('📅 ' + (c.hora ? c.hora + ' ' : '') + c.texto));
  d.tareasHoy.forEach(t => partes.push('☐ ' + t.texto));
  d.vencidas.forEach(v => partes.push('⚠️ ' + v.texto + (v.fecha ? ' (' + v.fecha + ')' : '')));
  return {
    ok: true, date: d.hoy, pendingNum: total > 0 ? 1 : 0,
    msg: partes.length ? partes.join(' · ') : 'Sin tareas para hoy',
    citasHoy: d.citasHoy, tareasHoy: d.tareasHoy, vencidas: d.vencidas
  };
}

function _tasksDigestHtml() {
  const d = _tasksDigestHoy();
  const li = (icon, texto, sub) => '<li style="margin-bottom:6px">' + icon + ' <b>' + texto + '</b>' +
    (sub ? ' <span style="color:#888">' + sub + '</span>' : '') + '</li>';
  let h = '<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#111827">';
  h += '<h2 style="margin:0 0 12px">🗓️ Tareas de hoy — ' + d.hoy + '</h2>';
  if (!d.citasHoy.length && !d.tareasHoy.length && !d.vencidas.length) {
    h += '<p style="color:#4b5563">No tenés nada pendiente para hoy. 🎉</p>';
  }
  if (d.citasHoy.length) {
    h += '<h3 style="font-size:14px;margin:16px 0 6px">📅 Citas de hoy</h3><ul style="padding-left:20px;margin:0">';
    d.citasHoy.forEach(c => { h += li('📅', (c.hora ? c.hora + ' — ' : '') + c.texto, c.notas); });
    h += '</ul>';
  }
  if (d.tareasHoy.length) {
    h += '<h3 style="font-size:14px;margin:16px 0 6px">☐ Para hoy</h3><ul style="padding-left:20px;margin:0">';
    d.tareasHoy.forEach(t => { h += li('☐', t.texto, t.notas); });
    h += '</ul>';
  }
  if (d.vencidas.length) {
    h += '<h3 style="font-size:14px;margin:16px 0 6px;color:#b91c1c">⚠️ Vencidas</h3><ul style="padding-left:20px;margin:0">';
    d.vencidas.forEach(v => { h += li('⚠️', v.texto, v.fecha); });
    h += '</ul>';
  }
  h += '</div>';
  return h;
}

function sendDailyTasksEmail(emailOpt) {
  const d = _tasksDigestHoy();
  const total = d.citasHoy.length + d.tareasHoy.length + d.vencidas.length;
  if (!total) return { ok: true, sent: false, msg: 'Nada pendiente, no se manda mail' };
  const email = emailOpt || Session.getEffectiveUser().getEmail();
  if (!email) throw new Error('No se pudo determinar email destinatario');
  MailApp.sendEmail({ to: email, subject: '🗓️ Tareas de hoy (' + total + ')', htmlBody: _tasksDigestHtml() });
  return { ok: true, sent: true, sentTo: email, total: total };
}

function installDailyTasksTrigger(hour) {
  const h = parseInt(hour, 10) || 7;
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'dailyTasksCron') { ScriptApp.deleteTrigger(t); removed++; }
  }
  ScriptApp.newTrigger('dailyTasksCron').timeBased().everyDays(1).atHour(h).create();
  return { ok: true, msg: 'Trigger instalado: todos los días a las ' + h + ':00', removedPrevious: removed };
}

function removeDailyTasksTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'dailyTasksCron') { ScriptApp.deleteTrigger(t); removed++; }
  }
  return { ok: true, removed: removed };
}

// Handler del trigger diario — sin argumentos, como pide ScriptApp.
function dailyTasksCron() {
  try { Logger.log('Daily tasks email: ' + JSON.stringify(sendDailyTasksEmail())); }
  catch (e) { Logger.log('dailyTasksCron: ' + e.message); }
}

// ---- Orden de las pestañas ------------------------------------------------

// Clave ordenable a partir del nombre. Devuelve null si no es un mes.
function _monthKey(name) {
  const m = String(name || '').trim().match(
    /^(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)\s+(\d{4})$/i);
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex(x => _stripAccents(x) === _stripAccents(m[1]));
  if (idx < 0) return null;
  return parseInt(m[2], 10) * 12 + idx;
}

// Clasifica cada hoja: gasto, habito, u otra.
function _sheetKind(name) {
  const n = String(name || '').trim();
  if (n.indexOf(HABIT_PREFIX) === 0) {
    const k = _monthKey(n.slice(HABIT_PREFIX.length));
    if (k !== null) return { kind: 'habito', key: k };
  }
  const k = _monthKey(n);
  if (k !== null) return { kind: 'gasto', key: k };
  return { kind: 'otro', key: 0 };
}

// Reordena las pestañas: primero los meses de hábitos (más reciente a la
// izquierda), después los de gastos con el mismo criterio, y al final lo que
// no sea ninguno de los dos (_rate_scratch).
//
// Hábitos va primero porque son pocas hojas y se usan a diario; dejarlas
// después de 50+ meses de gastos las volvería inalcanzables. Lo importante es
// que ninguno de los dos grupos corte al otro: antes las hojas de hábitos y
// el scratch quedaban encajados en el medio de la secuencia de meses, porque
// insertSheet las deja donde caiga.
function reorderSheets(dryRun) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();

  const gastos = [], habitos = [], tareas = [], ahorros = [], otros = [];
  for (const sh of sheets) {
    const info = _sheetKind(sh.getName());
    const item = { sheet: sh, name: sh.getName(), key: info.key };
    if (sh.getName() === TASKS_TAB) tareas.push(item);
    else if (sh.getName() === SAVINGS_TAB || sh.getName() === INGRESOS_TAB) ahorros.push(item);
    else if (info.kind === 'gasto') gastos.push(item);
    else if (info.kind === 'habito') habitos.push(item);
    else otros.push(item);
  }
  gastos.sort((a, b) => b.key - a.key);    // más reciente primero
  habitos.sort((a, b) => b.key - a.key);

  // Tareas va primero de todo: es lo que se mira apenas se abre la app a la
  // mañana. Ahorros justo después, por la misma razón de siempre.
  const orden = tareas.concat(ahorros).concat(habitos).concat(gastos).concat(otros);
  const antes = sheets.map(s => s.getName());
  const despues = orden.map(o => o.name);

  if (dryRun) return { ok: true, dryRun: true, antes: antes, despues: despues,
                       cambia: JSON.stringify(antes) !== JSON.stringify(despues) };

  // moveActiveSheet usa posiciones 1-indexed sobre el estado actual, así que
  // se recorre en orden y se va empujando cada hoja a su lugar definitivo.
  for (let i = 0; i < orden.length; i++) {
    ss.setActiveSheet(orden[i].sheet);
    ss.moveActiveSheet(i + 1);
  }
  const final = ss.getSheets().map(s => s.getName());
  return { ok: true, antes: antes, despues: final,
           gastos: gastos.length, habitos: habitos.length, otros: otros.length };
}

// Diagnóstico: qué hojas hay, en qué orden y si tienen datos.
function listSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return {
    ok: true,
    sheets: ss.getSheets().map((sh, i) => {
      const info = _sheetKind(sh.getName());
      return { pos: i + 1, name: sh.getName(), kind: info.kind,
               lastRow: sh.getLastRow(), lastCol: sh.getLastColumn() };
    })
  };
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

  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const hora = p.hora || Utilities.formatDate(new Date(), 'America/Montevideo', 'HH:mm');
  const tabName = p.month || habitTabFor(dateStr);
  const tipo = String(p.tipo || '').trim() || _waterLabel(ml);

  // Mismo lock que en addMealEntry, y por el mismo motivo: comidas y agua
  // comparten el log y compiten por la misma fila libre. El recalculo del
  // total tambien va adentro para que no lo pise otra alta en curso.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let insertAt, sheet, total;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    sheet = getOrCreateHabitTab(ss, tabName);
    insertAt = _nextLogRow(sheet);
    sheet.getRange(insertAt, 2).setNumberFormat('@');
    sheet.getRange(insertAt, 1, 1, HABIT_MEAL_HEADERS.length).setValues([[
      parseLocalDate(dateStr), hora, tipo, '', 'Agua', '', 'Agua', ml, '', ''
    ]]);
    sheet.getRange(insertAt, 1).setNumberFormat('dd/MM/yyyy');
    SpreadsheetApp.flush();
    total = _recalcWaterTotal(sheet, dateStr);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
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

  const cur = _assertLogRow(sheet, row, p.date, 'agua');

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

  const cur = _assertLogRow(sheet, row, p.date, 'agua');

  const d = Object.prototype.toString.call(cur[0]) === '[object Date]' ? cur[0] : parseLocalDate(cur[0]);
  const dateStr = p.date || Utilities.formatDate(d, 'America/Montevideo', 'yyyy-MM-dd');
  const ml = toNumber(cur[7]) || 0;
  const tipo = String(cur[2] || '');

  sheet.deleteRow(row);
  const total = _recalcWaterTotal(sheet, dateStr);
  return { ok: true, tab: tabName, deleted: tipo + ' (' + ml + ' ml)', total: total };
}

// Reemplaza la foto completa de las tomas de agua de una fecha. Se usa al
// confirmar el borrador del formulario: agregar, editar y borrar agua no toca
// la hoja hasta ese momento. Las filas de comida de la misma fecha se conservan.
function replaceWaterEntries(p) {
  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const target = parseLocalDate(dateStr);
  if (!target) throw new Error('Fecha inválida');
  const tabName = p.month || habitTabFor(dateStr);
  if (p.month && p.month !== habitTabFor(dateStr)) {
    throw new Error('La fecha ' + dateStr + ' no pertenece a "' + p.month + '"');
  }

  const raw = Array.isArray(p.waters) ? p.waters : [];
  if (raw.length > 100) throw new Error('Demasiadas tomas de agua para un solo día');
  const waters = raw.map((item, i) => {
    const src = item || {};
    const ml = toNumber(String(src.ml != null ? src.ml : '').replace(',', '.'));
    if (ml == null || ml <= 0) throw new Error('Cantidad de agua inválida en la toma ' + (i + 1));
    const parsedTime = _parseHM(src.hora);
    const hora = parsedTime == null
      ? Utilities.formatDate(new Date(), 'America/Montevideo', 'HH:mm')
      : _fmtHM(parsedTime);
    return { ml: ml, hora: hora, tipo: String(src.tipo || '').trim() || _waterLabel(ml) };
  });

  const targetKey = target.getFullYear() + '-' + target.getMonth() + '-' + target.getDate();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let sheet, total;
  const written = [];
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    sheet = getOrCreateHabitTab(ss, tabName);

    // Borrar de abajo hacia arriba evita que se corran las filas que todavía
    // faltan revisar. Registro (col G) distingue agua de comida.
    const lastRow = sheet.getLastRow();
    if (lastRow >= HABIT_MEAL_FIRST_ROW) {
      const vals = sheet.getRange(
        HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, 7
      ).getValues();
      for (let i = vals.length - 1; i >= 0; i--) {
        const row = vals[i];
        if (!row[0] || String(row[6] || '').trim().toLowerCase() !== 'agua') continue;
        const d = Object.prototype.toString.call(row[0]) === '[object Date]' ? row[0] : parseLocalDate(row[0]);
        if (!d) continue;
        const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        if (key === targetKey) sheet.deleteRow(HABIT_MEAL_FIRST_ROW + i);
      }
    }

    for (const water of waters) {
      const insertAt = _nextLogRow(sheet);
      if (insertAt > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
      sheet.getRange(insertAt, 2).setNumberFormat('@');
      sheet.getRange(insertAt, 1, 1, HABIT_MEAL_HEADERS.length).setValues([[
        parseLocalDate(dateStr), water.hora, water.tipo, '', 'Agua', '', 'Agua', water.ml, '', ''
      ]]);
      sheet.getRange(insertAt, 1).setNumberFormat('dd/MM/yyyy');
      written.push({ row: insertAt, hora: water.hora, tipo: water.tipo, ml: water.ml });
    }

    SpreadsheetApp.flush();
    total = _recalcWaterTotal(sheet, dateStr);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return { ok: true, tab: tabName, date: dateStr, total: total, waters: written };
}

// === EJERCICIO: log de varias sesiones por dia ===
// Antes el dia tenia un solo texto y un solo numero de minutos, asi que dos
// entrenamientos distintos no entraban: habia que escribirlos a mano en la
// misma linea y sumar los minutos de cabeza. Ahora cada sesion es una fila del
// log (Registro = "Ejercicio", minutos en la col 8) y la fila diaria guarda el
// resumen calculado, para que todo el analisis del mes siga leyendo lo mismo.

// Normaliza una entrada que viene del cliente. Un ejercicio sin minutos es
// valido (fuiste al gimnasio y no cronometraste); uno sin tipo no.
function _normExercise(src, idx) {
  const s = src || {};
  const donde = idx != null ? ' en la entrada ' + (idx + 1) : '';
  const tipo = String(s.tipo || s.ejercicio || s.detalle || '').trim();
  if (!tipo) throw new Error('Falta qué ejercicio hiciste' + donde);
  if (tipo.length > 120) throw new Error('El nombre del ejercicio es demasiado largo' + donde);

  let min = 0;
  const rawMin = s.min !== undefined ? s.min : s.minutos;
  if (rawMin !== undefined && rawMin !== '' && rawMin !== null) {
    const n = toNumber(String(rawMin).replace(',', '.'));
    if (n == null || n < 0) throw new Error('Minutos de ejercicio inválidos' + donde);
    if (n > 1440) throw new Error('Un ejercicio no puede durar más de 24 horas' + donde);
    min = Math.round(n);
  }

  const parsed = _parseHM(s.hora);
  const hora = parsed == null
    ? Utilities.formatDate(new Date(), 'America/Montevideo', 'HH:mm')
    : _fmtHM(parsed);
  return { tipo: tipo, min: min, hora: hora };
}

// Recalcula el resumen del dia a partir del log. "Ejercicio" queda con los
// tipos unidos por " + " (que es exactamente como los separa el analisis del
// mes) y "Min ejerc." con la suma de minutos.
function _recalcExerciseSummary(sheet, dateStr) {
  const target = parseLocalDate(dateStr);
  if (!target) return { texto: '', min: 0, count: 0 };
  const tKey = target.getFullYear() + '-' + target.getMonth() + '-' + target.getDate();

  const tipos = [];
  const vistos = {};
  let min = 0, count = 0;
  const lastRow = sheet.getLastRow();
  if (lastRow >= HABIT_MEAL_FIRST_ROW) {
    const vals = sheet.getRange(HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, HABIT_MEAL_HEADERS.length).getValues();
    for (const r of vals) {
      if (!r[0]) continue;
      if (String(r[6] || '').trim().toLowerCase() !== 'ejercicio') continue;
      const d = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0] : parseLocalDate(r[0]);
      if (!d) continue;
      if (d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() !== tKey) continue;
      count++;
      min += toNumber(r[7]) || 0;
      // Dos sesiones de gimnasio son "Gimnasio", no "Gimnasio + Gimnasio"
      const tipo = String(r[2] || '').trim();
      const key = _stripAccents(tipo);
      if (tipo && !vistos[key]) { vistos[key] = true; tipos.push(tipo); }
    }
  }

  const texto = tipos.join(' + ');
  const row = _habitFindDayRow(sheet, dateStr);
  if (row > 0) {
    const hmap = _habitHeaderMap(sheet);
    const cT = _habitColOf(hmap, 'ejercicio');
    const cM = _habitColOf(hmap, 'ejercicioMin');
    if (cT > 0) sheet.getRange(row, cT).setValue(texto);
    if (cM > 0) sheet.getRange(row, cM).setValue(min > 0 ? min : '');
  }
  return { texto: texto, min: min, count: count };
}

// Escribe una fila de ejercicio en el log. Asume que el lock ya esta tomado.
function _writeExerciseRow(sheet, dateStr, e) {
  const insertAt = _nextLogRow(sheet);
  if (insertAt > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  sheet.getRange(insertAt, 2).setNumberFormat('@');
  sheet.getRange(insertAt, 1, 1, HABIT_MEAL_HEADERS.length).setValues([[
    parseLocalDate(dateStr), e.hora, e.tipo, '', 'Ejercicio', '', 'Ejercicio', e.min || '', '', ''
  ]]);
  sheet.getRange(insertAt, 1).setNumberFormat('dd/MM/yyyy');
  return insertAt;
}

// Agrega una sesion sola, al instante. p: { date, tipo, min, hora, month }
function addExerciseEntry(p) {
  const e = _normExercise(p);
  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  if (p.month && p.month !== habitTabFor(dateStr)) {
    throw new Error('La fecha ' + dateStr + ' no pertenece a "' + p.month + '"');
  }
  const tabName = p.month || habitTabFor(dateStr);

  // Mismo lock que comidas y agua, y por el mismo motivo: los tres comparten el
  // log y compiten por la misma fila libre.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let insertAt, resumen;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateHabitTab(ss, tabName);
    insertAt = _writeExerciseRow(sheet, dateStr, e);
    SpreadsheetApp.flush();
    resumen = _recalcExerciseSummary(sheet, dateStr);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, tab: tabName, row: insertAt, date: dateStr, resumen: resumen,
           written: { tipo: e.tipo, min: e.min, hora: e.hora } };
}

// Reemplaza la foto completa de los ejercicios de una fecha. Igual que el agua:
// agregar, editar y borrar en el form no toca la hoja hasta que se confirma el
// dia. Las filas de comida y de agua de la misma fecha se conservan.
function replaceExerciseEntries(p) {
  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const target = parseLocalDate(dateStr);
  if (!target) throw new Error('Fecha inválida');
  if (p.month && p.month !== habitTabFor(dateStr)) {
    throw new Error('La fecha ' + dateStr + ' no pertenece a "' + p.month + '"');
  }
  const tabName = p.month || habitTabFor(dateStr);

  const raw = Array.isArray(p.ejercicios) ? p.ejercicios : [];
  if (raw.length > 30) throw new Error('Demasiados ejercicios para un solo día');
  const ejers = raw.map((item, i) => _normExercise(item, i));

  const targetKey = target.getFullYear() + '-' + target.getMonth() + '-' + target.getDate();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let resumen;
  const written = [];
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateHabitTab(ss, tabName);

    // Borrar de abajo hacia arriba evita que se corran las filas que todavía
    // faltan revisar. Registro (col G) distingue ejercicio de comida y agua.
    const lastRow = sheet.getLastRow();
    if (lastRow >= HABIT_MEAL_FIRST_ROW) {
      const vals = sheet.getRange(
        HABIT_MEAL_FIRST_ROW, 1, lastRow - HABIT_MEAL_FIRST_ROW + 1, 7
      ).getValues();
      for (let i = vals.length - 1; i >= 0; i--) {
        const row = vals[i];
        if (!row[0] || String(row[6] || '').trim().toLowerCase() !== 'ejercicio') continue;
        const d = Object.prototype.toString.call(row[0]) === '[object Date]' ? row[0] : parseLocalDate(row[0]);
        if (!d) continue;
        const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        if (key === targetKey) sheet.deleteRow(HABIT_MEAL_FIRST_ROW + i);
      }
    }

    for (const e of ejers) {
      const at = _writeExerciseRow(sheet, dateStr, e);
      written.push({ row: at, hora: e.hora, tipo: e.tipo, min: e.min });
    }

    SpreadsheetApp.flush();
    resumen = _recalcExerciseSummary(sheet, dateStr);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return { ok: true, tab: tabName, date: dateStr, resumen: resumen, ejercicios: written };
}

// Confirma en una sola accion logica los campos del dia y, si vinieron, las
// previsualizaciones completas de agua y de ejercicio. Devuelve el dia releido
// porque al borrar filas pueden cambiar los numeros de fila de las comidas.
function saveHabitDayData(data) {
  const p = data || {};
  const dateStr = p.date || Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  p.date = dateStr;
  const dayFields = [
    'levante', 'acoste', 'trabajo', 'avance', 'animo', 'ejercicio',
    'ejercicioMin', 'medite', 'mediteMin', 'lei', 'notas', 'mast', 'abordajes'
  ];
  const hasDayChanges = !!p.clear || dayFields.some(field => p[field] !== undefined);
  let dayResult = { ok: true, tab: p.month || habitTabFor(dateStr), date: dateStr, written: {} };
  if (hasDayChanges) dayResult = upsertHabitDay(p);

  let waterResult = null;
  if (Array.isArray(p.waters)) waterResult = replaceWaterEntries(p);

  // El ejercicio va DESPUES de la fila diaria a proposito: el resumen que
  // escribe (texto + minutos) es la fuente de verdad y tiene que pisar
  // cualquier 'ejercicio' suelto que haya venido en el mismo guardado.
  let exResult = null;
  if (Array.isArray(p.ejercicios)) exResult = replaceExerciseEntries(p);

  const fresh = getHabitDay(dateStr);
  if (!fresh || !fresh.ok) throw new Error((fresh && fresh.error) || 'No se pudo releer el día guardado');
  fresh.written = dayResult.written || {};
  if (waterResult) fresh.water = { total: waterResult.total, count: waterResult.waters.length };
  if (exResult) fresh.ejercicio = { min: exResult.resumen.min, count: exResult.ejercicios.length };
  return fresh;
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

  // Si falta cualquier encabezado (por ejemplo porque un reset viejo los
  // borró), se reescribe la fila entera. Es idempotente y se autorrepara.
  const faltaAlguno = HABIT_MEAL_HEADERS.some((h, i) => norm[i] !== _stripAccents(h));
  if (faltaAlguno) {
    sheet.getRange(HABIT_MEAL_HEADER_ROW, 1, 1, HABIT_MEAL_HEADERS.length)
         .setValues([HABIT_MEAL_HEADERS]).setFontWeight('bold').setBackground('#fef3c7');
    changed = true;
  }

  if (norm[2] === 'comida') { sheet.getRange(HABIT_MEAL_HEADER_ROW, 3).setValue('Detalle'); changed = true; }
  if (norm[6] !== 'registro') {
    sheet.getRange(HABIT_MEAL_HEADER_ROW, 7).setValue('Registro').setFontWeight('bold').setBackground('#fef3c7');
    changed = true;
  }
  // Antes se llamaba solo 'ml'; ahora la misma columna guarda los minutos de
  // ejercicio, así que se renombra sola al abrir una hoja vieja.
  if (norm[7] !== 'ml / min') {
    sheet.getRange(HABIT_MEAL_HEADER_ROW, 8).setValue('ml / min').setFontWeight('bold').setBackground('#fef3c7');
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


// Verifica que una fila del log sea del dia que dice el cliente y del tipo
// esperado. Sin esto un indice desactualizado (por ejemplo tras un borrado
// que corrio las filas) edita o borra el registro del vecino en silencio.
function _assertLogRow(sheet, row, dateStr, registroEsperado) {
  const cur = sheet.getRange(row, 1, 1, HABIT_MEAL_HEADERS.length).getValues()[0];
  if (!cur[0]) throw new Error('Esa fila está vacía — recargá el día e intentá de nuevo');

  const reg = String(cur[6] || '').trim().toLowerCase() || 'comida';
  if (reg !== registroEsperado) {
    throw new Error('Esa fila es un registro de "' + reg + '" y esperaba "' + registroEsperado +
                    '" — recargá el día e intentá de nuevo');
  }
  if (dateStr) {
    const target = parseLocalDate(dateStr);
    const d = Object.prototype.toString.call(cur[0]) === '[object Date]' ? cur[0] : parseLocalDate(cur[0]);
    if (target && d && !isNaN(target.getTime()) && !isNaN(d.getTime())) {
      const k = x => x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate();
      if (k(target) !== k(d)) {
        throw new Error('Esa fila es de otro día — recargá el día e intentá de nuevo');
      }
    }
  }
  return cur;
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

  const cur = _assertLogRow(sheet, row, p.date, 'comida');
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

  const cur = _assertLogRow(sheet, row, p.date, 'comida');
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
  try { return saveHabitDayData(data || {}); }
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
