// RowPoint Research Observatory (moat system #1). Shows an athlete where they
// stand among the anonymous, research-opted-in population: percentiles,
// distribution charts with a "you" marker, and hedged observational insights.
// Aggregate-only — never an individual. Backed by /api/observatory.
import { api, state, esc, fmtDistance, fmtDuration } from '../api.js';
import { t } from '../i18n.js';
import { drawDistribution } from '../components/charts.js';

const filters = { weightClass: '', goalType: '', birthDecade: '' };

const METRIC_FMT = {
  weeklyMeters: (v) => fmtDistance(v),
  workoutsPerWeek: (v) => `${v}/wk`,
  avgStrokeRate: (v) => `${v} spm`,
  best2k: (v) => fmtDuration(v),
  best5k: (v) => fmtDuration(v),
  best6k: (v) => fmtDuration(v),
};
const METRIC_ORDER = ['weeklyMeters', 'workoutsPerWeek', 'best2k', 'best5k', 'best6k', 'avgStrokeRate'];

export async function renderObservatory(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let obs;
  try { ({ observatory: obs } = await api(`/observatory${query()}`)); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  draw(el, obs);
}

function query() {
  const q = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return q ? `?${q}` : '';
}

function draw(el, obs) {
  const optedIn = !!state.user?.researchOptIn;
  const confColor = { high: 'good', moderate: 'amber', low: '' }[obs.confidence] || '';
  el.innerHTML = `
    <header class="mb">
      <h1>${esc(t('obs.title'))}</h1>
      <p class="muted">${esc(t('obs.subtitle'))}</p>
    </header>

    ${optedIn ? '' : `<div class="notice mb">🔬 ${esc(t('obs.optInPrompt'))} <a href="#/settings">${esc(t('obs.optInCta'))}</a></div>`}

    <div class="card">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
        <label class="field" style="margin:0"><span>${esc(t('obs.weightClass'))}</span>
          <select id="fWeight">${opt('', t('obs.any'))}${opt('lightweight', t('obs.lightweight'), filters.weightClass)}${opt('heavyweight', t('obs.heavyweight'), filters.weightClass)}${opt('openweight', t('obs.openweight'), filters.weightClass)}</select></label>
        <label class="field" style="margin:0"><span>${esc(t('obs.focus'))}</span>
          <select id="fGoal">${opt('', t('obs.any'))}${opt('race_prep', t('obs.racePrep'), filters.goalType)}${opt('general_fitness', t('obs.generalFitness'), filters.goalType)}${opt('weight_class', t('obs.weightMgmt'), filters.goalType)}</select></label>
        <button class="secondary sm" id="likeMe">${esc(t('obs.likeMe'))}</button>
      </div>
      <p class="muted small mt">
        <span class="badge ${confColor}">${esc(t('obs.confidence_' + obs.confidence))}</span>
        ${esc(t('obs.cohortSize', { n: obs.cohortSize, total: obs.populationSize }))}
      </p>
    </div>

    ${!obs.enoughData ? `<div class="card"><div class="empty">
        <span class="ic" aria-hidden="true">🌍</span>
        <h3>${esc(t('obs.building'))}</h3>
        <p class="muted small">${esc(t('obs.buildingNote', { n: obs.minCohort }))}</p>
      </div></div>`
    : `
      ${obs.insights.length ? `<div class="card"><h3>${esc(t('obs.insights'))}</h3>
        ${obs.insights.map(i => `<div class="small" style="display:flex;gap:8px;margin:6px 0"><span>📊</span><span>${esc(i)}</span></div>`).join('')}
      </div>` : ''}

      <div class="grid cols2">
        ${METRIC_ORDER.filter(k => obs.metrics[k] && obs.metrics[k].percentile != null).map(k => metricCard(k, obs.metrics[k])).join('')}
      </div>`}

    <p class="muted small mt">${esc(obs.disclaimer)}</p>`;

  el.querySelector('#fWeight').onchange = (e) => { filters.weightClass = e.target.value; renderObservatory(el); };
  el.querySelector('#fGoal').onchange = (e) => { filters.goalType = e.target.value; renderObservatory(el); };
  el.querySelector('#likeMe').onclick = () => {
    const me = obs.you || {};
    filters.weightClass = me.weightClass || '';
    filters.goalType = me.goalType || '';
    filters.birthDecade = me.birthDecade || '';
    renderObservatory(el);
  };

  requestAnimationFrame(() => {
    for (const k of METRIC_ORDER) {
      const m = obs.metrics[k]; if (!m || m.percentile == null) continue;
      const canvas = el.querySelector(`#dist_${k}`);
      if (canvas) drawDistribution(canvas, m.histogram, m.you, {
        fmt: k.startsWith('best') ? (v) => fmtDuration(v) : (v) => (k === 'weeklyMeters' ? Math.round(v / 1000) + 'k' : Math.round(v)),
      });
    }
  });
}

function metricCard(key, m) {
  const fmt = METRIC_FMT[key] || ((v) => v);
  const pctText = m.direction === 'low'
    ? t('obs.fasterThan', { pct: m.percentile })
    : t('obs.greaterThan', { pct: m.percentile });
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <h3 style="margin:0">${esc(t('obs.metric_' + key, {}) || m.label)}</h3>
      <span class="badge good">${m.percentile}${esc(t('obs.pctile'))}</span>
    </div>
    <p class="small muted" style="margin:4px 0">${esc(t('obs.you'))}: <strong>${m.you != null ? esc(fmt(m.you)) : '–'}</strong>${m.quantiles ? ` · ${esc(t('obs.median'))} ${esc(fmt(m.quantiles.median))}` : ''}</p>
    <canvas id="dist_${key}"></canvas>
    <p class="small muted">${esc(pctText)}</p>
  </div>`;
}

function opt(val, label, cur) {
  return `<option value="${esc(val)}" ${cur === val ? 'selected' : ''}>${esc(label)}</option>`;
}
