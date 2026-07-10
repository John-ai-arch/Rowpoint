// Energy expenditure model.
//
// Equations (documented):
// - Mechanical work  W_mech = P̄ · t  (average power × duration).
// - Metabolic work   W_met  = W_mech / η,  gross efficiency η = 0.20 ± 0.03
//   (rowing ergometry literature: 18–23% for trained rowers).
// - Calories         kcal = W_met / 4184 + basal ~1.2 kcal/min during work.
// - Energy-system split by duration (classic bioenergetics fractions):
//   alactic ~ first ~10 s, glycolytic peaks around 30–120 s, aerobic share
//   grows with ln(duration): ~50% at 1 min, ~80% at 6 min, ~98% at 60 min.
import { makeEstimate } from '../kernel/estimate.js';
import { wattsFromSplit } from './power.js';

export const ENERGY_MODEL_VERSION = 'physics.energy@1.0';

export const GROSS_EFFICIENCY = 0.20;
const EFFICIENCY_SPREAD = 0.03;

/**
 * Energy analysis for one workout. Uses measured watts when present,
 * pace-derived otherwise (provenance says which).
 */
export function energyExpenditure({ avgPowerWatts, avgSplitS, totalTimeS, nowS = Math.floor(Date.now() / 1000) }) {
  const t = Number(totalTimeS);
  if (!(t > 0)) return null;
  const measured = Number(avgPowerWatts) > 0;
  const watts = measured ? Number(avgPowerWatts) : wattsFromSplit(avgSplitS);
  if (!(watts > 0)) return null;

  const mechJ = watts * t;
  const metJ = mechJ / GROSS_EFFICIENCY;
  // Relative uncertainty of metabolic work is dominated by the efficiency
  // assumption: ση/η = 0.15.
  const relMet = EFFICIENCY_SPREAD / GROSS_EFFICIENCY;
  const kcal = metJ / 4184 + (t / 60) * 1.2;

  const est = (value, rel, opts = {}) => makeEstimate({
    value, uncertainty: value * rel,
    confidence: measured ? 0.75 : 0.6, provenance: 'estimated',
    modelVersion: ENERGY_MODEL_VERSION, evidenceCount: 1, updatedAt: nowS, ...opts,
  });

  return {
    mechanicalWorkKj: est(mechJ / 1000, measured ? 0.02 : 0.06),
    metabolicWorkKj: est(metJ / 1000, relMet),
    calories: est(kcal, relMet),
    grossEfficiency: makeEstimate({
      value: GROSS_EFFICIENCY, uncertainty: EFFICIENCY_SPREAD, confidence: 0.5,
      provenance: 'assumed', modelVersion: ENERGY_MODEL_VERSION, evidenceCount: 0, updatedAt: nowS,
    }),
    systems: energySystemSplit(t, nowS),
    powerSource: measured ? 'measured-watts' : 'pace-derived',
  };
}

/**
 * Aerobic / glycolytic / alactic contribution fractions by duration.
 * Smooth in duration; fractions sum to 1.
 */
export function energySystemSplit(durationS, nowS = Math.floor(Date.now() / 1000)) {
  const t = Math.max(Number(durationS) || 0, 5);
  // Aerobic share: logistic in ln(t), anchored at the documented points
  // (60s → ~0.50, 360s → ~0.80, 3600s → ~0.98).
  const aerobic = Math.min(0.995, 1 / (1 + Math.exp(-(Math.log(t) - Math.log(60)) * 1.05)) * 0.99 + 0.005);
  const alactic = Math.min(0.9, 10 / t) * 0.5;         // ~10s of stored phosphate
  const glycolytic = Math.max(0, 1 - aerobic - alactic);
  const est = (value) => makeEstimate({
    value: Math.round(value * 1000) / 1000, uncertainty: 0.07, confidence: 0.5,
    provenance: 'estimated', modelVersion: ENERGY_MODEL_VERSION, evidenceCount: 1, updatedAt: nowS,
  });
  return { aerobic: est(aerobic), glycolytic: est(glycolytic), alactic: est(alactic) };
}
