// Discovery API — research-administrator only, every action audited.
// Mounted at /api/research-admin/discovery. Athletes and coaches can never
// reach any of this; findings leave the queue only through explicit human
// review, and exports contain approved findings only.
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, researchAdminRequired, audit } from '../middleware.js';
import { rateLimit } from '../ratelimit.js';
import { ApiError, badRequest, safeJson, now } from '../util.js';
import { enqueue } from '../kernel/jobs.js';
import { emit, defineEvent } from '../kernel/events.js';
import { discoveryStatus } from './analyses.js';
import { cohortSummary, COHORT_FILTERS } from './cohorts.js';
import { DISCOVERY_FEATURES, FEATURE_STORE_VERSION } from './featureStore.js';

export const discoveryRouter = Router();
discoveryRouter.use(authRequired, researchAdminRequired);

// Reviewed findings are platform events: the experiments engine routes
// approved ones into hypothesis-confidence updates (no direct coupling).
defineEvent('research.finding-reviewed');

/** Queue a discovery run (background job; heavy on big datasets). */
discoveryRouter.post('/run', rateLimit('discovery_run', 6, 60 * 60 * 1000), (req, res) => {
  audit(req.user.id, 'research.discovery.run', null, {});
  const jobId = enqueue('discovery.run', { payload: { trigger: 'admin' }, priority: 6 });
  res.status(202).json({ ok: true, jobId });
});

/** Engine status: latest analysis, queue counts, feature-store size. */
discoveryRouter.get('/status', (req, res) => {
  res.json({ status: discoveryStatus(), features: DISCOVERY_FEATURES, featureStoreVersion: FEATURE_STORE_VERSION });
});

/** Findings queue (pending | approved | dismissed). */
discoveryRouter.get('/findings', (req, res) => {
  const status = ['pending', 'approved', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
  audit(req.user.id, 'research.discovery.findings.view', null, { status });
  const rows = db.prepare(
    `SELECT f.*, a.dataset_snapshot, a.seed FROM research_findings f
     JOIN research_analyses a ON a.id = f.analysis_id
     WHERE f.status = ? ORDER BY f.created_at DESC LIMIT 50`).all(status);
  res.json({
    findings: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: safeJson(r.body_json, {}),
      status: r.status,
      reviewerNote: r.reviewer_note,
      reviewedAt: r.reviewed_at,
      datasetSnapshot: r.dataset_snapshot,
      seed: r.seed,
      createdAt: r.created_at,
    })),
  });
});

/** Human review: approve or dismiss, with an optional researcher note. */
discoveryRouter.post('/findings/:id/review', (req, res) => {
  const action = req.body?.action;
  if (!['approve', 'dismiss'].includes(action)) throw badRequest('action must be approve or dismiss.');
  const note = String(req.body?.note || '').slice(0, 1000) || null;
  const row = db.prepare("SELECT * FROM research_findings WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!row) throw new ApiError(404, 'Pending finding not found.', 'not_found');
  db.prepare('UPDATE research_findings SET status = ?, reviewer_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .run(action === 'approve' ? 'approved' : 'dismissed', note, req.user.id, now(), row.id);
  audit(req.user.id, `research.discovery.finding.${action}`, row.id, { note: !!note });
  const body = safeJson(row.body_json, {});
  emit('research.finding-reviewed', {
    action, kind: row.kind, title: row.title, effect: body?.stats?.effect ?? null,
  });
  res.json({ ok: true });
});

/** Research report: approved findings with full reproducibility references. */
discoveryRouter.get('/report', (req, res) => {
  const rows = db.prepare(
    `SELECT f.*, a.dataset_snapshot, a.seed, a.versions_json, a.config_json FROM research_findings f
     JOIN research_analyses a ON a.id = f.analysis_id
     WHERE f.status = 'approved' ORDER BY f.reviewed_at DESC`).all();
  audit(req.user.id, 'research.discovery.report.export', null, { findings: rows.length });
  const report = {
    generatedAt: now(),
    platform: 'RowPoint Scientific Discovery Engine',
    note: 'All findings are exploratory hypotheses from observational, pseudonymized, consented data. None establish causation.',
    findings: rows.map(r => ({
      title: r.title,
      kind: r.kind,
      ...safeJson(r.body_json, {}),
      reviewerNote: r.reviewer_note,
      reviewedAt: r.reviewed_at,
      reproducibility: {
        datasetSnapshot: r.dataset_snapshot,
        seed: r.seed,
        componentVersions: safeJson(r.versions_json, []),
        analysisConfig: safeJson(r.config_json, {}),
      },
    })),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="rowpoint-research-findings.json"');
  res.send(JSON.stringify(report, null, 2));
});

/** Anonymous cohort summary (k-anonymity gated inside). */
discoveryRouter.get('/cohort', (req, res) => {
  const filters = {};
  for (const f of COHORT_FILTERS) if (req.query[f]) filters[f] = String(req.query[f]);
  if (req.query.minWeeklyMinutes) filters.minWeeklyMinutes = Number(req.query.minWeeklyMinutes);
  if (req.query.improvingOnly) filters.improvingOnly = String(req.query.improvingOnly);
  audit(req.user.id, 'research.discovery.cohort.view', null, { filters });
  res.json({ cohort: cohortSummary(filters) });
});

/** Exclusion log for the latest analysis — nothing is silently dropped. */
discoveryRouter.get('/exclusions', (req, res) => {
  const latest = db.prepare("SELECT id FROM research_analyses WHERE kind = 'discovery' ORDER BY created_at DESC LIMIT 1").get();
  if (!latest) return res.json({ exclusions: [] });
  const rows = db.prepare('SELECT record_ref, reason FROM research_exclusions WHERE analysis_id = ? LIMIT 200').all(latest.id);
  res.json({ exclusions: rows });
});
