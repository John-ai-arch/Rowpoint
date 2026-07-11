// Platform observability — one snapshot of how the machine is running.
//
// Composes what the platform already measures (API latency rings, job
// execution metrics, event-bus wiring, registry inventory, database shape)
// into a single admin-facing snapshot, and watches for performance
// regressions: a route group whose p95 crosses its threshold, or a job kind
// whose average runtime crosses its budget, is logged to health_events —
// once per boot per offender, so a regression is visible without flooding.
import fs from 'node:fs';
import { db } from '../db.js';
import { config } from '../config.js';
import { uuid, now } from '../util.js';
import { logger } from '../log.js';
import { metricsSnapshot, latencySummary } from '../metrics.js';
import { jobStats, queueStats } from '../kernel/jobs.js';
import { busInfo } from '../kernel/events.js';
import { contractInfo } from '../kernel/providers.js';

export const OBSERVABILITY_VERSION = 'rpos.observability@1.0';

const log = logger('rpos');

/** Performance budgets (documented targets from the platform design spec). */
export const BUDGETS = Object.freeze({
  apiP95Ms: 2000,          // any route group's p95 beyond this is a regression
  jobAvgMs: {              // per-kind average runtime budgets
    'twin.update': 2000,
    'twin.rebuild': 10000,
    'optimizer.run': 60000,
    'regatta.simulate': 120000,
  },
  jobAvgDefaultMs: 120000,
});

/** Row counts for the platform's hot tables (cheap: COUNT on indexed PKs). */
function tableCounts() {
  const tables = ['users', 'workouts', 'jobs', 'event_log', 'athlete_state', 'state_snapshots',
    'feature_cache', 'optimization_runs', 'race_simulations', 'research_workouts',
    'hypotheses', 'experiments', 'computation_log', 'model_performance'];
  const out = {};
  for (const t of tables) {
    try { out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { out[t] = null; }
  }
  return out;
}

function dbSizeBytes() {
  try { return fs.statSync(config.dbFile).size; } catch { return null; }
}

/** The full platform snapshot for the admin System tab / status endpoint. */
export function platformSnapshot() {
  return {
    version: OBSERVABILITY_VERSION,
    api: { ...metricsSnapshot(), latencyByGroup: latencySummary() },
    jobs: { execution: jobStats(), queue: queueStats() },
    events: busInfo(),
    contracts: contractInfo(),
    db: { sizeBytes: dbSizeBytes(), tables: tableCounts() },
  };
}

/* ------------------------- regression watchdog ------------------------- */

const alerted = new Set(); // one alert per offender per boot

function alertOnce(key, detail) {
  if (alerted.has(key)) return;
  alerted.add(key);
  log.error(`performance regression: ${detail}`);
  try {
    db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,NULL,?)')
      .run(uuid(), 'perf_regression', detail.slice(0, 400), now());
  } catch { /* telemetry must never cascade */ }
}

/** One watchdog pass; called periodically by the RPOS init. Exported so
 *  tests drive it deterministically. Returns the offenders found. */
export function watchdogTick() {
  const offenders = [];
  for (const [group, s] of Object.entries(latencySummary())) {
    if (s.samples >= 20 && s.p95 > BUDGETS.apiP95Ms) {
      offenders.push(`api:${group}`);
      alertOnce(`api:${group}`, `API group "${group}" p95 ${s.p95}ms exceeds budget ${BUDGETS.apiP95Ms}ms (${s.samples} samples)`);
    }
  }
  for (const row of jobStats()) {
    if (row.status !== 'completed' || !row.avg_ms || row.count < 3) continue;
    const budget = BUDGETS.jobAvgMs[row.kind] ?? BUDGETS.jobAvgDefaultMs;
    if (row.avg_ms > budget) {
      offenders.push(`job:${row.kind}`);
      alertOnce(`job:${row.kind}`, `Job "${row.kind}" average ${row.avg_ms}ms exceeds budget ${budget}ms over ${row.count} runs`);
    }
  }
  return offenders;
}

let watchdogTimer = null;

export function startWatchdog({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    try { watchdogTick(); } catch (e) { log.error(`watchdog tick failed: ${e.message}`); }
  }, intervalMs);
  watchdogTimer.unref();
}
