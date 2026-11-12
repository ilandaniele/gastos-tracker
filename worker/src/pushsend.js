// Envío de un Web Push sin payload con firma VAPID (RFC 8030 + RFC 8292). Sin dependencias del resto del Worker
// para poder probarlo solo (test/vapid.test.mjs).
const enc = new TextEncoder();
export const MAX_ENDPOINT = 2048;
const HOSTS_PUSH = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]+\.push\.apple\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/
];

export function endpointValido(e) {
  if (typeof e !== 'string' || e.length > MAX_ENDPOINT) return false;
  let u;
  try { u = new URL(e); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && !u.port && HOSTS_PUSH.some((r) => r.test(u.hostname));
}

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function jwtVapid(audience, subject, privateJwk) {
  const jwk = typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk;
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64url(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + p));
  return h + '.' + p + '.' + b64url(sig);
}

// { ok, status, gone }: gone = el navegador ya no tiene la suscripción (404/410) y hay que borrarla.
// PUSH_DEV_SIN_ENVIO=1 (solo tests locales, nunca en wrangler.toml) no sale a internet.
export async function enviarPush(endpoint, env) {
  if (env.PUSH_DEV_SIN_ENVIO) return { ok: true, status: 201, gone: false };
  const url = new URL(endpoint);
  const jwt = await jwtVapid(url.origin, 'mailto:' + (env.CONTACT_EMAIL || 'admin@example.com'), env.VAPID_PRIVATE_JWK);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY, TTL: '3600', Urgency: 'high', 'Content-Length': '0' },
    signal: AbortSignal.timeout(8000)
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}

