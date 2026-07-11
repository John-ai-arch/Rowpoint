// Regatta environment — race-day conditions as probability distributions.
//
// The physics engine's environment model answers "what do these conditions
// do to a boat"; this module answers "which conditions will each simulated
// race actually get". Known inputs become tight distributions around the
// measured value; unknown inputs become wide, zero-centred ones — never a
// guessed point value. Gusts are an Ornstein–Uhlenbeck process integrated by
// the race stepper; lane effects are small documented inequities, either
// user-specified (a coach who knows lane 6 carries current) or sampled.
// Pure module: safe on worker threads.

export const ENVIRONMENT_VERSION = 'regatta.environment@1.0';

const given = (v) => Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Maximum unexplained lane-to-lane speed inequity (fraction). Documented
 *  assumption: buoyed 2k courses are near-fair; residual wind shadow / chop
 *  differences rarely exceed ±0.3% of boat speed. */
export const LANE_BIAS_SD = 0.0015;

/**
 * Build the distribution model from user/coach-entered conditions.
 * All inputs optional. laneAdvantagePct: per-lane % speed adjustments
 * (positive = faster lane), used when the course is known to be unfair.
 */
export function makeEnvironmentModel(input = {}, laneCount = 2) {
  const windKnown = given(input.windSpeedMps);
  const directional = windKnown && given(input.windDirectionDeg) && given(input.headingDeg);
  const relDeg = directional ? (Number(input.windDirectionDeg) - Number(input.headingDeg)) : 0;
  const windSpeed = windKnown ? clamp(Number(input.windSpeedMps), 0, 25) : 0;
  // Meteorological convention: direction is where wind comes FROM, so
  // cos(0) = pure headwind for a boat heading into it.
  const headwindMean = windKnown ? windSpeed * Math.cos((relDeg * Math.PI) / 180) : 0;
  const headwindSd = !windKnown ? 1.5 : directional ? windSpeed * 0.12 + 0.2 : windSpeed * 0.45 + 0.2;

  const currentKnown = given(input.currentMps);
  const tempKnown = given(input.temperatureC);
  const waterKnown = given(input.waterTemperatureC);
  const altKnown = given(input.altitudeM);

  const tC = tempKnown ? clamp(Number(input.temperatureC), -10, 45) : 15;
  const altM = altKnown ? clamp(Number(input.altitudeM), 0, 3000) : 0;
  // Ideal-gas density with barometric altitude falloff (matches the physics
  // engine's model at standard humidity).
  const airDensity = (101325 * Math.exp(-altM / 8434)) / (287.058 * (tC + 273.15));

  const waterT = waterKnown ? clamp(Number(input.waterTemperatureC), 0, 35) : 15;
  // ~0.5% hull drag per °C from viscosity (see physics.environment).
  const waterDragFactor = 1 + (15 - waterT) * 0.005;

  const lanes = [];
  for (let i = 0; i < laneCount; i++) {
    const specified = Array.isArray(input.laneAdvantagePct) && given(input.laneAdvantagePct[i]);
    lanes.push({
      biasMean: specified ? clamp(Number(input.laneAdvantagePct[i]), -1, 1) / 100 : 0,
      biasSd: specified ? LANE_BIAS_SD / 2 : LANE_BIAS_SD,
      specified,
    });
  }

  return {
    version: ENVIRONMENT_VERSION,
    headwindMean, headwindSd,
    // Gust model: OU process around the mean wind. Gustiness scales with
    // wind speed; calm days barely gust.
    gustSd: windKnown ? Math.max(0.3, windSpeed * 0.25) : 0.5,
    gustTauS: 12,
    currentMean: currentKnown ? clamp(Number(input.currentMps), -3, 3) : 0,
    currentSd: currentKnown ? 0.05 : 0.15,
    airDensity,
    airDensitySd: tempKnown && altKnown ? 0.005 : 0.02,
    waterDragFactor,
    waterDragFactorSd: waterKnown ? 0.004 : 0.015,
    lanes,
    inputs: {
      windSpeedMps: windKnown ? windSpeed : null,
      windDirectionDeg: given(input.windDirectionDeg) ? Number(input.windDirectionDeg) : null,
      headingDeg: given(input.headingDeg) ? Number(input.headingDeg) : null,
      currentMps: currentKnown ? Number(input.currentMps) : null,
      temperatureC: tempKnown ? tC : null,
      waterTemperatureC: waterKnown ? waterT : null,
      altitudeM: altKnown ? altM : null,
    },
    provenance: {
      wind: windKnown ? (directional ? 'measured' : 'estimated') : 'assumed',
      current: currentKnown ? 'measured' : 'assumed',
      airDensity: tempKnown ? 'estimated' : 'assumed',
      water: waterKnown ? 'estimated' : 'assumed',
      lanes: lanes.some(l => l.specified) ? 'measured' : 'assumed',
    },
  };
}

/**
 * Draw one race day from the model. Returns plain numbers for the race
 * stepper plus the sampled values (recorded for sensitivity analysis).
 */
export function sampleEnvironment(model, rng) {
  const headwind = rng.gaussian(model.headwindMean, model.headwindSd);
  const current = rng.gaussian(model.currentMean, model.currentSd);
  return {
    headwindMps: clamp(headwind, -20, 20),
    currentMps: clamp(current, -3, 3),
    airDensity: clamp(rng.gaussian(model.airDensity, model.airDensitySd), 0.9, 1.5),
    waterDragFactor: clamp(rng.gaussian(model.waterDragFactor, model.waterDragFactorSd), 0.9, 1.15),
    gustSd: model.gustSd,
    gustTauS: model.gustTauS,
    laneBias: model.lanes.map(l => clamp(rng.gaussian(l.biasMean, l.biasSd), -0.02, 0.02)),
  };
}
