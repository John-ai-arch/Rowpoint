// Personal progress & gamification aggregation — read-only.
//
// This endpoint invents no new storage and changes no behavior: it reads the
// existing workouts/users tables and reuses the gamification helpers already
// living in groups.js (streaksFor, badgesFor, BADGES, weekStartS, isoWeekKey,
// dayNum). It powers the personal Progress hub (pages/progress.js).
import { Router } from 'express';
import { db } from './db.js';
import { authRequired } from './middleware.js';
import { streaksFor, badgesFor, BADGES, BADGE_ICONS, weekStartS, isoWeekKey, dayNum } from './groups.js';

export const progressRouter = Router();
progressRouter.use(authRequired);

const DAY = 86400;

// Same verified-test-piece definitions the leaderboards use (self-reported
// numbers never count — only actual logged pieces of the exact distance/time).
const TEST = {
  best2k: "json_extract(workout_plan_json,'$.type')='distance' AND json_extract(workout_plan_json,'$.distanceM')=2000 AND total_distance_m >= 2000 AND total_time_s > 0",
  best5k: "json_extract(workout_plan_json,'$.type')='distance' AND json_extract(workout_plan_json,'$.distanceM')=5000 AND total_distance_m >= 5000 AND total_time_s > 0",
  best6k: "json_extract(workout_plan_json,'$.type')='distance' AND json_extract(workout_plan_json,'$.distanceM')=6000 AND total_distance_m >= 6000 AND total_time_s > 0",
};

function monthStartS(t) {
  const d = new Date(t * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

progressRouter.get('/progress', (req, res) => {
  const uid = req.user.id;
  const t = Math.floor(Date.now() / 1000);
  const ws = weekStartS(t);
  const ms = monthStartS(t);

  const totals = db.prepare(
    `SELECT COUNT(*) AS workouts, COALESCE(SUM(total_distance_m),0) AS meters,
            COALESCE(SUM(total_time_s),0) AS seconds
     FROM workouts WHERE user_id = ?`).get(uid);

  const window = (since) => db.prepare(
    `SELECT COUNT(*) AS workouts, COALESCE(SUM(total_distance_m),0) AS meters,
            COALESCE(SUM(total_time_s),0) AS seconds
     FROM workouts WHERE user_id = ? AND started_at >= ?`).get(uid, since);
  const week = window(ws);
  const month = window(ms);

  // streaks from distinct training days
  const days = db.prepare(
    "SELECT date(started_at,'unixepoch') AS d FROM workouts WHERE user_id = ? GROUP BY d ORDER BY d").all(uid).map(r => r.d);
  const streak = streaksFor(days);

  // personal records
  const bestTime = (sql) => db.prepare(
    `SELECT total_time_s AS timeS, avg_split_s AS split, started_at AS at
     FROM workouts WHERE user_id = ? AND ${sql} ORDER BY total_time_s ASC LIMIT 1`).get(uid);
  const fastestSplit = db.prepare(
    `SELECT MIN(avg_split_s) AS split, started_at AS at FROM workouts
     WHERE user_id = ? AND avg_split_s > 0 AND total_distance_m >= 500`).get(uid);
  const longestPiece = db.prepare(
    `SELECT MAX(total_distance_m) AS meters, started_at AS at FROM workouts WHERE user_id = ?`).get(uid);
  // Smart PRs: sustained-effort and volume records beyond the test pieces.
  const best500 = db.prepare(
    `SELECT total_time_s AS timeS, started_at AS at FROM workouts
     WHERE user_id = ? AND json_extract(workout_plan_json,'$.type')='distance'
       AND json_extract(workout_plan_json,'$.distanceM')=500 AND total_time_s > 0
     ORDER BY total_time_s ASC LIMIT 1`).get(uid);
  const highestWatts = db.prepare(
    `SELECT MAX(avg_power_watts) AS watts, started_at AS at FROM workouts
     WHERE user_id = ? AND avg_power_watts > 0 AND total_distance_m >= 1000`).get(uid);
  const highestRate = db.prepare(
    `SELECT MAX(avg_stroke_rate) AS spm, started_at AS at FROM workouts
     WHERE user_id = ? AND avg_stroke_rate > 0 AND total_distance_m >= 1000`).get(uid);
  const bigWeek = db.prepare(
    `SELECT MAX(m) AS meters FROM (SELECT strftime('%Y-%W', started_at, 'unixepoch') AS wk,
       SUM(total_distance_m) AS m FROM workouts WHERE user_id = ? GROUP BY wk)`).get(uid);
  const bigMonth = db.prepare(
    `SELECT MAX(m) AS meters FROM (SELECT strftime('%Y-%m', started_at, 'unixepoch') AS mo,
       SUM(total_distance_m) AS m FROM workouts WHERE user_id = ? GROUP BY mo)`).get(uid);
  const records = {
    best2k: bestTime(TEST.best2k),
    best5k: bestTime(TEST.best5k),
    best6k: bestTime(TEST.best6k),
    best500: best500?.timeS ? { timeS: best500.timeS, at: best500.at } : null,
    fastestSplit: fastestSplit?.split ? { split: fastestSplit.split, at: fastestSplit.at } : null,
    longestPiece: longestPiece?.meters ? { meters: Math.round(longestPiece.meters), at: longestPiece.at } : null,
    highestWatts: highestWatts?.watts ? { watts: Math.round(highestWatts.watts), at: highestWatts.at } : null,
    highestStrokeRate: highestRate?.spm ? { spm: Math.round(highestRate.spm), at: highestRate.at } : null,
    biggestWeekMeters: bigWeek?.meters ? Math.round(bigWeek.meters) : null,
    biggestMonthMeters: bigMonth?.meters ? Math.round(bigMonth.meters) : null,
    longestStreakDays: streak.longest || 0,
  };

  // 12-week consistency calendar: meters per calendar day (for heatmap levels)
  const calRows = db.prepare(
    `SELECT date(started_at,'unixepoch') AS d, ROUND(SUM(total_distance_m)) AS meters
     FROM workouts WHERE user_id = ? AND started_at >= ? GROUP BY d`).all(uid, t - 84 * DAY);
  const calMap = Object.fromEntries(calRows.map(r => [r.d, r.meters]));
  const calendar = [];
  const todayNum = Math.floor(t / DAY);
  for (let i = 83; i >= 0; i--) {
    const dn = todayNum - i;
    const iso = new Date(dn * DAY * 1000).toISOString().slice(0, 10);
    calendar.push({ date: iso, meters: calMap[iso] || 0 });
  }

  // recent improvement: this-week vs the equivalent prior week
  const prevWeek = window(ws - 7 * DAY);
  const prevWeekOnly = db.prepare(
    `SELECT COALESCE(SUM(total_distance_m),0) AS meters, COUNT(*) AS workouts
     FROM workouts WHERE user_id = ? AND started_at >= ? AND started_at < ?`).get(uid, ws - 7 * DAY, ws);

  // distance-per-workout trend (last 12 sessions, oldest→newest)
  const trend = db.prepare(
    `SELECT started_at, total_distance_m FROM workouts WHERE user_id = ?
     ORDER BY started_at DESC LIMIT 12`).all(uid).reverse()
    .map(w => ({ at: w.started_at, meters: Math.round(w.total_distance_m || 0) }));

  // goals — reuse the user's existing stored goal fields; derive a weekly
  // distance target when none is set (weekly minutes → meters at ~2:15/500m,
  // a gentle default) so the ring always has a target to fill.
  const goalSessions = req.user.goal_weekly_sessions || null;
  const goalMinutes = req.user.goal_weekly_minutes || null;
  const goalMeters = req.user.goal_weekly_meters
    || (goalMinutes ? Math.round(goalMinutes * 60 / 135 * 500) : 10000);

  // badges — full catalog with unlocked/locked state
  const unlocked = badgesFor(uid);
  const unlockedMap = Object.fromEntries(unlocked.map(b => [b.badge, b.achieved_at]));
  const badges = Object.keys(BADGES).map(key => ({
    badge: key,
    icon: BADGE_ICONS[key] || '🏅',
    unlocked: key in unlockedMap,
    achievedAt: unlockedMap[key] || null,
  }));

  res.json({
    progress: {
      totals: {
        meters: Math.round(totals.meters),
        workouts: totals.workouts,
        hours: Math.round(totals.seconds / 360) / 10,
      },
      week: { meters: Math.round(week.meters), workouts: week.workouts, minutes: Math.round(week.seconds / 60) },
      month: { meters: Math.round(month.meters), workouts: month.workouts, hours: Math.round(month.seconds / 360) / 10 },
      streak,
      records,
      calendar,
      trend,
      goals: { weeklyMeters: goalMeters, weeklySessions: goalSessions, weeklyMinutes: goalMinutes },
      improvement: {
        metersDelta: Math.round(week.meters - prevWeekOnly.meters),
        workoutsDelta: week.workouts - prevWeekOnly.workouts,
        hadPriorWeek: prevWeekOnly.workouts > 0,
      },
      badges,
      badgeCount: { unlocked: unlocked.length, total: Object.keys(BADGES).length },
    },
  });
});
