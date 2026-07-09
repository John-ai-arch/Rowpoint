// Research platform API (Feature C) — administrator-only. Strictly gated by
// researchAdminRequired; regular users can never reach any of it. EVERY action
// is written to the audit log. All responses are aggregate + min-cohort gated
// (server/research/analytics.js); no participant row, id, or credential ever
// appears here.
import { Router } from 'express';
import { db } from './db.js';
import { config } from './config.js';
import { authRequired, adminRequired, researchAdminRequired, audit, isResearchAdmin } from './middleware.js';
import {
  participantSummary, qualityReport, variableDistributions,
  correlationMatrix, longitudinalTrends,
} from './research/analytics.js';
import { dataDictionary } from './research/dictionary.js';
import { buildExport } from './research/export.js';

export const researchAdminRouter = Router();
researchAdminRouter.use(authRequired, researchAdminRequired);

function filters(q = {}) {
  return {
    sex: q.sex || null, ageRange: q.ageRange || null, weightClass: q.weightClass || null,
    competitionLevel: q.competitionLevel || null, clubType: q.clubType || null,
    trainingEnvironment: q.trainingEnvironment || null, country: q.country || null,
    minWeeklyMeters: q.minWeeklyMeters || null,
  };
}

// Log every research action with the applied filters (research audit trail).
function log(req, action, extra) {
  audit(req.user.id, `research.${action}`, null, { ...extra, filters: filters(req.query) });
}

researchAdminRouter.get('/participants', (req, res) => {
  log(req, 'participants.view');
  res.json({ participants: participantSummary(filters(req.query)) });
});

researchAdminRouter.get('/quality', (req, res) => {
  log(req, 'quality.view');
  res.json({ quality: qualityReport() });
});

researchAdminRouter.get('/variables', (req, res) => {
  log(req, 'variables.view');
  res.json({ distributions: variableDistributions(filters(req.query)) });
});

researchAdminRouter.get('/correlations', (req, res) => {
  log(req, 'correlations.view');
  res.json({ correlations: correlationMatrix(filters(req.query)) });
});

researchAdminRouter.get('/trends', (req, res) => {
  const variable = String(req.query.variable || 'weeklyMeters');
  log(req, 'trends.view', { variable });
  res.json({ trends: longitudinalTrends(variable) });
});

// Auto-generated data dictionary (variable definitions, units, methods).
researchAdminRouter.get('/dictionary', (req, res) => {
  log(req, 'dictionary.view');
  res.json({ dictionary: dataDictionary() });
});

// Anonymized dataset export (CSV / JSON). Only research admins; refuses exports
// that would reveal fewer than the minimum cohort. Every export is audited.
researchAdminRouter.get('/export', (req, res) => {
  const kind = ['workouts', 'participants', 'snapshots'].includes(req.query.kind) ? req.query.kind : 'workouts';
  const format = req.query.format === 'json' ? 'json' : 'csv';
  const f = filters(req.query);
  const out = buildExport({ kind, format, filters: f }); // throws 422 if cohort too small
  audit(req.user.id, 'research.export', kind, { format, filters: f, rows: out.body.length });
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.body);
});

// The research audit trail itself (research.* entries only).
researchAdminRouter.get('/audit', (req, res) => {
  const rows = db.prepare(
    `SELECT a.action, a.details_json, a.created_at, u.display_name AS admin
     FROM audit_log a LEFT JOIN users u ON u.id = a.admin_user_id
     WHERE a.action LIKE 'research.%' ORDER BY a.created_at DESC LIMIT 200`).all();
  res.json({ audit: rows });
});
