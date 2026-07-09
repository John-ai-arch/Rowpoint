// Groups — the expanded social layer. A group is a persistent community
// (club, school squad, friend circle, research cohort) with its own
// dashboard, automatic leaderboards, activity feed with reactions/comments,
// challenges, collaborative goals, chat, roles, privacy modes, achievements,
// and analytics. Everything an athlete shares here still respects their
// individual privacy settings: volume/streak boards include only members
// with share_workouts_team enabled, erg-score boards only members with
// share_2k_history enabled.
import { Router } from 'express';
import { db } from './db.js';
import { authRequired, verifiedRequired } from './middleware.js';
import { publishToChannel } from './realtime.js';
import { logger } from './log.js';
import { uuid, now, badRequest, ApiError, safeJson, fmtSplit } from './util.js';

const log = logger('groups');

export const groupsRouter = Router();
groupsRouter.use(authRequired, verifiedRequired);

const ROLE_RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };
const DAY = 86400;

/* ================================================================== */
/* helpers                                                             */
/* ================================================================== */

function membership(groupId, userId) {
  return db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}
function requireMember(req, groupId) {
  const m = membership(groupId, req.user.id);
  if (!m) throw new ApiError(403, 'You are not in this group.', 'forbidden');
  return m;
}
function requireRole(req, groupId, minRole) {
  const m = requireMember(req, groupId);
  if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) {
    throw new ApiError(403, `This action needs the ${minRole} role.`, 'forbidden');
  }
  return m;
}
function getGroup(groupId) {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!g) throw new ApiError(404, 'Group not found.', 'not_found');
  return g;
}

function inviteCode() {
  return `G${uuid().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** Notify group members (respecting per-user prefs and per-group mute). */
function notifyGroup(groupId, title, body, { exceptUserId = null } = {}) {
  const rows = db.prepare(
    `SELECT u.id, u.notif_prefs, gm.muted FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? AND u.suspended = 0`).all(groupId);
  const ins = db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)');
  let sent = 0;
  for (const r of rows) {
    if (r.id === exceptUserId || r.muted) continue;
    if (safeJson(r.notif_prefs, {}).group_activity === false) continue;
    ins.run(uuid(), r.id, 'group_activity', title.slice(0, 120), String(body || '').slice(0, 500), now());
    sent++;
  }
  return sent;
}

function postFeed(groupId, userId, type, payload) {
  db.prepare('INSERT INTO group_feed (id, group_id, user_id, type, payload_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(uuid(), groupId, userId, type, JSON.stringify(payload), now());
}

/* ---- time windows (UTC; weeks reset Monday 00:00 UTC) ---- */

export function weekStartS(t = now()) {
  const d = new Date(t * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) / 1000);
}
function monthStartS(t = now()) {
  const d = new Date(t * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}
function yearStartS(t = now()) {
  const d = new Date(t * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / 1000);
}
// Rowing training season: September 1st (traditional northern-hemisphere year).
function seasonStartS(t = now()) {
  const d = new Date(t * 1000);
  const y = d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return Math.floor(Date.UTC(y, 8, 1) / 1000);
}
export function isoWeekKey(t) {
  const d = new Date(t * 1000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7)); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((target - firstThursday) / (7 * DAY * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/* ---- SQL fragments ---- */

// Erg-test filters: a "verified" score is an actual logged piece of exactly
// that programmed distance/time — never a self-reported number.
const TEST_2K = "json_extract(w.workout_plan_json,'$.type')='distance' AND json_extract(w.workout_plan_json,'$.distanceM')=2000 AND w.total_distance_m >= 2000 AND w.total_time_s > 0";
const TEST_5K = "json_extract(w.workout_plan_json,'$.type')='distance' AND json_extract(w.workout_plan_json,'$.distanceM')=5000 AND w.total_distance_m >= 5000 AND w.total_time_s > 0";
const TEST_6K = "json_extract(w.workout_plan_json,'$.type')='distance' AND json_extract(w.workout_plan_json,'$.distanceM')=6000 AND w.total_distance_m >= 6000 AND w.total_time_s > 0";
const TEST_30MIN = "json_extract(w.workout_plan_json,'$.type')='time' AND json_extract(w.workout_plan_json,'$.durationS')=1800";
const TEST_60MIN = "json_extract(w.workout_plan_json,'$.type')='time' AND json_extract(w.workout_plan_json,'$.durationS')=3600";

/* ================================================================== */
/* leaderboards                                                        */
/* ================================================================== */

export const LEADERBOARD_KINDS = [
  'best_2k', 'total_meters', 'weekly_meters', 'monthly_meters', 'annual_meters',
  'total_time', 'total_workouts', 'longest_streak', 'current_streak',
  'most_improved_2k', 'best_5k', 'best_6k', 'best_30min', 'best_60min',
  'avg_weekly_volume', 'single_day_volume', 'zone2_time', 'interval_workouts',
  'most_consistent',
];

// Volume/consistency boards respect share_workouts_team; erg-score boards
// respect share_2k_history.
const VOLUME_PRIVACY = 'u.share_workouts_team = 1';
const SCORE_PRIVACY = 'u.share_2k_history = 1';

function volumeBoard(groupId, sinceS) {
  const params = [];
  let where = '';
  if (sinceS) { where = 'AND w.started_at >= ?'; params.push(sinceS); }
  return db.prepare(
    `SELECT u.id AS userId, u.display_name AS displayName,
            COALESCE(SUM(w.total_distance_m),0) AS meters,
            COUNT(w.id) AS workouts,
            COALESCE(SUM(w.total_time_s),0) AS seconds
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
     LEFT JOIN workouts w ON w.user_id = u.id ${where}
     WHERE gm.group_id = ?
     GROUP BY u.id ORDER BY meters DESC LIMIT 100`).all(...params, groupId);
}

function bestTimeBoard(groupId, testSql, sinceS) {
  const params = [groupId];
  let where = '';
  if (sinceS) { where = 'AND w.started_at >= ?'; params.push(sinceS); }
  // SQLite returns the matching row's other columns alongside a lone MIN().
  return db.prepare(
    `SELECT u.id AS userId, u.display_name AS displayName,
            MIN(w.total_time_s) AS timeS, w.started_at AS achievedAt, w.avg_split_s AS avgSplitS
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id AND ${SCORE_PRIVACY}
     JOIN workouts w ON w.user_id = u.id AND ${testSql} ${where}
     WHERE gm.group_id = ?
     GROUP BY u.id ORDER BY timeS ASC LIMIT 100`).all(...params.slice(1), groupId);
}

function bestDistanceBoard(groupId, testSql) {
  return db.prepare(
    `SELECT u.id AS userId, u.display_name AS displayName,
            MAX(w.total_distance_m) AS meters, w.started_at AS achievedAt, w.avg_split_s AS avgSplitS
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id AND ${SCORE_PRIVACY}
     JOIN workouts w ON w.user_id = u.id AND ${testSql}
     WHERE gm.group_id = ?
     GROUP BY u.id ORDER BY meters DESC LIMIT 100`).all(groupId);
}

/** Distinct training days per sharing member — feeds streak + consistency. */
function memberTrainingDays(groupId) {
  const rows = db.prepare(
    `SELECT u.id AS userId, u.display_name AS displayName, date(w.started_at,'unixepoch') AS d
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
     JOIN workouts w ON w.user_id = u.id
     WHERE gm.group_id = ?
     GROUP BY u.id, d ORDER BY u.id, d`).all(groupId);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, { displayName: r.displayName, days: [] });
    byUser.get(r.userId).days.push(r.d);
  }
  return byUser;
}

export const dayNum = (iso) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / (DAY * 1000));

export function streaksFor(days) {
  let longest = 0, run = 0, prev = null;
  for (const d of days) {
    const n = dayNum(d);
    run = prev !== null && n === prev + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = n;
  }
  // Current streak counts only if it reaches today or yesterday.
  const today = Math.floor(now() / DAY);
  const current = prev !== null && (today - prev) <= 1 ? run : 0;
  return { longest, current };
}

export function computeLeaderboard(groupId, kind, range = 'all') {
  const t = now();
  const rank = (entries) => entries.map((e, i) => ({ rank: i + 1, ...e }));

  switch (kind) {
    case 'best_2k': {
      const since = range === 'season' ? seasonStartS(t) : range === '12mo' ? t - 365 * DAY : null;
      return rank(bestTimeBoard(groupId, TEST_2K, since).map(e => ({
        ...e, timeText: fmtDur(e.timeS), avgSplitText: fmtSplit(e.avgSplitS ?? e.timeS / 4),
      })));
    }
    case 'best_5k': return rank(bestTimeBoard(groupId, TEST_5K).map(e => ({ ...e, timeText: fmtDur(e.timeS), avgSplitText: fmtSplit(e.avgSplitS ?? e.timeS / 10) })));
    case 'best_6k': return rank(bestTimeBoard(groupId, TEST_6K).map(e => ({ ...e, timeText: fmtDur(e.timeS), avgSplitText: fmtSplit(e.avgSplitS ?? e.timeS / 12) })));
    case 'best_30min': return rank(bestDistanceBoard(groupId, TEST_30MIN));
    case 'best_60min': return rank(bestDistanceBoard(groupId, TEST_60MIN));

    case 'total_meters': return rank(volumeBoard(groupId, null).filter(e => e.meters > 0));
    case 'weekly_meters': return rank(volumeBoard(groupId, weekStartS(t)).filter(e => e.meters > 0));
    case 'monthly_meters': return rank(volumeBoard(groupId, monthStartS(t)).filter(e => e.meters > 0));
    case 'annual_meters': return rank(volumeBoard(groupId, yearStartS(t)).filter(e => e.meters > 0));
    case 'total_time':
      return rank(volumeBoard(groupId, null).filter(e => e.seconds > 0)
        .sort((a, b) => b.seconds - a.seconds)
        .map(e => ({ ...e, hours: Math.round(e.seconds / 360) / 10 })));
    case 'total_workouts':
      return rank(volumeBoard(groupId, null).filter(e => e.workouts > 0).sort((a, b) => b.workouts - a.workouts));

    case 'longest_streak': case 'current_streak': {
      const byUser = memberTrainingDays(groupId);
      const key = kind === 'longest_streak' ? 'longest' : 'current';
      const entries = [...byUser.entries()]
        .map(([userId, v]) => ({ userId, displayName: v.displayName, ...streaksFor(v.days) }))
        .filter(e => e[key] > 0)
        .sort((a, b) => b[key] - a[key]);
      return rank(entries.map(e => ({ userId: e.userId, displayName: e.displayName, days: e[key], longest: e.longest, current: e.current })));
    }

    case 'most_improved_2k': {
      // Improvement = first logged 2k minus current best 2k (seconds gained).
      const rows = db.prepare(
        `SELECT u.id AS userId, u.display_name AS displayName, w.total_time_s AS t, w.started_at AS at
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND ${SCORE_PRIVACY}
         JOIN workouts w ON w.user_id = u.id AND ${TEST_2K}
         WHERE gm.group_id = ? ORDER BY u.id, w.started_at`).all(groupId);
      const byUser = new Map();
      for (const r of rows) {
        let e = byUser.get(r.userId);
        if (!e) { e = { userId: r.userId, displayName: r.displayName, first: r.t, best: r.t, attempts: 0 }; byUser.set(r.userId, e); }
        e.best = Math.min(e.best, r.t);
        e.attempts++;
      }
      const entries = [...byUser.values()]
        .filter(e => e.attempts >= 2 && e.first > e.best)
        .map(e => ({ userId: e.userId, displayName: e.displayName, improvedS: Math.round((e.first - e.best) * 10) / 10, firstText: fmtDur(e.first), bestText: fmtDur(e.best) }))
        .sort((a, b) => b.improvedS - a.improvedS);
      return rank(entries);
    }

    case 'avg_weekly_volume': {
      const rows = db.prepare(
        `SELECT u.id AS userId, u.display_name AS displayName,
                SUM(w.total_distance_m) AS meters, MIN(w.started_at) AS firstAt
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
         JOIN workouts w ON w.user_id = u.id
         WHERE gm.group_id = ? GROUP BY u.id`).all(groupId);
      const entries = rows.map(r => {
        const weeks = Math.max(1, (t - r.firstAt) / (7 * DAY));
        return { userId: r.userId, displayName: r.displayName, weeklyMeters: Math.round(r.meters / weeks), totalMeters: Math.round(r.meters) };
      }).sort((a, b) => b.weeklyMeters - a.weeklyMeters);
      return rank(entries);
    }

    case 'single_day_volume': {
      const rows = db.prepare(
        `SELECT userId, displayName, MAX(dayMeters) AS meters, d AS achievedDate FROM (
           SELECT u.id AS userId, u.display_name AS displayName,
                  date(w.started_at,'unixepoch') AS d, SUM(w.total_distance_m) AS dayMeters
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
           JOIN workouts w ON w.user_id = u.id
           WHERE gm.group_id = ? GROUP BY u.id, d)
         GROUP BY userId ORDER BY meters DESC LIMIT 100`).all(groupId);
      return rank(rows);
    }

    case 'zone2_time': {
      // Zone 2 = the easy-aerobic band (60–70% of max HR) — index 1 of the
      // stored per-workout zoneSeconds array.
      const rows = db.prepare(
        `SELECT u.id AS userId, u.display_name AS displayName,
                COALESCE(SUM(json_extract(w.hr_zones_json,'$.zoneSeconds[1]')),0) AS seconds,
                COUNT(w.hr_zones_json) AS workoutsWithHr
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
         JOIN workouts w ON w.user_id = u.id AND w.hr_zones_json IS NOT NULL
         WHERE gm.group_id = ? GROUP BY u.id HAVING seconds > 0
         ORDER BY seconds DESC LIMIT 100`).all(groupId);
      return rank(rows.map(r => ({ ...r, hours: Math.round(r.seconds / 360) / 10 })));
    }

    case 'interval_workouts': {
      const rows = db.prepare(
        `SELECT u.id AS userId, u.display_name AS displayName, COUNT(w.id) AS workouts
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
         JOIN workouts w ON w.user_id = u.id AND json_extract(w.workout_plan_json,'$.type')='intervals'
         WHERE gm.group_id = ? GROUP BY u.id ORDER BY workouts DESC LIMIT 100`).all(groupId);
      return rank(rows);
    }

    case 'most_consistent': {
      // % of weeks (since each athlete's first workout) with ≥1 session.
      const byUser = memberTrainingDays(groupId);
      const entries = [...byUser.entries()].map(([userId, v]) => {
        const weeks = new Set(v.days.map(d => isoWeekKey(dayNum(d) * DAY + 43200)));
        const firstDay = dayNum(v.days[0]);
        const totalWeeks = Math.max(1, Math.ceil((Math.floor(t / DAY) - firstDay + 1) / 7));
        return {
          userId, displayName: v.displayName,
          consistencyPct: Math.min(100, Math.round((weeks.size / totalWeeks) * 100)),
          activeWeeks: weeks.size, totalWeeks,
        };
      }).filter(e => e.activeWeeks > 0)
        .sort((a, b) => b.consistencyPct - a.consistencyPct || b.activeWeeks - a.activeWeeks);
      return rank(entries);
    }

    default:
      throw badRequest(`Unknown leaderboard: ${kind}. Available: ${LEADERBOARD_KINDS.join(', ')}`, 'unknown_leaderboard');
  }
}

function fmtDur(totalS) {
  if (!Number.isFinite(totalS)) return '–';
  totalS = Math.round(totalS * 10) / 10;
  const m = Math.floor(totalS / 60);
  const s = (totalS - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

/* ================================================================== */
/* achievements                                                        */
/* ================================================================== */

export const BADGES = {
  first_workout: 'First Workout',
  first_week: 'First Week Completed',
  workouts_100: '100 Workouts',
  workouts_500: '500 Workouts',
  meters_100k: '100,000 Meters',
  meters_1m: '1 Million Meters',
  meters_5m: '5 Million Meters',
  marathon_42k: 'Marathon Distance',
  first_2k: 'First 2K',
  pb_2k: 'Personal Record',
  streak_7: 'Seven-Day Streak',
  streak_30: 'Thirty-Day Streak',
  streak_365: 'One-Year Streak',
  weekly_goal: 'Weekly Goal Completed',
  consistency_master: 'Consistency Master',
  weekly_champion: 'Weekly Champion',
  monthly_champion: 'Monthly Champion',
  challenge_winner: 'Challenge Winner',
};

// Icon for each badge, shared by every surface that renders achievements.
export const BADGE_ICONS = {
  first_workout: '🚣', first_week: '📅', workouts_100: '💯', workouts_500: '🏅',
  meters_100k: '🌊', meters_1m: '🌍', meters_5m: '🏆', marathon_42k: '🏃',
  first_2k: '⚡', pb_2k: '📈', streak_7: '🔥', streak_30: '🔥', streak_365: '👑',
  weekly_goal: '🎯', consistency_master: '🧭', weekly_champion: '🥇',
  monthly_champion: '👑', challenge_winner: '⚔️',
};

export function awardBadge(userId, badge, context = null) {
  if (!BADGES[badge]) return false;
  const r = db.prepare(
    `INSERT INTO user_achievements (id, user_id, badge, label, context_json, achieved_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, badge) DO NOTHING`)
    .run(uuid(), userId, badge, BADGES[badge], context ? JSON.stringify(context) : null, now());
  return r.changes > 0;
}

export function badgesFor(userId) {
  return db.prepare('SELECT badge, label, achieved_at FROM user_achievements WHERE user_id = ? ORDER BY achieved_at').all(userId);
}

/* ================================================================== */
/* workout-sync hook (called by workouts.js after every synced workout) */
/* ================================================================== */

const METER_MILESTONES = [100000, 250000, 500000, 1000000, 2000000, 5000000, 10000000];

export function onWorkoutSynced(user, workout, { newPb = false } = {}) {
  // Badges newly unlocked by THIS workout — returned so the client can play a
  // tasteful celebration. awardBadge() is idempotent and returns true only on
  // a first-time unlock, so this never re-fires for existing achievements.
  const newBadges = [];
  const grant = (badge, ctx) => { if (awardBadge(user.id, badge, ctx)) newBadges.push(badge); };
  const result = () => ({ newBadges: newBadges.map(b => ({ badge: b, label: BADGES[b], icon: BADGE_ICONS[b] || '🏅' })) });
  try {
    const totals = db.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(total_distance_m),0) AS meters FROM workouts WHERE user_id = ?').get(user.id);

    /* ---- personal achievements (always, independent of sharing) ---- */
    grant('first_workout');
    if (totals.n >= 100) grant('workouts_100');
    if (totals.n >= 500) grant('workouts_500');
    if (totals.meters >= 100000) grant('meters_100k');
    if (totals.meters >= 1000000) grant('meters_1m');
    if (totals.meters >= 5000000) grant('meters_5m');
    const plan = safeJson(workout.workout_plan_json);
    if (plan?.type === 'distance' && Number(plan.distanceM) === 2000) grant('first_2k');
    if (newPb) grant('pb_2k', { timeS: workout.total_time_s });
    if ((Number(workout.total_distance_m) || 0) >= 42195) grant('marathon_42k');
    const days = db.prepare(
      "SELECT date(started_at,'unixepoch') AS d FROM workouts WHERE user_id = ? GROUP BY d ORDER BY d").all(user.id).map(r => r.d);
    const { current } = streaksFor(days);
    if (current >= 7) grant('streak_7', { days: current });
    if (current >= 30) grant('streak_30', { days: current });
    if (current >= 365) grant('streak_365', { days: current });
    // First Week Completed: training history spans at least a full week.
    if (days.length >= 2 && (dayNum(days[days.length - 1]) - dayNum(days[0])) >= 6) grant('first_week');
    // Consistency Master: trained in each of the last 4 ISO weeks.
    const recentWeeks = new Set(days.map(d => isoWeekKey(dayNum(d) * DAY + 43200)));
    const last4 = [0, 1, 2, 3].map(i => isoWeekKey(weekStartS() - i * 7 * DAY + 43200));
    if (last4.every(w => recentWeeks.has(w))) grant('consistency_master');
    // Weekly Goal Completed: this week's sessions met the user's stated goal.
    if (user.goal_weekly_sessions > 0) {
      const ws = weekStartS();
      const weekSessions = db.prepare(
        'SELECT COUNT(*) c FROM workouts WHERE user_id = ? AND started_at >= ?').get(user.id, ws).c;
      if (weekSessions >= user.goal_weekly_sessions) grant('weekly_goal', { goal: user.goal_weekly_sessions });
    }

    /* ---- group-facing effects (only when the athlete shares workouts) ---- */
    if (!user.share_workouts_team) return result();
    const groups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(user.id).map(r => r.group_id);
    if (!groups.length) return result();

    const meters = Number(workout.total_distance_m) || 0;
    const before = totals.meters - meters;
    const milestone = METER_MILESTONES.find(m => before < m && totals.meters >= m);

    // Weekly-leaderboard movement: who did this workout overtake?
    const ws = weekStartS();
    const myWeek = db.prepare(
      'SELECT COALESCE(SUM(total_distance_m),0) m FROM workouts WHERE user_id = ? AND started_at >= ?').get(user.id, ws).m;
    const myWeekBefore = myWeek - meters;

    for (const gid of groups) {
      if (milestone) {
        postFeed(gid, user.id, 'milestone', {
          displayName: user.display_name, milestoneMeters: milestone, lifetimeMeters: Math.round(totals.meters),
        });
      }
      if (newPb) {
        notifyGroup(gid, 'Teammate personal record',
          `${user.display_name} set a new 2k personal best: ${fmtDur(workout.total_time_s)}.`,
          { exceptUserId: user.id });
      }
      // Overtaken members: their weekly meters sit between my old and new totals.
      const overtaken = db.prepare(
        `SELECT u.id, u.display_name, COALESCE(SUM(w.total_distance_m),0) AS m
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND u.share_workouts_team = 1
         LEFT JOIN workouts w ON w.user_id = u.id AND w.started_at >= ?
         WHERE gm.group_id = ? AND u.id != ?
         GROUP BY u.id HAVING m > ? AND m <= ?`).all(ws, gid, user.id, myWeekBefore, myWeek);
      for (const o of overtaken.slice(0, 10)) {
        const prefs = safeJson(db.prepare('SELECT notif_prefs FROM users WHERE id = ?').get(o.id)?.notif_prefs, {});
        const muted = db.prepare('SELECT muted FROM group_members WHERE group_id = ? AND user_id = ?').get(gid, o.id)?.muted;
        if (prefs.group_activity === false || muted) continue;
        db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)')
          .run(uuid(), o.id, 'group_activity', 'Leaderboard update',
            `${user.display_name} just passed you on this week's meters leaderboard.`, now());
      }

      // Collaborative goals: mark newly-completed ones.
      for (const goal of db.prepare('SELECT * FROM group_goals WHERE group_id = ? AND completed_at IS NULL').all(gid)) {
        const value = goalProgressValue(gid, goal);
        if (value >= goal.target) {
          db.prepare('UPDATE group_goals SET completed_at = ? WHERE id = ?').run(now(), goal.id);
          postFeed(gid, user.id, 'goal_completed', { name: goal.name, target: goal.target, metric: goal.metric });
          notifyGroup(gid, 'Team goal completed! 🎉', `The group finished "${goal.name}" together.`);
        }
      }
    }
  } catch (e) {
    // Social side-effects must never fail a workout save.
    log.error(`onWorkoutSynced side-effects failed: ${e.message}`);
  }
  return result();
}

function goalProgressValue(groupId, goal) {
  const col = goal.metric === 'meters' ? 'SUM(w.total_distance_m)'
    : goal.metric === 'hours' ? 'SUM(w.total_time_s)/3600.0'
      : 'COUNT(w.id)';
  // A workout counts toward a goal if it FINISHED after the goal started —
  // the session someone was mid-way through when the goal was created counts.
  return db.prepare(
    `SELECT COALESCE(${col},0) v FROM workouts w
     JOIN group_members gm ON gm.user_id = w.user_id AND gm.group_id = ?
     WHERE COALESCE(w.ended_at, w.started_at) >= ?`).get(groupId, goal.starts_at).v;
}

/* ================================================================== */
/* weekly history + champions (lazy rollover on group views)           */
/* ================================================================== */

function rolloverPeriods(groupId) {
  const t = now();
  // Previous completed week.
  const thisWeekStart = weekStartS(t);
  const prevWeekStart = thisWeekStart - 7 * DAY;
  const weekKey = isoWeekKey(prevWeekStart);
  if (!db.prepare('SELECT id FROM group_week_history WHERE group_id = ? AND week_key = ? LIMIT 1').get(groupId, weekKey)) {
    const standings = db.prepare(
      `SELECT u.id AS userId, u.display_name AS displayName,
              COALESCE(SUM(w.total_distance_m),0) AS meters, COUNT(w.id) AS workouts
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
       JOIN workouts w ON w.user_id = u.id AND w.started_at >= ? AND w.started_at < ?
       WHERE gm.group_id = ? GROUP BY u.id HAVING meters > 0 ORDER BY meters DESC`)
      .all(prevWeekStart, thisWeekStart, groupId);
    if (standings.length) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO group_week_history (id, group_id, week_key, user_id, display_name, meters, workouts, rank, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
      standings.forEach((s, i) => ins.run(uuid(), groupId, weekKey, s.userId, s.displayName, s.meters, s.workouts, i + 1, now()));
      const champ = standings[0];
      awardBadge(champ.userId, 'weekly_champion', { groupId, weekKey, meters: champ.meters });
      postFeed(groupId, champ.userId, 'weekly_champion', {
        displayName: champ.displayName, weekKey, meters: Math.round(champ.meters),
      });
    }
  }
  // Previous completed month (stored in the same table, period key 2026-M06).
  const thisMonthStart = monthStartS(t);
  const prevMonthStart = monthStartS(thisMonthStart - DAY);
  const md = new Date(prevMonthStart * 1000);
  const monthKey = `${md.getUTCFullYear()}-M${String(md.getUTCMonth() + 1).padStart(2, '0')}`;
  if (!db.prepare('SELECT id FROM group_week_history WHERE group_id = ? AND week_key = ? LIMIT 1').get(groupId, monthKey)) {
    const top = db.prepare(
      `SELECT u.id AS userId, u.display_name AS displayName, COALESCE(SUM(w.total_distance_m),0) AS meters, COUNT(w.id) AS workouts
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
       JOIN workouts w ON w.user_id = u.id AND w.started_at >= ? AND w.started_at < ?
       WHERE gm.group_id = ? GROUP BY u.id HAVING meters > 0 ORDER BY meters DESC LIMIT 1`)
      .get(prevMonthStart, thisMonthStart, groupId);
    if (top) {
      db.prepare('INSERT OR IGNORE INTO group_week_history (id, group_id, week_key, user_id, display_name, meters, workouts, rank, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uuid(), groupId, monthKey, top.userId, top.displayName, top.meters, top.workouts, 1, now());
      awardBadge(top.userId, 'monthly_champion', { groupId, monthKey, meters: top.meters });
    }
  }
}

/* ================================================================== */
/* challenges                                                          */
/* ================================================================== */

const CHALLENGE_METRICS = ['meters', 'workouts', 'avg_split', 'streak', 'team_meters', 'custom'];

function challengeStandings(challenge) {
  const { group_id: gid, starts_at: s, ends_at: e } = challenge;
  const clampEnd = Math.min(e, now());
  switch (challenge.metric) {
    case 'meters': case 'team_meters': case 'workouts': {
      const rows = db.prepare(
        `SELECT u.id AS userId, u.display_name AS displayName,
                COALESCE(SUM(w.total_distance_m),0) AS meters, COUNT(w.id) AS workouts
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
         JOIN workouts w ON w.user_id = u.id AND w.started_at >= ? AND w.started_at <= ?
         WHERE gm.group_id = ? GROUP BY u.id HAVING workouts > 0`).all(s, clampEnd, gid);
      const key = challenge.metric === 'workouts' ? 'workouts' : 'meters';
      const entries = rows.sort((a, b) => b[key] - a[key]).map((r, i) => ({ rank: i + 1, ...r }));
      const teamTotal = rows.reduce((x, r) => x + r.meters, 0);
      return { entries, teamTotal: Math.round(teamTotal) };
    }
    case 'avg_split': {
      // True average pace over the window; requires 2000m+ inside the window.
      const rows = db.prepare(
        `SELECT u.id AS userId, u.display_name AS displayName,
                SUM(w.total_distance_m) AS meters, SUM(w.total_time_s) AS seconds
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
         JOIN workouts w ON w.user_id = u.id AND w.started_at >= ? AND w.started_at <= ?
         WHERE gm.group_id = ? GROUP BY u.id HAVING meters >= 2000`).all(s, clampEnd, gid);
      const entries = rows.map(r => ({ ...r, avgSplitS: Math.round((r.seconds / r.meters) * 5000) / 10 }))
        .sort((a, b) => a.avgSplitS - b.avgSplitS)
        .map((r, i) => ({ rank: i + 1, userId: r.userId, displayName: r.displayName, avgSplitS: r.avgSplitS, avgSplitText: fmtSplit(r.avgSplitS), meters: Math.round(r.meters) }));
      return { entries, teamTotal: null };
    }
    case 'streak': {
      const rows = db.prepare(
        `SELECT u.id AS userId, u.display_name AS displayName, date(w.started_at,'unixepoch') AS d
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
         JOIN workouts w ON w.user_id = u.id AND w.started_at >= ? AND w.started_at <= ?
         WHERE gm.group_id = ? GROUP BY u.id, d ORDER BY u.id, d`).all(s, clampEnd, gid);
      const byUser = new Map();
      for (const r of rows) {
        if (!byUser.has(r.userId)) byUser.set(r.userId, { displayName: r.displayName, days: [] });
        byUser.get(r.userId).days.push(r.d);
      }
      const entries = [...byUser.entries()]
        .map(([userId, v]) => ({ userId, displayName: v.displayName, days: streaksFor(v.days).longest }))
        .sort((a, b) => b.days - a.days)
        .map((r, i) => ({ rank: i + 1, ...r }));
      return { entries, teamTotal: null };
    }
    default: // custom — progress tracked socially, standings by meters as a default view
      return challengeStandings({ ...challenge, metric: 'meters' });
  }
}

/** Finalize any challenge whose window has closed (lazy, on read). */
function finalizeDueChallenges(groupId) {
  const due = db.prepare(
    "SELECT * FROM group_challenges WHERE group_id = ? AND status = 'active' AND ends_at < ?").all(groupId, now());
  for (const c of due) {
    const { entries, teamTotal } = challengeStandings(c);
    const winners = entries.slice(0, 3).map(e => ({ userId: e.userId, displayName: e.displayName, rank: e.rank }));
    db.prepare("UPDATE group_challenges SET status = 'finished', winners_json = ? WHERE id = ?")
      .run(JSON.stringify({ winners, teamTotal }), c.id);
    if (winners.length) {
      awardBadge(winners[0].userId, 'challenge_winner', { challengeId: c.id, name: c.name });
      postFeed(groupId, winners[0].userId, 'challenge_finished', {
        name: c.name, winner: winners[0].displayName, winners,
      });
      notifyGroup(groupId, 'Challenge finished', `"${c.name}" is over — ${winners[0].displayName} takes it! 🏆`);
    }
  }
  return due.length;
}

/* ================================================================== */
/* routes: create / discover / join                                    */
/* ================================================================== */

groupsRouter.post('/', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw badRequest('Group needs a name.');
  const gid = uuid();
  db.prepare(
    `INSERT INTO groups (id, name, creator_id, created_at, description, photo_url, privacy,
                         invite_code, hide_members, school, club, city, region, country)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(gid, name, req.user.id, now(),
      String(b.description || '').slice(0, 500) || null,
      String(b.photoUrl || '').slice(0, 500) || null,
      b.privacy === 'public' ? 'public' : 'private',
      inviteCode(), b.hideMembers ? 1 : 0,
      strOrNull(b.school), strOrNull(b.club), strOrNull(b.city), strOrNull(b.region), strOrNull(b.country));
  db.prepare("INSERT INTO group_members (id, group_id, user_id, muted, joined_at, role) VALUES (?,?,?,0,?,'owner')")
    .run(uuid(), gid, req.user.id, now());
  res.status(201).json({ groupId: gid });
});

const strOrNull = (v) => { const s = String(v || '').trim().slice(0, 80); return s || null; };

// Discovery: public groups always searchable; private groups appear too (name
// + size only) so people can request to join — their content stays members-only.
groupsRouter.get('/discover', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const filters = [];
  const params = [];
  for (const f of ['school', 'club', 'city', 'region', 'country']) {
    if (req.query[f]) { filters.push(`LOWER(g.${f}) LIKE ?`); params.push(`%${String(req.query[f]).toLowerCase().slice(0, 80)}%`); }
  }
  if (q) {
    filters.push('(LOWER(g.name) LIKE ? OR LOWER(COALESCE(g.school,\'\')) LIKE ? OR LOWER(COALESCE(g.club,\'\')) LIKE ? OR LOWER(COALESCE(g.city,\'\')) LIKE ?)');
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  if (!filters.length) throw badRequest('Search by name, school, club, city, region, or country.');
  const rows = db.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
     FROM groups g WHERE ${filters.join(' AND ')} ORDER BY member_count DESC LIMIT 30`).all(...params);
  res.json({
    groups: rows.map(g => ({
      id: g.id, name: g.name, privacy: g.privacy, memberCount: g.member_count,
      description: g.privacy === 'public' ? g.description : null,
      photoUrl: g.photo_url,
      school: g.school, club: g.club, city: g.city, region: g.region, country: g.country,
      isMember: !!membership(g.id, req.user.id),
      pendingRequest: !!db.prepare("SELECT id FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'").get(g.id, req.user.id),
    })),
  });
});

groupsRouter.post('/join-by-code', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) throw badRequest('Enter an invite code.');
  const g = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(code);
  if (!g) throw new ApiError(404, 'No group with that invite code.', 'not_found');
  joinGroup(g, req.user);
  res.json({ ok: true, groupId: g.id, name: g.name });
});

groupsRouter.post('/:id/join', (req, res) => {
  const g = getGroup(req.params.id);
  if (g.privacy !== 'public') throw new ApiError(403, 'This group is private — join with an invite code or send a join request.', 'private_group');
  joinGroup(g, req.user);
  res.json({ ok: true, groupId: g.id });
});

function joinGroup(g, user) {
  if (membership(g.id, user.id)) throw badRequest('You are already a member of this group.', 'already_member');
  db.prepare("INSERT INTO group_members (id, group_id, user_id, muted, joined_at, role) VALUES (?,?,?,0,?,'member')")
    .run(uuid(), g.id, user.id, now());
  db.prepare("UPDATE group_join_requests SET status = 'approved' WHERE group_id = ? AND user_id = ? AND status = 'pending'").run(g.id, user.id);
  postFeed(g.id, user.id, 'joined', { displayName: user.display_name });
  notifyGroup(g.id, 'New member', `${user.display_name} joined ${g.name}. 👋`, { exceptUserId: user.id });
}

groupsRouter.post('/:id/join-request', (req, res) => {
  const g = getGroup(req.params.id);
  if (membership(g.id, req.user.id)) throw badRequest('You are already a member.', 'already_member');
  if (g.privacy === 'public') { joinGroup(g, req.user); return res.json({ ok: true, joined: true }); }
  db.prepare(
    `INSERT INTO group_join_requests (id, group_id, user_id, message, status, created_at) VALUES (?,?,?,?, 'pending', ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET status = 'pending', message = excluded.message, created_at = excluded.created_at`)
    .run(uuid(), g.id, req.user.id, String(req.body?.message || '').slice(0, 300) || null, now());
  // Only admins hear about join requests.
  const admins = db.prepare(
    "SELECT user_id FROM group_members WHERE group_id = ? AND role IN ('owner','admin','moderator')").all(g.id);
  for (const a of admins) {
    db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)')
      .run(uuid(), a.user_id, 'group_activity', 'Join request', `${req.user.display_name} asked to join ${g.name}.`, now());
  }
  res.status(201).json({ ok: true, joined: false });
});

groupsRouter.get('/:id/join-requests', (req, res) => {
  requireRole(req, req.params.id, 'moderator');
  const rows = db.prepare(
    `SELECT r.*, u.display_name FROM group_join_requests r JOIN users u ON u.id = r.user_id
     WHERE r.group_id = ? AND r.status = 'pending' ORDER BY r.created_at`).all(req.params.id);
  res.json({ requests: rows.map(r => ({ id: r.id, userId: r.user_id, displayName: r.display_name, message: r.message, createdAt: r.created_at })) });
});

groupsRouter.post('/:id/join-requests/:rid', (req, res) => {
  requireRole(req, req.params.id, 'moderator');
  const r = db.prepare("SELECT * FROM group_join_requests WHERE id = ? AND group_id = ? AND status = 'pending'").get(req.params.rid, req.params.id);
  if (!r) throw new ApiError(404, 'Request not found.', 'not_found');
  const approve = !!req.body?.approve;
  db.prepare('UPDATE group_join_requests SET status = ? WHERE id = ?').run(approve ? 'approved' : 'denied', r.id);
  if (approve) {
    const g = getGroup(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
    if (u && !membership(g.id, u.id)) {
      db.prepare("INSERT INTO group_members (id, group_id, user_id, muted, joined_at, role) VALUES (?,?,?,0,?,'member')")
        .run(uuid(), g.id, u.id, now());
      postFeed(g.id, u.id, 'joined', { displayName: u.display_name });
      db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)')
        .run(uuid(), u.id, 'group_activity', 'Request approved', `You're in — welcome to ${g.name}!`, now());
    }
  }
  res.json({ ok: true });
});

/* ================================================================== */
/* routes: dashboard / settings / members                              */
/* ================================================================== */

groupsRouter.get('/mine', (req, res) => {
  const rows = db.prepare(
    `SELECT g.*, gm.role, gm.muted, (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count
     FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?`).all(req.user.id);
  res.json({
    groups: rows.map(g => ({
      id: g.id, name: g.name, memberCount: g.member_count, role: g.role,
      privacy: g.privacy, muted: !!g.muted, photoUrl: g.photo_url,
    })),
  });
});

groupsRouter.get('/badges/me', (req, res) => {
  res.json({ badges: badgesFor(req.user.id), catalog: BADGES });
});

groupsRouter.get('/:id', (req, res) => {
  const m = requireMember(req, req.params.id);
  const g = getGroup(req.params.id);
  rolloverPeriods(g.id);
  finalizeDueChallenges(g.id);

  const t = now();
  const ws = weekStartS(t);
  const totals = db.prepare(
    `SELECT COALESCE(SUM(w.total_distance_m),0) AS meters, COUNT(w.id) AS workouts,
            COALESCE(SUM(w.total_time_s),0) AS seconds
     FROM workouts w JOIN group_members gm ON gm.user_id = w.user_id
     JOIN users u ON u.id = w.user_id AND ${VOLUME_PRIVACY}
     WHERE gm.group_id = ?`).get(g.id);
  const week = db.prepare(
    `SELECT COALESCE(SUM(w.total_distance_m),0) AS meters, COUNT(w.id) AS workouts,
            COUNT(DISTINCT w.user_id) AS activeMembers
     FROM workouts w JOIN group_members gm ON gm.user_id = w.user_id
     JOIN users u ON u.id = w.user_id AND ${VOLUME_PRIVACY}
     WHERE gm.group_id = ? AND w.started_at >= ?`).get(g.id, ws);
  const staff = db.prepare(
    `SELECT u.id, u.display_name, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? AND gm.role IN ('owner','admin','moderator') ORDER BY gm.role DESC`).all(g.id);
  const memberCount = db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?').get(g.id).c;
  const activeChallenges = db.prepare("SELECT COUNT(*) c FROM group_challenges WHERE group_id = ? AND status = 'active'").get(g.id).c;
  const openGoals = db.prepare('SELECT COUNT(*) c FROM group_goals WHERE group_id = ? AND completed_at IS NULL').get(g.id).c;

  res.json({
    group: {
      id: g.id, name: g.name, description: g.description, photoUrl: g.photo_url,
      privacy: g.privacy, hideMembers: !!g.hide_members,
      inviteCode: g.invite_code, // any member may invite by sharing the code
      school: g.school, club: g.club, city: g.city, region: g.region, country: g.country,
      createdAt: g.created_at,
      owner: staff.find(s => s.role === 'owner') || null,
      staff: staff.map(s => ({ id: s.id, displayName: s.display_name, role: s.role })),
      memberCount,
    },
    myRole: m.role,
    muted: !!m.muted,
    stats: {
      totalMeters: Math.round(totals.meters),
      totalWorkouts: totals.workouts,
      totalHours: Math.round(totals.seconds / 360) / 10,
      week: { meters: Math.round(week.meters), workouts: week.workouts, activeMembers: week.activeMembers },
      activeChallenges, openGoals,
    },
    myBadges: badgesFor(req.user.id),
    feed: feedPage(g.id, req.user.id, 15),
  });
});

groupsRouter.patch('/:id', (req, res) => {
  requireRole(req, req.params.id, 'admin');
  const g = getGroup(req.params.id);
  const b = req.body || {};
  db.prepare(
    `UPDATE groups SET name = ?, description = ?, photo_url = ?, privacy = ?, hide_members = ?,
                       school = ?, club = ?, city = ?, region = ?, country = ? WHERE id = ?`)
    .run(
      String(b.name ?? g.name).trim().slice(0, 80) || g.name,
      b.description !== undefined ? (String(b.description).slice(0, 500) || null) : g.description,
      b.photoUrl !== undefined ? (String(b.photoUrl).slice(0, 500) || null) : g.photo_url,
      b.privacy !== undefined ? (b.privacy === 'public' ? 'public' : 'private') : g.privacy,
      b.hideMembers !== undefined ? (b.hideMembers ? 1 : 0) : g.hide_members,
      b.school !== undefined ? strOrNull(b.school) : g.school,
      b.club !== undefined ? strOrNull(b.club) : g.club,
      b.city !== undefined ? strOrNull(b.city) : g.city,
      b.region !== undefined ? strOrNull(b.region) : g.region,
      b.country !== undefined ? strOrNull(b.country) : g.country,
      g.id);
  res.json({ ok: true });
});

groupsRouter.post('/:id/regenerate-code', (req, res) => {
  requireRole(req, req.params.id, 'admin');
  const code = inviteCode();
  db.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').run(code, req.params.id);
  res.json({ inviteCode: code });
});

groupsRouter.get('/:id/members', (req, res) => {
  const m = requireMember(req, req.params.id);
  const g = getGroup(req.params.id);
  // Invisible member lists: regular members see only the staff.
  const staffOnly = g.hide_members && ROLE_RANK[m.role] < ROLE_RANK.moderator;
  const rows = db.prepare(
    `SELECT u.*, gm.role, gm.joined_at FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ${staffOnly ? "AND gm.role IN ('owner','admin','moderator')" : ''}
     ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, u.display_name`)
    .all(req.params.id);
  res.json({
    hiddenList: !!staffOnly,
    members: rows.map(u => ({
      id: u.id, displayName: u.display_name, role: u.role, joinedAt: u.joined_at,
      photoUrl: u.share_profile ? u.photo_url : null,
      accountType: u.account_type,
      best2kSeconds: u.share_2k_history ? u.best_2k_seconds : null,
      best2kVerified: u.share_2k_history ? !!u.best_2k_verified : null,
      badges: badgesFor(u.id),
    })),
  });
});

groupsRouter.post('/:id/members/:uid/role', (req, res) => {
  const actor = requireRole(req, req.params.id, 'admin');
  const target = membership(req.params.id, req.params.uid);
  if (!target) throw new ApiError(404, 'Not a member of this group.', 'not_found');
  const role = String(req.body?.role || '');
  if (!['member', 'moderator', 'admin', 'owner'].includes(role)) throw badRequest('Role must be member, moderator, admin, or owner.');
  if (target.role === 'owner') throw badRequest('The owner\'s role can only change by transferring ownership.');
  if (role === 'owner') {
    // Ownership transfer: only the current owner may do it; they become admin.
    if (actor.role !== 'owner') throw new ApiError(403, 'Only the owner can transfer ownership.', 'forbidden');
    db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(req.params.id, req.user.id);
  }
  db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(role, req.params.id, req.params.uid);
  res.json({ ok: true });
});

groupsRouter.delete('/:id/members/:uid', (req, res) => {
  const actor = requireRole(req, req.params.id, 'moderator');
  const target = membership(req.params.id, req.params.uid);
  if (!target) throw new ApiError(404, 'Not a member of this group.', 'not_found');
  if (ROLE_RANK[target.role] >= ROLE_RANK[actor.role]) {
    throw new ApiError(403, 'You can only remove members below your own role.', 'forbidden');
  }
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.params.uid);
  res.json({ ok: true });
});

groupsRouter.post('/:id/leave', (req, res) => {
  const m = requireMember(req, req.params.id);
  const others = db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ? AND user_id != ?').get(req.params.id, req.user.id).c;
  if (m.role === 'owner' && others > 0) {
    throw badRequest('Transfer ownership to another member before leaving (Members tab → promote to owner).', 'owner_must_transfer');
  }
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (others === 0) db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id); // last member out → group dissolves
  res.json({ ok: true });
});

groupsRouter.post('/:id/mute', (req, res) => {
  requireMember(req, req.params.id);
  db.prepare('UPDATE group_members SET muted = ? WHERE group_id = ? AND user_id = ?')
    .run(req.body?.muted ? 1 : 0, req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ================================================================== */
/* routes: leaderboards + weekly history                               */
/* ================================================================== */

groupsRouter.get('/:id/leaderboard/:kind', (req, res) => {
  requireMember(req, req.params.id);
  const kind = String(req.params.kind);
  const range = ['all', 'season', '12mo'].includes(req.query.range) ? req.query.range : 'all';
  res.json({ kind, range, kinds: LEADERBOARD_KINDS, entries: computeLeaderboard(req.params.id, kind, range) });
});

groupsRouter.get('/:id/weeks', (req, res) => {
  requireMember(req, req.params.id);
  rolloverPeriods(req.params.id);
  const rows = db.prepare(
    `SELECT week_key, user_id, display_name, meters, workouts, rank FROM group_week_history
     WHERE group_id = ? AND week_key LIKE '%-W%' ORDER BY week_key DESC, rank ASC LIMIT 400`).all(req.params.id);
  const weeks = new Map();
  for (const r of rows) {
    if (!weeks.has(r.week_key)) weeks.set(r.week_key, []);
    weeks.get(r.week_key).push({ rank: r.rank, userId: r.user_id, displayName: r.display_name, meters: Math.round(r.meters), workouts: r.workouts });
  }
  res.json({ weeks: [...weeks.entries()].map(([weekKey, standings]) => ({ weekKey, standings })) });
});

/* ================================================================== */
/* routes: feed (likes + comments)                                     */
/* ================================================================== */

function feedPage(groupId, viewerId, limit = 30, beforeS = null) {
  const params = [viewerId, groupId];
  let where = '';
  if (beforeS) { where = 'AND f.created_at < ?'; params.push(beforeS); }
  params.push(limit);
  const rows = db.prepare(
    `SELECT f.*,
            (SELECT COUNT(*) FROM group_feed_likes l WHERE l.feed_id = f.id) AS likes,
            (SELECT COUNT(*) FROM group_feed_likes l WHERE l.feed_id = f.id AND l.user_id = ?) AS likedByMe,
            (SELECT COUNT(*) FROM group_feed_comments c WHERE c.feed_id = f.id) AS comments
     FROM group_feed f WHERE f.group_id = ? ${where} ORDER BY f.created_at DESC LIMIT ?`).all(...params);
  return rows.map(f => ({
    id: f.id, userId: f.user_id, type: f.type, payload: safeJson(f.payload_json),
    createdAt: f.created_at, likes: f.likes, likedByMe: !!f.likedByMe, comments: f.comments,
  }));
}

groupsRouter.get('/:id/feed', (req, res) => {
  requireMember(req, req.params.id);
  const before = Number(req.query.before) || null;
  res.json({ feed: feedPage(req.params.id, req.user.id, 30, before) });
});

groupsRouter.post('/:id/feed/:fid/like', (req, res) => {
  requireMember(req, req.params.id);
  const f = db.prepare('SELECT id FROM group_feed WHERE id = ? AND group_id = ?').get(req.params.fid, req.params.id);
  if (!f) throw new ApiError(404, 'Feed item not found.', 'not_found');
  const existing = db.prepare('SELECT id FROM group_feed_likes WHERE feed_id = ? AND user_id = ?').get(f.id, req.user.id);
  if (existing) db.prepare('DELETE FROM group_feed_likes WHERE id = ?').run(existing.id);
  else db.prepare('INSERT INTO group_feed_likes (id, feed_id, user_id, created_at) VALUES (?,?,?,?)').run(uuid(), f.id, req.user.id, now());
  const likes = db.prepare('SELECT COUNT(*) c FROM group_feed_likes WHERE feed_id = ?').get(f.id).c;
  res.json({ ok: true, liked: !existing, likes });
});

groupsRouter.get('/:id/feed/:fid/comments', (req, res) => {
  requireMember(req, req.params.id);
  const rows = db.prepare(
    `SELECT c.*, u.display_name FROM group_feed_comments c JOIN users u ON u.id = c.user_id
     WHERE c.feed_id = ? ORDER BY c.created_at LIMIT 100`).all(req.params.fid);
  res.json({ comments: rows.map(c => ({ id: c.id, userId: c.user_id, displayName: c.display_name, body: c.body, createdAt: c.created_at })) });
});

groupsRouter.post('/:id/feed/:fid/comments', (req, res) => {
  requireMember(req, req.params.id);
  const f = db.prepare('SELECT * FROM group_feed WHERE id = ? AND group_id = ?').get(req.params.fid, req.params.id);
  if (!f) throw new ApiError(404, 'Feed item not found.', 'not_found');
  const body = String(req.body?.body || '').trim().slice(0, 500);
  if (!body) throw badRequest('Comment cannot be empty.');
  db.prepare('INSERT INTO group_feed_comments (id, feed_id, user_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), f.id, req.user.id, body, now());
  res.status(201).json({ ok: true });
});

/* ================================================================== */
/* routes: challenges                                                  */
/* ================================================================== */

groupsRouter.get('/:id/challenges', (req, res) => {
  requireMember(req, req.params.id);
  finalizeDueChallenges(req.params.id);
  const rows = db.prepare('SELECT * FROM group_challenges WHERE group_id = ? ORDER BY status = \'finished\', ends_at DESC LIMIT 30').all(req.params.id);
  res.json({
    challenges: rows.map(c => {
      const live = c.status === 'active' ? challengeStandings(c) : null;
      return {
        id: c.id, name: c.name, description: c.description, metric: c.metric,
        target: c.target, startsAt: c.starts_at, endsAt: c.ends_at, status: c.status,
        standings: live ? live.entries.slice(0, 20) : safeJson(c.winners_json)?.winners || [],
        teamTotal: live ? live.teamTotal : safeJson(c.winners_json)?.teamTotal ?? null,
        winners: c.status === 'finished' ? safeJson(c.winners_json)?.winners || [] : null,
      };
    }),
  });
});

groupsRouter.post('/:id/challenges', (req, res) => {
  requireRole(req, req.params.id, 'moderator');
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw badRequest('Challenge needs a name.');
  if (!CHALLENGE_METRICS.includes(b.metric)) throw badRequest(`Metric must be one of: ${CHALLENGE_METRICS.join(', ')}`);
  const startsAt = Number(b.startsAt) || now();
  const endsAt = Number(b.endsAt) || startsAt + 7 * DAY;
  if (endsAt <= startsAt) throw badRequest('The challenge must end after it starts.');
  if (endsAt - startsAt > 366 * DAY) throw badRequest('Challenges can run for at most a year.');
  const id = uuid();
  db.prepare(
    `INSERT INTO group_challenges (id, group_id, creator_id, name, description, metric, target, starts_at, ends_at, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'active',?)`)
    .run(id, req.params.id, req.user.id, name, String(b.description || '').slice(0, 500) || null,
      b.metric, Number(b.target) || null, startsAt, endsAt, now());
  postFeed(req.params.id, req.user.id, 'challenge_started', { name, metric: b.metric, endsAt });
  notifyGroup(req.params.id, 'New challenge', `"${name}" just started — get rowing!`, { exceptUserId: req.user.id });
  res.status(201).json({ challengeId: id });
});

/* ================================================================== */
/* routes: team goals                                                  */
/* ================================================================== */

groupsRouter.get('/:id/goals', (req, res) => {
  requireMember(req, req.params.id);
  const rows = db.prepare('SELECT * FROM group_goals WHERE group_id = ? ORDER BY completed_at IS NOT NULL, created_at DESC LIMIT 20').all(req.params.id);
  res.json({
    goals: rows.map(goal => {
      const value = goalProgressValue(req.params.id, goal);
      return {
        id: goal.id, name: goal.name, metric: goal.metric, target: goal.target,
        startsAt: goal.starts_at, completedAt: goal.completed_at,
        current: Math.round(value * 10) / 10,
        progressPct: Math.min(100, Math.round((value / goal.target) * 100)),
      };
    }),
  });
});

groupsRouter.post('/:id/goals', (req, res) => {
  requireRole(req, req.params.id, 'moderator');
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw badRequest('Goal needs a name.');
  if (!['meters', 'workouts', 'hours'].includes(b.metric)) throw badRequest('Metric must be meters, workouts, or hours.');
  const target = Number(b.target);
  if (!Number.isFinite(target) || target <= 0) throw badRequest('Goal needs a positive target.');
  const id = uuid();
  db.prepare('INSERT INTO group_goals (id, group_id, creator_id, name, metric, target, starts_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, req.user.id, name, b.metric, target, Number(b.startsAt) || now(), now());
  postFeed(req.params.id, req.user.id, 'goal_started', { name, metric: b.metric, target });
  res.status(201).json({ goalId: id });
});

groupsRouter.delete('/:id/goals/:gid', (req, res) => {
  requireRole(req, req.params.id, 'admin');
  db.prepare('DELETE FROM group_goals WHERE id = ? AND group_id = ?').run(req.params.gid, req.params.id);
  res.json({ ok: true });
});

/* ================================================================== */
/* routes: chat                                                        */
/* ================================================================== */

const MAX_IMAGE_DATA = 200 * 1024; // small inline images only

function presentMessage(m, viewerId) {
  const reactions = db.prepare(
    'SELECT emoji, COUNT(*) AS n, SUM(user_id = ?) AS mine FROM group_message_reactions WHERE message_id = ? GROUP BY emoji')
    .all(viewerId, m.id);
  return {
    id: m.id, userId: m.user_id, displayName: m.display_name, kind: m.kind,
    body: m.deleted ? null : m.body,
    imageData: m.deleted ? null : m.image_data,
    workout: m.workout_id && !m.deleted ? sharedWorkout(m.workout_id) : null,
    pinned: !!m.pinned, deleted: !!m.deleted, createdAt: m.created_at,
    reactions: reactions.map(r => ({ emoji: r.emoji, count: r.n, mine: !!r.mine })),
  };
}

function sharedWorkout(workoutId) {
  const w = db.prepare('SELECT id, total_distance_m, total_time_s, avg_split_s, machine_type FROM workouts WHERE id = ?').get(workoutId);
  return w ? { id: w.id, distanceM: w.total_distance_m, timeS: w.total_time_s, avgSplitText: fmtSplit(w.avg_split_s), machineType: w.machine_type } : null;
}

groupsRouter.get('/:id/messages', (req, res) => {
  requireMember(req, req.params.id);
  const before = Number(req.query.before) || null;
  const params = [req.params.id];
  let where = '';
  if (before) { where = 'AND m.created_at < ?'; params.push(before); }
  const rows = db.prepare(
    `SELECT m.*, u.display_name FROM group_messages m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? ${where} ORDER BY m.created_at DESC LIMIT 50`).all(...params);
  const pinned = db.prepare(
    `SELECT m.*, u.display_name FROM group_messages m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? AND m.pinned = 1 AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 5`).all(req.params.id);
  res.json({
    messages: rows.reverse().map(m => presentMessage(m, req.user.id)),
    pinned: pinned.map(m => presentMessage(m, req.user.id)),
  });
});

groupsRouter.post('/:id/messages', (req, res) => {
  const m = requireMember(req, req.params.id);
  const b = req.body || {};
  let kind = ['text', 'announcement', 'image', 'workout'].includes(b.kind) ? b.kind : 'text';
  if (kind === 'announcement' && ROLE_RANK[m.role] < ROLE_RANK.moderator) {
    throw new ApiError(403, 'Only moderators and admins can post announcements.', 'forbidden');
  }
  const body = String(b.body || '').trim().slice(0, 2000);
  let imageData = null;
  if (kind === 'image') {
    imageData = String(b.imageData || '');
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(imageData)) throw badRequest('Images must be small inline data-URLs (png/jpeg/webp/gif).');
    if (imageData.length > MAX_IMAGE_DATA) throw badRequest('Image too large — keep shared images under ~150 KB.');
  }
  let workoutId = null;
  if (kind === 'workout') {
    // You can only share YOUR OWN workouts into the chat.
    const w = db.prepare('SELECT id FROM workouts WHERE id = ? AND user_id = ?').get(String(b.workoutId || ''), req.user.id);
    if (!w) throw badRequest('Workout not found in your history.');
    workoutId = w.id;
  }
  if (!body && !imageData && !workoutId) throw badRequest('Message is empty.');

  const id = uuid();
  db.prepare(
    'INSERT INTO group_messages (id, group_id, user_id, kind, body, image_data, workout_id, pinned, deleted, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)')
    .run(id, req.params.id, req.user.id, kind, body || null, imageData, workoutId, now());
  const row = db.prepare(
    'SELECT m.*, u.display_name FROM group_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?').get(id);
  const message = presentMessage(row, req.user.id);
  publishToChannel(`group:${req.params.id}`, { type: 'group_message', channel: `group:${req.params.id}`, message });
  if (kind === 'announcement') {
    postFeed(req.params.id, req.user.id, 'announcement', { displayName: req.user.display_name, body: body.slice(0, 200) });
    notifyGroup(req.params.id, 'Group announcement', body.slice(0, 300), { exceptUserId: req.user.id });
  }
  res.status(201).json({ message });
});

groupsRouter.post('/:id/messages/:mid/react', (req, res) => {
  requireMember(req, req.params.id);
  const msg = db.prepare('SELECT id FROM group_messages WHERE id = ? AND group_id = ? AND deleted = 0').get(req.params.mid, req.params.id);
  if (!msg) throw new ApiError(404, 'Message not found.', 'not_found');
  const emoji = String(req.body?.emoji || '').slice(0, 8);
  if (!emoji) throw badRequest('Pick an emoji.');
  const existing = db.prepare('SELECT id FROM group_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(msg.id, req.user.id, emoji);
  if (existing) db.prepare('DELETE FROM group_message_reactions WHERE id = ?').run(existing.id);
  else db.prepare('INSERT INTO group_message_reactions (id, message_id, user_id, emoji, created_at) VALUES (?,?,?,?,?)').run(uuid(), msg.id, req.user.id, emoji, now());
  publishToChannel(`group:${req.params.id}`, { type: 'group_reaction', channel: `group:${req.params.id}`, messageId: msg.id });
  res.json({ ok: true, reacted: !existing });
});

groupsRouter.post('/:id/messages/:mid/pin', (req, res) => {
  requireRole(req, req.params.id, 'moderator');
  const msg = db.prepare('SELECT * FROM group_messages WHERE id = ? AND group_id = ?').get(req.params.mid, req.params.id);
  if (!msg) throw new ApiError(404, 'Message not found.', 'not_found');
  db.prepare('UPDATE group_messages SET pinned = ? WHERE id = ?').run(msg.pinned ? 0 : 1, msg.id);
  res.json({ ok: true, pinned: !msg.pinned });
});

groupsRouter.delete('/:id/messages/:mid', (req, res) => {
  const m = requireMember(req, req.params.id);
  const msg = db.prepare('SELECT * FROM group_messages WHERE id = ? AND group_id = ?').get(req.params.mid, req.params.id);
  if (!msg) throw new ApiError(404, 'Message not found.', 'not_found');
  if (msg.user_id !== req.user.id && ROLE_RANK[m.role] < ROLE_RANK.moderator) {
    throw new ApiError(403, 'You can delete your own messages; moderators can delete any.', 'forbidden');
  }
  db.prepare('UPDATE group_messages SET deleted = 1, body = NULL, image_data = NULL, pinned = 0 WHERE id = ?').run(msg.id);
  publishToChannel(`group:${req.params.id}`, { type: 'group_message_deleted', channel: `group:${req.params.id}`, messageId: msg.id });
  res.json({ ok: true });
});

/* ================================================================== */
/* routes: analytics                                                   */
/* ================================================================== */

groupsRouter.get('/:id/analytics', (req, res) => {
  requireMember(req, req.params.id);
  const t = now();
  const gid = req.params.id;
  const agg = (sinceS) => db.prepare(
    `SELECT COALESCE(SUM(w.total_distance_m),0) AS meters, COUNT(w.id) AS workouts,
            COALESCE(SUM(w.total_time_s),0) AS seconds, COUNT(DISTINCT w.user_id) AS activeMembers
     FROM workouts w JOIN group_members gm ON gm.user_id = w.user_id
     JOIN users u ON u.id = w.user_id AND ${VOLUME_PRIVACY}
     WHERE gm.group_id = ? ${sinceS ? 'AND w.started_at >= ?' : ''}`)
    .get(...(sinceS ? [gid, sinceS] : [gid]));
  const total = agg(null), week = agg(weekStartS(t)), month = agg(monthStartS(t));
  const memberCount = db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?').get(gid).c;

  // Activity heatmap: workouts + meters per day, last 12 weeks.
  const heatmap = db.prepare(
    `SELECT date(w.started_at,'unixepoch') AS d, COUNT(*) AS workouts, ROUND(SUM(w.total_distance_m)) AS meters
     FROM workouts w JOIN group_members gm ON gm.user_id = w.user_id
     JOIN users u ON u.id = w.user_id AND ${VOLUME_PRIVACY}
     WHERE gm.group_id = ? AND w.started_at >= ? GROUP BY d ORDER BY d`).all(gid, t - 84 * DAY);

  // Growth: members joined + meters rowed per ISO week, last 8 weeks.
  const growth = [];
  for (let i = 7; i >= 0; i--) {
    const start = weekStartS(t) - i * 7 * DAY;
    const end = start + 7 * DAY;
    growth.push({
      weekKey: isoWeekKey(start),
      newMembers: db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ? AND joined_at >= ? AND joined_at < ?').get(gid, start, end).c,
      meters: Math.round(db.prepare(
        `SELECT COALESCE(SUM(w.total_distance_m),0) m FROM workouts w
         JOIN group_members gm ON gm.user_id = w.user_id
         JOIN users u ON u.id = w.user_id AND ${VOLUME_PRIVACY}
         WHERE gm.group_id = ? AND w.started_at >= ? AND w.started_at < ?`).get(gid, start, end).m),
    });
  }

  res.json({
    analytics: {
      memberCount,
      totalMeters: Math.round(total.meters),
      totalWorkouts: total.workouts,
      totalHours: Math.round(total.seconds / 360) / 10,
      weeklyMeters: Math.round(week.meters),
      monthlyMeters: Math.round(month.meters),
      activeMembers7d: db.prepare(
        `SELECT COUNT(DISTINCT w.user_id) c FROM workouts w
         JOIN group_members gm ON gm.user_id = w.user_id WHERE gm.group_id = ? AND w.started_at >= ?`).get(gid, t - 7 * DAY).c,
      activeMembers30d: db.prepare(
        `SELECT COUNT(DISTINCT w.user_id) c FROM workouts w
         JOIN group_members gm ON gm.user_id = w.user_id WHERE gm.group_id = ? AND w.started_at >= ?`).get(gid, t - 30 * DAY).c,
      avgWorkoutsPerMember: memberCount ? Math.round((total.workouts / memberCount) * 10) / 10 : 0,
      avgWeeklyVolumePerActiveMember: week.activeMembers ? Math.round(week.meters / week.activeMembers) : 0,
      heatmap,
      growth,
    },
  });
});

/* -------------------- club dashboard (vision #9) --------------------
   A club-level view for a group: total meters, most-active athletes, this-week
   participation rate, and club records (test pieces among sharing members). */
groupsRouter.get('/:id/club', (req, res) => {
  requireMember(req, req.params.id);
  const gid = req.params.id, t = now();
  const memberCount = db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?').get(gid).c;

  const totalMeters = Math.round(db.prepare(
    `SELECT COALESCE(SUM(w.total_distance_m),0) m FROM workouts w
     JOIN group_members gm ON gm.user_id = w.user_id
     JOIN users u ON u.id = w.user_id AND ${VOLUME_PRIVACY} WHERE gm.group_id = ?`).get(gid).m);

  const mostActive = db.prepare(
    `SELECT u.display_name AS name, ROUND(SUM(w.total_distance_m)) AS meters, COUNT(*) AS workouts
     FROM workouts w JOIN group_members gm ON gm.user_id = w.user_id
     JOIN users u ON u.id = w.user_id AND ${VOLUME_PRIVACY}
     WHERE gm.group_id = ? AND w.started_at >= ? GROUP BY w.user_id ORDER BY meters DESC LIMIT 10`).all(gid, t - 30 * DAY);

  const activeThisWeek = db.prepare(
    `SELECT COUNT(DISTINCT w.user_id) c FROM workouts w JOIN group_members gm ON gm.user_id = w.user_id
     WHERE gm.group_id = ? AND w.started_at >= ?`).get(gid, weekStartS(t)).c;

  // Club records: best test-piece times among members who share their history.
  const TESTS = {
    best2k: "json_extract(w.workout_plan_json,'$.type')='distance' AND json_extract(w.workout_plan_json,'$.distanceM')=2000 AND w.total_distance_m >= 2000",
    best5k: "json_extract(w.workout_plan_json,'$.type')='distance' AND json_extract(w.workout_plan_json,'$.distanceM')=5000 AND w.total_distance_m >= 5000",
    best6k: "json_extract(w.workout_plan_json,'$.type')='distance' AND json_extract(w.workout_plan_json,'$.distanceM')=6000 AND w.total_distance_m >= 6000",
  };
  const record = (sql) => db.prepare(
    `SELECT u.display_name AS name, w.total_time_s AS timeS FROM workouts w
     JOIN group_members gm ON gm.user_id = w.user_id
     JOIN users u ON u.id = w.user_id AND u.share_2k_history = 1
     WHERE gm.group_id = ? AND ${sql} AND w.total_time_s > 0 ORDER BY w.total_time_s ASC LIMIT 1`).get(gid);

  res.json({
    club: {
      memberCount,
      totalMeters,
      activeThisWeek,
      participationRatePct: memberCount ? Math.round((activeThisWeek / memberCount) * 100) : 0,
      mostActive: mostActive.map(m => ({ name: m.name, meters: m.meters, workouts: m.workouts })),
      records: {
        best2k: record(TESTS.best2k) || null,
        best5k: record(TESTS.best5k) || null,
        best6k: record(TESTS.best6k) || null,
      },
    },
  });
});

/* -------------------- crew compatibility (vision #4) --------------------
   A coaching aid — NOT a ranking of worth. Compares members' training
   characteristics (typical stroke rate, weekly volume, consistency, boat
   class) among those who share their workouts, and suggests pairs whose
   profiles are closest (similar rate + volume → likely to train well together). */
groupsRouter.get('/:id/crew-compatibility', (req, res) => {
  requireMember(req, req.params.id);
  const gid = req.params.id, t = now();
  const rows = db.prepare(
    `SELECT u.id, u.display_name AS name, u.boat_class AS boatClass,
            AVG(w.avg_stroke_rate) AS rate,
            SUM(w.total_distance_m) AS meters90,
            COUNT(DISTINCT date(w.started_at,'unixepoch')) AS trainingDays
     FROM group_members gm JOIN users u ON u.id = gm.user_id AND ${VOLUME_PRIVACY}
     LEFT JOIN workouts w ON w.user_id = u.id AND w.started_at >= ?
     WHERE gm.group_id = ? GROUP BY u.id`).all(t - 90 * DAY, gid);

  const members = rows.filter(r => r.meters90 > 0).map(r => ({
    id: r.id, name: r.name, boatClass: r.boatClass || null,
    avgStrokeRate: r.rate ? Math.round(r.rate) : null,
    weeklyMeters: Math.round((r.meters90 || 0) / 13),
    consistencyPct: Math.min(100, Math.round((r.trainingDays / 90) * 100 * 3)), // trained days as % of a ~3x/wk cadence
  }));

  // Suggest pairs by similarity of stroke rate + weekly volume (normalised).
  const pairs = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      if (a.avgStrokeRate == null || b.avgStrokeRate == null) continue;
      const rateDiff = Math.abs(a.avgStrokeRate - b.avgStrokeRate) / 40;         // ~0..1
      const volDiff = Math.abs(a.weeklyMeters - b.weeklyMeters) / Math.max(a.weeklyMeters, b.weeklyMeters, 1);
      const score = Math.round((1 - (rateDiff * 0.6 + volDiff * 0.4)) * 100);
      pairs.push({ a: a.name, b: b.name, score, sameBoatClass: !!(a.boatClass && a.boatClass === b.boatClass) });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  res.json({
    crew: {
      members,
      suggestedPairs: pairs.slice(0, 8),
      note: 'A coaching aid based on training style, not a measure of ability. Only members who share their workouts are included.',
    },
  });
});
