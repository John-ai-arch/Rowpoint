// Home: a "How am I doing?" progress hero (streak, weekly goal, lifetime,
// recent achievements — reusing /api/me/progress), the AI coach recommendation
// (§11), wellness prompt (§12), assigned workouts, daily suggestions (§7),
// and recent workouts.
import { api, state, toast, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate } from '../api.js';
import { t } from '../i18n.js';
import { icon, machineIcon, badgeIcon } from '../icons.js';
import { describePlanText } from './builder.js';

export async function renderDashboard(el) {
  const u = state.user;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  el.innerHTML = `
    <div class="page-head">
      <p class="eyebrow">${esc(today)}</p>
      <h1>${esc(t('dash.greeting', { name: u.displayName.split(' ')[0] }))}</h1>
    </div>
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
  const advisorNotes = aiRes.status === 'fulfilled' ? aiRes.value.advisorNotes : null;
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

    ${(advisorNotes || []).filter(n => n.kind === 'experiment').map(n => `
    <div class="card">
      <div class="card-head">
        <span class="icon-chip sm violet">${icon('lightbulb', { size: 18 })}</span>
        <h3>${esc(n.title || t('dash.experimentTitle'))}</h3>
        <span class="badge blue card-head-action">${esc(t('dash.experimentBadge'))}</span>
      </div>
      <p class="small" style="margin:0 0 6px">${esc(n.note)}</p>
      <p class="muted small" style="margin:0">${esc(t('dash.experimentOptional'))}</p>
    </div>`).join('')}

    ${!checkin ? `
    <div class="card ai-card" id="wellnessNudge">
      <div class="card-head">
        <span class="icon-chip sm">${icon('droplet', { size: 18 })}</span>
        <h3>${esc(t('dash.dailyCheckin'))}</h3>
        <span class="badge blue card-head-action">${esc(t('dash.seconds'))}</span>
      </div>
      <p class="muted small" style="margin:0 0 14px">${esc(t('dash.checkinBlurb'))}</p>
      <a class="btn" href="#/wellness">${icon('check', { size: 17 })} ${esc(t('dash.checkinCta'))}</a>
    </div>` : ''}

    ${assignments.length ? `
    <div class="section-head">
      <span class="icon-chip gold">${icon('flag')}</span>
      <div class="titles"><h2>${esc(t('dash.assignedByCoach'))}</h2></div>
    </div>
    <div class="card">
      ${assignments.map(a => `
        <div class="list-item">
          <span class="li-icon">${icon(machineIcon(a.machineType), { size: 20 })}</span>
          <div class="li-body"><strong>${esc(a.name)}</strong>
            <div class="muted small">${esc(describePlanText(a.plan))} · ${esc(a.teamName)} · ${esc(a.scheduledDate)}${a.note ? ` · “${esc(a.note)}”` : ''}</div></div>
          <a class="btn sm" href="#/row?assignment=${a.id}&team=${a.teamId}">${esc(t('dash.rowIt'))}</a>
        </div>`).join('')}
    </div>` : ''}

    ${daily.length ? `
    <div class="section-head">
      <span class="icon-chip">${icon('timer')}</span>
      <div class="titles"><h2>${esc(t('dash.suggestedToday'))}</h2></div>
    </div>
    <div class="card">
      ${daily.map(d => `<div class="list-item">
        <span class="li-icon">${icon(machineIcon(d.machineType), { size: 20 })}</span>
        <div class="li-body"><strong>${esc(d.name)}</strong>
          <div class="muted small">${esc(d.machineType)} · ${esc(describePlanText(d.plan))}</div></div>
        <a class="btn sm secondary" href="#/row?planId=${d.id}">${esc(t('dash.row'))}</a></div>`).join('')}
    </div>` : ''}

    ${recent.length ? `
    <div class="section-head">
      <span class="icon-chip">${icon('history')}</span>
      <div class="titles"><h2>${esc(t('dash.recentWorkouts'))}</h2></div>
      <a href="#/history" class="head-action">${esc(t('dash.seeAll'))} ${icon('chevron-right', { size: 15 })}</a>
    </div>
    <div class="card">
      ${recent.map(w => `<a class="list-item" href="#/workout/${w.id}" style="color:inherit">
        <span class="li-icon accent">${icon(machineIcon(w.machine_type), { size: 20 })}</span>
        <div class="li-body"><strong>${fmtDistance(w.total_distance_m)} · ${fmtDuration(w.total_time_s)}</strong>
          <div class="muted small">${fmtDate(w.started_at)} · avg ${fmtSplit(w.avg_split_s)}/500m${w.assigned_by_coach_id ? ' · coach-assigned' : ''}</div></div>
        ${w.aiFeedback ? `<span class="badge ${w.aiFeedback.classification === 'well_paced' ? 'green' : 'amber'}">${esc((w.aiFeedback.classification || '').replaceAll('_', ' '))}</span>`
          : `<span class="li-go">${icon('chevron-right', { size: 18 })}</span>`}
      </a>`).join('')}
    </div>` : `<div class="card"><div class="empty"><div class="center" style="margin-bottom:14px"><span class="icon-chip lg">${icon('oar')}</span></div><h3>${esc(t('dash.noWorkoutsTitle'))}</h3><p class="muted">${esc(t('dash.noWorkoutsBlurb'))}</p><a class="btn mt" href="#/row">${icon('oar', { size: 17 })} ${esc(t('dash.startRowing'))}</a></div></div>`}

    ${u.isAdmin ? `
    <div class="section-head">
      <span class="icon-chip plain">${icon('shield')}</span>
      <div class="titles"><h2>${esc(t('dash.adminTools'))}</h2></div>
    </div>
    <div class="card"><a class="btn secondary" href="#/admin">${icon('shield', { size: 17 })} ${esc(t('dash.openAdmin'))}</a></div>` : ''}
  `;

  // "Start this session" hands the coach's machine-programmable plan to the
  // Row page through the same draft mechanism the workout builder uses.
  const startBtn = content.querySelector('#startCoachSession');
  if (startBtn) {
    startBtn.onclick = () => {
      const rec = suggestion.recommendation;
      if (rec?.workout?.plan) {
        sessionStorage.setItem('rp_draft_plan', JSON.stringify({ plan: rec.workout.plan, name: rec.title }));
      } else {
        // Never silently degrade a "start this session" into an unprogrammed
        // free row — say what's happening before navigating.
        toast('This recommendation has no machine-programmable plan, so the monitor won\'t be programmed — opening free row.', 'info', 6000);
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
  <div class="card feature">
    <div class="hero-top">
      <div>
        <p class="eyebrow" style="margin:0 0 12px">${esc(t('dash.howAmIDoing'))}</p>
        <div class="streak-hero">
          <span class="icon-chip lg gold">${icon('flame', { size: 26 })}</span>
          <div>
            <div class="streak-n">${prog.streak.current}</div>
            <div class="streak-l">${esc(t('progress.dayStreak'))}</div>
          </div>
        </div>
      </div>
      <div class="ring" style="width:104px;height:104px">
        <svg viewBox="0 0 104 104" aria-hidden="true">
          <circle class="track" cx="52" cy="52" r="${r}" stroke-width="9"></circle>
          <circle class="bar" cx="52" cy="52" r="${r}" stroke-width="9" stroke="url(#dashring)"
            stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
          <defs><linearGradient id="dashring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#0d9488"/></linearGradient></defs>
        </svg>
        <div class="ring-label"><div class="v" style="font-size:1.25rem">${pct}%</div><div class="u" style="font-size:.55rem;letter-spacing:.4px;max-width:74px;margin:0 auto;line-height:1.15">${esc(t('progress.weeklyGoal'))}</div></div>
      </div>
    </div>

    <div class="grid cols4 hero-stats">
      <div class="stat-tile tight"><div class="n">${fmtDistance(weekMeters)}</div><div class="l">${esc(t('dash.thisWeek'))}</div></div>
      <div class="stat-tile tight"><div class="n">${fmtDistance(prog.totals.meters)}</div><div class="l">${esc(t('dash.lifetime'))}</div></div>
      <div class="stat-tile tight"><div class="n">${prog.totals.workouts}</div><div class="l">${esc(t('progress.totalWorkouts'))}</div></div>
      <div class="stat-tile tight"><div class="n">${u.best2kSeconds ? fmtSplit(u.best2kSeconds / 4) : '–'}</div>
        <div class="l">${esc(t('dash.twoKpb'))} ${u.best2kVerified ? `<span class="verified" title="Verified">${icon('check', { size: 12 })}</span>` : esc(t('dash.selfReported'))}</div></div>
    </div>

    ${recentAch.length ? `
    <div class="hero-ach">
      <p class="eyebrow" style="margin:0 0 9px">${esc(t('dash.recentAchievements'))}</p>
      <div class="row" style="gap:8px">
        ${recentAch.map(b => `<span class="chip" title="${esc(fmtDate(b.achievedAt))}"><span class="chip-ic gold">${icon(badgeIcon(b.badge), { size: 14 })}</span>${esc(t('achievements.' + b.badge))}</span>`).join('')}
      </div>
    </div>` : ''}

    <a class="btn ghost sm hero-cta" href="#/progress">${esc(t('dash.viewProgress'))} ${icon('arrow-right', { size: 16 })}</a>
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
  // and the generation path (language model vs deterministic analysis) is
  // never blurred — phrased for athletes, not developers.
  const sourceLabel = suggestion.source === 'llm' ? 'AI-generated · AI coach'
    : suggestion.source === 'guardrail' ? 'Coach plan first'
      : 'AI-generated · training analysis';
  const sourceIcon = suggestion.source === 'guardrail' ? 'flag' : 'sparkle';
  const confidence = suggestion.confidence || rec.confidence;
  const dur = Array.isArray(w.durationMinutes) ? `${w.durationMinutes[0]}–${w.durationMinutes[1]} min` : null;
  const targets = [
    w.targetPaceSPer500m ? `target ${fmtSplit(w.targetPaceSPer500m)}/500m` : null,
    Array.isArray(w.targetHrPct) ? `HR ${w.targetHrPct[0]}–${w.targetHrPct[1]}% of max` : null,
    w.targetStrokeRate ? `rate ${w.targetStrokeRate}` : null,
  ].filter(Boolean).join(' · ');

  if (overridden) {
    return `<div class="card ai-card">
      <div class="card-head">
        <span class="icon-chip">${icon('flag', { size: 20 })}</span>
        <div class="titles"><h3 style="margin:0">Today's plan</h3><span class="ai-tag">Replaced by your coach</span></div>
      </div>
      <p style="margin:0">${esc(suggestion.text)}</p></div>`;
  }

  return `
    <div class="card ai-card">
      <div class="card-head">
        <span class="icon-chip">${icon(sourceIcon, { size: 20 })}</span>
        <div class="titles"><h3 style="margin:0">Today's coach recommendation</h3>
          <span class="ai-tag">${esc(sourceLabel)}</span></div>
      </div>
      <p><strong>${esc(rec.title || '')}</strong>
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
