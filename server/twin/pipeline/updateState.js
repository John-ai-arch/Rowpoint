// Stage 7 — twin update. Blends the inferred Estimates into the persisted
// athlete state (exponential, evidence-weighted — a workout nudges the state,
// it never rewrites it) and announces the change on the event bus.
import { applyUpdates } from '../store.js';
import { emit } from '../../kernel/events.js';

export const updateStateStage = {
  name: 'update-state',
  version: '1.0',
  run(ctx) {
    const applied = applyUpdates(ctx.userId, ctx.updates || {});
    const variables = Object.values(applied).reduce((n, vars) => n + Object.keys(vars).length, 0);
    emit('twin.updated', { userId: ctx.userId, variables, trigger: ctx.trigger });
    return { updates: applied, variables };
  },
};
