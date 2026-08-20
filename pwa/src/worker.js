// Worker de notificaciones para la app de gastos y hábitos.
//
// Hace tres cosas:
//   1. Sirve la PWA (el shell que envuelve la app de Apps Script en un iframe,
//      el manifest, el service worker y los iconos). Sin esto iOS no deja
//      mandar notificaciones: solo las manda a apps agregadas a inicio.
//   2. Guarda las suscripciones de push en KV.
//   3. Por cron pregunta a Apps Script si falta cargar algo y, si falta,
//      manda el push.
//
// El cron corre en UTC. Montevideo es UTC-3 todo el año, así que
// 2,3,4,5 UTC = 23, 00, 01, 02 local (el cierre del día) y 12 UTC = 09 local
// (la hora de levantarse).

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

// extra: parámetros sueltos que se le pasan tal cual a Apps Script (desde,
// hasta, date...). Sirve para probar franjas horarias sin tocar el código.
// La app de Apps Script está publicada como "cualquiera con el link" (es lo
// único que le permite responderle a este Worker sin sesión de Google), así que
// pide una clave. La clave vive acá como secreto y nunca sale al navegador
// salvo dentro del HTML que ya pasó por el login.
function appUrl(env, extraParams) {
  const url = new URL(env.APPS_SCRIPT_URL);
  if (env.APP_KEY) url.searchParams.set('k', env.APP_KEY);
  for (const [k, v] of Object.entries(extraParams || {})) url.searchParams.set(k, v);
  return url;
}

async function pending(env, modoRaw, extra) {
  const modo = modoRaw === 'auto' ? modoPorHora(horaLocal()) : (modoRaw || '');
  const url = appUrl(env);
  url.searchParams.set('action', 'habitPending');
  if (modo) url.searchParams.set('modo', modo);
  for (const [k, v] of Object.entries(extra || {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { redirect: 'follow', cf: { cacheTtl: 0 } });
  const data = await res.json();
  return { ...data, modoUsado: modo };
}

// Todo lo que no sea de control se reenvía a Apps Script
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
      return new Response(SHELL_HTML.replace('__APP_URL__', appUrl(env).toString()), {
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
      ctx.waitUntil(anotarConsulta(env, request));
      try {
        return json(await pending(env, url.searchParams.get('modo') || '', extraParams(url.searchParams)));
      } catch (e) {
        return json({ ok: false, error: String(e) }, 502);
      }
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
    if (p === '/api/test') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
        return json({ ok: false, error: 'no' }, 403);
      }
      const r = await avisar(env, url.searchParams.get('modo') || 'auto',
                             url.searchParams.get('force') === '1',
                             extraParams(url.searchParams));
      return json(r);
    }

    return new Response('No encontrado', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // El resultado del cron se guarda en KV: es la única forma de saber por qué
    // no llegó un aviso sin poder mirar los logs en vivo.
    ctx.waitUntil((async () => {
      let r;
      try {
        r = await avisar(env, 'auto', false);
      } catch (e) {
        r = { ok: false, excepcion: String(e && e.stack || e) };
      }
      try {
        const previo = (await env.SUBS.get('log:cron', 'json')) || [];
        previo.unshift({ cuando: new Date().toISOString(),
                         hora: new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo',
                                 hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()),
                         cron: event && event.cron, r });
        await env.SUBS.put('log:cron', JSON.stringify(previo.slice(0, 20)));
      } catch (e) {}
    })());
  }
};

// Manda el push si hay algo pendiente. force saltea el chequeo (para probar).
async function avisar(env, modo, force, extra) {
  let estado = null;
  if (!force) {
    try {
      estado = await pending(env, modo, extra);
    } catch (e) {
      return { ok: false, error: 'No se pudo consultar Apps Script: ' + String(e) };
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
