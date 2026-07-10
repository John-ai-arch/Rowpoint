// Power production model — critical power (CP) and anaerobic work capacity
// (W′) estimated from the athlete's own performance history.
//
// Model: the 2-parameter critical-power model, P(t) = CP + W′/t — sustainable
// power for duration t is the aerobic ceiling CP plus the finite reserve W′
// spread over the effort. Fitting P against 1/t is a linear regression whose
// intercept is CP and slope is W′ (Monod & Scherrer 1965; validated for
// rowing at 2–30 min durations).
//
// Honesty rules: a real fit needs best-effort points at meaningfully
// different durations. When history can't support that, this model falls
// back to anchor-based estimates with 'assumed'/'estimated' provenance and
// wide uncertainty — it never dresses a guess up as a fit.
import { makeEstimate } from '../kernel/estimate.js';
import { linearRegression } from '../kernel/stats.js';

export const POWER_MODEL_VERSION = 'physics.power@1.0';

/** Concept2 pace→power. pace in seconds per 500m. */
export function wattsFromSplit(splitSPer500) {
  const p = Number(splitSPer500);
  if (!Number.isFinite(p) || p <= 0) return null;
  return 2.80 / (p / 500) ** 3;
}

/** Concept2 power→pace (s/500m). */
export function splitFromWatts(watts) {
  const w = Number(watts);
  if (!Number.isFinite(w) || w <= 0) return null;
  return 500 * Math.cbrt(2.80 / w);
}

/**
 * Build the athlete's best-effort curve: for logarithmic duration buckets,
 * the highest average power ever sustained for at least that duration.
 * Uses measured watts when present, pace-derived otherwise (flagged).
 */
export function bestEffortCurve(workouts) {
  const points = [];
  for (const w of workouts || []) {
    const t = Number(w.total_time_s);
    if (!(t >= 60) || t > 3 * 3600) continue; // sub-minute noise / ultra outliers
    const measured = Number(w.avg_power_watts) > 0;
    const watts = measured ? Number(w.avg_power_watts) : wattsFromSplit(w.avg_split_s);
    if (!(watts > 20) || watts > 1200) continue;
    points.push({ durationS: t, watts, measured });
  }
  // Keep only efforts on the upper envelope: a point survives if no longer
  // effort produced more power (longer AND more powerful dominates it).
  points.sort((a, b) => a.durationS - b.durationS);
  const envelope = [];
  for (const p of points) {
    if (!points.some(q => q !== p && q.durationS >= p.durationS && q.watts > p.watts)) envelope.push(p);
  }
  return envelope;
}

/**
 * Estimate CP and W′. Returns
 * { criticalPowerW: Estimate, wPrimeJ: Estimate, method, pointsUsed, curve }.
 * `anchors` = { best2kSeconds, best2kVerified, weightKg, steadyWatts }.
 */
export function estimateCriticalPower(workouts, anchors = {}, nowS = Math.floor(Date.now() / 1000)) {
  const curve = bestEffortCurve(workouts);
  // A meaningful fit needs ≥3 envelope points in the CP-valid window
  // (2–40 min) spanning at least a 2× duration range.
  const fitPts = curve.filter(p => p.durationS >= 120 && p.durationS <= 2400);
  const durations = fitPts.map(p => p.durationS);
  const spreadOk = durations.length >= 3 && Math.max(...durations) / Math.min(...durations) >= 2;

  if (spreadOk) {
    const reg = linearRegression(fitPts.map(p => 1 / p.durationS), fitPts.map(p => p.watts));
    const cp = reg?.intercept, wPrime = reg?.slope;
    // Physiological plausibility gate — a bad fit falls through to anchors.
    if (reg && cp >= 50 && cp <= 600 && wPrime >= 2000 && wPrime <= 60000) {
      const measuredShare = fitPts.filter(p => p.measured).length / fitPts.length;
      const conf = Math.min(0.85, 0.45 + fitPts.length * 0.05 + measuredShare * 0.15);
      return {
        criticalPowerW: makeEstimate({
          value: cp, uncertainty: Math.max(cp * 0.05, reg.slopeStdErr ? cp * 0.03 : cp * 0.08),
          confidence: conf, provenance: 'estimated', modelVersion: POWER_MODEL_VERSION,
          evidenceCount: fitPts.length, updatedAt: nowS,
        }),
        wPrimeJ: makeEstimate({
          value: wPrime, uncertainty: wPrime * 0.25,
          confidence: Math.max(0.3, conf - 0.15), provenance: 'estimated', modelVersion: POWER_MODEL_VERSION,
          evidenceCount: fitPts.length, updatedAt: nowS,
        }),
        method: 'cp-fit', pointsUsed: fitPts.length, curve,
      };
    }
  }

  /* ---- anchor fallbacks (documented, honestly uncertain) ---- */
  const out = { method: 'anchor', pointsUsed: 0, curve };
  if (anchors.best2kSeconds > 0) {
    // A 2k is a near-maximal ~6–8 min effort; CP ≈ 78% of 2k power for
    // trained rowers at these durations (from the CP model itself with
    // typical W′). W′ from mass prior (~230 J/kg trained).
    const w2k = wattsFromSplit(anchors.best2kSeconds / 4);
    out.criticalPowerW = makeEstimate({
      value: w2k * 0.78, uncertainty: w2k * 0.08,
      confidence: anchors.best2kVerified ? 0.6 : 0.4, provenance: 'estimated',
      modelVersion: POWER_MODEL_VERSION, evidenceCount: 1, updatedAt: nowS,
    });
  } else if (anchors.steadyWatts > 0) {
    out.criticalPowerW = makeEstimate({
      value: anchors.steadyWatts * 1.15, uncertainty: anchors.steadyWatts * 0.2,
      confidence: 0.3, provenance: 'estimated', modelVersion: POWER_MODEL_VERSION,
      evidenceCount: 1, updatedAt: nowS,
    });
  }
  const mass = anchors.weightKg > 0 ? anchors.weightKg : 75;
  out.wPrimeJ = makeEstimate({
    value: mass * 230, uncertainty: mass * 80, confidence: 0.2, provenance: 'assumed',
    modelVersion: POWER_MODEL_VERSION, evidenceCount: 0, updatedAt: nowS,
  });
  return out;
}

/**
 * Sustainable power for a target duration from CP/W′ — the inverse question
 * the race and translation models ask. Clamped to the model's valid window.
 */
export function sustainablePower(cpW, wPrimeJ, durationS) {
  const t = Math.max(120, Math.min(Number(durationS) || 0, 4 * 3600));
  if (!(cpW > 0)) return null;
  return cpW + (wPrimeJ > 0 ? wPrimeJ / t : 0);
}
