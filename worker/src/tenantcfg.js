// Config por tenant (multi-tenant paso 2, contrato en docs/MULTI-TENANT-PASO2.md).
//
// Forma pública de `cfg`:
//   { pais, moneda, tz, medios, categorias, catRules, catsSociales, modulos, onboarding_listo }
// Dónde vive: tenants.pais / moneda / tz / onboarding_listo (migración 0006) y tenants.config (0007, JSON con
// { medios, categorias, catRules, catsSociales, modulos }).
//
//   - 'ilan': con config NULL (y pais/moneda/tz NULL) devuelve EXACTAMENTE lo que estaba hardcodeado en el código
//     (CARDS de rpc/gastos.js, form-config.json, UYU, America/Montevideo, módulos todos visibles). Si se edita por
//     POST /api/config se guarda igual que cualquier cuenta, pero sus reglas de clasificación siguen siendo las suyas.
//   - Cuenta nueva sin onboarding: defaults GENÉRICOS (categorías y reglas multi-país), nunca los de Ilan.
//
// cargarCfg = una consulta a tenants. Si ya se tiene la fila (resolverTenant la trae en el JOIN de la sesión),
// cfgDeFila la arma sin consultar nada.
import FORM_CFG from './form-config.json';

export const ILAN = 'ilan';
const TZ_ILAN = 'America/Montevideo';

// ---- Defaults de Ilan (= lo que hoy está en el código) ------------------------------------------------
const MEDIOS_ILAN = ['Débito UYU', 'Crédito OCA', 'Crédito Itaú UYU', 'Crédito Itaú USD', 'Débito USD', 'Efectivo UYU', 'Efectivo USD'];
const congelar = (o) => JSON.parse(JSON.stringify(o));
export const DEFAULTS_ILAN = Object.freeze({
  pais: 'UY', moneda: 'UYU', tz: TZ_ILAN,
  medios: MEDIOS_ILAN,
  categorias: FORM_CFG.categorias,
  catRules: FORM_CFG.catRules,
  catsSociales: FORM_CFG.catsSociales,
  modulos: { accesosRapidos: true, pais: true, personal: true }
});

// ---- Defaults genéricos (cuentas nuevas) ----------------------------------------------------------------
export const CATEGORIAS_GENERICAS = ['Comida', 'Transporte', 'Hogar', 'Servicios', 'Salud', 'Entretenimiento', 'Ropa', 'Suscripciones',
  'Viajes', 'Regalos', 'Acciones/Bonos/Ahorros', 'Otros'];

// Reglas multi-país (español e inglés). El orden importa: la primera que matchea es la categoría principal.
// Se descartan las que apuntan a una categoría que el tenant no tiene (el nombre se compara sin tildes ni
// mayúsculas y se reescribe con la grafía del tenant). Hay reglas de categorías que no vienen por defecto
// (Bebida/Bar, Gimnasio, Limpieza, Mascotas, Educación) por si el usuario las agrega.
export const REGLAS_GENERICAS = [
  { source: 'acciones\\b|bonos\\b|broker|\\betf\\b|cedear|inversi[oó]n|invertir|ahorro|savings|investment|\\bstocks?\\b|crypto|bitcoin', flags: 'i', cat: 'Acciones/Bonos/Ahorros' },
  { source: 'uber ?eats|pedidos ?ya|rappi|ifood|didi food|deliveroo|doordash|glovo|just eat', flags: 'i', cat: 'Comida' },
  { source: 'pasaje|vuelo|aerol[ií]nea|flight|airline|aeropuerto|airport|hotel|hostel|airbnb|booking|hospedaje|excursi[oó]n|rent a car|alquiler de auto|peaje|free shop|duty free|seguro de viaje|viaje|travel', flags: 'i', cat: 'Viajes' },
  { source: '\\bbus\\b|[oó]mnibus|colectivo|\\bbondi\\b|\\bsube\\b|subte|\\bmetro\\b|\\btren\\b|\\btrain\\b|taxi|uber|cabify|didi|lyft|remis|nafta|gasolin|combustible|diesel|\\bfuel\\b|shell|axion|ypf|petrobras|pemex|estacionamiento|parking', flags: 'i', cat: 'Transporte' },
  { source: 'netflix|spotify|youtube|apple|icloud|google one|disney|\\bhbo\\b|prime video|amazon prime|chatgpt|openai|claude|anthropic|github|notion|dropbox|microsoft 365|office 365|suscripci[oó]n|subscription|patreon|twitch', flags: 'i', cat: 'Suscripciones' },
  { source: 'super|market|almac[eé]n|grocer|panader|bakery|carnicer|verduler|fruter|restaurant|restor[aá]n|pizza|hamburgues|burger|mcdonald|\\bkfc\\b|subway|sushi|empanad|asado|parrilla|comida|almuerzo|cena\\b|desayuno|merienda|\\bfood\\b|lunch|dinner|breakfast|cafeter|helado|delivery', flags: 'i', cat: 'Comida' },
  { source: '\\bbar\\b|\\bpub\\b|cerveza|\\bbeer\\b|\\bvino\\b|\\bwine\\b|fernet|trago|\\bdrinks?\\b|whisky|birra', flags: 'i', cat: 'Bebida/Bar' },
  { source: 'farmacia|pharmacy|drugstore|farmashop|farmacity|doctor|m[eé]dic|dentist|odont|hospital|cl[ií]nica|clinic|an[aá]lisis|laboratorio|psic[oó]log|terapia|[oó]ptica|mutualista|prepaga|obra social|health', flags: 'i', cat: 'Salud' },
  { source: 'gimnasio|\\bgym\\b|crossfit|pilates|yoga|f[uú]tbol|p[aá]del|nataci[oó]n|fitness|prote[ií]na', flags: 'i', cat: 'Gimnasio' },
  { source: 'cine\\b|cinema|movie|teatro|theat(er|re)|concierto|concert|recital|museo|museum|steam|playstation|xbox|nintendo|boliche|fiesta|party|\\blibros?\\b|\\bbooks?\\b', flags: 'i', cat: 'Entretenimiento' },
  { source: 'limpieza|detergente|lavandina|\\bcloro\\b|jab[oó]n|esponja|papel higi[eé]nico|cleaning', flags: 'i', cat: 'Limpieza' },
  { source: 'veterinari|\\bvet\\b|mascota|perro|gato|\\bpets?\\b|petshop', flags: 'i', cat: 'Mascotas' },
  { source: 'curso|colegio|escuela|universidad|facultad|matr[ií]cula|udemy|coursera|platzi|school|course|tuition', flags: 'i', cat: 'Educación' },
  { source: 'alquiler|\\brent\\b|ferreter|hardware|mueble|furniture|ikea|sodimac|home depot|electrodom|decoraci|bazar|garrafa', flags: 'i', cat: 'Hogar' },
  { source: '\\bluz\\b|electricidad|electricity|\\bagua\\b|water bill|\\bgas\\b|internet|wifi|tel[eé]fono|celular|phone|antel|movistar|\\bclaro\\b|telcel|verizon|expensas|gastos comunes|impuesto|tributo|contribuci[oó]n|\\bseguro\\b|insurance|peluquer|barber|lavander|tintorer|laundry', flags: 'i', cat: 'Servicios' },
  { source: '\\bropa\\b|zapat|calzado|remera|camisa|pantal[oó]n|\\bjeans?\\b|vestido|campera|abrigo|buzo|sweater|clothes|clothing|shoes|\\bzara\\b|h&m|\\bnike\\b|adidas|uniqlo|shein', flags: 'i', cat: 'Ropa' },
  { source: 'regalo|\\bgifts?\\b', flags: 'i', cat: 'Regalos' }
];

const MONEDA_GENERICA = 'UYU';
export const mediosGenericos = (moneda) => {
  const loc = moneda === 'USD' ? [] : [`Débito ${moneda}`, `Efectivo ${moneda}`, `Crédito ${moneda}`];
  return loc.concat(['Débito USD', 'Efectivo USD', 'Crédito USD']);
};

// ---- Helpers -------------------------------------------------------------------------------------------
// Clave de comparación: sin tildes, minúsculas, espacios colapsados.
export const clave = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Reglas base filtradas a las categorías del tenant (con su grafía). Las de Ilan, para Ilan; si no, las genéricas.
export function reglasPara(T, categorias) {
  const porClave = new Map(categorias.map((c) => [clave(c), c]));
  const base = T === ILAN ? DEFAULTS_ILAN.catRules : REGLAS_GENERICAS;
  return base.filter((r) => porClave.has(clave(r.cat))).map((r) => ({ source: r.source, flags: r.flags, cat: porClave.get(clave(r.cat)) }));
}

export function tzValida(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; }
}
const paisValido = (p) => typeof p === 'string' && /^[A-Z]{2}$/.test(p);
const monedaValida = (m) => typeof m === 'string' && /^[A-Z]{3}$/.test(m);

function genericos(fila) {
  const moneda = fila && monedaValida(fila.moneda) ? fila.moneda : MONEDA_GENERICA;
  const categorias = CATEGORIAS_GENERICAS.slice();
  return {
    pais: fila && paisValido(fila.pais) ? fila.pais : 'UY',
    moneda,
    tz: fila && tzValida(fila.tz) ? fila.tz : TZ_ILAN,
    medios: mediosGenericos(moneda),
    categorias,
    catRules: reglasPara('', categorias),
    catsSociales: [],
    modulos: { accesosRapidos: false, pais: false, personal: false }
  };
}

const listaDeStrings = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

// Arma la cfg a partir de la fila de tenants ({pais, moneda, tz, config, onboarding_listo}; puede ser null).
export function cfgDeFila(T, fila) {
  const esIlan = T === ILAN;
  const base = esIlan ? congelar(DEFAULTS_ILAN) : genericos(fila);
  let guardada = null;
  if (fila && fila.config) { try { guardada = JSON.parse(fila.config); } catch { guardada = null; } }
  const cfg = {
    pais: fila && paisValido(fila.pais) ? fila.pais : base.pais,
    moneda: fila && monedaValida(fila.moneda) ? fila.moneda : base.moneda,
    tz: fila && tzValida(fila.tz) ? fila.tz : base.tz,
    medios: base.medios, categorias: base.categorias, catRules: base.catRules, catsSociales: base.catsSociales,
    modulos: base.modulos,
    onboarding_listo: esIlan && !fila ? true : !!(fila && fila.onboarding_listo)
  };
  if (guardada && typeof guardada === 'object') {
    if (listaDeStrings(guardada.medios)) cfg.medios = guardada.medios;
    if (listaDeStrings(guardada.categorias)) cfg.categorias = guardada.categorias;
    if (Array.isArray(guardada.catRules)) cfg.catRules = guardada.catRules.filter((r) => r && typeof r.source === 'string' && cfg.categorias.includes(r.cat));
    if (Array.isArray(guardada.catsSociales)) cfg.catsSociales = guardada.catsSociales.filter((c) => cfg.categorias.includes(c));
    if (guardada.modulos && typeof guardada.modulos === 'object') cfg.modulos = { ...cfg.modulos, ...guardada.modulos };
  } else if (!esIlan) {
    // Sin config guardada los medios genéricos siguen la moneda de la fila.
    cfg.medios = mediosGenericos(cfg.moneda);
  }
  return cfg;
}

export const SELECT_CFG = 'pais, moneda, tz, config, onboarding_listo';

export async function cargarCfg(env, T) {
  const fila = await env.DB.prepare(`SELECT ${SELECT_CFG} FROM tenants WHERE id = ?`).bind(T).first();
  return cfgDeFila(T, fila || null);
}

// ---- Validación de POST /api/config ----------------------------------------------------------------------
const MAX_MEDIOS = 20, MAX_LARGO_MEDIO = 40, MAX_CATS = 30, MAX_LARGO_CAT = 30;
const MODULOS = ['accesosRapidos', 'pais', 'personal'];

// Saca caracteres de control (incluye los bidi), colapsa espacios. null si trae < o >.
function sanear(s) {
  const t = String(s).replace(/[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return /[<>]/.test(t) ? null : t;
}

function listaSaneada(v, nombre, max, largo, extraProhibido) {
  if (!Array.isArray(v)) return { error: `${nombre}: tiene que ser una lista` };
  const out = [], vistos = new Set();
  for (const x of v) {
    if (typeof x !== 'string') return { error: `${nombre}: cada elemento tiene que ser texto` };
    const s = sanear(x);
    if (s === null) return { error: `${nombre}: "${x.slice(0, 40)}" no puede tener < ni >` };
    if (!s) return { error: `${nombre}: hay un elemento vacío` };
    if (s.length > largo) return { error: `${nombre}: "${s.slice(0, 40)}" tiene más de ${largo} caracteres` };
    if (extraProhibido && extraProhibido.test(s)) return { error: `${nombre}: "${s}" no puede tener el carácter +` };
    const k = clave(s);
    if (vistos.has(k)) return { error: `${nombre}: "${s}" está repetido` };
    vistos.add(k);
    out.push(s);
  }
  if (out.length > max) return { error: `${nombre}: máximo ${max}` };
  return { lista: out };
}

// body = { pais, moneda, tz, medios, categorias, modulos? }; previa = cfg actual del tenant.
// Devuelve { ok:true, cfg } (cfg completa, lista para guardarCfg) o { ok:false, error } con un mensaje para el usuario.
export function validarCfg(body, previa, T) {
  const no = (error) => ({ ok: false, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return no('Se espera un objeto JSON');
  previa = previa || {};

  const pais = String(body.pais == null ? '' : body.pais).trim().toUpperCase();
  if (!paisValido(pais)) return no('País inválido: usá el código de 2 letras (ej. UY, AR, MX) o XX si no está');

  if (typeof body.moneda !== 'string') return no('Falta la moneda');
  const moneda = body.moneda.trim().toUpperCase();
  if (!monedaValida(moneda)) return no('Moneda inválida: tiene que ser un código de 3 letras (ej. UYU, ARS, USD)');
  if (previa.onboarding_listo && previa.moneda && moneda !== previa.moneda) {
    return no(`La moneda no se puede cambiar una vez configurada la cuenta (es ${previa.moneda}): cambiaría el significado de los importes guardados`);
  }

  const tz = typeof body.tz === 'string' ? body.tz.trim() : '';
  if (!tzValida(tz)) return no('Zona horaria inválida (ej. America/Montevideo)');

  const m = listaSaneada(body.medios, 'Medios de pago', MAX_MEDIOS, MAX_LARGO_MEDIO);
  if (m.error) return no(m.error);
  if (!m.lista.length) return no('Medios de pago: tiene que haber al menos uno');

  const c = listaSaneada(body.categorias, 'Categorías', Infinity, MAX_LARGO_CAT, /\+/);
  if (c.error) return no(c.error);
  // 'Otros' siempre presente y al final (se acepta en cualquier lugar y con cualquier grafía).
  const categorias = c.lista.filter((x) => clave(x) !== 'otros').concat(['Otros']);
  if (categorias.length > MAX_CATS) return no(`Categorías: máximo ${MAX_CATS} (contando "Otros")`);

  const modulos = { ...(previa.modulos || { accesosRapidos: T === ILAN, pais: T === ILAN, personal: T === ILAN }) };
  if (body.modulos != null) {
    if (typeof body.modulos !== 'object' || Array.isArray(body.modulos)) return no('Módulos: se espera un objeto');
    for (const k of MODULOS) {
      if (body.modulos[k] === undefined) continue;
      if (typeof body.modulos[k] !== 'boolean') return no(`Módulos: "${k}" tiene que ser true o false`);
      modulos[k] = body.modulos[k];
    }
  }

  const catsSociales = (previa.catsSociales || []).filter((x) => categorias.includes(x));
  return {
    ok: true,
    cfg: { pais, moneda, tz, medios: m.lista, categorias, catRules: reglasPara(T, categorias), catsSociales, modulos, onboarding_listo: true }
  };
}

// Guarda y marca onboarding_listo = 1. La condición del WHERE hace atómica la regla "moneda inmutable".
export async function guardarCfg(env, T, cfg) {
  const config = JSON.stringify({ medios: cfg.medios, categorias: cfg.categorias, catRules: cfg.catRules, catsSociales: cfg.catsSociales, modulos: cfg.modulos });
  const r = await env.DB.prepare(`UPDATE tenants SET pais = ?, moneda = ?, tz = ?, config = ?, onboarding_listo = 1
                                  WHERE id = ? AND (onboarding_listo = 0 OR moneda IS NULL OR moneda = ?)`)
    .bind(cfg.pais, cfg.moneda, cfg.tz, config, T, cfg.moneda).run();
  if (!r.meta.changes) throw new Error('No se pudo guardar: la moneda no se puede cambiar');
}

// Lo que devuelve GET /api/config.
export const cfgPublica = (cfg) => ({
  pais: cfg.pais, moneda: cfg.moneda, tz: cfg.tz, medios: cfg.medios, categorias: cfg.categorias, catRules: cfg.catRules,
  catsSociales: cfg.catsSociales, modulos: cfg.modulos, onboarding_listo: !!cfg.onboarding_listo
});
