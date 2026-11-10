# Auditoría de migración: de Google Sheets + Apps Script a una app vendible

Fecha: 2026-11-10. Alcance: todo el repo (`apps-script/`, `pwa/`, `cowork/`, `docs/`).
Es una auditoría de solo lectura: no se cambió código.

> Supuesto: "esto aparece con lo de google" se interpretó como el aviso/banner de
> Google sobre la app de Apps Script ("Esta aplicación fue creada por un usuario
> de Google Apps Script" y la pantalla de "app no verificada"). Si era otra cosa,
> el resto de la auditoría igual aplica, porque la conclusión no cambia: para
> vender, el sistema no puede seguir viviendo dentro de una cuenta de Google.

---

## 1. Por qué Google no sirve para vender esto

| Problema | Detalle |
|----------|---------|
| Banner y advertencias | Toda web app de Apps Script muestra el aviso de Google y corre dentro de un iframe propio de Google. En cuentas personales no se puede quitar. Un cliente que paga lo ve como "app de mentira". |
| Una sola cuenta dueña | El script corre como Ilan y toca la planilla de Ilan. Para dar la app a otra persona hay que copiarle el Sheet y el script, o mezclar datos de todos en la misma planilla. No hay forma segura de multi-cliente. |
| Sheets como base de datos | Una hoja por mes, tablas "fija" y "variable" dentro de la misma hoja, columnas halladas por regex de encabezado. Sin índices, sin transacciones reales (se simulan con `LockService`, 39 usos), sin restricciones de tipo, sin migraciones. Cada lectura es `getValues` de un rango. |
| Cuotas | Tiempo máximo por ejecución, tope diario de `UrlFetchApp`, tope de horas de triggers, tope de celdas por planilla. Con varios clientes se llega rápido. |
| Latencia | Cada llamada a Apps Script tarda de cientos de ms a varios segundos (arranque en frío + Sheets). Se nota en el celular. |
| Sin control de versiones del dato | Cualquiera con acceso al Sheet puede romper una tabla a mano y la app deja de funcionar (las columnas se buscan por texto). |
| Términos | Usar una cuenta de Google personal como backend de un producto comercial queda en zona gris respecto de los términos de Apps Script/Workspace. Verificar antes de cobrar. |

## 2. Qué hay hoy (inventario)

### Apps Script (`apps-script/`)
- `Code.gs`, 7.514 líneas. Todo el backend en un archivo.
- `form.html`, `form-scripts.html` (5.216 líneas), `form-styles.html`: la interfaz.
  **La interfaz llama al backend con `google.script.run` (57 usos), no con `fetch`.** Esto es lo más
  acoplado: no se puede servir esa UI desde otro lado sin reemplazar esas 57 llamadas.
- Rutas: `doGet` con `?action=` y más de 100 rutas en `ROUTES` (gastos, dashboard, ahorros, ingresos,
  tareas, argentina, hábitos, mantenimiento, diagnóstico). Auth: clave `APP_KEY` por `?k=`.
- Dependencias de Google (conteos en `Code.gs`):

| Servicio | Usos | Qué hace | Reemplazo |
|----------|------|----------|-----------|
| `SpreadsheetApp` | 114 | Base de datos | D1 / Postgres |
| `getRange/getValues/setValue` | 245 | Lectura y escritura de celdas | Consultas SQL |
| `LockService` | 39 | Evitar escrituras simultáneas | Transacciones SQL |
| `UrlFetchApp` | 10 | Gemini (OCR), Yahoo, BCU | `fetch` en el Worker, igual |
| `PropertiesService` | 11 | Claves y config | Secretos del Worker + tabla de ajustes |
| `CacheService` | 8 | Caché corta | Cache API o KV |
| `HtmlService` | 6 | Sirve la interfaz con plantillas | El Worker sirve los archivos |
| `MailApp` | 2 | Reporte mensual por mail | API de mail (Resend, Postmark, Cloudflare Email) |
| Triggers de tiempo | 3 | `monthlyReportCron`, `monthTabsCron`, `dailyTasksCron` | Cron Triggers del Worker |
| `GOOGLEFINANCE` en hoja oculta `_rate_scratch` | 1 | Cotización del dólar | Fuente HTTP (ya hay una BCU) |

### Cloudflare (`pwa/`) — ya existe
Worker `gastos-habitos`: sirve la PWA, guarda suscripciones push en KV `SUBS`, corre cron
(`0 2,3,4,5,12 * * *`) y consulta a Apps Script qué falta cargar. Acceso protegido con
Cloudflare Access (solo `ilan.daniele@gmail.com`). El Worker hoy es un proxy delgado delante de Apps Script, y
**Apps Script es el que sirve la interfaz** (el Worker navega hacia la app, no la embebe).

### Datos (pestañas del Sheet)
- Una pestaña por mes (`Mayo 2026`, ..., plantilla `TEMPLATE_TAB`): tabla fija (hasta 20 filas) + tabla variable.
  Categoría en una celda como `A + B` (separador `' + '`, máximo 2).
- `Ahorros`, `Ingresos`, `Tareas`, `Compras`, `_tickets`, `_rate_scratch`.
- Bloque `🇦🇷 ARGENTINA` (deudas y movimientos en ARS).
- Pestañas `Hábitos <mes>` (comidas, agua, ejercicio).

### Datos personales metidos en el código
`SHEET_ID` fijo, categorías (`CATEGORIES`) y reglas de palabras (`CAT_RULES`) propias de Ilan, el correo de Ilan para el
reporte, la zona horaria `America/Montevideo`, el bloque de Argentina, hábitos, tareas, compras. Nada de esto está
separado por usuario.

### Cosas que ya andan bien y se reusan
- Lógica de categorías, clasificación por texto, reporte mensual con "A minimizar", auditoría de mes: es lógica pura,
  se porta casi línea por línea a JavaScript de Worker.
- OCR con Gemini: ya es una llamada HTTP.
- Push con VAPID en el Worker: ya está.
- Pruebas manuales por rutas (`testCategorias` 20/20).

## 3. Opciones de destino

### Opción A (recomendada): todo en Cloudflare — Workers + D1
- **Datos:** D1 (SQLite administrado). Un solo DB con columna `tenant_id` en cada tabla. Sirve de sobra para miles de
  usuarios de gastos personales.
- **Backend:** un Worker con API JSON (Hono o similar). Cron Triggers para reporte, push y creación de mes.
- **Archivos:** R2 para fotos de tickets (hoy se manda la imagen a Gemini y no se guarda; R2 solo si se quiere historial).
- **Interfaz:** Worker sirve la PWA ya existente, con una capa que reemplace `google.script.run` por `fetch`.
- **Mail:** servicio externo de mail transaccional desde el Worker.
- **Login de clientes:** ver sección 5.
- **Pros:** una sola plataforma que ya usás, sin servidores, sin banner de Google, latencia baja, barato al inicio,
  la consola de D1 ya te deja ver y consultar las tablas.
- **Contras:** SQLite (no Postgres); hay que escribir el backend de nuevo; D1 tiene límites de tamaño por base y de
  consultas por invocación que hay que respetar (verificar los números vigentes en la documentación de Cloudflare).

### Opción B: Cloudflare + Supabase (Postgres)
- Worker para la lógica, Supabase para Postgres, login y reglas por fila (RLS).
- **Pros:** el panel de Supabase es el mejor "ver la base de datos" listo para usar; login con magic link, Google, etc. ya
  incluido; RLS resuelve el aislamiento entre clientes.
- **Contras:** dos proveedores; el plan gratuito se pausa por inactividad; más piezas para vigilar.

### Opción C: quedarse en Google pero "profesional"
- Pasar el script a un proyecto de Google Cloud, publicar la pantalla de consentimiento, usar Sheets API con una
  cuenta de servicio por cliente.
- **Contras:** no soluciona la base de datos, cuotas ni multi-cliente. No recomendada para un producto.

**Recomendación: A.** Si querés el visor de base de datos más cómodo desde el día uno y aceptás un proveedor más, B.
Se puede empezar en A y cambiar D1 por Postgres después si hace falta, porque el acceso a datos queda detrás de
una sola capa de repositorio.

## 4. Modelo de datos propuesto (D1)

Esquema mínimo para los gastos; el resto de módulos se agrega después.

```
tenants       (id, nombre, moneda_base, zona_horaria, creado)
users         (id, tenant_id, email, rol, creado)
categories    (id, tenant_id, nombre, es_social, es_ahorro, orden)
category_rules(id, tenant_id, palabra, category_id)
expenses      (id, tenant_id, fecha, mes, concepto, monto, moneda,
               categoria1_id, categoria2_id, es_fijo, pagado, medio_pago, nota, creado, actualizado)
fixed_items   (id, tenant_id, concepto, monto, moneda, dia, categoria1_id, activo)   -- plantilla mensual
incomes       (id, tenant_id, fecha, concepto, monto, moneda)
savings       (id, tenant_id, fecha, tipo, monto, moneda, nota)
tickets       (id, tenant_id, fecha, expense_id, texto_ocr, r2_key)
settings      (tenant_id, clave, valor)
fx_rates      (fecha, par, valor, fuente)
```

Notas de diseño:
- La categoría pasa de texto `A + B` a dos columnas. El importador separa por `' + '`.
- "Mes" deja de ser una pestaña: es una columna indexada (`mes = '2026-11'`). Los gastos fijos se generan desde
  `fixed_items` con el cron mensual.
- Todo importe en centavos enteros, con su moneda explícita (hoy USD/UYU/ARS conviven en la misma hoja).
- Módulos personales (hábitos, tareas, compras, Argentina): decidir si son parte del producto. Si no, se dejan en
  Apps Script para Ilan o se migran a un módulo opcional por tenant, después.

## 5. Qué hay que sumar para que sea vendible

1. **Multi-tenancy:** `tenant_id` en todas las consultas, obligatorio en la capa de datos (nunca en el frontend).
2. **Login de clientes:** hoy solo hay Cloudflare Access con una sola cuenta. Para clientes: magic link por mail o
   Google, sesiones propias. Cloudflare Access se mantiene solo como puerta del panel de administración.
3. **Cobro:** definir procesador de pagos disponible para un vendedor en Uruguay (verificar; un "merchant of record" como
   Paddle o Lemon Squeezy simplifica impuestos). Plan, trial, estado de suscripción en la tabla de `tenants`.
4. **Quitar lo personal:** categorías y reglas por tenant, plantilla inicial por defecto, nada de `SHEET_ID` ni mail fijos.
5. **Importación:** subir CSV/Excel de otro tracker, y un importador del Sheet de Ilan como primer cliente real.
6. **Legal mínimo:** política de privacidad, términos, borrado de cuenta y exportación de datos (son datos financieros).
7. **Observabilidad:** logs del Worker, alertas de errores de cron, copias de seguridad de D1 (export programado a R2).
8. **Costos por uso de Gemini:** el OCR cuesta por llamada. Poner límite por plan.

## 6. Plan de migración por fases

Estrategia: estrangular de a poco. Apps Script sigue siendo la fuente de verdad hasta el corte; nada se rompe
mientras se construye lo nuevo.

**Fase 0 — Respaldo y congelamiento (1 sesión)**
- Exportar el Sheet completo a CSV/JSON y guardarlo fuera del repo.
- Escribir `docs/` con el esquema real de cada pestaña (fijo, variable, Ahorros, Ingresos).
- Congelar cambios de estructura del Sheet durante la migración.

**Fase 1 — Base nueva y datos importados**
- Crear D1, esquema y migraciones versionadas en el repo (`worker/migrations/`).
- Script de importación Sheet → D1 (usando una ruta de exportación en Apps Script que devuelva todo en JSON).
- Verificación: totales por mes y por categoría en D1 deben coincidir con `dash` de hoy. Es el criterio de aceptación.

**Fase 2 — Visor de datos (lo que pediste como objetivo)**
- Antes de tocar la interfaz: consola de D1 y una pantalla de administración simple en el Worker (tabla de gastos con filtros
  por mes, categoría y texto; totales; exportar CSV), detrás de Cloudflare Access.
- Opcional: Drizzle Studio o Metabase apuntando a D1 para análisis más pesado.

**Fase 3 — API nueva con la misma forma**
- Worker implementa las rutas que usa la interfaz (`dash`, `addExpense`, `updateExpense`, `deleteExpense`,
  `setExpenseCategory`, ingresos, ahorros) devolviendo el mismo JSON.
- Se arma un adaptador del lado del navegador: `google.script.run.X(...)` → `fetch('/api/X')`. Si se hace como una
  clase compatible con `.withSuccessHandler()/.withFailureHandler()`, las 57 llamadas no se tocan.
- Escrituras en doble destino durante un tiempo (D1 + Sheet) y comparar.

**Fase 4 — Procesos programados y servicios**
- Cron del Worker: reporte mensual (día 1), creación de mes, avisos push ya existentes, tareas.
- Mail por API externa. Cotización de dólar por HTTP (BCU), sin `GOOGLEFINANCE`.
- OCR de tickets con Gemini desde el Worker.

**Fase 5 — Corte**
- La PWA apunta solo al Worker. Apps Script queda en solo lectura como archivo y se apaga la clave `APP_KEY`.
- Se conservan el Sheet y el script un tiempo como respaldo.

**Fase 6 — Producto**
- Multi-tenant real, login, planes y cobro, onboarding, páginas legales.
- Recién acá se agregan los módulos personales como opcionales, o se dejan afuera.

Orden sugerido por riesgo: 0 → 1 → 2 → 3. Hasta la fase 2 inclusive no se cambia nada de lo que usás todos los días.

## 7. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Reescribir 7.500 líneas introduce errores de totales | Criterio de aceptación numérico en Fase 1; comparar `dash` viejo vs nuevo por cada mes histórico |
| 57 llamadas `google.script.run` | Adaptador compatible en vez de reescribir la interfaz |
| Reglas de categorías y excepciones escondidas en `Code.gs` (ahorro fuera de totales, tarjeta de crédito no suma, solo su pago) | Listarlas como pruebas antes de portar; hay `testCategorias` como base |
| Pérdida de datos al importar | Respaldo de Fase 0, importación repetible e idempotente |
| Alcance infinito (hábitos, tareas, Argentina...) | Primero solo gastos, ingresos y ahorros. Lo demás después |
| Clave `APP_KEY` y secretos | Siguen en secretos del Worker; `pwa/.secrets-local.md` no entra a git. Rotar `APP_KEY` al hacer el corte |

## 8. Próximo paso concreto

Fase 0 y 1 juntas: escribir la ruta de exportación en Apps Script, crear la base D1 con el esquema de la sección 4 e
importar todos los meses. Con eso ya podés mirar tus gastos en la consola de D1 sin cambiar nada de lo que usás.

## 9. Decisiones tomadas (2026-11-10)

1. **Opción A:** todo en Cloudflare (Workers + D1).
2. **Módulos:** hábitos, tareas, compras y Argentina entran al producto. El bloque "Argentina" pasa a ser un
   módulo de "país secundario" configurable por tenant: país (código ISO), moneda, bandera y nombre se leen de
   `settings`/`tenants`. Valor por defecto: Argentina (AR, ARS, 🇦🇷). Hay que agregar a `tenants` o `settings` las claves
   `pais_codigo`, `pais_moneda`, `pais_nombre`; la bandera se deriva del código ISO. Los títulos hoy fijos en
   el código (`ARG_TITLE = '🇦🇷 ARGENTINA'`, rutas `arg*`) se vuelven genéricos (`foreign_*`).
3. **Nombre y dominio:** subdominio gratuito de Cloudflare (`<nombre>.ilandaniele.workers.dev`). Más adelante se
   puede cambiar a un dominio propio sin tocar el código (Custom Domain del Worker). Falta definir `<nombre>`.
4. **Mercado:** pendiente. Con país configurable queda abierto.

Tablas extra por los módulos incluidos: `habit_days`, `meals`, `water_logs`, `exercise_logs`, `tasks`, `purchases`,
`foreign_debts`, `foreign_movements`.

## 10. Estado (2026-11-10)

Hechas las fases 0, 1 y 2 para todos los módulos:

- Apps Script: ruta de solo lectura `exportAll` (versión @197) con gastos, ingresos, ahorros, tareas, compras, hábitos (días y registro de comida/agua/ejercicio) y país. La app no cambió.
- D1 `gastos-db` (esquema en `worker/migrations/0001_init.sql` y `0002_modulos.sql`): 57 meses, 5.294 gastos, 3 ingresos, 5 ahorros, 33 tareas, 3 compras, 10 días de hábitos, 42 registros de hábitos, 102 movimientos del país en 5 meses.
- Verificación: los totales en pesos y dólares de los 57 meses coinciden con los del Sheet (pestaña "Control" del visor, o `/api/verify`).
- País configurable: la tabla `settings` guarda `pais_codigo` (AR), `pais_nombre`, `pais_moneda`; la bandera sale del código ISO. Cambiar de país es cambiar esas filas. Las tablas se llaman `foreign_*` y no mencionan a Argentina.
- Visor en el Worker `gastos-app` (`worker/`): pestañas Gastos, Ingresos, Ahorros, Tareas, Compras, Hábitos, País y Control. Solo lectura.
- Acceso: clave en cookie (`VIEW_KEY`) como respaldo. La verificación del JWT de Cloudflare Access ya está en el Worker y probada (`worker/test/access.test.mjs`, 11 casos), pero se activa solo al definir `ACCESS_TEAM` y `ACCESS_AUD`. Falta crear en el dashboard la app de Access para `gastos-app.ilandaniele.workers.dev` y copiar su AUD tag (el token de wrangler no tiene permiso de Access).
- Reimportar en cualquier momento: desde `worker/`, con `APPS_SCRIPT_URL` y `APP_KEY` en el entorno, `node scripts/import.mjs --fetch --apply`.

Pendiente: activar Access (paso manual de arriba); API de escritura con adaptador para los 57 usos de `google.script.run` (fase 3); crons y mail (fase 4); tipo de cambio sin GOOGLEFINANCE; multi-tenant, login y cobro.
