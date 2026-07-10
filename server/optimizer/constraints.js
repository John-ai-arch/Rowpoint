// Hard constraints — candidate plans that violate any of these are PRUNED,
// never merely scored down. Soft preferences belong in objectives.js; this
// file is only for lines that must not be crossed (safety, availability,
// the coach's word, race logistics).
import { HARD_TYPES, slotLoad } from './planSpace.js';

/** Defaults, overridable per run (user config or coach policy). */
export function defaultConstraints(profile = {}) {
  return {
    maxDailyMinutes: 150,
    maxWeeklyMinutes: Math.max(300, Math.round((profile.weeklyMinutesRecent || 240) * 1.6)),
    // Ramp guard: weekly load may not exceed recent chronic weekly load ×1.5
    // (ACWR-style hard cap — the optimizer must never PLAN a load spike).
    maxWeeklyLoad: Math.max(120, (profile.chronicWeeklyLoad || 100) * 1.5),
    minRestDaysPerWeek: 1,
    maxHardPerWeek: 3,
    maxConsecutiveHardDays: 1,
    unavailableWeekdays: profile.unavailableWeekdays || [],   // 0=first plan day
    fixedDays: profile.fixedDays || {},                        // dayIndex → slot (coach assignments)
    raceDayIndex: profile.raceDayIndex ?? null,                // hard sessions banned 2 days prior
  };
}

/**
 * Validate a plan. Returns { valid, violations: [strings] } — violations name
 * the specific rule and day so explanations can cite what bound the search.
 */
export function checkConstraints(days, c) {
  const violations = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d.minutes > c.maxDailyMinutes) violations.push(`day ${i + 1}: ${d.minutes}min exceeds daily cap ${c.maxDailyMinutes}`);
    if (c.unavailableWeekdays.includes(i % 7) && d.type !== 'rest') violations.push(`day ${i + 1}: unavailable weekday`);
    const fixed = c.fixedDays[i];
    if (fixed && (d.type !== fixed.type || d.minutes !== fixed.minutes)) violations.push(`day ${i + 1}: coach-assigned session must stay (${fixed.type} ${fixed.minutes}min)`);
  }
  // Weekly windows.
  for (let w = 0; w * 7 < days.length; w++) {
    const week = days.slice(w * 7, w * 7 + 7);
    const minutes = week.reduce((s, d) => s + d.minutes, 0);
    if (minutes > c.maxWeeklyMinutes) violations.push(`week ${w + 1}: ${minutes}min exceeds weekly cap ${c.maxWeeklyMinutes}`);
    const load = week.reduce((s, d) => s + slotLoad(d), 0);
    if (load > c.maxWeeklyLoad) violations.push(`week ${w + 1}: load ${Math.round(load)} exceeds ramp guard ${Math.round(c.maxWeeklyLoad)}`);
    const rest = week.filter(d => d.type === 'rest').length;
    if (week.length === 7 && rest < c.minRestDaysPerWeek) violations.push(`week ${w + 1}: fewer than ${c.minRestDaysPerWeek} rest day(s)`);
    const hard = week.filter(d => HARD_TYPES.has(d.type)).length;
    if (hard > c.maxHardPerWeek) violations.push(`week ${w + 1}: ${hard} hard sessions exceeds ${c.maxHardPerWeek}`);
  }
  // Consecutive hard days.
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = HARD_TYPES.has(days[i].type) ? run + 1 : 0;
    if (run > c.maxConsecutiveHardDays) { violations.push(`day ${i + 1}: more than ${c.maxConsecutiveHardDays} consecutive hard day(s)`); break; }
  }
  // Race taper: the 2 days before a race carry no hard work.
  if (c.raceDayIndex !== null && c.raceDayIndex >= 0) {
    for (const off of [1, 2]) {
      const i = c.raceDayIndex - off;
      if (i >= 0 && i < days.length && HARD_TYPES.has(days[i].type)) violations.push(`day ${i + 1}: hard session ${off} day(s) before the race`);
    }
  }
  return { valid: violations.length === 0, violations };
}

/**
 * Repair a plan toward validity (used by search after mutation): drops the
 * cheapest offending sessions instead of discarding the whole candidate.
 * Not guaranteed to fix everything — checkConstraints remains the gate.
 */
export function repairPlan(days, c) {
  const out = days.map(d => ({ ...d }));
  // Restore fixed days & clear unavailable ones first (cheap, always right).
  for (let i = 0; i < out.length; i++) {
    if (c.fixedDays[i]) out[i] = { ...c.fixedDays[i] };
    else if (c.unavailableWeekdays.includes(i % 7)) out[i] = { type: 'rest', minutes: 0 };
  }
  // Enforce weekly rest and hard caps by downgrading from the week's end.
  for (let w = 0; w * 7 < out.length; w++) {
    const idx = Array.from({ length: Math.min(7, out.length - w * 7) }, (_, k) => w * 7 + k);
    let rest = idx.filter(i => out[i].type === 'rest').length;
    for (let k = idx.length - 1; k >= 0 && rest < c.minRestDaysPerWeek; k--) {
      const i = idx[k];
      if (out[i].type !== 'rest' && !c.fixedDays[i]) { out[i] = { type: 'rest', minutes: 0 }; rest++; }
    }
    let hard = idx.filter(i => HARD_TYPES.has(out[i].type)).length;
    for (let k = idx.length - 1; k >= 0 && hard > c.maxHardPerWeek; k--) {
      const i = idx[k];
      if (HARD_TYPES.has(out[i].type) && !c.fixedDays[i]) { out[i] = { type: 'ut2', minutes: out[i].minutes || 45 }; hard--; }
    }
  }
  // Split consecutive hard days.
  for (let i = 1; i < out.length; i++) {
    if (HARD_TYPES.has(out[i].type) && HARD_TYPES.has(out[i - 1].type) && !c.fixedDays[i]) {
      out[i] = { type: 'ut2', minutes: Math.min(out[i].minutes || 45, 60) };
    }
  }
  // Pre-race taper.
  if (c.raceDayIndex !== null) {
    for (const off of [1, 2]) {
      const i = c.raceDayIndex - off;
      if (i >= 0 && i < out.length && HARD_TYPES.has(out[i].type) && !c.fixedDays[i]) out[i] = { type: 'ut2', minutes: 30 };
    }
  }
  // Volume/load caps: shrink, then downgrade, then rest — always attacking
  // the week's heaviest non-fixed session, so the plan's shape survives.
  const SOFTER = { sprint: 'vo2', vo2: 'threshold', threshold: 'ut1', ut1: 'ut2' };
  for (let w = 0; w * 7 < out.length; w++) {
    const idx = Array.from({ length: Math.min(7, out.length - w * 7) }, (_, k) => w * 7 + k)
      .filter(i => !c.fixedDays[i]);
    for (let guard = 0; guard < 60; guard++) {
      const minutes = idx.reduce((s, i) => s + out[i].minutes, 0)
        + Object.keys(c.fixedDays).filter(i => Math.floor(i / 7) === w).reduce((s, i) => s + c.fixedDays[i].minutes, 0);
      const load = out.slice(w * 7, w * 7 + 7).reduce((s, d) => s + slotLoad(d), 0);
      if (minutes <= c.maxWeeklyMinutes && load <= c.maxWeeklyLoad) break;
      // Heaviest adjustable session this week.
      let heavy = -1;
      for (const i of idx) if (out[i].type !== 'rest' && (heavy === -1 || slotLoad(out[i]) > slotLoad(out[heavy]))) heavy = i;
      if (heavy === -1) break;
      const d = out[heavy];
      if (d.minutes > 45) d.minutes -= 15;
      else if (SOFTER[d.type]) d.type = SOFTER[d.type];
      else if (d.minutes > 30) d.minutes -= 15;
      else out[heavy] = { type: 'rest', minutes: 0 };
    }
  }
  return out;
}
