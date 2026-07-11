// Platform event bus — the decoupling layer between subsystems.
//
// Producers emit named events; subscribers react independently. One failing
// subscriber never breaks the producer or the other subscribers (its error is
// recorded to health_events instead). Every emit is appended to event_log so
// the reaction chain behind any state change stays auditable.
//
// The bus is in-process and synchronous by design: this is a single-process
// application, and the expensive reactions are expected to enqueue background
// jobs (kernel/jobs.js) rather than do heavy work inline in a handler.
import { db } from '../db.js';
import { uuid, now } from '../util.js';
import { logger } from '../log.js';

const log = logger('events');

/** The platform event catalog. Extensible: engines add types via defineEvent. */
export const EVENTS = new Set([
  'workout.saved',
  'workout.deleted',
  'workout.corrected',
  'twin.updated',
  'prediction.completed',
  'recommendation.generated',
  'optimization.completed',
  'experiment.updated',
  'research.snapshot',
  'race.result-recorded',
]);

/** Declare a new event type before first use (typo guard for emit/on). */
export function defineEvent(type) {
  if (!/^[a-z]+(\.[a-z-]+)+$/.test(type)) throw new TypeError(`Invalid event type: ${type}`);
  EVENTS.add(type);
  return type;
}

const handlers = new Map(); // type → [{ name, fn }]

/**
 * Subscribe. `name` identifies the subscriber in logs and error reports.
 * Duplicate (type, name) pairs replace the previous handler so hot re-imports
 * (tests) never double-subscribe.
 */
export function on(type, name, fn) {
  if (!EVENTS.has(type)) throw new TypeError(`Unknown event type: ${type} — defineEvent() it first`);
  if (typeof fn !== 'function') throw new TypeError('Event handler must be a function');
  const list = handlers.get(type) || [];
  const next = list.filter(h => h.name !== name);
  next.push({ name, fn });
  handlers.set(type, next);
}

export function off(type, name) {
  const list = handlers.get(type) || [];
  handlers.set(type, list.filter(h => h.name !== name));
}

let emitCount = 0;
const LOG_CAP = 20000;   // newest event_log rows kept
const PRUNE_EVERY = 1000; // amortized prune cadence

/**
 * Emit an event. Synchronous handlers run inline; async handlers are fired
 * and their rejections captured. Returns per-subscriber outcomes so callers
 * that need a synchronous result (rare) can read it.
 */
export function emit(type, payload = {}) {
  if (!EVENTS.has(type)) throw new TypeError(`Unknown event type: ${type} — defineEvent() it first`);
  // Audit trail. Payloads are capped: the log records THAT something happened
  // and its identifiers, not full data blobs.
  try {
    const json = JSON.stringify(payload);
    db.prepare('INSERT INTO event_log (id, type, payload_json, created_at) VALUES (?,?,?,?)')
      .run(uuid(), type, json.length > 4000 ? json.slice(0, 4000) : json, now());
    if (++emitCount % PRUNE_EVERY === 0) {
      db.prepare(`DELETE FROM event_log WHERE id IN (
        SELECT id FROM event_log ORDER BY created_at DESC LIMIT -1 OFFSET ?)`).run(LOG_CAP);
    }
  } catch (e) {
    log.error(`event_log append failed for ${type}: ${e.message}`);
  }

  const outcomes = [];
  for (const { name, fn } of handlers.get(type) || []) {
    try {
      const result = fn(payload);
      if (result && typeof result.then === 'function') {
        result.catch(e => recordFailure(type, name, e));
        outcomes.push({ name, ok: true, async: true });
      } else {
        outcomes.push({ name, ok: true, result });
      }
    } catch (e) {
      recordFailure(type, name, e);
      outcomes.push({ name, ok: false, error: e.message });
    }
  }
  return outcomes;
}

function recordFailure(type, name, e) {
  log.error(`subscriber "${name}" failed on ${type}: ${e.message}`);
  try {
    db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,NULL,?)')
      .run(uuid(), 'event_handler_error', `${type} → ${name}: ${String(e.message).slice(0, 400)}`, now());
  } catch { /* the failure record must never cascade */ }
}

/** Subscribers per event type — surfaced in RPOS observability. */
export function busInfo() {
  return [...EVENTS].sort().map(type => ({
    type, subscribers: (handlers.get(type) || []).map(h => h.name),
  }));
}
