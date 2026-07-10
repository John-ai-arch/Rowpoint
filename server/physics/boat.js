// Boat model: shell classes, hull drag, and boat speed from applied power.
//
// Physics: at racing speeds hull drag is dominated by skin friction, giving
// drag power P = k·v³ with k a per-boat constant that grows with wetted
// surface (≈ displacement^(2/3)). Rather than deriving k from naval
// architecture first principles, each class's baseline k is CALIBRATED so a
// crew producing typical elite race power hits that class's typical
// world-class speed — an explainable anchor with documented numbers, not a
// black box. Mass deviations from the calibration crew rescale k by
// (displacement ratio)^(2/3).
//
// Crew synchronization: crews never sum power perfectly; documented
// assumption of ~2% loss per doubling of crew size (sync + steering losses),
// partially offset in the calibration anchors themselves.
import { makeEstimate } from '../kernel/estimate.js';

export const BOAT_MODEL_VERSION = 'physics.boat@1.0';

/**
 * crew: rowers; cox: adds mass, no power. calibration = { crewPowerW (per
 * rower, sustained ~6min elite), speedMps (typical elite race speed) }.
 * shellMassKg: FISA minimums. Speeds from world-best-time-level averages,
 * rounded — they anchor the model, they are not claims about any race.
 */
export const BOAT_CLASSES = Object.freeze({
  '1x': { crew: 1, cox: false, shellMassKg: 14, calibration: { crewPowerW: 460, speedMps: 5.05 } },
  '2x': { crew: 2, cox: false, shellMassKg: 27, calibration: { crewPowerW: 460, speedMps: 5.45 } },
  '2-': { crew: 2, cox: false, shellMassKg: 27, calibration: { crewPowerW: 460, speedMps: 5.30 } },
  '2+': { crew: 2, cox: true, shellMassKg: 32, calibration: { crewPowerW: 460, speedMps: 5.05 } },
  '4x': { crew: 4, cox: false, shellMassKg: 52, calibration: { crewPowerW: 460, speedMps: 5.85 } },
  '4-': { crew: 4, cox: false, shellMassKg: 50, calibration: { crewPowerW: 460, speedMps: 5.70 } },
  '4+': { crew: 4, cox: true, shellMassKg: 51, calibration: { crewPowerW: 460, speedMps: 5.50 } },
  '8+': { crew: 8, cox: true, shellMassKg: 96, calibration: { crewPowerW: 460, speedMps: 6.25 } },
});

/** Propulsive efficiency: oar-work → hull-work. Documented ~0.78 ± 0.05. */
export const PROPULSIVE_EFFICIENCY = 0.78;

const CALIBRATION_ROWER_KG = 85;
const COX_KG = 55;

/** Crew power multiplier for synchronization losses (1.0 for a single). */
export function crewSyncFactor(crew) {
  return Math.pow(0.98, Math.log2(Math.max(crew, 1)));
}

/**
 * Drag constant k (P_hull = k·v³) for a boat class and actual crew masses.
 * `avgRowerKg` defaults to the calibration crew.
 */
export function dragConstant(boatClass, { avgRowerKg = CALIBRATION_ROWER_KG, waterDragFactor = 1 } = {}) {
  const spec = BOAT_CLASSES[boatClass];
  if (!spec) throw new Error(`Unknown boat class: ${boatClass}`);
  const { crewPowerW, speedMps } = spec.calibration;
  const totalPowerAtCal = crewPowerW * spec.crew * crewSyncFactor(spec.crew) * PROPULSIVE_EFFICIENCY;
  const kCal = totalPowerAtCal / speedMps ** 3;
  const calMass = spec.shellMassKg + spec.crew * CALIBRATION_ROWER_KG + (spec.cox ? COX_KG : 0);
  const actualMass = spec.shellMassKg + spec.crew * Math.min(Math.max(avgRowerKg, 40), 130) + (spec.cox ? COX_KG : 0);
  return kCal * Math.pow(actualMass / calMass, 2 / 3) * waterDragFactor;
}

/**
 * Boat speed through the water for a given per-rower sustained power.
 * Returns { speedMps: Estimate, split500s: Estimate, k } — wind adds an
 * air-drag term on top of hull drag; current shifts ground speed afterward.
 */
export function boatSpeed(boatClass, perRowerPowerW, {
  avgRowerKg = CALIBRATION_ROWER_KG, waterDragFactor = 1, headwindMps = 0, airDensity = 1.225,
} = {}) {
  const spec = BOAT_CLASSES[boatClass];
  if (!spec) throw new Error(`Unknown boat class: ${boatClass}`);
  if (!(perRowerPowerW > 0)) return null;
  const k = dragConstant(boatClass, { avgRowerKg, waterDragFactor });
  const pHull = perRowerPowerW * spec.crew * crewSyncFactor(spec.crew) * PROPULSIVE_EFFICIENCY;
  // Air drag: P_air = ½·ρ·CdA·(v+w)²·v. CdA ≈ 0.35·crew^0.6 m² (crew bodies).
  const cdA = 0.35 * Math.pow(spec.crew, 0.6);
  // Solve pHull = k·v³ + ½ρ·CdA·(v+w)²·v by bisection (monotone in v).
  const power = (v) => k * v ** 3 + 0.5 * airDensity * cdA * Math.max(v + headwindMps, 0) ** 2 * v;
  let lo = 0.1, hi = 9;
  if (power(hi) < pHull) hi = 12;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (power(mid) < pHull) lo = mid; else hi = mid;
  }
  const v = (lo + hi) / 2;
  // Uncertainty: propulsive efficiency ±0.05 dominates → ~2% on speed (cube root).
  const rel = 0.022 + Math.abs(headwindMps) * 0.004;
  return {
    speedMps: makeEstimate({
      value: v, uncertainty: v * rel, confidence: 0.6, provenance: 'estimated',
      modelVersion: BOAT_MODEL_VERSION, evidenceCount: 1,
    }),
    split500s: makeEstimate({
      value: 500 / v, uncertainty: (500 / v) * rel, confidence: 0.6, provenance: 'estimated',
      modelVersion: BOAT_MODEL_VERSION, evidenceCount: 1,
    }),
    k,
  };
}
