// Benchmark Explorer (moat #3). Interactive exploration of the anonymous
// research population: set filters (weight class, age, focus, 2k range, weekly
// volume) and see the resulting benchmark distributions + observational
// insights. Reuses the Observatory aggregation engine — /api/observatory/benchmark.
import { api, esc, fmtDistance, fmtDuration } from '../api.js';
import { t } from '../i18n.js';
import { drawDistribution } from '../components/charts.js';

const filters = { weightClass: '', goalType: '', best2kMin: '', best2kMax: '', weeklyMetersMin: '' };
const ORDER = ['best2k', 'weeklyMeters', 'workoutsPerWeek', 'best5k', 'best6k', 'avgStrokeRate'];
const FMT = {
  best2k: (v) => fmtDuration(v), best5k: (v) => fmtDuration(v), best6k: (v) => fmtDuration(v),
  weeklyMeters: (v) => fmtDistance(v), workoutsPerWeek: (v) => `${v}/wk`, avgStrokeRate: (v) => `${v} spm`,
};

function parseTime(s) { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : ''; }

export async function renderBenchmark(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let bm;
  try { ({ benchmark: bm } = await api(`/observatory/benchmark${query()}`)); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  draw(el, bm);
}

function query() {
  const q = Object.entries(filters).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return q ? `?${q}` : '';
}

function draw(el, bm) {
  const conf = { high: 'good', moderate: 'amber', low: '' }[bm.confidence] || '';
  el.innerHTML = `
    <header class="mb"><h1>${esc(t('bench.title'))}</h1><p class="muted">${esc(t('bench.subtitle'))}</p></header>

    <div class="card">
      <h3>${esc(t('bench.filters'))}</h3>
      <div class="grid cols3" style="gap:10px">
        <label class="field" style="margin:0"><span>${esc(t('obs.weightClass'))}</span>
          <select id="fWeight">${o('', t('obs.any'))}${o('lightweight', t('obs.lightweight'), filters.weightClass)}${o('heavyweight', t('obs.heavyweight'), filters.weightClass)}${o('openweight', t('obs.openweight'), filters.weightClass)}</select></label>
        <label class="field" style="margin:0"><span>${esc(t('obs.focus'))}</span>
          <select id="fGoal">${o('', t('obs.any'))}${o('race_prep', t('obs.racePrep'), filters.goalType)}${o('general_fitness', t('obs.generalFitness'), filters.goalType)}${o('weight_class', t('obs.weightMgmt'), filters.goalType)}</select></label>
        <label class="field" style="margin:0"><span>${esc(t('bench.minVolume'))}</span>
          <input id="fVol" type="number" min="0" step="10" placeholder="km" value="${filters.weeklyMetersMin ? Math.round(filters.weeklyMetersMin / 1000) : ''}"></label>
        <label class="field" style="margin:0"><span>${esc(t('bench.faster2k'))}</span><input id="f2kMax" placeholder="6:30" value="${filters.best2kMax ? fmtMMSS(filters.best2kMax) : ''}"></label>
        <label class="field" style="margin:0"><span>${esc(t('bench.slower2k'))}</span><input id="f2kMin" placeholder="7:30" value="${filters.best2kMin ? fmtMMSS(filters.best2kMin) : ''}"></label>
        <div style="display:flex;align-items:flex-end;gap:8px"><button id="applyBtn" style="flex:1">${esc(t('bench.apply'))}</button><button class="ghost sm" id="clearBtn">${esc(t('bench.clear'))}</button></div>
      </div>
      <p class="muted small mt"><span class="badge ${conf}">${esc(t('obs.confidence_' + bm.confidence))}</span> ${esc(t('bench.cohort', { n: bm.cohortSize, total: bm.populationSize }))}</p>
    </div>

    ${!bm.enoughData ? `<div class="card"><div class="empty"><span class="ic">🔎</span>
        <h3>${esc(t('bench.narrow'))}</h3><p class="muted small">${esc(t('obs.buildingNote', { n: bm.minCohort }))}</p></div></div>`
    : `
      ${bm.insights.length ? `<div class="card"><h3>${esc(t('bench.insights'))}</h3>
        ${bm.insights.map(i => `<div class="small" style="display:flex;gap:8px;margin:6px 0"><span>📊</span><span>${esc(i)}</span></div>`).join('')}
      </div>` : ''}
      <div class="grid cols2">
        ${ORDER.filter(k => bm.metrics[k]?.quantiles).map(k => card(k, bm.metrics[k])).join('')}
      </div>`}

    <p class="muted small mt">${esc(bm.disclaimer)}</p>`;

  const g = (id) => el.querySelector(id);
  g('#applyBtn').onclick = () => {
    filters.weightClass = g('#fWeight').value;
    filters.goalType = g('#fGoal').value;
    filters.weeklyMetersMin = g('#fVol').value ? Number(g('#fVol').value) * 1000 : '';
    filters.best2kMax = parseTime(g('#f2kMax').value) || '';
    filters.best2kMin = parseTime(g('#f2kMin').value) || '';
    renderBenchmark(el);
  };
  g('#clearBtn').onclick = () => { Object.keys(filters).forEach(k => filters[k] = ''); renderBenchmark(el); };

  requestAnimationFrame(() => {
    for (const k of ORDER) {
      const m = bm.metrics[k]; if (!m?.histogram) continue;
      const c = el.querySelector(`#bd_${k}`);
      if (c) drawDistribution(c, m.histogram, null, { fmt: k.startsWith('best') ? (v) => fmtDuration(v) : (v) => (k === 'weeklyMeters' ? Math.round(v / 1000) + 'k' : Math.round(v)) });
    }
  });
}

function card(key, m) {
  const fmt = FMT[key] || ((v) => v);
  const q = m.quantiles;
  return `<div class="card">
    <h3 style="margin:0 0 4px">${esc(t('obs.metric_' + key))}</h3>
    <p class="small muted" style="margin:0 0 4px">${esc(t('bench.range'))}: ${esc(fmt(q.p25))} – ${esc(fmt(q.p75))} · ${esc(t('bench.median'))} <strong>${esc(fmt(q.median))}</strong></p>
    <canvas id="bd_${key}"></canvas>
  </div>`;
}

const o = (val, label, cur) => `<option value="${esc(val)}" ${cur === val ? 'selected' : ''}>${esc(label)}</option>`;
const fmtMMSS = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
