// Digital Twin persistence: current state, append-only snapshots, and the
// inference audit trail. All writes go through here so the storage contract
// (Estimates in, Estimates out; snapshots never mutated) lives in one place.
import { db, inTransaction } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { isEstimate, blend } from '../kernel/estimate.js';
import { STATE_MODEL } from './state.js';

/**
 * Current state for one athlete, grouped by category:
 * { category → { variable → Estimate } }. Unknown categories/variables in
 * storage (from newer or retired models) are returned as-is — forward and
 * backward compatible by construction.
 */
export function getState(userId) {
  const rows = db.prepare('SELECT * FROM athlete_state WHERE user_id = ?').all(userId);
  const state = {};
  for (const r of rows) {
    if (!state[r.category]) state[r.category] = {};
    state[r.category][r.variable] = {
      value: r.value, uncertainty: r.uncertainty, confidence: r.confidence,
      provenance: r.provenance, modelVersion: r.model_version,
      evidenceCount: r.evidence_count, updatedAt: r.updated_at,
    };
  }
  return state;
}

/**
 * Apply a batch of inferred Estimates to the athlete's state. New values are
 * BLENDED with existing ones (exponential update, evidence-weighted) rather
 * than overwriting — one workout nudges the state; it never rewrites it.
 * Returns the applied { category → { variable → Estimate } }.
 */
export function applyUpdates(userId, updatesByCategory, { weightNew = 0.3 } = {}) {
  const previous = getState(userId);
  const applied = {};
  inTransaction(() => {
    const upsert = db.prepare(`INSERT INTO athlete_state
        (user_id, category, variable, value, uncertainty, confidence, provenance, model_version, evidence_count, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, category, variable) DO UPDATE SET
          value = excluded.value, uncertainty = excluded.uncertainty,
          confidence = excluded.confidence, provenance = excluded.provenance,
          model_version = excluded.model_version, evidence_count = excluded.evidence_count,
          updated_at = excluded.updated_at`);
    for (const [category, vars] of Object.entries(updatesByCategory)) {
      for (const [variable, next] of Object.entries(vars)) {
        if (!isEstimate(next)) continue; // models may return null/invalid = "no update"
        const prevRaw = previous[category]?.[variable];
        const prev = prevRaw && isEstimate(prevRaw) ? prevRaw : null;
        const merged = prev ? blend(prev, next, weightNew) : next;
        upsert.run(userId, category, variable, merged.value, merged.uncertainty,
          merged.confidence, merged.provenance, merged.modelVersion, merged.evidenceCount, merged.updatedAt);
        if (!applied[category]) applied[category] = {};
        applied[category][variable] = merged;
      }
    }
  });
  return applied;
}

/**
 * Append an immutable snapshot of the full current state. Snapshots within
 * 10 minutes of the previous one coalesce (skip) — a batch of offline-synced
 * workouts produces one history point, not twenty.
 */
export function snapshotState(userId, trigger = 'workout') {
  const last = db.prepare('SELECT created_at FROM state_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
  if (last && now() - last.created_at < 600) return null;
  const state = getState(userId);
  if (!Object.keys(state).length) return null;
  const id = uuid();
  db.prepare('INSERT INTO state_snapshots (id, user_id, created_at, trigger, state_json) VALUES (?,?,?,?,?)')
    .run(id, userId, now(), trigger, JSON.stringify(state));
  return id;
}

/** Snapshot series for one variable (charting). Oldest first. */
export function variableHistory(userId, category, variable, limit = 60) {
  const rows = db.prepare(
    'SELECT created_at, state_json FROM state_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, Math.min(limit, 200));
  return rows.reverse().map(r => {
    const est = safeJson(r.state_json, {})?.[category]?.[variable];
    return est && Number.isFinite(est.value)
      ? { at: r.created_at, value: est.value, confidence: est.confidence ?? null, uncertainty: est.uncertainty ?? null }
      : null;
  }).filter(Boolean);
}

/**
 * Chronic weekly training load (TSS-like) from the cached load features:
 * the 28-day sum divided by 4. Exposed to other engines through the
 * 'twin.state-access' provider contract.
 */
export function getChronicWeeklyLoad(userId, nowS = now()) {
  const row = db.prepare(
    `SELECT SUM(f.value) AS total FROM feature_cache f
     JOIN workouts w ON w.id = f.workout_id
     WHERE w.user_id = ? AND w.started_at >= ? AND f.feature = 'training_load'`)
    .get(userId, nowS - 28 * 86400);
  return row?.total ? Math.round((row.total / 4) * 10) / 10 : null;
}

/** Record one pipeline stage's outcome — the explainability trail. */
export function recordInference(userId, workoutId, stage, detail, modelVersion = null) {
  db.prepare('INSERT INTO inference_history (id, user_id, workout_id, stage, detail_json, model_version, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuid(), userId, workoutId, stage, JSON.stringify(detail).slice(0, 8000), modelVersion, now());
}

/** Evidence trail for one variable (most recent first). */
export function explainVariable(userId, category, variable, limit = 20) {
  const rows = db.prepare(
    `SELECT workout_id, stage, detail_json, model_version, created_at FROM inference_history
     WHERE user_id = ? AND stage IN ('infer','update-state') ORDER BY created_at DESC LIMIT 200`).all(userId);
  const out = [];
  for (const r of rows) {
    const detail = safeJson(r.detail_json, {});
    const hit = detail?.[category]?.[variable] ?? detail?.updates?.[category]?.[variable];
    if (hit !== undefined) {
      out.push({ at: r.created_at, workoutId: r.workout_id, stage: r.stage, modelVersion: r.model_version, estimate: hit });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Known metadata for UI labeling; unknown vars still render (raw). */
export function stateWithMeta(userId) {
  const state = getState(userId);
  const out = {};
  for (const [category, vars] of Object.entries(state)) {
    out[category] = {};
    for (const [variable, est] of Object.entries(vars)) {
      out[category][variable] = { ...est, meta: STATE_MODEL[category]?.[variable] || null };
    }
  }
  return out;
}
