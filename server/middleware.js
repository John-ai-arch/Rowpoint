// Auth middleware. Admin enforcement is role-based (RBAC): the user's role is
// re-read from the database on EVERY admin-scoped request — never a client
// flag. The owner account (config.ADMIN_EMAIL) is additionally always granted
// admin regardless of database state, so the owner can never be locked out.
import { db } from './db.js';
import { config } from './config.js';
import { verifyToken, ApiError, uuid, now } from './util.js';
import { parseCookies, SESSION_COOKIE } from './cookies.js';

export function getUserFromRequest(req) {
  const header = req.headers.authorization || '';
  // Auth sources, in order: Bearer header (API clients / tests), then the
  // HttpOnly session cookie (browser). Deliberately NOT a ?token= query param:
  // tokens in URLs leak into access logs, browser history, and Referer
  // headers. (The WebSocket upgrade path in realtime.js has its own handling.)
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (parseCookies(req)[SESSION_COOKIE] || null);
  const payload = verifyToken(token);
  if (!payload?.uid) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return null;
  // Session invalidation: a token minted before a logout / password reset
  // carries an older token_version and is rejected here. (Missing tv → 0,
  // matching the column default so pre-migration tokens still validate.)
  if ((payload.tv ?? 0) !== (user.token_version ?? 0)) return null;
  if (user.suspended) return { suspended: true, user };
  return { user };
}

export function authRequired(req, res, next) {
  const result = getUserFromRequest(req);
  if (!result) throw new ApiError(401, 'Not signed in', 'unauthenticated');
  if (result.suspended) throw new ApiError(403, 'This account has been suspended.', 'suspended');
  // Verification is a hard gate for the entire app: sessions are only issued
  // at verify time, and any legacy/stale token for an unverified account is
  // rejected here as well.
  if (!result.user.email_verified) {
    throw new ApiError(403, 'Please verify your email address to use RowPoint.', 'email_unverified');
  }
  req.user = result.user;
  // Activity tracking is minute-granular for the admin DAU/WAU stats — one
  // write per user per minute, not one per request (a dashboard load fires
  // half a dozen API calls; writing on each would just churn the WAL).
  const t = now();
  if (!result.user.last_active_at || t - result.user.last_active_at >= 60) {
    db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(t, result.user.id);
  }
  next();
}

// Cloud sync and anything touching other users requires a verified email (§2.1).
export function verifiedRequired(req, res, next) {
  if (!req.user.email_verified) {
    throw new ApiError(403, 'Please verify your email address to use this feature. Local workouts still work without verification.', 'email_unverified');
  }
  next();
}

/** True when this user row carries admin privileges (role, or owner email). */
export function isAdminUser(user) {
  if (!user || !user.email_verified) return false;
  return user.role === 'admin' || user.email === config.ADMIN_EMAIL;
}

export function adminRequired(req, res, next) {
  // Role re-checked server-side on every request (req.user is freshly read
  // from the database by authRequired — never trusted from the client).
  if (!isAdminUser(req.user)) {
    throw new ApiError(403, 'Admin access denied', 'not_admin');
  }
  next();
}

/** True when this admin additionally holds the Research Administrator grant. */
export function isResearchAdmin(user) {
  return isAdminUser(user) && (!!user.research_admin || user.email === config.ADMIN_EMAIL);
}

// The research platform is strictly gated: an authenticated ADMIN who ALSO holds
// the explicit Research Administrator grant (the owner always does). Regular
// users can never reach any research-database endpoint.
export function researchAdminRequired(req, res, next) {
  if (!isResearchAdmin(req.user)) {
    throw new ApiError(403, 'Research Administrator permission required.', 'not_research_admin');
  }
  next();
}

export function audit(adminUserId, action, target, details) {
  db.prepare('INSERT INTO audit_log (id, admin_user_id, action, target, details_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(uuid(), adminUserId, action, target || null, details ? JSON.stringify(details) : null, now());
}

/** Security event log: login attempts, verifications, resets, role changes. */
export function recordAuthEvent(kind, { email, userId, detail } = {}) {
  try {
    db.prepare('INSERT INTO auth_events (id, kind, email, user_id, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(uuid(), kind, email || null, userId || null, detail ? String(detail).slice(0, 300) : null, now());
  } catch { /* security telemetry must never break the auth flow itself */ }
}

// Express error handler — uniform JSON errors + api_error health events (§3.2).
// Deliberate ApiErrors keep their human-readable message at ANY status (a 501
// "Google sign-in is not configured" must never be masked as "Internal server
// error"); only unexpected exceptions are masked and logged.
export function errorHandler(err, req, res, _next) {
  const isApiError = err instanceof ApiError;
  const status = isApiError ? err.status : 500;
  if (!isApiError || status >= 500) {
    console.error(err);
    try {
      db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,?,?)')
        .run(uuid(), 'api_error', `${req.method} ${req.path}: ${err.message}`.slice(0, 500), req.user?.id || null, now());
    } catch { /* never let telemetry break the response */ }
  }
  res.status(status).json({ error: err.code || 'error', message: isApiError ? err.message : 'Internal server error' });
}
