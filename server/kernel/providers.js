// Cross-engine capability contracts.
//
// Engines never import each other — they register providers for well-known
// contracts here, and consumers discover them at run time. Example: the
// physics engine provides 'twin.inference-model' implementations; the twin's
// infer stage runs every provider of that contract without knowing who wrote
// it. Wiring happens in one place (each engine's init, called from server
// startup), so adding an engine never modifies an existing one.
//
// A contract's shape is documented where the consumer defines it; providers
// must also be registered in the kernel version registry so their outputs
// stay attributable.

const providers = new Map(); // contract → [{ name, ...impl }]

const CONTRACT_RE = /^[a-z]+(\.[a-z-]+)+$/;

/**
 * Register a provider for a contract. `impl.name` is required and unique per
 * contract (re-providing the same name replaces — safe for test re-imports).
 */
export function provide(contract, impl) {
  if (!CONTRACT_RE.test(contract)) throw new TypeError(`Invalid contract name: ${contract}`);
  if (!impl || typeof impl.name !== 'string' || !impl.name) throw new TypeError('Provider needs a name');
  const list = providers.get(contract) || [];
  providers.set(contract, [...list.filter(p => p.name !== impl.name), impl]);
  return impl;
}

/** Every provider registered for a contract (empty array when none). */
export function providersOf(contract) {
  return [...(providers.get(contract) || [])];
}

/** Contract inventory — powers RPOS observability and generated docs. */
export function contractInfo() {
  return [...providers.entries()].map(([contract, list]) => ({
    contract, providers: list.map(p => p.name),
  })).sort((a, b) => a.contract.localeCompare(b.contract));
}
