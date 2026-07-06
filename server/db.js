// Database layer. Uses Node's built-in SQLite (node:sqlite).
//
// Engineering note: the spec suggests Postgres for production (§7). This
// implementation uses SQLite so the app is fully self-contained and testable;
// the schema below is deliberately plain SQL (TEXT ids, INTEGER unix
// timestamps, no SQLite-specific types) so it ports to Postgres directly.
// All access goes through prepared statements — no string interpolation.
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
/* ------------------------------ accounts ------------------------------ */
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_sub TEXT,
  apple_sub TEXT,
  display_name TEXT NOT NULL,
  photo_url TEXT,
  account_type TEXT NOT NULL CHECK (account_type IN ('coach','rower')),
  birth_year INTEGER,
  weight_kg REAL,
  weight_class TEXT,
  best_2k_seconds REAL,
  best_2k_verified INTEGER NOT NULL DEFAULT 0,
  units TEXT NOT NULL DEFAULT 'metric' CHECK (units IN ('metric','imperial')),
  goal_type TEXT,                       -- general_fitness|race_prep|weight_class|return_from_injury|other
  goal_target_event TEXT,
  goal_target_date TEXT,
  goal_weekly_sessions INTEGER,
  goal_weekly_minutes INTEGER,
  email_verified INTEGER NOT NULL DEFAULT 0,
  research_opt_in INTEGER NOT NULL DEFAULT 1,   -- §5.1 opt-OUT model
  share_workouts_team INTEGER NOT NULL DEFAULT 1,  -- §4/§5 social sharing, separate from research
  share_2k_history INTEGER NOT NULL DEFAULT 1,
  share_wellness_coach INTEGER NOT NULL DEFAULT 0,
  share_profile INTEGER NOT NULL DEFAULT 1,
  notif_prefs TEXT NOT NULL DEFAULT '{"workout_reminder":true,"wellness_reminder":true,"team_activity":true,"group_activity":true,"announcement":true}',
  suspended INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

/* Dev mailer sink: in production this is replaced by a real email provider. */
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

/* ------------------------------ teams ------------------------------ */
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  coach_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  UNIQUE(team_id, user_id)
);

/* ------------------------------ workouts ------------------------------ */
CREATE TABLE IF NOT EXISTS workout_plans (
  id TEXT PRIMARY KEY,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  machine_type TEXT NOT NULL DEFAULT 'rower',
  plan_json TEXT NOT NULL,              -- {type:'time'|'distance'|'intervals', ...}
  is_daily_suggestion INTEGER NOT NULL DEFAULT 0,
  suggested_date TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
  coach_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_date TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_team ON assignments(team_id, scheduled_date);

/* Workout history is first-class and keyed by user_id (§2.5): it starts empty
   for every account and can never leak across accounts sharing a device. */
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,                  -- client-generated UUID (idempotent sync)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  assigned_by_coach_id TEXT,            -- NULL if self-directed (§11.2 input)
  started_at INTEGER,
  ended_at INTEGER,
  machine_type TEXT,
  machine_id TEXT,                      -- stable peripheral identifier (§1.2)
  total_distance_m REAL,
  total_time_s REAL,
  avg_split_s REAL,
  avg_stroke_rate REAL,
  avg_heart_rate REAL,
  avg_power_watts REAL,
  workout_plan_json TEXT,
  ai_feedback_json TEXT,                -- §11.4
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workouts_user ON workouts(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_workouts_assignment ON workouts(assignment_id);

CREATE TABLE IF NOT EXISTS splits (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  split_index INTEGER NOT NULL,
  interval_index INTEGER,
  distance_m REAL,
  time_s REAL,
  avg_pace_s_per_500m REAL,
  avg_stroke_rate REAL,
  avg_heart_rate INTEGER,
  avg_power_watts REAL
);
CREATE INDEX IF NOT EXISTS idx_splits_workout ON splits(workout_id, split_index);

/* One row per stroke; samples stored as a JSON array of force values.
   (The spec's client table is one row per sample; server-side we compact to
   per-stroke rows for volume reasons — noted engineering decision.) */
CREATE TABLE IF NOT EXISTS force_curves (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  stroke_index INTEGER NOT NULL,
  samples_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_force_workout ON force_curves(workout_id, stroke_index);

/* ------------------------------ wellness (§12) ------------------------------ */
CREATE TABLE IF NOT EXISTS wellness_checkins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                   -- one row per user per calendar day
  sleep_hours REAL,
  sleep_quality INTEGER,                -- 1-5
  soreness_level INTEGER,               -- 1-5
  stress_level INTEGER,                 -- 1-5
  resting_notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, date)
);

/* ------------------------------ social (§4) ------------------------------ */
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at INTEGER NOT NULL,
  UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_feed (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                   -- 'workout_completed', 'pb', 'joined', ...
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_group ON group_feed(group_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  actioned_by TEXT,
  actioned_at INTEGER,
  action_note TEXT,
  created_at INTEGER NOT NULL
);

/* ------------------------------ leaderboards (§2.4/§7) ------------------------------ */
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','adhoc')),
  scope_id TEXT NOT NULL,
  workout_key TEXT NOT NULL,            -- assignment_id or ad hoc session key
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,           -- snapshot so history survives renames
  avg_split_s REAL,
  total_distance_m REAL,
  total_time_s REAL,
  finished INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope_type, scope_id, workout_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_lb_key ON leaderboard_entries(scope_type, scope_id, workout_key);

/* ------------------------ research data store (§5.2) ------------------------
   Kept in separate tables keyed by a pseudonymous research_id (HMAC of the
   user id under a dedicated secret) — never the account id. */
CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_workouts (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  study_tag TEXT NOT NULL,
  machine_type TEXT,
  workout_type TEXT,
  started_at INTEGER,
  total_distance_m REAL,
  total_time_s REAL,
  avg_split_s REAL,
  avg_stroke_rate REAL,
  avg_heart_rate REAL,
  avg_power_watts REAL,
  splits_json TEXT,
  birth_decade INTEGER,                 -- coarsened, not birth year
  weight_class TEXT,
  goal_type TEXT,
  contributed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rw_study ON research_workouts(study_tag, contributed_at);

CREATE TABLE IF NOT EXISTS research_wellness (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  study_tag TEXT NOT NULL,
  date TEXT NOT NULL,
  sleep_hours REAL,
  sleep_quality INTEGER,
  soreness_level INTEGER,
  stress_level INTEGER,
  contributed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rwell_study ON research_wellness(study_tag, contributed_at);

/* ------------------------------ admin (§3) ------------------------------ */
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,               -- workout_reminder|wellness_reminder|team_activity|group_activity|announcement
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at);

CREATE TABLE IF NOT EXISTS health_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- ble_error|sync_failure|client_error|api_error|crash
  detail TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_kind ON health_events(kind, created_at);

/* Security event log (§3 admin security tab): login attempts, verifications,
   password resets, role changes. Kept separate from the admin audit log —
   this one records what USERS do to accounts, that one what ADMINS do. */
CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- login_success|login_fail|signup|verify|verify_fail|password_reset|oauth_login
  email TEXT,
  user_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_events ON auth_events(kind, created_at);

/* ------------------------------ AI suggestions (§11) ------------------------------ */
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  rationale_tag TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('pending_coach','approved','delivered','overridden')),
  coach_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, date)
);
`);

// Lightweight additive migrations for databases created by earlier builds.
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// Heart-rate subsystem: per-workout HR time series + zone summary, and
// user-level max/resting HR for zone calculation.
ensureColumn('workouts', 'hr_series_json', 'hr_series_json TEXT');
ensureColumn('workouts', 'hr_zones_json', 'hr_zones_json TEXT');
ensureColumn('workouts', 'max_heart_rate', 'max_heart_rate REAL');
ensureColumn('workouts', 'min_heart_rate', 'min_heart_rate REAL');
ensureColumn('users', 'max_hr', 'max_hr INTEGER');
ensureColumn('users', 'resting_hr', 'resting_hr INTEGER');

// Role-based access control. Roles live in the database (not a client flag);
// the account matching config.ADMIN_EMAIL is promoted automatically below and
// on signup/verify, so the owner account always has the Admin role.
ensureColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'user'");
// Separate, explicit consent for demographic fields (birth decade, weight
// class) entering the research dataset — independent of the main research
// toggle so athletes can contribute workouts without demographics.
ensureColumn('users', 'research_share_demographics', 'research_share_demographics INTEGER NOT NULL DEFAULT 1');

// AI coach recommendations: generation source (llm | analysis_engine |
// guardrail), model confidence, and adherence tracking (followed is set when
// a workout lands on the recommendation's date).
ensureColumn('ai_suggestions', 'source', 'source TEXT');
ensureColumn('ai_suggestions', 'confidence', 'confidence TEXT');
ensureColumn('ai_suggestions', 'followed', 'followed INTEGER');
ensureColumn('ai_suggestions', 'coach_note', 'coach_note TEXT');

// Research dataset: full heart-rate detail (opt-in gated at write time).
ensureColumn('research_workouts', 'max_heart_rate', 'max_heart_rate REAL');
ensureColumn('research_workouts', 'min_heart_rate', 'min_heart_rate REAL');
ensureColumn('research_workouts', 'hr_zones_json', 'hr_zones_json TEXT');
ensureColumn('research_workouts', 'hr_drift_pct', 'hr_drift_pct REAL');
ensureColumn('research_workouts', 'hr_series_json', 'hr_series_json TEXT');
ensureColumn('research_workouts', 'equipment', 'equipment TEXT');

// The owner account is always an admin (evaluated at every boot so a fresh
// database — or an account created before this column existed — heals itself).
db.prepare("UPDATE users SET role = 'admin' WHERE email = ? AND role != 'admin'").run(config.ADMIN_EMAIL);

// Seed the default study tag (§5.2) once.
const study = db.prepare('SELECT id FROM studies WHERE tag = ?').get('baseline-2026');
if (!study) {
  db.prepare('INSERT INTO studies (id, tag, name, active, created_at) VALUES (?,?,?,1,?)')
    .run(crypto.randomUUID(), 'baseline-2026', 'RowPoint baseline training dataset', Math.floor(Date.now() / 1000));
}
