// Platform audit trail — every background computation, recorded immutably.
//
// Subscribes to the kernel's job.completed / job.failed events and appends
// one computation_log row per execution: which job kind ran, for whom, how
// long it took, a hash of its inputs, the component-version manifest in
// force at execution time, and — for job kinds whose outputs live in a
// known run table — a reference to and hash of the produced record. The
// table is append-only (an UPDATE trigger aborts); rows age out through an
// explicit retention function, never through edits.
//
// This is what lets a researcher answer, months later: "what exactly ran,
// on what, under which model versions, and what did it produce?"
import crypto from 'node:crypto';
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { versionManifest } from '../kernel/registry.js';

export const AUDIT_VERSION = 'rpos.audit-trail@1.0';

const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 32);

/**
 * Output locators by job kind: where a job's durable result lives and which
 * column captures its content. Kinds not listed produce no single output
 * record (e.g. twin updates spread across athlete_state) — their rows carry
 * a null outputs_ref, which is honest, not missing.
 */
const OUTPUT_LOCATORS = {
  'optimizer.run': { table: 'optimization_runs', contentCol: 'frontier_json', summarize: r => ({ status: r.status, frontierSize: (safeJson(r.frontier_json, []) || []).length } ) },
  'regatta.simulate': { table: 'race_simulations', contentCol: 'summary_json', summarize: r => ({ status: r.status, winProb: safeJson(r.summary_json, null)?.user?.winProb ?? null }) },
};

/** Append one audit row for a finished job. Never throws (audit must not
 *  break the job system); a failed append is recorded to health_events. */
export function recordComputation({ jobId, kind, userId, durationMs = null, status = 'completed', error = null }) {
  try {
    const job = db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get(jobId);
    let outputsRef = null, outputsHash = null, detail = null;
    const locator = OUTPUT_LOCATORS[kind];
    if (locator) {
      const runId = safeJson(job?.payload_json, {})?.runId;
      if (runId) {
        const run = db.prepare(`SELECT * FROM ${locator.table} WHERE id = ?`).get(runId);
        if (run) {
          outputsRef = `${locator.table}:${runId}`;
          outputsHash = sha(run[locator.contentCol]);
          detail = locator.summarize(run);
        }
      }
    }
    if (error) detail = { ...(detail || {}), error };
    db.prepare(`INSERT INTO computation_log
        (id, job_id, kind, user_id, status, duration_ms, inputs_hash, outputs_ref, outputs_hash, detail_json, versions_json, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), jobId, kind, userId ?? null, status, durationMs,
        sha(job?.payload_json), outputsRef, outputsHash,
        detail ? JSON.stringify(detail) : null,
        JSON.stringify(versionManifest()), now());
  } catch (e) {
    try {
      db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,NULL,?)')
        .run(uuid(), 'audit_append_failed', `${kind}: ${String(e.message).slice(0, 300)}`, now());
    } catch { /* never cascade */ }
  }
}

/** Admin search over the audit trail. */
export function searchComputations({ kind = null, userId = null, status = null, limit = 50 } = {}) {
  const where = [], args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (status) { where.push('status = ?'); args.push(status); }
  const rows = db.prepare(
    `SELECT * FROM computation_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`).all(...args, Math.min(Math.max(limit, 1), 200));
  return rows.map(r => ({
    id: r.id, jobId: r.job_id, kind: r.kind, userId: r.user_id, status: r.status,
    durationMs: r.duration_ms, inputsHash: r.inputs_hash, outputsRef: r.outputs_ref,
    outputsHash: r.outputs_hash, detail: safeJson(r.detail_json, null),
    versions: safeJson(r.versions_json, []), createdAt: r.created_at,
  }));
}

/**
 * Retention: an explicit policy, never edits. High-volume routine kinds
 * (twin.* runs once per synced workout — the explainability record for
 * those already lives in inference_history) keep 30 days; everything else
 * (optimization, simulation, research runs — low volume, high value) keeps
 * 180 days. Called daily by the RPOS init.
 */
export function pruneAuditTrail({ routineKeepDays = 30, keepDays = 180 } = {}) {
  const routine = db.prepare("DELETE FROM computation_log WHERE kind LIKE 'twin.%' AND created_at < ?")
    .run(now() - routineKeepDays * 86400).changes;
  const rest = db.prepare('DELETE FROM computation_log WHERE created_at < ?')
    .run(now() - keepDays * 86400).changes;
  return routine + rest;
}
