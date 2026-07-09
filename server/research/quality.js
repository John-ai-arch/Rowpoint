// Research data-quality framework (Feature B core). Per-record quality control:
// flag impossible / implausible / incomplete values so analysts can EXCLUDE
// them during analysis. Nothing is ever deleted or silently corrected — data is
// retained, flagged, and documented (the scientific-integrity requirement).
//
// Each flag is a short machine-readable slug; QUALITY_FLAG_DOCS documents what
// each means and the bound that triggered it, and feeds the auto data dictionary.

export const QUALITY_FLAG_DOCS = {
  zero_distance: 'Total distance is zero or missing.',
  zero_time: 'Total elapsed time is zero or missing.',
  impossible_pace: 'Average 500 m split is faster than 1:00 — physiologically impossible on a rower.',
  suspicious_slow_pace: 'Average 500 m split is slower than 5:00 — likely a paused or partial recording.',
  distance_time_mismatch: 'Distance and time imply a pace that disagrees with the reported average split by >15%.',
  unrealistic_heart_rate: 'Average or max heart rate outside a plausible human range (30–230 bpm).',
  unrealistic_stroke_rate: 'Average stroke rate outside a plausible range (10–60 spm).',
  incomplete_sensors: 'Neither heart-rate nor power was recorded (manual or dropped sensors).',
  no_splits: 'No per-split detail was recorded.',
  very_short_piece: 'Total time under 60 s — likely a test or accidental recording.',
};

/**
 * Compute quality flags for one workout. Pure and deterministic. `workout`
 * fields are the stored column names (total_distance_m, avg_split_s, …).
 */
export function qualityFlags(workout, splits) {
  const f = [];
  const dist = Number(workout.total_distance_m);
  const time = Number(workout.total_time_s);
  const split = Number(workout.avg_split_s);
  const hr = Number(workout.avg_heart_rate);
  const maxHr = Number(workout.max_heart_rate);
  const rate = Number(workout.avg_stroke_rate);
  const power = Number(workout.avg_power_watts);

  if (!(dist > 0)) f.push('zero_distance');
  if (!(time > 0)) f.push('zero_time');
  if (split > 0 && split < 60) f.push('impossible_pace');
  if (split > 300) f.push('suspicious_slow_pace');
  if (dist > 0 && time > 0) {
    const impliedSplit = time / (dist / 500);
    if (split > 0 && Math.abs(impliedSplit - split) / split > 0.15) f.push('distance_time_mismatch');
  }
  if ((hr > 0 && (hr < 30 || hr > 230)) || (maxHr > 0 && maxHr > 240)) f.push('unrealistic_heart_rate');
  if (rate > 0 && (rate < 10 || rate > 60)) f.push('unrealistic_stroke_rate');
  if (!(hr > 0) && !(power > 0)) f.push('incomplete_sensors');
  if (!Array.isArray(splits) || !splits.length) f.push('no_splits');
  if (time > 0 && time < 60) f.push('very_short_piece');
  return f;
}
