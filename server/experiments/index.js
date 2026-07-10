// Autonomous Experimental Design & Validation Engine — wiring.
//
// Seeds the hypothesis registry and knowledge graph, defines the evaluation
// job, and connects the validation loops to platform events:
//   workout.saved       → race predictions scored against real 2k outcomes
//   twin.updated        → active experiments checked against stopping conditions
//   research.finding-reviewed → approved discovery findings update the
//                               mapped hypothesis and the knowledge graph
// The engine also provides an 'ai.suggestion-advisor' so the daily coach can
// surface an active experiment's session — clearly labeled, never silently.
import { db } from '../db.js';
import { logger } from '../log.js';
import { register } from '../kernel/registry.js';
import { on, defineEvent } from '../kernel/events.js';
import { defineJob } from '../kernel/jobs.js';
import { provide } from '../kernel/providers.js';
import { safeJson } from '../util.js';
import { seedHypotheses, SEED_HYPOTHESES, FINDING_HYPOTHESIS_MAP } from './hypothesisRegistry.js';
import { seedGraph, ensureNode, ensureEdge } from './knowledgeGraph.js';
import { updateHypothesis } from './bayes.js';
import { checkStoppingConditions } from './planner.js';
import { evaluateExperiment } from './evaluator.js';
import { validateRacePrediction } from './modelComparison.js';
export { experimentsRouter, validationRouter } from './api.js';

const log = logger('experiments');

const COMPONENTS = [
  ['experiments.hypothesis-registry', 'model', 'Model assumptions as first-class Bayesian-updated objects'],
  ['experiments.bayes', 'algorithm', 'Beta-Bernoulli hypothesis confidence updating'],
  ['experiments.knowledge-graph', 'model', 'Versioned knowledge graph of models, assumptions, variables, findings'],
  ['experiments.planner', 'algorithm', 'Safety-bounded, information-gain-ranked experiment protocols'],
  ['experiments.evaluator', 'algorithm', 'A/B outcome evaluation with honest small-n statistics'],
  ['experiments.model-validation', 'algorithm', 'Prediction-vs-outcome scoring, calibration, promotion rule'],
  ['experiments.notebook', 'model', 'Append-only digital lab notebook'],
];

let initialized = false;

export function initExperimentsEngine() {
  if (initialized) return;
  initialized = true;

  for (const [name, kind, description] of COMPONENTS) register({ name, kind, version: '1.0', description });
  seedHypotheses();
  seedGraph(SEED_HYPOTHESES);
  defineEvent('research.finding-reviewed');

  defineJob('experiments.evaluate', {
    maxAttempts: 2,
    coalesce: false, // each experiment evaluates exactly once
    async handler({ payload }) {
      const outcome = evaluateExperiment(payload.experimentId);
      if (outcome) log.info(`experiment ${payload.experimentId} evaluated: ${outcome.conclusion}`);
    },
  });

  // Real outcomes score real predictions (the meta-learning loop).
  on('workout.saved', 'experiments', ({ userId, workoutId }) => {
    const workout = db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId);
    if (workout) validateRacePrediction(userId, workout);
  });

  // Safety: every twin refresh re-checks active experiments' stop conditions.
  on('twin.updated', 'experiments', ({ userId }) => {
    const result = checkStoppingConditions(userId);
    if (result?.stopped) log.info(`experiment auto-stopped for ${userId}: ${result.reason}`);
  });

  // Approved discovery findings are evidence for the mapped hypotheses.
  on('research.finding-reviewed', 'experiments', ({ action, kind, title, effect }) => {
    if (action !== 'approve') return;
    const mapper = FINDING_HYPOTHESIS_MAP[kind];
    const hypothesisId = mapper ? mapper(title) : null;
    if (!hypothesisId) return;
    try {
      // Population-level exploratory evidence: moderate weight, scaled by effect.
      const weight = Math.min(0.8, Math.max(0.3, Math.abs(effect ?? 0.3)));
      updateHypothesis(hypothesisId, true, { source: 'discovery-finding-approved', detail: title, weight });
      const fNode = ensureNode('finding', title.slice(0, 120));
      const hNode = ensureNode('hypothesis', hypothesisId);
      ensureEdge(fNode, hNode, 'supports', { confidence: Math.abs(effect ?? 0.3), evidenceSource: 'discovery', modelVersion: 'discovery.hypotheses@1.0' });
    } catch (e) {
      log.error(`finding→hypothesis update failed: ${e.message}`);
    }
  });

  // The daily coach surfaces an active experiment's context — labeled.
  provide('ai.suggestion-advisor', {
    name: 'experiments',
    advise(user) {
      if (user.experiment_consent !== 'active') return null;
      const exp = db.prepare("SELECT * FROM experiments WHERE user_id = ? AND status = 'active'").get(user.id);
      if (!exp) return null;
      const protocol = safeJson(exp.protocol_json, {});
      const week = exp.started_at ? Math.floor((Math.floor(Date.now() / 1000) - exp.started_at) / (7 * 86400)) + 1 : 1;
      const arm = week <= (protocol.durationDays || 28) / 7 / 2 ? 'A' : 'B';
      return {
        kind: 'experiment',
        experimentId: exp.id,
        title: protocol.title,
        note: `Active experiment (week ${week}, arm ${arm}): ${protocol.arms?.[arm] || protocol.objective}`,
        optional: true,
      };
    },
  });
}
