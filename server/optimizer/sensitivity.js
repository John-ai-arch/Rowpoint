// Sensitivity analysis — how much does the recommendation move when the
// world doesn't cooperate? Each scenario deterministically perturbs either
// the plan or the athlete model, re-simulates, and reports the objective
// deltas. A plan whose value survives the scenarios is robust; one that
// only wins in the best case says so before the athlete commits to it.
import { simulatePlan } from './simulate.js';
import { scorePlan } from './objectives.js';
import { clonePlan } from './planSpace.js';

export const SENSITIVITY_VERSION = 'optimizer.sensitivity@1.0';

const SCENARIOS = [
  {
    key: 'missedSessions',
    label: 'One missed session per week',
    apply: ({ days }) => {
      const out = clonePlan(days);
      for (let w = 0; w * 7 < out.length; w++) {
        // The week's longest session is the one life usually eats.
        let best = -1;
        for (let i = w * 7; i < Math.min(w * 7 + 7, out.length); i++) {
          if (out[i].type !== 'rest' && (best === -1 || out[i].minutes > out[best].minutes)) best = i;
        }
        if (best >= 0) out[best] = { type: 'rest', minutes: 0 };
      }
      return { days: out };
    },
  },
  {
    key: 'poorSleep',
    label: 'A stretch of poor sleep (recovery 30% slower)',
    apply: ({ athlete }) => ({ athlete: { ...athlete, recoveryHalfLifeH: (athlete.recoveryHalfLifeH || 24) * 1.3 } }),
  },
  {
    key: 'illness',
    label: 'Four days ill mid-plan',
    apply: ({ days }) => {
      const out = clonePlan(days);
      const start = Math.floor(out.length / 3);
      for (let i = start; i < Math.min(start + 4, out.length); i++) out[i] = { type: 'rest', minutes: 0 };
      return { days: out };
    },
  },
  {
    key: 'compressedWeek',
    label: 'A schedule crunch (all sessions 25% shorter)',
    apply: ({ days }) => ({
      days: days.map(d => d.type === 'rest' ? { ...d } : { ...d, minutes: Math.max(30, Math.round(d.minutes * 0.75 / 15) * 15) }),
    }),
  },
];

/**
 * @returns { scenarios: [{ key, label, improvementDelta, fatigueDelta }],
 *            robustness: 0..1, verdict }
 */
export function sensitivityAnalysis(days, athlete, { raceDayIndex = null } = {}) {
  const base = scorePlan(days, simulatePlan(days, athlete), athlete, { raceDayIndex });
  const results = [];
  for (const sc of SCENARIOS) {
    const changed = sc.apply({ days, athlete });
    const scDays = changed.days || days;
    const scAthlete = changed.athlete || athlete;
    const scores = scorePlan(scDays, simulatePlan(scDays, scAthlete), scAthlete, { raceDayIndex });
    results.push({
      key: sc.key,
      label: sc.label,
      improvementDelta: Math.round((scores.improvement - base.improvement) * 10) / 10,
      fatigueDelta: Math.round((scores.fatigue - base.fatigue) * 10) / 10,
    });
  }
  // Robustness: how much of the baseline improvement survives the average
  // adverse scenario (only degradations count against it).
  const baseGain = Math.max(Math.abs(base.improvement), 5);
  const meanLoss = results.reduce((s, r) => s + Math.max(0, -r.improvementDelta), 0) / results.length;
  const robustness = Math.round(Math.max(0, 1 - meanLoss / baseGain) * 100) / 100;
  return {
    version: SENSITIVITY_VERSION,
    baseline: base,
    scenarios: results,
    robustness,
    verdict: robustness >= 0.7
      ? 'Robust: the plan keeps most of its value under realistic disruptions.'
      : robustness >= 0.4
        ? 'Moderately sensitive: disruptions cost a meaningful share of the predicted gain.'
        : 'Fragile: this plan\'s predicted gain depends on things going right.',
  };
}
