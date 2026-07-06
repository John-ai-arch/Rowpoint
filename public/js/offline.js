// §6 — Offline-first sync. Completed workouts are ALWAYS written to the local
// queue first (namespaced per user id, §2.5), then a background worker pushes
// pending items whenever connectivity returns, using client UUIDs so retries
// are idempotent server-side.
import { api, state, toast } from './api.js';

const keyFor = (userId) => `rp_queue_${userId}`;

export function queueWorkout(userId, payload) {
  const key = keyFor(userId);
  const q = JSON.parse(localStorage.getItem(key) || '[]');
  q.push({ payload, queuedAt: Date.now(), attempts: 0 });
  localStorage.setItem(key, JSON.stringify(q));
}

export function pendingCount(userId) {
  return JSON.parse(localStorage.getItem(keyFor(userId)) || '[]').length;
}

let syncing = false;
export async function syncPending({ silent = true } = {}) {
  if (!state.user || syncing) return;
  syncing = true;
  const key = keyFor(state.user.id);
  try {
    let q = JSON.parse(localStorage.getItem(key) || '[]');
    if (!q.length) return;
    const remaining = [];
    let ok = 0;
    for (const item of q) {
      try {
        const res = await api('/workouts/sync', { method: 'POST', body: item.payload });
        ok++;
        item.result = res;
      } catch (e) {
        if (e.status === 0 || e.status >= 500) {
          item.attempts++;
          remaining.push(item); // transient — retry later
        } else if (e.code === 'email_unverified') {
          remaining.push(item); // keep until the account is verified (§2.1)
        } else if (e.status === 409 || e.code === 'conflict') {
          // duplicate/foreign id — drop, already recorded
        } else {
          item.attempts++;
          if (item.attempts < 5) remaining.push(item);
          else {
            try { await api('/users/me/health-events', { method: 'POST', body: { kind: 'sync_failure', detail: `dropped after 5 attempts: ${e.message}` } }); } catch { /* offline */ }
          }
        }
      }
    }
    localStorage.setItem(key, JSON.stringify(remaining));
    if (ok && !silent) toast(`Synced ${ok} workout${ok > 1 ? 's' : ''}.`, 'success');
    window.dispatchEvent(new CustomEvent('rp:synced'));
  } finally {
    syncing = false;
  }
}

export function startSyncWorker() {
  window.addEventListener('online', () => syncPending({ silent: false }));
  setInterval(() => syncPending(), 20000);
  syncPending();
}
