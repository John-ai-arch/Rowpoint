// Physics engine validation: CP/W′ fitting against synthetic ground truth,
// the six-phase stroke decomposition, environmental models under extreme
// conditions, boat-speed calibration sanity, energy accounting, recovery
// kinetics, the erg→boat translation chain, performance decomposition, and
// numerical stability against garbage inputs (nothing may ever emit NaN).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = `/tmp/rowpoint-physics-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_JOBS_ENABLED = '0';

const { wattsFromSplit, splitFromWatts, bestEffortCurve, estimateCriticalPower, sustainablePower } = await import('../server/physics/power.js');
const { decomposeStroke, averageProfile, profileSmoothness, STROKE_PHASES } = await import('../server/physics/stroke.js');
const { airDensity, effectiveHeadwind, waterDragFactor, environmentModel } = await import('../server/physics/environment.js');
const { boatSpeed, dragConstant, crewSyncFactor, BOAT_CLASSES } = await import('../server/physics/boat.js');
const { energyExpenditure, energySystemSplit } = await import('../server/physics/energy.js');
const { recoveryKinetics } = await import('../server/physics/recovery.js');
const { ergToBoat } = await import('../server/physics/translation.js');
const { decomposePerformance } = await import('../server/physics/decomposition.js');

const noNaN = (obj, path = '') => {
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'number') assert.ok(!Number.isNaN(v), `NaN leaked at ${path}${k}`);
    else if (v && typeof v === 'object') noNaN(v, `${path}${k}.`);
  }
};

/* ------------------------------- power ------------------------------- */

test('pace↔power round-trips the Concept2 relation', () => {
  assert.ok(Math.abs(wattsFromSplit(120) - 202.5) < 1, '2:00/500m ≈ 203W');
  assert.ok(Math.abs(splitFromWatts(wattsFromSplit(105)) - 105) < 1e-9);
  assert.equal(wattsFromSplit(0), null);
  assert.equal(wattsFromSplit(-5), null);
});

test('CP fit recovers synthetic ground truth (CP=250, W′=15000)', () => {
  const CP = 250, WP = 15000;
  const workouts = [240, 360, 600, 1200, 2400].map(t => ({
    total_time_s: t, avg_power_watts: CP + WP / t, avg_split_s: null,
  }));
  const fit = estimateCriticalPower(workouts, {});
  assert.equal(fit.method, 'cp-fit');
  assert.ok(Math.abs(fit.criticalPowerW.value - CP) < 5, `CP within 5W, got ${fit.criticalPowerW.value}`);
  assert.ok(Math.abs(fit.wPrimeJ.value - WP) < 1500, `W′ within 10%, got ${fit.wPrimeJ.value}`);
  assert.equal(fit.criticalPowerW.provenance, 'estimated');
  assert.ok(fit.criticalPowerW.confidence > 0.5);
  // The sustainable-power inverse agrees with the forward model.
  assert.ok(Math.abs(sustainablePower(CP, WP, 600) - (CP + WP / 600)) < 1e-9);
});

test('CP estimation falls back honestly when history cannot support a fit', () => {
  // One duration only — no spread → anchor fallback.
  const workouts = [1, 2, 3].map(() => ({ total_time_s: 600, avg_power_watts: 210 }));
  const fit = estimateCriticalPower(workouts, { best2kSeconds: 420, weightKg: 80 });
  assert.equal(fit.method, 'anchor');
  assert.equal(fit.wPrimeJ.provenance, 'assumed', 'no short-effort data → W′ is an admitted assumption');
  assert.ok(fit.wPrimeJ.confidence <= 0.25);
  // No data at all → still no crash, wPrime prior present, CP possibly absent.
  const empty = estimateCriticalPower([], { weightKg: 70 });
  assert.equal(empty.criticalPowerW, undefined);
  assert.ok(empty.wPrimeJ.value > 0);
});

test('best-effort curve keeps only the upper envelope', () => {
  const curve = bestEffortCurve([
    { total_time_s: 300, avg_power_watts: 280 },
    { total_time_s: 300, avg_power_watts: 220 },   // dominated (same t, less W)
    { total_time_s: 600, avg_power_watts: 290 },   // dominates both above
    { total_time_s: 1200, avg_power_watts: 240 },
  ]);
  assert.deepEqual(curve.map(p => p.watts), [290, 240]);
});

/* ------------------------------- stroke ------------------------------- */

test('stroke decomposition: phase timings cover the full cycle, both sources', () => {
  const forceCurves = Array.from({ length: 10 }, () => ({
    samples: Array.from({ length: 16 }, (_, i) => Math.sin((i / 15) * Math.PI) * 400),
  }));
  for (const args of [{ avgRate: 24, forceCurves }, { avgRate: 28, forceCurves: [] }]) {
    const d = decomposeStroke(args);
    const total = STROKE_PHASES.reduce((s, ph) => s + d.phases[ph].timingPct.value, 0);
    assert.ok(Math.abs(total - 100) < 1.5, `phase timings sum to ~100%, got ${total} (${d.source})`);
    assert.ok(d.rhythmRatio.value > 0.8 && d.rhythmRatio.value < 3);
    noNaN(d.phases);
  }
  assert.equal(decomposeStroke({ avgRate: 24, forceCurves }).source, 'force-curve');
  assert.equal(decomposeStroke({ avgRate: 24, forceCurves: [] }).source, 'rate-model');
  // Provenance downgrade without force data.
  assert.equal(decomposeStroke({ avgRate: 24, forceCurves: [] }).phases.drive.timingPct.provenance, 'assumed');
});

test('force profile averaging and smoothness behave', () => {
  const smooth = Array.from({ length: 8 }, () => ({ samples: Array.from({ length: 20 }, (_, i) => Math.sin((i / 19) * Math.PI) * 300) }));
  const jagged = Array.from({ length: 8 }, () => ({ samples: Array.from({ length: 20 }, (_, i) => 150 + (i % 2 ? 200 : -100)) }));
  assert.equal(averageProfile([]).length, 0);
  assert.equal(averageProfile(smooth).length, 32);
  assert.ok(profileSmoothness(smooth) > profileSmoothness(jagged), 'sine drive is smoother than sawtooth');
  assert.equal(profileSmoothness([]), null);
});

/* ---------------------------- environment ---------------------------- */

test('air density: standard conditions and extremes stay physical', () => {
  const std = airDensity({});
  assert.ok(Math.abs(std.value - 1.22) < 0.02, `standard ≈ 1.225, got ${std.value}`);
  assert.equal(std.provenance, 'assumed');
  const altiplano = airDensity({ temperatureC: 30, altitudeM: 4000, humidityPct: 90 });
  assert.ok(altiplano.value > 0.7 && altiplano.value < std.value);
  const arctic = airDensity({ temperatureC: -30, altitudeM: 0, humidityPct: 10 });
  assert.ok(arctic.value > std.value && arctic.value < 1.6);
});

test('wind and water models: unknowns are wide assumptions, never guesses', () => {
  const unknown = effectiveHeadwind({});
  assert.equal(unknown.value, 0);
  assert.equal(unknown.provenance, 'assumed');
  assert.ok(unknown.uncertainty >= 2);
  const head = effectiveHeadwind({ windSpeedMps: 5, windDirectionDeg: 0, headingDeg: 180 });
  assert.ok(Math.abs(head.value + 5) < 0.01, 'pure tailwind at opposite heading');
  const cross = effectiveHeadwind({ windSpeedMps: 5, windDirectionDeg: 90, headingDeg: 0 });
  assert.ok(Math.abs(cross.value) < 0.01, 'pure crosswind → no head component');
  assert.ok(waterDragFactor({ waterTemperatureC: 5 }).value > 1, 'cold water is slower');
  assert.ok(waterDragFactor({ waterTemperatureC: 28 }).value < 1);
  const env = environmentModel({ temperatureC: 20 });
  assert.equal(env.inputs.temperatureC.source, 'measured');
  assert.equal(env.inputs.windSpeedMps.source, 'assumed');
});

/* -------------------------------- boat -------------------------------- */

test('boat speeds are calibrated: elite power → near-elite speed per class', () => {
  for (const [cls, spec] of Object.entries(BOAT_CLASSES)) {
    const out = boatSpeed(cls, spec.calibration.crewPowerW, {});
    // Air drag is added ON TOP of the calibrated hull anchor, so calibration
    // recovers speed within a few percent, monotone with class expectations.
    const rel = Math.abs(out.speedMps.value - spec.calibration.speedMps) / spec.calibration.speedMps;
    assert.ok(rel < 0.06, `${cls}: expected ~${spec.calibration.speedMps} m/s, got ${out.speedMps.value.toFixed(2)}`);
  }
  const eight = boatSpeed('8+', 460, {}).speedMps.value;
  const single = boatSpeed('1x', 460, {}).speedMps.value;
  assert.ok(eight > single, 'an eight outruns a single at the same per-rower power');
  const headwind = boatSpeed('1x', 460, { headwindMps: 5 }).speedMps.value;
  assert.ok(headwind < single, 'headwind slows the boat');
  assert.ok(single - headwind < 0.6, 'but plausibly (< ~0.6 m/s at 5 m/s wind)');
  assert.ok(crewSyncFactor(8) < crewSyncFactor(1));
  assert.ok(dragConstant('1x', { avgRowerKg: 100 }) > dragConstant('1x', { avgRowerKg: 70 }), 'heavier crew → more wetted surface');
  assert.equal(boatSpeed('1x', 0), null);
});

/* ------------------------------- energy ------------------------------- */

test('energy accounting: work, calories, and system split', () => {
  const e = energyExpenditure({ avgPowerWatts: 200, totalTimeS: 1800 });
  assert.ok(Math.abs(e.mechanicalWorkKj.value - 360) < 1, '200W × 1800s = 360 kJ');
  assert.ok(Math.abs(e.metabolicWorkKj.value - 1800) < 10, '360/0.20 = 1800 kJ metabolic');
  assert.ok(e.calories.value > 400 && e.calories.value < 520, `30min @200W ≈ 430–470 kcal, got ${e.calories.value}`);
  assert.equal(e.grossEfficiency.provenance, 'assumed');
  assert.equal(e.powerSource, 'measured-watts');
  assert.equal(energyExpenditure({ avgSplitS: 120, totalTimeS: 600 }).powerSource, 'pace-derived');
  assert.equal(energyExpenditure({ totalTimeS: 0 }), null);

  // Aerobic share grows monotonically with duration and hits the anchors.
  const at = (t) => energySystemSplit(t).aerobic.value;
  assert.ok(at(60) > 0.4 && at(60) < 0.6, `~50% at 1min, got ${at(60)}`);
  assert.ok(at(400) > 0.7 && at(400) < 0.9, `~80% at 2k duration, got ${at(400)}`);
  assert.ok(at(3600) > 0.94, `~98% at 1h, got ${at(3600)}`);
  assert.ok(at(60) < at(400) && at(400) < at(3600));
  const s = energySystemSplit(300);
  const sum = s.aerobic.value + s.glycolytic.value + s.alactic.value;
  assert.ok(Math.abs(sum - 1) < 0.02, `fractions sum to 1, got ${sum}`);
});

/* ------------------------------ recovery ------------------------------ */

test('recovery kinetics: monotone decay, load/intensity scaling, personal τ', () => {
  const hard = recoveryKinetics({ trainingLoad: 90, intensityFactor: 1.0 });
  const easy = recoveryKinetics({ trainingLoad: 30, intensityFactor: 0.65 });
  assert.ok(hard.residualAt(0).overall > easy.residualAt(0).overall);
  const r0 = hard.residualAt(0).overall, r24 = hard.residualAt(24).overall, r72 = hard.residualAt(72).overall;
  assert.ok(r0 > r24 && r24 > r72 && r72 >= 0, 'residual fatigue only ever decays');
  assert.ok(hard.hoursToRecover(10) > easy.hoursToRecover(10));
  // Slow personal recovery stretches the clock.
  const slow = recoveryKinetics({ trainingLoad: 90, intensityFactor: 1.0, personalHalfLifeH: 36 });
  assert.ok(slow.hoursToRecover(10) > hard.hoursToRecover(10));
  // Neural fatigue outlasts cardiovascular after intense work.
  assert.ok(hard.residualAt(48).neural > hard.residualAt(48).cardiovascular);
  noNaN(hard.residualAt(1000));
});

/* ----------------------------- translation ----------------------------- */

test('erg→boat chain: plausible predictions, explainable links', () => {
  // A 6:30 2k erg in a single: on-water prognosis should land ~7:00–8:15.
  const tr = ergToBoat({ erg2kSeconds: 390, boatClass: '1x', avgRowerKg: 85, waterExperience: 'intermediate' });
  assert.ok(tr.available);
  assert.ok(tr.predictedTimeS.value > 420 && tr.predictedTimeS.value < 495,
    `6:30 erg → 7:00–8:15 water 1x, got ${tr.predictedTime}`);
  assert.equal(tr.predictedTimeS.provenance, 'predicted');
  assert.ok(tr.chain.length >= 4, 'every link of the chain is reported');
  assert.ok(tr.assumptions.length >= 3);

  // An eight with the same athletes is much faster than the single.
  const eight = ergToBoat({ erg2kSeconds: 390, boatClass: '8+', avgRowerKg: 85, waterExperience: 'intermediate' });
  assert.ok(eight.predictedTimeS.value < tr.predictedTimeS.value - 40);

  // Headwind slows the prediction; tailwind speeds it (wind direction =
  // where it comes FROM: from dead ahead of a 0°-heading boat = headwind).
  const head = ergToBoat({ erg2kSeconds: 390, boatClass: '1x', environment: { windSpeedMps: 4, windDirectionDeg: 0, headingDeg: 0 } });
  const tail = ergToBoat({ erg2kSeconds: 390, boatClass: '1x', environment: { windSpeedMps: 4, windDirectionDeg: 180, headingDeg: 0 } });
  assert.ok(head.predictedTimeS.value > tail.predictedTimeS.value);

  assert.equal(ergToBoat({}).available, false, 'no anchor → honest refusal');
  assert.throws(() => ergToBoat({ erg2kSeconds: 390, boatClass: 'kayak' }), /Unknown boat class/);
});

/* ---------------------------- decomposition ---------------------------- */

test('performance decomposition attributes and explains', () => {
  const workout = { total_time_s: 420, avg_split_s: 105, avg_power_watts: null };
  const d = decomposePerformance(workout, {
    criticalPowerW: 230, wPrimeJ: 15000, readinessScore: 60,
    features: { pace_cv_pct: 4, pace_first_last_delta_s: 6, rate_cv_pct: 5 },
  });
  assert.ok(d.available);
  assert.ok(d.expectedWatts > 0);
  assert.ok(d.executionPenaltyPct.value > 0, 'a 6s fade costs something');
  assert.ok(d.freshnessPct.value < 0, 'readiness 60 → fatigue worked against them');
  assert.ok(d.aerobicSharePct.value + d.anaerobicSharePct.value > 95);
  assert.ok(d.explanation.length > 20);
  assert.equal(decomposePerformance({ total_time_s: 10 }, {}).available, false);
  // Without CP state: still decomposes what it can, honestly.
  const bare = decomposePerformance(workout, { features: {} });
  assert.ok(bare.available);
  assert.equal(bare.vsExpectedPct, null);
  assert.equal(bare.executionPenaltyPct.provenance, 'assumed');
  noNaN(bare);
});

/* ----------------------- stability under garbage ----------------------- */

test('numerical stability: garbage in, nulls/errors out — never NaN', () => {
  noNaN(estimateCriticalPower([{ total_time_s: Infinity, avg_power_watts: NaN }], {}));
  noNaN(decomposeStroke({ avgRate: NaN, forceCurves: [{ samples: [NaN, NaN, NaN] }] }));
  noNaN(airDensity({ temperatureC: 1e9, altitudeM: -1e9 }));
  noNaN(energySystemSplit(-50));
  noNaN(recoveryKinetics({ trainingLoad: NaN, intensityFactor: Infinity }));
  const bs = boatSpeed('1x', 1e9, {});
  assert.ok(Number.isFinite(bs.speedMps.value), 'even absurd power resolves to a finite (clamped-bisection) speed');
});
