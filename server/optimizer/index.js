// Global Training Optimization Engine — wiring.
//
// The optimizer runs as a background job: assemble the problem from the twin
// + analysis, search the plan space with the configured strategy, extract
// and annotate the Pareto frontier, put the top plans through Monte Carlo on
// a worker thread, run sensitivity analysis on the recommended plan, and
// persist the complete reproducibility record. Adaptive replanning: a saved
// workout re-optimizes any recent, still-relevant run incrementally
// (warm-started from its previous frontier) instead of regenerating from
// scratch.
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { logger } from '../log.js';
import { register, versionManifest } from '../kernel/registry.js';
import { on, emit } from '../kernel/events.js';
import { defineJob, enqueue, runInWorker } from '../kernel/jobs.js';
import { seedFrom, createRng } from '../kernel/rng.js';
import { buildProblem } from './problem.js';
import { getStrategy, STRATEGIES } from './search/index.js';
import { paretoFrontier, explainTradeoffs } from './pareto.js';
import { evaluatePlansMC } from './monteCarlo.js';
import { sensitivityAnalysis } from './sensitivity.js';
import { planSignature } from './planSpace.js';
export { optimizerRouter } from './api.js';

const log = logger('optimizer');
const MC_WORKER = fileURLToPath(new URL('./mcWorker.js', import.meta.url));

const COMPONENTS = [
  ['optimizer.simulate', 'model', 'Fitness–fatigue impulse-response forward simulator'],
  ['optimizer.objectives', 'model', 'Multi-objective plan scoring'],
  ['optimizer.pareto', 'algorithm', 'Non-dominated sorting + crowding trim'],
  ['optimizer.monte-carlo', 'algorithm', 'Seeded stochastic plan evaluation'],
  ['optimizer.sensitivity', 'algorithm', 'Scenario perturbation analysis'],
  ['optimizer.problem', 'model', 'Problem assembly from twin state + analysis'],
  ['optimizer.counterfactual', 'algorithm', 'What-if plan evaluation'],
];

/** Create the run row; the job fills it in. Returns runId. */
export function createRun(userId, config, { kind = 'user' } = {}) {
  const id = uuid();
  db.prepare(`INSERT INTO optimization_runs (id, user_id, kind, status, config_json, created_at)
              VALUES (?,?,?,?,?,?)`)
    .run(id, userId, kind, 'pending', JSON.stringify(config || {}), now());
  return id;
}

let initialized = false;

export function initOptimizerEngine() {
  if (initialized) return;
  initialized = true;

  for (const [name, kind, description] of COMPONENTS) register({ name, kind, version: '1.0', description });

  defineJob('optimizer.run', {
    maxAttempts: 2,
    async handler({ userId, payload, saveCheckpoint }) {
      const run = db.prepare('SELECT * FROM optimization_runs WHERE id = ?').get(payload.runId);
      if (!run || run.status === 'completed') return;
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) return;
      const startedMs = Date.now();
      db.prepare("UPDATE optimization_runs SET status = 'running' WHERE id = ?").run(run.id);
      try {
        const config = safeJson(run.config_json, {}) || {};
        const problem = buildProblem(user, config);

        // Warm start: seed with the previous run's frontier plans (matching
        // horizon), so replanning refines rather than restarts.
        if (config.warmStartRunId) {
          const prev = db.prepare('SELECT frontier_json FROM optimization_runs WHERE id = ? AND user_id = ?')
            .get(config.warmStartRunId, userId);
          for (const p of (safeJson(prev?.frontier_json, []) || [])) {
            if (p.days?.length === problem.horizonDays) problem.seeds.push({ name: 'warm-start', days: p.days });
          }
        }

        const strategyName = STRATEGIES[config.strategy] ? config.strategy : 'genetic';
        const strategy = getStrategy(strategyName);
        // Deterministic seed: run id fixes every stochastic choice.
        const seed = seedFrom(run.id);
        const budget = Math.min(Math.max(Number(config.budget) || 1200, 200), 5000);

        saveCheckpoint({ stage: 'search' });
        const { archive, evaluations } = strategy.search({ ...problem, rng: createRng(seed), budget, weights: problem.weights });

        // Dedup archive by plan signature before Pareto extraction.
        const seen = new Set();
        const unique = archive.filter(e => {
          const sig = planSignature(e.days);
          if (seen.has(sig)) return false;
          seen.add(sig);
          return true;
        });
        let frontier = explainTradeoffs(paretoFrontier(unique, { maxSize: 10 }));

        saveCheckpoint({ stage: 'monte-carlo', evaluations });
        // Distributions for the whole frontier — on a worker thread so this
        // job never blocks the event loop, with an inline fallback.
        const mcOpts = { iterations: 400, seed, raceDayIndex: problem.raceDayIndex };
        const plain = frontier.map(p => ({ days: p.days }));
        let withMc;
        try {
          withMc = await runInWorker(MC_WORKER, { plans: plain, athlete: problem.athlete, opts: mcOpts });
        } catch (e) {
          log.error(`MC worker failed (${e.message}) — running inline`);
          withMc = evaluatePlansMC(plain, problem.athlete, mcOpts);
        }
        frontier = frontier.map((p, i) => ({ ...p, mc: withMc[i].mc, fitness: undefined }));

        saveCheckpoint({ stage: 'sensitivity' });
        const sensitivity = frontier.length
          ? sensitivityAnalysis(frontier[0].days, problem.athlete, { raceDayIndex: problem.raceDayIndex })
          : null;

        db.prepare(`UPDATE optimization_runs SET status = 'completed', seed = ?, algorithm = ?,
            versions_json = ?, frontier_json = ?, sensitivity_json = ?, finished_at = ?, duration_ms = ?
            WHERE id = ?`)
          .run(seed, `${strategy.name}@${strategy.version}`,
            JSON.stringify(versionManifest()),
            JSON.stringify(frontier),
            sensitivity ? JSON.stringify(sensitivity) : null,
            now(), Date.now() - startedMs, run.id);
        emit('optimization.completed', { userId, runId: run.id, frontierSize: frontier.length, evaluations });
        // Storage cap: frontier records are tens of KB each; keep the newest
        // 30 runs per athlete (replans arrive on every synced workout, so an
        // active season would otherwise grow this without bound).
        db.prepare(`DELETE FROM optimization_runs WHERE user_id = ? AND id NOT IN (
          SELECT id FROM optimization_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30)`)
          .run(userId, userId);
        log.info(`optimization ${run.id} for ${userId}: ${frontier.length} frontier plans from ${evaluations} evaluations (${strategyName})`);
      } catch (e) {
        db.prepare("UPDATE optimization_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
          .run(String(e.message).slice(0, 500), now(), run.id);
        throw e; // job system records + retries
      }
    },
  });

  // Adaptive replanning: every completed workout is new evidence. If the
  // athlete has a recent completed run, refresh it incrementally — warm-
  // started, coalesced per user, delayed so a sync burst optimizes once.
  on('workout.saved', 'optimizer', ({ userId }) => {
    const recent = db.prepare(
      `SELECT id, config_json FROM optimization_runs
       WHERE user_id = ? AND status = 'completed' AND kind IN ('user','replan')
       AND created_at > ? ORDER BY created_at DESC LIMIT 1`)
      .get(userId, now() - 14 * 86400);
    if (!recent) return;
    const config = { ...(safeJson(recent.config_json, {}) || {}), warmStartRunId: recent.id };
    const runId = createRun(userId, config, { kind: 'replan' });
    enqueue('optimizer.run', { userId, payload: { runId }, priority: 7, delaySeconds: 60 });
  });
}
