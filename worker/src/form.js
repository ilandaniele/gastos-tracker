// Renderiza el formulario (form.generated.html, que build-form.mjs arma desde apps-script/) con
// las mismas sustituciones que hace HtmlService en Code.gs: <?= x ?> y <?!= x ?>.
// Con `cfg` (config de la cuenta, ver docs/MULTI-TENANT-PASO2.md) usa sus categorías, reglas y
// medios de pago, y le pasa al cliente la parte pública (moneda, medios, módulos) en TENANT_CFG.
// Sin `cfg` queda exactamente como antes (form-config.json, la config de Ilan).
import FORM from './form.generated.html';
import CFG from './form-config.json';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON dentro de <script>: sin "</script>" ni separadores de línea que corten el string.
const jsonEnScript = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

const arr = (v, def) => (Array.isArray(v) && v.length ? v : def);

// Opciones de un <select> de medios de pago; el primero queda elegido.
const opcionesMedios = (medios, conSelected) =>
  '\n' + medios.map((m, i) => '      <option' + (conSelected && i === 0 ? ' selected' : '') + '>' + esc(m) + '</option>').join('\n') + '\n    ';

export function renderForm(hoy, cfg) {
  const categorias = arr(cfg && cfg.categorias, CFG.categorias);
  const catRules = cfg && Array.isArray(cfg.catRules) ? cfg.catRules : CFG.catRules;
  const catsSociales = cfg && Array.isArray(cfg.catsSociales) ? cfg.catsSociales : CFG.catsSociales;

  let html = FORM;
  if (cfg) {
    const publico = {
      pais: cfg.pais || null,
      moneda: cfg.moneda || 'UYU',
      medios: arr(cfg.medios, null),
      modulos: cfg.modulos || {},
    };
    // Función como reemplazo: así un "$&" o "$1" dentro de la config no se interpreta.
    html = html.replace('/*TENANT_CFG*/null', () => jsonEnScript(publico));
    if (publico.medios) {
      html = html
        .replace(/(<select id="fCard" name="card" required>)[\s\S]*?(<\/select>)/, (_, a, b) => a + opcionesMedios(publico.medios, true) + b)
        .replace(/(<select id="expCard">)[\s\S]*?(<\/select>)/, (_, a, b) => a + opcionesMedios(publico.medios, false) + b);
    }
  }

  const opciones = categorias.map((c) => '<option>' + esc(c) + '</option>').join('');
  const vars = {
    today: esc(hoy),
    categoryOptions: opciones,
    categoryOptionsNew: categorias.map((c) => '<option' + (c === 'Otros' ? ' selected' : '') + '>' + esc(c) + '</option>').join(''),
    categoryOptions2: '<option value="" selected>— ninguna —</option>' + opciones,
    catRulesJson: jsonEnScript(catRules),
    categoriasJson: jsonEnScript(categorias),
    catsSocialesJson: jsonEnScript(catsSociales),
    tickersJson: jsonEnScript(CFG.tickers),
  };
  return html.replace(/<\?!?=\s*(\w+)\s*\?>/g, (_, k) => (k in vars ? vars[k] : ''));
}

export const CSP_FORM = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: blob: https://www.google.com https://icons.duckduckgo.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
