// Multi-objective scoring — a plan's simulated trajectory becomes a vector
// of named objectives. There is NO default collapse to one number: the
// Pareto layer works on the vector, and any scalarization (search needs one
// occasionally) is explicit, weighted, and recorded with the run.
import { HARD_TYPES } from './planSpace.js';

export const OBJECTIVES_VERSION = 'optimizer.objectives@1.0';

/**
 * Objective definitions. direction: +1 maximize, −1 minimize. `scale` is a
 * typical magnitude used for normalization in scalarization/crowding — it
 * never changes the Pareto relation.
 */
export const OBJECTIVES = Object.freeze({
  improvement: { direction: +1, scale: 60, label: 'Predicted improvement', detail: 'Performance-potential gain over the horizon (fitness − fatigue, impulse-response model).' },
  raceReadiness: { direction: +1, scale: 60, label: 'Race-day readiness', detail: 'Performance potential on race day (only when a race date is set).' },
  fatigue: { direction: -1, scale: 120, label: 'Accumulated fatigue', detail: 'Mean fatigue carried across the horizon.' },
  injuryRisk: { direction: -1, scale: 10, label: 'Strain risk', detail: 'Days above ACWR 1.5 plus training monotony.' },
  adherence: { direction: +1, scale: 1, label: 'Adherence plausibility', detail: 'How well the plan matches the athlete\'s demonstrated frequency and session lengths.' },
});

/**
 * Score one deterministic simulation.
 * @returns { improvement, raceReadiness?, fatigue, injuryRisk, adherence }
 */
export function scorePlan(days, sim, athlete, { raceDayIndex = null } = {}) {
  const o = sim.outcomes;
  const scores = {
    improvement: o.performanceGain,
    fatigue: o.meanFatigue,
    injuryRisk: o.daysAcwrHigh + Math.max(0, o.monotony - 2) * 2,
    adherence: adherencePlausibility(days, athlete),
  };
  if (raceDayIndex !== null && raceDayIndex >= 0 && raceDayIndex < sim.trajectory.length) {
    scores.raceReadiness = sim.trajectory[raceDayIndex].performance - sim.trajectory[0].performance;
  }
  return scores;
}

/**
 * Adherence plausibility 0..1: plans close to what the athlete demonstrably
 * does score high; big jumps in frequency, duration, or intensity score low.
 * This is a preference (objective), NOT a cap — an ambitious athlete can
 * still pick the ambitious plan, with open eyes.
 */
export function adherencePlausibility(days, athlete) {
  const weeks = Math.max(1, days.length / 7);
  const sessions = days.filter(d => d.type !== 'rest');
  const perWeek = sessions.length / weeks;
  const base = athlete.sessionsPerWeek || 3;
  const freqRatio = perWeek / Math.max(base, 1);
  let score = 1;
  if (freqRatio > 1) score -= Math.min(0.5, (freqRatio - 1) * 0.5);   // asking for more than they do
  if (freqRatio < 0.5) score -= 0.15;                                  // suspiciously little
  const avgMin = sessions.length ? sessions.reduce((s, d) => s + d.minutes, 0) / sessions.length : 0;
  const baseMin = athlete.typicalSessionMinutes || 45;
  if (avgMin > baseMin * 1.5) score -= 0.2;
  const hardShare = sessions.length ? sessions.filter(d => HARD_TYPES.has(d.type)).length / sessions.length : 0;
  if (hardShare > 0.45) score -= 0.2; // nobody adheres to mostly-hard plans
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

/** Objective vector → normalized "higher is better" array (fixed key order). */
export function toDirectionalVector(scores) {
  return activeKeys(scores).map(k => {
    const def = OBJECTIVES[k];
    return (def.direction * scores[k]) / def.scale;
  });
}

export function activeKeys(scores) {
  return Object.keys(OBJECTIVES).filter(k => scores[k] !== undefined);
}

/**
 * Explicit scalarization for search interiors. Weights are named, sum-free,
 * and recorded in the run config — never an implicit default hierarchy.
 */
export function scalarize(scores, weights = {}) {
  let total = 0;
  for (const k of activeKeys(scores)) {
    const def = OBJECTIVES[k];
    const w = weights[k] ?? 1;
    total += w * (def.direction * scores[k]) / def.scale;
  }
  return total;
}
