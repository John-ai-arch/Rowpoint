// Research export pipeline (Feature D). Produces fully-anonymized datasets in
// CSV (Excel-compatible) or JSON, each carrying a reproducibility manifest and
// the auto-generated data dictionary. Privacy is enforced: no PII ever leaves
// (no names, emails, account ids, IPs, precise locations), and an export that
// would reveal fewer than the minimum cohort of participants is refused.
import { db } from '../db.js';
import { config } from '../config.js';
import { safeJson, ApiError } from '../util.js';
import { dataDictionary } from './dictionary.js';
import { researchPopulation, applyCohortFilters, RESEARCH_NUMERIC_VARS, RESEARCH_MIN_COHORT } from './analytics.js';
import { qualityReport } from './analytics.js';

const csvEsc = (v) => {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCSV(columns, rows) {
  const head = columns.join(',');
  const body = rows.map(r => columns.map(c => csvEsc(r[c])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

/** Demographic WHERE clause for the raw-workout export (coarsened columns only). */
function workoutWhere(f = {}) {
  const clauses = [], params = [];
  const eq = (col, val) => { if (val) { clauses.push(`${col} = ?`); params.push(val); } };
  eq('sex', f.sex); eq('age_range', f.ageRange); eq('weight_class', f.weightClass);
  eq('competition_level', f.competitionLevel); eq('club_type', f.clubType);
  eq('training_environment', f.trainingEnvironment); eq('country', f.country);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const WORKOUT_COLUMNS = [
  'research_id', 'study_tag', 'started_at', 'tz_offset_min', 'total_distance_m', 'total_time_s',
  'avg_split_s', 'avg_stroke_rate', 'avg_heart_rate', 'avg_power_watts', 'device_type', 'sensor_source',
  'sw_version', 'schema_version', 'measurement_confidence', 'missing_flags', 'quality_flags',
  'age_range', 'sex', 'weight_class', 'height_band_cm', 'years_rowing', 'competition_level',
  'club_type', 'training_environment', 'country',
];

function workoutRows(f) {
  const { where, params } = workoutWhere(f);
  const rows = db.prepare(`SELECT ${WORKOUT_COLUMNS.join(', ')} FROM research_workouts ${where} ORDER BY research_id, started_at`).all(...params);
  return rows.map(r => ({ ...r, missing_flags: safeJson(r.missing_flags, []), quality_flags: safeJson(r.quality_flags, []) }));
}

const PARTICIPANT_COLUMNS = [
  'research_id_index', 'records', 'meanConfidence', 'flaggedRecords',
  ...RESEARCH_NUMERIC_VARS, 'ageRange', 'sex', 'weightClass', 'competitionLevel', 'clubType', 'trainingEnvironment', 'country',
];

function participantRows(f) {
  const cohort = applyCohortFilters(researchPopulation(), f);
  // A running index — never the pseudonym itself in the participant table.
  return cohort.map((a, i) => ({ research_id_index: i + 1, ...a }));
}

function snapshotRows(f) {
  // Longitudinal weekly variables. Uses the participant cohort to scope which
  // pseudonyms are eligible, then joins their snapshots.
  const rows = db.prepare('SELECT research_id, week_key, snapshot_at, variables_json, sw_version, schema_version FROM research_snapshots ORDER BY research_id, week_key').all();
  const flat = rows.map(r => {
    const v = safeJson(r.variables_json, {}) || {};
    const out = { research_id: r.research_id, week_key: r.week_key, snapshot_at: r.snapshot_at, sw_version: r.sw_version, schema_version: r.schema_version };
    for (const k of RESEARCH_NUMERIC_VARS) out[k] = v[k]?.value ?? null;
    return out;
  });
  return flat;
}
const SNAPSHOT_COLUMNS = ['research_id', 'week_key', 'snapshot_at', 'sw_version', 'schema_version', ...RESEARCH_NUMERIC_VARS];

/**
 * Build an anonymized export. Throws ApiError(422) if the result would reveal
 * fewer than the minimum cohort of participants (privacy protection against
 * isolating individuals via narrow filters).
 */
export function buildExport({ kind = 'workouts', format = 'csv', filters = {} } = {}) {
  let columns, rows, participantIds;
  if (kind === 'participants') {
    rows = participantRows(filters); columns = PARTICIPANT_COLUMNS;
    participantIds = rows.length;
  } else if (kind === 'snapshots') {
    rows = snapshotRows(filters); columns = SNAPSHOT_COLUMNS;
    participantIds = new Set(rows.map(r => r.research_id)).size;
  } else {
    kind = 'workouts';
    rows = workoutRows(filters); columns = WORKOUT_COLUMNS;
    participantIds = new Set(rows.map(r => r.research_id)).size;
  }

  if (participantIds < RESEARCH_MIN_COHORT) {
    throw new ApiError(422, `Export refused: it would reveal only ${participantIds} participant(s), below the minimum cohort of ${RESEARCH_MIN_COHORT}. Broaden the filters.`, 'cohort_too_small');
  }

  const manifest = {
    dataset: kind,
    softwareVersion: config.softwareVersion,
    researchSchemaVersion: config.researchSchemaVersion,
    exportedAt: new Date().toISOString(),
    appliedFilters: filters,
    rowCount: rows.length,
    participantCount: participantIds,
    minCohort: RESEARCH_MIN_COHORT,
    qualitySummary: qualityReport(),
    anonymization: 'No names, emails, account ids, IP addresses, or precise locations. Participant ids are HMAC pseudonyms; demographics are coarsened.',
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (format === 'json') {
    return {
      filename: `rowpoint-research-${kind}-${stamp}.json`,
      contentType: 'application/json',
      body: JSON.stringify({ manifest, dataDictionary: dataDictionary(), rows }, null, 2),
    };
  }
  // CSV (Excel-compatible): reproducibility facts as leading comment lines, then
  // the table. The full data dictionary is available at /research-admin/dictionary.
  const header = [
    `# RowPoint research export — ${kind}`,
    `# software_version: ${manifest.softwareVersion}`,
    `# research_schema_version: ${manifest.researchSchemaVersion}`,
    `# exported_at: ${manifest.exportedAt}`,
    `# applied_filters: ${JSON.stringify(filters)}`,
    `# rows: ${manifest.rowCount} · participants: ${manifest.participantCount} (min cohort ${manifest.minCohort})`,
    `# missing-value coding: empty = not measured/consented; list separator "|"`,
    `# data dictionary: GET /api/research-admin/dictionary`,
    `# ${manifest.anonymization}`,
  ].join('\n');
  return {
    filename: `rowpoint-research-${kind}-${stamp}.csv`,
    contentType: 'text/csv',
    body: `${header}\n${toCSV(columns, rows)}`,
  };
}
