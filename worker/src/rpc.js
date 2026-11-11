// API de escritura del Worker. Reemplaza, módulo por módulo, a las funciones de Apps Script
// que hoy llama el formulario con google.script.run: mismo nombre, mismos argumentos y
// misma forma de respuesta ({ ok, ... } / { ok:false, error }), para que el cliente pueda
// cambiar de backend con un adaptador y sin reescribirse.
//
// Fuente de verdad por módulo (tabla settings, clave fuente_<modulo>):
//   'sheet' (por defecto para 'ilan'; las cuentas nuevas arrancan en 'd1'): manda el Sheet. D1 es una copia que el sync pisa; acá no se escribe.
//   'd1': manda D1. El sync deja de tocar ese módulo y las escrituras se aceptan.
// Pasar un módulo a 'd1' es el corte de ese módulo (ver setFuente).

import * as compras from './rpc/compras.js';
import * as ahorros from './rpc/ahorros.js';
import * as ingresos from './rpc/ingresos.js';
import * as tareas from './rpc/tareas.js';
import * as habitos from './rpc/habitos.js';
import * as pais from './rpc/pais.js';
import * as gastos from './rpc/gastos.js';
import { fuenteDefecto } from './rpc/util.js';

// Un archivo por módulo en src/rpc/ (exporta MODULO y HANDLERS). Para sumar uno: importarlo acá,
// agregarlo a MODULES y listar sus grupos de sync en GRUPOS_DE_MODULO (sync.js).
const MODULES = [compras, ahorros, ingresos, tareas, habitos, pais, gastos];
export const MODULOS = MODULES.map((m) => m.MODULO);

export async function fuentes(env, tenant) {
  const r = await env.DB.prepare(`SELECT clave, valor FROM settings WHERE tenant_id = ? AND clave LIKE 'fuente_%'`).bind(tenant).all();
  const out = {};
  for (const m of MODULOS) out[m] = fuenteDefecto(tenant);
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

// Cada handler: (env, tenant, args) -> respuesta. `escribe: true` marca los que exigen fuente 'd1'.
const HANDLERS = {};
for (const m of MODULES) {
  for (const [nombre, h] of Object.entries(m.HANDLERS)) {
    if (nombre in HANDLERS) throw new Error('Handler duplicado: ' + nombre);
    HANDLERS[nombre] = { modulo: m.MODULO, ...h };
  }
}

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
