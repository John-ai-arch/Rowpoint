// Developer / product analytics — aggregate-only, no personally identifying
// data and no per-user rows ever leave this module. It is deliberately separate
// from the research pipeline (§5.2): research is opt-in and pseudonymous;
// this is operational product telemetry derived from data the app already
// stores (last_active_at, workouts, auth_events, health_events, memberships).
//
// Everything here is a COUNT/AVG aggregate. Device/browser/country breakdowns
// are intentionally omitted until an anonymized, consent-respecting capture
// layer exists — we do not fabricate metrics we don't measure.
import { db } from './db.js';
import { now } from './util.js';

const DAY = 86400;

function scalar(sql, ...params) {
  return db.prepare(sql).get(...params) ?? {};
}
function count(sql, ...params) {
  return scalar(sql, ...params).c || 0;
}

export function developerAnalytics() {
  const t = now();
  const totalUsers = count('SELECT COUNT(*) c FROM users');
  const verifiedUsers = count('SELECT COUNT(*) c FROM users WHERE email_verified = 1');

  // Active users by recency of last_active_at (updated on every authed request).
  const activeSince = (secs) => count('SELECT COUNT(*) c FROM users WHERE last_active_at >= ?', t - secs);
  const dau = activeSince(DAY);
  const wau = activeSince(7 * DAY);
  const mau = activeSince(30 * DAY);

  // Signups per day over the last 30 days (dense-ish; only non-zero days).
  const signupsByDay = db.prepare(
    `SELECT date(created_at,'unixepoch') AS day, COUNT(*) AS n
     FROM users WHERE created_at >= ? GROUP BY day ORDER BY day`).all(t - 30 * DAY);

  // Classic returning-user retention: of users who signed up 8–30 days ago,
  // what share were active in the last 7 days?
  const cohort = count('SELECT COUNT(*) c FROM users WHERE created_at BETWEEN ? AND ?', t - 30 * DAY, t - 8 * DAY);
  const cohortRetained = count(
    'SELECT COUNT(*) c FROM users WHERE created_at BETWEEN ? AND ? AND last_active_at >= ?',
    t - 30 * DAY, t - 8 * DAY, t - 7 * DAY);
  const retention7of30 = cohort ? Math.round((cohortRetained / cohort) * 1000) / 10 : null;

  // Workout volume + averages.
  const totalWorkouts = count('SELECT COUNT(*) c FROM workouts');
  const workouts7d = count('SELECT COUNT(*) c FROM workouts WHERE created_at >= ?', t - 7 * DAY);
  const workouts30d = count('SELECT COUNT(*) c FROM workouts WHERE created_at >= ?', t - 30 * DAY);
  const usersWithWorkout = count('SELECT COUNT(DISTINCT user_id) c FROM workouts');
  const avgWorkoutsPerActiveUser = usersWithWorkout ? Math.round((totalWorkouts / usersWithWorkout) * 10) / 10 : 0;
  const avgWorkoutsPerWeek = usersWithWorkout ? Math.round((workouts7d / usersWithWorkout) * 100) / 100 : 0;
  const avgWorkoutDurationS = Math.round(scalar('SELECT AVG(total_time_s) v FROM workouts').v || 0);

  // Machine / workout-type mix + coach-assigned vs self-directed.
  const machineMix = db.prepare(
    "SELECT COALESCE(machine_type,'unknown') AS type, COUNT(*) AS n FROM workouts GROUP BY type ORDER BY n DESC").all();
  const assigned = count('SELECT COUNT(*) c FROM workouts WHERE assigned_by_coach_id IS NOT NULL');
  const selfDirected = totalWorkouts - assigned;

  // AI usage + adherence.
  const aiSuggestions = count('SELECT COUNT(*) c FROM ai_suggestions');
  const aiFollowed = count('SELECT COUNT(*) c FROM ai_suggestions WHERE followed = 1');
  const usersUsingAi = count('SELECT COUNT(DISTINCT user_id) c FROM ai_suggestions');
  const aiAdherence = aiSuggestions ? Math.round((aiFollowed / aiSuggestions) * 1000) / 10 : null;

  // Feature adoption: share of users who have engaged each surface at least once.
  const pct = (n) => (totalUsers ? Math.round((n / totalUsers) * 1000) / 10 : 0);
  const featureAdoption = {
    loggedWorkout: pct(usersWithWorkout),
    joinedTeam: pct(count('SELECT COUNT(DISTINCT user_id) c FROM team_members')),
    joinedGroup: pct(count('SELECT COUNT(DISTINCT user_id) c FROM group_members')),
    loggedWellness: pct(count('SELECT COUNT(DISTINCT user_id) c FROM wellness_checkins')),
    usedAiCoach: pct(usersUsingAi),
    madeConnection: pct(count("SELECT COUNT(DISTINCT requester_id) c FROM connections WHERE status = 'accepted'")),
    earnedAchievement: pct(count('SELECT COUNT(DISTINCT user_id) c FROM user_achievements')),
  };

  // Signup → verification funnel (last 30 days, from the security event log).
  const signups30d = count("SELECT COUNT(*) c FROM auth_events WHERE kind = 'signup' AND created_at >= ?", t - 30 * DAY);
  const verifies30d = count("SELECT COUNT(*) c FROM auth_events WHERE kind = 'verify' AND created_at >= ?", t - 30 * DAY);
  const verificationRate = signups30d ? Math.round((verifies30d / signups30d) * 1000) / 10 : null;

  // Reliability signals (last 30 days) from health_events. We record BLE/HR and
  // sync ERRORS, not successes, so we surface error volume against the workout
  // volume it competed with rather than inventing a success-rate denominator.
  const errKind = (k) => count('SELECT COUNT(*) c FROM health_events WHERE kind = ? AND created_at >= ?', k, t - 30 * DAY);
  const reliability = {
    workouts30d,
    bleErrors30d: errKind('ble_error'),
    syncFailures30d: errKind('sync_failure'),
    clientCrashes30d: errKind('crash'),
    apiErrors30d: errKind('api_error'),
    backupFailures30d: errKind('backup_failure'),
  };

  return {
    generatedAt: t,
    users: { total: totalUsers, verified: verifiedUsers, dau, wau, mau, stickiness: mau ? Math.round((dau / mau) * 1000) / 10 : null },
    growth: { signupsByDay, retention7of30Pct: retention7of30, cohortSize: cohort },
    engagement: { totalWorkouts, workouts7d, workouts30d, avgWorkoutsPerActiveUser, avgWorkoutsPerWeek, avgWorkoutDurationS },
    workoutMix: { machine: machineMix, assigned, selfDirected },
    ai: { suggestions: aiSuggestions, followed: aiFollowed, adherencePct: aiAdherence, usersUsingAi },
    featureAdoption,
    funnel: { signups30d, verifies30d, verificationRatePct: verificationRate },
    reliability,
    notes: 'Aggregate metrics only; no PII. Device/browser/country breakdowns are not collected.',
  };
}
