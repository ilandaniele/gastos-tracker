# Gastos Tracker

Sistema de registro y análisis de gastos personales (Uruguay). Entrada de gastos desde
el celular, dashboard en vivo, escaneo OCR de tickets y auto-clasificación por categoría.

> **Estado actual (2026-11):** nació sobre una Google Sheet + Apps Script, pero los datos
> viven ahora en **Cloudflare D1** y todo corre en dos Workers: `gastos-app` (`worker/`: datos,
> formulario en `/app`, API en `/api/rpc/<función>`) y `gastos-habitos` (`pwa/`: PWA, web push
> y el cron compartido). Apps Script y la Sheet quedan como referencia y respaldo; las
> secciones de abajo que los describen son el sistema original. Ver
> [`docs/AUDITORIA-migracion.md`](docs/AUDITORIA-migracion.md) (estado y checklist para
> apagar Apps Script) y [`pwa/README.md`](pwa/README.md).

## Componentes

Vigentes: Worker `gastos-app` (D1 + formulario + API), Worker `gastos-habitos` (PWA + push + cron).
Originales (hoy legacy):

- **Google Sheet** "Registro de gastos" — base de datos, una pestaña por mes.
- **Apps Script webhook** — backend + webapp mobile (corre en la nube de Google).
- **Webapp mobile** — formulario para agregar gastos + dashboard + scan de tickets.
- **Dashboard Cowork** — artifact HTML que lee la Sheet en vivo (charts, KPIs, top categoría).

## Estructura del repo

```
gastos-tracker/
├── README.md
├── .githooks/
│   └── pre-commit         # corta el commit si se cuela otro proyecto
├── worker/                # Worker gastos-app: D1, formulario /app, API /api/rpc
├── pwa/                   # Worker gastos-habitos: PWA, web push, cron
├── apps-script/
│   ├── Code.gs            # (legacy) código del webhook (pegar en el editor Apps Script)
│   └── appsscript.json    # manifest con los OAuth scopes
├── cowork/
│   └── dashboard.html     # fuente del artifact Cowork
└── docs/
    ├── CONTEXTO-sistema-gastos.md   # referencia completa (IDs, arquitectura, endpoints)
    ├── project-instructions.md      # custom instructions para entrada por chat
    └── ios-shortcut-setup.md        # atajo iOS alternativo
```

## Quick start (sistema original en Apps Script, legacy)

> El Apps Script y la Sheet viven en la nube de Google. Desde cualquier computadora:
> abrir la Sheet → **Extensions → Apps Script**. No hay que instalar nada local.

1. **Código**: pegar `apps-script/Code.gs` en el editor Apps Script de la Sheet.
2. **Manifest**: Project Settings → activar "Show appsscript.json" → pegar `apps-script/appsscript.json`.
3. **Deploy**: Deploy → New deployment → Web App → "Execute as: Me", "Anyone with link".
4. **Autorizar**: correr `autorizarUrlFetch` desde el editor → otorgar permisos.
   La pantalla de Google muestra los permisos con casillas sueltas: hay que
   marcarlas **todas**. Si queda destildada la de servicios externos, la planilla
   anda igual pero se caen el scan de tickets y los precios de las acciones.
   Esa misma función dice qué cuenta ejecuta y, si falta permiso, devuelve el
   link directo para otorgarlo. Para probar sin subir un ticket:
   `<WEBHOOK_URL>?action=testGemini`.
5. **API key Gemini** (para el scan OCR): obtener en aistudio.google.com/app/apikey →
   setear con `<WEBHOOK_URL>?action=setKey&key=TU_KEY`.
6. **Dashboard Cowork**: recrear el artifact desde `cowork/dashboard.html`.

### Después de clonar: activar el hook

```
git config core.hooksPath .githooks
```

`core.hooksPath` es configuración local y no viaja en el clone, así que hay que
correrlo una vez por copia del repo.

El hook corta el commit si se cuela algo de otro proyecto: una carpeta de primer
nivel que no está en la lista blanca, o un repo git anidado. Pasó dos veces —
`puntos/config.js` (del proyecto *tribunal*) y `cybersecmanage/` (un repo SAP
entero, 178 MB)— porque hay varias sesiones trabajando en paralelo bajo
`Desktop\Proyectos` y alguna escribe con el directorio equivocado.

Si agregás una carpeta de primer nivel que sí es de acá, sumala a `PERMITIDOS`
en [`.githooks/pre-commit`](.githooks/pre-commit) en el mismo commit.

Para el detalle completo —IDs, URLs, endpoints, gotchas, cómo redeployar— ver
[`docs/CONTEXTO-sistema-gastos.md`](docs/CONTEXTO-sistema-gastos.md).

## Funcionalidades

- Entrada rápida de gastos desde el celular (botones quick variables + fijos).
- Detección automática de gastos fijos (Alquiler, Luz, Antel…) → sobreescribe la fila correcta.
- Cotización USD automática vía GOOGLEFINANCE (cacheada 10 min).
- Escaneo OCR de tickets con Gemini Vision → items desglosados y editables antes de guardar.
- Auto-clasificación de gastos por categoría (regex).
- Dashboard con totales, breakdown por categoría/tarjeta, top categoría del mes.
- Auto-creación de la pestaña del mes desde un template.

## Notas

- La API key de Gemini se guarda en Script Properties (nube), no en el repo.
- El proyecto está en español.
