// Model validation & comparison — the meta-learning loop.
//
// Every prediction the platform makes is a hypothesis about the future; when
// the future arrives, it gets scored. The concrete loop implemented here:
// a completed 2k benchmark is compared against the most recent race
// prediction that PRECEDED it — absolute error, signed bias, and whether the
// actual landed inside the predicted interval (calibration). Scores feed
// model_performance; the Riegel hypothesis gets a Bayesian update; and a
// documented promotion/retirement rule watches competing versions of the
// same model, recording every transition. Nothing here fabricates accuracy
// claims — with no real outcomes yet, dashboards honestly show n=0.
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { updateHypothesis } from './bayes.js';
import { appendNotebook } from './notebook.js';

export const VALIDATION_VERSION = 'experiments.model-validation@1.0';

/** Record one metric observation for a model version. */
export function recordPerformance(modelName, version, metric, value, detail = null) {
  db.prepare('INSERT INTO model_performance (id, model_name, version, metric, value, detail_json, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuid(), modelName, version, metric, value, detail ? JSON.stringify(detail) : null, now());
}

/**
 * Validate race predictions against an actual completed 2k.
 * Called from the workout.saved reaction when the workout is a 2k test.
 * Uses the newest 'race' prediction created BEFORE the workout started.
 */
export function validateRacePrediction(userId, workout) {
  const plan = safeJson(workout.workout_plan_json, null);
  if (!(plan?.type === 'distance' && Number(plan.distanceM) === 2000)) return null;
  if (!(Number(workout.total_distance_m) >= 2000) || !(Number(workout.total_time_s) > 300)) return null;

  const predRow = db.prepare(
    `SELECT * FROM predictions WHERE user_id = ? AND kind = 'race' AND created_at < ?
     ORDER BY created_at DESC LIMIT 1`).get(userId, workout.started_at);
  if (!predRow) return null;
  const pred = safeJson(predRow.payload_json, {});
  const p2k = pred?.predictions?.find(p => p.distance === 2000);
  if (!p2k) return null;

  const actual = Number(workout.total_time_s);
  const errorS = actual - p2k.timeS;                    // + = slower than predicted
  const withinInterval = actual >= p2k.lowS && actual <= p2k.highS;
  const [name, version] = (predRow.model_version || 'twin.predictor.race@1.0').split('@');

  recordPerformance(name, version, 'abs_error_s', Math.abs(Math.round(errorS * 10) / 10), {
    predicted: p2k.timeS, actual, confidence: predRow.confidence,
  });
  recordPerformance(name, version, 'signed_error_s', Math.round(errorS * 10) / 10);
  recordPerformance(name, version, 'interval_hit', withinInterval ? 1 : 0, {
    interval: [p2k.lowS, p2k.highS], actual, statedConfidence: predRow.confidence,
  });

  // The Riegel-model hypothesis learns from every real outcome; a hit inside
  // the interval supports it, a miss (weighted by how far) contradicts it.
  const missMagnitude = withinInterval ? 0 : Math.min(1, Math.abs(errorS) / Math.max(actual * 0.05, 5));
  updateHypothesis('riegel-endurance', withinInterval, {
    source: 'race-prediction-validation',
    detail: `predicted ${p2k.timeS}s [${p2k.lowS}–${p2k.highS}], actual ${Math.round(actual)}s`,
    weight: withinInterval ? 0.6 : Math.max(0.3, missMagnitude * 0.8),
  });

  appendNotebook('model-validation', predRow.id, {
    model: predRow.model_version, predicted: p2k.timeS,
    interval: [p2k.lowS, p2k.highS], actual: Math.round(actual),
    errorS: Math.round(errorS * 10) / 10, withinInterval,
    version: VALIDATION_VERSION,
  });
  return { errorS, withinInterval };
}

/**
 * Calibration & error summary per model version (validation dashboard).
 * Calibration compares the stated interval confidence with the observed hit
 * rate; honest n=0 when no outcomes exist yet.
 */
export function modelScorecards() {
  const models = db.prepare('SELECT DISTINCT model_name, version FROM model_performance ORDER BY model_name, version').all();
  return models.map(({ model_name, version }) => {
    const metric = (m) => db.prepare(
      'SELECT COUNT(*) n, AVG(value) mean FROM model_performance WHERE model_name = ? AND version = ? AND metric = ?')
      .get(model_name, version, m);
    const abs = metric('abs_error_s');
    const signed = metric('signed_error_s');
    const hits = metric('interval_hit');
    const statedConf = db.prepare(
      `SELECT AVG(json_extract(detail_json, '$.statedConfidence')) c FROM model_performance
       WHERE model_name = ? AND version = ? AND metric = 'interval_hit'`).get(model_name, version)?.c;
    return {
      model: model_name,
      version,
      outcomes: hits.n,
      meanAbsErrorS: abs.n ? Math.round(abs.mean * 10) / 10 : null,
      meanBiasS: signed.n ? Math.round(signed.mean * 10) / 10 : null,
      intervalHitRate: hits.n ? Math.round(hits.mean * 100) / 100 : null,
      statedConfidence: statedConf != null ? Math.round(statedConf * 100) / 100 : null,
      calibrationGap: hits.n && statedConf != null ? Math.round((hits.mean - statedConf) * 100) / 100 : null,
    };
  });
}

/** Promotion rule constants — documented, not folklore. */
export const PROMOTION_MIN_OUTCOMES = 20;
export const PROMOTION_MIN_IMPROVEMENT = 0.1; // ≥10% lower mean abs error

/**
 * Compare two versions of one model; promote the challenger when it has
 * enough outcomes and sustained superiority. Every transition is recorded
 * in model_transitions and the notebook. Returns the decision.
 */
export function evaluatePromotion(modelName, incumbentVersion, challengerVersion) {
  const cards = modelScorecards().filter(c => c.model === modelName);
  const inc = cards.find(c => c.version === incumbentVersion);
  const cha = cards.find(c => c.version === challengerVersion);
  if (!inc || !cha) return { decision: 'insufficient-data', reason: 'one of the versions has no recorded outcomes' };
  if (cha.outcomes < PROMOTION_MIN_OUTCOMES) {
    return { decision: 'wait', reason: `challenger has ${cha.outcomes}/${PROMOTION_MIN_OUTCOMES} required outcomes` };
  }
  if (inc.meanAbsErrorS === null || cha.meanAbsErrorS === null) return { decision: 'insufficient-data', reason: 'missing error metrics' };
  const improvement = (inc.meanAbsErrorS - cha.meanAbsErrorS) / Math.max(inc.meanAbsErrorS, 1e-9);
  if (improvement >= PROMOTION_MIN_IMPROVEMENT) {
    db.prepare('INSERT INTO model_transitions (id, model_name, from_version, to_version, reason, metrics_json, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), modelName, incumbentVersion, challengerVersion,
        `challenger mean abs error ${cha.meanAbsErrorS}s vs ${inc.meanAbsErrorS}s (${Math.round(improvement * 100)}% better over ${cha.outcomes} outcomes)`,
        JSON.stringify({ incumbent: inc, challenger: cha }), now());
    appendNotebook('model-transition', modelName, { from: incumbentVersion, to: challengerVersion, improvement: Math.round(improvement * 100) / 100 });
    return { decision: 'promote', improvement: Math.round(improvement * 100) / 100 };
  }
  return { decision: 'retain', reason: `challenger improvement ${Math.round(improvement * 100)}% below the ${PROMOTION_MIN_IMPROVEMENT * 100}% bar` };
}
