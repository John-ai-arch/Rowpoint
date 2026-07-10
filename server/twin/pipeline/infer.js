// Stage 6 — physiological inference. Assembles the model context (full
// training analysis + recent cached features) and runs every registered
// inference model. One model failing records its error and the others still
// run — models are independent by design.
import { db } from '../../db.js';
import { buildTrainingAnalysis, classifyWorkoutZone } from '../../ai/trainingAnalysis.js';
import { effectiveMaxHr } from '../../hr.js';
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
    for (const model of INFERENCE_MODELS) {
      try {
        const out = model.infer(modelCtx);
        for (const [variable, estimate] of Object.entries(out)) {
          if (!estimate) continue;
          if (!updates[model.category]) updates[model.category] = {};
          updates[model.category][variable] = estimate;
        }
      } catch (e) {
        modelErrors.push({ model: model.modelVersion, error: e.message });
      }
    }
    ctx.updates = updates;
    return { ...updates, modelErrors };
  },
};
