// Avisos pendientes (hábitos y tareas) sobre D1. Port de habitPending / _habitPendingNoche /
// _habitPendingManana / tasksPending de Apps Script (Code.gs), con las mismas respuestas:
// las consumen el Worker de la PWA (gastos-habitos), su service worker y los atajos de iOS.
import { getHabitDay, parseHM } from './rpc/habitos.js';
import { leerTareas } from './rpc/tareas.js';
import { hoy } from './rpc/util.js';

export const WATER_GOAL_ML = 2400; // objetivo diario de agua
// Ventanas horarias para saber si ya comió, sin depender de la etiqueta (editable a mano).
const MEAL_WINDOWS = { desayuno: [5, 11.5], almuerzo: [11.5, 16], cena: [19, 24] };

const hayComida = (meals, win) => meals.some((m) => {
  const mm = parseHM(m.hora);
  if (mm == null) return false;
  const h = mm / 60;
  return h >= win[0] && h < win[1];
});

const ymdValido = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const unDiaAntes = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

// Fecha y hora de Montevideo. opts.date (YYYY-MM-DD) y opts.hora (HH:MM) permiten simular otro
// momento para probar (Apps Script no los tenía): sin ellos es el reloj real.
function ahoraMVD(opts) {
  const now = new Date();
  let hora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const o = opts && opts.hora != null ? parseHM(opts.hora) : null;
  if (o != null) hora = String(Math.floor(o / 60)).padStart(2, '0') + ':' + String(o % 60).padStart(2, '0');
  const fecha = opts && ymdValido(opts.date) ? opts.date : hoy();
  const [h, m] = hora.split(':').map(Number);
  return { fecha, hora, h, m, t: h + m / 60 };
}

const sinDatos = (base) => Object.assign(base, { pending: false, pendingNum: 0, title: '', msg: 'Sin datos' });

// Cierre del día. Entre medianoche y las 5 AM el día que se cierra es el de ayer.
async function noche(env, T, ahora) {
  const dateStr = ahora.h < 5 ? unDiaAntes(ahora.fecha) : ahora.fecha;
  const base = { ok: true, modo: 'noche', date: dateStr, hora: ahora.hora };
  const day = await getHabitDay(env, T, dateStr);
  if (!day || !day.ok) return sinDatos(base);
  const d = day.day || {};

  // El "levanté" de ese día se contesta a la mañana siguiente: de noche se pide el "acosté".
  const faltantes = [];
  if (!d.acoste) faltantes.push('a qué hora te acostaste');
  if (!d.ejercicio && !(d.ejercicioMin > 0)) faltantes.push('si fuiste al gimnasio');
  if (!d.medite) faltantes.push('si meditaste');
  if (!d.lei) faltantes.push('si leíste');
  if (d.abordajes == null) faltantes.push('a cuántas abordaste');
  if (d.mast == null) faltantes.push('el contador');

  const pending = faltantes.length > 0;
  return Object.assign(base, {
    pending,
    pendingNum: pending ? 1 : 0,
    count: faltantes.length,
    title: pending ? '🌙 Cerrá el día' : '🌙 Día cerrado',
    msg: pending
      ? 'Falta ' + faltantes.slice(0, 3).join(', ') +
        (faltantes.length > 3 ? ' y ' + (faltantes.length - 3) + ' cosa' + (faltantes.length - 3 > 1 ? 's' : '') + ' más' : '')
      : 'Todo cargado ✓',
    faltantes,
    dia: { acoste: d.acoste || '', levante: d.levante || '', ejercicio: d.ejercicio || '',
           medite: d.medite || '', lei: d.lei || '', abordajes: d.abordajes, mast: d.mast, avance: d.avance }
  });
}

// A la mañana lo único que falta preguntar es a qué hora se levantó.
async function manana(env, T, ahora) {
  const base = { ok: true, modo: 'manana', date: ahora.fecha, hora: ahora.hora };
  const day = await getHabitDay(env, T, ahora.fecha);
  if (!day || !day.ok) return sinDatos(base);
  const d = day.day || {};
  const pending = !d.levante;
  return Object.assign(base, {
    pending, pendingNum: pending ? 1 : 0, count: pending ? 1 : 0,
    title: pending ? '☀️ ¿A qué hora te levantaste?' : '☀️ Ya cargado',
    msg: pending ? 'Cargá la hora para que salga el cálculo de sueño' : 'Levantada cargada ✓',
    faltantes: pending ? ['a qué hora te levantaste'] : [],
    dia: { levante: d.levante || '', acoste: d.acoste || '' }
  });
}

// opts: { modo: 'noche'|'manana'|'' , desde, hasta, date, hora }
export async function habitPending(env, T, opts) {
  try {
    opts = opts || {};
    const ahora = ahoraMVD(opts);
    const tNow = ahora.t;
    const desde = opts.desde != null && opts.desde !== '' ? Number(opts.desde) : 9;   // no molestar antes
    const hasta = opts.hasta != null && opts.hasta !== '' ? Number(opts.hasta) : 23;  // ni después

    const modo = String(opts.modo || '').toLowerCase();
    if (modo === 'noche') return await noche(env, T, ahora);
    if (modo === 'manana' || modo === 'mañana') return await manana(env, T, ahora);

    const base = { ok: true, date: ahora.fecha, hora: ahora.hora };
    if (tNow < desde || tNow > hasta) {
      return Object.assign(base, { pending: false, pendingNum: 0, title: '', msg: 'Fuera de la franja horaria' });
    }
    const day = await getHabitDay(env, T, ahora.fecha);
    if (!day || !day.ok) return sinDatos(base);

    const d = day.day || {};
    const meals = day.meals || [];
    const waters = day.waters || [];
    const faltantes = [];

    // Sueño
    if (tNow >= 10 && !d.levante) faltantes.push('marcá a qué hora te levantaste');

    // Agua: ritmo esperado entre las 8 y las 22, con margen de un vaso para no ser molesto
    const totalAgua = waters.reduce((s, w) => s + (w.ml || 0), 0);
    const ini = 8, fin = 22;
    let esperado = 0;
    if (tNow > ini) esperado = Math.round(WATER_GOAL_ML * Math.min((tNow - ini) / (fin - ini), 1));
    if (totalAgua < esperado - 250) {
      const faltan = esperado - totalAgua;
      faltantes.push('vas ' + totalAgua + ' ml de agua, deberías ir por ' + esperado +
                     ' (te faltan ~' + Math.ceil(faltan / 250) + ' vasos)');
    }

    // Comidas: por la hora cargada, no por la etiqueta
    if (tNow >= 11.5 && !hayComida(meals, MEAL_WINDOWS.desayuno)) faltantes.push('no cargaste el desayuno');
    if (tNow >= 16 && !hayComida(meals, MEAL_WINDOWS.almuerzo)) faltantes.push('no cargaste el almuerzo');
    if (tNow >= 22 && !hayComida(meals, MEAL_WINDOWS.cena)) faltantes.push('no cargaste la cena');

    // Cierre del día
    if (tNow >= 21 && d.trabajo == null) faltantes.push('faltan las horas trabajadas');

    const pending = faltantes.length > 0;
    let title = '', msg = '';
    if (pending) {
      title = faltantes.length === 1 ? '🧘 Te falta algo' : '🧘 Te faltan ' + faltantes.length + ' cosas';
      msg = faltantes.map((f, i) => i === 0 ? f.charAt(0).toUpperCase() + f.slice(1) : f).join(' · ');
    } else {
      msg = 'Todo al día ✓';
    }
    return Object.assign(base, {
      pending,
      pendingNum: pending ? 1 : 0, // 1/0 para que el atajo lo compare fácil
      count: faltantes.length,
      title, msg, faltantes,
      agua: totalAgua, aguaEsperado: esperado, aguaObjetivo: WATER_GOAL_ML
    });
  } catch (err) {
    console.error('habitPending error:', String(err && err.message || err));
    return { ok: false, pending: false, pendingNum: 0, error: String(err && err.message || err) };
  }
}

// Citas de hoy (con hora, ordenadas), tareas con vencimiento hoy y lo vencido sin completar.
export async function digestHoy(env, T) {
  const hoyIso = hoy(env); // env.cfg.tz si viene (cuentas nuevas); sin cfg, Montevideo
  const filas = (await leerTareas(env, T)).filter((f) => !f.completada);
  const citasHoy = filas.filter((f) => f.tipo === 'Cita' && f.fecha === hoyIso)
    .sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
  const tareasHoy = filas.filter((f) => f.tipo === 'Tarea' && f.fecha === hoyIso);
  const vencidas = filas.filter((f) => f.fecha && f.fecha < hoyIso);
  return { hoy: hoyIso, citasHoy, tareasHoy, vencidas, total: citasHoy.length + tareasHoy.length + vencidas.length };
}

export async function tasksPending(env, T) {
  const { hoy: hoyIso, citasHoy, tareasHoy, vencidas, total } = await digestHoy(env, T);
  const partes = [];
  citasHoy.forEach((c) => partes.push('📅 ' + (c.hora ? c.hora + ' ' : '') + c.texto));
  tareasHoy.forEach((t) => partes.push('☐ ' + t.texto));
  vencidas.forEach((v) => partes.push('⚠️ ' + v.texto + (v.fecha ? ' (' + v.fecha + ')' : '')));
  return {
    ok: true, date: hoyIso, pendingNum: total > 0 ? 1 : 0,
    msg: partes.length ? partes.join(' · ') : 'Sin tareas para hoy',
    citasHoy, tareasHoy, vencidas
  };
}
