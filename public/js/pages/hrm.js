// Heart Rate Monitors — a primary app section (not buried in settings):
// device management (connect / rename / forget / prefer / switch), live BPM
// with zones and rolling stats, monitor settings, and historical analysis.
import { api, state, toast, esc, fmtDuration, fmtDate, fmtDateTime } from '../api.js';
import {
  hrManager, SensorState, knownDevices, renameDevice, forgetDevice, preferDevice,
  hrSettings, saveHrSettings, zoneBounds, zoneForBpm, effectiveMaxHr,
  ZONE_COLORS, ZONE_NAMES,
} from '../ble/sensors.js';
import { drawHrSeries, drawTrend } from '../components/charts.js';
import { promptDialog } from '../components/dialog.js';
import { bluetoothHelpHtml } from '../ble/support.js';
import { t } from '../i18n.js';

const STATE_LABEL = {
  bluetooth_unavailable: () => t('ble.stateUnavailable'),
  disconnected: () => t('ble.stateDisconnected'),
  scanning: () => t('ble.stateScanning'),
  connecting: () => t('ble.stateConnecting'),
  connected: () => t('ble.stateConnected'),
  signal_lost: () => t('ble.stateSignalLost'),
  reconnecting: () => t('ble.stateReconnecting'),
};
const stateLabel = (s) => (STATE_LABEL[s] ? STATE_LABEL[s]() : s);

export async function renderHrm(el) {
  let tab = 'monitor';
  const unsubs = [];
  const liveSeries = []; // [tOffsetS, bpm] for the live mini-graph
  const liveStart = Date.now();

  el.innerHTML = `<h1>Heart Rate Monitors</h1>
    <div class="seg mb" style="max-width:320px">
      <button data-tab="monitor" class="on">Monitor</button>
      <button data-tab="history">History & analysis</button>
    </div>
    <div id="hrmBody"></div>`;
  const body = el.querySelector('#hrmBody');
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); tab = b.dataset.tab; draw();
  });

  function draw() { tab === 'monitor' ? drawMonitor() : drawHistory(); }

  /* ================= MONITOR TAB ================= */

  function drawMonitor() {
    const maxHr = effectiveMaxHr(state.user);
    const s = hrSettings();
    const connected = hrManager.state === SensorState.CONNECTED;
    const info = hrManager.deviceInfo;
    const zb = zoneBounds(maxHr);

    body.innerHTML = `
      <div class="card">
        <div class="row between">
          <div class="conn-state ${connected ? 'streaming' : hrManager.state}" >
            <span class="pulse"></span><span id="hrState">${esc(stateLabel(hrManager.state))}</span>
          </div>
          ${connected ? `<button class="sm danger" id="hrDisc">Disconnect</button>` : ''}
        </div>
        <div id="hrBanner"></div>

        ${connected ? `
        <div class="row mt" style="align-items:stretch">
          <div class="metric hero" style="flex:1;border-color:${ZONE_COLORS[zoneForBpm(hrManager.bpm, maxHr) ?? 0]}">
            <div class="val" id="hrBpm" style="color:${ZONE_COLORS[zoneForBpm(hrManager.bpm, maxHr) ?? 0]}">${hrManager.bpm ?? '–'}</div>
            <div class="lbl" id="hrZoneLbl">bpm</div>
          </div>
          <div style="flex:2;min-width:200px">
            <div class="grid cols3" style="gap:6px">
              <div class="stat-tile tight"><div class="n" id="hrAvg">–</div><div class="l">5s avg</div></div>
              <div class="stat-tile tight"><div class="n" id="hrMin">–</div><div class="l">min</div></div>
              <div class="stat-tile tight"><div class="n" id="hrMax">–</div><div class="l">max</div></div>
            </div>
            <p class="muted small" id="hrDevLine">
              ${esc(info?.name || '')}${info?.manufacturer ? ` · ${esc(info.manufacturer)}` : ''}${info?.firmware ? ` · fw ${esc(info.firmware)}` : ''}
            </p>
            <p class="muted small">
              <span id="hrBatt">${hrManager.battery !== null ? `🔋 ${hrManager.battery}%` : 'battery: n/a'}</span>
              · <span id="hrRssi">${signalText(hrManager.rssi)}</span>
              · connected <span id="hrDur">${fmtDuration((Date.now() - (hrManager.connectedAt || Date.now())) / 1000)}</span>
            </p>
          </div>
        </div>
        <canvas class="chart mt" id="hrLiveChart" height="150"></canvas>
        <div class="row mt" id="zoneLegend" style="gap:6px">
          ${ZONE_NAMES.map((n, i) => `<span class="badge" style="background:${ZONE_COLORS[i]}22;color:${ZONE_COLORS[i]}">${n.split(' · ')[0]} ${i === 0 ? `<${zb[1]}` : i === 4 ? `≥${zb[4]}` : `${zb[i]}–${zb[i + 1] - 1}`}</span>`).join('')}
        </div>` : `
        <div class="center mt mb">
          ${hrManager.available() ? '' : bluetoothHelpHtml({ showSimulator: true })}
          ${hrManager.available() ? `<button id="hrConnect" style="font-size:1.1rem;padding:16px 42px">${esc(t('ble.connectMonitor'))}</button>` : ''}
          <p class="muted small mt">The device picker lists <strong>only</strong> Bluetooth heart-rate monitors (Polar, Garmin, Wahoo, Coospo, Magene, …) — never headphones, speakers, or other gadgets. Wear the strap first: most only broadcast with skin contact.</p>
          <button class="ghost sm" id="hrSim">Try the simulated monitor (demo)</button>
        </div>`}
      </div>

      <div class="card">
        <h3>Saved monitors</h3>
        <p class="muted small">RowPoint remembers your monitors and reconnects to the preferred one automatically at launch and when a workout starts.</p>
        <div id="knownList">${knownListHtml()}</div>
      </div>

      <div class="card">
        <h3>Zones & monitor settings</h3>
        <div class="grid cols2">
          <label class="field"><span>Max heart rate (bpm) — blank = auto (${state.user.birthYear ? `220 − age = ${Math.max(150, 220 - (new Date().getFullYear() - state.user.birthYear))}` : '190'})</span>
            <input id="setMaxHr" type="number" min="120" max="230" value="${state.user.maxHr ?? s.maxHr ?? ''}"></label>
          <label class="field"><span>Resting heart rate (bpm, optional)</span>
            <input id="setRestHr" type="number" min="25" max="110" value="${state.user.restingHr ?? s.restingHr ?? ''}"></label>
        </div>
        <div class="toggle"><div>Reconnect automatically (at launch and on workout start)</div>
          <label class="switch"><input type="checkbox" id="setAuto" ${s.autoReconnect ? 'checked' : ''}><span class="sl"></span></label></div>
        <div class="toggle"><div>Remember connected monitors on this device</div>
          <label class="switch"><input type="checkbox" id="setRemember" ${s.remember ? 'checked' : ''}><span class="sl"></span></label></div>
        <div class="toggle"><div>Smooth the displayed value (5-second rolling average)</div>
          <label class="switch"><input type="checkbox" id="setSmooth" ${s.smoothing ? 'checked' : ''}><span class="sl"></span></label></div>
        <button class="sm mt" id="saveHrSettings">Save zone settings</button>
      </div>`;

    wireMonitor();
  }

  function knownListHtml() {
    const list = knownDevices();
    if (!list.length) return '<p class="muted small">No monitors saved yet.</p>';
    return list.map(d => `
      <div class="list-item">
        <div class="avatar">❤</div>
        <div style="flex:1">
          <strong>${esc(d.nickname || d.name)}</strong>
          ${d.preferred ? '<span class="badge green">preferred</span>' : ''}
          ${hrManager.deviceInfo?.id === d.id && hrManager.state === 'connected' ? '<span class="badge blue">connected</span>' : ''}
          <div class="muted small">${esc(d.manufacturer || '')}${d.manufacturer ? ' · ' : ''}last used ${fmtDate(Math.floor(d.lastConnected / 1000))}</div>
        </div>
        ${hrManager.deviceInfo?.id !== d.id ? `<button class="sm secondary" data-conn="${esc(d.id)}">Connect</button>` : ''}
        <button class="ghost sm" data-rename="${esc(d.id)}">Rename</button>
        ${!d.preferred ? `<button class="ghost sm" data-pref="${esc(d.id)}">Prefer</button>` : ''}
        <button class="ghost sm" data-forget="${esc(d.id)}">Forget</button>
      </div>`).join('');
  }

  function wireMonitor() {
    body.querySelector('#hrConnect')?.addEventListener('click', async () => {
      try { await hrManager.connect(); toast('Heart rate monitor connected.', 'success'); }
      catch (e) { toast(e.message, 'error', 7000); }
      drawMonitor();
    });
    body.querySelector('#hrSim')?.addEventListener('click', async () => {
      await hrManager.connectSimulated();
      toast('Simulated monitor connected — live data in a second.', 'success');
      drawMonitor();
    });
    body.querySelector('#hrDisc')?.addEventListener('click', async () => {
      await hrManager.disconnect(); drawMonitor();
    });
    body.querySelectorAll('[data-conn]').forEach(b => b.onclick = async () => {
      // Reconnect a remembered monitor without the chooser where supported.
      preferDevice(b.dataset.conn);
      const ok = await hrManager.tryAutoReconnect();
      if (ok) { toast(`Connected to ${ok.name}.`, 'success'); }
      else {
        toast('Silent reconnect not possible right now — opening the device picker.', 'info');
        try { await hrManager.connect(); } catch (e) { toast(e.message, 'error'); }
      }
      drawMonitor();
    });
    body.querySelectorAll('[data-rename]').forEach(b => b.onclick = async () => {
      const name = await promptDialog('New name for this monitor:', { title: 'Rename monitor', confirmText: t('common.save') });
      if (name?.trim()) { renameDevice(b.dataset.rename, name.trim()); drawMonitor(); }
    });
    body.querySelectorAll('[data-pref]').forEach(b => b.onclick = () => { preferDevice(b.dataset.pref); drawMonitor(); });
    body.querySelectorAll('[data-forget]').forEach(b => b.onclick = () => { forgetDevice(b.dataset.forget); drawMonitor(); });

    body.querySelector('#saveHrSettings')?.addEventListener('click', async () => {
      const maxHr = Number(body.querySelector('#setMaxHr').value) || null;
      const restingHr = Number(body.querySelector('#setRestHr').value) || null;
      saveHrSettings({
        maxHr, restingHr,
        autoReconnect: body.querySelector('#setAuto').checked,
        remember: body.querySelector('#setRemember').checked,
        smoothing: body.querySelector('#setSmooth').checked,
      });
      try {
        // zones live server-side too so workout summaries use the same max HR
        const { user } = await api('/users/me', { method: 'PATCH', body: { maxHr, restingHr } });
        state.user = user;
      } catch { /* offline — local settings still apply */ }
      toast('Heart rate settings saved.', 'success');
      drawMonitor();
    });
    ['#setAuto', '#setRemember', '#setSmooth'].forEach(sel => {
      body.querySelector(sel)?.addEventListener('change', () => {
        saveHrSettings({
          autoReconnect: body.querySelector('#setAuto').checked,
          remember: body.querySelector('#setRemember').checked,
          smoothing: body.querySelector('#setSmooth').checked,
        });
      });
    });
  }

  /* ---- live updates ---- */
  unsubs.push(hrManager.on('bpm', ({ bpm, smoothed }) => {
    if (tab !== 'monitor') return;
    const maxHr = effectiveMaxHr(state.user);
    const shown = hrSettings().smoothing ? smoothed : bpm;
    const z = zoneForBpm(shown, maxHr);
    const bpmEl = body.querySelector('#hrBpm');
    if (bpmEl) {
      bpmEl.textContent = String(shown);
      bpmEl.style.color = ZONE_COLORS[z ?? 0];
      bpmEl.parentElement.style.borderColor = ZONE_COLORS[z ?? 0];
      body.querySelector('#hrZoneLbl').textContent = `bpm · ${ZONE_NAMES[z ?? 0]} · ${Math.round((shown / maxHr) * 100)}% of max`;
      const st = hrManager.stats();
      if (st) {
        body.querySelector('#hrAvg').textContent = String(smoothed);
        body.querySelector('#hrMin').textContent = String(st.min);
        body.querySelector('#hrMax').textContent = String(st.max);
      }
      body.querySelector('#hrDur').textContent = fmtDuration((Date.now() - (hrManager.connectedAt || Date.now())) / 1000);
    } else {
      drawMonitor(); // transitioned into connected view
    }
    liveSeries.push([Math.round((Date.now() - liveStart) / 1000), bpm]);
    if (liveSeries.length > 600) liveSeries.shift();
    const canvas = body.querySelector('#hrLiveChart');
    if (canvas) {
      const recent = liveSeries.slice(-240).map(([t, b], i, arr) => [t - arr[0][0], b]);
      drawHrSeries(canvas, recent, { maxHr, zoneBounds: zoneBounds(maxHr), zoneColors: ZONE_COLORS, height: 150 });
    }
  }));
  unsubs.push(hrManager.on('state', () => { if (tab === 'monitor') drawMonitor(); }));
  unsubs.push(hrManager.on('battery', (pct) => {
    const n = body.querySelector('#hrBatt');
    if (n) n.textContent = pct !== null ? `🔋 ${pct}%` : 'battery: n/a';
  }));
  unsubs.push(hrManager.on('rssi', (rssi) => {
    const n = body.querySelector('#hrRssi');
    if (n) n.textContent = signalText(rssi);
  }));
  unsubs.push(hrManager.on('banner', ({ kind, text }) => {
    toast(text, kind === 'warn' ? 'error' : kind, 6000);
    const b = body.querySelector('#hrBanner');
    if (b) b.innerHTML = `<div class="notice ${kind === 'success' ? '' : 'warn'} mt">${esc(text)}</div>`;
  }));

  /* ================= HISTORY TAB ================= */

  async function drawHistory() {
    body.innerHTML = '<p class="muted">Loading…</p>';
    let workouts = [];
    try { ({ workouts } = await api('/workouts/?limit=200')); } catch (e) { body.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
    const withHr = workouts.filter(w => w.avg_heart_rate || w.max_heart_rate).reverse(); // oldest → newest

    if (!withHr.length) {
      body.innerHTML = '<div class="card center"><p class="muted">No workouts with heart rate yet. Connect a monitor and row — every session\'s HR is recorded automatically.</p></div>';
      return;
    }

    const maxEver = Math.max(...withHr.map(w => w.max_heart_rate || 0));
    const pr = withHr.find(w => w.max_heart_rate === maxEver);
    const zoneTotals = [0, 0, 0, 0, 0];
    for (const w of withHr) (w.hrZones?.zoneSeconds || []).forEach((s, i) => { zoneTotals[i] += s; });
    const totalZone = zoneTotals.reduce((a, b) => a + b, 0) || 1;

    // weekly + monthly averages
    const byWeek = groupBy(withHr, w => isoWeek(w.started_at));
    const byMonth = groupBy(withHr, w => new Date(w.started_at * 1000).toISOString().slice(0, 7));

    body.innerHTML = `
      <div class="grid cols3">
        <div class="stat-tile"><div class="n">${withHr.length}</div><div class="l">workouts with HR</div></div>
        <div class="stat-tile"><div class="n">${Math.round(avg(withHr.map(w => w.avg_heart_rate).filter(Boolean)))}</div><div class="l">avg workout HR</div></div>
        <div class="stat-tile"><div class="n" style="color:var(--bad)">${Math.round(maxEver)}</div><div class="l">max HR PR${pr ? ` · ${fmtDate(pr.started_at)}` : ''}</div></div>
      </div>

      <div class="card">
        <h3>Average & max HR per workout</h3>
        <canvas class="chart" id="hrTrendChart"></canvas>
      </div>

      <div class="card">
        <h3>Time in zone — all workouts</h3>
        ${ZONE_NAMES.map((n, i) => `
          <div class="row" style="margin:6px 0">
            <span style="width:120px" class="small">${n}</span>
            <div style="flex:1;background:var(--bg2);border-radius:6px;height:18px;overflow:hidden">
              <div style="width:${Math.round((zoneTotals[i] / totalZone) * 100)}%;background:${ZONE_COLORS[i]};height:100%"></div>
            </div>
            <span class="small muted" style="width:110px;text-align:right">${fmtDuration(zoneTotals[i])} · ${Math.round((zoneTotals[i] / totalZone) * 100)}%</span>
          </div>`).join('')}
      </div>

      <div class="grid cols2">
        <div class="card tight"><h3>Weekly averages</h3><table><thead><tr><th>Week</th><th>Avg</th><th>Max</th><th>#</th></tr></thead><tbody>
          ${[...byWeek.entries()].slice(-8).map(([k, ws]) => `<tr><td>${k}</td><td>${Math.round(avg(ws.map(w => w.avg_heart_rate).filter(Boolean)))}</td><td>${Math.round(Math.max(...ws.map(w => w.max_heart_rate || 0)))}</td><td>${ws.length}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="card tight"><h3>Monthly averages</h3><table><thead><tr><th>Month</th><th>Avg</th><th>Max</th><th>#</th></tr></thead><tbody>
          ${[...byMonth.entries()].slice(-6).map(([k, ws]) => `<tr><td>${k}</td><td>${Math.round(avg(ws.map(w => w.avg_heart_rate).filter(Boolean)))}</td><td>${Math.round(Math.max(...ws.map(w => w.max_heart_rate || 0)))}</td><td>${ws.length}</td></tr>`).join('')}
        </tbody></table></div>
      </div>

      <div class="card tight">
        <h3>Recent HR drift</h3>
        <p class="muted small">Drift compares second-half vs first-half heart rate — falling drift at the same paces over weeks is a classic sign of improving aerobic fitness.</p>
        ${withHr.slice(-8).reverse().map(w => `
          <div class="list-item"><div style="flex:1">${fmtDateTime(w.started_at)} · avg ${Math.round(w.avg_heart_rate || 0)} bpm</div>
          <span class="badge ${((w.hrZones?.driftPct ?? 0) > 5) ? 'amber' : 'green'}">${w.hrZones?.driftPct !== null && w.hrZones?.driftPct !== undefined ? `${w.hrZones.driftPct > 0 ? '+' : ''}${w.hrZones.driftPct}%` : 'n/a'}</span></div>`).join('')}
      </div>`;

    drawTrend(body.querySelector('#hrTrendChart'), [
      { label: 'avg bpm', color: '#38bdf8', points: withHr.map(w => ({ y: w.avg_heart_rate })), max: 220 },
      { label: 'max bpm', color: '#f87171', points: withHr.map(w => ({ y: w.max_heart_rate })), max: 220 },
    ]);
  }

  draw();
  // Silent auto-reconnect attempt when the page opens (no interaction needed).
  hrManager.tryAutoReconnect().then(ok => { if (ok && tab === 'monitor') drawMonitor(); });

  return () => { unsubs.forEach(u => u()); };
}

function signalText(rssi) {
  if (!Number.isFinite(rssi)) return 'signal: n/a';
  const bars = rssi > -55 ? '▂▄▆█' : rssi > -67 ? '▂▄▆' : rssi > -80 ? '▂▄' : '▂';
  const dist = rssi > -55 ? '<1 m' : rssi > -67 ? '~1–3 m' : rssi > -80 ? '~3–8 m' : '>8 m';
  return `signal ${bars} (${rssi} dBm, ${dist})`;
}
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
function isoWeek(unixS) {
  const d = new Date(unixS * 1000);
  const jan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - jan) / 86400000) + jan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
