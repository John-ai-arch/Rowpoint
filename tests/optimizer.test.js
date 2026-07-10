// Optimizer validation: the fitness–fatigue simulator's dynamics, constraint
// gating and repair, multi-objective scoring, Pareto extraction, all three
// search strategies (+ the benchmark harness), Monte Carlo reproducibility,
// sensitivity scenarios, counterfactual evaluation, and the full job-backed
// API flow with reproducibility records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = `/tmp/rowpoint-opt-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_BACKUPS_ENABLED = '0';
process.env.ROWPOINT_JOBS_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

const { startServer } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { processPending } = await import('../server/kernel/jobs.js');
const { createRng } = await import('../server/kernel/rng.js');
const { simulatePlan } = await import('../server/optimizer/simulate.js');
const { seedPlans, mutatePlan, planSignature } = await import('../server/optimizer/planSpace.js');
const { defaultConstraints, checkConstraints, repairPlan } = await import('../server/optimizer/constraints.js');
const { scorePlan, adherencePlausibility, scalarize } = await import('../server/optimizer/objectives.js');
const { paretoFrontier, dominates, explainTradeoffs } = await import('../server/optimizer/pareto.js');
const { STRATEGIES, benchmarkStrategies } = await import('../server/optimizer/search/index.js');
const { evaluatePlansMC } = await import('../server/optimizer/monteCarlo.js');
const { sensitivityAnalysis } = await import('../server/optimizer/sensitivity.js');

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

const ATHLETE = { chronicWeeklyLoad: 250, recoveryHalfLifeH: 24, adherenceBase: 0.9, sessionsPerWeek: 4, typicalSessionMinutes: 50 };
const mkProblem = (horizonDays = 28) => {
  const constraints = defaultConstraints({ weeklyMinutesRecent: 240, chronicWeeklyLoad: 250 });
  return {
    horizonDays,
    athlete: ATHLETE,
    seeds: seedPlans({ horizonDays, sessionsPerWeek: 4, sessionMinutes: 50 }),
    constraints,
    raceDayIndex: null,
    weights: {},
    evaluate: (days) => scorePlan(days, simulatePlan(days, ATHLETE), ATHLETE, {}),
  };
};

/* ------------------------------ simulator ------------------------------ */

test('simulator: training builds fitness, rest sheds fatigue, dose-response holds', () => {
  const horizon = 28;
  const bigWeek = seedPlans({ horizonDays: horizon, sessionsPerWeek: 6, sessionMinutes: 75 })[1].days; // build
  const nothing = Array.from({ length: horizon }, () => ({ type: 'rest', minutes: 0 }));
  const simBig = simulatePlan(bigWeek, ATHLETE);
  const simNothing = simulatePlan(nothing, ATHLETE);
  assert.ok(simBig.outcomes.fitnessGain > simNothing.outcomes.fitnessGain, 'training grows fitness; detraining does not');
  assert.ok(simNothing.outcomes.fitnessGain < 0, 'a month of nothing = detraining');
  assert.ok(simBig.outcomes.meanFatigue > simNothing.outcomes.meanFatigue);
  assert.ok(simNothing.trajectory.every(d => d.executed === 0));
  // Deterministic without an rng: identical reruns (JSON strips the
  // performanceAtDay helper — functions compare by reference otherwise).
  assert.deepEqual(
    JSON.parse(JSON.stringify(simulatePlan(bigWeek, ATHLETE).outcomes)),
    JSON.parse(JSON.stringify(simBig.outcomes)));
});

test('simulator: taper trades a little fitness for a lot of freshness', () => {
  const horizon = 14;
  const taper = seedPlans({ horizonDays: horizon })[3].days;   // taper template
  const build = seedPlans({ horizonDays: horizon })[1].days;   // build template
  const simTaper = simulatePlan(taper, ATHLETE);
  const simBuild = simulatePlan(build, ATHLETE);
  assert.ok(simTaper.outcomes.meanFatigue < simBuild.outcomes.meanFatigue);
  const lastTaper = simTaper.trajectory[horizon - 1];
  const lastBuild = simBuild.trajectory[horizon - 1];
  assert.ok(lastTaper.fatigue < lastBuild.fatigue, 'taper arrives at the end fresher');
});

test('simulator: stochastic draws are seed-reproducible and vary across seeds', () => {
  const days = seedPlans({ horizonDays: 28 })[0].days;
  const a = simulatePlan(days, ATHLETE, { rng: createRng(5) });
  const b = simulatePlan(days, ATHLETE, { rng: createRng(5) });
  const c = simulatePlan(days, ATHLETE, { rng: createRng(6) });
  assert.deepEqual(a.outcomes.performanceGain, b.outcomes.performanceGain);
  assert.notDeepEqual(
    a.trajectory.map(t => t.executed),
    c.trajectory.map(t => t.executed),
    'different seeds → different futures');
});

/* ------------------------------ constraints ------------------------------ */

test('constraints: violations are named; repair produces valid plans', () => {
  const c = defaultConstraints({ weeklyMinutesRecent: 240, chronicWeeklyLoad: 250 });
  const brutal = Array.from({ length: 14 }, () => ({ type: 'vo2', minutes: 90 }));
  const check = checkConstraints(brutal, c);
  assert.equal(check.valid, false);
  assert.ok(check.violations.some(v => v.includes('rest day')));
  assert.ok(check.violations.some(v => v.includes('hard')));
  const repaired = repairPlan(brutal, c);
  assert.ok(checkConstraints(repaired, c).valid, `repair yields validity, got: ${checkConstraints(repaired, c).violations[0]}`);

  // Coach-assigned sessions are inviolable: repair restores them.
  const cFixed = { ...c, fixedDays: { 3: { type: 'threshold', minutes: 60 } } };
  const messed = repaired.map(d => ({ ...d }));
  messed[3] = { type: 'rest', minutes: 0 };
  assert.deepEqual(repairPlan(messed, cFixed)[3], { type: 'threshold', minutes: 60 });

  // Race taper: no hard work 2 days out.
  const cRace = { ...c, raceDayIndex: 10 };
  const racy = repaired.map(d => ({ ...d }));
  racy[9] = { type: 'sprint', minutes: 45 };
  assert.ok(!['sprint', 'vo2', 'threshold'].includes(repairPlan(racy, cRace)[9].type));
});

/* ------------------------------ objectives ------------------------------ */

test('objectives: adherence penalizes fantasy plans; scalarization is explicit', () => {
  const modest = seedPlans({ horizonDays: 28, sessionsPerWeek: 4 })[0].days;
  const fantasy = Array.from({ length: 28 }, () => ({ type: 'vo2', minutes: 90 }));
  assert.ok(adherencePlausibility(modest, ATHLETE) > adherencePlausibility(fantasy, ATHLETE) + 0.2);
  const scores = { improvement: 30, fatigue: 60, injuryRisk: 2, adherence: 0.8 };
  assert.ok(scalarize(scores, { improvement: 2 }) > scalarize(scores, { improvement: 1 }), 'weights matter and are explicit');
});

/* -------------------------------- pareto -------------------------------- */

test('pareto: dominance, frontier extraction, tradeoff annotation', () => {
  assert.equal(dominates([1, 1], [0, 0]), true);
  assert.equal(dominates([1, 0], [0, 1]), false);
  const archive = [
    { days: [], scores: { improvement: 40, fatigue: 100, injuryRisk: 3, adherence: 0.6 } }, // aggressive
    { days: [], scores: { improvement: 20, fatigue: 50, injuryRisk: 1, adherence: 0.9 } },  // gentle
    { days: [], scores: { improvement: 19, fatigue: 60, injuryRisk: 2, adherence: 0.8 } },  // dominated by gentle
  ];
  const frontier = paretoFrontier(archive);
  assert.equal(frontier.length, 2, 'the dominated middle plan is gone');
  const explained = explainTradeoffs(frontier);
  assert.ok(explained.every(p => p.tradeoff.length > 10), 'every survivor explains why it exists');
});

/* -------------------------------- search -------------------------------- */

test('every search strategy produces valid, non-trivial frontiers from the same budget', () => {
  const problem = mkProblem();
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const { archive, evaluations } = strategy.search({ ...problem, rng: createRng(11), budget: 250 });
    assert.ok(evaluations > 0 && evaluations <= 250, `${name}: respects its budget`);
    assert.ok(archive.length >= 5, `${name}: archives evaluations (got ${archive.length})`);
    for (const e of archive.slice(0, 20)) {
      assert.ok(checkConstraints(e.days, problem.constraints).valid, `${name}: archive contains only valid plans`);
    }
    const frontier = paretoFrontier(archive);
    assert.ok(frontier.length >= 2, `${name}: finds a real frontier (got ${frontier.length})`);
  }
});

test('search is seed-deterministic; the benchmark harness measures all strategies', () => {
  const problem = mkProblem();
  const run = (seed) => {
    const { archive } = STRATEGIES.genetic.search({ ...problem, rng: createRng(seed), budget: 200 });
    return paretoFrontier(archive).map(p => planSignature(p.days)).join(';');
  };
  assert.equal(run(3), run(3), 'same seed → identical frontier');

  const bench = benchmarkStrategies(problem, { budgetPerStrategy: 150, seed: 9 });
  assert.equal(bench.length, 3);
  for (const b of bench) {
    assert.ok(b.frontierSize >= 1, `${b.strategy} benchmarked`);
    assert.ok(Number.isFinite(b.wallMs));
  }
});

/* ----------------------------- monte carlo ----------------------------- */

test('Monte Carlo: reproducible distributions with honest spread', () => {
  const days = seedPlans({ horizonDays: 28 })[1].days;
  const [a] = evaluatePlansMC([{ days }], ATHLETE, { iterations: 200, seed: 4 });
  const [b] = evaluatePlansMC([{ days }], ATHLETE, { iterations: 200, seed: 4 });
  assert.deepEqual(a.mc, b.mc, 'same seed → identical distribution');
  assert.ok(a.mc.improvement.p10 <= a.mc.improvement.p50 && a.mc.improvement.p50 <= a.mc.improvement.p90);
  assert.ok(a.mc.improvement.p90 - a.mc.improvement.p10 > 0, 'uncertainty is reported, not hidden');
  assert.ok(a.mc.skippedMean > 0, 'a 90%-adherence athlete skips sessions in simulation too');
});

/* ----------------------------- sensitivity ----------------------------- */

test('sensitivity: adverse scenarios cost improvement; robustness is bounded', () => {
  const days = seedPlans({ horizonDays: 28 })[1].days;
  const s = sensitivityAnalysis(days, ATHLETE, {});
  assert.equal(s.scenarios.length, 4);
  const missed = s.scenarios.find(x => x.key === 'missedSessions');
  assert.ok(missed.improvementDelta < 0, 'missing sessions costs predicted improvement');
  assert.ok(s.robustness >= 0 && s.robustness <= 1);
  assert.ok(s.verdict.length > 10);
});

/* ------------------------------ API flow ------------------------------ */

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let ann;

test('API: full run → frontier → counterfactual, own-data only, reproducible record', async () => {
  const su = await req('/auth/signup', { method: 'POST', body: { email: 'opt-ann@test.com', password: 'password123', displayName: 'Opt Ann', accountType: 'rower' } });
  const v = await req('/auth/verify', { method: 'POST', body: { email: 'opt-ann@test.com', code: su.body.devCode } });
  ann = { token: v.body.token, user: v.body.user };

  // A little history so the problem builder has signal.
  for (const paces of [[125, 126, 127, 126], [130, 131, 130, 129]]) {
    const splits = paces.map(p => ({ distanceM: 500, timeS: p, avgPaceSPer500m: p, avgStrokeRate: 24, avgHeartRate: 150 }));
    const t = paces.reduce((a, b) => a + b, 0);
    await req('/workouts/sync', {
      method: 'POST', token: ann.token,
      body: { id: crypto.randomUUID(), totalDistanceM: paces.length * 500, totalTimeS: t, machineType: 'rower', splits, startedAt: Math.floor(Date.now() / 1000) - t },
    });
  }
  await processPending();

  const meta = await req('/optimizer/meta', { token: ann.token });
  assert.equal(meta.status, 200);
  assert.ok(meta.body.strategies.includes('genetic'));

  const start = await req('/optimizer/run', { method: 'POST', token: ann.token, body: { horizonDays: 14, budget: 300 } });
  assert.equal(start.status, 202);
  await processPending();

  const detail = await req(`/optimizer/runs/${start.body.runId}`, { token: ann.token });
  assert.equal(detail.status, 200);
  const run = detail.body.run;
  assert.equal(run.status, 'completed', run.error || '');
  assert.ok(run.frontier.length >= 1);
  assert.ok(Number.isFinite(run.seed), 'seed recorded');
  assert.ok(run.versions.some(v => v.startsWith('optimizer.simulate@')), 'component versions recorded');
  assert.ok(run.frontier[0].mc?.improvement, 'Monte Carlo distributions attached');
  assert.ok(run.frontier[0].tradeoff.length > 5, 'every plan explains its tradeoff');
  assert.ok(run.sensitivity?.verdict, 'sensitivity analysis attached');
  for (const p of run.frontier) {
    assert.equal(p.days.length, 14);
  }

  // Counterfactual: valid edit evaluates; garbage is rejected.
  const edited = run.frontier[0].days.map(d => ({ ...d }));
  edited[0] = { type: 'rest', minutes: 0 };
  const cf = await req('/optimizer/counterfactual', { method: 'POST', token: ann.token, body: { runId: run.id, days: edited } });
  assert.equal(cf.status, 200);
  assert.ok(cf.body.evaluation.deltas, 'deltas vs the recommendation');
  const bad = await req('/optimizer/counterfactual', { method: 'POST', token: ann.token, body: { runId: run.id, days: [{ type: 'yoga', minutes: 45 }] } });
  assert.equal(bad.status, 400);

  // Own-data: another user cannot read Ann's run.
  const su2 = await req('/auth/signup', { method: 'POST', body: { email: 'opt-ben@test.com', password: 'password123', displayName: 'Opt Ben', accountType: 'rower' } });
  const v2 = await req('/auth/verify', { method: 'POST', body: { email: 'opt-ben@test.com', code: su2.body.devCode } });
  const stolen = await req(`/optimizer/runs/${run.id}`, { token: v2.body.token });
  assert.equal(stolen.status, 404);
});

test('adaptive replanning: a new workout warm-starts a coalesced replan of a recent run', async () => {
  const before = db.prepare("SELECT COUNT(*) c FROM optimization_runs WHERE user_id = ? AND kind = 'replan'").get(ann.user.id).c;
  const paces = [128, 128, 128, 128];
  const splits = paces.map(p => ({ distanceM: 500, timeS: p, avgPaceSPer500m: p, avgStrokeRate: 24 }));
  await req('/workouts/sync', {
    method: 'POST', token: ann.token,
    body: { id: crypto.randomUUID(), totalDistanceM: 2000, totalTimeS: 512, machineType: 'rower', splits, startedAt: Math.floor(Date.now() / 1000) - 512 },
  });
  const replans = db.prepare("SELECT * FROM optimization_runs WHERE user_id = ? AND kind = 'replan'").all(ann.user.id);
  assert.equal(replans.length, before + 1, 'exactly one replan run row created');
  const config = JSON.parse(replans[replans.length - 1].config_json);
  assert.ok(config.warmStartRunId, 'replan warm-starts from the previous run');
  // The replan job is delayed (coalescing window); force it due and run it.
  db.prepare("UPDATE jobs SET run_at = ? WHERE kind = 'optimizer.run' AND status = 'pending'").run(Math.floor(Date.now() / 1000) - 1);
  await processPending();
  const done = db.prepare('SELECT status FROM optimization_runs WHERE id = ?').get(replans[replans.length - 1].id);
  assert.equal(done.status, 'completed');
});

test('teardown', () => {
  server.close();
});
