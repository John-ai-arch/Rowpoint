// Digital Twin API — strictly own-data.
//
// Every route serves the AUTHENTICATED athlete's own state; there is no
// parameterized user id anywhere in this router, so cross-athlete access is
// impossible by construction. Aggregate/anonymous research views live behind
// the research-admin role in the research platform, never here.
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, verifiedRequired } from '../middleware.js';
import { rateLimit } from '../ratelimit.js';
import { safeJson, badRequest } from '../util.js';
import { stateWithMeta, variableHistory, explainVariable } from './store.js';
import { STATE_MODEL } from './state.js';
import { enqueue, jobsForUser } from '../kernel/jobs.js';

export const twinRouter = Router();
twinRouter.use(authRequired, verifiedRequired);

const CAT_RE = /^[a-zA-Z]{1,32}$/;

/** Current state, grouped by category, each variable a full Estimate + meta. */
twinRouter.get('/state', (req, res) => {
  const state = stateWithMeta(req.user.id);
  const latestPrediction = db.prepare(
    "SELECT payload_json, model_version, confidence, created_at FROM predictions WHERE user_id = ? AND kind = 'race' ORDER BY created_at DESC LIMIT 1")
    .get(req.user.id);
  const lastSnapshot = db.prepare(
    'SELECT created_at FROM state_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
  res.json({
    state,
    model: STATE_MODEL,
    racePrediction: latestPrediction ? {
      ...safeJson(latestPrediction.payload_json, {}),
      modelVersion: latestPrediction.model_version,
      generatedAt: latestPrediction.created_at,
    } : null,
    lastUpdatedAt: lastSnapshot?.created_at ?? null,
  });
});

/** Snapshot series for one variable (charts). */
twinRouter.get('/history', (req, res) => {
  const { category, variable } = req.query;
  if (!CAT_RE.test(String(category || '')) || !CAT_RE.test(String(variable || ''))) {
    throw badRequest('category and variable are required.');
  }
  res.json({ points: variableHistory(req.user.id, category, variable) });
});

/** Evidence trail: which inferences produced this variable's value. */
twinRouter.get('/explain', (req, res) => {
  const { category, variable } = req.query;
  if (!CAT_RE.test(String(category || '')) || !CAT_RE.test(String(variable || ''))) {
    throw badRequest('category and variable are required.');
  }
  res.json({
    meta: STATE_MODEL[category]?.[variable] || null,
    evidence: explainVariable(req.user.id, category, variable),
  });
});

/** Pipeline status: this athlete's recent twin jobs. */
twinRouter.get('/status', (req, res) => {
  res.json({ jobs: jobsForUser(req.user.id, 10).filter(j => j.kind.startsWith('twin.')) });
});

/** Recompute everything from full history. Job-backed; heavily rate-limited. */
twinRouter.post('/rebuild', rateLimit('twin_rebuild', 3, 60 * 60 * 1000), (req, res) => {
  const jobId = enqueue('twin.rebuild', { userId: req.user.id, priority: 6 });
  res.status(202).json({ ok: true, jobId });
});
