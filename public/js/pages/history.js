// §2.5 — Account-scoped workout history (server-side keyed by user_id).
import { api, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate } from '../api.js';
import { icon, machineIcon } from '../icons.js';

export async function renderHistory(el) {
  el.innerHTML = `<h1>History</h1><p class="muted">Loading…</p>`;
  let workouts = [];
  try { ({ workouts } = await api('/workouts/?limit=100')); }
  catch (e) {
    el.innerHTML = `<h1>History</h1><div class="notice warn">${esc(e.message)}</div>`;
    return;
  }
  el.innerHTML = `<div class="page-head"><h1>History</h1></div>
    <div class="row between mb"><span class="muted small">${workouts.length} workouts · newest first</span>
      <span class="row" style="gap:6px"><a class="btn secondary sm" href="#/journal">${icon('book', { size: 16 })} Journal</a>
      <a class="btn ghost sm" href="/api/users/me/export.csv" onclick="return false" id="exportBtn">${icon('download', { size: 16 })} Export CSV</a></span></div>
    ${workouts.length ? workouts.map(w => `
      <a class="card tight list-item" style="color:inherit" href="#/workout/${w.id}">
        <span class="li-icon accent">${icon(machineIcon(w.machine_type), { size: 20 })}</span>
        <div class="li-body">
          <strong>${fmtDistance(w.total_distance_m)} · ${fmtDuration(w.total_time_s)}</strong>
          <div class="muted small">${fmtDate(w.started_at)} · avg ${fmtSplit(w.avg_split_s)}/500m · ${Math.round(w.avg_stroke_rate || 0)} s/m${w.assigned_by_coach_id ? ' · <span class="badge blue">coach</span>' : ''}</div>
        </div>
        ${w.aiFeedback ? `<span class="badge ${w.aiFeedback.classification === 'well_paced' ? 'green' : 'amber'}">${esc((w.aiFeedback.classification || '').replaceAll('_', ' '))}</span>`
          : `<span class="li-go">${icon('chevron-right', { size: 18 })}</span>`}
      </a>`).join('') : `<div class="card"><div class="empty"><div class="center" style="margin-bottom:14px"><span class="icon-chip lg">${icon('history')}</span></div><h3>No workouts yet</h3><p class="muted">Your history starts completely empty and is yours alone.</p><a class="btn mt" href="#/row">${icon('oar', { size: 17 })} Row your first piece</a></div></div>`}`;

  el.querySelector('#exportBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const r = await api('/users/me/export.csv', { raw: true });
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'rowpoint-export.csv'; a.click();
    URL.revokeObjectURL(a.href);
  });
}
