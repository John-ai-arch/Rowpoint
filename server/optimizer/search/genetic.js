// Genetic search: population evolution with tournament selection, uniform
// crossover, point mutation, and constraint repair. The archive of every
// valid evaluation feeds the Pareto layer — the GA's own scalarized fitness
// only steers exploration.
import { crossoverPlans, mutatePlan } from '../planSpace.js';
import { repairPlan, checkConstraints } from '../constraints.js';
import { scalarize } from '../objectives.js';

export const geneticSearch = {
  name: 'genetic',
  version: '1.0',
  /**
   * ctx: { seeds, horizonDays, constraints, evaluate(days)→scores|null,
   *        rng, budget, weights }
   * evaluate returns null for invalid plans (constraint gate inside).
   */
  search(ctx) {
    const { seeds, constraints, evaluate, rng, budget, weights } = ctx;
    const popSize = 24;
    const archive = [];
    let evals = 0;
    const tryAdd = (days) => {
      if (evals >= budget) return null;
      const repaired = repairPlan(days, constraints);
      if (!checkConstraints(repaired, constraints).valid) return null;
      evals++;
      const scores = evaluate(repaired);
      if (!scores) return null;
      const entry = { days: repaired, scores, fitness: scalarize(scores, weights) };
      archive.push(entry);
      return entry;
    };

    let population = [];
    for (const s of seeds) { const e = tryAdd(s.days); if (e) population.push(e); }
    while (population.length < popSize && evals < budget) {
      const base = population.length ? rng.pick(population).days : seeds[0].days;
      const e = tryAdd(mutatePlan(base, rng));
      if (e) population.push(e);
    }

    const tournament = () => {
      const a = rng.pick(population), b = rng.pick(population);
      return a.fitness >= b.fitness ? a : b;
    };

    while (evals < budget && population.length >= 2) {
      const child = mutatePlan(crossoverPlans(tournament().days, tournament().days, rng), rng);
      const e = tryAdd(child);
      if (e) {
        // Steady-state replacement: the child evicts the current worst.
        let worst = 0;
        for (let i = 1; i < population.length; i++) if (population[i].fitness < population[worst].fitness) worst = i;
        if (e.fitness > population[worst].fitness) population[worst] = e;
      }
    }
    return { archive, evaluations: evals };
  },
};
