// Admin API. Access is role-based (RBAC via adminRequired; the owner email is
// auto-assigned the Admin role). Every action is audit-logged.
//
// Sections: research data · user/workout/AI statistics · user management
// (search, suspend, delete, roles, password reset, research grant/revoke,
// workout history, feedback) · system health · security (auth events, failed
// logins) · data management (CSV/JSON/SQL exports, DB backup, DB stats) ·
// moderation · broadcast · audit log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, dbPersistenceInfo } from './db.js';
import { config } from './config.js';
import { authRequired, adminRequired, audit, recordAuthEvent } from './middleware.js';
import { metricsSnapshot } from './metrics.js';
import { llmConfigured } from './ai/coach.js';
import { mailConfigured } from './mailer.js';
import { createBackup, listBackups, verifyBackup } from './backup.js';
import { developerAnalytics } from './analytics.js';
import { observatoryExport } from './observatory.js';
import { uuid, now, badRequest, ApiError, isEmail, safeJson, researchId, hashPassword } from './util.js';

export const adminRouter = Router();
adminRouter.use(authRequired, adminRequired);

/* ================= 1. research data ================= */

const RESEARCH_WORKOUT_COLS = [
  'research_id', 'study_tag', 'machine_type', 'workout_type', 'started_at',
  'total_distance_m', 'total_time_s', 'avg_split_s', 'avg_stroke_rate',
  'avg_heart_rate', 'avg_power_watts', 'birth_decade', 'weight_class',
  'goal_type', 'contributed_at', 'max_heart_rate', 'min_heart_rate',
  'hr_drift_pct', 'equipment',
];

function researchWorkoutQuery(query) {
  const { studyTag, workoutType, from, to } = query;
  let sql = 'SELECT * FROM research_workouts WHERE 1=1';
  const params = [];
  if (studyTag) { sql += ' AND study_tag = ?'; params.push(studyTag); }
  if (workoutType) { sql += ' AND workout_type = ?'; params.push(workoutType); }
  if (from) { sql += ' AND contributed_at >= ?'; params.push(Math.floor(new Date(from).getTime() / 1000)); }
  if (to) { sql += ' AND contributed_at <= ?'; params.push(Math.floor(new Date(to).getTime() / 1000) + 86399); }
  sql += ' ORDER BY contributed_at DESC LIMIT 5000';
  return db.prepare(sql).all(...params);
}

adminRouter.get('/research/workouts', (req, res) => {
  const rows = researchWorkoutQuery(req.query);
  const { studyTag, workoutType, from, to, format } = req.query;
  audit(req.user.id, 'research.workouts.query', null, { studyTag, workoutType, from, to, count: rows.length, export: format || 'json' });
  if (format === 'csv') {
    const lines = [RESEARCH_WORKOUT_COLS.join(',')];
    for (const r of rows) lines.push(RESEARCH_WORKOUT_COLS.map(c => r[c] ?? '').join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="research-workouts.csv"');
    return res.send(lines.join('\n'));
  }
  res.json({ rows });
});

adminRouter.get('/research/wellness', (req, res) => {
  const { studyTag, from, to } = req.query;
  let sql = 'SELECT * FROM research_wellness WHERE 1=1';
  const params = [];
  if (studyTag) { sql += ' AND study_tag = ?'; params.push(studyTag); }
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  sql += ' ORDER BY contributed_at DESC LIMIT 5000';
  const rows = db.prepare(sql).all(...params);
  audit(req.user.id, 'research.wellness.query', null, { studyTag, from, to, count: rows.length });
  res.json({ rows });
});

adminRouter.get('/research/studies', (req, res) => {
  res.json({ studies: db.prepare('SELECT * FROM studies ORDER BY created_at').all() });
});

adminRouter.post('/research/studies', (req, res) => {
  const tag = String(req.body?.tag || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const name = String(req.body?.name || '').trim();
  if (!tag || !name) throw badRequest('Study needs a tag and a name.');
  db.prepare('INSERT INTO studies (id, tag, name, active, created_at) VALUES (?,?,?,1,?)').run(uuid(), tag, name, now());
  audit(req.user.id, 'research.study.create', tag, { name });
  res.status(201).json({ ok: true });
});

adminRouter.patch('/research/studies/:tag', (req, res) => {
  db.prepare('UPDATE studies SET active = ? WHERE tag = ?').run(req.body?.active ? 1 : 0, req.params.tag);
  audit(req.user.id, 'research.study.update', req.params.tag, { active: !!req.body?.active });
  res.json({ ok: true });
});

// Research oversight: dataset completeness — how many rows lack each optional
// signal, so researchers know what analyses the corpus can support.
adminRouter.get('/research/completeness', (req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  const total = count('SELECT COUNT(*) c FROM research_workouts');
  const report = {
    totalWorkoutRows: total,
    totalWellnessRows: count('SELECT COUNT(*) c FROM research_wellness'),
    hrDatasets: count('SELECT COUNT(*) c FROM research_workouts WHERE hr_series_json IS NOT NULL'),
    missing: {
      heartRate: count('SELECT COUNT(*) c FROM research_workouts WHERE avg_heart_rate IS NULL'),
      hrSeries: count('SELECT COUNT(*) c FROM research_workouts WHERE hr_series_json IS NULL'),
      power: count('SELECT COUNT(*) c FROM research_workouts WHERE avg_power_watts IS NULL'),
      demographics: count('SELECT COUNT(*) c FROM research_workouts WHERE birth_decade IS NULL AND weight_class IS NULL'),
      splits: count("SELECT COUNT(*) c FROM research_workouts WHERE splits_json IS NULL OR splits_json = '[]'"),
      strokeRate: count('SELECT COUNT(*) c FROM research_workouts WHERE avg_stroke_rate IS NULL'),
    },
    consentingParticipants: count('SELECT COUNT(*) c FROM users WHERE research_opt_in = 1 AND email_verified = 1'),
    distinctContributors: count('SELECT COUNT(DISTINCT research_id) c FROM research_workouts'),
  };
  audit(req.user.id, 'research.completeness.view', null, null);
  res.json({ report });
});

/* ================= 2. statistics ================= */

adminRouter.get('/stats', (req, res) => {
  const t = now();
  const day = 86400;
  const count = (sql, ...p) => db.prepare(sql).get(...p).c;

  // Retention: of users who signed up more than 30 days ago, how many were
  // active (any API call) in the last 7 days.
  const cohort = count('SELECT COUNT(*) c FROM users WHERE created_at <= ?', t - 30 * day);
  const retained = count('SELECT COUNT(*) c FROM users WHERE created_at <= ? AND last_active_at >= ?', t - 30 * day, t - 7 * day);

  const stats = {
    /* ---- users ---- */
    totalUsers: count('SELECT COUNT(*) c FROM users'),
    coaches: count("SELECT COUNT(*) c FROM users WHERE account_type = 'coach'"),
    rowers: count("SELECT COUNT(*) c FROM users WHERE account_type = 'rower'"),
    admins: count("SELECT COUNT(*) c FROM users WHERE role = 'admin'"),
    verified: count('SELECT COUNT(*) c FROM users WHERE email_verified = 1'),
    suspended: count('SELECT COUNT(*) c FROM users WHERE suspended = 1'),
    researchOptIn: count('SELECT COUNT(*) c FROM users WHERE research_opt_in = 1'),
    researchOptOut: count('SELECT COUNT(*) c FROM users WHERE research_opt_in = 0'),
    newLastDay: count('SELECT COUNT(*) c FROM users WHERE created_at >= ?', t - day),
    newLastWeek: count('SELECT COUNT(*) c FROM users WHERE created_at >= ?', t - 7 * day),
    newLastMonth: count('SELECT COUNT(*) c FROM users WHERE created_at >= ?', t - 30 * day),
    dailyActiveUsers: count('SELECT COUNT(*) c FROM users WHERE last_active_at >= ?', t - day),
    weeklyActiveUsers: count('SELECT COUNT(*) c FROM users WHERE last_active_at >= ?', t - 7 * day),
    monthlyActiveUsers: count('SELECT COUNT(*) c FROM users WHERE last_active_at >= ?', t - 30 * day),
    activeLast7d: count('SELECT COUNT(DISTINCT user_id) c FROM workouts WHERE created_at >= ?', t - 7 * day),
    activeLast30d: count('SELECT COUNT(DISTINCT user_id) c FROM workouts WHERE created_at >= ?', t - 30 * day),
    retention30d7dPct: cohort ? Math.round((retained / cohort) * 100) : null,
    totalTeams: count('SELECT COUNT(*) c FROM teams'),
    totalGroups: count('SELECT COUNT(*) c FROM groups'),
    signupsPerDay: db.prepare(
      `SELECT date(created_at,'unixepoch') AS d, COUNT(*) AS n FROM users
       WHERE created_at >= ? GROUP BY d ORDER BY d`).all(t - 30 * day),

    /* ---- workouts ---- */
    totalWorkouts: count('SELECT COUNT(*) c FROM workouts'),
    workoutsLast7d: count('SELECT COUNT(*) c FROM workouts WHERE created_at >= ?', t - 7 * day),
    totalMetersRowed: Math.round(db.prepare('SELECT COALESCE(SUM(total_distance_m),0) s FROM workouts').get().s),
    totalHoursTrained: Math.round(db.prepare('SELECT COALESCE(SUM(total_time_s),0) s FROM workouts').get().s / 3600 * 10) / 10,
    avgWorkoutDurationMin: round1(db.prepare('SELECT AVG(total_time_s) a FROM workouts').get().a / 60),
    avgWorkoutDistanceM: Math.round(db.prepare('SELECT COALESCE(AVG(total_distance_m),0) a FROM workouts').get().a),
    avgPaceSPer500m: round1(db.prepare('SELECT AVG(avg_split_s) a FROM workouts WHERE avg_split_s > 0').get().a),
    workoutsWithHr: count('SELECT COUNT(*) c FROM workouts WHERE hr_series_json IS NOT NULL'),
    workoutsPerDay: db.prepare(
      `SELECT date(started_at,'unixepoch') AS d, COUNT(*) AS n, ROUND(SUM(total_distance_m)) AS meters
       FROM workouts WHERE started_at >= ? GROUP BY d ORDER BY d`).all(t - 30 * day),
    popularWorkoutTypes: db.prepare(
      `SELECT COALESCE(json_extract(workout_plan_json, '$.type'), 'justrow') AS type, COUNT(*) AS n
       FROM workouts GROUP BY type ORDER BY n DESC`).all(),
    machineTypes: db.prepare(
      'SELECT COALESCE(machine_type, \'rower\') AS machine, COUNT(*) AS n FROM workouts GROUP BY machine ORDER BY n DESC').all(),

    /* ---- research ---- */
    researchWorkoutRows: count('SELECT COUNT(*) c FROM research_workouts'),
    researchWellnessRows: count('SELECT COUNT(*) c FROM research_wellness'),
    researchHrDatasets: count('SELECT COUNT(*) c FROM research_workouts WHERE hr_series_json IS NOT NULL'),
  };
  audit(req.user.id, 'stats.view', null, null);
  res.json({ stats });
});

/* ---- AI analytics ---- */

adminRouter.get('/stats/ai', (req, res) => {
  const t = now();
  const count = (sql, ...p) => db.prepare(sql).get(...p).c;
  const total = count('SELECT COUNT(*) c FROM ai_suggestions');
  const followedKnown = db.prepare('SELECT COUNT(*) c FROM ai_suggestions WHERE followed IS NOT NULL AND date < ?')
    .get(new Date().toISOString().slice(0, 10)).c;
  const followedYes = db.prepare('SELECT COUNT(*) c FROM ai_suggestions WHERE followed = 1').get().c;
  // "Success": a followed recommendation whose resulting workout was well
  // paced — the closest available outcome signal for recommendation quality.
  const successRows = db.prepare(
    `SELECT COUNT(*) c FROM ai_suggestions s
     WHERE s.followed = 1 AND EXISTS (
       SELECT 1 FROM workouts w
       WHERE w.user_id = s.user_id
         AND date(w.started_at,'unixepoch') = s.date
         AND json_extract(w.ai_feedback_json, '$.classification') = 'well_paced')`).get().c;
  const stats = {
    totalGenerated: total,
    generatedLast7d: count('SELECT COUNT(*) c FROM ai_suggestions WHERE created_at >= ?', t - 7 * 86400),
    generatedLast30d: count('SELECT COUNT(*) c FROM ai_suggestions WHERE created_at >= ?', t - 30 * 86400),
    bySource: db.prepare("SELECT COALESCE(source,'legacy') AS source, COUNT(*) AS n FROM ai_suggestions GROUP BY source ORDER BY n DESC").all(),
    byCategory: db.prepare('SELECT rationale_tag AS category, COUNT(*) AS n FROM ai_suggestions GROUP BY rationale_tag ORDER BY n DESC').all(),
    byConfidence: db.prepare("SELECT COALESCE(confidence,'n/a') AS confidence, COUNT(*) AS n FROM ai_suggestions GROUP BY confidence").all(),
    byStatus: db.prepare('SELECT status, COUNT(*) AS n FROM ai_suggestions GROUP BY status').all(),
    adherence: {
      followed: followedYes,
      trackable: followedKnown + followedYes,
      followRatePct: total ? Math.round((followedYes / total) * 100) : null,
    },
    successMetrics: {
      followedAndWellPaced: successRows,
      wellPacedRatePct: followedYes ? Math.round((successRows / followedYes) * 100) : null,
    },
    llmConfigured: llmConfigured(),
    model: llmConfigured() ? config.anthropicModel : null,
  };
  audit(req.user.id, 'stats.ai.view', null, null);
  res.json({ stats });
});

/* ================= 3. user management ================= */

function adminUserView(u) {
  return {
    id: u.id, email: u.email, displayName: u.display_name, accountType: u.account_type,
    role: u.role || 'user',
    emailVerified: !!u.email_verified, suspended: !!u.suspended, suspendedReason: u.suspended_reason,
    researchOptIn: !!u.research_opt_in, researchShareDemographics: !!u.research_share_demographics,
    createdAt: u.created_at, lastActiveAt: u.last_active_at,
  };
}

adminRouter.get('/users/search', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw badRequest('Enter a full email address.');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  audit(req.user.id, 'user.search', email, { found: !!u });
  if (!u) return res.json({ found: false });
  const teams = db.prepare(
    `SELECT t.id, t.name, 'member' AS role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?
     UNION SELECT id, name, 'coach' AS role FROM teams WHERE coach_id = ?`).all(u.id, u.id);
  res.json({
    found: true,
    user: {
      ...adminUserView(u),
      workoutCount: db.prepare('SELECT COUNT(*) c FROM workouts WHERE user_id = ?').get(u.id).c,
      teams,
    },
  });
});

// Recent accounts list (search complements it; this gives browsability).
adminRouter.get('/users/recent', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 50').all();
  audit(req.user.id, 'user.list_recent', null, null);
  res.json({ users: rows.map(adminUserView) });
});

adminRouter.get('/users/:id/workouts', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new ApiError(404, 'User not found.', 'not_found');
  const rows = db.prepare(
    `SELECT id, started_at, machine_type, total_distance_m, total_time_s, avg_split_s,
            avg_heart_rate, max_heart_rate, ai_feedback_json, workout_plan_json
     FROM workouts WHERE user_id = ? ORDER BY started_at DESC LIMIT 100`).all(u.id);
  audit(req.user.id, 'user.workouts.view', u.email, { count: rows.length });
  res.json({
    workouts: rows.map(w => ({
      ...w,
      planType: safeJson(w.workout_plan_json)?.type || 'justrow',
      pacing: safeJson(w.ai_feedback_json)?.classification || null,
      ai_feedback_json: undefined, workout_plan_json: undefined,
    })),
  });
});

// Feedback the user has filed and reports filed against them.
adminRouter.get('/users/:id/feedback', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new ApiError(404, 'User not found.', 'not_found');
  const filed = db.prepare('SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 50').all(u.id);
  const against = db.prepare('SELECT * FROM reports WHERE target_user_id = ? ORDER BY created_at DESC LIMIT 50').all(u.id);
  audit(req.user.id, 'user.feedback.view', u.email, null);
  res.json({ filed, against });
});

adminRouter.post('/users/:id/suspend', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new ApiError(404, 'User not found.', 'not_found');
  if (u.email === config.ADMIN_EMAIL) throw badRequest('You cannot suspend the owner account.');
  const suspend = req.body?.suspend !== false;
  db.prepare('UPDATE users SET suspended = ?, suspended_reason = ? WHERE id = ?')
    .run(suspend ? 1 : 0, suspend ? String(req.body?.reason || 'Suspended by admin').slice(0, 300) : null, u.id);
  audit(req.user.id, suspend ? 'user.suspend' : 'user.reinstate', u.email, { reason: req.body?.reason });
  res.json({ ok: true });
});

// RBAC: assign or revoke the admin role. The owner account cannot be demoted.
adminRouter.post('/users/:id/role', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new ApiError(404, 'User not found.', 'not_found');
  const role = req.body?.role;
  if (!['user', 'admin'].includes(role)) throw badRequest('Role must be "user" or "admin".');
  if (u.email === config.ADMIN_EMAIL && role !== 'admin') {
    throw badRequest('The owner account\'s Admin role cannot be revoked.');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  audit(req.user.id, 'user.role.assign', u.email, { role });
  recordAuthEvent('role_change', { email: u.email, userId: u.id, detail: `role set to ${role} by ${req.user.email}` });
  res.json({ ok: true, role });
});

// Support password reset: generates a one-time temporary password, shown to
// the admin exactly once. The user should change it after signing in.
adminRouter.post('/users/:id/reset-password', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new ApiError(404, 'User not found.', 'not_found');
  const temp = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe
  // Resetting the password also invalidates every existing session for that
  // account (token_version bump) — a leaked old token can't outlive a reset.
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(temp), u.id);
  audit(req.user.id, 'user.password.reset', u.email, null);
  recordAuthEvent('password_reset', { email: u.email, userId: u.id, detail: `reset by admin ${req.user.email}` });
  res.json({ ok: true, temporaryPassword: temp });
});

// Grant/revoke research participation on a user's behalf (support requests).
adminRouter.post('/users/:id/research', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new ApiError(404, 'User not found.', 'not_found');
  const optIn = !!req.body?.optIn;
  db.prepare('UPDATE users SET research_opt_in = ? WHERE id = ?').run(optIn ? 1 : 0, u.id);
  audit(req.user.id, optIn ? 'user.research.grant' : 'user.research.revoke', u.email, null);
  res.json({ ok: true, researchOptIn: optIn });
});

// Manual deletion for support/GDPR requests — same semantics as the
// user-initiated flow, including removal of research contributions.
adminRouter.delete('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new ApiError(404, 'User not found.', 'not_found');
  if (u.email === req.user.email) throw badRequest('You cannot delete your own admin account from here.');
  const rid = researchId(u.id);
  db.prepare('DELETE FROM research_workouts WHERE research_id = ?').run(rid);
  db.prepare('DELETE FROM research_wellness WHERE research_id = ?').run(rid);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit(req.user.id, 'user.delete', u.email, { requested: req.body?.reason || 'admin manual deletion' });
  res.json({ ok: true });
});

/* ================= 4. system health ================= */

adminRouter.get('/health', (req, res) => {
  const t = now();
  const rows = db.prepare(
    `SELECT kind, COUNT(*) AS n FROM health_events WHERE created_at >= ? GROUP BY kind`).all(t - 7 * 86400);
  const recent = db.prepare('SELECT * FROM health_events ORDER BY created_at DESC LIMIT 50').all();
  audit(req.user.id, 'health.view', null, null);
  res.json({ last7d: rows, recent });
});

adminRouter.get('/system', (req, res) => {
  // Database status: quick self-check + physical size (main file + WAL).
  let dbOk = true;
  let quickCheck = 'ok';
  try { quickCheck = db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'ok'; dbOk = quickCheck === 'ok'; }
  catch (e) { dbOk = false; quickCheck = e.message; }
  const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const dbBytes = fileSize(config.dbFile);
  const walBytes = fileSize(`${config.dbFile}-wal`);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const tableCounts = tables.map(({ name }) => ({
    table: name,
    rows: db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c,
  }));

  const t = now();
  const failedSyncs7d = db.prepare(
    "SELECT COUNT(*) c FROM health_events WHERE kind = 'sync_failure' AND created_at >= ?").get(t - 7 * 86400).c;
  const apiErrors7d = db.prepare(
    "SELECT COUNT(*) c FROM health_events WHERE kind = 'api_error' AND created_at >= ?").get(t - 7 * 86400).c;

  audit(req.user.id, 'system.view', null, null);
  res.json({
    system: {
      backend: { status: 'ok', ...metricsSnapshot() },
      database: {
        status: dbOk ? 'ok' : 'error',
        quickCheck,
        file: path.basename(config.dbFile),
        sizeBytes: dbBytes,
        walSizeBytes: walBytes,
        totalStorageBytes: dbBytes + walBytes,
        tableCounts,
        // Storage-persistence proof: instanceId and dbCreatedAt survive
        // restarts only if the data directory does. A low bootCount with a
        // recent dbCreatedAt on a long-running deployment means accounts are
        // being wiped on redeploys — the ephemeral-disk misconfiguration.
        persistence: dbPersistenceInfo(),
      },
      auth: {
        status: 'ok',
        tokenSigning: 'hmac-sha256',
        emailDelivery: mailConfigured() ? 'resend' : 'dev-outbox',
        googleOauth: !!config.googleClientId,
        appleOauth: !!config.appleClientId,
      },
      ai: {
        llmConfigured: llmConfigured(),
        model: llmConfigured() ? config.anthropicModel : null,
        fallback: 'analysis_engine',
      },
      backgroundTasks: {
        // Client sync is the app's only background job system (offline-first
        // queue on each device); failures surface as sync_failure events.
        failedSyncs7d,
        apiErrors7d,
      },
    },
  });
});

/* ================= 5. security ================= */

adminRouter.get('/security/auth-events', (req, res) => {
  const kind = String(req.query.kind || '');
  const rows = kind
    ? db.prepare('SELECT * FROM auth_events WHERE kind = ? ORDER BY created_at DESC LIMIT 200').all(kind)
    : db.prepare('SELECT * FROM auth_events ORDER BY created_at DESC LIMIT 200').all();
  const t = now();
  const summary = {
    failedLogins24h: db.prepare("SELECT COUNT(*) c FROM auth_events WHERE kind = 'login_fail' AND created_at >= ?").get(t - 86400).c,
    failedLogins7d: db.prepare("SELECT COUNT(*) c FROM auth_events WHERE kind = 'login_fail' AND created_at >= ?").get(t - 7 * 86400).c,
    logins7d: db.prepare("SELECT COUNT(*) c FROM auth_events WHERE kind IN ('login_success','oauth_login') AND created_at >= ?").get(t - 7 * 86400).c,
    repeatOffenders: db.prepare(
      `SELECT email, COUNT(*) AS n FROM auth_events
       WHERE kind = 'login_fail' AND created_at >= ? GROUP BY email HAVING n >= 3 ORDER BY n DESC LIMIT 20`).all(t - 7 * 86400),
  };
  audit(req.user.id, 'security.auth_events.view', kind || 'all', null);
  res.json({ events: rows, summary });
});

/* ================= 6. data management ================= */

adminRouter.get('/export/research.json', (req, res) => {
  const workouts = researchWorkoutQuery(req.query);
  const wellness = db.prepare('SELECT * FROM research_wellness ORDER BY contributed_at DESC LIMIT 5000').all();
  audit(req.user.id, 'export.research.json', null, { workouts: workouts.length, wellness: wellness.length });
  res.setHeader('Content-Disposition', 'attachment; filename="research-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    note: 'Pseudonymous research dataset — research_id is an HMAC, not joinable to accounts.',
    workouts, wellness,
  });
});

adminRouter.get('/export/research.sql', (req, res) => {
  const sqlLit = (v) => v === null || v === undefined ? 'NULL'
    : typeof v === 'number' ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;
  const dump = (table) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY contributed_at DESC LIMIT 5000`).all();
    if (!rows.length) return `-- ${table}: empty\n`;
    const cols = Object.keys(rows[0]);
    return rows.map(r => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => sqlLit(r[c])).join(', ')});`).join('\n') + '\n';
  };
  audit(req.user.id, 'export.research.sql', null, null);
  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', 'attachment; filename="research-export.sql"');
  res.send(`-- RowPoint anonymized research export ${new Date().toISOString()}\nBEGIN TRANSACTION;\n${dump('research_workouts')}${dump('research_wellness')}COMMIT;\n`);
});

// Full database backup (contains personal data — owner/support use only,
// audit-logged like everything else).
adminRouter.get('/backup.db', (req, res) => {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* checkpoint is best-effort */ }
  audit(req.user.id, 'export.backup.db', null, null);
  res.download(path.resolve(config.dbFile), `rowpoint-backup-${todayCompact()}.db`);
});

/* ---- automated encrypted backups (server/backup.js) ---- */

// List the retained encrypted backups + their manifests, plus current policy.
adminRouter.get('/backups', (req, res) => {
  const lastAt = Number(db.prepare("SELECT value FROM meta WHERE key = 'last_backup_at'").get()?.value || 0) || null;
  res.json({
    policy: {
      enabled: config.backupsEnabled,
      intervalHours: config.backupIntervalHours,
      retention: config.backupRetention,
      keyFromEnv: !!process.env.ROWPOINT_BACKUP_KEY,
      lastBackupAt: lastAt,
    },
    backups: listBackups(),
  });
});

// Trigger an on-demand encrypted backup now.
adminRouter.post('/backups', (req, res) => {
  const manifest = createBackup('manual-admin');
  audit(req.user.id, 'backup.create', manifest.file, { users: manifest.users, bytes: manifest.plaintextBytes });
  res.status(201).json({ backup: manifest });
});

// Integrity-check a backup (decrypt + verify GCM auth + SHA-256) without
// restoring it. Restore itself is an operator CLI action (node server/backup.js
// restore <file>) so it can never clobber a live DB from the web UI.
adminRouter.post('/backups/:file/verify', (req, res) => {
  const result = verifyBackup(req.params.file);
  audit(req.user.id, 'backup.verify', req.params.file, { ok: result.ok });
  res.json({ verify: result });
});

/* ---- developer / product analytics (aggregate-only, no PII) ---- */
adminRouter.get('/analytics', (req, res) => {
  audit(req.user.id, 'analytics.view', null, null);
  res.json({ analytics: developerAnalytics() });
});

/* ---- Research Observatory: publication-ready aggregate export (no PII) ---- */
adminRouter.get('/observatory/export', (req, res) => {
  audit(req.user.id, 'observatory.export', null, null);
  res.json({ observatory: observatoryExport() });
});

adminRouter.get('/db-stats', (req, res) => {
  const pragma = (name) => { try { return db.prepare(`PRAGMA ${name}`).get()?.[name]; } catch { return null; } };
  const growth = db.prepare(
    `SELECT date(created_at,'unixepoch') AS d, COUNT(*) AS workouts
     FROM workouts WHERE created_at >= ? GROUP BY d ORDER BY d`).all(now() - 30 * 86400);
  audit(req.user.id, 'db.stats.view', null, null);
  res.json({
    stats: {
      pageCount: pragma('page_count'),
      pageSizeBytes: pragma('page_size'),
      journalMode: pragma('journal_mode'),
      freelistCount: pragma('freelist_count'),
      growthLast30d: growth,
    },
  });
});

/* ================= 7. moderation ================= */

adminRouter.get('/reports', (req, res) => {
  const status = ['open', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const rows = db.prepare(
    `SELECT r.*, ru.display_name AS reporter_name, tu.display_name AS target_name, tu.email AS target_email
     FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id LEFT JOIN users tu ON tu.id = r.target_user_id
     WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`).all(status);
  audit(req.user.id, 'reports.view', status, null);
  res.json({ reports: rows });
});

adminRouter.post('/reports/:id/action', (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r) throw new ApiError(404, 'Report not found.', 'not_found');
  const action = req.body?.action; // 'dismiss' | 'suspend_target' | 'note'
  if (action === 'suspend_target') {
    db.prepare('UPDATE users SET suspended = 1, suspended_reason = ? WHERE id = ?')
      .run(`Moderation: ${String(req.body?.note || r.reason).slice(0, 200)}`, r.target_user_id);
  }
  db.prepare('UPDATE reports SET status = ?, actioned_by = ?, actioned_at = ?, action_note = ? WHERE id = ?')
    .run(action === 'dismiss' ? 'dismissed' : 'actioned', req.user.id, now(), String(req.body?.note || '').slice(0, 500), r.id);
  audit(req.user.id, `report.${action || 'action'}`, r.id, { target: r.target_user_id });
  res.json({ ok: true });
});

/* ================= 8. broadcast ================= */

adminRouter.post('/broadcast', (req, res) => {
  const { title, body, audience } = req.body || {};
  if (!title) throw badRequest('Broadcast needs a title.');
  let sql = 'SELECT id, notif_prefs FROM users WHERE suspended = 0';
  const params = [];
  if (audience?.accountType) { sql += ' AND account_type = ?'; params.push(audience.accountType); }
  if (audience?.researchOptIn !== undefined) { sql += ' AND research_opt_in = ?'; params.push(audience.researchOptIn ? 1 : 0); }
  if (audience?.teamId) {
    sql += ' AND (id IN (SELECT user_id FROM team_members WHERE team_id = ?) OR id IN (SELECT coach_id FROM teams WHERE id = ?))';
    params.push(audience.teamId, audience.teamId);
  }
  const users = db.prepare(sql).all(...params);
  const ins = db.prepare('INSERT INTO notifications (id, user_id, category, title, body, read, created_at) VALUES (?,?,?,?,?,0,?)');
  let sent = 0;
  for (const u of users) {
    const prefs = safeJson(u.notif_prefs, {});
    if (prefs.announcement === false) continue;
    ins.run(uuid(), u.id, 'announcement', String(title).slice(0, 120), String(body || '').slice(0, 2000), now());
    sent++;
  }
  audit(req.user.id, 'broadcast.send', null, { title, audience, recipients: sent });
  res.json({ ok: true, recipients: sent });
});

/* ================= 9. audit log ================= */

adminRouter.get('/audit', (req, res) => {
  const entries = db.prepare(
    `SELECT a.*, u.email AS admin_email FROM audit_log a LEFT JOIN users u ON u.id = a.admin_user_id
     ORDER BY a.created_at DESC LIMIT 200`).all();
  res.json({ entries });
});

/* ------------------------------------------------------------------ */

const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const todayCompact = () => new Date().toISOString().slice(0, 10);
