// RPOS API — the platform's operator and progress surface.
//
// Two audiences, strictly separated:
//   /api/platform/my/*   — any verified athlete: their OWN background jobs
//                          (progress reporting for long computations).
//   /api/platform/*      — administrators: queue control, platform status,
//                          audit-trail search, organizations.
// No athlete can see another athlete's jobs, and nothing here exposes
// research or twin data — those keep their own gated surfaces.
import { Router } from 'express';
import { authRequired, verifiedRequired, adminRequired, audit } from '../middleware.js';
import { ApiError, badRequest } from '../util.js';
import { queueView, jobDetail, cancelJob, retryJob, myJobs } from './orchestrator.js';
import { platformSnapshot, watchdogTick } from './observability.js';
import { platformInventory, validatePlatform } from './plugins.js';
import { searchComputations } from './auditTrail.js';
import { createOrganization, listOrganizations, getOrganization, attachTeam, setMemberRole } from './orgs.js';

export const platformRouter = Router();
platformRouter.use(authRequired, verifiedRequired);

/* ------------------------- own-data progress ------------------------- */

platformRouter.get('/my/jobs', (req, res) => {
  res.json({ jobs: myJobs(req.user.id) });
});

platformRouter.get('/my/jobs/:id', (req, res) => {
  const job = jobDetail(req.params.id, { ownUserId: req.user.id });
  if (!job) throw new ApiError(404, 'Job not found.', 'not_found');
  res.json({ job });
});

platformRouter.post('/my/jobs/:id/cancel', (req, res) => {
  res.json({ ok: cancelJob(req.params.id, { ownUserId: req.user.id }) });
});

/* --------------------------- admin surface --------------------------- */

platformRouter.use(adminRequired);

platformRouter.get('/status', (req, res) => {
  res.json({ snapshot: platformSnapshot(), validation: validatePlatform(), regressions: watchdogTick() });
});

platformRouter.get('/inventory', (req, res) => {
  res.json({ inventory: platformInventory() });
});

platformRouter.get('/jobs', (req, res) => {
  res.json(queueView({ limit: Math.min(Number(req.query.limit) || 50, 200) }));
});

platformRouter.post('/jobs/:id/retry', (req, res) => {
  const ok = retryJob(req.params.id);
  if (ok) audit(req.user.id, 'job_retry', req.params.id);
  res.json({ ok });
});

platformRouter.post('/jobs/:id/cancel', (req, res) => {
  const ok = cancelJob(req.params.id);
  if (ok) audit(req.user.id, 'job_cancel', req.params.id);
  res.json({ ok });
});

platformRouter.get('/audit', (req, res) => {
  res.json({
    computations: searchComputations({
      kind: req.query.kind ? String(req.query.kind) : null,
      userId: req.query.userId ? String(req.query.userId) : null,
      status: req.query.status ? String(req.query.status) : null,
      limit: Number(req.query.limit) || 50,
    }),
  });
});

/* --------------------------- organizations --------------------------- */

platformRouter.get('/orgs', (req, res) => {
  res.json({ organizations: listOrganizations() });
});

platformRouter.post('/orgs', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 2) throw badRequest('Organization name is required.');
  const org = createOrganization(name, req.user.id);
  audit(req.user.id, 'org_create', org.id, { name });
  res.status(201).json({ organization: org });
});

platformRouter.get('/orgs/:id', (req, res) => {
  const org = getOrganization(req.params.id);
  if (!org) throw new ApiError(404, 'Organization not found.', 'not_found');
  res.json({ organization: org });
});

platformRouter.post('/orgs/:id/teams', (req, res) => {
  const org = getOrganization(req.params.id);
  if (!org) throw new ApiError(404, 'Organization not found.', 'not_found');
  const result = attachTeam(org.id, String(req.body?.teamId || ''));
  if (!result.ok) throw badRequest(result.reason);
  audit(req.user.id, 'org_attach_team', org.id, { teamId: req.body?.teamId });
  res.json({ organization: getOrganization(org.id) });
});

platformRouter.post('/orgs/:id/members/:userId/role', (req, res) => {
  const org = getOrganization(req.params.id);
  if (!org) throw new ApiError(404, 'Organization not found.', 'not_found');
  const result = setMemberRole(org.id, req.params.userId, String(req.body?.role || ''));
  if (!result.ok) throw badRequest(result.reason);
  audit(req.user.id, 'org_set_role', org.id, { userId: req.params.userId, role: req.body?.role });
  res.json({ organization: getOrganization(org.id) });
});
