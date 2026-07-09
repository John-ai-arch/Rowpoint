// RowPoint Research Observatory (moat system #1).
//
// Turns anonymous research participation into value for every athlete: it
// computes population statistics ONLY from research-opted-in contributions
// (server/research.js → research_workouts, keyed by a pseudonymous research_id)
// and lets an athlete see where they stand — percentiles, distributions, and
// hedged, observational insights. No individual is ever identifiable: the API
// returns aggregates only, never a research_id or a single athlete's row, and
// a cohort must clear a minimum size before any statistic is shown.
//
// Scalability: the expensive per-athlete rollup is computed once and cached
// (TTL); requests then filter + percentile in memory. For very large datasets
// this same shape moves to a materialised table refreshed on a schedule.
import { db } from './db.js';

const DAY = 86400;
const MIN_COHORT = 8;            // privacy + statistical-validity floor
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, athletes: null };

/** One pseudonymous row per opted-in athlete, rolled up from their workouts. */
function buildPopulation() {
  const base = db.prepare(`
    SELECT research_id AS rid, COUNT(*) AS workouts, SUM(total_distance_m) AS meters,
           MIN(started_at) AS firstAt, MAX(started_at) AS lastAt, AVG(avg_stroke_rate) AS rate,
           MAX(birth_decade) AS birthDecade, MAX(weight_class) AS weightClass, MAX(goal_type) AS goalType
    FROM research_workouts WHERE started_at IS NOT NULL GROUP BY research_id`).all();

  const bestFor = (dist) => Object.fromEntries(db.prepare(
    `SELECT research_id AS rid, MIN(total_time_s) AS t FROM research_workouts
     WHERE ABS(total_distance_m - ?) <= 25 AND total_time_s > 0 GROUP BY research_id`).all(dist).map(r => [r.rid, r.t]));
  const b2k = bestFor(2000), b5k = bestFor(5000), b6k = bestFor(6000);

  return base.map(r => {
    const weeks = Math.max(1, (r.lastAt - r.firstAt) / (7 * DAY));
    return {
      weeklyMeters: Math.round(r.meters / weeks),
      workoutsPerWeek: Math.round((r.workouts / weeks) * 10) / 10,
      avgStrokeRate: r.rate ? Math.round(r.rate) : null,
      best2k: b2k[r.rid] || null,
      best5k: b5k[r.rid] || null,
      best6k: b6k[r.rid] || null,
      weeksActive: Math.round(weeks),
      birthDecade: r.birthDecade, weightClass: r.weightClass, goalType: r.goalType,
    };
  });
}

function population() {
  if (cache.athletes && Date.now() - cache.at < CACHE_TTL_MS) return cache.athletes;
  cache = { at: Date.now(), athletes: buildPopulation() };
  return cache.athletes;
}
export function invalidateObservatoryCache() { cache = { at: 0, athletes: null }; }

/** The viewer's own metrics, computed the same way as the population rows. */
function viewerMetrics(user, nowS) {
  const rows = db.prepare(
    `SELECT started_at, total_distance_m, total_time_s, avg_stroke_rate, workout_plan_json
     FROM workouts WHERE user_id = ? AND started_at IS NOT NULL ORDER BY started_at`).all(user.id);
  if (!rows.length) return { hasData: false };
  const meters = rows.reduce((s, w) => s + (w.total_distance_m || 0), 0);
  const weeks = Math.max(1, (rows[rows.length - 1].started_at - rows[0].started_at) / (7 * DAY));
  const bestAt = (d) => {
    const f = rows.filter(w => Math.abs((w.total_distance_m || 0) - d) <= 25 && w.total_time_s > 0);
    return f.length ? Math.min(...f.map(w => w.total_time_s)) : null;
  };
  const rates = rows.map(w => w.avg_stroke_rate).filter(v => Number.isFinite(v) && v > 0);
  return {
    hasData: true,
    weeklyMeters: Math.round(meters / weeks),
    workoutsPerWeek: Math.round((rows.length / weeks) * 10) / 10,
    avgStrokeRate: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
    best2k: user.best_2k_seconds || bestAt(2000),
    best5k: bestAt(5000), best6k: bestAt(6000),
    birthDecade: user.birth_year ? Math.floor(user.birth_year / 10) * 10 : null,
    weightClass: user.weight_class || null,
    goalType: user.goal_type || null,
  };
}

function applyFilters(pop, f = {}) {
  return pop.filter(a => {
    if (f.weightClass && a.weightClass !== f.weightClass) return false;
    if (f.birthDecade && a.birthDecade !== Number(f.birthDecade)) return false;
    if (f.goalType && a.goalType !== f.goalType) return false;
    if (f.best2kMin && !(a.best2k && a.best2k >= Number(f.best2kMin))) return false;
    if (f.best2kMax && !(a.best2k && a.best2k <= Number(f.best2kMax))) return false;
    if (f.weeklyMetersMin && !(a.weeklyMeters >= Number(f.weeklyMetersMin))) return false;
    return true;
  });
}

// Lower-is-better metrics invert the percentile so "faster than X%" reads right.
const METRICS = {
  weeklyMeters: { dir: 'high', label: 'Weekly volume' },
  workoutsPerWeek: { dir: 'high', label: 'Training frequency' },
  avgStrokeRate: { dir: 'neutral', label: 'Stroke rate' },
  best2k: { dir: 'low', label: '2k' },
  best5k: { dir: 'low', label: '5k' },
  best6k: { dir: 'low', label: '6k' },
};

function percentile(values, value, dir) {
  const vals = values.filter(v => Number.isFinite(v));
  if (vals.length < MIN_COHORT || !Number.isFinite(value)) return null;
  const below = vals.filter(v => (dir === 'low' ? v > value : v < value)).length;
  return Math.round((below / vals.length) * 100);
}

function quantiles(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: v[v.length - 1], n: v.length };
}

function histogram(values, bins = 12) {
  const v = values.filter(Number.isFinite);
  if (v.length < MIN_COHORT) return null;
  const min = Math.min(...v), max = Math.max(...v);
  if (max === min) return { min, max, bins: [{ x0: min, x1: max, count: v.length }] };
  const w = (max - min) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ x0: min + i * w, x1: min + (i + 1) * w, count: 0 }));
  for (const x of v) out[Math.min(bins - 1, Math.floor((x - min) / w))].count++;
  return { min, max, bins: out };
}

/** Full Observatory response for a viewer within a cohort. */
export function observe(user, filters = {}, nowS = Math.floor(Date.now() / 1000)) {
  const cohort = applyFilters(population(), filters);
  const me = viewerMetrics(user, nowS);
  const metrics = {};
  for (const [key, meta] of Object.entries(METRICS)) {
    const vals = cohort.map(a => a[key]).filter(Number.isFinite);
    const mine = me[key];
    metrics[key] = {
      label: meta.label, direction: meta.dir,
      you: Number.isFinite(mine) ? mine : null,
      percentile: percentile(vals, mine, meta.dir),
      quantiles: quantiles(vals),
      histogram: histogram(vals),
    };
  }
  return {
    cohortSize: cohort.length,
    populationSize: cache.athletes ? cache.athletes.length : 0,
    enoughData: cohort.length >= MIN_COHORT,
    minCohort: MIN_COHORT,
    you: me,
    metrics,
    insights: insights(metrics, cohort, filters),
    confidence: cohort.length >= 40 ? 'high' : cohort.length >= MIN_COHORT ? 'moderate' : 'low',
    disclaimer: 'These are observational statistics from athletes who opted into research — patterns, not guarantees, and never a medical claim.',
    filtersApplied: filters,
  };
}

function insights(metrics, cohort, filters) {
  if (cohort.length < MIN_COHORT) return [];
  const out = [];
  const wm = metrics.weeklyMeters;
  if (wm.percentile != null) out.push(`Your weekly volume is greater than ${wm.percentile}% of comparable athletes${cohortPhrase(filters)}.`);
  const fr = metrics.workoutsPerWeek;
  if (fr.percentile != null && fr.percentile >= 60) out.push(`Your training consistency is among the top ${100 - fr.percentile}% of this group — a strong foundation for progress.`);
  const k = metrics.best2k;
  if (k.percentile != null && k.you) out.push(`Your 2k is faster than ${k.percentile}% of comparable athletes.`);
  // A longitudinal, hedged observation when the cohort is rich enough.
  if (cohort.length >= 25 && wm.quantiles) {
    out.push(`In this group, athletes rowing above ${Math.round(wm.quantiles.median / 1000)} km/week tend to hold faster steady-state paces — an association, not a guarantee.`);
  }
  return out;
}

function cohortPhrase(f) {
  const parts = [];
  if (f.weightClass) parts.push(f.weightClass);
  if (f.birthDecade) parts.push(`born ${f.birthDecade}s`);
  if (f.goalType) parts.push(String(f.goalType).replace(/_/g, ' '));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** Publication-ready, PII-free aggregate tables for the admin research export. */
export function observatoryExport() {
  const pop = population();
  const byWeight = {};
  for (const a of pop) {
    const key = a.weightClass || 'unspecified';
    (byWeight[key] = byWeight[key] || []).push(a);
  }
  const summarise = (arr) => ({
    n: arr.length,
    weeklyMeters: quantiles(arr.map(a => a.weeklyMeters)),
    best2k: quantiles(arr.map(a => a.best2k)),
    workoutsPerWeek: quantiles(arr.map(a => a.workoutsPerWeek)),
  });
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    totalAthletes: pop.length,
    overall: summarise(pop),
    byWeightClass: Object.fromEntries(Object.entries(byWeight).filter(([, a]) => a.length >= MIN_COHORT).map(([k, a]) => [k, summarise(a)])),
    note: 'Aggregates only; cohorts below the minimum size are omitted. No personally identifying information.',
  };
}
