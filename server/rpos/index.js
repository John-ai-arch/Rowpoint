// RowPoint Operating System (RPOS) — wiring.
//
// RPOS is deliberately ADDITIVE: it registers its own components, subscribes
// the audit trail to the kernel's job events, validates the loaded plugin
// set at startup (surfacing inconsistencies to health_events instead of
// letting them rot), and starts the performance watchdog. It never modifies
// another engine — every fact it reports is read from kernel surfaces the
// engines already populate.
import { db } from '../db.js';
import { uuid, now } from '../util.js';
import { logger } from '../log.js';
import { register } from '../kernel/registry.js';
import { on } from '../kernel/events.js';
import { recordComputation, pruneAuditTrail } from './auditTrail.js';
import { validatePlatform } from './plugins.js';
import { startWatchdog } from './observability.js';
export { platformRouter } from './api.js';
export { generateDocs } from './docs.js';

const log = logger('rpos');

const COMPONENTS = [
  ['rpos.orchestrator', 'algorithm', 'Operator control surface over the kernel job system'],
  ['rpos.plugins', 'algorithm', 'Registered-component inventory + startup validation'],
  ['rpos.observability', 'algorithm', 'Platform snapshot + performance-regression watchdog'],
  ['rpos.audit-trail', 'algorithm', 'Immutable computation_log written on job completion'],
  ['rpos.organizations', 'model', 'Enterprise groundwork: orgs, role-scoped membership, team attachment'],
  ['rpos.docs', 'algorithm', 'Documentation generated from live registries and schema'],
];

let initialized = false;

export function initRposEngine() {
  if (initialized) return;
  initialized = true;

  for (const [name, kind, description] of COMPONENTS) register({ name, kind, version: '1.0', description });

  // The audit trail listens to the job system through the event bus — the
  // kernel stays ignorant of RPOS, exactly like every other subscriber.
  on('job.completed', 'rpos-audit', ({ jobId, kind, userId, durationMs }) => {
    recordComputation({ jobId, kind, userId, durationMs, status: 'completed' });
  });
  on('job.failed', 'rpos-audit', ({ jobId, kind, userId, error }) => {
    recordComputation({ jobId, kind, userId, status: 'failed', error });
  });

  // Startup validation: an engine that failed to register, an empty
  // contract, a duplicate identity — all land in the log AND health_events.
  const validation = validatePlatform();
  if (validation.ok) {
    log.info(`platform validated: ${validation.componentCount} components, no issues`);
  } else {
    for (const issue of validation.issues) {
      log.error(`platform validation: ${issue}`);
      try {
        db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,NULL,?)')
          .run(uuid(), 'platform_validation', issue.slice(0, 400), now());
      } catch { /* telemetry must never break startup */ }
    }
  }

  startWatchdog();
  // Audit retention runs opportunistically at boot (documented policy).
  try { pruneAuditTrail(); } catch { /* non-fatal */ }
}
