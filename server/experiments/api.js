// Experiments API.
//
// Athlete surface (/api/experiments): consent management (opt in / pause /
// opt out / delete contributions), proposals, accept/decline/stop — all
// strictly own-data. Admin surface (validationRouter, mounted at
// /api/research-admin/validation): model scorecards, hypothesis registry,
// knowledge graph, notebook export — aggregate only, no athlete identity.
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, verifiedRequired, researchAdminRequired, audit } from '../middleware.js';
import { rateLimit } from '../ratelimit.js';
import { ApiError, badRequest, now } from '../util.js';
import { enqueue } from '../kernel/jobs.js';
import { proposeExperiment, presentExperiment, TEMPLATES } from './planner.js';
import { appendNotebook, exportNotebook, readNotebook } from './notebook.js';
import { listHypotheses } from './hypothesisRegistry.js';
import { modelScorecards } from './modelComparison.js';
import { graphStats, exportGraph } from './knowledgeGraph.js';

export const experimentsRouter = Router();
experimentsRouter.use(authRequired, verifiedRequired);

/* ------------------------------ consent ------------------------------ */

experimentsRouter.get('/consent', (req, res) => {
  res.json({
    status: req.user.experiment_consent || 'none',
    since: req.user.experiment_consent_at || null,
    explanation: 'Experiments are optional protocols that rearrange training you already do to answer a scientific question. You can pause or stop at any time; stopping never affects any other feature.',
  });
});

experimentsRouter.post('/consent', (req, res) => {
  const status = String(req.body?.status || '');
  if (!['active', 'paused', 'none'].includes(status)) throw badRequest('status must be active, paused, or none.');
  db.prepare('UPDATE users SET experiment_consent = ?, experiment_consent_at = ? WHERE id = ?')
    .run(status, now(), req.user.id);
  // Leaving active participation stops any running experiment immediately.
  if (status !== 'active') {
    const stopped = db.prepare(
      "UPDATE experiments SET status = 'stopped', stop_reason = 'consent-withdrawn' WHERE user_id = ? AND status IN ('proposed','active')")
      .run(req.user.id);
    if (stopped.changes) appendNotebook('experiment-stopped', null, { reason: 'consent-withdrawn', automatic: true });
  }
  res.json({ ok: true, status });
});

/** Privacy: remove this athlete's experiment records entirely. Aggregated
    hypothesis updates are anonymous and irreversible; the personal rows go. */
experimentsRouter.delete('/contributions', (req, res) => {
  const r = db.prepare('DELETE FROM experiments WHERE user_id = ?').run(req.user.id);
  appendNotebook('privacy-deletion', null, { experimentsDeleted: r.changes });
  res.json({ ok: true, deleted: r.changes });
});

/* --------------------------- lifecycle (own) --------------------------- */

experimentsRouter.get('/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM experiments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(req.user.id);
  res.json({ experiments: rows.map(presentExperiment), templates: Object.keys(TEMPLATES) });
});

experimentsRouter.post('/propose', rateLimit('experiment_propose', 10, 60 * 60 * 1000), (req, res) => {
  const result = proposeExperiment(req.user, { templateKey: req.body?.template || null });
  res.status(result.proposed ? 201 : 200).json(result);
});

experimentsRouter.post('/:id/accept', (req, res) => {
  const exp = db.prepare("SELECT * FROM experiments WHERE id = ? AND user_id = ? AND status = 'proposed'").get(req.params.id, req.user.id);
  if (!exp) throw new ApiError(404, 'No proposed experiment with that id.', 'not_found');
  if (req.user.experiment_consent !== 'active') throw badRequest('Experiment participation is not enabled.');
  const protocol = JSON.parse(exp.protocol_json);
  const startedAt = now();
  const endsAt = startedAt + (protocol.durationDays || 28) * 86400;
  db.prepare("UPDATE experiments SET status = 'active', started_at = ?, ends_at = ? WHERE id = ?").run(startedAt, endsAt, exp.id);
  // Outcome evaluation runs itself when the window closes.
  enqueue('experiments.evaluate', { userId: req.user.id, payload: { experimentId: exp.id }, delaySeconds: endsAt - startedAt, priority: 8 });
  appendNotebook('experiment-accepted', exp.id, { template: exp.template, endsAt });
  res.json({ ok: true, startedAt, endsAt });
});

experimentsRouter.post('/:id/decline', (req, res) => {
  const r = db.prepare("UPDATE experiments SET status = 'declined' WHERE id = ? AND user_id = ? AND status = 'proposed'").run(req.params.id, req.user.id);
  if (!r.changes) throw new ApiError(404, 'No proposed experiment with that id.', 'not_found');
  res.json({ ok: true });
});

experimentsRouter.post('/:id/stop', (req, res) => {
  const r = db.prepare("UPDATE experiments SET status = 'stopped', stop_reason = 'athlete' WHERE id = ? AND user_id = ? AND status = 'active'").run(req.params.id, req.user.id);
  if (!r.changes) throw new ApiError(404, 'No active experiment with that id.', 'not_found');
  appendNotebook('experiment-stopped', req.params.id, { reason: 'athlete', automatic: false });
  res.json({ ok: true });
});

/* ----------------------- validation (admin only) ----------------------- */

export const validationRouter = Router();
validationRouter.use(authRequired, researchAdminRequired);

validationRouter.get('/overview', (req, res) => {
  audit(req.user.id, 'research.validation.view', null, {});
  const experimentStats = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) n FROM experiments GROUP BY status').all().map(r => [r.status, r.n]));
  const transitions = db.prepare('SELECT model_name, from_version, to_version, reason, created_at FROM model_transitions ORDER BY created_at DESC LIMIT 20').all();
  res.json({
    scorecards: modelScorecards(),
    hypotheses: listHypotheses().map(h => ({
      id: h.id, statement: h.statement, originModel: h.originModel,
      confidence: h.confidence, priorConfidence: h.priorConfidence,
      observations: h.validationHistory.length,
      lastUpdate: h.validationHistory[h.validationHistory.length - 1] || null,
    })),
    graph: graphStats(),
    experiments: experimentStats,
    transitions,
    notebookRecent: readNotebook({ limit: 20 }),
  });
});

validationRouter.get('/notebook', (req, res) => {
  audit(req.user.id, 'research.validation.notebook.export', null, {});
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="rowpoint-lab-notebook.json"');
  res.send(JSON.stringify(exportNotebook(), null, 2));
});

validationRouter.get('/graph', (req, res) => {
  audit(req.user.id, 'research.validation.graph.export', null, {});
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="rowpoint-knowledge-graph.json"');
  res.send(JSON.stringify(exportGraph(), null, 2));
});
