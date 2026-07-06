// Simple in-memory sliding-window rate limiter. Used on auth endpoints and on
// the email-search social feature so it cannot be used to enumerate all
// registered emails (§14). In a multi-node deployment this moves to Redis.
import { ApiError } from './util.js';

const buckets = new Map(); // key -> number[] (timestamps ms)

export function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const who = req.user?.id || req.ip || 'anon';
    const key = `${name}:${who}`;
    const nowMs = Date.now();
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    while (arr.length && arr[0] <= nowMs - windowMs) arr.shift();
    if (arr.length >= limit) {
      throw new ApiError(429, 'Too many requests — please slow down and try again shortly.', 'rate_limited');
    }
    arr.push(nowMs);
    next();
  };
}

export function resetRateLimits() { buckets.clear(); }
