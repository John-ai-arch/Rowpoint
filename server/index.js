// RowPoint server entry point.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { db, dbPersistenceInfo } from './db.js';
import { logger } from './log.js';
import { errorHandler } from './middleware.js';
import { metricsMiddleware } from './metrics.js';

const log = logger('server');

/**
 * Persistence sanity checks. The single most damaging deployment mistake for
 * this app is an ephemeral data directory: every redeploy silently deletes
 * all accounts AND rotates the token secret, which presents as "users have to
 * sign up again and can re-register the same email". These checks make that
 * misconfiguration impossible to miss in the logs.
 */
function warnIfStorageLooksEphemeral() {
  const info = dbPersistenceInfo();
  log.info(`Data dir: ${info.dataDir} (db instance ${info.instanceId?.slice(0, 8)}…, boot #${info.bootCount}, ${info.userCount} users)`);
  if (process.env.NODE_ENV !== 'production') return;
  if (!info.dataDirConfigured) {
    log.error('ROWPOINT_DATA_DIR is not set — the database is being written inside the app directory, '
      + 'which is EPHEMERAL on most hosts (Render/Railway/Heroku/Docker without a volume). '
      + 'Every redeploy will DELETE ALL USER ACCOUNTS and invalidate every session. '
      + 'Mount a persistent disk and set ROWPOINT_DATA_DIR to it (see DEPLOY.md).');
  }
  if (!info.dbExistedAtBoot && info.bootCount === 1) {
    log.warn('A brand-new database was created at boot. If this is NOT the first deploy of this app, '
      + 'the previous database was lost — the data directory is not persistent. '
      + 'Fix the disk mount before real users sign up (see DEPLOY.md).');
  }
  if (!info.tokenSecretFromEnv) {
    log.warn('ROWPOINT_TOKEN_SECRET is not set — the session-signing secret lives only on the data disk. '
      + 'That is fine while the disk is persistent, but setting it as an environment variable '
      + 'keeps every user signed in even across disk migrations.');
  }
}
import { authRouter } from './auth.js';
import { usersRouter } from './users.js';
import { teamsRouter } from './teams.js';
import { workoutsRouter } from './workouts.js';
import { wellnessRouter } from './wellness.js';
import { socialRouter } from './social.js';
import { groupsRouter } from './groups.js';
import { progressRouter } from './progress.js';
import { aiRouter } from './aiRouter.js';
import { adminRouter } from './admin.js';
import { csrfProtection } from './cookies.js';
import { scheduleBackups } from './backup.js';
import { attachRealtime } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Security headers for the SPA. The CSP is tuned to exactly what RowPoint
  // needs: same-origin everything, inline *styles* only (the UI uses style
  // attributes; there are no inline scripts), the Google Identity script/iframe
  // (only active when GOOGLE_CLIENT_ID is set), the Google Fonts CDN, and
  // data:/https: images (avatars, chat images, user photos). This blocks the
  // main XSS vectors while leaving Web Bluetooth (governed by Permissions-
  // Policy below) intact.
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self' https://accounts.google.com https://apis.google.com",
    "connect-src 'self' https://accounts.google.com",
    "frame-src https://accounts.google.com",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Deny powerful features the app never uses; allow Web Bluetooth to self
    // (rowing machines + HR straps depend on it).
    res.setHeader('Permissions-Policy', 'bluetooth=(self), geolocation=(), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=()');
    // HSTS only in production (over HTTPS) — never on localhost/dev.
    if (!config.devMode) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // API usage counters for the admin System tab (in-memory, per process).
  app.use('/api', metricsMiddleware);

  // CSRF protection for cookie-authenticated, state-changing requests. No-op
  // for GETs, for Bearer-token (API/test) requests, and for requests with no
  // session cookie — so it hardens the browser flow without touching anything
  // else. (See server/cookies.js for the double-submit rationale.)
  app.use('/api', csrfProtection);

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/workouts', workoutsRouter);
  app.use('/api/wellness', wellnessRouter);
  app.use('/api/social', socialRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/me', progressRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/admin', adminRouter);

  app.get('/api/status', (req, res) => res.json({ ok: true, name: 'RowPoint', ts: Date.now() }));

  // Readiness probe for load balancers / uptime monitors: verifies the process
  // is up AND the database answers a trivial query. Returns 503 if the DB is
  // unreachable so orchestrators can pull the instance out of rotation. No
  // authentication and no sensitive data — safe to expose publicly.
  app.get('/api/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.json({ ok: true, db: 'ok', uptimeSeconds: Math.round(process.uptime()) });
    } catch (e) {
      res.status(503).json({ ok: false, db: 'error', error: e.message });
    }
  });

  // Dev-only: expose the email outbox so verification flows are testable
  // without a real mail provider. Disabled entirely in production.
  if (config.devMode) {
    app.get('/api/dev/outbox', (req, res) => {
      const to = String(req.query.to || '').toLowerCase();
      const rows = to
        ? db.prepare('SELECT * FROM email_outbox WHERE to_email = ? ORDER BY created_at DESC LIMIT 10').all(to)
        : db.prepare('SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT 10').all();
      res.json({ emails: rows });
    });
  }

  // Static SPA.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get(/^\/(?!api\/|ws).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use(errorHandler);
  return app;
}

export function startServer(port = config.port) {
  warnIfStorageLooksEphemeral();
  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);
  scheduleBackups();
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`RowPoint listening on http://localhost:${server.address().port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
