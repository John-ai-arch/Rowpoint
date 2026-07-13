// §2.2/§2.3/§14 — Team detail. Coach: roster with shared data, bulk workout
// assignment, completion tracking, AI-suggestion review/override, live view.
// Rower: assignments + leaderboards.
import { api, state, toast, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate } from '../api.js';
import { icon } from '../icons.js';
import { confirmDialog, promptDialog } from '../components/dialog.js';
import { describePlanText } from './builder.js';

export async function renderTeamDetail(el, teamId) {
  el.innerHTML = `<p class="muted">Loading…</p>`;
  let rosterData = null, assignmentsData;
  try { assignmentsData = await api(`/teams/${teamId}/assignments`); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  const isCoach = assignmentsData.isCoach;
  if (isCoach) {
    try { rosterData = await api(`/teams/${teamId}/roster`); } catch { /* not coach */ }
  }

  const a = assignmentsData.assignments;
  el.innerHTML = `
    <a href="#/teams" class="back-link">${icon('chevron-left', { size: 16 })} Teams</a>
    <h1>${esc(rosterData?.team?.name || 'Team')}</h1>
    ${isCoach ? coachHtml(rosterData, a) : rowerHtml(a)}
  `;

  if (isCoach) wireCoach(el, teamId, rosterData);
  wireCommon(el, teamId);

  function rowerHtml(assignments) {
    return `<div class="section-head"><span class="icon-chip gold">${icon('flag')}</span><div class="titles"><h2>Assigned workouts</h2></div></div>
      ${assignments.length ? assignments.map(x => `
        <div class="card tight">
          <div class="row between">
            <div class="row" style="gap:11px"><span class="li-icon">${icon('oar', { size: 20 })}</span>
            <div><strong>${esc(x.name)}</strong>
              <div class="muted small">${esc(describePlanText(x.plan))} · ${esc(x.scheduledDate)}${x.note ? ` · “${esc(x.note)}”` : ''}</div></div></div>
            <div class="row">
              ${x.completedByMe ? '<span class="badge green">done</span>' : `<a class="btn sm" href="#/row?assignment=${x.id}&team=${teamId}">Row it</a>`}
              <a class="btn ghost sm" href="#/live/${x.id}">Live / results</a>
            </div>
          </div>
        </div>`).join('') : '<p class="muted">No workouts assigned yet.</p>'}`;
  }

  function coachHtml(rd, assignments) {
    return `
    <div class="card">
      <div class="card-head"><span class="icon-chip sm">${icon('calendar', { size: 18 })}</span><h3>Assign a workout to the whole team</h3></div>
      <div class="grid cols2">
        <label class="field"><span>Name</span><input id="aName" value="Team steady state"></label>
        <label class="field"><span>Date</span><input id="aDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      </div>
      <div class="grid cols3">
        <label class="field"><span>Type</span>
          <select id="aType"><option value="distance">Distance</option><option value="time">Time</option><option value="intervals">Intervals</option></select></label>
        <label class="field" id="aV1wrap"><span id="aV1label">Meters</span><input id="aV1" type="number" value="5000"></label>
        <label class="field" id="aV2wrap" style="display:none"><span>Rest (s)</span><input id="aV2" type="number" value="60"></label>
      </div>
      <label class="field"><span>Note (optional)</span><input id="aNote" placeholder="Cap at 22 s/m"></label>
      <button id="assignBtn">Assign to team</button>
    </div>

    <div class="section-head"><span class="icon-chip">${icon('check-circle')}</span><div class="titles"><h2>Assignments & completion</h2></div></div>
    ${assignments.length ? assignments.map(x => `
      <div class="card tight">
        <div class="row between">
          <div><strong>${esc(x.name)}</strong><div class="muted small">${esc(describePlanText(x.plan))} · ${esc(x.scheduledDate)}</div></div>
          <a class="btn sm" href="#/live/${x.id}">${icon('activity', { size: 15 })} Watch live</a>
        </div>
        ${x.roster ? `<div class="row mt" style="gap:6px">
          ${x.roster.map(r => `<span class="badge ${r.completed ? 'green' : 'gray'}">${esc(r.displayName)} ${r.completed ? icon('check', { size: 12 }) : '·'}</span>`).join('')}
          ${!x.roster.length ? '<span class="muted small">No rowers on the team yet.</span>' : ''}
        </div>` : ''}
      </div>`).join('') : '<p class="muted">Nothing assigned yet.</p>'}

    <div class="section-head"><span class="icon-chip">${icon('users')}</span><div class="titles"><h2>Roster</h2></div></div>
    <div id="aiSuggestions"></div>
    ${rd.roster.length ? rd.roster.map(r => `
      <div class="card tight">
        <div class="row between">
          <div class="row"><div class="avatar">${esc(r.displayName[0] || '?')}</div>
            <div><strong>${esc(r.displayName)}</strong>
              <div class="muted small">
                2k PB: ${r.best2kSeconds ? `${fmtDuration(r.best2kSeconds)}${r.best2kVerified ? ` <span style="color:var(--good)">${icon('check', { size: 12 })}</span>` : ' (self-reported)'}` : 'not shared'}
                ${r.weightClass ? ` · ${esc(r.weightClass)}` : ''}${r.goalType ? ` · ${esc(r.goalType.replaceAll('_', ' '))}` : ''}
              </div></div></div>
          <button class="ghost sm" data-remove="${r.id}" data-name="${esc(r.displayName)}">Remove</button>
        </div>
        ${r.sharesWorkouts ? (r.recentWorkouts.length ? `
          <table class="mt"><thead><tr><th>Date</th><th>Dist</th><th>Time</th><th>/500m</th><th>Pacing</th></tr></thead><tbody>
          ${r.recentWorkouts.map(w => {
    let fbTag = ''; try { fbTag = JSON.parse(w.ai_feedback_json || 'null')?.classification || ''; } catch { /* none */ }
    return `<tr><td>${fmtDate(w.started_at)}</td><td>${fmtDistance(w.total_distance_m)}</td><td>${fmtDuration(w.total_time_s)}</td><td>${fmtSplit(w.avg_split_s)}</td><td class="small muted">${esc(fbTag.replaceAll('_', ' '))}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted small mt">No workouts yet.</p>')
    : '<p class="muted small mt">This rower keeps workouts private from the team.</p>'}
        ${r.wellness ? `<p class="muted small">Wellness (shared): last sleep ${r.wellness[0]?.sleep_hours ?? '–'}h, soreness ${r.wellness[0]?.soreness_level ?? '–'}/5</p>` : ''}
      </div>`).join('') : `<div class="card"><p class="muted">No rowers yet — share the team code <strong>${esc(rd.team.code)}</strong> to get started.</p></div>`}`;
  }

  function wireCoach(root, tid, rd) {
    const typeSel = root.querySelector('#aType');
    typeSel?.addEventListener('change', () => {
      const t = typeSel.value;
      root.querySelector('#aV1label').textContent = t === 'time' ? 'Minutes' : t === 'intervals' ? 'Meters per rep' : 'Meters';
      root.querySelector('#aV2wrap').style.display = t === 'intervals' ? '' : 'none';
    });
    root.querySelector('#assignBtn')?.addEventListener('click', async () => {
      const t = typeSel.value;
      const v1 = Number(root.querySelector('#aV1').value);
      const plan = t === 'time' ? { type: 'time', durationS: Math.round(v1 * 60) }
        : t === 'intervals' ? { type: 'intervals', intervals: Array.from({ length: 4 }, () => ({ workType: 'distance', workDistanceM: v1, restTimeS: Number(root.querySelector('#aV2').value) })) }
          : { type: 'distance', distanceM: v1 };
      try {
        await api(`/teams/${tid}/assignments`, {
          method: 'POST',
          body: { name: root.querySelector('#aName').value, plan, scheduledDate: root.querySelector('#aDate').value, note: root.querySelector('#aNote').value || undefined },
        });
        toast('Assigned to the whole team.', 'success');
        renderTeamDetail(el, tid);
      } catch (e) { toast(e.message, 'error'); }
    });
    root.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
      if (!(await confirmDialog(`Remove ${b.dataset.name} from the team?`, { title: 'Remove member', confirmText: 'Remove', danger: true }))) return;
      await api(`/teams/${tid}/members/${b.dataset.remove}`, { method: 'DELETE' });
      toast('Removed.'); renderTeamDetail(el, tid);
    });

    // AI suggestion review (§11.2): coach sees today's per-rower suggestions.
    api(`/ai/team/${tid}/suggestions`).then(({ suggestions }) => {
      if (!suggestions.length) return;
      root.querySelector('#aiSuggestions').innerHTML = `<div class="card ai-card">
        <div class="card-head"><span class="icon-chip sm">${icon('sparkle', { size: 18 })}</span><h3>Today's AI suggestions to your rowers</h3>
          <span class="ai-tag card-head-action">review / override</span></div>
        ${suggestions.map(s => `<div class="list-item"><div style="flex:1">
          <strong>${esc(s.displayName)}</strong> <span class="badge ${s.status === 'overridden' ? 'amber' : 'blue'}">${esc(String(s.status || '').replaceAll('_', ' '))}</span>
          <div class="muted small">${esc(s.text)}</div><div class="ai-tag">${esc(String(s.rationaleTag || '').replaceAll('_', ' '))}</div></div>
          <div><button class="ghost sm" data-appr="${s.id}">Approve</button><button class="ghost sm" data-ovr="${s.id}">Override</button></div>
        </div>`).join('')}</div>`;
      root.querySelectorAll('[data-appr]').forEach(b => b.onclick = async () => {
        await api(`/ai/suggestions/${b.dataset.appr}/override`, { method: 'POST', body: { approve: true } });
        toast('Approved.'); });
      root.querySelectorAll('[data-ovr]').forEach(b => b.onclick = async () => {
        const note = await promptDialog('Replace the AI suggestion with your own note to this rower:', { title: 'Override suggestion', confirmText: 'Send note', multiline: true });
        if (note === null) return;
        await api(`/ai/suggestions/${b.dataset.ovr}/override`, { method: 'POST', body: { note } });
        toast('Overridden — the rower now sees your note instead.');
      });
    }).catch(() => { /* no suggestions yet */ });
  }

  function wireCommon() { /* reserved for shared behaviors */ }
}
