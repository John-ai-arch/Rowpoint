// Home: AI suggestion of the day (§11), wellness prompt (§12), assigned
// workouts, daily suggested workouts (§7), quick stats.
import { api, state, toast, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate } from '../api.js';
import { describePlanText } from './builder.js';

export async function renderDashboard(el) {
  const u = state.user;
  el.innerHTML = `<h1>Hi, ${esc(u.displayName.split(' ')[0])} 👋</h1><div id="content"><p class="muted">Loading…</p></div>`;

  const content = el.querySelector('#content');
  const [wellnessRes, aiRes, teamsRes, workoutsRes, dailyRes] = await Promise.allSettled([
    api('/wellness/today'),
    api('/ai/suggestion'),
    api('/teams'),
    api('/workouts/?limit=5'),
    api('/workouts/daily/suggestions'),
  ]);

  const checkin = wellnessRes.status === 'fulfilled' ? wellnessRes.value.checkin : null;
  const suggestion = aiRes.status === 'fulfilled' ? aiRes.value.suggestion : null;
  const teams = teamsRes.status === 'fulfilled' ? teamsRes.value : { coached: [], joined: [] };
  const recent = workoutsRes.status === 'fulfilled' ? workoutsRes.value.workouts : [];
  const daily = dailyRes.status === 'fulfilled' ? dailyRes.value.suggestions : [];

  // Assigned workouts across joined teams (today's first).
  let assignments = [];
  for (const t of teams.joined || []) {
    try {
      const r = await api(`/teams/${t.id}/assignments`);
      assignments.push(...r.assignments.filter(a => !a.completedByMe).map(a => ({ ...a, teamName: t.name, teamId: t.id })));
    } catch { /* team fetch best-effort */ }
  }
  assignments = assignments.slice(0, 4);

  const totalM = recent.reduce((s, w) => s + (w.total_distance_m || 0), 0);

  content.innerHTML = `
    ${!checkin ? `
    <div class="card ai-card" id="wellnessNudge">
      <div class="row between"><h3>Daily check-in</h3><span class="badge blue">~20 seconds</span></div>
      <p class="muted small">Sleep, soreness, stress — it powers smarter training suggestions and overtraining alerts.</p>
      <a class="btn" href="#/wellness">Check in now</a>
    </div>` : ''}

    ${suggestion ? renderCoachCard(suggestion) : ''}

    ${assignments.length ? `
    <div class="card">
      <h3>Assigned by your coach</h3>
      ${assignments.map(a => `
        <div class="list-item">
          <div style="flex:1"><strong>${esc(a.name)}</strong>
            <div class="muted small">${esc(describePlanText(a.plan))} · ${esc(a.teamName)} · ${esc(a.scheduledDate)}${a.note ? ` · “${esc(a.note)}”` : ''}</div></div>
          <a class="btn sm" href="#/row?assignment=${a.id}&team=${a.teamId}">Row it</a>
        </div>`).join('')}
    </div>` : ''}

    <div class="grid cols3">
      <div class="stat-tile"><div class="n">${recent.length}</div><div class="l">recent workouts</div></div>
      <div class="stat-tile"><div class="n">${fmtDistance(totalM)}</div><div class="l">recent meters</div></div>
      <div class="stat-tile"><div class="n">${u.best2kSeconds ? fmtSplit(u.best2kSeconds / 4) : '–'}</div><div class="l">2k pace PB ${u.best2kVerified ? '✓' : '(self-reported)'}</div></div>
    </div>

    ${daily.length ? `
    <div class="card">
      <h3>Today's suggested workouts</h3>
      ${daily.map(d => `<div class="list-item"><div style="flex:1"><strong>${esc(d.name)}</strong>
        <div class="muted small">${esc(d.machineType)} · ${esc(describePlanText(d.plan))}</div></div>
        <a class="btn sm secondary" href="#/row?planId=${d.id}">Row</a></div>`).join('')}
    </div>` : ''}

    ${recent.length ? `
    <div class="card">
      <div class="row between"><h3>Recent workouts</h3><a href="#/history" class="small">See all →</a></div>
      ${recent.map(w => `<a class="list-item" href="#/workout/${w.id}" style="color:inherit">
        <div class="avatar">${w.machine_type === 'bike' ? '🚲' : '🚣'}</div>
        <div style="flex:1"><strong>${fmtDistance(w.total_distance_m)} · ${fmtDuration(w.total_time_s)}</strong>
          <div class="muted small">${fmtDate(w.started_at)} · avg ${fmtSplit(w.avg_split_s)}/500m${w.assigned_by_coach_id ? ' · coach-assigned' : ''}</div></div>
        ${w.aiFeedback ? `<span class="badge ${w.aiFeedback.classification === 'well_paced' ? 'green' : 'amber'}">${esc((w.aiFeedback.classification || '').replaceAll('_', ' '))}</span>` : ''}
      </a>`).join('')}
    </div>` : `<div class="card center"><h3>No workouts yet</h3><p class="muted">Connect to an erg — or fire up the simulator — and pull your first strokes.</p><a class="btn" href="#/row">Start rowing</a></div>`}

    ${u.isAdmin ? `<div class="card"><h3>Admin tools</h3><a class="btn secondary" href="#/admin">Open admin dashboard</a></div>` : ''}
  `;

  // "Start this session" hands the coach's machine-programmable plan to the
  // Row page through the same draft mechanism the workout builder uses.
  const startBtn = content.querySelector('#startCoachSession');
  if (startBtn) {
    startBtn.onclick = () => {
      const rec = suggestion.recommendation;
      if (rec?.workout?.plan) {
        sessionStorage.setItem('rp_draft_plan', JSON.stringify({ plan: rec.workout.plan, name: rec.title }));
      }
      location.hash = '#/row';
    };
  }
  const whyBtn = content.querySelector('#coachWhyBtn');
  if (whyBtn) {
    whyBtn.onclick = () => {
      const d = content.querySelector('#coachDetail');
      d.style.display = d.style.display === 'none' ? '' : 'none';
      whyBtn.textContent = d.style.display === 'none' ? 'Why this workout?' : 'Hide details';
    };
  }
}

/** Today's AI coach recommendation card. */
function renderCoachCard(suggestion) {
  const rec = suggestion.recommendation || suggestion.structured || {};
  const w = rec.workout || {};
  const overridden = suggestion.status === 'overridden';
  // §11.5 disclosure: machine-generated coaching is always labeled as such,
  // and the generation path (LLM vs analysis engine) is never blurred.
  const sourceLabel = suggestion.source === 'llm' ? '✨ AI-generated · LLM coach'
    : suggestion.source === 'guardrail' ? 'Coach plan first'
      : '✨ AI-generated · analysis engine';
  const confidence = suggestion.confidence || rec.confidence;
  const dur = Array.isArray(w.durationMinutes) ? `${w.durationMinutes[0]}–${w.durationMinutes[1]} min` : null;
  const targets = [
    w.targetPaceSPer500m ? `target ${fmtSplit(w.targetPaceSPer500m)}/500m` : null,
    Array.isArray(w.targetHrPct) ? `HR ${w.targetHrPct[0]}–${w.targetHrPct[1]}% of max` : null,
    w.targetStrokeRate ? `rate ${w.targetStrokeRate}` : null,
  ].filter(Boolean).join(' · ');

  if (overridden) {
    return `<div class="card ai-card">
      <div class="row between"><h3>Today's plan</h3><span class="ai-tag">Replaced by your coach</span></div>
      <p>${esc(suggestion.text)}</p></div>`;
  }

  return `
    <div class="card ai-card">
      <div class="row between"><h3>Today's coach recommendation</h3><span class="ai-tag">${sourceLabel}</span></div>
      <p><strong>${esc(rec.title || '')}</strong> <code>${esc(suggestion.rationaleTag || rec.category || '')}</code>
        ${confidence ? `<span class="badge ${confidence === 'high' ? 'green' : confidence === 'medium' ? 'blue' : 'gray'}">${esc(confidence)} confidence</span>` : ''}</p>
      ${w.description ? `<p>${esc(w.description)}</p>` : ''}
      ${dur || targets ? `<p class="muted small">${[dur, targets].filter(Boolean).join(' · ')}</p>` : ''}
      <p>${esc(rec.explanation || suggestion.text || '')}</p>
      ${rec.healthPrompt ? '<div class="notice warn small">This pattern may be worth mentioning to your coach or a medical professional — RowPoint can\'t make a clinical assessment.</div>' : ''}

      <div id="coachDetail" style="display:none">
        ${rec.whyAppropriate ? `<p class="small"><strong>Why this fits you now:</strong> ${esc(rec.whyAppropriate)}</p>` : ''}
        ${rec.targetSystem ? `<p class="small"><strong>Targets:</strong> ${esc(rec.targetSystem)}</p>` : ''}
        ${rec.expectedAdaptations ? `<p class="small"><strong>Expected adaptations:</strong> ${esc(rec.expectedAdaptations)}</p>` : ''}
        ${rec.recoveryAdvice ? `<p class="small"><strong>Recovery:</strong> ${esc(rec.recoveryAdvice)}</p>` : ''}
        ${Array.isArray(rec.keyFactors) && rec.keyFactors.length ? `<p class="small"><strong>Based on:</strong></p>
          <ul class="small muted">${rec.keyFactors.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${rec.alternative ? `<p class="small"><strong>Alternative — ${esc(rec.alternative.title)}:</strong> ${esc(rec.alternative.description)}</p>` : ''}
        <p class="muted small">Generated from your complete training history — the recommendation evolves as you train.</p>
      </div>

      <div class="row mt">
        ${!rec.restDay && rec.category !== 'coach_assignment'
    ? '<button class="secondary sm" id="startCoachSession">Start this session</button>' : ''}
        <button class="ghost sm" id="coachWhyBtn">Why this workout?</button>
      </div>
    </div>`;
}
