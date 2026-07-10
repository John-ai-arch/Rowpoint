// Versioned registry of every model, algorithm, feature extractor, pipeline
// stage, and plugin on the platform.
//
// Every computational component self-registers at module load with a name,
// kind, and version. Registrations persist to model_versions so historical
// outputs stay attributable to the exact code that produced them — versions
// are never deleted, only superseded. Reproducibility records (job runs,
// optimization runs, research analyses) reference these entries.
//
// Kernel rule: this module knows nothing about any specific engine.
import { db } from '../db.js';
import { now } from '../util.js';

export const KINDS = ['feature', 'model', 'algorithm', 'pipeline-stage', 'strategy', 'plugin'];

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const NAME_RE = /^[a-z][a-z0-9-]{1,63}(\.[a-z][a-z0-9-]{1,63})*$/;

/** In-memory registry: "name@version" → definition. Rebuilt on every boot. */
const registered = new Map();

/**
 * Register a component. Idempotent for identical (name, version); throws if
 * the same name+version is registered twice with different definitions in
 * one process (two components must never share an identity).
 */
export function register({ name, kind, version, description = '' }) {
  if (!NAME_RE.test(String(name || ''))) throw new TypeError(`Invalid component name: ${name}`);
  if (!KINDS.includes(kind)) throw new TypeError(`Invalid component kind: ${kind} (expected ${KINDS.join('|')})`);
  if (!VERSION_RE.test(String(version || ''))) throw new TypeError(`Invalid version for ${name}: ${version} (expected semver-like "1.0" or "1.0.0")`);
  const key = `${name}@${version}`;
  const existing = registered.get(key);
  if (existing) {
    if (existing.kind !== kind) throw new Error(`Component ${key} already registered with kind ${existing.kind}`);
    return existing; // idempotent re-registration (e.g. test re-imports)
  }
  const def = Object.freeze({ name, kind, version, description, key });
  registered.set(key, def);
  db.prepare(`INSERT INTO model_versions (id, name, kind, version, description, first_seen_at)
              VALUES (?,?,?,?,?,?) ON CONFLICT(name, version) DO NOTHING`)
    .run(crypto.randomUUID(), name, kind, version, description, now());
  return def;
}

/** Look up a registered component; latest version when version is omitted. */
export function lookup(name, version = null) {
  if (version) return registered.get(`${name}@${version}`) || null;
  const versions = [...registered.values()].filter(d => d.name === name);
  if (!versions.length) return null;
  return versions.sort((a, b) => compareVersions(a.version, b.version))[versions.length - 1];
}

/** All components registered in this process, optionally filtered by kind. */
export function allRegistered({ kind = null } = {}) {
  const all = [...registered.values()];
  return kind ? all.filter(d => d.kind === kind) : all;
}

/** Every version of a name ever persisted (includes retired code paths). */
export function versionHistory(name) {
  return db.prepare('SELECT name, kind, version, description, first_seen_at FROM model_versions WHERE name = ? ORDER BY first_seen_at').all(name);
}

/** Compact "name@version" list — recorded into reproducibility records. */
export function versionManifest(names = null) {
  const defs = names ? names.map(n => lookup(n)).filter(Boolean) : [...registered.values()];
  return defs.map(d => d.key).sort();
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
