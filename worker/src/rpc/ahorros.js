// Módulo ahorros. Contrato: ver src/rpc.js y src/rpc/compras.js (ejemplo completo).
// Porta getSavingsDataSafe / addSavingsSafe / updateSavingsSafe / deleteSavingsSafe de Apps Script.
// Las cotizaciones (precio de las acciones y dólar) se piden desde el Worker a Yahoo Finance
// (sin API key) y se guardan en price_cache (migración 0005); no hay GOOGLEFINANCE.
import { hoy, idDe } from './util.js';

export const MODULO = 'ahorros';

const TIPOS = ['Acción', 'Banco', 'Bono'];
const MONEDAS = ['USD', 'UYU'];
const COTIZ_FALLBACK = 40.25;        // igual que Code.gs: si no hay ninguna fuente
const TTL_PRECIO_MS = 15 * 60 * 1000; // precios de acciones: 15 min
const TTL_FX_MS = 10 * 60 * 1000;     // dólar: 10 min

// Empresas conocidas (idéntico a TICKER_INFO de Code.gs): el ticker alcanza para nombre y logo.
const TICKER_INFO = {
  NVDA: { nombre: 'NVIDIA', dominio: 'nvidia.com' }, AMD: { nombre: 'AMD', dominio: 'amd.com' },
  AAPL: { nombre: 'Apple', dominio: 'apple.com' }, MSFT: { nombre: 'Microsoft', dominio: 'microsoft.com' },
  GOOGL: { nombre: 'Alphabet', dominio: 'google.com' }, GOOG: { nombre: 'Alphabet', dominio: 'google.com' },
  AMZN: { nombre: 'Amazon', dominio: 'amazon.com' }, TSLA: { nombre: 'Tesla', dominio: 'tesla.com' },
  META: { nombre: 'Meta', dominio: 'meta.com' }, NFLX: { nombre: 'Netflix', dominio: 'netflix.com' },
  INTC: { nombre: 'Intel', dominio: 'intel.com' }, MELI: { nombre: 'MercadoLibre', dominio: 'mercadolibre.com' },
  CVX: { nombre: 'Chevron', dominio: 'chevron.com' }, XOM: { nombre: 'Exxon Mobil', dominio: 'exxonmobil.com' },
  ORCL: { nombre: 'Oracle', dominio: 'oracle.com' }, TTWO: { nombre: 'Take-Two', dominio: 'take2games.com' },
  NDAQ: { nombre: 'Nasdaq Inc.', dominio: 'nasdaq.com' }, KO: { nombre: 'Coca-Cola', dominio: 'coca-cola.com' },
  DIS: { nombre: 'Disney', dominio: 'disney.com' }, JPM: { nombre: 'JPMorgan', dominio: 'jpmorganchase.com' },
  V: { nombre: 'Visa', dominio: 'visa.com' }, MA: { nombre: 'Mastercard', dominio: 'mastercard.com' },
  PYPL: { nombre: 'PayPal', dominio: 'paypal.com' }, UBER: { nombre: 'Uber', dominio: 'uber.com' },
  ABNB: { nombre: 'Airbnb', dominio: 'airbnb.com' }, PLTR: { nombre: 'Palantir', dominio: 'palantir.com' },
  SHOP: { nombre: 'Shopify', dominio: 'shopify.com' }, SPOT: { nombre: 'Spotify', dominio: 'spotify.com' },
  AVGO: { nombre: 'Broadcom', dominio: 'broadcom.com' }, TSM: { nombre: 'TSMC', dominio: 'tsmc.com' },
  MU: { nombre: 'Micron', dominio: 'micron.com' }, QCOM: { nombre: 'Qualcomm', dominio: 'qualcomm.com' },
  ARM: { nombre: 'ARM', dominio: 'arm.com' }, COIN: { nombre: 'Coinbase', dominio: 'coinbase.com' },
  SPY: { nombre: 'S&P 500 (SPY)', dominio: 'ssga.com' }, VOO: { nombre: 'S&P 500 (VOO)', dominio: 'vanguard.com' },
  VTI: { nombre: 'Total Market', dominio: 'vanguard.com' }, QQQ: { nombre: 'Nasdaq 100', dominio: 'invesco.com' }
};
const tickerInfo = (t) => TICKER_INFO[String(t || '').trim().toUpperCase()] || null;

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ---- helpers (mismos que Code.gs) -----------------------------------------------------------
const stripAccents = (s) => String(s || '').replace(/[áéíóúÁÉÍÓÚñÑ]/g, (c) => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ú: 'u', ñ: 'n', Ñ: 'n' })[c]).toLowerCase().trim();
const toNumber = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const num = (v) => toNumber(String(v == null ? '' : v).replace(',', '.'));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (ganancia, invertido) => (!invertido ? null : Math.round((ganancia / invertido) * 1000) / 10);
const tipoCanon = (raw) => { const t = stripAccents(raw); return TIPOS.find((x) => stripAccents(x) === t) || String(raw || '').trim(); };

function fechaISO(f) {
  const m = String(f).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('Fecha inválida');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('Fecha inválida');
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---- cotizaciones ------------------------------------------------------------------------------
async function leerCache(env, claves) {
  const out = new Map();
  if (!claves.length) return out;
  try {
    const r = await env.DB.prepare(`SELECT clave, precio, at FROM price_cache WHERE clave IN (${claves.map(() => '?').join(',')})`).bind(...claves).all();
    for (const x of r.results) out.set(x.clave, x);
  } catch (e) { /* sin tabla o sin DB: se opera sin cache */ }
  return out;
}

async function guardarCache(env, filas) {
  if (!filas.length) return;
  try {
    const st = env.DB.prepare(`INSERT INTO price_cache (clave, precio, moneda_orig, precio_orig, at) VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT (clave) DO UPDATE SET precio = excluded.precio, moneda_orig = excluded.moneda_orig, precio_orig = excluded.precio_orig, at = excluded.at`);
    await env.DB.batch(filas.map((f) => st.bind(f.clave, f.precio, f.moneda || null, f.precioOrig == null ? null : f.precioOrig, f.at)));
  } catch (e) { /* el cache es opcional */ }
}

// Consulta cruda a Yahoo: precio y moneda en que cotiza. null si falla.
async function yahooQuote(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    const precio = meta && toNumber(meta.regularMarketPrice);
    if (precio == null || precio <= 0) return null;
    return { precio, moneda: String(meta.currency || 'USD').toUpperCase() };
  } catch (e) { return null; }
}

// Pesos uruguayos por dólar. Yahoo (UYU=X) -> open.er-api.com -> último valor guardado -> 40.25.
async function cotizacionUsdUyu(env) {
  const valida = (v) => Number.isFinite(v) && v > 20 && v < 100;
  const ahora = Date.now();
  const c = (await leerCache(env, ['fx:USDUYU'])).get('fx:USDUYU');
  if (c && valida(c.precio) && ahora - c.at < TTL_FX_MS) return c.precio;
  let v = null;
  const q = await yahooQuote('UYU=X');
  if (q && valida(q.precio)) v = q.precio;
  if (v == null) {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); const x = toNumber(j && j.rates && j.rates.UYU); if (valida(x)) v = x; }
    } catch (e) { /* sigue al respaldo */ }
  }
  if (v != null) { await guardarCache(env, [{ clave: 'fx:USDUYU', precio: v, moneda: 'UYU', precioOrig: v, at: ahora }]); return v; }
  return c && valida(c.precio) ? c.precio : COTIZ_FALLBACK;
}

// Precio en DÓLARES de varios tickers. Cache de 15 min en price_cache; si la fuente falla se usa el
// último valor guardado (mejor un total un poco viejo que en cero); sin nada, null.
async function preciosUsd(env, tickers) {
  const out = {};
  if (!tickers.length) return out;
  const ahora = Date.now();
  const cache = await leerCache(env, tickers.map((t) => 'px:' + t));
  const faltan = [];
  for (const t of tickers) {
    const c = cache.get('px:' + t);
    if (c && ahora - c.at < TTL_PRECIO_MS) out[t] = c.precio; else faltan.push(t);
  }
  if (!faltan.length) return out;

  const quotes = await Promise.all(faltan.map((t) => yahooQuote(t)));
  const monedas = [...new Set(quotes.filter((q) => q && q.moneda !== 'USD').map((q) => q.moneda))];
  const fx = {};
  if (monedas.length) {
    const cf = await leerCache(env, monedas.map((m) => 'fx:' + m));
    const pedir = [];
    for (const m of monedas) {
      const c = cf.get('fx:' + m);
      if (c && ahora - c.at < TTL_FX_MS) fx[m] = c.precio; else pedir.push(m);
    }
    const qs = await Promise.all(pedir.map((m) => yahooQuote(m + 'USD=X')));
    pedir.forEach((m, i) => {
      if (qs[i] && qs[i].precio) fx[m] = qs[i].precio;
      else if (cf.get('fx:' + m)) fx[m] = cf.get('fx:' + m).precio;   // cambio viejo antes que nada
    });
    await guardarCache(env, pedir.filter((m, i) => qs[i] && qs[i].precio).map((m) => ({ clave: 'fx:' + m, precio: fx[m], moneda: m, precioOrig: fx[m], at: ahora })));
  }

  const nuevos = [];
  faltan.forEach((t, i) => {
    const q = quotes[i];
    const viejo = cache.get('px:' + t);
    if (!q) { out[t] = viejo ? viejo.precio : null; return; }
    let precio = q.precio;
    if (q.moneda !== 'USD') {
      const rate = fx[q.moneda];
      if (!rate) { out[t] = viejo ? viejo.precio : null; return; }   // sin cambio: mejor sin precio que inflado
      precio = q.precio * rate;
    }
    out[t] = precio;
    nuevos.push({ clave: 'px:' + t, precio, moneda: q.moneda, precioOrig: q.precio, at: ahora });
  });
  await guardarCache(env, nuevos);
  return out;
}

// ---- lectura de movimientos -----------------------------------------------------------------------
async function leerMovimientos(env, T) {
  const r = await env.DB.prepare(`SELECT id, fecha, tipo, entidad, ticker, cantidad, precio_usd, comision_usd, monto, moneda, invertido_usd, notas
                                  FROM savings WHERE tenant_id = ? ORDER BY id`).bind(T).all();
  return r.results.map((x) => ({
    row: x.id,
    fecha: x.fecha || '',
    tipo: tipoCanon(x.tipo),
    entidad: String(x.entidad || '').trim(),
    ticker: String(x.ticker || '').trim().toUpperCase(),
    cantidad: x.cantidad == null ? null : x.cantidad,
    precioUsd: x.precio_usd == null ? null : x.precio_usd,
    comisionUsd: x.comision_usd || 0,
    monto: x.monto == null ? null : x.monto,
    moneda: String(x.moneda || 'USD').trim().toUpperCase(),
    invertidoUsd: x.invertido_usd || 0,
    precioHoy: null,
    valorHoyUsd: 0,
    notas: String(x.notas || '')
  }));
}

// Valúa cada movimiento con el precio del día y arma los totales (= _savingsRepaint sin escribir hoja).
async function valuar(env, filas) {
  const tickers = [...new Set(filas.filter((f) => f.tipo === 'Acción' && f.ticker).map((f) => f.ticker))];
  const [precios, cot] = await Promise.all([preciosUsd(env, tickers), cotizacionUsdUyu(env)]);
  let enAcciones = 0, enBanco = 0, enBonos = 0, invertidoAcciones = 0, comisiones = 0;
  for (const f of filas) {
    let precioHoy = null, valor = 0;
    if (f.tipo === 'Acción') {
      const px = precios[f.ticker] != null ? precios[f.ticker] : null;
      if (px != null && f.cantidad != null) { precioHoy = px; valor = f.cantidad * px; } else valor = f.invertidoUsd;
      enAcciones += valor; invertidoAcciones += f.invertidoUsd; comisiones += f.comisionUsd || 0;
    } else {
      valor = f.invertidoUsd;
      if (f.tipo === 'Bono') enBonos += valor; else enBanco += valor;
    }
    f.precioHoy = precioHoy;
    f.valorHoyUsd = valor;
  }
  const totalUsd = enAcciones + enBanco + enBonos;
  const gananciaUsd = enAcciones - invertidoAcciones;
  return {
    cot,
    totales: {
      totalUsd, totalUyu: totalUsd * cot, cotizacion: cot, enAcciones, enBanco, enBonos,
      invertidoAcciones, comisionesUsd: comisiones, gananciaUsd, gananciaPct: pct(gananciaUsd, invertidoAcciones)
    }
  };
}

// Dos compras de NVDA son una posición: cantidad sumada, invertido sumado.
function posiciones(filas) {
  const mapa = {};
  for (const f of filas) {
    const clave = f.tipo === 'Acción' ? 'A|' + f.ticker : f.tipo + '|' + stripAccents(f.entidad);
    if (!mapa[clave]) {
      const info = tickerInfo(f.ticker);
      mapa[clave] = {
        clave, tipo: f.tipo, ticker: f.ticker, nombre: f.entidad || (info && info.nombre) || f.ticker,
        dominio: info ? info.dominio : '', cantidad: 0, invertidoUsd: 0, valorHoyUsd: 0, comisionUsd: 0,
        precioHoy: f.precioHoy, movimientos: 0
      };
    }
    const p = mapa[clave];
    p.cantidad += f.cantidad || 0;
    p.invertidoUsd += f.invertidoUsd || 0;
    p.valorHoyUsd += f.valorHoyUsd || 0;
    p.comisionUsd += f.comisionUsd || 0;
    p.movimientos += 1;
    if (f.precioHoy != null) p.precioHoy = f.precioHoy;
  }
  return Object.values(mapa).map((p) => {
    p.gananciaUsd = p.tipo === 'Acción' ? p.valorHoyUsd - p.invertidoUsd : 0;
    p.gananciaPct = p.tipo === 'Acción' ? pct(p.gananciaUsd, p.invertidoUsd) : null;
    p.sinPrecio = p.tipo === 'Acción' && p.precioHoy == null;
    return p;
  }).sort((a, b) => b.valorHoyUsd - a.valorHoyUsd);
}

// Saldo del banco: depósitos - gastos que salen del banco del mes + ingresos del mes.
// Gastos = fijos del mes + variables que no son efectivo (mismo criterio que _monthExpenseTotals).
async function saldo(env, T, filas) {
  const [anio, mm] = hoy().split('-');
  const mes = `${anio}-${mm}`;
  const mesActual = `${MESES[+mm - 1]} ${anio}`;
  const [g, ing] = await Promise.all([
    env.DB.prepare(`SELECT
        COALESCE(SUM(CASE WHEN es_fijo = 1 THEN COALESCE(uyu_raw, 0)
                          WHEN moneda = 'UYU' AND monto > 0 AND LOWER(COALESCE(medio_pago, '')) NOT LIKE '%efectivo%' THEN monto ELSE 0 END), 0) AS uyu,
        COALESCE(SUM(CASE WHEN es_fijo = 1 THEN COALESCE(usd_raw, 0)
                          WHEN moneda = 'USD' AND monto > 0 AND LOWER(COALESCE(medio_pago, '')) NOT LIKE '%efectivo%' THEN monto ELSE 0 END), 0) AS usd
      FROM expenses WHERE tenant_id = ? AND mes = ?`).bind(T, mes).first(),
    env.DB.prepare(`SELECT UPPER(COALESCE(moneda, 'UYU')) AS moneda, COALESCE(SUM(monto), 0) AS total
                    FROM incomes WHERE tenant_id = ? AND substr(fecha, 1, 7) = ? GROUP BY 1`).bind(T, mes).all()
  ]);
  const ingUyu = ing.results.filter((x) => x.moneda !== 'USD').reduce((s, x) => s + x.total, 0);
  const ingUsd = ing.results.filter((x) => x.moneda === 'USD').reduce((s, x) => s + x.total, 0);
  const banco = filas.filter((f) => f.tipo === 'Banco');
  const suma = (m) => banco.filter((f) => f.moneda === m).reduce((s, f) => s + (f.monto || 0), 0);
  const hayUyu = banco.some((f) => f.moneda === 'UYU'), hayUsd = banco.some((f) => f.moneda === 'USD');
  return {
    uyu: hayUyu ? Math.round((suma('UYU') - g.uyu + ingUyu) * 100) / 100 : null,
    usd: hayUsd ? Math.round((suma('USD') - g.usd + ingUsd) * 100) / 100 : null,
    mesActual, gastosUyu: g.uyu, gastosUsd: g.usd, ingresosUyu: ingUyu, ingresosUsd: ingUsd
  };
}

// ---- validación (= _normSaving) ----------------------------------------------------------------------
async function normalizar(env, p) {
  const tipoRaw = String(p.tipo || '').trim();
  const tipo = TIPOS.find((t) => stripAccents(t) === stripAccents(tipoRaw));
  if (!tipo) throw new Error('Tipo inválido: usá ' + TIPOS.join(', '));
  const fecha = fechaISO(p.fecha || hoy());
  const notas = String(p.notas || '').trim();

  if (tipo === 'Acción') {
    const ticker = String(p.ticker || '').trim().toUpperCase();
    if (!ticker) throw new Error('Falta el ticker de la acción (NVDA, AMD, …)');
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) throw new Error('Ticker inválido: ' + ticker);
    const cantidad = num(p.cantidad);
    if (cantidad == null || cantidad <= 0) throw new Error('Cantidad de acciones inválida');

    // Siempre cierra: acciones (cantidad x precio) + comisión = total gastado. Se puede cargar
    // cualquier combinación; del resto se deduce el que falte.
    let precio = num(p.precioUsd);
    let comision = num(p.comisionUsd !== undefined ? p.comisionUsd : p.comision);
    let gastado = num(p.gastadoUsd !== undefined ? p.gastadoUsd : p.gastado);

    if (precio == null && gastado == null) throw new Error('Poné el precio por acción o cuánto gastaste en total');
    if (precio != null && precio < 0) throw new Error('Precio de compra inválido');
    if (comision != null && comision < 0) throw new Error('La comisión no puede ser negativa');
    if (gastado != null && gastado < 0) throw new Error('Lo gastado no puede ser negativo');

    if (precio != null && gastado != null) {
      // El precio por acción viene redondeado a centavos; con cantidades fraccionadas ese redondeo
      // se amplifica, así que la tolerancia acompaña a la cantidad.
      const costo = cantidad * precio;
      const tol = 0.01 + cantidad * 0.005;
      if (comision == null) {
        if (gastado - costo < -tol) throw new Error('Lo gastado (US$ ' + r2(gastado) + ') es menor que las acciones (US$ ' + r2(costo) + '). Revisá el precio o el total.');
        comision = Math.max(0, gastado - costo);
      } else if (Math.abs(costo + comision - gastado) > tol) {
        throw new Error('No cierra: US$ ' + r2(costo) + ' de acciones + US$ ' + r2(comision) + ' de comisión dan US$ ' + r2(costo + comision) + ', no US$ ' + r2(gastado));
      } else {
        // Lo gastado y la comisión son plata exacta: el precio es el derivado y se recalcula.
        precio = (gastado - comision) / cantidad;
      }
    } else if (precio != null) {
      comision = comision || 0;
      gastado = cantidad * precio + comision;
    } else {
      // Solo el total: se le resta la comisión y recién ahí sale el precio por acción.
      comision = comision || 0;
      const costo = gastado - comision;
      if (costo <= 0) throw new Error('La comisión no puede ser mayor o igual a lo gastado');
      precio = costo / cantidad;
    }

    const info = tickerInfo(ticker);
    return {
      fecha, tipo, entidad: String(p.entidad || '').trim() || (info ? info.nombre : ticker),
      ticker, cantidad, precioUsd: precio, comisionUsd: comision, monto: '', moneda: 'USD',
      costoUsd: cantidad * precio, invertidoUsd: gastado, notas
    };
  }

  const entidad = String(p.entidad || '').trim();
  if (!entidad) throw new Error(tipo === 'Banco' ? 'Falta el banco' : 'Falta el nombre del bono');
  const monto = num(p.monto);
  if (monto == null || monto <= 0) throw new Error('Monto inválido');
  const mon = String(p.moneda || 'USD').toUpperCase();
  const moneda = MONEDAS.includes(mon) ? mon : 'USD';
  const invertidoUsd = moneda === 'UYU' ? monto / (await cotizacionUsdUyu(env)) : monto;
  return { fecha, tipo, entidad, ticker: '', cantidad: '', precioUsd: '', comisionUsd: '', monto, moneda, invertidoUsd, notas };
}

const nul = (v) => (v === '' || v === undefined ? null : v);
const valoresDe = (e) => [e.fecha, e.tipo, e.entidad, nul(e.ticker), nul(e.cantidad), nul(e.precioUsd), nul(e.comisionUsd), nul(e.monto), e.moneda, e.invertidoUsd, e.notas];

async function totalesActuales(env, T) {
  const filas = await leerMovimientos(env, T);
  return (await valuar(env, filas)).totales;
}

export const HANDLERS = {
  getSavingsDataSafe: { escribe: false, run: async (env, T) => {
    const filas = await leerMovimientos(env, T);
    const [v, s] = await Promise.all([valuar(env, filas), saldo(env, T, filas)]);
    return { ok: true, tab: 'Ahorros', movimientos: filas, posiciones: posiciones(filas), totales: v.totales, tipos: TIPOS, monedas: MONEDAS, saldo: s };
  } },

  addSavingsSafe: { escribe: true, run: async (env, T, [d]) => {
    const e = await normalizar(env, d || {});
    const r = await env.DB.prepare(`INSERT INTO savings (tenant_id, fecha, tipo, entidad, ticker, cantidad, precio_usd, comision_usd, monto, moneda, invertido_usd, notas)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(T, ...valoresDe(e)).run();
    return { ok: true, tab: 'Ahorros', row: r.meta.last_row_id, written: e, totales: await totalesActuales(env, T) };
  } },

  updateSavingsSafe: { escribe: true, run: async (env, T, [d]) => {
    d = d || {};
    const id = idDe(d);
    const e = await normalizar(env, d);
    const r = await env.DB.prepare(`UPDATE savings SET fecha = ?, tipo = ?, entidad = ?, ticker = ?, cantidad = ?, precio_usd = ?, comision_usd = ?, monto = ?, moneda = ?, invertido_usd = ?, notas = ?
                                    WHERE tenant_id = ? AND id = ?`).bind(...valoresDe(e), T, id).run();
    if (!r.meta.changes) throw new Error('Esa fila está vacía — recargá los ahorros e intentá de nuevo');
    return { ok: true, tab: 'Ahorros', row: id, written: e, totales: await totalesActuales(env, T) };
  } },

  deleteSavingsSafe: { escribe: true, run: async (env, T, [d]) => {
    const id = idDe(d || {});
    const cur = await env.DB.prepare(`SELECT entidad, ticker FROM savings WHERE tenant_id = ? AND id = ?`).bind(T, id).first();
    if (!cur) throw new Error('Esa fila ya está vacía');
    await env.DB.prepare(`DELETE FROM savings WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
    return { ok: true, tab: 'Ahorros', deleted: String(cur.entidad || cur.ticker || ''), totales: await totalesActuales(env, T) };
  } }
};
