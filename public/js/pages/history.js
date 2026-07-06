// §2.5 — Account-scoped workout history (server-side keyed by user_id).
import { api, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate } from '../api.js';

export async function renderHistory(el) {
  el.innerHTML = `<h1>History</h1><p class="muted">Loading…</p>`;
  let workouts = [];
  try { ({ workouts } = await api('/workouts/?limit=100')); }
  catch (e) {
    el.innerHTML = `<h1>History</h1><div class="notice warn">${esc(e.message)}</div>`;
    return;
  }
  el.innerHTML = `<h1>History</h1>
    <div class="row between mb"><span class="muted small">${workouts.length} workouts · newest first</span>
      <a class="btn ghost sm" href="/api/users/me/export.csv" onclick="return false" id="exportBtn">Export CSV</a></div>
    ${workouts.length ? workouts.map(w => `
      <a class="card tight list-item" style="color:inherit" href="#/workout/${w.id}">
        <div class="avatar">${w.machine_type === 'bike' ? '🚲' : '🚣'}</div>
        <div style="flex:1">
          <strong>${fmtDistance(w.total_distance_m)} · ${fmtDuration(w.total_time_s)}</strong>
          <div class="muted small">${fmtDate(w.started_at)} · avg ${fmtSplit(w.avg_split_s)}/500m · ${Math.round(w.avg_stroke_rate || 0)} s/m${w.assigned_by_coach_id ? ' · <span class="badge blue">coach</span>' : ''}</div>
        </div>
        ${w.aiFeedback ? `<span class="badge ${w.aiFeedback.classification === 'well_paced' ? 'green' : 'amber'}">${esc((w.aiFeedback.classification || '').replaceAll('_', ' '))}</span>` : ''}
      </a>`).join('') : `<div class="card center"><p class="muted">No workouts yet. Your history starts completely empty and is yours alone.</p><a class="btn" href="#/row">Row your first piece</a></div>`}`;

  el.querySelector('#exportBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const r = await api('/users/me/export.csv', { raw: true });
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'rowpoint-export.csv'; a.click();
    URL.revokeObjectURL(a.href);
  });
}
