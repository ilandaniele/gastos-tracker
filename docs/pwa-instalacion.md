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
- **09:00** — si no anotaste a qué hora te levantaste, te lo recuerda.
- Tocás la notificación y se abre la app directo.

Los horarios están en `pwa/wrangler.toml`. Se cambian ahí y se vuelve a
publicar con `npx wrangler deploy`.

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

**La app abre pero se ve en blanco unos segundos**
Es normal: adentro carga la app de Apps Script, que tarda. Si queda en blanco
más de un minuto, avisame.

---

## Volver a publicar cambios

Desde `pwa/`, con el token de Cloudflare en el ambiente:

```bash
export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
```

---

## Lo que esto NO cambia

La app sigue siendo la misma de Apps Script y la planilla sigue siendo la misma.
El Worker no guarda ningún dato tuyo: solo la suscripción de push, que es una
dirección larga que le dice a Apple a qué teléfono avisar.
