// Monte Carlo plan evaluation — distributions, not point estimates.
//
// Each frontier plan is simulated hundreds of times with seeded perturbations
// of the uncertain world (adherence, execution noise, recovery speed,
// illness). The output is the SPREAD of futures a plan buys, reported as
// quantiles. Pure module (no database): the same code runs inline for small
// jobs and on a worker thread for large ones (see mcWorker.js).
import { createRng, seedFrom } from '../kernel/rng.js';
import { quantile, mean } from '../kernel/stats.js';
import { simulatePlan } from './simulate.js';

export const MC_VERSION = 'optimizer.monte-carlo@1.0';

/**
 * @param {Array} plans     [{ days, ... }] — extra keys pass through
 * @param {object} athlete  simulator athlete params
 * @param {object} opts     { iterations, seed, raceDayIndex }
 * @returns per-plan { mc: { improvement: {p10,p50,p90}, peakFatigue: {p50,p90},
 *                     raceReadiness?, skippedMean, illnessDaysMean, iterations, seed } }
 */
export function evaluatePlansMC(plans, athlete, { iterations = 300, seed = 1, raceDayIndex = null } = {}) {
  return plans.map((plan, planIdx) => {
    const gains = [], fatigues = [], readiness = [], skipped = [], illness = [];
    for (let it = 0; it < iterations; it++) {
      // Deterministic per (seed, plan, iteration): reruns byte-match.
      const rng = createRng(seedFrom(seed, planIdx, it));
      const sim = simulatePlan(plan.days, athlete, { rng });
      gains.push(sim.outcomes.performanceGain);
      fatigues.push(sim.outcomes.peakFatigue);
      skipped.push(sim.outcomes.skippedSessions);
      illness.push(sim.outcomes.illnessDays);
      if (raceDayIndex !== null) {
        readiness.push(sim.outcomes.performanceAtDay(raceDayIndex) - sim.trajectory[0].performance);
      }
    }
    const q = (xs, p) => Math.round(quantile(xs, p) * 10) / 10;
    return {
      ...plan,
      mc: {
        version: MC_VERSION,
        iterations,
        seed,
        improvement: { p10: q(gains, 0.1), p50: q(gains, 0.5), p90: q(gains, 0.9) },
        peakFatigue: { p50: q(fatigues, 0.5), p90: q(fatigues, 0.9) },
        ...(raceDayIndex !== null ? { raceReadiness: { p10: q(readiness, 0.1), p50: q(readiness, 0.5), p90: q(readiness, 0.9) } } : {}),
        skippedMean: Math.round(mean(skipped) * 10) / 10,
        illnessDaysMean: Math.round(mean(illness) * 100) / 100,
      },
    };
  });
}
