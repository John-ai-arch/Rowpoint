// Environmental effects model.
//
// Every input is optional. Provided values are 'measured'; absent ones use
// documented standard-condition defaults with 'assumed' provenance — the
// output always distinguishes which was which via the `inputs` map. Nothing
// is ever fabricated: an unknown wind is a zero-mean assumption with wide
// uncertainty, not a guessed number.
import { makeEstimate } from '../kernel/estimate.js';

export const ENV_MODEL_VERSION = 'physics.environment@1.0';

/** Standard conditions used when a value is not provided. */
export const STANDARD = Object.freeze({
  temperatureC: 15, altitudeM: 0, humidityPct: 50,
  windSpeedMps: 0, windDirectionDeg: 0, currentMps: 0, waterTemperatureC: 15,
});

const given = (v) => Number.isFinite(Number(v));

/**
 * Air density (kg/m³) from temperature, altitude, humidity.
 * Barometric pressure falloff + ideal-gas density + a small humidity
 * correction (moist air is LESS dense). Standard conditions → ~1.225.
 */
export function airDensity({ temperatureC, altitudeM, humidityPct } = {}) {
  const T = given(temperatureC) ? Number(temperatureC) : STANDARD.temperatureC;
  const h = given(altitudeM) ? Math.min(Math.max(Number(altitudeM), -430), 6000) : STANDARD.altitudeM;
  const rh = given(humidityPct) ? Math.min(Math.max(Number(humidityPct), 0), 100) : STANDARD.humidityPct;
  const tK = T + 273.15;
  const pressure = 101325 * Math.exp(-h / 8434); // isothermal barometric approx
  // Saturation vapor pressure (Tetens), partial pressure of water vapor.
  const pSat = 610.78 * Math.exp((17.27 * T) / (T + 237.3));
  const pV = (rh / 100) * pSat;
  const density = (pressure - pV) / (287.058 * tK) + pV / (461.495 * tK);
  const measured = given(temperatureC) && given(altitudeM);
  return makeEstimate({
    value: density, uncertainty: measured ? 0.005 : 0.03,
    confidence: measured ? 0.9 : 0.5, provenance: measured ? 'estimated' : 'assumed',
    modelVersion: ENV_MODEL_VERSION, evidenceCount: measured ? 1 : 0,
  });
}

/**
 * Effective headwind component (m/s, + = against the boat) from wind speed,
 * wind direction, and boat heading. Meteorological convention: wind
 * direction is where the wind comes FROM, so wind from 0° against a boat
 * heading 0° is a pure headwind. Unknown wind → 0 ± 2 m/s assumed.
 */
export function effectiveHeadwind({ windSpeedMps, windDirectionDeg, headingDeg } = {}) {
  if (!given(windSpeedMps)) {
    return makeEstimate({
      value: 0, uncertainty: 2, confidence: 0.3, provenance: 'assumed',
      modelVersion: ENV_MODEL_VERSION, evidenceCount: 0,
    });
  }
  const speed = Math.min(Math.max(Number(windSpeedMps), 0), 40);
  const relDeg = given(windDirectionDeg) && given(headingDeg)
    ? (Number(windDirectionDeg) - Number(headingDeg))
    : 0; // direction unknown → treat as pure head/tail with wider spread
  const component = speed * Math.cos((relDeg * Math.PI) / 180);
  const directional = given(windDirectionDeg) && given(headingDeg);
  return makeEstimate({
    value: component, uncertainty: directional ? speed * 0.15 + 0.3 : speed * 0.5 + 0.3,
    confidence: directional ? 0.75 : 0.45, provenance: 'estimated',
    modelVersion: ENV_MODEL_VERSION, evidenceCount: 1,
  });
}

/**
 * Water drag multiplier from water temperature: kinematic viscosity of water
 * falls ~2.4%/°C around 15°C, and skin friction is the dominant hull drag
 * component (~80%), so colder water is measurably slower.
 * Returns a multiplier on the drag constant (1.0 at 15°C).
 */
export function waterDragFactor({ waterTemperatureC } = {}) {
  const known = given(waterTemperatureC);
  const T = known ? Math.min(Math.max(Number(waterTemperatureC), 0), 35) : STANDARD.waterTemperatureC;
  // ~0.5% drag change per °C (2.4% viscosity × ~0.2 friction sensitivity × 0.8 share).
  const factor = 1 + (STANDARD.waterTemperatureC - T) * 0.005;
  return makeEstimate({
    value: factor, uncertainty: known ? 0.005 : 0.02,
    confidence: known ? 0.7 : 0.4, provenance: known ? 'estimated' : 'assumed',
    modelVersion: ENV_MODEL_VERSION, evidenceCount: known ? 1 : 0,
  });
}

/** Current along the course (m/s, + = pushing the boat). Unknown → 0 ± 0.3. */
export function effectiveCurrent({ currentMps } = {}) {
  if (!given(currentMps)) {
    return makeEstimate({
      value: 0, uncertainty: 0.3, confidence: 0.3, provenance: 'assumed',
      modelVersion: ENV_MODEL_VERSION, evidenceCount: 0,
    });
  }
  return makeEstimate({
    value: Math.min(Math.max(Number(currentMps), -3), 3), uncertainty: 0.1,
    confidence: 0.8, provenance: 'measured', modelVersion: ENV_MODEL_VERSION, evidenceCount: 1,
  });
}

/** Full environment bundle with input provenance, for explainability. */
export function environmentModel(inputs = {}) {
  return {
    airDensity: airDensity(inputs),
    headwind: effectiveHeadwind(inputs),
    waterDragFactor: waterDragFactor(inputs),
    current: effectiveCurrent(inputs),
    inputs: Object.fromEntries(Object.keys(STANDARD).map(k => [
      k, given(inputs[k]) ? { value: Number(inputs[k]), source: 'measured' } : { value: STANDARD[k], source: 'assumed' },
    ])),
  };
}
