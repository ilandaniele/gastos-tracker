// Wizard de configuración de la cuenta (multi-tenant paso 2, ver docs/MULTI-TENANT-PASO2.md).
//
// paginaOnboarding(cfg, { edicion }) devuelve la página completa. Sirve para el alta (cuenta nueva,
// onboarding_listo = 0) y para editar después (edicion = true: la moneda queda fija porque cambiarla
// cambiaría el significado de los importes ya guardados; el servidor igual la rechaza con 400).
//
// 4 pasos: país/moneda/zona horaria, medios de pago, categorías, módulos + resumen. Guarda con
// POST /api/config ({pais, moneda, tz, medios, categorias, modulos}) y va a /app.
//
// Seguridad: nada de cfg se escribe como HTML. El estado inicial viaja como JSON dentro del
// <script> (jsonEnScript escapa "<" y los separadores de línea) y el JS lo pinta con textContent.
// CSP pensada para esta página:
//   default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self';
//   base-uri 'none'; form-action 'none'; frame-ancestors 'none'

const jsonEnScript = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
  .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

export const CSP_ONBOARDING = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const lista = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

export function paginaOnboarding(cfg, opciones) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const edicion = !!(opciones && opciones.edicion);
  const inicial = {
    edicion,
    pais: typeof c.pais === 'string' ? c.pais : '',
    moneda: typeof c.moneda === 'string' ? c.moneda : '',
    tz: typeof c.tz === 'string' ? c.tz : '',
    medios: lista(c.medios),
    categorias: lista(c.categorias),
    modulos: c.modulos && typeof c.modulos === 'object' ? c.modulos : {},
  };
  const titulo = edicion ? 'Ajustes de la cuenta' : 'Configurá tu cuenta';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${titulo}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <nav class="arriba" aria-label="Cuenta">
    ${edicion ? '<a href="/app">← Volver a la app</a>' : '<span></span>'}
    <button type="button" id="salir" class="link">Salir</button>
  </nav>
  <h1>${titulo}</h1>
  <p class="sub">${edicion ? 'Cambiá lo que necesites y guardá.' : 'Cuatro pasos cortos y empezás a cargar gastos.'}</p>
  <ol class="pasos" id="pasos" aria-label="Pasos">
    <li data-n="1">País</li><li data-n="2">Medios</li><li data-n="3">Categorías</li><li data-n="4">Resumen</li>
  </ol>
  <noscript><p class="aviso err">Esta página necesita JavaScript.</p></noscript>
  <form id="wiz" novalidate>

    <section data-paso="1" aria-labelledby="t1">
      <h2 id="t1" tabindex="-1">1. País y moneda</h2>
      <label for="pais">País</label>
      <select id="pais">
        <option value="UY">Uruguay</option><option value="AR">Argentina</option><option value="CL">Chile</option>
        <option value="MX">México</option><option value="CO">Colombia</option><option value="PE">Perú</option>
        <option value="PY">Paraguay</option><option value="BR">Brasil</option><option value="ES">España</option>
        <option value="US">Estados Unidos</option><option value="XX">Otro país</option>
      </select>
      <div id="monedaEditable">
        <label for="moneda">Moneda local</label>
        <select id="moneda">
          <option value="UYU">UYU · peso uruguayo</option><option value="ARS">ARS · peso argentino</option>
          <option value="CLP">CLP · peso chileno</option><option value="MXN">MXN · peso mexicano</option>
          <option value="COP">COP · peso colombiano</option><option value="PEN">PEN · sol peruano</option>
          <option value="PYG">PYG · guaraní</option><option value="BRL">BRL · real</option>
          <option value="BOB">BOB · boliviano</option><option value="EUR">EUR · euro</option>
          <option value="USD">USD · dólar estadounidense</option><option value="GBP">GBP · libra esterlina</option>
          <option value="CAD">CAD · dólar canadiense</option><option value="otra">Otra…</option>
        </select>
        <div id="monedaOtraBox" hidden>
          <label for="monedaOtra">Código de la moneda (3 letras, ISO 4217)</label>
          <input id="monedaOtra" maxlength="3" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ej: CHF" aria-describedby="monedaOtraAyuda">
          <p class="ayuda" id="monedaOtraAyuda">Por ejemplo CHF, GTQ, CRC.</p>
        </div>
        <p class="ayuda">La otra moneda siempre es el dólar (USD). La moneda local no se puede cambiar después.</p>
      </div>
      <div id="monedaFija" hidden>
        <p class="etq">Moneda local</p>
        <p class="fija" id="monedaFijaTxt"></p>
        <p class="ayuda">No se puede cambiar: cambiaría el valor de los gastos que ya cargaste.</p>
      </div>
      <label for="tz">Zona horaria</label>
      <input id="tz" list="tzLista" autocomplete="off" spellcheck="false" aria-describedby="tzAyuda">
      <datalist id="tzLista"></datalist>
      <p class="ayuda" id="tzAyuda">Define qué día es "hoy" al cargar un gasto. <button type="button" class="link" id="tzLocal" hidden></button></p>
      <div class="aviso err" id="err1" role="alert" hidden></div>
    </section>

    <section data-paso="2" aria-labelledby="t2" hidden>
      <h2 id="t2" tabindex="-1">2. Medios de pago</h2>
      <p class="ayuda">Elegí con qué pagás. El primero queda elegido por defecto al cargar un gasto.</p>
      <fieldset>
        <legend id="legLocal"></legend>
        <div class="checks" id="stdLocal"></div>
      </fieldset>
      <fieldset id="fsUsd">
        <legend>En dólares (USD)</legend>
        <div class="checks" id="stdUsd"></div>
      </fieldset>
      <fieldset>
        <legend>Tarjetas con nombre</legend>
        <ul class="nombradas" id="nombradas"></ul>
        <p class="ayuda" id="sinNombradas">Todavía no agregaste ninguna.</p>
        <label for="nuevaTarj">Nombre de la tarjeta</label>
        <input id="nuevaTarj" maxlength="40" autocomplete="off" placeholder="ej: Visa Banco" aria-describedby="nuevaTarjAyuda">
        <p class="ayuda" id="nuevaTarjAyuda">Enter la agrega. Si es de crédito se le agrega "Crédito" al nombre; si es en dólares, "USD".</p>
        <div class="radios" role="radiogroup" aria-label="Tipo de tarjeta">
          <label class="op"><input type="radio" name="tipoTarj" value="Débito" checked> Débito</label>
          <label class="op"><input type="radio" name="tipoTarj" value="Crédito"> Crédito</label>
        </div>
        <div class="radios" role="radiogroup" aria-label="Moneda de la tarjeta" id="monTarjBox">
          <label class="op"><input type="radio" name="monTarj" value="L" checked> <span id="monTarjLocal"></span></label>
          <label class="op"><input type="radio" name="monTarj" value="USD"> USD</label>
        </div>
        <button type="button" class="sec" id="agregarTarj">Agregar tarjeta</button>
      </fieldset>
      <div class="aviso err" id="err2" role="alert" hidden></div>
    </section>

    <section data-paso="3" aria-labelledby="t3" hidden>
      <h2 id="t3" tabindex="-1">3. Categorías</h2>
      <p class="ayuda" id="catAyuda">Tocá para prender o apagar. "Otros" siempre está y va al final.</p>
      <div class="chips" id="chips" role="group" aria-labelledby="t3" aria-describedby="catAyuda"></div>
      <label for="nuevaCat">Agregar una categoría</label>
      <div class="fila">
        <input id="nuevaCat" maxlength="30" autocomplete="off" placeholder="ej: Mascotas">
        <button type="button" class="sec corto" id="agregarCat">Agregar</button>
      </div>
      <div class="aviso err" id="err3" role="alert" hidden></div>
    </section>

    <section data-paso="4" aria-labelledby="t4" hidden>
      <h2 id="t4" tabindex="-1">4. Listo</h2>
      <label class="op switch"><input type="checkbox" id="modRapidos"> Accesos rápidos de ejemplo (botones con comercios y servicios de Uruguay; no son editables todavía)</label>
      <h3>Resumen</h3>
      <dl class="resumen" id="resumen"></dl>
      <div class="aviso err" id="err4" role="alert" hidden></div>
    </section>

    <div class="nav">
      <button type="button" class="sec" id="atras">Atrás</button>
      <button type="submit" id="siguiente">Siguiente</button>
    </div>
    <p class="estado" id="estado" role="status" aria-live="polite"></p>
  </form>
</main>
<script>
var INI = ${jsonEnScript(inicial)};
${JS}
</script>
</body>
</html>`;
}

const CSS = `
:root{--bg:#f4f4f2;--card:#fff;--ink:#1c1c1a;--mut:#6b6b66;--line:#d9d9d3;--acc:#1f6f54;--acc-ink:#fff;--okbg:#e4f3ec;--errbg:#fbe9e7;--errink:#a3281b;--gbg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121413;--card:#1c1f1d;--ink:#ecece8;--mut:#9a9a93;--line:#34383a;--acc:#4cb68f;--acc-ink:#0c1511;--okbg:#17302a;--errbg:#3a1f1c;--errink:#ff9d90;--gbg:#131314}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100dvh;display:flex;align-items:flex-start;justify-content:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px 18px 24px}
h1{font-size:24px;line-height:1.2;margin:4px 0 6px;letter-spacing:-.01em}p.sub{margin:0 0 16px;color:var(--mut)}
h2{font-size:19px;margin:0 0 12px}h2:focus{outline:none}h3{font-size:16px;margin:22px 0 8px}
label,.etq{display:block;font-size:14px;font-weight:600;margin:16px 0 6px}
input:not([type=checkbox]):not([type=radio]),select{width:100%;min-height:48px;padding:0 14px;font:inherit;font-size:16px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:12px}
select{appearance:auto}
input[type=checkbox],input[type=radio]{width:20px;height:20px;margin:0;flex:0 0 auto;accent-color:var(--acc)}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
input:focus-visible,select:focus-visible{outline-offset:1px;border-color:transparent}
button{min-height:48px;font:inherit;font-weight:600;color:var(--acc-ink);background:var(--acc);border:0;border-radius:12px;cursor:pointer;padding:0 18px}
button:disabled{opacity:.6;cursor:default}
button.sec{color:var(--ink);background:transparent;border:1px solid var(--line)}
button.link{min-height:44px;padding:0 4px;background:none;color:var(--acc);border:0;text-decoration:underline;font-weight:600}
.ayuda{margin:6px 0 0;font-size:14px;color:var(--mut)}.ayuda button.link{min-height:44px;font-size:14px}
.fija{margin:0;font-size:18px;font-weight:700}
.aviso{margin:16px 0 0;padding:12px 14px;border-radius:12px;font-size:15px}.aviso.err{background:var(--errbg);color:var(--errink)}
.arriba{display:flex;justify-content:space-between;align-items:center;margin:-6px 0 4px}
.arriba a{display:inline-flex;align-items:center;min-height:44px;color:var(--acc);font-weight:600;text-decoration:none}
.pasos{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;list-style:none;margin:0 0 18px;padding:0;counter-reset:p}
.pasos li{font-size:12px;color:var(--mut);text-align:center;padding-top:8px;border-top:4px solid var(--line);overflow-wrap:anywhere}
.pasos li.hecho{border-top-color:var(--acc)}.pasos li[aria-current]{border-top-color:var(--acc);color:var(--ink);font-weight:700}
fieldset{border:1px solid var(--line);border-radius:12px;margin:14px 0 0;padding:4px 12px 12px;min-width:0}
legend{font-size:14px;font-weight:700;padding:0 6px}
.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:2px 8px}
.op{display:flex;align-items:center;gap:10px;min-height:44px;margin:0;font-weight:500;font-size:16px;cursor:pointer}
.radios{display:flex;flex-wrap:wrap;gap:0 18px;margin-top:6px}
.nombradas{list-style:none;margin:8px 0 0;padding:0}
.nombradas li{display:flex;gap:8px;align-items:center;margin-top:8px}
.nombradas li input{flex:1 1 auto;min-width:0}
button.corto{flex:0 0 auto;min-width:44px;padding:0 14px}
#agregarTarj{margin-top:10px;width:100%}
.fila{display:flex;gap:8px}.fila input{flex:1 1 auto;min-width:0}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:stretch;border-radius:999px;border:1px solid var(--line);overflow:hidden}
.chip button{min-height:44px;border-radius:0;background:transparent;color:var(--ink);font-weight:500;padding:0 14px}
.chip button[aria-pressed=true]{background:var(--acc);color:var(--acc-ink)}
.chip button.quitar{padding:0 12px;border-left:1px solid var(--line);font-size:18px;line-height:1}
.chip.fijo button{cursor:default}
.switch{font-weight:500;margin-top:0}
.resumen{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;font-size:15px}
.resumen dt{color:var(--mut)}.resumen dd{margin:0;overflow-wrap:anywhere}
.nav{display:flex;gap:10px;margin-top:22px}.nav button{flex:1 1 0}
.estado{min-height:1.5em;margin:10px 0 0;font-size:14px;color:var(--mut)}
[hidden]{display:none!important}
`;

// JS del cliente (va dentro de <script>, sin "</" literal).
const JS = String.raw`
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PAISES = {
    UY: ['UYU', 'America/Montevideo'], AR: ['ARS', 'America/Argentina/Buenos_Aires'], CL: ['CLP', 'America/Santiago'],
    MX: ['MXN', 'America/Mexico_City'], CO: ['COP', 'America/Bogota'], PE: ['PEN', 'America/Lima'],
    PY: ['PYG', 'America/Asuncion'], BR: ['BRL', 'America/Sao_Paulo'], ES: ['EUR', 'Europe/Madrid'],
    US: ['USD', 'America/New_York']
  };
  var TIPOS = ['Débito', 'Efectivo', 'Crédito'];
  var SUGERIDAS = ['Supermercado', 'Comida', 'Bebida/Bar', 'Transporte', 'Hogar', 'Servicios', 'Salud', 'Ropa',
    'Entretenimiento', 'Suscripciones', 'Regalos', 'Viajes', 'Educación', 'Mascotas', 'Gimnasio'];
  var MAX_MEDIOS = 20, MAX_CATS = 30;
  var RE_USD = /usd|d[oó]lar/i, RE_CRED = /cr[eé]dito|\boca\b/i;
  var norm = function (s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); };
  var tzNav = '';
  try { tzNav = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}

  // ---- Estado ----
  var ed = !!INI.edicion;
  var st = {
    pais: PAISES[INI.pais] || INI.pais === 'XX' ? INI.pais : (INI.pais ? 'XX' : 'UY'),
    moneda: /^[A-Z]{3}$/.test(INI.moneda) ? INI.moneda : '',
    tz: INI.tz || '',
    std: {},        // 'Débito|L' / 'Efectivo|USD' -> true
    nombradas: [],  // [{id, nombre}]
    cats: [],       // elegidas (sin 'Otros')
    extra: [],      // propias (no sugeridas), visibles aunque estén apagadas
    rapidos: INI.modulos.accesosRapidos === true
  };
  if (!st.moneda) st.moneda = (PAISES[st.pais] || PAISES.UY)[0];
  if (!ed && !INI.pais) st.tz = tzNav || (PAISES[st.pais] || PAISES.UY)[1];
  if (!st.tz) st.tz = tzNav || 'UTC';
  var nId = 0;
  INI.medios.forEach(function (m) {
    var mt = /^(Débito|Crédito|Efectivo) ([A-Z]{3})$/.exec(m);
    if (mt && (mt[2] === st.moneda || mt[2] === 'USD')) st.std[mt[1] + '|' + (mt[2] === 'USD' && st.moneda !== 'USD' ? 'USD' : 'L')] = true;
    else st.nombradas.push({ id: ++nId, nombre: m });
  });
  INI.categorias.forEach(function (c) {
    if (norm(c) === 'otros') return;
    st.cats.push(c);
    if (!SUGERIDAS.some(function (s) { return norm(s) === norm(c); })) st.extra.push(c);
  });

  // ---- Paso 1 ----
  var selPais = $('pais'), selMon = $('moneda'), inOtra = $('monedaOtra'), inTz = $('tz');
  selPais.value = st.pais;
  function pintarMoneda() {
    var hay = Array.prototype.some.call(selMon.options, function (o) { return o.value === st.moneda; });
    selMon.value = hay ? st.moneda : 'otra';
    $('monedaOtraBox').hidden = hay;
    if (!hay) inOtra.value = st.moneda;
  }
  if (ed) {
    $('monedaEditable').hidden = true; $('monedaFija').hidden = false;
    $('monedaFijaTxt').textContent = st.moneda;
  } else pintarMoneda();
  inTz.value = st.tz;
  try {
    if (Intl.supportedValuesOf) {
      var dl = $('tzLista');
      Intl.supportedValuesOf('timeZone').forEach(function (z) { var o = document.createElement('option'); o.value = z; dl.appendChild(o); });
    }
  } catch (e) {}
  var bTzLocal = $('tzLocal');
  function pintarTzLocal() {
    bTzLocal.hidden = !tzNav || inTz.value.trim() === tzNav;
    bTzLocal.textContent = 'Usar la de este dispositivo (' + tzNav + ')';
  }
  bTzLocal.addEventListener('click', function () { inTz.value = tzNav; pintarTzLocal(); inTz.focus(); });
  inTz.addEventListener('input', pintarTzLocal);
  pintarTzLocal();
  selPais.addEventListener('change', function () {
    st.pais = selPais.value;
    var p = PAISES[st.pais];
    if (!p) { if (!ed) { selMon.focus(); } return; }
    if (!ed) { st.moneda = p[0]; pintarMoneda(); }
    inTz.value = p[1]; pintarTzLocal();
  });
  selMon.addEventListener('change', function () {
    var otra = selMon.value === 'otra';
    $('monedaOtraBox').hidden = !otra;
    if (otra) inOtra.focus(); else st.moneda = selMon.value;
  });
  inOtra.addEventListener('input', function () { inOtra.value = inOtra.value.toUpperCase().replace(/[^A-Z]/g, ''); });

  function tzValida(z) {
    if (!z) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (e) { return false; }
  }
  function validar1() {
    if (!ed) {
      var m = selMon.value === 'otra' ? inOtra.value.trim().toUpperCase() : selMon.value;
      if (!/^[A-Z]{3}$/.test(m)) return { msg: 'Poné el código de la moneda: 3 letras, por ejemplo CHF.', el: inOtra };
      st.moneda = m;
    }
    var z = inTz.value.trim();
    if (!tzValida(z)) return { msg: 'Esa zona horaria no existe. Elegí una de la lista (por ejemplo America/Montevideo).', el: inTz };
    st.tz = z; st.pais = selPais.value;
    return null;
  }

  // ---- Paso 2 ----
  var local = function () { return st.moneda; };
  function nombreStd(tipo, mon) { return tipo + ' ' + (mon === 'L' ? local() : 'USD'); }
  function pintarStd() {
    $('legLocal').textContent = 'En moneda local (' + local() + ')';
    $('monTarjLocal').textContent = local();
    var esUsd = local() === 'USD';
    $('fsUsd').hidden = esUsd; $('monTarjBox').hidden = esUsd;
    if (esUsd) document.querySelector('input[name=monTarj][value=L]').checked = true;
    [['L', 'stdLocal'], ['USD', 'stdUsd']].forEach(function (par) {
      var box = $(par[1]); box.textContent = '';
      TIPOS.forEach(function (t) {
        var k = t + '|' + par[0];
        var l = document.createElement('label'); l.className = 'op';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!st.std[k];
        cb.addEventListener('change', function () { st.std[k] = cb.checked; });
        l.appendChild(cb); l.appendChild(document.createTextNode(' ' + nombreStd(t, par[0])));
        box.appendChild(l);
      });
    });
  }
  function pintarNombradas(foco) {
    var ul = $('nombradas'); ul.textContent = '';
    st.nombradas.forEach(function (n, i) {
      var li = document.createElement('li');
      var inp = document.createElement('input');
      inp.value = n.nombre; inp.maxLength = 40; inp.autocomplete = 'off';
      inp.id = 'nom' + n.id; inp.setAttribute('aria-label', 'Nombre del medio ' + (i + 1));
      inp.addEventListener('input', function () { n.nombre = inp.value; });
      var b = document.createElement('button'); b.type = 'button'; b.className = 'sec corto';
      b.textContent = 'Quitar'; b.setAttribute('aria-label', 'Quitar ' + n.nombre);
      b.addEventListener('click', function () {
        st.nombradas = st.nombradas.filter(function (x) { return x !== n; });
        pintarNombradas(); $('nuevaTarj').focus();
        anunciar('Quitaste ' + n.nombre + '.');
      });
      li.appendChild(inp); li.appendChild(b); ul.appendChild(li);
    });
    $('sinNombradas').hidden = st.nombradas.length > 0;
    if (foco) { var f = $('nom' + foco); if (f) f.focus(); }
  }
  function agregarTarjeta() {
    var inp = $('nuevaTarj');
    var base = inp.value.replace(/\s+/g, ' ').trim();
    var cred = document.querySelector('input[name=tipoTarj]:checked').value === 'Crédito';
    var usd = local() !== 'USD' && document.querySelector('input[name=monTarj]:checked').value === 'USD';
    if (!base) return error(2, 'Escribí el nombre de la tarjeta.', inp);
    if (!cred && RE_CRED.test(base)) return error(2, 'El nombre dice crédito pero elegiste débito. Cambiá una de las dos cosas.', inp);
    if (!usd && local() !== 'USD' && RE_USD.test(base)) return error(2, 'El nombre dice dólares pero elegiste ' + local() + '. Cambiá una de las dos cosas.', inp);
    var nombre = base;
    if (cred && !RE_CRED.test(nombre)) nombre = 'Crédito ' + nombre;
    if (usd && !RE_USD.test(nombre)) nombre = nombre + ' USD';
    if (nombre.length > 40) return error(2, 'El nombre queda muy largo ("' + nombre + '"). Máximo 40 letras.', inp);
    if (medios().some(function (m) { return norm(m) === norm(nombre); })) return error(2, 'Ya tenés "' + nombre + '".', inp);
    st.nombradas.push({ id: ++nId, nombre: nombre });
    inp.value = ''; error(2, '');
    pintarNombradas(); inp.focus();
    anunciar('Agregaste ' + nombre + '.');
  }
  $('agregarTarj').addEventListener('click', agregarTarjeta);
  $('nuevaTarj').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); agregarTarjeta(); }
    else if (ev.key === 'Escape' && this.value) { ev.preventDefault(); this.value = ''; }
  });
  function medios() {
    var out = [];
    ['L', 'USD'].forEach(function (mon) {
      if (mon === 'USD' && local() === 'USD') return;
      TIPOS.forEach(function (t) { if (st.std[t + '|' + mon]) out.push(nombreStd(t, mon)); });
    });
    st.nombradas.forEach(function (n) { var v = n.nombre.replace(/\s+/g, ' ').trim(); if (v) out.push(v); });
    if (ed) { // en edición se respeta el orden que ya tenía (el primero es el de por defecto)
      var pos = function (m) { var i = INI.medios.indexOf(m); return i < 0 ? 1e3 : i; };
      out = out.map(function (m, i) { return [m, i]; })
        .sort(function (a, b) { return (pos(a[0]) - pos(b[0])) || (a[1] - b[1]); })
        .map(function (x) { return x[0]; });
    }
    return out;
  }
  function validar2() {
    var ms = medios();
    if (!ms.length) return { msg: 'Elegí al menos un medio de pago.', el: document.querySelector('#stdLocal input') };
    if (ms.length > MAX_MEDIOS) return { msg: 'Son demasiados: máximo ' + MAX_MEDIOS + ' medios de pago.' };
    var vistos = {};
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].length > 40) return { msg: '"' + ms[i] + '" es muy largo (máximo 40 letras).' };
      if (vistos[norm(ms[i])]) return { msg: '"' + ms[i] + '" está repetido.' };
      vistos[norm(ms[i])] = true;
    }
    for (var j = 0; j < st.nombradas.length; j++) {
      if (!st.nombradas[j].nombre.trim()) return { msg: 'Hay una tarjeta sin nombre: escribile uno o quitala.', el: $('nom' + st.nombradas[j].id) };
    }
    return null;
  }

  // ---- Paso 3 ----
  function pintarChips() {
    var box = $('chips'); box.textContent = '';
    var todas = SUGERIDAS.slice();
    st.extra.forEach(function (c) { if (!todas.some(function (s) { return norm(s) === norm(c); })) todas.push(c); });
    todas.forEach(function (c) {
      var propia = st.extra.indexOf(c) >= 0;
      var w = document.createElement('span'); w.className = 'chip';
      var b = document.createElement('button'); b.type = 'button'; b.textContent = c;
      var on = st.cats.some(function (x) { return norm(x) === norm(c); });
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () {
        var i = st.cats.findIndex(function (x) { return norm(x) === norm(c); });
        if (i >= 0) st.cats.splice(i, 1); else st.cats.push(c);
        b.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
      });
      w.appendChild(b);
      if (propia) {
        var q = document.createElement('button'); q.type = 'button'; q.className = 'quitar';
        q.textContent = '×'; q.setAttribute('aria-label', 'Quitar ' + c);
        q.addEventListener('click', function () {
          st.extra = st.extra.filter(function (x) { return x !== c; });
          st.cats = st.cats.filter(function (x) { return norm(x) !== norm(c); });
          pintarChips(); $('nuevaCat').focus(); anunciar('Quitaste ' + c + '.');
        });
        w.appendChild(q);
      }
      box.appendChild(w);
    });
    var f = document.createElement('span'); f.className = 'chip fijo';
    var bo = document.createElement('button'); bo.type = 'button'; bo.textContent = 'Otros';
    bo.setAttribute('aria-pressed', 'true'); bo.setAttribute('aria-disabled', 'true');
    bo.setAttribute('aria-label', 'Otros (siempre incluida)');
    f.appendChild(bo); box.appendChild(f);
  }
  function agregarCat() {
    var inp = $('nuevaCat');
    var c = inp.value.replace(/\s+/g, ' ').trim();
    if (!c) return error(3, 'Escribí el nombre de la categoría.', inp);
    if (c.length > 30) return error(3, 'Máximo 30 letras.', inp);
    if (norm(c) === 'otros') return error(3, '"Otros" ya está siempre.', inp);
    var ya = SUGERIDAS.concat(st.extra).filter(function (s) { return norm(s) === norm(c); })[0];
    if (ya) {
      if (!st.cats.some(function (x) { return norm(x) === norm(ya); })) st.cats.push(ya);
    } else { st.extra.push(c); st.cats.push(c); }
    inp.value = ''; error(3, '');
    pintarChips(); inp.focus(); anunciar('Agregaste ' + (ya || c) + '.');
  }
  $('agregarCat').addEventListener('click', agregarCat);
  $('nuevaCat').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); agregarCat(); }
    else if (ev.key === 'Escape' && this.value) { ev.preventDefault(); this.value = ''; }
  });
  function categorias() { return st.cats.concat(['Otros']); }
  function validar3() {
    if (categorias().length > MAX_CATS) return { msg: 'Son demasiadas: máximo ' + MAX_CATS + ' categorías contando "Otros".' };
    return null;
  }

  // ---- Paso 4 ----
  var cbRap = $('modRapidos'); cbRap.checked = st.rapidos;
  cbRap.addEventListener('change', function () { st.rapidos = cbRap.checked; pintarResumen(); });
  var NOMBRES_PAIS = {};
  Array.prototype.forEach.call(selPais.options, function (o) { NOMBRES_PAIS[o.value] = o.textContent; });
  function pintarResumen() {
    var dl = $('resumen'); dl.textContent = '';
    [['País', NOMBRES_PAIS[st.pais] || st.pais], ['Moneda', st.moneda + (st.moneda === 'USD' ? '' : ' + USD')], ['Zona horaria', st.tz],
     ['Medios', medios().join(', ')], ['Categorías', categorias().join(', ')],
     ['Accesos rápidos', st.rapidos ? 'Sí' : 'No']].forEach(function (p) {
      var dt = document.createElement('dt'); dt.textContent = p[0];
      var dd = document.createElement('dd'); dd.textContent = p[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
  }

  // ---- Navegación ----
  var paso = 1;
  var VALIDAR = { 1: validar1, 2: validar2, 3: validar3 };
  function anunciar(t) { $('estado').textContent = t; }
  function error(n, msg, el) {
    var box = $('err' + n);
    box.textContent = msg || ''; box.hidden = !msg;
    if (msg && el) el.focus();
    return false;
  }
  function ir(n) {
    paso = n;
    Array.prototype.forEach.call(document.querySelectorAll('section[data-paso]'), function (s) {
      s.hidden = Number(s.getAttribute('data-paso')) !== n;
    });
    Array.prototype.forEach.call(document.querySelectorAll('#pasos li'), function (li) {
      var k = Number(li.getAttribute('data-n'));
      if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      li.classList.toggle('hecho', k < n);
    });
    $('atras').hidden = n === 1;
    $('siguiente').textContent = n === 4 ? 'Guardar' : 'Siguiente';
    if (n === 2) { pintarStd(); pintarNombradas(); }
    if (n === 3) pintarChips();
    if (n === 4) pintarResumen();
    anunciar('Paso ' + n + ' de 4.');
    $('t' + n).focus();
    window.scrollTo(0, 0);
  }
  $('atras').addEventListener('click', function () { if (paso > 1) ir(paso - 1); });
  $('wiz').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (paso < 4) {
      var e = VALIDAR[paso]();
      if (e) return error(paso, e.msg, e.el);
      error(paso, '');
      return ir(paso + 1);
    }
    guardar();
  });

  var guardando = false;
  function guardar() {
    if (guardando) return;
    for (var n = 1; n <= 3; n++) {
      var e = VALIDAR[n]();
      if (e) { ir(n); return error(n, e.msg, e.el); }
    }
    var modulos = {};
    for (var k in INI.modulos) if (Object.prototype.hasOwnProperty.call(INI.modulos, k)) modulos[k] = INI.modulos[k];
    modulos.accesosRapidos = st.rapidos;
    var body = { pais: st.pais, moneda: st.moneda, tz: st.tz, medios: medios(), categorias: categorias(), modulos: modulos };
    var b = $('siguiente');
    guardando = true; b.disabled = true; $('atras').disabled = true;
    error(4, ''); anunciar('Guardando…');
    fetch('/api/config', {
      method: 'POST', credentials: 'same-origin', referrerPolicy: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { r: r, j: j }; });
    }).then(function (x) {
      if (x.r.ok && x.j && x.j.ok) { anunciar('Guardado. Entrando…'); location.assign('/app'); return; }
      if (x.r.status === 401) throw new Error('Se venció la sesión. Volvé a entrar y probá de nuevo.');
      throw new Error((x.j && x.j.error) || ('No se pudo guardar (error ' + x.r.status + ').'));
    }).catch(function (err) {
      guardando = false; b.disabled = false; $('atras').disabled = false;
      anunciar('');
      var msg = err && err.message && !/fetch|network/i.test(err.message) ? err.message : 'No hay conexión. Probá de nuevo.';
      error(4, msg); b.focus();
    });
  }

  // ---- Salir ----
  $('salir').addEventListener('click', function () {
    var b = this; b.disabled = true;
    fetch('/logout', {
      method: 'POST', credentials: 'same-origin', referrerPolicy: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(function (r) {
      if (r.ok || r.redirected) location.assign('/login'); else throw new Error();
    }).catch(function () { b.disabled = false; anunciar('No se pudo cerrar la sesión. Probá de nuevo.'); });
  });

  ir(1);
  window.scrollTo(0, 0);
})();
`;
