// Training analysis engine — the data layer behind the AI coach.
//
// Everything here is deterministic, explainable computation over the athlete's
// real training history: volume, training-zone distribution, structure mix,
// heart-rate trends, pace progression, recovery patterns, compliance with
// previous recommendations, and risk flags (overtraining / undertraining /
// detraining / missing zones). The output is a compact, JSON-serializable
// picture of the athlete that the LLM coach (coach.js) reasons over — and that
// the deterministic fallback recommender uses when no LLM is configured.
import { db } from '../db.js';
import { todayStr, safeJson } from '../util.js';
import { effectiveMaxHr } from '../hr.js';

const DAY = 86400;

/* ------------------------------------------------------------------ */
/* Intensity-zone classification                                        */
/* ------------------------------------------------------------------ */

export const ZONES = ['ut2', 'ut1', 'threshold', 'vo2', 'sprint'];

export const ZONE_DESCRIPTIONS = {
  ut2: 'UT2 — low-intensity aerobic base (conversation pace)',
  ut1: 'UT1 — moderate aerobic endurance',
  threshold: 'AT — anaerobic threshold work',
  vo2: 'TR — VO2max / transport intervals',
  sprint: 'AN — anaerobic sprint / race-start work',
};

/**
 * Classify one workout into a training zone using, in order of reliability:
 *  1. pace relative to the athlete's 2k split (standard rowing pace bands),
 *  2. average HR as a % of max HR,
 *  3. workout structure (interval work length) as a last resort.
 */
export function classifyWorkoutZone(w, { best2kSeconds, maxHr } = {}) {
  const avgSplit = Number(w.avg_split_s);
  if (best2kSeconds && Number.isFinite(avgSplit) && avgSplit > 0) {
    const twoKSplit = best2kSeconds / 4;
    const delta = avgSplit - twoKSplit; // s/500m slower (+) or faster (-) than 2k pace
    if (delta >= 16) return 'ut2';
    if (delta >= 10) return 'ut1';
    if (delta >= 5) return 'threshold';
    if (delta >= 0) return 'vo2';
    return 'sprint';
  }
  const avgHr = Number(w.avg_heart_rate);
  if (maxHr && Number.isFinite(avgHr) && avgHr > 0) {
    const pct = avgHr / maxHr;
    if (pct < 0.70) return 'ut2';
    if (pct < 0.80) return 'ut1';
    if (pct < 0.87) return 'threshold';
    if (pct < 0.93) return 'vo2';
    return 'sprint';
  }
  // Structure-only guess: short interval work skews anaerobic, long steady aerobic.
  const plan = typeof w.workout_plan_json === 'string' ? safeJson(w.workout_plan_json) : w.workout_plan_json;
  if (plan?.type === 'intervals') {
    const first = plan.intervals?.[0];
    const workS = first?.workType === 'time' ? Number(first.workTimeS)
      : first?.workType === 'distance' ? Number(first.workDistanceM) / 4 // rough s at ~2:00/500m
        : 120;
    if (workS <= 75) return 'sprint';
    if (workS <= 300) return 'vo2';
    return 'threshold';
  }
  const mins = (Number(w.total_time_s) || 0) / 60;
  return mins >= 40 ? 'ut2' : 'ut1';
}

export function workoutStructure(w) {
  const plan = typeof w.workout_plan_json === 'string' ? safeJson(w.workout_plan_json) : w.workout_plan_json;
  if (plan?.type === 'intervals') return 'intervals';
  if (plan?.type === 'time' || plan?.type === 'distance') return 'steady';
  return 'justrow';
}

const isHardZone = (z) => z === 'threshold' || z === 'vo2' || z === 'sprint';

/* ------------------------------------------------------------------ */
/* Pure analysis core (unit-testable without a database)                */
/* ------------------------------------------------------------------ */

/**
 * @param {Array} workouts   workout rows, ANY order (sorted internally),
 *                           each { started_at, total_distance_m, total_time_s,
 *                           avg_split_s, avg_stroke_rate, avg_heart_rate,
 *                           max_heart_rate, machine_type, workout_plan_json,
 *                           hr_zones_json, ai_feedback_json, assigned_by_coach_id }
 * @param {object} athlete   { best2kSeconds, maxHr }
 * @param {number} nowS      unix seconds "now" (injectable for tests)
 */
export function analyzeWorkouts(workouts, athlete = {}, nowS = Math.floor(Date.now() / 1000)) {
  const rows = (workouts || [])
    .filter(w => Number.isFinite(Number(w.started_at)))
    .sort((a, b) => a.started_at - b.started_at)
    .map(w => {
      const zone = classifyWorkoutZone(w, athlete);
      const hrZones = typeof w.hr_zones_json === 'string' ? safeJson(w.hr_zones_json) : w.hr_zones_json;
      const feedback = typeof w.ai_feedback_json === 'string' ? safeJson(w.ai_feedback_json) : w.ai_feedback_json;
      return {
        ...w, zone,
        structure: workoutStructure(w),
        minutes: (Number(w.total_time_s) || 0) / 60,
        meters: Number(w.total_distance_m) || 0,
        driftPct: hrZones?.driftPct ?? null,
        pacingTag: feedback?.classification ?? null,
        ageDays: (nowS - w.started_at) / DAY,
      };
    });

  const within = (days) => rows.filter(r => r.ageDays <= days);
  const between = (fromDays, toDays) => rows.filter(r => r.ageDays > toDays && r.ageDays <= fromDays);

  const volume = (set) => ({
    sessions: set.length,
    meters: Math.round(set.reduce((s, r) => s + r.meters, 0)),
    minutes: Math.round(set.reduce((s, r) => s + r.minutes, 0)),
    avgSplitS: avgOf(set.map(r => r.avg_split_s)),
  });

  const last7 = within(7), last28 = within(28), prev28 = between(56, 28);

  /* ---- training distribution over the last 28 days ---- */
  const zoneMinutes = Object.fromEntries(ZONES.map(z => [z, 0]));
  const structureMinutes = { steady: 0, intervals: 0, justrow: 0 };
  const machineMinutes = {};
  let longSessions = 0, shortSessions = 0;
  for (const r of last28) {
    zoneMinutes[r.zone] += r.minutes;
    structureMinutes[r.structure] += r.minutes;
    const m = r.machine_type || 'rower';
    machineMinutes[m] = (machineMinutes[m] || 0) + r.minutes;
    if (r.minutes >= 45) longSessions++; else if (r.minutes > 0 && r.minutes < 25) shortSessions++;
  }
  const totalMin28 = Object.values(zoneMinutes).reduce((a, b) => a + b, 0);
  const zonePct = Object.fromEntries(ZONES.map(z =>
    [z, totalMin28 ? Math.round((zoneMinutes[z] / totalMin28) * 100) : 0]));
  const aerobicPct = zonePct.ut2 + zonePct.ut1;
  const anaerobicPct = zonePct.threshold + zonePct.vo2 + zonePct.sprint;

  // Zones the athlete has effectively ignored recently (given enough volume
  // for a distribution to be meaningful at all).
  const missingZones = totalMin28 >= 90
    ? ZONES.filter(z => zonePct[z] <= 3)
    : [];

  /* ---- recovery & hard-session spacing ---- */
  const hardRows = rows.filter(r => isHardZone(r.zone));
  const hardLast7 = last7.filter(r => isHardZone(r.zone)).length;
  const recentHard = hardRows.filter(r => r.ageDays <= 28);
  let avgRecoveryDaysBetweenHard = null;
  if (recentHard.length >= 2) {
    let gaps = 0;
    for (let i = 1; i < recentHard.length; i++) gaps += (recentHard[i].started_at - recentHard[i - 1].started_at) / DAY;
    avgRecoveryDaysBetweenHard = round1(gaps / (recentHard.length - 1));
  }
  const daysSinceLastWorkout = rows.length ? round1((nowS - rows[rows.length - 1].started_at) / DAY) : null;
  const daysSinceLastHard = hardRows.length ? round1((nowS - hardRows[hardRows.length - 1].started_at) / DAY) : null;

  /* ---- load trend: acute (7d) vs chronic (28d weekly average) ---- */
  const acute = volume(last7).minutes;
  const chronicWeekly = volume(last28).minutes / 4;
  const acuteChronicRatio = chronicWeekly > 15 ? round1(acute / chronicWeekly) : null;

  /* ---- heart-rate trends ---- */
  const withHr = rows.filter(r => Number.isFinite(Number(r.avg_heart_rate)) && r.avg_heart_rate > 0);
  const withDrift = rows.filter(r => Number.isFinite(r.driftPct));
  const driftRecent = avgOf(withDrift.filter(r => r.ageDays <= 21).map(r => r.driftPct));
  const driftPrev = avgOf(withDrift.filter(r => r.ageDays > 21 && r.ageDays <= 56).map(r => r.driftPct));
  // Aerobic efficiency: pace-per-heartbeat on aerobic sessions, recent vs prior.
  // Lower s/500m at the same HR (higher efficiency index) = fitter engine.
  const effIndex = (set) => {
    const pts = set.filter(r => (r.zone === 'ut2' || r.zone === 'ut1')
      && Number.isFinite(Number(r.avg_heart_rate)) && r.avg_heart_rate > 0
      && Number.isFinite(Number(r.avg_split_s)) && r.avg_split_s > 0);
    if (!pts.length) return null;
    // meters/min per bpm — normalizes speed by cardiovascular cost.
    return round2(avgOf(pts.map(r => (30000 / r.avg_split_s) / r.avg_heart_rate)));
  };
  const efficiencyRecent = effIndex(rows.filter(r => r.ageDays <= 21));
  const efficiencyPrev = effIndex(rows.filter(r => r.ageDays > 21 && r.ageDays <= 56));

  /* ---- pace progression on comparable (steady aerobic) work ---- */
  const steadyPace = (set) => avgOf(set
    .filter(r => (r.zone === 'ut2' || r.zone === 'ut1') && Number.isFinite(Number(r.avg_split_s)) && r.avg_split_s > 0)
    .map(r => r.avg_split_s));
  const steadyPaceRecent = steadyPace(rows.filter(r => r.ageDays <= 21));
  const steadyPacePrev = steadyPace(rows.filter(r => r.ageDays > 21 && r.ageDays <= 56));
  let paceTrend = 'insufficient_data';
  if (steadyPaceRecent && steadyPacePrev) {
    const d = steadyPacePrev - steadyPaceRecent; // + means faster now
    paceTrend = d >= 1 ? 'improving' : d <= -1 ? 'declining' : 'stable';
  }

  /* ---- pacing habit from post-workout classifications ---- */
  const tagged = rows.filter(r => r.pacingTag && r.pacingTag !== 'insufficient_data').slice(-10);
  const tooHardCount = tagged.filter(r => r.pacingTag === 'started_too_hard').length;
  const chronicStartsTooHard = tagged.length >= 3 && tooHardCount >= Math.ceil(tagged.length / 2);

  /* ---- personal records ---- */
  const finiteMax = (vals) => { const f = vals.filter(Number.isFinite); return f.length ? Math.max(...f) : null; };
  const prs = {
    longestMeters: finiteMax(rows.map(r => r.meters)),
    longestMinutes: round1(finiteMax(rows.map(r => r.minutes))),
    fastestAvgSplitS: rows.length
      ? round1(Math.min(...rows.filter(r => Number.isFinite(Number(r.avg_split_s)) && r.avg_split_s > 0 && r.meters >= 500).map(r => r.avg_split_s).concat([Infinity])))
      : null,
    maxHeartRate: finiteMax(rows.map(r => Number(r.max_heart_rate))),
  };
  if (!Number.isFinite(prs.fastestAvgSplitS)) prs.fastestAvgSplitS = null;

  /* ---- risk flags ---- */
  const flags = {
    // Load ramping much faster than the body is used to.
    rampTooFast: acuteChronicRatio !== null && acuteChronicRatio >= 1.5,
    // Stacked hard sessions with little spacing.
    hardStacking: hardLast7 >= 3 || (avgRecoveryDaysBetweenHard !== null && avgRecoveryDaysBetweenHard < 1.5 && recentHard.length >= 3),
    // Effectively detrained / returning after a break.
    returningFromBreak: daysSinceLastWorkout !== null && daysSinceLastWorkout >= 5,
    // Not training enough to progress against any goal.
    undertraining: last28.length > 0 && volume(last28).minutes < 120 && !(daysSinceLastWorkout >= 5),
    // Monotony: nearly everything in one zone.
    monotonous: totalMin28 >= 150 && Math.max(...Object.values(zonePct)) >= 85,
    // Cardiovascular strain signal: HR drifting up across sessions.
    highDrift: driftRecent !== null && driftRecent >= 6,
  };

  return {
    generatedAt: nowS,
    history: {
      totalWorkouts: rows.length,
      firstWorkoutAt: rows[0]?.started_at ?? null,
      lifetimeMeters: Math.round(rows.reduce((s, r) => s + r.meters, 0)),
      lifetimeHours: round1(rows.reduce((s, r) => s + r.minutes, 0) / 60),
    },
    volume: {
      last7d: volume(last7),
      last28d: volume(last28),
      prev28d: volume(prev28),
      acuteChronicRatio,
      weeklyAvgMinutes28d: Math.round(chronicWeekly),
    },
    distribution28d: {
      zoneMinutes: mapVals(zoneMinutes, Math.round),
      zonePct,
      aerobicPct,
      anaerobicPct,
      structureMinutes: mapVals(structureMinutes, Math.round),
      machineMinutes: mapVals(machineMinutes, Math.round),
      longSessions,
      shortSessions,
      missingZones,
    },
    recovery: {
      daysSinceLastWorkout,
      daysSinceLastHard,
      hardSessionsLast7d: hardLast7,
      avgRecoveryDaysBetweenHard,
    },
    heartRate: {
      workoutsWithHr: withHr.length,
      avgHrRecent: avgOf(withHr.filter(r => r.ageDays <= 21).map(r => r.avg_heart_rate)),
      driftRecentPct: driftRecent,
      driftPrevPct: driftPrev,
      driftTrend: driftRecent !== null && driftPrev !== null
        ? (driftPrev - driftRecent >= 1 ? 'improving' : driftRecent - driftPrev >= 1 ? 'worsening' : 'stable')
        : 'insufficient_data',
      aerobicEfficiencyRecent: efficiencyRecent,
      aerobicEfficiencyPrev: efficiencyPrev,
      aerobicEfficiencyTrend: efficiencyRecent !== null && efficiencyPrev !== null
        ? (efficiencyRecent - efficiencyPrev >= 0.05 ? 'improving' : efficiencyPrev - efficiencyRecent >= 0.05 ? 'declining' : 'stable')
        : 'insufficient_data',
    },
    paceProgression: {
      steadyPaceRecentS: steadyPaceRecent,
      steadyPacePrevS: steadyPacePrev,
      trend: paceTrend,
    },
    pacingHabit: { chronicStartsTooHard, recentTags: tagged.map(r => r.pacingTag) },
    prs,
    flags,
    // Compact recent-workout log for the LLM (most recent first, capped).
    recentWorkouts: rows.slice(-15).reverse().map(r => ({
      date: new Date(r.started_at * 1000).toISOString().slice(0, 10),
      zone: r.zone,
      structure: r.structure,
      machine: r.machine_type || 'rower',
      meters: Math.round(r.meters),
      minutes: round1(r.minutes),
      avgSplitS: round1(r.avg_split_s),
      avgStrokeRate: round1(r.avg_stroke_rate),
      avgHr: round1(r.avg_heart_rate),
      maxHr: round1(r.max_heart_rate),
      hrDriftPct: r.driftPct,
      pacing: r.pacingTag,
      coachAssigned: !!r.assigned_by_coach_id,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Full DB-backed gather                                                */
/* ------------------------------------------------------------------ */

/** Everything the coach needs about one athlete, gathered from the database. */
export function buildTrainingAnalysis(user, nowS = Math.floor(Date.now() / 1000)) {
  const since = nowS - 180 * DAY; // six months of history is plenty of signal
  const workouts = db.prepare(
    `SELECT started_at, total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
            avg_heart_rate, max_heart_rate, machine_type, workout_plan_json,
            hr_zones_json, ai_feedback_json, assigned_by_coach_id
     FROM workouts WHERE user_id = ? AND started_at >= ? ORDER BY started_at`)
    .all(user.id, since);

  const maxHr = effectiveMaxHr(user);
  const analysis = analyzeWorkouts(workouts, { best2kSeconds: user.best_2k_seconds, maxHr }, nowS);

  /* ---- wellness (last 14 days) ---- */
  const wellSince = todayStr(nowS * 1000 - 14 * DAY * 1000);
  const wl = db.prepare(
    `SELECT AVG(sleep_hours) AS sleep, AVG(soreness_level) AS soreness, AVG(stress_level) AS stress,
            COUNT(*) AS n
     FROM wellness_checkins WHERE user_id = ? AND date >= ?`).get(user.id, wellSince);
  const riskDays = db.prepare(
    `SELECT COUNT(*) AS n FROM wellness_checkins
     WHERE user_id = ? AND date >= ? AND sleep_hours < 6 AND soreness_level >= 4`).get(user.id, wellSince);

  /* ---- compliance with previous recommendations ---- */
  const suggestions = db.prepare(
    `SELECT date, structured_json FROM ai_suggestions
     WHERE user_id = ? AND date >= ? AND date < ? ORDER BY date DESC LIMIT 30`)
    .all(user.id, todayStr(nowS * 1000 - 30 * DAY * 1000), todayStr(nowS * 1000));
  let followed = 0;
  for (const s of suggestions) {
    const structured = safeJson(s.structured_json) || {};
    const dayStart = Math.floor(new Date(`${s.date}T00:00:00Z`).getTime() / 1000);
    const workedOut = db.prepare(
      'SELECT COUNT(*) AS n FROM workouts WHERE user_id = ? AND started_at >= ? AND started_at < ?')
      .get(user.id, dayStart, dayStart + DAY).n > 0;
    // A rest-day recommendation is "followed" by NOT training; anything else by training.
    if (structured.restDay ? !workedOut : workedOut) followed++;
  }

  /* ---- coach assignment today (the coach's plan always wins) ---- */
  const today = todayStr(nowS * 1000);
  const assignmentToday = db.prepare(
    `SELECT a.id FROM assignments a JOIN team_members m ON m.team_id = a.team_id
     WHERE m.user_id = ? AND a.scheduled_date = ?
       AND NOT EXISTS (SELECT 1 FROM workouts w WHERE w.assignment_id = a.id AND w.user_id = m.user_id)
     LIMIT 1`).get(user.id, today);

  const overtrainingRisk = riskDays.n >= 3
    || (analysis.flags.hardStacking && wl.soreness !== null && wl.soreness >= 3.5)
    || (analysis.flags.rampTooFast && analysis.flags.highDrift);

  const daysToEvent = user.goal_target_date
    ? Math.round((new Date(user.goal_target_date).getTime() / 1000 - nowS) / DAY)
    : null;

  return {
    athlete: {
      accountType: user.account_type,
      age: user.birth_year ? new Date(nowS * 1000).getFullYear() - user.birth_year : null,
      weightKg: user.weight_kg ?? null,
      weightClass: user.weight_class ?? null,
      best2kSeconds: user.best_2k_seconds ?? null,
      best2kSplitS: user.best_2k_seconds ? round1(user.best_2k_seconds / 4) : null,
      best2kVerified: !!user.best_2k_verified,
      maxHr,
      restingHr: user.resting_hr ?? null,
      goal: {
        type: user.goal_type || 'general_fitness',
        targetEvent: user.goal_target_event ?? null,
        targetDate: user.goal_target_date ?? null,
        daysToEvent,
        weeklySessions: user.goal_weekly_sessions ?? null,
        weeklyMinutes: user.goal_weekly_minutes ?? null,
      },
    },
    ...analysis,
    wellness: {
      checkins14d: wl.n || 0,
      avgSleepHours: round1(wl.sleep),
      avgSoreness: round1(wl.soreness),
      avgStress: round1(wl.stress),
      lowSleepHighSorenessDays: riskDays.n || 0,
    },
    compliance: {
      suggestionsLast30d: suggestions.length,
      followed,
      followRatePct: suggestions.length ? Math.round((followed / suggestions.length) * 100) : null,
    },
    constraints: {
      hasCoachAssignmentToday: !!assignmentToday,
      overtrainingRisk,
    },
  };
}

/* ------------------------------------------------------------------ */

function avgOf(vals) {
  const f = vals.map(Number).filter(v => Number.isFinite(v) && v > 0);
  return f.length ? round1(f.reduce((a, b) => a + b, 0) / f.length) : null;
}
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const round2 = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
const mapVals = (o, fn) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v)]));
