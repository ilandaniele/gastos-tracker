// Worker nuevo: visor de gastos sobre D1 (y base de la app que reemplazará a Apps Script).
// Hoy es de SOLO LECTURA: los datos entran por scripts/import.mjs desde el Sheet.
import UI from './ui.html';
import { buildStatements } from './sync.js';

const TENANT = 'ilan';

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

function filtros(url) {
  const w = ['tenant_id = ?'];
  const p = [TENANT];
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

async function listarGastos(env, url, limit) {
  const { where, params } = filtros(url);
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

async function ajustes(env) {
  const r = await env.DB.prepare(`SELECT clave, valor FROM settings WHERE tenant_id = ?`).bind(TENANT).all();
  const s = {};
  for (const x of r.results) s[x.clave] = x.valor;
  s.pais_codigo = s.pais_codigo || 'AR';
  s.pais_bandera = banderaDe(s.pais_codigo);
  return s;
}

async function api(req, env, url) {
  const path = url.pathname;

  if (path === '/api/months') {
    const r = await env.DB.prepare(
      `SELECT e.mes AS mes, MAX(e.tab) AS tab, COUNT(*) AS n, ${SUMA_UYU} AS uyu, ${SUMA_USD} AS usd
       FROM expenses e WHERE e.tenant_id = ? GROUP BY e.mes ORDER BY e.mes DESC`).bind(TENANT).all();
    return json({ ok: true, months: r.results });
  }

  if (path === '/api/expenses') {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
    return json({ ok: true, ...(await listarGastos(env, url, limit)) });
  }

  if (path === '/api/categories') {
    // Un gasto con 2 categorías suma su monto entero en cada una (igual que la app).
    const { where, params } = filtros(url);
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
      env.DB.prepare(`SELECT cat FROM (SELECT cat1 AS cat FROM expenses WHERE tenant_id = ? UNION SELECT cat2 FROM expenses WHERE tenant_id = ?) WHERE cat IS NOT NULL ORDER BY cat`).bind(TENANT, TENANT),
      env.DB.prepare(`SELECT DISTINCT medio_pago AS m FROM expenses WHERE tenant_id = ? AND medio_pago <> '' ORDER BY m`).bind(TENANT)
    ]);
    return json({ ok: true, categories: cats.results.map((x) => x.cat), medios: medios.results.map((x) => x.m) });
  }

  if (path === '/api/incomes') {
    const r = await env.DB.prepare(`SELECT id, fecha, concepto, monto, moneda, notas FROM incomes WHERE tenant_id = ? ORDER BY fecha DESC, id DESC`).bind(TENANT).all();
    return json({ ok: true, incomes: r.results });
  }

  if (path === '/api/savings') {
    const r = await env.DB.prepare(`SELECT id, fecha, tipo, entidad, ticker, cantidad, precio_usd, comision_usd, monto, moneda, invertido_usd, notas FROM savings WHERE tenant_id = ? ORDER BY fecha DESC, id DESC`).bind(TENANT).all();
    return json({ ok: true, savings: r.results });
  }

  if (path === '/api/config') {
    const r = await env.DB.prepare(`SELECT clave, valor FROM config WHERE tenant_id = ? ORDER BY clave`).bind(TENANT).all();
    return json({ ok: true, config: r.results });
  }

  if (path === '/api/settings') return json({ ok: true, settings: await ajustes(env) });

  if (path === '/api/tasks') {
    const r = await env.DB.prepare(
      `SELECT id, creada, tipo, categoria, subcategoria, texto, fecha, hora, notas, completada, fecha_completada, recurrente, objetivo, contador, periodo, importancia, archivada, subtareas
       FROM tasks WHERE tenant_id = ? ORDER BY completada, archivada, COALESCE(NULLIF(fecha, ''), '9999'), id`).bind(TENANT).all();
    const tasks = r.results.map((t) => { let s = []; try { s = JSON.parse(t.subtareas || '[]'); } catch {} return { ...t, subtareas: s }; });
    return json({ ok: true, tasks });
  }

  if (path === '/api/purchases') {
    const r = await env.DB.prepare(`SELECT id, creada, texto, comprado, fecha_comprado FROM purchases WHERE tenant_id = ? ORDER BY comprado, id DESC`).bind(TENANT).all();
    return json({ ok: true, purchases: r.results });
  }

  if (path === '/api/habits') {
    const [days, log] = await env.DB.batch([
      env.DB.prepare(`SELECT fecha, levante, acoste, hs_sueno, trabajo, avance, animo, ejercicio, ejercicio_min, medite, medite_min, lei, abordajes, agua, mast, notas FROM habit_days WHERE tenant_id = ? ORDER BY fecha DESC`).bind(TENANT),
      env.DB.prepare(`SELECT fecha, hora, kind, detalle, macro, tipo, procesado, kcal, ml, min, ingredientes FROM habit_log WHERE tenant_id = ? ORDER BY fecha DESC, hora DESC, id DESC`).bind(TENANT)
    ]);
    return json({ ok: true, days: days.results, log: log.results });
  }

  // Módulo "país": movimientos y deuda por mes. Nombre, moneda y bandera salen de los ajustes.
  if (path === '/api/country') {
    const [movs, meses] = await env.DB.batch([
      env.DB.prepare(`SELECT id, mes, fecha, tipo, detalle, usd, cotizacion, monto_local, quien, categoria FROM foreign_movements WHERE tenant_id = ? ORDER BY mes DESC, src_row DESC`).bind(TENANT),
      env.DB.prepare(`SELECT m.mes, m.deuda_antes_usd,
          (SELECT COUNT(*) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes) AS n,
          (SELECT COALESCE(SUM(usd), 0) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes AND f.tipo = 'Gasto') AS gasto_usd,
          (SELECT COALESCE(SUM(usd), 0) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes AND f.tipo = 'Carga') AS carga_usd,
          (SELECT COALESCE(SUM(usd), 0) FROM foreign_movements f WHERE f.tenant_id = m.tenant_id AND f.mes = m.mes AND f.tipo = 'Pago') AS pago_usd
        FROM foreign_months m WHERE m.tenant_id = ? ORDER BY m.mes DESC`).bind(TENANT)
    ]);
    return json({ ok: true, settings: await ajustes(env), months: meses.results, movements: movs.results });
  }

  // Compara, mes por mes, el total que calcula D1 con el que calculó el Sheet al importar.
  if (path === '/api/verify') {
    const r = await env.DB.prepare(
      `SELECT t.mes, t.tab, t.uyu AS sheet_uyu, t.usd AS sheet_usd,
              (SELECT ${SUMA_UYU} FROM expenses e WHERE e.tenant_id = t.tenant_id AND e.mes = t.mes) AS d1_uyu,
              (SELECT ${SUMA_USD} FROM expenses e WHERE e.tenant_id = t.tenant_id AND e.mes = t.mes) AS d1_usd,
              (SELECT COUNT(*) FROM expenses e WHERE e.tenant_id = t.tenant_id AND e.mes = t.mes) AS filas
       FROM month_totals t WHERE t.tenant_id = ? ORDER BY t.mes`).bind(TENANT).all();
    const meses = r.results.map((m) => {
      const du = Math.round(((m.d1_uyu || 0) - (m.sheet_uyu || 0)) * 100) / 100;
      const dd = Math.round(((m.d1_usd || 0) - (m.sheet_usd || 0)) * 100) / 100;
      return { ...m, dif_uyu: du, dif_usd: dd, ok: du === 0 && dd === 0 };
    });
    const log = await env.DB.prepare(`SELECT * FROM import_log ORDER BY id DESC LIMIT 1`).all();
    return json({ ok: true, todoCoincide: meses.every((m) => m.ok), meses, ultimaImportacion: log.results[0] || null });
  }

  if (path === '/api/export.csv') {
    const { rows } = await listarGastos(env, url, 5000);
    const head = ['mes', 'fecha', 'fecha_origen', 'concepto', 'monto', 'moneda', 'medio_pago', 'categoria', 'fijo', 'credito', 'ahorro', 'notas'];
    const lines = [head.join(',')].concat(rows.map((r) =>
      [r.mes, r.fecha_efectiva, r.fecha_origen, r.concepto, r.monto, r.moneda, r.medio_pago, r.categoria, r.es_fijo, r.es_credito, r.es_ahorro, r.notas].map(csvCell).join(',')));
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gastos.csv"', 'Cache-Control': 'no-store' }
    });
  }

  return json({ ok: false, error: 'Ruta no encontrada' }, 404);
}

// Sync automático: baja el volcado parcial (mes actual y anterior + módulos chicos) de
// Apps Script y lo carga en D1. Apps Script sigue siendo la fuente de verdad.
async function sincronizar(env) {
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
  const { statements, counts } = buildStatements(data, { fuente: 'cron' });
  // Una sola batch = una transacción: si algo falla no queda a medias.
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
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
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': `vk=${encodeURIComponent(k)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`,
          'Cache-Control': 'no-store'
        }
      });
    }

    // Disparo del sync por Apps Script: no hay sesión de navegador, se autentica con
    // la clave compartida (APP_KEY) en un header. Solo POST, y no acepta nada del cuerpo:
    // el Worker mismo baja el volcado.
    if (url.pathname === '/api/sync') {
      if (req.method !== 'POST') return json({ ok: false, error: 'Usar POST' }, 405);
      if (!env.APP_KEY || !eq(req.headers.get('X-Sync-Key') || '', env.APP_KEY)) return json({ ok: false, error: 'No autorizado' }, 401);
      try { return json({ ok: true, counts: await sincronizar(env) }); }
      catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
    }

    if (!(await autorizado(req, env))) {
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'No autorizado' }, 401);
      return new Response('No autorizado', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (req.method !== 'GET') return json({ ok: false, error: 'Solo lectura' }, 405);

    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
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
