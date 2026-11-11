// El formulario de gastos (el mismo de Apps Script) servido por el Worker.
// form.generated.html lo arma scripts/build-form.mjs; acá se completan las variables.
import FORM from './form.generated.html';
import CFG from './form-config.json';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON dentro de <script>: se evita cerrar la etiqueta por accidente.
const jsonEnScript = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

export function renderForm(hoy) {
  const opciones = CFG.categorias.map((c) => '<option>' + esc(c) + '</option>').join('');
  const vars = {
    today: esc(hoy),
    categoryOptions: opciones,
    categoryOptionsNew: CFG.categorias.map((c) => '<option' + (c === 'Otros' ? ' selected' : '') + '>' + esc(c) + '</option>').join(''),
    categoryOptions2: '<option value="" selected>— ninguna —</option>' + opciones,
    catRulesJson: jsonEnScript(CFG.catRules),
    categoriasJson: jsonEnScript(CFG.categorias),
    catsSocialesJson: jsonEnScript(CFG.catsSociales),
    tickersJson: jsonEnScript(CFG.tickers)
  };
  return FORM.replace(/<\?!?=\s*(\w+)\s*\?>/g, (_, k) => (k in vars ? vars[k] : ''));
}

export const CSP_FORM = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: blob: https://www.google.com https://icons.duckduckgo.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
