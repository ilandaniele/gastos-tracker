// API de escritura del Worker. Reemplaza, módulo por módulo, a las funciones de Apps Script
// que hoy llama el formulario con google.script.run: mismo nombre, mismos argumentos y
// misma forma de respuesta ({ ok, ... } / { ok:false, error }), para que el cliente pueda
// cambiar de backend con un adaptador y sin reescribirse.
//
// Fuente de verdad por módulo (tabla settings, clave fuente_<modulo>):
//   'sheet' (por defecto): manda el Sheet. D1 es una copia que el sync pisa; acá no se escribe.
//   'd1': manda D1. El sync deja de tocar ese módulo y las escrituras se aceptan.
// Pasar un módulo a 'd1' es el corte de ese módulo (ver setFuente).

export const MODULOS = ['compras'];

const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date());

export async function fuentes(env, tenant) {
  const r = await env.DB.prepare(`SELECT clave, valor FROM settings WHERE tenant_id = ? AND clave LIKE 'fuente_%'`).bind(tenant).all();
  const out = {};
  for (const m of MODULOS) out[m] = 'sheet';
  for (const f of r.results) out[f.clave.slice(7)] = f.valor === 'd1' ? 'd1' : 'sheet';
  return out;
}

export async function setFuente(env, tenant, modulo, fuente) {
  if (!MODULOS.includes(modulo)) throw new Error('Módulo desconocido: ' + modulo);
  if (fuente !== 'd1' && fuente !== 'sheet') throw new Error('Fuente inválida');
  await env.DB.prepare(`INSERT INTO settings (tenant_id, clave, valor) VALUES (?, ?, ?)
                        ON CONFLICT (tenant_id, clave) DO UPDATE SET valor = excluded.valor`)
    .bind(tenant, 'fuente_' + modulo, fuente).run();
}

const falla = (m) => ({ ok: false, error: m });
const idDe = (d) => { const n = parseInt(d && (d.row != null ? d.row : d.id), 10); if (!Number.isFinite(n) || n < 1) throw new Error('Fila inválida'); return n; };

// Cada handler: (env, tenant, args) -> respuesta. `escribe` marca los que exigen fuente 'd1'.
const HANDLERS = {
  // ---- Compras --------------------------------------------------------------
  getComprasSafe: { modulo: 'compras', escribe: false, run: async (env, T) => {
    const r = await env.DB.prepare(`SELECT id, creada, texto, comprado, fecha_comprado FROM purchases WHERE tenant_id = ? ORDER BY id`).bind(T).all();
    return { ok: true, tab: 'Compras', items: r.results.map((x) => ({ row: x.id, creada: x.creada || '', texto: x.texto, comprado: !!x.comprado, fechaComprado: x.fecha_comprado || '' })) };
  } },
  addCompraSafe: { modulo: 'compras', escribe: true, run: async (env, T, [d]) => {
    const texto = String((d && d.texto) || '').trim();
    if (!texto) throw new Error('Falta el texto');
    const r = await env.DB.prepare(`INSERT INTO purchases (tenant_id, creada, texto, comprado) VALUES (?, ?, ?, 0)`).bind(T, hoy(), texto.slice(0, 120)).run();
    return { ok: true, tab: 'Compras', row: r.meta.last_row_id, texto };
  } },
  toggleCompraSafe: { modulo: 'compras', escribe: true, run: async (env, T, [d]) => {
    const id = idDe(d);
    const comprado = d.comprado === true || String(d.comprado) === 'true';
    const r = await env.DB.prepare(`UPDATE purchases SET comprado = ?, fecha_comprado = ? WHERE tenant_id = ? AND id = ?`)
      .bind(comprado ? 1 : 0, comprado ? hoy() : null, T, id).run();
    if (!r.meta.changes) throw new Error('Ese ítem ya no existe — recargá la lista');
    return { ok: true, tab: 'Compras', row: id, comprado };
  } },
  deleteCompraSafe: { modulo: 'compras', escribe: true, run: async (env, T, [d]) => {
    const id = idDe(d);
    await env.DB.prepare(`DELETE FROM purchases WHERE tenant_id = ? AND id = ?`).bind(T, id).run();
    return { ok: true, tab: 'Compras', row: id };
  } },
  clearBoughtComprasSafe: { modulo: 'compras', escribe: true, run: async (env, T) => {
    const r = await env.DB.prepare(`DELETE FROM purchases WHERE tenant_id = ? AND comprado = 1`).bind(T).run();
    return { ok: true, tab: 'Compras', borrados: r.meta.changes };
  } }
};

export const RPC_NOMBRES = Object.keys(HANDLERS);

export async function llamar(env, tenant, nombre, args) {
  const h = Object.prototype.hasOwnProperty.call(HANDLERS, nombre) ? HANDLERS[nombre] : null;
  if (!h) return falla('Función desconocida: ' + nombre);
  try {
    if (h.escribe) {
      const f = await fuentes(env, tenant);
      if (f[h.modulo] !== 'd1') return falla(`El módulo ${h.modulo} todavía lo maneja el Sheet: pasalo a D1 antes de escribir`);
    }
    return await h.run(env, tenant, Array.isArray(args) ? args : []);
  } catch (e) {
    return falla(String(e && e.message || e));
  }
}
