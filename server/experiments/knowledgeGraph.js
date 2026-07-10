// The versioned knowledge graph — what the platform believes and why.
//
// Nodes: models, hypotheses, state variables, findings, experiments.
// Edges: evidenced relationships ('assumes', 'affects', 'supports',
// 'contradicts', 'validates'), each carrying confidence, evidence source,
// model version, and last-validation date. The graph evolves only through
// recorded changes (every mutation appends a notebook entry), so its history
// is reconstructable.
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { appendNotebook } from './notebook.js';

export const GRAPH_VERSION = 'experiments.knowledge-graph@1.0';

export const NODE_KINDS = ['model', 'hypothesis', 'variable', 'finding', 'experiment'];
export const RELATIONS = ['assumes', 'affects', 'supports', 'contradicts', 'validates'];

/** Idempotent node creation. Returns node id. */
export function ensureNode(kind, label, meta = null) {
  if (!NODE_KINDS.includes(kind)) throw new Error(`Unknown node kind: ${kind}`);
  const existing = db.prepare('SELECT id FROM knowledge_nodes WHERE kind = ? AND label = ?').get(kind, label);
  if (existing) return existing.id;
  const id = uuid();
  db.prepare('INSERT INTO knowledge_nodes (id, kind, label, meta_json, created_at) VALUES (?,?,?,?,?)')
    .run(id, kind, label, meta ? JSON.stringify(meta) : null, now());
  return id;
}

/**
 * Create or update an edge. Updates refresh confidence/evidence and the
 * last-validated date; every change is notebook-recorded.
 */
export function ensureEdge(fromId, toId, relation, { confidence = null, evidenceSource = null, modelVersion = null } = {}) {
  if (!RELATIONS.includes(relation)) throw new Error(`Unknown relation: ${relation}`);
  const existing = db.prepare('SELECT * FROM knowledge_edges WHERE from_node = ? AND to_node = ? AND relation = ?')
    .get(fromId, toId, relation);
  if (existing) {
    const changed = confidence !== null && Math.abs((existing.confidence ?? -1) - confidence) > 1e-9;
    db.prepare('UPDATE knowledge_edges SET confidence = COALESCE(?, confidence), evidence_source = COALESCE(?, evidence_source), model_version = COALESCE(?, model_version), last_validated_at = ? WHERE id = ?')
      .run(confidence, evidenceSource, modelVersion, now(), existing.id);
    if (changed) {
      appendNotebook('knowledge-graph-change', existing.id, {
        change: 'edge-confidence', relation, confidence: { before: existing.confidence, after: confidence }, evidenceSource,
      });
    }
    return existing.id;
  }
  const id = uuid();
  db.prepare(`INSERT INTO knowledge_edges (id, from_node, to_node, relation, confidence, evidence_source, model_version, last_validated_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, fromId, toId, relation, confidence, evidenceSource, modelVersion, now(), now());
  appendNotebook('knowledge-graph-change', id, { change: 'edge-added', relation, evidenceSource, confidence });
  return id;
}

/** Structural summary for dashboards + docs. */
export function graphStats() {
  const nodes = Object.fromEntries(db.prepare('SELECT kind, COUNT(*) n FROM knowledge_nodes GROUP BY kind').all().map(r => [r.kind, r.n]));
  const edges = Object.fromEntries(db.prepare('SELECT relation, COUNT(*) n FROM knowledge_edges GROUP BY relation').all().map(r => [r.relation, r.n]));
  const stale = db.prepare('SELECT COUNT(*) n FROM knowledge_edges WHERE last_validated_at < ?').get(now() - 90 * 86400).n;
  return {
    nodes, edges,
    totalNodes: Object.values(nodes).reduce((a, b) => a + b, 0),
    totalEdges: Object.values(edges).reduce((a, b) => a + b, 0),
    edgesUnvalidated90d: stale,
    version: GRAPH_VERSION,
  };
}

/** Full export (admin/docs): nodes + edges with labels resolved. */
export function exportGraph() {
  const nodes = db.prepare('SELECT * FROM knowledge_nodes').all()
    .map(n => ({ id: n.id, kind: n.kind, label: n.label, meta: safeJson(n.meta_json, null) }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = db.prepare('SELECT * FROM knowledge_edges').all().map(e => ({
    from: byId.get(e.from_node)?.label, fromKind: byId.get(e.from_node)?.kind,
    to: byId.get(e.to_node)?.label, toKind: byId.get(e.to_node)?.kind,
    relation: e.relation, confidence: e.confidence,
    evidenceSource: e.evidence_source, modelVersion: e.model_version, lastValidatedAt: e.last_validated_at,
  }));
  return { version: GRAPH_VERSION, exportedAt: now(), nodes, edges };
}

/**
 * Seed the structural backbone: every seed hypothesis links to its origin
 * model ('assumes') and to the state variables it concerns ('affects').
 */
export function seedGraph(seedHypotheses) {
  const AFFECTS = {
    'cp-2k-fraction': ['power.criticalPowerW'],
    'riegel-endurance': ['readiness.score'],
    'steady-volume-aerobic': ['efficiency.paceHrIndex', 'aerobic.capacityIndex'],
    'monotony-plateau': ['adaptation.plateauRisk', 'injuryRisk.monotonyIndex'],
    'acwr-strain': ['injuryRisk.loadSpikeIndex', 'fatigue.acwr'],
    'recovery-half-life': ['recovery.recoveryHalfLifeH'],
    'taper-freshness': ['readiness.score', 'fatigue.acuteLoad'],
    'longer-rest-interval-quality': ['consistency.paceVariability'],
  };
  for (const h of seedHypotheses) {
    const hNode = ensureNode('hypothesis', h.key, { statement: h.statement });
    const mNode = ensureNode('model', h.originModel);
    ensureEdge(mNode, hNode, 'assumes', { confidence: h.prior, evidenceSource: 'model-documentation', modelVersion: h.originModel });
    for (const variable of AFFECTS[h.key] || []) {
      ensureEdge(hNode, ensureNode('variable', variable), 'affects', { evidenceSource: 'model-documentation' });
    }
  }
}
