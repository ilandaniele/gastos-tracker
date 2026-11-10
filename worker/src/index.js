// Worker nuevo: visor de gastos sobre D1 (y base de la app que reemplazará a Apps Script).
// Hoy es de SOLO LECTURA: los datos entran por scripts/import.mjs desde el Sheet.
import UI from './ui.html';

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
function autorizado(req, env) {
  // Ojo: el header Cf-Access-Jwt-Assertion NO se puede dar por bueno sin verificar
  // la firma del JWT (cualquiera puede mandarlo). Cuando se ponga Access delante
  // hay que validarlo contra las claves públicas del team domain; hasta entonces
  // solo vale la clave.
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
  fecha: 'COALESCE(NULLIF(fecha, \'\'), \'0000\')',
  monto: 'monto', concepto: 'concepto COLLATE NOCASE', categoria: 'categoria COLLATE NOCASE', mes: 'mes'
};

async function listarGastos(env, url, limit) {
  const { where, params } = filtros(url);
  const col = ORDEN[url.searchParams.get('orden')] || ORDEN.fecha;
  const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const off = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const [rows, tot] = await env.DB.batch([
    env.DB.prepare(`SELECT id, mes, concepto, monto, moneda, uyu_raw, usd_raw, medio_pago, es_fijo, es_credito, es_ahorro, categoria, fecha, cotizacion, notas, grupo_nombre
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
    const head = ['mes', 'fecha', 'concepto', 'monto', 'moneda', 'medio_pago', 'categoria', 'fijo', 'credito', 'ahorro', 'notas'];
    const lines = [head.join(',')].concat(rows.map((r) =>
      [r.mes, r.fecha, r.concepto, r.monto, r.moneda, r.medio_pago, r.categoria, r.es_fijo, r.es_credito, r.es_ahorro, r.notas].map(csvCell).join(',')));
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gastos.csv"', 'Cache-Control': 'no-store' }
    });
  }

  return json({ ok: false, error: 'Ruta no encontrada' }, 404);
}

export default {
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

    if (!autorizado(req, env)) {
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
