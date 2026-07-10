// Beam search: constructive, week by week. Partial plans are extended with
// candidate week-shapes; only the top-K partials (by scalarized evaluation
// of the plan-so-far padded with the athlete's current behavior) survive to
// the next week. Deterministic given the seed, and strong at finding
// well-ordered progressions (build → absorb → build).
import { makeRestDay } from '../planSpace.js';
import { repairPlan, checkConstraints } from '../constraints.js';
import { scalarize } from '../objectives.js';

export const beamSearch = {
  name: 'beam',
  version: '1.0',
  search(ctx) {
    const { seeds, horizonDays, constraints, evaluate, rng, budget, weights } = ctx;
    const weeks = Math.ceil(horizonDays / 7);
    const beamWidth = 6;
    const archive = [];
    let evals = 0;

    // Candidate week shapes come from the seed templates' weeks + mutations.
    const weekShapes = [];
    for (const s of seeds) {
      for (let w = 0; w < Math.ceil(s.days.length / 7); w++) {
        const shape = s.days.slice(w * 7, w * 7 + 7);
        while (shape.length < 7) shape.push(makeRestDay());
        weekShapes.push(shape);
      }
    }
    const uniqueShapes = dedup(weekShapes).slice(0, 14);

    const pad = (days) => {
      const out = days.map(d => ({ ...d }));
      while (out.length < horizonDays) out.push({ ...uniqueShapes[0][out.length % 7] });
      return out.slice(0, horizonDays);
    };
    const evaluateFull = (days) => {
      if (evals >= budget) return null;
      const repaired = repairPlan(days, constraints);
      if (!checkConstraints(repaired, constraints).valid) return null;
      evals++;
      const scores = evaluate(repaired);
      if (!scores) return null;
      archive.push({ days: repaired, scores });
      return scores;
    };

    let beam = [{ days: [] }];
    for (let w = 0; w < weeks && evals < budget; w++) {
      const extended = [];
      for (const partial of beam) {
        // A shuffled subset of shapes per partial keeps the beam diverse.
        for (const shape of rng.shuffle(uniqueShapes).slice(0, 8)) {
          const days = [...partial.days, ...shape.map(d => ({ ...d }))];
          const scores = evaluateFull(pad(days));
          if (scores) extended.push({ days, value: scalarize(scores, weights) });
          if (evals >= budget) break;
        }
        if (evals >= budget) break;
      }
      if (extended.length) beam = extended.sort((a, b) => b.value - a.value).slice(0, beamWidth);
    }
    return { archive, evaluations: evals };
  },
};

function dedup(shapes) {
  const seen = new Set();
  return shapes.filter(s => {
    const key = s.map(d => `${d.type}:${d.minutes}`).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
