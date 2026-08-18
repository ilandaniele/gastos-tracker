# Instalar la app con notificaciones

Todo el código ya está escrito y probado. Falta subirlo a una cuenta de
Cloudflare (gratis) y agregar la app a la pantalla de inicio del iPhone.

---

## Paso 1 — Cuenta de Cloudflare (2 min)

1. Entrá a **https://dash.cloudflare.com/sign-up**
2. Registrate con tu mail. No pide tarjeta.
3. Confirmá el mail.

El plan gratis alcanza de sobra: 100.000 requests por día y los cron incluidos.
Esto va a usar unos 200 por día.

---

## Paso 2 — Crear el token (2 min)

1. En el panel, arriba a la derecha, tu ícono → **My Profile**
2. Menú izquierdo → **API Tokens** → **Create Token**
3. Buscá la plantilla **Edit Cloudflare Workers** → **Use template**
4. Abajo de todo → **Continue to summary** → **Create Token**
5. Copiá el token (se muestra **una sola vez**)

Pasámelo por acá y yo hago el resto: creo el almacenamiento, subo las claves y
publico la app.

> El token solo da permiso sobre Workers. Cuando termine podés borrarlo desde
> la misma pantalla y la app sigue funcionando.

**¿Preferís hacerlo vos?** Con Node instalado, desde la carpeta `pwa`:
>
> ```bash
> npx wrangler login
> npx wrangler kv namespace create SUBS      # copiá el id al wrangler.toml
> npx wrangler secret put VAPID_PUBLIC_KEY   # pegá la de vapid-keys.json
> npx wrangler secret put VAPID_PRIVATE_JWK  # pegá el JSON de la privada
> npx wrangler secret put ADMIN_KEY          # cualquier texto largo
> npx wrangler deploy
> ```

---

## Paso 3 — Agregarla al iPhone (1 min)

Cuando esté publicada te paso una dirección tipo
`https://gastos-habitos.<tu-cuenta>.workers.dev`.

1. Abrila **en Safari** (tiene que ser Safari, no Chrome).
2. Tocá **Compartir** (el cuadradito con la flecha, abajo).
3. **Agregar a inicio** → **Agregar**.
4. Cerrá Safari y abrí la app **desde el ícono nuevo**.

Esto no es un detalle: iOS solo manda notificaciones a las webs agregadas a la
pantalla de inicio. Desde Safari no funciona, y la app te lo va a avisar si
entrás por ahí.

---

## Paso 4 — Activar los avisos (10 segundos)

1. Abrí la app desde el ícono.
2. Abajo a la derecha aparece **🔔 Activar avisos**. Tocalo.
3. iOS pregunta si permitís notificaciones → **Permitir**.

El botón desaparece. Listo.

---

## Cómo se va a comportar

- **23:00, 00:00, 01:00 y 02:00** — si no cerraste el día, te llega
  "🌙 Cerrá el día" con lo que falta. Apenas cargás, deja de insistir.
- **09:00** — si no anotaste a qué hora te levantaste, te lo recuerda.
- Tocás la notificación y se abre la app directo.

Los horarios están en `pwa/wrangler.toml`. Se cambian ahí y se vuelve a
publicar.

---

## Probar sin esperar a la noche

```
https://<tu-app>.workers.dev/api/test?key=<ADMIN_KEY>&force=1
```

Manda el push aunque no falte nada. Sin `force=1` respeta la lógica normal.

---

## Si algo no anda

**No llega ninguna notificación**
Abrí la app desde el ícono (no desde Safari) y fijate si volvió a aparecer el
botón 🔔: si iOS reinstaló la app, hay que suscribirse de nuevo.

**"No se pudo activar"**
Revisá Ajustes → Notificaciones → Gastos, que estén permitidas.

**La app abre pero se ve en blanco**
Es la app de Apps Script adentro; probá recargar. Si sigue, avisame y miro el
Worker.

---

## Lo que esto NO cambia

La app sigue siendo la misma de Apps Script y la planilla sigue siendo la misma.
El Worker no guarda ningún dato tuyo: solo la suscripción de push (una
dirección larga que le dice a Apple a qué teléfono avisar).
