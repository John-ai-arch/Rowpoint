// Stage 10 — recommendation refresh. A new workout makes today's cached
// suggestion stale: the read path (aiRouter) regenerates engine-sourced
// suggestions in place on the next fetch. LLM-sourced and coach-touched
// suggestions are left alone — refreshing an LLM suggestion stays an
// explicit, rate-limited user action so twin updates can never generate
// model cost, and a coach's word is never silently replaced.
import { db } from '../../db.js';
import { todayStr } from '../../util.js';

export const recommendationsStage = {
  name: 'refresh-recommendations',
  version: '1.0',
  run(ctx) {
    const r = db.prepare(
      `UPDATE ai_suggestions SET stale = 1
       WHERE user_id = ? AND date = ? AND status = 'delivered'`)
      .run(ctx.userId, todayStr(ctx.nowS * 1000));
    return { markedStale: r.changes };
  },
};
