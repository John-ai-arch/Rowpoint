// Future wearable / health-platform integration architecture (vision #12).
//
// We do NOT ship any unsupported integration — instead this file defines the
// clean seam future adapters plug into, mirroring how BLE ergs sit behind
// `ErgDataSource` (public/js/ble/ergSource.js). A new provider becomes a small
// adapter implementing WearableSource + a registry entry; nothing else in the
// app has to change.
//
// A WearableSource adapter is expected to implement:
//   async isAvailable()            → boolean (SDK present + reachable)
//   async connect()                → begins an auth/pair flow, resolves when linked
//   async disconnect()             → unlinks
//   async fetchDailyMetrics(dateISO) → { restingHr?, hrv?, sleepHours?, readiness? }
//   async importWorkouts(sinceISO) → [{ startedAt, distanceM, timeS, avgHr, ... }]
//   onUpdate(cb)                   → live metric stream (optional)
// All fields are optional; the app degrades gracefully to what a source offers.

export class WearableSource {
  get id() { return 'abstract'; }
  get name() { return 'Wearable'; }
  async isAvailable() { return false; }
  async connect() { throw new Error('not implemented'); }
  async disconnect() { }
  async fetchDailyMetrics() { return {}; }
  async importWorkouts() { return []; }
  onUpdate() { return () => {}; }
}

// Registry: future adapters register here; the UI + sync layer discover sources
// through it without hard-coding any provider.
const registry = new Map();
export function registerWearableSource(provider) {
  if (provider?.id) registry.set(provider.id, provider);
}
export function getWearableSource(id) { return registry.get(id) || null; }
export function listWearableSources() { return [...registry.values()]; }

// The roadmap the interface is designed to accept. `status: 'planned'` is the
// honest truth today — none are wired, but each maps cleanly onto WearableSource
// so adding one is an adapter, not a rewrite.
// `icon` is a RowPoint icon-set name (see public/js/icons.js), not a brand
// logo — we deliberately don't ship third-party marks. The UI renders it via
// icon(p.icon).
export const WEARABLE_PROVIDERS = [
  { id: 'apple_watch', name: 'Apple Watch', icon: 'watch', capabilities: ['heart rate', 'workouts', 'HRV'], status: 'planned' },
  { id: 'healthkit', name: 'Apple Health (HealthKit)', icon: 'heart', capabilities: ['workouts', 'resting HR', 'sleep'], status: 'planned' },
  { id: 'garmin', name: 'Garmin Connect', icon: 'activity', capabilities: ['workouts', 'HRV', 'body battery'], status: 'planned' },
  { id: 'whoop', name: 'WHOOP', icon: 'pulse', capabilities: ['recovery', 'strain', 'sleep', 'HRV'], status: 'planned' },
  { id: 'polar', name: 'Polar Flow', icon: 'heart', capabilities: ['heart rate', 'workouts', 'recovery'], status: 'planned' },
  { id: 'concept2', name: 'Concept2 Logbook', icon: 'oar', capabilities: ['erg workouts', 'rankings'], status: 'planned' },
  { id: 'health_connect', name: 'Google Health Connect', icon: 'activity', capabilities: ['workouts', 'heart rate', 'sleep'], status: 'planned' },
];
