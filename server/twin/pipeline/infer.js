// Stage 6 — physiological inference. Assembles the model context (full
// training analysis + recent cached features) and runs every registered
// inference model — the twin's own plus any engine providing the
// 'twin.inference-model' contract (e.g. the physics engine's CP/W′ fit).
// Duplicate proposals for the same variable are merged by inverse-variance
// combination: independent model opinions weight by their certainty.
// One model failing records its error and the others still run.
import { db } from '../../db.js';
import { buildTrainingAnalysis, classifyWorkoutZone } from '../../ai/trainingAnalysis.js';
import { effectiveMaxHr } from '../../hr.js';
import { combine } from '../../kernel/estimate.js';
import { providersOf } from '../../kernel/providers.js';
import { INFERENCE_MODELS } from '../inference.js';

export const inferStage = {
  name: 'infer',
  version: '1.0',
  run(ctx) {
    ctx.analysis = buildTrainingAnalysis(ctx.user, ctx.nowS);

    // Recent workouts with their cached features — the models' observation window.
    const recent = db.prepare(
      `SELECT id, started_at, avg_split_s, avg_heart_rate, total_time_s, workout_plan_json
       FROM workouts WHERE user_id = ? ORDER BY started_at DESC LIMIT 20`).all(ctx.userId);
    const featureRows = recent.length
      ? db.prepare(`SELECT workout_id, feature, value FROM feature_cache
                    WHERE workout_id IN (${recent.map(() => '?').join(',')})`).all(...recent.map(r => r.id))
      : [];
    const featuresByWorkout = new Map();
    for (const r of featureRows) {
      if (!featuresByWorkout.has(r.workout_id)) featuresByWorkout.set(r.workout_id, {});
      featuresByWorkout.get(r.workout_id)[r.feature] = r.value;
    }
    const anchors = { best2kSeconds: ctx.user.best_2k_seconds, maxHr: effectiveMaxHr(ctx.user) };
    ctx.recentWorkouts = recent.reverse().map(w => ({
      workoutId: w.id,
      startedAt: w.started_at,
      zone: classifyWorkoutZone(w, anchors),
      features: featuresByWorkout.get(w.id) || {},
    }));

    const modelCtx = { user: ctx.user, analysis: ctx.analysis, recentWorkouts: ctx.recentWorkouts, nowS: ctx.nowS };
    const updates = {};
    const modelErrors = [];
    const models = [...INFERENCE_MODELS, ...providersOf('twin.inference-model')];
    for (const model of models) {
      try {
        const out = model.infer(modelCtx);
        for (const [variable, estimate] of Object.entries(out)) {
          if (!estimate) continue;
          if (!updates[model.category]) updates[model.category] = {};
          const existing = updates[model.category][variable];
          updates[model.category][variable] = existing ? combine(existing, estimate) : estimate;
        }
      } catch (e) {
        modelErrors.push({ model: model.modelVersion || model.name, error: e.message });
      }
    }
    ctx.updates = updates;
    return { ...updates, modelErrors };
  },
};
