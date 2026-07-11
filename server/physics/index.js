// Computational Rowing Physics Engine — wiring.
//
// Registers every physics model in the kernel version registry and provides
// a 'twin.inference-model' implementation (the CP/W′ fit from the athlete's
// own best-effort curve — a genuine upgrade over the twin's anchor-based
// power estimates). The twin never imports physics and physics never imports
// the twin: the provider contract in kernel/providers.js is the only bridge.
import { register } from '../kernel/registry.js';
import { provide } from '../kernel/providers.js';
import { mean } from '../kernel/stats.js';
import { estimateCriticalPower, sustainablePower, wattsFromSplit, splitFromWatts } from './power.js';
import { BOAT_CLASSES, PROPULSIVE_EFFICIENCY, crewSyncFactor, dragConstant, boatSpeed } from './boat.js';
import { environmentModel } from './environment.js';
export { physicsRouter } from './api.js';

const MODELS = [
  ['physics.power', 'Critical-power / W′ estimation from the best-effort curve (2-parameter CP model)'],
  ['physics.stroke', 'Six-phase stroke decomposition (force-curve or rate-based)'],
  ['physics.environment', 'Air density, wind, current, water-temperature effects'],
  ['physics.boat', 'Hull drag (P=k·v³, calibrated per class) and boat speed'],
  ['physics.energy', 'Mechanical/metabolic work, calories, energy-system split'],
  ['physics.recovery', 'Multi-system exponential recovery kinetics'],
  ['physics.translation', 'Erg ↔ boat translation chain'],
  ['physics.decomposition', 'Performance decomposition against the athlete model'],
];

let initialized = false;

/** Idempotent engine start-up: registry entries + twin providers. */
export function initPhysicsEngine() {
  if (initialized) return;
  initialized = true;

  for (const [name, description] of MODELS) {
    register({ name, kind: 'model', version: '1.0', description });
  }

  // Regatta boat-physics provider: the hull/power/environment models the
  // Digital Regatta Simulation Engine builds its race dynamics on. The
  // contract shape is documented in server/regatta/athleteModel.js (the
  // consumer); this is the only bridge — regatta never imports physics code.
  provide('regatta.boat-physics', {
    name: 'physics',
    modelVersion: 'physics.boat@1.0',
    BOAT_CLASSES,
    PROPULSIVE_EFFICIENCY,
    crewSyncFactor,
    dragConstant,
    boatSpeed,
    sustainablePower,
    wattsFromSplit,
    splitFromWatts,
    environmentModel,
  });

  // Twin inference provider: same contract shape as the twin's own models
  // ({ name, category, modelVersion, infer(ctx) → { variable: Estimate } }).
  // The twin's infer stage merges duplicate proposals by inverse-variance
  // combination, so this coexists with (and, with enough data, dominates)
  // the twin's anchor-based power model.
  provide('twin.inference-model', {
    name: 'physics-power',
    category: 'power',
    modelVersion: 'physics.power@1.0',
    infer(ctx) {
      // Reconstruct effort points from the cached features the twin already
      // extracted — duration + average watts (+ measurement grounding).
      const workoutsLike = ctx.recentWorkouts
        .map(w => ({
          total_time_s: (w.features.duration_min ?? 0) * 60,
          avg_power_watts: w.features.power_source === 1 ? w.features.power_avg_w : null,
          avg_split_s: w.features.pace_avg_split_s ?? null,
        }))
        .filter(w => w.total_time_s > 0);
      const steadyWatts = mean(ctx.recentWorkouts
        .filter(w => w.zone === 'ut2' || w.zone === 'ut1')
        .map(w => w.features.power_avg_w)
        .filter(Number.isFinite));
      const a = ctx.analysis.athlete || {};
      const fit = estimateCriticalPower(workoutsLike, {
        best2kSeconds: a.best2kSeconds, best2kVerified: a.best2kVerified,
        weightKg: ctx.user.weight_kg, steadyWatts,
      }, ctx.nowS);
      const out = {};
      if (fit.criticalPowerW) out.criticalPowerW = fit.criticalPowerW;
      if (fit.wPrimeJ) out.wPrimeJ = fit.wPrimeJ;
      return out;
    },
  });
}
