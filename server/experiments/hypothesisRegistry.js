// The hypothesis registry — every model assumption as a first-class object.
//
// Seeded with the documented assumptions the earlier engines rely on, each
// carrying its origin model, a prior confidence (the original modeling
// judgement), and a Beta posterior that evidence moves over time. New
// engines register additional hypotheses through ensureHypothesis; nothing
// here is ever hard-deleted (assumptions are retired by evidence, not by
// edit).
import { db } from '../db.js';
import { now, safeJson } from '../util.js';
import { priorToAlphaBeta } from './bayes.js';

export const REGISTRY_VERSION = 'experiments.hypothesis-registry@1.0';

/** The platform's documented modeling assumptions (Phases 1–3). */
export const SEED_HYPOTHESES = [
  {
    key: 'cp-2k-fraction',
    statement: 'Critical power is approximately 78% of an athlete\'s 2k average power for trained rowers.',
    originModel: 'physics.power@1.0', prior: 0.65,
  },
  {
    key: 'riegel-endurance',
    statement: 'Race times across 2k–6k follow a Riegel endurance curve with exponent ≈1.06.',
    originModel: 'twin.predictor.race@1.0', prior: 0.7,
  },
  {
    key: 'steady-volume-aerobic',
    statement: 'Higher steady-state (UT2/UT1) volume is associated with improving aerobic efficiency.',
    originModel: 'twin.model.efficiency@1.0', prior: 0.65,
  },
  {
    key: 'monotony-plateau',
    statement: 'High training monotony increases the probability of a performance plateau.',
    originModel: 'twin.model.adaptation@1.0', prior: 0.55,
  },
  {
    key: 'acwr-strain',
    statement: 'A sustained acute:chronic workload ratio ≥ 1.5 elevates strain/injury risk.',
    originModel: 'twin.model.injury-risk@1.0', prior: 0.6,
  },
  {
    key: 'recovery-half-life',
    statement: 'Post-session fatigue decays exponentially with a ~24 h population baseline half-life, modulated by sleep and soreness.',
    originModel: 'physics.recovery@1.0', prior: 0.55,
  },
  {
    key: 'taper-freshness',
    statement: 'Reducing load before a race raises race-day performance potential by shedding fatigue faster than fitness.',
    originModel: 'optimizer.simulate@1.0', prior: 0.7,
  },
  {
    key: 'longer-rest-interval-quality',
    statement: 'Longer recovery intervals between hard repetitions improve within-session interval quality (pace consistency).',
    originModel: 'experiments.planner@1.0', prior: 0.55,
  },
];

/** Idempotently create a hypothesis; returns its row id. */
export function ensureHypothesis({ key, statement, originModel, prior, populations = 'general' }) {
  const existing = db.prepare('SELECT id FROM hypotheses WHERE id = ?').get(key);
  if (existing) return key;
  const { alpha, beta } = priorToAlphaBeta(prior);
  db.prepare(`INSERT INTO hypotheses (id, statement, origin_model, alpha, beta, confidence, prior_confidence, populations, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(key, statement, originModel, alpha, beta, prior, prior, populations, now(), now());
  return key;
}

export function seedHypotheses() {
  for (const h of SEED_HYPOTHESES) ensureHypothesis(h);
  return SEED_HYPOTHESES.length;
}

export function getHypothesis(id) {
  const h = db.prepare('SELECT * FROM hypotheses WHERE id = ?').get(id);
  return h ? present(h) : null;
}

export function listHypotheses() {
  return db.prepare('SELECT * FROM hypotheses ORDER BY updated_at DESC').all().map(present);
}

function present(h) {
  return {
    id: h.id,
    statement: h.statement,
    originModel: h.origin_model,
    confidence: h.confidence,
    priorConfidence: h.prior_confidence,
    posterior: { alpha: h.alpha, beta: h.beta },
    populations: h.populations,
    validationHistory: safeJson(h.validation_history_json, []),
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  };
}

/** Discovery-finding → hypothesis mapping (evidence routing). */
export const FINDING_HYPOTHESIS_MAP = {
  correlation: (title) => {
    if (/volume/i.test(title)) return 'steady-volume-aerobic';
    if (/monotony/i.test(title)) return 'monotony-plateau';
    return null;
  },
  plateau: () => 'monotony-plateau',
  archetype: () => null, // descriptive — no single assumption to update
};
