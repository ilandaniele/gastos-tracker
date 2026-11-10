// Importa el volcado de Apps Script (?action=exportAll) a D1.
//
//   node scripts/import.mjs --fetch            baja el volcado (usa APPS_SCRIPT_URL y APP_KEY del entorno)
//   node scripts/import.mjs --file export.json usa un volcado ya bajado
//   --parcial   con --fetch: solo mes actual y anterior (lo mismo que hace el cron del Worker)
//   --save f    guarda el volcado crudo en f (queda fuera de git: *.export.json)
//   --apply     lo ejecuta contra D1 remoto; sin eso solo genera el SQL
//
// Es repetible: borra lo del tenant y vuelve a cargar, así importar dos veces no
// duplica nada. Mientras Apps Script siga siendo la fuente de verdad se puede correr
// las veces que haga falta. La lógica de armado del SQL vive en src/sync.js (la
// comparte con el cron del Worker).
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildStatements } from '../src/sync.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

async function load() {
  if (val('--file')) return JSON.parse(readFileSync(val('--file'), 'utf8'));
  if (!flag('--fetch')) throw new Error('Usar --fetch o --file <export.json>');
  const base = process.env.APPS_SCRIPT_URL, k = process.env.APP_KEY;
  if (!base || !k) throw new Error('Faltan APPS_SCRIPT_URL y APP_KEY en el entorno');
  const u = new URL(base);
  u.searchParams.set('action', 'exportAll');
  u.searchParams.set('k', k);
  if (flag('--parcial')) u.searchParams.set('parcial', '1');
  const r = await fetch(u, { redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('Respuesta no es JSON (¿clave mala?): ' + text.slice(0, 120)); }
}

const data = await load();
if (!data.ok) throw new Error('El volcado dijo: ' + (data.error || JSON.stringify(data).slice(0, 200)));
if (data.errores && data.errores.length) console.warn('Avisos del volcado:', data.errores);
if (val('--save')) writeFileSync(val('--save'), JSON.stringify(data));
const { statements, counts } = buildStatements(data);
const outFile = val('--out') || join(here, 'import.generated.sql');
writeFileSync(outFile, statements.map((s) => s + ';').join('\n') + '\n');
console.log('SQL generado:', outFile, counts);
if (flag('--apply')) {
  const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(wrangler, ['--yes', 'wrangler@4', 'd1', 'execute', 'gastos-db', '--remote', '--file', outFile],
    { cwd: join(here, '..'), stdio: 'inherit', shell: process.platform === 'win32' });
  console.log('Aplicado a D1.');
}
