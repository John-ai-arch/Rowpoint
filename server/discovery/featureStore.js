// Research feature store — versioned longitudinal derived variables.
//
// One row per pseudonym per ISO week per feature, computed from the raw
// research contributions and kept SEPARATE from operational tables. Every
// feature carries the store version and a quality score (mean measurement
// confidence of the contributing records). Quality-flagged records are
// excluded from computation — and every exclusion is recorded with its
// reason, never silently dropped.
//
// Intensity note: research data carries no 2k anchor (deliberately — it
// would be identifying), so intensity is WITHIN-athlete relative: a
// workout's split against that pseudonym's own median split. Documented
// in the data dictionary entry below.
import { db, inTransaction } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { mean, sd, cv, median, linearRegression } from '../kernel/stats.js';

export const FEATURE_STORE_VERSION = '1.0';

/** Feature definitions — feeds the API and the auto data dictionary. */
export const DISCOVERY_FEATURES = Object.freeze({
  weekly_meters: 'Total meters rowed in the ISO week.',
  weekly_minutes: 'Total training minutes in the ISO week.',
  sessions: 'Workouts completed in the ISO week.',
  split_mean_s: 'Mean average 500m split across the week\'s workouts (s).',
  split_volatility_pct: 'Coefficient of variation of workout splits within the week (%).',
  intensity_rel_mean: 'Mean within-athlete relative intensity (athlete median split ÷ workout split; >1 = harder than typical).',
  pct_hard_minutes: 'Share of weekly minutes at relative intensity > 1.05 (%).',
  hr_drift_mean: 'Mean within-workout HR drift across the week (%), where recorded.',
  monotony: 'Foster monotony: mean ÷ sd of daily training minutes within the week.',
  strain: 'Foster strain: weekly minutes × monotony.',
  improvement_slope: 'Trailing 8-week regression slope of weekly mean split (s/500m per week; negative = getting faster).',
});

/** ISO-8601 week key (same convention platform-wide). */
export function isoWeekKey(tS) {
  const d = new Date(tS * 1000);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const weekSortKey = (wk) => Number(wk.slice(0, 4)) * 100 + Number(wk.slice(6));

/**
 * Rebuild the feature store from the research dataset. Idempotent (upserts).
 * Returns { athletes, weeks, featuresWritten, excluded } and records every
 * exclusion under the given analysisId.
 */
export function buildFeatureStore(analysisId, nowS = now()) {
  const rows = db.prepare(
    `SELECT id, research_id, started_at, total_distance_m, total_time_s, avg_split_s,
            hr_drift_pct, measurement_confidence, quality_flags
     FROM research_workouts ORDER BY research_id, started_at`).all();

  /* ---- exclusion pass: quality-flagged records don't enter features ---- */
  const HARD_EXCLUDE = new Set(['zero_distance', 'zero_time', 'impossible_pace', 'distance_time_mismatch', 'very_short_piece']);
  const usable = [];
  const exclusions = [];
  for (const r of rows) {
    const flags = safeJson(r.quality_flags, []) || [];
    const bad = flags.filter(f => HARD_EXCLUDE.has(f));
    if (bad.length) exclusions.push({ ref: r.id, reason: `quality flags: ${bad.join(', ')}` });
    else if (!Number.isFinite(r.started_at)) exclusions.push({ ref: r.id, reason: 'missing start time' });
    else usable.push(r);
  }

  /* ---- group per pseudonym per ISO week ---- */
  const byAthlete = new Map();
  for (const r of usable) {
    if (!byAthlete.has(r.research_id)) byAthlete.set(r.research_id, []);
    byAthlete.get(r.research_id).push(r);
  }

  let featuresWritten = 0;
  const weeksSeen = new Set();
  inTransaction(() => {
    const upsert = db.prepare(`INSERT INTO research_features (research_id, week_key, feature, version, value, quality, computed_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(research_id, week_key, feature) DO UPDATE SET
          version = excluded.version, value = excluded.value, quality = excluded.quality, computed_at = excluded.computed_at`);
    const insExcl = db.prepare('INSERT INTO research_exclusions (id, analysis_id, record_ref, reason, created_at) VALUES (?,?,?,?,?)');
    for (const e of exclusions) insExcl.run(uuid(), analysisId, e.ref, e.reason, nowS);

    for (const [rid, workouts] of byAthlete) {
      const athleteMedianSplit = median(workouts.map(w => w.avg_split_s).filter(v => v > 0));
      const byWeek = new Map();
      for (const w of workouts) {
        const wk = isoWeekKey(w.started_at);
        if (!byWeek.has(wk)) byWeek.set(wk, []);
        byWeek.get(wk).push(w);
      }
      const weekKeys = [...byWeek.keys()].sort((a, b) => weekSortKey(a) - weekSortKey(b));
      const weeklySplitMeans = [];

      for (const wk of weekKeys) {
        weeksSeen.add(wk);
        const ws = byWeek.get(wk);
        const minutes = ws.map(w => (Number(w.total_time_s) || 0) / 60);
        const splits = ws.map(w => Number(w.avg_split_s)).filter(v => v > 0);
        const relIntensities = athleteMedianSplit > 0
          ? ws.map(w => (Number(w.avg_split_s) > 0 ? athleteMedianSplit / w.avg_split_s : null)).filter(Number.isFinite)
          : [];
        const hardMinutes = ws.reduce((s, w) => {
          const rel = athleteMedianSplit > 0 && w.avg_split_s > 0 ? athleteMedianSplit / w.avg_split_s : 0;
          return s + (rel > 1.05 ? (Number(w.total_time_s) || 0) / 60 : 0);
        }, 0);
        // Daily minutes for Foster monotony (7 slots, most empty most weeks).
        const daily = new Array(7).fill(0);
        for (const w of ws) daily[(new Date(w.started_at * 1000).getUTCDay() + 6) % 7] += (Number(w.total_time_s) || 0) / 60;
        const dMean = mean(daily), dSd = sd(daily);
        const monotony = dSd !== null && dSd > 0.01 ? dMean / dSd : (dMean > 0 ? 4 : null);
        const totalMinutes = minutes.reduce((a, b) => a + b, 0);
        const drift = ws.map(w => Number(w.hr_drift_pct)).filter(Number.isFinite);
        const quality = mean(ws.map(w => w.measurement_confidence).filter(Number.isFinite));

        const splitMean = splits.length ? mean(splits) : null;
        if (splitMean !== null) weeklySplitMeans.push({ wk, split: splitMean });

        const featureValues = {
          weekly_meters: ws.reduce((s, w) => s + (Number(w.total_distance_m) || 0), 0),
          weekly_minutes: totalMinutes,
          sessions: ws.length,
          split_mean_s: splitMean,
          split_volatility_pct: splits.length >= 2 && cv(splits) !== null ? cv(splits) * 100 : null,
          intensity_rel_mean: relIntensities.length ? mean(relIntensities) : null,
          pct_hard_minutes: totalMinutes > 0 ? (hardMinutes / totalMinutes) * 100 : null,
          hr_drift_mean: drift.length ? mean(drift) : null,
          monotony,
          strain: monotony !== null ? totalMinutes * monotony : null,
        };
        for (const [feature, value] of Object.entries(featureValues)) {
          upsert.run(rid, wk, feature, FEATURE_STORE_VERSION,
            Number.isFinite(value) ? Math.round(value * 100) / 100 : null, quality ?? null, nowS);
          featuresWritten++;
        }
      }

      /* trailing improvement slope per week (needs the weekly series) */
      for (let i = 0; i < weeklySplitMeans.length; i++) {
        const windowStart = Math.max(0, i - 7);
        const win = weeklySplitMeans.slice(windowStart, i + 1);
        let slope = null;
        if (win.length >= 4) {
          const x0 = weekSortKey(win[0].wk);
          const reg = linearRegression(win.map(p => weekSortKey(p.wk) - x0), win.map(p => p.split));
          slope = reg ? Math.round(reg.slope * 1000) / 1000 : null;
        }
        upsert.run(rid, weeklySplitMeans[i].wk, 'improvement_slope', FEATURE_STORE_VERSION, slope, null, nowS);
        featuresWritten++;
      }
    }
  });

  return { athletes: byAthlete.size, weeks: weeksSeen.size, featuresWritten, excluded: exclusions.length };
}

/**
 * Per-athlete aggregates over the feature store (means across weeks, plus
 * the latest trailing improvement slope) — the hypothesis engine's dataset.
 * Requires ≥ minWeeks of data per athlete to include them.
 */
export function athleteAggregates({ minWeeks = 4 } = {}) {
  const rows = db.prepare('SELECT research_id, week_key, feature, value, quality FROM research_features').all();
  const byAthlete = new Map();
  for (const r of rows) {
    if (!byAthlete.has(r.research_id)) byAthlete.set(r.research_id, new Map());
    const weeks = byAthlete.get(r.research_id);
    if (!weeks.has(r.week_key)) weeks.set(r.week_key, {});
    weeks.get(r.week_key)[r.feature] = r.value;
    if (r.quality !== null) weeks.get(r.week_key)._quality = r.quality;
  }
  const out = [];
  for (const [rid, weeks] of byAthlete) {
    if (weeks.size < minWeeks) continue;
    const ordered = [...weeks.entries()].sort((a, b) => weekSortKey(a[0]) - weekSortKey(b[0])).map(([, v]) => v);
    const agg = { researchId: rid, weeks: weeks.size };
    for (const f of Object.keys(DISCOVERY_FEATURES)) {
      if (f === 'improvement_slope') continue;
      agg[f] = mean(ordered.map(w => w[f]).filter(Number.isFinite));
    }
    const slopes = ordered.map(w => w.improvement_slope).filter(Number.isFinite);
    agg.improvement_slope = slopes.length ? slopes[slopes.length - 1] : null;
    agg.quality = mean(ordered.map(w => w._quality).filter(Number.isFinite));
    out.push(agg);
  }
  return out;
}
