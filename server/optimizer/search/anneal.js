// Simulated annealing with weight-vector restarts: each restart draws a
// random emphasis over the objectives, so successive chains walk toward
// different regions of the tradeoff surface and the combined archive covers
// the frontier instead of piling onto one corner.
import { mutatePlan } from '../planSpace.js';
import { repairPlan, checkConstraints } from '../constraints.js';
import { scalarize, OBJECTIVES } from '../objectives.js';

export const annealSearch = {
  name: 'anneal',
  version: '1.0',
  search(ctx) {
    const { seeds, constraints, evaluate, rng, budget } = ctx;
    const archive = [];
    let evals = 0;
    const evaluateValid = (days) => {
      if (evals >= budget) return null;
      const repaired = repairPlan(days, constraints);
      if (!checkConstraints(repaired, constraints).valid) return null;
      evals++;
      const scores = evaluate(repaired);
      if (!scores) return null;
      const entry = { days: repaired, scores };
      archive.push(entry);
      return entry;
    };

    const restarts = 4;
    const perChain = Math.floor(budget / restarts);
    for (let r = 0; r < restarts && evals < budget; r++) {
      // Random objective emphasis for this chain.
      const weights = Object.fromEntries(Object.keys(OBJECTIVES).map(k => [k, 0.4 + rng.float() * 1.6]));
      let current = evaluateValid(seeds[r % seeds.length].days);
      if (!current) continue;
      let currentE = scalarize(current.scores, weights);
      let temp = 1.0;
      const cooling = Math.pow(0.01, 1 / Math.max(perChain, 1)); // → temp ~0.01 by chain end
      for (let step = 0; step < perChain && evals < budget; step++) {
        const cand = evaluateValid(mutatePlan(current.days, rng));
        temp *= cooling;
        if (!cand) continue;
        const candE = scalarize(cand.scores, weights);
        if (candE >= currentE || rng.chance(Math.exp((candE - currentE) / Math.max(temp, 1e-6)))) {
          current = cand;
          currentE = candE;
        }
      }
    }
    return { archive, evaluations: evals };
  },
};
