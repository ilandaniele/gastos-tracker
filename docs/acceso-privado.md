# Acceso privado

Antes cualquiera con el link entraba a tus datos. Ahora hay dos puertas.

## 1. Login delante de la app

`https://gastos-habitos.ilandaniele.workers.dev` está protegida con Cloudflare
Access. Antes de ver nada pide identificarte, y la única cuenta permitida es
**ilan.daniele@gmail.com**. La sesión dura **30 días**, así que en el celular lo
hacés una vez y te olvidás.

Hay dos formas de entrar:

- **Iniciar sesión con Google** — el botón de arriba, con tu cuenta.
- **Código por mail** — queda como respaldo por si Google falla.

## 2. Clave en la app de Apps Script

La app de adentro sigue publicada como "cualquiera con el link" (es lo único
que le permite contestarle al servidor de notificaciones sin sesión de Google),
pero ahora **exige una clave** que solo conoce la PWA. Entrar al link pelado
muestra "🔒 No autorizado".

La clave está en `pwa/.secrets-local.md` (no va a git).

### Qué se rompió con esto

- El **acceso directo viejo** del escritorio: ya apunta a la app nueva.
- Los **Atajos de iOS** que le peguen a la URL de Apps Script: hay que agregarles
  `&k=<clave>` al final de cada dirección. Si vas a usar la app con
  notificaciones, no los necesitás.

---

## Si Google te rechaza

La app de OAuth quedó en modo **Testing**, así que Google solo deja entrar a las
cuentas listadas como usuarios de prueba. Si al tocar el botón te dice que la
app no está verificada o que no tenés acceso:

1. Entrá a **https://console.cloud.google.com/auth/audience**
2. En **Usuarios de prueba**, agregá `ilan.daniele@gmail.com`

O tocá **Publicar app** en esa misma pantalla y listo (siendo el único usuario,
Google no pide verificación).

Mientras tanto siempre podés entrar con el código por mail.

---

## Si te quedás afuera

Entrá a **https://one.dash.cloudflare.com** con tu cuenta de Cloudflare →
Access → Applications → *Gastos*. Ahí podés cambiar las políticas o borrar la
aplicación (borrarla deja la app abierta de nuevo, pero la clave de Apps Script
sigue protegiendo los datos).

## Datos de la instalación

| Qué | Valor |
|-----|-------|
| App | `gastos-habitos.ilandaniele.workers.dev` |
| Dominio de login | `ilandaniele.cloudflareaccess.com` |
| Aplicación de Access | Gastos |
| Política | Solo `ilan.daniele@gmail.com` |
| Duración de sesión | 30 días |
