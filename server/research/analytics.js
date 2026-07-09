// Research analytics engine (Feature C) — the admin-only research platform's
// computation core. Builds an anonymous per-participant dataset from
// research_workouts (pseudonymous, opt-in only), then derives participant
// summaries, data-quality reports, variable distributions, correlation
// matrices, cohort comparisons, and longitudinal trends.
//
// Privacy is enforced HERE, not just in the UI: a hard minimum cohort size
// gates every statistic and demographic cell, so no small (re-identifiable)
// group is ever revealed. Aggregates only — never a participant row or id.
// Expensive rollups are cached (TTL) for scalability.
import { db } from '../db.js';
import { computeResearchVariables } from './variables.js';
import { safeJson } from '../util.js';

const MIN_COHORT = 8;
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, pop: null };

export function invalidateResearchCache() { cache = { at: 0, pop: null }; }

// The numeric research variables exposed to distributions/correlations. Kept in
// one place so the dashboard, exports, and data dictionary stay consistent.
export const RESEARCH_NUMERIC_VARS = [
  'weeklyMeters', 'weeklySessions', 'rolling7dLoadMin', 'rolling28dLoadMin',
  'acuteChronicWorkloadRatio', 'trainingMonotony', 'trainingStrain',
  'strokeRateMean', 'daysBetweenWorkouts', 'consistencyScore', 'best2kSeconds',
];

/** One anonymous record per opted-in participant: full variables + demographics + quality. */
function buildPopulation() {
  const ids = db.prepare('SELECT DISTINCT research_id FROM research_workouts').all().map(r => r.research_id);
  const nowS = Math.floor(Date.now() / 1000);
  const out = [];
  const wStmt = db.prepare(
    `SELECT started_at, total_distance_m, total_time_s, avg_split_s, avg_stroke_rate,
            avg_heart_rate, hr_zones_json, measurement_confidence, missing_flags, quality_flags,
            age_range, sex, weight_class, competition_level, club_type, training_environment,
            country, height_band_cm, years_rowing, device_type, sensor_source
     FROM research_workouts WHERE research_id = ?`);
  for (const rid of ids) {
    const rows = wStmt.all(rid);
    if (!rows.length) continue;
    const vars = computeResearchVariables(rows, nowS);
    const last = rows[rows.length - 1];
    const flatVars = {};
    for (const k of RESEARCH_NUMERIC_VARS) flatVars[k] = vars[k]?.value ?? null;
    const conf = rows.map(r => r.measurement_confidence).filter(v => Number.isFinite(v));
    const flagCount = rows.reduce((s, r) => s + (safeJson(r.quality_flags, [])?.length || 0), 0);
    out.push({
      ...flatVars,
      records: rows.length,
      meanConfidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null,
      flaggedRecords: rows.filter(r => (safeJson(r.quality_flags, [])?.length || 0) > 0).length,
      flagCount,
      // demographics (coarsened at write time)
      ageRange: last.age_range, sex: last.sex, weightClass: last.weight_class,
      competitionLevel: last.competition_level, clubType: last.club_type,
      trainingEnvironment: last.training_environment, country: last.country,
    });
  }
  return out;
}

function population() {
  if (cache.pop && Date.now() - cache.at < CACHE_TTL_MS) return cache.pop;
  cache = { at: Date.now(), pop: buildPopulation() };
  return cache.pop;
}

export function applyCohortFilters(pop, f = {}) {
  return pop.filter(a => {
    if (f.sex && a.sex !== f.sex) return false;
    if (f.ageRange && a.ageRange !== f.ageRange) return false;
    if (f.weightClass && a.weightClass !== f.weightClass) return false;
    if (f.competitionLevel && a.competitionLevel !== f.competitionLevel) return false;
    if (f.clubType && a.clubType !== f.clubType) return false;
    if (f.trainingEnvironment && a.trainingEnvironment !== f.trainingEnvironment) return false;
    if (f.country && a.country !== f.country) return false;
    if (f.minWeeklyMeters && !(a.weeklyMeters >= Number(f.minWeeklyMeters))) return false;
    return true;
  });
}

/* -------- stats helpers -------- */
const nums = (a) => a.filter(v => Number.isFinite(v));
function quantiles(values) {
  const v = nums(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)) : null;
  return { n: v.length, min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: v[v.length - 1], mean: round(m), sd: round(sd) };
}
function histogram(values, bins = 12) {
  const v = nums(values); if (v.length < MIN_COHORT) return null;
  const min = Math.min(...v), max = Math.max(...v);
  if (max === min) return { min, max, bins: [{ x0: min, x1: max, count: v.length }] };
  const w = (max - min) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ x0: round(min + i * w), x1: round(min + (i + 1) * w), count: 0 }));
  for (const x of v) out[Math.min(bins - 1, Math.floor((x - min) / w))].count++;
  return { min, max, bins: out };
}
function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < MIN_COHORT) return null;
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return { r: round(sxy / Math.sqrt(sxx * syy), 3), n };
}
const round = (n, p = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);

/* -------- public API (all aggregate, min-cohort gated) -------- */

export function participantSummary(filters = {}) {
  const all = population();
  const cohort = applyCohortFilters(all, filters);
  const suppressed = cohort.length < MIN_COHORT;
  // Demographic breakdowns with per-cell suppression.
  const breakdown = (key) => {
    const counts = {};
    for (const a of cohort) { const k = a[key] || 'unspecified'; counts[k] = (counts[k] || 0) + 1; }
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v >= MIN_COHORT ? v : 'suppressed']));
  };
  return {
    totalParticipants: all.length,
    cohortParticipants: cohort.length,
    minCohort: MIN_COHORT,
    suppressed,
    totalRecords: cohort.reduce((s, a) => s + a.records, 0),
    demographics: suppressed ? null : {
      sex: breakdown('sex'), ageRange: breakdown('ageRange'), weightClass: breakdown('weightClass'),
      competitionLevel: breakdown('competitionLevel'), trainingEnvironment: breakdown('trainingEnvironment'),
      country: breakdown('country'),
    },
  };
}

export function qualityReport() {
  const t = db.prepare('SELECT COUNT(*) c FROM research_workouts').get().c;
  const flagRows = db.prepare("SELECT quality_flags FROM research_workouts WHERE quality_flags IS NOT NULL AND quality_flags != '[]'").all();
  const flagCounts = {};
  let flaggedRecords = 0;
  for (const r of flagRows) {
    const flags = safeJson(r.quality_flags, []) || [];
    if (flags.length) flaggedRecords++;
    for (const f of flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
  }
  const missingCounts = {};
  for (const r of db.prepare("SELECT missing_flags FROM research_workouts WHERE missing_flags IS NOT NULL").all()) {
    for (const m of (safeJson(r.missing_flags, []) || [])) missingCounts[m] = (missingCounts[m] || 0) + 1;
  }
  const conf = db.prepare('SELECT AVG(measurement_confidence) a, COUNT(measurement_confidence) n FROM research_workouts').get();
  return {
    totalRecords: t,
    flaggedRecords,
    flaggedPct: t ? round((flaggedRecords / t) * 100, 1) : 0,
    flagCounts,
    missingByMeasure: Object.fromEntries(Object.entries(missingCounts).map(([k, v]) => [k, { count: v, pct: t ? round((v / t) * 100, 1) : 0 }])),
    meanMeasurementConfidence: round(conf.a, 3),
    note: 'Flagged records are RETAINED and documented for optional exclusion during analysis — never deleted.',
  };
}

export function variableDistributions(filters = {}) {
  const cohort = applyCohortFilters(population(), filters);
  if (cohort.length < MIN_COHORT) return { suppressed: true, cohort: cohort.length, minCohort: MIN_COHORT, variables: {} };
  const variables = {};
  for (const key of RESEARCH_NUMERIC_VARS) {
    const vals = cohort.map(a => a[key]);
    variables[key] = { quantiles: quantiles(vals), histogram: histogram(vals) };
  }
  return { suppressed: false, cohort: cohort.length, minCohort: MIN_COHORT, variables };
}

export function correlationMatrix(filters = {}) {
  const cohort = applyCohortFilters(population(), filters);
  if (cohort.length < MIN_COHORT) return { suppressed: true, cohort: cohort.length, minCohort: MIN_COHORT, variables: [], matrix: [] };
  const vars = RESEARCH_NUMERIC_VARS;
  const matrix = vars.map(a => vars.map(b => {
    if (a === b) return { r: 1, n: cohort.length };
    return pearson(cohort.map(x => x[a]), cohort.map(x => x[b]));
  }));
  return {
    suppressed: false, cohort: cohort.length, minCohort: MIN_COHORT, variables: vars, matrix,
    note: 'Pearson correlations are ASSOCIATIONS on observational data — never evidence of causation.',
  };
}

/** Longitudinal trend of a variable's weekly median across the whole dataset. */
export function longitudinalTrends(variable = 'weeklyMeters') {
  const rows = db.prepare('SELECT week_key, variables_json FROM research_snapshots ORDER BY week_key').all();
  const byWeek = {};
  for (const r of rows) {
    const v = safeJson(r.variables_json, {});
    const val = v?.[variable]?.value;
    if (Number.isFinite(val)) (byWeek[r.week_key] = byWeek[r.week_key] || []).push(val);
  }
  const points = Object.entries(byWeek)
    .filter(([, vals]) => vals.length >= MIN_COHORT)   // suppress thin weeks
    .map(([week, vals]) => ({ week, n: vals.length, ...quantiles(vals) }));
  return { variable, minCohort: MIN_COHORT, points };
}
