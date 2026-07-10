// Search strategy registry — one interface, pluggable implementations, and a
// benchmark harness so "which algorithm is better" is a measured question,
// not folklore. Every strategy is versioned in the kernel registry.
import { register } from '../../kernel/registry.js';
import { createRng } from '../../kernel/rng.js';
import { geneticSearch } from './genetic.js';
import { annealSearch } from './anneal.js';
import { beamSearch } from './beam.js';
import { paretoFrontier } from '../pareto.js';

export const STRATEGIES = { genetic: geneticSearch, anneal: annealSearch, beam: beamSearch };

for (const s of Object.values(STRATEGIES)) {
  register({ name: `optimizer.search.${s.name}`, kind: 'strategy', version: s.version, description: `Plan search strategy: ${s.name}` });
}

export function getStrategy(name) {
  return STRATEGIES[name] || null;
}

/**
 * Benchmark every strategy on the same problem and seed. Returns per-strategy
 * frontier quality (hypervolume proxy: mean of best directional value per
 * objective), frontier size, evaluations, and wall time — persisted by the
 * caller into the run record so strategy claims stay evidence-based.
 */
export function benchmarkStrategies(problem, { budgetPerStrategy = 300, seed = 42 } = {}) {
  const results = [];
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const started = Date.now();
    const { archive, evaluations } = strategy.search({ ...problem, rng: createRng(seed), budget: budgetPerStrategy });
    const frontier = paretoFrontier(archive, { maxSize: 20 });
    results.push({
      strategy: name,
      version: strategy.version,
      evaluations,
      frontierSize: frontier.length,
      bestImprovement: frontier.length ? Math.max(...frontier.map(p => p.scores.improvement)) : null,
      bestAdherence: frontier.length ? Math.max(...frontier.map(p => p.scores.adherence)) : null,
      lowestFatigue: frontier.length ? Math.min(...frontier.map(p => p.scores.fatigue)) : null,
      wallMs: Date.now() - started,
    });
  }
  return results;
}
