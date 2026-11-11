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
const leer = (n) => readFileSync(join(dir, n + '.html'), 'utf8');

const shim = `<script>
// Adaptador: mismo contrato que google.script.run de Apps Script, contra el Worker.
// Cada eslabón de la cadena devuelve un runner nuevo (como en Apps Script).
(function () {
  function runner(ok, fail, user) {
    return new Proxy({}, {
      get: function (_, nombre) {
        if (nombre === 'withSuccessHandler') return function (f) { return runner(f, fail, user); };
        if (nombre === 'withFailureHandler') return function (f) { return runner(ok, f, user); };
        if (nombre === 'withUserObject') return function (u) { return runner(ok, fail, u); };
        if (typeof nombre !== 'string' || nombre === 'then') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/api/rpc/' + encodeURIComponent(nombre), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: args })
          }).then(function (r) { return r.json(); }).then(function (r) {
            if (ok) ok(r, user);
          }).catch(function (e) {
            if (fail) fail(e && e.message ? e : new Error(String(e)), user);
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
writeFileSync(join(aqui, '..', 'src', 'form.generated.html'), html);
console.log('form.generated.html', Math.round(html.length / 1024) + ' KB');
