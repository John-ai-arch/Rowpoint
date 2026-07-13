// §2.3 — Coach live team view: a grid of live-metric tiles, one per rower,
// all updating in parallel with presence/staleness. §2.4 — the same channel
// drives the live leaderboard; final standings persist and render here after
// the session from leaderboard_entries.
import { api, state, esc, fmtSplit, fmtDuration } from '../api.js';
import { icon } from '../icons.js';
import { subscribe, unsubscribe, onRealtime, requestRoster } from '../ws.js';

export async function renderLive(el, assignmentId) {
  const channel = `team_workout:${assignmentId}`;
  const tiles = new Map(); // userId -> data
  let teamId = null, workoutName = 'Team workout';

  // Resolve team for the persisted leaderboard read.
  try {
    const { coached, joined } = await api('/teams');
    for (const t of [...coached, ...joined]) {
      try {
        const { assignments } = await api(`/teams/${t.id}/assignments`);
        const found = assignments.find(x => x.id === assignmentId);
        if (found) { teamId = t.id; workoutName = found.name; break; }
      } catch { /* keep looking */ }
    }
  } catch { /* offline */ }

  el.innerHTML = `
    <a href="${teamId ? `#/team/${teamId}` : '#/teams'}" class="back-link">${icon('chevron-left', { size: 16 })} Team</a>
    <h1>${esc(workoutName)} <span class="badge blue">live</span></h1>
    <p class="muted small" id="liveStatus">Connecting to the live channel…</p>
    <div class="team-live-grid" id="grid"></div>
    <div class="card"><div class="card-head"><span class="icon-chip sm gold">${icon('trophy', { size: 18 })}</span><h3>Leaderboard <span class="muted small" style="font-weight:500">lowest average split wins</span></h3></div>
      <div id="lb"><p class="muted small">Waiting for data…</p></div></div>
    <div class="card tight"><p class="muted small">Rowers appear as they connect; tiles dim when a phone goes stale and mark a rower done when they finish. Standings persist here after the session ends.</p></div>`;

  function drawGrid() {
    const grid = el.querySelector('#grid');
    const arr = [...tiles.values()];
    grid.innerHTML = arr.length ? arr.map(t => `
      <div class="rower-tile ${t.stale ? 'stale' : ''} ${t.metrics?.finished ? 'finished' : ''}">
        <div class="name">${esc(t.displayName)}
          ${t.metrics?.finished ? `<span class="badge green">${icon('check', { size: 12 })} done</span>` : t.connected === false ? '<span class="badge red">offline</span>' : t.stale ? '<span class="badge gray">stale</span>' : '<span class="badge blue">live</span>'}</div>
        <div class="big">${fmtSplit(t.metrics?.paceS ?? t.metrics?.avgSplitS)}</div>
        <div class="sub"><span>${Math.round(t.metrics?.distanceM || 0)} m</span><span>${fmtDuration(t.metrics?.elapsedS || 0)}</span></div>
        <div class="sub"><span>${t.metrics?.strokeRate ?? '–'} s/m</span><span>${t.metrics?.heartRate ? t.metrics.heartRate + ' bpm' : ''}</span></div>
      </div>`).join('')
      : '<p class="muted">No rowers connected yet — tiles appear the moment someone starts streaming.</p>';
    drawLb();
  }

  async function drawLb() {
    const live = [...tiles.values()].filter(t => Number.isFinite(t.metrics?.avgSplitS))
      .map(t => ({ name: t.displayName, split: t.metrics.avgSplitS, finished: !!t.metrics.finished, live: true }));
    let persisted = [];
    if (teamId) {
      try {
        const { entries } = await api(`/workouts/leaderboard/team/${teamId}/${assignmentId}`);
        persisted = entries.map(e => ({ name: e.display_name, split: e.avg_split_s, finished: !!e.finished, live: false }));
      } catch { /* not readable */ }
    }
    // Merge: live data wins for currently-streaming rowers.
    const byName = new Map();
    for (const p of persisted) byName.set(p.name, p);
    for (const l of live) byName.set(l.name, l);
    const rows = [...byName.values()].filter(r => Number.isFinite(r.split))
      .sort((a, b) => (b.finished - a.finished) || (a.split - b.split));
    el.querySelector('#lb').innerHTML = rows.length ? rows.map((r, i) => `
      <div class="lb-row ${i === 0 ? 'first' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <span>${esc(r.name)} ${r.finished ? '<span class="badge green">finished</span>' : '<span class="badge blue">in progress</span>'}</span>
        <span class="lb-split">${fmtSplit(r.split)}</span>
      </div>`).join('') : '<p class="muted small">No results yet.</p>';
  }

  subscribe(channel, state.user.accountType === 'coach' ? 'coach' : 'rower');
  const off = onRealtime((msg) => {
    if (msg.type === '_socket') {
      el.querySelector('#liveStatus').textContent = msg.up ? 'Live — updating in real time.' : 'Reconnecting…';
      return;
    }
    if (msg.channel !== channel) return;
    if (msg.type === 'roster') {
      for (const r of msg.roster) {
        if (r.role === 'coach' && !r.metrics) continue; // don't tile spectating coaches
        tiles.set(r.userId, { ...tiles.get(r.userId), ...r });
      }
      // prune entries not in roster anymore
      const ids = new Set(msg.roster.map(r => r.userId));
      for (const id of tiles.keys()) if (!ids.has(id)) tiles.delete(id);
      drawGrid();
    }
    if (msg.type === 'metrics') {
      const t = tiles.get(msg.userId) || { userId: msg.userId, displayName: msg.displayName };
      t.metrics = msg.metrics; t.stale = false; t.connected = true; t.displayName = msg.displayName;
      tiles.set(msg.userId, t);
      drawGrid();
    }
    if (msg.type === 'presence') requestRoster(channel);
    if (msg.type === 'error') el.querySelector('#liveStatus').textContent = msg.message;
  });

  drawLb(); // show persisted results immediately (post-workout view, §2.4)
  return () => { off(); unsubscribe(channel); };
}
