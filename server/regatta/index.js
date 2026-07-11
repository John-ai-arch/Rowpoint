// Digital Regatta Simulation Engine — wiring.
//
// The simulation runs as a background job: the API layer assembles and
// stores the fully-prepared, plain-data configuration (every boat's numbers,
// the environment distributions, the strategy, the seed) in the run row, and
// the job hands exactly that record to a worker thread. Nothing but the run
// row is needed to reproduce a simulation — that is the reproducibility
// contract, and it is also why the worker never needs a database handle.
//
// Validation loop: when an athlete records a real race result, the engine
// checks every completed simulation linked to that race and writes the
// prediction error to model_performance — the platform's meta-learning
// tables — so calibration is measured against reality, never assumed.
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { logger } from '../log.js';
import { register, versionManifest } from '../kernel/registry.js';
import { on, emit } from '../kernel/events.js';
import { defineJob, enqueue, runInWorker } from '../kernel/jobs.js';
import { seedFrom } from '../kernel/rng.js';
import { runRegattaMC } from './monteCarloRegatta.js';
export { regattaRouter } from './api.js';

const log = logger('regatta');
const MC_WORKER = fileURLToPath(new URL('./mcWorker.js', import.meta.url));

const COMPONENTS = [
  ['regatta.athlete', 'model', 'Race-boat state from the Digital Twin (CP, W′, readiness, variability) + opponent archetypes'],
  ['regatta.race', 'model', 'Discrete-time race dynamics: coupled W′-balance, technique fade, hull + air drag'],
  ['regatta.strategy', 'model', 'Normalized pacing profiles + opponent tendency blending'],
  ['regatta.environment', 'model', 'Race-day conditions as distributions: wind, gusts, current, lanes'],
  ['regatta.tactics', 'model', 'Optional probabilistic race events with documented base rates'],
  ['regatta.monte-carlo', 'algorithm', 'Seeded Monte Carlo regatta with sensitivity + median-race replay'],
  ['regatta.what-if', 'algorithm', 'Bounded assumption modification vs a baseline run'],
];

/** Create the run row; the job fills it in. Returns { runId, seed }. */
export function createSimulation(userId, config, raceId = null) {
  const id = uuid();
  const seed = seedFrom(id); // the run id fixes every stochastic choice
  db.prepare(`INSERT INTO race_simulations (id, user_id, status, config_json, seed, race_id, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, userId, 'pending', JSON.stringify({ ...config, seed }), seed, raceId, now());
  return { runId: id, seed };
}

let initialized = false;

export function initRegattaEngine() {
  if (initialized) return;
  initialized = true;

  for (const [name, kind, description] of COMPONENTS) register({ name, kind, version: '1.0', description });

  defineJob('regatta.simulate', {
    maxAttempts: 2,
    coalesce: false, // every run row is distinct work — never merge two regattas
    async handler({ userId, payload, saveCheckpoint }) {
      const run = db.prepare('SELECT * FROM race_simulations WHERE id = ? AND user_id = ?').get(payload.runId, userId);
      if (!run || run.status === 'completed') return;
      const startedMs = Date.now();
      db.prepare("UPDATE race_simulations SET status = 'running' WHERE id = ?").run(run.id);
      try {
        const config = safeJson(run.config_json, null);
        if (!config?.boats?.length) throw new Error('Run has no prepared boats — config corrupted');
        saveCheckpoint({ stage: 'simulating', iterations: config.iterations });
        let result;
        try {
          result = await runInWorker(MC_WORKER, { config }, { timeoutMs: 180000 });
        } catch (e) {
          log.error(`regatta MC worker failed (${e.message}) — running inline`);
          result = runRegattaMC(config);
        }
        db.prepare(`UPDATE race_simulations SET status = 'completed', versions_json = ?,
            summary_json = ?, replay_json = ?, finished_at = ?, duration_ms = ?, error = NULL
            WHERE id = ?`)
          .run(JSON.stringify(versionManifest()),
            JSON.stringify(result.summary),
            JSON.stringify(result.replay),
            now(), Date.now() - startedMs, run.id);
        emit('prediction.completed', { userId, kind: 'race-simulation', runId: run.id, winProb: result.summary.user.winProb });
        // Storage cap: replays are ~100 KB each; keep the newest 30 runs per
        // athlete (the reproducibility record of anything older has aged out
        // of relevance — reproducing it means re-running with its seed).
        db.prepare(`DELETE FROM race_simulations WHERE user_id = ? AND id NOT IN (
          SELECT id FROM race_simulations WHERE user_id = ? ORDER BY created_at DESC LIMIT 30)`)
          .run(userId, userId);
        log.info(`regatta ${run.id} for ${userId}: ${config.iterations} races, P(win)=${result.summary.user.winProb}`);
      } catch (e) {
        db.prepare("UPDATE race_simulations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
          .run(String(e.message).slice(0, 500), now(), run.id);
        throw e; // job system records + retries
      }
    },
  });

  // Reality check: a recorded race result validates every simulation that
  // predicted that race. Errors land in model_performance (meta-learning).
  on('race.result-recorded', 'regatta', ({ userId, raceId, resultTimeS }) => {
    const sims = db.prepare(
      `SELECT id, summary_json FROM race_simulations
       WHERE user_id = ? AND race_id = ? AND status = 'completed'
       ORDER BY created_at DESC LIMIT 3`).all(userId, raceId);
    for (const sim of sims) {
      const summary = safeJson(sim.summary_json, null);
      const predicted = summary?.user?.finish?.p50;
      if (!Number.isFinite(predicted)) continue;
      const error = resultTimeS - predicted;
      const withinBand = resultTimeS >= summary.user.finish.p5 && resultTimeS <= summary.user.finish.p95;
      db.prepare(`INSERT INTO model_performance (id, model_name, version, metric, value, detail_json, created_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(uuid(), 'regatta.race', '1.0', 'race_abs_error_s', Math.round(Math.abs(error) * 100) / 100,
          JSON.stringify({ runId: sim.id, raceId, predictedS: predicted, actualS: resultTimeS, signedErrorS: Math.round(error * 100) / 100, withinP5P95: withinBand }),
          now());
      log.info(`regatta validation: run ${sim.id} predicted ${predicted}s, actual ${resultTimeS}s (|err| ${Math.abs(error).toFixed(1)}s, in band: ${withinBand})`);
    }
  });
}

/** Enqueue the simulation job for a created run. */
export function enqueueSimulation(userId, runId, priority = 5) {
  return enqueue('regatta.simulate', { userId, payload: { runId }, priority });
}
