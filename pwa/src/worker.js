// Worker de notificaciones para la app de gastos y hábitos.
//
// Hace tres cosas:
//   1. Sirve la PWA (el shell que lleva a la app de gastos, el manifest, el
//      service worker y los iconos). Sin esto iOS no deja mandar
//      notificaciones: solo las manda a apps agregadas a inicio.
//   2. Guarda las suscripciones de push en KV.
//   3. Por cron le pregunta a gastos-app (service binding GASTOS_APP, datos en
//      D1) si falta cargar algo y, si falta, manda el push.
//
// El cron corre en UTC. Montevideo es UTC-3 todo el año, así que
// 2,3,4,5 UTC = 23, 00, 01, 02 local (el cierre del día), 12 UTC = 09 local
// (la hora de levantarse) y 10 UTC = 07 local (tareas y citas del día, ver
// avisarTareas()). El día 1 de cada mes a las 12 UTC sale además el reporte
// mensual de gastos (mail + push, ver avisarInforme()).

import { sendPush } from './push.js';
import { SHELL_HTML, SERVICE_WORKER, MANIFEST } from './ui.js';
import ICON192 from './icon-192.png';
import ICON512 from './icon-512.png';

const KEY_PREFIX = 'sub:';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// Hora de Montevideo sin depender de librerías de zona horaria
function horaLocal(d) {
  return parseInt(new Intl.DateTimeFormat('es-UY', {
    timeZone: 'America/Montevideo', hour: '2-digit', hour12: false
  }).format(d || new Date()), 10);
}

// De noche se pregunta por el cierre del día; a la mañana, por la hora de
// levantarse. El service worker manda modo=auto y decide el servidor, que es
// el único que sabe en qué franja estamos.
function modoPorHora(h) {
  if (h >= 22 || h < 5) return 'noche';
  if (h >= 5 && h < 12) return 'manana';
  return '';
}

// Pregunta a gastos-app por service binding (sin pasar por internet ni por Access):
// se autentica con la clave compartida APP_KEY en X-Sync-Key.
async function consultarApp(env, ruta, params) {
  if (!env.GASTOS_APP || !env.APP_KEY) throw new Error('Falta binding GASTOS_APP o APP_KEY');
  const url = new URL('https://gastos-app' + ruta);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await env.GASTOS_APP.fetch(url.toString(), { headers: { 'X-Sync-Key': env.APP_KEY } });
  const texto = await res.text();
  let data;
  try { data = JSON.parse(texto); } catch (e) { throw new Error('gastos-app ' + res.status + ': ' + texto.slice(0, 100)); }
  if (res.status === 401) throw new Error('gastos-app rechazó la clave (APP_KEY distinta en los dos Workers)');
  return data;
}

// Dónde lo manda el shell: el formulario que sirve gastos-app. Ese Worker manda
// X-Frame-Options/frame-ancestors 'none', así que no se puede embeber: el shell
// navega a él. Si este Worker tiene VIEW_KEY (la misma clave de visor de gastos-app),
// la usa para dejar la cookie de sesión en el primer paso (iOS guarda la cookie de la
// app instalada aparte de Safari, y desde acá no se puede tipear una URL con ?key=).
const APP_FORM_URL = 'https://gastos-app.ilandaniele.workers.dev/app';
function appUrl(env) {
  if (!env.VIEW_KEY) return APP_FORM_URL;
  const u = new URL('https://gastos-app.ilandaniele.workers.dev/');
  u.searchParams.set('key', env.VIEW_KEY);
  u.searchParams.set('next', '/app');
  return u.toString();
}

// extra: parámetros sueltos que se le pasan tal cual (desde, hasta, date...).
// Sirve para probar franjas horarias sin tocar el código.
async function pending(env, modoRaw, extra) {
  const modo = modoRaw === 'auto' ? modoPorHora(horaLocal()) : (modoRaw || '');
  const params = { ...(extra || {}) };
  if (modo) params.modo = modo;
  const data = await consultarApp(env, '/api/habit-pending', params);
  return { ...data, modoUsado: modo };
}

// Citas de hoy + tareas que vencen hoy + vencidas sin completar.
async function pendingTareas(env) {
  return await consultarApp(env, '/api/tasks-pending');
}

// Pide a gastos-app que mande el informe por mail (POST /api/informe/enviar). Sin proveedor de
// mail configurado en gastos-app contesta {ok:true, enviado:false} y no pasa nada.
async function pedirEnvio(env, tipo) {
  try {
    if (!env.GASTOS_APP || !env.APP_KEY) return { ok: false, error: 'Falta binding GASTOS_APP o APP_KEY' };
    const res = await env.GASTOS_APP.fetch('https://gastos-app/api/informe/enviar?tipo=' + encodeURIComponent(tipo),
      { method: 'POST', headers: { 'X-Sync-Key': env.APP_KEY } });
    const texto = await res.text();
    try { return JSON.parse(texto); } catch (e) { return { ok: false, status: res.status, body: texto.slice(0, 150) }; }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Todo lo que no sea de control se reenvía a gastos-app
function extraParams(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) {
    if (k === 'modo' || k === 'key' || k === 'force') continue;
    out[k] = v;
  }
  return out;
}

async function listarSubs(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: KEY_PREFIX, cursor });
    for (const k of page.keys) {
      const v = await env.SUBS.get(k.name, 'json');
      if (v && v.endpoint) out.push({ key: k.name, sub: v });
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  return out;
}

// Una suscripción se identifica por su endpoint. Guardarla por endpoint evita
// duplicados cuando la app vuelve a mandar la misma al abrirse.
async function claveDe(sub) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return KEY_PREFIX + hex.slice(0, 32);
}

async function anotarConsulta(env, request, que) {
  try {
    const bruto = await env.SUBS.get('log:pending', 'json');
    const previo = Array.isArray(bruto) ? bruto : [];
    previo.unshift({
      que: que || 'pending',
      hora: new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo',
              hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()),
      ua: (request.headers.get('user-agent') || '').slice(0, 90),
      pais: request.headers.get('cf-ipcountry') || ''
    });
    await env.SUBS.put('log:pending', JSON.stringify(previo.slice(0, 15)));
  } catch (e) {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      return new Response(SHELL_HTML.replace('__APP_URL__', () => appUrl(env)), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    if (p === '/sw.js') {
      return new Response(SERVICE_WORKER, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8',
                   'Service-Worker-Allowed': '/', 'Cache-Control': 'no-store' }
      });
    }

    if (p === '/manifest.webmanifest') {
      return new Response(JSON.stringify(MANIFEST), {
        headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' }
      });
    }

    if (p === '/icon-192.png' || p === '/icon-512.png') {
      const body = p === '/icon-192.png' ? ICON192 : ICON512;
      return new Response(body, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }
      });
    }

    if (p === '/api/vapid') {
      return new Response(env.VAPID_PUBLIC_KEY, {
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }
      });
    }

    if (p === '/api/subscribe' && request.method === 'POST') {
      const sub = await request.json();
      if (!sub || !sub.endpoint) return json({ ok: false, error: 'Falta endpoint' }, 400);
      const key = await claveDe(sub);
      // Se guarda con quién y cómo se suscribió: si el push no llega, lo
      // primero que hay que saber es si vino de la app instalada o de Safari.
      sub._meta = {
        ua: (request.headers.get('user-agent') || '').slice(0, 120),
        standalone: url.searchParams.get('standalone') || '',
        cuando: new Date().toISOString()
      };
      await env.SUBS.put(key, JSON.stringify(sub));
      return json({ ok: true });
    }

    if (p === '/api/unsubscribe' && request.method === 'POST') {
      const sub = await request.json();
      if (sub && sub.endpoint) await env.SUBS.delete(await claveDe(sub));
      return json({ ok: true });
    }

    if (p === '/api/pending') {
      // Se anota quién consulta: cuando llega un push, el service worker del
      // teléfono pega acá. Ver ese registro es la única forma de saber, desde
      // afuera, si el push llegó al teléfono y el service worker se despertó.
      ctx.waitUntil(anotarConsulta(env, request, url.searchParams.get('tipo') === 'tareas' ? 'pending tareas' : 'pending'));
      try {
        if (url.searchParams.get('tipo') === 'tareas') return json(await pendingTareas(env));
        return json(await pending(env, url.searchParams.get('modo') || '', extraParams(url.searchParams)));
      } catch (e) {
        return json({ ok: false, error: String(e) }, 502);
      }
    }

    // Aviso especial pendiente (el reporte mensual): el push va vacío, así que el cron deja en KV
    // qué mostrar y el service worker lo reclama acá. Se entrega una sola vez (se borra al leerlo),
    // para que el push de hábitos que sale a la misma hora siga mostrando lo suyo.
    if (p === '/api/aviso' && request.method === 'POST') {
      const aviso = await env.SUBS.get('aviso:informe', 'json');
      if (!aviso) return json({ ok: true });
      await env.SUBS.delete('aviso:informe');
      return json({ ok: true, ...aviso });
    }

    // Acuse de recibo del teléfono (lo llama el service worker)
    if (p === '/api/ack') {
      ctx.waitUntil(anotarConsulta(env, request, 'ACK ' + (url.searchParams.get('e') || '')));
      return json({ ok: true });
    }

    // Diagnóstico: qué pasó en los últimos crons y quién consultó
    if (p === '/api/diag') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
        return json({ ok: false, error: 'no' }, 403);
      }
      const subs = await listarSubs(env);
      return json({
        ok: true,
        ahora: new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo', dateStyle: 'short', timeStyle: 'short' }).format(new Date()),
        suscripciones: subs.length,
        cron: (await env.SUBS.get('log:cron', 'json')) || [],
        consultas: (await env.SUBS.get('log:pending', 'json')) || []
      });
    }

    // Disparo manual, para probar sin esperar a la noche:
    //   /api/test?key=<ADMIN_KEY>&modo=noche&force=1
    //   /api/test?key=<ADMIN_KEY>&tipo=tareas          (fuerza el aviso de tareas)
    if (p === '/api/test') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
        return json({ ok: false, error: 'no' }, 403);
      }
      if (url.searchParams.get('tipo') === 'tareas') {
        return json(await avisarTareas(env));
      }
      const r = await avisar(env, url.searchParams.get('modo') || 'auto',
                             url.searchParams.get('force') === '1',
                             extraParams(url.searchParams));
      return json(r);
    }

    return new Response('No encontrado', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // El cron corre cada 15 min (la cuenta gratis de Cloudflare permite solo 5 crons,
    // así que este se comparte): siempre sincroniza D1 vía gastos-app, y los avisos
    // push salen solo en los horarios de siempre (minuto 0 de 02, 03, 04, 05 y 12 UTC) y
    // el de tareas (minuto 0 de 10 UTC = 07:00 en Montevideo).
    ctx.waitUntil(sincronizarD1(env));
    ctx.waitUntil(tickPushCuentas(env));
    const t = new Date(event && event.scheduledTime ? event.scheduledTime : Date.now());
    const horaUTC = t.getUTCHours();
    if (!(t.getUTCMinutes() === 0 && [2, 3, 4, 5, 10, 12].indexOf(horaUTC) >= 0)) return;

    // El resultado del cron se guarda en KV: es la única forma de saber por qué
    // no llegó un aviso sin poder mirar los logs en vivo.
    ctx.waitUntil((async () => {
      // 10 UTC (07:00 local): solo el aviso de tareas/citas del día (y su mail, si hay proveedor).
      // Resto de las horas: el de hábitos (cierre del día de noche, "¿a qué hora te levantaste?"
      // a las 09:00); el día 1 a las 12 UTC antes sale el reporte mensual.
      let r = null, rt = null, ri = null, rm = null;
      if (horaUTC === 10) {
        try {
          rt = await avisarTareas(env);
        } catch (e) {
          rt = { ok: false, excepcion: String(e && e.stack || e) };
        }
        rm = await pedirEnvio(env, 'tareas');
      } else {
        if (horaUTC === 12 && t.getUTCDate() === 1) {
          try {
            ri = await avisarInforme(env, t);
          } catch (e) {
            ri = { ok: false, excepcion: String(e && e.stack || e) };
          }
          // Margen para que el teléfono reclame el aviso del reporte antes de que llegue el de hábitos.
          await new Promise((ok) => setTimeout(ok, 5000));
        }
        try {
          r = await avisar(env, 'auto', false);
        } catch (e) {
          r = { ok: false, excepcion: String(e && e.stack || e) };
        }
      }
      try {
        const previo = (await env.SUBS.get('log:cron', 'json')) || [];
        previo.unshift({ cuando: new Date().toISOString(),
                         hora: new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo',
                                 hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()),
                         cron: event && event.cron, r, rt, ri, rm });
        await env.SUBS.put('log:cron', JSON.stringify(previo.slice(0, 20)));
      } catch (e) {}
    })());
  }
};

// Le pide al Worker gastos-app (service binding GASTOS_APP) que actualice D1 desde
// el Sheet (vía Apps Script, mientras algún módulo siga con fuente 'sheet').
// Guarda el último resultado en KV (log:sync) para poder revisarlo.
async function sincronizarD1(env) {
  let r;
  try {
    if (!env.GASTOS_APP || !env.APP_KEY) r = { ok: false, error: 'Falta binding GASTOS_APP o APP_KEY' };
    else {
      const res = await env.GASTOS_APP.fetch('https://gastos-app/api/sync', { method: 'POST', headers: { 'X-Sync-Key': env.APP_KEY } });
      r = { ok: res.status === 200, status: res.status, body: (await res.text()).slice(0, 300) };
    }
  } catch (e) {
    r = { ok: false, error: String(e && e.message || e) };
  }
  try { await env.SUBS.put('log:sync', JSON.stringify({ cuando: new Date().toISOString(), r })); } catch (e) {}
  return r;
}

// Avisos push de las cuentas nuevas (multi-tenant): gastos-app mira la hora local de cada cuenta con suscripciones
// (tabla push_subs) y manda lo que corresponda. Las suscripciones de 'ilan' siguen siendo las del KV de este Worker.
async function tickPushCuentas(env) {
  let r;
  try {
    if (!env.GASTOS_APP || !env.APP_KEY) r = { ok: false, error: 'Falta binding GASTOS_APP o APP_KEY' };
    else {
      const res = await env.GASTOS_APP.fetch('https://gastos-app/api/push/tick', { method: 'POST', headers: { 'X-Sync-Key': env.APP_KEY } });
      r = { ok: res.status === 200, status: res.status, body: (await res.text()).slice(0, 300) };
    }
  } catch (e) {
    r = { ok: false, error: String(e && e.message || e) };
  }
  // Solo se guarda en KV si pasó algo (no ensucia el KV con un "nada" cada 15 minutos).
  try { if (r.ok && /"enviados":[1-9]|"errores":[1-9]/.test(r.body || '')) await env.SUBS.put('log:tick', JSON.stringify({ cuando: new Date().toISOString(), r })); } catch (e) {}
  return r;
}

// Manda el push si hay algo pendiente. force saltea el chequeo (para probar).
async function avisar(env, modo, force, extra) {
  let estado = null;
  if (!force) {
    try {
      estado = await pending(env, modo, extra);
    } catch (e) {
      return { ok: false, error: 'No se pudo consultar gastos-app: ' + String(e) };
    }
    // Si no falta nada, no se molesta. Es lo que hace que la insistencia se
    // apague sola cuando carga los datos.
    if (!estado || estado.pendingNum === 0) {
      return { ok: true, enviados: 0, motivo: 'nada pendiente', estado: estado };
    }
  }

  const subs = await listarSubs(env);
  let enviados = 0, borrados = 0;
  const errores = [];
  for (const { key, sub } of subs) {
    try {
      const r = await sendPush(sub, env);
      if (r.ok) enviados++;
      else if (r.gone) { await env.SUBS.delete(key); borrados++; }
      else errores.push(r.status);
    } catch (e) {
      errores.push(String(e));
    }
  }
  return { ok: true, enviados, borrados, suscripciones: subs.length,
           errores, estado: estado };
}

// Igual que avisar() pero para tareas/citas — sin franjas horarias ni force,
// porque solo se llama una vez al día (ver scheduled()). El push va vacío: el
// service worker del teléfono (ui.js) ve que son las 6-9 de la mañana y muestra
// '🗓️ Tareas de hoy' con el msg de /api/tasks-pending.
async function avisarTareas(env) {
  let estado;
  try {
    estado = await pendingTareas(env);
  } catch (e) {
    return { ok: false, error: 'No se pudo consultar gastos-app (tareas): ' + String(e) };
  }
  if (!estado || estado.pendingNum === 0) {
    return { ok: true, enviados: 0, motivo: 'nada pendiente', estado: estado };
  }

  const subs = await listarSubs(env);
  let enviados = 0, borrados = 0;
  const errores = [];
  for (const { key, sub } of subs) {
    try {
      const r = await sendPush(sub, env);
      if (r.ok) enviados++;
      else if (r.gone) { await env.SUBS.delete(key); borrados++; }
      else errores.push(r.status);
    } catch (e) {
      errores.push(String(e));
    }
  }
  return { ok: true, enviados, borrados, suscripciones: subs.length, errores, estado: estado };
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const INFORME_URL = 'https://gastos-app.ilandaniele.workers.dev/informe/mensual';

// Reporte mensual (día 1, 09:00 local): pide el mail a gastos-app (no hace nada sin proveedor de
// mail) y avisa por push. El push va vacío: el texto y el destino los deja en KV (aviso:informe)
// y el service worker los reclama en POST /api/aviso. El enlace abre el reporte del mes anterior.
async function avisarInforme(env, t) {
  const mail = await pedirEnvio(env, 'mensual');
  const prev = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
  const mes = MESES[prev.getUTCMonth()] + ' ' + prev.getUTCFullYear();
  await env.SUBS.put('aviso:informe', JSON.stringify({
    titulo: '📊 Reporte de gastos', cuerpo: 'Ya está el reporte de ' + mes, url: INFORME_URL
  }), { expirationTtl: 3600 });
  const subs = await listarSubs(env);
  let enviados = 0, borrados = 0;
  const errores = [];
  for (const { key, sub } of subs) {
    try {
      const r = await sendPush(sub, env);
      if (r.ok) enviados++;
      else if (r.gone) { await env.SUBS.delete(key); borrados++; }
      else errores.push(r.status);
    } catch (e) {
      errores.push(String(e));
    }
  }
  return { ok: true, mes, mail, enviados, borrados, suscripciones: subs.length, errores };
}
