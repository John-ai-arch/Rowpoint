// Home: a "How am I doing?" progress hero (streak, weekly goal, lifetime,
// recent achievements — reusing /api/me/progress), the AI coach recommendation
// (§11), wellness prompt (§12), assigned workouts, daily suggestions (§7),
// and recent workouts.
import { api, state, toast, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate } from '../api.js';
import { t } from '../i18n.js';
import { describePlanText } from './builder.js';

export async function renderDashboard(el) {
  const u = state.user;
  el.innerHTML = `<h1>${esc(t('dash.greeting', { name: u.displayName.split(' ')[0] }))}</h1>
    <div id="content">${dashSkeleton()}</div>`;

  const content = el.querySelector('#content');
  const [wellnessRes, aiRes, teamsRes, workoutsRes, dailyRes, progRes] = await Promise.allSettled([
    api('/wellness/today'),
    api('/ai/suggestion'),
    api('/teams'),
    api('/workouts/?limit=5'),
    api('/workouts/daily/suggestions'),
    api('/me/progress'),
  ]);

  const checkin = wellnessRes.status === 'fulfilled' ? wellnessRes.value.checkin : null;
  const suggestion = aiRes.status === 'fulfilled' ? aiRes.value.suggestion : null;
  const teams = teamsRes.status === 'fulfilled' ? teamsRes.value : { coached: [], joined: [] };
  const recent = workoutsRes.status === 'fulfilled' ? workoutsRes.value.workouts : [];
  const daily = dailyRes.status === 'fulfilled' ? dailyRes.value.suggestions : [];
  const prog = progRes.status === 'fulfilled' ? progRes.value.progress : null;

  // Assigned workouts across joined teams (today's first).
  let assignments = [];
  for (const tm of teams.joined || []) {
    try {
      const r = await api(`/teams/${tm.id}/assignments`);
      assignments.push(...r.assignments.filter(a => !a.completedByMe).map(a => ({ ...a, teamName: tm.name, teamId: tm.id })));
    } catch { /* team fetch best-effort */ }
  }
  assignments = assignments.slice(0, 4);

  content.innerHTML = `
    ${prog && prog.totals.workouts ? heroHtml(prog, u) : ''}

    ${suggestion ? renderCoachCard(suggestion) : ''}

    ${!checkin ? `
    <div class="card ai-card" id="wellnessNudge">
      <div class="row between"><h3>${esc(t('dash.dailyCheckin'))}</h3><span class="badge blue">${esc(t('dash.seconds'))}</span></div>
      <p class="muted small">${esc(t('dash.checkinBlurb'))}</p>
      <a class="btn" href="#/wellness">${esc(t('dash.checkinCta'))}</a>
    </div>` : ''}

    ${assignments.length ? `
    <div class="card">
      <h3>${esc(t('dash.assignedByCoach'))}</h3>
      ${assignments.map(a => `
        <div class="list-item">
          <div style="flex:1"><strong>${esc(a.name)}</strong>
            <div class="muted small">${esc(describePlanText(a.plan))} · ${esc(a.teamName)} · ${esc(a.scheduledDate)}${a.note ? ` · “${esc(a.note)}”` : ''}</div></div>
          <a class="btn sm" href="#/row?assignment=${a.id}&team=${a.teamId}">${esc(t('dash.rowIt'))}</a>
        </div>`).join('')}
    </div>` : ''}

    ${daily.length ? `
    <div class="card">
      <h3>${esc(t('dash.suggestedToday'))}</h3>
      ${daily.map(d => `<div class="list-item"><div style="flex:1"><strong>${esc(d.name)}</strong>
        <div class="muted small">${esc(d.machineType)} · ${esc(describePlanText(d.plan))}</div></div>
        <a class="btn sm secondary" href="#/row?planId=${d.id}">${esc(t('dash.row'))}</a></div>`).join('')}
    </div>` : ''}

    ${recent.length ? `
    <div class="card">
      <div class="row between"><h3>${esc(t('dash.recentWorkouts'))}</h3><a href="#/history" class="small">${esc(t('dash.seeAll'))}</a></div>
      ${recent.map(w => `<a class="list-item" href="#/workout/${w.id}" style="color:inherit">
        <div class="avatar">${w.machine_type === 'bike' ? '🚲' : '🚣'}</div>
        <div style="flex:1"><strong>${fmtDistance(w.total_distance_m)} · ${fmtDuration(w.total_time_s)}</strong>
          <div class="muted small">${fmtDate(w.started_at)} · avg ${fmtSplit(w.avg_split_s)}/500m${w.assigned_by_coach_id ? ' · coach-assigned' : ''}</div></div>
        ${w.aiFeedback ? `<span class="badge ${w.aiFeedback.classification === 'well_paced' ? 'green' : 'amber'}">${esc((w.aiFeedback.classification || '').replaceAll('_', ' '))}</span>` : ''}
      </a>`).join('')}
    </div>` : `<div class="card"><div class="empty"><span class="ic" aria-hidden="true">🚣</span><h3>${esc(t('dash.noWorkoutsTitle'))}</h3><p class="muted">${esc(t('dash.noWorkoutsBlurb'))}</p><a class="btn mt" href="#/row">${esc(t('dash.startRowing'))}</a></div></div>`}

    ${u.isAdmin ? `<div class="card"><h3>${esc(t('dash.adminTools'))}</h3><a class="btn secondary" href="#/admin">${esc(t('dash.openAdmin'))}</a></div>` : ''}
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

/** "How am I doing?" hero — streak, weekly goal ring, lifetime, this week,
 *  2k PB, and recent achievements. Reuses the /api/me/progress payload. */
function heroHtml(prog, u) {
  const weekMeters = prog.week.meters;
  const goalMeters = Math.max(prog.goals.weeklyMeters || 0, 1);
  const pct = Math.min(100, Math.round((weekMeters / goalMeters) * 100));
  const r = 40, c = 2 * Math.PI * r, offset = c * (1 - pct / 100);
  const recentAch = (prog.badges || []).filter(b => b.unlocked)
    .sort((a, b) => (b.achievedAt || 0) - (a.achievedAt || 0)).slice(0, 4);

  return `
  <div class="card" style="background:linear-gradient(150deg, rgba(56,189,248,.10), var(--card) 60%)">
    <div class="row between" style="align-items:flex-start;gap:18px">
      <div>
        <p class="muted small" style="margin:0 0 10px">${esc(t('dash.howAmIDoing'))}</p>
        <div class="row" style="gap:22px;align-items:center">
          <div class="streak-hero">
            <span class="flame" aria-hidden="true">🔥</span>
            <div><div style="font-size:2rem;font-weight:800;font-variant-numeric:tabular-nums;line-height:1">${prog.streak.current}</div>
              <div class="l" style="color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.6px">${esc(t('progress.dayStreak'))}</div></div>
          </div>
          <div class="ring" style="width:96px;height:96px">
            <svg viewBox="0 0 96 96" aria-hidden="true">
              <circle class="track" cx="48" cy="48" r="${r}" stroke-width="9"></circle>
              <circle class="bar" cx="48" cy="48" r="${r}" stroke-width="9" stroke="url(#dashring)"
                stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
              <defs><linearGradient id="dashring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#0d9488"/></linearGradient></defs>
            </svg>
            <div class="ring-label"><div class="v" style="font-size:1.1rem">${pct}%</div><div class="u" style="font-size:.55rem;letter-spacing:.4px;max-width:72px;margin:0 auto;line-height:1.15">${esc(t('progress.weeklyGoal'))}</div></div>
          </div>
        </div>
      </div>
      <a class="btn ghost sm" href="#/progress">${esc(t('dash.viewProgress'))}</a>
    </div>

    <div class="grid cols4 mt">
      <div class="stat-tile tight"><div class="n">${fmtDistance(weekMeters)}</div><div class="l">${esc(t('dash.thisWeek'))}</div></div>
      <div class="stat-tile tight"><div class="n">${fmtDistance(prog.totals.meters)}</div><div class="l">${esc(t('dash.lifetime'))}</div></div>
      <div class="stat-tile tight"><div class="n">${prog.totals.workouts}</div><div class="l">${esc(t('progress.totalWorkouts'))}</div></div>
      <div class="stat-tile tight"><div class="n">${u.best2kSeconds ? fmtSplit(u.best2kSeconds / 4) : '–'}</div><div class="l">${esc(t('dash.twoKpb'))} ${u.best2kVerified ? '✓' : esc(t('dash.selfReported'))}</div></div>
    </div>

    ${recentAch.length ? `
    <div class="mt">
      <p class="muted small" style="margin:4px 0 8px">${esc(t('dash.recentAchievements'))}</p>
      <div class="row" style="gap:8px">
        ${recentAch.map(b => `<span class="chip" title="${esc(fmtDate(b.achievedAt))}">${b.icon} ${esc(t('achievements.' + b.badge))}</span>`).join('')}
      </div>
    </div>` : ''}
  </div>`;
}

function dashSkeleton() {
  return `<div class="card skeleton" style="height:190px"></div>
    <div class="card skeleton" style="height:150px"></div>
    <div class="grid cols3">${'<div class="stat-tile skeleton" style="height:74px"></div>'.repeat(3)}</div>`;
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
