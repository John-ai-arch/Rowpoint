// The Digital Twin pipeline runner.
//
//   validate → sensor-validate → clean → normalize → extract-features →
//   infer → update-state → derive-metrics → refresh-predictions →
//   refresh-recommendations → research-aggregate → snapshot
//
// Stages are independent modules executed through the kernel's computational
// graph (topological order, explicit dependencies). The pipeline is
// self-incremental: it determines its own work by comparing feature_cache
// against current extractor versions, so coalesced job runs and full rebuilds
// go through the identical code path. Every stage's outcome is appended to
// inference_history — the explainability trail behind every state value.
import { db } from '../../db.js';
import { safeJson } from '../../util.js';
import { createGraph } from '../../kernel/graph.js';
import { register } from '../../kernel/registry.js';
import { EXTRACTORS } from '../features/index.js';
import { recordInference } from '../store.js';
import { validateStage } from './validate.js';
import { sensorValidateStage } from './sensorValidate.js';
import { cleanStage } from './clean.js';
import { normalizeStage } from './normalize.js';
import { extractStage } from './extract.js';
import { inferStage } from './infer.js';
import { updateStateStage } from './updateState.js';
import { deriveStage } from './derive.js';
import { predictionsStage } from './predictions.js';
import { recommendationsStage } from './recommendations.js';
import { researchStage } from './research.js';
import { snapshotStage } from './snapshot.js';

export const STAGES = [
  validateStage, sensorValidateStage, cleanStage, normalizeStage,
  extractStage, inferStage, updateStateStage, deriveStage,
  predictionsStage, recommendationsStage, researchStage, snapshotStage,
];

for (const s of STAGES) {
  register({ name: `twin.stage.${s.name}`, kind: 'pipeline-stage', version: s.version, description: `Twin pipeline stage: ${s.name}` });
}

export const PIPELINE_VERSION = '1.0';

const graph = createGraph('twin-pipeline');
let prev = null;
for (const stage of STAGES) {
  const deps = prev ? [prev] : [];
  graph.node({
    name: stage.name,
    dependsOn: deps,
    compute: (ctx) => stage.run(ctx),
  });
  prev = stage.name;
}
export const pipelineGraph = graph;

/** Workouts whose cached features are missing or from an older extractor version. */
function workoutsNeedingExtraction(userId, { sinceDays = 180, limit = 200 } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const rows = db.prepare(
    `SELECT * FROM workouts WHERE user_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT ?`)
    .all(userId, nowS - sinceDays * 86400, limit);
  if (!rows.length) return [];
  const cached = db.prepare(
    `SELECT workout_id, feature, version FROM feature_cache
     WHERE workout_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map(r => r.id));
  const byWorkout = new Map();
  for (const c of cached) {
    if (!byWorkout.has(c.workout_id)) byWorkout.set(c.workout_id, new Map());
    byWorkout.get(c.workout_id).set(c.feature, c.version);
  }
  return rows.filter(w => {
    const have = byWorkout.get(w.id);
    if (!have) return true;
    for (const ex of EXTRACTORS) {
      for (const f of ex.features) {
        if (have.get(f) !== ex.version) return true;
      }
    }
    return false;
  });
}

/**
 * Run the full pipeline for one athlete. `trigger` labels why (workout,
 * rebuild, backfill). Returns { ran, stageResults }. Throws only on a
 * stage-level failure (the job system records and retries).
 */
export async function runTwinPipeline(user, { trigger = 'workout' } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const candidateWorkouts = workoutsNeedingExtraction(user.id);

  // Load split/force-curve data only for workouts actually being processed.
  const splitsByWorkout = new Map();
  const forceCurvesByWorkout = new Map();
  if (candidateWorkouts.length) {
    const ids = candidateWorkouts.map(w => w.id);
    const ph = ids.map(() => '?').join(',');
    for (const s of db.prepare(`SELECT * FROM splits WHERE workout_id IN (${ph}) ORDER BY split_index`).all(...ids)) {
      if (!splitsByWorkout.has(s.workout_id)) splitsByWorkout.set(s.workout_id, []);
      splitsByWorkout.get(s.workout_id).push(s);
    }
    for (const c of db.prepare(`SELECT workout_id, stroke_index, samples_json FROM force_curves WHERE workout_id IN (${ph}) ORDER BY stroke_index`).all(...ids)) {
      if (!forceCurvesByWorkout.has(c.workout_id)) forceCurvesByWorkout.set(c.workout_id, []);
      forceCurvesByWorkout.get(c.workout_id).push({ strokeIndex: c.stroke_index, samples: safeJson(c.samples_json, []) });
    }
  }

  const ctx = {
    user, userId: user.id, nowS, trigger,
    candidateWorkouts, splitsByWorkout, forceCurvesByWorkout,
  };

  graph.markStale(user.id); // full pipeline per run; graph enforces order
  const { ran, results } = await graph.run(user.id, ctx);

  // Explainability trail: one row per stage with its outcome.
  const workoutId = candidateWorkouts.length === 1 ? candidateWorkouts[0].id : null;
  for (const stageName of ran) {
    const stage = STAGES.find(s => s.name === stageName);
    recordInference(user.id, workoutId, stageName, results[stageName] ?? {}, `twin.stage.${stageName}@${stage.version}`);
  }
  // Bound the trail: everything stays reproducible from snapshots + versions;
  // per-stage detail older than 180 days is prunable noise.
  db.prepare('DELETE FROM inference_history WHERE user_id = ? AND created_at < ?').run(user.id, nowS - 180 * 86400);

  return { ran, stageResults: results };
}

/** Full rebuild: clear this athlete's feature cache, then run the pipeline. */
export async function rebuildTwin(user) {
  db.prepare(`DELETE FROM feature_cache WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = ?)`).run(user.id);
  return runTwinPipeline(user, { trigger: 'rebuild' });
}
