// Stage 5 — feature extraction. Runs every registered extractor plugin over
// each workout needing (re)computation and persists results to feature_cache,
// keyed by extractor version — so bumping one extractor recomputes exactly
// its own features and nothing else.
import { db, inTransaction } from '../../db.js';
import { now } from '../../util.js';
import { extractAll, EXTRACTORS } from '../features/index.js';

export const extractStage = {
  name: 'extract-features',
  version: '1.0',
  run(ctx) {
    let computed = 0;
    const allErrors = [];
    inTransaction(() => {
      const upsert = db.prepare(`INSERT INTO feature_cache (workout_id, feature, version, value, computed_at)
          VALUES (?,?,?,?,?)
          ON CONFLICT(workout_id, feature) DO UPDATE SET
            version = excluded.version, value = excluded.value, computed_at = excluded.computed_at`);
      for (const [workoutId, exCtx] of ctx.extractorCtxs) {
        const { features, versions, errors } = extractAll(exCtx);
        allErrors.push(...errors);
        for (const ex of EXTRACTORS) {
          for (const f of ex.features) {
            upsert.run(workoutId, f, versions[ex.name], features[f], now());
            computed++;
          }
        }
      }
    });
    return { workouts: ctx.extractorCtxs.size, featuresComputed: computed, extractorErrors: allErrors };
  },
};
