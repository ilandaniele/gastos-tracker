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
| Webhook URL | `https://script.google.com/macros/s/AKfycbw_Nom1eonYjrZvHIAixp6YzEhKfYqGjl5qfUrddtbEm8zJLIviB1oULPWcP2GH9VRUZA/exec` |
| Apps Script | Bound a la Sheet → Extensions → Apps Script |
| Cowork artifact | id `expense-dashboard` ("Expense Dashboard") |

**La webapp exige una clave**: entrar al link pelado devuelve "🔒 No autorizado".
Hay que agregar `?k=<clave>` (o `&k=<clave>` si ya hay otros parámetros) a cada
llamada. La clave está en `pwa/.secrets-local.md`, que no va a git — ver
[`acceso-privado.md`](acceso-privado.md).

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
Hogar, Limpieza, Ropa, Regalos, Gimnasio, Servicios, Viajes, Acciones/Bonos/Ahorros, Otros

`Acciones/Bonos/Ahorros` es para la plata que sale de la cuenta hacia el ahorro:
no es consumo. Su regla de clasificación va **primera** en `CAT_RULES` y exige
plural en "acciones" y "bonos" a propósito — en singular, "bono" es el aguinaldo
o un vale y "acción" es acción de gracias, y los dos caían mal ahí.

**Labels fijos** (tabla fija de Mayo): Alquiler, Gastos comunes, Tributos domiciliarios,
Antel Internet, Luz, Itau paquete, Sandra Psicologa, Antel móvil, Viandas, Ble, BlueCross,
Gimnasio, Itaú Crédito, Oca

---

## 5b. Pestaña "Ahorros"

Los ahorros **no** son de un mes: una acción comprada en marzo se sigue teniendo
en septiembre. Por eso viven en su propia pestaña `Ahorros` (una sola, no una por
mes) y no en un bloque del tab del mes como Argentina. La crea el código solo la
primera vez que se abre la sección.

```
Fila 1      💰 AHORROS
Filas 2-10  Totales calculados: Total (USD) | Total (UYU) |
            Invertido en acciones (USD) | Comisiones pagadas (USD) |
            Ganancia acciones (USD) | En acciones (USD) | En banco (USD) |
            En bonos (USD) | Cotización usada
Fila 12     Headers
Fila 13+    Un movimiento por fila
```

**Columnas**: `Fecha | Tipo | Entidad | Ticker | Cantidad | Precio USD | Comisión USD |
Monto | Moneda | Invertido USD | Precio hoy | Valor hoy USD | Notas`

**Tipos**: `Acción`, `Banco`, `Bono`.

- **Acción**: se carga ticker + cuántas, y después cualquier combinación de
  **precio por acción**, **comisión** y **total gastado**. La identidad que
  siempre cierra es:

  ```
  Invertido USD  =  Cantidad × Precio USD  +  Comisión USD
     (gastado)          (las acciones)         (el broker)
  ```

  Del resto se deduce el que falte: con precio y total sale la comisión; con
  total y comisión sale el precio (restando la comisión **primero**, para que no
  quede repartida en el precio por acción y ensucie la ganancia de ahí en
  adelante). Si mandan las tres y no cierran, se avisa en vez de elegir una en
  silencio.

  La tolerancia de ese chequeo **escala con la cantidad**: el precio por acción
  viene redondeado a centavos (lo redondea el form, y también el resumen del
  broker), y multiplicado por una cantidad fraccionada ese redondeo se amplifica
  — 8,956358 acciones a 218,73 "sobran" un centavo contra el total real. Cuando
  las tres cierran dentro de ese margen, lo gastado y la comisión se conservan
  exactos (son plata que el usuario conoce) y el precio se **recalcula con
  precisión completa**, que es el derivado. La comisión cuenta como plata gastada, así que la ganancia queda
  **neta** de comisiones. El valor de hoy usa el precio del día.
- **Banco / Bono**: se carga entidad + monto + moneda. Valen lo que dice el monto;
  si es UYU se pasa a USD con la cotización del BCU.

Cada fila es **un movimiento**, no una posición: dos compras de NVDA son dos filas
y se agrupan al mostrarlas (cantidad sumada, valuadas al mismo precio). Así no se
pierde a qué precio compraste cada vez.

**Ganancia/pérdida**: se mide **solo sobre las acciones**. El banco y los bonos
valen lo que pusiste, así que meterlos en el promedio solo diluiría el
porcentaje. Se calcula por empresa y en total. Una acción cuyo precio no se pudo
traer se valúa al costo (lo más seguro para el total) pero se marca `sinPrecio`:
la app dice "sin precio" en vez de un +0% que haría creer que no se movió.

**Precio de las acciones**: sale de Yahoo Finance
(`query1.finance.yahoo.com/v8/finance/chart/<TICKER>`), sin API key, cacheado 15
min por ticker. El endpoint batch (`v7/finance/quote`) NO sirve: pide auth. Si
Yahoo no contesta se conserva el último precio que haya en la hoja — un total un
poco viejo es mejor que un total en cero.

Se usa `regularMarketPrice`, que es el **cierre de la rueda regular**, no el
after-hours. Verificado el 2026-09-10 contra dos fuentes independientes: CNBC
daba 218,36 al cierre de las 16:00 ET (idéntico) y Nasdaq 218,7395 a las 17:56
ET, que es extended hours — poco volumen y no representativo para valuar.

**Monedas**: el precio se devuelve **siempre en USD**. Una acción que cotiza en
otra moneda se convierte con `<MONEDA>USD=X`, del mismo endpoint de Yahoo (no
hace falta otra fuente). Sin esto, una acción japonesa a 2994 JPY entraba al
total como US$ 2994 — un error de ~150x. Si no se consigue el tipo de cambio se
devuelve `null`: mejor sin precio que con un total inflado.

**Logos**: se arman con el dominio de la empresa, del mapa `TICKER_INFO` en
`Code.gs` (única fuente: el form lo recibe inyectado en la plantilla). Primero
DuckDuckGo (`icons.duckduckgo.com/ip3/<dominio>.ico`), si falla Google
(`google.com/s2/favicons`), y si fallan los dos queda un badge con el ticker.
Clearbit **no** sirve: HubSpot lo discontinuó y el dominio ni siquiera resuelve.
Un ticker que no esté en el mapa igual se puede cargar: solo pierde el logo.

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
| `?action=ahorros` | Movimientos + posiciones agrupadas + totales |
| `?action=addAhorro&tipo=Acción&ticker=NVDA&cantidad=12&precioUsd=140&comisionUsd=5` | Agrega una compra |
| `?action=addAhorro&tipo=Banco&entidad=Santander&monto=5000&moneda=USD` | Agrega un depósito |
| `?action=updateAhorro&row=N&...` | Edita un movimiento |
| `?action=deleteAhorro&row=N` | Borra un movimiento |
| `?action=precioAccion&ticker=NVDA` | Precio del día de un ticker |

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

Son **dos pasos separados**: subir el código no cambia lo que sirve la URL de
producción. Hay que publicar además una versión nueva del deployment.

### Con clasp (desde el repo, sin pegar nada)

```bash
cd apps-script
npx @google/clasp@3 push
npx @google/clasp@3 create-deployment -i <DEPLOYMENT_ID> -d "qué cambió"
```

- **Tiene que ser `clasp@3`.** Con la v2 falla en
  `Cannot read properties of undefined (reading 'access_token')`: las
  credenciales de `~/.clasprc.json` están en formato v3 (`{tokens:{default:…}}`)
  y la v2 espera el formato viejo.
- El `<DEPLOYMENT_ID>` de producción es el que está en `pwa/wrangler.toml`
  (`APPS_SCRIPT_URL`) — el mismo `AKfycb…` que va en la URL. `list-deployments`
  muestra cinco; los `api exec` son viejos y no se tocan.
- Pasar `-i` **reusa** el deployment, así que la URL NO cambia. Sin `-i` se crea
  uno nuevo con otra URL, que es justamente lo que hay que evitar.
- `push` pisa lo que haya en el editor. Si tocaste algo ahí y no está en el repo,
  primero `clasp pull` en una carpeta aparte y comparar.
- `apps-script/.clasp.json` está en `.gitignore`, así que en una máquina nueva hay
  que recrearlo con el `scriptId` y correr `clasp login`.

### A mano (fallback)

1. Editor Apps Script → pegar el código nuevo → Ctrl+S.
2. Deploy → **Manage deployments** → ✏️ Edit (lápiz) en el deployment existente.
3. Version → **New version** → Deploy.
4. La URL NO cambia.

### Verificar que quedó vivo

```bash
curl -s "<WEBHOOK_URL>?action=habitToday&k=<clave>"
```

Si devuelve JSON con `"ok":true`, la versión nueva está sirviendo. Si dice
`No autorizado`, falta la clave; si da 404, la URL apunta a un deployment
borrado.

---

## 9. Gotchas / problemas conocidos

- **Los `?action=add…` son GET que escriben**: no son idempotentes. Un reintento
  (recarga, timeout, un cliente que reintenta al seguir el redirect de Apps
  Script) vuelve a ejecutar la escritura y duplica el registro. Verificando los
  ahorros con un cliente que seguía redirects quedaron 5 compras idénticas de
  AMD. Para probar a mano conviene **no seguir el redirect**, o releer y limpiar
  después. Aplica igual a `addWater`, `addMeal` y a la carga de gastos.

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
