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
    getOrCreateMonthTab(ss, p.month);
    return { ok: true, action: 'createMonth', tab: p.month, alreadyExisted: existed };
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
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Agregar Gasto</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #fafafa; color: #1a1a1a; margin: 0; padding: 16px; max-width: 420px; margin-left: auto; margin-right: auto; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  label { display: block; font-size: 12px; color: #666; margin: 14px 0 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  input, select { width: 100%; padding: 12px 14px; border: 1px solid #e5e5e5; border-radius: 8px; font-size: 16px; background: white; -webkit-appearance: none; appearance: none; }
  input:focus, select:focus { outline: none; border-color: #0f766e; }
  button { width: 100%; background: #0f766e; color: white; border: none; padding: 14px; border-radius: 8px; font-size: 16px; font-weight: 600; margin-top: 20px; cursor: pointer; }
  button:active { background: #0d5c52; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .quick-section { margin-bottom: 10px; }
  .quick-label { font-size: 11px; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; padding-left: 2px; }
  .quick-scroll { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
  .quick-scroll::-webkit-scrollbar { height: 4px; }
  .quick-scroll::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
  .quick-scroll button { flex: 0 0 auto; width: auto; background: #f5f5f5; color: #1a1a1a; padding: 7px 10px; font-size: 12px; margin: 0; font-weight: 500; white-space: nowrap; border-radius: 7px; border: none; min-width: 56px; }
  .quick-scroll button:active { background: #e5e5e5; }
  .quick-scroll.fijos button { background: #fef3c7; color: #92400e; }
  .quick-scroll.fijos button:active { background: #fde68a; }
  #status { margin-top: 14px; padding: 14px; border-radius: 8px; font-size: 14px; display: none; }
  #status.ok { display: block; background: #ecfdf5; border: 1px solid #10b981; color: #15803d; }
  #status.err { display: block; background: #fef2f2; border: 1px solid #dc2626; color: #dc2626; }
  #status.loading { display: block; background: #f0f9ff; border: 1px solid #0ea5e9; color: #0369a1; }
  /* Tabs */
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid #e5e5e5; margin: 0 0 16px; position: sticky; top: 0; background: #fafafa; z-index: 10; padding-top: 4px; }
  .tab { flex: 1; padding: 10px 12px; text-align: center; cursor: pointer; border: none; background: transparent; color: #666; font-size: 14px; font-weight: 600; border-bottom: 2px solid transparent; margin: 0; width: auto; border-radius: 0; }
  .tab.active { color: #0f766e; border-bottom-color: #0f766e; }
  .panel { display: none; }
  .panel.active { display: block; }
  /* Dashboard */
  .dash-loader { color: #666; padding: 24px; text-align: center; font-size: 14px; }
  .dash-section { margin-bottom: 18px; }
  .dash-section h2 { font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; font-weight: 700; }
  .dash-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .dash-kpi { background: white; border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px 12px; }
  .dash-kpi.big { grid-column: span 2; background: #ecfdf5; border-color: #a7f3d0; }
  .dash-kpi-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .dash-kpi-val { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .dash-kpi.big .dash-kpi-val { font-size: 26px; color: #0f766e; }
  .dash-kpi-sub { font-size: 11px; color: #888; margin-top: 2px; }
  .dash-list { background: white; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; }
  .dash-list-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
  .dash-list-row:last-child { border-bottom: none; }
  .dash-list-row .name { color: #1a1a1a; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; }
  .dash-list-row .val { font-weight: 600; color: #0f766e; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dash-list-row .sub { font-size: 11px; color: #888; }
  .dash-bar { height: 4px; background: #f0f0f0; border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .dash-bar > div { height: 100%; background: #0f766e; }
  .dash-refresh { width: auto; padding: 8px 14px; font-size: 13px; margin: 0 0 16px; background: #f5f5f5; color: #1a1a1a; }
  .dash-refresh:active { background: #e5e5e5; }
  /* Ticket scan */
  .scan-section { margin: 10px 0 16px; }
  .scan-btn { background: #6366f1; color: white; padding: 12px; font-size: 14px; margin: 0; width: 100%; border-radius: 8px; border: none; font-weight: 600; }
  .scan-btn:active { background: #4f46e5; }
  .scan-btn.cancel { background: #f5f5f5; color: #1a1a1a; }
  .scan-btn.save { background: #10b981; }
  .scan-btn.save:active { background: #059669; }
  #scanPreview { background: white; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; margin: 12px 0; }
  #scanPreview h3 { margin: 0 0 10px; font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .scan-row { display: grid; grid-template-columns: 1fr 70px 90px 26px; gap: 4px; margin-bottom: 6px; align-items: center; }
  .scan-row input, .scan-row select { padding: 6px 6px; font-size: 12px; border-radius: 5px; }
  .scan-row .del-btn { padding: 4px 0; background: #fecaca; color: #991b1b; margin: 0; font-size: 14px; line-height: 1; width: 100%; font-weight: 700; border-radius: 5px; border: none; }
  .scan-total { display: flex; justify-content: space-between; padding: 10px 4px 12px; font-size: 13px; border-top: 1px solid #f0f0f0; margin-top: 8px; }
  .scan-total .v { font-weight: 700; color: #0f766e; font-variant-numeric: tabular-nums; }
  .scan-actions { display: flex; gap: 8px; margin-top: 8px; }
  .scan-actions button { margin: 0; }
  .scan-actions .cancel { flex: 1; }
  .scan-actions .save { flex: 2; }
</style></head><body>
<div class="tabs">
  <button type="button" class="tab active" data-panel="addPanel">+ Agregar</button>
  <button type="button" class="tab" data-panel="dashPanel">📊 Dashboard</button>
</div>

<div id="addPanel" class="panel active">
<h1>Agregar Gasto</h1>
<div class="quick-section">
  <div class="quick-label">Variables — scroll →</div>
  <div class="quick-scroll" id="quickVar">
    <button type="button" data-key="bus52">🚌52</button>
    <button type="button" data-key="cafe">☕</button>
    <button type="button" data-key="frog">🍺Frog</button>
    <button type="button" data-key="disco">🛒Disco</button>
    <button type="button" data-key="devoto">🛒Devoto</button>
    <button type="button" data-key="tata">🛒Tata</button>
    <button type="button" data-key="claude">🤖Claude</button>
    <button type="button" data-key="uber">🚕Uber</button>
    <button type="button" data-key="cabify">🚕Cabify</button>
    <button type="button" data-key="taxi">🚖Taxi</button>
    <button type="button" data-key="agua140">💧140</button>
    <button type="button" data-key="futbol350">⚽350</button>
    <button type="button" data-key="farma">💊Farma</button>
    <button type="button" data-key="medic">💉Medic</button>
    <button type="button" data-key="cine">🎬Cine</button>
    <button type="button" data-key="regalo">🎁Regalo</button>
    <button type="button" data-key="ropa">👕Ropa</button>
    <button type="button" data-key="pelu">💇Pelu</button>
    <button type="button" data-key="powerade">🥤Pwr</button>
    <button type="button" data-key="empanadas">🥟Empa</button>
    <button type="button" data-key="pizza">🍕Pizza</button>
    <button type="button" data-key="fernet">🍸Fernet</button>
    <button type="button" data-key="nafta">⛽Nafta</button>
    <button type="button" data-key="otros">📦Otros</button>
  </div>
</div>
<div class="quick-section">
  <div class="quick-label">Fijos — scroll →</div>
  <div class="quick-scroll fijos" id="quickFijo">
    <button type="button" data-key="fijo_alquiler">🏠Alq</button>
    <button type="button" data-key="fijo_gc">🏢GC</button>
    <button type="button" data-key="fijo_trib">🧾Trib</button>
    <button type="button" data-key="fijo_antel_int">📶Net</button>
    <button type="button" data-key="fijo_antel_mov">📱Móvil</button>
    <button type="button" data-key="fijo_luz">💡Luz</button>
    <button type="button" data-key="fijo_itau">🏦Itau pq</button>
    <button type="button" data-key="fijo_sandra">🧠Sandra</button>
    <button type="button" data-key="fijo_viandas">🍱Vianda</button>
    <button type="button" data-key="fijo_ble">📞Ble</button>
    <button type="button" data-key="fijo_bluecross">⚕️Blue</button>
    <button type="button" data-key="fijo_gimnasio">🏋️Gym</button>
    <button type="button" data-key="fijo_itau_cred">💳Itaú cr</button>
    <button type="button" data-key="fijo_oca">💳Oca</button>
  </div>
</div>
<div class="scan-section">
  <input type="file" id="ticketFile" accept="image/*" style="display:none">
  <button type="button" id="scanBtn" class="scan-btn">📷 Escanear ticket</button>
</div>
<div id="scanPreview" style="display:none">
  <h3>Items detectados — revisá antes de guardar</h3>
  <div id="scanItems"></div>
  <div class="scan-total"><span>Total</span><span class="v" id="scanTotal">—</span></div>
  <div class="scan-actions">
    <button type="button" id="cancelScan" class="scan-btn cancel">Cancelar</button>
    <button type="button" id="saveAll" class="scan-btn save">Guardar todos</button>
  </div>
</div>
<form id="f">
  <label>Ítem</label>
  <input name="item" required>
  <div class="row">
    <div><label>Monto</label><input name="amount" type="number" step="0.01" required inputmode="decimal"></div>
    <div><label>Moneda</label><select name="currency" required>
      <option value="UYU">UYU</option><option value="USD">USD</option><option value="ARS">ARS</option>
    </select></div>
  </div>
  <label>Medio de pago</label>
  <select name="card" required>
    <option selected>Débito UYU</option>
    <option>Crédito OCA</option>
    <option>Crédito Itaú UYU</option>
    <option>Crédito Itaú USD</option>
    <option>Débito USD</option>
  </select>
  <label>Categoría</label>
  <select name="category" required>
    <option>Transporte</option><option>Comida</option><option>Bebida/Bar</option>
    <option>Salud</option><option>Suscripciones</option><option>Entretenimiento</option>
    <option>Hogar</option><option>Limpieza</option><option>Ropa</option>
    <option>Regalos</option><option>Gimnasio</option><option>Servicios</option><option>Otros</option>
  </select>
  <div class="row">
    <div><label>Fecha</label><input name="date" type="date" value="${today}"></div>
    <div><label>Cotización USD</label><input name="cotizacion" type="number" step="0.01" placeholder="auto (BCU)"></div>
  </div>
  <label>Notas (opcional)</label>
  <input name="notes" placeholder="">
  <button type="submit" id="submitBtn">Guardar gasto</button>
  <div id="status"></div>
</form>
</div><!-- /addPanel -->

<div id="dashPanel" class="panel">
  <h1 id="dashTitle">Dashboard</h1>
  <button type="button" id="refreshDash" class="dash-refresh">↻ Recargar</button>
  <div id="dashContent" class="dash-loader">Cargando datos...</div>
</div>
<script>
  function setStatus(text, cls) {
    var el = document.getElementById('status');
    el.className = cls || '';
    el.textContent = text;
  }

  function setLocked(locked) {
    // Disable all form inputs + quick buttons during save
    var f = document.getElementById('f');
    for (var i = 0; i < f.elements.length; i++) f.elements[i].disabled = locked;
    var qbtns = document.querySelectorAll('.quick-scroll button');
    for (var j = 0; j < qbtns.length; j++) qbtns[j].disabled = locked;
    document.body.style.opacity = locked ? '0.6' : '1';
    document.body.style.pointerEvents = locked ? 'none' : 'auto';
    // Keep status visible
    document.getElementById('status').style.pointerEvents = 'auto';
  }

  function getField(name) {
    return document.querySelector('#f [name="' + name + '"]');
  }

  function fillQuick(data) {
    var itemField = getField('item');
    if (itemField) itemField.value = data.item || '';
    var amountField = getField('amount');
    if (data.amount !== undefined && data.amount !== null) amountField.value = data.amount;
    var curField = getField('currency'); if (data.currency && curField) curField.value = data.currency;
    var cardField = getField('card'); if (data.card && cardField) cardField.value = data.card;
    var catField = getField('category'); if (data.category && catField) catField.value = data.category;
    if (data.amount === undefined || data.amount === null) amountField.focus();
  }

  // Hardcoded quick presets — avoids HTML attribute sanitization issues
  var QUICKS = {
    // Variables
    bus52:     { item: 'Bus', amount: 52, currency: 'UYU', card: 'Crédito OCA', category: 'Transporte' },
    cafe:      { item: 'Café', currency: 'UYU', card: 'Débito UYU', category: 'Bebida/Bar' },
    frog:      { item: 'Frog', currency: 'UYU', card: 'Débito UYU', category: 'Bebida/Bar' },
    disco:     { item: 'Disco', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Comida' },
    devoto:    { item: 'Devoto', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Comida' },
    tata:      { item: 'Tata', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Comida' },
    claude:    { item: 'Claude', currency: 'USD', card: 'Crédito Itaú USD', category: 'Suscripciones' },
    uber:      { item: 'Uber', currency: 'UYU', card: 'Débito UYU', category: 'Transporte' },
    cabify:    { item: 'Cabify', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Transporte' },
    taxi:      { item: 'Taxi', currency: 'UYU', card: 'Débito UYU', category: 'Transporte' },
    agua140:   { item: 'Agua', amount: 140, currency: 'UYU', card: 'Débito UYU', category: 'Bebida/Bar' },
    futbol350: { item: 'Fútbol', amount: 350, currency: 'UYU', card: 'Débito UYU', category: 'Gimnasio' },
    farma:     { item: 'Farmacia', currency: 'UYU', card: 'Débito UYU', category: 'Salud' },
    medic:     { item: 'Medicamento', currency: 'UYU', card: 'Débito UYU', category: 'Salud' },
    cine:      { item: 'Cine', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Entretenimiento' },
    regalo:    { item: 'Regalo', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Regalos' },
    ropa:      { item: 'Ropa', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Ropa' },
    pelu:      { item: 'Peluquería', currency: 'UYU', card: 'Débito UYU', category: 'Ropa' },
    powerade:  { item: 'Powerade', currency: 'UYU', card: 'Débito UYU', category: 'Bebida/Bar' },
    empanadas: { item: 'Empanadas', currency: 'UYU', card: 'Débito UYU', category: 'Comida' },
    pizza:     { item: 'Pizza', currency: 'UYU', card: 'Crédito Itaú UYU', category: 'Comida' },
    fernet:    { item: 'Fernet', currency: 'UYU', card: 'Débito UYU', category: 'Bebida/Bar' },
    nafta:     { item: 'Nafta', currency: 'UYU', card: 'Crédito OCA', category: 'Transporte' },
    otros:     { item: '', currency: 'UYU', card: 'Débito UYU', category: 'Otros' },
    // Fijos — kind:'fijo' routes to fixed-table row on server (Mayo 2026 layout)
    fijo_alquiler:   { kind: 'fijo', item: 'Alquiler',         currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_gc:         { kind: 'fijo', item: 'Gastos comunes',   currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_trib:       { kind: 'fijo', item: 'Tributos domiciliarios', currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_antel_int:  { kind: 'fijo', item: 'Antel Internet',   currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_antel_mov:  { kind: 'fijo', item: 'Antel móvil',      currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_luz:        { kind: 'fijo', item: 'Luz',              currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_itau:       { kind: 'fijo', item: 'Itau paquete',     currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_sandra:     { kind: 'fijo', item: 'Sandra Psicologa', currency: 'UYU', card: 'Débito UYU', category: 'Salud' },
    fijo_viandas:    { kind: 'fijo', item: 'Viandas',          currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_ble:        { kind: 'fijo', item: 'Ble',              currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_bluecross:  { kind: 'fijo', item: 'BlueCross',        currency: 'UYU', card: 'Débito UYU', category: 'Salud' },
    fijo_gimnasio:   { kind: 'fijo', item: 'Gimnasio',         currency: 'UYU', card: 'Débito UYU', category: 'Gimnasio' },
    fijo_itau_cred:  { kind: 'fijo', item: 'Itaú Crédito',     currency: 'UYU', card: 'Débito UYU', category: 'Servicios' },
    fijo_oca:        { kind: 'fijo', item: 'Oca',              currency: 'UYU', card: 'Débito UYU', category: 'Servicios' }
  };
  var btns = document.querySelectorAll('.quick-scroll button');
  for (var i = 0; i < btns.length; i++) {
    (function(btn){
      btn.addEventListener('click', function(){
        var key = btn.getAttribute('data-key');
        if (QUICKS[key]) fillQuick(QUICKS[key]);
        else setStatus('Quick key no encontrado: ' + key, 'err');
      });
    })(btns[i]);
  }

  // === Auto-correct card based on item text (only on manual typing) ===
  // Rules: item starts with "bus" → Crédito OCA. Default → Débito UYU.
  var AUTO_CARD_RULES = [
    { re: /^\s*bus\b/i, card: 'Crédito OCA' }
    // Add more if needed: { re: /^\s*claude/i, card: 'Crédito Itaú USD' }
  ];
  function autoCorrectCard() {
    var itemField = getField('item');
    var cardField = getField('card');
    if (!itemField || !cardField) return;
    var v = itemField.value.trim();
    var matched = 'Débito UYU'; // default
    for (var i = 0; i < AUTO_CARD_RULES.length; i++) {
      if (AUTO_CARD_RULES[i].re.test(v)) { matched = AUTO_CARD_RULES[i].card; break; }
    }
    cardField.value = matched;
  }
  (function(){
    var itemField = getField('item');
    if (itemField) itemField.addEventListener('input', autoCorrectCard);
  })();

  function onSuccess(result) {
    setLocked(false);
    if (result && result.ok) {
      var cot = result.written && result.written.cotizacion;
      var src = result.cotizSource || '?';
      var prefix = result.fixed ? '✓ FIJO actualizado · ' : '✓ Guardado · ';
      var prevNote = '';
      if (result.fixed && result.written && result.written.prevAmount > 0) {
        prevNote = ' (sobreescribió ' + result.written.prevAmount + ')';
      }
      setStatus(prefix + result.tab + ' · row ' + result.row + ' · cot=' + cot + ' (' + src + ')' + prevNote, 'ok');
      var f = document.getElementById('f');
      f.reset();
      // Local date, not UTC (avoids next-day glitch in evening)
      var n = new Date();
      var iso = n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0');
      var dateField = getField('date');
      if (dateField) dateField.value = iso;
    } else {
      setStatus('✗ Error: ' + (result && result.error ? result.error : 'desconocido'), 'err');
    }
  }

  function onError(err) {
    setLocked(false);
    setStatus('✗ Server: ' + (err && err.message ? err.message : err), 'err');
  }

  document.getElementById('f').addEventListener('submit', function(ev){
    ev.preventDefault();
    var f = document.getElementById('f');
    var data = {};
    for (var i = 0; i < f.elements.length; i++) {
      var el = f.elements[i];
      if (el.name && el.value) data[el.name] = el.value;
    }
    setLocked(true);
    setStatus('Guardando...', 'loading');
    google.script.run
      .withSuccessHandler(onSuccess)
      .withFailureHandler(onError)
      .addExpenseSafe(data);
  });

  // === Ticket OCR scan ===
  var scannedItems = [];
  var CATS = ['Transporte','Comida','Bebida/Bar','Salud','Suscripciones','Entretenimiento','Hogar','Limpieza','Ropa','Regalos','Gimnasio','Servicios','Otros'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function resizeImage(dataUrl, maxSize, cb) {
    var img = new Image();
    img.onload = function(){
      var w = img.width, h = img.height;
      var ratio = Math.min(maxSize/w, maxSize/h, 1);
      var nw = Math.round(w * ratio), nh = Math.round(h * ratio);
      var canvas = document.createElement('canvas');
      canvas.width = nw; canvas.height = nh;
      canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
      cb(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = dataUrl;
  }

  document.getElementById('scanBtn').addEventListener('click', function(){
    document.getElementById('ticketFile').click();
  });
  document.getElementById('ticketFile').addEventListener('change', function(ev){
    var file = ev.target.files[0];
    if (!file) return;
    setStatus('Procesando imagen...', 'loading');
    var reader = new FileReader();
    reader.onload = function(e){
      resizeImage(e.target.result, 1280, function(resizedDataUrl){
        var b64 = resizedDataUrl.split(',')[1];
        setStatus('Escaneando ticket con AI (puede tardar)...', 'loading');
        google.script.run
          .withSuccessHandler(onScanResult)
          .withFailureHandler(function(err){
            setStatus('✗ Scan: ' + (err && err.message ? err.message : err), 'err');
          })
          .scanTicket(b64);
      });
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be re-selected
    ev.target.value = '';
  });

  function onScanResult(result) {
    if (!result || !result.ok) {
      setStatus('✗ ' + (result && result.error || 'scan error'), 'err');
      return;
    }
    scannedItems = (result.items || []).map(function(it){
      return { name: it.name || '', amount: parseFloat(it.amount) || 0, category: it.category || 'Otros' };
    });
    if (!scannedItems.length) {
      setStatus('No se detectaron items. Probá con foto más clara.', 'err');
      return;
    }
    renderScanPreview();
    setStatus('✓ ' + scannedItems.length + ' items detectados', 'ok');
  }

  function renderScanPreview() {
    var container = document.getElementById('scanItems');
    var html = '';
    for (var i = 0; i < scannedItems.length; i++) {
      var it = scannedItems[i];
      html += '<div class="scan-row">' +
        '<input type="text" data-idx="' + i + '" data-field="name" value="' + esc(it.name) + '">' +
        '<input type="number" step="0.01" inputmode="decimal" data-idx="' + i + '" data-field="amount" value="' + it.amount + '">' +
        '<select data-idx="' + i + '" data-field="category">' +
        CATS.map(function(c){ return '<option' + (c===it.category?' selected':'') + '>' + c + '</option>'; }).join('') +
        '</select>' +
        '<button type="button" class="del-btn" data-del="' + i + '">×</button>' +
      '</div>';
    }
    container.innerHTML = html;
    var totEl = document.getElementById('scanTotal');
    var tot = scannedItems.reduce(function(s,e){ return s + (parseFloat(e.amount)||0); }, 0);
    totEl.textContent = fmt(tot, 'UYU');
    document.getElementById('scanPreview').style.display = 'block';
    // Wire delete buttons
    var dels = container.querySelectorAll('[data-del]');
    for (var d = 0; d < dels.length; d++) {
      (function(btn){
        btn.addEventListener('click', function(){
          var idx = parseInt(btn.getAttribute('data-del'), 10);
          scannedItems.splice(idx, 1);
          if (!scannedItems.length) {
            document.getElementById('scanPreview').style.display = 'none';
          } else {
            renderScanPreview();
          }
        });
      })(dels[d]);
    }
    // Wire input updates
    var inputs = container.querySelectorAll('input,select');
    for (var ii = 0; ii < inputs.length; ii++) {
      (function(el){
        el.addEventListener('change', function(){
          var idx = parseInt(el.getAttribute('data-idx'), 10);
          var fld = el.getAttribute('data-field');
          if (!scannedItems[idx]) return;
          scannedItems[idx][fld] = fld === 'amount' ? (parseFloat(el.value) || 0) : el.value;
          if (fld === 'amount') {
            var tot = scannedItems.reduce(function(s,e){ return s + (parseFloat(e.amount)||0); }, 0);
            document.getElementById('scanTotal').textContent = fmt(tot, 'UYU');
          }
        });
      })(inputs[ii]);
    }
  }

  document.getElementById('cancelScan').addEventListener('click', function(){
    scannedItems = [];
    document.getElementById('scanPreview').style.display = 'none';
    setStatus('Cancelado', 'loading');
    setTimeout(function(){ var s = document.getElementById('status'); s.style.display = 'none'; }, 1500);
  });
  document.getElementById('saveAll').addEventListener('click', function(){
    if (!scannedItems.length) return;
    var cardField = getField('card');
    var defaultCard = cardField ? cardField.value : 'Débito UYU';
    var dateField = getField('date');
    var date = dateField ? dateField.value : '';
    var batch = scannedItems.map(function(it){
      return {
        item: it.name,
        amount: it.amount,
        currency: 'UYU',
        card: defaultCard,
        category: it.category,
        date: date
      };
    });
    setLocked(true);
    setStatus('Guardando ' + batch.length + ' items...', 'loading');
    google.script.run
      .withSuccessHandler(function(result){
        setLocked(false);
        if (result && result.ok) {
          setStatus('✓ ' + result.saved + ' guardados · ' + result.failed + ' fallaron · ' + result.tab, 'ok');
          scannedItems = [];
          document.getElementById('scanPreview').style.display = 'none';
        } else {
          setStatus('✗ Batch: ' + (result && result.error || 'error'), 'err');
        }
      })
      .withFailureHandler(function(err){
        setLocked(false);
        setStatus('✗ Batch: ' + (err && err.message ? err.message : err), 'err');
      })
      .addBatch(batch);
  });

  // === Tabs ===
  var dashLoadedOnce = false;
  function switchTab(panelId) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-panel') === panelId);
    }
    var panels = document.querySelectorAll('.panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('active', panels[j].id === panelId);
    }
    if (panelId === 'dashPanel' && !dashLoadedOnce) loadDashboard();
  }
  var tabBtns = document.querySelectorAll('.tab');
  for (var t = 0; t < tabBtns.length; t++) {
    (function(b){ b.addEventListener('click', function(){ switchTab(b.getAttribute('data-panel')); }); })(tabBtns[t]);
  }
  document.getElementById('refreshDash').addEventListener('click', function(){ loadDashboard(); });

  // === Dashboard ===
  function fmt(n, cur) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    try {
      if (!cur) {
        return new Intl.NumberFormat('es-UY', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
      }
      // UYU: sin decimales (montos enteros). USD/ARS: 2 decimales.
      var maxFrac = cur === 'UYU' ? 0 : 2;
      return new Intl.NumberFormat('es-UY', {
        style: 'currency',
        currency: cur,
        currencyDisplay: 'symbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: maxFrac
      }).format(n);
    } catch(e) {
      var sym = cur === 'USD' ? 'US$ ' : '$ ';
      return sym + n.toFixed(cur === 'UYU' ? 0 : 2);
    }
  }

  function loadDashboard() {
    var content = document.getElementById('dashContent');
    content.className = 'dash-loader';
    content.textContent = 'Cargando datos...';
    google.script.run
      .withSuccessHandler(renderDashboard)
      .withFailureHandler(function(err){
        content.textContent = '✗ Error: ' + (err && err.message ? err.message : err);
      })
      .getDashboardData();
  }

  function renderDashboard(data) {
    dashLoadedOnce = true;
    var content = document.getElementById('dashContent');
    if (!data || !data.ok) {
      content.className = 'dash-loader';
      content.textContent = '✗ ' + ((data && data.error) || 'Error desconocido');
      return;
    }
    document.getElementById('dashTitle').textContent = data.tab;
    content.className = '';
    var t = data.totals || {};
    var html = '';

    // KPIs
    html += '<div class="dash-section"><div class="dash-kpis">';
    html += '<div class="dash-kpi big"><div class="dash-kpi-label">Total UYU+USD en UYU</div><div class="dash-kpi-val">' + fmt(t.uyuInUyu, 'UYU') + '</div><div class="dash-kpi-sub">cot. ' + fmt(data.cotizacion) + '</div></div>';
    html += '<div class="dash-kpi"><div class="dash-kpi-label">Total UYU</div><div class="dash-kpi-val">' + fmt(t.uyu, 'UYU') + '</div></div>';
    html += '<div class="dash-kpi"><div class="dash-kpi-label">Total USD</div><div class="dash-kpi-val">' + fmt(t.usd, 'USD') + '</div></div>';
    html += '<div class="dash-kpi"><div class="dash-kpi-label">Fijos UYU</div><div class="dash-kpi-val">' + fmt(t.fixedUyu, 'UYU') + '</div></div>';
    html += '<div class="dash-kpi"><div class="dash-kpi-label">Variable UYU</div><div class="dash-kpi-val">' + fmt(t.varUyu, 'UYU') + '</div><div class="dash-kpi-sub">' + (data.variableCount || 0) + ' gastos</div></div>';
    // Top categoría KPI
    if (data.byCategory && data.byCategory.length) {
      var topCat = data.byCategory.filter(function(c){ return (c.uyu||0) > 0; })[0];
      if (topCat) {
        html += '<div class="dash-kpi big" style="background:#fef3c7;border-color:#fde68a"><div class="dash-kpi-label">🥇 Top categoría</div><div class="dash-kpi-val" style="color:#92400e">' + topCat.name + '</div><div class="dash-kpi-sub">' + fmt(topCat.uyu, 'UYU') + '</div></div>';
      }
    }
    html += '</div></div>';

    // Por categoría con barras + ranking
    if (data.byCategory && data.byCategory.length) {
      var maxCat = data.byCategory.reduce(function(m, x){ return Math.max(m, x.uyu || 0); }, 0);
      var totalCatUyu = data.byCategory.reduce(function(s, x){ return s + (x.uyu || 0); }, 0);
      html += '<div class="dash-section"><h2>Por categoría (UYU)</h2><div class="dash-list">';
      var rank = 0;
      for (var i = 0; i < data.byCategory.length; i++) {
        var c = data.byCategory[i];
        if (!c.uyu && !c.usd) continue;
        rank++;
        var pct = maxCat > 0 ? (c.uyu / maxCat * 100) : 0;
        var pctTot = totalCatUyu > 0 ? (c.uyu / totalCatUyu * 100) : 0;
        var medal = rank === 1 ? '🥇 ' : (rank === 2 ? '🥈 ' : (rank === 3 ? '🥉 ' : ''));
        var rowStyle = rank === 1 ? ' style="background:#fefce8"' : '';
        var barColor = rank === 1 ? '#f59e0b' : '#0f766e';
        html += '<div class="dash-list-row"' + rowStyle + '>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="name">' + medal + c.name + '</div>' +
            '<div class="dash-bar"><div style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
          '</div>' +
          '<div class="val" style="text-align:right">' + fmt(c.uyu, 'UYU') +
            '<div class="sub" style="font-weight:400">' + pctTot.toFixed(0) + '%</div>' +
          '</div>' +
        '</div>';
      }
      html += '</div></div>';
    }

    // Por medio de pago
    if (data.byCard && data.byCard.length) {
      html += '<div class="dash-section"><h2>Por medio de pago</h2><div class="dash-list">';
      for (var k = 0; k < data.byCard.length; k++) {
        var card = data.byCard[k];
        if (!card.amount) continue;
        html += '<div class="dash-list-row"><span class="name">' + card.name + '</span><span class="val">' + fmt(card.amount, card.currency) + '</span></div>';
      }
      html += '</div></div>';
    }

    // Últimos gastos
    if (data.recent && data.recent.length) {
      html += '<div class="dash-section"><h2>Últimos gastos</h2><div class="dash-list">';
      for (var r = 0; r < data.recent.length; r++) {
        var e = data.recent[r];
        html += '<div class="dash-list-row"><div style="flex:1;min-width:0"><div class="name">' + e.item + '</div><div class="sub">' + (e.card || '') + (e.category ? ' · ' + e.category : '') + '</div></div><div class="val">' + fmt(e.amount, e.currency) + '</div></div>';
      }
      html += '</div></div>';
    }

    content.innerHTML = html;
  }
</script>
</body></html>`;
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
  sheet.setName(tabName);
  // Move new tab to position right after template
  const templateIdx = template.getIndex();
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(templateIdx + 1);
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

function monthTabFor(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) throw new Error('Fecha inválida: ' + date);
  return MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
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

  const tabName = monthTabFor(date ? new Date(date) : new Date());
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
    return {
      tab: tabName, row: row1, fixed: true, cotizSource,
      written: { item: String(range[fixedRowIdx][0]).trim(), amount: amt, currency: currencyUpper, prevAmount: existingNum, cotizacion }
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

  // Build single row write (atomic — one round trip instead of 4)
  const numCols = headers.length;
  const row = new Array(numCols).fill('');
  row[0] = item;
  row[cardCol] = amt;
  if (cotizCol >= 0 && cotizacion) row[cotizCol] = cotizacion;
  if (catCol >= 0 && category) row[catCol] = category;
  if (notes && catCol >= 0 && catCol + 1 < numCols) row[catCol + 1] = notes;
  sheet.getRange(insertAt, 1, 1, numCols).setValues([row]);

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
    written: { item, amount: amt, currency, card, category: category || null, cotizacion: cotizacion || null, notes: notes || null }
  };
}
