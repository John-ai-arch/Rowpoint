// Pareto layer: non-dominated sorting + crowding-distance trimming.
//
// The frontier IS the answer the optimizer gives — a set of plans none of
// which is beaten on every objective, each annotated with the tradeoff that
// justifies its existence. Collapsing to one "best" plan is the USER's
// choice to make, not the engine's.
import { toDirectionalVector, activeKeys, OBJECTIVES } from './objectives.js';

/** a dominates b: ≥ on every objective, > on at least one (directional). */
export function dominates(a, b) {
  let strictly = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-12) return false;
    if (a[i] > b[i] + 1e-12) strictly = true;
  }
  return strictly;
}

/**
 * Extract the Pareto frontier from an archive of { days, scores, ... },
 * trimmed to `maxSize` by crowding distance (keep the spread, drop the
 * crowd). Returns entries sorted by predicted improvement, best first.
 */
export function paretoFrontier(archive, { maxSize = 12 } = {}) {
  if (!archive.length) return [];
  const withVec = archive.map(e => ({ ...e, vec: toDirectionalVector(e.scores) }));
  let frontier = withVec.filter(e => !withVec.some(o => o !== e && dominates(o.vec, e.vec)));

  if (frontier.length > maxSize) {
    const dims = frontier[0].vec.length;
    const crowding = new Array(frontier.length).fill(0);
    for (let d = 0; d < dims; d++) {
      const order = frontier.map((e, i) => i).sort((a, b) => frontier[a].vec[d] - frontier[b].vec[d]);
      const lo = frontier[order[0]].vec[d], hi = frontier[order[order.length - 1]].vec[d];
      const span = hi - lo || 1;
      crowding[order[0]] = Infinity;
      crowding[order[order.length - 1]] = Infinity;
      for (let k = 1; k < order.length - 1; k++) {
        crowding[order[k]] += (frontier[order[k + 1]].vec[d] - frontier[order[k - 1]].vec[d]) / span;
      }
    }
    frontier = frontier
      .map((e, i) => ({ e, c: crowding[i] }))
      .sort((a, b) => b.c - a.c)
      .slice(0, maxSize)
      .map(x => x.e);
  }
  return frontier
    .sort((a, b) => b.scores.improvement - a.scores.improvement)
    .map(({ vec, ...rest }) => rest);
}

/**
 * Human-readable tradeoff line for each frontier plan: what it wins and what
 * it pays for that, relative to the frontier's own ranges.
 */
export function explainTradeoffs(frontier) {
  if (frontier.length < 2) {
    return frontier.map(p => ({ ...p, tradeoff: 'The only plan that survived every constraint and dominance check.' }));
  }
  const keys = activeKeys(frontier[0].scores);
  const ranges = Object.fromEntries(keys.map(k => {
    const vals = frontier.map(p => p.scores[k]);
    return [k, { min: Math.min(...vals), max: Math.max(...vals) }];
  }));
  return frontier.map(p => {
    const strengths = [], costs = [];
    for (const k of keys) {
      const { min, max } = ranges[k];
      if (max - min < 1e-9) continue;
      const rel = (p.scores[k] - min) / (max - min); // position within frontier range
      const good = OBJECTIVES[k].direction === 1 ? rel : 1 - rel;
      if (good >= 0.85) strengths.push(OBJECTIVES[k].label.toLowerCase());
      if (good <= 0.15) costs.push(OBJECTIVES[k].label.toLowerCase());
    }
    let tradeoff;
    if (strengths.length && costs.length) tradeoff = `Best-in-frontier ${strengths.join(' and ')}, paid for with the weakest ${costs.join(' and ')}.`;
    else if (strengths.length) tradeoff = `Leads the frontier on ${strengths.join(' and ')} without a standout weakness.`;
    else if (costs.length) tradeoff = `A balanced middle option — its weakest point is ${costs.join(' and ')}.`;
    else tradeoff = 'A balanced compromise across every objective.';
    return { ...p, tradeoff };
  });
}
