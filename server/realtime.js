// §2.3 / §2.4 — Real-time layer. A lightweight WebSocket hub, entirely
// separate from the bulk sync path. Channels are keyed team_workout:{assignment_id}
// (or adhoc:{key}); rowers publish small metric deltas, coaches and fellow
// rowers subscribe for the live grid + live leaderboard. Presence and
// staleness are first-class: subscribers learn when a rower connects, goes
// stale, or disconnects — the view never silently freezes on old data.
import { WebSocketServer } from 'ws';
import { db } from './db.js';
import { verifyToken } from './util.js';

const STALE_AFTER_MS = 6000;

// Server-initiated pushes (e.g. a chat message created over REST is fanned
// out to everyone with the group channel open). Wired up by attachRealtime;
// a no-op before the hub exists (tests that never attach realtime still work).
let hubBroadcast = null;
export function publishToChannel(channel, msg) {
  if (hubBroadcast) hubBroadcast(channel, msg);
}

export function attachRealtime(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  // channel -> Map<userId, { ws, lastMetrics, lastSeen, role }>
  const channels = new Map();

  function channelState(channel) {
    let m = channels.get(channel);
    if (!m) { m = new Map(); channels.set(channel, m); }
    return m;
  }

  function canJoin(user, channel) {
    // team_workout:{assignmentId} → must be team member or its coach.
    // group:{groupId} → must be a group member (live chat + activity).
    const [kind, key] = channel.split(':');
    if (kind === 'adhoc') return typeof key === 'string' && key.length >= 4 && key.length <= 64;
    if (kind === 'group') {
      return !!db.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?').get(key, user.id);
    }
    if (kind !== 'team_workout') return false;
    const a = db.prepare('SELECT team_id, coach_id FROM assignments WHERE id = ?').get(key);
    if (!a) return false;
    if (a.coach_id === user.id) return true;
    return !!db.prepare('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?').get(a.team_id, user.id);
  }

  function broadcast(channel, msg, exceptUserId = null) {
    const m = channels.get(channel);
    if (!m) return;
    const data = JSON.stringify(msg);
    for (const [uid, entry] of m) {
      if (uid === exceptUserId) continue;
      if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(data);
    }
  }
  hubBroadcast = broadcast;

  function roster(channel) {
    const m = channels.get(channel);
    if (!m) return [];
    const nowMs = Date.now();
    return [...m.entries()].map(([uid, e]) => ({
      userId: uid,
      displayName: e.displayName,
      role: e.role,
      connected: e.ws.readyState === e.ws.OPEN,
      stale: e.lastMetrics ? nowMs - e.lastSeen > STALE_AFTER_MS : false,
      metrics: e.lastMetrics || null,
    }));
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const payload = verifyToken(url.searchParams.get('token'));
    const user = payload?.uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid) : null;
    if (!user || user.suspended || !user.email_verified) {
      ws.send(JSON.stringify({ type: 'error', code: 'unauthenticated', message: 'Sign in with a verified account to use live sessions.' }));
      ws.close();
      return;
    }
    const joined = new Set();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString().slice(0, 4096)); } catch { return; }

      if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
        const channel = msg.channel.slice(0, 100);
        if (!canJoin(user, channel)) {
          ws.send(JSON.stringify({ type: 'error', code: 'forbidden', channel, message: 'You are not part of this session.' }));
          return;
        }
        const m = channelState(channel);
        m.set(user.id, {
          ws, role: msg.role === 'coach' ? 'coach' : 'rower',
          displayName: user.display_name, lastMetrics: null, lastSeen: Date.now(),
        });
        joined.add(channel);
        ws.send(JSON.stringify({ type: 'roster', channel, roster: roster(channel) }));
        broadcast(channel, { type: 'presence', channel, event: 'joined', userId: user.id, displayName: user.display_name }, user.id);
      }

      if (msg.type === 'unsubscribe' && joined.has(msg.channel)) {
        channelState(msg.channel).delete(user.id);
        joined.delete(msg.channel);
        broadcast(msg.channel, { type: 'presence', channel: msg.channel, event: 'left', userId: user.id });
      }

      // Small, frequent metric deltas (§7): throttled client-side to ~1 Hz.
      if (msg.type === 'metrics' && joined.has(msg.channel) && msg.payload && typeof msg.payload === 'object') {
        const m = channelState(msg.channel);
        const entry = m.get(user.id);
        if (!entry) return;
        const p = msg.payload;
        entry.lastMetrics = {
          distanceM: Number(p.distanceM) || 0,
          elapsedS: Number(p.elapsedS) || 0,
          paceS: Number(p.paceS) || null,          // current pace s/500m
          avgSplitS: Number(p.avgSplitS) || null,  // drives the live leaderboard (§2.4)
          strokeRate: Number(p.strokeRate) || null,
          heartRate: Number(p.heartRate) || null,
          watts: Number(p.watts) || null,
          finished: !!p.finished,
        };
        entry.lastSeen = Date.now();
        broadcast(msg.channel, {
          type: 'metrics', channel: msg.channel, userId: user.id,
          displayName: user.display_name, metrics: entry.lastMetrics,
        }, user.id);
      }

      if (msg.type === 'roster' && joined.has(msg.channel)) {
        ws.send(JSON.stringify({ type: 'roster', channel: msg.channel, roster: roster(msg.channel) }));
      }
    });

    ws.on('close', () => {
      for (const channel of joined) {
        const m = channels.get(channel);
        const entry = m?.get(user.id);
        // Keep last-known metrics visible but flagged disconnected for a grace
        // period (rower reconnecting mid-session, §2.3), then drop.
        if (entry) {
          entry.ws = ws; // closed socket → connected:false in roster()
          broadcast(channel, { type: 'presence', channel, event: 'disconnected', userId: user.id });
          setTimeout(() => {
            const cur = channels.get(channel)?.get(user.id);
            if (cur && cur.ws.readyState !== cur.ws.OPEN) {
              channels.get(channel).delete(user.id);
              broadcast(channel, { type: 'presence', channel, event: 'left', userId: user.id });
              if (channels.get(channel)?.size === 0) channels.delete(channel);
            }
          }, 30000).unref?.();
        }
      }
    });
  });

  // Periodic staleness sweep: subscribers get roster refreshes so a frozen
  // phone shows as "stale" on the coach grid rather than silently fresh.
  const sweep = setInterval(() => {
    for (const [channel, m] of channels) {
      if (!m.size) { channels.delete(channel); continue; }
      broadcast(channel, { type: 'roster', channel, roster: roster(channel) });
    }
  }, 5000);
  sweep.unref?.();

  return wss;
}
