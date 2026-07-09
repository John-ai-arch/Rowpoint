// Database layer. Uses Node's built-in SQLite (node:sqlite).
//
// Engineering note: the spec suggests Postgres for production (§7). This
// implementation uses SQLite so the app is fully self-contained and testable;
// the schema below is deliberately plain SQL (TEXT ids, INTEGER unix
// timestamps, no SQLite-specific types) so it ports to Postgres directly.
// All access goes through prepared statements — no string interpolation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// Persistence guard: remember whether the database file existed BEFORE this
// boot. A production process that keeps finding no database is the classic
// ephemeral-filesystem deployment bug (every redeploy silently wipes all
// accounts, so "users can't log back in" and "the same email can sign up
// twice" — the data is simply gone). Detected and shouted about below.
const dbExistedAtBoot = fs.existsSync(config.dbFile);

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

/* Self-service password recovery. The reset code is stored HASHED (never in
   the clear), single-use, short-lived, and bumps token_version on use so a
   reset also signs the account out everywhere. */
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, used);

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
// AI Training Journal: the athlete's own free-text note per workout (the AI
// coaching summary already lives in ai_feedback_json). Searchable together.
ensureColumn('workouts', 'user_note', 'user_note TEXT');

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
// Session-invalidation counter. Every issued token carries the version it was
// minted under; bumping this (logout, password reset) invalidates all of a
// user's existing tokens server-side without needing per-token state. Tokens
// with no version (pre-migration) are treated as version 0, so existing
// sessions keep working across the upgrade.
ensureColumn('users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
// Separate, explicit consent for demographic fields (birth decade, weight
// class) entering the research dataset — independent of the main research
// toggle so athletes can contribute workouts without demographics.
ensureColumn('users', 'research_share_demographics', 'research_share_demographics INTEGER NOT NULL DEFAULT 1');
// Personal weekly-distance goal (meters) for the Progress hub — reuses the
// existing per-user goal fields (goal_weekly_sessions/minutes) rather than a
// new goals subsystem.
ensureColumn('users', 'goal_weekly_meters', 'goal_weekly_meters INTEGER');

// Athlete profile (Adaptive Training Intelligence). Extends the existing goal
// fields rather than introducing a parallel profile table — the coach + plan
// generator read these alongside best_2k_seconds / goal_* already present.
ensureColumn('users', 'height_cm', 'height_cm REAL');
ensureColumn('users', 'experience_level', 'experience_level TEXT');            // beginner|intermediate|advanced|elite
ensureColumn('users', 'goal_2k_seconds', 'goal_2k_seconds REAL');             // TARGET 2k (best_2k_seconds is current)
ensureColumn('users', 'preferred_race_distance', 'preferred_race_distance TEXT'); // 2000m|5000m|6000m|head|marathon
ensureColumn('users', 'available_days', 'available_days INTEGER');            // training days/week available
ensureColumn('users', 'session_minutes', 'session_minutes INTEGER');         // typical minutes available per session
ensureColumn('users', 'preferred_workout_types', 'preferred_workout_types TEXT'); // JSON array
ensureColumn('users', 'injury_history', 'injury_history TEXT');
ensureColumn('users', 'club', 'club TEXT');
ensureColumn('users', 'boat_class', 'boat_class TEXT');

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

/* -------------------- groups (expanded social feature) --------------------
   Groups grow from "shared feed" into a full social layer: profiles &
   discovery metadata, privacy modes with invite codes and join requests,
   member roles, chat, challenges, collaborative goals, feed reactions &
   comments, preserved weekly leaderboard history, and user achievements. */
ensureColumn('groups', 'description', 'description TEXT');
ensureColumn('groups', 'photo_url', 'photo_url TEXT');
ensureColumn('groups', 'privacy', "privacy TEXT NOT NULL DEFAULT 'private'"); // public|private
ensureColumn('groups', 'invite_code', 'invite_code TEXT');
ensureColumn('groups', 'hide_members', 'hide_members INTEGER NOT NULL DEFAULT 0');
ensureColumn('groups', 'school', 'school TEXT');
ensureColumn('groups', 'club', 'club TEXT');
ensureColumn('groups', 'city', 'city TEXT');
ensureColumn('groups', 'region', 'region TEXT');
ensureColumn('groups', 'country', 'country TEXT');
ensureColumn('group_members', 'role', "role TEXT NOT NULL DEFAULT 'member'"); // owner|admin|moderator|member

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_invite ON groups(invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS group_join_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','announcement','image','workout')),
  body TEXT,
  image_data TEXT,                      -- small data-URL images only (capped at write)
  workout_id TEXT,                      -- shared-workout messages
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, created_at);

CREATE TABLE IF NOT EXISTS group_message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS group_challenges (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  metric TEXT NOT NULL,                 -- meters|workouts|avg_split|streak|team_meters|custom
  target REAL,                          -- team_meters goal, or null
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished')),
  winners_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_challenges ON group_challenges(group_id, status);

CREATE TABLE IF NOT EXISTS group_goals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('meters','workouts','hours')),
  target REAL NOT NULL,
  starts_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_feed_likes (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES group_feed(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(feed_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_feed_comments (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES group_feed(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_comments ON group_feed_comments(feed_id, created_at);

/* Preserved weekly leaderboard history: one row per member per completed
   week, written when the week closes (lazily, on first group view after
   Monday). Also the source of Weekly Champion awards. */
CREATE TABLE IF NOT EXISTS group_week_history (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  week_key TEXT NOT NULL,               -- ISO week, e.g. 2026-W27
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  meters REAL NOT NULL,
  workouts INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, week_key, user_id)
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge TEXT NOT NULL,                  -- e.g. first_workout, meters_1m, streak_30
  label TEXT NOT NULL,
  context_json TEXT,
  achieved_at INTEGER NOT NULL,
  UNIQUE(user_id, badge)
);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON user_achievements(user_id);
`);

/* -------------------- performance indexes --------------------
   Added after the tables/migrations above so they cover columns introduced by
   later builds. All are IF NOT EXISTS and match real query shapes: admin
   security lookups by email, and the "incoming connection requests" query that
   filters by addressee + status. */
db.exec(`
CREATE INDEX IF NOT EXISTS idx_auth_events_email ON auth_events(email, created_at);
CREATE INDEX IF NOT EXISTS idx_connections_addressee ON connections(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
`);

// Backfill for groups created before the expansion: creators become owners
// and every group gets an invite code.
db.prepare(`UPDATE group_members SET role = 'owner'
            WHERE role = 'member' AND EXISTS (
              SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.creator_id = group_members.user_id)`).run();
for (const g of db.prepare('SELECT id FROM groups WHERE invite_code IS NULL').all()) {
  const code = crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8);
  db.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').run(`G${code}`, g.id);
}

/* -------------------- adaptive training plans --------------------
   A periodized, multi-week plan generated from the athlete's goal race + date
   and current fitness. The week-by-week structure lives in weeks_json (phase,
   target volume, session mix, prescriptions); adaptations (load changes driven
   by real training) are appended to adaptations_json with their reasoning so
   the athlete always sees WHY the plan changed. One active plan per user. */
db.exec(`
CREATE TABLE IF NOT EXISTS training_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal_event TEXT,
  goal_date TEXT,
  goal_2k_seconds REAL,
  target_weekly_meters INTEGER,
  total_weeks INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  weeks_json TEXT NOT NULL,
  adaptations_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','completed')),
  coach_id TEXT,
  coach_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  adapted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_training_plans_user ON training_plans(user_id, status);
`);

/* -------------------- season planner (vision #2) --------------------
   A rowing season = a set of target races with dates + priorities. The
   training-plan generator already targets one race; this lets the athlete lay
   out the whole season and build/reorient the plan toward any race. */
db.exec(`
CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  race_date TEXT NOT NULL,
  distance TEXT,                        -- 2000m|5000m|6000m|head|marathon|other
  priority TEXT NOT NULL DEFAULT 'B' CHECK (priority IN ('A','B','C')),
  goal_time_s REAL,
  location TEXT,
  notes TEXT,
  result_time_s REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_races_user ON races(user_id, race_date);
`);

/* -------------------- equipment management (vision #8) --------------------
   The athlete's gear: ergs, HR monitors, boats, oars, shoes, etc., with
   maintenance + battery-reminder notes. Per-erg usage totals are derived from
   workouts.machine_id, so tagging equipment with a machine id surfaces "meters
   on this erg" without any duplicate storage. */
db.exec(`
CREATE TABLE IF NOT EXISTS equipment (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                   -- erg|hrm|boat|oars|shoes|other
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  serial TEXT,
  machine_id TEXT,                      -- optional link to a BLE peripheral (per-erg totals)
  purchased_on TEXT,
  battery_changed_on TEXT,
  maintenance_note TEXT,
  retired INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_user ON equipment(user_id, retired);
`);

/* -------------------- database identity & boot tracking --------------------
   One row of instance metadata lets the app (and the admin System tab) prove
   whether storage is actually persistent: the instance id and created_at
   survive restarts only if the data directory does. A brand-new database on
   a non-first production boot is the smoking gun for ephemeral storage. */
db.exec(`CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);
function metaGet(key) { return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
function metaSet(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
if (!metaGet('instance_id')) {
  metaSet('instance_id', crypto.randomUUID());
  metaSet('db_created_at', Math.floor(Date.now() / 1000));
}
metaSet('boot_count', Number(metaGet('boot_count') || 0) + 1);
metaSet('last_boot_at', Math.floor(Date.now() / 1000));

/* -------------------- schema versioning --------------------
   The schema is built and evolved idempotently: every table is CREATE ...
   IF NOT EXISTS and every later column/index goes through ensureColumn() or
   CREATE INDEX IF NOT EXISTS, so bringing an old database up to date is just
   "run this file". SCHEMA_VERSION is recorded for observability and as the
   gate for any *destructive* future migration (which must branch on the stored
   version rather than run unconditionally). Bump it whenever the schema
   changes. */
const SCHEMA_VERSION = 6;
const priorSchema = Number(metaGet('schema_version') || 0);
if (priorSchema !== SCHEMA_VERSION) metaSet('schema_version', SCHEMA_VERSION);
export const schemaInfo = { version: SCHEMA_VERSION, previousVersion: priorSchema };

/**
 * Run a set of synchronous DB writes atomically. node:sqlite has no
 * better-sqlite3-style db.transaction(), so we drive BEGIN/COMMIT/ROLLBACK
 * directly. The callback MUST be synchronous (no awaits) — a partial failure
 * rolls the whole thing back so a workout never lands without its splits.
 */
export function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Persistence facts for boot-time warnings and the admin System tab. */
export function dbPersistenceInfo() {
  return {
    dataDir: config.dataDir,
    dbFile: config.dbFile,
    dataDirConfigured: !!process.env.ROWPOINT_DATA_DIR,
    dbExistedAtBoot,
    instanceId: metaGet('instance_id'),
    dbCreatedAt: Number(metaGet('db_created_at')),
    bootCount: Number(metaGet('boot_count')),
    tokenSecretFromEnv: !!process.env.ROWPOINT_TOKEN_SECRET,
    userCount: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    schemaVersion: SCHEMA_VERSION,
  };
}

// Seed the default study tag (§5.2) once.
const study = db.prepare('SELECT id FROM studies WHERE tag = ?').get('baseline-2026');
if (!study) {
  db.prepare('INSERT INTO studies (id, tag, name, active, created_at) VALUES (?,?,?,1,?)')
    .run(crypto.randomUUID(), 'baseline-2026', 'RowPoint baseline training dataset', Math.floor(Date.now() / 1000));
}
