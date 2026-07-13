// Personal Analytics Laboratory (vision #13). Professional-grade exploration of
// the athlete's own data: pace vs stroke rate, heart-rate vs split, training-
// zone distribution, and weekly load — all from /api/performance/lab, drawn
// with the shared canvas charts. Every view explains what it shows.
import { api, esc, fmtDistance, fmtSplit } from '../api.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { drawScatter, drawBars } from '../components/charts.js';

const ZONE_COLOR = { ut2: '#3b82f6', ut1: '#10b981', threshold: '#f59e0b', vo2: '#f97316', sprint: '#ef4444' };
const ZONE_LABEL = { ut2: 'UT2', ut1: 'UT1', threshold: 'AT', vo2: 'VO2', sprint: 'AN' };

export async function renderLab(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let lab;
  try { ({ lab } = await api('/performance/lab')); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }

  if (!lab.hasData) {
    el.innerHTML = `<header class="mb"><h1>${esc(t('lab.title'))}</h1></header>
      <div class="card"><div class="empty"><div class="center" style="margin-bottom:12px"><span class="icon-chip lg">${icon('lightbulb')}</span></div>
        <h3>${esc(t('lab.empty'))}</h3><a class="btn mt" href="#/row">${icon('oar', { size: 17 })} ${esc(t('lab.startRowing'))}</a></div></div>`;
    return;
  }

  const legend = Object.keys(ZONE_LABEL).map(z =>
    `<span class="small" style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:3px;background:${ZONE_COLOR[z]}"></span>${ZONE_LABEL[z]}</span>`).join(' ');

  el.innerHTML = `
    <header class="mb">
      <h1>${esc(t('lab.title'))}</h1>
      <p class="muted">${esc(t('lab.subtitle', { n: lab.workouts90d }))}</p>
    </header>

    <div class="grid cols3">
      <div class="stat-tile"><div class="n">${lab.aerobicPct}%</div><div class="l">${esc(t('lab.aerobic'))}</div></div>
      <div class="stat-tile"><div class="n">${lab.anaerobicPct}%</div><div class="l">${esc(t('lab.anaerobic'))}</div></div>
      <div class="stat-tile"><div class="n">${Math.round(lab.totalZoneMinutes / 60)}h</div><div class="l">${esc(t('lab.trainingTime'))}</div></div>
    </div>

    <div class="card">
      <h3>${esc(t('lab.zoneDist'))}</h3>
      <p class="muted small">${esc(t('lab.zoneDistNote'))}</p>
      <canvas id="labZones"></canvas>
    </div>

    <div class="grid cols2">
      <div class="card">
        <h3>${esc(t('lab.paceRate'))}</h3>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:6px">${legend}</div>
        <canvas id="labPaceRate"></canvas>
        <p class="muted small">${esc(t('lab.paceRateNote'))}</p>
      </div>
      <div class="card">
        <h3>${esc(t('lab.hrSplit'))}</h3>
        <canvas id="labHrSplit"></canvas>
        <p class="muted small">${esc(t('lab.hrSplitNote'))}</p>
      </div>
    </div>

    <div class="card">
      <h3>${esc(t('lab.weeklyLoad'))}</h3>
      <canvas id="labLoad"></canvas>
      <p class="muted small">${esc(t('lab.weeklyLoadNote'))}</p>
    </div>`;

  // Draw after layout so canvases have a measured width.
  requestAnimationFrame(() => {
    const zoneItems = Object.keys(ZONE_LABEL).map(z => ({ label: ZONE_LABEL[z], value: lab.zonePct[z], color: ZONE_COLOR[z] }));
    drawBars(el.querySelector('#labZones'), zoneItems, { height: 150 });

    const pr = lab.scatter.filter(p => p.rate && p.split).map(p => ({ x: p.rate, y: p.split, color: ZONE_COLOR[p.zone] }));
    drawScatter(el.querySelector('#labPaceRate'), pr, { xLabel: t('lab.strokeRate'), yLabel: t('lab.splitFaster'), yInvert: false });

    const hs = lab.scatter.filter(p => p.hr && p.split).map(p => ({ x: p.hr, y: p.split, color: ZONE_COLOR[p.zone] }));
    drawScatter(el.querySelector('#labHrSplit'), hs, { xLabel: t('lab.heartRate'), yLabel: t('lab.splitFaster') });

    const loadItems = lab.weeklyLoad.map(w => ({ label: w.weeksAgo === 0 ? t('lab.now') : `-${w.weeksAgo}`, value: Math.round(w.meters / 1000), color: '#38bdf8' }));
    drawBars(el.querySelector('#labLoad'), loadItems, { height: 160 });
  });
}
