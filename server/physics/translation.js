// Erg ↔ boat translation — an explainable chain, never one conversion factor.
//
//   erg performance → sustainable power for the target duration (CP model)
//   → per-rower on-water power (technique/steering discount)
//   → boat speed (hull + air drag, environment)
//   → predicted race pace with uncertainty
//
// Every link contributes its own uncertainty and appears in the returned
// `chain` so the user sees exactly how the prediction was built and which
// assumptions dominate it.
import { makeEstimate } from '../kernel/estimate.js';
import { wattsFromSplit, sustainablePower } from './power.js';
import { boatSpeed, BOAT_CLASSES, PROPULSIVE_EFFICIENCY } from './boat.js';
import { environmentModel } from './environment.js';

export const TRANSLATION_MODEL_VERSION = 'physics.translation@1.0';

/**
 * On-water technique discount: erg power transfers imperfectly to moving
 * water (blade work, balance, steering). Documented range 0.90–0.98 by
 * water experience; defaults to 0.94 when unknown.
 */
function techniqueTransfer(waterExperience) {
  const table = { none: 0.88, novice: 0.90, intermediate: 0.94, advanced: 0.96, elite: 0.98 };
  return table[waterExperience] ?? 0.94;
}

/**
 * Predict on-water race performance from erg fitness.
 * @param {object} opts
 *   erg2kSeconds     the athlete's (current-form) 2k time
 *   criticalPowerW / wPrimeJ   optional CP-model params (better grounding)
 *   boatClass        one of BOAT_CLASSES
 *   raceDistanceM    default 2000
 *   avgRowerKg       crew average mass
 *   waterExperience  none|novice|intermediate|advanced|elite
 *   environment      { temperatureC, windSpeedMps, windDirectionDeg,
 *                      headingDeg, currentMps, waterTemperatureC, altitudeM }
 */
export function ergToBoat(opts = {}) {
  const {
    erg2kSeconds, criticalPowerW, wPrimeJ, boatClass = '1x', raceDistanceM = 2000,
    avgRowerKg = 80, waterExperience, environment = {}, nowS = Math.floor(Date.now() / 1000),
  } = opts;
  if (!BOAT_CLASSES[boatClass]) throw new Error(`Unknown boat class: ${boatClass}`);
  const chain = [];

  /* 1 — erg anchor → power */
  let ergWatts = null, anchorNote;
  if (erg2kSeconds > 0) {
    ergWatts = wattsFromSplit(erg2kSeconds / 4);
    anchorNote = `2k of ${fmtTime(erg2kSeconds)} → ${Math.round(ergWatts)} W average`;
  } else if (criticalPowerW > 0) {
    ergWatts = criticalPowerW * 1.28; // invert the CP↔2k relation used below
    anchorNote = `critical power ${Math.round(criticalPowerW)} W → ~${Math.round(ergWatts)} W 2k-equivalent`;
  } else {
    return { available: false, reason: 'Needs a 2k time or a critical-power estimate.' };
  }
  chain.push({ step: 'erg-anchor', detail: anchorNote, relUncertainty: erg2kSeconds > 0 ? 0.02 : 0.06 });

  /* 2 — sustainable power for the RACE duration (not the erg duration) */
  // First-pass race duration guess from the erg anchor, refined once below.
  const cp = criticalPowerW > 0 ? criticalPowerW : ergWatts * 0.78;
  const wp = wPrimeJ > 0 ? wPrimeJ : avgRowerKg * 230;
  let raceDurationS = (erg2kSeconds || 400) * (raceDistanceM / 2000);
  let racePowerW = sustainablePower(cp, wp, raceDurationS);
  chain.push({
    step: 'sustainable-power',
    detail: `CP ${Math.round(cp)} W + W′ ${Math.round(wp / 1000)} kJ over ~${Math.round(raceDurationS)}s → ${Math.round(racePowerW)} W`,
    relUncertainty: criticalPowerW > 0 ? 0.04 : 0.07,
  });

  /* 3 — technique transfer to water */
  const transfer = techniqueTransfer(waterExperience);
  const onWaterW = racePowerW * transfer;
  chain.push({
    step: 'technique-transfer',
    detail: `${waterExperience || 'unknown'} water experience → ×${transfer}`,
    relUncertainty: waterExperience ? 0.02 : 0.04,
  });

  /* 4 — environment + hull physics → speed (iterate once for duration) */
  const env = environmentModel(environment);
  for (let pass = 0; pass < 2; pass++) {
    const speed = boatSpeed(boatClass, onWaterW, {
      avgRowerKg,
      waterDragFactor: env.waterDragFactor.value,
      headwindMps: env.headwind.value,
      airDensity: env.airDensity.value,
    });
    const groundSpeed = Math.max(speed.speedMps.value + env.current.value, 0.5);
    raceDurationS = raceDistanceM / groundSpeed;
    racePowerW = sustainablePower(cp, wp, raceDurationS) * transfer;
    if (pass === 1) {
      chain.push({
        step: 'boat-physics',
        detail: `${boatClass}: ${speed.speedMps.value.toFixed(2)} m/s through water, `
          + `${env.headwind.value ? `${env.headwind.value.toFixed(1)} m/s headwind, ` : 'no wind data, '}`
          + `${env.current.value ? `${env.current.value.toFixed(2)} m/s current` : 'no current data'}`,
        relUncertainty: speed.speedMps.uncertainty / speed.speedMps.value,
      });
      // Total relative uncertainty: independent links in quadrature.
      const rel = Math.sqrt(chain.reduce((s, c) => s + c.relUncertainty ** 2, 0));
      const timeS = raceDistanceM / groundSpeed;
      const split = timeS / (raceDistanceM / 500);
      return {
        available: true,
        boatClass,
        raceDistanceM,
        predictedTimeS: makeEstimate({
          value: Math.round(timeS * 10) / 10, uncertainty: timeS * rel, confidence: Math.max(0.25, 0.7 - rel * 2),
          provenance: 'predicted', modelVersion: TRANSLATION_MODEL_VERSION, evidenceCount: 1, updatedAt: nowS,
        }),
        predictedSplit500S: Math.round(split * 10) / 10,
        predictedTime: fmtTime(timeS),
        range: `${fmtTime(timeS * (1 - rel))}–${fmtTime(timeS * (1 + rel))}`,
        chain,
        environment: env,
        assumptions: [
          `Propulsive efficiency ${PROPULSIVE_EFFICIENCY} (oar → hull)`,
          `Technique transfer ×${transfer}${waterExperience ? '' : ' (experience not set — default)'}`,
          'Hull drag calibrated to typical elite crew speeds per class',
          'Flat-water course; unknown environment values use standard conditions',
        ],
        disclaimer: 'A physics-grounded estimate, not a promise — water conditions, steering, and crew rhythm move real results by several seconds.',
      };
    }
  }
  /* unreachable */
  return { available: false, reason: 'internal' };
}

function fmtTime(totalS) {
  if (!Number.isFinite(totalS) || totalS <= 0) return '—';
  const s = Math.round(totalS);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
