// Experiment outcome evaluation — honest, small-n statistics.
//
// When an experiment window closes, the designated outcome metric is
// compared between arm A (first half) and arm B (second half) using the
// athlete's cached workout features. Direction + Welch p decide whether the
// outcome supports or contradicts the hypothesis; underpowered or ambiguous
// results are recorded as INCONCLUSIVE and move no beliefs. Every outcome —
// including inconclusive ones — lands in the notebook.
import { db } from '../db.js';
import { safeJson } from '../util.js';
import { welchT, cohensD, mean } from '../kernel/stats.js';
import { emit } from '../kernel/events.js';
import { updateHypothesis } from './bayes.js';
import { appendNotebook } from './notebook.js';

export const EVALUATOR_VERSION = 'experiments.evaluator@1.0';

/**
 * Per-template outcome specs: which workouts count, what metric is measured
 * on each, and which direction supports the hypothesis in arm B.
 */
const OUTCOME_SPECS = {
  'rest-interval-quality': {
    filter: (f, plan) => plan?.type === 'intervals' && Number.isFinite(f.pace_cv_pct),
    metric: (f) => f.pace_cv_pct,
    supportsWhenB: 'lower', // longer rest → steadier pace
    label: 'within-session pace CV (%) on interval workouts',
  },
  'steady-volume-block': {
    filter: (f) => Number.isFinite(f.pace_avg_split_s) && Number.isFinite(f.hr_avg_bpm) && f.hr_avg_bpm > 0,
    metric: (f) => (30000 / f.pace_avg_split_s) / f.hr_avg_bpm, // m/min per bpm
    supportsWhenB: 'higher', // more steady volume → better aerobic efficiency
    label: 'aerobic efficiency (m/min per bpm)',
  },
  'hard-session-spacing': {
    filter: (f) => Number.isFinite(f.intensity_factor) && f.intensity_factor > 0.85 && Number.isFinite(f.pace_avg_split_s),
    metric: (f) => f.pace_avg_split_s,
    supportsWhenB: 'lower', // more recovery → faster hard sessions
    label: 'average split (s/500m) on hard sessions',
  },
};

function windowValues(userId, spec, fromS, toS) {
  const workouts = db.prepare(
    'SELECT id, workout_plan_json FROM workouts WHERE user_id = ? AND started_at >= ? AND started_at < ?')
    .all(userId, fromS, toS);
  const values = [];
  for (const w of workouts) {
    const features = Object.fromEntries(
      db.prepare('SELECT feature, value FROM feature_cache WHERE workout_id = ?').all(w.id).map(r => [r.feature, r.value]));
    const plan = safeJson(w.workout_plan_json, null);
    if (!spec.filter(features, plan)) continue;
    const v = spec.metric(features);
    if (Number.isFinite(v)) values.push(v);
  }
  return values;
}

/** Evaluate and close one experiment. Returns the outcome record. */
export function evaluateExperiment(experimentId) {
  const exp = db.prepare("SELECT * FROM experiments WHERE id = ? AND status = 'active'").get(experimentId);
  if (!exp) return null;
  const spec = OUTCOME_SPECS[exp.template];
  const mid = Math.floor((exp.started_at + exp.ends_at) / 2);
  const armA = spec ? windowValues(exp.user_id, spec, exp.started_at, mid) : [];
  const armB = spec ? windowValues(exp.user_id, spec, mid, exp.ends_at) : [];

  let outcome;
  if (!spec || armA.length < 4 || armB.length < 4) {
    outcome = {
      version: EVALUATOR_VERSION,
      conclusion: 'inconclusive',
      reason: `too few qualifying workouts per arm (A=${armA.length}, B=${armB.length}, need ≥4 each)`,
      armA: { n: armA.length }, armB: { n: armB.length },
    };
  } else {
    const w = welchT(armA, armB);
    const d = cohensD(armB, armA); // + = B higher
    const bIsBetter = spec.supportsWhenB === 'higher' ? mean(armB) > mean(armA) : mean(armB) < mean(armA);
    const decisive = w && w.p < 0.2 && Math.abs(d ?? 0) >= 0.3;
    outcome = {
      version: EVALUATOR_VERSION,
      measure: spec.label,
      armA: { n: armA.length, mean: round2(mean(armA)) },
      armB: { n: armB.length, mean: round2(mean(armB)) },
      effectD: round2(d),
      welchP: w ? round3(w.p) : null,
      conclusion: decisive ? (bIsBetter ? 'supported' : 'contradicted') : 'inconclusive',
      reason: decisive ? null : 'difference too small or too uncertain at this sample size',
      caveat: 'A/B arms are sequential, not randomized — time-order effects (fitness drift, season) are possible confounders.',
    };
  }

  let beliefUpdate = null;
  if (exp.hypothesis_id && outcome.conclusion !== 'inconclusive') {
    // Single-athlete evidence is weak by construction: capped weight.
    const weight = Math.min(0.5, Math.abs(outcome.effectD ?? 0.3) * 0.5);
    beliefUpdate = updateHypothesis(exp.hypothesis_id, outcome.conclusion === 'supported', {
      source: `experiment:${exp.template}`,
      detail: `${outcome.measure}: A ${outcome.armA.mean} vs B ${outcome.armB.mean} (d=${outcome.effectD}, p=${outcome.welchP})`,
      weight,
    });
  }

  db.prepare("UPDATE experiments SET status = 'completed', outcome_json = ? WHERE id = ?")
    .run(JSON.stringify(outcome), exp.id);
  appendNotebook('experiment-completed', exp.id, {
    template: exp.template,
    hypothesisId: exp.hypothesis_id,
    outcome,
    beliefUpdate,
  });
  emit('experiment.updated', { experimentId: exp.id, status: 'completed', conclusion: outcome.conclusion });
  return outcome;
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
