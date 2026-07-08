// Adaptive Training Plan — the flagship coaching surface. Shows the athlete's
// periodized multi-week plan (phase timeline + current week prescriptions),
// a weekly coaching review, and one-tap adaptation that re-tunes upcoming weeks
// from real training — every change explained. Backed by /api/training/*.
import { api, state, toast, esc, fmtDistance, fmtSplit } from '../api.js';
import { t } from '../i18n.js';

const PHASE_COLOR = {
  base: '#3b82f6', build: '#10b981', threshold: '#f59e0b',
  peak: '#f97316', taper: '#a855f7', race: '#eab308', recovery: '#64748b',
};

export async function renderPlan(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let plan, review;
  try {
    const [p, r] = await Promise.all([api('/training/plan'), api('/training/weekly-review')]);
    plan = p.plan; review = r.review;
  } catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }

  if (!plan) { renderCreate(el); return; }

  const weeks = plan.weeks || [];
  const cur = plan.currentWeekIndex || 0;
  const week = weeks[cur];

  el.innerHTML = `
    <header class="mb">
      <h1>${esc(t('plan.title'))}</h1>
      <p class="muted">${esc(plan.goalEvent || t('plan.subtitle'))}${plan.weeksToGoal != null ? ` · ${esc(t('plan.weeksToGoal', { n: plan.weeksToGoal }))}` : ''}</p>
    </header>

    ${plan.coachNote ? `<div class="notice mb">🧑‍🏫 <strong>${esc(t('plan.coachNote'))}:</strong> ${esc(plan.coachNote)}</div>` : ''}

    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${esc(t('plan.timeline'))}</h3>
        <span class="muted small">${esc(t('plan.weekOf', { n: cur + 1, total: plan.totalWeeks }))}</span>
      </div>
      <div style="display:flex;gap:2px;margin-top:12px;border-radius:6px;overflow:hidden">
        ${weeks.map((w, i) => `<div title="${esc(t('plan.wk'))} ${i + 1}: ${esc(w.phaseLabel)}${w.deload ? ' (deload)' : ''} · ${Math.round(w.targetMeters / 1000)}k"
          style="flex:1;height:34px;background:${PHASE_COLOR[w.phase] || '#64748b'};opacity:${i === cur ? 1 : 0.42};position:relative;${i === cur ? 'outline:2px solid var(--fg);outline-offset:-2px' : ''}">
          ${w.deload ? '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.6rem">•</span>' : ''}
        </div>`).join('')}
      </div>
      <div class="row mt" style="flex-wrap:wrap;gap:10px">
        ${[...new Set(weeks.map(w => w.phase))].map(ph =>
    `<span class="small" style="display:inline-flex;align-items:center;gap:5px"><span style="width:11px;height:11px;border-radius:3px;background:${PHASE_COLOR[ph]}"></span>${esc(phaseName(ph))}</span>`).join('')}
      </div>
      <p class="muted small mt">${esc(plan.rationale || '')}</p>
    </div>

    ${week ? currentWeekHtml(week, cur) : ''}

    ${reviewHtml(review)}

    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div><h3 style="margin:0">${esc(t('plan.adapt'))}</h3>
          <p class="muted small" style="margin:2px 0 0">${esc(t('plan.adaptSub'))}</p></div>
        <button id="adaptBtn">${esc(t('plan.adaptCta'))}</button>
      </div>
      <div id="adaptOut" class="mt"></div>
      ${(plan.adaptations || []).length ? `<details class="mt"><summary class="small muted">${esc(t('plan.history'))}</summary>
        ${plan.adaptations.slice(0, 6).map(a => `<div class="list-item"><div><div class="small muted">${new Date(a.at * 1000).toLocaleDateString()}</div>
          ${(a.decisions || []).map(d => `<div class="small"><strong>${esc(d.change)}</strong> — ${esc(d.reason)}</div>`).join('')}</div></div>`).join('')}
      </details>` : ''}
    </div>

    <div class="row mt" style="gap:8px">
      <button class="secondary sm" id="regenBtn">${esc(t('plan.regenerate'))}</button>
      <button class="ghost sm" id="archiveBtn">${esc(t('plan.archive'))}</button>
    </div>`;

  el.querySelector('#adaptBtn').onclick = async (ev) => {
    ev.target.disabled = true; ev.target.textContent = t('plan.adapting');
    try {
      const r = await api('/training/plan/adapt', { method: 'POST' });
      const out = el.querySelector('#adaptOut');
      if (r.decisions.length) {
        out.innerHTML = `<div class="notice">${esc(r.message)}</div>` + r.decisions.map(d =>
          `<div class="list-item"><div class="avatar" aria-hidden="true">⚙︎</div><div><strong>${esc(t('plan.wk'))} ${d.weekIndex + 1}: ${esc(d.change)}</strong>
          <div class="muted small">${esc(d.reason)}</div></div></div>`).join('');
        toast(r.message, 'success', 6000);
        setTimeout(() => renderPlan(el), 1400);
      } else {
        out.innerHTML = `<div class="notice">${esc(r.message)}</div>`;
        toast(r.message, 'info');
      }
    } catch (e) { toast(e.message, 'error'); }
    ev.target.disabled = false; ev.target.textContent = t('plan.adaptCta');
  };
  el.querySelector('#regenBtn').onclick = () => renderCreate(el, plan);
  el.querySelector('#archiveBtn').onclick = async () => {
    if (!confirm(t('plan.archiveConfirm'))) return;
    await api('/training/plan', { method: 'DELETE' });
    toast(t('plan.archived'), 'success');
    renderPlan(el);
  };
}

function currentWeekHtml(week, idx) {
  return `<div class="card" style="border-left:3px solid ${PHASE_COLOR[week.phase] || 'var(--accent)'}">
    <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div><span class="badge" style="background:${PHASE_COLOR[week.phase]}22;color:${PHASE_COLOR[week.phase]}">${esc(week.phaseLabel)}${week.deload ? ' · deload' : ''}</span>
        <h3 style="margin:6px 0 0">${esc(t('plan.thisWeek'))}</h3></div>
      <div class="right"><div class="stat-tile tight" style="min-width:120px"><div class="n">${fmtDistance(week.targetMeters)}</div><div class="l">${esc(t('plan.weeklyTarget'))}</div></div></div>
    </div>
    <p class="muted small">${esc(week.focus)}</p>
    ${week.adaptationNote ? `<div class="notice small mb">⚙︎ ${esc(week.adaptationNote)}</div>` : ''}
    <div class="mt">
      ${(week.sessions || []).map((s, i) => `<div class="list-item">
        <div class="avatar" aria-hidden="true" style="background:${PHASE_COLOR[s.zone === 'ut2' || s.zone === 'ut1' ? 'base' : s.zone === 'threshold' ? 'threshold' : 'peak']}22">${i + 1}</div>
        <div><strong>${esc(s.prescription)}</strong><div class="muted small">${esc(s.why)}</div></div></div>`).join('')}
    </div>
    <p class="muted small mt">${esc(t('plan.sessionsNote'))}</p>
  </div>`;
}

function reviewHtml(r) {
  if (!r) return '';
  const vv = r.volume?.volumeVsTargetPct;
  const fitnessBadge = { improving: 'good', declining: 'bad', 'holding steady': '' }[r.estimatedFitness] ?? '';
  return `<div class="card">
    <h3>${esc(t('plan.weeklyReview'))}</h3>
    <p>${esc(r.summary)}</p>
    <div class="grid cols3 mt">
      <div class="stat-tile tight"><div class="n">${r.volume.sessions}</div><div class="l">${esc(t('plan.sessions'))}</div></div>
      <div class="stat-tile tight"><div class="n">${fmtDistance(r.volume.meters)}</div><div class="l">${esc(t('plan.volume'))}</div></div>
      <div class="stat-tile tight"><div class="n"><span class="badge ${fitnessBadge}">${esc(phaseFitness(r.estimatedFitness))}</span></div><div class="l">${esc(t('plan.fitness'))}</div></div>
    </div>
    ${vv != null ? `<div class="pbar mt"><span style="width:${Math.min(100, vv)}%"></span></div><p class="small muted">${esc(t('plan.ofWeeklyTarget', { pct: vv }))}</p>` : ''}
    ${listBlock(t('plan.strengths'), r.strengths, '✅')}
    ${listBlock(t('plan.watch'), r.weaknesses, '⚠️')}
    ${listBlock(t('plan.focusNext'), r.focusNextWeek, '🎯')}
  </div>`;
}

function listBlock(title, items, icon) {
  if (!items || !items.length) return '';
  return `<div class="mt"><strong class="small">${esc(title)}</strong>
    ${items.map(i => `<div class="small" style="display:flex;gap:6px;margin-top:4px"><span>${icon}</span><span>${esc(i)}</span></div>`).join('')}</div>`;
}

/* ---------------- create / regenerate ---------------- */

function renderCreate(el, existing) {
  const u = state.user || {};
  const in12wk = new Date(Date.now() + 84 * 86400 * 1000).toISOString().slice(0, 10);
  el.innerHTML = `
    <header class="mb"><h1>${esc(t('plan.buildTitle'))}</h1>
      <p class="muted">${esc(t('plan.buildSub'))}</p></header>
    <div class="card">
      <label class="field"><span>${esc(t('plan.goalEvent'))}</span><input id="pEvent" value="${esc(u.goalTargetEvent || '')}" placeholder="${esc(t('plan.goalEventPh'))}"></label>
      <div class="grid cols2">
        <label class="field"><span>${esc(t('plan.goalDate'))}</span><input id="pDate" type="date" value="${esc(u.goalTargetDate || in12wk)}"></label>
        <label class="field"><span>${esc(t('plan.goal2k'))}</span><input id="pGoal2k" placeholder="6:40" value="${u.goal2kSeconds ? fmtSplit(u.goal2kSeconds).replace('.0','') : ''}"></label>
      </div>
      <div class="grid cols2">
        <label class="field"><span>${esc(t('plan.availableDays'))}</span><input id="pDays" type="number" min="2" max="7" value="${u.availableDays || u.goalWeeklySessions || 5}"></label>
        <label class="field"><span>${esc(t('plan.targetWeekly'))}</span><input id="pWeekly" type="number" min="10" max="200" step="5" value="${u.goalWeeklyMeters ? Math.round(u.goalWeeklyMeters / 1000) : ''}" placeholder="60"></label>
      </div>
      <p class="muted small">${esc(t('plan.buildNote'))}</p>
      <button id="genBtn" style="width:100%">${esc(existing ? t('plan.regenerateCta') : t('plan.generate'))}</button>
      ${existing ? `<button class="ghost sm mt" id="cancelGen" style="width:100%">${esc(t('common.back'))}</button>` : ''}
    </div>`;
  el.querySelector('#cancelGen')?.addEventListener('click', () => renderPlan(el));
  el.querySelector('#genBtn').onclick = async (ev) => {
    const days = Number(el.querySelector('#pDays').value) || 5;
    const weeklyKm = Number(el.querySelector('#pWeekly').value);
    const goal2k = parse2k(el.querySelector('#pGoal2k').value);
    const body = {
      goalEvent: el.querySelector('#pEvent').value.trim() || 'My goal race',
      goalDate: el.querySelector('#pDate').value || undefined,
      availableDays: days,
      targetWeeklyMeters: weeklyKm ? weeklyKm * 1000 : undefined,
      goal2kSeconds: goal2k,
    };
    ev.target.disabled = true; ev.target.textContent = t('plan.generating');
    try {
      await api('/training/plan', { method: 'POST', body });
      toast(t('plan.created'), 'success');
      renderPlan(el);
    } catch (e) { toast(e.message, 'error'); ev.target.disabled = false; ev.target.textContent = t('plan.generate'); }
  };
}

/* ---------------- helpers ---------------- */

function phaseName(ph) {
  return { base: t('plan.phaseBase'), build: t('plan.phaseBuild'), threshold: t('plan.phaseThreshold'), peak: t('plan.phasePeak'), taper: t('plan.phaseTaper'), race: t('plan.phaseRace'), recovery: t('plan.phaseRecovery') }[ph] || ph;
}
function phaseFitness(f) {
  return { improving: t('plan.fitnessImproving'), declining: t('plan.fitnessDeclining'), 'holding steady': t('plan.fitnessSteady') }[f] || f;
}
function parse2k(s) {
  if (!s) return undefined;
  const m = String(s).match(/^(\d{1,2}):(\d{2}(?:\.\d)?)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}
