# App con notificaciones (PWA + Web Push)

Esto convierte la app de gastos y hábitos en una app de verdad en el iPhone:
ícono propio en la pantalla de inicio, pantalla completa sin barra de Safari, y
**notificaciones push que manda el servidor**, no una automatización del
teléfono.

## Por qué hace falta un servidor aparte

Apps Script no puede mandar push: firmar una notificación necesita criptografía
de curva elíptica (ECDSA P-256) que Apps Script no tiene. Un Cloudflare Worker
sí, es gratis en el plan free, y de paso sirve la PWA y corre el cron.

## Qué hace el Worker

| Ruta | Para qué |
|------|----------|
| `/` | El shell de la PWA: la app de Apps Script adentro de un iframe + el botón para activar avisos |
| `/manifest.webmanifest`, `/sw.js`, `/icon-*.png` | Lo que iOS necesita para tratarla como app |
| `/api/vapid` | La clave pública para suscribirse |
| `/api/subscribe` | Guarda la suscripción del navegador en KV |
| `/api/pending?modo=auto` | Le pregunta a Apps Script qué falta cargar |
| `/api/test?key=...` | Disparar un aviso a mano, para probar |

Y por cron (23, 00, 01, 02 y 09 de Montevideo) pregunta qué falta y manda el
push **solo si falta algo**. Si ya cargaste, no manda nada: la insistencia se
apaga sola.

## El push va vacío a propósito

Se manda un push sin contenido y el service worker, al recibirlo, le pregunta
al servidor qué falta y arma el texto. Mandar el texto adentro del push
obligaría a cifrarlo (RFC 8291: ECDH + HKDF + AES128GCM), que es la parte más
frágil de todo esto. Así solo hay que firmar el JWT de VAPID, y de paso el
texto siempre está actualizado al momento de mostrarse.

## Estructura

```
pwa/
  src/worker.js     rutas, KV y cron
  src/push.js       VAPID + envío del push
  src/ui.js         el shell HTML, el service worker y el manifest
  src/icon-*.png    iconos de la app
  wrangler.toml     configuración y horarios del cron
  vapid-keys.json   claves (NO va a git)
```

## Secretos que necesita el Worker

- `VAPID_PUBLIC_KEY` — la pública, sale de `vapid-keys.json`
- `VAPID_PRIVATE_JWK` — la privada, sale de `vapid-keys.json`
- `ADMIN_KEY` — cualquier texto largo; protege `/api/test`

## Probar local

```bash
npx wrangler dev --local
curl "http://localhost:8787/api/pending?modo=noche"
```

Los secretos locales van en `.dev.vars` (tampoco va a git).

## Instalación

Ver `docs/pwa-instalacion.md`.
