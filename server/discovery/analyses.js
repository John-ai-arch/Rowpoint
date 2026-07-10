// Discovery orchestration + reproducibility.
//
// One discovery run = one immutable research_analyses record: the dataset
// snapshot identifier (content-derived — same data, same id), the seed
// (derived FROM the snapshot, so identical datasets produce identical
// analyses), component versions, config, and results summary. Fresh
// candidate findings replace the previous run's still-pending queue;
// reviewed findings (approved/dismissed) are never touched.
import crypto from 'node:crypto';
import { db, inTransaction } from '../db.js';
import { uuid, now } from '../util.js';
import { seedFrom } from '../kernel/rng.js';
import { versionManifest } from '../kernel/registry.js';
import { buildFeatureStore, athleteAggregates, FEATURE_STORE_VERSION } from './featureStore.js';
import { generateHypotheses, HYPOTHESIS_ENGINE_VERSION } from './hypotheses.js';
import { STATS_GATE_VERSION } from './statsTests.js';

/**
 * Content-derived dataset snapshot id: row count + latest contribution +
 * a sample hash of ids. Identical data → identical snapshot id → identical
 * seed → byte-identical analysis.
 */
export function datasetSnapshotId() {
  const meta = db.prepare('SELECT COUNT(*) AS n, MAX(contributed_at) AS latest FROM research_workouts').get();
  const idsHash = crypto.createHash('sha256')
    .update(db.prepare('SELECT id FROM research_workouts ORDER BY id').all().map(r => r.id).join(','))
    .digest('hex').slice(0, 16);
  return `rw-${meta.n}-${meta.latest || 0}-${idsHash}`;
}

/**
 * Run the full discovery pipeline. Returns the analysis record summary.
 * `trigger` is recorded (admin | auto) for the audit trail.
 */
export function runDiscovery({ trigger = 'admin', minWeeks = 4 } = {}) {
  const startedMs = Date.now();
  const snapshot = datasetSnapshotId();
  const seed = seedFrom(snapshot);
  const analysisId = uuid();
  const config = { trigger, minWeeks, featureStoreVersion: FEATURE_STORE_VERSION };

  const store = buildFeatureStore(analysisId);
  const athletes = athleteAggregates({ minWeeks });
  const generated = generateHypotheses(athletes, seed);

  const results = {
    snapshot,
    featureStore: store,
    athletesAnalyzed: generated.athletesAnalyzed ?? athletes.length,
    findings: generated.findings.length,
    skipped: generated.skipped || null,
    durationMs: Date.now() - startedMs,
  };

  inTransaction(() => {
    db.prepare(`INSERT INTO research_analyses (id, kind, dataset_snapshot, config_json, seed, versions_json, results_json, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(analysisId, 'discovery', snapshot, JSON.stringify(config), seed,
        JSON.stringify(versionManifest([
          'discovery.feature-store', 'discovery.hypotheses', 'discovery.stats-gate',
        ]).concat([`inline:${HYPOTHESIS_ENGINE_VERSION}`, `inline:${STATS_GATE_VERSION}`])),
        JSON.stringify(results), now());

    // Fresh queue: stale pending candidates from older runs are superseded;
    // human-reviewed rows are permanent.
    db.prepare("DELETE FROM research_findings WHERE status = 'pending'").run();
    const ins = db.prepare(`INSERT INTO research_findings (id, analysis_id, kind, title, body_json, status, created_at)
        VALUES (?,?,?,?,?,'pending',?)`);
    for (const f of generated.findings) {
      ins.run(uuid(), analysisId, f.kind, f.title.slice(0, 200), JSON.stringify(f), now());
    }
  });

  return { analysisId, ...results };
}

/** Latest analysis + queue counts (dashboard status panel). */
export function discoveryStatus() {
  const latest = db.prepare("SELECT * FROM research_analyses WHERE kind = 'discovery' ORDER BY created_at DESC LIMIT 1").get();
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM research_findings GROUP BY status').all().map(r => [r.status, r.n]));
  const features = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT research_id) AS athletes FROM research_features').get();
  return {
    latest: latest ? {
      id: latest.id,
      snapshot: latest.dataset_snapshot,
      seed: latest.seed,
      results: JSON.parse(latest.results_json || '{}'),
      createdAt: latest.created_at,
    } : null,
    findings: { pending: counts.pending || 0, approved: counts.approved || 0, dismissed: counts.dismissed || 0 },
    featureStore: { rows: features.n, athletes: features.athletes, version: FEATURE_STORE_VERSION },
  };
}
