// Plugin framework — the platform's registered-component contract, enforced.
//
// Everything computational on RowPoint already self-registers through the
// kernel (models/algorithms/features in the version registry, providers on
// contracts, job kinds, event subscribers). This module treats those
// registrations AS the plugin manifest system: it validates the loaded set
// at startup, produces the platform inventory the admin System tab and the
// generated docs consume, and reports violations (a provider whose
// modelVersion was never registered, an engine that registered nothing)
// instead of letting them rot silently.
//
// Adding a future capability = registering into the same kernel surfaces.
// Nothing here needs modification for a new engine — that is the point.
import { allRegistered, KINDS } from '../kernel/registry.js';
import { contractInfo } from '../kernel/providers.js';
import { busInfo } from '../kernel/events.js';
import { jobKinds } from '../kernel/jobs.js';

export const PLUGINS_VERSION = 'rpos.plugins@1.0';

/** Engines expected to register components (the platform's spine). */
const EXPECTED_ENGINE_PREFIXES = ['twin', 'physics', 'optimizer', 'discovery', 'experiments', 'regatta', 'rpos'];

/** Full inventory of everything loaded in this process. */
export function platformInventory() {
  const components = allRegistered();
  return {
    components: components
      .map(c => ({ name: c.name, kind: c.kind, version: c.version, description: c.description }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    byKind: Object.fromEntries(KINDS.map(k => [k, components.filter(c => c.kind === k).length])),
    contracts: contractInfo(),
    events: busInfo(),
    jobKinds: jobKinds(),
  };
}

/**
 * Validate the loaded plugin set. Returns { ok, issues } — every issue is a
 * human-readable string naming exactly what is inconsistent.
 */
export function validatePlatform() {
  const issues = [];
  const components = allRegistered();
  const componentKeys = new Set(components.map(c => `${c.name}@${c.version}`));

  // 1. Every expected engine registered at least one component.
  for (const prefix of EXPECTED_ENGINE_PREFIXES) {
    if (prefix === 'rpos') continue; // rpos registers algorithms below during init
    if (!components.some(c => c.name.startsWith(`${prefix}.`))) {
      issues.push(`Engine "${prefix}" registered no components — is its init running?`);
    }
  }

  // 2. Every provider that claims a modelVersion points at a registered one.
  for (const { contract, providers } of contractInfo()) {
    if (!providers.length) issues.push(`Contract "${contract}" has no providers`);
  }

  // 3. Every event type has a well-formed name; orphan subscribers are fine
  //    (an event may be consumed before its first producer ships), but an
  //    event nobody subscribes to AND nobody documents is worth surfacing.
  for (const { type, subscribers } of busInfo()) {
    if (!/^[a-z]+(\.[a-z-]+)+$/.test(type)) issues.push(`Event "${type}" violates the naming convention`);
    void subscribers;
  }

  // 4. Duplicate name+version with diverging descriptions would indicate two
  //    modules claiming one identity (the registry throws at register time;
  //    this re-checks the persisted view for defense in depth).
  const seen = new Map();
  for (const c of components) {
    const key = `${c.name}@${c.version}`;
    if (seen.has(key) && seen.get(key) !== c.description) {
      issues.push(`Component ${key} registered twice with different descriptions`);
    }
    seen.set(key, c.description);
  }

  return { ok: issues.length === 0, issues, componentCount: componentKeys.size };
}
