// Plan Explorer — the Global Training Optimization Engine's user interface.
//
// Run an optimization, then explore the Pareto frontier: a tradeoff scatter
// (improvement vs fatigue), per-plan week grids, objective bars, Monte Carlo
// outcome ranges, sensitivity verdicts, and a what-if editor that evaluates
// the athlete's own edits through the same computational yardstick.
import { api, esc, toast, fmtDateTime } from '../api.js';
import { t } from '../i18n.js';

const ZONE_COLORS = {
  rest: 'rgba(127,127,127,.25)', ut2: '#4aa3df', ut1: '#3d84c6', threshold: '#e0a63c',
  vo2: '#e0713c', sprint: '#d5453c', strength: '#8e6cc0', cross: '#5ec08d',
};

let meta = null;

export async function renderOptimizer(el) {
  el.innerHTML = `<h1>${esc(t('opt.title'))}</h1><p class="muted">${esc(t('common.loading'))}</p>`;
  let runs;
  try {
    [meta, { runs }] = await Promise.all([meta || api('/optimizer/meta'), api('/optimizer/runs')]);
  } catch (e) {
    el.innerHTML = `<h1>${esc(t('opt.title'))}</h1><div class="notice warn">${esc(e.message)}</div>`;
    return;
  }

  el.innerHTML = `
    <header class="mb">
      <h1>${esc(t('opt.title'))}</h1>
      <p class="muted">${esc(t('opt.subtitle'))}</p>
    </header>
    <div class="card">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
        <label class="small">${esc(t('opt.horizon'))}<br>
          <select id="optHorizon">${meta.horizons.map(h => `<option value="${h}" ${h === 28 ? 'selected' : ''}>${h / 7} ${esc(t('opt.weeks'))}</option>`).join('')}</select></label>
        <label class="small">${esc(t('opt.strategy'))}<br>
          <select id="optStrategy">${meta.strategies.map(s => `<option value="${s}">${esc(s)}</option>`).join('')}</select></label>
        <button class="btn" id="optRun">▶ ${esc(t('opt.run'))}</button>
      </div>
      <p class="muted small" style="margin-bottom:0">${esc(t('opt.runNote'))}</p>
    </div>
    <div id="optStatus"></div>
    <div id="optResult"></div>
    ${runs.length ? `<div class="card"><h3>${esc(t('opt.previousRuns'))}</h3>
      ${runs.slice(0, 8).map(r => `<button class="list-item" data-run="${esc(r.id)}" style="width:100%;text-align:left;background:none;border:0;padding:7px 4px;cursor:pointer;color:inherit;font:inherit">
        <div style="flex:1"><strong>${esc(fmtDateTime(r.created_at))}</strong>
          <div class="muted small">${esc(r.kind)} · ${esc(r.algorithm || '')}</div></div>
        <span class="badge ${r.status === 'completed' ? 'green' : r.status === 'failed' ? 'amber' : 'blue'}">${esc(r.status)}</span>
      </button>`).join('')}</div>` : ''}
    <p class="muted small">${esc(t('opt.disclaimer'))}</p>`;

  const status = el.querySelector('#optStatus');
  const result = el.querySelector('#optResult');

  el.querySelector('#optRun').onclick = async () => {
    try {
      const body = { horizonDays: Number(el.querySelector('#optHorizon').value), strategy: el.querySelector('#optStrategy').value };
      const { runId } = await api('/optimizer/run', { method: 'POST', body });
      status.innerHTML = `<div class="notice">${esc(t('opt.running'))}</div>`;
      pollRun(runId, status, result);
    } catch (e) { toast(e.message, 'warn'); }
  };

  el.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
    status.innerHTML = '';
    await showRun(b.dataset.run, result);
  });

  // Auto-show the newest completed run.
  const latest = runs.find(r => r.status === 'completed');
  if (latest) await showRun(latest.id, result);
}

function pollRun(runId, status, result, attempt = 0) {
  if (attempt > 60) { status.innerHTML = `<div class="notice warn">${esc(t('opt.timeout'))}</div>`; return; }
  setTimeout(async () => {
    try {
      const { run } = await api(`/optimizer/runs/${runId}`);
      if (run.status === 'completed') { status.innerHTML = ''; renderRun(run, result); }
      else if (run.status === 'failed') status.innerHTML = `<div class="notice warn">${esc(run.error || 'failed')}</div>`;
      else pollRun(runId, status, result, attempt + 1);
    } catch { pollRun(runId, status, result, attempt + 1); }
  }, 1500);
}

async function showRun(runId, result) {
  try {
    const { run } = await api(`/optimizer/runs/${runId}`);
    if (run.status === 'completed') renderRun(run, result);
  } catch { /* stale id — ignore */ }
}

function renderRun(run, result) {
  const frontier = run.frontier || [];
  if (!frontier.length) {
    result.innerHTML = `<div class="card"><p class="muted">${esc(t('opt.empty'))}</p></div>`;
    return;
  }
  result.innerHTML = `
    <div class="card">
      <div class="row between" style="flex-wrap:wrap;gap:6px">
        <h3 style="margin:0">${esc(t('opt.frontier'))} <span class="muted small">(${frontier.length} ${esc(t('opt.plans'))})</span></h3>
        <span class="muted small">${esc(run.algorithm || '')} · seed ${run.seed} · ${Math.round((run.durationMs || 0) / 100) / 10}s</span>
      </div>
      <canvas id="frontierChart" class="chart" style="max-height:240px"></canvas>
      <p class="muted small">${esc(t('opt.frontierNote'))}</p>
      <div id="planDetail"></div>
    </div>`;
  const canvas = result.querySelector('#frontierChart');
  const detail = result.querySelector('#planDetail');
  drawFrontier(canvas, frontier, (i) => renderPlan(run, frontier, i, detail));
  renderPlan(run, frontier, 0, detail);
}

function drawFrontier(canvas, frontier, onPick) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 600, H = 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const xs = frontier.map(p => p.scores.fatigue), ys = frontier.map(p => p.scores.improvement);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const PAD = 34;
  const x = (v) => PAD + ((v - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - ((v - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD);
  ctx.font = '11px system-ui';
  ctx.fillStyle = 'rgba(127,127,127,.8)';
  ctx.fillText(t('opt.axisFatigue'), W / 2 - 40, H - 6);
  ctx.save(); ctx.translate(10, H / 2 + 40); ctx.rotate(-Math.PI / 2); ctx.fillText(t('opt.axisImprovement'), 0, 0); ctx.restore();
  const pts = frontier.map((p, i) => ({ px: x(p.scores.fatigue), py: y(p.scores.improvement), i }));
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.px, p.py, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#3d9be9';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(String(p.i + 1), p.px - 3, p.py + 4);
  }
  canvas.style.cursor = 'pointer';
  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    let best = null, bestD = 20 ** 2;
    for (const p of pts) {
      const d = (p.px - cx) ** 2 + (p.py - cy) ** 2;
      if (d < bestD) { bestD = d; best = p.i; }
    }
    if (best !== null) onPick(best);
  };
}

function renderPlan(run, frontier, idx, detail) {
  const p = frontier[idx];
  const weeks = [];
  for (let w = 0; w * 7 < p.days.length; w++) weeks.push(p.days.slice(w * 7, w * 7 + 7));
  const dayCell = (d, i) => `
    <div data-day="${i}" title="${esc(d.type)} ${d.minutes || ''}" style="flex:1;min-width:0;height:34px;border-radius:6px;cursor:pointer;
      background:${ZONE_COLORS[d.type] || '#888'};opacity:${d.type === 'rest' ? .45 : 1};display:flex;align-items:center;justify-content:center">
      <span style="font-size:.62rem;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.4)">${d.type === 'rest' ? '—' : `${esc(shortType(d.type))}<br>${d.minutes}'`}</span>
    </div>`;
  const objBar = (key) => {
    if (p.scores[key] === undefined) return '';
    const def = meta.objectives[key];
    return `<div class="row" style="gap:8px;margin:3px 0"><span class="small" style="width:170px">${esc(def.label)}</span>
      <strong class="small" style="width:60px;text-align:right">${p.scores[key]}</strong></div>`;
  };
  detail.innerHTML = `
    <hr style="opacity:.2">
    <div class="row between" style="flex-wrap:wrap;gap:6px">
      <h3 style="margin:0">${esc(t('opt.plan'))} ${idx + 1}${p.name ? ` · ${esc(p.name)}` : ''}</h3>
      <span class="muted small">${esc(t('opt.clickDay'))}</span>
    </div>
    <p class="small" style="margin:6px 0">${esc(p.tradeoff || '')}</p>
    ${weeks.map((week, w) => `<div class="row" style="gap:4px;margin:4px 0"><span class="muted small" style="width:34px">W${w + 1}</span>${week.map((d, di) => dayCell(d, w * 7 + di)).join('')}</div>`).join('')}
    <div class="grid cols2 mt">
      <div>${Object.keys(meta.objectives).map(objBar).join('')}</div>
      <div class="small">
        ${p.mc ? `<div><strong>${esc(t('opt.mcTitle'))}</strong> (${p.mc.iterations}× seeded)</div>
        <div>${esc(t('opt.mcImprovement'))}: ${p.mc.improvement.p10} … <strong>${p.mc.improvement.p50}</strong> … ${p.mc.improvement.p90}</div>
        <div>${esc(t('opt.mcFatigue'))}: p90 ${p.mc.peakFatigue.p90}</div>
        <div>${esc(t('opt.mcSkipped'))}: ~${p.mc.skippedMean}</div>` : ''}
        ${idx === 0 && run.sensitivity ? `<div class="mt"><strong>${esc(t('opt.sensitivity'))}</strong> ${Math.round(run.sensitivity.robustness * 100)}% — ${esc(run.sensitivity.verdict)}</div>` : ''}
      </div>
    </div>
    <div id="whatIf" class="mt"></div>`;

  // What-if editor: click a day → cycle its session; evaluate the edit.
  const edited = p.days.map(d => ({ ...d }));
  const order = Object.keys(meta.sessionTypes);
  detail.querySelectorAll('[data-day]').forEach(cell => cell.onclick = async () => {
    const i = Number(cell.dataset.day);
    const cur = order.indexOf(edited[i].type);
    const next = order[(cur + 1) % order.length];
    edited[i] = next === 'rest' ? { type: 'rest', minutes: 0 } : { type: next, minutes: edited[i].minutes || 45 };
    cell.style.background = ZONE_COLORS[next] || '#888';
    cell.style.opacity = next === 'rest' ? .45 : 1;
    cell.querySelector('span').innerHTML = next === 'rest' ? '—' : `${esc(shortType(next))}<br>${edited[i].minutes}'`;
    try {
      const { evaluation } = await api('/optimizer/counterfactual', { method: 'POST', body: { runId: run.id, days: edited } });
      const box = detail.querySelector('#whatIf');
      box.innerHTML = `
        <div class="notice ${evaluation.valid ? '' : 'warn'}">
          <strong>${esc(t('opt.whatIfTitle'))}</strong>
          ${evaluation.valid ? '' : `<div class="small">${evaluation.violations.slice(0, 3).map(v => `⚠ ${esc(v)}`).join('<br>')}</div>`}
          ${evaluation.deltas ? `<div class="small mt">${Object.values(evaluation.deltas)
    .filter(d => Math.abs(d.delta) >= 0.1)
    .map(d => `${esc(d.label)}: <strong style="color:${d.better ? 'var(--good,#2f9e63)' : 'var(--bad,#d5453c)'}">${d.delta > 0 ? '+' : ''}${d.delta}</strong>`)
    .join(' · ') || esc(t('opt.whatIfNoChange'))}</div>` : ''}
        </div>`;
    } catch (e) { toast(e.message, 'warn'); }
  });
}

const shortType = (type) => ({ ut2: 'UT2', ut1: 'UT1', threshold: 'AT', vo2: 'VO2', sprint: 'SPR', strength: 'STR', cross: 'X' }[type] || type);
