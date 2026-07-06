// §5.2 — Research contribution pipeline.
// Separate storage keyed by pseudonymous research_id; opt-in status checked at
// WRITE time (not signup time) so a later opt-out is respected immediately.
// Each record carries a study tag; contributions are written once per active
// study so the admin dashboard can filter per experiment (engineering choice:
// row-per-study rather than tables-per-study, as suggested by the spec).
//
// What is contributed per workout (all pseudonymous):
//  - workout type, distance, duration, pace, stroke rate, power, timestamp
//  - equipment (machine type + stable peripheral kind, never a raw device id)
//  - full heart-rate detail when available: avg/max/min, time-in-zone,
//    within-session drift, and the timestamped sample series
//  - demographics (birth decade, weight class) ONLY when the athlete has the
//    separate demographics consent enabled, independent of the main toggle.
import { db } from './db.js';
import { uuid, now, researchId, safeJson } from './util.js';

function activeStudyTags() {
  return db.prepare('SELECT tag FROM studies WHERE active = 1').all().map(r => r.tag);
}

const birthDecade = (year) => Number.isFinite(year) ? Math.floor(year / 10) * 10 : null;

export function contributeWorkout(user, workout, splits) {
  if (!user.research_opt_in) return { contributed: false, reason: 'opted_out' };
  if (!user.email_verified) return { contributed: false, reason: 'unverified' };
  const rid = researchId(user.id);
  const tags = activeStudyTags();
  const stmt = db.prepare(`INSERT INTO research_workouts (
      id, research_id, study_tag, machine_type, workout_type, started_at,
      total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
      avg_heart_rate, avg_power_watts, splits_json, birth_decade, weight_class,
      goal_type, max_heart_rate, min_heart_rate, hr_zones_json, hr_drift_pct,
      hr_series_json, equipment, contributed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const splitsJson = JSON.stringify((splits || []).map(s => ({
    i: s.split_index, d: s.distance_m, t: s.time_s, p: s.avg_pace_s_per_500m,
    r: s.avg_stroke_rate, h: s.avg_heart_rate, w: s.avg_power_watts,
  })));
  const workoutType = safeJson(workout.workout_plan_json)?.type || 'justrow';

  // Equipment descriptor: the machine class plus a coarse connection kind —
  // never the raw peripheral id, which could fingerprint a specific gym.
  const equipment = [workout.machine_type || 'rower', workout.machine_id ? 'ble_monitor' : 'manual']
    .join('/');

  // HR detail travels with the contribution only when it exists; the zone
  // summary keeps zoneSeconds + drift but drops the athlete's max-HR setting
  // used for the calculation (a quasi-identifier when combined with age).
  const hrZones = safeJson(workout.hr_zones_json);
  const hrZonesOut = hrZones ? JSON.stringify({ zoneSeconds: hrZones.zoneSeconds }) : null;
  const shareDemographics = !!user.research_share_demographics;

  for (const tag of tags) {
    stmt.run(uuid(), rid, tag, workout.machine_type, workoutType, workout.started_at,
      workout.total_distance_m, workout.total_time_s, workout.avg_split_s,
      workout.avg_stroke_rate, workout.avg_heart_rate, workout.avg_power_watts,
      splitsJson,
      shareDemographics ? birthDecade(user.birth_year) : null,
      shareDemographics ? user.weight_class : null,
      user.goal_type,
      workout.max_heart_rate ?? null, workout.min_heart_rate ?? null,
      hrZonesOut, hrZones?.driftPct ?? null,
      workout.hr_series_json ?? null,
      equipment, now());
  }
  return { contributed: tags.length > 0, studies: tags };
}

export function contributeWellness(user, checkin) {
  if (!user.research_opt_in) return { contributed: false, reason: 'opted_out' };
  if (!user.email_verified) return { contributed: false, reason: 'unverified' };
  const rid = researchId(user.id);
  const tags = activeStudyTags();
  // Same-day edits replace the earlier contribution rather than duplicating.
  const del = db.prepare('DELETE FROM research_wellness WHERE research_id = ? AND date = ? AND study_tag = ?');
  const ins = db.prepare(`INSERT INTO research_wellness
      (id, research_id, study_tag, date, sleep_hours, sleep_quality, soreness_level, stress_level, contributed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const tag of tags) {
    del.run(rid, checkin.date, tag);
    ins.run(uuid(), rid, tag, checkin.date, checkin.sleep_hours, checkin.sleep_quality,
      checkin.soreness_level, checkin.stress_level, now());
  }
  return { contributed: tags.length > 0, studies: tags };
}
