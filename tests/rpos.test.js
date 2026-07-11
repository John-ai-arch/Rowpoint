// RowPoint Operating System (RPOS) validation: platform plugin validation
// and inventory, the immutable computation audit trail (written from job
// events, UPDATE-proof by trigger), orchestrator queue control (retry /
// cancel with strict authorization), the observability snapshot and
// performance watchdog, versioned /api/v1 aliases (contract test),
// organization groundwork, and the generated-documentation pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = `/tmp/rowpoint-rpos-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_BACKUPS_ENABLED = '0';
process.env.ROWPOINT_JOBS_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

const { startServer } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { defineJob, enqueue, processPending } = await import('../server/kernel/jobs.js');
const { validatePlatform, platformInventory } = await import('../server/rpos/plugins.js');
const { platformSnapshot, watchdogTick, BUDGETS } = await import('../server/rpos/observability.js');
const { searchComputations } = await import('../server/rpos/auditTrail.js');
const { generateDocs } = await import('../server/rpos/docs.js');

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

async function req(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${pathname}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function mkUser(email, name, accountType = 'rower') {
  const su = await req('/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: name, accountType } });
  const v = await req('/auth/verify', { method: 'POST', body: { email, code: su.body.devCode } });
  return { token: v.body.token, user: v.body.user };
}

let admin, athlete;

/* --------------------------- plugin framework --------------------------- */

test('plugins: the loaded platform validates clean and inventories every engine', () => {
  const validation = validatePlatform();
  assert.equal(validation.ok, true, validation.issues.join('; '));
  assert.ok(validation.componentCount > 40, `a real platform has many components, got ${validation.componentCount}`);
  const inv = platformInventory();
  for (const prefix of ['twin.', 'physics.', 'optimizer.', 'discovery.', 'experiments.', 'regatta.', 'rpos.']) {
    assert.ok(inv.components.some(c => c.name.startsWith(prefix)), `inventory includes ${prefix}* components`);
  }
  assert.ok(inv.jobKinds.includes('twin.update') && inv.jobKinds.includes('regatta.simulate'));
  assert.ok(inv.contracts.some(c => c.contract === 'regatta.boat-physics'));
  assert.ok(inv.events.some(e => e.type === 'job.completed' && e.subscribers.includes('rpos-audit')));
});

/* ----------------------------- audit trail ----------------------------- */

test('audit trail: job completion appends an immutable computation record', async () => {
  athlete = await mkUser('rpos-ann@test.com', 'RPOS Ann');
  // Real platform work: a synced workout runs the twin pipeline as a job.
  const splits = [130, 131, 130, 129].map(p => ({ distanceM: 500, timeS: p, avgPaceSPer500m: p, avgStrokeRate: 24 }));
  await req('/workouts/sync', {
    method: 'POST', token: athlete.token,
    body: { id: crypto.randomUUID(), totalDistanceM: 2000, totalTimeS: 520, machineType: 'rower', splits, startedAt: Math.floor(Date.now() / 1000) - 520 },
  });
  await processPending();

  const rows = searchComputations({ kind: 'twin.update' });
  assert.ok(rows.length >= 1, 'twin.update execution audited');
  const r = rows[0];
  assert.equal(r.status, 'completed');
  assert.equal(r.userId, athlete.user.id);
  assert.ok(r.inputsHash?.length >= 16, 'inputs hashed');
  assert.ok(r.versions.some(v => v.startsWith('twin.')), 'version manifest recorded');

  // Immutability: the trigger rejects ANY update.
  assert.throws(
    () => db.prepare("UPDATE computation_log SET status = 'tampered' WHERE id = ?").run(r.id),
    /append-only/,
    'computation_log rows cannot be rewritten');
});

test('audit trail: run-backed jobs carry an output reference and hash', async () => {
  const start = await req('/regatta/simulate', {
    method: 'POST', token: athlete.token,
    body: { iterations: 500, opponents: [{ kind: 'archetype', archetype: 'matched' }] },
  });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  await processPending();
  const rows = searchComputations({ kind: 'regatta.simulate' });
  assert.ok(rows.length >= 1);
  assert.match(rows[0].outputsRef, /^race_simulations:/);
  assert.ok(rows[0].outputsHash?.length >= 16, 'outputs hashed');
  assert.ok(rows[0].detail?.winProb !== undefined, 'compact outcome summary attached');
});

/* ----------------------------- orchestrator ----------------------------- */

test('orchestrator: failed jobs are visible, retryable, and recover', async () => {
  admin = await mkUser('lambert.venema2027@gmail.com', 'Lambert', 'coach');
  let failures = 0;
  defineJob('test.rpos-flaky', {
    maxAttempts: 1,
    handler() { if (failures++ === 0) throw new Error('deliberate first failure'); },
  });
  const jobId = enqueue('test.rpos-flaky', { userId: athlete.user.id });
  await processPending();

  const view = await req('/platform/jobs', { token: admin.token });
  assert.equal(view.status, 200);
  assert.ok(view.body.failed.some(j => j.id === jobId), 'the failure is on the operator view');

  const retry = await req(`/platform/jobs/${jobId}/retry`, { method: 'POST', token: admin.token });
  assert.equal(retry.body.ok, true);
  await processPending();
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'completed', 'retried job recovered');

  // The failure AND the recovery are both in the audit trail.
  const audited = searchComputations({ kind: 'test.rpos-flaky' });
  assert.ok(audited.some(r => r.status === 'failed') && audited.some(r => r.status === 'completed'));
});

test('orchestrator: athletes see and control only their own jobs', async () => {
  const mine = await req('/platform/my/jobs', { token: athlete.token });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.jobs.length >= 1);
  assert.ok(mine.body.jobs.every(j => ['twin.update', 'twin.rebuild', 'regatta.simulate', 'optimizer.run', 'test.rpos-flaky'].includes(j.kind)));

  const stranger = await mkUser('rpos-ben@test.com', 'RPOS Ben');
  const someJob = mine.body.jobs[0];
  const stolen = await req(`/platform/my/jobs/${someJob.id}`, { token: stranger.token });
  assert.equal(stolen.status, 404, 'job detail is own-data only');

  // Admin surface is role-gated.
  assert.equal((await req('/platform/status', { token: stranger.token })).status, 403);
  assert.equal((await req('/platform/jobs', { token: stranger.token })).status, 403);
  assert.equal((await req('/platform/audit', { token: stranger.token })).status, 403);
  assert.equal((await req('/platform/orgs', { token: stranger.token })).status, 403);
});

/* ---------------------------- observability ---------------------------- */

test('observability: the platform snapshot composes every surface; watchdog stays quiet on a healthy system', async () => {
  const status = await req('/platform/status', { token: admin.token });
  assert.equal(status.status, 200);
  const snap = status.body.snapshot;
  assert.ok(snap.api.totalRequests > 10, 'API metrics flowing');
  assert.ok(Object.keys(snap.api.latencyByGroup).length >= 1, 'latency percentiles recorded');
  assert.ok(snap.jobs.execution.length >= 1 && snap.jobs.queue.byStatus, 'job metrics + queue state');
  assert.ok(snap.db.tables.users >= 3 && snap.db.sizeBytes > 0, 'database shape reported');
  assert.ok(snap.events.length >= 8 && snap.contracts.length >= 2, 'wiring reported');
  assert.equal(status.body.validation.ok, true);

  const local = platformSnapshot();
  assert.deepEqual(Object.keys(local).sort(), ['api', 'contracts', 'db', 'events', 'jobs', 'version'].sort());
  assert.deepEqual(watchdogTick(), [], 'no regressions on a healthy test run');
  assert.ok(BUDGETS.apiP95Ms > 0);
});

/* ------------------------- versioned API aliases ------------------------- */

test('API versioning: /api/v1/* aliases serve byte-identical contracts', async () => {
  for (const p of ['/twin/state', '/optimizer/meta', '/regatta/meta']) {
    const [plain, v1] = await Promise.all([
      req(p, { token: athlete.token }),
      req(`/v1${p}`, { token: athlete.token }),
    ]);
    assert.equal(plain.status, 200, `${p} works`);
    assert.equal(v1.status, 200, `/v1${p} works`);
    assert.deepEqual(v1.body, plain.body, `/v1${p} matches ${p}`);
  }
  // Platform surface too (own jobs).
  const [plain, v1] = await Promise.all([
    req('/platform/my/jobs', { token: athlete.token }),
    req('/v1/platform/my/jobs', { token: athlete.token }),
  ]);
  assert.deepEqual(v1.body, plain.body);
});

/* ----------------------------- organizations ----------------------------- */

test('organizations: create, attach a coached team, roles enforced server-side', async () => {
  const created = await req('/platform/orgs', { method: 'POST', token: admin.token, body: { name: 'River City Rowing' } });
  assert.equal(created.status, 201);
  const org = created.body.organization;
  assert.equal(org.members[0].role, 'admin', 'creator becomes org admin');

  // The admin signed up as a coach, so a team exists — attach it.
  const teams = await req('/teams', { token: admin.token });
  const teamId = teams.body.coached[0].id;
  const attached = await req(`/platform/orgs/${org.id}/teams`, { method: 'POST', token: admin.token, body: { teamId } });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.organization.teams.length, 1);
  assert.ok(attached.body.organization.members.some(m => m.role === 'coach' || m.role === 'admin'));

  const badRole = await req(`/platform/orgs/${org.id}/members/${athlete.user.id}/role`, { method: 'POST', token: admin.token, body: { role: 'overlord' } });
  assert.equal(badRole.status, 400, 'unknown roles are rejected');
  const goodRole = await req(`/platform/orgs/${org.id}/members/${athlete.user.id}/role`, { method: 'POST', token: admin.token, body: { role: 'athlete' } });
  assert.equal(goodRole.status, 200);
  assert.ok(goodRole.body.organization.members.some(m => m.user_id === athlete.user.id && m.role === 'athlete'));

  const list = await req('/platform/orgs', { token: admin.token });
  assert.equal(list.body.organizations.length, 1);
  assert.equal(list.body.organizations[0].member_count, 2);
});

/* --------------------------- generated docs --------------------------- */

test('docs: generated documentation reflects the live platform', () => {
  const outDir = path.join(DIR, 'generated-docs');
  const files = generateDocs({ outDir });
  assert.equal(files.length, 5);
  const read = (name) => fs.readFileSync(path.join(outDir, name), 'utf8');

  const components = read('components.md');
  assert.match(components, /regatta\.race/, 'component inventory includes the regatta engine');
  assert.match(components, /twin\.stage\./, 'twin pipeline stages documented');

  const schema = read('schema.md');
  assert.match(schema, /CREATE TABLE.*race_simulations/s);
  assert.match(schema, /computation_log_immutable/, 'the immutability trigger is part of the documented schema');

  const api = read('api.md');
  assert.match(api, /POST \| \/api\/regatta\/simulate/);
  assert.match(api, /GET \| \/api\/twin\/state/);

  const wiring = read('events-jobs-contracts.md');
  assert.match(wiring, /job\.completed \| rpos-audit/);
  assert.match(wiring, /regatta\.boat-physics/);

  const arch = read('architecture.md');
  assert.match(arch, /server\/rpos\//);
  assert.match(arch, /server\/kernel\//);
});

test('teardown', () => {
  server.close();
});
