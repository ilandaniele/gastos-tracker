# Acceso privado

Antes cualquiera con el link entraba a tus datos. Ahora hay dos puertas.

## 1. Login delante de la app

`https://gastos-habitos.ilandaniele.workers.dev` está protegida con Cloudflare
Access. Antes de ver nada pide identificarte, y la única cuenta permitida es
**ilan.daniele@gmail.com**. La sesión dura **30 días**, así que en el celular lo
hacés una vez y te olvidás.

Hoy el método es un **código por mail** (ponés tu mail, te llega un código de 6
dígitos). Para pasarlo al botón de **Iniciar sesión con Google** faltan unas
credenciales que tenés que crear vos — están los pasos abajo.

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

## Pasar el login a Google (5 min tuyos)

1. Entrá a **https://console.cloud.google.com/apis/credentials**
2. Arriba, elegí un proyecto o creá uno (nombre: `Gastos`).
3. Si te pide configurar la **pantalla de consentimiento**:
   - Tipo: **Externo** → Crear
   - Nombre de la app: `Gastos`, mail de asistencia: el tuyo → Guardar y continuar
   - Seguí hasta el final (no hace falta agregar permisos)
   - En **Usuarios de prueba**, agregá tu propio mail
4. **Credenciales** → **Crear credenciales** → **ID de cliente de OAuth**
5. Tipo de aplicación: **Aplicación web**. Nombre: `Cloudflare Access`
6. En **URI de redireccionamiento autorizados**, agregá exactamente esto:

```
https://ilandaniele.cloudflareaccess.com/cdn-cgi/access/callback
```

7. Crear → te muestra **ID de cliente** y **Secreto de cliente**.
8. Pasámelos y lo dejo andando en un minuto.

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
