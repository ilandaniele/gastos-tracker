// Web Push sin payload (RFC 8030 + VAPID).
//
// Se manda un push VACÍO a propósito: el service worker recibe el aviso y él
// mismo le pregunta al servidor qué falta. Mandar el texto adentro del push
// obligaría a cifrarlo (RFC 8291: ECDH + HKDF + AES128GCM), que es la parte
// más frágil de todo esto. Sin payload alcanza con firmar el JWT de VAPID.

const enc = new TextEncoder();

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importVapidKey(jwkStr) {
  const jwk = typeof jwkStr === 'string' ? JSON.parse(jwkStr) : jwkStr;
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

// JWT ES256. La firma que devuelve WebCrypto ya viene como r||s, que es
// exactamente lo que pide JWS: no hay que desarmar ningún DER.
async function vapidJwt(audience, subject, privateJwk) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  })));
  const key = await importVapidKey(privateJwk);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload));
  return header + '.' + payload + '.' + b64url(sig);
}

// Devuelve { ok, status, gone } — gone significa que el navegador ya no tiene
// esa suscripción y hay que borrarla.
export async function sendPush(subscription, env) {
  const url = new URL(subscription.endpoint);
  const jwt = await vapidJwt(url.origin, 'mailto:' + (env.VAPID_SUBJECT || 'ilan.daniele@gmail.com'), env.VAPID_PRIVATE_JWK);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY,
      'TTL': '3600',
      'Urgency': 'high',
      'Content-Length': '0'
    }
  });

  return { ok: res.status >= 200 && res.status < 300, status: res.status,
           gone: res.status === 404 || res.status === 410 };
}
