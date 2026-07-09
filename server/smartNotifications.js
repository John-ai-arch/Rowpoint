// Intelligent notifications (vision #10). Generates helpful, non-spam nudges
// from the athlete's own data and writes them into the existing notifications
// table (category 'workout_reminder', governed by the existing notif_prefs
// toggle). Every nudge is de-duplicated within a window so the same message is
// never repeated — a reminder, not a firehose. Generated lazily when the user
// opens their notifications (no cron needed).
import { db } from './db.js';
import { uuid, now, safeJson } from './util.js';
import { streaksFor, weekStartS } from './groups.js';

const DAY = 86400;

function startOfTodayS(nowS) {
  const d = new Date(nowS * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/**
 * Insert a nudge unless an identical one (same title) already exists since
 * `sinceS` — keeps it helpful, never repetitive. Returns true if inserted.
 */
function emit(user, title, body, sinceS) {
  const dupe = db.prepare(
    "SELECT 1 FROM notifications WHERE user_id = ? AND category = 'workout_reminder' AND title = ? AND created_at >= ? LIMIT 1")
    .get(user.id, title, sinceS);
  if (dupe) return false;
  db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)')
    .run(uuid(), user.id, 'workout_reminder', title, body, now());
  return true;
}

/**
 * Generate any due intelligent notifications for a user. Idempotent within its
 * de-dup windows. Returns the number created.
 */
export function refreshSmartNotifications(user, nowS = now()) {
  const prefs = safeJson(user.notif_prefs, {});
  if (prefs.workout_reminder === false) return 0; // user opted out
  const today0 = startOfTodayS(nowS);
  let created = 0;

  // 1. Weekly-goal proximity / completion.
  const ws = weekStartS(nowS);
  const week = db.prepare('SELECT COALESCE(SUM(total_distance_m),0) m, COUNT(*) n FROM workouts WHERE user_id = ? AND started_at >= ?').get(user.id, ws);
  const goal = user.goal_weekly_meters || 0;
  if (goal > 0 && week.n > 0) {
    const remaining = goal - week.m;
    if (remaining <= 0) {
      if (emit(user, 'Weekly goal reached! 🎉', `You've hit your ${Math.round(goal / 1000)} km weekly goal — brilliant work.`, ws)) created++;
    } else if (remaining <= goal * 0.25 && remaining <= 6000) {
      if (emit(user, 'Almost at your weekly goal', `You're only ${(remaining / 1000).toFixed(1)} km from your ${Math.round(goal / 1000)} km weekly goal — one row away.`, today0)) created++;
    }
  }

  // 2. Inactivity nudge (escalates by day; one per day at most).
  const last = db.prepare('SELECT MAX(started_at) a FROM workouts WHERE user_id = ?').get(user.id).a;
  if (last) {
    const days = Math.floor((nowS - last) / DAY);
    if (days >= 4) {
      if (emit(user, `It's been ${days} days`, 'A short, easy row keeps your fitness ticking over — no session is too small.', today0)) created++;
    }
  }

  // 3. Streak keep-alive (only if a streak is live and today isn't logged yet).
  const days = db.prepare("SELECT date(started_at,'unixepoch') d FROM workouts WHERE user_id = ? GROUP BY d ORDER BY d").all(user.id).map(r => r.d);
  if (days.length) {
    const streak = streaksFor(days);
    const todayISO = new Date(nowS * 1000).toISOString().slice(0, 10);
    if (streak.current >= 3 && days[days.length - 1] !== todayISO) {
      if (emit(user, `Keep your ${streak.current}-day streak alive`, `Row today to extend your ${streak.current}-day training streak.`, today0)) created++;
    }
  }

  // 4. Training-plan phase focus (once per week).
  const plan = db.prepare("SELECT weeks_json, start_date FROM training_plans WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(user.id);
  if (plan) {
    const weeks = safeJson(plan.weeks_json, []) || [];
    const startS = Math.floor(new Date(`${plan.start_date}T00:00:00Z`).getTime() / 1000);
    const idx = Math.max(0, Math.min(weeks.length - 1, Math.floor((nowS - startS) / (7 * DAY))));
    const wk = weeks[idx];
    if (wk) { if (emit(user, `This week: ${wk.phaseLabel}`, wk.focus, ws)) created++; }
  }

  return created;
}
