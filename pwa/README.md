# App con notificaciones (PWA + Web Push)

Esto convierte la app de gastos y hábitos en una app de verdad en el iPhone:
ícono propio en la pantalla de inicio, pantalla completa sin barra de Safari, y
**notificaciones push que manda el servidor**, no una automatización del
teléfono.

## Cómo encaja con el resto

Hay dos Workers de Cloudflare:

| Worker | Carpeta | Qué hace |
|--------|---------|----------|
| `gastos-app` | `worker/` | Los datos (D1), el formulario en `/app`, la API de escritura `/api/rpc/<función>` y los avisos pendientes `/api/habit-pending` y `/api/tasks-pending`. Es la fuente de verdad. |
| `gastos-habitos` | `pwa/` (este) | El shell de la PWA, las suscripciones push, el envío del push y el cron compartido. |

**Este Worker ya no llama a Apps Script.** Para saber qué falta cargar le pregunta
a `gastos-app` por service binding (`GASTOS_APP`), sin pasar por internet ni por
Cloudflare Access, autenticándose con la clave compartida `APP_KEY` en el header
`X-Sync-Key` (solo GET y solo esas dos rutas de avisos). Los siete módulos
(gastos, ahorros, ingresos, tareas, hábitos, país y compras) tienen fuente `d1`.
Apps Script quedó como referencia (`Code.gs`) y como respaldo en el Sheet.

## Por qué hace falta un servidor aparte

Apps Script no puede mandar push: firmar una notificación necesita criptografía
de curva elíptica (ECDSA P-256) que Apps Script no tiene. Un Cloudflare Worker
sí, es gratis en el plan free, y de paso sirve la PWA y corre el cron.

## Qué hace el Worker

| Ruta | Para qué |
|------|----------|
| `/` | El shell de la PWA: pantalla de carga + el botón para activar avisos. Redirige a `https://gastos-app.ilandaniele.workers.dev/app` |
| `/manifest.webmanifest`, `/sw.js`, `/icon-*.png` | Lo que iOS necesita para tratarla como app |
| `/api/vapid` | La clave pública para suscribirse |
| `/api/subscribe`, `/api/unsubscribe` | Guarda / borra la suscripción del navegador en KV |
| `/api/pending?modo=auto` | Le pregunta a `gastos-app` qué falta cargar de hábitos (`/api/habit-pending`) |
| `/api/pending?tipo=tareas` | Le pregunta a `gastos-app` las tareas/citas de hoy (`/api/tasks-pending`) |
| `/api/ack` | Acuse de recibo que manda el service worker del teléfono |
| `/api/diag?key=<ADMIN_KEY>` | Suscripciones, últimos crons y últimas consultas |
| `/api/test?key=<ADMIN_KEY>` | Disparar un aviso a mano, para probar (agregá `&tipo=tareas` para forzar el de tareas) |

### El shell ya no embebe el formulario

Antes el shell mostraba la app de Apps Script adentro de un iframe. Ahora el
formulario lo sirve `gastos-app` en `/app` y manda `frame-ancestors 'none'`, así
que **no se puede meter en un iframe**: el shell navega directo a
`https://gastos-app.ilandaniele.workers.dev/app`.

Si este Worker tiene el secreto `VIEW_KEY` (la misma clave de visor que
`gastos-app`), el shell va a `/?key=<VIEW_KEY>&next=/app`: `gastos-app` deja la
cookie de sesión y entra al formulario. Hace falta porque iOS guarda las cookies
de la app instalada aparte de las de Safari, y desde la app instalada no se puede
tipear una URL con `?key=`.

## Cuándo manda push

El cron es **uno solo para los dos Workers**: `*/15 * * * *` (la cuenta gratis de
Cloudflare permite 5 crons y estaban usados). En cada corrida sincroniza D1
llamando a `POST /api/sync` de `gastos-app`; como todos los módulos están en `d1`,
ese endpoint contesta `{omitido}` y no toca Apps Script ni escribe nada. Los
avisos push salen solo al minuto 0 de estas horas (en UTC; Montevideo es UTC-3 todo el año):

| UTC | Montevideo | Aviso |
|-----|------------|-------|
| 2, 3, 4, 5 | 23, 00, 01, 02 | Cierre del día (hábitos), **solo si falta algo** |
| 10 | 07:00 | Tareas y citas del día, **solo si hay pendientes** |
| 12 | 09:00 | A qué hora te levantaste, solo si falta |

Si ya cargaste, no manda nada: la insistencia se apaga sola. El aviso de tareas
de las 09:00 (12 UTC) ya no existe; pasó a las 07:00.

## El push va vacío a propósito

Se manda un push sin contenido y el service worker, al recibirlo, le pregunta
al servidor qué falta y arma el texto. Mandar el texto adentro del push
obligaría a cifrarlo (RFC 8291: ECDH + HKDF + AES128GCM), que es la parte más
frágil de todo esto. Así solo hay que firmar el JWT de VAPID, y de paso el
texto siempre está actualizado al momento de mostrarse.

## Estructura

```
pwa/
  src/worker.js     rutas, KV, cron y consultas a gastos-app
  src/push.js       VAPID + envío del push
  src/ui.js         el shell HTML, el service worker y el manifest
  src/icon-*.png    iconos de la app
  wrangler.toml     configuración, cron y service binding GASTOS_APP
  vapid-keys.json   claves (NO va a git)
```

## Secretos que necesita el Worker

Se cargan con `npx wrangler secret put <NOMBRE>`:

- `ADMIN_KEY` — cualquier texto largo; protege `/api/test` y `/api/diag`
- `APP_KEY` — la **misma** que tiene `gastos-app`; autentica las consultas por el binding
- `VAPID_PRIVATE_JWK` — la privada, sale de `vapid-keys.json`
- `VAPID_PUBLIC_KEY` — la pública, sale de `vapid-keys.json`
- `VIEW_KEY` — opcional; la misma clave de visor que `gastos-app`, para que el shell
  deje la sesión puesta al entrar al formulario

Si `APP_KEY` es distinta en los dos Workers, las consultas devuelven
"gastos-app rechazó la clave".

## Probar local

```bash
npx wrangler dev --local
```

Los secretos locales van en `.dev.vars` (tampoco va a git). El binding
`GASTOS_APP` no existe en local, así que las rutas que consultan a `gastos-app`
se prueban ya publicadas con `/api/test?key=<ADMIN_KEY>`.

## Instalación

Ver `docs/pwa-instalacion.md`.
