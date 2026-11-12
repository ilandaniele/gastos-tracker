// Módulo ingresos. Contrato: ver src/rpc.js y src/rpc/compras.js (ejemplo completo).
// Porta getIngresosData (el cliente la llama sin "Safe"), addIngresoSafe y deleteIngresoSafe de Apps Script.
import { hoy, idDe, monedaLocal } from './util.js';

export const MODULO = 'ingresos';

const toNumber = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

function fechaISO(f) {
  const m = String(f).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('Fecha inválida');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('Fecha inválida');
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export const HANDLERS = {
  getIngresosData: { escribe: false, run: async (env, T) => {
    const r = await env.DB.prepare(`SELECT id, fecha, concepto, monto, moneda, notas FROM incomes
                                    WHERE tenant_id = ? AND fecha IS NOT NULL AND fecha <> '' ORDER BY id`).bind(T).all();
    return { ok: true, ingresos: r.results.map((x) => ({
      row: x.id, fecha: x.fecha, concepto: String(x.concepto || '').trim(), monto: x.monto || 0,
      moneda: String(x.moneda || monedaLocal(env)).toUpperCase(), notas: String(x.notas || '').trim()
    })) };
  } },

  addIngresoSafe: { escribe: true, run: async (env, T, [d]) => {
    const p = d || {};
    const fecha = fechaISO(p.fecha || hoy(env));
    const concepto = String(p.concepto || '').trim();
    if (!concepto) throw new Error('Falta el concepto');
    const monto = toNumber(String(p.monto == null ? '' : p.monto).replace(',', '.'));
    if (!monto || monto <= 0) throw new Error('Monto inválido');
    const L = monedaLocal(env);
    const mon = String(p.moneda || L).toUpperCase();
    const moneda = mon === 'USD' ? 'USD' : L;
    const notas = String(p.notas || '').trim();
    const r = await env.DB.prepare(`INSERT INTO incomes (tenant_id, fecha, concepto, monto, moneda, notas) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(T, fecha, concepto, monto, moneda, notas).run();
    return { ok: true, row: r.meta.last_row_id };
  } },

  deleteIngresoSafe: { escribe: true, run: async (env, T, [d]) => {
    const id = idDe(d || {});
    await env.DB.prepare(`DELETE FROM incomes WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
    return { ok: true };
  } }
};
