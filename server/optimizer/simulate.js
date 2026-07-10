// Forward model — what a candidate plan does to THIS athlete.
//
// Fitness–fatigue impulse-response (Banister 1975 family): every day's
// training load contributes an impulse that decays into two antagonistic
// stores — fitness (slow decay, τ_a ≈ 42 d) and fatigue (fast decay, τ_f
// personalized from the twin's recovery half-life). Performance potential is
// fitness − k_f·fatigue. The model is deliberately classical: decades of
// literature, fully explainable, cheap enough to evaluate tens of thousands
// of candidate plans.
//
// Optionally stochastic: pass an rng and the simulation perturbs adherence,
// executed load, recovery speed, and illness — one seeded draw per run, so
// Monte Carlo evaluation is exactly reproducible.
import { slotLoad, HARD_TYPES } from './planSpace.js';

export const SIMULATOR_VERSION = 'optimizer.simulate@1.0';

const TAU_FITNESS_D = 42;
const K_FATIGUE = 1.8; // fatigue hurts ~2× per unit while it lasts

/**
 * @param {Array} days   plan vector
 * @param {object} athlete
 *   chronicWeeklyLoad  current weekly TSS-like load (twin fatigue.chronicLoad-derived)
 *   recoveryHalfLifeH  twin recovery.recoveryHalfLifeH (24 default)
 *   adherenceBase      0..1 probability a planned session actually happens
 *   sessionsPerWeek    demonstrated frequency (adherence strain reference)
 * @param {object} [opts] { rng } for a stochastic draw
 * @returns per-day trajectory + aggregate outcomes
 */
export function simulatePlan(days, athlete, { rng = null } = {}) {
  const tauF_d = Math.min(Math.max((athlete.recoveryHalfLifeH || 24) / 24 / Math.LN2, 0.4), 4) * 7; // half-life → τ, scaled to ~7d anchor
  // Recovery speed noise (±20%) — one draw per simulated future.
  const tauF = rng ? tauF_d * (1 + rng.gaussian(0, 0.12)) : tauF_d;
  const dailyChronic = (athlete.chronicWeeklyLoad || 100) / 7;

  // Steady-state initialization: the athlete arrives carrying the fitness
  // and fatigue their recent chronic load implies, not zero. The fixed point
  // of x += L − x/τ under constant daily load L is x* = L·τ.
  let fitness = dailyChronic * TAU_FITNESS_D;
  let fatigue = dailyChronic * tauF;

  const adherenceBase = Math.min(Math.max(athlete.adherenceBase ?? 0.85, 0.3), 1);
  let illDaysLeft = 0;

  const trajectory = [];
  const executedLoads = [];
  let skipped = 0, illnessDays = 0;

  for (let i = 0; i < days.length; i++) {
    const planned = slotLoad(days[i]);
    let executed = planned;

    if (rng) {
      if (illDaysLeft > 0) { illDaysLeft--; illnessDays++; executed = 0; }
      else if (rng.chance(0.01 / 7)) illDaysLeft = rng.int(2, 5); // ≈1%/week illness onset
      else if (planned > 0) {
        // Adherence: long/hard sessions are skipped more when frequency runs
        // above the athlete's demonstrated pattern.
        const strain = HARD_TYPES.has(days[i].type) ? 0.05 : 0;
        if (!rng.chance(adherenceBase - strain)) { executed = 0; skipped++; }
        else executed = planned * (1 + rng.gaussian(0, 0.08)); // execution noise
      }
      if (illDaysLeft > 0 && executed === 0 && planned > 0) skipped++;
    }
    executed = Math.max(0, executed);
    executedLoads.push(executed);

    fitness += executed - fitness / TAU_FITNESS_D;
    fatigue += executed - fatigue / tauF;

    // Rolling load windows for risk signals.
    const acute = mean(executedLoads.slice(-7)) * 7;
    const chronicWindow = executedLoads.length >= 14 ? mean(executedLoads.slice(-28)) * 7 : (athlete.chronicWeeklyLoad || 100);
    const acwr = chronicWindow > 10 ? acute / chronicWindow : 1;

    trajectory.push({
      day: i,
      planned, executed: Math.round(executed * 10) / 10,
      fitness: Math.round(fitness * 10) / 10,
      fatigue: Math.round(fatigue * 10) / 10,
      performance: Math.round((fitness - K_FATIGUE * fatigue) * 10) / 10,
      acwr: Math.round(acwr * 100) / 100,
    });
  }

  /* ---- aggregates the objectives consume ---- */
  const perf0 = trajectory[0].fitness - K_FATIGUE * trajectory[0].fatigue;
  const perfEnd = trajectory[trajectory.length - 1].performance;
  const weeklyLoads = [];
  for (let w = 0; w * 7 < executedLoads.length; w++) {
    weeklyLoads.push(executedLoads.slice(w * 7, w * 7 + 7).reduce((a, b) => a + b, 0));
  }
  const dailySd = sd(executedLoads);
  const dailyMean = mean(executedLoads);
  // Foster monotony & strain: mean/sd of daily load; high = every day the same.
  const monotony = dailySd > 0.01 ? dailyMean / dailySd : (dailyMean > 0 ? 4 : 0);

  return {
    version: SIMULATOR_VERSION,
    trajectory,
    outcomes: {
      performanceGain: Math.round((perfEnd - perf0) * 10) / 10,
      fitnessGain: Math.round((trajectory[trajectory.length - 1].fitness - trajectory[0].fitness) * 10) / 10,
      peakFatigue: Math.round(Math.max(...trajectory.map(t => t.fatigue)) * 10) / 10,
      meanFatigue: Math.round(mean(trajectory.map(t => t.fatigue)) * 10) / 10,
      daysAcwrHigh: trajectory.filter(t => t.acwr > 1.5).length,
      monotony: Math.round(monotony * 100) / 100,
      weeklyLoads: weeklyLoads.map(Math.round),
      skippedSessions: skipped,
      illnessDays,
      performanceAtDay: (i) => trajectory[Math.min(Math.max(i, 0), trajectory.length - 1)].performance,
    },
  };
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
