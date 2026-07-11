// Race-boat assembly — every lane's state, built from the Digital Twin.
//
// The user's boat is grounded in their own twin state (critical power, W′,
// readiness, pace variability, technique discipline) with honest fallbacks
// when history is thin. Opponents are either archetypes RELATIVE to the
// user's own level (demographics-neutral: "a matched opponent" means matched
// for THIS athlete, whether junior or elite) or manually-entered erg
// estimates for known rivals. Real athletes may only appear as lanes in a
// coach-run team simulation, and only after the API layer has verified the
// coach relationship — an athlete can never load another athlete's twin.
//
// Physics arrives through the kernel 'regatta.boat-physics' contract
// (provided by the physics engine — see server/physics/index.js). Contract
// shape: { BOAT_CLASSES, PROPULSIVE_EFFICIENCY, crewSyncFactor, dragConstant,
// boatSpeed, sustainablePower, wattsFromSplit, splitFromWatts,
// environmentModel }. Everything this module returns is PLAIN DATA so it can
// cross the worker-thread boundary.
import { providersOf } from '../kernel/providers.js';
import { buildTrainingAnalysis } from '../ai/trainingAnalysis.js';

export const ATHLETE_MODEL_VERSION = 'regatta.athlete@1.0';

/** Added hydrodynamic mass: accelerating a hull also accelerates entrained
 *  water; documented factor ~1.15 on the displaced system. */
export const ADDED_MASS_FACTOR = 1.15;
const COX_KG = 55;

/**
 * Opponent archetypes, defined RELATIVE to the user's estimated race power
 * so a junior's "matched opponent" and an elite's differ automatically.
 * powerFactor multiplies the user's mean CP; sd is the archetype's spread
 * (how uncertain we are about who actually shows up in that lane).
 */
export const ARCHETYPES = Object.freeze({
  matched: { label: 'Evenly matched', powerFactor: 1.0, powerSd: 0.02, aggression: 0.4, sprintTendency: 0.4, fadeTendency: 0.5 },
  challenger: { label: 'Slightly faster', powerFactor: 1.02, powerSd: 0.015, aggression: 0.5, sprintTendency: 0.5, fadeTendency: 0.45 },
  underdog: { label: 'Slightly slower', powerFactor: 0.98, powerSd: 0.015, aggression: 0.55, sprintTendency: 0.35, fadeTendency: 0.55 },
  wildcard: { label: 'Unknown entry', powerFactor: 1.0, powerSd: 0.045, aggression: 0.5, sprintTendency: 0.5, fadeTendency: 0.5 },
});

function physics() {
  const p = providersOf('regatta.boat-physics')[0];
  if (!p) throw new Error('regatta.boat-physics provider not registered — is the physics engine initialized?');
  return p;
}

function twinState(userId) {
  const provider = providersOf('twin.state-access')[0];
  return provider ? provider.getState(userId) : {};
}

const stateVal = (state, cat, v) => {
  const x = state?.[cat]?.[v]?.value;
  return Number.isFinite(x) ? x : null;
};
const stateUnc = (state, cat, v) => {
  const x = state?.[cat]?.[v]?.uncertainty;
  return Number.isFinite(x) && x > 0 ? x : null;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Physiological race parameters for one real athlete, from their twin state
 * with documented anchor fallbacks. Returns { available:false, reason } when
 * there is genuinely nothing to ground an estimate in.
 */
export function athleteRaceParams(user, nowS = Math.floor(Date.now() / 1000)) {
  const phys = physics();
  const state = twinState(user.id);
  const explain = [];

  let cpW = stateVal(state, 'power', 'criticalPowerW');
  let cpSd = stateUnc(state, 'power', 'criticalPowerW');
  if (cpW) {
    explain.push({ source: 'twin', detail: `critical power ${Math.round(cpW)} W from athlete state` });
  } else {
    // Anchor fallback: current 2k form from the training analysis.
    const analysis = buildTrainingAnalysis(user, nowS);
    const best2k = analysis?.athlete?.best2kSeconds;
    if (best2k > 0) {
      const w2k = phys.wattsFromSplit(best2k / 4);
      cpW = w2k * 0.78;
      cpSd = w2k * 0.08;
      explain.push({ source: 'anchor', detail: `2k of ${Math.round(best2k)}s → CP ≈ ${Math.round(cpW)} W (78% of 2k power)` });
    }
  }
  if (!cpW) return { available: false, reason: 'No power estimate yet — log a few workouts (or a 2k) first.' };
  cpSd = clamp(cpSd ?? cpW * 0.06, cpW * 0.02, cpW * 0.12);

  const massKg = user.weight_kg > 0 ? Number(user.weight_kg) : 75;
  let wPrimeJ = stateVal(state, 'power', 'wPrimeJ');
  let wpSd = stateUnc(state, 'power', 'wPrimeJ');
  if (!wPrimeJ) {
    wPrimeJ = massKg * 230; // trained-rower mass prior, matches physics.power
    wpSd = massKg * 80;
    explain.push({ source: 'assumed', detail: `W′ from mass prior (${massKg} kg × 230 J/kg)` });
  }
  wpSd = clamp(wpSd ?? wPrimeJ * 0.2, wPrimeJ * 0.05, wPrimeJ * 0.4);

  // Readiness: under-recovery costs race power (documented: up to ~3%).
  const readiness = stateVal(state, 'readiness', 'score');
  const readinessFactor = readiness !== null ? clamp(1 - (65 - readiness) * 0.0006, 0.97, 1.01) : 1;
  if (readiness !== null && readinessFactor < 0.995) {
    explain.push({ source: 'twin', detail: `readiness ${Math.round(readiness)} → ×${readinessFactor.toFixed(3)} on race power` });
  }

  // Execution noise from demonstrated pace variability (CV%).
  const paceVar = stateVal(state, 'consistency', 'paceVariability');
  const paceCv = paceVar !== null ? clamp((paceVar / 100) * 0.8, 0.008, 0.05) : 0.02;

  // Technique fade from rate discipline; sprint reserve → start quality.
  const rateDisc = stateVal(state, 'technique', 'rateDiscipline');
  const fadeTendency = rateDisc !== null ? clamp((100 - rateDisc) / 100, 0.25, 0.85) : 0.5;
  const sprintIdx = stateVal(state, 'anaerobic', 'sprintReserveIndex');
  const startQuality = sprintIdx !== null ? clamp(0.5 + sprintIdx / 200, 0.5, 1) : 0.7;

  return {
    available: true,
    cpW: Math.round(cpW * 10) / 10,
    cpSd: Math.round(cpSd * 10) / 10,
    wPrimeJ: Math.round(wPrimeJ),
    wpSd: Math.round(wpSd),
    massKg,
    readinessFactor: Math.round(readinessFactor * 1000) / 1000,
    paceCv: Math.round(paceCv * 1000) / 1000,
    fadeTendency: Math.round(fadeTendency * 100) / 100,
    startQuality: Math.round(startQuality * 100) / 100,
    explain,
  };
}

/** Opponent from an archetype, relative to the user's estimated level. */
export function archetypeBoat(kind, userParams, name) {
  const a = ARCHETYPES[kind] || ARCHETYPES.matched;
  return {
    name: name || a.label,
    kind: 'archetype',
    archetype: ARCHETYPES[kind] ? kind : 'matched',
    cpW: Math.round(userParams.cpW * a.powerFactor * 10) / 10,
    cpSd: Math.round(userParams.cpW * a.powerSd * 10) / 10,
    wPrimeJ: userParams.wPrimeJ,
    wpSd: Math.round(userParams.wPrimeJ * 0.25),
    massKg: userParams.massKg,
    readinessFactor: 1,
    paceCv: 0.022,
    fadeTendency: a.fadeTendency,
    startQuality: 0.7,
    aggression: a.aggression,
    sprintTendency: a.sprintTendency,
  };
}

/** Opponent from a manually-entered erg estimate (a known rival). */
export function manualBoat(entry, userParams) {
  const phys = physics();
  const split = entry.split500s > 0 ? Number(entry.split500s)
    : entry.erg2kSeconds > 0 ? Number(entry.erg2kSeconds) / 4 : null;
  if (!split || split < 75 || split > 180) return null;
  const w2k = phys.wattsFromSplit(split);
  return {
    name: String(entry.name || 'Rival').slice(0, 40),
    kind: 'manual',
    cpW: Math.round(w2k * 0.78 * 10) / 10,
    cpSd: Math.round(w2k * 0.05 * 10) / 10, // an entered estimate, not a lab test
    wPrimeJ: userParams.wPrimeJ,
    wpSd: Math.round(userParams.wPrimeJ * 0.3),
    massKg: entry.massKg > 0 ? clamp(Number(entry.massKg), 40, 130) : userParams.massKg,
    readinessFactor: 1,
    paceCv: 0.022,
    fadeTendency: clamp(Number(entry.fadeTendency) || 0.5, 0, 1),
    startQuality: 0.7,
    aggression: clamp(Number(entry.aggression) || 0.5, 0, 1),
    sprintTendency: clamp(Number(entry.sprintTendency) || 0.5, 0, 1),
  };
}

/**
 * Average several athletes' race params into one crew (coach lineups).
 * Documented simplification: a crew rows at its members' mean CP/mass with
 * synchronization losses applied by the boat model — no seat-order effects.
 */
export function crewParams(memberParams) {
  const ok = memberParams.filter(p => p?.available);
  if (!ok.length) return null;
  const avg = (f) => ok.reduce((s, p) => s + f(p), 0) / ok.length;
  return {
    available: true,
    cpW: Math.round(avg(p => p.cpW) * 10) / 10,
    cpSd: Math.round(avg(p => p.cpSd) * 10) / 10,
    wPrimeJ: Math.round(avg(p => p.wPrimeJ)),
    wpSd: Math.round(avg(p => p.wpSd)),
    massKg: Math.round(avg(p => p.massKg) * 10) / 10,
    readinessFactor: Math.round(avg(p => p.readinessFactor) * 1000) / 1000,
    paceCv: Math.round(avg(p => p.paceCv) * 1000) / 1000,
    fadeTendency: Math.round(avg(p => p.fadeTendency) * 100) / 100,
    startQuality: Math.round(avg(p => p.startQuality) * 100) / 100,
    explain: [{ source: 'crew', detail: `averaged over ${ok.length} rower(s)` }],
  };
}

/**
 * Attach the plain-number hull constants every boat needs in the stepper,
 * plus the shared reference race duration used for the CP power budget.
 * (Per-simulation durations vary a few percent; using the mean-parameter
 * duration for basePower is a documented second-order approximation.)
 */
export function prepareBoats(boats, { boatClass = '1x', distanceM = 2000 } = {}) {
  const phys = physics();
  const spec = phys.BOAT_CLASSES[boatClass];
  if (!spec) throw new Error(`Unknown boat class: ${boatClass}`);

  const prepared = boats.map((b) => {
    const kBase = phys.dragConstant(boatClass, { avgRowerKg: b.massKg });
    return {
      ...b,
      boatClass,
      kBase: Math.round(kBase * 10000) / 10000,
      cdA: Math.round(0.35 * Math.pow(spec.crew, 0.6) * 1000) / 1000,
      crewPowerFactor: Math.round(spec.crew * phys.crewSyncFactor(spec.crew) * phys.PROPULSIVE_EFFICIENCY * 1000) / 1000,
      effMassKg: Math.round((spec.shellMassKg + spec.crew * b.massKg + (spec.cox ? COX_KG : 0)) * ADDED_MASS_FACTOR * 10) / 10,
    };
  });

  // Reference duration from the user's mean parameters (two-pass iteration).
  const user = prepared.find(b => b.isUser) || prepared[0];
  let durationS = distanceM / 4.5;
  for (let pass = 0; pass < 2; pass++) {
    const p = phys.sustainablePower(user.cpW, user.wPrimeJ, durationS) * user.readinessFactor;
    const speed = phys.boatSpeed(boatClass, p, { avgRowerKg: user.massKg });
    if (speed?.speedMps?.value > 0) durationS = distanceM / speed.speedMps.value;
  }
  const duration0S = Math.round(durationS * 10) / 10;
  return prepared.map(b => ({ ...b, duration0S }));
}
