// Worker nuevo: visor de gastos sobre D1 (y base de la app que reemplazará a Apps Script).
// Hoy es de SOLO LECTURA: los datos entran por scripts/import.mjs desde el Sheet.
import UI from './ui.html';
import { buildDelta } from './sync.js';
import { renderForm, CSP_FORM } from './form.js';
import { llamar, fuentes, setFuente, MODULOS, RPC_NOMBRES } from './rpc.js';
import { habitPending, tasksPending } from './pending.js';
import { pedirLink, canjearLink, tenantDeSesion, cerrarSesion, cookieSesion, cookieSesionBorrada, paginaLogin, paginaConfirmar, esHex64, CSP_LOGIN } from './cuentas.js';
import { reporteMensualHtml, tareasHoyHtml, enviarInforme, mesPorDefecto, mesValido } from './informes.js';

// Único tenant que sigue atado al Sheet/Apps Script (sync, /api/fuente, informes por mail): el original.
const ILAN = 'ilan';
// Los informes son HTML estático con estilos en línea: sin scripts, sin conexiones, sin embeber.
const CSP_INFORME = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

// --- acceso -----------------------------------------------------------------
// Mientras Cloudflare Access no esté delante, se pide una clave (secreto VIEW_KEY).
// Entra por ?key=... una vez y queda en una cookie. Sin clave configurada se cierra todo.
function eq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function cookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// --- Cloudflare Access -------------------------------------------------------
// El header Cf-Access-Jwt-Assertion lo puede mandar cualquiera: solo vale si la
// firma RS256 verifica contra las claves públicas del team domain y el token
// es para ESTA app (aud), vigente y del emisor esperado.
// Se activa con las variables ACCESS_TEAM (ej. ilandaniele.cloudflareaccess.com)
// y ACCESS_AUD (Application Audience tag de la app de Access). Opcional:
// ACCESS_EMAILS (lista separada por comas) para restringir por mail.
let certsCache = { at: 0, keys: null, team: '' };

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function b64urlJson(s) { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }

async function claves(team) {
  if (certsCache.keys && certsCache.team === team && Date.now() - certsCache.at < 3600_000) return certsCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs ' + r.status);
  const j = await r.json();
  certsCache = { at: Date.now(), keys: j.keys || [], team };
  return certsCache.keys;
}

async function verificarAccess(jwt, env) {
  const partes = String(jwt || '').split('.');
  if (partes.length !== 3) return null;
  try {
    const head = b64urlJson(partes[0]);
    const body = b64urlJson(partes[1]);
    if (head.alg !== 'RS256') return null;
    let jwk = (await claves(env.ACCESS_TEAM)).find((k) => k.kid === head.kid);
    if (!jwk) { certsCache.at = 0; jwk = (await claves(env.ACCESS_TEAM)).find((k) => k.kid === head.kid); }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(partes[2]), new TextEncoder().encode(partes[0] + '.' + partes[1]));
    if (!ok) return null;
    const ahora = Math.floor(Date.now() / 1000);
    if (typeof body.exp !== 'number' || body.exp < ahora) return null;
    if (typeof body.nbf === 'number' && body.nbf > ahora + 60) return null;
    if (body.iss !== 'https://' + env.ACCESS_TEAM) return null;
    const aud = [].concat(body.aud || []);
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (env.ACCESS_EMAILS) {
      const permitidos = env.ACCESS_EMAILS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!permitidos.includes(String(body.email || '').toLowerCase())) return null;
    }
    return body;
  } catch { return null; }
}

async function autorizado(req, env) {
  if (env.ACCESS_TEAM && env.ACCESS_AUD) {
    const jwt = req.headers.get('Cf-Access-Jwt-Assertion') || cookie(req, 'CF_Authorization');
    if (jwt && await verificarAccess(jwt, env)) return true;
  }
  // Respaldo: clave del visor en cookie.
  return !!env.VIEW_KEY && eq(cookie(req, 'vk'), env.VIEW_KEY);
}

// --- consultas --------------------------------------------------------------
// Misma regla que la app: el gasto con tarjeta de crédito no suma (suma su pago)
// y el ahorro/inversión queda fuera de los totales de gasto.
const SUMA_UYU = `SUM(CASE WHEN es_credito = 0 AND es_ahorro = 0 THEN (CASE WHEN es_fijo = 1 THEN COALESCE(uyu_raw, 0) WHEN moneda = 'UYU' THEN monto ELSE 0 END) ELSE 0 END)`;
const SUMA_USD = `SUM(CASE WHEN es_credito = 0 AND es_ahorro = 0 THEN (CASE WHEN es_fijo = 1 THEN COALESCE(usd_raw, 0) WHEN moneda = 'USD' THEN monto ELSE 0 END) ELSE 0 END)`;

function filtros(url, T) {
  const w = ['tenant_id = ?'];
  const p = [T];
  const mes = url.searchParams.get('mes');
  if (mes && /^\d{4}-\d{2}$/.test(mes)) { w.push('mes = ?'); p.push(mes); }
  const cat = url.searchParams.get('cat');
  if (cat) { w.push('(cat1 = ? OR cat2 = ?)'); p.push(cat, cat); }
  const moneda = url.searchParams.get('moneda');
  if (moneda === 'UYU' || moneda === 'USD') { w.push('moneda = ?'); p.push(moneda); }
  const medio = url.searchParams.get('medio');
  if (medio) { w.push('medio_pago = ?'); p.push(medio); }
  const desde = url.searchParams.get('desde'), hasta = url.searchParams.get('hasta');
  if (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) { w.push('fecha_efectiva >= ?'); p.push(desde); }
  if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) { w.push('fecha_efectiva <= ?'); p.push(hasta); }
  const tipo = url.searchParams.get('tipo');
  if (tipo === 'fijo') w.push('es_fijo = 1');
  else if (tipo === 'variable') w.push('es_fijo = 0');
  else if (tipo === 'ahorro') w.push('es_ahorro = 1');
  else if (tipo === 'credito') w.push('es_credito = 1');
  const q = (url.searchParams.get('q') || '').trim();
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    w.push("(concepto LIKE ? ESCAPE '\\' OR notas LIKE ? ESCAPE '\\' OR categoria LIKE ? ESCAPE '\\' OR grupo_nombre LIKE ? ESCAPE '\\')");
    p.push(like, like, like, like);
  }
  return { where: w.join(' AND '), params: p };
}

const ORDEN = {
  fecha: 'fecha_efectiva',
  monto: 'monto', concepto: 'concepto COLLATE NOCASE', categoria: 'categoria COLLATE NOCASE', mes: 'mes'
};

async function listarGastos(env, url, limit, T) {
  const { where, params } = filtros(url, T);
  const col = ORDEN[url.searchParams.get('orden')] || ORDEN.fecha;
  const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const off = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const [rows, tot] = await env.DB.batch([
    env.DB.prepare(`SELECT id, mes, concepto, monto, moneda, uyu_raw, usd_raw, medio_pago, es_fijo, es_credito, es_ahorro, categoria, fecha, fecha_efectiva, fecha_origen, cotizacion, notas, grupo_nombre
                    FROM expenses WHERE ${where} ORDER BY ${col} ${dir}, id DESC LIMIT ? OFFSET ?`).bind(...params, limit, off),
    env.DB.prepare(`SELECT COUNT(*) AS n, ${SUMA_UYU} AS uyu, ${SUMA_USD} AS usd FROM expenses WHERE ${where}`).bind(...params)
  ]);
  return { rows: rows.results, count: tot.results[0].n, uyu: tot.results[0].uyu || 0, usd: tot.results[0].usd || 0 };
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Evita que Excel/Sheets ejecuten una celda que empiece con = + - @ (inyección de fórmulas).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Bandera a partir del código ISO de país (dos letras -> dos "regional indicators").
function banderaDe(codigo) {
  const c = String(codigo || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🏳️';
  return String.fromCodePoint(...[...c].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
}

async function ajustes(env, T) {
  const r = await env.DB.prepare(`SELECT clave, valor FROM settings WHERE tenant_id = ?`).bind(T).all();
  const s = {};
  for (const x of r.results) s[x.clave] = x.valor;
  s.pais_codigo = s.pais_codigo || 'AR';
  s.pais_bandera = banderaDe(s.pais_codigo);
  return s;
}

async function api(req, env, url, T) {
  const path = url.pathname;

  if (path === '/api/months') {
    const r = await env.DB.prepare(
      `SELECT e.mes AS mes, MAX(e.tab) AS tab, COUNT(*) AS n, ${SUMA_UYU} AS uyu, ${SUMA_USD} AS usd
       FROM expenses e WHERE e.tenant_id = ? GROUP BY e.mes ORDER BY e.mes DESC`).bind(T).all();
    return json({ ok: true, months: r.results });
  }

  if (path === '/api/expenses') {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
    return json({ ok: true, ...(await listarGastos(env, url, limit, T)) });
  }

  if (path === '/api/categories') {
    // Un gasto con 2 categorías suma su monto entero en cada una (igual que la app).
    const { where, params } = filtros(url, T);
    const base = `FROM expenses WHERE ${where} AND es_credito = 0 AND es_ahorro = 0`;
    const monto = (m) => `CASE WHEN es_fijo = 1 THEN COALESCE(${m === 'UYU' ? 'uyu_raw' : 'usd_raw'}, 0) WHEN moneda = '${m}' THEN monto ELSE 0 END`;
    const r = await env.DB.prepare(
      `SELECT cat, SUM(uyu) AS uyu, SUM(usd) AS usd, COUNT(*) AS n FROM (
         SELECT COALESCE(cat1, 'Otros') AS cat, ${monto('UYU')} AS uyu, ${monto('USD')} AS usd ${base}
         UNION ALL
         SELECT cat2 AS cat, ${monto('UYU')} AS uyu, ${monto('USD')} AS usd ${base} AND cat2 IS NOT NULL
       ) GROUP BY cat ORDER BY (SUM(uyu) + SUM(usd) * 40) DESC`).bind(...params, ...params).all();
    return json({ ok: true, categories: r.results });
  }

  if (path === '/api/facets') {
    const [cats, medios] = await env.DB.batch([
      env.DB.prepare(`SELECT cat FROM (SELECT cat1 AS cat FROM expenses WHERE tenant_id = ? UNION SELECT cat2 FROM expenses WHERE tenant_id = ?) WHERE cat IS NOT NULL ORDER BY cat`).bind(T, T),
      env.DB.prepare(`SELECT DISTINCT medio_pago AS m FROM expenses WHERE tenant_id = ? AND medio_pago <> '' ORDER BY m`).bind(T)
    ]);
    return json({ ok: true, categories: cats.results.map((x) => x.cat), medios: medios.results.map((x) => x.m) });
  }

  if (path === '/api/incomes') {
    const r = await env.DB.prepare(`SELECT id, fecha, concepto, monto, moneda, notas FROM incomes WHERE tenant_id = ? ORDER BY fecha DESC, id DESC`).bind(T).all();
    return json({ ok: true, incomes: r.results });
  }

  if (path === '/api/savings') {
    const r = await env.DB.prepare(`SELECT id, fecha, tipo, entidad, ticker, cantidad, precio_usd, comision_usd, monto, moneda, invertido_usd, notas FROM savings WHERE tenant_id = ? ORDER BY fecha DESC, id DESC`).bind(T).all();
    return json({ ok: true, savings: r.results });
  }

  if (path === '/api/config') {
    const r = await env.DB.prepare(`SELECT clave, valor FROM config WHERE tenant_id = ? ORDER BY clave`).bind(T).all();
    return json({ ok: true, config: r.results });
  }

  if (path === '/api/fuente') {
    if (T !== ILAN) return json({ ok: false, error: 'No disponible' }, 403);
    return json({ ok: true, fuentes: await fuentes(env, T), rpc: RPC_NOMBRES });
  }

  if (path === '/api/settings') return json({ ok: true, settings: await ajustes(env, T) });

  if (path === '/api/tasks') {
    const r = await env.DB.prepare(
      `SELECT id, creada, tipo, categoria, subcategoria, texto, fecha, hora, notas, completada, fecha_completada, recurrente, objetivo, contador, periodo, importancia, archivada, subtareas
       FROM tasks WHERE tenant_id = ? ORDER BY completada, archivada, COALESCE(NULLIF(fecha, ''), '9999'), id`).bind(T).all();
    const tasks = r.results.map((t) => { let s = []; try { s = JSON.parse(t.subtareas || '[]'); } catch {} return { ...t, subtareas: s }; });
    return json({ ok: true, tasks });
  }

  if (path === '/api/purchases') {
    const r = await env.DB.prepare(`SELECT id, creada, texto, comprado, fecha_comprado FROM purchases WHERE tenant_id = ? ORDER BY comprado, id DESC`).bind(T).all();
    return json({ ok: true, purchases: r.results });
  }

  if (path === '/api/habits') {
    const [days, log] = await env.DB.batch([
      env.DB.prepare(`SELECT fecha, levante, acoste, hs_sueno, trabajo, avance, animo, ejercicio, ejercicio_min, medite, medite_min, lei, abordajes, agua, mast, notas FROM habit_days WHERE tenant_id = ? ORDER BY fecha DESC`).bind(T),
      env.DB.prepare(`SELECT fecha, hora, kind, detalle, macro, tipo, procesado, kcal, ml, min, ingredientes FROM habit_log WHERE tenant_id = ? ORDER BY fecha DESC, hora DESC, id DESC`).bind(T)
    ]);
    return json({ ok: true, days: days.results, log: log.results });
  }

  // Módulo "país": movimientos y deuda por mes. Nombre, moneda y bandera salen de los ajustes.
  if (path === '/api/country') {
    const [movs, meses] = await env.DB.batch([
      env.DB.prepare(`SELECT id, mes, fecha, tipo, detalle, usd, cotizacion, monto_local, quien, categoria FROM foreign_movements WHERE tenant_id = ? ORDER BY mes DESC, src_row DESC`).bind(T),
      env.DB.prepare(`SELECT m.mes, m.deuda_antes_usd,
          (SELECT COUNT(*) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes) AS n,
          (SELECT COALESCE(SUM(usd), 0) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes AND f.tipo = 'Gasto') AS gasto_usd,
          (SELECT COALESCE(SUM(usd), 0) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes AND f.tipo = 'Carga') AS carga_usd,
          (SELECT COALESCE(SUM(usd), 0) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes AND f.tipo = 'Pago') AS pago_usd
        FROM foreign_months m WHERE m.tenant_id = ? ORDER BY m.mes DESC`).bind(T)
    ]);
    return json({ ok: true, settings: await ajustes(env, T), months: meses.results, movements: movs.results });
  }

  // Compara, mes por mes, el total que calcula D1 con el que calculó el Sheet al importar.
  if (path === '/api/verify') {
    const r = await env.DB.prepare(
      `SELECT t.mes, t.tab, t.uyu AS sheet_uyu, t.usd AS sheet_usd,
              (SELECT ${SUMA_UYU} FROM expenses e WHERE e.tenant_id = t.tenant_id AND e.mes = t.mes) AS d1_uyu,
              (SELECT ${SUMA_USD} FROM expenses e WHERE e.tenant_id = t.tenant_id AND e.mes = t.mes) AS d1_usd,
              (SELECT COUNT(*) FROM expenses e WHERE e.tenant_id = t.tenant_id AND e.mes = t.mes) AS filas
       FROM month_totals t WHERE t.tenant_id = ? ORDER BY t.mes`).bind(T).all();
    const meses = r.results.map((m) => {
      const du = Math.round(((m.d1_uyu || 0) - (m.sheet_uyu || 0)) * 100) / 100;
      const dd = Math.round(((m.d1_usd || 0) - (m.sheet_usd || 0)) * 100) / 100;
      return { ...m, dif_uyu: du, dif_usd: dd, ok: du === 0 && dd === 0 };
    });
    // import_log es global (sin tenant_id) y describe la importación del Sheet de ILAN: solo se muestra a él.
    const log = T === ILAN ? await env.DB.prepare(`SELECT * FROM import_log ORDER BY id DESC LIMIT 1`).all() : { results: [] };
    return json({ ok: true, todoCoincide: meses.every((m) => m.ok), meses, ultimaImportacion: log.results[0] || null });
  }

  if (path === '/api/export.csv') {
    const { rows } = await listarGastos(env, url, 5000, T);
    const head = ['mes', 'fecha', 'fecha_origen', 'concepto', 'monto', 'moneda', 'medio_pago', 'categoria', 'fijo', 'credito', 'ahorro', 'notas'];
    const lines = [head.join(',')].concat(rows.map((r) =>
      [r.mes, r.fecha_efectiva, r.fecha_origen, r.concepto, r.monto, r.moneda, r.medio_pago, r.categoria, r.es_fijo, r.es_credito, r.es_ahorro, r.notas].map(csvCell).join(',')));
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gastos.csv"', 'Cache-Control': 'no-store' }
    });
  }

  return json({ ok: false, error: 'Ruta no encontrada' }, 404);
}

// Tenant de la request: Access (JWT válido) o clave del visor (cookie vk) = 'ilan'; si no, la sesión
// de la cookie sid (una consulta con JOIN, y ninguna si no hay cookie). null = sin sesión.
async function resolverTenant(req, env) {
  if (await autorizado(req, env)) return ILAN;
  const s = await tenantDeSesion(env, req);
  return s ? s.id : null;
}

const redir = (to, status = 302, cookies = []) => {
  const h = new Headers({ Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status, headers: h });
};

const htmlLogin = (aviso, mail, status = 200) => new Response(paginaLogin(aviso, mail), {
  status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP_LOGIN
  }
});

// Rutas sin sesión: login por magic link. Devuelve null si la ruta no es una de ellas.
async function rutaPublica(req, env, url) {
  const path = url.pathname;
  const origenMalo = () => { const o = req.headers.get('Origin'); return !!o && o !== url.origin; };

  if (path === '/login') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await resolverTenant(req, env)) return redir('/app');
      return htmlLogin();
    }
    if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);
    if (origenMalo()) return json({ ok: false, error: 'Origen no permitido' }, 403);
    const ct = (req.headers.get('Content-Type') || '').toLowerCase();
    const esJson = ct.startsWith('application/json');
    let email = '';
    try {
      const txt = await req.text();
      if (txt.length > 2000) return json({ ok: false, error: 'Pedido demasiado grande' }, 413);
      email = esJson ? String((JSON.parse(txt) || {}).email || '') : String(new URLSearchParams(txt).get('email') || '');
    } catch { return json({ ok: false, error: 'Pedido inválido' }, 400); }
    let r;
    try { r = await pedirLink(env, email, env.APP_URL || url.origin, req.headers.get('CF-Connecting-IP')); }
    catch (e) { console.error('login falló:', String(e && e.message || e)); r = { ok: false, status: 500, error: 'No pudimos procesar el pedido. Probá de nuevo en un rato.' }; }
    const { status, ...cuerpo } = r;
    if (esJson) return json(cuerpo, status || 200);
    return htmlLogin({ tipo: r.ok ? 'ok' : 'error', texto: r.ok ? r.mensaje : r.error, link: r.dev_link }, email.slice(0, 254), status || 200);
  }

  if (path.startsWith('/auth/')) {
    const token = path.slice(6);
    const venció = () => htmlLogin({ tipo: 'error', texto: 'Ese link venció o ya se usó. Pedí uno nuevo.' }, '', 400);
    // GET/HEAD: solo muestra el botón. No canjea ni toca D1 (escáneres de mail y prefetch hacen GET).
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!esHex64(token)) return venció();
      return new Response(paginaConfirmar(token), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP_LOGIN
        }
      });
    }
    if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);
    if (origenMalo()) return json({ ok: false, error: 'Origen no permitido' }, 403);
    let r;
    try { r = await canjearLink(env, token, req.headers.get('User-Agent')); }
    catch (e) { console.error('canje falló:', String(e && e.message || e)); r = { ok: false }; }
    if (!r.ok) return venció();
    return redir('/app', 303, [cookieSesion(r.sid)]);
  }

  if (path === '/logout') {
    if (req.method !== 'POST') return json({ ok: false, error: 'Usar POST' }, 405);
    if (origenMalo()) return json({ ok: false, error: 'Origen no permitido' }, 403);
    try { await cerrarSesion(env, req); } catch (e) { console.error('logout falló:', String(e && e.message || e)); }
    return redir('/login', 303, [cookieSesionBorrada]);
  }
  return null;
}

// Sync automático: baja el volcado parcial (mes actual y anterior + módulos chicos) de
// Apps Script y lo carga en D1. Apps Script sigue siendo la fuente de verdad.
async function sincronizar(env) {
  // Con todos los módulos en D1 ya no hay nada que bajar del Sheet: no se llama a Apps Script.
  const f0 = await fuentes(env, ILAN);
  if (MODULOS.every((m) => f0[m] === 'd1')) return { omitido: 'todos los módulos están en D1' };
  if (!env.APPS_SCRIPT_URL || !env.APP_KEY) throw new Error('Faltan APPS_SCRIPT_URL / APP_KEY');
  const u = new URL(env.APPS_SCRIPT_URL);
  u.searchParams.set('action', 'exportAll');
  u.searchParams.set('parcial', '1');
  u.searchParams.set('k', env.APP_KEY);
  const r = await fetch(u, { redirect: 'follow' });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Volcado no es JSON: ' + text.slice(0, 100)); }
  if (!data.ok) throw new Error('Volcado dijo: ' + (data.error || 'error'));
  if (data.errores && data.errores.length) throw new Error('Volcado con errores, no se carga: ' + JSON.stringify(data.errores).slice(0, 200));
  const saltear = MODULOS.filter((m) => f0[m] === 'd1');
  // Solo se escriben los grupos que cambiaron desde el último sync (huella en sync_state):
  // el plan gratis de D1 limita las filas escritas por día.
  const { results } = await env.DB.prepare('SELECT grupo, huella FROM sync_state WHERE tenant_id = ?').bind(ILAN).all();
  const previas = Object.fromEntries(results.map((x) => [x.grupo, x.huella]));
  const { statements, counts } = await buildDelta(data, previas, { tenant: ILAN, fuente: 'cron', saltear });
  // Una sola batch = una transacción: si algo falla no queda a medias.
  if (statements.length) await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  return counts;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sincronizar(env).then(
      (c) => console.log('sync ok', JSON.stringify(c)),
      (e) => console.error('sync falló:', String(e && e.message || e))
    ));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    // Entrada con clave: la guarda en cookie y limpia la URL.
    const k = url.searchParams.get('key');
    if (k && env.VIEW_KEY && eq(k, env.VIEW_KEY)) {
      const cookieVk = `vk=${encodeURIComponent(k)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`;
      // Entrada desde la PWA (otro sitio): una cookie Strict no viaja en una navegación que
      // arranca en otro sitio ni en sus redirecciones 302. Esta página la guarda y navega a /app
      // por su cuenta (meta refresh = navegación propia del mismo sitio), así que la cookie sí va.
      if (url.searchParams.get('next') === '/app') {
        return new Response('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/app"><title>Gastos</title>', {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Set-Cookie': cookieVk,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
          }
        });
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': cookieVk,
          'Cache-Control': 'no-store'
        }
      });
    }

    const publica = await rutaPublica(req, env, url);
    if (publica) return publica;

    // Disparo del sync por Apps Script: no hay sesión de navegador, se autentica con
    // la clave compartida (APP_KEY) en un header. Solo POST, y no acepta nada del cuerpo:
    // el Worker mismo baja el volcado.
    if (url.pathname === '/api/sync') {
      if (req.method !== 'POST') return json({ ok: false, error: 'Usar POST' }, 405);
      if (!env.APP_KEY || !eq(req.headers.get('X-Sync-Key') || '', env.APP_KEY)) return json({ ok: false, error: 'No autorizado' }, 401);
      try { return json({ ok: true, counts: await sincronizar(env) }); }
      catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
    }

    // Avisos pendientes (los consulta el Worker de la PWA por service binding): además de la
    // sesión normal, entran con la clave compartida APP_KEY en X-Sync-Key. Solo GET y solo estas
    // dos rutas; cualquier otra cosa sigue exigiendo la sesión.
    // Los informes (HTML de GET /informe/mensual y /informe/tareas, y el envío por mail con
    // POST /api/informe/enviar) tienen la misma doble entrada: los llama el cron de la PWA.
    const esPendiente = req.method === 'GET' && (url.pathname === '/api/habit-pending' || url.pathname === '/api/tasks-pending');
    const esInforme = (req.method === 'GET' && (url.pathname === '/informe/mensual' || url.pathname === '/informe/tareas')) ||
      (req.method === 'POST' && url.pathname === '/api/informe/enviar');
    const porClave = (esPendiente || esInforme) && !!env.APP_KEY && eq(req.headers.get('X-Sync-Key') || '', env.APP_KEY);

    // Las rutas por clave (cron de la PWA) son siempre del tenant original.
    const T = porClave ? ILAN : await resolverTenant(req, env);
    if (!T) {
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'No autorizado' }, 401);
      if (url.pathname === '/' || url.pathname === '/app') return redir('/login');
      return new Response('No autorizado', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // Escritura: solo POST JSON a /api/rpc/<función> (mismo contrato que google.script.run)
    // y /api/fuente. Se exige Content-Type JSON (un formulario cruzado no puede mandarlo
    // sin preflight) y, si viene Origin, que sea el propio Worker.
    if (req.method === 'POST' && (url.pathname.startsWith('/api/rpc/') || url.pathname === '/api/fuente')) {
      const origin = req.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ ok: false, error: 'Origen no permitido' }, 403);
      if (!(req.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ ok: false, error: 'Se espera JSON' }, 415);
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: 'JSON inválido' }, 400); }
      if (url.pathname === '/api/fuente') {
        if (T !== ILAN) return json({ ok: false, error: 'No disponible' }, 403);
        try {
          const modulo = body && body.modulo, destino = body && body.fuente;
          if (destino === 'd1') await sincronizar(env); // D1 arranca con lo último del Sheet
          await setFuente(env, T, modulo, destino);
          return json({ ok: true, fuentes: await fuentes(env, T) });
        } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 400); }
      }
      return json(await llamar(env, T, decodeURIComponent(url.pathname.slice(9)), body && body.args));
    }

    // Envío del informe por mail (solo si hay proveedor configurado, ver informes.js). Sin cuerpo:
    // todo va en la query (?tipo=mensual|tareas, y mes=YYYY-MM opcional para el mensual).
    if (req.method === 'POST' && url.pathname === '/api/informe/enviar') {
      // El destino del mail es MAIL_TO (el de ILAN): para otro tenant mandaría sus datos a un tercero.
      if (T !== ILAN) return json({ ok: false, error: 'No disponible' }, 403);
      const origin = req.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ ok: false, error: 'Origen no permitido' }, 403);
      try {
        const tipo = url.searchParams.get('tipo');
        const mes = url.searchParams.get('mes') || '';
        const r = await enviarInforme(env, T, tipo, { mes });
        return json(r, r.ok ? 200 : (r.error && r.error.startsWith('Resend') ? 502 : 400));
      } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
    }

    if (req.method !== 'GET') return json({ ok: false, error: 'Solo lectura' }, 405);

    try {
      if (url.pathname === '/api/habit-pending') {
        return json(await habitPending(env, T, Object.fromEntries(url.searchParams)));
      }
      if (url.pathname === '/api/tasks-pending') return json(await tasksPending(env, T));
      if (url.pathname.startsWith('/api/')) return await api(req, env, url, T);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }

    if (url.pathname === '/informe/mensual' || url.pathname === '/informe/tareas') {
      try {
        let html;
        if (url.pathname === '/informe/tareas') html = await tareasHoyHtml(env, T);
        else {
          const mes = url.searchParams.get('mes') || mesPorDefecto();
          if (!mesValido(mes)) return new Response('Mes inválido (usar YYYY-MM)', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
          html = await reporteMensualHtml(env, T, mes);
        }
        return new Response(html, { headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP_INFORME
        } });
      } catch (e) {
        return new Response('Error: ' + String(e && e.message || e), { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }

    if (url.pathname === '/app') {
      return new Response(renderForm(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date())), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP_FORM }
      });
    }

    return new Response(UI, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      }
    });
  }
};
