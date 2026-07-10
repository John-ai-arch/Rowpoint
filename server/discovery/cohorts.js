// Anonymous cohort builder over the discovery feature store.
//
// Cohorts are defined by coarsened demographic filters (the same vocabulary
// as the research platform) plus feature bounds; results are distribution
// summaries only, hard-gated by the k-anonymity floor. Research ids are
// resolved internally and never leave this module.
import { db } from '../db.js';
import { mean, median, quantile } from '../kernel/stats.js';
import { athleteAggregates, DISCOVERY_FEATURES } from './featureStore.js';
import { MIN_SUBGROUP } from './statsTests.js';

export const COHORTS_VERSION = 'discovery.cohorts@1.0';

/** Demographic filter vocabulary (mirrors the research platform's). */
export const COHORT_FILTERS = ['sex', 'ageRange', 'weightClass', 'competitionLevel', 'trainingEnvironment', 'country'];

const COLUMN = {
  sex: 'sex', ageRange: 'age_range', weightClass: 'weight_class',
  competitionLevel: 'competition_level', trainingEnvironment: 'training_environment', country: 'country',
};

/** research_id → latest coarsened demographics (internal only). */
function demographicsByAthlete() {
  const rows = db.prepare(
    `SELECT research_id, sex, age_range, weight_class, competition_level,
            training_environment, country, MAX(contributed_at) AS latest
     FROM research_workouts GROUP BY research_id`).all();
  return new Map(rows.map(r => [r.research_id, r]));
}

/**
 * Summarize a cohort. Refuses (suppressed: true) below the anonymity floor.
 * Returns feature distributions (quartiles only — never individual values).
 */
export function cohortSummary(filters = {}, { minWeeks = 4 } = {}) {
  const demo = demographicsByAthlete();
  const athletes = athleteAggregates({ minWeeks }).filter(a => {
    const d = demo.get(a.researchId);
    if (!d) return false;
    for (const f of COHORT_FILTERS) {
      if (filters[f] && d[COLUMN[f]] !== filters[f]) return false;
    }
    if (filters.minWeeklyMinutes && !(a.weekly_minutes >= Number(filters.minWeeklyMinutes))) return false;
    if (filters.improvingOnly === 'true' && !(a.improvement_slope < 0)) return false;
    return true;
  });

  if (athletes.length < MIN_SUBGROUP) {
    return { suppressed: true, n: null, minCohort: MIN_SUBGROUP, note: 'Cohort below the anonymity floor — statistics suppressed.' };
  }

  const distributions = {};
  for (const feature of Object.keys(DISCOVERY_FEATURES)) {
    const vals = athletes.map(a => a[feature]).filter(Number.isFinite);
    if (vals.length < MIN_SUBGROUP) { distributions[feature] = { suppressed: true }; continue; }
    distributions[feature] = {
      n: vals.length,
      mean: round2(mean(vals)),
      median: round2(median(vals)),
      q25: round2(quantile(vals, 0.25)),
      q75: round2(quantile(vals, 0.75)),
    };
  }
  return {
    suppressed: false,
    n: athletes.length,
    minCohort: MIN_SUBGROUP,
    filters,
    distributions,
    improvingShare: round2(athletes.filter(a => a.improvement_slope < 0).length / athletes.length),
  };
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
