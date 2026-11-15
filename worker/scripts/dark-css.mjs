// Modo oscuro del formulario, generado a partir de su hoja de estilos (apps-script/form-styles.html).
//
// La hoja tiene unos 600 colores escritos a mano. En vez de reemplazarlos por variables (y arriesgar el modo claro), se
// genera un bloque `@media (prefers-color-scheme: dark)` que repite, en el mismo orden, cada regla que toca colores con los
// colores convertidos. El modo claro no se modifica: si este archivo no corre, el formulario queda igual que antes.
//
// Por qué se repiten TODAS las declaraciones de color y no solo las que tienen un hex: una regla más abajo en la hoja
// (por ejemplo `background: none`) le gana a una anterior de igual especificidad; si el bloque oscuro copiara solo la
// anterior, quedaría al final del documento y le ganaría a la de abajo.
//
// Reglas de conversión (en HSL):
//   fondo  claro (L > 0.60) -> oscuro, invertido: lo más blanco queda lo más oscuro. Los fondos de acento (L <= 0.60) no cambian.
//   texto  oscuro (L < 0.62) -> claro. El texto claro (blanco sobre un acento) no cambia.
//   borde  claro -> oscuro apenas más claro que los fondos.
//   Si una regla trae fondo y texto, se comprueba el contraste del resultado y se corrige el texto si queda bajo 4,5.
// Sombras, animaciones (@keyframes) y @font-face no se tocan.

const PROPS_COLOR = /^(background|background-color|background-image|color|fill|stroke|caret-color|outline|outline-color|border|border-top|border-right|border-bottom|border-left|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color)$/;
const COLOR_RE = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^)]*\)|\bwhite\b|%23[0-9a-fA-F]{6}\b/g;

function aRgb(tok) {
  let t = tok.toLowerCase();
  if (t === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (t.startsWith('%23')) t = '#' + t.slice(3);
  if (t[0] === '#') {
    let h = t.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const m = t.match(/rgba?\(([^)]*)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
  if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

function aHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  const d = mx - mn;
  if (!d) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function deHsl({ h, s, l }) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

const luz = ({ r, g, b }) => {
  const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contraste = (x, y) => { const a = luz(x), b = luz(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

function convertir(rgb, tipo) {
  const hsl = aHsl(rgb);
  let { h, s, l } = hsl;
  if (tipo === 'fondo') {
    // Casi negro y sin color: es el estado "activo" invertido (píldora negra con texto blanco). En oscuro pasa a claro, si no
    // quedaría igual que las píldoras sin elegir.
    if (l < 0.2 && s < 0.15) { l = 0.9; s = 0; return { ...deHsl({ h, s, l }), a: rgb.a }; }
    if (l <= 0.60) return rgb;
    l = 0.10 + (1 - l) * 0.9; s = s * 0.55;
  } else if (tipo === 'texto') {
    if (l >= 0.62) return rgb;
    l = 0.95 - l * 0.7; s = Math.min(s, 0.85) * 0.85;
  } else { // borde
    if (l <= 0.60 && l >= 0.25) return rgb;
    if (l < 0.25) { l = 0.60; } else { l = 0.16 + (1 - l) * 0.7; s = s * 0.55; }
  }
  return { ...deHsl({ h, s, l }), a: rgb.a };
}

function aTexto(c, original) {
  if (original.startsWith('%23')) return '%23' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  if (original[0] === '#' && original.length !== 9 && original.length !== 5) return '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return c.a < 1 ? `rgba(${c.r},${c.g},${c.b},${+c.a.toFixed(3)})` : `rgb(${c.r},${c.g},${c.b})`;
}

const tipoDe = (prop) => (/^background/.test(prop) ? 'fondo' : /^(border|outline)/.test(prop) ? 'borde' : 'texto');

// Un overlay blanco translúcido sobre un acento (brillo) no es un fondo claro: se deja como está.
const esBrillo = (rgb) => rgb.r === 255 && rgb.g === 255 && rgb.b === 255 && rgb.a < 0.5;

function convertirValor(prop, valor) {
  const tipo = tipoDe(prop);
  let cambio = false;
  let out = valor.replace(COLOR_RE, (tok) => {
    const rgb = aRgb(tok);
    if (!rgb || esBrillo(rgb)) return tok;
    const c = convertir(rgb, tipo);
    if (c === rgb) return tok;
    cambio = true;
    return aTexto(c, tok);
  });
  // Burbujas de color por categoría: hsl(var(--h, 170) 65% 92%) -> la misma tonalidad, oscura.
  out = out.replace(/hsl\(\s*var\(--h,\s*(\d+)\)\s+(\d+)%\s+(\d+)%\s*\)/g, (m, h, s, l) => {
    if (+l <= 60) return m;
    cambio = true;
    return `hsl(var(--h, ${h}) ${Math.round(s * 0.55)}% ${Math.round(10 + (100 - l) * 0.9)}%)`;
  });
  return { valor: out, cambio };
}

// --- parser mínimo de CSS (sin anidado) -------------------------------------------------------------------------------
function sinComentarios(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

function bloques(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const a = css.indexOf('{', i);
    if (a < 0) break;
    const head = css.slice(i, a).trim();
    let d = 1, j = a + 1, q = null;
    while (j < css.length && d > 0) {
      const ch = css[j];
      if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '{') d++; else if (ch === '}') d--;
      j++;
    }
    out.push({ head, body: css.slice(a + 1, j - 1) });
    i = j;
  }
  return out;
}

function declaraciones(body) {
  const out = [];
  let cur = '', p = 0, q = null;
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(') p++; else if (ch === ')') p--;
    if (ch === ';' && p === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((d) => { const k = d.indexOf(':'); return k < 0 ? null : { prop: d.slice(0, k).trim().toLowerCase(), valor: d.slice(k + 1).trim() }; }).filter(Boolean);
}

function reglaOscura(sel, body) {
  const decls = declaraciones(body).filter((d) => PROPS_COLOR.test(d.prop));
  if (!decls.length) return '';
  let hayCambio = false;
  const res = decls.map((d) => {
    const c = convertirValor(d.prop, d.valor);
    if (c.cambio) hayCambio = true;
    return { prop: d.prop, valor: c.valor, original: d.valor, cambio: c.cambio };
  });
  // Contraste: si la regla trae fondo y texto y el texto convertido no se lee, se elige claro u oscuro.
  const fondo = res.find((d) => /^background(-color)?$/.test(d.prop));
  const texto = res.find((d) => d.prop === 'color');
  if (fondo && texto) {
    const mf = fondo.valor.match(COLOR_RE), mt = texto.valor.match(COLOR_RE);
    const f = mf && aRgb(mf[0]), t = mt && aRgb(mt[0]);
    if (f && t && f.a >= 0.9 && contraste(f, t) < 4.5) {
      const claro = { r: 242, g: 242, b: 238 }, oscuro = { r: 17, g: 17, b: 17 };
      const mejor = contraste(f, claro) >= contraste(f, oscuro) ? claro : oscuro;
      texto.valor = texto.valor.replace(COLOR_RE, aTexto(mejor, '#000000'));
      texto.cambio = true; hayCambio = true;
    }
  }
  if (!hayCambio) return '';
  return `${sel} { ${res.map((d) => `${d.prop}: ${d.valor}`).join('; ')}; }`;
}

function procesar(css, nivel) {
  const reglas = [];
  for (const { head, body } of bloques(css)) {
    if (head.startsWith('@')) {
      if (/^@(media|supports|container|layer)\b/.test(head)) {
        const dentro = procesar(body, nivel + 1);
        if (dentro.length) reglas.push(`${head} {\n${dentro.join('\n')}\n}`);
      } // @keyframes, @font-face y demás: no se tocan
    } else {
      const r = reglaOscura(head, body);
      if (r) reglas.push(r);
    }
  }
  return reglas;
}

// forzar=true emite `@media all` en vez de `(prefers-color-scheme: dark)`: solo para mirar el resultado en un navegador sin tema oscuro.
export function cssOscuro(css, { forzar = false } = {}) {
  const reglas = procesar(sinComentarios(css), 0);
  const cond = forzar ? 'all' : '(prefers-color-scheme: dark)';
  return `\n  /* ===== Modo oscuro (generado por worker/scripts/dark-css.mjs; no editar a mano) ===== */\n  :root { color-scheme: ${forzar ? 'dark' : 'light dark'}; }\n  @media ${cond} {\n${reglas.join('\n')}\n  }\n`;
}
