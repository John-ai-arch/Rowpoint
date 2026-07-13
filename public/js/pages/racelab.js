// Race Lab — the Digital Regatta Simulation Engine's user interface.
//
// Set up a field (archetype opponents relative to your own level, or known
// rivals by 2k time), conditions, and a strategy; run thousands of seeded
// race simulations in the background; then explore the outcome as
// probabilities: win/medal odds, finish-time spread, expected order, split
// distributions, a leading-probability curve, sensitivity ranking, strategy
// comparison — and a scrubbable computational replay of the median race.
import { api, esc, toast, fmtDateTime } from '../api.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

let meta = null;

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const pct = (p) => `${Math.round(p * 100)}%`;

export async function renderRaceLab(el) {
  el.innerHTML = `<h1>${esc(t('race.title'))}</h1><p class="muted">${esc(t('common.loading'))}</p>`;
  let athlete, runs;
  try {
    [meta, { params: athlete }, { runs }] = await Promise.all([
      meta || api('/regatta/meta'), api('/regatta/athlete'), api('/regatta/runs'),
    ]);
  } catch (e) {
    el.innerHTML = `<h1>${esc(t('race.title'))}</h1><div class="notice warn">${esc(e.message)}</div>`;
    return;
  }

  const opponents = [{ kind: 'archetype', archetype: 'matched' }, { kind: 'archetype', archetype: 'challenger' }];

  el.innerHTML = `
    <header class="mb">
      <h1>${esc(t('race.title'))}</h1>
      <p class="muted">${esc(t('race.subtitle'))}</p>
    </header>
    ${athlete.available ? `
    <div class="card">
      <h3>${esc(t('race.yourBoat'))}</h3>
      <div class="row" style="gap:18px;flex-wrap:wrap">
        <div><span class="muted small">${esc(t('race.yourPower'))}</span><br><strong>${Math.round(athlete.cpW)} W</strong> <span class="muted small">± ${Math.round(athlete.cpSd)}</span></div>
        <div><span class="muted small">${esc(t('race.yourReserve'))}</span><br><strong>${(athlete.wPrimeJ / 1000).toFixed(1)} kJ</strong></div>
      </div>
      <p class="muted small" style="margin-bottom:0">${athlete.explain.map(x => esc(x.detail)).join(' · ')}</p>
    </div>
    <div class="card">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
        <label class="small">${esc(t('race.boatClass'))}<br>
          <select id="rlBoat">${meta.boatClasses.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></label>
        <label class="small">${esc(t('race.distance'))}<br>
          <select id="rlDist"><option value="500">500m</option><option value="1000">1000m</option><option value="2000" selected>2000m</option><option value="5000">5000m</option><option value="6000">6000m</option></select></label>
        <label class="small">${esc(t('race.strategy'))}<br>
          <select id="rlStrat">${Object.entries(meta.strategies).map(([k, s]) => `<option value="${esc(k)}">${esc(s.label)}</option>`).join('')}</select></label>
        <label class="small">${esc(t('race.lane'))}<br>
          <select id="rlLane"></select></label>
      </div>
      <p class="muted small" id="rlStratNote"></p>
      <h3 class="mt">${esc(t('race.opponents'))}</h3>
      <div id="rlOpps"></div>
      <div class="row" style="gap:8px;margin-top:6px">
        <button class="secondary sm" id="rlAddArch">${esc(t('race.addArchetype'))}</button>
        <button class="secondary sm" id="rlAddRival">${esc(t('race.addRival'))}</button>
      </div>
      <h3 class="mt">${esc(t('race.conditions'))}</h3>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <label class="small">${esc(t('race.headwind'))}<br><input type="number" id="rlWind" value="0" step="0.5" min="-15" max="20" style="width:110px"></label>
        <label class="small">${esc(t('race.current'))}<br><input type="number" id="rlCurrent" value="0" step="0.1" min="-2" max="2" style="width:110px"></label>
      </div>
      <label class="small row" style="gap:6px;margin-top:8px"><input type="checkbox" id="rlTactics"> ${esc(t('race.tactics'))}</label>
      <label class="small row" style="gap:6px;margin-top:4px"><input type="checkbox" id="rlCompare"> ${esc(t('race.compareStrategies'))}</label>
      <div class="mt"><button class="btn" id="rlRun">${icon('flag', { size: 16 })} ${esc(t('race.run'))}</button></div>
    </div>` : `
    <div class="card"><p class="muted">${esc(t('race.noData'))}</p></div>`}
    <div id="rlStatus"></div>
    <div id="rlResult"></div>
    ${runs.length ? `<div class="card"><h3>${esc(t('race.previousRuns'))}</h3>
      ${runs.slice(0, 8).map(r => `<button class="list-item" data-run="${esc(r.id)}" style="width:100%;text-align:left;background:none;border:0;padding:7px 4px;cursor:pointer;color:inherit;font:inherit">
        <div style="flex:1"><strong>${esc(fmtDateTime(r.created_at))}</strong></div>
        <span class="badge ${r.status === 'completed' ? 'green' : r.status === 'failed' ? 'amber' : 'blue'}">${esc(r.status)}</span>
      </button>`).join('')}</div>` : ''}
    <p class="muted small">${esc(t('race.disclaimer'))}</p>`;

  const status = el.querySelector('#rlStatus');
  const result = el.querySelector('#rlResult');

  el.querySelectorAll('[data-run]').forEach(b => b.onclick = () => showRun(b.dataset.run, result));

  if (!athlete.available) {
    const latest = runs.find(r => r.status === 'completed');
    if (latest) await showRun(latest.id, result);
    return;
  }

  /* ------------------------- setup interactions ------------------------- */

  const stratSel = el.querySelector('#rlStrat');
  const stratNote = el.querySelector('#rlStratNote');
  const updateNote = () => { stratNote.textContent = meta.strategies[stratSel.value]?.description || ''; };
  stratSel.onchange = updateNote;
  updateNote();

  const oppsBox = el.querySelector('#rlOpps');
  const laneSel = el.querySelector('#rlLane');
  const renderOpps = () => {
    oppsBox.innerHTML = opponents.map((o, i) => `
      <div class="row" style="gap:8px;align-items:center;margin:4px 0" data-opp="${i}">
        ${o.kind === 'archetype'
    ? `<select data-arch="${i}">${Object.entries(meta.archetypes).map(([k, a]) => `<option value="${esc(k)}" ${o.archetype === k ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>`
    : `<input data-rname="${i}" placeholder="${esc(t('race.rivalName'))}" value="${esc(o.name || '')}" style="width:130px">
       <input data-r2k="${i}" type="number" placeholder="${esc(t('race.rival2k'))}" value="${o.erg2kSeconds || ''}" min="300" max="720" style="width:120px">`}
        <button class="ghost sm icon-btn" data-del="${i}" aria-label="${esc(t('common.remove'))}">${icon('close', { size: 15 })}</button>
      </div>`).join('');
    const laneCount = opponents.length + 1;
    laneSel.innerHTML = Array.from({ length: laneCount }, (_, i) =>
      `<option value="${i + 1}" ${i + 1 === Math.ceil(laneCount / 2) ? 'selected' : ''}>${i + 1}</option>`).join('');
    oppsBox.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { opponents.splice(Number(b.dataset.del), 1); renderOpps(); });
    oppsBox.querySelectorAll('[data-arch]').forEach(s => s.onchange = () => { opponents[Number(s.dataset.arch)].archetype = s.value; });
    oppsBox.querySelectorAll('[data-rname]').forEach(inp => inp.onchange = () => { opponents[Number(inp.dataset.rname)].name = inp.value; });
    oppsBox.querySelectorAll('[data-r2k]').forEach(inp => inp.onchange = () => { opponents[Number(inp.dataset.r2k)].erg2kSeconds = Number(inp.value); });
  };
  el.querySelector('#rlAddArch').onclick = () => { if (opponents.length < 7) { opponents.push({ kind: 'archetype', archetype: 'wildcard' }); renderOpps(); } };
  el.querySelector('#rlAddRival').onclick = () => { if (opponents.length < 7) { opponents.push({ kind: 'manual', name: '', erg2kSeconds: null }); renderOpps(); } };
  renderOpps();

  el.querySelector('#rlRun').onclick = async () => {
    const wind = Number(el.querySelector('#rlWind').value) || 0;
    const body = {
      boatClass: el.querySelector('#rlBoat').value,
      distanceM: Number(el.querySelector('#rlDist').value),
      strategy: stratSel.value,
      userLane: Number(laneSel.value),
      opponents: opponents.filter(o => o.kind === 'archetype' || o.erg2kSeconds > 0),
      environment: {
        windSpeedMps: Math.abs(wind) || undefined,
        windDirectionDeg: wind ? (wind >= 0 ? 0 : 180) : undefined,
        headingDeg: wind ? 0 : undefined,
        currentMps: Number(el.querySelector('#rlCurrent').value) || undefined,
      },
      tactics: el.querySelector('#rlTactics').checked,
      compareStrategies: el.querySelector('#rlCompare').checked,
    };
    try {
      const { runId } = await api('/regatta/simulate', { method: 'POST', body });
      status.innerHTML = `<div class="notice">${esc(t('race.running'))}</div>`;
      pollRun(runId, status, result);
    } catch (e) { toast(e.message, 'warn'); }
  };

  const latest = runs.find(r => r.status === 'completed');
  if (latest) await showRun(latest.id, result);
}

function pollRun(runId, status, result, attempt = 0) {
  if (attempt > 60) { status.innerHTML = `<div class="notice warn">${esc(t('race.timeout'))}</div>`; return; }
  setTimeout(async () => {
    try {
      const { run } = await api(`/regatta/runs/${runId}`);
      if (run.status === 'completed') { status.innerHTML = ''; renderRun(run, result); }
      else if (run.status === 'failed') status.innerHTML = `<div class="notice warn">${esc(run.error || 'failed')}</div>`;
      else pollRun(runId, status, result, attempt + 1);
    } catch { pollRun(runId, status, result, attempt + 1); }
  }, 1500);
}

async function showRun(runId, result) {
  try {
    const { run } = await api(`/regatta/runs/${runId}`);
    if (run.status === 'completed') renderRun(run, result);
  } catch { /* stale id — ignore */ }
}

function renderRun(run, result) {
  const s = run.summary;
  if (!s) return;
  const best = s.strategyComparison?.[0];
  result.innerHTML = `
    <div class="card">
      <div class="row between" style="flex-wrap:wrap;gap:6px">
        <h3 style="margin:0">${esc(s.boatClass)} · ${s.distanceM}m</h3>
        <span class="muted small">${s.iterations} ${esc(t('race.iterations'))} · ${esc(t('race.seed'))} ${run.seed}</span>
      </div>
      <div class="grid cols3 mt" style="text-align:center">
        <div><div class="muted small">${esc(t('race.winProb'))}</div><div style="font-size:1.6rem"><strong>${pct(s.user.winProb)}</strong></div></div>
        <div><div class="muted small">${esc(t('race.medalProb'))}</div><div style="font-size:1.6rem"><strong>${pct(s.user.medalProb)}</strong></div></div>
        <div><div class="muted small">${esc(t('race.expectedFinish'))}</div><div style="font-size:1.6rem"><strong>${fmtTime(s.user.finish.p50)}</strong></div></div>
      </div>
      <p class="muted small center">${esc(t('race.finishRange', { lo: fmtTime(s.user.finish.p5), hi: fmtTime(s.user.finish.p95) }))}</p>

      <h4>${esc(t('race.expectedOrder'))}</h4>
      ${s.expectedOrder.map((b, i) => `<div class="row" style="gap:8px;padding:2px 0">
        <span class="muted small" style="width:18px">${i + 1}.</span>
        <span style="flex:1${b.isUser ? ';font-weight:700' : ''}">${esc(b.name)}</span>
        <span class="muted small">${esc(t('race.meanRank'))} ${b.meanRank}</span></div>`).join('')}

      <h4 class="mt">${esc(t('race.splits'))}</h4>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${s.user.splits500.map((sp, i) => sp ? `<div class="badge blue" title="500m #${i + 1}">${fmtTime(sp.p10)} / <strong>${fmtTime(sp.p50)}</strong> / ${fmtTime(sp.p90)}</div>` : '').join('')}
      </div>

      <h4 class="mt">${esc(t('race.leaderCurve'))}</h4>
      <canvas id="rlLeader" class="chart" style="max-height:150px"></canvas>

      <h4 class="mt">${esc(t('race.sensitivity'))}</h4>
      ${s.sensitivity.slice(0, 5).map(x => `<div class="row" style="gap:8px;align-items:center;padding:1px 0">
        <span class="small" style="width:220px">${esc(x.label)}</span>
        <div style="flex:1;height:8px;background:rgba(127,127,127,.15);border-radius:4px;overflow:hidden">
          <div style="width:${Math.min(Math.abs(x.r) * 100, 100)}%;height:100%;background:${x.r < 0 ? 'var(--good,#2f9e63)' : '#d5453c'}"></div>
        </div>
        <span class="muted small" style="width:44px;text-align:right">${x.r.toFixed(2)}</span></div>`).join('')}

      ${s.strategyComparison ? `
      <h4 class="mt">${esc(t('race.strategyRanking'))}</h4>
      ${s.strategyComparison.map((x, i) => `<div class="row" style="gap:8px;padding:1px 0">
        <span class="small" style="flex:1">${i === 0 ? `<span style="color:var(--gold)">${icon('star', { size: 13 })}</span> ` : ''}${esc(x.label)}</span>
        <span class="small">${pct(x.winProb)}</span>
        <span class="muted small" style="width:64px;text-align:right">${fmtTime(x.medianS)}</span></div>`).join('')}
      <p class="muted small" style="display:flex;gap:5px;align-items:center"><span style="color:var(--gold)">${icon('star', { size: 13 })}</span> ${esc(t('race.bestStrategy'))}${best ? ` — ${esc(best.label)}` : ''}</p>` : ''}

      <div class="mt"><button class="secondary" id="rlReplayBtn">${icon('play', { size: 15 })} ${esc(t('race.replayOpen'))}</button></div>
      <div id="rlReplay"></div>

      <h4 class="mt">${esc(t('race.whatIfTitle'))}</h4>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
        <label class="small">${esc(t('race.whatIfPower'))}<br><input type="number" id="wiPower" value="2" min="-8" max="8" style="width:80px"></label>
        <label class="small">${esc(t('race.whatIfStrategy'))}<br>
          <select id="wiStrat"><option value="">—</option>${(s.strategyComparison || Object.keys(meta?.strategies || {}).map(k => ({ strategy: k, label: meta.strategies[k].label })))
    .map(x => `<option value="${esc(x.strategy)}">${esc(x.label)}</option>`).join('')}</select></label>
        <label class="small">${esc(t('race.whatIfHeadwind'))}<br><input type="number" id="wiWind" placeholder="—" min="-8" max="12" style="width:80px"></label>
        <button class="secondary sm" id="wiRun">${esc(t('race.whatIfRun'))}</button>
      </div>
      <div id="wiResult"></div>
    </div>`;

  drawLeaderCurve(result.querySelector('#rlLeader'), s);

  result.querySelector('#rlReplayBtn').onclick = async () => {
    try {
      const { replay } = await api(`/regatta/runs/${run.id}/replay`);
      if (replay?.timeline?.length) renderReplay(result.querySelector('#rlReplay'), replay, s.distanceM);
    } catch (e) { toast(e.message, 'warn'); }
  };

  result.querySelector('#wiRun').onclick = async () => {
    const mods = {};
    const p = Number(result.querySelector('#wiPower').value);
    if (p) mods.powerPct = p;
    const st = result.querySelector('#wiStrat').value;
    if (st) mods.strategy = st;
    const w = result.querySelector('#wiWind').value;
    if (w !== '') mods.headwindMps = Number(w);
    try {
      const { evaluation } = await api('/regatta/whatif', { method: 'POST', body: { runId: run.id, mods } });
      const box = result.querySelector('#wiResult');
      if (!evaluation.valid) { box.innerHTML = `<div class="notice warn">${esc(evaluation.reason)}</div>`; return; }
      const d = evaluation.deltas.winProb;
      box.innerHTML = `<div class="notice">
        ${esc(t('race.whatIfResult', {
    win: pct(evaluation.result.winProb),
    delta: `${d >= 0 ? '+' : ''}${Math.round(d * 100)}pp`,
    time: fmtTime(evaluation.result.finishP50),
  }))}
        <div class="muted small">${esc(evaluation.note)}</div></div>`;
    } catch (e) { toast(e.message, 'warn'); }
  };
}

function drawLeaderCurve(canvas, s) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 600, H = 140;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const PAD = 26;
  const marks = s.leaderCurve.marksM;
  const colors = ['#3d9be9', '#e0a63c', '#5ec08d', '#d5453c', '#8e6cc0', '#4aa3df', '#c07a5e', '#7a7a7a'];
  const userLane = s.user.lane - 1;
  s.leaderCurve.probs.forEach((row, b) => {
    ctx.beginPath();
    row.forEach((p, m) => {
      const x = PAD + (m / Math.max(marks.length - 1, 1)) * (W - 2 * PAD);
      const y = H - PAD - p * (H - 2 * PAD);
      if (m === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = b === userLane ? '#3d9be9' : colors[b % colors.length] + '88';
    ctx.lineWidth = b === userLane ? 2.5 : 1.2;
    ctx.stroke();
  });
  ctx.font = '10px system-ui';
  ctx.fillStyle = 'rgba(127,127,127,.8)';
  ctx.fillText('0%', 4, H - PAD + 3);
  ctx.fillText('100%', 4, PAD + 3);
  ctx.fillText(`${marks[0]}m`, PAD, H - 8);
  ctx.fillText(`${marks[marks.length - 1]}m`, W - PAD - 30, H - 8);
}

function renderReplay(box, replay, distanceM) {
  box.innerHTML = `
    <p class="muted small">${esc(t('race.replayNote'))}</p>
    <canvas id="rlRace" class="chart" style="max-height:${40 + replay.boats.length * 26}px"></canvas>
    <div class="row" style="gap:10px;align-items:center">
      <input type="range" id="rlScrub" min="0" max="${replay.timeline.length - 1}" value="0" style="flex:1">
      <span class="small" id="rlClock" style="width:90px;text-align:right"></span>
    </div>`;
  const canvas = box.querySelector('#rlRace');
  const scrub = box.querySelector('#rlScrub');
  const clock = box.querySelector('#rlClock');
  const draw = (idx) => {
    const frame = replay.timeline[Math.min(idx, replay.timeline.length - 1)];
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 600, H = 30 + replay.boats.length * 26;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const PAD = 70;
    ctx.font = '11px system-ui';
    // Course line + finish
    ctx.strokeStyle = 'rgba(127,127,127,.3)';
    replay.boats.forEach((b, i) => {
      const y = 22 + i * 26;
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - 16, y); ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(213,69,60,.6)';
    ctx.beginPath(); ctx.moveTo(W - 16, 8); ctx.lineTo(W - 16, H - 8); ctx.stroke();
    replay.boats.forEach((b, i) => {
      const st = frame.boats[i];
      const y = 22 + i * 26;
      const x = PAD + (st.x / distanceM) * (W - PAD - 16);
      ctx.fillStyle = 'rgba(127,127,127,.9)';
      ctx.fillText(b.name.slice(0, 9), 4, y + 4);
      // W′ reserve bar behind the boat
      ctx.fillStyle = 'rgba(94,192,141,.35)';
      ctx.fillRect(PAD, y + 6, (W - PAD - 16) * st.wbal, 3);
      // Boat dot
      ctx.beginPath();
      ctx.arc(x, y, b.isUser ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = b.isUser ? '#3d9be9' : '#e0a63c';
      ctx.fill();
      ctx.fillStyle = 'rgba(127,127,127,.75)';
      ctx.fillText(`${st.v.toFixed(1)} m/s`, Math.min(x + 10, W - 66), y - 6);
    });
    clock.textContent = `${t('race.replayTime')} ${fmtTime(frame.t)}`;
  };
  scrub.oninput = () => draw(Number(scrub.value));
  draw(0);
}
