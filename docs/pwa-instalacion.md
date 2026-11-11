# Instalar la app con notificaciones

**Ya está publicada:**

```
https://gastos-habitos.ilandaniele.workers.dev
```

Falta un solo paso, en el iPhone.

---

## Agregarla a la pantalla de inicio (1 min)

1. Abrí esa dirección **en Safari** (tiene que ser Safari, no Chrome).
2. Tocá **Compartir** (el cuadradito con la flecha, abajo).
3. **Agregar a inicio** → **Agregar**.
4. Cerrá Safari y abrí la app **desde el ícono nuevo**.

Esto no es un detalle: iOS solo manda notificaciones a las webs agregadas a la
pantalla de inicio. Desde Safari no funciona, y la app te lo va a avisar si
entrás por ahí.

---

## Activar los avisos (10 segundos)

1. Abrí la app desde el ícono.
2. Abajo a la derecha aparece **🔔 Activar avisos**. Tocalo.
3. iOS pregunta si permitís notificaciones → **Permitir**.

El botón desaparece. Listo.

---

## Cómo se va a comportar

- **23:00, 00:00, 01:00 y 02:00** — si no cerraste el día, te llega
  "🌙 Cerrá el día" con lo que falta. Apenas cargás, deja de insistir.
- **07:00** — "🗓️ Tareas de hoy": las citas y tareas de hoy y las vencidas, solo
  si hay alguna pendiente.
- **09:00** — si no anotaste a qué hora te levantaste, te lo recuerda.
- Tocás la notificación y se abre la app directo.

Los horarios están en UTC (Montevideo es UTC-3): 2, 3, 4 y 5 = 23 a 02; 10 = 07:00;
12 = 09:00. El cron corre cada 15 minutos y es compartido con la sincronización de
D1; la lista de horas de aviso está en `scheduled()` de `pwa/src/worker.js` y el
cron en `pwa/wrangler.toml`. Se cambian ahí y se vuelve a publicar con
`npx wrangler deploy`.

---

## Probar sin esperar a la noche

La clave de administración está en `pwa/.secrets-local.md` (no va a git):

```
https://gastos-habitos.ilandaniele.workers.dev/api/test?key=<ADMIN_KEY>&force=1
```

Manda el push aunque no falte nada. Sin `force=1` respeta la lógica normal:
si ya cargaste, no manda.

Para ver qué considera pendiente:

```
https://gastos-habitos.ilandaniele.workers.dev/api/pending?modo=noche
```

---

## Si algo no anda

**No llega ninguna notificación**
Casi siempre es lo mismo: la suscripción se hizo desde Safari y no desde la app
instalada. En iOS solo reciben push las webs agregadas a la pantalla de inicio;
desde Safari te deja suscribirte igual, el servidor no ve ningún error, y no
llega nada nunca.

Abrí la app **desde el ícono** y tocá 🔔 de nuevo. Para confirmar que el
teléfono la está recibiendo:

```
https://gastos-habitos.ilandaniele.workers.dev/api/diag?key=<ADMIN_KEY>
```

- `suscripciones` debería decir 1, y la suscripción tener `standalone: "1"`
- después de un aviso, en `consultas` tiene que aparecer un `ACK push` con la
  hora y el user agent del iPhone

Si aparece el ACK, el push llegó: si igual no viste la notificación, revisá
Modo Concentración o los permisos.

**"No se pudo activar"**
Revisá Ajustes → Notificaciones → Gastos, que estén permitidas.

**Al abrir la app aparece la pantalla de carga y después el formulario**
Es normal: el shell navega al formulario que sirve `gastos-app`
(`https://gastos-app.ilandaniele.workers.dev/app`). Ya no hay nada de Apps Script
en el medio, así que carga rápido. Si en cambio ves "No autorizado", el shell no
pudo dejar la sesión: falta el secreto `VIEW_KEY` en este Worker (tiene que ser el
mismo que tiene `gastos-app`) o se venció la cookie.

**"gastos-app rechazó la clave" en `/api/pending` o en `/api/test`**
`APP_KEY` es distinta en `gastos-habitos` y en `gastos-app`. Se vuelven a cargar
con `wrangler secret put APP_KEY` en las dos carpetas.

---

## Volver a publicar cambios

Desde `pwa/`, con el token de Cloudflare en el ambiente:

```bash
export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
```

---

## Secretos

`gastos-habitos` (`pwa/`): `ADMIN_KEY`, `APP_KEY`, `VAPID_PRIVATE_JWK`,
`VAPID_PUBLIC_KEY` y, opcional, `VIEW_KEY`. `gastos-app` (`worker/`): `APP_KEY`,
`VIEW_KEY`, `GEMINI_API_KEY`. `APP_KEY` tiene que ser idéntica en los dos.

---

## Qué guarda cada parte

Los datos viven en D1 (Worker `gastos-app`); ese Worker sirve el formulario y la
API. `gastos-habitos` no guarda ningún dato tuyo: solo la suscripción de push
(una dirección larga que le dice a Apple a qué teléfono avisar) y los últimos
registros de diagnóstico, en KV. Apps Script y el Sheet ya no están en el camino:
quedan como referencia y respaldo (ver "Apagar Apps Script" en
`docs/AUDITORIA-migracion.md`).
