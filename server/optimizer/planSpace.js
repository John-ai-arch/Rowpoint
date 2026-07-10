// Training-plan decision space.
//
// A plan is a fixed-length vector of day slots over the optimization horizon.
// Each slot is one decision: what kind of session (or rest) and how long.
// This representation is deliberately small and uniform — search strategies
// mutate/cross plans without knowing anything about physiology, and the
// simulator gives the vector meaning.

/** Session types and their relative intensity factor (2k-pace-relative IF). */
export const SESSION_TYPES = Object.freeze({
  rest: { if: 0, label: 'Rest' },
  ut2: { if: 0.65, label: 'Steady UT2' },
  ut1: { if: 0.75, label: 'Endurance UT1' },
  threshold: { if: 0.85, label: 'Threshold' },
  vo2: { if: 0.95, label: 'VO2 intervals' },
  sprint: { if: 1.05, label: 'Sprint work' },
  strength: { if: 0.45, label: 'Strength' },
  cross: { if: 0.55, label: 'Cross-training' },
});

export const TYPES = Object.keys(SESSION_TYPES);
export const HARD_TYPES = new Set(['threshold', 'vo2', 'sprint']);
export const DURATIONS = [0, 30, 45, 60, 75, 90]; // minutes; 0 only with rest

/** Daily TSS-like load of one slot (matches the twin's load feature scale). */
export function slotLoad(slot) {
  const t = SESSION_TYPES[slot.type];
  if (!t || slot.type === 'rest') return 0;
  return (slot.minutes / 60) * t.if ** 2 * 100;
}

export function makeRestDay() { return { type: 'rest', minutes: 0 }; }

/** Deterministic plan signature for dedup in search archives. */
export function planSignature(days) {
  return days.map(d => `${d.type}:${d.minutes}`).join('|');
}

export function clonePlan(days) { return days.map(d => ({ ...d })); }

/**
 * Seed templates — the search's starting population. Named after the
 * periodization engine's phase philosophy (base/build/peak/taper) plus the
 * athlete's own demonstrated weekly pattern, so optimization starts from
 * recognizable coaching shapes rather than noise.
 */
export function seedPlans({ horizonDays, sessionsPerWeek = 4, sessionMinutes = 45, recentWeekPattern = null }) {
  const weeks = Math.ceil(horizonDays / 7);
  const mk = (weekTemplate) => {
    const days = [];
    for (let w = 0; w < weeks; w++) for (let d = 0; d < 7 && days.length < horizonDays; d++) days.push({ ...weekTemplate[d] });
    return days;
  };
  const R = makeRestDay();
  const s = (type, minutes = sessionMinutes) => ({ type, minutes });
  const templates = {
    // Base: aerobic volume, one quality touch.
    base: [s('ut2', 60), s('ut1'), R, s('ut2', 60), s('threshold'), s('ut2', 75), R],
    // Build: two quality sessions inside sustained volume.
    build: [s('threshold'), s('ut2', 60), s('vo2'), R, s('ut1'), s('ut2', 75), R],
    // Peak: race-pace sharpness, reduced volume.
    peak: [s('vo2'), s('ut2', 45), R, s('sprint', 30), s('ut1', 45), s('threshold'), R],
    // Taper: frequency kept, load cut.
    taper: [s('ut2', 30), R, s('threshold', 30), R, s('ut2', 30), R, R],
    // Polarized: mostly easy, small sharp top end.
    polarized: [s('ut2', 75), s('ut2', 60), R, s('vo2'), s('ut2', 60), s('ut2', 75), R],
  };
  const seeds = Object.entries(templates).map(([name, tpl]) => ({ name, days: mk(tpl) }));
  if (recentWeekPattern?.length === 7) seeds.push({ name: 'current-behavior', days: mk(recentWeekPattern) });
  // Trim each template toward the athlete's available frequency.
  for (const seed of seeds) {
    let excess = seed.days.filter(d => d.type !== 'rest').length - Math.ceil((sessionsPerWeek * horizonDays) / 7);
    for (let i = seed.days.length - 1; i >= 0 && excess > 0; i--) {
      if (seed.days[i].type !== 'rest' && !HARD_TYPES.has(seed.days[i].type)) { seed.days[i] = makeRestDay(); excess--; }
    }
  }
  return seeds;
}

/** Random valid-ish plan (constraints filter later). */
export function randomPlan(horizonDays, rng) {
  return Array.from({ length: horizonDays }, () => randomSlot(rng));
}

export function randomSlot(rng) {
  const type = rng.pick(TYPES);
  if (type === 'rest') return makeRestDay();
  return { type, minutes: rng.pick(DURATIONS.slice(1)) };
}

/** Point mutation: change one day's decision. */
export function mutatePlan(days, rng) {
  const out = clonePlan(days);
  const i = rng.int(0, out.length - 1);
  const roll = rng.float();
  if (roll < 0.35) out[i] = makeRestDay();
  else if (roll < 0.7) out[i] = randomSlot(rng);
  else if (out[i].type !== 'rest') out[i].minutes = rng.pick(DURATIONS.slice(1));
  else out[i] = randomSlot(rng);
  return out;
}

/** Uniform crossover of two parents. */
export function crossoverPlans(a, b, rng) {
  return a.map((day, i) => ({ ...(rng.chance(0.5) ? day : b[i]) }));
}
