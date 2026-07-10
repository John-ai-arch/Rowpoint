// Experiments engine validation: Bayesian hypothesis updating, the seeded
// registry + knowledge graph, safety-bounded experiment planning, the
// consent lifecycle over the API, automatic stopping conditions, outcome
// evaluation with honest small-n rules, the prediction-vs-outcome
// meta-learning loop, the promotion rule, and the append-only notebook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = `/tmp/rowpoint-exp-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_BACKUPS_ENABLED = '0';
process.env.ROWPOINT_JOBS_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

const { startServer } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { processPending } = await import('../server/kernel/jobs.js');
const { emit } = await import('../server/kernel/events.js');
const { updateHypothesis, priorToAlphaBeta, hypothesisUncertainty } = await import('../server/experiments/bayes.js');
const { listHypotheses, getHypothesis, SEED_HYPOTHESES } = await import('../server/experiments/hypothesisRegistry.js');
const { graphStats, exportGraph } = await import('../server/experiments/knowledgeGraph.js');
const { validateRacePrediction, modelScorecards, evaluatePromotion, recordPerformance, PROMOTION_MIN_OUTCOMES } = await import('../server/experiments/modelComparison.js');
const { evaluateExperiment } = await import('../server/experiments/evaluator.js');
const { readNotebook, exportNotebook } = await import('../server/experiments/notebook.js');

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function makeUser(email) {
  const su = await req('/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: email.split('@')[0], accountType: 'rower' } });
  const v = await req('/auth/verify', { method: 'POST', body: { email, code: su.body.devCode } });
  return { token: v.body.token, user: v.body.user };
}

const uuid = () => crypto.randomUUID();
function workoutBody({ paces, daysAgo = 0, plan = null, intervals = false }) {
  const splits = paces.map((p, i) => ({ distanceM: 500, timeS: p, avgPaceSPer500m: p, avgStrokeRate: 24, avgHeartRate: 152, intervalIndex: intervals ? i : undefined }));
  const t = paces.reduce((a, b) => a + b, 0);
  return {
    id: uuid(), totalDistanceM: paces.length * 500, totalTimeS: t, machineType: 'rower', splits,
    startedAt: Math.floor(Date.now() / 1000) - daysAgo * 86400 - t, ...(plan ? { plan } : {}),
  };
}

/* ------------------------------- bayes ------------------------------- */

test('bayes: priors map to Beta, support raises confidence, contradiction lowers it, history records', () => {
  const { alpha, beta } = priorToAlphaBeta(0.7);
  assert.ok(Math.abs(alpha / (alpha + beta) - 0.7) < 1e-9);

  const before = getHypothesis('taper-freshness');
  const up = updateHypothesis('taper-freshness', true, { source: 'test', detail: 'supporting evidence' });
  assert.ok(up.confidence > before.confidence, 'support raises confidence');
  const down1 = updateHypothesis('taper-freshness', false, { source: 'test', detail: 'contradiction', weight: 1 });
  assert.ok(down1.confidence < up.confidence, 'contradiction lowers it');

  const h = getHypothesis('taper-freshness');
  assert.equal(h.validationHistory.length, 2, 'every update recorded');
  assert.equal(h.validationHistory[0].supported, true);
  assert.ok(h.validationHistory[1].confidenceBefore > h.validationHistory[1].confidenceAfter);
  assert.ok(readNotebook({ kind: 'hypothesis-update' }).length >= 2, 'notebook mirrors every belief change');

  assert.ok(hypothesisUncertainty(0.5) > hypothesisUncertainty(0.9), 'uncertainty peaks at 0.5');
});

test('registry + knowledge graph seeded from documented model assumptions', () => {
  const hyps = listHypotheses();
  assert.ok(hyps.length >= SEED_HYPOTHESES.length);
  for (const seed of SEED_HYPOTHESES) {
    const h = hyps.find(x => x.id === seed.key);
    assert.ok(h, `${seed.key} seeded`);
    assert.equal(h.originModel, seed.originModel, 'every assumption names its origin model');
  }
  const stats = graphStats();
  assert.ok(stats.nodes.hypothesis >= 8 && stats.nodes.model >= 5 && stats.nodes.variable >= 8);
  assert.ok(stats.edges.assumes >= 8, 'model→hypothesis assumption edges exist');
  const graph = exportGraph();
  const edge = graph.edges.find(e => e.relation === 'assumes');
  assert.ok(edge.evidenceSource && edge.lastValidatedAt, 'edges carry evidence source and validation date');
});

/* --------------------- consent + lifecycle over API --------------------- */

let ann;

test('experiments require explicit consent; planner is safety-bounded and explains refusals', async () => {
  ann = await makeUser('exp-ann@test.com');

  // No consent → proposals refuse with the reason.
  const refused = await req('/experiments/propose', { method: 'POST', token: ann.token });
  assert.equal(refused.body.proposed, false);
  assert.match(refused.body.reason, /not enabled/i);

  await req('/experiments/consent', { method: 'POST', token: ann.token, body: { status: 'active' } });

  // Consent alone isn't enough: with no training history, every template is
  // blocked — and each blocker is named.
  const blocked = await req('/experiments/propose', { method: 'POST', token: ann.token });
  assert.equal(blocked.body.proposed, false);
  assert.ok(blocked.body.details.every(d => d.blockedBy.length > 0), 'every template names why it does not fit');
  assert.ok(blocked.body.details.some(d => d.blockedBy.some(r => /28 days/.test(r))));

  // Build history: 12 workouts over 3 weeks, including interval sessions —
  // enough for the rest-interval template's envelope.
  for (let i = 0; i < 12; i++) {
    const isIntervals = i % 3 === 0;
    await req('/workouts/sync', {
      method: 'POST', token: ann.token,
      body: workoutBody({
        paces: isIntervals ? [112, 113, 114, 113] : [128, 129, 128, 129, 128, 129],
        daysAgo: 21 - i * 1.7,
        plan: isIntervals ? { type: 'intervals', intervals: Array.from({ length: 4 }, () => ({ workType: 'distance', workDistanceM: 500, restTimeS: 60 })) } : { type: 'distance', distanceM: 3000 },
        intervals: isIntervals,
      }),
    });
  }
  await processPending(); // twin pipeline → features + state

  const proposed = await req('/experiments/propose', { method: 'POST', token: ann.token });
  assert.equal(proposed.body.proposed, true, JSON.stringify(proposed.body));
  const protocol = proposed.body.protocol;
  assert.ok(protocol.hypothesisStatement, 'protocol names the hypothesis it tests');
  assert.ok(protocol.stoppingConditions.length >= 4, 'stopping conditions are explicit');
  assert.ok(protocol.expectedInformationGain > 0);
  assert.ok(protocol.envelope.zones.length >= 1, 'protocol records the athlete envelope it respects');

  // Only one open experiment at a time.
  const dup = await req('/experiments/propose', { method: 'POST', token: ann.token });
  assert.equal(dup.body.proposed, false);

  // Accept → active with an evaluation job scheduled at the window end.
  const accept = await req(`/experiments/${proposed.body.experimentId}/accept`, { method: 'POST', token: ann.token });
  assert.equal(accept.status, 200);
  const job = db.prepare("SELECT * FROM jobs WHERE kind = 'experiments.evaluate' AND status = 'pending'").get();
  assert.ok(job, 'evaluation scheduled');
  assert.ok(job.run_at > Math.floor(Date.now() / 1000) + 20 * 86400, 'scheduled at the experiment window end');

  // Own-data: Ben cannot see or touch Ann's experiment.
  const ben = await makeUser('exp-ben@test.com');
  const benMine = await req('/experiments/mine', { token: ben.token });
  assert.equal(benMine.body.experiments.length, 0);
  const steal = await req(`/experiments/${proposed.body.experimentId}/stop`, { method: 'POST', token: ben.token });
  assert.equal(steal.status, 404);
});

test('withdrawing consent stops the running experiment immediately', async () => {
  const active = db.prepare("SELECT id FROM experiments WHERE user_id = ? AND status = 'active'").get(ann.user.id);
  assert.ok(active);
  await req('/experiments/consent', { method: 'POST', token: ann.token, body: { status: 'paused' } });
  const row = db.prepare('SELECT status, stop_reason FROM experiments WHERE id = ?').get(active.id);
  assert.equal(row.status, 'stopped');
  assert.equal(row.stop_reason, 'consent-withdrawn');
});

test('stopping conditions fire automatically on twin updates', async () => {
  // Re-enable and start a fresh experiment.
  await req('/experiments/consent', { method: 'POST', token: ann.token, body: { status: 'active' } });
  const proposed = await req('/experiments/propose', { method: 'POST', token: ann.token });
  assert.equal(proposed.body.proposed, true);
  await req(`/experiments/${proposed.body.experimentId}/accept`, { method: 'POST', token: ann.token });

  // Force a dangerous strain state, then emit the twin update the engine watches.
  db.prepare(`INSERT INTO athlete_state (user_id, category, variable, value, uncertainty, confidence, provenance, model_version, evidence_count, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, category, variable) DO UPDATE SET value = excluded.value`)
    .run(ann.user.id, 'injuryRisk', 'riskIndex', 85, 10, 0.8, 'estimated', 'test@1.0', 5, Math.floor(Date.now() / 1000));
  emit('twin.updated', { userId: ann.user.id, variables: 1, trigger: 'test' });

  const row = db.prepare('SELECT status, stop_reason FROM experiments WHERE id = ?').get(proposed.body.experimentId);
  assert.equal(row.status, 'stopped', 'high strain risk stops the experiment');
  assert.equal(row.stop_reason, 'high-strain');
  // Clean up the injected state for later tests.
  db.prepare("DELETE FROM athlete_state WHERE user_id = ? AND category = 'injuryRisk'").run(ann.user.id);
});

/* ----------------------------- evaluation ----------------------------- */

test('outcome evaluation: too little data → inconclusive, beliefs untouched', async () => {
  await req('/experiments/consent', { method: 'POST', token: ann.token, body: { status: 'active' } });
  const proposed = await req('/experiments/propose', { method: 'POST', token: ann.token });
  await req(`/experiments/${proposed.body.experimentId}/accept`, { method: 'POST', token: ann.token });
  // Close the window immediately: whatever few qualifying workouts fall in
  // each half, it's below the ≥4-per-arm bar.
  const expId = proposed.body.experimentId;
  const confBefore = getHypothesis(db.prepare('SELECT hypothesis_id FROM experiments WHERE id = ?').get(expId).hypothesis_id)?.confidence;
  db.prepare('UPDATE experiments SET started_at = ?, ends_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 28 * 86400, Math.floor(Date.now() / 1000) - 27 * 86400, expId);
  const outcome = evaluateExperiment(expId);
  assert.equal(outcome.conclusion, 'inconclusive');
  assert.match(outcome.reason, /too few/);
  const row = db.prepare('SELECT status, hypothesis_id FROM experiments WHERE id = ?').get(expId);
  assert.equal(row.status, 'completed');
  assert.equal(getHypothesis(row.hypothesis_id)?.confidence, confBefore, 'inconclusive outcomes move no beliefs');
  assert.ok(readNotebook({ kind: 'experiment-completed' }).length >= 1, 'but they ARE recorded');
});

/* ---------------------- meta-learning validation loop ---------------------- */

test('real 2k outcomes score standing predictions and update the Riegel hypothesis', async () => {
  // A standing prediction: 2k in 8:20 with a ±5% interval.
  db.prepare(`INSERT INTO predictions (id, user_id, kind, payload_json, model_version, confidence, created_at)
      VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), ann.user.id, 'race', JSON.stringify({
      available: true,
      predictions: [{ distance: 2000, timeS: 500, lowS: 475, highS: 525 }],
    }), 'twin.predictor.race@1.0', 0.75, Math.floor(Date.now() / 1000) - 3600);

  const before = getHypothesis('riegel-endurance').confidence;
  // Actual 2k: 8:24 (504s) — inside the interval → calibration hit.
  const w = {
    workout_plan_json: JSON.stringify({ type: 'distance', distanceM: 2000 }),
    total_distance_m: 2000, total_time_s: 504, started_at: Math.floor(Date.now() / 1000),
  };
  const result = validateRacePrediction(ann.user.id, w);
  assert.equal(result.withinInterval, true);
  assert.ok(Math.abs(result.errorS - 4) < 0.01);
  assert.ok(getHypothesis('riegel-endurance').confidence > before, 'a calibration hit supports the model hypothesis');

  const cards = modelScorecards();
  const card = cards.find(c => c.model === 'twin.predictor.race');
  assert.equal(card.outcomes, 1);
  assert.equal(card.meanAbsErrorS, 4);
  assert.equal(card.intervalHitRate, 1);
  assert.equal(card.statedConfidence, 0.75, 'stated confidence recorded for calibration comparison');
});

test('promotion rule: waits for evidence, promotes on sustained superiority, records the transition', () => {
  // Incumbent: mean abs error 10s; challenger: 6s over enough outcomes.
  for (let i = 0; i < PROMOTION_MIN_OUTCOMES; i++) {
    recordPerformance('test.model', '1.0', 'abs_error_s', 10 + (i % 3));
    recordPerformance('test.model', '1.1', 'abs_error_s', 6 + (i % 3));
    recordPerformance('test.model', '1.1', 'interval_hit', 1);
    recordPerformance('test.model', '1.0', 'interval_hit', 1);
  }
  const early = evaluatePromotion('test.model', '1.0', '2.0');
  assert.equal(early.decision, 'insufficient-data');
  const promote = evaluatePromotion('test.model', '1.0', '1.1');
  assert.equal(promote.decision, 'promote', JSON.stringify(promote));
  const transition = db.prepare("SELECT * FROM model_transitions WHERE model_name = 'test.model'").get();
  assert.ok(transition, 'transition recorded');
  assert.match(transition.reason, /better over/);
});

/* --------------------- findings → hypotheses (event) --------------------- */

test('approved discovery findings update mapped hypotheses through the event bus', () => {
  const before = getHypothesis('steady-volume-aerobic').confidence;
  emit('research.finding-reviewed', {
    action: 'approve', kind: 'correlation',
    title: 'Weekly training volume vs long-term improvement', effect: -0.6,
  });
  assert.ok(getHypothesis('steady-volume-aerobic').confidence > before, 'population evidence moves the mapped hypothesis');
  const dismissed = getHypothesis('monotony-plateau').confidence;
  emit('research.finding-reviewed', { action: 'dismiss', kind: 'plateau', title: 'x', effect: 0.5 });
  assert.equal(getHypothesis('monotony-plateau').confidence, dismissed, 'dismissals move nothing');
});

/* ------------------------- notebook + admin API ------------------------- */

test('notebook is append-only and exports; validation dashboard is admin-gated', async () => {
  const full = exportNotebook();
  assert.ok(full.entryCount >= 6, 'the session left a scientific paper trail');
  assert.ok(full.entries.every(e => e.kind && e.at), 'entries are structured');
  assert.ok(!JSON.stringify(full).includes(ann.user.id), 'no athlete id in the notebook export');

  const athleteBlocked = await req('/research-admin/validation/overview', { token: ann.token });
  assert.equal(athleteBlocked.status, 403);

  const admin = await makeUser('exp-admin@test.com');
  db.prepare("UPDATE users SET role = 'admin', research_admin = 1 WHERE id = ?").run(admin.user.id);
  const overview = await req('/research-admin/validation/overview', { token: admin.token });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.hypotheses.length >= 8);
  assert.ok(overview.body.scorecards.some(c => c.model === 'twin.predictor.race'));
  assert.ok(overview.body.graph.totalEdges > 0);
  assert.ok(overview.body.experiments.completed >= 1);
});

test('privacy: deleting experiment contributions removes the rows and records the deletion', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM experiments WHERE user_id = ?').get(ann.user.id).c;
  assert.ok(before > 0);
  const del = await req('/experiments/contributions', { method: 'DELETE', token: ann.token });
  assert.equal(del.body.deleted, before);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM experiments WHERE user_id = ?').get(ann.user.id).c, 0);
  assert.ok(readNotebook({ kind: 'privacy-deletion' }).length >= 1);
});

test('teardown', () => {
  server.close();
});
