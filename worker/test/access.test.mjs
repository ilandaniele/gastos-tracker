// Prueba de la verificación del JWT de Cloudflare Access con claves RSA generadas acá.
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createSign } from 'node:crypto';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const ini = src.indexOf('let certsCache');
const fin = src.indexOf('async function autorizado');
const TEAM = 'equipo.cloudflareaccess.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otra } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function firmar(payload, key = privateKey, head = { alg: 'RS256', kid: 'k1' }) {
  const data = b64u(head) + '.' + b64u(payload);
  return data + '.' + createSign('RSA-SHA256').update(data).sign(key).toString('base64url');
}
const verificar = new Function('eq', 'cookie', `${src.slice(ini, fin)}; return verificarAccess;`)();
const env = { ACCESS_TEAM: TEAM, ACCESS_AUD: 'aud1', ACCESS_EMAILS: 'yo@x.com' };
const ahora = Math.floor(Date.now() / 1000);
const bueno = { iss: 'https://' + TEAM, aud: ['aud1'], exp: ahora + 600, email: 'yo@x.com' };

assert.ok(await verificar(firmar(bueno), env), 'token válido');
assert.equal(await verificar(firmar({ ...bueno, exp: ahora - 5 }), env), null, 'vencido');
assert.equal(await verificar(firmar({ ...bueno, aud: ['otra'] }), env), null, 'aud ajena');
assert.equal(await verificar(firmar({ ...bueno, iss: 'https://malo.com' }), env), null, 'issuer ajeno');
assert.equal(await verificar(firmar({ ...bueno, email: 'otro@x.com' }), env), null, 'mail no permitido');
assert.equal(await verificar(firmar(bueno, otra), env), null, 'firma de otra clave');
assert.equal(await verificar(firmar(bueno, privateKey, { alg: 'none', kid: 'k1' }), env), null, 'alg none');
assert.equal(await verificar(firmar(bueno, privateKey, { alg: 'RS256', kid: 'zz' }), env), null, 'kid desconocido');
assert.equal(await verificar('a.b', env), null, 'basura');
assert.equal(await verificar('', env), null, 'vacío');
const partes = firmar(bueno).split('.');
assert.equal(await verificar(partes[0] + '.' + b64u({ ...bueno, email: 'yo@x.com', aud: ['aud1'], exp: ahora + 99999 }) + '.' + partes[2], env), null, 'payload alterado');
console.log('access: 11 casos OK');
