// Genera src/iconos.generated.js (iconos de la PWA en base64) a partir de los de pwa/src.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const aqui = dirname(fileURLToPath(import.meta.url));
const b64 = (n) => readFileSync(join(aqui, '..', '..', 'pwa', 'src', n)).toString('base64');
writeFileSync(join(aqui, '..', 'src', 'iconos.generated.js'),
  '// Generado por scripts/gen-iconos.mjs. No editar.\n' +
  `export const ICONO_192 = '${b64('icon-192.png')}';\nexport const ICONO_512 = '${b64('icon-512.png')}';\n`);
console.log('ok');
