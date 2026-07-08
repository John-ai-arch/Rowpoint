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
import { attachRealtime } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Basic security headers for the SPA.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // API usage counters for the admin System tab (in-memory, per process).
  app.use('/api', metricsMiddleware);

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
