// Adaptive Training Plan — the flagship coaching surface. Shows the athlete's
// periodized multi-week plan (phase timeline + current week prescriptions),
// a weekly coaching review, and one-tap adaptation that re-tunes upcoming weeks
// from real training — every change explained. Backed by /api/training/*.
import { api, state, toast, esc, fmtDistance, fmtSplit } from '../api.js';
import { confirmDialog } from '../components/dialog.js';
import { t } from '../i18n.js';

const PHASE_COLOR = {
  base: '#3b82f6', build: '#10b981', threshold: '#f59e0b',
  peak: '#f97316', taper: '#a855f7', race: '#eab308', recovery: '#64748b',
};

export async function renderPlan(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let plan, review, season;
  try {
    const [p, r, s] = await Promise.all([api('/training/plan'), api('/training/weekly-review'), api('/training/season').catch(() => null)]);
    plan = p.plan; review = r.review; season = s;
  } catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }

  if (!plan) { renderCreate(el, null, season); return; }

  const weeks = plan.weeks || [];
  const cur = plan.currentWeekIndex || 0;
  const week = weeks[cur];

  el.innerHTML = `
    <header class="mb">
      <h1>${esc(t('plan.title'))}</h1>
      <p class="muted">${esc(plan.goalEvent || t('plan.subtitle'))}${plan.weeksToGoal != null ? ` · ${esc(t('plan.weeksToGoal', { n: plan.weeksToGoal }))}` : ''}</p>
    </header>

    ${plan.coachNote ? `<div class="notice mb">🧑‍🏫 <strong>${esc(t('plan.coachNote'))}:</strong> ${esc(plan.coachNote)}</div>` : ''}

    ${season ? seasonHtml(season) : ''}

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
  el.querySelector('#regenBtn').onclick = () => renderCreate(el, plan, season);
  el.querySelector('#archiveBtn').onclick = async () => {
    if (!(await confirmDialog(t('plan.archiveConfirm'), { danger: true }))) return;
    await api('/training/plan', { method: 'DELETE' });
    toast(t('plan.archived'), 'success');
    renderPlan(el);
  };
  wireSeason(el, season);
}

/* ---------------- season planner ---------------- */

const PRIORITY_COLOR = { A: '#ef4444', B: '#f59e0b', C: '#64748b' };

function seasonHtml(season) {
  const races = season.upcoming || [];
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">${esc(t('season.title'))}</h3>
      <button class="ghost sm" id="addRaceBtn">${esc(t('season.addRace'))}</button>
    </div>
    <div id="raceForm"></div>
    ${races.length ? races.map(r => `<div class="list-item" style="align-items:flex-start">
      <div style="flex:0 0 auto;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:${PRIORITY_COLOR[r.priority]}22;color:${PRIORITY_COLOR[r.priority]};font-weight:700">${esc(r.priority)}</div>
      <div style="flex:1">
        <strong>${esc(r.name)}</strong>${r.distance ? ` <span class="badge">${esc(r.distance)}</span>` : ''}
        <div class="muted small">${esc(r.raceDate)}${r.daysAway != null ? ` · ${esc(t('season.daysAway', { n: r.daysAway }))}` : ''}${r.location ? ` · ${esc(r.location)}` : ''}</div>
      </div>
      <div class="row" style="gap:4px">
        <button class="ghost sm" data-plan-race="${esc(r.name)}|${esc(r.raceDate)}">${esc(t('season.buildPlan'))}</button>
        <button class="ghost sm" data-del-race="${esc(r.id)}">✕</button>
      </div>
    </div>`).join('') : `<p class="muted small">${esc(t('season.empty'))}</p>`}
  </div>`;
}

function wireSeason(el, season) {
  if (!season) return;
  const addBtn = el.querySelector('#addRaceBtn');
  if (addBtn) addBtn.onclick = () => {
    const host = el.querySelector('#raceForm');
    host.innerHTML = `<div style="padding:12px;background:var(--bg2);border-radius:12px;margin:8px 0">
      <div class="grid cols2">
        <label class="field"><span>${esc(t('season.raceName'))}</span><input id="rName" placeholder="${esc(t('season.raceNamePh'))}"></label>
        <label class="field"><span>${esc(t('season.raceDate'))}</span><input id="rDate" type="date"></label>
        <label class="field"><span>${esc(t('season.priority'))}</span><select id="rPri"><option value="A">A — ${esc(t('season.priorityA'))}</option><option value="B" selected>B</option><option value="C">C</option></select></label>
        <label class="field"><span>${esc(t('season.distance'))}</span><select id="rDist"><option value="">—</option>${['2000m', '5000m', '6000m', 'head', 'marathon', 'other'].map(d => `<option>${d}</option>`).join('')}</select></label>
      </div>
      <div class="row" style="gap:8px"><button id="rSave" class="sm">${esc(t('season.save'))}</button><button class="secondary sm" id="rCancel">${esc(t('common.cancel') || 'Cancel')}</button></div>
    </div>`;
    host.querySelector('#rCancel').onclick = () => { host.innerHTML = ''; };
    host.querySelector('#rSave').onclick = async () => {
      const name = host.querySelector('#rName').value.trim();
      const raceDate = host.querySelector('#rDate').value;
      if (!name || !raceDate) { toast(t('season.needNameDate'), 'error'); return; }
      try {
        await api('/training/races', { method: 'POST', body: { name, raceDate, priority: host.querySelector('#rPri').value, distance: host.querySelector('#rDist').value || undefined } });
        toast(t('season.added'), 'success');
        renderPlan(el);
      } catch (e) { toast(e.message, 'error'); }
    };
  };
  el.querySelectorAll('[data-del-race]').forEach(b => b.onclick = async () => {
    await api(`/training/races/${b.dataset.delRace}`, { method: 'DELETE' });
    toast(t('season.removed'), 'success');
    renderPlan(el);
  });
  el.querySelectorAll('[data-plan-race]').forEach(b => b.onclick = () => {
    const [name, date] = b.dataset.planRace.split('|');
    renderCreate(el, null, season, { goalEvent: name, goalDate: date });
  });
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

function renderCreate(el, existing, season, prefill) {
  const u = state.user || {};
  const in12wk = new Date(Date.now() + 84 * 86400 * 1000).toISOString().slice(0, 10);
  const evVal = prefill?.goalEvent || u.goalTargetEvent || '';
  const dateVal = prefill?.goalDate || u.goalTargetDate || in12wk;
  el.innerHTML = `
    <header class="mb"><h1>${esc(t('plan.buildTitle'))}</h1>
      <p class="muted">${esc(t('plan.buildSub'))}</p></header>
    ${season ? seasonHtml(season) : ''}
    <div class="card">
      <label class="field"><span>${esc(t('plan.goalEvent'))}</span><input id="pEvent" value="${esc(evVal)}" placeholder="${esc(t('plan.goalEventPh'))}"></label>
      <div class="grid cols2">
        <label class="field"><span>${esc(t('plan.goalDate'))}</span><input id="pDate" type="date" value="${esc(dateVal)}"></label>
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
  wireSeason(el, season);
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
