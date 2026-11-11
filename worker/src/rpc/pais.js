// Módulo pais: el bloque del "país secundario" (hoy Argentina): gastos en el exterior en USD con
// cotización y monto en moneda local, y la deuda mensual con 'quien' paga. Contrato: ver src/rpc.js.
// Los nombres de handler son los de Apps Script (xxxArgentinaSafe); la lógica es genérica: nada
// de acá depende de que el país sea Argentina salvo el texto de algunos errores y esos nombres.
//
// Tablas: foreign_movements (id = `row` del cliente) y foreign_months (existe una fila por mes que
// tiene el bloque; guarda la "deuda de antes" en USD). `mes` es 'YYYY-MM'; el cliente habla en
// nombres de hoja ('Agosto 2026'), que se traducen con tabDe()/mesDeTab().
import { hoy } from './util.js';

export const MODULO = 'pais';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const TIPOS = ['Carga', 'Gasto', 'Pago', 'Transferencia'];
const QUIENES = ['Mía', 'Mamá'];
// Igual que CATEGORIES de Code.gs (categoriasOrdenadas): alfabético en español, 'Otros' al final.
const CATEGORIAS = ['Transporte', 'Comida', 'Bebida/Bar', 'Salud', 'Suscripciones', 'Entretenimiento', 'Hogar', 'Limpieza', 'Ropa', 'Regalos',
  'Gimnasio', 'Servicios', 'Viajes', 'Amigos', 'Cita', 'Acciones/Bonos/Ahorros', 'Otros'];
const categoriasOrdenadas = () => {
  const resto = CATEGORIAS.filter((c) => c !== 'Otros').sort((a, b) => a.localeCompare(b, 'es'));
  return resto.concat(['Otros']);
};

// ---- Helpers (equivalentes a los de Code.gs) ------------------------------------------------
const stripAccents = (s) => String(s == null ? '' : s).replace(/[áéíóúÁÉÍÓÚñÑ]/g, (c) => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ú: 'u', ñ: 'n', Ñ: 'n' })[c]).toLowerCase().trim();
const toNumber = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const num = (v) => (v === undefined || v === '' || v === null) ? null : toNumber(String(v).replace(',', '.'));
const r2 = (n) => Math.round(n * 100) / 100;

const tabDe = (mes) => { const [y, m] = mes.split('-'); return MONTH_NAMES[parseInt(m, 10) - 1] + ' ' + y; };
// 'Agosto 2026' (o 'YYYY-MM') -> '2026-08'; null si no se entiende.
const mesDeTab = (tab) => {
  const s = String(tab).trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return s;
  const m = s.match(/^([A-Za-zÁÉÍÓÚáéíóú]+)\s+(\d{4})$/);
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1].toLowerCase());
  return idx < 0 ? null : `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
};
const mesAnterior = (mes) => {
  let [y, m] = mes.split('-').map(Number);
  if (m === 1) { y -= 1; m = 12; } else m -= 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};
const resolverMes = (monthOpt) => {
  if (!monthOpt) return hoy().slice(0, 7);
  const mes = mesDeTab(monthOpt);
  if (!mes) throw new Error('No existe la hoja "' + monthOpt + '"');
  return mes;
};

// Totales del mes. Idéntico a _argTotales: la deuda con mamá = deuda de antes + USD de gastos/cargas
// con plata de ella − pagos; las transferencias de terceros quedan aparte.
function totalesDe(entradas, deudaAntesOpt) {
  const deudaAntes = Math.round((toNumber(deudaAntesOpt) || 0) * 100) / 100;
  let gastadoArs = 0, gastadoUsd = 0, mamaUsd = 0, mioUsd = 0, pagadoUsd = 0, recibidoUsd = 0;
  for (const e of entradas) {
    const t = stripAccents(e.tipo);
    const esMama = stripAccents(e.quien).indexOf('mama') >= 0;
    if (t === 'gasto') {
      gastadoArs += e.ars || 0;
      gastadoUsd += e.usd || 0;
      if (esMama) mamaUsd += e.usd || 0; else mioUsd += e.usd || 0;
    } else if (t === 'carga') {
      if (esMama) mamaUsd += e.usd || 0; else mioUsd += e.usd || 0;
    } else if (t === 'pago') {
      pagadoUsd += e.usd || 0;
    } else if (t === 'transferencia') {
      recibidoUsd += e.usd || 0;
    }
  }
  return {
    gastadoArs: Math.round(gastadoArs),
    gastadoUsd: r2(gastadoUsd),
    pusoMamaUsd: r2(mamaUsd),
    pusoMioUsd: r2(mioUsd),
    pagadoUsd: r2(pagadoUsd),
    recibidoUsd: r2(recibidoUsd),
    deudaAntesUsd: deudaAntes,
    deudaUsd: r2(deudaAntes + mamaUsd - pagadoUsd)
  };
}

const mapMov = (x) => ({
  row: x.id, fecha: x.fecha || '', tipo: x.tipo || '', detalle: x.detalle || '',
  usd: x.usd, cotiz: x.cotizacion, ars: x.monto_local, quien: x.quien || '', categoria: x.categoria || '',
  // Orden de carga para desempatar (no sale al cliente): lo cargado acá va después de lo importado del Sheet.
  ord: x.src_row != null ? x.src_row : 1e9 + x.id
});

async function leerMovs(env, T, mes) {
  const r = await env.DB.prepare(`SELECT id, src_row, fecha, tipo, detalle, usd, cotizacion, monto_local, quien, categoria
                                  FROM foreign_movements WHERE tenant_id = ? AND mes = ? ORDER BY id`).bind(T, mes).all();
  return r.results.map(mapMov);
}
// null = el mes no tiene bloque; si lo tiene, la deuda de antes (puede ser null = 0).
async function leerBloque(env, T, mes) {
  const r = await env.DB.prepare(`SELECT deuda_antes_usd FROM foreign_months WHERE tenant_id = ? AND mes = ?`).bind(T, mes).first();
  return r ? { deudaAntes: r.deuda_antes_usd } : null;
}
// Deuda final (USD) del mes calendario anterior, o 0 si no existe o no tiene bloque (_argDeudaFinMesAnterior).
async function deudaFinMesAnterior(env, T, mes) {
  const prev = mesAnterior(mes);
  const blk = await leerBloque(env, T, prev);
  if (!blk) return 0;
  return totalesDe(await leerMovs(env, T, prev), blk.deudaAntes).deudaUsd || 0;
}
// Crea el bloque del mes si no existe, heredando la deuda del mes anterior (getOrCreateArgBlock).
async function asegurarBloque(env, T, mes) {
  const blk = await leerBloque(env, T, mes);
  if (blk) return blk;
  const heredada = (await deudaFinMesAnterior(env, T, mes)) || 0;
  await env.DB.prepare(`INSERT OR IGNORE INTO foreign_months (tenant_id, mes, deuda_antes_usd) VALUES (?, ?, ?)`).bind(T, mes, heredada).run();
  return { deudaAntes: heredada };
}
const totalesDelMes = async (env, T, mes) => {
  const blk = await leerBloque(env, T, mes);
  return totalesDe(await leerMovs(env, T, mes), blk && blk.deudaAntes);
};
const ordenarPorFechaDesc = (filas) => filas.slice().sort((a, b) => {
  const fa = a.fecha || '', fb = b.fecha || '';
  if (fa !== fb) return fb.localeCompare(fa);
  return (b.ord || 0) - (a.ord || 0);
});
const tipoValido = (raw) => TIPOS.find((t) => stripAccents(t) === stripAccents(raw));
const fechaIso = (f) => {
  const m = String(f).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCMonth() !== +m[2] - 1) throw new Error('Fecha inválida: ' + f);
  return m[0];
};

export const HANDLERS = {
  // Lee el mes entero: entradas (por fecha desc) + totales. Mes sin bloque -> exists:false.
  getArgentinaDataSafe: { escribe: false, run: async (env, T, [monthOpt]) => {
    let mes;
    try { mes = resolverMes(monthOpt); } catch (e) { return { ok: false, error: e.message }; }
    const tab = tabDe(mes);
    let blk = await leerBloque(env, T, mes);
    // El mes en curso siempre tiene bloque en Apps Script (ensureCurrentMonthTabs): se muestra con la
    // deuda heredada del mes anterior, sin persistir nada (se fija recién al cargar el primer movimiento).
    if (!blk && mes === hoy().slice(0, 7)) blk = { deudaAntes: await deudaFinMesAnterior(env, T, mes) };
    if (!blk) {
      return { ok: true, tab, exists: false, entradas: [], totales: totalesDe([]), tipos: TIPOS, quienes: QUIENES, categorias: categoriasOrdenadas() };
    }
    const raw = await leerMovs(env, T, mes);
    return { ok: true, tab, exists: true, entradas: ordenarPorFechaDesc(raw).map(({ ord, ...e }) => e), totales: totalesDe(raw, blk.deudaAntes),
             tipos: TIPOS, quienes: QUIENES, categorias: categoriasOrdenadas() };
  } },

  // p: { month, fecha, tipo, detalle, usd, cotiz, ars, quien, categoria }
  addArgentinaSafe: { escribe: true, run: async (env, T, [data]) => {
    const p = data || {};
    const tipo = tipoValido(String(p.tipo || '').trim());
    if (!tipo) throw new Error('Tipo inválido: usá Carga, Gasto, Pago o Transferencia');
    let usd = num(p.usd), cotiz = num(p.cotiz), ars = num(p.ars);

    if (tipo === 'Carga') {
      if (usd == null || usd <= 0) throw new Error('Una carga necesita el monto en USD');
      if (ars == null && cotiz != null) ars = Math.round(usd * cotiz);
      if (ars == null) throw new Error('Falta la cotización o los ARS que recibiste');
    } else if (tipo === 'Gasto') {
      if (ars == null || ars <= 0) throw new Error('Un gasto necesita el monto en ARS');
      if (cotiz == null || cotiz <= 0) throw new Error('Falta la cotización del dólar');
      if (usd == null) usd = r2(ars / cotiz);
    } else {
      // Pago y Transferencia: si mandaron pesos, mandan ellos (recalcula los USD); si no, el USD directo.
      if (ars != null && ars > 0) {
        if (cotiz == null || cotiz <= 0) throw new Error('Falta la cotización del dólar');
        usd = r2(ars / cotiz);
      }
      if (usd == null || usd <= 0) {
        throw new Error(tipo === 'Pago'
          ? 'Un pago necesita el monto, en pesos (+ cotización) o en USD'
          : 'Una transferencia necesita el monto, en pesos (+ cotización) o en USD');
      }
    }

    const fecha = p.fecha ? fechaIso(p.fecha) : hoy();
    const mes = p.month ? resolverMes(p.month) : fecha.slice(0, 7);
    const q = String(p.quien || '').trim();
    const quien = QUIENES.find((x) => stripAccents(x) === stripAccents(q)) || (tipo === 'Pago' ? 'Mamá' : 'Mía');

    await asegurarBloque(env, T, mes);
    const r = await env.DB.prepare(`INSERT INTO foreign_movements (tenant_id, mes, tab, fecha, tipo, detalle, usd, cotizacion, monto_local, quien, categoria)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(T, mes, tabDe(mes), fecha, tipo, String(p.detalle || '').trim(), usd, cotiz, ars, quien, tipo === 'Gasto' ? String(p.categoria || '').trim() : '').run();
    const totales = await totalesDelMes(env, T, mes);
    return { ok: true, tab: tabDe(mes), row: r.meta.last_row_id, totales,
             written: { tipo, detalle: p.detalle || '', usd, cotiz, ars, quien } };
  } },

  // Edita una entrada existente; solo pisa los campos que llegan.
  updateArgentinaSafe: { escribe: true, run: async (env, T, [data]) => {
    const p = data || {};
    const row = parseInt(p.row, 10);
    if (!Number.isFinite(row)) throw new Error('Fila inválida');
    const mes = resolverMes(p.month);
    const tab = tabDe(mes);
    const cur = await env.DB.prepare(`SELECT * FROM foreign_movements WHERE tenant_id = ? AND mes = ? AND id = ?`).bind(T, mes, row).first();
    if (!cur) {
      if (!(await leerBloque(env, T, mes))) throw new Error('Esta hoja no tiene sección de Argentina');
      throw new Error('Esa fila está vacía — recargá y probá de nuevo');
    }

    const tipoRaw = String(p.tipo || '').trim();
    const tipo = tipoRaw ? (tipoValido(tipoRaw) || String(cur.tipo)) : String(cur.tipo);

    let usd, cotiz, ars;
    // Pago/transferencia con moneda explícita (p.monedaPago): se resuelve entero desde lo que mandaron.
    if ((tipo === 'Pago' || tipo === 'Transferencia') && (p.monedaPago === 'ARS' || p.monedaPago === 'USD')) {
      if (p.monedaPago === 'ARS') {
        ars = num(p.ars);
        cotiz = num(p.cotiz);
        if (ars == null || ars <= 0) throw new Error('Falta el monto en pesos');
        if (cotiz == null || cotiz <= 0) throw new Error('Falta la cotización del dólar');
        usd = r2(ars / cotiz);
      } else {
        usd = num(p.usd);
        if (usd == null || usd <= 0) throw new Error('Falta el monto en USD');
        ars = null;
        cotiz = null;
      }
    } else {
      usd = p.usd !== undefined && p.usd !== '' ? num(p.usd) : toNumber(cur.usd);
      cotiz = p.cotiz !== undefined && p.cotiz !== '' ? num(p.cotiz) : toNumber(cur.cotizacion);
      ars = p.ars !== undefined && p.ars !== '' ? num(p.ars) : toNumber(cur.monto_local);
    }
    // Un gasto se carga en pesos: si cambian pesos o cotización, los USD se recalculan. En las cargas viejas es al revés.
    if (tipo === 'Gasto' && ars != null && cotiz != null && cotiz > 0) {
      usd = r2(ars / cotiz);
    } else if (tipo === 'Carga' && usd != null && cotiz != null && (p.usd !== undefined || p.cotiz !== undefined) && p.ars === undefined) {
      ars = Math.round(usd * cotiz);
    }

    const fecha = p.fecha ? fechaIso(p.fecha) : (cur.fecha || null);
    await env.DB.prepare(`UPDATE foreign_movements SET fecha = ?, tipo = ?, detalle = ?, usd = ?, cotizacion = ?, monto_local = ?, quien = ?, categoria = ?
                          WHERE tenant_id = ? AND id = ?`)
      .bind(fecha, tipo,
        p.detalle !== undefined ? String(p.detalle).trim() : String(cur.detalle || ''),
        usd, cotiz, ars,
        p.quien !== undefined ? String(p.quien).trim() : String(cur.quien || ''),
        p.categoria !== undefined ? String(p.categoria).trim() : String(cur.categoria || ''),
        T, row).run();
    return { ok: true, tab, row, totales: await totalesDelMes(env, T, mes) };
  } },

  // Borra la entrada (los ids no se corren: no hace falta compactar como en el Sheet).
  deleteArgentinaSafe: { escribe: true, run: async (env, T, [data]) => {
    const p = data || {};
    const row = parseInt(p.row, 10);
    if (!Number.isFinite(row)) throw new Error('Fila inválida');
    const mes = resolverMes(p.month);
    const cur = await env.DB.prepare(`SELECT tipo, detalle FROM foreign_movements WHERE tenant_id = ? AND mes = ? AND id = ?`).bind(T, mes, row).first();
    if (!cur) {
      if (!(await leerBloque(env, T, mes))) throw new Error('Esta hoja no tiene sección de Argentina');
      throw new Error('Esa fila ya está vacía — recargá y probá de nuevo');
    }
    await env.DB.prepare(`DELETE FROM foreign_movements WHERE tenant_id = ? AND id = ?`).bind(T, row).run();
    return { ok: true, tab: tabDe(mes), deleted: String(cur.detalle || '') + ' (' + String(cur.tipo || '') + ')', totales: await totalesDelMes(env, T, mes) };
  } },

  // Fija la deuda que viene arrastrada de meses anteriores (setArgDeudaAntes; args: [mes, usd]).
  // El cliente del form no la llama hoy; está por paridad con Apps Script (acción argDeudaAntes).
  setArgDeudaAntes: { escribe: true, run: async (env, T, [monthOpt, usdRaw]) => {
    const mes = resolverMes(monthOpt);
    await asegurarBloque(env, T, mes);
    const usd = toNumber(String(usdRaw == null ? '' : usdRaw).replace(',', '.')) || 0;
    await env.DB.prepare(`UPDATE foreign_months SET deuda_antes_usd = ? WHERE tenant_id = ? AND mes = ?`).bind(usd, T, mes).run();
    return { ok: true, tab: tabDe(mes), deudaAntesUsd: usd, totales: totalesDe(await leerMovs(env, T, mes), usd) };
  } }
};
