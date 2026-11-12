// Verifica que enviarPush firma bien el JWT VAPID (ES256) y manda los headers que piden los push services.
// Uso: node test/vapid.test.mjs <clave privada JWK en archivo> <clave pública base64url>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { enviarPush } from '../src/pushsend.js';

const jwk = fs.readFileSync(process.argv[2], 'utf8');
const pub = process.argv[3];
let visto = null;
const srv = http.createServer((req, res) => { visto = { m: req.method, h: req.headers, url: req.url }; res.statusCode = 201; res.end(); });
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const ep = 'http://127.0.0.1:' + srv.address().port + '/push/abc';
const r = await enviarPush(ep, { VAPID_PRIVATE_JWK: jwk, VAPID_PUBLIC_KEY: pub, CONTACT_EMAIL: 'soporte@ejemplo.com' });
assert.equal(r.ok, true); assert.equal(r.status, 201); assert.equal(r.gone, false);
assert.equal(visto.m, 'POST'); assert.equal(visto.h.ttl, '3600'); assert.equal(visto.h.urgency, 'high');
const m = visto.h.authorization.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=(.+)$/);
assert.ok(m, visto.h.authorization); assert.equal(m[4], pub);
const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());
assert.deepEqual(dec(m[1]), { typ: 'JWT', alg: 'ES256' });
const p = dec(m[2]);
assert.equal(p.aud, 'http://127.0.0.1:' + srv.address().port); assert.equal(p.sub, 'mailto:soporte@ejemplo.com');
assert.ok(p.exp > Date.now() / 1000 && p.exp < Date.now() / 1000 + 13 * 3600);
const key = await crypto.subtle.importKey('raw', Buffer.from(pub, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(m[3], 'base64url'), new TextEncoder().encode(m[1] + '.' + m[2]));
assert.equal(ok, true, 'firma ES256 válida con la clave pública');
assert.equal(Buffer.from(m[3], 'base64url').length, 64, 'firma en formato crudo r||s');
srv.close();
console.log('OK   VAPID: JWT ES256 firmado, verifica con la clave pública');
