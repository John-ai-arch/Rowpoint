// Athlete State — the Digital Twin's user-facing view.
//
// Renders the athlete's own latent-state estimates by category, each with a
// confidence bar and provenance badge, a summary strip (readiness, predicted
// 2k, strain risk), and a per-variable drawer with description, history
// sparkline, and the evidence trail behind the number. Strictly own-data
// (the API has no way to address another athlete).
import { api, esc, toast, fmtDateTime } from '../api.js';
import { t } from '../i18n.js';
import { openModal } from '../app.js';

const PROV_BADGE = { measured: 'green', estimated: 'blue', assumed: 'amber', predicted: '' };

const fmtVal = (v, unit) => {
  if (!Number.isFinite(v)) return '—';
  const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded}${unit ? ` <span class="muted small">${esc(unit)}</span>` : ''}`;
};

export async function renderTwin(el) {
  el.innerHTML = `<h1>${esc(t('twin.title'))}</h1><p class="muted">${esc(t('common.loading'))}</p>`;
  let data;
  try { data = await api('/twin/state'); }
  catch (e) {
    el.innerHTML = `<h1>${esc(t('twin.title'))}</h1><div class="notice warn">${esc(e.message)}</div>`;
    return;
  }

  const categories = Object.keys(data.model).filter(c => data.state[c] && Object.keys(data.state[c]).length);
  if (!categories.length) {
    el.innerHTML = `<h1>${esc(t('twin.title'))}</h1>
      <p class="muted">${esc(t('twin.subtitle'))}</p>
      <div class="card center"><p class="muted">${esc(t('twin.empty'))}</p>
      <a class="btn" href="#/row">${esc(t('twin.emptyCta'))}</a></div>`;
    return;
  }

  const readiness = data.state.readiness?.score;
  const risk = data.state.injuryRisk?.riskIndex;
  const pred2k = data.racePrediction?.available ? data.racePrediction.predictions?.find(p => p.distance === 2000) : null;

  const summaryTile = (label, valueHtml, sub) => `
    <div class="card tight center" style="flex:1;min-width:130px">
      <div class="muted small">${esc(label)}</div>
      <div style="font-size:1.5rem;font-weight:700">${valueHtml}</div>
      ${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}
    </div>`;

  const confBar = (c) => `
    <span class="muted small" title="${esc(t('twin.confidence'))}: ${Math.round((c ?? 0) * 100)}%">
      <span style="display:inline-block;width:52px;height:6px;border-radius:3px;background:rgba(127,127,127,.25);vertical-align:middle">
        <span style="display:block;width:${Math.round((c ?? 0) * 100)}%;height:6px;border-radius:3px;background:var(--accent,#3d9be9)"></span>
      </span></span>`;

  const varRow = (cat, name, est) => {
    const meta = est.meta || {};
    return `
      <button class="list-item" data-var="${esc(cat)}:${esc(name)}" style="width:100%;text-align:left;background:none;border:0;padding:8px 4px;cursor:pointer;color:inherit;font:inherit">
        <div style="flex:1">
          <strong>${esc(meta.label || name)}</strong>
          <div class="muted small">${confBar(est.confidence)}
            <span class="badge ${PROV_BADGE[est.provenance] ?? ''}" style="margin-left:6px">${esc(t(`twin.provenance.${est.provenance}`) || est.provenance)}</span>
          </div>
        </div>
        <div style="font-size:1.15rem;font-weight:600">${fmtVal(est.value, meta.unit)}</div>
      </button>`;
  };

  el.innerHTML = `
    <header class="mb">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div><h1>${esc(t('twin.title'))}</h1>
          <p class="muted">${esc(t('twin.subtitle'))}</p></div>
        <button class="btn secondary sm" id="rebuildBtn">🔄 ${esc(t('twin.rebuild'))}</button>
      </div>
    </header>
    <div class="row mb" style="gap:10px;flex-wrap:wrap">
      ${summaryTile(t('twin.readiness'), fmtVal(readiness?.value, '/100'), null)}
      ${summaryTile(t('twin.predicted2k'), pred2k ? esc(pred2k.time) : '—', pred2k ? `${esc(pred2k.split)}/500m · ${esc(pred2k.range)}` : null)}
      ${summaryTile(t('twin.strainRisk'), fmtVal(risk?.value, '/100'), null)}
    </div>
    ${data.lastUpdatedAt ? `<p class="muted small">${esc(t('twin.lastUpdated'))}: ${esc(fmtDateTime(data.lastUpdatedAt))}</p>` : ''}
    <div class="grid cols2">
      ${categories.map(cat => `
        <div class="card">
          <h3 style="margin-top:0">${esc(t(`twin.categories.${cat}`) || cat)}</h3>
          ${Object.entries(data.state[cat]).map(([name, est]) => varRow(cat, name, est)).join('')}
        </div>`).join('')}
    </div>
    <div class="card" id="boatCard">
      <div class="row between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${esc(t('physics.boatTitle'))}</h3>
        <select id="boatClass" style="max-width:120px">
          ${['1x', '2x', '2-', '4x', '4-', '4+', '8+'].map(b => `<option value="${b}">${b}</option>`).join('')}
        </select>
      </div>
      <div id="boatResult" class="mt muted small">${esc(t('common.loading'))}</div>
    </div>
    <p class="muted small mt">${esc(t('twin.disclaimer'))}</p>`;

  el.querySelector('#rebuildBtn').onclick = async () => {
    try {
      await api('/twin/rebuild', { method: 'POST' });
      toast(t('twin.rebuildQueued'), 'info');
    } catch (e) { toast(e.message, 'warn'); }
  };

  el.querySelectorAll('[data-var]').forEach(btn => btn.onclick = () => {
    const [cat, name] = btn.dataset.var.split(':');
    openVariable(cat, name, data.state[cat]?.[name]);
  });

  // On-water projection (physics engine): explainable chain, honest range.
  const boatSelect = el.querySelector('#boatClass');
  const boatResult = el.querySelector('#boatResult');
  const loadBoat = async () => {
    boatResult.innerHTML = esc(t('common.loading'));
    try {
      const { translation: tr } = await api(`/physics/translation?boatClass=${encodeURIComponent(boatSelect.value)}`);
      if (!tr.available) { boatResult.innerHTML = esc(tr.reason); return; }
      boatResult.innerHTML = `
        <div style="font-size:1.4rem;font-weight:700;color:var(--text,inherit)">${esc(tr.predictedTime)} <span class="muted small">/ ${tr.raceDistanceM}m · ${esc(tr.range)}</span></div>
        <details class="mt"><summary class="small">${esc(t('physics.chain'))}</summary>
          ${tr.chain.map(c => `<div class="small" style="margin:4px 0">→ ${esc(c.detail)}</div>`).join('')}
          <div class="muted small mt">${tr.assumptions.map(a => `• ${esc(a)}`).join('<br>')}</div>
        </details>
        <p class="muted small" style="margin-bottom:0">${esc(tr.disclaimer)}</p>`;
    } catch (e) { boatResult.innerHTML = esc(e.message); }
  };
  boatSelect.onchange = loadBoat;
  loadBoat();
}

async function openVariable(cat, name, est) {
  if (!est) return;
  const meta = est.meta || {};
  const modal = openModal(`
    <h2>${esc(meta.label || name)}</h2>
    <p class="muted">${esc(meta.description || '')}</p>
    <div class="grid cols2" style="gap:8px">
      <div><span class="muted small">${esc(t('twin.value'))}</span><div><strong>${fmtVal(est.value, meta.unit)}</strong></div></div>
      <div><span class="muted small">${esc(t('twin.confidence'))}</span><div><strong>${Math.round((est.confidence ?? 0) * 100)}%</strong></div></div>
      <div><span class="muted small">${esc(t('twin.uncertainty'))}</span><div><strong>${est.uncertainty != null ? `±${Math.round(est.uncertainty * 10) / 10}` : '—'}</strong></div></div>
      <div><span class="muted small">${esc(t('twin.evidenceCount'))}</span><div><strong>${est.evidenceCount ?? 0}</strong></div></div>
      <div><span class="muted small">${esc(t('twin.provenance.label'))}</span><div><strong>${esc(t(`twin.provenance.${est.provenance}`) || est.provenance)}</strong></div></div>
      <div><span class="muted small">${esc(t('twin.model'))}</span><div class="small" style="word-break:break-all"><strong>${esc(est.modelVersion || '—')}</strong></div></div>
    </div>
    <h3>${esc(t('twin.history'))}</h3>
    <div id="twinSpark" class="muted small">${esc(t('common.loading'))}</div>
    <h3>${esc(t('twin.evidence'))}</h3>
    <div id="twinEvidence" class="muted small">${esc(t('common.loading'))}</div>`);

  try {
    const [{ points }, { evidence }] = await Promise.all([
      api(`/twin/history?category=${encodeURIComponent(cat)}&variable=${encodeURIComponent(name)}`),
      api(`/twin/explain?category=${encodeURIComponent(cat)}&variable=${encodeURIComponent(name)}`),
    ]);
    const spark = modal.querySelector('#twinSpark');
    spark.innerHTML = points.length >= 2 ? sparkline(points) : esc(t('twin.noHistory'));
    const ev = modal.querySelector('#twinEvidence');
    ev.innerHTML = evidence.length ? evidence.slice(0, 8).map(e => `
      <div class="list-item" style="padding:6px 0">
        <div style="flex:1"><strong>${esc(fmtDateTime(e.at))}</strong>
          <div class="muted small">${esc(String(e.stage || '').replaceAll('-', ' '))}${e.modelVersion ? ` · ${esc(String(e.modelVersion).replace('@', ' v'))}` : ''}</div></div>
        <div>${Number.isFinite(e.estimate?.value) ? fmtVal(e.estimate.value, meta.unit) : ''}</div>
      </div>`).join('') : esc(t('twin.noEvidence'));
  } catch { /* modal already shows loading text; leave it non-fatal */ }
}

/** Inline SVG sparkline with a ±uncertainty band where available. */
function sparkline(points) {
  const W = 440, H = 80, PAD = 6;
  const vals = points.map(p => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - ((v - lo) / span) * (H - 2 * PAD);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const band = points.every(p => Number.isFinite(p.uncertainty))
    ? `<polygon fill="var(--accent,#3d9be9)" opacity="0.13" points="${points.map((p, i) => `${x(i).toFixed(1)},${y(p.value + p.uncertainty).toFixed(1)}`).join(' ')} ${points.slice().reverse().map((p) => { const i = points.indexOf(p); return `${x(i).toFixed(1)},${y(p.value - p.uncertainty).toFixed(1)}`; }).join(' ')}"/>`
    : '';
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px" role="img" aria-label="${esc(t('twin.history'))}">
    ${band}
    <polyline fill="none" stroke="var(--accent,#3d9be9)" stroke-width="2" points="${line}"/>
  </svg>
  <div class="muted small">${points.length} ${esc(t('twin.snapshots'))} · ${Math.round(lo * 10) / 10} – ${Math.round(hi * 10) / 10}</div>`;
}
