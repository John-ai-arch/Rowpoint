// Optimizer API — strictly own-data; runs are job-backed and rate-limited.
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, verifiedRequired } from '../middleware.js';
import { rateLimit } from '../ratelimit.js';
import { ApiError, badRequest, safeJson } from '../util.js';
import { enqueue } from '../kernel/jobs.js';
import { createRun } from './index.js';
import { buildProblem } from './problem.js';
import { sanitizePlanDays, evaluateCounterfactual } from './counterfactual.js';
import { OBJECTIVES } from './objectives.js';
import { SESSION_TYPES, DURATIONS } from './planSpace.js';
import { STRATEGIES } from './search/index.js';

export const optimizerRouter = Router();
optimizerRouter.use(authRequired, verifiedRequired);

/** Vocabulary for the Plan Explorer UI (types, durations, objectives). */
optimizerRouter.get('/meta', (req, res) => {
  res.json({
    sessionTypes: SESSION_TYPES,
    durations: DURATIONS,
    objectives: OBJECTIVES,
    strategies: Object.keys(STRATEGIES),
    horizons: [14, 28, 56, 84],
  });
});

/** Start an optimization run (background job). */
optimizerRouter.post('/run', rateLimit('optimizer_run', 6, 60 * 60 * 1000), (req, res) => {
  const b = req.body || {};
  const config = {
    horizonDays: Math.min(Math.max(Number(b.horizonDays) || 28, 7), 112),
    strategy: STRATEGIES[b.strategy] ? b.strategy : 'genetic',
    raceDate: typeof b.raceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.raceDate) ? b.raceDate : null,
    budget: Math.min(Math.max(Number(b.budget) || 1200, 200), 5000),
  };
  const runId = createRun(req.user.id, config);
  const jobId = enqueue('optimizer.run', { userId: req.user.id, payload: { runId }, priority: 5 });
  res.status(202).json({ ok: true, runId, jobId });
});

/** Own runs, newest first (compact list). */
optimizerRouter.get('/runs', (req, res) => {
  const rows = db.prepare(
    `SELECT id, kind, status, algorithm, created_at, finished_at, duration_ms, error
     FROM optimization_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.user.id);
  res.json({ runs: rows });
});

/** One run in full: frontier, tradeoffs, distributions, sensitivity. */
optimizerRouter.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM optimization_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!run) throw new ApiError(404, 'Run not found.', 'not_found');
  res.json({
    run: {
      id: run.id,
      kind: run.kind,
      status: run.status,
      algorithm: run.algorithm,
      seed: run.seed,
      config: safeJson(run.config_json, {}),
      versions: safeJson(run.versions_json, []),
      frontier: safeJson(run.frontier_json, []),
      sensitivity: safeJson(run.sensitivity_json, null),
      error: run.error,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
      durationMs: run.duration_ms,
    },
  });
});

/** What-if: evaluate an edited plan against a run's recommendation. */
optimizerRouter.post('/counterfactual', rateLimit('optimizer_whatif', 60, 60 * 60 * 1000), (req, res) => {
  const { runId, days } = req.body || {};
  const run = db.prepare('SELECT * FROM optimization_runs WHERE id = ? AND user_id = ?').get(String(runId || ''), req.user.id);
  if (!run) throw new ApiError(404, 'Run not found.', 'not_found');
  if (run.status !== 'completed') throw badRequest('Run has not completed.');
  const config = safeJson(run.config_json, {}) || {};
  const problem = buildProblem(req.user, config);
  let candidate;
  try { candidate = sanitizePlanDays(days, problem.horizonDays); }
  catch (e) { throw badRequest(e.message); }
  const frontier = safeJson(run.frontier_json, []) || [];
  const reference = frontier[0]?.days || null;
  res.json({ evaluation: evaluateCounterfactual(candidate, reference, problem) });
});
