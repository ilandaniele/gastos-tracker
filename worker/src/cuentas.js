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
export const esHex64 =(s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

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

function leerCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : '';
}

// Cookie de sesión: HttpOnly (el JS de la página no la lee), Secure y Lax (viaja al entrar desde el link del mail).
export const cookieSesion = (sid) => `sid=${sid}; Path=/; Max-Age=${SESION_SEG}; HttpOnly; Secure; SameSite=Lax`;
export const cookieSesionBorrada = 'sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

// Una consulta (sesión + tenant con JOIN). Sin cookie sid no toca D1. -> { id, email, onboarding_listo } | null
export async function tenantDeSesion(env, req) {
  const sid = leerCookie(req, 'sid');
  if (!esHex64(sid)) return null;
  const r = await env.DB.prepare(
    `SELECT t.id AS id, t.email AS email, t.onboarding_listo AS onboarding_listo
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

// aviso: { tipo: 'ok' | 'error', texto, link? }
export function paginaLogin(aviso, mail) {
  const caja = aviso
    ? '<p class="aviso ' + (aviso.tipo === 'error' ? 'err' : 'ok') + '" role="status">' + esc(aviso.texto) + '</p>'
      + (aviso.link ? '<p class="dev">DEV: <a href="' + esc(aviso.link) + '">' + esc(aviso.link) + '</a></p>' : '')
    : '';
  return paginaBase('Entrar · Gastos', `<h1>Entrá a Gastos</h1>
<p class="sub">Sin contraseña: te mandamos un link por mail.</p>
${caja}
<form method="post" action="/login">
<label for="email">Tu mail</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254" placeholder="vos@ejemplo.com" value="${esc(mail || '')}">
<button type="submit">Mandarme el link</button>
</form>
<p class="pie">Si es tu primera vez, te creamos la cuenta al entrar.</p>`);
}

function paginaBase(titulo, cuerpo) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${titulo}</title>
<style>
:root{--bg:#f4f4f2;--card:#fff;--ink:#1c1c1a;--mut:#6b6b66;--line:#d9d9d3;--acc:#1f6f54;--acc-ink:#fff;--okbg:#e4f3ec;--errbg:#fbe9e7;--errink:#a3281b}
@media (prefers-color-scheme:dark){:root{--bg:#121413;--card:#1c1f1d;--ink:#ecece8;--mut:#9a9a93;--line:#34383a;--acc:#4cb68f;--acc-ink:#0c1511;--okbg:#17302a;--errbg:#3a1f1c;--errink:#ff9d90}}
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
.pie{margin:18px 0 0;font-size:13px;color:var(--mut)}
</style></head>
<body><main>
${cuerpo}
</main></body></html>`;
}
