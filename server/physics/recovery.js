// Recovery kinetics — continuous decay, never discrete labels.
//
// Model: each physiological system sheds its session-induced fatigue
// exponentially, fatigue_s(t) = M_s · exp(−t/τ_s), with system-specific time
// constants (documented literature ranges):
//   cardiovascular τ ≈ 12–24 h   (autonomic/HRV normalization)
//   muscular       τ ≈ 24–48 h   (contractile function, soreness)
//   neural         τ ≈ 48–72 h   (CNS drive after hard/maximal work)
//   energy         τ ≈ 18–30 h   (glycogen, nutrition unknown → widest)
// Magnitudes M_s scale with session training load and intensity; the
// athlete's personal recovery half-life (twin state, wellness-informed)
// rescales every τ. Outputs are Estimates plus an evaluator so downstream
// models (readiness, the optimizer's forward simulation) can query residual
// fatigue at any future time.
import { makeEstimate } from '../kernel/estimate.js';

export const RECOVERY_MODEL_VERSION = 'physics.recovery@1.0';

const SYSTEMS = Object.freeze({
  cardiovascular: { tauH: 18, tauSpread: 6, loadWeight: 1.0, intensityWeight: 0.6 },
  muscular: { tauH: 36, tauSpread: 12, loadWeight: 0.8, intensityWeight: 1.0 },
  neural: { tauH: 60, tauSpread: 12, loadWeight: 0.4, intensityWeight: 1.4 },
  energy: { tauH: 24, tauSpread: 10, loadWeight: 1.2, intensityWeight: 0.4 },
});

/**
 * Post-workout recovery kinetics.
 * @param {number} trainingLoad   session load (duration·IF²·100, the twin's
 *                                load feature); ~60 = solid steady hour
 * @param {number} intensityFactor 0..~1.1 relative to 2k pace
 * @param {number} personalHalfLifeH the athlete's recovery half-life from
 *                                twin state (24 = population default)
 */
export function recoveryKinetics({ trainingLoad, intensityFactor, personalHalfLifeH = 24, nowS = Math.floor(Date.now() / 1000) } = {}) {
  const load = Math.min(Math.max(Number(trainingLoad) || 0, 0), 600);
  const intensity = Math.min(Math.max(Number(intensityFactor) || 0.6, 0), 1.3);
  // Personal scaling: 24 h is the population τ anchor.
  const personal = Math.min(Math.max(Number(personalHalfLifeH) || 24, 8), 72) / 24;
  const personalKnown = Number(personalHalfLifeH) > 0 && personalHalfLifeH !== 24;

  const systems = {};
  for (const [name, s] of Object.entries(SYSTEMS)) {
    // Magnitude 0–100: how much this system was stressed by the session.
    // The intensity term only engages above IF 0.75 — easy aerobic work
    // fatigues through volume (the load term), not through intensity.
    const magnitude = Math.min(100,
      (load / 60) * 35 * s.loadWeight + Math.max(0, intensity - 0.75) * 130 * s.intensityWeight);
    const tauH = s.tauH * personal;
    systems[name] = {
      magnitude: makeEstimate({
        value: Math.round(magnitude * 10) / 10, uncertainty: 12, confidence: 0.5,
        provenance: 'estimated', modelVersion: RECOVERY_MODEL_VERSION, evidenceCount: 1, updatedAt: nowS,
      }),
      halfLifeH: makeEstimate({
        value: Math.round(tauH * Math.LN2 * 10) / 10, // report as half-life, not τ
        uncertainty: s.tauSpread, confidence: personalKnown ? 0.5 : 0.35,
        provenance: personalKnown ? 'estimated' : 'assumed',
        modelVersion: RECOVERY_MODEL_VERSION, evidenceCount: personalKnown ? 1 : 0, updatedAt: nowS,
      }),
      tauH,
      magnitudeValue: magnitude,
    };
  }

  return {
    systems,
    /** Residual fatigue per system (0–100 each) t hours after the session. */
    residualAt(tHours) {
      const t = Math.max(0, Number(tHours) || 0);
      const out = {};
      for (const [name, s] of Object.entries(systems)) {
        out[name] = Math.round(s.magnitudeValue * Math.exp(-t / s.tauH) * 10) / 10;
      }
      out.overall = Math.round(Math.max(...Object.values(out)) * 10) / 10;
      return out;
    },
    /** Hours until every system is below the given residual threshold. */
    hoursToRecover(threshold = 10) {
      let worst = 0;
      for (const s of Object.values(systems)) {
        if (s.magnitudeValue <= threshold) continue;
        worst = Math.max(worst, s.tauH * Math.log(s.magnitudeValue / threshold));
      }
      return Math.round(worst * 10) / 10;
    },
  };
}
