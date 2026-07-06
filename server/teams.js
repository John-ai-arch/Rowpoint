// Teams (§2.2): team codes, join/leave/remove, coach dashboard with roster,
// assignments + bulk roster completion view (§14 coach-side bulk tools).
import { Router } from 'express';
import { db } from './db.js';
import { authRequired, verifiedRequired } from './middleware.js';
import { uuid, now, teamCode, badRequest, ApiError, todayStr, safeJson } from './util.js';
import { validatePlan } from './ai/planValidation.js';

export const teamsRouter = Router();
teamsRouter.use(authRequired, verifiedRequired);

function teamForCoach(req, teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ? AND coach_id = ?').get(teamId, req.user.id);
  if (!team) throw new ApiError(404, 'Team not found (or you are not its coach).', 'not_found');
  return team;
}

export function isTeamMemberOrCoach(userId, teamId) {
  const t = db.prepare('SELECT coach_id FROM teams WHERE id = ?').get(teamId);
  if (!t) return false;
  if (t.coach_id === userId) return true;
  return !!db.prepare('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
}

function notifyTeam(teamId, category, title, body, exceptUserId = null) {
  const members = db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(teamId);
  const insert = db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)');
  for (const m of members) {
    if (m.user_id === exceptUserId) continue;
    const prefs = safeJson(db.prepare('SELECT notif_prefs FROM users WHERE id = ?').get(m.user_id)?.notif_prefs, {});
    if (prefs[category] === false) continue; // opt-in per category (§14)
    insert.run(uuid(), m.user_id, category, title, body, now());
  }
}

/* ---------------- my teams ---------------- */

teamsRouter.get('/', (req, res) => {
  const coached = db.prepare('SELECT * FROM teams WHERE coach_id = ?').all(req.user.id);
  const joined = db.prepare(
    `SELECT t.*, u.display_name AS coach_name FROM team_members m
     JOIN teams t ON t.id = m.team_id JOIN users u ON u.id = t.coach_id
     WHERE m.user_id = ?`).all(req.user.id);
  res.json({
    coached: coached.map(t => ({ ...t, memberCount: db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id = ?').get(t.id).c })),
    joined: joined.map(t => ({ id: t.id, name: t.name, coachName: t.coach_name })),
  });
});

teamsRouter.post('/join', (req, res) => {
  // A rower can belong to zero or more teams (§2.2).
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) throw badRequest('Enter a team code.');
  const team = db.prepare('SELECT * FROM teams WHERE code = ?').get(code);
  if (!team) throw new ApiError(404, 'No team found with that code. Check with your coach — codes can be regenerated.', 'bad_code');
  if (team.coach_id === req.user.id) throw badRequest('You are the coach of this team.');
  const existing = db.prepare('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, req.user.id);
  if (existing) throw badRequest('You are already on this team.', 'already_member');
  db.prepare('INSERT INTO team_members (id, team_id, user_id, joined_at) VALUES (?,?,?,?)').run(uuid(), team.id, req.user.id, now());
  const coach = db.prepare('SELECT * FROM users WHERE id = ?').get(team.coach_id);
  const prefs = safeJson(coach?.notif_prefs, {});
  if (coach && prefs.team_activity !== false) {
    db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)')
      .run(uuid(), coach.id, 'team_activity', 'New team member', `${req.user.display_name} joined ${team.name} with your team code.`, now());
  }
  res.json({ team: { id: team.id, name: team.name, coachName: coach?.display_name } });
});

teamsRouter.post('/:teamId/leave', (req, res) => {
  const r = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(req.params.teamId, req.user.id);
  if (!r.changes) throw new ApiError(404, 'You are not on this team.', 'not_found');
  res.json({ ok: true });
});

/* ---------------- coach tools ---------------- */

teamsRouter.post('/:teamId/regenerate-code', (req, res) => {
  const team = teamForCoach(req, req.params.teamId);
  const code = teamCode();
  db.prepare('UPDATE teams SET code = ? WHERE id = ?').run(code, team.id);
  res.json({ code });
});

teamsRouter.patch('/:teamId', (req, res) => {
  const team = teamForCoach(req, req.params.teamId);
  if (req.body?.name) db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(String(req.body.name).slice(0, 80), team.id);
  res.json({ ok: true });
});

teamsRouter.delete('/:teamId/members/:userId', (req, res) => {
  const team = teamForCoach(req, req.params.teamId);
  const r = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, req.params.userId);
  if (!r.changes) throw new ApiError(404, 'That rower is not on this team.', 'not_found');
  res.json({ ok: true });
});

// Coach dashboard roster (§2.2): recent workouts, current 2k PB, and profile
// info the rower has made visible to the team (privacy settings, §5).
teamsRouter.get('/:teamId/roster', (req, res) => {
  const team = teamForCoach(req, req.params.teamId);
  const members = db.prepare(
    `SELECT u.* , m.joined_at FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? ORDER BY u.display_name`).all(team.id);
  const roster = members.map(u => {
    const shareWorkouts = !!u.share_workouts_team;
    const recent = shareWorkouts
      ? db.prepare(`SELECT id, started_at, machine_type, total_distance_m, total_time_s, avg_split_s, avg_stroke_rate, ai_feedback_json
                    FROM workouts WHERE user_id = ? ORDER BY started_at DESC LIMIT 5`).all(u.id)
      : [];
    const wellness = u.share_wellness_coach
      ? db.prepare('SELECT date, sleep_hours, sleep_quality, soreness_level, stress_level FROM wellness_checkins WHERE user_id = ? ORDER BY date DESC LIMIT 7').all(u.id)
      : null;
    return {
      id: u.id,
      displayName: u.display_name,
      photoUrl: u.share_profile ? u.photo_url : null,
      joinedAt: u.joined_at,
      best2kSeconds: u.share_2k_history ? u.best_2k_seconds : null,
      best2kVerified: u.share_2k_history ? !!u.best_2k_verified : null,
      weightClass: u.share_profile ? u.weight_class : null,
      goalType: u.share_profile ? u.goal_type : null,
      sharesWorkouts: shareWorkouts,
      recentWorkouts: recent,
      wellness,
    };
  });
  res.json({ team: { id: team.id, name: team.name, code: team.code }, roster });
});

/* ---------------- assignments (§2.3 prerequisite, §14 bulk tools) ---------------- */

teamsRouter.post('/:teamId/assignments', (req, res) => {
  const team = teamForCoach(req, req.params.teamId);
  const b = req.body || {};
  if (!b.plan) throw badRequest('Missing workout plan.');
  const v = validatePlan(b.plan);
  if (!v.ok) throw badRequest(v.error, 'invalid_plan');
  const planId = uuid();
  db.prepare('INSERT INTO workout_plans (id, creator_id, name, machine_type, plan_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(planId, req.user.id, String(b.name || 'Team workout').slice(0, 100), b.machineType || 'rower', JSON.stringify(b.plan), now());
  const assignmentId = uuid();
  const date = b.scheduledDate || todayStr();
  db.prepare('INSERT INTO assignments (id, team_id, plan_id, coach_id, scheduled_date, note, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(assignmentId, team.id, planId, req.user.id, date, b.note || null, now());
  notifyTeam(team.id, 'team_activity', 'New assigned workout',
    `${req.user.display_name} assigned "${b.name || 'Team workout'}" for ${date}.`);
  res.status(201).json({ assignmentId, planId });
});

// Assignments visible to any member or the coach, with per-rower completion
// (who has / hasn't completed it — §14 roster view).
teamsRouter.get('/:teamId/assignments', (req, res) => {
  if (!isTeamMemberOrCoach(req.user.id, req.params.teamId)) throw new ApiError(403, 'Not a member of this team.', 'forbidden');
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  const isCoach = team.coach_id === req.user.id;
  const rows = db.prepare(
    `SELECT a.*, p.name AS plan_name, p.plan_json, p.machine_type
     FROM assignments a JOIN workout_plans p ON p.id = a.plan_id
     WHERE a.team_id = ? ORDER BY a.scheduled_date DESC, a.created_at DESC LIMIT 50`).all(req.params.teamId);
  const members = db.prepare('SELECT u.id, u.display_name FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?').all(req.params.teamId);
  const assignments = rows.map(a => {
    const completions = db.prepare('SELECT DISTINCT user_id FROM workouts WHERE assignment_id = ?').all(a.id).map(r => r.user_id);
    return {
      id: a.id, planId: a.plan_id, name: a.plan_name, plan: safeJson(a.plan_json),
      machineType: a.machine_type, scheduledDate: a.scheduled_date, note: a.note,
      createdAt: a.created_at,
      completedByMe: completions.includes(req.user.id),
      roster: isCoach ? members.map(m => ({ id: m.id, displayName: m.display_name, completed: completions.includes(m.id) })) : undefined,
    };
  });
  res.json({ assignments, isCoach });
});
