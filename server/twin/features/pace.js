// Pace features: central tendency, variability, and pacing shape of a
// workout's splits. All values are in seconds per 500m unless noted.
import { mean, cv } from '../../kernel/stats.js';

export const paceExtractor = {
  name: 'pace',
  version: '1.0',
  features: ['pace_avg_split_s', 'pace_cv_pct', 'pace_first_last_delta_s', 'pace_negative_split'],
  extract({ workout, splits }) {
    const paces = (splits || [])
      .map(s => Number(s.avg_pace_s_per_500m))
      .filter(p => Number.isFinite(p) && p > 0);
    const avg = Number(workout.avg_split_s) > 0 ? Number(workout.avg_split_s) : mean(paces);
    if (paces.length < 2) return { pace_avg_split_s: avg ?? null };

    const variability = cv(paces);
    const third = Math.max(1, Math.floor(paces.length / 3));
    const first = mean(paces.slice(0, third));
    const last = mean(paces.slice(-third));
    return {
      pace_avg_split_s: avg,
      pace_cv_pct: variability !== null ? variability * 100 : null,
      // + means the finish was SLOWER than the start (fade); − means negative split.
      pace_first_last_delta_s: first !== null && last !== null ? last - first : null,
      pace_negative_split: first !== null && last !== null ? (last < first ? 1 : 0) : null,
    };
  },
};
