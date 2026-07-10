// Computational kernel tests: the Estimate type, seeded RNG, shared
// statistics, versioned registry, event bus (with error isolation), the
// dependency graph, and the SQLite-backed job system. Also the architectural
// isolation test: the kernel must import nothing from any engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = `/tmp/rowpoint-kernel-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
process.env.ROWPOINT_JOBS_ENABLED = '0';

const { db } = await import('../server/db.js');
const est = await import('../server/kernel/estimate.js');
const { createRng, seedFrom } = await import('../server/kernel/rng.js');
const stats = await import('../server/kernel/stats.js');
const registry = await import('../server/kernel/registry.js');
const events = await import('../server/kernel/events.js');
const { createGraph } = await import('../server/kernel/graph.js');
const jobs = await import('../server/kernel/jobs.js');

/* ------------------------------ estimate ------------------------------ */

test('estimate: constructors validate and carry provenance', () => {
  const m = est.measured(42, { modelVersion: 'x@1.0' });
  assert.equal(m.value, 42);
  assert.equal(m.provenance, 'measured');
  assert.equal(m.uncertainty, 0);
  assert.ok(est.isEstimate(m));

  assert.throws(() => est.makeEstimate({ value: NaN, provenance: 'measured' }), /finite number/);
  assert.throws(() => est.makeEstimate({ value: 1, provenance: 'guessed' }), /provenance/);
  assert.throws(() => est.makeEstimate({ value: 1, provenance: 'measured', confidence: 2 }), /confidence/);
  assert.equal(est.isEstimate({ value: 1 }), false);
});

test('estimate: combine is inverse-variance weighted and accumulates evidence', () => {
  const a = est.makeEstimate({ value: 10, uncertainty: 1, confidence: 0.8, provenance: 'estimated', evidenceCount: 5 });
  const b = est.makeEstimate({ value: 20, uncertainty: 3, confidence: 0.6, provenance: 'estimated', evidenceCount: 2 });
  const c = est.combine(a, b);
  // Weight of a = 1/1, b = 1/9 → value ≈ (10 + 20/9) / (1 + 1/9) = 11.0
  assert.ok(Math.abs(c.value - 11) < 0.01, `expected ~11, got ${c.value}`);
  assert.ok(c.uncertainty < 1, 'combined spread shrinks below the tighter input');
  assert.equal(c.evidenceCount, 7);
});

test('estimate: blend nudges toward the new value and strengthens with evidence', () => {
  const prev = est.makeEstimate({ value: 100, uncertainty: 10, confidence: 0.5, provenance: 'estimated', evidenceCount: 10 });
  const next = est.makeEstimate({ value: 110, uncertainty: 10, confidence: 0.5, provenance: 'estimated', evidenceCount: 1 });
  const out = est.blend(prev, next, 0.3);
  assert.ok(Math.abs(out.value - 103) < 0.01); // 100·0.7 + 110·0.3
  assert.equal(out.evidenceCount, 11);
  assert.ok(out.confidence >= 0.5, 'evidence accumulation lifts confidence');
  // Blending with no previous state returns the new estimate unchanged.
  assert.deepEqual(est.blend(null, next, 0.3), next);
});

test('estimate: confidence decays with age', () => {
  const e = est.estimated(50, { confidence: 0.8 });
  const aged = est.decayConfidence(e, 28, 28);
  assert.ok(Math.abs(aged.confidence - 0.4) < 0.001, 'one half-life halves confidence');
  assert.equal(aged.value, 50, 'value never decays — only trust in it');
});

/* -------------------------------- rng -------------------------------- */

test('rng: same seed → identical stream; different seeds diverge', () => {
  const a1 = createRng(1234), a2 = createRng(1234), b = createRng(5678);
  const seqA1 = Array.from({ length: 20 }, () => a1.float());
  const seqA2 = Array.from({ length: 20 }, () => a2.float());
  const seqB = Array.from({ length: 20 }, () => b.float());
  assert.deepEqual(seqA1, seqA2);
  assert.notDeepEqual(seqA1, seqB);
  assert.equal(seedFrom('user-1', 'race'), seedFrom('user-1', 'race'));
  assert.notEqual(seedFrom('user-1', 'race'), seedFrom('user-2', 'race'));
});

test('rng: distributions behave sanely', () => {
  const rng = createRng(42);
  for (let i = 0; i < 1000; i++) {
    const v = rng.int(3, 7);
    assert.ok(v >= 3 && v <= 7);
  }
  const gauss = Array.from({ length: 5000 }, () => rng.gaussian(10, 2));
  const m = gauss.reduce((a, b) => a + b, 0) / gauss.length;
  assert.ok(Math.abs(m - 10) < 0.15, `gaussian mean ~10, got ${m}`);
  const shuffled = rng.shuffle([1, 2, 3, 4, 5]);
  assert.deepEqual([...shuffled].sort(), [1, 2, 3, 4, 5]);
});

/* ------------------------------- stats ------------------------------- */

test('stats: descriptive statistics against fixtures', () => {
  assert.equal(stats.mean([1, 2, 3, 4]), 2.5);
  assert.equal(stats.median([5, 1, 3]), 3);
  assert.equal(stats.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(stats.sd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.01);
  assert.equal(stats.mean([]), null);
  assert.equal(stats.sd([1]), null);
  assert.equal(stats.mean([1, NaN, 3]), 2, 'non-finite inputs are ignored, not propagated');
});

test('stats: regression recovers an exact linear relationship', () => {
  const xs = [0, 1, 2, 3, 4, 5];
  const reg = stats.linearRegression(xs, xs.map(x => 2 * x + 1));
  assert.ok(Math.abs(reg.slope - 2) < 1e-9);
  assert.ok(Math.abs(reg.intercept - 1) < 1e-9);
  assert.ok(Math.abs(reg.r2 - 1) < 1e-9);
  assert.equal(stats.pearson(xs, xs.map(x => 3 * x - 2)), 1);
  assert.ok(stats.spearman(xs, xs.map(x => x ** 3)) === 1, 'spearman sees monotonic as perfect');
  assert.equal(stats.linearRegression([1, 1, 1], [1, 2, 3]), null, 'no x-variance → null');
});

test('stats: Welch t and effect size separate what is separated', () => {
  const a = [10, 11, 10.5, 9.8, 10.2, 10.7, 9.9, 10.4];
  const b = [14, 15, 14.5, 13.8, 14.2, 14.7, 13.9, 15.1];
  const w = stats.welchT(a, b);
  assert.ok(w.p < 0.001, `clearly different samples → tiny p, got ${w.p}`);
  assert.ok(Math.abs(stats.cohensD(a, b)) > 2);
  const same = stats.welchT(a, a.map(v => v + 0.01));
  assert.ok(same.p > 0.5, `near-identical samples → large p, got ${same.p}`);
});

test('stats: Benjamini–Hochberg controls the ordering', () => {
  const out = stats.benjaminiHochberg([0.01, 0.04, 0.03, 0.005], 0.05);
  assert.equal(out.length, 4);
  assert.ok(out[3].significant, 'smallest p survives');
  for (const o of out) assert.ok(o.adjusted >= o.p, 'adjustment never shrinks p');
});

test('stats: seeded bootstrap and k-means are reproducible', () => {
  const data = [3, 4, 5, 4, 3, 5, 4, 4, 6, 2];
  const ci1 = stats.bootstrapCI(data, stats.mean, { rng: createRng(7), iterations: 500 });
  const ci2 = stats.bootstrapCI(data, stats.mean, { rng: createRng(7), iterations: 500 });
  assert.deepEqual(ci1, ci2, 'same seed → identical CI');
  assert.ok(ci1.lo <= 4 && ci1.hi >= 4, 'CI covers the sample mean');

  const pts = [[0, 0], [0.2, 0.1], [0.1, 0.2], [5, 5], [5.1, 4.9], [4.9, 5.2]];
  const km = stats.kmeans(pts, 2, { rng: createRng(3) });
  assert.deepEqual([...km.sizes].sort(), [3, 3], 'two clean clusters of three');
  assert.equal(km.assignments[0], km.assignments[1]);
  assert.notEqual(km.assignments[0], km.assignments[3]);
});

test('stats: exponential decay fit recovers parameters', () => {
  const ts = [0, 1, 2, 3, 4, 5];
  const fit = stats.fitExponentialDecay(ts, ts.map(t => 8 * Math.exp(-0.5 * t)));
  assert.ok(Math.abs(fit.a - 8) < 0.01);
  assert.ok(Math.abs(fit.k - 0.5) < 0.001);
});

/* ------------------------------ registry ------------------------------ */

test('registry: registration persists, validates, and resolves latest', () => {
  registry.register({ name: 'test.model.alpha', kind: 'model', version: '1.0', description: 'test' });
  registry.register({ name: 'test.model.alpha', kind: 'model', version: '1.1', description: 'test' });
  assert.equal(registry.lookup('test.model.alpha').version, '1.1', 'latest wins without explicit version');
  assert.equal(registry.lookup('test.model.alpha', '1.0').version, '1.0');
  assert.throws(() => registry.register({ name: 'Bad Name!', kind: 'model', version: '1.0' }), /name/);
  assert.throws(() => registry.register({ name: 'test.model.beta', kind: 'nonsense', version: '1.0' }), /kind/);
  assert.throws(() => registry.register({ name: 'test.model.beta', kind: 'model', version: 'v1' }), /version/i);
  const rows = db.prepare("SELECT * FROM model_versions WHERE name = 'test.model.alpha' ORDER BY version").all();
  assert.equal(rows.length, 2, 'both versions persisted — versions are never deleted');
  assert.ok(registry.versionManifest(['test.model.alpha']).includes('test.model.alpha@1.1'));
});

/* ------------------------------- events ------------------------------- */

test('events: emit reaches subscribers, isolates failures, logs to event_log', () => {
  events.defineEvent('test.ping');
  const seen = [];
  events.on('test.ping', 'good-subscriber', (p) => { seen.push(p.n); return 'ok'; });
  events.on('test.ping', 'bad-subscriber', () => { throw new Error('boom'); });

  const outcomes = events.emit('test.ping', { n: 7 });
  assert.deepEqual(seen, [7]);
  assert.equal(outcomes.find(o => o.name === 'good-subscriber').ok, true);
  assert.equal(outcomes.find(o => o.name === 'bad-subscriber').ok, false, 'failure reported, not thrown');

  const logged = db.prepare("SELECT * FROM event_log WHERE type = 'test.ping'").all();
  assert.equal(logged.length, 1);
  const health = db.prepare("SELECT * FROM health_events WHERE kind = 'event_handler_error'").all();
  assert.ok(health.some(h => h.detail.includes('bad-subscriber')), 'subscriber failure recorded');

  assert.throws(() => events.emit('never.defined', {}), /Unknown event/);
  // Re-subscribing the same (type, name) replaces, never double-fires.
  events.on('test.ping', 'good-subscriber', (p) => seen.push(p.n * 10));
  events.emit('test.ping', { n: 2 });
  assert.deepEqual(seen, [7, 20]);
});

/* ------------------------------- graph ------------------------------- */

test('graph: topological order, cycle rejection, keyed dirty propagation', async () => {
  const g = createGraph('t');
  const ran = [];
  g.node({ name: 'a', compute: () => { ran.push('a'); return 1; } });
  g.node({ name: 'b', dependsOn: ['a'], compute: (ctx, r) => { ran.push('b'); return r.a + 1; } });
  g.node({ name: 'c', dependsOn: ['b'], compute: (ctx, r) => { ran.push('c'); return r.b + 1; } });
  g.node({ name: 'd', dependsOn: ['a'], compute: () => { ran.push('d'); return 0; } });

  assert.throws(() => g.node({ name: 'a', compute: () => {} }), /already has/);

  const order = g.topoOrder();
  assert.ok(order.indexOf('a') < order.indexOf('b'));
  assert.ok(order.indexOf('b') < order.indexOf('c'));

  // Marking b stale for user1 dirties b and c but NOT a or d — and not user2.
  g.markStale('user1', 'b');
  assert.deepEqual(g.staleNodes('user1').sort(), ['b', 'c']);
  assert.deepEqual(g.staleNodes('user2'), []);

  const { ran: executed, results } = await g.run('user1', {});
  assert.deepEqual(executed.sort(), ['b', 'c']);
  // Clean nodes are skipped and their previous in-memory results are NOT
  // re-provided — nodes must persist their own outputs (documented contract).
  assert.ok(Number.isNaN(results.b));
  assert.deepEqual(g.staleNodes('user1'), [], 'run clears staleness');
  assert.deepEqual(ran.filter(n => n === 'a'), [], 'clean nodes are skipped');
});

test('graph: cycles are rejected at registration', () => {
  const g = createGraph('cyclic');
  g.node({ name: 'x', dependsOn: ['y'], compute: () => {} });
  assert.throws(() => g.node({ name: 'y', dependsOn: ['x'], compute: () => {} }), /Cycle/);
});

/* -------------------------------- jobs -------------------------------- */

test('jobs: define → enqueue → process; coalescing; checkpoint; cancel', async () => {
  const runs = [];
  jobs.defineJob('test.echo', {
    handler({ payload, checkpoint, saveCheckpoint }) {
      runs.push(payload.msg);
      if (!checkpoint) saveCheckpoint({ progress: 50 });
    },
  });

  const id1 = jobs.enqueue('test.echo', { userId: 'u1', payload: { msg: 'first' } });
  const id2 = jobs.enqueue('test.echo', { userId: 'u1', payload: { msg: 'replaced' } });
  assert.equal(id1, id2, 'pending (kind,user) coalesces into one job');
  const idOther = jobs.enqueue('test.echo', { userId: 'u2', payload: { msg: 'other-user' } });
  assert.notEqual(id1, idOther);

  const n = await jobs.processPending();
  assert.equal(n, 2);
  assert.deepEqual(runs.sort(), ['other-user', 'replaced'], 'coalesced payload wins; users independent');
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id1);
  assert.equal(row.status, 'completed');
  assert.ok(row.duration_ms !== null);
  assert.equal(JSON.parse(row.checkpoint_json).progress, 50);

  const idCancel = jobs.enqueue('test.echo', { userId: 'u3', payload: { msg: 'never' } });
  assert.equal(jobs.cancel(idCancel), true);
  await jobs.processPending();
  assert.ok(!runs.includes('never'));
});

test('jobs: failures retry with backoff, then fail terminally', async () => {
  let attempts = 0;
  jobs.defineJob('test.flaky', { maxAttempts: 2, handler() { attempts++; throw new Error('nope'); } });
  const id = jobs.enqueue('test.flaky', { userId: 'u9' });

  await jobs.processPending();
  let row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  assert.equal(row.status, 'pending', 'first failure re-queues');
  assert.equal(row.attempts, 1);
  assert.ok(row.run_at > Math.floor(Date.now() / 1000), 'backoff pushes run_at into the future');

  // Force the retry due now, then exhaust attempts.
  db.prepare('UPDATE jobs SET run_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, id);
  await jobs.processPending();
  row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.equal(attempts, 2);
  assert.ok(db.prepare("SELECT * FROM health_events WHERE kind = 'job_failed'").all()
    .some(h => h.detail.includes('test.flaky')), 'terminal failure surfaces in health events');
});

/* ------------------------ architectural isolation ------------------------ */

test('isolation: the kernel imports nothing from any engine', () => {
  const kernelDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'kernel');
  const engineDirs = ['twin', 'physics', 'optimizer', 'discovery', 'experiments', 'regatta', 'rpos'];
  for (const file of fs.readdirSync(kernelDir)) {
    const src = fs.readFileSync(path.join(kernelDir, file), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      for (const engine of engineDirs) {
        assert.ok(!spec.includes(`/${engine}/`) && !spec.endsWith(`/${engine}`),
          `kernel/${file} must not import engine code (found "${spec}")`);
      }
    }
  }
});

test('isolation: engines import only the kernel, their own code, and shared app modules', () => {
  const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
  const engineDirs = ['twin', 'physics', 'optimizer', 'discovery', 'experiments', 'regatta', 'rpos'];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const engine of engineDirs) {
    const dir = path.join(serverDir, engine);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1];
        for (const other of engineDirs) {
          if (other === engine) continue;
          assert.ok(!spec.includes(`/${other}/`) && !spec.endsWith(`/${other}`),
            `${engine}/${path.basename(file)} must not import engine "${other}" (found "${spec}") — engines talk through the kernel`);
        }
      }
    }
  }
});
