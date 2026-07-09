// Personal Analytics Laboratory data (vision #13). Turns the athlete's workout
// history into the datasets professional sports-science tools plot: pace vs
// stroke rate, heart-rate vs split, training-zone distribution, and weekly
// load. Reuses the same zone classifier the coach uses — no new analysis logic.
import { db } from '../db.js';
import { classifyWorkoutZone, ZONES } from './trainingAnalysis.js';
import { effectiveMaxHr } from '../hr.js';

const DAY = 86400;

export function buildTrainingLab(user, nowS = Math.floor(Date.now() / 1000)) {
  const since = nowS - 180 * DAY;
  const rows = db.prepare(
    `SELECT started_at, total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
            avg_heart_rate, workout_plan_json
     FROM workouts WHERE user_id = ? AND started_at >= ? ORDER BY started_at`).all(user.id, since);
  const athlete = { best2kSeconds: user.best_2k_seconds, maxHr: effectiveMaxHr(user) };

  const points = rows.map(w => ({
    at: w.started_at,
    split: Number.isFinite(w.avg_split_s) && w.avg_split_s > 0 ? Math.round(w.avg_split_s * 10) / 10 : null,
    rate: Number.isFinite(w.avg_stroke_rate) && w.avg_stroke_rate > 0 ? Math.round(w.avg_stroke_rate) : null,
    hr: Number.isFinite(w.avg_heart_rate) && w.avg_heart_rate > 0 ? Math.round(w.avg_heart_rate) : null,
    meters: Math.round(w.total_distance_m || 0),
    minutes: Math.round((w.total_time_s || 0) / 60),
    zone: classifyWorkoutZone(w, athlete),
  }));

  // Training-zone distribution over the last 90 days (time-in-zone).
  const cut90 = nowS - 90 * DAY;
  const zoneMinutes = Object.fromEntries(ZONES.map(z => [z, 0]));
  for (const p of points) if (p.at >= cut90) zoneMinutes[p.zone] += p.minutes;
  const totalZ = Object.values(zoneMinutes).reduce((a, b) => a + b, 0) || 1;
  const zonePct = Object.fromEntries(ZONES.map(z => [z, Math.round((zoneMinutes[z] / totalZ) * 100)]));

  // Weekly load, last 12 weeks (oldest → newest).
  const weeklyLoad = [];
  for (let i = 11; i >= 0; i--) {
    const ws = nowS - (i + 1) * 7 * DAY, we = nowS - i * 7 * DAY;
    const meters = points.filter(p => p.at >= ws && p.at < we).reduce((s, p) => s + p.meters, 0);
    weeklyLoad.push({ weeksAgo: i, meters: Math.round(meters) });
  }

  return {
    hasData: points.length > 0,
    workouts90d: points.filter(p => p.at >= cut90).length,
    scatter: points.filter(p => p.at >= cut90),
    zoneMinutes, zonePct, totalZoneMinutes: totalZ,
    weeklyLoad,
    // aerobic/anaerobic split for the headline (80/20 rule of thumb).
    aerobicPct: zonePct.ut2 + zonePct.ut1,
    anaerobicPct: zonePct.threshold + zonePct.vo2 + zonePct.sprint,
  };
}
