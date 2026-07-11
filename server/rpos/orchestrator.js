// Orchestrator — operator-grade control over the platform's computation.
//
// The kernel job system already schedules, prioritizes, retries, coalesces,
// checkpoints and measures every background computation. This module is the
// CONTROL surface on top of it: the queue as an operator sees it, per-job
// history, and the retry/cancel actions — with authorization decided by the
// API layer (admins see everything; athletes see and touch only their own).
import { db } from '../db.js';
import { safeJson } from '../util.js';
import { cancel, retry, jobsForUser, jobStats, queueStats } from '../kernel/jobs.js';

export const ORCHESTRATOR_VERSION = 'rpos.orchestrator@1.0';

/** The queue as the operator sees it: waiting + running + recent failures. */
export function queueView({ limit = 50 } = {}) {
  const active = db.prepare(
    `SELECT id, kind, user_id, status, priority, attempts, max_attempts, run_at, created_at, started_at, error
     FROM jobs WHERE status IN ('pending','running') ORDER BY priority ASC, run_at ASC LIMIT ?`).all(limit);
  const failed = db.prepare(
    `SELECT id, kind, user_id, attempts, error, created_at, finished_at
     FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT ?`).all(limit);
  return { stats: queueStats(), execution: jobStats(), active, failed };
}

/** One job with its checkpoint (progress reporting). ownUserId scopes
 *  non-admin callers to their own jobs. */
export function jobDetail(jobId, { ownUserId = null } = {}) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  if (ownUserId && job.user_id !== ownUserId) return null;
  return {
    id: job.id, kind: job.kind, userId: job.user_id, status: job.status,
    priority: job.priority, attempts: job.attempts, maxAttempts: job.max_attempts,
    error: job.error, checkpoint: safeJson(job.checkpoint_json, null),
    createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at,
    durationMs: job.duration_ms,
  };
}

/** Cancel a pending job. Non-admins may only cancel their own. */
export function cancelJob(jobId, { ownUserId = null } = {}) {
  if (ownUserId) {
    const job = db.prepare('SELECT user_id FROM jobs WHERE id = ?').get(jobId);
    if (!job || job.user_id !== ownUserId) return false;
  }
  return cancel(jobId);
}

/** Retry a failed job with a fresh attempt budget (admin operation). */
export function retryJob(jobId) {
  return retry(jobId);
}

/** A user's own recent jobs — the progress surface for long computations. */
export function myJobs(userId, limit = 20) {
  return jobsForUser(userId, limit);
}
