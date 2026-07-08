// Performance intelligence: a daily Training Readiness estimate and a race-time
// predictor. Both are deterministic and fully explainable (every number shows
// the inputs behind it and a confidence level), and both reuse the existing
// training-analysis object — no duplicate analysis.
//
// IMPORTANT: readiness is a TRAINING-LOAD estimate, never a medical or health
// diagnosis, and the copy says so. Predictions are estimates with a stated
// confidence interval, never guarantees.

/* ------------------------------------------------------------------ */
/* Training Readiness Score (0–100)                                     */
/* ------------------------------------------------------------------ */

/**
 * Estimate how ready the athlete is to absorb a hard session today, from
 * recent load, intensity spacing, heart-rate trend, rest, and (if logged)
 * wellness. Returns a score, a band, and the ranked factors that moved it —
 * so the athlete sees exactly why.
 */
export function readinessScore(analysis) {
  const v = analysis.volume || {};
  const r = analysis.recovery || {};
  const hr = analysis.heartRate || {};
  const w = analysis.wellness || {};
  const f = analysis.flags || {};
  const c = analysis.constraints || {};

  let score = 100;
  const factors = [];
  const adjust = (delta, label, detail) => {
    if (!delta) return;
    score += delta;
    factors.push({ label, impact: delta, detail });
  };

  // Acute:chronic workload — the single best-validated overtraining signal.
  if (v.acuteChronicRatio != null) {
    if (v.acuteChronicRatio >= 1.5) adjust(-20, 'Sharp load spike', `Your last 7 days are ${v.acuteChronicRatio}× your typical weekly load — a strong fatigue driver.`);
    else if (v.acuteChronicRatio >= 1.3) adjust(-10, 'Elevated recent load', `Training load is running ${v.acuteChronicRatio}× your 4-week average.`);
    else if (v.acuteChronicRatio <= 0.8) adjust(+6, 'Load well-managed', 'Recent volume is comfortably within your normal range.');
  }

  // Intensity spacing.
  if (r.hardSessionsLast7d >= 3) adjust(-15, 'Stacked hard sessions', `${r.hardSessionsLast7d} high-intensity sessions in the last 7 days.`);
  else if (r.hardSessionsLast7d === 2) adjust(-6, 'Some accumulated intensity', 'Two hard sessions this week — manageable but noted.');

  if (r.daysSinceLastHard != null && r.daysSinceLastHard >= 2 && r.daysSinceLastHard <= 6) adjust(+7, 'Recovered from intensity', `${r.daysSinceLastHard} days since your last hard session.`);
  if (r.daysSinceLastWorkout != null && r.daysSinceLastWorkout >= 3) adjust(+8, 'Rested', `${r.daysSinceLastWorkout} days since your last row.`);

  // Heart-rate trend.
  if (hr.driftTrend === 'worsening') adjust(-10, 'Rising heart-rate drift', 'HR is drifting up within sessions — often an early fatigue signal.');
  else if (hr.driftTrend === 'improving') adjust(+5, 'Improving HR response', 'Heart-rate drift is decreasing — a good recovery sign.');
  if (hr.aerobicEfficiencyTrend === 'improving') adjust(+4, 'Aerobic efficiency rising', 'You are producing more pace per heartbeat lately.');

  // Wellness (only if the athlete has logged check-ins).
  if (w.checkins14d > 0) {
    if (w.avgSleepHours != null && w.avgSleepHours < 6.5) adjust(-12, 'Low sleep', `~${w.avgSleepHours}h average sleep recently.`);
    else if (w.avgSleepHours != null && w.avgSleepHours >= 7.5) adjust(+6, 'Good sleep', `~${w.avgSleepHours}h average sleep recently.`);
    if (w.avgSoreness != null && w.avgSoreness >= 3.5) adjust(-10, 'Elevated soreness', 'Recent soreness check-ins are high.');
    if (w.avgStress != null && w.avgStress >= 3.5) adjust(-6, 'Elevated life stress', 'Recent stress check-ins are high.');
  }

  // Hard floor for combined overtraining signals.
  if (c.overtrainingRisk) { score = Math.min(score, 45); if (!factors.some(x => x.label.includes('Overtraining'))) factors.push({ label: 'Overtraining signals present', impact: -30, detail: 'Multiple fatigue markers are elevated together — prioritise recovery.' }); }
  if (f.returningFromBreak) adjust(+4, 'Fresh after a break', 'Time off means low fatigue — ease back in rather than going all-out.');

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = score >= 75 ? 'ready' : score >= 50 ? 'moderate' : 'caution';
  const headline = {
    ready: 'You look ready for a quality session.',
    moderate: 'Moderate readiness — train, but keep intensity in check.',
    caution: 'Low readiness — favour easy aerobic work or recovery today.',
  }[band];

  factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return {
    score,
    band,
    headline,
    factors: factors.slice(0, 5),
    inputsUsed: ['7d vs 28d load', 'hard-session spacing', 'days since last row/hard session', 'heart-rate drift trend', analysis.wellness?.checkins14d ? 'wellness check-ins' : 'wellness (none logged)'],
    disclaimer: 'This is a training-load estimate to guide session choice — not a medical or health assessment.',
  };
}

/* ------------------------------------------------------------------ */
/* Race predictor (2k / 5k / 6k)                                        */
/* ------------------------------------------------------------------ */

// Riegel-style endurance exponent: T(d2) = T(d1) · (d2/d1)^k. k≈1.06 fits erg
// results well across 2k–10k (fatigue makes longer pieces slightly slower/500m).
const RIEGEL_K = 1.06;

/**
 * Predict 2k/5k/6k times from the athlete's current fitness. Uses the best 2k
 * as the anchor when available (nudged by the recent steady-pace trend for an
 * estimate of *current* form), otherwise estimates a 2k from recent aerobic
 * pace. Returns per-distance time, split, and a confidence interval, plus the
 * basis and a plain disclaimer.
 */
export function racePredictions(analysis) {
  const a = analysis.athlete || {};
  const pace = analysis.paceProgression || {};
  const basis = [];
  let anchor2k = null;          // predicted CURRENT 2k time (seconds)
  let confidence = 'low';

  if (a.best2kSeconds) {
    anchor2k = a.best2kSeconds;
    basis.push(`your ${a.best2kVerified ? 'verified' : 'self-reported'} 2k of ${fmt(a.best2kSeconds)}`);
    // Nudge toward current form using the steady-pace trend (bounded ±3s).
    if (pace.trend === 'improving') { anchor2k -= 2; basis.push('recent steady-state pace trending faster'); }
    else if (pace.trend === 'declining') { anchor2k += 2; basis.push('recent steady-state pace trending slower'); }
    confidence = a.best2kVerified && (analysis.history?.totalWorkouts || 0) >= 10 && pace.trend !== 'declining' ? 'high'
      : (analysis.history?.totalWorkouts || 0) >= 6 ? 'medium' : 'low';
  } else if (pace.steadyPaceRecentS) {
    // No 2k on file: estimate one from recent aerobic pace. Steady UT2/UT1 work
    // typically sits ~13–16 s/500m slower than 2k pace; use 14.
    const est2kSplit = pace.steadyPaceRecentS - 14;
    anchor2k = est2kSplit * 4;
    basis.push(`an estimate from your recent steady-state pace (${fmt(pace.steadyPaceRecentS * 4)}/2k-equivalent)`);
    confidence = 'low';
  } else {
    return { available: false, reason: 'Log a 2k or a few steady rows and we can predict your race times.', predictions: [] };
  }

  const spread = { high: 0.015, medium: 0.03, low: 0.05 }[confidence];
  const predict = (distance) => {
    const t = anchor2k * Math.pow(distance / 2000, RIEGEL_K);
    const splitS = t / (distance / 500);
    return {
      distance,
      label: `${distance}m`,
      timeS: Math.round(t * 10) / 10,
      splitS: Math.round(splitS * 10) / 10,
      time: fmt(t),
      split: fmtSplit(splitS),
      lowS: Math.round(t * (1 - spread)),
      highS: Math.round(t * (1 + spread)),
      range: `${fmt(t * (1 - spread))}–${fmt(t * (1 + spread))}`,
    };
  };

  return {
    available: true,
    confidence,
    confidencePct: { high: 90, medium: 75, low: 55 }[confidence],
    predictions: [predict(2000), predict(5000), predict(6000)],
    basis,
    method: `Endurance extrapolation (Riegel model, exponent ${RIEGEL_K}) anchored on your current 2k fitness.`,
    disclaimer: 'Estimates from your current fitness — actual results depend on the day, conditions, pacing, and taper.',
  };
}

/* ------------------------------------------------------------------ */

function fmt(totalS) {
  if (!Number.isFinite(totalS) || totalS <= 0) return '—';
  totalS = Math.round(totalS);
  const m = Math.floor(totalS / 60), s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtSplit(s) {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
