// Stroke dynamics — a six-phase decomposition of the rowing stroke:
//
//   catch → connection → drive → finish → extraction → recovery
//
// With force-curve data (PM5 per-stroke force samples covering the drive),
// phase boundaries come from the measured force profile. Without it, the
// model falls back to rate-based timing with documented assumptions and
// 'assumed' provenance — the shape of the answer is identical either way, so
// consumers handle both by reading provenance, never by branching on nulls.
//
// Documented assumptions (rate-based path):
// - Cycle time = 60/rate seconds.
// - Drive:recovery ratio ≈ 1:2.2 at rate 20, compressing toward 1:1.1 at 36+
//   (standard coaching ratios; linear in rate between).
import { makeEstimate } from '../kernel/estimate.js';

export const STROKE_MODEL_VERSION = 'physics.stroke@1.0';

export const STROKE_PHASES = ['catch', 'connection', 'drive', 'finish', 'extraction', 'recovery'];

/** Drive fraction of the whole cycle at a given stroke rate. */
function driveFraction(rate) {
  const r = Math.min(Math.max(Number(rate) || 24, 14), 44);
  const ratio = Math.max(1.1, 2.2 - (r - 20) * 0.07); // recovery:drive ratio
  return 1 / (1 + ratio);
}

/**
 * Decompose one workout's stroke cycle.
 * ctx = { avgRate, forceCurves: [{ samples: [...] }], nowS }.
 * Returns { phases: { phase → { timingPct: Estimate, powerPct: Estimate|null } },
 *           rhythmRatio: Estimate, driveTimeS: Estimate, source }.
 */
export function decomposeStroke({ avgRate, forceCurves = [], nowS = Math.floor(Date.now() / 1000) }) {
  const rate = Number(avgRate) > 0 ? Number(avgRate) : null;
  const cycleS = rate ? 60 / rate : null;
  const dFrac = driveFraction(rate ?? 24);
  const hasForce = forceCurves.some(c => Array.isArray(c.samples) && c.samples.length >= 8);
  const provenance = hasForce ? 'estimated' : 'assumed';
  const baseConf = hasForce ? 0.6 : 0.2;
  const est = (value, opts = {}) => makeEstimate({
    value, provenance, confidence: baseConf, modelVersion: STROKE_MODEL_VERSION,
    evidenceCount: hasForce ? forceCurves.length : 0, updatedAt: nowS, ...opts,
  });

  // Within-drive sub-phase boundaries. With force data: measured from the
  // averaged profile (rise to 30% of peak = catch+connection; decline past
  // 40% = finish). Without: textbook fractions of the drive.
  let sub = { catch: 0.10, connection: 0.15, drive: 0.50, finish: 0.18, extraction: 0.07 };
  let powerShare = { catch: 0.04, connection: 0.14, drive: 0.62, finish: 0.17, extraction: 0.03 };
  if (hasForce) {
    const profile = averageProfile(forceCurves);
    const peak = Math.max(...profile);
    const n = profile.length;
    const riseEnd = profile.findIndex(v => v >= peak * 0.3);
    let fallStart = n - 1;
    for (let i = n - 1; i >= 0; i--) { if (profile[i] >= peak * 0.4) { fallStart = i; break; } }
    const catchEnd = Math.max(1, Math.round(riseEnd * 0.4));
    const total = profile.reduce((a, b) => a + b, 0) || 1;
    const seg = (a, b) => profile.slice(a, b).reduce((x, y) => x + y, 0) / total;
    sub = {
      catch: catchEnd / n,
      connection: Math.max(0.02, (riseEnd - catchEnd) / n),
      drive: Math.max(0.1, (fallStart - riseEnd) / n),
      finish: Math.max(0.02, (n - 1 - fallStart) / n),
      extraction: 0.05,
    };
    // Renormalize the measured drive portion to sum to 0.95 + fixed extraction.
    const meas = sub.catch + sub.connection + sub.drive + sub.finish;
    for (const k of ['catch', 'connection', 'drive', 'finish']) sub[k] = (sub[k] / meas) * 0.95;
    powerShare = {
      catch: seg(0, catchEnd),
      connection: seg(catchEnd, riseEnd),
      drive: seg(riseEnd, fallStart),
      finish: seg(fallStart, n),
      extraction: 0,
    };
  }

  // Phase timings as % of the FULL cycle: drive phases share dFrac,
  // recovery takes the remainder.
  const phases = {};
  for (const phase of ['catch', 'connection', 'drive', 'finish', 'extraction']) {
    phases[phase] = {
      timingPct: est(sub[phase] * dFrac * 100, { uncertainty: hasForce ? 2 : 5 }),
      powerPct: est(powerShare[phase] * 100, { uncertainty: hasForce ? 4 : 10 }),
    };
  }
  phases.recovery = {
    timingPct: est((1 - dFrac) * 100, { uncertainty: rate ? 3 : 8, provenance: rate ? 'estimated' : 'assumed' }),
    powerPct: est(0, { uncertainty: 0, confidence: 0.9, provenance: 'estimated' }),
  };

  return {
    phases,
    rhythmRatio: est((1 - dFrac) / dFrac, { uncertainty: 0.25 }), // recovery:drive
    driveTimeS: cycleS ? est(cycleS * dFrac, { uncertainty: 0.12 }) : null,
    source: hasForce ? 'force-curve' : 'rate-model',
  };
}

/** Average all strokes' force curves onto a common 32-point profile. */
export function averageProfile(forceCurves, points = 32) {
  const usable = forceCurves.filter(c => Array.isArray(c.samples) && c.samples.length >= 8);
  if (!usable.length) return [];
  const out = new Array(points).fill(0);
  for (const c of usable) {
    const s = c.samples.map(Number);
    for (let i = 0; i < points; i++) {
      const pos = (i / (points - 1)) * (s.length - 1);
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      out[i] += s[lo] + (s[hi] - s[lo]) * (pos - lo);
    }
  }
  return out.map(v => v / usable.length);
}

/** Smoothness of the averaged profile, 0–100 (100 = glass). */
export function profileSmoothness(forceCurves) {
  const profile = averageProfile(forceCurves);
  if (profile.length < 8) return null;
  const peak = Math.max(...profile, 1);
  let jerk = 0;
  for (let i = 2; i < profile.length; i++) jerk += Math.abs(profile[i] - 2 * profile[i - 1] + profile[i - 2]);
  return Math.max(0, Math.min(100, 100 - (jerk / (profile.length - 2) / peak) * 400));
}
