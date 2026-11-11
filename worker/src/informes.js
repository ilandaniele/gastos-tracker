// Informes en HTML (reporte mensual de gastos + hábitos, y tareas de hoy) y su envío por mail.
// Port de buildMonthlyReportHtml / _buildHabitsEmailSection / sendMonthlyReport y de
// _tasksDigestHtml / sendDailyTasksEmail de Apps Script (Code.gs), calculado desde D1.
//
// Costo en D1: el reporte mensual hace UNA lectura de expenses para los 6 meses (el mes pedido
// + 5 previos) y las de getHabitsData (hábitos del mes); el de tareas, las de leerTareas.
// Nada por fila. El envío por mail no toca D1 si no hay proveedor configurado.
import { hoy } from './rpc/util.js';
import { tabDeMes, splitCategorias } from './rpc/gastos.js';
import { getHabitsData } from './rpc/habitos.js';
import { digestHoy, WATER_GOAL_ML } from './pending.js';

const CATS_A_MINIMIZAR = ['Cita', 'Amigos'];
const FX = 40; // aproximación USD -> UYU para ordenar (igual que auditMonth)

// ---- Formato --------------------------------------------------------------------------------------
// Todo lo que viene de datos del usuario pasa por e() antes de ir al HTML.
const e = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtN = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 });
const fmtD = new Intl.NumberFormat('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUyu = (n) => (Number.isFinite(n) ? '$ ' + fmtN.format(Math.round(n)) : '—');
const fmtUsd = (n) => (Number.isFinite(n) ? 'US$ ' + fmtD.format(Math.round(n * 100) / 100) : '—');
const plural = (n, s, p) => n + ' ' + (Math.abs(n) === 1 ? s : p);
const round2 = (n) => Math.round(n * 100) / 100;
const pctChange = (curr, prev) => (!prev ? null : ((curr - prev) / prev) * 100);

// '2026-11' -> '2026-10'
export function mesAnterior(ym) {
  const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
// Mes anterior al de hoy (Montevideo): es lo que reporta el mail del día 1.
export const mesPorDefecto = () => mesAnterior(hoy().slice(0, 7));
export const mesValido = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

// ---- Auditoría del mes (auditMonth) ------------------------------------------------------------------
// rows: gastos variables del mes (sin crédito ni ahorro, con monto). Mismo criterio que el dashboard.
function auditar(rows) {
  const items = rows.map((r) => ({
    item: r.concepto, cat: r.categoria || '',
    uyu: r.moneda === 'USD' ? 0 : r.monto, usd: r.moneda === 'USD' ? r.monto : 0
  }));
  const eq = (it) => it.uyu + it.usd * FX;
  const byCat = {};
  let sumUyu = 0, sumUsd = 0;
  for (const it of items) {
    sumUyu += it.uyu; sumUsd += it.usd;
    // 2 categorías = el monto entero en cada una.
    const cats = splitCategorias(it.cat);
    for (const c of (cats.length ? cats : ['Otros'])) {
      if (!byCat[c]) byCat[c] = { uyu: 0, usd: 0, count: 0 };
      byCat[c].uyu += it.uyu; byCat[c].usd += it.usd; byCat[c].count++;
    }
  }
  const allCategorias = Object.keys(byCat)
    .map((name) => ({ name, uyu: round2(byCat[name].uyu), usd: round2(byCat[name].usd), count: byCat[name].count }))
    .sort((a, b) => (b.uyu + b.usd * FX) - (a.uyu + a.usd * FX));
  const minimizar = CATS_A_MINIMIZAR.map((name) => {
    const delCat = items.filter((it) => splitCategorias(it.cat).indexOf(name) >= 0).sort((a, b) => eq(b) - eq(a));
    return {
      name, count: delCat.length,
      uyu: round2(delCat.reduce((s, it) => s + it.uyu, 0)), usd: round2(delCat.reduce((s, it) => s + it.usd, 0)),
      top: delCat.slice(0, 3).map((it) => ({ item: it.item, uyu: round2(it.uyu), usd: round2(it.usd) }))
    };
  });
  const topItems = items.slice().sort((a, b) => eq(b) - eq(a)).slice(0, 10)
    .map((it) => ({ item: it.item, uyu: round2(it.uyu), usd: round2(it.usd), cat: it.cat }));
  return {
    itemCount: items.length, sumUyu: round2(sumUyu), sumUsd: round2(sumUsd),
    allCategorias, topCategorias: allCategorias.slice(0, 5), minimizar, topItems, fx: FX
  };
}

// ---- Reporte mensual ---------------------------------------------------------------------------------
const HEAD = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
const BODY_STYLE = 'font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.5;';

export async function reporteMensualHtml(env, tenant, mes) {
  const meses = [mes];
  for (let i = 1; i <= 5; i++) meses.push(mesAnterior(meses[meses.length - 1]));
  const r = await env.DB.prepare(
    `SELECT mes, concepto, monto, moneda, categoria FROM expenses
     WHERE tenant_id = ? AND mes IN (${meses.map(() => '?').join(',')}) AND es_fijo = 0 AND es_credito = 0 AND es_ahorro = 0 AND monto <> 0`)
    .bind(tenant, ...meses).all();
  const porMes = {};
  for (const x of r.results) (porMes[x.mes] = porMes[x.mes] || []).push(x);

  const monthlyData = meses.map((m) => ({ month: m, tab: tabDeMes(m), ok: !!porMes[m], audit: porMes[m] ? auditar(porMes[m]) : null }));
  const current = monthlyData[0];
  if (!current.ok) {
    return HEAD + '<title>Reporte de gastos</title></head><body style="' + BODY_STYLE + '"><p>No hay gastos cargados en ' + e(current.tab) + '.</p></body></html>';
  }
  const previous = monthlyData.slice(1).filter((md) => md.ok);
  const ca = current.audit;
  const findCat = (audit, name) => (audit ? audit.allCategorias : []).find((c) => c.name === name);
  const avgOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  let html = HEAD + '<title>Reporte de gastos — ' + e(current.tab) + '</title></head><body style="' + BODY_STYLE + '">';
  html += '<h1 style="color: #047857; border-bottom: 2px solid #047857; padding-bottom: 8px; margin: 0;">📊 Reporte de gastos — ' + e(current.tab) + '</h1>';

  // Total
  html += '<div style="background: #d1fae5; padding: 20px; border-radius: 8px; margin: 16px 0; text-align: center;">';
  html += '<div style="font-size: 13px; color: #047857; text-transform: uppercase; letter-spacing: 0.5px;">Total variables del mes</div>';
  html += '<div style="font-size: 30px; font-weight: 700; color: #047857; margin-top: 4px;">' + fmtUyu(ca.sumUyu) + '</div>';
  html += '<div style="font-size: 18px; color: #065f46; margin-top: 4px;">' + fmtUsd(ca.sumUsd) + '</div>';
  html += '<div style="font-size: 12px; color: #047857; margin-top: 8px;">' + ca.itemCount + ' gastos · solo variables, no incluye fijos mensuales</div>';
  html += '</div>';

  // A minimizar: Cita y Amigos, con la tendencia contra los meses previos
  const equiv = (c) => (c ? c.uyu + c.usd * FX : 0);
  const minimizarTodas = ca.minimizar;
  const minimizarRows = minimizarTodas.filter((m) => m.count > 0);
  if (minimizarTodas.length) {
    html += '<div style="background: #fee2e2; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #dc2626;">';
    html += '<div style="font-size: 13px; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px;">✂ A minimizar</div>';
    const sinGasto = minimizarTodas.filter((m) => m.count === 0).map((m) => e(m.name));
    if (sinGasto.length) html += '<div style="font-size: 14px; color: #15803d; margin-top: 10px;">✓ Sin gastos en ' + sinGasto.join(' ni ') + ' este mes.</div>';
    for (const m of minimizarRows) {
      const prevEq = previous.map((md) => findCat(md.audit, m.name)).filter((c) => c).map(equiv);
      const avgEq = avgOf(prevEq);
      const pctM = pctChange(equiv(m), avgEq);
      html += '<div style="margin-top: 14px;">';
      html += '<div style="font-size: 20px; font-weight: 700; color: #991b1b;">' + e(m.name) + ' · ' + fmtUyu(m.uyu) + (m.usd > 0 ? ' + ' + fmtUsd(m.usd) : '') + '</div>';
      html += '<div style="font-size: 13px; color: #7f1d1d; margin-top: 2px;">' + plural(m.count, 'gasto', 'gastos');
      if (avgEq > 0 && pctM !== null) {
        const color = pctM >= 10 ? '#dc2626' : (pctM <= -10 ? '#15803d' : '#7f1d1d');
        html += ' · <span style="color: ' + color + '; font-weight: 600;">' + (pctM >= 0 ? '+' : '') + pctM.toFixed(0) +
          '%</span> vs promedio últimos ' + prevEq.length + ' meses (' + fmtUyu(avgEq) + ')';
      }
      html += '</div>';
      if (m.top.length) {
        html += '<div style="font-size: 12px; color: #7f1d1d; margin-top: 4px;">Lo que más pesó: ' +
          m.top.map((t) => e(t.item) + ' (' + (t.uyu > 0 ? fmtUyu(t.uyu) : fmtUsd(t.usd)) + ')').join(' · ') + '</div>';
      }
      html += '</div>';
    }
    if (minimizarRows.length) html += '<div style="font-size: 11px; color: #991b1b; margin-top: 12px;">Un gasto con 2 categorías (ej. Cita + Comida) cuenta entero en cada una, por eso estas cifras pueden solaparse con las de Comida.</div>';
    html += '</div>';
  }

  // Comida
  const comidaCurrent = findCat(ca, 'Comida');
  if (comidaCurrent) {
    const comidaPrev = previous.map((md) => findCat(md.audit, 'Comida')).filter((c) => c).map((c) => c.uyu);
    const avgComida = avgOf(comidaPrev);
    const pctC = pctChange(comidaCurrent.uyu, avgComida);
    html += '<div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #f59e0b;">';
    html += '<div style="font-size: 13px; color: #92400e; text-transform: uppercase; letter-spacing: 0.5px;">🍽 Gasto en Comida</div>';
    html += '<div style="font-size: 26px; font-weight: 700; color: #92400e; margin-top: 4px;">' + fmtUyu(comidaCurrent.uyu) + '</div>';
    html += '<div style="font-size: 13px; color: #78350f; margin-top: 6px;">' + comidaCurrent.count + ' compras';
    if (avgComida > 0 && pctC !== null) {
      const color = pctC >= 10 ? '#dc2626' : (pctC <= -10 ? '#15803d' : '#92400e');
      html += ' · <span style="color: ' + color + '; font-weight: 600;">' + (pctC >= 0 ? '+' : '') + pctC.toFixed(0) + '%</span> vs promedio últimos ' + comidaPrev.length + ' meses (' + fmtUyu(avgComida) + ')';
    }
    html += '</div>';
    if (comidaPrev.length) {
      const abrev = (md) => e(md.tab.split(' ')[0].substr(0, 3));
      const cells = [];
      for (let i = previous.length - 1; i >= 0; i--) {
        const c = findCat(previous[i].audit, 'Comida');
        cells.push(abrev(previous[i]) + ' ' + fmtUyu(c ? c.uyu : 0));
      }
      cells.push('<b>' + abrev(current) + ' ' + fmtUyu(comidaCurrent.uyu) + '</b>');
      html += '<div style="margin-top: 12px; font-size: 12px; color: #78350f;">Histórico: ' + cells.join(' → ') + '</div>';
    }
    html += '</div>';
  }

  // Últimos 6 meses
  const TH = 'padding: 10px; border-bottom: 2px solid #e5e5e5;';
  html += '<h2 style="margin-top: 32px;">Últimos 6 meses</h2>';
  html += '<table style="width: 100%; border-collapse: collapse;"><tr style="background: #f5f5f5;">';
  html += '<th style="text-align: left; ' + TH + '">Mes</th><th style="text-align: right; ' + TH + '">UYU</th>';
  html += '<th style="text-align: right; ' + TH + '">USD</th><th style="text-align: right; ' + TH + '"># Gastos</th></tr>';
  for (const md of monthlyData) {
    if (!md.ok) { html += '<tr><td colspan="4" style="padding: 8px; color: #999;">' + e(md.tab) + ' — sin datos</td></tr>'; continue; }
    const isCurrent = md === current;
    const TD = 'padding: 10px; border-bottom: 1px solid #e5e5e5;';
    html += '<tr style="' + (isCurrent ? 'background: #ecfdf5; font-weight: 700;' : '') + '">';
    html += '<td style="' + TD + '">' + e(md.tab) + (isCurrent ? ' ←' : '') + '</td>';
    html += '<td style="text-align: right; ' + TD + '">' + fmtUyu(md.audit.sumUyu) + '</td>';
    html += '<td style="text-align: right; ' + TD + '">' + fmtUsd(md.audit.sumUsd) + '</td>';
    html += '<td style="text-align: right; ' + TD + ' color: #666;">' + md.audit.itemCount + '</td></tr>';
  }
  html += '</table>';

  // Top categorías con tendencia
  html += '<h2 style="margin-top: 32px;">Top categorías</h2><table style="width: 100%; border-collapse: collapse;">';
  for (const cat of ca.topCategorias) {
    const avg = avgOf(previous.map((md) => findCat(md.audit, cat.name)).filter((c) => c).map((c) => c.uyu));
    const pct = pctChange(cat.uyu, avg);
    let badge = '';
    if (pct !== null) {
      if (pct >= 20) badge = ' <span style="background: #fef2f2; color: #dc2626; padding: 2px 6px; border-radius: 4px; font-size: 11px;">▲ ' + pct.toFixed(0) + '%</span>';
      else if (pct <= -20) badge = ' <span style="background: #f0fdf4; color: #15803d; padding: 2px 6px; border-radius: 4px; font-size: 11px;">▼ ' + Math.abs(pct).toFixed(0) + '%</span>';
    }
    html += '<tr><td style="padding: 10px; border-bottom: 1px solid #e5e5e5;"><b>' + e(cat.name) + '</b>' + badge + '</td>';
    html += '<td style="text-align: right; padding: 10px; border-bottom: 1px solid #e5e5e5;">' + fmtUyu(cat.uyu);
    if (cat.usd > 0) html += '<br><span style="color: #666; font-size: 12px;">+ ' + fmtUsd(cat.usd) + '</span>';
    html += '</td><td style="text-align: right; padding: 10px; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 12px;">' + cat.count + ' gastos</td></tr>';
  }
  html += '</table>';

  // Top 10 ítems
  if (ca.topItems.length) {
    const TH8 = 'padding: 8px; border-bottom: 2px solid #e5e5e5;';
    html += '<h2 style="margin-top: 32px;">Top 10 gastos individuales</h2><table style="width: 100%; border-collapse: collapse;">';
    html += '<tr style="background: #f5f5f5;"><th style="text-align: left; ' + TH8 + '">#</th><th style="text-align: left; ' + TH8 + '">Ítem</th>' +
      '<th style="text-align: left; ' + TH8 + '">Categoría</th><th style="text-align: right; ' + TH8 + '">Monto</th></tr>';
    ca.topItems.forEach((it, i) => {
      html += '<tr><td style="padding: 8px; border-bottom: 1px solid #e5e5e5; color: #666;">' + (i + 1) + '</td>';
      html += '<td style="padding: 8px; border-bottom: 1px solid #e5e5e5;">' + e(it.item) + '</td>';
      html += '<td style="padding: 8px; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 12px;">' + (e(it.cat) || '—') + '</td>';
      html += '<td style="text-align: right; padding: 8px; border-bottom: 1px solid #e5e5e5;">';
      if (it.uyu > 0) html += fmtUyu(it.uyu);
      if (it.usd > 0) html += (it.uyu > 0 ? ' + ' : '') + fmtUsd(it.usd);
      html += '</td></tr>';
    });
    html += '</table>';
  }

  // Dónde aflojar
  html += '<h2 style="margin-top: 32px;">🎯 Dónde aflojar</h2><ul style="line-height: 1.7;">';
  const recs = [];
  const totalEq = ca.sumUyu + ca.sumUsd * FX;
  for (const m of minimizarRows) {
    const avgEq = avgOf(previous.map((md) => findCat(md.audit, m.name)).filter((c) => c).map(equiv));
    const nowEq = equiv(m);
    const share = totalEq > 0 ? Math.round(nowEq / totalEq * 100) : 0;
    let txt = '<li><b>' + e(m.name) + '</b>: ' + fmtUyu(nowEq) + ' en el mes (' + share + '% de los variables)';
    if (avgEq > 0 && nowEq > avgEq * 1.1) txt += ', <span style="color: #dc2626;">por encima</span> de tu promedio de ' + fmtUyu(avgEq);
    else if (avgEq > 0 && nowEq < avgEq * 0.9) txt += ', <span style="color: #15803d;">por debajo</span> de tu promedio de ' + fmtUyu(avgEq) + ' — bien';
    txt += '. Fijate un tope para el mes que viene' + (avgEq > 0 ? ' (por ejemplo ' + fmtUyu(Math.min(nowEq, avgEq) * 0.8) + ', un 20% menos)' : '') + '.</li>';
    recs.push(txt);
  }
  for (const cat of ca.topCategorias.slice(0, 5)) {
    if (CATS_A_MINIMIZAR.indexOf(cat.name) >= 0) continue; // ya salió arriba
    const avg = avgOf(previous.map((md) => findCat(md.audit, cat.name)).filter((c) => c).map((c) => c.uyu));
    if (avg > 0 && cat.uyu > avg * 1.3) {
      recs.push('<li><b>' + e(cat.name) + '</b> está <span style="color: #dc2626;">' + ((cat.uyu - avg) / avg * 100).toFixed(0) + '% arriba</span> del promedio (avg ' + fmtUyu(avg) + ' vs ahora ' + fmtUyu(cat.uyu) + '). Identificá qué cambió este mes.</li>');
    }
  }
  if (comidaCurrent && comidaCurrent.uyu > 8000) {
    recs.push('<li><b>Comida</b> es tu mayor margen flexible — reducir 1-2 salidas o pedidos semanales puede bajar 3-5k UYU/mes.</li>');
  }
  const subs = findCat(ca, 'Suscripciones');
  if (subs && subs.usd > 0) {
    recs.push('<li><b>Suscripciones</b> · ' + fmtUsd(subs.usd) + ' USD este mes. Revisá cuáles usás de verdad — cancelar 1-2 chicas libera ~5-10 USD/mes.</li>');
  }
  if (!recs.length) recs.push('<li>Todo dentro de rango vs los meses previos. Mantené el ritmo.</li>');
  html += recs.join('') + '</ul>';

  html += await seccionHabitos(env, tenant, mes);

  html += '<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0 16px;">';
  html += '<p style="font-size: 11px; color: #888;">Reporte generado por el Worker de gastos. Trigger automático: día 1 de cada mes a las 9am (reporta el mes anterior).</p>';
  return html + '</body></html>';
}

// Sección de hábitos del mes. Devuelve '' si no hay datos: nunca rompe el reporte de gastos.
async function seccionHabitos(env, tenant, mes) {
  try {
    const d = await getHabitsData(env, tenant, mes);
    if (!d || !d.ok || !d.daysTracked) return '';
    const a = d.avg || {}, t = d.totals || {}, c = d.correlations || {};
    const nn = (v, suf) => (v == null ? '—' : v + (suf || ''));
    const pctDe = (n) => Math.round(n / d.daysTracked * 100);

    let h = '<h2 style="margin-top: 36px;">🧘 Hábitos del mes</h2>';
    h += '<p style="color:#666;font-size:13px;margin-top:-8px;">' + plural(d.daysTracked, 'día registrado', 'días registrados') +
      ' · ' + plural(d.totalMeals, 'comida', 'comidas') + ' en el log</p>';

    h += '<table style="width:100%;border-collapse:collapse;margin-top:12px;">';
    const kpis = [
      ['😴 Sueño promedio', nn(a.sueno, ' hs')],
      ['💼 Trabajo total', nn(t.trabajo, ' hs')],
      ['📈 Avance promedio', nn(a.avance, ' / 5')],
      ['🔥 Racha avance 4+', plural(d.streak, 'día', 'días')]
    ];
    if (a.animo != null) kpis.push(['🙂 Ánimo promedio', a.animo + ' / 5']);
    if (t.ejercicioDias) {
      kpis.push(['🏃 Días con ejercicio', t.ejercicioDias + ' de ' + d.daysTracked + '  (' + pctDe(t.ejercicioDias) + '%)']);
      if (t.ejercicioMin) kpis.push(['⏱️ Minutos de ejercicio', t.ejercicioMin + ' min']);
    }
    if (t.mediteDias) {
      kpis.push(['🧘 Días que medité', t.mediteDias + ' de ' + d.daysTracked + '  (' + pctDe(t.mediteDias) + '%)' + (t.mediteMin ? '  ·  ' + t.mediteMin + ' min' : '')]);
    }
    if (t.abordajes) {
      kpis.push(['🗣️ Abordajes', t.abordajes + '  ·  ' + t.abordajesDias + ' de ' + d.daysTracked + ' días  (' + pctDe(t.abordajesDias) + '%)']);
    }
    if (t.leiDias) kpis.push(['📖 Días que leí', t.leiDias + ' de ' + d.daysTracked + '  (' + pctDe(t.leiDias) + '%)']);
    if (a.agua != null) kpis.push(['💧 Agua promedio', Math.round(a.agua) + ' ml/día  (objetivo ' + WATER_GOAL_ML + ')']);
    const ki = d.kcalInfo || {};
    if (a.kcal != null && ki.dias) {
      kpis.push(['🔥 Calorías', Math.round(a.kcal) + ' kcal/día sobre ' + ki.dias + ' día' + (ki.dias === 1 ? '' : 's') + ' con foto']);
    }
    if (t.mast) {
      const perWeek = Math.round(t.mast / Math.max(d.daysTracked, 1) * 7 * 10) / 10;
      kpis.push(['📊 Masturbación', t.mast + ' en el mes (~' + perWeek + '/semana)']);
    }
    for (const k of kpis) {
      h += '<tr><td style="padding:9px;border-bottom:1px solid #e5e5e5;">' + k[0] + '</td>' +
        '<td style="padding:9px;border-bottom:1px solid #e5e5e5;text-align:right;"><b>' + e(k[1]) + '</b></td></tr>';
    }
    h += '</table>';

    // Correlaciones (solo con muestra suficiente en ambos grupos)
    const ok = (x, y) => x && y && x.n >= 3 && y.n >= 3 && x.avance != null && y.avance != null;
    const corr = [];
    if (ok(c.sleepGood, c.sleepBad)) {
      const diff = c.sleepGood.avance - c.sleepBad.avance;
      const arrow = diff > 0.4 ? ' — dormir más te está rindiendo' : (diff < -0.4 ? ' — la relación va al revés este mes' : ' — sin diferencia clara');
      corr.push('<li>Con <b>7+ hs de sueño</b> tu avance promedio es <b>' + c.sleepGood.avance + '</b> (' + c.sleepGood.n + ' días) vs <b>' +
        c.sleepBad.avance + '</b> con menos (' + c.sleepBad.n + ' días)' + arrow + '.</li>');
    }
    if (ok(c.withUltraprocesado, c.withoutUltraprocesado)) {
      corr.push('<li>Días <b>con ultraprocesados</b>: avance <b>' + c.withUltraprocesado.avance + '</b> (' + c.withUltraprocesado.n + ' días) vs <b>' +
        c.withoutUltraprocesado.avance + '</b> sin ellos (' + c.withoutUltraprocesado.n + ' días).</li>');
    }
    if (ok(c.withEjercicio, c.withoutEjercicio)) {
      corr.push('<li>Días <b>con ejercicio</b>: avance <b>' + c.withEjercicio.avance + '</b> (' + c.withEjercicio.n + ' días) vs <b>' +
        c.withoutEjercicio.avance + '</b> sin entrenar (' + c.withoutEjercicio.n + ' días)' +
        (c.withEjercicio.animo != null && c.withoutEjercicio.animo != null ? ' · ánimo ' + c.withEjercicio.animo + ' vs ' + c.withoutEjercicio.animo : '') + '.</li>');
    }
    if (corr.length) h += '<h3 style="margin-top:24px;font-size:15px;">🔍 Correlaciones</h3><ul style="line-height:1.7;">' + corr.join('') + '</ul>';

    // Macros
    if (d.byMacro && d.byMacro.length) {
      h += '<h3 style="margin-top:24px;font-size:15px;">🍽️ Composición de comidas</h3><table style="width:100%;border-collapse:collapse;">';
      const totalM = d.byMacro.reduce((s, m) => s + m.count, 0) || 1;
      for (const m of d.byMacro) {
        h += '<tr><td style="padding:7px;border-bottom:1px solid #f0f0f0;">' + e(m.name) + '</td>' +
          '<td style="padding:7px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;font-size:12px;">' +
          plural(m.count, 'vez', 'veces') + ' · ' + Math.round(m.count / totalM * 100) + '%</td></tr>';
      }
      h += '</table>';
    }
    if (ki.parcial && ki.comidas > 0) {
      h += '<p style="font-size:11px;color:#888;margin-top:4px;">Las calorías salen sólo de las ' + ki.comidas + ' comidas que cargaste con foto, de ' +
        ki.totalComidas + ' en total — tomalas como referencia parcial, no como el total del día.</p>';
    }

    // Tipos de ejercicio
    if (d.byEjercicio && d.byEjercicio.length) {
      h += '<h3 style="margin-top:24px;font-size:15px;">🏃 Ejercicio</h3><table style="width:100%;border-collapse:collapse;">';
      for (const x of d.byEjercicio) {
        h += '<tr><td style="padding:7px;border-bottom:1px solid #f0f0f0;">' + e(x.name) + '</td>' +
          '<td style="padding:7px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;font-size:12px;">' + plural(x.count, 'día', 'días') + '</td></tr>';
      }
      h += '</table>';
    }

    // Ajustes sugeridos
    const tips = [];
    if (a.sueno != null && a.sueno < 7) tips.push('<li>Dormís <b>' + a.sueno + ' hs</b> en promedio. Subir a 7+ es la palanca más barata que tenés para el avance.</li>');
    if (a.avance != null && a.avance < 3) tips.push('<li>Avance promedio <b>' + a.avance + '/5</b>. Mirá los días de 4-5 y qué tuvieron en común (sueño, horario de arranque, comidas).</li>');
    const up = (d.byMacro || []).find((m) => m.name === 'Ultraprocesado');
    if (up && d.totalMeals && up.count / d.totalMeals > 0.25) {
      tips.push('<li><b>' + Math.round(up.count / d.totalMeals * 100) + '%</b> de tus comidas son ultraprocesadas. Bajar a menos del 15% es un objetivo concreto para el mes que viene.</li>');
    }
    if (t.ejercicioDias != null && d.daysTracked >= 10) {
      const pctEx = pctDe(t.ejercicioDias);
      if (pctEx < 40) tips.push('<li>Entrenaste <b>' + t.ejercicioDias + ' de ' + d.daysTracked + ' días</b> (' + pctEx + '%). Subir a 3-4 días por semana es un objetivo concreto.</li>');
      else tips.push('<li>Buen ritmo de ejercicio: <b>' + pctEx + '%</b> de los días registrados.</li>');
    }
    if (a.agua != null && a.agua < WATER_GOAL_ML) {
      const falta = WATER_GOAL_ML - Math.round(a.agua);
      tips.push('<li>Promedio de <b>' + Math.round(a.agua) + ' ml de agua</b> por día — te faltan <b>' + falta + ' ml</b> para los ' + WATER_GOAL_ML +
        ' ml que te propusiste (unos ' + Math.ceil(falta / 250) + ' vasos más por día).</li>');
    } else if (a.agua != null) {
      tips.push('<li>Agua: <b>' + Math.round(a.agua) + ' ml/día</b> de promedio, por encima de tu objetivo de ' + WATER_GOAL_ML + ' ml. ✓</li>');
    }
    if (t.trabajo != null && d.daysTracked >= 10) {
      tips.push('<li>Promedio de <b>' + Math.round(t.trabajo / d.daysTracked * 10) / 10 + ' hs/día</b> trabajadas sobre ' + d.daysTracked + ' días registrados.</li>');
    }
    if (tips.length) h += '<h3 style="margin-top:24px;font-size:15px;">🎯 Ajustes para el mes que viene</h3><ul style="line-height:1.7;">' + tips.join('') + '</ul>';
    return h;
  } catch (err) {
    console.error('seccionHabitos error:', String(err && err.message || err));
    return '';
  }
}

// ---- Tareas de hoy -----------------------------------------------------------------------------------------
function htmlTareas(d) {
  const li = (icon, texto, sub) => '<li style="margin-bottom:6px">' + icon + ' <b>' + e(texto) + '</b>' + (sub ? ' <span style="color:#888">' + e(sub) + '</span>' : '') + '</li>';
  let h = HEAD + '<title>Tareas de hoy</title></head><body style="margin:0;padding:20px;"><div style="font-family:-apple-system,Segoe UI,sans-serif;color:#111827;max-width:720px;margin:0 auto;">';
  h += '<h2 style="margin:0 0 12px">🗓️ Tareas de hoy — ' + e(d.hoy) + '</h2>';
  if (!d.total) h += '<p style="color:#4b5563">No tenés nada pendiente para hoy. 🎉</p>';
  if (d.citasHoy.length) {
    h += '<h3 style="font-size:14px;margin:16px 0 6px">📅 Citas de hoy</h3><ul style="padding-left:20px;margin:0">';
    d.citasHoy.forEach((c) => { h += li('📅', (c.hora ? c.hora + ' — ' : '') + c.texto, c.notas); });
    h += '</ul>';
  }
  if (d.tareasHoy.length) {
    h += '<h3 style="font-size:14px;margin:16px 0 6px">☐ Para hoy</h3><ul style="padding-left:20px;margin:0">';
    d.tareasHoy.forEach((t) => { h += li('☐', t.texto, t.notas); });
    h += '</ul>';
  }
  if (d.vencidas.length) {
    h += '<h3 style="font-size:14px;margin:16px 0 6px;color:#b91c1c">⚠️ Vencidas</h3><ul style="padding-left:20px;margin:0">';
    d.vencidas.forEach((v) => { h += li('⚠️', v.texto, v.fecha); });
    h += '</ul>';
  }
  return h + '</div></body></html>';
}

// { html, total }: total = citas de hoy + tareas de hoy + vencidas (lo que decide si vale el mail).
export async function tareasHoy(env, tenant) {
  const d = await digestHoy(env, tenant);
  return { html: htmlTareas(d), total: d.total };
}
export async function tareasHoyHtml(env, tenant) {
  return (await tareasHoy(env, tenant)).html;
}

// ---- Envío por mail (Resend) ---------------------------------------------------------------------------------
// Solo si hay RESEND_API_KEY y MAIL_TO (secretos/vars del Worker). MAIL_TO admite varias direcciones
// separadas por coma. Remitente: MAIL_FROM o, por defecto, el de pruebas de Resend (que solo entrega a
// la dirección dueña de la cuenta). RESEND_API_URL existe solo para apuntar a un mock en las pruebas.
const RESEND_URL = 'https://api.resend.com/emails';

export const hayProveedorDeMail = (env) => !!(env.RESEND_API_KEY && env.MAIL_TO);

async function mandarMail(env, asunto, html) {
  const to = String(env.MAIL_TO).split(',').map((x) => x.trim()).filter(Boolean);
  const res = await fetch(env.RESEND_API_URL || RESEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'onboarding@resend.dev', to, subject: asunto, html })
  });
  const texto = await res.text();
  if (!res.ok) return { ok: false, enviado: false, error: 'Resend ' + res.status + ': ' + texto.slice(0, 200) };
  let id = '';
  try { id = JSON.parse(texto).id || ''; } catch { /* respuesta sin JSON */ }
  return { ok: true, enviado: true, a: to, id };
}

// tipo: 'mensual' (opts.mes opcional, por defecto el mes anterior) | 'tareas' (no manda si no hay nada).
export async function enviarInforme(env, tenant, tipo, opts) {
  if (tipo !== 'mensual' && tipo !== 'tareas') return { ok: false, error: 'tipo inválido (mensual | tareas)' };
  if (!hayProveedorDeMail(env)) return { ok: true, enviado: false, motivo: 'sin proveedor de mail' };
  if (tipo === 'mensual') {
    const mes = opts && opts.mes ? opts.mes : mesPorDefecto();
    if (!mesValido(mes)) return { ok: false, error: 'mes inválido (YYYY-MM)' };
    const r = await mandarMail(env, '📊 Reporte de gastos — ' + tabDeMes(mes), await reporteMensualHtml(env, tenant, mes));
    return { ...r, tipo, mes };
  }
  const { html, total } = await tareasHoy(env, tenant);
  if (!total) return { ok: true, enviado: false, tipo, motivo: 'nada pendiente' };
  return { ...(await mandarMail(env, '🗓️ Tareas de hoy (' + total + ')', html)), tipo, total };
}
