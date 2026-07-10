// Bayesian belief updating for hypotheses — Beta-Bernoulli conjugacy.
//
// A hypothesis's confidence is the posterior mean α/(α+β) of a Beta
// distribution over "observations consistent with the hypothesis". Priors
// encode the original modeling judgement (e.g. confidence 0.6 ⇒ Beta(6,4)
// at prior strength 10). Every update appends to the validation history and
// the lab notebook — uncertainty is never hidden and never rewritten.
import { db } from '../db.js';
import { now, safeJson } from '../util.js';
import { appendNotebook } from './notebook.js';

export const BAYES_VERSION = 'experiments.bayes@1.0';

/** Prior pseudo-observation count: how firmly the original judgement holds. */
export const PRIOR_STRENGTH = 10;

export function priorToAlphaBeta(priorConfidence, strength = PRIOR_STRENGTH) {
  const c = Math.min(Math.max(priorConfidence, 0.05), 0.95);
  return { alpha: c * strength, beta: (1 - c) * strength };
}

/**
 * Record one observation for a hypothesis.
 * @param {string} hypothesisId
 * @param {boolean} supported   did the evidence agree with the hypothesis?
 * @param {object} evidence     { source, detail, weight? } — weight in (0,1]
 *                              lets weak evidence count fractionally
 */
export function updateHypothesis(hypothesisId, supported, evidence) {
  const h = db.prepare('SELECT * FROM hypotheses WHERE id = ?').get(hypothesisId);
  if (!h) throw new Error(`Unknown hypothesis: ${hypothesisId}`);
  const weight = Math.min(Math.max(Number(evidence?.weight) || 1, 0.1), 1);
  const alpha = h.alpha + (supported ? weight : 0);
  const beta = h.beta + (supported ? 0 : weight);
  const confidence = alpha / (alpha + beta);

  const history = safeJson(h.validation_history_json, []) || [];
  history.push({
    at: now(),
    supported,
    weight,
    source: String(evidence?.source || 'unknown').slice(0, 120),
    detail: String(evidence?.detail || '').slice(0, 300),
    confidenceBefore: round3(h.confidence),
    confidenceAfter: round3(confidence),
  });

  db.prepare(`UPDATE hypotheses SET alpha = ?, beta = ?, confidence = ?,
      validation_history_json = ?, updated_at = ? WHERE id = ?`)
    .run(alpha, beta, round3(confidence), JSON.stringify(history.slice(-100)), now(), hypothesisId);

  appendNotebook('hypothesis-update', hypothesisId, {
    statement: h.statement,
    supported,
    weight,
    evidence: { source: evidence?.source, detail: evidence?.detail },
    confidence: { before: round3(h.confidence), after: round3(confidence) },
    posterior: { alpha: round3(alpha), beta: round3(beta) },
    version: BAYES_VERSION,
  });

  return { confidence: round3(confidence), alpha, beta, delta: round3(confidence - h.confidence) };
}

/** Uncertainty of a hypothesis in [0,1]: 1 at confidence 0.5, 0 at 0 or 1. */
export function hypothesisUncertainty(confidence) {
  return 1 - Math.abs(2 * confidence - 1);
}

const round3 = (v) => Math.round(v * 1000) / 1000;
