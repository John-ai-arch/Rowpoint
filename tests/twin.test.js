// Digital Twin integration tests against a live server: the event-driven
// pipeline (workout sync → job → state), the own-data-only API contract,
// state serialization round-trips, forward compatibility of snapshots,
// snapshot coalescing, the recommendation staleness flow, and rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = `/tmp/rowpoint-twin-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_BACKUPS_ENABLED = '0';
process.env.ROWPOINT_JOBS_ENABLED = '0'; // tests drive the queue deterministically
delete process.env.ANTHROPIC_API_KEY;

const { startServer } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { processPending } = await import('../server/kernel/jobs.js');
const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, body: json };
}

async function makeUser(email, extra = {}) {
  const su = await req('/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: email.split('@')[0], accountType: 'rower', ...extra } });
  assert.equal(su.status, 201, JSON.stringify(su.body));
  const v = await req('/auth/verify', { method: 'POST', body: { email, code: su.body.devCode } });
  assert.equal(v.status, 200);
  return { token: v.body.token, user: v.body.user };
}

const uuid = () => crypto.randomUUID();
const mkSplits = (paces) => paces.map(p => ({ distanceM: 500, timeS: p, avgPaceSPer500m: p, avgStrokeRate: 24, avgHeartRate: 150, avgPowerWatts: 180 }));
function workoutBody(paces, extra = {}) {
  const splits = mkSplits(paces);
  const t = splits.reduce((s, x) => s + x.timeS, 0);
  return { id: uuid(), totalDistanceM: splits.length * 500, totalTimeS: t, machineType: 'rower', splits, startedAt: Math.floor(Date.now() / 1000) - t, ...extra };
}

let ann, ben;

test('setup', async () => {
  ann = await makeUser('twin-ann@test.com');
  ben = await makeUser('twin-ben@test.com');
});

test('a synced workout enqueues a coalesced twin job; running it builds state', async () => {
  for (const paces of [[125, 126, 127, 126], [130, 131, 130, 129], [124, 125, 126, 125]]) {
    const r = await req('/workouts/sync', { method: 'POST', body: workoutBody(paces), token: ann.token });
    assert.equal(r.status, 201);
  }
  const pending = db.prepare("SELECT * FROM jobs WHERE kind = 'twin.update' AND user_id = ? AND status = 'pending'").all(ann.user.id);
  assert.equal(pending.length, 1, 'three syncs coalesce into ONE pending twin job');

  await processPending();

  const stateRows = db.prepare('SELECT * FROM athlete_state WHERE user_id = ?').all(ann.user.id);
  assert.ok(stateRows.length >= 8, `expected a populated state vector, got ${stateRows.length} variables`);
  const snapshots = db.prepare('SELECT * FROM state_snapshots WHERE user_id = ?').all(ann.user.id);
  assert.equal(snapshots.length, 1, 'one snapshot per pipeline run');
  const features = db.prepare(`SELECT COUNT(*) c FROM feature_cache WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = ?)`).get(ann.user.id);
  assert.ok(features.c >= 3 * 15, 'features cached for every synced workout');
});

test('GET /twin/state returns Estimates with provenance, meta, and a prediction', async () => {
  const r = await req('/twin/state', { token: ann.token });
  assert.equal(r.status, 200);
  const { state, model, racePrediction, lastUpdatedAt } = r.body;

  const acute = state.fatigue?.acuteLoad;
  assert.ok(acute, 'fatigue.acuteLoad exists');
  assert.equal(acute.provenance, 'measured', 'observed minutes are measured, not estimated');
  assert.ok(acute.value > 0);
  assert.ok(acute.meta?.label, 'metadata travels with the value');

  const smooth = state.technique?.strokeSmoothness;
  assert.ok(smooth, 'technique.strokeSmoothness exists even without force curves');
  assert.equal(smooth.provenance, 'assumed', 'no force data → honestly assumed');
  assert.ok(smooth.confidence <= 0.3, 'assumed values carry low confidence');

  const readiness = state.readiness?.score;
  assert.ok(readiness && readiness.value >= 0 && readiness.value <= 100);

  assert.ok(model.aerobic, 'the state model definition ships with the response');
  assert.ok(racePrediction?.available, 'steady rowing is enough for a low-confidence prediction');
  assert.ok(racePrediction.predictions.some(p => p.distance === 2000));
  assert.ok(lastUpdatedAt > 0);
});

test('twin API is strictly own-data and requires auth', async () => {
  const anon = await req('/twin/state');
  assert.equal(anon.status, 401);

  const benState = await req('/twin/state', { token: ben.token });
  assert.equal(benState.status, 200);
  assert.deepEqual(benState.body.state, {}, "Ben has no workouts — and no way to address Ann's state");

  const hist = await req(`/twin/history?category=fatigue&variable=acuteLoad`, { token: ben.token });
  assert.deepEqual(hist.body.points, [], 'history is keyed to the requesting account only');

  const bad = await req('/twin/history?category=fatigue;DROP&variable=x', { token: ann.token });
  assert.equal(bad.status, 400, 'category/variable names are validated');
});

test('explain returns the evidence trail behind a variable', async () => {
  const r = await req('/twin/explain?category=fatigue&variable=acuteLoad', { token: ann.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.meta?.label);
  assert.ok(r.body.evidence.length >= 1, 'inference history recorded the update');
  const ev = r.body.evidence[0];
  assert.ok(ev.modelVersion?.includes('@'), 'evidence is version-attributed');
  assert.ok(Number.isFinite(ev.estimate?.value));
});

test('state serializes and round-trips; unknown categories are tolerated (forward compatibility)', async () => {
  const snap = db.prepare('SELECT * FROM state_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(ann.user.id);
  const parsed = JSON.parse(snap.state_json);
  for (const vars of Object.values(parsed)) {
    for (const est of Object.values(vars)) {
      assert.ok(Number.isFinite(est.value) && typeof est.provenance === 'string' && est.confidence >= 0 && est.confidence <= 1,
        'every snapshotted variable is a well-formed Estimate');
    }
  }
  // A snapshot written by a FUTURE model version with an unknown category
  // must not break reads.
  const future = { ...parsed, futuristics: { flux: { value: 1, confidence: 0.5, uncertainty: 1, provenance: 'estimated', evidenceCount: 1, updatedAt: 1 } } };
  db.prepare('INSERT INTO state_snapshots (id, user_id, created_at, trigger, state_json) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), ann.user.id, Math.floor(Date.now() / 1000) + 1, 'test', JSON.stringify(future));
  const r = await req('/twin/state', { token: ann.token });
  assert.equal(r.status, 200, 'unknown snapshot content never breaks the API');
  const hist = await req('/twin/history?category=futuristics&variable=flux', { token: ann.token });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.points.length, 1, 'unknown variables are preserved, not rejected');
});

test('snapshots coalesce within 10 minutes — an offline batch is one history point', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM state_snapshots WHERE user_id = ?').get(ann.user.id).c;
  await req('/workouts/sync', { method: 'POST', body: workoutBody([128, 128, 128, 128]), token: ann.token });
  await processPending();
  const after = db.prepare('SELECT COUNT(*) c FROM state_snapshots WHERE user_id = ?').get(ann.user.id).c;
  assert.equal(after, before, 'second run minutes later coalesces its snapshot');
});

test('a new workout marks today\'s engine suggestion stale; the read path regenerates it in place', async () => {
  const s1 = await req('/ai/suggestion', { token: ann.token });
  assert.equal(s1.status, 200);
  const id1 = s1.body.suggestion.id;
  assert.notEqual(s1.body.suggestion.source, 'llm', 'no API key in tests → engine source');

  await req('/workouts/sync', { method: 'POST', body: workoutBody([127, 127, 127, 127]), token: ann.token });
  await processPending();
  const row = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?').get(id1);
  assert.equal(row.stale, 1, 'twin pipeline marked the cached suggestion stale');

  const s2 = await req('/ai/suggestion', { token: ann.token });
  assert.equal(s2.body.suggestion.id, id1, 'regenerated IN PLACE — adherence tracking survives');
  assert.equal(db.prepare('SELECT stale FROM ai_suggestions WHERE id = ?').get(id1).stale, 0);
});

test('rebuild is job-backed, rate-limited, and reproduces equivalent state', async () => {
  const stateBefore = db.prepare('SELECT category, variable, value FROM athlete_state WHERE user_id = ? ORDER BY category, variable').all(ann.user.id);
  const r = await req('/twin/rebuild', { method: 'POST', token: ann.token });
  assert.equal(r.status, 202);
  await processPending();
  const stateAfter = db.prepare('SELECT category, variable, value FROM athlete_state WHERE user_id = ? ORDER BY category, variable').all(ann.user.id);
  assert.deepEqual(stateAfter.map(s => `${s.category}.${s.variable}`), stateBefore.map(s => `${s.category}.${s.variable}`),
    'rebuild reproduces the same variable set from the same history');

  await req('/twin/rebuild', { method: 'POST', token: ann.token });
  await req('/twin/rebuild', { method: 'POST', token: ann.token });
  const limited = await req('/twin/rebuild', { method: 'POST', token: ann.token });
  assert.equal(limited.status, 429, 'rebuild is heavily rate-limited');
});

test('research aggregation respects consent at write time', async () => {
  // Ann is opted in (default): a weekly pseudonymous state row exists.
  const rows = db.prepare('SELECT * FROM research_state_snapshots').all();
  assert.ok(rows.length >= 1);
  assert.ok(!rows.some(r => r.research_id === ann.user.id), 'research rows are keyed by pseudonym, never the account id');
  const parsed = JSON.parse(rows[0].state_json);
  const anyVar = Object.values(parsed).flatMap(vars => Object.values(vars))[0];
  assert.ok(anyVar && !('modelVersion' in anyVar) && !('evidenceCount' in anyVar), 'research aggregates are coarsened');

  // An opted-out athlete contributes nothing.
  const before = db.prepare('SELECT COUNT(*) c FROM research_state_snapshots').get().c;
  const optOut = await makeUser('twin-optout@test.com', { researchOptIn: false });
  db.prepare('UPDATE users SET research_opt_in = 0 WHERE id = ?').run(optOut.user.id);
  await req('/workouts/sync', { method: 'POST', body: workoutBody([135, 135, 135, 135]), token: optOut.token });
  await processPending();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM research_state_snapshots').get().c, before,
    'opted-out athletes add no research state rows');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM athlete_state WHERE user_id = ?').get(optOut.user.id).c > 0,
    'their own twin still works — consent gates research only');
});

test('teardown', () => {
  server.close();
});
