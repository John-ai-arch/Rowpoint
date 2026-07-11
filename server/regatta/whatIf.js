// What-If Lab — modify assumptions, re-simulate, report deltas honestly.
//
// Every what-if starts from a COMPLETED run's stored configuration (so the
// baseline is a real, reproducible record), applies bounded modifications,
// and re-runs a smaller Monte Carlo with a seed derived from the baseline
// seed + the modification set — the same what-if always reproduces the same
// answer. Deltas are reported against the baseline summary, never presented
// as fresh absolute truth (fewer iterations = wider noise, and the response
// says so).
import { seedFrom } from '../kernel/rng.js';
import { runRegattaMC } from './monteCarloRegatta.js';
import { STRATEGIES } from './strategy.js';

export const WHATIF_VERSION = 'regatta.what-if@1.0';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Bounded modification vocabulary — everything a what-if may change. */
export const WHATIF_MODS = Object.freeze({
  powerPct: { label: 'Your sustainable power', min: -8, max: 8, unit: '%' },
  wPrimePct: { label: 'Your anaerobic reserve (W′)', min: -25, max: 25, unit: '%' },
  recoveryPct: { label: 'Recovery state on race day', min: -10, max: 5, unit: '%' },
  strategy: { label: 'Race strategy', options: [...Object.keys(STRATEGIES), 'custom'] },
  headwindMps: { label: 'Headwind', min: -8, max: 12, unit: 'm/s' },
  currentMps: { label: 'Course current', min: -1.5, max: 1.5, unit: 'm/s' },
  laneIndex: { label: 'Your lane', min: 1, max: 8 },
});

/** Sanitize a raw mods object down to the allowed, bounded set. */
export function sanitizeMods(raw = {}) {
  const mods = {};
  for (const key of ['powerPct', 'wPrimePct', 'recoveryPct', 'headwindMps', 'currentMps']) {
    const v = Number(raw[key]);
    if (Number.isFinite(v) && v !== 0) mods[key] = clamp(v, WHATIF_MODS[key].min, WHATIF_MODS[key].max);
  }
  if (typeof raw.strategy === 'string' && (STRATEGIES[raw.strategy] || raw.strategy === 'custom')) {
    mods.strategy = raw.strategy;
    if (raw.strategy === 'custom' && Array.isArray(raw.customQuarters)) {
      mods.customQuarters = raw.customQuarters.slice(0, 4).map(Number);
    }
  }
  if (Number.isFinite(Number(raw.laneIndex))) mods.laneIndex = clamp(Math.round(Number(raw.laneIndex)), 1, 8);
  return mods;
}

/**
 * Apply sanitized mods to a baseline MC config (prepared boats + environment).
 * Returns a new config; the baseline object is never mutated.
 */
export function applyMods(baseConfig, mods) {
  const config = {
    ...baseConfig,
    boats: baseConfig.boats.map(b => ({ ...b })),
    environment: { ...(baseConfig.environment || {}) },
  };
  const user = config.boats.find(b => b.isUser);
  if (user) {
    if (mods.powerPct) user.cpW = Math.round(user.cpW * (1 + mods.powerPct / 100) * 10) / 10;
    if (mods.wPrimePct) user.wPrimeJ = Math.round(user.wPrimeJ * (1 + mods.wPrimePct / 100));
    if (mods.recoveryPct) {
      // Recovery expresses itself as a bounded race-power factor (same
      // mapping the athlete model uses for twin readiness).
      user.readinessFactor = clamp((user.readinessFactor ?? 1) * (1 + mods.recoveryPct / 300), 0.94, 1.02);
    }
  }
  if (mods.strategy) {
    config.strategy = mods.strategy;
    config.customQuarters = mods.strategy === 'custom' ? (mods.customQuarters || null) : null;
  }
  if (mods.headwindMps !== undefined) {
    config.environment.windSpeedMps = Math.abs(mods.headwindMps);
    config.environment.windDirectionDeg = mods.headwindMps >= 0 ? 0 : 180;
    config.environment.headingDeg = 0;
  }
  if (mods.currentMps !== undefined) config.environment.currentMps = mods.currentMps;
  if (mods.laneIndex !== undefined && user) {
    const from = config.boats.indexOf(user);
    const to = clamp(mods.laneIndex - 1, 0, config.boats.length - 1);
    config.boats.splice(from, 1);
    config.boats.splice(to, 0, user);
  }
  return config;
}

/**
 * Evaluate a what-if against a baseline run. `baseConfig` is the stored,
 * prepared MC config of the completed run; `baselineSummary` its stored
 * summary. Runs a smaller MC inline (bounded iterations) and reports deltas.
 */
export function evaluateWhatIf(baseConfig, baselineSummary, rawMods, { iterations = 300 } = {}) {
  const mods = sanitizeMods(rawMods);
  if (!Object.keys(mods).length) {
    return { valid: false, reason: 'No recognized modifications — see the mods vocabulary in /meta.' };
  }
  const config = applyMods(baseConfig, mods);
  config.iterations = clamp(iterations, 100, 500);
  config.seed = seedFrom(baseConfig.seed, 'whatif', JSON.stringify(mods));
  config.compareStrategies = false;
  const { summary } = runRegattaMC(config);
  const d2 = (v) => Math.round(v * 100) / 100;
  return {
    valid: true,
    version: WHATIF_VERSION,
    mods,
    iterations: config.iterations,
    result: {
      winProb: summary.user.winProb,
      medalProb: summary.user.medalProb,
      finishP50: summary.user.finish.p50,
      expectedOrder: summary.expectedOrder,
    },
    deltas: {
      winProb: d2(summary.user.winProb - baselineSummary.user.winProb),
      medalProb: d2(summary.user.medalProb - baselineSummary.user.medalProb),
      finishP50S: d2(summary.user.finish.p50 - baselineSummary.user.finish.p50),
    },
    note: `Re-simulated with ${config.iterations} iterations (baseline used ${baselineSummary.iterations}) — small deltas may be Monte Carlo noise.`,
  };
}
