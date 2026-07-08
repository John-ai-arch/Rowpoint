// Cookie-based session transport + CSRF protection.
//
// Security architecture (production auth): the browser never stores the session
// token in JavaScript-reachable storage. Instead the server sets it as an
// HttpOnly, Secure, SameSite=Lax cookie (`rp_session`) that script cannot read,
// which removes the XSS token-theft vector that localStorage has. A second,
// JS-readable cookie (`rp_csrf`) carries a random CSRF token; the SPA echoes it
// back in an `X-CSRF-Token` header on every state-changing request. Because a
// cross-site attacker can neither read our CSRF cookie nor set a custom header
// without a (blocked) CORS preflight, this stateless double-submit pattern
// defeats CSRF while the SameSite=Lax attribute blocks the common cases outright.
//
// Programmatic clients (and the test suite) keep using `Authorization: Bearer`
// — those requests carry no ambient cookie credential, so they are immune to
// CSRF by construction and are deliberately exempt from the CSRF check.
import crypto from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './util.js';

export const SESSION_COOKIE = 'rp_session';
export const CSRF_COOKIE = 'rp_csrf';
const CSRF_HEADER = 'x-csrf-token';

/** Parse the Cookie header into a plain object (no dependency). */
export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function newCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function serialize(name, value, { maxAge, httpOnly } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) attrs.push('HttpOnly');
  // Secure everywhere except local dev over plain HTTP (where a Secure cookie
  // would simply never be sent back).
  if (!config.devMode) attrs.push('Secure');
  if (typeof maxAge === 'number') attrs.push(`Max-Age=${maxAge}`);
  return attrs.join('; ');
}

function appendCookie(res, cookieStr) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookieStr);
  else res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, cookieStr] : [prev, cookieStr]);
}

/**
 * Issue the browser session: the signed token as an HttpOnly cookie plus a
 * fresh readable CSRF token. Returns the CSRF token so callers can also include
 * it in the JSON body for the very first render (before the cookie round-trips).
 */
export function setSessionCookies(res, token) {
  const csrf = newCsrfToken();
  const maxAge = config.tokenTtlSeconds;
  appendCookie(res, serialize(SESSION_COOKIE, token, { maxAge, httpOnly: true }));
  appendCookie(res, serialize(CSRF_COOKIE, csrf, { maxAge, httpOnly: false }));
  return csrf;
}

export function clearSessionCookies(res) {
  appendCookie(res, serialize(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true }));
  appendCookie(res, serialize(CSRF_COOKIE, '', { maxAge: 0, httpOnly: false }));
}

/**
 * CSRF guard for cookie-authenticated, state-changing requests. Mounted before
 * the API routers. It only acts when the request actually carries our session
 * cookie AND uses a mutating method AND is not using Bearer auth — otherwise
 * there is no ambient credential for an attacker to abuse and the request is
 * passed through untouched (keeps GETs, Bearer API calls, and the test suite
 * working exactly as before).
 */
// Unauthenticated bootstrap endpoints: these create or recover a session and
// never act on an existing one, so a stale/leftover session cookie must not
// gate them (otherwise a returning visitor who still holds an old cookie can't
// sign in or reset a password). The emailed code / credentials in the body are
// the real secret on the reset path.
const CSRF_EXEMPT = new Set([
  '/auth/signup', '/auth/login', '/auth/verify', '/auth/resend-verification',
  '/auth/forgot-password', '/auth/reset-password', '/auth/oauth/google', '/auth/oauth/apple',
]);

export function csrfProtection(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  // Bearer-authenticated requests are immune to CSRF (no ambient cookie).
  if ((req.headers.authorization || '').startsWith('Bearer ')) return next();
  // req.path is relative to the /api mount point here (e.g. '/auth/login').
  if (CSRF_EXEMPT.has(req.path)) return next();
  const cookies = parseCookies(req);
  const session = cookies[SESSION_COOKIE];
  if (!session) return next(); // no cookie session → nothing CSRF-abusable here
  const sent = req.headers[CSRF_HEADER];
  const expected = cookies[CSRF_COOKIE];
  if (!sent || !expected || !safeEqual(String(sent), String(expected))) {
    throw new ApiError(403, 'Your session security token is missing or invalid — please refresh and try again.', 'csrf_failed');
  }
  next();
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
