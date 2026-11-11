// Módulo Compras. Contrato: ver src/rpc.js. Cada handler: (env, tenant, args) -> respuesta.
import { hoy, idDe } from './util.js';

export const MODULO = 'compras';

export const HANDLERS = {
  // ---- Compras --------------------------------------------------------------
  getComprasSafe: { escribe: false, run: async (env, T) => {
    const r = await env.DB.prepare(`SELECT id, creada, texto, comprado, fecha_comprado FROM purchases WHERE tenant_id = ? ORDER BY id`).bind(T).all();
    return { ok: true, tab: 'Compras', items: r.results.map((x) => ({ row: x.id, creada: x.creada || '', texto: x.texto, comprado: !!x.comprado, fechaComprado: x.fecha_comprado || '' })) };
  } },
  addCompraSafe: { escribe: true, run: async (env, T, [d]) => {
    const texto = String((d && d.texto) || '').trim();
    if (!texto) throw new Error('Falta el texto');
    const r = await env.DB.prepare(`INSERT INTO purchases (tenant_id, creada, texto, comprado) VALUES (?, ?, ?, 0)`).bind(T, hoy(), texto.slice(0, 120)).run();
    return { ok: true, tab: 'Compras', row: r.meta.last_row_id, texto };
  } },
  toggleCompraSafe: { escribe: true, run: async (env, T, [d]) => {
    const id = idDe(d);
    const comprado = d.comprado === true || String(d.comprado) === 'true';
    const r = await env.DB.prepare(`UPDATE purchases SET comprado = ?, fecha_comprado = ? WHERE tenant_id = ? AND id = ?`)
      .bind(comprado ? 1 : 0, comprado ? hoy() : null, T, id).run();
    if (!r.meta.changes) throw new Error('Ese ítem ya no existe — recargá la lista');
    return { ok: true, tab: 'Compras', row: id, comprado };
  } },
  deleteCompraSafe: { escribe: true, run: async (env, T, [d]) => {
    const id = idDe(d);
    await env.DB.prepare(`DELETE FROM purchases WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
    return { ok: true, tab: 'Compras', row: id };
  } },
  clearBoughtComprasSafe: { escribe: true, run: async (env, T) => {
    const r = await env.DB.prepare(`DELETE FROM purchases WHERE tenant_id = ? AND comprado = 1`).bind(T).run();
    return { ok: true, tab: 'Compras', borrados: r.meta.changes };
  } }
};
