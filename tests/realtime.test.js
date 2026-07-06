// §2.3/§2.4 — Real-time layer tests: channel auth, metric fan-out to the
// coach, roster/presence on disconnect, rejection of non-members.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import WebSocket from 'ws';

const DIR = `/tmp/rowpoint-rt-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;

const { startServer } = await import('../server/index.js');
const server = await startServer(0);
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function makeUser(email, accountType = 'rower') {
  const su = await req('/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: email.split('@')[0], accountType } });
  const ob = await req(`/dev/outbox?to=${email}`);
  const code = ob.body.emails[0].body.match(/code is: (\d{6})/)[1];
  const v = await req('/auth/verify', { method: 'POST', body: { email, code } });
  return { token: v.body.token, user: v.body.user };
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const messages = [];
    const waiters = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      const idx = waiters.findIndex(w => w.match(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else messages.push(msg);
    });
    ws.on('open', () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      next(match, timeoutMs = 4000) {
        const found = messages.findIndex(match);
        if (found >= 0) return Promise.resolve(messages.splice(found, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), timeoutMs);
          waiters.push({ match, resolve: (m) => { clearTimeout(t); res(m); } });
        });
      },
    }));
    ws.on('error', reject);
  });
}

let coach, ann, ben, outsider, assignmentId, channel;

test('setup', async () => {
  coach = await makeUser('coach@rt.com', 'coach');
  ann = await makeUser('ann@rt.com');
  ben = await makeUser('ben@rt.com');
  outsider = await makeUser('out@rt.com');
  const teams = await req('/teams', { token: coach.token });
  const teamId = teams.body.coached[0].id;
  const code = teams.body.coached[0].code;
  await req('/teams/join', { method: 'POST', body: { code }, token: ann.token });
  await req('/teams/join', { method: 'POST', body: { code }, token: ben.token });
  const a = await req(`/teams/${teamId}/assignments`, { method: 'POST', token: coach.token, body: { name: 'Live 2k', plan: { type: 'distance', distanceM: 2000 } } });
  assignmentId = a.body.assignmentId;
  channel = `team_workout:${assignmentId}`;
});

test('coach receives live metrics from multiple rowers simultaneously; leaderboard data flows', async () => {
  const cWs = await connectWs(coach.token);
  cWs.send({ type: 'subscribe', channel, role: 'coach' });
  await cWs.next(m => m.type === 'roster');

  const aWs = await connectWs(ann.token);
  aWs.send({ type: 'subscribe', channel });
  await cWs.next(m => m.type === 'presence' && m.event === 'joined');

  const bWs = await connectWs(ben.token);
  bWs.send({ type: 'subscribe', channel });
  await cWs.next(m => m.type === 'presence' && m.event === 'joined');

  aWs.send({ type: 'metrics', channel, payload: { distanceM: 500, elapsedS: 120, paceS: 120, avgSplitS: 120, strokeRate: 26, heartRate: 165 } });
  bWs.send({ type: 'metrics', channel, payload: { distanceM: 480, elapsedS: 120, paceS: 125, avgSplitS: 125, strokeRate: 24 } });

  const m1 = await cWs.next(m => m.type === 'metrics' && m.userId === ann.user.id);
  assert.equal(m1.metrics.avgSplitS, 120);
  assert.equal(m1.displayName, 'ann');
  const m2 = await cWs.next(m => m.type === 'metrics' && m.userId === ben.user.id);
  assert.equal(m2.metrics.avgSplitS, 125);

  // rowers see each other too (live leaderboard rides the same channel, §2.4)
  const seenByAnn = await aWs.next(m => m.type === 'metrics' && m.userId === ben.user.id);
  assert.equal(seenByAnn.metrics.distanceM, 480);

  // finishing propagates
  aWs.send({ type: 'metrics', channel, payload: { distanceM: 2000, elapsedS: 480, avgSplitS: 120, finished: true } });
  const fin = await cWs.next(m => m.type === 'metrics' && m.userId === ann.user.id && m.metrics.finished);
  assert.equal(fin.metrics.finished, true);

  // disconnect → coach gets presence + roster shows connected:false (staleness, §2.3)
  aWs.ws.close();
  await cWs.next(m => m.type === 'presence' && m.event === 'disconnected' && m.userId === ann.user.id);
  cWs.send({ type: 'roster', channel });
  const roster = await cWs.next(m => m.type === 'roster');
  const annEntry = roster.roster.find(r => r.userId === ann.user.id);
  assert.ok(annEntry, 'last-known data retained during grace period');
  assert.equal(annEntry.connected, false);
  assert.equal(annEntry.metrics.finished, true);

  cWs.ws.close(); bWs.ws.close();
});

test('non-members are rejected from a team workout channel', async () => {
  const oWs = await connectWs(outsider.token);
  oWs.send({ type: 'subscribe', channel });
  const err = await oWs.next(m => m.type === 'error');
  assert.equal(err.code, 'forbidden');
  // and publishing without membership does nothing (no crash)
  oWs.send({ type: 'metrics', channel, payload: { distanceM: 1 } });
  oWs.ws.close();
});

test('unverified/invalid tokens are refused', async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=garbage`);
  const msg = await new Promise((resolve) => ws.on('message', d => resolve(JSON.parse(d.toString()))));
  assert.equal(msg.code, 'unauthenticated');
});

test.after(() => server.close());
