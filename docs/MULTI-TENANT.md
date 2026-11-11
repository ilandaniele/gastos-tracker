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

Tenant por request: Access (JWT válido) o cookie `vk` → `ilan`; si no, cookie `sid` → tenant de la sesión (una sola
consulta con JOIN, ninguna si no hay cookie); si no, `/` y `/app` redirigen a `/login` y `/api/*` da 401.
Las rutas por clave `X-Sync-Key` (cron de la PWA) siguen siendo del tenant `ilan`.

Exclusivo de `ilan`: `/api/sync`, `/api/fuente` y `/api/informe/enviar` (el destino es su `MAIL_TO`). Las cuentas nuevas
nacen con todos los módulos en `d1` (`fuenteDefecto()` en `src/rpc/util.js`); `ilan` mantiene lo guardado en `settings`.

## Variables

- `RESEND_API_KEY`, `MAIL_FROM` (secretos/vars): sin `RESEND_API_KEY` no sale ningún mail de login.
- `APP_URL` (opcional): base de los links del mail; si falta se usa el origen del request.
- `DEV_MOSTRAR_LINK=1`: **solo para desarrollo local** (`wrangler dev --var DEV_MOSTRAR_LINK:1`); devuelve el link en la
  respuesta. Nunca ponerla en `wrangler.toml` ni como secreto en producción.

## Lo que falta

- **Cloudflare Access**: hoy cubre todo el host con la política "Solo Ilan"; `/login` y `/auth/*` tienen que quedar
  fuera (bypass) o usar otro host para clientes, si no nadie más llega a la página.
- **Mail con dominio verificado**: el remitente de pruebas de Resend (`onboarding@resend.dev`) solo entrega al dueño
  de la cuenta. Hace falta un dominio verificado (SPF/DKIM) para mandar a clientes.
- **Onboarding**: `onboarding_listo = 0` no dispara nada todavía (país, moneda, zona horaria, medios de pago, categorías).
- **Config que sigue siendo de Ilan** (código, no por tenant): medios de pago (`CARDS` en `rpc/gastos.js`; un tenant
  nuevo solo puede usar esos), categorías y reglas (`form-config.json`), zona horaria `America/Montevideo`
  (`rpc/util.js`, `pending.js`, `form`), meta de agua, cotización UYU/USD.
- **Límites y abuso**: alta abierta a cualquier mail; sin cuotas por tenant (filas, requests); sin renovación
  deslizante de sesión; sin borrado de cuenta/exportación; las IP se guardan ~2 h (limpieza oportunista).
- **Push y avisos por tenant**: el cron de la PWA y el push diario solo atienden a `ilan`; informes por mail también.
- **Prefetch de links**: resuelto. `GET /auth/<token>` no consume el token; el canje es un `POST` desde el botón.
