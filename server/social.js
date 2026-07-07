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

/* Groups moved to their own router (server/groups.js) — the expanded groups
   feature (dashboards, leaderboards, challenges, goals, chat, achievements,
   discovery) lives under /api/groups. The connection/block/report endpoints
   above remain the §4 friend-connection layer. */
