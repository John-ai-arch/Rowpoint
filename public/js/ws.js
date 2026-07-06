// §2.3/§2.4 — Real-time client. Auto-reconnecting WebSocket with channel
// resubscription; publishes ~1 Hz metric deltas, receives roster/presence.
import { state } from './api.js';

let ws = null;
let wanted = new Map();   // channel -> role
let listeners = new Set();
let retryMs = 1000;
let alive = false;

export function onRealtime(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit(msg) { for (const fn of listeners) { try { fn(msg); } catch (e) { console.error(e); } } }

function connect() {
  if (!state.token || ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  ws.onopen = () => {
    alive = true; retryMs = 1000;
    for (const [channel, role] of wanted) ws.send(JSON.stringify({ type: 'subscribe', channel, role }));
    emit({ type: '_socket', up: true });
  };
  ws.onmessage = (ev) => {
    try { emit(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
  };
  ws.onclose = () => {
    ws = null; alive = false;
    emit({ type: '_socket', up: false });
    if (wanted.size) setTimeout(connect, retryMs = Math.min(retryMs * 1.6, 10000));
  };
  ws.onerror = () => { try { ws?.close(); } catch { /* already closed */ } };
}

export function subscribe(channel, role = 'rower') {
  wanted.set(channel, role);
  if (alive) ws.send(JSON.stringify({ type: 'subscribe', channel, role }));
  else connect();
}

export function unsubscribe(channel) {
  wanted.delete(channel);
  if (alive) ws.send(JSON.stringify({ type: 'unsubscribe', channel }));
  if (!wanted.size && ws) { ws.close(); ws = null; }
}

export function publishMetrics(channel, payload) {
  if (alive) ws.send(JSON.stringify({ type: 'metrics', channel, payload }));
}

export function requestRoster(channel) {
  if (alive) ws.send(JSON.stringify({ type: 'roster', channel }));
}
