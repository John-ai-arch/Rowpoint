// Stroke-mechanics features from force curves, when the erg provided them.
// Most workouts have none — every feature is null then; the technique model
// widens its uncertainty accordingly rather than guessing.
import { mean, cv } from '../../kernel/stats.js';

export const strokeExtractor = {
  name: 'stroke',
  version: '1.0',
  features: ['stroke_count', 'force_peak_avg', 'force_smoothness_idx', 'force_area_cv_pct'],
  extract({ forceCurves }) {
    const curves = (forceCurves || [])
      .map(c => (Array.isArray(c.samples) ? c.samples.map(Number).filter(Number.isFinite) : []))
      .filter(s => s.length >= 4);
    if (!curves.length) return {};

    const peaks = curves.map(s => Math.max(...s));
    const areas = curves.map(s => s.reduce((a, b) => a + b, 0));

    // Smoothness: mean absolute second difference (jerk) normalized by peak —
    // lower is smoother; inverted to a 0-100 index where 100 = glass-smooth.
    const smoothness = curves.map(s => {
      const peak = Math.max(...s, 1);
      let jerk = 0;
      for (let i = 2; i < s.length; i++) jerk += Math.abs(s[i] - 2 * s[i - 1] + s[i - 2]);
      return Math.max(0, 100 - ((jerk / (s.length - 2)) / peak) * 400);
    });

    return {
      stroke_count: curves.length,
      force_peak_avg: mean(peaks),
      force_smoothness_idx: mean(smoothness),
      force_area_cv_pct: areas.length >= 2 && cv(areas) !== null ? cv(areas) * 100 : null,
    };
  },
};
