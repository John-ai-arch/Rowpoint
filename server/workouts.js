// Workout sync + history (§2.5, §6): offline-first clients push completed
// workouts here idempotently (client-generated UUIDs). Completion triggers the
// pacing classifier + AI feedback (§11.4), the research pipeline (§5.2),
// leaderboard persistence (§2.4), group feed events (§4) and 2k PB tracking.
import { Router } from 'express';
import { db, inTransaction } from './db.js';
import { authRequired, verifiedRequired } from './middleware.js';
import { uuid, now, badRequest, ApiError, safeJson, clampNum, fmtSplit, todayStr } from './util.js';
import { classifyPacing, classifyIntervals } from './ai/pacing.js';
import { phraseFeedback } from './ai/coach.js';
import { markSuggestionFollowed } from './aiRouter.js';
import { onWorkoutSynced } from './groups.js';
import { contributeWorkout } from './research.js';
import { validatePlan } from './ai/planValidation.js';
import { sanitizeHrSeries, hrSummary, effectiveMaxHr } from './hr.js';

export const workoutsRouter = Router();
workoutsRouter.use(authRequired);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------- sync (verified accounts only, §2.1) ---------------- */

workoutsRouter.post('/sync', verifiedRequired, async (req, res) => {
  const b = req.body || {};
  if (!UUID_RE.test(String(b.id || ''))) throw badRequest('Workout id must be a client-generated UUID.');
  const existing = db.prepare('SELECT id, user_id FROM workouts WHERE id = ?').get(b.id);
  if (existing) {
    if (existing.user_id !== req.user.id) throw new ApiError(409, 'Workout id conflict.', 'conflict');
    return res.json({ ok: true, alreadySynced: true, workoutId: b.id }); // idempotent
  }

  const splits = Array.isArray(b.splits) ? b.splits.slice(0, 500) : [];
  const totalDistance = clampNum(b.totalDistanceM, 0, 1e6, 0);
  const totalTime = clampNum(b.totalTimeS, 0, 86400, 0);
  if (totalTime <= 0 || totalDistance <= 0) throw badRequest('Workout has no recorded distance/time.');

  const avgSplit = totalDistance > 0 ? (totalTime / totalDistance) * 500 : null;
  const wAvg = (key) => {
    const vs = splits.filter(s => Number.isFinite(Number(s[key])));
    if (!vs.length) return null;
    let n = 0, d = 0;
    for (const s of vs) { const w = Number(s.timeS) > 0 ? Number(s.timeS) : 1; n += Number(s[key]) * w; d += w; }
    return n / d;
  };

  // Assignment linkage → assigned_by_coach_id (input to the rules engine).
  let assignedByCoachId = null;
  let assignment = null;
  if (b.assignmentId) {
    assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(b.assignmentId);
    if (assignment) {
      const member = db.prepare('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?').get(assignment.team_id, req.user.id);
      if (!member) assignment = null; else assignedByCoachId = assignment.coach_id;
    }
  }

  const plan = b.plan ?? null;
  // Client clocks drift and offline queues replay late, but a start time in
  // the future (or before the app could exist) corrupts streaks, weekly
  // goals, and research timestamps — clamp to a plausible window instead.
  const nowS = now();
  const MIN_PLAUSIBLE = 1577836800; // 2020-01-01
  let startedAt = Number(b.startedAt) || nowS - Math.round(totalTime);
  if (startedAt > nowS + 300 || startedAt < MIN_PLAUSIBLE) startedAt = nowS - Math.round(totalTime);

  // Heart-rate time series (universal HR monitor subsystem): sanitized,
  // summarized into min/max/avg + zone seconds + drift using the rower's
  // effective max HR, and stored alongside the workout so live data,
  // history, and summaries stay synchronized with the same session.
  const hrSeries = sanitizeHrSeries(b.hrSeries);
  const hr = hrSummary(hrSeries, effectiveMaxHr(req.user));
  // HR retention follows research consent: participants keep the full
  // timestamped sample series (it powers their per-workout HR chart, research
  // contributions, and the AI coach's HR analyses); non-participants keep
  // only the minimum their own history needs — the summary statistics
  // (avg/max/min, time-in-zone, drift) — and the raw series is discarded.
  const storeFullHrSeries = !!req.user.research_opt_in;

  // Pure normalization first (no DB), then commit the workout + its splits +
  // force curves as ONE atomic unit so a mid-write failure can never leave a
  // workout without its splits (or vice versa).
  const normSplits = splits.map((s, i) => ({
    split_index: i,
    interval_index: Number.isFinite(Number(s.intervalIndex)) ? Number(s.intervalIndex) : null,
    distance_m: clampNum(s.distanceM, 0, 1e6),
    time_s: clampNum(s.timeS, 0, 86400),
    avg_pace_s_per_500m: clampNum(s.avgPaceSPer500m, 0, 1000),
    avg_stroke_rate: clampNum(s.avgStrokeRate, 0, 100),
    avg_heart_rate: clampNum(s.avgHeartRate, 0, 250),
    avg_power_watts: clampNum(s.avgPowerWatts, 0, 2500),
  }));
  const curves = Array.isArray(b.forceCurves) ? b.forceCurves.slice(0, 5000) : [];

  inTransaction(() => {
    db.prepare(`INSERT INTO workouts (
        id, user_id, assignment_id, assigned_by_coach_id, started_at, ended_at,
        machine_type, machine_id, total_distance_m, total_time_s, avg_split_s,
        avg_stroke_rate, avg_heart_rate, avg_power_watts, workout_plan_json,
        hr_series_json, hr_zones_json, max_heart_rate, min_heart_rate, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.id, req.user.id, assignment?.id || null, assignedByCoachId, startedAt,
        clampNum(b.endedAt, startedAt, startedAt + 86400, null) ?? startedAt + Math.round(totalTime),
        b.machineType || 'rower', b.machineId || null, totalDistance, totalTime, avgSplit,
        // When a recorded HR series exists it is the single source of truth for
        // this workout's HR stats (avg/max/min all from the same samples);
        // split-level averages are the fallback for relay-only sessions.
        wAvg('avgStrokeRate'), hr?.avg ?? wAvg('avgHeartRate') ?? null, wAvg('avgPowerWatts'),
        plan ? JSON.stringify(plan) : null,
        storeFullHrSeries && hrSeries.length ? JSON.stringify(hrSeries) : null,
        hr ? JSON.stringify({ zoneSeconds: hr.zoneSeconds, maxHrUsed: hr.maxHrUsed, driftPct: hr.driftPct }) : null,
        hr?.max ?? null, hr?.min ?? null, now());

    const insSplit = db.prepare(`INSERT INTO splits
        (id, workout_id, split_index, interval_index, distance_m, time_s, avg_pace_s_per_500m, avg_stroke_rate, avg_heart_rate, avg_power_watts)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const s of normSplits) {
      insSplit.run(uuid(), b.id, s.split_index, s.interval_index, s.distance_m, s.time_s,
        s.avg_pace_s_per_500m, s.avg_stroke_rate, s.avg_heart_rate, s.avg_power_watts);
    }

    // Force curves (§6): one row per stroke, JSON sample arrays.
    const insCurve = db.prepare('INSERT INTO force_curves (id, workout_id, stroke_index, samples_json) VALUES (?,?,?,?)');
    for (const c of curves) {
      if (!Array.isArray(c?.samples)) continue;
      insCurve.run(uuid(), b.id, Number(c.strokeIndex) || 0, JSON.stringify(c.samples.slice(0, 64).map(Number)));
    }
  });

  /* ---- AI pacing feedback (§11.4) ---- */
  let classification = classifyPacing(normSplits);
  let perInterval = null;
  if (plan?.type === 'intervals' && normSplits.some(s => s.interval_index !== null)) {
    const groups = new Map();
    for (const s of normSplits) {
      if (s.interval_index === null) continue;
      if (!groups.has(s.interval_index)) groups.set(s.interval_index, []);
      groups.get(s.interval_index).push(s);
    }
    const ic = classifyIntervals([...groups.keys()].sort((a, z) => a - z).map(k => groups.get(k)));
    perInterval = ic.perInterval;
    if (ic.overall !== 'well_paced') classification = { ...classification, tag: ic.overall };
  }
  const phrased = await phraseFeedback(classification);
  const aiFeedback = {
    classification: classification.tag,
    detail: classification.detail,
    firstThirdPace: classification.firstThirdPace,
    lastThirdPace: classification.lastThirdPace,
    avgPace: classification.avgPace,
    perInterval,
    text: phrased.text,
    textSource: phrased.source,
    aiGenerated: true, // §11.5 disclosure travels with the data
  };
  db.prepare('UPDATE workouts SET ai_feedback_json = ? WHERE id = ?').run(JSON.stringify(aiFeedback), b.id);

  /* ---- 2k PB tracking ---- */
  let newPb = false;
  if (plan?.type === 'distance' && Number(plan.distanceM) === 2000 && totalDistance >= 2000) {
    if (!req.user.best_2k_seconds || totalTime < req.user.best_2k_seconds) {
      db.prepare('UPDATE users SET best_2k_seconds = ?, best_2k_verified = 1 WHERE id = ?').run(totalTime, req.user.id);
      newPb = true;
    }
  }

  /* ---- leaderboard persistence (§2.4) ---- */
  if (assignment) {
    upsertLeaderboard('team', assignment.team_id, assignment.id, req.user, avgSplit, totalDistance, totalTime, true);
  }
  if (b.adhocSessionKey && typeof b.adhocSessionKey === 'string') {
    upsertLeaderboard('adhoc', 'adhoc', String(b.adhocSessionKey).slice(0, 64), req.user, avgSplit, totalDistance, totalTime, true);
  }

  /* ---- group activity feed (§4), respecting sharing settings ---- */
  if (req.user.share_workouts_team) {
    const memberships = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(req.user.id);
    const insFeed = db.prepare('INSERT INTO group_feed (id, group_id, user_id, type, payload_json, created_at) VALUES (?,?,?,?,?,?)');
    const payload = JSON.stringify({
      displayName: req.user.display_name,
      distanceM: totalDistance, timeS: totalTime, avgSplit, avgSplitText: fmtSplit(avgSplit),
      machineType: b.machineType || 'rower', newPb,
    });
    for (const m of memberships) insFeed.run(uuid(), m.group_id, req.user.id, newPb ? 'pb' : 'workout_completed', payload, now());
  }

  /* ---- AI recommendation adherence tracking ---- */
  markSuggestionFollowed(req.user.id, startedAt);

  /* ---- groups: achievements, milestones, leaderboard notifications, goals ---- */
  const savedWorkout = db.prepare('SELECT * FROM workouts WHERE id = ?').get(b.id);
  const { newBadges } = onWorkoutSynced(req.user, savedWorkout, { newPb });

  /* ---- research contribution (§5.2, write-time opt-in check) ---- */
  // Provenance travels with the workout from the client (timezone, device,
  // sensor source) so every research record is traceable & reproducible.
  const provenance = {
    tzOffsetMin: b.client?.tzOffsetMin,
    deviceType: b.client?.deviceType,
    sensorSource: b.client?.sensorSource,
    firmwareVersion: b.client?.firmwareVersion,
  };
  const research = contributeWorkout(req.user, savedWorkout, normSplits, provenance);

  res.status(201).json({
    ok: true, workoutId: b.id, aiFeedback, newPb, newBadges,
    research: {
      contributed: research.contributed,
      measurementConfidence: research.confidence ?? null,
      missing: research.missing ?? null,
      qualityFlags: research.qualityFlags ?? null,
    },
  });
});

export function upsertLeaderboard(scopeType, scopeId, workoutKey, user, avgSplit, dist, time, finished) {
  db.prepare(`INSERT INTO leaderboard_entries
      (id, scope_type, scope_id, workout_key, user_id, display_name, avg_split_s, total_distance_m, total_time_s, finished, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scope_type, scope_id, workout_key, user_id) DO UPDATE SET
        avg_split_s = excluded.avg_split_s, total_distance_m = excluded.total_distance_m,
        total_time_s = excluded.total_time_s,
        finished = MAX(leaderboard_entries.finished, excluded.finished),
        display_name = excluded.display_name, updated_at = excluded.updated_at`)
    .run(uuid(), scopeType, scopeId, workoutKey, user.id, user.display_name,
      avgSplit, dist, time, finished ? 1 : 0, now());
}

/* ---------------- history & detail (account-scoped, §2.5) ---------------- */

workoutsRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = db.prepare(
    `SELECT id, assignment_id, assigned_by_coach_id, started_at, machine_type,
            total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
            avg_heart_rate, avg_power_watts, max_heart_rate, min_heart_rate,
            hr_zones_json, workout_plan_json, ai_feedback_json
     FROM workouts WHERE user_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(req.user.id, limit, offset);
  res.json({
    workouts: rows.map(w => ({
      ...w, plan: safeJson(w.workout_plan_json), aiFeedback: safeJson(w.ai_feedback_json),
      hrZones: safeJson(w.hr_zones_json),
      workout_plan_json: undefined, ai_feedback_json: undefined, hr_zones_json: undefined,
    })),
  });
});

/* ---- AI Training Journal (§6 vision): per-workout coaching summary (already
   generated at sync) + the athlete's own note, searchable together. ---- */

workoutsRouter.get('/journal', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = db.prepare(
    `SELECT id, started_at, machine_type, total_distance_m, total_time_s, avg_split_s,
            ai_feedback_json, user_note
     FROM workouts WHERE user_id = ? ORDER BY started_at DESC LIMIT 400`).all(req.user.id);
  let entries = rows.map(w => {
    const fb = safeJson(w.ai_feedback_json) || {};
    return {
      id: w.id, startedAt: w.started_at, machineType: w.machine_type,
      distanceM: Math.round(w.total_distance_m || 0), timeS: Math.round(w.total_time_s || 0),
      avgSplitS: w.avg_split_s || null,
      coachSummary: fb.text || null,      // the AI's short post-workout summary
      pacing: fb.classification || null,
      note: w.user_note || null,
    };
  });
  if (q) {
    entries = entries.filter(e =>
      (e.coachSummary && e.coachSummary.toLowerCase().includes(q))
      || (e.note && e.note.toLowerCase().includes(q))
      || (e.pacing && e.pacing.toLowerCase().includes(q)));
  }
  res.json({ entries: entries.slice(0, limit), total: entries.length });
});

workoutsRouter.patch('/:id/note', (req, res) => {
  const w = db.prepare('SELECT id FROM workouts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!w) throw new ApiError(404, 'Workout not found.', 'not_found');
  const note = String(req.body?.note ?? '').slice(0, 2000);
  db.prepare('UPDATE workouts SET user_note = ? WHERE id = ?').run(note || null, w.id);
  res.json({ ok: true, note: note || null });
});

workoutsRouter.get('/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM workouts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!w) throw new ApiError(404, 'Workout not found.', 'not_found');
  const splits = db.prepare('SELECT * FROM splits WHERE workout_id = ? ORDER BY split_index').all(w.id);
  const curves = db.prepare('SELECT stroke_index, samples_json FROM force_curves WHERE workout_id = ? ORDER BY stroke_index').all(w.id);
  res.json({
    workout: {
      ...w, plan: safeJson(w.workout_plan_json), aiFeedback: safeJson(w.ai_feedback_json),
      // safeJson(null) parses to null rather than falling back — coerce so a
      // workout without a stored series always presents an empty array.
      hrSeries: safeJson(w.hr_series_json, []) || [], hrZones: safeJson(w.hr_zones_json),
      hr_series_json: undefined,
    },
    splits,
    forceCurves: curves.map(c => ({ strokeIndex: c.stroke_index, samples: safeJson(c.samples_json, []) })),
  });
});

/* ---------------- leaderboards (§2.4 read path) ---------------- */

workoutsRouter.get('/leaderboard/:scopeType/:scopeId/:workoutKey', (req, res) => {
  const { scopeType, scopeId, workoutKey } = req.params;
  if (scopeType === 'team') {
    const t = db.prepare('SELECT coach_id FROM teams WHERE id = ?').get(scopeId);
    const isMember = t && (t.coach_id === req.user.id ||
      db.prepare('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?').get(scopeId, req.user.id));
    if (!isMember) throw new ApiError(403, 'Not a member of this team.', 'forbidden');
  }
  const entries = db.prepare(
    `SELECT user_id, display_name, avg_split_s, total_distance_m, total_time_s, finished, updated_at
     FROM leaderboard_entries WHERE scope_type = ? AND scope_id = ? AND workout_key = ?
     ORDER BY finished DESC, avg_split_s ASC`) // lowest average split wins (§2.4)
    .all(scopeType, scopeId, workoutKey);
  res.json({ entries: entries.map(e => ({ ...e, avgSplitText: fmtSplit(e.avg_split_s) })) });
});

/* ---------------- daily suggested workouts (§7 scheduled content) ---------------- */

workoutsRouter.get('/daily/suggestions', (req, res) => {
  const date = todayStr();
  let rows = db.prepare('SELECT * FROM workout_plans WHERE is_daily_suggestion = 1 AND suggested_date = ?').all(date);
  if (!rows.length) {
    // Deterministic daily rotation, generated server-side with stable IDs so
    // each suggestion is addressable/shareable (not baked into the client).
    const catalog = [
      { name: 'Steady 5k', machine: 'rower', plan: { type: 'distance', distanceM: 5000 } },
      { name: '4 × 500m / 1:00 rest', machine: 'rower', plan: { type: 'intervals', intervals: Array.from({ length: 4 }, () => ({ workType: 'distance', workDistanceM: 500, restTimeS: 60 })) } },
      { name: '30:00 aerobic base', machine: 'rower', plan: { type: 'time', durationS: 1800 } },
      { name: '8 × 1:00 on / 1:00 off', machine: 'bike', plan: { type: 'intervals', intervals: Array.from({ length: 8 }, () => ({ workType: 'time', workTimeS: 60, restTimeS: 60 })) } },
      { name: '2000m benchmark', machine: 'rower', plan: { type: 'distance', distanceM: 2000 } },
    ];
    const daySeed = Math.floor(Date.now() / 86400000);
    const ins = db.prepare('INSERT INTO workout_plans (id, creator_id, name, machine_type, plan_json, is_daily_suggestion, suggested_date, created_at) VALUES (?,NULL,?,?,?,1,?,?)');
    for (let k = 0; k < 3; k++) {
      const item = catalog[(daySeed + k * 2) % catalog.length];
      const v = validatePlan(item.plan);
      if (v.ok) ins.run(uuid(), item.name, item.machine, JSON.stringify(item.plan), date, now());
    }
    rows = db.prepare('SELECT * FROM workout_plans WHERE is_daily_suggestion = 1 AND suggested_date = ?').all(date);
  }
  res.json({ suggestions: rows.map(r => ({ id: r.id, name: r.name, machineType: r.machine_type, plan: safeJson(r.plan_json) })) });
});
