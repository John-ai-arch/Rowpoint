// Accounts & auth (§2.1): email+password with mandatory verification before
// cloud sync, Google OAuth and Sign in with Apple (both activate when the
// provider client IDs are configured; the endpoints and account-linking logic
// are fully implemented either way).
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, inTransaction } from './db.js';
import { config } from './config.js';
import { sendEmail, mailConfigured } from './mailer.js';
import { rateLimit } from './ratelimit.js';
import { authRequired, isAdminUser, recordAuthEvent } from './middleware.js';
import { setSessionCookies, clearSessionCookies, parseCookies, SESSION_COOKIE } from './cookies.js';
import {
  uuid, now, hashPassword, verifyPassword, signToken, teamCode,
  verificationCode, resetCode, hashResetCode, ApiError, badRequest,
  requireFields, isEmail, clampInt,
} from './util.js';

export const authRouter = Router();

const GOAL_TYPES = ['general_fitness', 'race_prep', 'weight_class', 'return_from_injury', 'other'];

/**
 * Establish a session for a freshly-authenticated user. Sets the HttpOnly
 * session cookie + readable CSRF cookie for the browser, and returns the same
 * token + CSRF token in the JSON body so programmatic clients (and the test
 * suite) can use Bearer auth. The browser deliberately does NOT persist the
 * token — it relies on the cookie — so there is nothing in JS-readable storage
 * to steal via XSS.
 */
function issueSession(res, user, body) {
  const token = signToken({ uid: user.id, tv: user.token_version });
  const csrf = setSessionCookies(res, token);
  return { token, csrf, user: publicUser(user) };
}

export function publicUser(u) {
  return {
    id: u.id, email: u.email, displayName: u.display_name, photoUrl: u.photo_url,
    accountType: u.account_type, birthYear: u.birth_year, weightKg: u.weight_kg,
    weightClass: u.weight_class, best2kSeconds: u.best_2k_seconds,
    best2kVerified: !!u.best_2k_verified, units: u.units,
    goalType: u.goal_type, goalTargetEvent: u.goal_target_event,
    goalTargetDate: u.goal_target_date, goalWeeklySessions: u.goal_weekly_sessions,
    goalWeeklyMinutes: u.goal_weekly_minutes, goalWeeklyMeters: u.goal_weekly_meters,
    maxHr: u.max_hr, restingHr: u.resting_hr,
    heightCm: u.height_cm, experienceLevel: u.experience_level, goal2kSeconds: u.goal_2k_seconds,
    preferredRaceDistance: u.preferred_race_distance, availableDays: u.available_days,
    sessionMinutes: u.session_minutes, club: u.club, boatClass: u.boat_class,
    emailVerified: !!u.email_verified, researchOptIn: !!u.research_opt_in,
    shareWorkoutsTeam: !!u.share_workouts_team, share2kHistory: !!u.share_2k_history,
    shareWellnessCoach: !!u.share_wellness_coach, shareProfile: !!u.share_profile,
    researchShareDemographics: !!u.research_share_demographics,
    notifPrefs: JSON.parse(u.notif_prefs || '{}'),
    role: u.role || 'user',
    isAdmin: isAdminUser(u),
    createdAt: u.created_at,
  };
}

// The owner email is assigned the Admin role the moment the account exists —
// role-based access control everywhere else, but this one assignment is
// automatic so the owner never has to bootstrap it by hand.
function promoteOwner(userId, email) {
  if (email === config.ADMIN_EMAIL) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
  }
}

function issueVerification(user) {
  const code = verificationCode();
  db.prepare('INSERT INTO email_verifications (id, user_id, code, expires_at, used) VALUES (?,?,?,?,0)')
    .run(uuid(), user.id, code, now() + config.verificationTtlSeconds);
  sendEmail(user.email, 'Verify your RowPoint account',
    `Welcome to RowPoint, ${user.display_name}!\n\nYour verification code is: ${code}\n\nIt expires in 24 hours.`);
  return code;
}

// In dev mode with no mail provider configured, the code is surfaced directly
// in the UI so local testing "just works". Never exposed once RESEND_API_KEY
// is set or in production.
const devCodeOrNull = (code) => (config.devMode && !mailConfigured()) ? code : undefined;

/* ---------------- sign-in provider discovery ---------------- */
// The client asks which providers are configured and only renders those
// buttons — an unconfigured Google button should not exist, let alone error.
authRouter.get('/providers', (req, res) => {
  res.json({
    google: !!config.googleClientId,
    googleClientId: config.googleClientId,
    apple: !!config.appleClientId,
    appleClientId: config.appleClientId,
    devMail: config.devMode && !mailConfigured(),
  });
});

function createTeamForCoach(coachId, displayName) {
  // Retry on the (astronomically unlikely) code collision.
  for (let i = 0; i < 5; i++) {
    try {
      const id = uuid();
      db.prepare('INSERT INTO teams (id, coach_id, name, code, created_at) VALUES (?,?,?,?,?)')
        .run(id, coachId, `${displayName}'s Team`, teamCode(), now());
      return id;
    } catch (e) { if (i === 4) throw e; }
  }
}

/* ---------------- signup ---------------- */

authRouter.post('/signup', rateLimit('signup', 20, 60 * 60 * 1000), (req, res) => {
  const b = req.body || {};
  requireFields(b, ['email', 'password', 'displayName', 'accountType']);
  const email = String(b.email).trim().toLowerCase();
  if (!isEmail(email)) throw badRequest('Please enter a valid email address.', 'invalid_email');
  if (String(b.password).length < 8) throw badRequest('Password must be at least 8 characters.', 'weak_password');
  if (!['coach', 'rower'].includes(b.accountType)) throw badRequest('Account type must be coach or rower.');
  if (b.goalType && !GOAL_TYPES.includes(b.goalType)) throw badRequest('Unknown goal type.');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw new ApiError(409, 'An account with this email already exists. Sign in instead — your workouts and profile are waiting.', 'email_taken');
  }

  const id = uuid();
  try {
    db.prepare(`INSERT INTO users (
        id, email, password_hash, display_name, account_type, birth_year, weight_kg,
        weight_class, best_2k_seconds, units, goal_type, goal_target_event,
        goal_target_date, goal_weekly_sessions, goal_weekly_minutes,
        research_opt_in, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id, email, hashPassword(String(b.password)), String(b.displayName).slice(0, 80),
        b.accountType, clampInt(b.birthYear, 1900, 2100), b.weightKg ?? null,
        b.weightClass ?? null, b.best2kSeconds ?? null,
        b.units === 'imperial' ? 'imperial' : 'metric',
        b.goalType ?? null, b.goalTargetEvent ?? null, b.goalTargetDate ?? null,
        clampInt(b.goalWeeklySessions, 0, 28), clampInt(b.goalWeeklyMinutes, 0, 4000),
        // §5.1: research contribution is opt-OUT, presented plainly at signup.
        b.researchOptIn === false ? 0 : 1,
        now(),
      );
  } catch (e) {
    // Race-safe duplicate prevention: two simultaneous signups for the same
    // email both pass the pre-check above, but the UNIQUE(email) constraint
    // makes exactly one INSERT win — surface the loser as the same clean 409
    // instead of a masked 500.
    if (/UNIQUE constraint failed.*users\.email/i.test(String(e.message))) {
      throw new ApiError(409, 'An account with this email already exists. Sign in instead — your workouts and profile are waiting.', 'email_taken');
    }
    throw e;
  }

  promoteOwner(id, email);
  recordAuthEvent('signup', { email, userId: id });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const code = issueVerification(user);

  let joinedTeam = null;
  if (b.accountType === 'coach') {
    createTeamForCoach(id, user.display_name);
  } else if (b.teamCode) {
    const team = db.prepare('SELECT * FROM teams WHERE code = ?').get(String(b.teamCode).trim().toUpperCase());
    if (team) {
      db.prepare('INSERT INTO team_members (id, team_id, user_id, joined_at) VALUES (?,?,?,?)')
        .run(uuid(), team.id, id, now());
      joinedTeam = { id: team.id, name: team.name };
    }
    // Invalid code at signup is non-fatal; the rower can join later (§2.1).
  }

  // NO session token until the email is verified — there is no way into the
  // app with an unverified address, by design.
  res.status(201).json({ needsVerification: true, email: user.email, joinedTeam, devCode: devCodeOrNull(code) });
});

/* ---------------- email verification ---------------- */

authRouter.post('/verify', rateLimit('verify', 30, 60 * 60 * 1000), (req, res) => {
  requireFields(req.body || {}, ['email', 'code']);
  const email = String(req.body.email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    recordAuthEvent('verify_fail', { email, detail: 'unknown email' });
    throw badRequest('Invalid code.', 'invalid_code');
  }
  const row = db.prepare(
    `SELECT * FROM email_verifications
     WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > ?
     ORDER BY expires_at DESC LIMIT 1`)
    .get(user.id, String(req.body.code).trim(), now());
  if (!row) {
    recordAuthEvent('verify_fail', { email, userId: user.id, detail: 'invalid or expired code' });
    throw badRequest('Invalid or expired code.', 'invalid_code');
  }
  db.prepare('UPDATE email_verifications SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
  promoteOwner(user.id, email);
  recordAuthEvent('verify', { email, userId: user.id });
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json(issueSession(res, fresh));
});

authRouter.post('/resend-verification', rateLimit('resend', 5, 60 * 60 * 1000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Do not reveal whether the email exists.
  let code;
  if (user && !user.email_verified) code = issueVerification(user);
  res.json({ ok: true, devCode: code ? devCodeOrNull(code) : undefined });
});

/* ---------------- self-service password recovery ----------------
   Two steps: request a code by email, then submit the code + a new password.
   Security properties: responses never reveal whether an account exists
   (anti-enumeration), codes are single-use, hashed at rest, short-lived, and
   IP-rate-limited; a successful reset bumps token_version so every existing
   session for that account is invalidated. Every step is audit-logged. */

authRouter.post('/forgot-password', rateLimit('forgot', 5, 60 * 60 * 1000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = isEmail(email) ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
  let devCode;
  // Only password accounts (not OAuth-only) with a verified email can reset.
  if (user && user.password_hash) {
    // Invalidate any outstanding codes, then issue a fresh single-use one.
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
    const code = resetCode();
    db.prepare('INSERT INTO password_resets (id, user_id, code_hash, expires_at, used, created_at) VALUES (?,?,?,?,0,?)')
      .run(uuid(), user.id, hashResetCode(code), now() + 60 * 60, now()); // 1-hour window
    sendEmail(user.email, 'Reset your RowPoint password',
      `Hi ${user.display_name},\n\nUse this code to reset your RowPoint password: ${code}\n\n`
      + `It expires in 1 hour. If you didn't request this, you can safely ignore this email — your password will not change.`);
    recordAuthEvent('password_reset_requested', { email, userId: user.id });
    devCode = devCodeOrNull(code);
  } else {
    recordAuthEvent('password_reset_requested', { email, detail: 'no eligible account' });
  }
  // Identical response either way — callers cannot distinguish a real account.
  res.json({ ok: true, message: 'If an account with that email exists, a reset code is on its way.', devCode });
});

authRouter.post('/reset-password', rateLimit('reset', 10, 60 * 60 * 1000), (req, res) => {
  requireFields(req.body || {}, ['email', 'code', 'newPassword']);
  const email = String(req.body.email).trim().toLowerCase();
  const newPassword = String(req.body.newPassword);
  if (newPassword.length < 8) throw badRequest('Password must be at least 8 characters.', 'weak_password');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const row = user && db.prepare(
    `SELECT * FROM password_resets
     WHERE user_id = ? AND code_hash = ? AND used = 0 AND expires_at > ?
     ORDER BY expires_at DESC LIMIT 1`)
    .get(user.id, hashResetCode(String(req.body.code).trim()), now());
  if (!row) {
    recordAuthEvent('password_reset_fail', { email, userId: user?.id, detail: 'invalid or expired code' });
    throw badRequest('That reset code is invalid or has expired. Request a new one.', 'invalid_code');
  }
  inTransaction(() => {
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
    // Setting a password verifies the address (they proved email control) and
    // bumps token_version, signing out every existing session.
    db.prepare('UPDATE users SET password_hash = ?, email_verified = 1, token_version = token_version + 1 WHERE id = ?')
      .run(hashPassword(newPassword), user.id);
  });
  recordAuthEvent('password_reset', { email, userId: user.id });
  // Log the user straight in with a fresh session.
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json(issueSession(res, fresh));
});

/* ---------------- login ---------------- */

authRouter.post('/login', rateLimit('login', 20, 15 * 60 * 1000), (req, res) => {
  requireFields(req.body || {}, ['email', 'password']);
  const email = String(req.body.email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.password_hash || !verifyPassword(String(req.body.password), user.password_hash)) {
    recordAuthEvent('login_fail', { email, userId: user?.id, detail: user ? 'wrong password' : 'unknown email' });
    throw new ApiError(401, 'Incorrect email or password.', 'bad_credentials');
  }
  if (user.suspended) {
    recordAuthEvent('login_fail', { email, userId: user.id, detail: 'account suspended' });
    throw new ApiError(403, 'This account has been suspended.', 'suspended');
  }
  if (!user.email_verified) {
    // Unverified accounts get NO session — a fresh code is issued and the
    // client is routed straight to the verification screen instead.
    const code = issueVerification(user);
    return res.json({ needsVerification: true, email: user.email, devCode: devCodeOrNull(code) });
  }
  recordAuthEvent('login_success', { email, userId: user.id });
  res.json(issueSession(res, user));
});

/* ---------------- logout (server-side session invalidation) ----------------
   Stateless tokens can't be individually revoked, so logging out bumps the
   user's token_version — every token issued before this moment stops
   validating. A professional "sign out (all devices)" without per-token
   state. The client also discards its local token. */
authRouter.post('/logout', authRequired, (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
  recordAuthEvent('logout', { email: req.user.email, userId: req.user.id });
  clearSessionCookies(res);
  res.json({ ok: true });
});

/* ---------------- OAuth (Google / Apple) ----------------
   The client obtains an ID token from the provider SDK and posts it here.
   Verification requires the provider client ID to be configured; without it
   the endpoint returns 501 with setup instructions rather than pretending. */

async function verifyGoogleIdToken(idToken) {
  // Verify via Google's tokeninfo endpoint (simple + adequate for this scale;
  // swap for local JWKS verification under high volume).
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) throw new ApiError(401, 'Google token rejected.', 'oauth_failed');
  const info = await r.json();
  if (info.aud !== config.googleClientId) throw new ApiError(401, 'Google token audience mismatch.', 'oauth_failed');
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    throw new ApiError(401, 'Google account email is unverified.', 'oauth_failed');
  }
  return { sub: info.sub, email: String(info.email).toLowerCase(), name: info.name || info.email };
}

function oauthLoginOrSignup(res, provider, identity, body) {
  const subCol = provider === 'google' ? 'google_sub' : 'apple_sub';
  let user = db.prepare(`SELECT * FROM users WHERE ${subCol} = ?`).get(identity.sub)
        || db.prepare('SELECT * FROM users WHERE email = ?').get(identity.email);
  if (user) {
    db.prepare(`UPDATE users SET ${subCol} = ?, email_verified = 1 WHERE id = ?`).run(identity.sub, user.id);
  } else {
    if (!['coach', 'rower'].includes(body?.accountType)) {
      // First-time OAuth signup still needs the account-type choice (§2.1).
      return res.status(200).json({ needsProfile: true, provider, email: identity.email, suggestedName: identity.name });
    }
    const id = uuid();
    db.prepare(`INSERT INTO users (id, email, ${subCol}, display_name, account_type, email_verified, research_opt_in, created_at)
                VALUES (?,?,?,?,?,1,?,?)`)
      .run(id, identity.email, identity.sub, String(body.displayName || identity.name).slice(0, 80),
        body.accountType, body.researchOptIn === false ? 0 : 1, now());
    if (body.accountType === 'coach') createTeamForCoach(id, body.displayName || identity.name);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  promoteOwner(user.id, identity.email);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (fresh.suspended) {
    recordAuthEvent('login_fail', { email: identity.email, userId: fresh.id, detail: 'account suspended (oauth)' });
    throw new ApiError(403, 'This account has been suspended.', 'suspended');
  }
  recordAuthEvent('oauth_login', { email: identity.email, userId: fresh.id, detail: provider });
  res.json(issueSession(res, fresh));
}

authRouter.post('/oauth/google', async (req, res) => {
  if (!config.googleClientId) {
    throw new ApiError(501, 'Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID to enable it.', 'oauth_unconfigured');
  }
  requireFields(req.body || {}, ['idToken']);
  const identity = await verifyGoogleIdToken(req.body.idToken);
  oauthLoginOrSignup(res, 'google', identity, req.body);
});

// Apple publishes its ID-token signing keys as a JWKS; cache them (Apple rotates
// keys, so refresh periodically) and verify the RS256 signature locally.
let appleKeys = { keys: null, at: 0 };
async function applePublicKeys() {
  if (appleKeys.keys && Date.now() - appleKeys.at < 6 * 3600 * 1000) return appleKeys.keys;
  const r = await fetch('https://appleid.apple.com/auth/keys');
  if (!r.ok) throw new ApiError(401, 'Could not reach Apple to verify the sign-in.', 'oauth_failed');
  appleKeys = { keys: (await r.json()).keys, at: Date.now() };
  return appleKeys.keys;
}

async function verifyAppleIdToken(idToken) {
  const [h, p, s] = String(idToken).split('.');
  if (!h || !p || !s) throw new ApiError(401, 'Malformed Apple token.', 'oauth_failed');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const jwk = (await applePublicKeys()).find(k => k.kid === header.kid && k.alg === (header.alg || 'RS256'));
  if (!jwk) throw new ApiError(401, 'Unknown Apple signing key.', 'oauth_failed');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'));
  if (!ok) throw new ApiError(401, 'Apple token signature is invalid.', 'oauth_failed');
  const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (c.iss !== 'https://appleid.apple.com') throw new ApiError(401, 'Apple token issuer mismatch.', 'oauth_failed');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(config.appleClientId)) throw new ApiError(401, 'Apple token audience mismatch.', 'oauth_failed');
  if (!c.exp || c.exp < now()) throw new ApiError(401, 'Apple token has expired.', 'oauth_failed');
  // Apple sends the email only on the first authorization; fall back to the
  // stable private-relay address so account linking always has an identity.
  return { sub: c.sub, email: String(c.email || `${c.sub}@privaterelay.appleid.com`).toLowerCase(), name: 'Apple user' };
}

authRouter.post('/oauth/apple', async (req, res) => {
  if (!config.appleClientId) {
    throw new ApiError(501, 'Sign in with Apple is not configured on this server. Set APPLE_CLIENT_ID (your Services ID) to enable it.', 'oauth_unconfigured');
  }
  requireFields(req.body || {}, ['idToken']);
  const identity = await verifyAppleIdToken(req.body.idToken);
  // Apple returns the user's name only on first sign-in; the client forwards it.
  if (req.body.displayName) identity.name = String(req.body.displayName).slice(0, 80);
  oauthLoginOrSignup(res, 'apple', identity, req.body);
});

/* ---------------- session ---------------- */

authRouter.get('/me', authRequired, (req, res) => {
  // Transparently migrate a legacy Bearer/localStorage session to the HttpOnly
  // cookie the first time we see it, so the deploy that introduced cookie auth
  // never forces anyone to sign in again — and the XSS-stealable token stops
  // being needed immediately.
  const usedBearer = (req.headers.authorization || '').startsWith('Bearer ');
  const hasCookie = !!parseCookies(req)[SESSION_COOKIE];
  const out = { user: publicUser(req.user) };
  if (usedBearer && !hasCookie) {
    out.csrf = issueSession(res, req.user).csrf;
    out.migrated = true;
  }
  res.json(out);
});
