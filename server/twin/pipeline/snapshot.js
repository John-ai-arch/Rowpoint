// Stage 12 — historical snapshot. Appends the full current state to the
// athlete's immutable history (coalesced within 10 minutes so an offline
// batch sync produces one history point). This is what powers longitudinal
// charts and makes any past state reproducible.
import { snapshotState } from '../store.js';

export const snapshotStage = {
  name: 'snapshot',
  version: '1.0',
  run(ctx) {
    const id = snapshotState(ctx.userId, ctx.trigger);
    return { snapshotId: id, coalesced: id === null };
  },
};
