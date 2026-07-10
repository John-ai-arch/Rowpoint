// Stage 9 — prediction refresh. Recomputes race predictions from the fresh
// analysis and appends them to the predictions table (append-only history:
// how predictions evolved IS the calibration dataset for later phases).
import { db } from '../../db.js';
import { uuid, now } from '../../util.js';
import { register } from '../../kernel/registry.js';
import { emit } from '../../kernel/events.js';
import { racePredictions } from '../../ai/performance.js';

const PREDICTOR = register({
  name: 'twin.predictor.race', kind: 'model', version: '1.0',
  description: 'Riegel-extrapolated 2k/5k/6k predictions anchored on current 2k fitness',
});

export const predictionsStage = {
  name: 'refresh-predictions',
  version: '1.0',
  run(ctx) {
    const pred = racePredictions(ctx.analysis);
    if (!pred.available) return { available: false, reason: pred.reason };
    const id = uuid();
    const confidence = (pred.confidencePct ?? 50) / 100;
    db.prepare('INSERT INTO predictions (id, user_id, kind, payload_json, model_version, confidence, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, ctx.userId, 'race', JSON.stringify(pred), PREDICTOR.key, confidence, now());
    // History is bounded per user — the newest 100 fully cover calibration needs.
    db.prepare(`DELETE FROM predictions WHERE user_id = ? AND kind = 'race' AND id NOT IN (
        SELECT id FROM predictions WHERE user_id = ? AND kind = 'race' ORDER BY created_at DESC LIMIT 100)`)
      .run(ctx.userId, ctx.userId);
    emit('prediction.completed', { userId: ctx.userId, kind: 'race', predictionId: id, confidence });
    return { available: true, predictionId: id, confidence };
  },
};
