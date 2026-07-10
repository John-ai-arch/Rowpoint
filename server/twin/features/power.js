// Power features. Measured watts are used when the erg reported them;
// otherwise power is derived from pace with the standard Concept2 relation
// watts = 2.80 / (pace_s_per_m)^3 — flagged by power_source so downstream
// consumers know which grounding they got.
import { mean, cv } from '../../kernel/stats.js';

/** Concept2 pace→power. pace in seconds per 500m. */
export function wattsFromSplit(splitSPer500) {
  const p = Number(splitSPer500);
  if (!Number.isFinite(p) || p <= 0) return null;
  const pacePerMeter = p / 500;
  return 2.80 / pacePerMeter ** 3;
}

export const powerExtractor = {
  name: 'power',
  version: '1.0',
  features: ['power_avg_w', 'power_cv_pct', 'power_fade_pct', 'power_source'],
  extract({ workout, splits }) {
    const measured = (splits || [])
      .map(s => Number(s.avg_power_watts))
      .filter(w => Number.isFinite(w) && w > 0);
    const workoutAvgW = Number(workout.avg_power_watts);

    let series = measured;
    let avg = workoutAvgW > 0 ? workoutAvgW : mean(measured);
    let source = 1; // 1 = measured watts
    if (!series.length && !(avg > 0)) {
      // Derive from split paces instead.
      series = (splits || [])
        .map(s => wattsFromSplit(s.avg_pace_s_per_500m))
        .filter(w => Number.isFinite(w) && w > 0);
      avg = wattsFromSplit(workout.avg_split_s) ?? mean(series);
      source = 0; // 0 = pace-derived
    }
    if (!(avg > 0)) return {};

    let fade = null;
    if (series.length >= 3) {
      const third = Math.max(1, Math.floor(series.length / 3));
      const first = mean(series.slice(0, third));
      const last = mean(series.slice(-third));
      if (first > 0) fade = ((first - last) / first) * 100; // + = power fell off
    }
    return {
      power_avg_w: avg,
      power_cv_pct: series.length >= 2 && cv(series) !== null ? cv(series) * 100 : null,
      power_fade_pct: fade,
      power_source: source,
    };
  },
};
