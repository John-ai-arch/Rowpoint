// Computational dependency graph with per-key dirty tracking.
//
// Engines declare computation nodes and what they depend on; the graph
// guarantees topological execution order and recomputes only what a change
// actually invalidated. "Key" scopes staleness — in practice the athlete's
// user id — so one athlete's new workout never triggers recomputation for
// anyone else.
//
// Cycles are rejected at registration time, not discovered at run time.
// Pure module (no database): persistence of node outputs is each node's own
// responsibility inside its compute function.

export function createGraph(graphName) {
  const nodes = new Map();          // name → { name, dependsOn, compute }
  const dependents = new Map();     // name → Set of downstream node names
  const staleByKey = new Map();     // key → Set of stale node names
  let orderCache = null;

  function assertNoCycle(fromName, deps) {
    // Would adding `fromName` (depending on `deps`) close a cycle? Walk up
    // from each dependency through existing edges looking for fromName.
    const visit = (name, seen) => {
      if (name === fromName) throw new Error(`Cycle detected in graph "${graphName}" adding node "${fromName}"`);
      if (seen.has(name) || !nodes.has(name)) return;
      seen.add(name);
      for (const dep of nodes.get(name).dependsOn) visit(dep, seen);
    };
    for (const dep of deps) visit(dep, new Set());
  }

  const graph = {
    name: graphName,

    /** Declare a computation node. Dependencies may be declared later (forward refs allowed). */
    node({ name, dependsOn = [], compute }) {
      if (!name || typeof name !== 'string') throw new TypeError('Graph node needs a name');
      if (nodes.has(name)) throw new Error(`Graph "${graphName}" already has a node "${name}"`);
      if (typeof compute !== 'function') throw new TypeError(`Graph node "${name}" needs a compute function`);
      assertNoCycle(name, dependsOn);
      nodes.set(name, { name, dependsOn: [...dependsOn], compute });
      for (const dep of dependsOn) {
        if (!dependents.has(dep)) dependents.set(dep, new Set());
        dependents.get(dep).add(name);
      }
      orderCache = null;
      return graph;
    },

    /** Topological order (dependencies first). Throws on unresolved deps. */
    topoOrder() {
      if (orderCache) return orderCache;
      for (const n of nodes.values()) {
        for (const dep of n.dependsOn) {
          if (!nodes.has(dep)) throw new Error(`Graph "${graphName}": node "${n.name}" depends on unknown node "${dep}"`);
        }
      }
      const order = [];
      const state = new Map(); // 0 visiting, 1 done
      const visit = (name) => {
        if (state.get(name) === 1) return;
        if (state.get(name) === 0) throw new Error(`Cycle detected in graph "${graphName}" at "${name}"`);
        state.set(name, 0);
        for (const dep of nodes.get(name).dependsOn) visit(dep);
        state.set(name, 1);
        order.push(name);
      };
      for (const name of nodes.keys()) visit(name);
      orderCache = order;
      return order;
    },

    /**
     * Mark a node (or, with no node name, every node) stale for a key.
     * Staleness propagates to all transitive dependents automatically.
     */
    markStale(key, nodeName = null) {
      if (!staleByKey.has(key)) staleByKey.set(key, new Set());
      const stale = staleByKey.get(key);
      const spread = (name) => {
        if (stale.has(name)) return;
        stale.add(name);
        for (const dep of dependents.get(name) || []) spread(dep);
      };
      if (nodeName === null) for (const name of nodes.keys()) stale.add(name);
      else {
        if (!nodes.has(nodeName)) throw new Error(`Graph "${graphName}": unknown node "${nodeName}"`);
        spread(nodeName);
      }
    },

    staleNodes(key) { return [...(staleByKey.get(key) || [])]; },

    /**
     * Run the graph for a key: stale nodes execute in topological order, each
     * receiving (ctx, resultsSoFar). Clean nodes are skipped — their previous
     * output is whatever they persisted themselves. Returns
     * { ran: [names], results: { name → returned value } }.
     * A node failure stops the run (downstream nodes stay stale) and rethrows.
     */
    async run(key, ctx = {}) {
      const stale = staleByKey.get(key) || new Set();
      const results = {};
      const ran = [];
      for (const name of graph.topoOrder()) {
        if (!stale.has(name)) continue;
        results[name] = await nodes.get(name).compute(ctx, results);
        stale.delete(name);
        ran.push(name);
      }
      return { ran, results };
    },

    nodeNames() { return [...nodes.keys()]; },
    /** Edges as { from, to } pairs — powers generated architecture docs. */
    edges() {
      const out = [];
      for (const n of nodes.values()) for (const dep of n.dependsOn) out.push({ from: dep, to: n.name });
      return out;
    },
  };
  return graph;
}
