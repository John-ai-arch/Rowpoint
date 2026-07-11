// Digital Regatta Simulation Engine validation: strategy profile
// normalization, environment distributions with honest provenance, the
// discrete-time race dynamics (physics sanity, W′ coupling, determinism,
// numerical stability at extremes), Monte Carlo reproducibility and
// probability coherence, tactical event sampling, the what-if evaluator,
// and the full job-backed API flow with own-data enforcement, coach-gated
// teammate lanes, and the race-result validation loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = `/tmp/rowpoint-regatta-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_BACKUPS_ENABLED = '0';
process.env.ROWPOINT_JOBS_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

const { startServer } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { processPending } = await import('../server/kernel/jobs.js');
const { createRng, seedFrom } = await import('../server/kernel/rng.js');
const { mean } = await import('../server/kernel/stats.js');
const { STRATEGIES, customStrategy, resolveProfile, profileMultiplier } = await import('../server/regatta/strategy.js');
const { makeEnvironmentModel, sampleEnvironment } = await import('../server/regatta/environment.js');
const { simulateRace } = await import('../server/regatta/race.js');
const { sampleEvents, eventModifiers, EVENT_TYPES } = await import('../server/regatta/tactics.js');
const { runRegattaMC } = await import('../server/regatta/monteCarloRegatta.js');
const { sanitizeMods, applyMods, evaluateWhatIf } = await import('../server/regatta/whatIf.js');

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---------------------------- test fixtures ---------------------------- */

/** A plain single-scull boat descriptor with realistic 1x constants. */
function mkBoat({ name = 'boat', cpW = 300, wPrimeJ = 18000, isUser = false, strategy = 'even', paceCv = 0, fadeTendency = 0.5, startQuality = 0.7 } = {}) {
  return {
    name, isUser,
    cpW, cpSd: cpW * 0.04,
    wPrimeJ, wpSd: wPrimeJ * 0.2,
    massKg: 80, readinessFactor: 1,
    paceCv, fadeTendency, startQuality,
    aggression: 0.4, sprintTendency: 0.4,
    kBase: 2.79, cdA: 0.35, crewPowerFactor: 0.78, effMassKg: 108,
    duration0S: 420,
    basePowerW: cpW + wPrimeJ / 420,
    profile: resolveProfile({ strategy }),
    events: null,
    boatClass: '1x',
  };
}

const CALM = { headwindMps: 0, currentMps: 0, airDensity: 1.225, waterDragFactor: 1, gustSd: 0, gustTauS: 12, laneBias: [0, 0, 0, 0, 0, 0] };

/* ------------------------------- strategy ------------------------------- */

test('strategies: every profile is normalized to mean 1 (effort is redistributed, never conjured)', () => {
  for (const [key, s] of Object.entries(STRATEGIES)) {
    let sum = 0;
    for (let i = 0; i < 400; i++) sum += profileMultiplier(s, (i + 0.5) / 400);
    assert.ok(Math.abs(sum / 400 - 1) < 0.005, `${key} mean ≈ 1, got ${sum / 400}`);
  }
  const custom = customStrategy([2.0, 0.1, 1, 1]); // silly inputs get clamped THEN normalized
  let sum = 0;
  for (let i = 0; i < 400; i++) sum += profileMultiplier(custom, (i + 0.5) / 400);
  assert.ok(Math.abs(sum / 400 - 1) < 0.005, 'custom profiles are normalized too');
});

test('strategies: shapes match their names; opponent tendencies bend the profile', () => {
  assert.ok(profileMultiplier(STRATEGIES.fastStart, 0.05) > profileMultiplier(STRATEGIES.fastStart, 0.8), 'fast start front-loads');
  assert.ok(profileMultiplier(STRATEGIES.lateSprint, 0.95) > profileMultiplier(STRATEGIES.lateSprint, 0.5), 'late sprint back-loads');
  assert.ok(profileMultiplier(STRATEGIES.negative, 0.9) > profileMultiplier(STRATEGIES.negative, 0.1), 'negative split builds');
  const aggressive = resolveProfile({ strategy: 'even', aggression: 1 });
  assert.ok(profileMultiplier(aggressive, 0.05) > profileMultiplier(STRATEGIES.even, 0.05) + 0.02,
    'an aggressive opponent opens harder than even pace');
});

/* ------------------------------ environment ------------------------------ */

test('environment: unknown inputs become wide honest distributions, known ones tight', () => {
  const unknown = makeEnvironmentModel({}, 4);
  assert.equal(unknown.headwindMean, 0);
  assert.ok(unknown.headwindSd >= 1, 'unknown wind is wide');
  assert.equal(unknown.provenance.wind, 'assumed');

  const known = makeEnvironmentModel({ windSpeedMps: 4, windDirectionDeg: 0, headingDeg: 0, currentMps: 0.2, temperatureC: 20, waterTemperatureC: 18, altitudeM: 0 }, 4);
  assert.ok(Math.abs(known.headwindMean - 4) < 0.01, 'wind from dead ahead = pure headwind');
  assert.ok(known.headwindSd < unknown.headwindSd, 'measured wind is tighter than assumed wind');
  assert.equal(known.provenance.wind, 'measured');
  assert.ok(known.waterDragFactor < 1, 'warm water (18°C > 15°C) is slightly faster');

  const tail = makeEnvironmentModel({ windSpeedMps: 4, windDirectionDeg: 180, headingDeg: 0 }, 2);
  assert.ok(tail.headwindMean < -3.9, 'wind from astern is a tailwind');

  const sampled = sampleEnvironment(known, createRng(7));
  const sampled2 = sampleEnvironment(known, createRng(7));
  assert.deepEqual(sampled, sampled2, 'sampling is seed-deterministic');
  assert.equal(sampled.laneBias.length, 4);
});

/* ------------------------------ race engine ------------------------------ */

test('race: the stronger athlete wins; results are seed-deterministic', () => {
  const boats = [mkBoat({ name: 'strong', cpW: 320 }), mkBoat({ name: 'weak', cpW: 290 })];
  const a = simulateRace(boats, CALM, { rng: createRng(1) });
  const b = simulateRace(boats.map(x => ({ ...x })), CALM, { rng: createRng(1) });
  assert.equal(a.ranks[0], 0, 'higher CP wins in calm, even conditions');
  assert.ok(a.finishTimes[0] < a.finishTimes[1]);
  assert.deepEqual(a.finishTimes, b.finishTimes, 'same seed → identical race');
  // A 320W scull should be in a broadly realistic 2k window.
  assert.ok(a.finishTimes[0] > 380 && a.finishTimes[0] < 480, `plausible 2k time, got ${a.finishTimes[0]}s`);
});

test('race: headwind slows everyone; tail current speeds ground progress', () => {
  const boats = () => [mkBoat({ cpW: 310 })];
  const calm = simulateRace(boats(), CALM, {});
  const wind = simulateRace(boats(), { ...CALM, headwindMps: 5 }, {});
  const current = simulateRace(boats(), { ...CALM, currentMps: 0.5 }, {});
  assert.ok(wind.finishTimes[0] > calm.finishTimes[0] + 10, '5 m/s headwind costs serious time');
  assert.ok(current.finishTimes[0] < calm.finishTimes[0] - 20, 'favorable current shortens the race');
});

test('race: W′ coupling — a tiny reserve forces fade; blown boats slow below CP pace', () => {
  const normal = mkBoat({ name: 'normal', cpW: 300, wPrimeJ: 20000, strategy: 'fastStart' });
  const fragile = mkBoat({ name: 'fragile', cpW: 300, wPrimeJ: 5000, strategy: 'fastStart' });
  const race = simulateRace([normal, fragile], CALM, {});
  assert.ok(race.finishTimes[1] > race.finishTimes[0], 'same CP but tiny W′ loses on an aggressive plan');
  const splits = race.splits500[1];
  assert.ok(splits[3] > splits[0] + 2, `the fragile boat fades hard (${splits[0]} → ${splits[3]})`);
});

test('race: splits are internally consistent and marks are monotonic', () => {
  const race = simulateRace([mkBoat({ cpW: 310 })], CALM, { rng: createRng(3) });
  const sum = race.splits500[0].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - race.finishTimes[0]) < 1, `splits sum to the finish time (${sum} vs ${race.finishTimes[0]})`);
  const marks = race.markTimes[0];
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i] > marks[i - 1], 'mark crossings increase');
});

test('race: numerical stability at extremes — sprints, head races, weak athletes, storms', () => {
  const cases = [
    { boats: [mkBoat({ cpW: 90, wPrimeJ: 4000 })], env: CALM, opts: { distanceM: 2000 } },
    { boats: [mkBoat({ cpW: 420 })], env: CALM, opts: { distanceM: 500 } },
    { boats: [mkBoat({ cpW: 300 })], env: CALM, opts: { distanceM: 10000 } },
    { boats: [mkBoat({ cpW: 250 })], env: { ...CALM, headwindMps: 12, waterDragFactor: 1.1 }, opts: {} },
    { boats: [mkBoat({ cpW: 250 })], env: { ...CALM, currentMps: -1.5 }, opts: {} },
  ];
  for (const c of cases) {
    const race = simulateRace(c.boats, c.env, { ...c.opts, rng: createRng(5) });
    assert.ok(race.finishTimes.every(Number.isFinite), 'finish times are finite');
    assert.ok(race.finishTimes.every(t => t > 0), 'finish times are positive');
  }
});

test('race: replay recording captures coupled state without changing the outcome', () => {
  const boats = () => [mkBoat({ cpW: 315, strategy: 'fastStart' }), mkBoat({ cpW: 310 })];
  const plain = simulateRace(boats(), CALM, { rng: createRng(9) });
  const recorded = simulateRace(boats(), CALM, { rng: createRng(9), record: true });
  assert.deepEqual(plain.finishTimes, recorded.finishTimes, 'recording is an observer, not a participant');
  assert.ok(recorded.timeline.length > 100, 'a ~7 min race yields hundreds of frames');
  const frame = recorded.timeline[60];
  assert.ok(frame.boats[0].x > 0 && frame.boats[0].v > 0);
  assert.ok(frame.boats[0].wbal < 1, 'a fast-starting boat has spent W′ by 60 s');
});

/* -------------------------------- tactics -------------------------------- */

test('tactics: events are seed-deterministic, base rates roughly honored, modifiers bounded', () => {
  const boats = Array.from({ length: 1000 }, () => ({ aggression: 0.5 }));
  const events = sampleEvents(boats, createRng(11));
  assert.deepEqual(events, sampleEvents(boats, createRng(11)), 'deterministic given the seed');
  const crabs = events.filter(e => e.some(x => x.type === 'missedStroke')).length / 1000;
  assert.ok(Math.abs(crabs - EVENT_TYPES.missedStroke.baseRate) < 0.02, `crab rate ≈ base rate, got ${crabs}`);
  const withCrab = [{ type: 'missedStroke', atFraction: 0.5, durationS: 3, powerFactor: 0.35 }];
  assert.equal(eventModifiers(withCrab, 0.4, 100).power, 1, 'not yet reached — no effect');
  assert.equal(eventModifiers(withCrab, 0.5, 200).power, 0.35, 'active while inside the window');
  assert.equal(eventModifiers(withCrab, 0.6, 300).power, 1, 'expired after its duration');
});

/* ------------------------------ monte carlo ------------------------------ */

test('MC: reproducible, coherent probabilities, honest spread, sensitivity + replay', () => {
  const config = {
    boats: [mkBoat({ name: 'You', cpW: 305, isUser: true }), mkBoat({ name: 'Rival', cpW: 305 })],
    environment: {},
    distanceM: 2000, strategy: 'even', iterations: 300, seed: 42, tactics: false,
  };
  const a = runRegattaMC(config);
  const b = runRegattaMC(config);
  assert.deepEqual(a.summary, b.summary, 'same seed → identical summary');
  assert.deepEqual(a.replay.finishTimes, b.replay.finishTimes, 'same seed → identical replay');

  const s = a.summary;
  assert.ok(s.user.winProb > 0.2 && s.user.winProb < 0.8, `evenly matched → toss-up-ish, got ${s.user.winProb}`);
  assert.ok(s.user.finish.p5 < s.user.finish.p50 && s.user.finish.p50 < s.user.finish.p95, 'quantiles ordered');
  for (const row of s.rankMatrix) {
    assert.ok(Math.abs(row.reduce((x, y) => x + y, 0) - 1) < 0.01, 'each boat lands in exactly one rank');
  }
  assert.equal(s.leaderCurve.marksM.length, 8, '2k → 8 quarter-marks');
  assert.ok(s.sensitivity.length >= 5 && Math.abs(s.sensitivity[0].r) > 0, 'sensitivity ranks influential variables');
  assert.ok(s.sensitivity.some(x => x.factor === 'userCp' && x.r < 0), 'more power → less time (negative correlation)');
  assert.ok(a.replay.timeline.length > 100, 'replay timeline present');
  const mid = Math.abs(a.replay.finishTimes[0] - s.user.finish.p50);
  assert.ok(mid < 5, `replay is the median race (|Δ| = ${mid}s)`);
});

test('MC: a clearly stronger opponent crushes the win probability', () => {
  const mk = (oppCp) => runRegattaMC({
    boats: [mkBoat({ name: 'You', cpW: 300, isUser: true }), mkBoat({ name: 'Opp', cpW: oppCp })],
    environment: {}, distanceM: 2000, strategy: 'even', iterations: 300, seed: 7,
  }).summary.user.winProb;
  assert.ok(mk(275) > 0.75, 'weaker field → strong favorite');
  assert.ok(mk(330) < 0.15, 'stronger field → long odds');
});

test('MC: strategy comparison evaluates the whole catalog against the field', () => {
  const { summary } = runRegattaMC({
    boats: [mkBoat({ name: 'You', cpW: 305, isUser: true }), mkBoat({ name: 'Opp', cpW: 303 })],
    environment: {}, distanceM: 2000, strategy: 'even', iterations: 300, seed: 3, compareStrategies: true,
  });
  assert.equal(summary.strategyComparison.length, Object.keys(STRATEGIES).length);
  assert.ok(summary.strategyComparison.every(x => x.winProb >= 0 && x.winProb <= 1 && Number.isFinite(x.medianS)));
  const sorted = [...summary.strategyComparison].sort((x, y) => y.winProb - x.winProb);
  assert.deepEqual(summary.strategyComparison, sorted, 'ranked best-first');
});

/* -------------------------------- what-if -------------------------------- */

test('what-if: bounded mods, honest deltas, deterministic evaluation', () => {
  const baseConfig = {
    boats: [mkBoat({ name: 'You', cpW: 300, isUser: true }), mkBoat({ name: 'Opp', cpW: 302 })],
    environment: {}, distanceM: 2000, strategy: 'even', iterations: 300, seed: 12,
  };
  const { summary } = runRegattaMC(baseConfig);

  assert.deepEqual(sanitizeMods({ powerPct: 50, nonsense: true }), { powerPct: 8 }, 'mods are clamped and unknown keys dropped');
  assert.equal(evaluateWhatIf(baseConfig, summary, {}).valid, false, 'empty mods are refused');

  const up = evaluateWhatIf(baseConfig, summary, { powerPct: 5 });
  assert.ok(up.valid);
  assert.ok(up.deltas.winProb > 0.1, `+5% power should clearly lift win probability, got ${up.deltas.winProb}`);
  assert.ok(up.deltas.finishP50S < -3, 'and cut several seconds');
  assert.deepEqual(up, evaluateWhatIf(baseConfig, summary, { powerPct: 5 }), 'same what-if → same answer');

  const modded = applyMods(baseConfig, sanitizeMods({ laneIndex: 2 }));
  assert.equal(modded.boats[1].isUser, true, 'lane move relocates the user boat');
  assert.equal(baseConfig.boats[0].isUser, true, 'baseline config is never mutated');
});

/* ------------------------------- API flow ------------------------------- */

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function mkUser(email, name) {
  const su = await req('/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: name, accountType: 'rower' } });
  const v = await req('/auth/verify', { method: 'POST', body: { email, code: su.body.devCode } });
  return { token: v.body.token, user: v.body.user };
}

let ann, runId;

test('API: simulate → job → distributions + replay; own-data enforced end to end', async () => {
  ann = await mkUser('regatta-ann@test.com', 'Regatta Ann');
  // History so the twin has a power estimate.
  for (const paces of [[118, 119, 120, 119], [124, 125, 124, 123], [130, 131, 130, 129]]) {
    const splits = paces.map(p => ({ distanceM: 500, timeS: p, avgPaceSPer500m: p, avgStrokeRate: 26, avgHeartRate: 165 }));
    const t = paces.reduce((a, b) => a + b, 0);
    await req('/workouts/sync', {
      method: 'POST', token: ann.token,
      body: { id: crypto.randomUUID(), totalDistanceM: paces.length * 500, totalTimeS: t, machineType: 'rower', splits, startedAt: Math.floor(Date.now() / 1000) - t },
    });
  }
  await processPending();

  const meta = await req('/regatta/meta', { token: ann.token });
  assert.equal(meta.status, 200);
  assert.ok(meta.body.boatClasses.includes('8+'));
  assert.ok(meta.body.strategies.even, 'strategy vocabulary published');

  const params = await req('/regatta/athlete', { token: ann.token });
  assert.equal(params.status, 200);
  assert.ok(params.body.params.available, params.body.params.reason || '');
  assert.ok(params.body.params.cpW > 100, 'a real power estimate from history');
  assert.ok(params.body.params.explain.length >= 1, 'the estimate explains its grounding');

  const start = await req('/regatta/simulate', {
    method: 'POST', token: ann.token,
    body: {
      boatClass: '1x', distanceM: 2000, strategy: 'even', iterations: 500,
      opponents: [
        { kind: 'archetype', archetype: 'matched' },
        { kind: 'archetype', archetype: 'challenger' },
        { kind: 'manual', name: 'Known Rival', erg2kSeconds: 452 },
      ],
      environment: { windSpeedMps: 3, windDirectionDeg: 0, headingDeg: 0 },
      userLane: 2,
    },
  });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  runId = start.body.runId;
  await processPending();

  const detail = await req(`/regatta/runs/${runId}`, { token: ann.token });
  assert.equal(detail.status, 200);
  const run = detail.body.run;
  assert.equal(run.status, 'completed', run.error || '');
  assert.ok(Number.isFinite(run.seed), 'seed recorded');
  assert.ok(run.versions.some(v => v.startsWith('regatta.race@')), 'component versions recorded');
  assert.equal(run.summary.boats.length, 4);
  assert.equal(run.summary.user.lane, 2, 'user rows the requested lane');
  assert.ok(run.summary.user.winProb >= 0 && run.summary.user.winProb <= 1);
  assert.ok(run.summary.user.splits500.length === 4 && run.summary.user.splits500.every(s => s && s.p10 <= s.p90));
  assert.ok(run.summary.sensitivity.length >= 5, 'sensitivity attached');
  assert.ok(run.summary.environment.provenance.wind === 'measured', 'environment provenance travels with the run');

  const replay = await req(`/regatta/runs/${runId}/replay`, { token: ann.token });
  assert.equal(replay.status, 200);
  assert.ok(replay.body.replay.timeline.length > 100, 'computational replay stored');

  // Own-data: a stranger sees nothing.
  const ben = await mkUser('regatta-ben@test.com', 'Regatta Ben');
  assert.equal((await req(`/regatta/runs/${runId}`, { token: ben.token })).status, 404);
  assert.equal((await req(`/regatta/runs/${runId}/replay`, { token: ben.token })).status, 404);

  // Teammate lanes are coach-gated: Ben (not a coach of Ann) is refused.
  const stolen = await req('/regatta/simulate', {
    method: 'POST', token: ben.token,
    body: { opponents: [{ kind: 'teammate', userId: ann.user.id }] },
  });
  assert.ok([400, 403].includes(stolen.status), 'a non-coach cannot put a real athlete in a lane');
  assert.equal(stolen.body.error, 'not_your_athlete');
});

test('API: what-if re-simulates against the stored baseline', async () => {
  const wi = await req('/regatta/whatif', {
    method: 'POST', token: ann.token,
    body: { runId, mods: { powerPct: 4, strategy: 'negative' } },
  });
  assert.equal(wi.status, 200, JSON.stringify(wi.body));
  const ev = wi.body.evaluation;
  assert.ok(ev.valid);
  assert.deepEqual(Object.keys(ev.mods).sort(), ['powerPct', 'strategy']);
  assert.ok(ev.deltas.winProb > 0, '+4% power lifts the odds');
  assert.match(ev.note, /Monte Carlo noise/, 'reduced-iteration honesty note attached');
});

test('API: race-result validation loop writes prediction error to model_performance', async () => {
  const race = await req('/training/races', {
    method: 'POST', token: ann.token,
    body: { name: 'Spring Head', raceDate: '2027-05-01', distance: '2000m' },
  });
  assert.equal(race.status, 201);
  const start = await req('/regatta/simulate', {
    method: 'POST', token: ann.token,
    body: { raceId: race.body.race.id, iterations: 500, opponents: [{ kind: 'archetype', archetype: 'matched' }] },
  });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  await processPending();
  const run = (await req(`/regatta/runs/${start.body.runId}`, { token: ann.token })).body.run;
  assert.equal(run.status, 'completed', run.error || '');

  const actual = Math.round(run.summary.user.finish.p50 + 4);
  const patch = await req(`/training/races/${race.body.race.id}`, {
    method: 'PATCH', token: ann.token, body: { resultTimeSeconds: actual },
  });
  assert.equal(patch.status, 200);

  const perf = db.prepare("SELECT * FROM model_performance WHERE model_name = 'regatta.race'").all();
  assert.ok(perf.length >= 1, 'validation row written');
  const detail = JSON.parse(perf[perf.length - 1].detail_json);
  assert.equal(detail.actualS, actual);
  assert.ok(Math.abs(perf[perf.length - 1].value - Math.abs(actual - detail.predictedS)) < 0.1, 'error metric is |actual − predicted|');
});

test('API: a brand-new athlete with no history is refused with a clear reason', async () => {
  const newbie = await mkUser('regatta-new@test.com', 'Regatta New');
  const r = await req('/regatta/simulate', { method: 'POST', token: newbie.token, body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'insufficient_data');
  assert.match(r.body.message, /workouts|2k/i);
});

test('teardown', () => {
  server.close();
});
