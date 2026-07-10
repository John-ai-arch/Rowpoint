// Feature extraction — plugin registry.
//
// A feature extractor is a versioned plugin: { name, version, features,
// extract(ctx) } where ctx = { workout, splits, forceCurves, hrSeries,
// hrZones, user, best2kSeconds, maxHr }. extract() returns
// { featureName: number | null } — null means "not computable from this
// workout", which downstream consumers must treat as missing, never as zero.
//
// Adding a new extractor = adding a module to this directory and listing it
// below; nothing else changes. Bumping an extractor's version invalidates
// exactly its own cached features (feature_cache is keyed by version).
import { register } from '../../kernel/registry.js';
import { paceExtractor } from './pace.js';
import { heartExtractor } from './heart.js';
import { cadenceExtractor } from './cadence.js';
import { powerExtractor } from './power.js';
import { loadExtractor } from './load.js';
import { strokeExtractor } from './stroke.js';

export const EXTRACTORS = [
  paceExtractor,
  heartExtractor,
  cadenceExtractor,
  powerExtractor,
  loadExtractor,
  strokeExtractor,
];

for (const ex of EXTRACTORS) {
  register({ name: `twin.feature.${ex.name}`, kind: 'feature', version: ex.version, description: `Features: ${ex.features.join(', ')}` });
}

/** Every feature name any registered extractor can produce. */
export function allFeatureNames() {
  return EXTRACTORS.flatMap(ex => ex.features);
}

/**
 * Run every extractor over one workout context. Returns
 * { features: {name → value|null}, versions: {extractorName → version} }.
 * A single extractor failure yields nulls for its features (recorded by the
 * pipeline), never a failed pipeline.
 */
export function extractAll(ctx) {
  const features = {};
  const versions = {};
  const errors = [];
  for (const ex of EXTRACTORS) {
    versions[ex.name] = ex.version;
    let out = null;
    try { out = ex.extract(ctx) || {}; }
    catch (e) { errors.push(`${ex.name}: ${e.message}`); out = {}; }
    for (const f of ex.features) {
      const v = out[f];
      features[f] = Number.isFinite(v) ? v : null;
    }
  }
  return { features, versions, errors };
}
