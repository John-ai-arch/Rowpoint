// Scientific Discovery Engine — wiring.
//
// Runs as a background job. Two triggers: an explicit research-admin request,
// and a low-frequency automatic pass after research contributions accumulate
// (coalesced, long-delayed, and gated to at most one auto-run per day — the
// engine is continuous but never busy). All analysis is deterministic per
// dataset snapshot, so re-triggering on unchanged data is a no-op by
// construction.
import { db } from '../db.js';
import { logger } from '../log.js';
import { register } from '../kernel/registry.js';
import { on } from '../kernel/events.js';
import { defineJob, enqueue } from '../kernel/jobs.js';
import { runDiscovery, datasetSnapshotId } from './analyses.js';
import { FEATURE_STORE_VERSION } from './featureStore.js';
export { discoveryRouter } from './api.js';

const log = logger('discovery');
const AUTO_RUN_MIN_INTERVAL_S = 24 * 3600;

let initialized = false;

export function initDiscoveryEngine() {
  if (initialized) return;
  initialized = true;

  register({ name: 'discovery.feature-store', kind: 'model', version: FEATURE_STORE_VERSION, description: 'Longitudinal research feature store (weekly derived variables per pseudonym)' });
  register({ name: 'discovery.hypotheses', kind: 'algorithm', version: '1.0', description: 'Automated hypothesis screens: correlations, archetype clustering, plateau analysis' });
  register({ name: 'discovery.stats-gate', kind: 'algorithm', version: '1.0', description: 'Statistical reporting gate: permutation p, bootstrap CI, BH correction, k-anonymity' });
  register({ name: 'discovery.cohorts', kind: 'model', version: '1.0', description: 'Anonymous cohort summaries over the feature store' });

  defineJob('discovery.run', {
    maxAttempts: 2,
    async handler({ payload }) {
      // Deterministic short-circuit: identical dataset → identical analysis;
      // skip if the latest analysis already covers this snapshot.
      const snapshot = datasetSnapshotId();
      const latest = db.prepare("SELECT dataset_snapshot FROM research_analyses WHERE kind = 'discovery' ORDER BY created_at DESC LIMIT 1").get();
      if (latest?.dataset_snapshot === snapshot && payload.trigger !== 'admin') {
        log.info('discovery skipped: dataset unchanged since last analysis');
        return;
      }
      const result = runDiscovery({ trigger: payload.trigger || 'auto' });
      log.info(`discovery ${result.analysisId}: ${result.findings} candidate findings from ${result.athletesAnalyzed} athletes (${result.durationMs}ms)`);
    },
  });

  on('research.snapshot', 'discovery', () => {
    const last = db.prepare("SELECT created_at FROM research_analyses WHERE kind = 'discovery' ORDER BY created_at DESC LIMIT 1").get();
    if (last && Math.floor(Date.now() / 1000) - last.created_at < AUTO_RUN_MIN_INTERVAL_S) return;
    // Long delay + coalescing: a week's worth of contributions still yields
    // one analysis run.
    enqueue('discovery.run', { payload: { trigger: 'auto' }, priority: 8, delaySeconds: 600 });
  });
}
