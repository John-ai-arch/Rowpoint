// §11.4 — Post-workout pacing classification. Pure, explainable rules over
// split-level data; runs before any text generation.

export const PACING = {
  TOO_HARD: 'started_too_hard',
  TOO_EASY: 'started_too_easy',
  WELL_PACED: 'well_paced',
  INSUFFICIENT: 'insufficient_data',
};

// Tolerance band for "even" pacing, in seconds per 500 m (§11.4 suggests 1–2 s).
const EVEN_TOLERANCE_S = 1.5;
// How much faster/slower than the workout average the first third must be to count.
const MEANINGFUL_DELTA_S = 2.0;

/**
 * splits: [{ avg_pace_s_per_500m, time_s, distance_m, avg_stroke_rate }]
 * Returns { tag, firstThirdPace, midThirdPace, lastThirdPace, avgPace, detail }
 */
export function classifyPacing(splits) {
  const valid = (splits || []).filter(s => Number.isFinite(s?.avg_pace_s_per_500m) && s.avg_pace_s_per_500m > 0);
  if (valid.length < 3) {
    return { tag: PACING.INSUFFICIENT, detail: 'Fewer than three splits recorded.' };
  }
  const third = Math.floor(valid.length / 3);
  const first = valid.slice(0, third);
  const mid = valid.slice(third, valid.length - third);
  const last = valid.slice(valid.length - third);

  const paceOf = (arr) => weightedAvg(arr, s => s.avg_pace_s_per_500m);
  const rateOf = (arr) => weightedAvg(arr.filter(s => Number.isFinite(s.avg_stroke_rate)), s => s.avg_stroke_rate);

  const firstPace = paceOf(first);
  const midPace = paceOf(mid);
  const lastPace = paceOf(last);
  const avgPace = paceOf(valid);
  const firstRate = rateOf(first);
  const lastRate = rateOf(last);

  const result = {
    firstThirdPace: round1(firstPace), midThirdPace: round1(midPace),
    lastThirdPace: round1(lastPace), avgPace: round1(avgPace),
    firstThirdRate: round1(firstRate), lastThirdRate: round1(lastRate),
  };

  const spread = Math.max(firstPace, midPace, lastPace) - Math.min(firstPace, midPace, lastPace);
  if (spread <= EVEN_TOLERANCE_S) {
    return { tag: PACING.WELL_PACED, ...result, detail: `Pace stayed within ${EVEN_TOLERANCE_S}s/500m across the piece.` };
  }
  // Started too hard: first third meaningfully faster than average AND a fade
  // in the back third (lower pace number = faster).
  if (avgPace - firstPace >= MEANINGFUL_DELTA_S && lastPace - avgPace >= MEANINGFUL_DELTA_S * 0.5) {
    return { tag: PACING.TOO_HARD, ...result, detail: 'Fast opening third followed by a fade in the final third.' };
  }
  // Started too easy: first third meaningfully slower, negative split at the
  // end, and stroke rate clearly rising (effort still in reserve).
  const negativeSplit = lastPace < avgPace - EVEN_TOLERANCE_S * 0.5;
  const rateRising = Number.isFinite(firstRate) && Number.isFinite(lastRate) ? lastRate >= firstRate + 1 : true;
  if (firstPace - avgPace >= MEANINGFUL_DELTA_S && negativeSplit && rateRising) {
    return { tag: PACING.TOO_EASY, ...result, detail: 'Slow opening third with a strong negative split and rising rate — time left on the course.' };
  }
  return { tag: PACING.WELL_PACED, ...result, detail: 'No consistent pacing error pattern detected.' };
}

/**
 * Structured interval workouts get per-interval classification too (§11.4),
 * since pacing errors repeat interval-to-interval.
 * intervalsSplits: array of split-arrays, one per interval.
 */
export function classifyIntervals(intervalsSplits) {
  const per = (intervalsSplits || []).map((s, idx) => ({ interval: idx + 1, ...classifyPacing(s) }));
  const tags = per.map(p => p.tag).filter(t => t !== PACING.INSUFFICIENT);
  let overall = PACING.WELL_PACED;
  const count = (t) => tags.filter(x => x === t).length;
  if (tags.length && count(PACING.TOO_HARD) >= Math.ceil(tags.length / 2)) overall = PACING.TOO_HARD;
  else if (tags.length && count(PACING.TOO_EASY) >= Math.ceil(tags.length / 2)) overall = PACING.TOO_EASY;
  return { overall, perInterval: per };
}

function weightedAvg(arr, fn) {
  if (!arr.length) return NaN;
  let num = 0, den = 0;
  for (const s of arr) {
    const w = Number.isFinite(s.time_s) && s.time_s > 0 ? s.time_s : 1;
    num += fn(s) * w; den += w;
  }
  return num / den;
}
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
