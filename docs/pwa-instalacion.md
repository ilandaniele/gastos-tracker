# Instalar la app con notificaciones

La app y los avisos viven en el Worker `gastos-app`:

```
https://gastos-app.ilandaniele.workers.dev/app
```

(El Worker viejo `gastos-habitos` ya no se usa: sus avisos, su cron y su PWA pasaron a `gastos-app`.)

---

## Agregarla a la pantalla de inicio (1 min)

1. Abrí esa dirección **en Safari** (tiene que ser Safari, no Chrome).
2. Tocá **Compartir** (el cuadradito con la flecha, abajo).
3. **Agregar a inicio** → **Agregar**.
4. Cerrá Safari y abrí la app **desde el ícono nuevo**.

Esto no es un detalle: iOS solo manda notificaciones a las webs agregadas a la
pantalla de inicio. Desde Safari no funciona.

Si todavía tenés el ícono de la app vieja (la de `gastos-habitos`), borralo: sus
suscripciones ya no sirven.

---

## Activar los avisos (10 segundos)

1. Abrí la app desde el ícono.
2. En la pantalla de inicio tocá **Avisos** (también se llega con `/avisos`).
3. Tocá el botón para activarlos. iOS pregunta si permitís notificaciones → **Permitir**.
4. Tocá **Mandarme un aviso de prueba** para confirmar que llega.

---

## Cómo se va a comportar

Para todas las cuentas, según la hora local de la cuenta:

- **07:00** — "Tareas de hoy": las citas y tareas de hoy y las vencidas, solo si hay alguna pendiente.
- **Día 1, 09:00** — el reporte mensual.

Solo para la cuenta del dueño (`ilan`), además:

- **09:00** — si no anotaste a qué hora te levantaste, te lo recuerda.
- **23:00, 00:00, 01:00 y 02:00** — si no cerraste el día, "Cerrá el día" con lo que falta.
  Apenas cargás, deja de insistir.
- Los mails de tareas (07:00) y del reporte mensual (día 1), si hay proveedor de mail configurado.

Tocás la notificación y se abre la app directo.

Los horarios se calculan en la zona horaria de cada cuenta (Montevideo es UTC-3). El cron
corre cada 15 minutos (`[triggers]` en `worker/wrangler.toml`); la lógica de qué se manda y
cuándo está en `tiposPara` y `tickPush` de `worker/src/push.js`. Se cambian ahí y se
vuelve a publicar con `npx wrangler deploy` desde `worker/`.

---

## Probar sin esperar a la noche

- Botón **Mandarme un aviso de prueba** en `/avisos` (máximo uno por minuto).
- Para ver cómo le fue al último tick y qué suscripciones hay, con la sesión abierta
  (solo la cuenta del dueño): `https://gastos-app.ilandaniele.workers.dev/api/push/diag`.
- Para disparar un tick a mano: `POST /api/push/tick` con el encabezado `X-Sync-Key: <APP_KEY>`.

---

## Si algo no anda

**No llega ninguna notificación**
Casi siempre es lo mismo: la suscripción se hizo desde Safari y no desde la app
instalada. En iOS solo reciben push las webs agregadas a la pantalla de inicio;
desde Safari te deja suscribirte igual, el servidor no ve ningún error, y no
llega nada nunca.

Abrí la app **desde el ícono**, andá a Avisos y activalos de nuevo. Si el aviso de
prueba llega pero los programados no, mirá `/api/push/diag`: ahí figura el último tick.

Si el push llegó pero no viste la notificación, revisá Modo Concentración o los permisos.

**"No se pudo activar"**
Revisá Ajustes → Notificaciones → Gastos, que estén permitidas.

---

## Volver a publicar cambios

Desde `worker/`, con el token de Cloudflare en el ambiente:

```bash
export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
```

---

## Secretos

`gastos-app` (`worker/`): `APP_KEY`, `VIEW_KEY`, `GEMINI_API_KEY`, `VAPID_PRIVATE_JWK`
(la clave pública `VAPID_PUBLIC_KEY` está en `worker/wrangler.toml`).

---

## Qué guarda cada parte

Los datos viven en D1 (Worker `gastos-app`); ese Worker sirve el formulario, la API y los
avisos. Las suscripciones de push (una dirección larga que le dice a Apple a qué teléfono
avisar) están en la tabla `push_subs`. Apps Script y el Sheet ya no están en el camino:
quedan como referencia y respaldo (ver "Apagar Apps Script" en
`docs/AUDITORIA-migracion.md`).
