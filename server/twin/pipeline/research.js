// Stage 11 — research aggregation. For research-consenting athletes only
// (checked at write time, same policy as workout contributions): a coarse,
// pseudonymous weekly aggregate of twin state — values and confidences only,
// keyed by the HMAC research id, never the account id. One row per pseudonym
// per ISO week, upserted within the week; historical weeks stay frozen.
import { db } from '../../db.js';
import { uuid, now, researchId } from '../../util.js';
import { emit } from '../../kernel/events.js';
import { getState } from '../store.js';

/** ISO-8601 week key, e.g. "2026-W28" (same convention as group history). */
export function isoWeekKey(tS) {
  const d = new Date(tS * 1000);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday decides the week-year
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const researchStage = {
  name: 'research-aggregate',
  version: '1.0',
  run(ctx) {
    if (!ctx.user.research_opt_in) return { contributed: false, reason: 'not_opted_in' };
    const state = getState(ctx.userId);
    if (!Object.keys(state).length) return { contributed: false, reason: 'no_state' };

    // Coarsen: rounded values + confidence only. No timestamps-of-day, no
    // model internals, no evidence identifiers — nothing joinable back.
    const coarse = {};
    for (const [category, vars] of Object.entries(state)) {
      coarse[category] = {};
      for (const [variable, est] of Object.entries(vars)) {
        if (!Number.isFinite(est.value)) continue;
        coarse[category][variable] = {
          value: Math.round(est.value * 10) / 10,
          confidence: Math.round((est.confidence ?? 0) * 100) / 100,
          provenance: est.provenance,
        };
      }
    }
    const rid = researchId(ctx.userId);
    const week = isoWeekKey(ctx.nowS);
    db.prepare(`INSERT INTO research_state_snapshots (id, research_id, week_key, state_json, model_version, created_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(research_id, week_key) DO UPDATE SET
          state_json = excluded.state_json, model_version = excluded.model_version, created_at = excluded.created_at`)
      .run(uuid(), rid, week, JSON.stringify(coarse), 'twin@1.0', now());
    emit('research.snapshot', { weekKey: week });
    return { contributed: true, weekKey: week };
  },
};
