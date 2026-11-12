# Multi-tenant: cuentas y login (paso 1)

El Worker (`worker/`) deja de tener un único dueño fijo. Cada cliente es un **tenant** con sus datos en D1
(todas las tablas ya llevaban `tenant_id`). El tenant `ilan` es el original y conserva su comportamiento.

## Modelo de cuentas (`migrations/0006_cuentas.sql`)

| Tabla | Qué guarda |
|---|---|
| `tenants` | `id` (`ilan` o `t_` + 12 hex), `email` único (minúsculas), `creado`, `pais`, `moneda`, `tz`, `onboarding_listo` |
| `login_tokens` | **hash** SHA-256 del token del mail, `email`, `expira` (15 min), `usado`, `ip` |
| `sesiones` | **hash** SHA-256 del `sid` de la cookie, `tenant_id`, `creado`, `expira` (30 días), `ua` |

Del token y del sid solo se guarda el hash: con la base a la vista no se puede entrar.

## Flujo de login (`src/cuentas.js`, rutas en `src/index.js`)

1. `GET /login`: página con un campo de mail (sin scripts, CSP estricta). `POST /login` (form o JSON, chequea `Origin`).
2. `pedirLink`: valida el mail, límite de 5 pedidos/hora por mail y 20/hora por IP, token de 32 bytes, lo manda por
   Resend. La respuesta es **idéntica** exista o no la cuenta; sin `RESEND_API_KEY` no manda nada y tampoco filtra el link.
3. `GET /auth/<token>`: **no canjea**. Muestra una página mínima (CSP estricta, sin scripts) con el botón "Entrar" y no toca D1
   (solo valida que el token tenga 64 hex), así los escáneres de mail y los prefetch no gastan el link. El botón hace
   `POST /auth/<token>` (chequea `Origin`; `Origin: null` o ajeno da 403), que canjea: un solo uso, atómico con
   `UPDATE ... WHERE usado = 0 AND expira > ahora`. Si el mail es nuevo crea el tenant (el login es también el alta).
   Crea la sesión y responde `303` a `/app` con la cookie `sid` (`HttpOnly; Secure; SameSite=Lax`). Link vencido, usado
   o mal formado: 400 con la página de login y un aviso.
4. `POST /logout`: borra la sesión.

### Continuar con Google (OAuth 2.0, authorization code + PKCE)

Solo está activo si existen `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`; sin ellos `/auth/google*` da 404 y el botón no se muestra.

1. `GET /auth/google`: genera `state` (32 bytes) y `code_verifier`, y redirige (302) a Google con `scope=openid email`,
   `code_challenge` S256 y `prompt=select_account`. state + verifier + timestamp viajan en la cookie `gstate`
   (`HttpOnly; Secure; SameSite=Lax; Path=/auth/google; Max-Age=600`), firmada con HMAC-SHA256 usando el client secret.
   No escribe en D1.
2. `GET /auth/google/callback`: compara el state de la URL con el de la cookie en tiempo constante, verifica la firma y la
   edad de la cookie, y la borra. Intercambia el `code` en el endpoint de token (con `client_secret` y `code_verifier`) y
   lee el `id_token` (llega directo por TLS: se chequea `iss`, `aud`, `exp`, `email_verified === true` y `email`, sin
   verificar la firma del JWT). Con el mail abre sesión igual que el magic link (`abrirSesion`: tenant por mail o
   nuevo `t_`+12 hex), pone la cookie `sid` y responde `303` a `/app`. Cualquier error da 400 con la página de login y un
   mensaje genérico; el detalle va solo a `console.error`.
3. Mismo mail = misma cuenta: entrar con Google como `ilan.daniele@gmail.com` da el tenant `ilan`.

Tenant por request: Access (JWT válido) o cookie `vk` → `ilan`; si no, cookie `sid` → tenant de la sesión (una sola
consulta con JOIN, ninguna si no hay cookie); si no, `/` y `/app` redirigen a `/login` y `/api/*` da 401.
Las rutas por clave `X-Sync-Key` (cron de la PWA) siguen siendo del tenant `ilan`.

Exclusivo de `ilan`: `/api/sync`, `/api/fuente` y `/api/informe/enviar` (el destino es su `MAIL_TO`). Las cuentas nuevas
nacen con todos los módulos en `d1` (`fuenteDefecto()` en `src/rpc/util.js`); `ilan` mantiene lo guardado en `settings`.

## Variables

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (secretos: `wrangler secret put ...`). OAuth client de tipo "Web application"
  con redirect URI autorizado `https://gastos-app.ilandaniele.workers.dev/auth/google/callback`. Si hay `APP_URL`, el
  redirect URI se arma con ese origen (tiene que estar registrado tal cual).
- `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`: **solo para tests locales** con un mock de Google (`--var` de `wrangler dev`);
  los valores por defecto son los de Google. Nunca en `wrangler.toml` ni en producción.
- `RESEND_API_KEY`, `MAIL_FROM` (secretos/vars): sin `RESEND_API_KEY` no sale ningún mail de login.
- `APP_URL` (opcional): base de los links del mail; si falta se usa el origen del request.
- `DEV_MOSTRAR_LINK=1`: **solo para desarrollo local** (`wrangler dev --var DEV_MOSTRAR_LINK:1`); devuelve el link en la
  respuesta. Nunca ponerla en `wrangler.toml` ni como secreto en producción.

## Lo que falta

- **Cloudflare Access**: eliminado de `gastos-app`. Quedan variables `ACCESS_*` en wrangler.toml (inofensivas).
- **Mail con dominio verificado**: el remitente de pruebas de Resend (`onboarding@resend.dev`) solo entrega al dueño
  de la cuenta. Hace falta un dominio verificado (SPF/DKIM) para mandar a clientes.
- **Onboarding y config por cuenta**: hecho (paso 2, ver MULTI-TENANT-PASO2.md). Cada cuenta elige país, moneda local,
  zona horaria, medios y categorías en `/onboarding`; la moneda no se cambia después. Las cuentas nuevas arrancan sin los
  accesos rápidos de ejemplo (son de Ilan) y sin los módulos Argentina y hábitos íntimos.
- **Personal de Ilan que sigue en el código**: presets de Accesos rápidos (comercios y montos de Uruguay), meta de agua,
  cotización de respaldo de 40 y textos del módulo Argentina. La cotización de monedas distintas de UYU/USD es null si no hay caché.
- **Límites y abuso**: alta abierta a cualquier mail; sin cuota de filas ni de requests por tenant; sin renovación
  deslizante de sesión; sin borrado de cuenta/exportación (se pide por mail, ver /privacidad); las IP se guardan ~2 h.
  Hecho: cuota diaria de Gemini por cuenta (`usarGemini` en `rpc/util.js`, fila `gemini_uso` en `settings`; 60 por día,
  600 para `ilan`, se cambia con la variable `GEMINI_LIMITE_DIA`; una foto pesa 4 y un texto 1).
- **Legal**: `/privacidad` y `/terminos` reescritas para clientes de cualquier país (retención, transferencias, menores,
  responsabilidad, ley uruguaya sin perjuicio del consumidor local). No las revisó un abogado: antes de cobrar, que las vea uno.
- **Plan pago de Workers/D1**: el plan gratis de D1 corta a las 100k filas escritas por día y 5M leídas; con clientes hay
  que pasar al plan Workers pago (lo contrata Ilan en el dashboard de Cloudflare).
- **Push y avisos por cuenta** (hecho, falta activar una clave): `src/push.js` + `src/pushsend.js`, migración 0008 (`push_subs`).
  La PWA de las cuentas nuevas es el propio `/app` (mismo origen que la cookie): `/manifest.webmanifest`, `/sw.js`, íconos y
  la página `/avisos` (link "🔔 Avisos" en el home). El push va SIN payload; el service worker pide el texto a
  `POST /api/push/aviso` con la sesión. El cron compartido de `gastos-habitos` llama cada 15 min a `POST /api/push/tick`
  (X-Sync-Key); ahí se mira la hora LOCAL de cada cuenta (`tenants.tz`): 07 h tareas y citas de hoy (solo si hay algo) y el
  día 1 a las 09 h el aviso del reporte mensual, una vez por dispositivo y día (`push_subs.ultimo`). Máximo 5 dispositivos por
  cuenta; un dispositivo avisa a la última cuenta que lo activó; el endpoint solo se acepta si es https de FCM, Mozilla, Apple
  o Windows (anti SSRF). `ilan` sigue con su KV y su Worker de la PWA. Sin `VAPID_PRIVATE_JWK` el tick no hace nada ni gasta D1.
  **Para activarlo**: `npx wrangler secret put VAPID_PRIVATE_JWK` en `worker/` con el contenido de la clave privada JWK (la
  pública ya está en `wrangler.toml`, `VAPID_PUBLIC_KEY`; la privada que corresponde se generó con `crypto.subtle.generateKey`
  ECDSA P-256 y la guarda quien la generó: si se pierde, se genera un par nuevo y se cambian las dos).
  Límites: iOS solo avisa a la app agregada a inicio; el reporte mensual por mail sigue siendo de `ilan` (falta dominio).
  Tests: `test/push.test.mjs` (16, contra `wrangler dev`) y `test/vapid.test.mjs` (firma ES256).
- **Prefetch de links**: resuelto. `GET /auth/<token>` no consume el token; el canje es un `POST` desde el botón.
- **Referrer-Policy**: las páginas y respuestas de login y `/auth/*` salen con `Referrer-Policy: same-origin`. Con `no-referrer`
  Chrome manda `Origin: null` en el POST same-origin de un `<form>` y el chequeo de Origin (que rechaza `null` y orígenes
  ajenos) cortaba el login. El link a Google lleva `rel="noreferrer"`. Ojo: `/app` sigue con `no-referrer`; si se le agrega
  un form de logout (`POST /logout`) va a pasar lo mismo y habrá que cambiarle la política a esa página.
- **Google sin rate limit**: el callback de Google no tiene límite propio (cada intento válido cuesta una llamada al token
  endpoint); el state firmado ya evita que se dispare sin pasar antes por `/auth/google`.
