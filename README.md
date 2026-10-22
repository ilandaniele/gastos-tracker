# Gastos Tracker

Sistema de registro y análisis de gastos personales (Uruguay), construido sobre una
Google Sheet + Apps Script. Entrada de gastos desde el celular, dashboard en vivo,
escaneo OCR de tickets y auto-clasificación por categoría.

## Componentes

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
├── apps-script/
│   ├── Code.gs            # código del webhook (pegar en el editor Apps Script)
│   └── appsscript.json    # manifest con los OAuth scopes
├── cowork/
│   └── dashboard.html     # fuente del artifact Cowork
└── docs/
    ├── CONTEXTO-sistema-gastos.md   # referencia completa (IDs, arquitectura, endpoints)
    ├── project-instructions.md      # custom instructions para entrada por chat
    └── ios-shortcut-setup.md        # atajo iOS alternativo
```

## Quick start

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
