// Adaptive periodization engine — the intelligence behind long-term training
// plans. Like trainingAnalysis.js, everything here is deterministic, explainable
// sports-science computation (no black box): a plan is reverse-periodized from
// the goal race date, and adaptation decisions are driven by the same analysis
// object the daily coach uses, each carrying an explicit reason.
//
// Model: classic rowing periodization. From the race backwards the athlete moves
// through Base → Aerobic Build → Threshold → Peak → Taper → Race, with an easy
// Transition/Recovery afterwards. Aerobic base dominates throughout (polarized
// early, more pyramidal as race work sharpens); volume ramps with a deload every
// fourth week and drops sharply into the taper.

export const PHASES = {
  transition: { label: 'Transition', blurb: 'Easy, unstructured aerobic work to refresh before the next block.', volumeFactor: 0.55, dist: { ut2: 85, ut1: 12, threshold: 3, vo2: 0, sprint: 0 } },
  base: { label: 'Aerobic Base', blurb: 'Build a big aerobic engine with high-volume low-intensity work.', volumeFactor: 1.0, dist: { ut2: 72, ut1: 20, threshold: 6, vo2: 1, sprint: 1 } },
  build: { label: 'Aerobic Build', blurb: 'Raise sustainable aerobic power; introduce steady threshold touches.', volumeFactor: 1.05, dist: { ut2: 60, ut1: 23, threshold: 12, vo2: 4, sprint: 1 } },
  threshold: { label: 'Threshold', blurb: 'Lift anaerobic threshold — the pace you can hold for a 2k.', volumeFactor: 0.95, dist: { ut2: 50, ut1: 20, threshold: 22, vo2: 6, sprint: 2 } },
  peak: { label: 'Peak / Sharpening', blurb: 'Race-pace and VO2 work to sharpen top-end speed. Volume eases.', volumeFactor: 0.8, dist: { ut2: 45, ut1: 15, threshold: 18, vo2: 15, sprint: 7 } },
  taper: { label: 'Taper', blurb: 'Cut volume, keep short race-pace touches — arrive fresh and fast.', volumeFactor: 0.5, dist: { ut2: 55, ut1: 15, threshold: 15, vo2: 10, sprint: 5 } },
  race: { label: 'Race Week', blurb: 'Minimal volume, a couple of sharp primers, then race.', volumeFactor: 0.4, dist: { ut2: 55, ut1: 15, threshold: 12, vo2: 12, sprint: 6 } },
  recovery: { label: 'Recovery', blurb: 'Deliberate easy week to absorb training and reduce fatigue.', volumeFactor: 0.55, dist: { ut2: 82, ut1: 13, threshold: 4, vo2: 1, sprint: 0 } },
};

export const PHASE_ORDER = ['transition', 'base', 'build', 'threshold', 'peak', 'taper', 'race'];

const ZONE_LABEL = { ut2: 'UT2 steady', ut1: 'UT1 aerobic', threshold: 'AT threshold', vo2: 'VO2max', sprint: 'Sprint/race-start' };
const DAY = 86400;
const round = (n) => Math.round(n);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isoDate = (s) => new Date(s * 1000).toISOString().slice(0, 10);

/**
 * Allocate `weeks` calendar weeks into periodization phase blocks, sized
 * proportionally to a canonical template and always ending on race week. Short
 * plans compress the early blocks; long plans expand Base most.
 */
export function allocatePhases(weeks) {
  const w = clamp(round(weeks), 4, 52);
  // Race + taper are near-fixed; the rest scale with the runway.
  const raceWk = 1;
  const taperWk = w >= 10 ? 2 : 1;
  const peakWk = clamp(Math.round(w * 0.14), 1, 3);
  const remaining = w - raceWk - taperWk - peakWk;
  // Split the remainder Base:Build:Threshold ≈ 45:30:25.
  let baseWk = Math.max(1, Math.round(remaining * 0.45));
  let buildWk = Math.max(1, Math.round(remaining * 0.30));
  let thresholdWk = Math.max(1, remaining - baseWk - buildWk);
  // Fix rounding drift so the blocks sum exactly to `w`.
  let sum = baseWk + buildWk + thresholdWk + peakWk + taperWk + raceWk;
  baseWk += w - sum;
  if (baseWk < 1) { buildWk += baseWk - 1; baseWk = 1; }

  const blocks = [];
  const push = (phase, n) => { for (let i = 0; i < n; i++) blocks.push(phase); };
  push('base', baseWk); push('build', buildWk); push('threshold', thresholdWk);
  push('peak', peakWk); push('taper', taperWk); push('race', raceWk);
  return blocks.slice(0, w);
}

/**
 * Prescribe the concrete sessions for one week from its phase, available days,
 * target weekly meters, and the athlete's 2k split (used to write pace targets).
 */
export function prescribeWeek(phase, { days, weeklyMeters, best2kSplitS, sessionMinutes }) {
  const p = PHASES[phase];
  const nDays = clamp(days || 4, 2, 7);
  // How many quality (non-UT2) sessions this phase wants.
  const hardShare = (p.dist.threshold + p.dist.vo2 + p.dist.sprint) / 100;
  let hard = clamp(Math.round(nDays * hardShare * 1.6), phase === 'base' ? 0 : 1, phase === 'peak' ? 3 : 2);
  if (phase === 'recovery' || phase === 'transition') hard = 0;
  const easy = nDays - hard;
  const perSessionM = Math.max(2000, Math.round(weeklyMeters / nDays / 500) * 500);
  const longM = Math.round((perSessionM * 1.4) / 500) * 500;
  const split = best2kSplitS || null;
  const pace = (deltaS, label) => (split ? `${fmtSplit(split + deltaS)}/500m (${label})` : label);

  const sessions = [];
  // Long aerobic row anchors every week (except taper/race keep it short).
  const longLen = (phase === 'taper' || phase === 'race') ? perSessionM : longM;
  sessions.push({ zone: 'ut2', structure: 'steady', prescription: `${(longLen / 1000).toFixed(1)}k steady @ ${pace(18, 'UT2, conversational')}`,
    why: 'Long low-intensity row develops aerobic capacity and fat metabolism with minimal fatigue cost.' });
  for (let i = 1; i < easy; i++) {
    sessions.push({ zone: i % 2 ? 'ut1' : 'ut2', structure: 'steady',
      prescription: `${(perSessionM / 1000).toFixed(1)}k @ ${pace(i % 2 ? 11 : 16, i % 2 ? 'UT1' : 'UT2')}`,
      why: i % 2 ? 'UT1 endurance raises sustainable aerobic power just below threshold.' : 'Extra UT2 volume reinforces the aerobic base.' });
  }
  const hardMenus = {
    build: [{ zone: 'threshold', structure: 'intervals', prescription: `4 × 1500m @ ${pace(6, 'AT')}, 3′ easy`, why: 'Threshold intervals lift the pace you can hold aerobically — the foundation of 2k speed.' }],
    threshold: [
      { zone: 'threshold', structure: 'intervals', prescription: `4 × 2000m @ ${pace(5, 'AT')}, 4′ easy`, why: 'Sustained threshold work pushes lactate threshold toward race pace.' },
      { zone: 'vo2', structure: 'intervals', prescription: `6 × 750m @ ${pace(1, 'just under 2k pace')}, 3′ easy`, why: 'VO2 intervals raise maximal oxygen uptake — your aerobic ceiling.' }],
    peak: [
      { zone: 'vo2', structure: 'intervals', prescription: `5 × 500m @ ${pace(-1, '2k pace')}, 3′ easy`, why: 'Race-pace repeats rehearse 2k rhythm and recruit fast-twitch fibres.' },
      { zone: 'sprint', structure: 'intervals', prescription: `8 × 250m @ ${pace(-3, 'faster than 2k')}, 2′ easy`, why: 'Short sprints sharpen neuromuscular power and the race start.' }],
    taper: [{ zone: 'vo2', structure: 'intervals', prescription: `3 × 500m @ ${pace(-1, '2k pace')}, full recovery`, why: 'A few sharp race-pace pieces keep speed primed while fatigue drops.' }],
    race: [{ zone: 'sprint', structure: 'intervals', prescription: `4 × 250m @ ${pace(-2, 'race pace')}, full recovery`, why: 'Short primers wake up the system without adding fatigue before racing.' }],
  };
  const menu = hardMenus[phase] || hardMenus.build;
  for (let i = 0; i < hard; i++) sessions.push(menu[i % menu.length]);

  return sessions.slice(0, nDays);
}

/**
 * Generate a full periodized plan. Deterministic and explainable.
 * @param {object} opts { startDateS, goalDateS, weeks?, best2kSeconds, goal2kSeconds,
 *                         targetWeeklyMeters, availableDays, sessionMinutes,
 *                         goalEvent, baselineWeeklyMeters }
 */
export function generatePlan(opts) {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const startS = opts.startDateS ?? nowS;
  let weeks = opts.weeks;
  if (!weeks && opts.goalDateS) weeks = Math.round((opts.goalDateS - startS) / (7 * DAY));
  weeks = clamp(weeks || 12, 4, 52);

  const best2kSplitS = opts.best2kSeconds ? opts.best2kSeconds / 4 : null;
  // Peak weekly volume: prefer an explicit target, else grow the athlete's
  // recent weekly load by ~30%, else a sensible default by experience.
  const baseline = opts.baselineWeeklyMeters || 0;
  const peakWeekly = clamp(
    opts.targetWeeklyMeters || (baseline ? Math.round(baseline * 1.3) : defaultWeekly(opts.availableDays)),
    8000, 200000);

  const blocks = allocatePhases(weeks);
  const days = clamp(opts.availableDays || 4, 2, 7);

  // Volume ramps from ~65% of peak up to peak by the end of the Threshold block,
  // with a deload (×0.7) every fourth week, then the taper factors take over.
  const lastBuildIdx = blocks.lastIndexOf('threshold');
  const weekList = blocks.map((phase, i) => {
    const p = PHASES[phase];
    const rampEnd = lastBuildIdx > 0 ? lastBuildIdx : weeks - 1;
    const ramp = 0.65 + 0.35 * clamp(i / Math.max(1, rampEnd), 0, 1);
    const deload = (i > 0 && (i + 1) % 4 === 0 && phase !== 'taper' && phase !== 'race') ? 0.7 : 1;
    const weeklyMeters = round((peakWeekly * ramp * p.volumeFactor * deload) / 500) * 500;
    const weekStartS = startS + i * 7 * DAY;
    const sessions = prescribeWeek(deload < 1 ? 'recovery' : phase, { days, weeklyMeters, best2kSplitS, sessionMinutes: opts.sessionMinutes });
    return {
      index: i,
      weekOf: isoDate(weekStartS),
      phase,
      phaseLabel: p.label,
      deload: deload < 1,
      focus: deload < 1 ? 'Deload week — absorb the last block; volume intentionally reduced.' : p.blurb,
      targetMeters: weeklyMeters,
      targetSessions: sessions.length,
      intensity: p.dist,
      sessions,
    };
  });

  return {
    totalWeeks: weeks,
    startDate: isoDate(startS),
    goalEvent: opts.goalEvent || null,
    goalDate: opts.goalDateS ? isoDate(opts.goalDateS) : null,
    goal2kSeconds: opts.goal2kSeconds || null,
    targetWeeklyMeters: peakWeekly,
    weeks: weekList,
    rationale: `Reverse-periodized ${weeks}-week plan from ${opts.goalEvent || 'your goal'}: `
      + `${blocks.filter(b => b === 'base').length}w base → ${blocks.filter(b => b === 'build').length}w build → `
      + `${blocks.filter(b => b === 'threshold').length}w threshold → ${blocks.filter(b => b === 'peak').length}w peak → taper. `
      + `Peak volume ~${(peakWeekly / 1000).toFixed(0)}k/week across ${days} days, deload every 4th week.`,
  };
}

function defaultWeekly(days) {
  const d = clamp(days || 4, 2, 7);
  return d * 8000; // ~8k per available day as a starting aerobic load
}

/** Which plan week index is "current" for a given time (clamped to the plan). */
export function currentWeekIndex(plan, nowS = Math.floor(Date.now() / 1000)) {
  const startS = Math.floor(new Date(`${plan.startDate}T00:00:00Z`).getTime() / 1000);
  return clamp(Math.floor((nowS - startS) / (7 * DAY)), 0, plan.totalWeeks - 1);
}

/**
 * Adapt a plan's upcoming weeks from the athlete's real training. Returns the
 * decisions taken (each with a scientific reason) and the mutated week list.
 * Never touches past weeks. This is what makes the plan "never static".
 */
export function adaptPlan(plan, analysis, nowS = Math.floor(Date.now() / 1000)) {
  const weeks = plan.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => ({ ...s })) }));
  const cur = currentWeekIndex(plan, nowS);
  const next = weeks[cur + 1] || weeks[cur];
  const decisions = [];
  if (!next) return { decisions, weeks };

  const scale = (week, factor, reason) => {
    if (!week || week.__scaled) return;
    week.targetMeters = round((week.targetMeters * factor) / 500) * 500;
    week.__scaled = true;
    week.adaptationNote = reason;
    decisions.push({ weekIndex: week.index, weekOf: week.weekOf, change: factor < 1 ? `reduced load ${Math.round((1 - factor) * 100)}%` : `increased load ${Math.round((factor - 1) * 100)}%`, reason });
  };
  const toRecovery = (week, reason) => {
    if (!week) return;
    week.phase = 'recovery'; week.phaseLabel = PHASES.recovery.label; week.deload = true;
    week.intensity = PHASES.recovery.dist;
    week.targetMeters = round((week.targetMeters * 0.6) / 500) * 500;
    week.sessions = prescribeWeek('recovery', { days: week.targetSessions, weeklyMeters: week.targetMeters });
    week.targetSessions = week.sessions.length;
    week.focus = 'Recovery week inserted by the adaptive coach.';
    week.adaptationNote = reason;
    decisions.push({ weekIndex: week.index, weekOf: week.weekOf, change: 'converted to recovery week', reason });
  };

  const f = analysis.flags || {};
  const c = analysis.constraints || {};
  const v = analysis.volume || {};
  const last7Sessions = v.last7d?.sessions ?? 0;

  // 1. Overtraining / high strain → forced recovery (health always wins).
  if (c.overtrainingRisk || (f.highDrift && f.hardStacking)) {
    toRecovery(next, 'Fatigue and cardiovascular-strain signals (HR drift + stacked hard sessions) indicate accumulated fatigue; a recovery week now protects adaptation and reduces injury/illness risk.');
  } else if (f.rampTooFast) {
    // 2. Load ramping faster than the body is adapting → hold it back.
    scale(next, 0.85, `Your recent load jumped well above your 4-week average (acute:chronic ≈ ${v.acuteChronicRatio}); easing next week keeps the ramp in the safe zone (~10–15%/week).`);
  } else if (f.returningFromBreak) {
    // 3. Coming back from time off → rebuild gradually.
    scale(next, 0.75, `You've had ${analysis.recovery?.daysSinceLastWorkout} days off; rebuilding volume gradually re-establishes consistency without overreaching.`);
  } else if (last7Sessions < Math.max(2, Math.round(next.targetSessions * 0.6))) {
    // 4. Behind on sessions → scale back so the plan stays achievable.
    scale(next, 0.85, `Only ${last7Sessions} session(s) logged in the last 7 days versus ${next.targetSessions} planned; trimming next week's target keeps the plan realistic and rebuilds momentum.`);
  } else if ((analysis.paceProgression?.trend === 'improving' || analysis.heartRate?.aerobicEfficiencyTrend === 'improving')
    && (v.acuteChronicRatio == null || v.acuteChronicRatio < 1.3) && !f.monotonous) {
    // 5. Fitness rising and load healthy → progress.
    scale(next, 1.08, 'Steady-state pace and/or aerobic efficiency are improving while your load is well-managed — a small progression capitalises on rising fitness.');
  }

  // 6. Chronic monotony → nudge variety regardless of the above.
  if (f.monotonous && !next.__scaled) {
    decisions.push({ weekIndex: next.index, weekOf: next.weekOf, change: 'added intensity variety', reason: `Your recent training is very single-zone; next week keeps the ${next.phaseLabel} mix but ensure the prescribed threshold/VO2 sessions are done to avoid a training plateau.` });
  }

  weeks.forEach(w => { delete w.__scaled; });
  return { decisions, weeks };
}

/* ------------------------------------------------------------------ */
/* Weekly & monthly reviews (deterministic, explainable)               */
/* ------------------------------------------------------------------ */

export function weeklyReview(analysis, plan, nowS = Math.floor(Date.now() / 1000)) {
  const v = analysis.volume || {};
  const last7 = v.last7d || { sessions: 0, meters: 0, minutes: 0 };
  const week = plan ? plan.weeks[currentWeekIndex(plan, nowS)] : null;
  const targetMeters = week?.targetMeters ?? analysis.athlete?.goal?.weeklyMinutes ?? null;
  const volumeVsTarget = week?.targetMeters ? Math.round((last7.meters / week.targetMeters) * 100) : null;

  const strengths = [], weaknesses = [], focus = [];
  if (last7.sessions >= (week?.targetSessions || 4)) strengths.push(`Hit ${last7.sessions} sessions — strong consistency.`);
  else weaknesses.push(`${last7.sessions} session(s) this week${week ? ` vs ${week.targetSessions} planned` : ''} — consistency is the biggest lever on progress.`);

  if (analysis.paceProgression?.trend === 'improving') strengths.push('Steady-state pace is trending faster at the same effort.');
  else if (analysis.paceProgression?.trend === 'declining') weaknesses.push('Steady-state pace has slipped — could be fatigue or reduced volume.');

  if (analysis.heartRate?.aerobicEfficiencyTrend === 'improving') strengths.push('Aerobic efficiency (pace per heartbeat) is improving — your engine is getting fitter.');
  if (analysis.heartRate?.driftTrend === 'worsening') weaknesses.push('Heart-rate drift is rising within sessions — a sign of accumulating fatigue or heat/hydration stress.');

  const dist = analysis.distribution28d || {};
  if ((dist.aerobicPct ?? 0) < 70 && (dist.zonePct && Object.values(dist.zonePct).some(Boolean))) {
    weaknesses.push(`Only ${dist.aerobicPct}% of recent work was low-intensity — most athletes progress fastest around 75–85% aerobic.`);
    focus.push('Add an easy UT2 row to rebalance toward aerobic base.');
  }
  if (dist.missingZones?.length) focus.push(`Recently missing: ${dist.missingZones.join(', ')} — the plan reintroduces these.`);
  if (week) focus.push(`This week is ${week.phaseLabel}: ${week.focus}`);
  if (analysis.constraints?.overtrainingRisk) { weaknesses.push('Fatigue markers are elevated.'); focus.push('Prioritise sleep and an easy day before the next hard session.'); }

  const fitness = analysis.paceProgression?.trend === 'improving' || analysis.heartRate?.aerobicEfficiencyTrend === 'improving'
    ? 'improving' : analysis.paceProgression?.trend === 'declining' ? 'declining' : 'holding steady';

  return {
    weekOf: week?.weekOf || isoDate(nowS),
    phase: week?.phaseLabel || null,
    volume: { meters: last7.meters, minutes: last7.minutes, sessions: last7.sessions, targetMeters, volumeVsTargetPct: volumeVsTarget },
    estimatedFitness: fitness,
    strengths, weaknesses, focusNextWeek: focus,
    summary: `You completed ${last7.sessions} session(s) for ${(last7.meters / 1000).toFixed(1)}k`
      + `${volumeVsTarget != null ? ` (${volumeVsTarget}% of the ${(week.targetMeters / 1000).toFixed(0)}k target)` : ''}. `
      + `Fitness looks to be ${fitness}. ${focus[0] || 'Keep the aerobic base rolling.'}`,
  };
}

export function monthlyReview(analysis, nowS = Math.floor(Date.now() / 1000)) {
  const v = analysis.volume || {};
  const cur = v.last28d || { sessions: 0, meters: 0, minutes: 0 };
  const prev = v.prev28d || { sessions: 0, meters: 0, minutes: 0 };
  const delta = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const dist = analysis.distribution28d || {};
  const improvements = [], stagnation = [], recommendations = [];

  const volDelta = delta(cur.meters, prev.meters);
  if (volDelta != null && volDelta >= 8) improvements.push(`Training volume up ${volDelta}% vs the previous month.`);
  else if (volDelta != null && volDelta <= -8) stagnation.push(`Volume down ${Math.abs(volDelta)}% vs the previous month.`);

  if (analysis.heartRate?.aerobicEfficiencyTrend === 'improving') improvements.push('Aerobic development: pace-per-heartbeat improved — a clear sign of a growing aerobic base.');
  else if (analysis.heartRate?.aerobicEfficiencyTrend === 'declining') stagnation.push('Aerobic efficiency dipped this month.');

  if (analysis.paceProgression?.trend === 'improving') improvements.push('Steady-state pace improved at the same effort.');
  else if (analysis.paceProgression?.trend === 'stable') stagnation.push('Steady-state pace held flat — a progression stimulus (more volume or threshold work) may be due.');

  const anaerobic = dist.anaerobicPct ?? 0;
  if (anaerobic < 10) recommendations.push('Add a weekly threshold or VO2 session to develop anaerobic power alongside the aerobic base.');
  if ((dist.aerobicPct ?? 0) < 70) recommendations.push('Shift the balance toward more low-intensity volume (~80/20 easy/hard).');
  if (cur.sessions < 8) recommendations.push('Aim for at least 2–3 sessions per week for consistent adaptation.');
  if (!recommendations.length) recommendations.push('Balance looks good — keep progressing volume gradually and protect recovery.');

  return {
    period: '28 days',
    volume: { current: cur, previous: prev, changePct: volDelta },
    consistency: { sessions: cur.sessions, sessionsPrev: prev.sessions },
    aerobicDevelopment: analysis.heartRate?.aerobicEfficiencyTrend || 'insufficient_data',
    anaerobicDevelopment: anaerobic >= 15 ? 'well-developed' : anaerobic >= 8 ? 'developing' : 'underdeveloped',
    prs: analysis.prs || {},
    biggestImprovements: improvements,
    stagnated: stagnation,
    recommendations,
    summary: `Over the last 28 days: ${cur.sessions} sessions, ${(cur.meters / 1000).toFixed(0)}k`
      + `${volDelta != null ? ` (${volDelta >= 0 ? '+' : ''}${volDelta}% vs prior month)` : ''}. `
      + `${improvements[0] || stagnation[0] || 'Steady month.'} ${recommendations[0]}`,
  };
}

/** Infer the athlete's current macro-phase from days-to-race when no plan exists. */
export function inferPhaseFromRace(daysToEvent) {
  if (daysToEvent == null) return null;
  const w = daysToEvent / 7;
  if (w <= 1) return 'race';
  if (w <= 2) return 'taper';
  if (w <= 5) return 'peak';
  if (w <= 9) return 'threshold';
  if (w <= 16) return 'build';
  return 'base';
}

/* ------------------------------------------------------------------ */

function fmtSplit(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(0).padStart(2, '0')}`;
}
