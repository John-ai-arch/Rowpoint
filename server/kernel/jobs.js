// Background job system — SQLite-backed queue, in-process scheduler.
//
// Every expensive computation on the platform (twin updates, optimization,
// race simulation, research analyses) runs as a job: persisted, prioritized,
// retried with backoff, cancellable, checkpointable, and measured. Because
// the queue lives in the application database, a crashed process resumes its
// queue on the next boot with no external infrastructure.
//
// Concurrency model: jobs execute one at a time per process (SQLite has one
// writer; serial execution keeps every job's writes trivially consistent).
// CPU-heavy handlers offload pure computation to a worker thread via
// runInWorker() so the event loop — and the HTTP API — never stalls.
import { Worker } from 'node:worker_threads';
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { logger } from '../log.js';
import { emit } from './events.js';

const log = logger('jobs');

const kinds = new Map(); // kind → { handler, maxAttempts, coalesce }

/**
 * Declare a job kind. `handler({ payload, userId, checkpoint, saveCheckpoint })`
 * may be async. `coalesce: true` (default) means enqueueing while an identical
 * (kind, userId) job is still pending replaces its payload instead of queueing
 * duplicate work — the right semantics for "recompute X for athlete Y".
 */
export function defineJob(kind, { handler, maxAttempts = 3, coalesce = true } = {}) {
  if (!/^[a-z]+(\.[a-z-]+)+$/.test(kind)) throw new TypeError(`Invalid job kind: ${kind}`);
  if (typeof handler !== 'function') throw new TypeError(`Job ${kind} needs a handler function`);
  kinds.set(kind, { handler, maxAttempts, coalesce });
  return kind;
}

/** Enqueue a job. Returns the job id (an existing one when coalesced). */
export function enqueue(kind, { userId = null, payload = {}, priority = 5, delaySeconds = 0 } = {}) {
  const def = kinds.get(kind);
  if (!def) throw new Error(`Unknown job kind: ${kind} — defineJob() it first`);
  const runAt = now() + Math.max(0, Math.floor(delaySeconds));
  if (def.coalesce) {
    const existing = db.prepare(
      "SELECT id FROM jobs WHERE kind = ? AND user_id IS ? AND status = 'pending' LIMIT 1").get(kind, userId);
    if (existing) {
      db.prepare('UPDATE jobs SET payload_json = ?, run_at = MIN(run_at, ?), priority = MIN(priority, ?) WHERE id = ?')
        .run(JSON.stringify(payload), runAt, priority, existing.id);
      return existing.id;
    }
  }
  const id = uuid();
  db.prepare(`INSERT INTO jobs (id, kind, user_id, payload_json, status, priority, attempts, max_attempts, run_at, created_at)
              VALUES (?,?,?,?,'pending',?,0,?,?,?)`)
    .run(id, kind, userId, JSON.stringify(payload), priority, def.maxAttempts, runAt, now());
  return id;
}

/** Cancel a pending job. Running jobs finish their current attempt. */
export function cancel(id) {
  const r = db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'pending'").run(now(), id);
  return r.changes > 0;
}

/** Re-queue a failed job with a fresh attempt budget (operator action). */
export function retry(id) {
  const r = db.prepare(
    "UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, run_at = ?, finished_at = NULL WHERE id = ? AND status = 'failed'")
    .run(now(), id);
  return r.changes > 0;
}

/** Every job kind registered in this process (RPOS plugin inventory). */
export function jobKinds() {
  return [...kinds.keys()].sort();
}

/** Live queue state: how much work is waiting/running/finished, per kind. */
export function queueStats() {
  return {
    byStatus: Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM jobs GROUP BY status').all().map(r => [r.status, r.c])),
    oldestPendingAgeS: (() => {
      const r = db.prepare("SELECT MIN(run_at) m FROM jobs WHERE status = 'pending'").get();
      return r?.m ? Math.max(0, now() - r.m) : 0;
    })(),
  };
}

/**
 * Claim and run due jobs, highest priority (lowest number) first, up to
 * `limit`. Returns how many jobs were executed. Exposed so tests — and the
 * scheduler tick — drive execution deterministically.
 */
export async function processPending({ limit = 20 } = {}) {
  let processed = 0;
  while (processed < limit) {
    const job = claimNext();
    if (!job) break;
    await runJob(job);
    processed++;
  }
  return processed;
}

function claimNext() {
  // Single-process claim: the UPDATE only succeeds while the row is still
  // pending, so a concurrent drain (tests + scheduler) can never run the
  // same job twice.
  const row = db.prepare(
    `SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ?
     ORDER BY priority ASC, run_at ASC, created_at ASC LIMIT 1`).get(now());
  if (!row) return null;
  const claimed = db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'").run(now(), row.id);
  if (!claimed.changes) return null;
  return row;
}

async function runJob(row) {
  const def = kinds.get(row.kind);
  const startedMs = Date.now();
  if (!def) {
    // A queued kind this build no longer defines (rollback/rename) — fail it
    // visibly rather than leaving it running forever.
    db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(`No handler registered for kind ${row.kind}`, now(), row.id);
    return;
  }
  try {
    await def.handler({
      jobId: row.id,
      userId: row.user_id,
      payload: safeJson(row.payload_json, {}) || {},
      attempt: row.attempts + 1,
      checkpoint: safeJson(row.checkpoint_json, null),
      // Long jobs persist progress; a retried/resumed job continues from it.
      saveCheckpoint(data) {
        db.prepare('UPDATE jobs SET checkpoint_json = ? WHERE id = ?').run(JSON.stringify(data), row.id);
      },
    });
    db.prepare("UPDATE jobs SET status = 'completed', finished_at = ?, duration_ms = ?, error = NULL WHERE id = ?")
      .run(now(), Date.now() - startedMs, row.id);
    // Platform event: the RPOS audit trail (and anything else) reacts here —
    // the job system itself stays ignorant of who is listening.
    emit('job.completed', { jobId: row.id, kind: row.kind, userId: row.user_id, durationMs: Date.now() - startedMs });
  } catch (e) {
    const attempts = row.attempts + 1;
    const willRetry = attempts < row.max_attempts;
    log.error(`job ${row.kind} (${row.id}) attempt ${attempts}/${row.max_attempts} failed: ${e.message}`);
    if (willRetry) {
      // Exponential backoff: 30s, 60s, 120s, ...
      db.prepare("UPDATE jobs SET status = 'pending', attempts = ?, error = ?, run_at = ? WHERE id = ?")
        .run(attempts, String(e.message).slice(0, 500), now() + 30 * 2 ** (attempts - 1), row.id);
    } else {
      db.prepare("UPDATE jobs SET status = 'failed', attempts = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?")
        .run(attempts, String(e.message).slice(0, 500), now(), Date.now() - startedMs, row.id);
      try {
        db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,?,?)')
          .run(uuid(), 'job_failed', `${row.kind}: ${String(e.message).slice(0, 400)}`, row.user_id, now());
      } catch { /* never cascade */ }
      emit('job.failed', { jobId: row.id, kind: row.kind, userId: row.user_id, error: String(e.message).slice(0, 200) });
    }
  }
}

/* ------------------------------ scheduler ------------------------------ */

let timer = null;
let ticking = false;

/**
 * Start the polling scheduler. ROWPOINT_JOBS_ENABLED=0 disables it (tests
 * drive processPending() directly for determinism). Old completed/failed
 * rows are pruned periodically to keep the table bounded.
 */
export function startJobScheduler({ intervalMs = 1000 } = {}) {
  if (process.env.ROWPOINT_JOBS_ENABLED === '0') return false;
  if (timer) return true;
  // Reset jobs stranded 'running' by a previous crash so they retry.
  db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run();
  let tickCount = 0;
  timer = setInterval(async () => {
    if (ticking) return; // never overlap ticks
    ticking = true;
    try {
      await processPending();
      if (++tickCount % 3600 === 0) pruneFinished();
    } catch (e) {
      log.error(`scheduler tick failed: ${e.message}`);
    } finally {
      ticking = false;
    }
  }, intervalMs);
  timer.unref(); // never keep the process alive just to poll an empty queue
  return true;
}

export function stopJobScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

function pruneFinished({ keepDays = 7 } = {}) {
  db.prepare("DELETE FROM jobs WHERE status IN ('completed','cancelled') AND finished_at < ?").run(now() - keepDays * 86400);
  db.prepare("DELETE FROM jobs WHERE status = 'failed' AND finished_at < ?").run(now() - 30 * 86400);
}

/* ---------------------------- observability ---------------------------- */

/** Per-kind execution metrics for the RPOS observability surface. */
export function jobStats() {
  return db.prepare(
    `SELECT kind, status, COUNT(*) AS count, ROUND(AVG(duration_ms)) AS avg_ms, MAX(duration_ms) AS max_ms
     FROM jobs GROUP BY kind, status ORDER BY kind, status`).all();
}

/** One user's recent jobs (own-data progress reporting). */
export function jobsForUser(userId, limit = 20) {
  return db.prepare(
    `SELECT id, kind, status, priority, attempts, error, created_at, started_at, finished_at, duration_ms
     FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, Math.min(limit, 100));
}

/* --------------------------- worker offload --------------------------- */

/**
 * Run a pure-computation module on a worker thread. The module at
 * `scriptPath` receives `workerData` and must postMessage() its result once.
 * Workers get data in and results out — never a database handle; all
 * persistence happens back on the main thread.
 */
export function runInWorker(scriptPath, workerData, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(scriptPath, { workerData });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Worker ${scriptPath} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    worker.once('message', (msg) => { clearTimeout(timeout); worker.terminate(); resolve(msg); });
    worker.once('error', (e) => { clearTimeout(timeout); reject(e); });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Worker ${scriptPath} exited with code ${code}`));
    });
  });
}
