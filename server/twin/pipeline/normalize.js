// Stage 4 — normalization. Builds the per-workout extractor contexts:
// cleaned data joined with the athlete's anchors (2k, max HR) and parsed
// auxiliary series so extractors receive one uniform shape.
import { safeJson } from '../../util.js';
import { effectiveMaxHr } from '../../hr.js';

export const normalizeStage = {
  name: 'normalize',
  version: '1.0',
  run(ctx) {
    const maxHr = effectiveMaxHr(ctx.user);
    const best2kSeconds = Number(ctx.user.best_2k_seconds) > 0 ? Number(ctx.user.best_2k_seconds) : null;
    const extractorCtxs = new Map();
    for (const [workoutId, { workout, splits }] of ctx.cleaned) {
      extractorCtxs.set(workoutId, {
        workout,
        splits,
        forceCurves: ctx.forceCurvesByWorkout.get(workoutId) || [],
        hrSeries: safeJson(workout.hr_series_json, []) || [],
        hrZones: safeJson(workout.hr_zones_json, null),
        user: ctx.user,
        best2kSeconds,
        maxHr,
      });
    }
    ctx.extractorCtxs = extractorCtxs;
    ctx.anchors = { best2kSeconds, maxHr };
    return { workouts: extractorCtxs.size, anchors: ctx.anchors };
  },
};
