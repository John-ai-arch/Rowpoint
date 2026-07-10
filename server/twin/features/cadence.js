// Stroke-cadence features: rate level, rate steadiness, and stroke length
// (distance per stroke — a technique effectiveness proxy).
import { mean, cv } from '../../kernel/stats.js';

export const cadenceExtractor = {
  name: 'cadence',
  version: '1.0',
  features: ['rate_avg_spm', 'rate_cv_pct', 'distance_per_stroke_m'],
  extract({ workout, splits }) {
    const rates = (splits || [])
      .map(s => Number(s.avg_stroke_rate))
      .filter(r => Number.isFinite(r) && r > 0);
    const avgRate = Number(workout.avg_stroke_rate) > 0 ? Number(workout.avg_stroke_rate) : mean(rates);
    const rateCv = rates.length >= 2 ? cv(rates) : null;

    // Distance per stroke = speed / stroke frequency.
    const dist = Number(workout.total_distance_m), time = Number(workout.total_time_s);
    let dps = null;
    if (avgRate > 0 && dist > 0 && time > 0) dps = (dist / time) / (avgRate / 60);

    return {
      rate_avg_spm: avgRate ?? null,
      rate_cv_pct: rateCv !== null ? rateCv * 100 : null,
      distance_per_stroke_m: dps,
    };
  },
};
