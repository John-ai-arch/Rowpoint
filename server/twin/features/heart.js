// Heart-rate features. Uses the workout's stored HR summary (computed at sync
// from the raw strap series) and the athlete's effective max HR; every value
// is null when no HR source was present — never fabricated.
export const heartExtractor = {
  name: 'heart',
  version: '1.0',
  features: ['hr_avg_bpm', 'hr_max_bpm', 'hr_drift_pct', 'hr_intensity_pct'],
  extract({ workout, hrZones, maxHr }) {
    const avg = Number(workout.avg_heart_rate);
    const max = Number(workout.max_heart_rate);
    const drift = Number(hrZones?.driftPct);
    return {
      hr_avg_bpm: avg > 0 ? avg : null,
      hr_max_bpm: max > 0 ? max : null,
      hr_drift_pct: Number.isFinite(drift) ? drift : null,
      // Session intensity as % of max HR — comparable across athletes.
      hr_intensity_pct: avg > 0 && maxHr > 0 ? (avg / maxHr) * 100 : null,
    };
  },
};
