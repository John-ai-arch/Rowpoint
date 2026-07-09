// Adaptive Training Intelligence API: the athlete profile, long-term periodized
// plans, plan adaptation, and weekly/monthly coaching reviews. Built on the
// existing training-analysis engine (server/ai/trainingAnalysis.js) and the
// periodization engine (server/ai/periodization.js) — no duplicate analysis.
import { Router } from 'express';
import { db, inTransaction } from './db.js';
import { authRequired } from './middleware.js';
import { buildTrainingAnalysis } from './ai/trainingAnalysis.js';
import {
  generatePlan, adaptPlan, weeklyReview, monthlyReview,
  currentWeekIndex, inferPhaseFromRace, PHASES,
} from './ai/periodization.js';
import { uuid, now, clampInt, clampNum, safeJson, ApiError, badRequest } from './util.js';

export const trainingRouter = Router();
trainingRouter.use(authRequired);

const EXPERIENCE = ['beginner', 'intermediate', 'advanced', 'elite'];
const RACE_DISTANCES = ['2000m', '5000m', '6000m', 'head', 'marathon'];

/* ---------------- athlete profile ---------------- */

function profileOf(u) {
  return {
    displayName: u.display_name,
    heightCm: u.height_cm ?? null,
    weightKg: u.weight_kg ?? null,
    birthYear: u.birth_year ?? null,
    experienceLevel: u.experience_level ?? null,
    best2kSeconds: u.best_2k_seconds ?? null,
    goal2kSeconds: u.goal_2k_seconds ?? null,
    preferredRaceDistance: u.preferred_race_distance ?? null,
    availableDays: u.available_days ?? u.goal_weekly_sessions ?? null,
    sessionMinutes: u.session_minutes ?? null,
    preferredWorkoutTypes: safeJson(u.preferred_workout_types, []) || [],
    injuryHistory: u.injury_history ?? null,
    club: u.club ?? null,
    boatClass: u.boat_class ?? null,
    goalEvent: u.goal_target_event ?? null,
    goalDate: u.goal_target_date ?? null,
    goalType: u.goal_type ?? null,
  };
}

trainingRouter.get('/profile', (req, res) => {
  res.json({ profile: profileOf(req.user) });
});

trainingRouter.patch('/profile', (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  const set = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

  if ('heightCm' in b) set('height_cm', clampNum(b.heightCm, 100, 250));
  if ('weightKg' in b) set('weight_kg', clampNum(b.weightKg, 30, 250));
  if ('experienceLevel' in b) {
    if (b.experienceLevel && !EXPERIENCE.includes(b.experienceLevel)) throw badRequest('Unknown experience level.');
    set('experience_level', b.experienceLevel || null);
  }
  if ('goal2kSeconds' in b) set('goal_2k_seconds', clampNum(b.goal2kSeconds, 300, 720));
  if ('preferredRaceDistance' in b) {
    if (b.preferredRaceDistance && !RACE_DISTANCES.includes(b.preferredRaceDistance)) throw badRequest('Unknown race distance.');
    set('preferred_race_distance', b.preferredRaceDistance || null);
  }
  if ('availableDays' in b) set('available_days', clampInt(b.availableDays, 1, 14));
  if ('sessionMinutes' in b) set('session_minutes', clampInt(b.sessionMinutes, 10, 300));
  if ('preferredWorkoutTypes' in b) set('preferred_workout_types', JSON.stringify(Array.isArray(b.preferredWorkoutTypes) ? b.preferredWorkoutTypes.slice(0, 12) : []));
  if ('injuryHistory' in b) set('injury_history', String(b.injuryHistory || '').slice(0, 1000) || null);
  if ('club' in b) set('club', String(b.club || '').slice(0, 120) || null);
  if ('boatClass' in b) set('boat_class', String(b.boatClass || '').slice(0, 40) || null);
  // Goal event/date reuse the existing user goal fields (single source of truth).
  if ('goalEvent' in b) set('goal_target_event', String(b.goalEvent || '').slice(0, 120) || null);
  if ('goalDate' in b) set('goal_target_date', b.goalDate || null);

  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ profile: profileOf(fresh) });
});

/* ---------------- plans ---------------- */

function presentPlan(row, nowS = now()) {
  if (!row) return null;
  const weeks = safeJson(row.weeks_json, []) || [];
  const plan = {
    totalWeeks: row.total_weeks, startDate: row.start_date, goalEvent: row.goal_event,
    goalDate: row.goal_date, weeks,
  };
  const idx = weeks.length ? currentWeekIndex(plan, nowS) : 0;
  const cw = weeks[idx] || null;
  return {
    id: row.id,
    name: row.name,
    goalEvent: row.goal_event,
    goalDate: row.goal_date,
    goal2kSeconds: row.goal_2k_seconds,
    targetWeeklyMeters: row.target_weekly_meters,
    totalWeeks: row.total_weeks,
    startDate: row.start_date,
    status: row.status,
    weeks,
    currentWeekIndex: idx,
    currentPhase: cw ? { key: cw.phase, label: cw.phaseLabel, focus: cw.focus } : null,
    weeksToGoal: row.goal_date ? Math.max(0, Math.round((new Date(`${row.goal_date}T00:00:00Z`).getTime() / 1000 - nowS) / (7 * 86400))) : null,
    adaptations: safeJson(row.adaptations_json, []) || [],
    coachNote: row.coach_note || null,
    coachId: row.coach_id || null,
    createdAt: row.created_at,
    adaptedAt: row.adapted_at,
  };
}

function activePlanRow(userId) {
  return db.prepare("SELECT * FROM training_plans WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(userId);
}

trainingRouter.get('/plan', (req, res) => {
  res.json({ plan: presentPlan(activePlanRow(req.user.id)) });
});

trainingRouter.post('/plan', (req, res) => {
  const b = req.body || {};
  const nowS = now();
  const u = req.user;
  const analysis = buildTrainingAnalysis(u, nowS);
  const baselineWeeklyMeters = Math.round((analysis.volume?.last28d?.meters || 0) / 4);

  const goalDate = b.goalDate || u.goal_target_date || null;
  const goalDateS = goalDate ? Math.floor(new Date(`${goalDate}T00:00:00Z`).getTime() / 1000) : null;
  let weeks = clampInt(b.weeks, 4, 52);
  if (!weeks && goalDateS) weeks = Math.max(4, Math.round((goalDateS - nowS) / (7 * 86400)));
  if (!weeks) weeks = 12;
  if (goalDateS && goalDateS <= nowS) throw badRequest('Your goal date is in the past — pick a future race date.', 'bad_goal_date');

  const plan = generatePlan({
    nowS, startDateS: nowS, goalDateS, weeks,
    best2kSeconds: u.best_2k_seconds,
    goal2kSeconds: b.goal2kSeconds ?? u.goal_2k_seconds,
    targetWeeklyMeters: clampInt(b.targetWeeklyMeters, 8000, 200000) || u.goal_weekly_meters || null,
    availableDays: clampInt(b.availableDays, 1, 14) || u.available_days || u.goal_weekly_sessions || 4,
    sessionMinutes: u.session_minutes || null,
    goalEvent: b.goalEvent || u.goal_target_event || 'your goal race',
    baselineWeeklyMeters,
  });

  const id = uuid();
  const name = b.name || `${plan.goalEvent} — ${weeks}-week plan`;
  inTransaction(() => {
    // One active plan at a time; archive any prior active plan.
    db.prepare("UPDATE training_plans SET status = 'archived', updated_at = ? WHERE user_id = ? AND status = 'active'").run(nowS, u.id);
    db.prepare(`INSERT INTO training_plans
        (id, user_id, name, goal_event, goal_date, goal_2k_seconds, target_weekly_meters,
         total_weeks, start_date, weeks_json, adaptations_json, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?)`)
      .run(id, u.id, name.slice(0, 120), plan.goalEvent, plan.goalDate, plan.goal2kSeconds || null,
        plan.targetWeeklyMeters, plan.totalWeeks, plan.startDate, JSON.stringify(plan.weeks), '[]', nowS, nowS);
  });
  res.status(201).json({ plan: presentPlan(db.prepare('SELECT * FROM training_plans WHERE id = ?').get(id), nowS), rationale: plan.rationale });
});

trainingRouter.post('/plan/adapt', (req, res) => {
  const nowS = now();
  const row = activePlanRow(req.user.id);
  if (!row) throw new ApiError(404, 'No active training plan to adapt. Generate one first.', 'no_plan');
  const analysis = buildTrainingAnalysis(req.user, nowS);
  const plan = { totalWeeks: row.total_weeks, startDate: row.start_date, weeks: safeJson(row.weeks_json, []) || [] };
  const { decisions, weeks } = adaptPlan(plan, analysis, nowS);

  const prior = safeJson(row.adaptations_json, []) || [];
  const entry = { at: nowS, decisions };
  const log = decisions.length ? [entry, ...prior].slice(0, 30) : prior;
  db.prepare('UPDATE training_plans SET weeks_json = ?, adaptations_json = ?, adapted_at = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(weeks), JSON.stringify(log), nowS, nowS, row.id);

  res.json({
    plan: presentPlan(db.prepare('SELECT * FROM training_plans WHERE id = ?').get(row.id), nowS),
    adapted: decisions.length > 0,
    decisions,
    message: decisions.length ? `Adapted your plan: ${decisions.length} change(s) based on your recent training.` : 'Your plan is on track — no changes needed right now.',
  });
});

trainingRouter.delete('/plan', (req, res) => {
  const row = activePlanRow(req.user.id);
  if (row) db.prepare("UPDATE training_plans SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), row.id);
  res.json({ ok: true });
});

/* ---------------- reviews ---------------- */

trainingRouter.get('/weekly-review', (req, res) => {
  const nowS = now();
  const analysis = buildTrainingAnalysis(req.user, nowS);
  const row = activePlanRow(req.user.id);
  const plan = row ? { totalWeeks: row.total_weeks, startDate: row.start_date, weeks: safeJson(row.weeks_json, []) || [] } : null;
  res.json({ review: weeklyReview(analysis, plan, nowS) });
});

trainingRouter.get('/monthly-review', (req, res) => {
  const analysis = buildTrainingAnalysis(req.user, now());
  res.json({ review: monthlyReview(analysis) });
});

/* ---------------- current phase (works with or without a plan) ---------------- */

trainingRouter.get('/phase', (req, res) => {
  const nowS = now();
  const row = activePlanRow(req.user.id);
  if (row) {
    const plan = presentPlan(row, nowS);
    return res.json({ phase: plan.currentPhase, source: 'plan', weeksToGoal: plan.weeksToGoal });
  }
  const analysis = buildTrainingAnalysis(req.user, nowS);
  const key = inferPhaseFromRace(analysis.athlete?.goal?.daysToEvent);
  res.json({
    phase: key ? { key, label: PHASES[key].label, focus: PHASES[key].blurb } : null,
    source: key ? 'inferred_from_race' : 'none',
    weeksToGoal: analysis.athlete?.goal?.daysToEvent != null ? Math.round(analysis.athlete.goal.daysToEvent / 7) : null,
  });
});

/* ---------------- season planner (races) ---------------- */

const RACE_DISTANCES2 = ['2000m', '5000m', '6000m', 'head', 'marathon', 'other'];
const PRIORITIES = ['A', 'B', 'C'];

function presentRace(r, nowS = now()) {
  const dateS = r.race_date ? Math.floor(new Date(`${r.race_date}T00:00:00Z`).getTime() / 1000) : null;
  return {
    id: r.id, name: r.name, raceDate: r.race_date, distance: r.distance,
    priority: r.priority, goalTimeSeconds: r.goal_time_s, location: r.location,
    notes: r.notes, resultTimeSeconds: r.result_time_s,
    daysAway: dateS ? Math.round((dateS - nowS) / 86400) : null,
    isPast: dateS ? dateS < nowS : false,
  };
}

trainingRouter.get('/season', (req, res) => {
  const nowS = now();
  const races = db.prepare('SELECT * FROM races WHERE user_id = ? ORDER BY race_date').all(req.user.id).map(r => presentRace(r, nowS));
  const plan = activePlanRow(req.user.id);
  const nextA = races.find(r => !r.isPast && r.priority === 'A') || races.find(r => !r.isPast) || null;
  res.json({
    races,
    upcoming: races.filter(r => !r.isPast),
    past: races.filter(r => r.isPast),
    nextRace: nextA,
    activePlanEvent: plan ? plan.goal_event : null,
    activePlanGoalDate: plan ? plan.goal_date : null,
  });
});

trainingRouter.post('/races', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.raceDate) throw badRequest('Race name and date are required.', 'missing_field');
  if (b.distance && !RACE_DISTANCES2.includes(b.distance)) throw badRequest('Unknown race distance.');
  if (b.priority && !PRIORITIES.includes(b.priority)) throw badRequest('Priority must be A, B, or C.');
  const id = uuid();
  db.prepare(`INSERT INTO races (id, user_id, name, race_date, distance, priority, goal_time_s, location, notes, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, String(b.name).slice(0, 120), b.raceDate, b.distance || null,
      PRIORITIES.includes(b.priority) ? b.priority : 'B', clampNum(b.goalTimeSeconds, 60, 20000),
      b.location ? String(b.location).slice(0, 120) : null, b.notes ? String(b.notes).slice(0, 500) : null, now(), now());
  res.status(201).json({ race: presentRace(db.prepare('SELECT * FROM races WHERE id = ?').get(id)) });
});

trainingRouter.patch('/races/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM races WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!r) throw new ApiError(404, 'Race not found.', 'not_found');
  const b = req.body || {};
  if (b.distance && !RACE_DISTANCES2.includes(b.distance)) throw badRequest('Unknown race distance.');
  if (b.priority && !PRIORITIES.includes(b.priority)) throw badRequest('Priority must be A, B, or C.');
  db.prepare(`UPDATE races SET name=?, race_date=?, distance=?, priority=?, goal_time_s=?, location=?, notes=?, result_time_s=?, updated_at=? WHERE id=?`)
    .run(b.name !== undefined ? String(b.name).slice(0, 120) : r.name,
      b.raceDate ?? r.race_date, b.distance !== undefined ? b.distance : r.distance,
      b.priority !== undefined && PRIORITIES.includes(b.priority) ? b.priority : r.priority,
      b.goalTimeSeconds !== undefined ? clampNum(b.goalTimeSeconds, 60, 20000) : r.goal_time_s,
      b.location !== undefined ? (b.location ? String(b.location).slice(0, 120) : null) : r.location,
      b.notes !== undefined ? (b.notes ? String(b.notes).slice(0, 500) : null) : r.notes,
      b.resultTimeSeconds !== undefined ? clampNum(b.resultTimeSeconds, 60, 20000) : r.result_time_s,
      now(), r.id);
  res.json({ race: presentRace(db.prepare('SELECT * FROM races WHERE id = ?').get(r.id)) });
});

trainingRouter.delete('/races/:id', (req, res) => {
  const r = db.prepare('SELECT id FROM races WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!r) throw new ApiError(404, 'Race not found.', 'not_found');
  db.prepare('DELETE FROM races WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

/* ---------------- coach visibility & note (coaches see rowers' plans) ---------------- */

trainingRouter.get('/team/:teamId/plans', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ? AND coach_id = ?').get(req.params.teamId, req.user.id);
  if (!team) throw new ApiError(403, 'You are not the coach of this team.', 'forbidden');
  const rows = db.prepare(
    `SELECT p.*, u.display_name FROM training_plans p
     JOIN team_members m ON m.user_id = p.user_id AND m.team_id = ?
     JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active' ORDER BY u.display_name`).all(team.id);
  res.json({
    plans: rows.map(r => ({
      userId: r.user_id, displayName: r.display_name,
      plan: presentPlan(r),
    })),
  });
});

trainingRouter.post('/plan/:id/coach-note', (req, res) => {
  const row = db.prepare('SELECT * FROM training_plans WHERE id = ?').get(req.params.id);
  if (!row) throw new ApiError(404, 'Plan not found.', 'not_found');
  const coaches = db.prepare(
    `SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id
     WHERE t.coach_id = ? AND m.user_id = ? LIMIT 1`).get(req.user.id, row.user_id);
  if (!coaches) throw new ApiError(403, 'You do not coach this athlete.', 'forbidden');
  const note = String(req.body?.note || '').slice(0, 800);
  db.prepare('UPDATE training_plans SET coach_note = ?, coach_id = ?, updated_at = ? WHERE id = ?')
    .run(note || null, req.user.id, now(), row.id);
  res.json({ ok: true });
});
