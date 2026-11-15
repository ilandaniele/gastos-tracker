// Arma src/form.generated.html a partir del formulario de Apps Script (apps-script/form*.html):
// resuelve los include() y agrega el adaptador que convierte google.script.run en
// fetch('/api/rpc/<función>'). Las variables dinámicas (<?!= x ?> / <?= x ?>) quedan
// para que el Worker las complete en cada pedido (ver src/form.js).
// Correr cada vez que cambie el formulario:  node scripts/build-form.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const dir = join(aqui, '..', '..', 'apps-script');
import { cssOscuro } from './dark-css.mjs';
const leerCrudo = (n) => readFileSync(join(dir, n + '.html'), 'utf8');
// La hoja de estilos sale con su versión oscura agregada al final (DARK_FORCE=1 la fuerza siempre, solo para probar).
const leer = (n) => {
  const t = leerCrudo(n);
  if (n !== 'form-styles') return t;
  const i = t.lastIndexOf('</style>');
  if (i < 0) throw new Error('form-styles sin </style>');
  return t.slice(0, i) + cssOscuro(t, { forzar: process.env.DARK_FORCE === '1' }) + t.slice(i);
};

const shim = `<script>
// Adaptador: mismo contrato que google.script.run de Apps Script, contra el Worker.
// Cada eslabón de la cadena devuelve un runner nuevo (como en Apps Script).
(function () {
  // Pedidos en vuelo. El corte por tiempo NO depende solo de setTimeout: en el celular, con la pestaña en segundo plano o
  // al volver de otra app, los timers se pausan y un fetch puede quedar colgado sin resolverse ni fallar nunca, y el
  // formulario se queda bloqueado en "Guardando...". Por eso un vigía compara la hora real (Date.now) al volver a la
  // pestaña, al recuperar la red y cada 2 s.
  var enVuelo = [];
  function vencer(p) {
    if (p.listo) return;
    p.listo = true;
    var i = enVuelo.indexOf(p); if (i >= 0) enVuelo.splice(i, 1);
    clearTimeout(p.reloj);
    try { if (p.ctl) p.ctl.abort(); } catch (_) {}
    var err = new Error('Tardó demasiado. Revisá tu conexión y mirá si el movimiento quedó guardado antes de repetirlo.');
    if (p.fail) p.fail(err, p.user); else console.error('rpc ' + p.nombre, err);
  }
  function vigilar() {
    var ahora = Date.now();
    enVuelo.slice().forEach(function (p) { if (ahora - p.t0 >= p.limite) vencer(p); });
  }
  setInterval(vigilar, 2000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) vigilar(); });
  window.addEventListener('pageshow', vigilar);
  window.addEventListener('online', vigilar);

  function runner(ok, fail, user) {
    return new Proxy({}, {
      get: function (_, nombre) {
        if (nombre === 'withSuccessHandler') return function (f) { return runner(f, fail, user); };
        if (nombre === 'withFailureHandler') return function (f) { return runner(ok, f, user); };
        if (nombre === 'withUserObject') return function (u) { return runner(ok, fail, u); };
        if (typeof nombre !== 'string' || nombre === 'then') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          // Escanear un ticket con Gemini es lo más lento: tiene más margen. window.__rpcLimiteMs solo lo usan las pruebas.
          var limite = typeof window.__rpcLimiteMs === 'number' ? window.__rpcLimiteMs : (nombre === 'scanTicket' ? 90000 : 25000);
          var ctl = typeof AbortController === 'function' ? new AbortController() : null;
          var p = { nombre: nombre, ok: ok, fail: fail, user: user, ctl: ctl, t0: Date.now(), limite: limite, listo: false, reloj: null };
          p.reloj = setTimeout(function () { vencer(p); }, limite);
          enVuelo.push(p);
          function terminar() {
            var i = enVuelo.indexOf(p); if (i >= 0) enVuelo.splice(i, 1);
            clearTimeout(p.reloj);
          }
          fetch('/api/rpc/' + encodeURIComponent(nombre), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: args }),
            signal: ctl ? ctl.signal : undefined
          }).then(function (r) { return r.json(); }).then(function (r) {
            if (p.listo) return; // ya se dio por vencido: el formulario se desbloqueó con un aviso, no se pisa
            p.listo = true; terminar();
            // Si el handler de éxito tira, NO se llama al de error: el pedido salió bien y avisar de un fallo invita a repetirlo.
            try { if (ok) ok(r, user); } catch (e) { console.error('rpc ' + nombre + ' (handler)', e); }
          }, function (e) {
            if (p.listo) return;
            p.listo = true; terminar();
            var err = e && e.message ? e : new Error(String(e));
            if (fail) fail(err, user);
            else console.error('rpc ' + nombre, e);
          });
        };
      }
    });
  }
  window.google = { script: { run: runner(null, null, undefined) } };
})();
</script>`;

let html = leer('form');
html = html.replace(/<\?!=\s*include\('([^']+)'\)\s*\?>/g, (_, n) => (n === 'form-scripts' ? shim + '\n' : '') + leer(n));
// Apps Script agrega este meta con addMetaTag (Code.gs); acá tiene que ir en el propio HTML,
// si no el celular renderiza a 980px de ancho.
if (!/name=["']viewport["']/.test(html)) html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">');
writeFileSync(join(aqui, '..', 'src', 'form.generated.html'), html);
console.log('form.generated.html', Math.round(html.length / 1024) + ' KB');
