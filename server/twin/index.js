// Digital Twin engine — wiring.
//
// Connects the twin to the platform: subscribes to workout events, defines
// the background jobs that run the pipeline, and exposes the router. All
// communication with the rest of the system goes through the kernel (events,
// jobs, registry) — no other engine or app module is imported here.
import { db } from '../db.js';
import { logger } from '../log.js';
import { on } from '../kernel/events.js';
import { defineJob, enqueue } from '../kernel/jobs.js';
import { provide } from '../kernel/providers.js';
import { runTwinPipeline, rebuildTwin } from './pipeline/index.js';
import { getState } from './store.js';
export { twinRouter } from './api.js';

const log = logger('twin');

function loadUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

let initialized = false;

/** Idempotent engine start-up: job kinds + event subscriptions. */
export function initTwinEngine() {
  if (initialized) return;
  initialized = true;

  // Other engines read athlete state through this contract — never by
  // importing twin code or touching twin tables directly.
  provide('twin.state-access', { name: 'twin', getState });

  // Incremental update — the standard reaction to a completed workout.
  // Coalesces per user: a burst of offline-synced workouts runs the pipeline
  // once (it self-discovers every workout needing extraction).
  defineJob('twin.update', {
    maxAttempts: 3,
    async handler({ userId }) {
      const user = loadUser(userId);
      if (!user) return; // account deleted between enqueue and run
      const { ran } = await runTwinPipeline(user, { trigger: 'workout' });
      log.info(`twin updated for ${userId} (${ran.length} stages)`);
    },
  });

  // Full recompute — deletion/correction of history, or a user-requested rebuild.
  defineJob('twin.rebuild', {
    maxAttempts: 2,
    async handler({ userId }) {
      const user = loadUser(userId);
      if (!user) return;
      await rebuildTwin(user);
      log.info(`twin rebuilt for ${userId}`);
    },
  });

  on('workout.saved', 'twin', ({ userId }) => {
    enqueue('twin.update', { userId, priority: 4 });
  });
  on('workout.deleted', 'twin', ({ userId }) => {
    // History changed under the state — recompute from what remains.
    enqueue('twin.rebuild', { userId, priority: 6 });
  });
  on('workout.corrected', 'twin', ({ userId }) => {
    enqueue('twin.rebuild', { userId, priority: 6 });
  });
}
