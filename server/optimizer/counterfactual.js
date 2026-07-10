// Counterfactual evaluation — "what if I trained differently?"
//
// The athlete (or coach) edits a plan; this evaluates their version through
// the exact same simulator, objectives, constraint gate, and a small Monte
// Carlo draw, then reports the deltas against a reference plan. Consequences
// before commitment — and the same yardstick for human ideas as for the
// optimizer's own.
import { checkConstraints } from './constraints.js';
import { simulatePlan } from './simulate.js';
import { scorePlan, activeKeys, OBJECTIVES } from './objectives.js';
import { evaluatePlansMC } from './monteCarlo.js';
import { TYPES, DURATIONS } from './planSpace.js';

export const COUNTERFACTUAL_VERSION = 'optimizer.counterfactual@1.0';

/** Validate and normalize a user-submitted plan vector. Throws on garbage. */
export function sanitizePlanDays(raw, horizonDays) {
  if (!Array.isArray(raw) || raw.length !== horizonDays) {
    throw new Error(`Plan must be an array of exactly ${horizonDays} days.`);
  }
  return raw.map((d, i) => {
    const type = TYPES.includes(d?.type) ? d.type : null;
    if (!type) throw new Error(`Day ${i + 1}: unknown session type.`);
    if (type === 'rest') return { type: 'rest', minutes: 0 };
    const minutes = DURATIONS.includes(Number(d.minutes)) && Number(d.minutes) > 0 ? Number(d.minutes) : null;
    if (!minutes) throw new Error(`Day ${i + 1}: duration must be one of ${DURATIONS.slice(1).join('/')} minutes.`);
    return { type, minutes };
  });
}

/**
 * @param {Array} candidateDays   the edited plan (sanitized)
 * @param {Array|null} referenceDays  plan to compare against (e.g. the run's
 *                                recommended plan); null → deltas omitted
 * @param {object} problem        from buildProblem()
 */
export function evaluateCounterfactual(candidateDays, referenceDays, problem, { mcIterations = 120, seed = 7 } = {}) {
  const constraintCheck = checkConstraints(candidateDays, problem.constraints);
  const sim = simulatePlan(candidateDays, problem.athlete);
  const scores = scorePlan(candidateDays, sim, problem.athlete, { raceDayIndex: problem.raceDayIndex });
  const [withMc] = evaluatePlansMC([{ days: candidateDays }], problem.athlete, {
    iterations: mcIterations, seed, raceDayIndex: problem.raceDayIndex,
  });

  let deltas = null;
  if (referenceDays) {
    const refScores = scorePlan(referenceDays, simulatePlan(referenceDays, problem.athlete), problem.athlete, { raceDayIndex: problem.raceDayIndex });
    deltas = {};
    for (const k of activeKeys(scores)) {
      const d = Math.round((scores[k] - refScores[k]) * 10) / 10;
      deltas[k] = {
        delta: d,
        better: OBJECTIVES[k].direction === 1 ? d > 0 : d < 0,
        label: OBJECTIVES[k].label,
      };
    }
  }

  return {
    version: COUNTERFACTUAL_VERSION,
    valid: constraintCheck.valid,
    violations: constraintCheck.violations,
    scores,
    mc: withMc.mc,
    trajectory: sim.trajectory.filter((_, i) => i % 2 === 0), // decimated for transport
    deltas,
  };
}
