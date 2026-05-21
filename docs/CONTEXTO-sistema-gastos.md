# Sistema de Gastos — Contexto Completo

> Documento de traspaso. Leé esto (o pasáselo a una sesión nueva de Claude) para
> retomar el proyecto desde cualquier computadora. Última actualización: Mayo 2026.

---

## 1. Qué es el sistema

Sistema de registro y análisis de gastos personales de Ilan (Uruguay), construido sobre
una Google Sheet existente llamada **"Registro de gastos"**. Tiene 4 componentes:

1. **Google Sheet** — base de datos, una pestaña por mes ("Mayo 2026", "Abril 2026", etc.).
2. **Apps Script webhook** — backend + webapp mobile. Corre en la nube de Google.
3. **Webapp mobile** — formulario que sirve el webhook (agregar gastos + dashboard + scan OCR).
4. **Cowork dashboard** — artifact HTML que lee la Sheet en vivo y muestra charts/KPIs.

---

## 2. Datos clave (IDs y URLs)

| Recurso | Valor |
|---|---|
| Sheet ID | `1kEcFTH2XgS5KF9qh3PFcq1HItDnmf_gXpohfQW8V3RI` |
| Sheet URL | https://docs.google.com/spreadsheets/d/1kEcFTH2XgS5KF9qh3PFcq1HItDnmf_gXpohfQW8V3RI/edit |
| Webhook URL | `https://script.google.com/macros/s/AKfycbzmN4924Cvy3LHES6vHjGvy_QoOGU8v4KNCTIztfoTTDB-XAuKd2KWqQScnZgFQw1Bdfw/exec` |
| Apps Script | Bound a la Sheet → Extensions → Apps Script |
| Cowork artifact | id `expense-dashboard` ("Expense Dashboard") |

**Importante**: el Apps Script y la Sheet viven en la nube de Google. Desde una computadora
nueva NO hay que reinstalar nada — solo abrir la Sheet → Extensions → Apps Script.
La webapp URL funciona desde cualquier dispositivo.

---

## 3. Archivos del proyecto (en esta carpeta)

| Archivo | Qué es | Dónde va |
|---|---|---|
| `expense-webhook.gs` | Código del Apps Script (backend + webapp) | Pegar en el editor Apps Script |
| `appsscript.json` | Manifest con los OAuth scopes | Manifest del proyecto Apps Script |
| `dashboard.html` | Fuente del artifact Cowork | Artifact Cowork "expense-dashboard" |
| `project-instructions.md` | Custom instructions para entrada por chat | Claude Project (opcional) |
| `ios-shortcut-setup.md` | Atajo iOS alternativo (camino viejo) | Referencia |
| `CONTEXTO-sistema-gastos.md` | Este documento | Guardar / Obsidian vault |

---

## 4. Arquitectura — cómo funciona

### Webhook (`expense-webhook.gs`)
Apps Script desplegado como Web App. `doGet(e)` enruta según los parámetros:

- **Sin params** → sirve el formulario mobile (HTML+CSS+JS en `formHtml()`).
- **`?item=...`** → agrega un gasto, devuelve JSON.
- **`?action=...`** → endpoints JSON (ver sección 6).

### Lógica de escritura (`addExpense`)
Dos caminos:
1. **Gasto fijo** — si el `item` matchea un label de la tabla fija (Alquiler, Luz, Antel móvil…),
   sobreescribe esa fila (col B=UYU o C=USD).
2. **Gasto variable** — inserta una fila nueva en la tabla variable, antes de la fila "Total".

Usa `LockService` para serializar escrituras concurrentes.

### Cotización USD
`fetchBcuRate()` usa `=GOOGLEFINANCE("CURRENCY:USDUYU")` en una pestaña oculta `_rate_scratch`.
Cacheada 10 min vía `CacheService`. Fallback: 40.25. **No borrar la pestaña `_rate_scratch`.**

### OCR de tickets (`scanTicket`)
La webapp saca/sube una foto → la redimensiona en el browser → la manda al server →
`scanTicket()` llama a **Gemini 2.5 Flash Vision** vía `UrlFetchApp` → devuelve items
parseados (nombre, monto, categoría) → el usuario revisa/edita → "Guardar todos" → `addBatch()`.

### Dashboard Cowork (`dashboard.html`)
Artifact que lee la Sheet vía Drive MCP (`window.cowork.callMcpTool`). Parsea todas las
pestañas, calcula KPIs, charts con flip cards, filtro por mes, top categoría.
**Solo funciona como artifact Cowork**, no abriendo el .html suelto.

---

## 5. Estructura de la Sheet (pestaña "Mayo 2026" = template)

```
Filas 1-15   Tabla FIJA:  col A=label | B=UYU | C=USD | D=Cotización
Filas ~17    Tabla VARIABLE: header "Lugar / Actividad" | Débito UYU | Crédito OCA |
             Crédito Itaú USD | Crédito Itaú UYU | Débito USD | Cotización dolar | Categoría
             ...filas de gastos... | fila "Total" con fórmulas SUM
Después      Subtotal por categoría
Después      "Gastos totales" | fila "Cantidad" (totales calculados)
Después      Secciones del viaje a Argentina (el parser las IGNORA)
```

**Tarjetas válidas**: Débito UYU (default), Crédito OCA, Crédito Itaú UYU, Crédito Itaú USD, Débito USD

**Categorías**: Transporte, Comida, Bebida/Bar, Salud, Suscripciones, Entretenimiento,
Hogar, Limpieza, Ropa, Regalos, Gimnasio, Servicios, Otros

**Labels fijos** (tabla fija de Mayo): Alquiler, Gastos comunes, Tributos domiciliarios,
Antel Internet, Luz, Itau paquete, Sandra Psicologa, Antel móvil, Viandas, Ble, BlueCross,
Gimnasio, Itaú Crédito, Oca

---

## 6. Endpoints del webhook

| Endpoint | Qué hace |
|---|---|
| `?item=X&amount=N&currency=UYU&card=...&category=...&date=YYYY-MM-DD` | Agrega gasto |
| `?action=dash` | JSON del dashboard (mes actual) |
| `?action=createMonth&month=Junio%202026` | Crea pestaña del mes desde el template |
| `?action=classifyMonth&month=Mayo%202026` | Auto-clasifica gastos sin categoría de un mes |
| `?action=classifyAll` | Auto-clasifica todos los meses (agrega col Categoría si falta) |
| `?action=inspectHeaders&month=X` | Debug: dumpea los headers de una pestaña |
| `?action=testRate` | Devuelve la cotización GOOGLEFINANCE |
| `?action=testFetch` | Verifica que el scope UrlFetch funciona |
| `?action=setKey&key=...` | Guarda la API key de Gemini en Script Properties |
| `?action=hasKey` | Verifica si la key está seteada |

---

## 7. Estado del setup (ya hecho)

- ✅ Webhook desplegado como Web App ("Execute as: Me", "Anyone with link").
- ✅ OAuth scopes autorizados: `spreadsheets` + `script.external_request`.
- ✅ `appsscript.json` con `oauthScopes` explícitos.
- ✅ API key de Gemini guardada en **Script Properties** como `GEMINI_KEY`
  (la key NO está en este doc por seguridad — se gestiona en aistudio.google.com/app/apikey
  y se setea con `?action=setKey`).
- ✅ Pestaña oculta `_rate_scratch` para la cotización.
- ✅ Webapp mobile con tabs: "+ Agregar" y "📊 Dashboard".
- ✅ Scan OCR de tickets operativo.
- ✅ Cowork artifact "expense-dashboard" creado.

---

## 8. Cómo redeployar el webhook (cada cambio de código)

1. Editor Apps Script → pegar el código nuevo de `expense-webhook.gs` → Ctrl+S.
2. Deploy → **Manage deployments** → ✏️ Edit (lápiz) en el deployment existente.
3. Version → **New version** → Deploy.
4. La URL NO cambia.

---

## 9. Gotchas / problemas conocidos

- **OAuth trabado**: si `UrlFetchApp` falla con error de permisos → revocar acceso en
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions) ("Expense Webhook")
  → correr una función desde el editor → otorgar TODO → redeploy.
- **Banner de Google** en la webapp ("created by a Google Apps Script user"): no se puede
  sacar. Workaround: Safari → Share → "Add to Home Screen" (modo PWA lo oculta).
- **`_rate_scratch`**: pestaña necesaria, mantener oculta, no borrar.
- **Datos de Argentina**: el parser y el clasificador los saltean (boundary detection).
- **Dashboard Cowork**: solo funciona como artifact, no abriendo el .html directo
  (necesita `window.cowork`).
- **Meses futuros**: el dashboard los oculta del dropdown automáticamente.

---

## 10. Pendientes / mejoras futuras posibles

- `formHtml()` son ~650 líneas de CSS+HTML+JS juntas — se podría partir en archivos
  `.html` separados con `HtmlService.createTemplateFromFile`.
- `CAT_RULES` (reglas de clasificación) están duplicadas entre `expense-webhook.gs` y
  `project-instructions.md` — unificar a una sola fuente.
- Dashboard: agregar editar/borrar gastos desde la UI.
- Server-renderizar los `<select>` de categoría/tarjeta desde las constantes.

---

## 11. Para retomar en una sesión nueva de Claude

Pasale a Claude: este archivo + `expense-webhook.gs` + `dashboard.html`. Con eso tiene
todo el contexto para seguir desarrollando. El proyecto está en español; el usuario (Ilan)
prefiere respuestas concisas.
