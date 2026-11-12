# Multi-tenant paso 2: onboarding y config por cuenta (contrato)

Objetivo: que una cuenta nueva (no `ilan`) elija país, moneda local, zona horaria, medios de pago y categorías,
y que la app use esa config en vez de lo hardcodeado de Ilan. `ilan` NO cambia de comportamiento (sus defaults son
exactamente lo que hoy está en el código).

## Forma de la config (`cfg`)

```js
{
  pais: 'UY',                 // ISO-3166 alpha-2 en mayúsculas, o 'XX' = otro
  moneda: 'UYU',              // moneda LOCAL: ISO-4217, 3 letras mayúsculas. La otra moneda siempre es 'USD'.
  tz: 'America/Montevideo',   // zona IANA válida (se valida con Intl.DateTimeFormat en try/catch)
  medios: ['Débito UYU', 'Crédito OCA', ...],  // 1..20 strings, 1..40 chars, únicos (sin distinguir tildes/mayúsculas)
  categorias: ['Comida', ..., 'Otros'],        // 1..30 strings, 1..30 chars, únicos; 'Otros' siempre presente y al final
  catRules: [{ source, flags, cat }],          // reglas de autoclasificación; cada `cat` debe estar en categorias
  catsSociales: ['Cita', 'Amigos'],            // subconjunto de categorias (para ilan; [] en cuentas nuevas)
  modulos: { accesosRapidos: true, pais: true }, // true = visible. `pais` es el módulo "Argentina / cuentas con mamá" de Ilan
  onboarding_listo: true      // espejo de tenants.onboarding_listo
}
```

Reglas del modelo de moneda: hay un solo slot "local" más USD. Los importes locales se guardan con el CÓDIGO REAL de la
moneda del tenant en las columnas `moneda` (no con 'UYU' fijo). Una tarjeta/medio es USD si su nombre matchea
`/usd|d[oó]lar/i`; si no, es local. Los medios por defecto de una cuenta nueva se arman como `Débito ${moneda}`,
`Efectivo ${moneda}`, `Crédito ${moneda}`, `Débito USD`, `Efectivo USD`, `Crédito USD` según lo que elija en el wizard,
más tarjetas con nombre propio (el wizard agrega "USD" al nombre si es en dólares). Es crédito si matchea
`/cr[eé]dito|\boca\b/i` (el wizard pone "Crédito" en el nombre de cualquier tarjeta de crédito).
Si la moneda local es `USD`: no hay segunda moneda (cotización = 1, medios solo locales).

## Dónde vive

- `tenants.pais`, `tenants.moneda`, `tenants.tz`, `tenants.onboarding_listo` (ya existen, migración 0006) y una
  columna nueva `tenants.config TEXT` (migración 0007) con el JSON `{ medios, categorias, catRules, catsSociales, modulos }`.
- `ilan`: `config` queda NULL y el cargador devuelve los defaults de Ilan (los valores actuales del código:
  `CARDS` de `rpc/gastos.js`, `form-config.json`, `UYU`, `America/Montevideo`, modulos todo true).
- Cuenta nueva: `onboarding_listo = 0` y `config` NULL hasta que completa el wizard. Antes del wizard el cargador devuelve
  defaults genéricos (no los de Ilan).

## Rutas

- `GET /onboarding`: página del wizard (sirve para el alta Y para editar después, con los valores actuales). Requiere sesión.
- `GET /api/config`: devuelve `cfg` del tenant (solo la parte pública de arriba).
- `POST /api/config`: valida y guarda (JSON `{pais, moneda, tz, medios, categorias, modulos?}`), pone `onboarding_listo = 1`.
  Chequeo de Origin y content-type JSON como el resto de `/api/*`. Una vez `onboarding_listo = 1`, `moneda` NO se puede
  cambiar (400) porque cambiaría el significado de los importes ya guardados. Los demás campos sí.
- `GET /app` con sesión de cuenta con `onboarding_listo = 0`: redirige 302 a `/onboarding`.

## Archivos y dueños

- Backend (agente A): `migrations/0007_config_tenant.sql`, `src/tenantcfg.js` (nuevo: defaults, cargar, validar, guardar,
  reglas genéricas), `src/rpc.js`, `src/rpc/*.js`, `src/rpc/util.js`, `src/index.js` (rutas y cableado), `src/pending.js` solo si hace falta.
- Frontend (agente B): `src/onboarding.js` (nuevo: `paginaOnboarding(cfg, opciones)` que devuelve HTML), `src/form.js`
  (`renderForm(hoy, cfg)`), `../apps-script/form.html`, `form-scripts.html`, `form-styles.html`, `worker/src/form.generated.html`
  (se regenera con `node scripts/build-form.mjs`).
- `src/index.js` lo edita SOLO el agente A. B exporta lo que A necesita y A lo cablea.
