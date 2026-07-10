// Physics API — strictly own-data, like every athlete-facing engine route.
//
// Twin state (CP, W′, readiness, recovery half-life) is read through the
// 'twin.state-access' provider contract, never by importing twin code — the
// engines stay decoupled even where their data meets.
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, verifiedRequired } from '../middleware.js';
import { ApiError, badRequest, safeJson } from '../util.js';
import { providersOf } from '../kernel/providers.js';
import { decomposeStroke, profileSmoothness } from './stroke.js';
import { energyExpenditure } from './energy.js';
import { recoveryKinetics } from './recovery.js';
import { decomposePerformance } from './decomposition.js';
import { ergToBoat } from './translation.js';
import { BOAT_CLASSES } from './boat.js';

export const physicsRouter = Router();
physicsRouter.use(authRequired, verifiedRequired);

function twinState(userId) {
  const provider = providersOf('twin.state-access')[0];
  return provider ? provider.getState(userId) : {};
}

const stateVal = (state, cat, v) => state?.[cat]?.[v]?.value ?? null;

/** Full physics analysis of one of the athlete's own workouts. */
physicsRouter.get('/workout/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM workouts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!w) throw new ApiError(404, 'Workout not found.', 'not_found');
  const curves = db.prepare('SELECT samples_json FROM force_curves WHERE workout_id = ? ORDER BY stroke_index').all(w.id)
    .map(c => ({ samples: safeJson(c.samples_json, []) }));
  const features = Object.fromEntries(
    db.prepare('SELECT feature, value FROM feature_cache WHERE workout_id = ?').all(w.id).map(r => [r.feature, r.value]));
  const state = twinState(req.user.id);

  const stroke = decomposeStroke({ avgRate: w.avg_stroke_rate, forceCurves: curves });
  const energy = energyExpenditure({ avgPowerWatts: w.avg_power_watts, avgSplitS: w.avg_split_s, totalTimeS: w.total_time_s });
  const recovery = recoveryKinetics({
    trainingLoad: features.training_load,
    intensityFactor: features.intensity_factor,
    personalHalfLifeH: stateVal(state, 'recovery', 'recoveryHalfLifeH') ?? 24,
  });
  const decomposition = decomposePerformance(w, {
    criticalPowerW: stateVal(state, 'power', 'criticalPowerW'),
    wPrimeJ: stateVal(state, 'power', 'wPrimeJ'),
    readinessScore: stateVal(state, 'readiness', 'score'),
    features,
  });

  res.json({
    workoutId: w.id,
    stroke,
    forceSmoothness: profileSmoothness(curves),
    energy,
    recovery: {
      systems: recovery.systems,
      residualIn12h: recovery.residualAt(12),
      residualIn24h: recovery.residualAt(24),
      residualIn48h: recovery.residualAt(48),
      hoursToRecover: recovery.hoursToRecover(10),
    },
    decomposition,
  });
});

/** Boat classes the translation model supports (for UI selectors). */
physicsRouter.get('/boat-classes', (req, res) => {
  res.json({ classes: Object.keys(BOAT_CLASSES) });
});

/** Erg → on-water projection from the athlete's own state. */
physicsRouter.get('/translation', (req, res) => {
  const boatClass = String(req.query.boatClass || '1x');
  if (!BOAT_CLASSES[boatClass]) throw badRequest('Unknown boat class.');
  const raceDistanceM = Math.min(Math.max(Number(req.query.distanceM) || 2000, 500), 10000);
  const state = twinState(req.user.id);
  const experienceMap = { erg: 'novice', mixed: 'intermediate', water: 'advanced' };
  const result = ergToBoat({
    erg2kSeconds: req.user.best_2k_seconds || null,
    criticalPowerW: stateVal(state, 'power', 'criticalPowerW'),
    wPrimeJ: stateVal(state, 'power', 'wPrimeJ'),
    boatClass,
    raceDistanceM,
    avgRowerKg: req.user.weight_kg || 80,
    waterExperience: experienceMap[req.user.training_environment] || undefined,
    environment: {
      temperatureC: numOrUndef(req.query.temperatureC),
      windSpeedMps: numOrUndef(req.query.windSpeedMps),
      windDirectionDeg: numOrUndef(req.query.windDirectionDeg),
      headingDeg: numOrUndef(req.query.headingDeg),
      currentMps: numOrUndef(req.query.currentMps),
      waterTemperatureC: numOrUndef(req.query.waterTemperatureC),
      altitudeM: numOrUndef(req.query.altitudeM),
    },
  });
  res.json({ translation: result });
});

const numOrUndef = (v) => (v === undefined || v === '' ? undefined : Number(v));
