// Integration tests against a live server instance with a fresh database:
// auth/verification gating, teams, workout sync + AI feedback + leaderboards,
// wellness, research opt-out semantics, social + rate limiting, admin access
// control + audit, account deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = `/tmp/rowpoint-api-${process.pid}`;
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = DIR;
delete process.env.ANTHROPIC_API_KEY;

const { startServer } = await import('../server/index.js');
const { resetRateLimits } = await import('../server/ratelimit.js');
const server = await startServer(0);
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* csv etc */ }
  return { status: r.status, body: json, text };
}

async function makeUser(email, accountType = 'rower', extra = {}) {
  const su = await req('/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: extra.displayName || email.split('@')[0], accountType, ...extra } });
  assert.equal(su.status, 201, JSON.stringify(su.body));
  const ob = await req(`/dev/outbox?to=${email}`);
  const code = ob.body.emails[0].body.match(/code is: (\d{6})/)[1];
  const v = await req('/auth/verify', { method: 'POST', body: { email, code } });
  assert.equal(v.status, 200);
  return { token: v.body.token, user: v.body.user };
}

const uuid = () => crypto.randomUUID();
const mkSplits = (paces) => paces.map((p) => ({ distanceM: 500, timeS: p, avgPaceSPer500m: p, avgStrokeRate: 24, avgHeartRate: 150, avgPowerWatts: 180 }));
const workoutBody = (paces, extra = {}) => {
  const splits = mkSplits(paces);
  const t = splits.reduce((s, x) => s + x.timeS, 0);
  return { id: uuid(), totalDistanceM: splits.length * 500, totalTimeS: t, machineType: 'rower', splits, startedAt: Math.floor(Date.now() / 1000) - t, ...extra };
};

let coach, rower, rower2, admin;

test('setup accounts', async () => {
  coach = await makeUser('coach@test.com', 'coach', { displayName: 'Coach Carla' });
  rower = await makeUser('rower1@test.com', 'rower', { displayName: 'Ann Rower', goalType: 'race_prep', goalWeeklySessions: 14 });
  rower2 = await makeUser('rower2@test.com', 'rower', { displayName: 'Ben Rower' });
});

/* ---------------- auth & verification gating (§2.1) ---------------- */

test('there is NO way in without email verification: no token at signup, none at login', async () => {
  const su = await req('/auth/signup', { method: 'POST', body: { email: 'unv@test.com', password: 'password123', displayName: 'Unv', accountType: 'rower' } });
  assert.equal(su.status, 201);
  assert.equal(su.body.token, undefined, 'signup must not issue a session token');
  assert.equal(su.body.needsVerification, true);
  assert.match(String(su.body.devCode), /^\d{6}$/, 'dev mode surfaces the code in the response');

  // logging in before verifying also yields no token — just the verify flow
  const login = await req('/auth/login', { method: 'POST', body: { email: 'unv@test.com', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.token, undefined);
  assert.equal(login.body.needsVerification, true);
  assert.match(String(login.body.devCode), /^\d{6}$/);

  // and with no token, nothing is reachable
  assert.equal((await req('/workouts/')).status, 401);
  assert.equal((await req('/workouts/sync', { method: 'POST', body: workoutBody([120, 121, 122]) })).status, 401);

  // verifying with the surfaced code completes and issues the session
  const v = await req('/auth/verify', { method: 'POST', body: { email: 'unv@test.com', code: login.body.devCode } });
  assert.equal(v.status, 200);
  assert.ok(v.body.token);
  assert.equal((await req('/workouts/', { token: v.body.token })).status, 200);
});

test('sign-in provider discovery hides unconfigured providers', async () => {
  const p = await req('/auth/providers');
  assert.equal(p.status, 200);
  assert.equal(p.body.google, false); // GOOGLE_CLIENT_ID not set in tests
  assert.equal(p.body.apple, false);
  assert.equal(p.body.devMail, true);
});

test('wrong password and duplicate email are rejected', async () => {
  assert.equal((await req('/auth/login', { method: 'POST', body: { email: 'coach@test.com', password: 'wrongpass1' } })).status, 401);
  assert.equal((await req('/auth/signup', { method: 'POST', body: { email: 'coach@test.com', password: 'password123', displayName: 'X', accountType: 'coach' } })).status, 409);
});

test('OAuth endpoints report unconfigured cleanly (501 with the REAL message, never "internal server error")', async () => {
  const g = await req('/auth/oauth/google', { method: 'POST', body: { idToken: 'x' } });
  assert.equal(g.status, 501);
  assert.match(g.body.message, /not configured/i);
  assert.doesNotMatch(g.body.message, /internal server error/i);
  assert.equal((await req('/auth/oauth/apple', { method: 'POST', body: { idToken: 'x' } })).status, 501);
});

/* ---------------- teams (§2.2) ---------------- */

let teamId, teamCode;

test('coach gets a team + code; rowers join by code; roster respects privacy', async () => {
  const t = await req('/teams', { token: coach.token });
  teamId = t.body.coached[0].id;
  teamCode = t.body.coached[0].code;
  assert.ok(/^[A-Z2-9]{7}$/.test(teamCode));

  for (const r of [rower, rower2]) {
    const j = await req('/teams/join', { method: 'POST', body: { code: teamCode.toLowerCase() }, token: r.token });
    assert.equal(j.status, 200, JSON.stringify(j.body));
  }
  assert.equal((await req('/teams/join', { method: 'POST', body: { code: 'ZZZZZZZ' }, token: rower.token })).status, 404);
  assert.equal((await req('/teams/join', { method: 'POST', body: { code: teamCode }, token: rower.token })).status, 400); // already member

  // privacy: rower2 hides workouts from the team
  await req('/users/me', { method: 'PATCH', body: { shareWorkoutsTeam: false, share2kHistory: false }, token: rower2.token });
  const roster = await req(`/teams/${teamId}/roster`, { token: coach.token });
  assert.equal(roster.status, 200);
  const ben = roster.body.roster.find(r => r.displayName === 'Ben Rower');
  assert.equal(ben.sharesWorkouts, false);
  assert.equal(ben.best2kSeconds, null);
  // non-coach cannot read roster
  assert.equal((await req(`/teams/${teamId}/roster`, { token: rower.token })).status, 404);
});

test('regenerating the team code invalidates the old one', async () => {
  const rg = await req(`/teams/${teamId}/regenerate-code`, { method: 'POST', token: coach.token });
  assert.notEqual(rg.body.code, teamCode);
  const extra = await makeUser('late@test.com');
  assert.equal((await req('/teams/join', { method: 'POST', body: { code: teamCode }, token: extra.token })).status, 404);
  assert.equal((await req('/teams/join', { method: 'POST', body: { code: rg.body.code }, token: extra.token })).status, 200);
  await req(`/teams/${teamId}/members/${extra.user.id}`, { method: 'DELETE', token: coach.token }); // coach removes
  teamCode = rg.body.code;
});

/* ---------------- assignments + workout sync + leaderboard (§2.3–2.5, §11.4) ---------------- */

let assignmentId;

test('coach assigns a workout; roster completion view tracks who has done it', async () => {
  const a = await req(`/teams/${teamId}/assignments`, {
    method: 'POST', token: coach.token,
    body: { name: '6x500 test', plan: { type: 'distance', distanceM: 3000 }, note: 'hold 24' },
  });
  assert.equal(a.status, 201);
  assignmentId = a.body.assignmentId;

  // invalid plan is rejected with instant validation error
  const bad = await req(`/teams/${teamId}/assignments`, {
    method: 'POST', token: coach.token, body: { name: 'bad', plan: { type: 'distance', distanceM: 10 } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_plan');

  const list = await req(`/teams/${teamId}/assignments`, { token: coach.token });
  const mine = list.body.assignments.find(x => x.id === assignmentId);
  assert.equal(mine.roster.filter(r => r.completed).length, 0);
});

test('workout sync: idempotent, computes averages, AI pacing feedback, leaderboard persists', async () => {
  // Ann flies and dies on the assigned piece
  const body = workoutBody([115, 118, 122, 126, 130, 134], { assignmentId });
  const s1 = await req('/workouts/sync', { method: 'POST', body, token: rower.token });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  assert.equal(s1.body.aiFeedback.classification, 'started_too_hard');
  assert.equal(s1.body.aiFeedback.aiGenerated, true);
  assert.ok(s1.body.aiFeedback.text.length > 30);

  // idempotent retry
  const s2 = await req('/workouts/sync', { method: 'POST', body, token: rower.token });
  assert.equal(s2.status, 200);
  assert.equal(s2.body.alreadySynced, true);

  // another user cannot claim the same workout id
  const stolen = await req('/workouts/sync', { method: 'POST', body, token: rower2.token });
  assert.equal(stolen.status, 409);

  // Ben rows it more evenly and faster on average
  const s3 = await req('/workouts/sync', { method: 'POST', body: workoutBody([120, 120.5, 120.2, 119.8, 120.1, 120.4], { assignmentId }), token: rower2.token });
  assert.equal(s3.body.aiFeedback.classification, 'well_paced');

  // leaderboard: lowest average split first, finished flagged
  const lb = await req(`/workouts/leaderboard/team/${teamId}/${assignmentId}`, { token: coach.token });
  assert.equal(lb.status, 200);
  assert.equal(lb.body.entries.length, 2);
  assert.equal(lb.body.entries[0].display_name, 'Ben Rower');
  assert.ok(lb.body.entries[0].avg_split_s < lb.body.entries[1].avg_split_s);
  assert.equal(lb.body.entries[0].finished, 1);
  // outsider cannot read a team leaderboard
  const outsider = await makeUser('outsider@test.com');
  assert.equal((await req(`/workouts/leaderboard/team/${teamId}/${assignmentId}`, { token: outsider.token })).status, 403);

  // completion shows on the roster view
  const list = await req(`/teams/${teamId}/assignments`, { token: coach.token });
  const mine = list.body.assignments.find(x => x.id === assignmentId);
  assert.equal(mine.roster.filter(r => r.completed).length, 2);

  // history is account-scoped (§2.5): outsider sees zero, Ann sees hers only
  assert.equal((await req('/workouts/', { token: outsider.token })).body.workouts.length, 0);
  const annHist = await req('/workouts/', { token: rower.token });
  assert.equal(annHist.body.workouts.length, 1);
  assert.equal(annHist.body.workouts[0].assigned_by_coach_id, coach.user.id);
});

test('2k PB: verified time recorded from a true 2000m piece', async () => {
  const s = await req('/workouts/sync', {
    method: 'POST', token: rower.token,
    body: workoutBody([112, 113, 114, 115], { plan: { type: 'distance', distanceM: 2000 } }),
  });
  assert.equal(s.body.newPb, true);
  const me = await req('/auth/me', { token: rower.token });
  assert.equal(me.body.user.best2kVerified, true);
  assert.equal(Math.round(me.body.user.best2kSeconds), 112 + 113 + 114 + 115);
});

test('workout detail returns splits and force curves', async () => {
  const body = workoutBody([125, 125, 125], { forceCurves: [{ strokeIndex: 1, samples: [10, 80, 200, 150, 40] }] });
  await req('/workouts/sync', { method: 'POST', body, token: rower.token });
  const d = await req(`/workouts/${body.id}`, { token: rower.token });
  assert.equal(d.body.splits.length, 3);
  assert.deepEqual(d.body.forceCurves[0].samples, [10, 80, 200, 150, 40]);
  // other users cannot read it
  assert.equal((await req(`/workouts/${body.id}`, { token: rower2.token })).status, 404);
});

/* ---------------- wellness (§12) ---------------- */

test('wellness: one row per day, same-day edit, trend', async () => {
  const c1 = await req('/wellness/checkin', { method: 'POST', body: { sleepHours: 7.5, sleepQuality: 4, sorenessLevel: 2, stressLevel: 2 }, token: rower.token });
  assert.equal(c1.body.edited, false);
  const c2 = await req('/wellness/checkin', { method: 'POST', body: { sleepHours: 6, sleepQuality: 3, sorenessLevel: 3, stressLevel: 3, restingNotes: 'knee tweak' }, token: rower.token });
  assert.equal(c2.body.edited, true);
  const trend = await req('/wellness/trend?days=7', { token: rower.token });
  assert.equal(trend.body.checkins.length, 1); // still one row for today
  assert.equal(trend.body.checkins[0].sleep_hours, 6);
});

/* ---------------- AI suggestion endpoint (§11) ---------------- */

test('AI suggestion: cached per day, structured + rationale tag, coach can override', async () => {
  const s1 = await req('/ai/suggestion', { token: rower.token });
  assert.equal(s1.status, 200);
  assert.ok(s1.body.suggestion.rationaleTag);
  assert.equal(s1.body.suggestion.aiGenerated, true);
  const s2 = await req('/ai/suggestion', { token: rower.token });
  assert.equal(s2.body.suggestion.id, s1.body.suggestion.id); // cached

  const teamSugg = await req(`/ai/team/${teamId}/suggestions`, { token: coach.token });
  const annSugg = teamSugg.body.suggestions.find(x => x.userId === rower.user.id);
  assert.ok(annSugg, 'coach sees rower suggestion');
  const ovr = await req(`/ai/suggestions/${annSugg.id}/override`, { method: 'POST', body: { note: 'Do the water session instead.' }, token: coach.token });
  assert.equal(ovr.status, 200);
  const s3 = await req('/ai/suggestion', { token: rower.token });
  assert.equal(s3.body.suggestion.status, 'overridden');
  assert.ok(s3.body.suggestion.text.includes('water session'));
  // a non-coach cannot override
  assert.equal((await req(`/ai/suggestions/${annSugg.id}/override`, { method: 'POST', body: { note: 'hi' }, token: rower2.token })).status, 403);
});

/* ---------------- research pipeline (§5) ---------------- */

test('research: opt-in contributes pseudonymously; opt-out stops future contributions immediately', async () => {
  admin = await makeUser('lambert.venema2027@gmail.com', 'coach', { displayName: 'Lambert' });

  const before = await req('/admin/research/workouts', { token: admin.token });
  const countBefore = before.body.rows.length;
  assert.ok(countBefore >= 1); // synced workouts above were contributed (default opt-in)
  // research ids are pseudonymous — never equal to any account id
  for (const row of before.body.rows) {
    assert.notEqual(row.research_id, rower.user.id);
    assert.notEqual(row.research_id, rower2.user.id);
    assert.equal(row.research_id.length, 24);
  }

  // rower opts out → future workouts NOT contributed
  await req('/users/me', { method: 'PATCH', body: { researchOptIn: false }, token: rower.token });
  const s = await req('/workouts/sync', { method: 'POST', body: workoutBody([126, 126, 126]), token: rower.token });
  assert.equal(s.body.research.contributed, false);
  const after = await req('/admin/research/workouts', { token: admin.token });
  assert.equal(after.body.rows.length, countBefore);

  // wellness follows the SAME toggle (§12.3) — no contribution while opted out.
  // The earlier opted-in check-in's contribution is retained (stated policy);
  // an opted-out edit must neither add rows nor update the retained one.
  const wBefore = (await req('/admin/research/wellness', { token: admin.token })).body.rows;
  await req('/wellness/checkin', { method: 'POST', body: { sleepHours: 8, sleepQuality: 4, sorenessLevel: 1, stressLevel: 1 }, token: rower.token });
  const wAfter = (await req('/admin/research/wellness', { token: admin.token })).body.rows;
  assert.equal(wAfter.length, wBefore.length, 'opted-out check-in added no research rows');
  const today = new Date().toISOString().slice(0, 10);
  const retained = wAfter.find(r => r.date === today);
  if (retained) assert.equal(retained.sleep_hours, 6, 'retained contribution not updated while opted out');

  // opting back in resumes contribution
  await req('/users/me', { method: 'PATCH', body: { researchOptIn: true }, token: rower.token });
  const s2 = await req('/workouts/sync', { method: 'POST', body: workoutBody([124, 124, 124]), token: rower.token });
  assert.equal(s2.body.research.contributed, true);

  // CSV export works
  const csv = await req('/admin/research/workouts?format=csv', { token: admin.token });
  assert.ok(csv.text.startsWith('research_id,study_tag'));
});

/* ---------------- social (§4, §14 rate limiting) ---------------- */

test('social: exact-email search, connect/accept, report feeds moderation', async () => {
  const s = await req(`/social/search?email=${encodeURIComponent('rower2@test.com')}`, { token: rower.token });
  assert.equal(s.body.found, true);
  // request + accept a friend connection
  await req('/social/connections/request', { method: 'POST', body: { userId: rower2.user.id }, token: rower.token });
  const conns = await req('/social/connections', { token: rower2.token });
  const incoming = conns.body.incoming[0];
  assert.ok(incoming, 'the request arrived');
  await req(`/social/connections/${incoming.connectionId}/respond`, { method: 'POST', body: { accept: true }, token: rower2.token });
  const accepted = await req('/social/connections', { token: rower.token });
  assert.ok(accepted.body.connections.some(c => c.id === rower2.user.id), 'now connected');

  // report feeds admin moderation
  await req('/social/report', { method: 'POST', body: { userId: rower.user.id, reason: 'spam', details: 'test report' }, token: rower2.token });
});

test('email search is rate-limited against enumeration (§14)', async () => {
  resetRateLimits();
  let last;
  for (let i = 0; i < 21; i++) {
    last = await req(`/social/search?email=probe${i}@test.com`, { token: rower2.token });
  }
  assert.equal(last.status, 429);
  resetRateLimits();
});

test('blocked users cannot be found or re-requested', async () => {
  const trouble = await makeUser('trouble@test.com');
  await req('/social/block', { method: 'POST', body: { userId: trouble.user.id }, token: rower.token });
  const s = await req(`/social/search?email=trouble@test.com`, { token: rower.token });
  assert.equal(s.body.found, false);
  assert.equal((await req('/social/connections/request', { method: 'POST', body: { userId: trouble.user.id }, token: rower.token })).status, 404);
});

/* ---------------- admin (§3) ---------------- */

test('admin access is denied to everyone except the hard-coded owner email', async () => {
  for (const t of [coach.token, rower.token, rower2.token]) {
    assert.equal((await req('/admin/stats', { token: t })).status, 403);
  }
  const st = await req('/admin/stats', { token: admin.token });
  assert.equal(st.status, 200);
  assert.ok(st.body.stats.totalUsers >= 5);
  assert.ok(st.body.stats.coaches >= 2);
  assert.ok(st.body.stats.researchOptOut >= 0);
  assert.ok(st.body.stats.activeLast7d >= 2);
});

test('admin: user search, suspend blocks login and API, reinstate restores', async () => {
  const found = await req(`/admin/users/search?email=rower2@test.com`, { token: admin.token });
  assert.equal(found.body.found, true);
  await req(`/admin/users/${rower2.user.id}/suspend`, { method: 'POST', body: { suspend: true, reason: 'test' }, token: admin.token });
  assert.equal((await req('/workouts/', { token: rower2.token })).status, 403);
  assert.equal((await req('/auth/login', { method: 'POST', body: { email: 'rower2@test.com', password: 'password123' } })).status, 403);
  await req(`/admin/users/${rower2.user.id}/suspend`, { method: 'POST', body: { suspend: false }, token: admin.token });
  assert.equal((await req('/workouts/', { token: rower2.token })).status, 200);
});

test('admin: moderation queue actions reports; broadcast respects notification prefs', async () => {
  const reports = await req('/admin/reports', { token: admin.token });
  assert.ok(reports.body.reports.length >= 1);
  const rep = reports.body.reports[0];
  await req(`/admin/reports/${rep.id}/action`, { method: 'POST', body: { action: 'dismiss', note: 'not abuse' }, token: admin.token });
  assert.equal((await req('/admin/reports?status=dismissed', { token: admin.token })).body.reports.length >= 1, true);

  // rower2 opts out of announcements
  await req('/users/me', { method: 'PATCH', body: { notifPrefs: { workout_reminder: true, wellness_reminder: true, team_activity: true, group_activity: true, announcement: false } }, token: rower2.token });
  const bc = await req('/admin/broadcast', { method: 'POST', body: { title: 'Hello teams', body: 'Test', audience: {} }, token: admin.token });
  assert.equal(bc.status, 200);
  const notifs2 = await req('/users/me/notifications', { token: rower2.token });
  assert.equal(notifs2.body.notifications.filter(n => n.title === 'Hello teams').length, 0);
  const notifs1 = await req('/users/me/notifications', { token: rower.token });
  assert.equal(notifs1.body.notifications.filter(n => n.title === 'Hello teams').length, 1);
});

test('every admin action landed in the audit log (§3.1)', async () => {
  const audit = await req('/admin/audit', { token: admin.token });
  const actions = audit.body.entries.map(a => a.action);
  for (const expected of ['stats.view', 'user.search', 'user.suspend', 'user.reinstate', 'broadcast.send', 'research.workouts.query']) {
    assert.ok(actions.includes(expected), `missing audit entry ${expected}`);
  }
  assert.ok(audit.body.entries.every(a => a.admin_user_id === admin.user.id));
});

/* ---------------- health telemetry ---------------- */

test('client health events surface on the admin health dashboard', async () => {
  await req('/users/me/health-events', { method: 'POST', body: { kind: 'ble_error', detail: 'machine_busy: PM5 in use' }, token: rower.token });
  const h = await req('/admin/health', { token: admin.token });
  assert.ok(h.body.recent.some(e => e.kind === 'ble_error'));
});

/* ---------------- RBAC & extended admin surface ---------------- */

test('RBAC: owner is auto-admin; roles can be granted and revoked; owner cannot be demoted', async () => {
  assert.equal(admin.user.role, 'admin');
  assert.equal(admin.user.isAdmin, true);

  // grant coach the admin role → admin API opens up for them
  const grant = await req(`/admin/users/${coach.user.id}/role`, { method: 'POST', body: { role: 'admin' }, token: admin.token });
  assert.equal(grant.status, 200);
  assert.equal((await req('/admin/stats', { token: coach.token })).status, 200);
  const me = await req('/auth/me', { token: coach.token });
  assert.equal(me.body.user.role, 'admin');
  assert.equal(me.body.user.isAdmin, true);

  // revoke → access closes again, immediately
  await req(`/admin/users/${coach.user.id}/role`, { method: 'POST', body: { role: 'user' }, token: admin.token });
  assert.equal((await req('/admin/stats', { token: coach.token })).status, 403);

  // the owner account can never lose the Admin role
  const demote = await req(`/admin/users/${admin.user.id}/role`, { method: 'POST', body: { role: 'user' }, token: admin.token });
  assert.equal(demote.status, 400);
  assert.equal((await req('/admin/stats', { token: admin.token })).status, 200);
});

test('admin: password reset issues a working temporary password', async () => {
  const r = await req(`/admin/users/${rower2.user.id}/reset-password`, { method: 'POST', token: admin.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.temporaryPassword.length >= 10);
  const login = await req('/auth/login', { method: 'POST', body: { email: 'rower2@test.com', password: r.body.temporaryPassword } });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  rower2.token = login.body.token;
});

test('admin: research participation can be granted/revoked per user', async () => {
  await req(`/admin/users/${rower2.user.id}/research`, { method: 'POST', body: { optIn: false }, token: admin.token });
  let found = await req('/admin/users/search?email=rower2@test.com', { token: admin.token });
  assert.equal(found.body.user.researchOptIn, false);
  await req(`/admin/users/${rower2.user.id}/research`, { method: 'POST', body: { optIn: true }, token: admin.token });
  found = await req('/admin/users/search?email=rower2@test.com', { token: admin.token });
  assert.equal(found.body.user.researchOptIn, true);
});

test('admin: user workout history and feedback views', async () => {
  const w = await req(`/admin/users/${rower.user.id}/workouts`, { token: admin.token });
  assert.equal(w.status, 200);
  assert.ok(w.body.workouts.length >= 1);
  assert.ok(w.body.workouts[0].planType);
  const f = await req(`/admin/users/${rower.user.id}/feedback`, { token: admin.token });
  assert.equal(f.status, 200);
  assert.ok(Array.isArray(f.body.filed) && Array.isArray(f.body.against));
});

test('admin: extended stats include workout + AI analytics', async () => {
  const { body } = await req('/admin/stats', { token: admin.token });
  assert.ok(body.stats.totalMetersRowed > 0);
  assert.ok(body.stats.totalHoursTrained >= 0);
  assert.ok(body.stats.avgWorkoutDurationMin > 0);
  assert.ok(Array.isArray(body.stats.popularWorkoutTypes));
  assert.ok(body.stats.weeklyActiveUsers >= 1);

  const ai = await req('/admin/stats/ai', { token: admin.token });
  assert.equal(ai.status, 200);
  assert.ok(ai.body.stats.totalGenerated >= 1, 'AI recommendations counted');
  assert.ok(ai.body.stats.byCategory.length >= 1);
  assert.equal(ai.body.stats.llmConfigured, false); // no key in tests → analysis engine
  assert.ok(ai.body.stats.bySource.some(s => s.source === 'analysis_engine' || s.source === 'guardrail'));
});

test('admin: system status reports backend, database, auth, and storage', async () => {
  const { body, status } = await req('/admin/system', { token: admin.token });
  assert.equal(status, 200);
  assert.equal(body.system.backend.status, 'ok');
  assert.equal(body.system.database.status, 'ok');
  assert.ok(body.system.database.sizeBytes > 0);
  assert.ok(body.system.database.tableCounts.some(t => t.table === 'workouts' && t.rows >= 1));
  assert.ok(body.system.backend.totalRequests > 0);
  const dbs = await req('/admin/db-stats', { token: admin.token });
  assert.ok(dbs.body.stats.pageCount > 0);
});

test('security: failed logins are recorded and visible to admins only', async () => {
  await req('/auth/login', { method: 'POST', body: { email: 'rower1@test.com', password: 'definitely-wrong' } });
  const sec = await req('/admin/security/auth-events', { token: admin.token });
  assert.equal(sec.status, 200);
  assert.ok(sec.body.summary.failedLogins24h >= 1);
  assert.ok(sec.body.events.some(e => e.kind === 'login_fail' && e.email === 'rower1@test.com'));
  assert.ok(sec.body.events.some(e => e.kind === 'login_success'));
  assert.equal((await req('/admin/security/auth-events', { token: rower.token })).status, 403);
});

test('data management: JSON and SQL research exports are anonymized', async () => {
  const j = await req('/admin/export/research.json', { token: admin.token });
  assert.equal(j.status, 200);
  assert.ok(Array.isArray(j.body.workouts));
  for (const row of j.body.workouts) assert.equal(row.research_id.length, 24);
  const s = await req('/admin/export/research.sql', { token: admin.token });
  assert.equal(s.status, 200);
  assert.ok(s.text.includes('INSERT INTO research_workouts'));
  assert.ok(!s.text.includes('rower1@test.com'), 'no emails in the research export');
});

test('research dataset: HR detail contributed with workouts; completeness report reflects it', async () => {
  const hrSeries = [];
  for (let t = 0; t < 90; t++) hrSeries.push([t, 140]);
  const body = workoutBody([126, 126, 126], { hrSeries });
  await req('/workouts/sync', { method: 'POST', body, token: rower.token });
  const rows = (await req('/admin/research/workouts', { token: admin.token })).body.rows;
  const withHr = rows.filter(r => r.hr_series_json);
  assert.ok(withHr.length >= 1, 'HR series reached the research dataset');
  assert.equal(withHr[0].max_heart_rate, 140);
  assert.ok(withHr[0].equipment.startsWith('rower/'));
  const comp = await req('/admin/research/completeness', { token: admin.token });
  assert.ok(comp.body.report.hrDatasets >= 1);
  assert.ok(comp.body.report.consentingParticipants >= 1);
});

test('research dataset: demographics respect the separate consent toggle', async () => {
  // rower has a birth year? give them one plus consent OFF, then contribute
  await req('/users/me', { method: 'PATCH', body: { birthYear: 1995, researchShareDemographics: false }, token: rower.token });
  const noDemo = workoutBody([127, 127, 127]); // unique avg split identifies the row
  await req('/workouts/sync', { method: 'POST', body: noDemo, token: rower.token });
  let rows = (await req('/admin/research/workouts', { token: admin.token })).body.rows;
  const noDemoRow = rows.find(r => r.avg_split_s === 127);
  assert.ok(noDemoRow, 'contribution still happened');
  assert.equal(noDemoRow.birth_decade, null, 'no demographics without explicit consent');

  await req('/users/me', { method: 'PATCH', body: { researchShareDemographics: true }, token: rower.token });
  const withDemo = workoutBody([127.5, 127.5, 127.5]);
  await req('/workouts/sync', { method: 'POST', body: withDemo, token: rower.token });
  rows = (await req('/admin/research/workouts', { token: admin.token })).body.rows;
  const withDemoRow = rows.find(r => r.avg_split_s === 127.5);
  assert.equal(withDemoRow.birth_decade, 1990, 'birth decade (coarsened) with consent');
});

test('AI adherence: a workout on the recommendation date marks it followed', async () => {
  // rower2 gets today's recommendation, then trains today
  const sugg = await req('/ai/suggestion', { token: rower2.token });
  assert.equal(sugg.status, 200);
  await req('/workouts/sync', { method: 'POST', body: workoutBody([129, 129, 129]), token: rower2.token });
  const again = await req('/ai/suggestion', { token: rower2.token });
  assert.equal(again.body.suggestion.followed, true);
});

test('AI recommendation is grounded in the athlete\'s history and refreshes on demand', async () => {
  const s = await req('/ai/suggestion?refresh=1', { token: rower.token });
  const rec = s.body.suggestion.recommendation;
  assert.ok(rec.category, 'has a category');
  assert.ok(rec.whyAppropriate.length > 10, 'explains why it fits this athlete');
  assert.ok(rec.targetSystem.length > 3, 'names the physiological target');
  assert.ok(Array.isArray(rec.keyFactors));
  assert.equal(rec.source, 'analysis_engine'); // no API key in tests
  const a = await req('/ai/analysis', { token: rower.token });
  assert.equal(a.status, 200);
  assert.ok(a.body.analysis.history.totalWorkouts >= 1);
  assert.ok(a.body.analysis.distribution28d.zonePct);
});

/* ---------------- export & deletion (§14, §10.1) ---------------- */

test('CSV export contains workouts and wellness; account deletion removes everything incl. research rows', async () => {
  const exp = await req('/users/me/export.csv', { token: rower.token });
  assert.ok(exp.text.includes('workout_id,started_at_iso'));
  assert.ok(exp.text.split('\n').length > 4);

  const victim = await makeUser('deleteme@test.com');
  await req('/workouts/sync', { method: 'POST', body: workoutBody([130, 130, 130]), token: victim.token });
  const before = (await req('/admin/research/workouts', { token: admin.token })).body.rows.length;
  assert.equal((await req('/users/me', { method: 'DELETE', body: { confirm: 'wrong' }, token: victim.token })).status, 400);
  const del = await req('/users/me', { method: 'DELETE', body: { confirm: 'delete' }, token: victim.token });
  assert.equal(del.status, 200);
  assert.equal((await req('/auth/me', { token: victim.token })).status, 401);
  assert.equal((await req('/auth/login', { method: 'POST', body: { email: 'deleteme@test.com', password: 'password123' } })).status, 401);
  const after = (await req('/admin/research/workouts', { token: admin.token })).body.rows.length;
  assert.equal(after, before - 1, 'research contribution removed on deletion');
});

/* ---------------- heart-rate subsystem (server side) ---------------- */

test('workout sync stores HR time series, computes zone summary with the user\'s max HR', async () => {
  // Ann sets a custom max HR of 200 → deterministic zone boundaries
  await req('/users/me', { method: 'PATCH', body: { maxHr: 200, restingHr: 52 }, token: rower.token });
  const me = await req('/auth/me', { token: rower.token });
  assert.equal(me.body.user.maxHr, 200);

  const hrSeries = [];
  for (let t = 0; t < 120; t++) hrSeries.push([t, t < 60 ? 115 : 165]); // Z1 then Z4
  const body = workoutBody([128, 128, 128], { hrSeries });
  const s = await req('/workouts/sync', { method: 'POST', body, token: rower.token });
  assert.equal(s.status, 201, JSON.stringify(s.body));

  const d = await req(`/workouts/${body.id}`, { token: rower.token });
  const w = d.body.workout;
  assert.equal(w.hrSeries.length, 120);
  assert.equal(w.max_heart_rate, 165);
  assert.equal(w.min_heart_rate, 115);
  assert.equal(w.hrZones.maxHrUsed, 200);
  assert.equal(w.hrZones.zoneSeconds.length, 5);
  assert.ok(w.hrZones.zoneSeconds[0] >= 58, 'first half in Z1');
  assert.ok(w.hrZones.zoneSeconds[3] >= 58, 'second half in Z4');
  assert.ok(w.hrZones.driftPct > 30, 'drift detected');

  // list endpoint exposes HR summary columns for the history/analysis pages
  const list = await req('/workouts/', { token: rower.token });
  const inList = list.body.workouts.find(x => x.id === body.id);
  assert.equal(inList.max_heart_rate, 165);
  assert.equal(inList.hrZones.zoneSeconds.length, 5);

  // CSV export includes the HR series section
  const exp = await req('/users/me/export.csv', { token: rower.token });
  assert.ok(exp.text.includes('workout_id,t_offset_s,bpm'));
  assert.ok(exp.text.includes(`${body.id},0,115`));
});

test('malformed HR series are sanitized, never crash sync', async () => {
  const body = workoutBody([130, 130, 130], { hrSeries: [['a', 'b'], [0, 9999], null, [1, 130], [1, 131], [2, -5], [3, 128]] });
  const s = await req('/workouts/sync', { method: 'POST', body, token: rower.token });
  assert.equal(s.status, 201);
  const d = await req(`/workouts/${body.id}`, { token: rower.token });
  assert.deepEqual(d.body.workout.hrSeries, [[1, 130], [3, 128]]);
});

test('HR retention follows research consent: opted-out users keep summary only, no raw series', async () => {
  const hrSeries = [];
  for (let t = 0; t < 60; t++) hrSeries.push([t, 150]);

  // opted out → summary statistics stored, raw series discarded
  await req('/users/me', { method: 'PATCH', body: { researchOptIn: false }, token: rower2.token });
  const minimal = workoutBody([131, 131, 131], { hrSeries });
  assert.equal((await req('/workouts/sync', { method: 'POST', body: minimal, token: rower2.token })).status, 201);
  const d1 = await req(`/workouts/${minimal.id}`, { token: rower2.token });
  assert.deepEqual(d1.body.workout.hrSeries, [], 'raw series not retained without research consent');
  assert.equal(d1.body.workout.avg_heart_rate, 150, 'summary avg still available for their own history');
  assert.equal(d1.body.workout.max_heart_rate, 150);
  assert.equal(d1.body.workout.hrZones.zoneSeconds.length, 5, 'zone summary still available');

  // opted in → the full series is kept with the workout
  await req('/users/me', { method: 'PATCH', body: { researchOptIn: true }, token: rower2.token });
  const full = workoutBody([131.5, 131.5, 131.5], { hrSeries });
  assert.equal((await req('/workouts/sync', { method: 'POST', body: full, token: rower2.token })).status, 201);
  const d2 = await req(`/workouts/${full.id}`, { token: rower2.token });
  assert.equal(d2.body.workout.hrSeries.length, 60, 'full series retained with consent');
});

/* ---------------- groups: dashboard, leaderboards, challenges, goals, chat ---------------- */

let groupId;

test('groups: create with privacy, invite-code join, dashboard, non-member blocked', async () => {
  const created = await req('/groups', {
    method: 'POST', token: rower.token,
    body: { name: 'Erg Legends', description: 'Test crew', privacy: 'private', city: 'Boston', country: 'USA' },
  });
  assert.equal(created.status, 201);
  groupId = created.body.groupId;

  const dash = await req(`/groups/${groupId}`, { token: rower.token });
  assert.equal(dash.body.myRole, 'owner');
  assert.ok(dash.body.group.inviteCode.startsWith('G'));
  assert.equal(dash.body.group.privacy, 'private');
  assert.equal(dash.body.group.memberCount, 1);

  // outsider cannot see anything, and cannot join a private group directly
  assert.equal((await req(`/groups/${groupId}`, { token: rower2.token })).status, 403);
  assert.equal((await req(`/groups/${groupId}/join`, { method: 'POST', token: rower2.token })).status, 403);

  // invite code joins instantly and lands in the feed
  const join = await req('/groups/join-by-code', { method: 'POST', body: { code: dash.body.group.inviteCode }, token: rower2.token });
  assert.equal(join.status, 200);
  const dash2 = await req(`/groups/${groupId}`, { token: rower2.token });
  assert.equal(dash2.body.group.memberCount, 2);
  assert.ok(dash2.body.feed.some(f => f.type === 'joined'));
  assert.ok(dash2.body.stats.totalMeters > 0, 'group totals aggregate member workouts');
});

test('groups: join-request flow for private groups (approval by staff)', async () => {
  const r = await req(`/groups/${groupId}/join-request`, { method: 'POST', body: { message: 'Coach here!' }, token: coach.token });
  assert.equal(r.status, 201);
  assert.equal(r.body.joined, false);
  const list = await req(`/groups/${groupId}/join-requests`, { token: rower.token });
  const mine = list.body.requests.find(x => x.userId === coach.user.id);
  assert.ok(mine, 'owner sees the pending request');
  // members can't review requests
  assert.equal((await req(`/groups/${groupId}/join-requests`, { token: rower2.token })).status, 403);
  await req(`/groups/${groupId}/join-requests/${mine.id}`, { method: 'POST', body: { approve: true }, token: rower.token });
  assert.equal((await req(`/groups/${groupId}`, { token: coach.token })).status, 200, 'approved requester is a member');
});

test('groups: leaderboards rank real training data across kinds', async () => {
  // rower2 turned team sharing off in the earlier teams-privacy test —
  // re-enable so both athletes appear on the boards.
  await req('/users/me', { method: 'PATCH', body: { shareWorkoutsTeam: true } , token: rower2.token });
  const meters = await req(`/groups/${groupId}/leaderboard/total_meters`, { token: rower.token });
  assert.ok(meters.body.entries.length >= 2);
  assert.equal(meters.body.entries[0].rank, 1);
  assert.ok(meters.body.entries[0].meters >= meters.body.entries[1].meters, 'sorted by meters');

  const weekly = await req(`/groups/${groupId}/leaderboard/weekly_meters`, { token: rower.token });
  assert.ok(weekly.body.entries.length >= 1, 'this week has meters');

  const twoK = await req(`/groups/${groupId}/leaderboard/best_2k?range=all`, { token: rower.token });
  const ann = twoK.body.entries.find(e => e.userId === rower.user.id);
  assert.ok(ann, 'Ann logged a real 2k');
  assert.match(ann.timeText, /^\d+:\d{2}\.\d$/);
  assert.ok(ann.avgSplitText);

  const streak = await req(`/groups/${groupId}/leaderboard/current_streak`, { token: rower.token });
  assert.ok(streak.body.entries.some(e => e.days >= 1), 'today counts toward a streak');

  const consistent = await req(`/groups/${groupId}/leaderboard/most_consistent`, { token: rower.token });
  assert.ok(consistent.body.entries.every(e => e.consistencyPct >= 0 && e.consistencyPct <= 100));

  assert.equal((await req(`/groups/${groupId}/leaderboard/nonsense`, { token: rower.token })).status, 400);

  // privacy: a member who stops sharing workouts disappears from volume boards
  await req('/users/me', { method: 'PATCH', body: { shareWorkoutsTeam: false }, token: rower2.token });
  const metersAfter = await req(`/groups/${groupId}/leaderboard/total_meters`, { token: rower.token });
  assert.ok(!metersAfter.body.entries.some(e => e.userId === rower2.user.id), 'privacy respected on leaderboards');
  await req('/users/me', { method: 'PATCH', body: { shareWorkoutsTeam: true }, token: rower2.token });
});

test('groups: feed likes and comments', async () => {
  const { body: fb } = await req(`/groups/${groupId}/feed`, { token: rower.token });
  const item = fb.feed[0];
  const like = await req(`/groups/${groupId}/feed/${item.id}/like`, { method: 'POST', token: rower2.token });
  assert.equal(like.body.liked, true);
  assert.equal(like.body.likes, 1);
  await req(`/groups/${groupId}/feed/${item.id}/comments`, { method: 'POST', body: { body: 'Huge session! 🔥' }, token: rower2.token });
  const { body: cb } = await req(`/groups/${groupId}/feed/${item.id}/comments`, { token: rower.token });
  assert.equal(cb.comments.length, 1);
  assert.equal(cb.comments[0].body, 'Huge session! 🔥');
});

test('groups: challenges — permissions, live standings, finalize with winners + badge', async () => {
  // regular members cannot create challenges
  assert.equal((await req(`/groups/${groupId}/challenges`, {
    method: 'POST', body: { name: 'Nope', metric: 'meters' }, token: rower2.token,
  })).status, 403);

  // a live challenge with standings — only training done DURING the window counts
  const live = await req(`/groups/${groupId}/challenges`, {
    method: 'POST', token: rower.token,
    body: { name: 'Meter Monsters', metric: 'meters', endsAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
  });
  assert.equal(live.status, 201);
  await req('/workouts/sync', {
    method: 'POST', token: rower2.token,
    body: workoutBody([134, 134, 134], { startedAt: Math.floor(Date.now() / 1000) }),
  });

  // an already-elapsed challenge finalizes on read: winners + feed + badge
  const t = Math.floor(Date.now() / 1000);
  await req(`/groups/${groupId}/challenges`, {
    method: 'POST', token: rower.token,
    body: { name: 'Yesterday Sprint', metric: 'meters', startsAt: t - 2 * 86400, endsAt: t - 60 },
  });
  const { body } = await req(`/groups/${groupId}/challenges`, { token: rower2.token });
  const liveC = body.challenges.find(c => c.name === 'Meter Monsters');
  assert.equal(liveC.status, 'active');
  assert.ok(liveC.standings.length >= 1, 'live standings computed');
  const done = body.challenges.find(c => c.name === 'Yesterday Sprint');
  assert.equal(done.status, 'finished');
  assert.ok(done.winners.length >= 1, 'winners recorded');
  const winnerBadges = await req('/groups/badges/me', { token: rower.token });
  const rower2Badges = await req('/groups/badges/me', { token: rower2.token });
  const allBadges = [...winnerBadges.body.badges, ...rower2Badges.body.badges].map(b => b.badge);
  assert.ok(allBadges.includes('challenge_winner'), 'challenge winner got the badge');
});

test('groups: collaborative goals track progress and complete on sync', async () => {
  const g = await req(`/groups/${groupId}/goals`, {
    method: 'POST', token: rower.token,
    body: { name: 'Row 3k together', metric: 'meters', target: 3000 },
  });
  assert.equal(g.status, 201);
  // a fresh workout pushes the group over the target → completion detected
  await req('/workouts/sync', { method: 'POST', body: workoutBody([133, 133, 133, 133, 133, 133, 133]), token: rower2.token });
  const { body } = await req(`/groups/${groupId}/goals`, { token: rower.token });
  const goal = body.goals.find(x => x.name === 'Row 3k together');
  assert.equal(goal.progressPct, 100);
  assert.ok(goal.completedAt, 'goal marked completed by the sync hook');
  const { body: fb } = await req(`/groups/${groupId}/feed`, { token: rower.token });
  assert.ok(fb.feed.some(f => f.type === 'goal_completed'));
});

test('groups: chat — messages, reactions, pinning, announcements, deletion permissions', async () => {
  const m1 = await req(`/groups/${groupId}/messages`, { method: 'POST', body: { body: 'Morning erg at 6?' }, token: rower2.token });
  assert.equal(m1.status, 201);
  // members cannot post announcements…
  assert.equal((await req(`/groups/${groupId}/messages`, {
    method: 'POST', body: { kind: 'announcement', body: 'fake' }, token: rower2.token,
  })).status, 403);
  // …but staff can, and the group gets notified
  const ann = await req(`/groups/${groupId}/messages`, {
    method: 'POST', body: { kind: 'announcement', body: 'Regatta entries close Friday!' }, token: rower.token,
  });
  assert.equal(ann.status, 201);
  const notifs = await req('/users/me/notifications', { token: rower2.token });
  assert.ok(notifs.body.notifications.some(n => n.title === 'Group announcement'));

  // reactions toggle
  const react = await req(`/groups/${groupId}/messages/${m1.body.message.id}/react`, { method: 'POST', body: { emoji: '🔥' }, token: rower.token });
  assert.equal(react.body.reacted, true);

  // pinning is staff-only
  assert.equal((await req(`/groups/${groupId}/messages/${ann.body.message.id}/pin`, { method: 'POST', token: rower2.token })).status, 403);
  await req(`/groups/${groupId}/messages/${ann.body.message.id}/pin`, { method: 'POST', token: rower.token });

  // members can't delete others' messages; authors can delete their own
  assert.equal((await req(`/groups/${groupId}/messages/${ann.body.message.id}`, { method: 'DELETE', token: rower2.token })).status, 403);
  assert.equal((await req(`/groups/${groupId}/messages/${m1.body.message.id}`, { method: 'DELETE', token: rower2.token })).status, 200);

  const list = await req(`/groups/${groupId}/messages`, { token: rower.token });
  assert.ok(list.body.pinned.length >= 1, 'pinned message surfaced');
  const deleted = list.body.messages.find(m => m.id === m1.body.message.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.body, null, 'deleted message content is gone');
});

test('groups: roles, member management, achievements on profiles, analytics', async () => {
  // promote rower2 to moderator → they can now create a challenge
  await req(`/groups/${groupId}/members/${rower2.user.id}/role`, { method: 'POST', body: { role: 'moderator' }, token: rower.token });
  assert.equal((await req(`/groups/${groupId}/challenges`, {
    method: 'POST', body: { name: 'Mod challenge', metric: 'workouts' }, token: rower2.token,
  })).status, 201);

  const members = await req(`/groups/${groupId}/members`, { token: rower2.token });
  const ann = members.body.members.find(m => m.id === rower.user.id);
  assert.equal(ann.role, 'owner');
  assert.ok(ann.badges.some(b => b.badge === 'first_workout'), 'badges appear on member profiles');
  assert.ok(ann.badges.some(b => b.badge === 'first_2k'));
  assert.ok(ann.badges.some(b => b.badge === 'pb_2k'));

  // owner cannot leave while others remain
  assert.equal((await req(`/groups/${groupId}/leave`, { method: 'POST', token: rower.token })).status, 400);

  const analytics = await req(`/groups/${groupId}/analytics`, { token: rower.token });
  const a = analytics.body.analytics;
  assert.ok(a.totalMeters > 0);
  assert.ok(a.activeMembers7d >= 1);
  assert.ok(Array.isArray(a.heatmap) && a.heatmap.length >= 1);
  assert.equal(a.growth.length, 8);
});

test('groups: discovery finds public groups; direct join works', async () => {
  const pub = await req('/groups', {
    method: 'POST', token: coach.token,
    body: { name: 'Open Water Collective', privacy: 'public', school: 'State University', city: 'Seattle', country: 'USA' },
  });
  const found = await req('/groups/discover?q=open%20water', { token: rower.token });
  const hit = found.body.groups.find(g => g.id === pub.body.groupId);
  assert.ok(hit, 'public group discoverable by name');
  assert.equal(hit.privacy, 'public');
  const bySchool = await req('/groups/discover?school=state%20university', { token: rower.token });
  assert.ok(bySchool.body.groups.some(g => g.id === pub.body.groupId), 'discoverable by school');
  const join = await req(`/groups/${pub.body.groupId}/join`, { method: 'POST', token: rower.token });
  assert.equal(join.status, 200);
  assert.equal((await req(`/groups/${pub.body.groupId}`, { token: rower.token })).body.group.memberCount, 2);
});

/* ---------------- account persistence & duplicate prevention ---------------- */

test('accounts persist: log out, log back in, same account, history intact, duplicate signup rejected', async () => {
  const persist = await makeUser('persist@test.com', 'rower', { displayName: 'Perry' });
  const w = workoutBody([132, 132, 132]);
  await req('/workouts/sync', { method: 'POST', body: w, token: persist.token });

  // "Log out" (client discards the token) and sign back in days later —
  // same credentials must return the SAME account, not a new one.
  const login = await req('/auth/login', { method: 'POST', body: { email: 'persist@test.com', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.ok(login.body.token, 'login issues a session');
  assert.equal(login.body.user.id, persist.user.id, 'login retrieves the ORIGINAL account');

  // the old token also still works (sessions survive until their TTL)
  assert.equal((await req('/auth/me', { token: persist.token })).status, 200);

  // all previous data is still attached to the account
  const hist = await req('/workouts/', { token: login.body.token });
  assert.ok(hist.body.workouts.some(x => x.id === w.id), 'workout history intact after re-login');

  // registering again with the same email is rejected and points to sign-in
  const dup = await req('/auth/signup', {
    method: 'POST',
    body: { email: 'persist@test.com', password: 'different123', displayName: 'Imposter', accountType: 'rower' },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'email_taken');
  assert.match(dup.body.message, /sign in/i);
  // and email match is case-insensitive at the API boundary (lowercased)
  const dup2 = await req('/auth/signup', {
    method: 'POST',
    body: { email: 'PERSIST@TEST.COM', password: 'different123', displayName: 'Imposter', accountType: 'rower' },
  });
  assert.equal(dup2.status, 409);
});

test('duplicate signup race: simultaneous registrations for one email create exactly one account', async () => {
  const body = (n) => ({ email: 'race@test.com', password: 'password123', displayName: `Racer${n}`, accountType: 'rower' });
  const results = await Promise.all([1, 2, 3, 4].map(n =>
    req('/auth/signup', { method: 'POST', body: body(n) })));
  const created = results.filter(r => r.status === 201);
  const rejected = results.filter(r => r.status === 409);
  assert.equal(created.length, 1, 'exactly one signup wins the race');
  assert.equal(rejected.length, 3, 'the rest get a clean 409, never a 500');
  for (const r of rejected) assert.equal(r.body.error, 'email_taken');
});

test('/admin/system reports storage persistence facts (instance id, boot count)', async () => {
  const { body } = await req('/admin/system', { token: admin.token });
  const p = body.system.database.persistence;
  assert.ok(p.instanceId, 'database has a stable instance id');
  assert.ok(p.bootCount >= 1);
  assert.ok(p.userCount >= 5);
  assert.equal(typeof p.dbExistedAtBoot, 'boolean');
});

/* ---------------- personal progress & gamification hub ---------------- */

test('progress: /api/me/progress aggregates totals, streak, PRs, badges from real data', async () => {
  const p = await makeUser('progress@test.com', 'rower', { displayName: 'Pat', goalWeeklySessions: 3 });
  // a verified 2k plus a couple of steady rows on the same day (streak = 1)
  await req('/workouts/sync', { method: 'POST', token: p.token, body: workoutBody([112, 113, 114, 115], { plan: { type: 'distance', distanceM: 2000 } }) });
  await req('/workouts/sync', { method: 'POST', token: p.token, body: workoutBody([130, 130, 130]) });

  const { status, body } = await req('/me/progress', { token: p.token });
  assert.equal(status, 200);
  const g = body.progress;
  assert.ok(g.totals.meters > 0 && g.totals.workouts === 2, 'lifetime totals');
  assert.equal(g.streak.current, 1, 'today counts toward the streak');
  assert.ok(g.records.best2k && g.records.best2k.timeS > 0, 'verified 2k PR captured');
  assert.ok(g.records.fastestSplit && g.records.fastestSplit.split > 0, 'fastest split PR');
  assert.equal(g.calendar.length, 84, '12-week consistency calendar');
  assert.ok(g.goals.weeklySessions === 3, 'reuses the existing weekly session goal');
  // badges include the full catalog with unlocked flags; personal ones fired
  const unlocked = g.badges.filter(b => b.unlocked).map(b => b.badge);
  assert.ok(unlocked.includes('first_workout'), 'first workout badge unlocked');
  assert.ok(unlocked.includes('first_2k'), 'first 2k badge unlocked');
  assert.ok(g.badges.some(b => !b.unlocked), 'locked badges still listed for the collection');
  assert.equal(g.badgeCount.total, g.badges.length);
});

test('progress: weekly distance goal persists via the standard /users/me PATCH', async () => {
  const p = await makeUser('goalset@test.com', 'rower', { displayName: 'Gina' });
  const patched = await req('/users/me', { method: 'PATCH', body: { goalWeeklyMeters: 25000 }, token: p.token });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.user.goalWeeklyMeters, 25000);
  const { body } = await req('/me/progress', { token: p.token });
  assert.equal(body.progress.goals.weeklyMeters, 25000);
});

test('progress: endpoint requires auth', async () => {
  assert.equal((await req('/me/progress')).status, 401);
});

test('achievements: workout sync reports newly-unlocked badges (idempotent)', async () => {
  const c = await makeUser('celebrate@test.com', 'rower', { displayName: 'Cara' });
  const first = await req('/workouts/sync', { method: 'POST', token: c.token, body: workoutBody([120, 120, 120, 120], { plan: { type: 'distance', distanceM: 2000 } }) });
  assert.equal(first.status, 201);
  assert.ok(Array.isArray(first.body.newBadges), 'sync returns a newBadges array');
  const keys = first.body.newBadges.map(b => b.badge);
  assert.ok(keys.includes('first_workout'), 'first workout unlocked on first sync');
  assert.ok(keys.includes('first_2k'), 'first 2k unlocked');
  assert.ok(first.body.newBadges.every(b => b.label && b.icon), 'badges carry label + icon for the toast');
  // second, different workout must NOT re-award the same badges
  const second = await req('/workouts/sync', { method: 'POST', token: c.token, body: workoutBody([130, 130, 130]) });
  assert.ok(!second.body.newBadges.map(b => b.badge).includes('first_workout'), 'already-earned badges are not re-fired');
});

/* ---------------- production hardening: sessions, headers, health ---------------- */

test('security: logout invalidates the session token server-side', async () => {
  const s = await makeUser('logout@test.com');
  assert.equal((await req('/workouts/', { token: s.token })).status, 200, 'token works before logout');
  const out = await req('/auth/logout', { method: 'POST', token: s.token });
  assert.equal(out.status, 200);
  // the same token must now be rejected everywhere (token_version bumped)
  assert.equal((await req('/workouts/', { token: s.token })).status, 401, 'old token rejected after logout');
  assert.equal((await req('/auth/me', { token: s.token })).status, 401);
  // logging back in issues a fresh, valid token
  const back = await req('/auth/login', { method: 'POST', body: { email: 'logout@test.com', password: 'password123' } });
  assert.ok(back.body.token && back.body.token !== s.token);
  assert.equal((await req('/workouts/', { token: back.body.token })).status, 200);
});

test('security: admin password reset invalidates the user\'s existing sessions', async () => {
  const victim = await makeUser('resetsession@test.com');
  assert.equal((await req('/workouts/', { token: victim.token })).status, 200);
  const r = await req(`/admin/users/${victim.user.id}/reset-password`, { method: 'POST', token: admin.token });
  assert.equal(r.status, 200);
  // the pre-reset token is now dead; the new temp password logs in fresh
  assert.equal((await req('/workouts/', { token: victim.token })).status, 401, 'session killed by reset');
  const relogin = await req('/auth/login', { method: 'POST', body: { email: 'resetsession@test.com', password: r.body.temporaryPassword } });
  assert.ok(relogin.body.token);
  assert.equal((await req('/workouts/', { token: relogin.body.token })).status, 200);
});

test('security: hardened headers are present (CSP, nosniff, frame options, permissions)', async () => {
  const r = await fetch(`${BASE}/api/status`);
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy') || '', /object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('permissions-policy') || '', /bluetooth=\(self\)/);
  assert.equal(r.headers.get('x-powered-by'), null, 'express fingerprint suppressed');
});

test('observability: /api/healthz reports process + database health', async () => {
  const r = await req('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.db, 'ok');
  assert.ok(typeof r.body.uptimeSeconds === 'number');
});

test('integrity: a transactional workout sync stores workout + all its splits together', async () => {
  const p = await makeUser('txn@test.com');
  const body = workoutBody([120, 121, 122, 123, 124]);
  const s = await req('/workouts/sync', { method: 'POST', body, token: p.token });
  assert.equal(s.status, 201);
  const d = await req(`/workouts/${body.id}`, { token: p.token });
  assert.equal(d.body.splits.length, 5, 'all splits committed with the workout');
  assert.ok(d.body.workout.total_distance_m > 0);
});

test('daily suggested workouts have stable shareable ids (§7)', async () => {
  const a = await req('/workouts/daily/suggestions', { token: rower.token });
  const b = await req('/workouts/daily/suggestions', { token: rower2.token });
  assert.ok(a.body.suggestions.length >= 1);
  assert.deepEqual(a.body.suggestions.map(s => s.id), b.body.suggestions.map(s => s.id));
});

test.after(() => { server.close(); });
