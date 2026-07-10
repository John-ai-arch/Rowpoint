// The digital lab notebook — an append-only scientific record.
//
// Every hypothesis update, experiment lifecycle event, model validation, and
// model transition writes an entry. Entries are never edited or deleted
// (account-triggered privacy deletions are recorded as their own entries).
// The whole notebook exports as structured JSON for external research use.
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';

export const NOTEBOOK_VERSION = 'experiments.notebook@1.0';

export const ENTRY_KINDS = [
  'hypothesis-update', 'experiment-proposed', 'experiment-accepted',
  'experiment-stopped', 'experiment-completed', 'model-validation',
  'model-transition', 'knowledge-graph-change', 'privacy-deletion',
];

export function appendNotebook(entryKind, refId, body) {
  if (!ENTRY_KINDS.includes(entryKind)) throw new Error(`Unknown notebook entry kind: ${entryKind}`);
  const id = uuid();
  db.prepare('INSERT INTO lab_notebook (id, entry_kind, ref_id, body_json, created_at) VALUES (?,?,?,?,?)')
    .run(id, entryKind, refId || null, JSON.stringify(body).slice(0, 8000), now());
  return id;
}

/** Recent entries, newest first, optionally filtered by kind. */
export function readNotebook({ kind = null, limit = 100 } = {}) {
  const rows = kind
    ? db.prepare('SELECT * FROM lab_notebook WHERE entry_kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, Math.min(limit, 500))
    : db.prepare('SELECT * FROM lab_notebook ORDER BY created_at DESC LIMIT ?').all(Math.min(limit, 500));
  return rows.map(r => ({ id: r.id, kind: r.entry_kind, refId: r.ref_id, body: safeJson(r.body_json, {}), at: r.created_at }));
}

/** Full export for external research — chronological, with counts. */
export function exportNotebook() {
  const rows = db.prepare('SELECT * FROM lab_notebook ORDER BY created_at ASC').all();
  return {
    exportedAt: now(),
    platform: 'RowPoint Autonomous Experimental Design & Validation Engine',
    version: NOTEBOOK_VERSION,
    entryCount: rows.length,
    note: 'Append-only record. Entries reference hypotheses, experiments, and models by id; no athlete identity appears.',
    entries: rows.map(r => ({ kind: r.entry_kind, refId: r.ref_id, at: r.created_at, ...safeJson(r.body_json, {}) })),
  };
}
