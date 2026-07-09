// Research Dashboard (Feature C) — administrator-only research platform UI.
// Access is enforced server-side (researchAdminRequired) AND guarded here; a
// regular user can never load this. Shows anonymous participant summaries, a
// data-quality report, variable distributions, a correlation matrix, and
// longitudinal trends — all aggregate, min-cohort gated, with explicit
// observational-not-causal framing.
import { api, state, esc, fmtDistance, fmtDate } from '../api.js';
import { drawDistribution, drawTrend } from '../components/charts.js';

const VAR_LABEL = {
  weeklyMeters: 'Weekly m', weeklySessions: 'Sessions/wk', rolling7dLoadMin: '7d load',
  rolling28dLoadMin: '28d load', acuteChronicWorkloadRatio: 'ACWR', trainingMonotony: 'Monotony',
  trainingStrain: 'Strain', strokeRateMean: 'Rate', daysBetweenWorkouts: 'Gap d', consistencyScore: 'Consistency', best2kSeconds: '2k s',
};
const filters = {};

export async function renderResearchDashboard(el) {
  if (!state.user?.isAdmin || !state.user?.researchAdmin) {
    el.innerHTML = '<div class="notice warn">Research Administrator permission required.</div>';
    return;
  }
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let parts, quality, dist, corr, trends;
  try {
    const q = query();
    [parts, quality, dist, corr, trends] = await Promise.all([
      api(`/research-admin/participants${q}`), api('/research-admin/quality'),
      api(`/research-admin/variables${q}`), api(`/research-admin/correlations${q}`),
      api('/research-admin/trends?variable=weeklyMeters'),
    ]);
  } catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  draw(el, parts.participants, quality.quality, dist.distributions, corr.correlations, trends.trends);
}

function query() {
  const q = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return q ? `?${q}` : '';
}

function draw(el, p, quality, dist, corr, trends) {
  el.innerHTML = `
    <header class="mb"><h1>Research platform</h1>
      <p class="muted">Anonymous, aggregate-only. Minimum cohort ${p.minCohort} before any statistic is shown.</p></header>

    <div class="card">
      <h3>Cohort filter</h3>
      <div class="grid cols3" style="gap:10px">
        ${select('sex', 'Sex', ['', 'female', 'male', 'other'])}
        ${select('ageRange', 'Age band', ['', 'under_18', '18-24', '25-34', '35-44', '45-54', '55-64', '65_plus'])}
        ${select('competitionLevel', 'Level', ['', 'recreational', 'club', 'school', 'university', 'national', 'elite'])}
        ${select('trainingEnvironment', 'Environment', ['', 'erg', 'water', 'mixed'])}
        ${select('weightClass', 'Weight', ['', 'lightweight', 'heavyweight', 'openweight'])}
        <div style="display:flex;align-items:flex-end;gap:8px"><button id="apply" style="flex:1">Apply</button><button class="ghost sm" id="clear">Clear</button></div>
      </div>
      <div class="grid cols3 mt">
        ${tile(p.totalParticipants, 'total participants')}
        ${tile(p.cohortParticipants, 'in this cohort')}
        ${tile(p.totalRecords, 'workout records')}
      </div>
      ${p.suppressed ? `<p class="notice small mt">Cohort below the minimum size — statistics suppressed to protect anonymity.</p>` : ''}
    </div>

    ${p.demographics ? `<div class="card"><h3>Demographics</h3><div class="grid cols3">
      ${['sex', 'ageRange', 'competitionLevel', 'trainingEnvironment', 'weightClass', 'country'].map(k => demoBlock(k, p.demographics[k])).join('')}
    </div><p class="muted small">Cells below the minimum cohort are shown as “suppressed”.</p></div>` : ''}

    <div class="card"><h3>Data quality</h3>
      <div class="grid cols3">
        ${tile(quality.totalRecords, 'records')}
        ${tile(quality.flaggedPct + '%', 'flagged')}
        ${tile(quality.meanMeasurementConfidence ?? '–', 'mean confidence (0–1)')}
      </div>
      <div class="grid cols2 mt">
        <div><strong class="small">Quality flags</strong>
          ${kvTable(quality.flagCounts)}</div>
        <div><strong class="small">Missing measures</strong>
          ${kvTable(Object.fromEntries(Object.entries(quality.missingByMeasure).map(([k, v]) => [k, `${v.count} (${v.pct}%)`])))}</div>
      </div>
      <p class="muted small mt">${esc(quality.note)}</p>
    </div>

    ${dist.suppressed ? '' : `<div class="card"><h3>Variable distributions</h3>
      <div class="grid cols2">${['weeklyMeters', 'acuteChronicWorkloadRatio', 'trainingMonotony', 'consistencyScore'].filter(k => dist.variables[k]?.histogram).map(k => `
        <div><div class="small" style="display:flex;justify-content:space-between"><strong>${esc(VAR_LABEL[k])}</strong>
          <span class="muted">median ${dist.variables[k].quantiles?.median ?? '–'} (n=${dist.variables[k].quantiles?.n ?? 0})</span></div>
          <canvas id="dv_${k}"></canvas></div>`).join('')}</div></div>`}

    ${corr.suppressed ? '' : `<div class="card"><h3>Correlation matrix</h3>
      <div style="overflow-x:auto">${corrTable(corr)}</div>
      <p class="muted small">${esc(corr.note)}</p></div>`}

    ${trends.points.length ? `<div class="card"><h3>Weekly volume — dataset median over time</h3>
      <canvas id="trendCanvas"></canvas><p class="muted small">Weeks below the minimum cohort are omitted.</p></div>` : ''}

    <p class="muted small">Observational data. Distinguishes measured / derived / estimated variables; associations are never causal claims. Every view here is written to the research audit log.</p>`;

  el.querySelector('#apply').onclick = () => {
    for (const k of ['sex', 'ageRange', 'competitionLevel', 'trainingEnvironment', 'weightClass']) filters[k] = el.querySelector(`#f_${k}`).value || '';
    renderResearchDashboard(el);
  };
  el.querySelector('#clear').onclick = () => { Object.keys(filters).forEach(k => delete filters[k]); renderResearchDashboard(el); };

  requestAnimationFrame(() => {
    if (!dist.suppressed) for (const k of ['weeklyMeters', 'acuteChronicWorkloadRatio', 'trainingMonotony', 'consistencyScore']) {
      const c = el.querySelector(`#dv_${k}`); if (c && dist.variables[k]?.histogram) drawDistribution(c, dist.variables[k].histogram, null, { fmt: (v) => Math.round(v) });
    }
    const tc = el.querySelector('#trendCanvas');
    if (tc && trends.points.length) drawTrend(tc, [{ label: 'median weekly m', color: '#38bdf8', points: trends.points.map((pt, i) => ({ x: i, y: pt.median })) }]);
  });
}

function corrTable(corr) {
  const v = corr.variables;
  const cell = (c) => {
    if (!c) return '<td class="small muted" style="text-align:center">–</td>';
    const r = c.r; const hue = r >= 0 ? 210 : 0; const a = Math.min(0.75, Math.abs(r));
    return `<td style="text-align:center;background:hsla(${hue},80%,55%,${a});font-size:.72rem" title="r=${r}, n=${c.n}">${r}</td>`;
  };
  return `<table style="font-size:.72rem"><thead><tr><th></th>${v.map(x => `<th style="writing-mode:vertical-rl;transform:rotate(180deg);font-size:.62rem">${esc(VAR_LABEL[x] || x)}</th>`).join('')}</tr></thead>
    <tbody>${corr.matrix.map((row, i) => `<tr><td class="small" style="white-space:nowrap">${esc(VAR_LABEL[v[i]] || v[i])}</td>${row.map(cell).join('')}</tr>`).join('')}</tbody></table>`;
}

function demoBlock(key, obj) {
  if (!obj) return '';
  return `<div><strong class="small">${esc(key)}</strong>${kvTable(obj)}</div>`;
}
function kvTable(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '<p class="muted small">—</p>';
  return `<table class="small"><tbody>${entries.map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right">${esc(String(v))}</td></tr>`).join('')}</tbody></table>`;
}
function select(key, label, vals) {
  return `<label class="field" style="margin:0"><span>${esc(label)}</span><select id="f_${key}">${vals.map(v => `<option value="${esc(v)}" ${filters[key] === v ? 'selected' : ''}>${esc(v || 'Any')}</option>`).join('')}</select></label>`;
}
const tile = (v, l) => `<div class="stat-tile tight"><div class="n">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`;
