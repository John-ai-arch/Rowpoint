// Client/server-side workout plan validation (§1.3). These mirror the PM5's
// documented constraints so users get instant feedback BEFORE connecting; the
// machine's own validation remains authoritative and its errors are surfaced
// verbatim by the BLE layer (firmware minimums change across revisions).
export const PLAN_LIMITS = {
  minTimeS: 20,             // PM5 minimum programmable time workout
  maxTimeS: 9 * 3600 + 59 * 60 + 59,
  minDistanceM: 100,        // PM5 minimum programmable distance
  maxDistanceM: 50000,
  minIntervals: 1,
  maxIntervals: 30,         // PM5 v2 interval limit
  minRestS: 0,
  maxRestS: 9 * 60 + 55,
  minCalories: 1,
  maxCalories: 2000,
};

export function validatePlan(plan) {
  const err = (error) => ({ ok: false, error });
  if (!plan || typeof plan !== 'object') return err('No workout plan provided.');
  const L = PLAN_LIMITS;

  if (plan.type === 'time') {
    const t = Number(plan.durationS);
    if (!Number.isFinite(t)) return err('Time workout needs a duration.');
    if (t < L.minTimeS) return err(`Minimum time workout is ${L.minTimeS} seconds.`);
    if (t > L.maxTimeS) return err('Time workout is too long for the monitor.');
    return { ok: true };
  }
  if (plan.type === 'distance') {
    const d = Number(plan.distanceM);
    if (!Number.isFinite(d)) return err('Distance workout needs a distance.');
    if (d < L.minDistanceM) return err(`Minimum distance workout is ${L.minDistanceM} m.`);
    if (d > L.maxDistanceM) return err(`Maximum distance workout is ${L.maxDistanceM} m.`);
    return { ok: true };
  }
  if (plan.type === 'intervals') {
    if (!Array.isArray(plan.intervals) || plan.intervals.length < L.minIntervals) {
      return err('Interval workout needs at least one interval.');
    }
    if (plan.intervals.length > L.maxIntervals) {
      return err(`The monitor supports at most ${L.maxIntervals} intervals.`);
    }
    for (let i = 0; i < plan.intervals.length; i++) {
      const iv = plan.intervals[i];
      const label = `Interval ${i + 1}`;
      if (iv.workType === 'time') {
        const t = Number(iv.workTimeS);
        if (!Number.isFinite(t) || t < L.minTimeS) return err(`${label}: work time must be at least ${L.minTimeS} s.`);
        if (t > L.maxTimeS) return err(`${label}: work time too long.`);
      } else if (iv.workType === 'distance') {
        const d = Number(iv.workDistanceM);
        if (!Number.isFinite(d) || d < L.minDistanceM) return err(`${label}: work distance must be at least ${L.minDistanceM} m.`);
        if (d > L.maxDistanceM) return err(`${label}: work distance too long.`);
      } else if (iv.workType === 'calories') {
        const c = Number(iv.workCalories);
        if (!Number.isFinite(c) || c < L.minCalories || c > L.maxCalories) return err(`${label}: calories out of range.`);
      } else {
        return err(`${label}: unknown work type.`);
      }
      const rest = Number(iv.restTimeS ?? 0);
      if (!Number.isFinite(rest) || rest < L.minRestS || rest > L.maxRestS) {
        return err(`${label}: rest must be between ${L.minRestS} and ${L.maxRestS} s.`);
      }
    }
    return { ok: true };
  }
  if (plan.type === 'justrow') return { ok: true };
  return err('Unknown workout type.');
}

export function describePlan(plan) {
  if (!plan) return 'Just row';
  if (plan.type === 'time') {
    const m = Math.floor(plan.durationS / 60), s = plan.durationS % 60;
    return `${m}:${String(s).padStart(2, '0')} timed piece`;
  }
  if (plan.type === 'distance') return `${plan.distanceM} m piece`;
  if (plan.type === 'intervals') {
    const n = plan.intervals.length;
    const first = plan.intervals[0];
    const work = first.workType === 'time' ? `${Math.round(first.workTimeS / 60)}min` :
      first.workType === 'distance' ? `${first.workDistanceM}m` : `${first.workCalories}cal`;
    const rest = first.restTimeS ? `/${first.restTimeS}s rest` : '';
    return `${n} × ${work}${rest}`;
  }
  return 'Just row';
}
