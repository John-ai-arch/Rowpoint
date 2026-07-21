// Personal Progress & Achievements hub. Surfaces the existing gamification
// data (totals, streaks, PRs, badges, consistency) from /api/me/progress in a
// premium, motivating layout. Goals reuse the user's existing weekly goal
// fields via the standard /users/me PATCH — no new subsystem.
import { api, state, toast, esc, fmtDistance, fmtSplit, fmtDuration, fmtDate } from '../api.js';
import { t } from '../i18n.js';
import { icon, badgeIcon } from '../icons.js';
import { drawTrend } from '../components/charts.js';

export async function renderProgress(el) {
  el.innerHTML = skeleton();
  let data, perf = null;
  try {
    const [p, s] = await Promise.all([
      api('/me/progress'),
      api('/performance/summary').catch(() => null), // additive; never blocks the page
    ]);
    data = p.progress; perf = s;
  } catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }

  if (!data.totals.workouts) {
    el.innerHTML = `
      <header class="mb"><h1>${esc(t('progress.title'))}</h1></header>
      <div class="card"><div class="empty">
        <div class="center" style="margin-bottom:14px"><span class="icon-chip lg">${icon('oar')}</span></div>
        <h3>${esc(t('progress.empty'))}</h3>
        <a class="btn mt" href="#/row">${icon('oar', { size: 17 })} ${esc(t('progress.startRowing'))}</a>
      </div></div>`;
    return;
  }

  const g = data.goals;
  const weekMeters = data.week.meters;
  const goalMeters = Math.max(g.weeklyMeters || 0, 1);
  const goalPct = Math.min(100, Math.round((weekMeters / goalMeters) * 100));
  const remaining = Math.max(0, goalMeters - weekMeters);

  el.innerHTML = `
    <div class="page-head">
      <h1>${esc(t('progress.title'))}</h1>
      <p class="muted">${esc(t('progress.subtitle'))}</p>
    </div>

    ${insightHtml(data, remaining, goalPct)}

    ${analyticsHub()}

    ${communityChip(data.population)}

    ${perf ? perfHtml(perf) : ''}

    ${livingGoalsHtml(data.goalsLiving)}

    <div class="grid cols2">
      <div class="card">
        <div class="card-head"><span class="icon-chip sm">${icon('target', { size: 18 })}</span><h3>${esc(t('progress.weeklyGoal'))}</h3></div>
        <div class="row" style="justify-content:center;gap:22px;flex-wrap:wrap">
          ${ringHtml(goalPct, fmtDistance(weekMeters), t('progress.ofGoal'))}
          <div style="min-width:150px">
            <div class="stat-tile tight mb"><div class="n">${fmtDistance(weekMeters)}</div><div class="l">${esc(t('progress.thisWeek'))}</div></div>
            <div class="pbar ${goalPct >= 100 ? 'good' : ''}"><i style="width:${goalPct}%"></i></div>
            <p class="muted small mt">${goalPct >= 100 ? esc(t('progress.goalReached')) : esc(t('progress.keepGoing', { remaining: fmtDistance(remaining) }))}</p>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon-chip sm gold">${icon('flame', { size: 18 })}</span><h3>${esc(t('progress.currentStreak'))}</h3></div>
        <div class="streak-hero">
          <span class="icon-chip lg gold">${icon('flame', { size: 26 })}</span>
          <div>
            <div class="stat-tile tight" style="text-align:left;background:none;border:none;padding:0">
              <div class="n">${data.streak.current}</div>
              <div class="l">${esc(t('progress.dayStreak'))}</div>
            </div>
            <p class="muted small">${esc(t('progress.longestStreak'))}: <strong>${esc(t('progress.day', { count: data.streak.longest }))}</strong></p>
          </div>
        </div>
      </div>
    </div>

    <div class="grid cols3">
      <div class="stat-tile"><div class="n">${fmtDistance(data.totals.meters)}</div><div class="l">${esc(t('progress.totalMeters'))}</div></div>
      <div class="stat-tile"><div class="n">${data.totals.workouts}</div><div class="l">${esc(t('progress.totalWorkouts'))}</div></div>
      <div class="stat-tile"><div class="n">${data.totals.hours}</div><div class="l">${esc(t('progress.totalHours'))}</div></div>
      <div class="stat-tile"><div class="n">${fmtDistance(data.month.meters)}</div><div class="l">${esc(t('progress.thisMonth'))}</div></div>
      <div class="stat-tile"><div class="n">${data.week.workouts}</div><div class="l">${esc(t('progress.thisWeek'))} · ${esc(t('common.workouts', { count: data.week.workouts }))}</div></div>
      <div class="stat-tile"><div class="n">${data.improvement.hadPriorWeek ? (data.improvement.metersDelta >= 0 ? '+' : '') + fmtDistance(data.improvement.metersDelta) : '—'}</div><div class="l">${esc(t('progress.vsLastWeek'))}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><span class="icon-chip sm gold">${icon('trophy', { size: 18 })}</span><h3>${esc(t('progress.records'))}</h3></div>
      <div class="grid cols3">
        ${prCard(t('progress.best2k'), data.records.best2k && fmtDuration(data.records.best2k.timeS), data.records.best2k && fmtDate(data.records.best2k.at))}
        ${prCard(t('progress.best5k'), data.records.best5k && fmtDuration(data.records.best5k.timeS), data.records.best5k && fmtDate(data.records.best5k.at))}
        ${prCard(t('progress.best6k'), data.records.best6k && fmtDuration(data.records.best6k.timeS), data.records.best6k && fmtDate(data.records.best6k.at))}
        ${prCard(t('progress.fastestSplit'), data.records.fastestSplit && fmtSplit(data.records.fastestSplit.split) + '/500m', data.records.fastestSplit && fmtDate(data.records.fastestSplit.at))}
        ${prCard(t('progress.longestPiece'), data.records.longestPiece && fmtDistance(data.records.longestPiece.meters), data.records.longestPiece && fmtDate(data.records.longestPiece.at))}
        ${prCard(t('progress.best500'), data.records.best500 && fmtDuration(data.records.best500.timeS), data.records.best500 && fmtDate(data.records.best500.at))}
      </div>
      <details class="mt">
        <summary class="small muted" style="cursor:pointer">${esc(t('progress.moreRecords'))}</summary>
        <div class="grid cols3 mt">
          ${prCard(t('progress.highestWatts'), data.records.highestWatts && `${data.records.highestWatts.watts} W`, data.records.highestWatts && fmtDate(data.records.highestWatts.at))}
          ${prCard(t('progress.highestRate'), data.records.highestStrokeRate && `${data.records.highestStrokeRate.spm} spm`, data.records.highestStrokeRate && fmtDate(data.records.highestStrokeRate.at))}
          ${prCard(t('progress.biggestWeek'), data.records.biggestWeekMeters && fmtDistance(data.records.biggestWeekMeters))}
          ${prCard(t('progress.biggestMonth'), data.records.biggestMonthMeters && fmtDistance(data.records.biggestMonthMeters))}
          ${prCard(t('progress.longestStreak'), data.records.longestStreakDays ? t('progress.nDays', { n: data.records.longestStreakDays, count: data.records.longestStreakDays }) : null)}
        </div>
      </details>
    </div>

    ${achievementsCard(data)}

    <div class="card">
      <h3>${esc(t('progress.consistency'))}</h3>
      <div class="cal" role="img" aria-label="${esc(t('progress.consistency'))}">
        ${data.calendar.map(d => `<div class="d ${calLevel(d.meters)}" title="${d.date}: ${fmtDistance(d.meters)}"></div>`).join('')}
      </div>
      <p class="muted small mt">${esc(t('progress.consistencyHint'))}</p>
    </div>

    ${data.trend.length >= 2 ? `<div class="card"><h3>${esc(t('progress.trend'))}</h3><canvas class="chart" id="progTrend" height="160"></canvas></div>` : ''}

    <div class="card">
      <div class="row between"><h3>${esc(t('progress.goals'))}</h3><button class="ghost sm" id="editGoals">${esc(t('progress.editGoals'))}</button></div>
      <div id="goalBody">
        <div class="mb"><div class="row between"><span class="muted small">${esc(t('progress.weeklyDistance'))}</span><span class="small">${fmtDistance(weekMeters)} / ${fmtDistance(goalMeters)}</span></div>
          <div class="pbar ${goalPct >= 100 ? 'good' : ''}"><i style="width:${goalPct}%"></i></div></div>
        ${g.weeklySessions ? `<div><div class="row between"><span class="muted small">${esc(t('progress.weeklySessions'))}</span><span class="small">${data.week.workouts} / ${g.weeklySessions}</span></div>
          <div class="pbar ${data.week.workouts >= g.weeklySessions ? 'good' : ''}"><i style="width:${Math.min(100, Math.round(data.week.workouts / g.weeklySessions * 100))}%"></i></div></div>` : ''}
      </div>
    </div>`;

  // improvement chart
  if (data.trend.length >= 2) {
    const canvas = el.querySelector('#progTrend');
    if (canvas) {
      const max = Math.max(...data.trend.map(p => p.meters)) * 1.15 || 1000;
      drawTrend(canvas, [{ label: t('progress.trend'), color: '#38bdf8', points: data.trend.map(p => ({ y: p.meters })), max }]);
    }
  }

  // goal editor
  el.querySelector('#editGoals').onclick = () => {
    const box = el.querySelector('#goalBody');
    box.innerHTML = `
      <label class="field"><span>${esc(t('progress.weeklyDistance'))} (m)</span><input id="gMeters" type="number" min="0" max="2000000" value="${g.weeklyMeters || ''}"></label>
      <label class="field"><span>${esc(t('progress.weeklySessions'))}</span><input id="gSessions" type="number" min="0" max="28" value="${g.weeklySessions || ''}"></label>
      <button class="sm" id="saveGoals">${esc(t('common.save'))}</button>`;
    box.querySelector('#saveGoals').onclick = async () => {
      try {
        const { user } = await api('/users/me', { method: 'PATCH', body: {
          goalWeeklyMeters: Number(box.querySelector('#gMeters').value) || 0,
          goalWeeklySessions: Number(box.querySelector('#gSessions').value) || 0,
        } });
        state.user = user;
        toast(t('progress.goalsSaved'), 'success');
        renderProgress(el);
      } catch (e) { toast(e.message, 'error'); }
    };
  };
}

/* ---------------- helpers ---------------- */

/* Achievements — earned badges stay in view (they motivate); the still-locked
   ones fold into a details so the grid isn't a wall of greyed-out lockboxes. */
function achievementsCard(data) {
  const badge = (b) => `
    <div class="ach ${b.unlocked ? 'unlocked' : 'locked'}" title="${b.unlocked ? esc(fmtDate(b.achievedAt)) : esc(t('achievements.locked'))}">
      <span class="ic" aria-hidden="true">${b.unlocked ? icon(badgeIcon(b.badge), { size: 30 }) : icon('lock', { size: 28 })}</span>
      <div class="nm">${esc(t('achievements.' + b.badge))}</div>
      ${b.unlocked ? `<div class="dt">${esc(fmtDate(b.achievedAt))}</div>` : ''}
    </div>`;
  const unlocked = data.badges.filter(b => b.unlocked);
  const locked = data.badges.filter(b => !b.unlocked);
  return `<div class="card">
    <div class="card-head"><span class="icon-chip sm">${icon('medal', { size: 18 })}</span><h3>${esc(t('progress.achievements'))}</h3>
      <span class="badge blue card-head-action">${esc(t('progress.achievementsUnlocked', { n: data.badgeCount.unlocked, total: data.badgeCount.total }))}</span></div>
    ${unlocked.length
    ? `<div class="ach-grid mt">${unlocked.map(badge).join('')}</div>`
    : `<p class="muted small mt">${esc(t('dash.noAchievements'))}</p>`}
    ${locked.length ? `<details class="mt">
      <summary class="small muted" style="cursor:pointer">${esc(t('progress.showLocked', { n: locked.length }))}</summary>
      <div class="ach-grid mt">${locked.map(badge).join('')}</div>
    </details>` : ''}
  </div>`;
}

/* The analytics hub — replaces the old wall of eight equal buttons with the
   same eight tools (plus the previously-buried Benchmark explorer) grouped
   into labelled sections, each row a calm tappable list-item. Progressive
   disclosure: deeper analysis is here when the athlete wants it, not shouted. */
function analyticsHub() {
  const link = (href, iconName, label) => `
    <a class="list-item" href="${href}" style="color:inherit">
      <span class="li-icon accent">${icon(iconName, { size: 20 })}</span>
      <div class="li-body"><strong>${esc(label)}</strong></div>
      <span class="li-go">${icon('chevron-right', { size: 18 })}</span>
    </a>`;
  const group = (label, rows) => `<p class="eyebrow" style="margin:16px 2px 4px">${esc(label)}</p>${rows}`;
  return `
    <div class="section-head">
      <span class="icon-chip">${icon('activity')}</span>
      <div class="titles"><h2>${esc(t('explore.title'))}</h2><div class="section-sub">${esc(t('explore.sub'))}</div></div>
    </div>
    <div class="card stagger">
      ${group(t('explore.planning'), link('#/plan', 'calendar', t('plan.open')))}
      ${group(t('explore.lab'),
    link('#/lab', 'lightbulb', t('lab.open'))
    + link('#/athlete', 'user', t('twin.open'))
    + link('#/optimizer', 'target', t('opt.open'))
    + link('#/stroke', 'eye', t('stroke.open')))}
      ${group(t('explore.racing'),
    link('#/racelab', 'flag', t('race.open'))
    + link('#/benchmark', 'medal', t('bench.open')))}
      ${group(t('explore.community'),
    link('#/observatory', 'globe', t('obs.open'))
    + link('#/timeline', 'progress', t('timeline.open')))}
    </div>`;
}

function ringHtml(pct, valueText, unitText) {
  const r = 56, c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(100, pct) / 100);
  return `<div class="ring celebrate">
    <svg viewBox="0 0 132 132" aria-hidden="true">
      <circle class="track" cx="66" cy="66" r="${r}" stroke-width="12"></circle>
      <circle class="bar" cx="66" cy="66" r="${r}" stroke-width="12" stroke="url(#ringgrad)"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
      <defs><linearGradient id="ringgrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#0d9488"/>
      </linearGradient></defs>
    </svg>
    <div class="ring-label"><div class="v">${pct}%</div><div class="u">${esc(unitText)}</div></div>
  </div>`;
}

/* Performance intelligence: readiness ring + race predictions (both explained). */
function perfHtml(perf) {
  const rd = perf.readiness, pr = perf.predictions;
  const bandColor = { ready: 'var(--good)', moderate: 'var(--warn)', caution: 'var(--bad)' }[rd.band] || 'var(--accent)';
  return `<div class="grid cols2">
    <div class="card">
      <h3>${esc(t('perf.readiness'))}</h3>
      <div class="row" style="align-items:center;gap:16px;flex-wrap:wrap">
        ${readinessRing(rd.score, bandColor)}
        <div style="flex:1;min-width:150px">
          <p style="margin:0 0 4px"><strong style="color:${bandColor};font-size:1.05rem">${esc(t('perf.band_' + rd.band))}</strong></p>
          <p class="muted small" style="margin:0">${esc(rd.headline)}</p>
        </div>
      </div>
      <div class="mt">
        ${rd.factors.slice(0, 4).map(f => `<div class="small" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid var(--bg2)">
          <span>${esc(f.label)}</span><span style="color:${f.impact >= 0 ? 'var(--good)' : 'var(--bad)'}">${f.impact >= 0 ? '+' : ''}${f.impact}</span></div>`).join('')}
      </div>
      <p class="muted" style="font-size:.68rem;margin-top:8px">${esc(rd.disclaimer)}</p>
    </div>
    <div class="card">
      <h3>${esc(t('perf.predictions'))}</h3>
      ${pr.available ? `
        <table><thead><tr><th>${esc(t('perf.distance'))}</th><th>${esc(t('perf.predicted'))}</th><th>/500m</th><th class="small">${esc(t('perf.range'))}</th></tr></thead><tbody>
        ${pr.predictions.map(p => `<tr><td><strong>${esc(p.label)}</strong></td><td>${esc(p.time)}</td><td class="muted">${esc(p.split)}</td><td class="small muted">${esc(p.range)}</td></tr>`).join('')}
        </tbody></table>
        <p class="small mt"><span class="badge ${pr.confidence === 'high' ? 'good' : pr.confidence === 'low' ? '' : 'amber'}">${esc(t('perf.conf_' + pr.confidence))} · ${pr.confidencePct}%</span></p>
        <details><summary class="small muted">${esc(t('perf.howCalculated'))}</summary>
          <p class="small muted">${esc(t('perf.basedOn'))}: ${pr.basis.map(esc).join('; ')}.<br>${esc(pr.method)}</p></details>
        <p class="muted" style="font-size:.68rem">${esc(pr.disclaimer)}</p>`
    : `<div class="empty"><div class="center" style="margin-bottom:10px"><span class="icon-chip plain">${icon('activity')}</span></div><p class="muted small">${esc(pr.reason)}</p></div>`}
    </div>
  </div>`;
}

/* Cross-system: celebrate where the athlete stands in the anonymous population. */
function communityChip(pop) {
  if (!pop || !pop.available || pop.weeklyMetersPct == null) return '';
  const pct = pop.weeklyMetersPct;
  const msg = pct >= 50
    ? t('progress.communityTop', { pct: Math.max(1, 100 - pct) })
    : t('progress.communityAhead', { pct });
  return `<a href="#/observatory" class="notice" style="display:flex;align-items:center;gap:10px;text-decoration:none;margin-bottom:14px">
    <span style="color:var(--accent2);flex:none">${icon('globe', { size: 20 })}</span><span>${esc(msg)} <span class="muted small">${esc(t('progress.communityCta'))}</span></span></a>`;
}

/* Living goals: each shows progress, a projected outcome, and an ETA. */
function livingGoalsHtml(g) {
  if (!g) return '';
  const w = g.weekly, m = g.lifetimeMilestone, k = g.best2k;
  const bar = (pct) => `<div class="pbar" style="margin:8px 0"><span style="width:${Math.min(100, pct || 0)}%"></span></div>`;
  const block = (inner) => `<div style="padding:12px;background:var(--bg2);border-radius:12px">${inner}</div>`;
  const milestoneLabel = m.target / 1000000 >= 1 ? `${m.target / 1000000}M` : `${m.target / 1000}k`;
  let cards = block(`<div class="row" style="justify-content:space-between;align-items:center"><strong class="small">${esc(t('goals.weekly'))}</strong>
    ${w.onTrack === null ? '' : `<span class="badge ${w.onTrack ? 'good' : 'amber'}">${w.onTrack ? esc(t('goals.onTrack')) : esc(t('goals.behind'))}</span>`}</div>
    ${bar(w.pct)}<div class="small muted">${fmtDistance(w.current)} / ${fmtDistance(w.target)} · ${esc(t('goals.projected'))} ${fmtDistance(w.projectedEndOfWeek)}</div>`);
  cards += block(`<div class="row" style="justify-content:space-between;align-items:center"><strong class="small">${esc(t('goals.nextMilestone'))}</strong><span class="badge">${milestoneLabel} m</span></div>
    ${bar(m.pct)}<div class="small muted">${fmtDistance(m.toGo)} ${esc(t('goals.toGo'))}${m.etaWeeks ? ` · ${esc(t('goals.eta', { n: m.etaWeeks }))}` : ''}</div>`);
  if (k.target) cards += block(`<div class="row" style="justify-content:space-between;align-items:center"><strong class="small">${esc(t('goals.goal2k'))}</strong>
    ${k.achieved ? `<span class="badge good">${esc(t('goals.achieved'))}</span>` : ''}</div>
    <div class="small muted" style="margin-top:10px">${k.current ? fmtSplit(k.current / 4) : '–'} → <strong>${fmtSplit(k.target / 4)}</strong> /500m</div>`);
  return `<div class="card"><h3>${esc(t('goals.title'))}</h3><div class="grid cols3" style="gap:10px">${cards}</div></div>`;
}

function readinessRing(score, color) {
  const r = 56, c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(100, score) / 100);
  return `<div class="ring">
    <svg viewBox="0 0 132 132" aria-hidden="true">
      <circle class="track" cx="66" cy="66" r="${r}" stroke-width="12"></circle>
      <circle class="bar" cx="66" cy="66" r="${r}" stroke-width="12" stroke="${color}"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
    </svg>
    <div class="ring-label"><div class="v">${score}</div><div class="u">/100</div></div>
  </div>`;
}

function prCard(label, value, date) {
  return `<div class="stat-tile" style="text-align:left">
    <div class="l" style="letter-spacing:.4px">${esc(label)}</div>
    <div class="n" style="font-size:1.35rem;color:${value ? 'var(--text)' : 'var(--faint)'}">${value ? esc(value) : esc(t('progress.noRecord'))}</div>
    ${date ? `<div class="muted small">${esc(date)}</div>` : ''}
  </div>`;
}

function calLevel(meters) {
  if (!meters) return '';
  if (meters < 3000) return 'l1';
  if (meters < 7000) return 'l2';
  if (meters < 12000) return 'l3';
  return 'l4';
}

function insightHtml(data, remaining, goalPct) {
  let msg;
  if (goalPct >= 100) msg = t('progress.goalReached');
  else if (data.streak.current >= 2) msg = t('progress.streakAlive', { n: data.streak.current });
  else if (data.week.workouts === 1) msg = t('progress.firstOfWeek');
  else msg = t('progress.keepGoing', { remaining: fmtDistance(remaining) });
  return `<div class="card ai-card"><span class="ai-tag">${icon('sparkle', { size: 13 })} ${esc(t('progress.insight'))}</span>
    <p style="margin:6px 0 0;font-size:1.05rem">${esc(msg)}</p></div>`;
}

function skeleton() {
  return `<header class="mb"><h1>${esc(t('progress.title'))}</h1></header>
    <div class="grid cols2">
      <div class="card skeleton" style="height:170px"></div>
      <div class="card skeleton" style="height:170px"></div>
    </div>
    <div class="grid cols3">${'<div class="stat-tile skeleton" style="height:74px"></div>'.repeat(6)}</div>`;
}
