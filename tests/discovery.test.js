// Scientific Discovery Engine validation: the longitudinal feature store
// (with recorded exclusions), the statistical gate (permutation p, paired
// bootstrap, BH correction, k-anonymity), hypothesis generation against
// ENGINEERED ground truth, byte-level reproducibility per dataset snapshot,
// the human review queue, and strict research-admin access control.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = `/tmp/rowpoint-disc-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_BACKUPS_ENABLED = '0';
process.env.ROWPOINT_JOBS_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

const { startServer } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { processPending } = await import('../server/kernel/jobs.js');
const { createRng } = await import('../server/kernel/rng.js');
const { buildFeatureStore, athleteAggregates, isoWeekKey } = await import('../server/discovery/featureStore.js');
const { permutationP, pairedBootstrapCI, correlationTest, groupComparison, gateScreen, MIN_SUBGROUP } = await import('../server/discovery/statsTests.js');
const { generateHypotheses } = await import('../server/discovery/hypotheses.js');
const { runDiscovery, datasetSnapshotId } = await import('../server/discovery/analyses.js');
const { cohortSummary } = await import('../server/discovery/cohorts.js');
const { spearman } = await import('../server/kernel/stats.js');

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---- synthetic research population with ENGINEERED ground truth ----
   14 pseudonymous athletes, 10 weeks each. Athlete i trains 120+i·15
   min/week; their weekly split improves proportionally to volume — so
   "higher volume ↔ faster improvement" is TRUE in this dataset and the
   correlation screen must find it (negative ρ against the slope). */
const WEEK_S = 7 * 86400;
const T0 = Math.floor(Date.now() / 1000) - 12 * WEEK_S;

function seedResearchData() {
  const ins = db.prepare(`INSERT INTO research_workouts (
      id, research_id, study_tag, machine_type, workout_type, started_at,
      total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
      avg_heart_rate, hr_drift_pct, measurement_confidence, quality_flags,
      age_range, sex, competition_level, training_environment, contributed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rng = createRng(1234);
  for (let i = 0; i < 14; i++) {
    const rid = `synthetic-athlete-${String(i).padStart(2, '0')}`;
    const weeklyMinutes = 120 + i * 15;
    const improvementPerWeek = 0.05 + i * 0.045; // s/500m faster per week, scales with volume
    for (let w = 0; w < 10; w++) {
      const sessions = 3 + (i % 3);
      const sessionMinutes = weeklyMinutes / sessions;
      for (let s = 0; s < sessions; s++) {
        const split = 135 - improvementPerWeek * w + rng.gaussian(0, 0.4);
        const timeS = Math.round(sessionMinutes * 60);
        const dist = Math.round((timeS / split) * 500);
        ins.run(
          crypto.randomUUID(), rid, 'baseline-2026', 'rower', 'steady',
          T0 + w * WEEK_S + s * 86400 + 3600,
          dist, timeS, Math.round(split * 10) / 10, 22,
          150, Math.round(rng.gaussian(3, 1) * 10) / 10, 0.9, '[]',
          i < 7 ? '18-24' : '25-34', i % 2 ? 'female' : 'male', 'club', 'erg',
          T0 + w * WEEK_S,
        );
      }
    }
  }
  // Two garbage rows that MUST be excluded (and recorded as such).
  ins.run(crypto.randomUUID(), 'synthetic-athlete-00', 'baseline-2026', 'rower', 'steady',
    T0, 0, 0, null, 22, 150, null, 0.1, JSON.stringify(['zero_distance', 'zero_time']),
    '18-24', 'male', 'club', 'erg', T0);
  ins.run(crypto.randomUUID(), 'synthetic-athlete-01', 'baseline-2026', 'rower', 'steady',
    T0, 500, 30, 45, 22, 150, null, 0.2, JSON.stringify(['impossible_pace', 'very_short_piece']),
    '18-24', 'female', 'club', 'erg', T0);
}
seedResearchData();

/* ------------------------------ stats gate ------------------------------ */

test('permutation p and paired bootstrap: correct behavior on signal vs noise', () => {
  const xs = Array.from({ length: 20 }, (_, i) => i);
  const linked = xs.map(x => x * 2 + 1);
  const rng1 = createRng(1), rng2 = createRng(1);
  const pSignal = permutationP(xs, linked, spearman, { rng: createRng(2) });
  assert.ok(pSignal < 0.01, `perfect monotone relation → tiny p, got ${pSignal}`);
  assert.deepEqual(
    permutationP(xs, linked, spearman, { rng: rng1 }),
    permutationP(xs, linked, spearman, { rng: rng2 }),
    'seeded → reproducible');
  const noise = createRng(9);
  const pNoise = permutationP(xs, xs.map(() => noise.float()), spearman, { rng: createRng(3) });
  assert.ok(pNoise > 0.05, `independent noise → non-significant, got ${pNoise}`);
  const ci = pairedBootstrapCI(xs, linked, spearman, { rng: createRng(4) });
  assert.ok(ci.lo > 0.9, 'CI for a perfect relation hugs 1');
});

test('gate: small samples refuse, k-anonymity suppresses, warnings attach', () => {
  const tiny = correlationTest([1, 2, 3], [3, 2, 1], { seed: 1, label: 't' });
  assert.equal(tiny.available, false);
  assert.match(tiny.reason, /≥8 athletes/);

  const cmp = groupComparison([1, 2, 3, 4], [5, 6, 7, 8, 9]);
  assert.equal(cmp.available, false, `subgroup of 4 < floor ${MIN_SUBGROUP}`);
  assert.match(cmp.reason, /anonymity/);

  const screened = gateScreen([
    { stats: { available: true, effect: 0.1, p: 0.04, n: 10, ci95: { lo: -0.2, hi: 0.4 } } },
    { stats: { available: true, effect: 0.6, p: 0.001, n: 40, ci95: { lo: 0.3, hi: 0.8 } } },
  ]);
  assert.equal(screened[0].evidence, 'exploratory');
  assert.ok(screened[0].warnings.some(w => w.includes('small sample')));
  assert.ok(screened[0].warnings.some(w => w.includes('crosses zero')));
  assert.ok(screened[0].warnings.some(w => w.includes('practical-significance')));
  assert.equal(screened[1].warnings.length, 0, 'a strong clean effect carries no warnings');
  assert.ok(screened[1].stats.pAdjusted >= screened[1].stats.p, 'BH never shrinks p');
});

/* ---------------------------- feature store ---------------------------- */

test('feature store: weekly features computed, exclusions recorded with reasons', () => {
  const result = buildFeatureStore('analysis-test-1');
  assert.equal(result.athletes, 14);
  assert.ok(result.weeks >= 10);
  assert.equal(result.excluded, 2, 'both garbage rows excluded');
  const excl = db.prepare("SELECT * FROM research_exclusions WHERE analysis_id = 'analysis-test-1'").all();
  assert.equal(excl.length, 2);
  assert.ok(excl.every(e => e.reason.includes('quality flags')), 'every exclusion names its reason');

  const rows = db.prepare("SELECT * FROM research_features WHERE feature = 'weekly_minutes' AND research_id = 'synthetic-athlete-13'").all();
  assert.ok(rows.length >= 10);
  assert.ok(rows.every(r => r.version === '1.0'), 'features carry the store version');
  const highVol = rows[0].value;
  const lowVol = db.prepare("SELECT value FROM research_features WHERE feature = 'weekly_minutes' AND research_id = 'synthetic-athlete-00' LIMIT 1").get().value;
  assert.ok(highVol > lowVol + 100, 'engineered volume gradient survives into features');

  const aggs = athleteAggregates({ minWeeks: 4 });
  assert.equal(aggs.length, 14);
  const fastest = aggs.find(a => a.researchId === 'synthetic-athlete-13');
  const slowest = aggs.find(a => a.researchId === 'synthetic-athlete-00');
  assert.ok(fastest.improvement_slope < slowest.improvement_slope, 'high-volume athlete improves faster (engineered)');
  assert.ok(fastest.improvement_slope < -0.3, `strong negative slope, got ${fastest.improvement_slope}`);
});

test('isoWeekKey follows the ISO-8601 convention', () => {
  assert.equal(isoWeekKey(Math.floor(Date.UTC(2026, 0, 1) / 1000)), '2026-W01');
  assert.equal(isoWeekKey(Math.floor(Date.UTC(2024, 11, 30) / 1000)), '2025-W01', 'Dec 30 2024 belongs to ISO week 2025-W01');
});

/* --------------------------- hypothesis engine --------------------------- */

test('hypothesis engine finds the engineered volume↔improvement relationship', () => {
  const athletes = athleteAggregates({ minWeeks: 4 });
  const { findings } = generateHypotheses(athletes, 42);
  assert.ok(findings.length >= 1, 'at least one candidate emerges from strong engineered signal');
  const volume = findings.find(f => f.kind === 'correlation' && f.title.toLowerCase().includes('volume'));
  assert.ok(volume, `the volume↔improvement screen fires; got: ${findings.map(f => f.title).join(' | ')}`);
  assert.ok(volume.stats.effect < -0.5, `strong negative ρ vs slope (faster), got ${volume.stats.effect}`);
  assert.ok(volume.stats.pAdjusted <= 0.05, 'survives BH correction');
  assert.match(volume.narrative, /FASTER/);
  assert.match(volume.narrative, /not evidence that changing/i, 'causal disclaimer travels with the finding');
  assert.equal(volume.evidence, 'exploratory');
  assert.ok(volume.confounders.length >= 3);
  assert.ok(volume.followUp.length > 10);
});

test('hypothesis engine refuses small datasets outright', () => {
  const { findings, skipped } = generateHypotheses([{ improvement_slope: -1 }, { improvement_slope: 0 }], 1);
  assert.equal(findings.length, 0);
  assert.match(skipped, /requires ≥8/);
});

/* ----------------------- reproducibility & runs ----------------------- */

test('discovery runs are deterministic per dataset snapshot', () => {
  const snap1 = datasetSnapshotId();
  const run1 = runDiscovery({ trigger: 'admin' });
  const run2 = runDiscovery({ trigger: 'admin' });
  assert.equal(datasetSnapshotId(), snap1, 'unchanged data → unchanged snapshot id');
  assert.equal(run1.snapshot, run2.snapshot);
  const f1 = db.prepare('SELECT title, body_json FROM research_findings WHERE analysis_id = ? ORDER BY title').all(run1.analysisId);
  const f2 = db.prepare('SELECT title, body_json FROM research_findings WHERE analysis_id = ? ORDER BY title').all(run2.analysisId);
  // run2 replaced run1's pending queue; compare the recorded analyses instead.
  assert.equal(f1.length, 0, 'older pending findings were superseded');
  assert.ok(f2.length >= 1);
  const a1 = db.prepare('SELECT seed, results_json FROM research_analyses WHERE id = ?').get(run1.analysisId);
  const a2 = db.prepare('SELECT seed, results_json FROM research_analyses WHERE id = ?').get(run2.analysisId);
  assert.equal(a1.seed, a2.seed, 'seed derives from the dataset snapshot');
  assert.deepEqual(
    { ...JSON.parse(a1.results_json), durationMs: 0 },
    { ...JSON.parse(a2.results_json), durationMs: 0 },
    'identical dataset + seed → identical results');
});

/* -------------------------------- cohorts -------------------------------- */

test('cohorts: summaries are quartiles-only and k-anonymity gated', () => {
  const all = cohortSummary({});
  assert.equal(all.suppressed, false);
  assert.equal(all.n, 14);
  assert.ok(all.distributions.weekly_minutes.median > 0);
  assert.equal(Object.keys(all.distributions.weekly_minutes).sort().join(','), 'mean,median,n,q25,q75', 'no raw values, only summaries');

  const women = cohortSummary({ sex: 'female' });
  assert.equal(women.suppressed, false, '7 female athletes clear the floor');
  assert.ok(women.n >= MIN_SUBGROUP);

  const tiny = cohortSummary({ sex: 'female', ageRange: '25-34' });
  assert.equal(tiny.suppressed, true, 'a 3-athlete cohort refuses to report');
  assert.equal(tiny.n, null, 'not even the count leaks');
});

/* ------------------------------ API + access ------------------------------ */

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), raw: r };
}

async function makeUser(email) {
  const su = await req('/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: email.split('@')[0], accountType: 'rower' } });
  const v = await req('/auth/verify', { method: 'POST', body: { email, code: su.body.devCode } });
  return { token: v.body.token, user: v.body.user };
}

test('API: research-admin gating, review queue, audited report export', async () => {
  const athlete = await makeUser('disc-athlete@test.com');
  assert.equal((await req('/research-admin/discovery/status', { token: athlete.token })).status, 403, 'athletes can never reach discovery');
  assert.equal((await req('/research-admin/discovery/findings', { token: athlete.token })).status, 403);

  const admin = await makeUser('disc-admin@test.com');
  db.prepare("UPDATE users SET role = 'admin', research_admin = 1 WHERE id = ?").run(admin.user.id);

  const status = await req('/research-admin/discovery/status', { token: admin.token });
  assert.equal(status.status, 200);
  assert.ok(status.body.status.featureStore.rows > 0);

  // Trigger a run through the job system and drain it.
  const run = await req('/research-admin/discovery/run', { method: 'POST', token: admin.token });
  assert.equal(run.status, 202);
  await processPending();

  const pending = await req('/research-admin/discovery/findings?status=pending', { token: admin.token });
  assert.ok(pending.body.findings.length >= 1);
  const finding = pending.body.findings[0];
  assert.ok(finding.datasetSnapshot && Number.isFinite(finding.seed), 'every finding carries its reproducibility reference');
  assert.ok(!JSON.stringify(pending.body).includes('synthetic-athlete-'), 'no pseudonym ever appears in a finding');

  // Approve with a note; it moves out of pending and into the report.
  const review = await req(`/research-admin/discovery/findings/${finding.id}/review`, {
    method: 'POST', token: admin.token, body: { action: 'approve', note: 'Direction is plausible; needs within-athlete replication.' },
  });
  assert.equal(review.status, 200);
  const approved = await req('/research-admin/discovery/findings?status=approved', { token: admin.token });
  assert.ok(approved.body.findings.some(f => f.id === finding.id));

  const report = await req('/research-admin/discovery/report', { token: admin.token });
  assert.equal(report.status, 200);
  assert.ok(report.body.findings.some(f => f.title === finding.title));
  assert.match(report.body.note, /exploratory/i);
  assert.ok(report.body.findings[0].reproducibility.datasetSnapshot, 'report embeds reproducibility metadata');

  // Everything above was audited.
  const auditRows = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'research.discovery.%'").all();
  for (const action of ['research.discovery.run', 'research.discovery.finding.approve', 'research.discovery.report.export']) {
    assert.ok(auditRows.some(a => a.action === action), `${action} audited`);
  }

  // Exclusions are inspectable.
  const excl = await req('/research-admin/discovery/exclusions', { token: admin.token });
  assert.ok(excl.body.exclusions.length >= 2);
});

test('teardown', () => {
  server.close();
});
