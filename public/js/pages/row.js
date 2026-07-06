// §1 + §2.3/2.4 — Connect & Row: connection state machine UI, workout push,
// live metrics, per-stroke force curve, HR strap, live team streaming and
// live leaderboard, then offline-first save with AI pacing feedback.
import { api, state, toast, esc, fmtSplit, fmtDuration, uuidv4 } from '../api.js';
import { ergManager, ConnState } from '../ble/ergSource.js';
import { hrManager, SensorState } from '../ble/sensors.js';
import { drawForceCurve } from '../components/charts.js';
import { queueWorkout, syncPending } from '../offline.js';
import { subscribe, unsubscribe, publishMetrics, onRealtime } from '../ws.js';
import { describePlanText, validatePlanClient } from './builder.js';

const STATE_LABEL = {
  idle: 'Not connected', scanning: 'Scanning…', candidate_found: 'Machine found',
  connecting: 'Connecting…', discovering_services: 'Discovering services…',
  ready: 'Connected — row to start', streaming: 'Streaming', active_workout: 'Workout in progress',
  finished: 'Workout finished', disconnect_prompted: 'Disconnecting…', error: 'Connection problem',
};

export async function renderRow(el) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const assignmentId = qs.get('assignment');
  const teamId = qs.get('team');
  const planId = qs.get('planId');

  let plan = null, planName = 'Just row';
  const draft = sessionStorage.getItem('rp_draft_plan');
  if (draft) { const d = JSON.parse(draft); plan = d.plan; planName = d.name; }
  if (assignmentId && teamId) {
    try {
      const { assignments } = await api(`/teams/${teamId}/assignments`);
      const a = assignments.find(x => x.id === assignmentId);
      if (a) { plan = a.plan; planName = a.name; }
    } catch (e) { toast(e.message, 'error'); }
  } else if (planId) {
    try {
      const { suggestions } = await api('/workouts/daily/suggestions');
      const p = suggestions.find(x => x.id === planId);
      if (p) { plan = p.plan; planName = p.name; }
    } catch { /* fall back to just row */ }
  }

  const session = {
    hrValue: null, adapter: null, unsubs: [],
    started: false, startTs: null, splits: [], curves: [], strokeSeen: 0,
    lastSplitDistance: 0, lastSplitTime: 0, splitHr: [], splitRate: [], splitWatts: [],
    channel: assignmentId ? `team_workout:${assignmentId}` : null,
    liveEntries: new Map(), finishedSaved: false, lastPublish: 0, last: null,
  };

  function header() {
    const remembered = ergManager.rememberedMachine();
    return `
    <h1>Row</h1>
    <div class="card tight">
      <div class="row between">
        <div class="conn-state ${ergManager.state}" id="connState"><span class="pulse"></span><span id="connLabel">${STATE_LABEL[ergManager.state]}</span></div>
        <div class="row" id="connBtns"></div>
      </div>
      <div id="connError"></div>
      ${remembered ? `<p class="muted small">Last machine: ${esc(remembered.kind === 'simulator' ? 'Simulator' : remembered.machineId)} — RowPoint remembers the physical monitor, not just its name, so you can find the same erg in a full gym.</p>` : ''}
      <p class="muted small">Bluetooth is used only to discover nearby fitness machines — never your location. One phone per machine: if an erg won't connect, someone else may already be linked to it.</p>
    </div>
    <div class="card tight">
      <div class="row between">
        <div><strong>${esc(planName)}</strong><div class="muted small">${esc(describePlanText(plan))}${assignmentId ? ' · coach-assigned · live team session' : ''}</div></div>
        <div class="row">
          <a class="btn ghost sm" href="#/builder">Builder</a>
          ${plan ? `<button class="sm secondary" id="pushBtn" title="Send to the monitor">Send to erg</button>` : ''}
        </div>
      </div>
      <div id="pushResult"></div>
    </div>
    <div id="liveArea"></div>
    <div id="lbArea"></div>
    <div id="afterArea"></div>`;
  }

  function connButtons() {
    const c = el.querySelector('#connBtns');
    if (!c) return;
    if (ergManager.adapter) {
      c.innerHTML = `<button class="sm danger" id="disconnectBtn">Disconnect</button>`;
      el.querySelector('#disconnectBtn').onclick = () => endSession(true);
    } else {
      const remembered = ergManager.rememberedMachine();
      const canSilent = remembered?.deviceId && remembered.kind !== 'simulator' && navigator.bluetooth?.getDevices;
      c.innerHTML = `
        ${canSilent ? `<button class="sm secondary" id="reconnectBtn">↻ ${esc(remembered.name || 'Last machine')}</button>` : ''}
        <button class="sm" id="connectBtn">Connect erg</button>
        <button class="sm secondary" id="simBtn">Simulator</button>`;
      el.querySelector('#reconnectBtn')?.addEventListener('click', async () => {
        const adapter = await ergManager.reconnectRemembered();
        if (!adapter) { toast('Couldn\'t silently reach the last machine — pick it from the list instead.', 'info'); connect('auto'); return; }
        session.adapter = adapter;
        session.unsubs.push(adapter.onMetrics(onMetrics));
        session.unsubs.push(adapter.onForceCurve(onForce));
        if (plan) await pushPlan(false);
        if (session.channel) joinLive();
        connButtons(); renderLiveShell(); updateConnState();
      });
      el.querySelector('#connectBtn').onclick = () => connect('auto');
      el.querySelector('#simBtn').onclick = () => pickSimProfile();
    }
  }

  function pickSimProfile() {
    const box = el.querySelector('#connError');
    box.innerHTML = `<div class="notice mt">
      <strong>Simulator pacing profile</strong> <span class="muted small">(great for testing the AI feedback)</span>
      <div class="row mt">
        <button class="sm secondary" data-prof="even">Even pace</button>
        <button class="sm secondary" data-prof="fly_and_die">Fly & die</button>
        <button class="sm secondary" data-prof="negative">Negative split</button>
      </div></div>`;
    box.querySelectorAll('[data-prof]').forEach(b => b.onclick = () => {
      box.innerHTML = '';
      connect('simulator', { pacingProfile: b.dataset.prof, timeScale: Number(qs.get('sim_speed')) || 1, basePaceS: Number(qs.get('sim_pace')) || 130 });
    });
  }

  async function connect(kind, opts) {
    try {
      const adapter = await ergManager.connect(kind, opts);
      session.adapter = adapter;
      session.unsubs.push(adapter.onMetrics(onMetrics));
      session.unsubs.push(adapter.onForceCurve(onForce));
      if (plan) await pushPlan(false);
      if (session.channel) joinLive();
      if (adapter.kind === 'simulator') {
        el.querySelector('#connError').innerHTML = `<div class="mt"><button id="simStart">▶ Start simulated rowing</button></div>`;
        el.querySelector('#simStart').onclick = () => { adapter.start(); el.querySelector('#simStart').remove(); };
      }
      connButtons();
      renderLiveShell();
    } catch (e) {
      const err = ergManager.error;
      el.querySelector('#connError').innerHTML = `<div class="notice warn mt"><strong>${esc(err?.code === 'machine_busy' ? 'Machine in use' : 'Couldn\'t connect')}</strong><br>${esc(err?.message || e.message)}</div>`;
      try { await api('/users/me/health-events', { method: 'POST', body: { kind: 'ble_error', detail: `${err?.code}: ${err?.message}`.slice(0, 300) } }); } catch { /* offline */ }
      connButtons();
    }
    updateConnState();
  }

  async function pushPlan(manual = true) {
    const box = el.querySelector('#pushResult');
    const v = validatePlanClient(plan);
    if (!v.ok) { box.innerHTML = `<div class="notice warn mt">${esc(v.error)}</div>`; return; }
    if (!session.adapter) { if (manual) toast('Connect to a machine first.', 'error'); return; }
    try {
      await session.adapter.sendWorkout(plan);
      box.innerHTML = `<div class="notice mt">✓ Workout programmed on the monitor. ${session.adapter.kind === 'pm5' ? 'Press start on the PM5 or just row.' : ''}</div>`;
    } catch (e) {
      // The machine's own validation is authoritative (§1.3) — show its words.
      box.innerHTML = `<div class="notice warn mt"><strong>${e.machineRejection ? 'The monitor rejected this workout' : 'Couldn\'t program the monitor'}</strong><br>${esc(e.message)}</div>`;
    }
  }

  function renderLiveShell() {
    el.querySelector('#liveArea').innerHTML = `
      <div class="live-grid mt" role="status" aria-label="Live rowing metrics">
        <div class="metric hero"><div class="val" id="mPace">–:––</div><div class="lbl">split /500m</div></div>
        <div class="metric"><div class="val" id="mDist">0</div><div class="lbl">meters</div></div>
        <div class="metric"><div class="val" id="mTime">0:00</div><div class="lbl">time</div></div>
        <div class="metric"><div class="val" id="mRate">0</div><div class="lbl">s/m</div></div>
        <div class="metric"><div class="val" id="mHr">–</div><div class="lbl">heart rate</div></div>
        <div class="metric"><div class="val" id="mWatts">0</div><div class="lbl">watts</div></div>
        <div class="metric"><div class="val" id="mAvg">–:––</div><div class="lbl">avg split</div></div>
        <div class="metric"><div class="val" id="mStrokes">0</div><div class="lbl">strokes</div></div>
      </div>
      <div class="card tight mt">
        <div class="row between"><h3>Stroke force curve</h3>
          <button class="ghost sm" id="hrBtn">${hrManager.state === SensorState.CONNECTED ? '❤ HR monitor ✓' : '+ HR monitor'}</button></div>
        <canvas class="chart" id="forceCanvas" height="170"></canvas>
        <p class="muted small">Live per-stroke force shape (current vs. previous stroke) — data the monitor never shows you.</p>
      </div>
      <div class="row mt">
        <button id="finishBtn" style="flex:1">■ Finish & save workout</button>
      </div>`;
    el.querySelector('#hrBtn').onclick = connectHr;
    el.querySelector('#finishBtn').onclick = () => finish();
  }

  async function connectHr() {
    // §1.6: prefer the machine's HR relay when present; the HR-monitor
    // subsystem (sensors.js) is the concurrent-second-central path, shared
    // with the dedicated Heart Rate Monitors page.
    if (hrManager.state === SensorState.CONNECTED) { location.hash = '#/hr'; return; }
    try {
      const info = await hrManager.connect();
      toast(`Connected to ${info.name}.`, 'success');
      el.querySelector('#hrBtn').textContent = '❤ HR monitor ✓';
    } catch (e) {
      toast(e.message, 'error', 6000);
    }
  }

  let prevCurve = null;
  function onForce(curve) {
    session.strokeSeen++;
    if (session.strokeSeen % 2 === 0 && session.curves.length < 300) {
      session.curves.push({ strokeIndex: session.strokeSeen, samples: curve });
    }
    const canvas = el.querySelector('#forceCanvas');
    if (canvas) drawForceCurve(canvas, curve, { ghost: prevCurve });
    prevCurve = curve;
  }

  function onMetrics(m) {
    session.last = m;
    if (m.disconnected) {
      updateConnState(ConnState.ERROR, { message: 'The machine disconnected. Your workout so far is safe — reconnect or save it.' });
      return;
    }
    if (!session.started && (m.distanceM > 1 || m.elapsedS > 1)) {
      session.started = true;
      session.startTs = Math.floor(Date.now() / 1000) - Math.round(m.elapsedS || 0);
      ergManager.markActive();
      updateConnState();
      // HR subsystem: start recording the time series for this workout, and
      // silently reconnect the preferred monitor if it isn't connected yet.
      hrManager.startRecording();
      if (hrManager.state !== SensorState.CONNECTED) hrManager.tryAutoReconnect();
    }
    // machine HR relay preferred; connected monitor fallback (§1.6)
    const hr = m.heartRate ?? session.hrValue;
    setText('#mPace', fmtSplit(m.paceS));
    setText('#mDist', String(Math.round(m.distanceM || 0)));
    setText('#mTime', fmtDuration(m.elapsedS || 0));
    setText('#mRate', String(m.strokeRate ?? 0));
    setText('#mHr', hr ? String(hr) : '–');
    setText('#mWatts', String(m.watts ?? 0));
    setText('#mAvg', fmtSplit(m.avgSplitS));
    setText('#mStrokes', String(m.strokeCount ?? session.strokeSeen));

    // Split accumulation every 500 m.
    if (Number.isFinite(m.strokeRate)) session.splitRate.push(m.strokeRate);
    if (hr) session.splitHr.push(hr);
    if (Number.isFinite(m.watts)) session.splitWatts.push(m.watts);
    while (m.distanceM - session.lastSplitDistance >= 500) {
      const dist = 500;
      const t = m.elapsedS - session.lastSplitTime;
      session.splits.push({
        distanceM: dist, timeS: t, avgPaceSPer500m: t,
        avgStrokeRate: avg(session.splitRate), avgHeartRate: avg(session.splitHr), avgPowerWatts: avg(session.splitWatts),
      });
      session.lastSplitDistance += 500;
      session.lastSplitTime = m.elapsedS;
      session.splitRate = []; session.splitHr = []; session.splitWatts = [];
    }

    // Live channel publish, throttled to ~1 Hz (§2.3).
    if (session.channel && Date.now() - session.lastPublish > 1000) {
      session.lastPublish = Date.now();
      publishMetrics(session.channel, {
        distanceM: m.distanceM, elapsedS: m.elapsedS, paceS: m.paceS,
        avgSplitS: m.avgSplitS, strokeRate: m.strokeRate, heartRate: hr,
        watts: m.watts, finished: !!m.finished,
      });
    }

    if (m.finished && !session.finishedSaved) {
      ergManager.markFinished(); updateConnState();
      finish();
    }
  }

  /* ---- live leaderboard for team sessions (§2.4) ---- */
  function joinLive() {
    subscribe(session.channel, 'rower');
    session.unsubs.push(onRealtime((msg) => {
      if (msg.channel !== session.channel) return;
      if (msg.type === 'metrics') session.liveEntries.set(msg.userId, { displayName: msg.displayName, ...msg.metrics, stale: false });
      if (msg.type === 'roster') {
        for (const r of msg.roster) if (r.metrics) session.liveEntries.set(r.userId, { displayName: r.displayName, ...r.metrics, stale: r.stale, connected: r.connected });
      }
      drawLeaderboard();
    }));
  }

  function drawLeaderboard() {
    const area = el.querySelector('#lbArea');
    if (!area) return;
    const me = { displayName: `${state.user.displayName} (you)`, avgSplitS: session.last?.avgSplitS, distanceM: session.last?.distanceM || 0, finished: !!session.last?.finished };
    const rows = [...session.liveEntries.entries()].filter(([uid]) => uid !== state.user.id).map(([, v]) => v).concat(session.started || session.last ? [me] : []);
    const ranked = rows.filter(r => Number.isFinite(r.avgSplitS)).sort((a, b) => (b.finished - a.finished) || (a.avgSplitS - b.avgSplitS));
    if (!ranked.length) { area.innerHTML = ''; return; }
    area.innerHTML = `<div class="card tight"><h3>Live leaderboard <span class="muted small">lowest average split</span></h3>
      ${ranked.map((r, i) => `<div class="lb-row ${i === 0 ? 'first' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <span>${esc(r.displayName)} ${r.finished ? '<span class="badge green">finished</span>' : '<span class="badge blue">rowing</span>'}${r.stale ? ' <span class="badge gray">stale</span>' : ''}</span>
        <span class="lb-split">${fmtSplit(r.avgSplitS)}</span>
      </div>`).join('')}
      <p class="muted small">Unfinished efforts are ranked on pace so far — final standings settle when everyone finishes.</p></div>`;
  }

  /* ---- finish & save (offline-first, §6) ---- */
  async function finish(discard = false) {
    if (session.finishedSaved) return;
    const m = session.last;
    if (!m || (!m.distanceM && !m.elapsedS)) { toast('Nothing to save yet.', 'error'); return; }
    session.finishedSaved = true;
    session.adapter?.stop?.();

    // trailing partial split
    if (m.distanceM - session.lastSplitDistance > 25) {
      const d = m.distanceM - session.lastSplitDistance;
      const t = m.elapsedS - session.lastSplitTime;
      session.splits.push({
        distanceM: d, timeS: t, avgPaceSPer500m: (t / d) * 500,
        avgStrokeRate: avg(session.splitRate), avgHeartRate: avg(session.splitHr), avgPowerWatts: avg(session.splitWatts),
      });
    }

    // HR subsystem: every received sample was timestamped and recorded for
    // this session; it ships with the workout so summaries stay in sync.
    const hrSeries = hrManager.stopRecording();

    const payload = {
      id: uuidv4(),
      startedAt: session.startTs || Math.floor(Date.now() / 1000) - Math.round(m.elapsedS || 0),
      endedAt: Math.floor(Date.now() / 1000),
      machineType: session.adapter?.machineType || 'rower',
      machineId: session.adapter?.machineId,
      totalDistanceM: m.distanceM, totalTimeS: m.elapsedS,
      plan, assignmentId: assignmentId || undefined,
      splits: session.splits, forceCurves: session.curves,
      hrSeries: hrSeries?.length ? hrSeries : undefined,
    };
    queueWorkout(state.user.id, payload); // local first, always (§6)
    sessionStorage.removeItem('rp_draft_plan');

    if (session.channel) publishMetrics(session.channel, { distanceM: m.distanceM, elapsedS: m.elapsedS, avgSplitS: m.avgSplitS, finished: true });

    const after = el.querySelector('#afterArea');
    after.innerHTML = `<div class="card"><h3>Saved ✓</h3><p class="muted small">Workout stored locally. Syncing…</p></div>`;
    try {
      const res = await api('/workouts/sync', { method: 'POST', body: payload });
      // remove from queue since direct sync succeeded
      const key = `rp_queue_${state.user.id}`;
      const q = JSON.parse(localStorage.getItem(key) || '[]').filter(x => x.payload.id !== payload.id);
      localStorage.setItem(key, JSON.stringify(q));
      after.innerHTML = `<div class="card ai-card">
        <div class="row between"><h3>Workout saved</h3><span class="ai-tag">✨ AI-generated feedback</span></div>
        ${res.newPb ? `<p><span class="badge green">New verified 2k PB!</span></p>` : ''}
        <p>${esc(res.aiFeedback?.text || '')}</p>
        <div class="row">
          <a class="btn secondary sm" href="#/workout/${payload.id}">Full breakdown</a>
          ${assignmentId ? `<a class="btn ghost sm" href="#/live/${assignmentId}">Final leaderboard</a>` : ''}
        </div></div>`;
      if (res.research?.contributed) toast('Anonymized data contributed to research — thank you! (Opt out anytime in Settings.)', 'info', 5000);
    } catch (e) {
      after.innerHTML = `<div class="card"><h3>Saved locally ✓</h3>
        <p class="muted small">${e.code === 'email_unverified'
    ? 'Cloud sync is waiting for email verification — the workout is safe on this device and will sync automatically once you verify.'
    : `Will sync automatically when you're back online. (${esc(e.message)})`}</p></div>`;
      syncPending();
    }
  }

  async function endSession(fully) {
    session.adapter?.stop?.();
    if (session.started && !session.finishedSaved) await finish();
    for (const un of session.unsubs.splice(0)) un();
    if (session.channel) unsubscribe(session.channel);
    // The HR monitor stays connected app-wide (it belongs to hrManager, not
    // this page) so it's instantly ready for the next workout.
    if (fully) await ergManager.disconnect();
    connButtons(); updateConnState();
  }

  function updateConnState(force, forceErr) {
    const s = force || ergManager.state;
    const node = el.querySelector('#connState');
    if (!node) return;
    node.className = `conn-state ${s === 'active_workout' || s === 'streaming' || s === 'ready' ? 'streaming' : s}`;
    el.querySelector('#connLabel').textContent = STATE_LABEL[s] || s;
    if (forceErr) el.querySelector('#connError').innerHTML = `<div class="notice warn mt">${esc(forceErr.message)}</div>`;
  }

  const setText = (sel, v) => { const n = el.querySelector(sel); if (n && n.textContent !== v) n.textContent = v; };
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  el.innerHTML = header();
  connButtons();
  const unSt = ergManager.onState(() => updateConnState());
  // Live HR from the shared monitor subsystem: feeds the HR tile when the
  // erg has no relay value, and surfaces disconnect banners mid-workout.
  // The tile updates directly on every monitor sample (not only when erg
  // metrics tick), so live heart rate shows with minimal latency even before
  // the first stroke and between strokes.
  session.unsubs.push(hrManager.on('bpm', ({ smoothed }) => {
    session.hrValue = smoothed;
    if (!Number.isFinite(session.last?.heartRate)) {
      setText('#mHr', smoothed ? String(smoothed) : '–');
    }
  }));
  session.unsubs.push(hrManager.on('state', () => {
    // Reflect signal-lost / reconnecting on the HR tile instantly.
    if (hrManager.state !== SensorState.CONNECTED && !Number.isFinite(session.last?.heartRate)) {
      session.hrValue = null;
      setText('#mHr', '–');
    }
  }));
  session.unsubs.push(hrManager.on('banner', ({ kind, text }) => {
    toast(text, kind === 'success' ? 'success' : 'error', 6000);
  }));
  if (ergManager.adapter) { session.adapter = ergManager.adapter; renderLiveShell(); }

  return () => { endSession(false); unSt(); };
}
