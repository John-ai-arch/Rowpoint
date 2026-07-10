// Profile, settings (units / privacy / notifications / research toggle),
// data export (§14), and full in-app account deletion (§10.1 / §14).
import { Router } from 'express';
import { db, inTransaction } from './db.js';
import { config } from './config.js';
import { authRequired } from './middleware.js';
import { publicUser } from './auth.js';
import { badRequest, clampInt, clampNum, uuid, now, researchId, safeImageUrl } from './util.js';
import { refreshSmartNotifications } from './smartNotifications.js';

export const usersRouter = Router();
usersRouter.use(authRequired);

const GOAL_TYPES = ['general_fitness', 'race_prep', 'weight_class', 'return_from_injury', 'other'];

usersRouter.patch('/me', (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const updates = {
    display_name: b.displayName !== undefined ? String(b.displayName).slice(0, 80) : u.display_name,
    photo_url: b.photoUrl !== undefined ? safeImageUrl(b.photoUrl) : u.photo_url,
    birth_year: b.birthYear !== undefined ? clampInt(b.birthYear, 1900, 2100) : u.birth_year,
    weight_kg: b.weightKg !== undefined ? clampNum(b.weightKg, 20, 300) : u.weight_kg,
    weight_class: b.weightClass !== undefined ? (b.weightClass || null) : u.weight_class,
    best_2k_seconds: b.best2kSeconds !== undefined ? clampNum(b.best2kSeconds, 300, 1200) : u.best_2k_seconds,
    units: b.units !== undefined ? (b.units === 'imperial' ? 'imperial' : 'metric') : u.units,
    goal_type: b.goalType !== undefined ? (GOAL_TYPES.includes(b.goalType) ? b.goalType : null) : u.goal_type,
    goal_target_event: b.goalTargetEvent !== undefined ? (b.goalTargetEvent || null) : u.goal_target_event,
    goal_target_date: b.goalTargetDate !== undefined ? (b.goalTargetDate || null) : u.goal_target_date,
    goal_weekly_sessions: b.goalWeeklySessions !== undefined ? clampInt(b.goalWeeklySessions, 0, 28) : u.goal_weekly_sessions,
    goal_weekly_minutes: b.goalWeeklyMinutes !== undefined ? clampInt(b.goalWeeklyMinutes, 0, 4000) : u.goal_weekly_minutes,
    goal_weekly_meters: b.goalWeeklyMeters !== undefined ? clampInt(b.goalWeeklyMeters, 0, 2000000) : u.goal_weekly_meters,
    max_hr: b.maxHr !== undefined ? clampInt(b.maxHr, 120, 230) : u.max_hr,
    resting_hr: b.restingHr !== undefined ? clampInt(b.restingHr, 25, 110) : u.resting_hr,
    share_workouts_team: b.shareWorkoutsTeam !== undefined ? (b.shareWorkoutsTeam ? 1 : 0) : u.share_workouts_team,
    share_2k_history: b.share2kHistory !== undefined ? (b.share2kHistory ? 1 : 0) : u.share_2k_history,
    share_wellness_coach: b.shareWellnessCoach !== undefined ? (b.shareWellnessCoach ? 1 : 0) : u.share_wellness_coach,
    share_profile: b.shareProfile !== undefined ? (b.shareProfile ? 1 : 0) : u.share_profile,
    // §5.1: single clearly-labeled research toggle, reversible any time,
    // architecturally separate from the social-sharing flags above.
    research_opt_in: b.researchOptIn !== undefined ? (b.researchOptIn ? 1 : 0) : u.research_opt_in,
    // Separate explicit consent for demographic fields entering the research
    // dataset (birth decade, weight class) — independent of the main toggle.
    research_share_demographics: b.researchShareDemographics !== undefined ? (b.researchShareDemographics ? 1 : 0) : u.research_share_demographics,
    notif_prefs: b.notifPrefs !== undefined ? JSON.stringify({
      workout_reminder: !!b.notifPrefs.workout_reminder,
      wellness_reminder: !!b.notifPrefs.wellness_reminder,
      team_activity: !!b.notifPrefs.team_activity,
      group_activity: !!b.notifPrefs.group_activity,
      announcement: !!b.notifPrefs.announcement,
    }) : u.notif_prefs,
  };
  db.prepare(`UPDATE users SET
      display_name=@display_name, photo_url=@photo_url, birth_year=@birth_year,
      weight_kg=@weight_kg, weight_class=@weight_class, best_2k_seconds=@best_2k_seconds,
      units=@units, goal_type=@goal_type, goal_target_event=@goal_target_event,
      goal_target_date=@goal_target_date, goal_weekly_sessions=@goal_weekly_sessions,
      goal_weekly_minutes=@goal_weekly_minutes, goal_weekly_meters=@goal_weekly_meters,
      max_hr=@max_hr, resting_hr=@resting_hr,
      share_workouts_team=@share_workouts_team,
      share_2k_history=@share_2k_history, share_wellness_coach=@share_wellness_coach,
      share_profile=@share_profile, research_opt_in=@research_opt_in,
      research_share_demographics=@research_share_demographics, notif_prefs=@notif_prefs
    WHERE id = @id`).run({ ...updates, id: u.id });
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  res.json({ user: publicUser(fresh) });
});

/* ---------------- notifications ---------------- */

usersRouter.get('/me/notifications', (req, res) => {
  // Generate any due intelligent nudges (goal proximity, inactivity, streak
  // keep-alive, plan phase) before returning — deduped so they never spam.
  try { refreshSmartNotifications(req.user); } catch { /* nudges must never break the feed */ }
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ notifications: rows });
});

usersRouter.post('/me/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------------- client health telemetry (feeds §3.2 dashboard) ---------------- */

usersRouter.post('/me/health-events', (req, res) => {
  const kind = ['ble_error', 'sync_failure', 'client_error', 'crash'].includes(req.body?.kind) ? req.body.kind : 'client_error';
  db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), kind, String(req.body?.detail || '').slice(0, 500), req.user.id, now());
  res.json({ ok: true });
});

/* ---------------- data export (§14) ---------------- */

usersRouter.get('/me/export.csv', (req, res) => {
  const workouts = db.prepare('SELECT * FROM workouts WHERE user_id = ? ORDER BY started_at').all(req.user.id);
  const esc = (v) => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = ['workout_id,started_at_iso,machine_type,total_distance_m,total_time_s,avg_split_s,avg_stroke_rate,avg_heart_rate,max_heart_rate,min_heart_rate,avg_power_watts,assigned_by_coach'];
  for (const w of workouts) {
    lines.push([w.id, w.started_at ? new Date(w.started_at * 1000).toISOString() : '', w.machine_type,
      w.total_distance_m, w.total_time_s, w.avg_split_s, w.avg_stroke_rate, w.avg_heart_rate,
      w.max_heart_rate, w.min_heart_rate,
      w.avg_power_watts, w.assigned_by_coach_id ? 'yes' : 'no'].map(esc).join(','));
  }
  // Full HR time series per workout (t_offset_s,bpm) — export requirement of
  // the HR subsystem; kept in a separate CSV section.
  lines.push('', 'workout_id,t_offset_s,bpm');
  for (const w of workouts) {
    let series = [];
    try { series = JSON.parse(w.hr_series_json || '[]'); } catch { /* none */ }
    for (const [t, bpm] of series) lines.push(`${w.id},${t},${bpm}`);
  }
  const checkins = db.prepare('SELECT * FROM wellness_checkins WHERE user_id = ? ORDER BY date').all(req.user.id);
  lines.push('', 'date,sleep_hours,sleep_quality,soreness_level,stress_level,notes');
  for (const c of checkins) {
    lines.push([c.date, c.sleep_hours, c.sleep_quality, c.soreness_level, c.stress_level, c.resting_notes].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="rowpoint-export.csv"');
  res.send(lines.join('\n'));
});

/* ---------------- account deletion (§10.1(v), §14) ----------------
   Full in-app deletion. Removes the account and all personal data, including
   the user's pseudonymous research contributions (deletion is stronger than
   opt-out: opt-out retains past contributions, deletion removes them). */

usersRouter.delete('/me', (req, res) => {
  if (!req.body?.confirm || String(req.body.confirm).toLowerCase() !== 'delete') {
    throw badRequest('Send {"confirm":"delete"} to permanently delete your account.', 'confirm_required');
  }
  const rid = researchId(req.user.id);
  // One atomic unit: every pseudonymous research row (workouts, wellness, AND
  // longitudinal snapshots) plus the account itself. Teams owned by a deleted
  // coach cascade; memberships cascade via FK.
  inTransaction(() => {
    db.prepare('DELETE FROM research_workouts WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM research_wellness WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM research_snapshots WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  });
  res.json({ ok: true, message: 'Your account and all associated data have been deleted.' });
});
