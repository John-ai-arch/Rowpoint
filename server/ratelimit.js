// Simple in-memory sliding-window rate limiter. Used on auth endpoints and on
// the email-search social feature so it cannot be used to enumerate all
// registered emails (§14). In a multi-node deployment this moves to Redis.
import { ApiError } from './util.js';

const buckets = new Map(); // key -> { hits: number[] (timestamps ms), windowMs }

// Hourly sweep: drop buckets whose window has fully elapsed, so IP churn
// (every visitor gets a key) can't grow the map without bound.
let lastSweep = Date.now();
function sweep(nowMs) {
  if (nowMs - lastSweep < 3600 * 1000) return;
  lastSweep = nowMs;
  for (const [key, b] of buckets) {
    if (!b.hits.length || b.hits[b.hits.length - 1] <= nowMs - b.windowMs) buckets.delete(key);
  }
}

export function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const who = req.user?.id || req.ip || 'anon';
    const key = `${name}:${who}`;
    const nowMs = Date.now();
    sweep(nowMs);
    let b = buckets.get(key);
    if (!b) { b = { hits: [], windowMs }; buckets.set(key, b); }
    while (b.hits.length && b.hits[0] <= nowMs - windowMs) b.hits.shift();
    if (b.hits.length >= limit) {
      throw new ApiError(429, 'Too many requests — please slow down and try again shortly.', 'rate_limited');
    }
    b.hits.push(nowMs);
    next();
  };
}

export function resetRateLimits() { buckets.clear(); }
