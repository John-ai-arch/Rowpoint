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
import { config } from './config.js';
import { uuid, now, researchId, safeJson } from './util.js';
import { qualityFlags } from './research/quality.js';
import { computeResearchVariables } from './research/variables.js';
import { isoWeekKey } from './groups.js';

/**
 * Append a weekly longitudinal snapshot of the standardized research variables
 * for this pseudonymous athlete, at most once per study per ISO week (older
 * weeks are preserved — never overwritten). Best-effort; never throws into the
 * contribution path.
 */
function writeSnapshotIfDue(rid, nowS) {
  try {
    const weekKey = isoWeekKey(nowS);
    for (const tag of activeStudyTags()) {
      const exists = db.prepare('SELECT 1 FROM research_snapshots WHERE research_id = ? AND study_tag = ? AND week_key = ?').get(rid, tag, weekKey);
      if (exists) continue;
      const rows = db.prepare(
        `SELECT started_at, total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
                avg_heart_rate, hr_zones_json FROM research_workouts
         WHERE research_id = ? AND study_tag = ?`).all(rid, tag);
      const vars = computeResearchVariables(rows, nowS);
      db.prepare(`INSERT INTO research_snapshots
          (id, research_id, study_tag, week_key, snapshot_at, variables_json, sw_version, schema_version, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(uuid(), rid, tag, weekKey, nowS, JSON.stringify(vars), config.softwareVersion, config.researchSchemaVersion, nowS);
    }
  } catch { /* snapshots must never break contribution */ }
}

function activeStudyTags() {
  return db.prepare('SELECT tag FROM studies WHERE active = 1').all().map(r => r.tag);
}

const birthDecade = (year) => Number.isFinite(year) ? Math.floor(year / 10) * 10 : null;

// Coarse, privacy-preserving demographic bands (no single field is a
// quasi-identifier). Age uses broad life-stage bands; height uses 5 cm bands.
function ageRange(birthYear, nowS) {
  if (!Number.isFinite(birthYear)) return null;
  const age = new Date(nowS * 1000).getUTCFullYear() - birthYear;
  if (age < 18) return 'under_18';
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  if (age <= 54) return '45-54';
  if (age <= 64) return '55-64';
  return '65_plus';
}
const heightBand = (cm) => (Number.isFinite(cm) && cm > 0 ? Math.round(cm / 5) * 5 : null);

// Fraction of the core measures actually present → a data-completeness score,
// plus an explicit list of which measures were missing (never silently null).
function completeness(workout, splits) {
  const checks = {
    distance: Number.isFinite(workout.total_distance_m) && workout.total_distance_m > 0,
    time: Number.isFinite(workout.total_time_s) && workout.total_time_s > 0,
    pace: Number.isFinite(workout.avg_split_s) && workout.avg_split_s > 0,
    strokeRate: Number.isFinite(workout.avg_stroke_rate) && workout.avg_stroke_rate > 0,
    heartRate: Number.isFinite(workout.avg_heart_rate) && workout.avg_heart_rate > 0,
    power: Number.isFinite(workout.avg_power_watts) && workout.avg_power_watts > 0,
    splits: Array.isArray(splits) && splits.length > 0,
  };
  const present = Object.values(checks).filter(Boolean).length;
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { confidence: Math.round((present / Object.keys(checks).length) * 100) / 100, missing };
}

export function contributeWorkout(user, workout, splits, provenance = {}) {
  if (!user.research_opt_in) return { contributed: false, reason: 'opted_out' };
  if (!user.email_verified) return { contributed: false, reason: 'unverified' };
  const rid = researchId(user.id);
  const tags = activeStudyTags();
  const nowS = now();
  const stmt = db.prepare(`INSERT INTO research_workouts (
      id, research_id, study_tag, machine_type, workout_type, started_at,
      total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
      avg_heart_rate, avg_power_watts, splits_json, birth_decade, weight_class,
      goal_type, max_heart_rate, min_heart_rate, hr_zones_json, hr_drift_pct,
      hr_series_json, equipment,
      sw_version, schema_version, tz_offset_min, device_type, sensor_source,
      firmware_version, measurement_confidence, missing_flags, quality_flags,
      age_range, sex, height_band_cm, years_rowing, competition_level,
      club_type, training_environment, country,
      contributed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const splitsJson = JSON.stringify((splits || []).map(s => ({
    i: s.split_index, d: s.distance_m, t: s.time_s, p: s.avg_pace_s_per_500m,
    r: s.avg_stroke_rate, h: s.avg_heart_rate, w: s.avg_power_watts,
  })));
  const workoutType = safeJson(workout.workout_plan_json)?.type || 'justrow';

  // Equipment descriptor: the machine class plus a coarse connection kind —
  // never the raw peripheral id, which could fingerprint a specific gym.
  const equipment = [workout.machine_type || 'rower', workout.machine_id ? 'ble_monitor' : 'manual'].join('/');
  const sensorSource = provenance.sensorSource
    || (workout.machine_id ? (workout.machine_type === 'bike' ? 'ble_ftms' : 'ble_pm') : 'manual');
  const deviceType = ['web', 'ios', 'android'].includes(provenance.deviceType) ? provenance.deviceType : 'web';
  const tzOffset = Number.isFinite(Number(provenance.tzOffsetMin)) ? Math.trunc(Number(provenance.tzOffsetMin)) : null;

  const hrZones = safeJson(workout.hr_zones_json);
  const hrZonesOut = hrZones ? JSON.stringify({ zoneSeconds: hrZones.zoneSeconds }) : null;
  const shareDemographics = !!user.research_share_demographics;
  const { confidence, missing } = completeness(workout, splits);
  const flags = qualityFlags(workout, splits);

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
      equipment,
      config.softwareVersion, config.researchSchemaVersion, tzOffset, deviceType, sensorSource,
      provenance.firmwareVersion || null, confidence, JSON.stringify(missing), JSON.stringify(flags),
      shareDemographics ? ageRange(user.birth_year, nowS) : null,
      shareDemographics ? (user.sex || null) : null,
      shareDemographics ? heightBand(user.height_cm) : null,
      shareDemographics ? (user.years_rowing ?? null) : null,
      shareDemographics ? (user.competition_level || null) : null,
      shareDemographics ? (user.club_type || null) : null,
      shareDemographics ? (user.training_environment || null) : null,
      shareDemographics ? (user.country || null) : null,
      nowS);
  }
  writeSnapshotIfDue(rid, nowS);
  return { contributed: tags.length > 0, studies: tags, confidence, missing, qualityFlags: flags };
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
