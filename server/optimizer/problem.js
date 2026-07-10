// Problem assembly: one athlete + one run config → the optimization problem
// (athlete simulator params, seed plans, constraints, evaluator, race index).
//
// Twin state arrives through the 'twin.state-access' kernel contract; the
// training analysis through the shared analysis engine; coach assignments
// from the operational schedule. Every number the optimizer reasons with is
// gathered HERE, so a run's inputs are one inspectable object.
import { db } from '../db.js';
import { safeJson, todayStr } from '../util.js';
import { providersOf } from '../kernel/providers.js';
import { buildTrainingAnalysis } from '../ai/trainingAnalysis.js';
import { seedPlans } from './planSpace.js';
import { defaultConstraints } from './constraints.js';
import { simulatePlan } from './simulate.js';
import { scorePlan } from './objectives.js';

export const PROBLEM_VERSION = 'optimizer.problem@1.0';

function twinState(userId) {
  const provider = providersOf('twin.state-access')[0];
  return provider ? provider.getState(userId) : {};
}

const stateVal = (state, cat, v, fallback = null) => {
  const x = state?.[cat]?.[v]?.value;
  return Number.isFinite(x) ? x : fallback;
};

/**
 * @param {object} user   full user row
 * @param {object} config { horizonDays, raceDate, objectiveWeights,
 *                          constraintOverrides }
 */
export function buildProblem(user, config = {}, nowS = Math.floor(Date.now() / 1000)) {
  const horizonDays = Math.min(Math.max(Number(config.horizonDays) || 28, 7), 112);
  const analysis = buildTrainingAnalysis(user, nowS);
  const state = twinState(user.id);

  /* ---- athlete simulator parameters (provenance: twin + analysis) ---- */
  const weeklyMinutes = analysis.volume?.weeklyAvgMinutes28d || 0;
  const provider = providersOf('twin.state-access')[0];
  const chronicWeeklyLoad = provider?.getChronicWeeklyLoad?.(user.id)
    // Fallback: minutes at an assumed aerobic IF 0.7 when features are absent.
    || Math.max(30, (weeklyMinutes / 60) * 0.49 * 100);
  const athlete = {
    chronicWeeklyLoad: Math.round(chronicWeeklyLoad),
    recoveryHalfLifeH: stateVal(state, 'recovery', 'recoveryHalfLifeH', 24),
    adherenceBase: analysis.compliance?.followRatePct != null
      ? Math.min(Math.max(analysis.compliance.followRatePct / 100, 0.4), 0.98)
      : 0.85,
    sessionsPerWeek: stateVal(state, 'consistency', 'sessionsPerWeek', Math.max(2, (analysis.volume?.last28d?.sessions || 8) / 4)),
    typicalSessionMinutes: analysis.volume?.last28d?.sessions
      ? Math.round((analysis.volume.last28d.minutes || 0) / analysis.volume.last28d.sessions) || 45
      : 45,
  };

  /* ---- race day within the horizon? ---- */
  let raceDayIndex = null;
  const raceDate = config.raceDate || user.goal_target_date || null;
  if (raceDate) {
    const days = Math.round((new Date(`${raceDate}T00:00:00Z`).getTime() / 1000 - nowS) / 86400);
    if (days >= 3 && days < horizonDays) raceDayIndex = days;
  }

  /* ---- coach assignments become fixed days ---- */
  const fixedDays = {};
  const today = todayStr(nowS * 1000);
  const assignments = db.prepare(
    `SELECT a.scheduled_date, p.plan_json FROM assignments a
     JOIN team_members m ON m.team_id = a.team_id AND m.user_id = ?
     JOIN workout_plans p ON p.id = a.plan_id
     WHERE a.scheduled_date >= ? ORDER BY a.scheduled_date LIMIT 40`).all(user.id, today);
  for (const a of assignments) {
    const dayIndex = Math.round((new Date(`${a.scheduled_date}T00:00:00Z`).getTime() / 1000 - nowS) / 86400);
    if (dayIndex < 0 || dayIndex >= horizonDays) continue;
    const plan = safeJson(a.plan_json, {});
    // Coarse mapping (documented approximation): interval prescriptions are
    // quality work; steady time/distance is aerobic volume.
    const minutes = plan.type === 'time' ? Math.round((plan.durationS || 2700) / 60)
      : plan.type === 'distance' ? Math.max(30, Math.round((plan.distanceM || 8000) / 250))
        : 45;
    fixedDays[dayIndex] = { type: plan.type === 'intervals' ? 'threshold' : 'ut2', minutes: Math.min(minutes, 120) };
  }

  const constraints = {
    ...defaultConstraints({
      weeklyMinutesRecent: weeklyMinutes,
      chronicWeeklyLoad: athlete.chronicWeeklyLoad,
      fixedDays,
      raceDayIndex,
    }),
    ...(config.constraintOverrides || {}),
    fixedDays,
    raceDayIndex,
  };

  /* ---- the athlete's demonstrated weekly pattern as a seed ---- */
  const zoneMin = analysis.distribution28d?.zoneMinutes || {};
  const recentWeekPattern = buildRecentPattern(zoneMin, athlete);

  const seeds = seedPlans({
    horizonDays,
    sessionsPerWeek: Math.round(athlete.sessionsPerWeek),
    sessionMinutes: Math.min(Math.max(athlete.typicalSessionMinutes, 30), 90),
    recentWeekPattern,
  });

  const evaluate = (days) => scorePlan(days, simulatePlan(days, athlete), athlete, { raceDayIndex });

  return {
    version: PROBLEM_VERSION,
    horizonDays,
    athlete,
    seeds,
    constraints,
    raceDayIndex,
    weights: config.objectiveWeights || {},
    evaluate,
  };
}

/** A 7-day pattern echoing the athlete's recent zone distribution. */
function buildRecentPattern(zoneMinutes, athlete) {
  const perWeek = Math.min(Math.max(Math.round(athlete.sessionsPerWeek), 0), 7);
  if (!perWeek) return null;
  const total = Object.values(zoneMinutes).reduce((a, b) => a + b, 0);
  const week = Array.from({ length: 7 }, () => ({ type: 'rest', minutes: 0 }));
  if (!total) return null;
  // Fill alternating days with the athlete's dominant zones.
  const ranked = Object.entries(zoneMinutes).filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]);
  const slots = [0, 2, 4, 5, 1, 3, 6].slice(0, perWeek);
  slots.forEach((dayIdx, i) => {
    const [zone] = ranked[i % ranked.length];
    week[dayIdx] = { type: zone, minutes: Math.min(Math.max(athlete.typicalSessionMinutes, 30), 90) };
  });
  return week;
}
