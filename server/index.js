// RowPoint server entry point.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { errorHandler } from './middleware.js';
import { metricsMiddleware } from './metrics.js';
import { authRouter } from './auth.js';
import { usersRouter } from './users.js';
import { teamsRouter } from './teams.js';
import { workoutsRouter } from './workouts.js';
import { wellnessRouter } from './wellness.js';
import { socialRouter } from './social.js';
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
