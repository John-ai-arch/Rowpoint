// §4 — Social layer: exact-email search (rate-limited against enumeration,
// §14), connection requests, groups of mutually-connected accounts, activity
// feed, mute/leave, and report/block feeding admin moderation (§3.2).
import { Router } from 'express';
import { db } from './db.js';
import { authRequired, verifiedRequired } from './middleware.js';
import { rateLimit } from './ratelimit.js';
import { uuid, now, badRequest, ApiError, isEmail, safeJson } from './util.js';

export const socialRouter = Router();
socialRouter.use(authRequired, verifiedRequired);

function connectionBetween(a, b) {
  return db.prepare(
    `SELECT * FROM connections WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`)
    .get(a, b, b, a);
}
function isBlockedEitherWay(a, b) {
  return !!db.prepare(
    'SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
    .get(a, b, b, a);
}

/* ---------------- search & connections ---------------- */

// Exact email only — no fuzzy/name search, to prevent profile scraping (§4).
socialRouter.get('/search', rateLimit('email_search', 20, 60 * 60 * 1000), (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw badRequest('Enter a full email address.');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || u.suspended || u.id === req.user.id || isBlockedEitherWay(req.user.id, u.id)) {
    return res.json({ found: false }); // identical response for all miss cases
  }
  const conn = connectionBetween(req.user.id, u.id);
  res.json({
    found: true,
    user: { id: u.id, displayName: u.display_name, photoUrl: u.share_profile ? u.photo_url : null, accountType: u.account_type },
    connection: conn ? { status: conn.status, requestedByMe: conn.requester_id === req.user.id } : null,
  });
});

socialRouter.post('/connections/request', (req, res) => {
  const targetId = String(req.body?.userId || '');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target || target.suspended || isBlockedEitherWay(req.user.id, targetId)) throw new ApiError(404, 'User not found.', 'not_found');
  if (targetId === req.user.id) throw badRequest('You cannot connect with yourself.');
  if (connectionBetween(req.user.id, targetId)) throw badRequest('A connection or request already exists.', 'exists');
  db.prepare('INSERT INTO connections (id, requester_id, addressee_id, status, created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), req.user.id, targetId, 'pending', now());
  const prefs = safeJson(target.notif_prefs, {});
  if (prefs.group_activity !== false) {
    db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)')
      .run(uuid(), targetId, 'group_activity', 'Connection request', `${req.user.display_name} wants to connect on RowPoint.`, now());
  }
  res.status(201).json({ ok: true });
});

socialRouter.post('/connections/:id/respond', (req, res) => {
  const conn = db.prepare('SELECT * FROM connections WHERE id = ? AND addressee_id = ? AND status = ?')
    .get(req.params.id, req.user.id, 'pending');
  if (!conn) throw new ApiError(404, 'Request not found.', 'not_found');
  if (req.body?.accept) {
    db.prepare('UPDATE connections SET status = ? WHERE id = ?').run('accepted', conn.id);
  } else {
    db.prepare('DELETE FROM connections WHERE id = ?').run(conn.id);
  }
  res.json({ ok: true });
});

socialRouter.delete('/connections/:userId', (req, res) => {
  const conn = connectionBetween(req.user.id, req.params.userId);
  if (!conn) throw new ApiError(404, 'No connection with that user.', 'not_found');
  db.prepare('DELETE FROM connections WHERE id = ?').run(conn.id);
  res.json({ ok: true });
});

socialRouter.get('/connections', (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, ru.display_name AS requester_name, au.display_name AS addressee_name,
            ru.photo_url AS requester_photo, au.photo_url AS addressee_photo
     FROM connections c JOIN users ru ON ru.id = c.requester_id JOIN users au ON au.id = c.addressee_id
     WHERE c.requester_id = ? OR c.addressee_id = ?`).all(req.user.id, req.user.id);
  const connections = [], incoming = [], outgoing = [];
  for (const c of rows) {
    const otherIsRequester = c.addressee_id === req.user.id;
    const other = {
      id: otherIsRequester ? c.requester_id : c.addressee_id,
      displayName: otherIsRequester ? c.requester_name : c.addressee_name,
      photoUrl: otherIsRequester ? c.requester_photo : c.addressee_photo,
      connectionId: c.id,
    };
    if (c.status === 'accepted') connections.push(other);
    else if (otherIsRequester) incoming.push(other);
    else outgoing.push(other);
  }
  res.json({ connections, incoming, outgoing });
});

/* ---------------- blocking & reporting (§4 → §3.2 moderation) ---------------- */

socialRouter.post('/block', (req, res) => {
  const targetId = String(req.body?.userId || '');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetId)) throw new ApiError(404, 'User not found.', 'not_found');
  db.prepare('INSERT OR IGNORE INTO blocks (id, blocker_id, blocked_id, created_at) VALUES (?,?,?,?)')
    .run(uuid(), req.user.id, targetId, now());
  const conn = connectionBetween(req.user.id, targetId);
  if (conn) db.prepare('DELETE FROM connections WHERE id = ?').run(conn.id);
  res.json({ ok: true });
});

socialRouter.post('/report', (req, res) => {
  const b = req.body || {};
  if (!b.userId || !b.reason) throw badRequest('Report needs a user and a reason.');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(b.userId)) throw new ApiError(404, 'User not found.', 'not_found');
  db.prepare('INSERT INTO reports (id, reporter_id, target_user_id, group_id, reason, details, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uuid(), req.user.id, b.userId, b.groupId || null, String(b.reason).slice(0, 100), String(b.details || '').slice(0, 1000), 'open', now());
  res.status(201).json({ ok: true, message: 'Thanks — our team will review this report.' });
});

/* ---------------- groups (§4) ---------------- */

socialRouter.post('/groups', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) throw badRequest('Group needs a name.');
  const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
  // Groups are made of mutually-connected accounts (§4).
  for (const mid of memberIds) {
    const conn = connectionBetween(req.user.id, mid);
    if (!conn || conn.status !== 'accepted') {
      throw badRequest('Groups can only include people you are connected with.', 'not_connected');
    }
  }
  const gid = uuid();
  db.prepare('INSERT INTO groups (id, name, creator_id, created_at) VALUES (?,?,?,?)').run(gid, name, req.user.id, now());
  const ins = db.prepare('INSERT INTO group_members (id, group_id, user_id, muted, joined_at) VALUES (?,?,?,0,?)');
  ins.run(uuid(), gid, req.user.id, now());
  for (const mid of new Set(memberIds)) if (mid !== req.user.id) ins.run(uuid(), gid, mid, now());
  res.status(201).json({ groupId: gid });
});

function requireGroupMember(req, groupId) {
  const m = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
  if (!m) throw new ApiError(403, 'You are not in this group.', 'forbidden');
  return m;
}

socialRouter.get('/groups', (req, res) => {
  const rows = db.prepare(
    `SELECT g.*, gm.muted, (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count
     FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?`).all(req.user.id);
  res.json({ groups: rows.map(g => ({ id: g.id, name: g.name, memberCount: g.member_count, muted: !!g.muted })) });
});

socialRouter.post('/groups/:id/members', (req, res) => {
  requireGroupMember(req, req.params.id);
  const mid = String(req.body?.userId || '');
  const conn = connectionBetween(req.user.id, mid);
  if (!conn || conn.status !== 'accepted') throw badRequest('You can only add people you are connected with.', 'not_connected');
  db.prepare('INSERT OR IGNORE INTO group_members (id, group_id, user_id, muted, joined_at) VALUES (?,?,?,0,?)')
    .run(uuid(), req.params.id, mid, now());
  res.json({ ok: true });
});

socialRouter.post('/groups/:id/mute', (req, res) => {
  requireGroupMember(req, req.params.id);
  db.prepare('UPDATE group_members SET muted = ? WHERE group_id = ? AND user_id = ?')
    .run(req.body?.muted ? 1 : 0, req.params.id, req.user.id);
  res.json({ ok: true });
});

socialRouter.post('/groups/:id/leave', (req, res) => {
  requireGroupMember(req, req.params.id);
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Group detail: members with shared info (recent workouts, 2k times, profile),
// all filtered by each person's individual sharing settings (§4, §5).
socialRouter.get('/groups/:id', (req, res) => {
  requireGroupMember(req, req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  const members = db.prepare(
    `SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`).all(req.params.id);
  const detail = members.map(u => ({
    id: u.id,
    displayName: u.display_name,
    photoUrl: u.share_profile ? u.photo_url : null,
    accountType: u.account_type,
    best2kSeconds: u.share_2k_history ? u.best_2k_seconds : null,
    best2kVerified: u.share_2k_history ? !!u.best_2k_verified : null,
    recent2ks: u.share_2k_history
      ? db.prepare(`SELECT started_at, total_time_s FROM workouts
                    WHERE user_id = ? AND total_distance_m >= 2000 AND json_extract(workout_plan_json,'$.type') = 'distance'
                      AND json_extract(workout_plan_json,'$.distanceM') = 2000
                    ORDER BY started_at DESC LIMIT 5`).all(u.id)
      : null,
    recentWorkouts: u.share_workouts_team
      ? db.prepare('SELECT started_at, machine_type, total_distance_m, total_time_s, avg_split_s FROM workouts WHERE user_id = ? ORDER BY started_at DESC LIMIT 3').all(u.id)
      : null,
  }));
  const feed = db.prepare('SELECT * FROM group_feed WHERE group_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id)
    .map(f => ({ id: f.id, userId: f.user_id, type: f.type, payload: safeJson(f.payload_json), createdAt: f.created_at }));
  res.json({ group: { id: group.id, name: group.name, creatorId: group.creator_id }, members: detail, feed });
});
