// Shared utilities: IDs, password hashing, session tokens, validation helpers.
import crypto from 'node:crypto';
import { config } from './config.js';

export const uuid = () => crypto.randomUUID();
export const now = () => Math.floor(Date.now() / 1000);
export const todayStr = (tsMs = Date.now()) => new Date(tsMs).toISOString().slice(0, 10);

/* ---------------- password hashing (scrypt) ---------------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// A real scrypt hash of a random throwaway password, computed once at startup.
// Login runs verifyPassword against this when the email is unknown (or the
// account has no password) so the response takes the same ~scrypt time whether
// or not the account exists — closing the timing side channel that would
// otherwise let an attacker enumerate registered emails from login latency.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

/**
 * Constant-time credential check. Always performs one scrypt computation, so
 * an unknown email and a wrong password are indistinguishable by timing.
 * Returns true only for a real account whose password matches.
 */
export function verifyLogin(password, storedHash) {
  if (!storedHash) { verifyPassword(password, DUMMY_PASSWORD_HASH); return false; }
  return verifyPassword(password, storedHash);
}

/* ---------------- session tokens (HMAC-signed, stateless) ---------------- */

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, ttlSeconds = config.tokenTtlSeconds) {
  const body = b64u(JSON.stringify({ ...payload, exp: now() + ttlSeconds }));
  const sig = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- team codes & verification codes ---------------- */

// Unambiguous alphabet (no 0/O, 1/I/L) for human-shareable codes (§2.1).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function teamCode(len = 7) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function verificationCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 digits
}

// Password-reset codes carry more entropy than the 6-digit email code (they
// gate a password change), and are stored only as a keyed hash.
export function resetCode(len = 8) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function hashResetCode(code) {
  return crypto.createHmac('sha256', config.tokenSecret).update(String(code).toUpperCase()).digest('hex');
}

/* ---------------- research pseudonymization (§5.2) ---------------- */

export function researchId(userId) {
  return crypto.createHmac('sha256', config.researchSecret).update(String(userId)).digest('hex').slice(0, 24);
}

/* ---------------- validation helpers ---------------- */

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const badRequest = (msg, code = 'bad_request') => new ApiError(400, msg, code);

export function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] === undefined || obj?.[f] === null || obj?.[f] === '') {
      throw badRequest(`Missing required field: ${f}`, 'missing_field');
    }
  }
}

export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

export function clampInt(v, min, max, fallback = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function clampNum(v, min, max, fallback = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function safeJson(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Validate a user-supplied image URL: only https resources or inline data
 * images, capped in length. Anything else (javascript:, file:, http:, vbscript:,
 * protocol-relative tricks) is rejected to null — these strings end up in
 * <img src> attributes across the app.
 */
export function safeImageUrl(v, maxLen = 500) {
  const s = String(v || '').trim();
  if (!s || s.length > maxLen) return null;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) return s;
  try { return new URL(s).protocol === 'https:' ? s : null; } catch { return null; }
}

/* ---------------- formatting ---------------- */

export function fmtSplit(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--.-';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
