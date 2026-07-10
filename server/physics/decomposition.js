// Performance decomposition — "why was this a 6:34", not just "it was".
//
// Method: predict what the athlete's current model state (CP/W′) says this
// workout's average power SHOULD have been for its duration, then attribute
// the observed result across explainable factors:
//   aerobic / anaerobic supply  — from the energy-system split for the duration
//   execution (pacing)          — fade & variability against an even effort
//   technique                   — rate discipline and (when present) force smoothness
//   freshness                   — readiness relative to neutral
// Each factor is an Estimate; `residualPct` is the honest leftover the model
// cannot attribute. Confidence reflects grounding — decomposition without HR
// or force data says so via wide uncertainty, it doesn't pretend.
import { makeEstimate } from '../kernel/estimate.js';
import { wattsFromSplit, sustainablePower } from './power.js';
import { energySystemSplit } from './energy.js';

export const DECOMPOSITION_MODEL_VERSION = 'physics.decomposition@1.0';

/**
 * @param {object} workout   { total_time_s, avg_split_s, avg_power_watts }
 * @param {object} ctx       { criticalPowerW, wPrimeJ, readinessScore,
 *                            features: { pace_cv_pct, pace_first_last_delta_s,
 *                                        rate_cv_pct, force_smoothness_idx } }
 */
export function decomposePerformance(workout, ctx = {}) {
  const t = Number(workout.total_time_s);
  const actualW = Number(workout.avg_power_watts) > 0
    ? Number(workout.avg_power_watts)
    : wattsFromSplit(workout.avg_split_s);
  if (!(t > 30) || !(actualW > 0)) return { available: false, reason: 'Too little data to decompose.' };
  const nowS = Math.floor(Date.now() / 1000);
  const f = ctx.features || {};
  const est = (value, { u = 8, c = 0.5, p = 'estimated' } = {}) => makeEstimate({
    value: Math.round(value * 10) / 10, uncertainty: u, confidence: c, provenance: p,
    modelVersion: DECOMPOSITION_MODEL_VERSION, evidenceCount: 1, updatedAt: nowS,
  });

  /* Expected power from the athlete's own model state (if known). */
  const expectedW = ctx.criticalPowerW > 0 ? sustainablePower(ctx.criticalPowerW, ctx.wPrimeJ || 0, t) : null;
  const vsExpectedPct = expectedW ? ((actualW - expectedW) / expectedW) * 100 : null;

  /* Energy supply split for this duration. */
  const systems = energySystemSplit(t, nowS);

  /* Execution: fade against an even effort. + = faded, − = negative split. */
  const fadeS = Number(f.pace_first_last_delta_s);
  const cvPct = Number(f.pace_cv_pct);
  let executionPenaltyPct = 0;
  if (Number.isFinite(fadeS)) executionPenaltyPct += Math.max(0, fadeS) * 0.4;
  if (Number.isFinite(cvPct)) executionPenaltyPct += Math.max(0, cvPct - 1.5) * 0.5;
  executionPenaltyPct = Math.min(executionPenaltyPct, 15);

  /* Technique: rate discipline + force smoothness when measured. */
  const rateCv = Number(f.rate_cv_pct);
  const smooth = Number(f.force_smoothness_idx);
  const hasForce = Number.isFinite(smooth);
  let techniquePenaltyPct = 0;
  if (Number.isFinite(rateCv)) techniquePenaltyPct += Math.max(0, rateCv - 3) * 0.3;
  if (hasForce) techniquePenaltyPct += Math.max(0, 70 - smooth) * 0.05;
  techniquePenaltyPct = Math.min(techniquePenaltyPct, 10);

  /* Freshness: readiness 75 is neutral; each 10 points ≈ ∓1% power. */
  const readiness = Number(ctx.readinessScore);
  const freshnessPct = Number.isFinite(readiness) ? (readiness - 75) / 10 : null;

  const residualPct = vsExpectedPct !== null
    ? Math.round((vsExpectedPct + executionPenaltyPct + techniquePenaltyPct - (freshnessPct ?? 0)) * 10) / 10
    : null;

  return {
    available: true,
    actualWatts: Math.round(actualW),
    expectedWatts: expectedW ? Math.round(expectedW) : null,
    vsExpectedPct: vsExpectedPct !== null ? est(vsExpectedPct, { u: 5, c: 0.55 }) : null,
    aerobicSharePct: est(systems.aerobic.value * 100, { u: 7 }),
    anaerobicSharePct: est((systems.glycolytic.value + systems.alactic.value) * 100, { u: 7 }),
    executionPenaltyPct: est(executionPenaltyPct, { u: 3, c: Number.isFinite(fadeS) ? 0.6 : 0.2, p: Number.isFinite(fadeS) ? 'estimated' : 'assumed' }),
    techniquePenaltyPct: est(techniquePenaltyPct, { u: 3, c: hasForce ? 0.55 : 0.3, p: hasForce ? 'estimated' : 'assumed' }),
    freshnessPct: freshnessPct !== null ? est(freshnessPct, { u: 2, c: 0.45 }) : null,
    residualPct,
    explanation: buildExplanation({ vsExpectedPct, executionPenaltyPct, techniquePenaltyPct, freshnessPct }),
  };
}

function buildExplanation({ vsExpectedPct, executionPenaltyPct, techniquePenaltyPct, freshnessPct }) {
  const parts = [];
  if (vsExpectedPct !== null) {
    parts.push(vsExpectedPct >= 0
      ? `Output ran ${vsExpectedPct.toFixed(1)}% above what your current fitness model expected`
      : `Output ran ${Math.abs(vsExpectedPct).toFixed(1)}% below what your current fitness model expected`);
  }
  if (executionPenaltyPct >= 1) parts.push(`pacing cost roughly ${executionPenaltyPct.toFixed(1)}%`);
  if (techniquePenaltyPct >= 1) parts.push(`rhythm/technique variability cost roughly ${techniquePenaltyPct.toFixed(1)}%`);
  if (freshnessPct !== null && Math.abs(freshnessPct) >= 0.5) {
    parts.push(freshnessPct > 0 ? 'freshness worked in your favor' : 'accumulated fatigue worked against you');
  }
  return parts.length ? parts.join('; ') + '.' : 'An unremarkable session against your current model — no single factor stands out.';
}
