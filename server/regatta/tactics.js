// Tactical race events — optional, probabilistic, documented base rates.
//
// Real races contain discrete incidents that no smooth pacing model
// produces: a crab, an equipment niggle, an opponent's surprise push.
// Each event type has a documented per-race base rate and a bounded,
// explainable effect on the dynamics. Everything here is OFF by default
// and only sampled when the user enables tactical events for a run.
// Psychological pressure is deliberately modeled ONLY as observable pacing
// change (a surge, a response); the engine never claims mental states.
// Pure module: safe on worker threads.

export const TACTICS_VERSION = 'regatta.tactics@1.0';

/** Event catalog with per-race base rates (documented assumptions). */
export const EVENT_TYPES = Object.freeze({
  missedStroke: {
    label: 'Missed stroke / crab',
    baseRate: 0.04,           // ~1 in 25 race-boats catches a minor crab
    durationS: 3,
    powerFactor: 0.35,        // near-total power loss for ~3 s
  },
  equipmentNiggle: {
    label: 'Minor equipment issue',
    baseRate: 0.01,           // loose foot stretcher, slipping seat, …
    durationS: 20,
    dragFactor: 1.05,         // +5% effective drag while coping
  },
  surge: {
    label: 'Unexpected opponent surge',
    baseRate: 0.35,           // scaled by the boat's aggression estimate
    durationS: 30,
    powerFactor: 1.05,        // +5% power for ~30 s (paid from W′)
  },
});

/**
 * Sample this race's events for every boat. Returns per-boat arrays of
 * { type, atFraction, durationS, powerFactor?, dragFactor? } sorted by
 * position on the course. Deterministic given the rng.
 */
export function sampleEvents(boats, rng) {
  return boats.map((boat) => {
    const events = [];
    if (rng.chance(EVENT_TYPES.missedStroke.baseRate)) {
      events.push({
        type: 'missedStroke',
        atFraction: rng.uniform(0.05, 0.95),
        durationS: EVENT_TYPES.missedStroke.durationS,
        powerFactor: EVENT_TYPES.missedStroke.powerFactor,
      });
    }
    if (rng.chance(EVENT_TYPES.equipmentNiggle.baseRate)) {
      events.push({
        type: 'equipmentNiggle',
        atFraction: rng.uniform(0.02, 0.8),
        durationS: EVENT_TYPES.equipmentNiggle.durationS,
        dragFactor: EVENT_TYPES.equipmentNiggle.dragFactor,
      });
    }
    // Surges express estimated aggression as an observable mid-race push.
    if (rng.chance(EVENT_TYPES.surge.baseRate * Math.min(Math.max(boat.aggression || 0, 0), 1))) {
      events.push({
        type: 'surge',
        atFraction: rng.uniform(0.35, 0.7),
        durationS: EVENT_TYPES.surge.durationS,
        powerFactor: EVENT_TYPES.surge.powerFactor,
      });
    }
    return events.sort((a, b) => a.atFraction - b.atFraction);
  });
}

/**
 * Combined event modifiers for one boat at race fraction f, time t.
 * Events are positional (they start at a course fraction) but last a fixed
 * time, so activation is tracked by the stepper via `activeUntilS`.
 */
export function eventModifiers(events, f, tS) {
  let power = 1, drag = 1;
  for (const e of events) {
    if (f >= e.atFraction && e.activeUntilS === undefined) e.activeUntilS = tS + e.durationS;
    if (e.activeUntilS !== undefined && tS <= e.activeUntilS) {
      if (e.powerFactor) power *= e.powerFactor;
      if (e.dragFactor) drag *= e.dragFactor;
    }
  }
  return { power, drag };
}
