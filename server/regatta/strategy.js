// Race strategy catalog — explicit pacing plans, never implicit behavior.
//
// A strategy is a power-multiplier profile over race fraction f ∈ [0,1],
// defined by anchor points and linearly interpolated. Every profile is
// normalized to mean 1: a strategy REDISTRIBUTES effort across the course,
// it never conjures extra energy. Whether a redistribution pays off is
// decided by the race dynamics (W′ depletion, drag being cubic in speed) —
// not by the profile itself. Pure module: safe to import on worker threads.

export const STRATEGY_VERSION = 'regatta.strategy@1.0';

/** anchors: [fraction, raw multiplier] pairs; normalized at build time. */
const CATALOG = {
  even: {
    label: 'Even pace',
    description: 'Hold constant power the whole way — the physics optimum on flat conditions.',
    anchors: [[0, 1], [1, 1]],
  },
  negative: {
    label: 'Negative split',
    description: 'Start conservatively, finish faster than you began.',
    anchors: [[0, 0.965], [0.5, 0.99], [0.8, 1.02], [1, 1.05]],
  },
  fastStart: {
    label: 'Fast first 500',
    description: 'Aggressive opening to take early water; costs W′ that must be paid back late.',
    anchors: [[0, 1.09], [0.2, 1.05], [0.4, 0.99], [0.75, 0.97], [1, 0.98]],
  },
  highMidPush: {
    label: 'High-mid push',
    description: 'Even opening, sustained surge through the third quarter.',
    anchors: [[0, 0.99], [0.4, 0.99], [0.5, 1.045], [0.7, 1.045], [0.8, 0.99], [1, 1.0]],
  },
  lateSprint: {
    label: 'Late sprint',
    description: 'Controlled race saving W′ for a maximal final 300 m.',
    anchors: [[0, 0.985], [0.8, 0.985], [0.87, 1.06], [1, 1.10]],
  },
  controlled: {
    label: 'Controlled opening',
    description: 'Ease into rhythm over the first 250 m, then slightly above even.',
    anchors: [[0, 0.95], [0.12, 1.005], [1, 1.01]],
  },
};

/** Numerically normalize anchors so the profile's mean multiplier is 1. */
function normalize(anchors) {
  const SAMPLES = 200;
  let sum = 0;
  for (let i = 0; i < SAMPLES; i++) sum += interpolate(anchors, (i + 0.5) / SAMPLES);
  const meanMult = sum / SAMPLES;
  return anchors.map(([f, m]) => [f, m / meanMult]);
}

function interpolate(anchors, f) {
  const x = Math.min(Math.max(f, 0), 1);
  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i][0]) {
      const [f0, m0] = anchors[i - 1];
      const [f1, m1] = anchors[i];
      return f1 === f0 ? m1 : m0 + ((x - f0) / (f1 - f0)) * (m1 - m0);
    }
  }
  return anchors[anchors.length - 1][1];
}

export const STRATEGIES = Object.fromEntries(
  Object.entries(CATALOG).map(([key, def]) => [key, Object.freeze({
    key,
    label: def.label,
    description: def.description,
    anchors: normalize(def.anchors),
  })]),
);

/**
 * Custom strategy from per-quarter multipliers (coach-designed). Values are
 * clamped to [0.85, 1.15] and normalized to mean 1 like every other profile.
 */
export function customStrategy(quarters) {
  const q = (Array.isArray(quarters) ? quarters : []).slice(0, 4).map(v =>
    Math.min(Math.max(Number(v) || 1, 0.85), 1.15));
  while (q.length < 4) q.push(1);
  const anchors = normalize([[0, q[0]], [0.245, q[0]], [0.255, q[1]], [0.495, q[1]], [0.505, q[2]], [0.745, q[2]], [0.755, q[3]], [1, q[3]]]);
  return { key: 'custom', label: 'Custom (per-500)', anchors };
}

/**
 * Resolve the pacing profile a boat will row. The user rows their chosen
 * strategy. Opponents row a tendency-blend: their estimated aggression pulls
 * the profile toward a fast start, their sprint tendency toward a late
 * sprint — an explainable model of likely opponent decisions, never a claim
 * of certainty (tendencies are sampled with uncertainty upstream).
 */
export function resolveProfile({ strategy = 'even', customQuarters = null, aggression = 0, sprintTendency = 0 } = {}) {
  if (strategy === 'custom') return customStrategy(customQuarters);
  const base = STRATEGIES[strategy] || STRATEGIES.even;
  if (!aggression && !sprintTendency) return base;
  const fast = STRATEGIES.fastStart, sprint = STRATEGIES.lateSprint;
  const a = Math.min(Math.max(aggression, 0), 1), s = Math.min(Math.max(sprintTendency, 0), 1);
  // Blend in anchor space on a common fraction grid, then renormalize.
  const grid = [...new Set([...base.anchors, ...fast.anchors, ...sprint.anchors].map(p => p[0]))].sort((x, y) => x - y);
  const blended = grid.map(f => [f,
    interpolate(base.anchors, f)
    + a * 0.6 * (interpolate(fast.anchors, f) - 1)
    + s * 0.6 * (interpolate(sprint.anchors, f) - 1),
  ]);
  return { key: `${base.key}+tendencies`, label: base.label, anchors: normalize(blended) };
}

/** Power multiplier at race fraction f for a resolved profile. */
export function profileMultiplier(profile, f) {
  return interpolate(profile.anchors, f);
}
