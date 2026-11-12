// Cuentas propias (multi-tenant): login por magic link y sesiones por cookie.
//
// - Del token del mail y del sid de la cookie solo se guarda el hash SHA-256 (hex) en D1.
// - Un mail nuevo que canjea un link crea su tenant ('t_' + 12 hex): el login es también el alta.
// - pedirLink responde igual exista o no el mail (anti-enumeración) y no filtra el link
//   (salvo con la variable de DEV DEV_MOSTRAR_LINK=1, que NUNCA va en wrangler.toml).
// - Cuota de D1: pedirLink = 1 lectura + 1 batch de escritura; canjearLink = 2 llamadas;
//   tenantDeSesion = 1 consulta con JOIN (y ninguna si no hay cookie sid).
import { enviarMail, hayResend } from './mail.js';

const SESION_SEG = 30 * 24 * 3600;
const LINK_SEG = 15 * 60;
const MAX_POR_MAIL = 5;   // pedidos por hora y por mail
const MAX_POR_IP = 20;    // pedidos por hora y por IP
const VENTANA_SEG = 3600;
const PURGA_SEG = 2 * 3600;

const ahoraSeg = () => Math.floor(Date.now() / 1000);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const aleatorio = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
export const esHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export const normalizarMail = (m) => String(m || '').trim().toLowerCase();
export function mailValido(m) {
  return m.length <= 254 && /^[^\s@<>",;:\\()[\]]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(m);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function htmlMail(link) {
  return '<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1c1a">'
    + '<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">'
    + '<h1 style="font-size:20px;margin:0 0 12px">Entrá a Gastos</h1>'
    + '<p style="font-size:15px;line-height:1.5;margin:0 0 20px">Tocá el botón para entrar. El link sirve una sola vez y vence en 15 minutos.</p>'
    + '<p style="margin:0 0 20px"><a href="' + esc(link) + '" style="display:inline-block;background:#1f6f54;color:#fff;text-decoration:none;font-weight:600;padding:14px 22px;border-radius:10px">Entrar</a></p>'
    + '<p style="font-size:13px;line-height:1.5;color:#666;margin:0">Si no lo pediste vos, ignorá este mail: nadie puede entrar sin el link.</p>'
    + '</div></body></html>';
}

// Respuesta única de pedirLink cuando el mail es válido, exista o no la cuenta.
const RESPUESTA_OK = { ok: true, mensaje: 'Si el mail es válido, te mandamos un link para entrar. Revisá tu bandeja (y el spam).' };

// origin: base para armar el link (env.APP_URL si está, para no depender del Host del request).
export async function pedirLink(env, email, origin, ip) {
  const mail = normalizarMail(email);
  if (!mailValido(mail)) return { ok: false, status: 400, error: 'Ese mail no parece válido.' };
  const ahora = ahoraSeg();
  const ipv = String(ip || '').slice(0, 64);

  // Pedidos de la última hora: expira = creado + 15 min, así que "creado > ahora - 1h" es "expira > ahora - 45 min".
  const desde = ahora - (VENTANA_SEG - LINK_SEG);
  const c = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM login_tokens WHERE email = ?1 AND expira > ?3) AS por_mail,
            (SELECT COUNT(*) FROM login_tokens WHERE ip = ?2 AND ?2 <> '' AND expira > ?3) AS por_ip`)
    .bind(mail, ipv, desde).first();
  if (c.por_mail >= MAX_POR_MAIL || c.por_ip >= MAX_POR_IP) {
    return { ok: false, status: 429, error: 'Pediste muchos links seguidos. Probá de nuevo en un rato.' };
  }

  const token = aleatorio(32);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_tokens WHERE expira < ?`).bind(ahora - PURGA_SEG),
    env.DB.prepare(`INSERT INTO login_tokens (token_hash, email, expira, usado, ip) VALUES (?, ?, ?, 0, ?)`)
      .bind(await sha256(token), mail, ahora + LINK_SEG, ipv)
  ]);

  const link = String(origin).replace(/\/+$/, '') + '/auth/' + token;
  if (hayResend(env)) {
    try {
      const r = await enviarMail(env, [mail], 'Tu link para entrar a Gastos', htmlMail(link));
      if (!r.ok) console.error('login: mail no enviado:', r.error);
    } catch (e) { console.error('login: mail no enviado:', String(e && e.message || e)); }
  }
  // Solo para desarrollo local: el único lugar donde el link sale del mail.
  if (env.DEV_MOSTRAR_LINK === '1') return { ...RESPUESTA_OK, dev_link: link };
  return RESPUESTA_OK;
}

// Un solo uso y atómico: el UPDATE ... WHERE usado = 0 decide quién gana si llegan dos a la vez.
// Devuelve { ok:true, sid, tenant, nuevo } o { ok:false }.
export async function canjearLink(env, token, ua) {
  if (!esHex64(token)) return { ok: false };
  const ahora = ahoraSeg();
  const r = await env.DB.prepare(
    `UPDATE login_tokens SET usado = 1 WHERE token_hash = ? AND usado = 0 AND expira > ? RETURNING email`)
    .bind(await sha256(token), ahora).all();
  const fila = r.results && r.results[0];
  if (!r.meta.changes || !fila) return { ok: false };
  return abrirSesion(env, fila.email, ua);
}

// Mail ya verificado (por link o por Google): tenant existente por mail o tenant nuevo, y sesión nueva.
// Una sola batch. Devuelve { ok:true, sid, tenant, nuevo } o { ok:false }.
async function abrirSesion(env, email, ua) {
  const ahora = ahoraSeg();
  const fila = { email };
  const sid = aleatorio(32);
  const idNuevo = 't_' + aleatorio(6);
  const [alta, , dueno] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, email, creado, onboarding_listo) VALUES (?, ?, ?, 0)`)
      .bind(idNuevo, fila.email, new Date().toISOString()),
    env.DB.prepare(`INSERT INTO sesiones (sid_hash, tenant_id, creado, expira, ua)
                    SELECT ?, id, ?, ?, ? FROM tenants WHERE email = ?`)
      .bind(await sha256(sid), ahora, ahora + SESION_SEG, String(ua || '').slice(0, 200), fila.email),
    env.DB.prepare(`SELECT id FROM tenants WHERE email = ?`).bind(fila.email),
    env.DB.prepare(`DELETE FROM sesiones WHERE expira < ?`).bind(ahora) // purga de sesiones vencidas
  ]);
  const tenant = dueno.results[0] && dueno.results[0].id;
  if (!tenant) return { ok: false };
  return { ok: true, sid, tenant, nuevo: alta.meta.changes > 0 };
}

// --- Continuar con Google (OAuth 2.0, authorization code + PKCE) -----------------------------
// Solo se activa con GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (secretos del Worker).
// state + code_verifier viajan en la cookie gstate (HttpOnly, Path=/auth/google, 10 min), firmada con
// HMAC-SHA256 usando el client secret: sin escrituras extra en D1. GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL
// existen solo para tests locales con un mock (NUNCA van en wrangler.toml).
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GSTATE_SEG = 600;
export const googleConfigurado = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const cookieGstateBorrada = 'gstate=; Path=/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)));
};
async function hmacHex(clave, texto) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(texto))));
}
function igualConstante(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// -> { location, cookie }
export async function googleInicio(env, base) {
  const state = aleatorio(32);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const reto = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const ts = String(ahoraSeg());
  const firma = await hmacHex(env.GOOGLE_CLIENT_SECRET, state + '.' + verifier + '.' + ts);
  const u = new URL(env.GOOGLE_AUTH_URL || GOOGLE_AUTH);
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', String(base).replace(/\/+$/, '') + '/auth/google/callback');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', reto);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  return {
    location: u.toString(),
    cookie: `gstate=${state}.${verifier}.${ts}.${firma}; Path=/auth/google; Max-Age=${GSTATE_SEG}; HttpOnly; Secure; SameSite=Lax`
  };
}

const MSG_GOOGLE = 'No pudimos entrar con Google. Probá de nuevo o usá tu mail.';

// Vuelta de Google. -> { ok:true, sid, tenant, nuevo } o { ok:false, error }. Nunca devuelve detalles de Google.
export async function googleCallback(env, req, url, base, ua) {
  const fallo = (motivo) => { console.error('google login:', motivo); return { ok: false, error: MSG_GOOGLE }; };
  if (url.searchParams.get('error')) return { ok: false, error: 'Cancelaste el ingreso con Google. Si querés, probá de nuevo.' };
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const partes = leerCookie(req, 'gstate').split('.');
  if (partes.length !== 4 || !code || !state) return fallo('falta state/cookie/code');
  const [cState, verifier, ts, firma] = partes;
  const esperada = await hmacHex(env.GOOGLE_CLIENT_SECRET, cState + '.' + verifier + '.' + ts);
  const okFirma = igualConstante(firma, esperada);
  const okState = igualConstante(state, cState);
  if (!okFirma || !okState) return fallo('state o firma inválidos');
  if (!/^[0-9a-f]{64}$/.test(cState) || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) return fallo('cookie mal formada');
  if (ahoraSeg() - Number(ts) > GSTATE_SEG || ahoraSeg() < Number(ts) - 60) return fallo('cookie vencida');

  let tok;
  try {
    const r = await fetch(env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code_verifier: verifier,
        redirect_uri: String(base).replace(/\/+$/, '') + '/auth/google/callback', grant_type: 'authorization_code'
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return fallo('token endpoint HTTP ' + r.status);
    tok = await r.json();
  } catch (e) { return fallo('token endpoint: ' + String(e && e.message || e)); }

  // El id_token llega directo del endpoint de token por TLS: alcanza con leer y chequear los claims.
  let c;
  try {
    const p = String(tok.id_token || '').split('.');
    if (p.length !== 3) return fallo('id_token ausente o mal formado');
    c = JSON.parse(deB64url(p[1]));
  } catch { return fallo('id_token ilegible'); }
  if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') return fallo('iss incorrecto');
  if (c.aud !== env.GOOGLE_CLIENT_ID) return fallo('aud incorrecto');
  if (typeof c.exp !== 'number' || c.exp <= ahoraSeg()) return fallo('id_token vencido');
  if (c.email_verified !== true) return fallo('email no verificado');
  const mail = normalizarMail(c.email);
  if (!mailValido(mail)) return fallo('email ausente o inválido');

  const s = await abrirSesion(env, mail, ua);
  if (!s.ok) return fallo('no se pudo abrir la sesión');
  return s;
}

function leerCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : '';
}

// Cookie de sesión: HttpOnly (el JS de la página no la lee), Secure y Lax (viaja al entrar desde el link del mail).
export const cookieSesion = (sid) => `sid=${sid}; Path=/; Max-Age=${SESION_SEG}; HttpOnly; Secure; SameSite=Lax`;
export const cookieSesionBorrada = 'sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

// Una consulta (sesión + tenant con JOIN). Sin cookie sid no toca D1.
// -> { id, email, onboarding_listo, pais, moneda, tz, config } | null (las últimas 4 arman la cfg: src/tenantcfg.js)
export async function tenantDeSesion(env, req) {
  const sid = leerCookie(req, 'sid');
  if (!esHex64(sid)) return null;
  const r = await env.DB.prepare(
    `SELECT t.id AS id, t.email AS email, t.onboarding_listo AS onboarding_listo, t.pais AS pais, t.moneda AS moneda, t.tz AS tz, t.config AS config
     FROM sesiones s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.sid_hash = ? AND s.expira > ?`).bind(await sha256(sid), ahoraSeg()).first();
  return r || null;
}

// Borra la sesión de la cookie (si la hay). Quien llama manda el Set-Cookie con cookieSesionBorrada.
export async function cerrarSesion(env, req) {
  const sid = leerCookie(req, 'sid');
  if (!esHex64(sid)) return;
  await env.DB.prepare(`DELETE FROM sesiones WHERE sid_hash = ?`).bind(await sha256(sid)).run();
}

// --- página de login ---------------------------------------------------------------------------
// Sin scripts: el formulario es un POST común. CSP estricta, sin nada de terceros.
export const CSP_LOGIN = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// Página intermedia del link: el GET no gasta el token (los escáneres de mail y los prefetch
// hacen GET); el canje real es el POST de este botón. token ya viene validado como 64 hex.
export function paginaConfirmar(token) {
  return paginaBase('Entrar · Gastos', `<h1>Entrá a Gastos</h1>
<p class="sub">Tocá el botón para terminar de entrar en este dispositivo.</p>
<form method="post" action="/auth/${esc(token)}">
<button type="submit">Entrar</button>
</form>
<p class="pie">Si no pediste este link, cerrá esta página: no pasa nada.</p>`);
}

// rel="noreferrer": es una navegación saliente a Google, no se le manda nuestra URL.
const BOTON_GOOGLE = `<a class="g" href="/auth/google" rel="noreferrer"><svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg><span>Continuar con Google</span></a>
<p class="o"><span>o</span></p>
`;

// aviso: { tipo: 'ok' | 'error', texto, link? }
export function paginaLogin(aviso, mail, google) {
  const caja = aviso
    ? '<p class="aviso ' + (aviso.tipo === 'error' ? 'err' : 'ok') + '" role="status">' + esc(aviso.texto) + '</p>'
      + (aviso.link ? '<p class="dev">DEV: <a href="' + esc(aviso.link) + '">' + esc(aviso.link) + '</a></p>' : '')
    : '';
  return paginaBase('Entrar · Gastos', `<h1>Entrá a Gastos</h1>
<p class="sub">Sin contraseña: ${google ? 'entrá con Google o te mandamos un link por mail.' : 'te mandamos un link por mail.'}</p>
${caja}
${google ? BOTON_GOOGLE : ''}<form method="post" action="/login">
<label for="email">Tu mail</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254" placeholder="vos@ejemplo.com" value="${esc(mail || '')}">
<button type="submit">Mandarme el link</button>
</form>
<p class="pie">Si es tu primera vez, te creamos la cuenta al entrar.</p>`);
}

// --- páginas legales (públicas, indexables: Google las revisa para la pantalla de consentimiento) ---
const LEGAL = {
  privacidad: { titulo: 'Política de privacidad · Gastos', cuerpo: (c) => `<h1>Política de privacidad</h1>
<p class="sub">Última actualización: noviembre de 2026.</p>
<h2>Qué es Gastos</h2>
<p>Gastos es una app para registrar y ver tus gastos, ingresos, ahorros, compras y tareas personales. El servicio lo presta su titular a título personal desde Uruguay.</p>
<h2>Qué datos guardamos</h2>
<ul>
<li>Tu mail, para identificar tu cuenta y mandarte el link de acceso.</li>
<li>Lo que cargás en la app: gastos, ingresos, ahorros, compras, tareas y hábitos, y la configuración de tu cuenta (país, moneda, zona horaria, medios de pago y categorías).</li>
<li>Si usás “Continuar con Google”, solo recibimos tu mail verificado. No accedemos a tus archivos, contactos ni a ningún otro dato de tu cuenta de Google.</li>
<li>Una cookie de sesión, necesaria para mantenerte adentro. No usamos cookies de publicidad ni de seguimiento, ni herramientas de analítica de terceros.</li>
<li>Datos técnicos mínimos de funcionamiento (por ejemplo, un contador de escaneos diarios por cuenta para evitar abusos).</li>
</ul>
<h2>Para qué los usamos</h2>
<p>Solo para que la app funcione: mostrarte tus datos, mandarte el link de acceso y, si lo activás, avisos y reportes por mail. No vendemos tus datos, no los usamos para publicidad ni para entrenar modelos propios, y no los compartimos con terceros con fines comerciales.</p>
<h2>Con quién se procesan</h2>
<ul>
<li>Cloudflare: aloja la app y la base de datos.</li>
<li>Resend: envía los mails de acceso y los reportes.</li>
<li>Google: si usás el escaneo de tickets o de comidas con IA, la foto se envía a Google (Gemini) para leerla. No guardamos la imagen en nuestra base; guardamos solo el resultado que confirmás.</li>
</ul>
<p>Estos proveedores pueden procesar datos fuera de tu país. Los usamos porque ofrecen medidas de seguridad adecuadas.</p>
<h2>Cuánto tiempo los guardamos</h2>
<p>Mientras tu cuenta esté activa. Si pedís el borrado, eliminamos tu cuenta y todo lo que cargaste; los respaldos técnicos se vacían en un plazo razonable.</p>
<h2>Tus derechos</h2>
<p>Podés pedir acceso, copia, corrección o borrado de tus datos en cualquier momento. Aplicamos la Ley 18.331 de Uruguay de protección de datos personales y, cuando corresponda según tu país, tus derechos equivalentes bajo la normativa local. ${c ? 'Escribinos a <a href="mailto:' + esc(c) + '">' + esc(c) + '</a>.' : 'Escribinos respondiendo desde el mail de tu cuenta.'}</p>
<h2>Seguridad</h2>
<p>El acceso es por link de un solo uso o Google, sin contraseñas que filtrar. Cada cuenta ve solo sus propios datos. Ningún sistema es infalible: si hubiera un incidente que te afecte, te avisaremos.</p>
<h2>Menores</h2>
<p>El servicio es para personas de 18 años o más.</p>
<h2>Cambios</h2>
<p>Si cambia algo importante, actualizamos esta página y la fecha de arriba.</p>` },
  terminos: { titulo: 'Términos del servicio · Gastos', cuerpo: (c) => `<h1>Términos del servicio</h1>
<p class="sub">Última actualización: noviembre de 2026.</p>
<h2>El servicio</h2>
<p>Gastos es una herramienta personal para llevar tus finanzas. Se ofrece tal cual está, sin garantía de disponibilidad continua ni de que los resultados (incluidos los del escaneo con IA o las conversiones de moneda) sean exactos: revisalos antes de confiar en ellos. No es asesoramiento financiero, contable ni impositivo.</p>
<h2>Tu cuenta</h2>
<p>Entrás con tu mail o con Google. Sos responsable de lo que pase con tu sesión y de la veracidad de lo que cargás. Tenés que tener 18 años o más.</p>
<h2>Uso aceptable</h2>
<p>No uses el servicio para abusar de él, sobrecargarlo, automatizar accesos masivos ni acceder a datos de otras personas. El escaneo con IA tiene un límite diario por cuenta. Podemos suspender cuentas que incumplan estas reglas.</p>
<h2>Tus datos</h2>
<p>Los datos que cargás son tuyos. Podés pedir que los borremos. Ver la <a href="/privacidad">política de privacidad</a>.</p>
<h2>Precio</h2>
<p>Por ahora el servicio es gratuito. Si en el futuro hubiera planes pagos, lo avisaremos antes y no se te cobrará nada sin tu aceptación.</p>
<h2>Responsabilidad</h2>
<p>En la medida que la ley lo permita, no respondemos por pérdidas indirectas ni por decisiones que tomes en base a la información de la app. Te recomendamos llevar tus propios respaldos de lo importante.</p>
<h2>Cambios y baja</h2>
<p>Podemos modificar o discontinuar el servicio, avisando con anticipación razonable cuando sea posible. Estos términos se rigen por las leyes de Uruguay, sin perjuicio de los derechos que te reconozca como consumidor la ley de tu país. ${c ? 'Contacto: <a href="mailto:' + esc(c) + '">' + esc(c) + '</a>.' : ''}</p>` }
};

// Devuelve la página legal ('privacidad' | 'terminos') o null.
export function paginaLegal(clave, contacto) {
  const p = Object.prototype.hasOwnProperty.call(LEGAL, clave) ? LEGAL[clave] : null;
  return p ? paginaBase(p.titulo, p.cuerpo(contacto), true) : null;
}

function paginaBase(titulo, cuerpo, indexable) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
${indexable ? '' : '<meta name="robots" content="noindex">'}
<title>${titulo}</title>
<style>
:root{--bg:#f4f4f2;--card:#fff;--ink:#1c1c1a;--mut:#6b6b66;--line:#d9d9d3;--acc:#1f6f54;--acc-ink:#fff;--okbg:#e4f3ec;--errbg:#fbe9e7;--errink:#a3281b;--gbg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121413;--card:#1c1f1d;--ink:#ecece8;--mut:#9a9a93;--line:#34383a;--acc:#4cb68f;--acc-ink:#0c1511;--okbg:#17302a;--errbg:#3a1f1c;--errink:#ff9d90;--gbg:#131314}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 22px}
h1{font-size:24px;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
p.sub{margin:0 0 22px;color:var(--mut)}
label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}
input[type=email]{width:100%;height:48px;padding:0 14px;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:12px}
input[type=email]:focus{outline:2px solid var(--acc);outline-offset:1px;border-color:transparent}
button{width:100%;height:48px;margin-top:14px;font:inherit;font-weight:600;color:var(--acc-ink);background:var(--acc);border:0;border-radius:12px;cursor:pointer}
button:active{transform:translateY(1px)}
.aviso{margin:0 0 16px;padding:12px 14px;border-radius:12px;font-size:15px}
.aviso.ok{background:var(--okbg)}.aviso.err{background:var(--errbg);color:var(--errink)}
.dev{font-size:12px;word-break:break-all;color:var(--mut)}
a.g{display:flex;align-items:center;justify-content:center;gap:10px;min-height:48px;padding:0 14px;font-weight:600;color:var(--ink);background:var(--gbg);border:1px solid var(--line);border-radius:12px;text-decoration:none}
a.g:active{transform:translateY(1px)}
a.g:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
p.o{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--mut);font-size:13px}
p.o:before,p.o:after{content:"";flex:1;height:1px;background:var(--line)}
.pie{margin:18px 0 0;font-size:13px;color:var(--mut)}
h2{font-size:17px;margin:22px 0 6px}
main p,main li{font-size:15px}
main ul{padding-left:20px;margin:6px 0}
main a:not(.g){color:var(--acc)}
body:has(h2){align-items:flex-start}
body:has(h2) main{max-width:640px}
</style></head>
<body><main>
${cuerpo}
</main></body></html>`;
}
