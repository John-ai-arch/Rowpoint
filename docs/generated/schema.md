# Database schema

_Generated from sqlite_master._

## ai_suggestions

```sql
CREATE TABLE ai_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  rationale_tag TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('pending_coach','approved','delivered','overridden')),
  coach_id TEXT,
  created_at INTEGER NOT NULL, source TEXT, confidence TEXT, followed INTEGER, coach_note TEXT, stale INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
)
```

## assignments

```sql
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
  coach_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_date TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
)
```

## athlete_state

```sql
CREATE TABLE athlete_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  variable TEXT NOT NULL,
  value REAL,
  uncertainty REAL,
  confidence REAL,
  provenance TEXT,
  model_version TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, category, variable)
)
```

## audit_log

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL
)
```

## auth_events

```sql
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- login_success|login_fail|signup|verify|verify_fail|password_reset|oauth_login
  email TEXT,
  user_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
)
```

## blocks

```sql
CREATE TABLE blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(blocker_id, blocked_id)
)
```

## computation_log

```sql
CREATE TABLE computation_log (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  inputs_hash TEXT,
  outputs_ref TEXT,
  outputs_hash TEXT,
  detail_json TEXT,
  versions_json TEXT,
  created_at INTEGER NOT NULL
)
```

## connections

```sql
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at INTEGER NOT NULL,
  UNIQUE(requester_id, addressee_id)
)
```

## email_outbox

```sql
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

## email_verifications

```sql
CREATE TABLE email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
)
```

## equipment

```sql
CREATE TABLE equipment (
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
)
```

## event_log

```sql
CREATE TABLE event_log (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
)
```

## experiments

```sql
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hypothesis_id TEXT REFERENCES hypotheses(id) ON DELETE SET NULL,
  template TEXT NOT NULL,
  protocol_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','completed','stopped','declined')),
  started_at INTEGER,
  ends_at INTEGER,
  outcome_json TEXT,
  stop_reason TEXT,
  created_at INTEGER NOT NULL
)
```

## feature_cache

```sql
CREATE TABLE feature_cache (
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  version TEXT NOT NULL,
  value REAL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (workout_id, feature)
)
```

## force_curves

```sql
CREATE TABLE force_curves (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  stroke_index INTEGER NOT NULL,
  samples_json TEXT NOT NULL
)
```

## group_challenges

```sql
CREATE TABLE group_challenges (
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
)
```

## group_feed

```sql
CREATE TABLE group_feed (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                   -- 'workout_completed', 'pb', 'joined', ...
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

## group_feed_comments

```sql
CREATE TABLE group_feed_comments (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES group_feed(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

## group_feed_likes

```sql
CREATE TABLE group_feed_likes (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES group_feed(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(feed_id, user_id)
)
```

## group_goals

```sql
CREATE TABLE group_goals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('meters','workouts','hours')),
  target REAL NOT NULL,
  starts_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
)
```

## group_join_requests

```sql
CREATE TABLE group_join_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, user_id)
)
```

## group_members

```sql
CREATE TABLE group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  UNIQUE(group_id, user_id)
)
```

## group_message_reactions

```sql
CREATE TABLE group_message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, user_id, emoji)
)
```

## group_messages

```sql
CREATE TABLE group_messages (
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
)
```

## group_week_history

```sql
CREATE TABLE group_week_history (
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
)
```

## groups

```sql
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
, description TEXT, photo_url TEXT, privacy TEXT NOT NULL DEFAULT 'private', invite_code TEXT, hide_members INTEGER NOT NULL DEFAULT 0, school TEXT, club TEXT, city TEXT, region TEXT, country TEXT)
```

## health_events

```sql
CREATE TABLE health_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- ble_error|sync_failure|client_error|api_error|crash
  detail TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
)
```

## hypotheses

```sql
CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  origin_model TEXT NOT NULL,
  alpha REAL NOT NULL DEFAULT 1,
  beta REAL NOT NULL DEFAULT 1,
  confidence REAL NOT NULL,
  prior_confidence REAL NOT NULL,
  populations TEXT NOT NULL DEFAULT 'general',
  validation_history_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

## inference_history

```sql
CREATE TABLE inference_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_id TEXT,
  stage TEXT NOT NULL,
  detail_json TEXT,
  model_version TEXT,
  created_at INTEGER NOT NULL
)
```

## jobs

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at INTEGER NOT NULL,
  checkpoint_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER
)
```

## knowledge_edges

```sql
CREATE TABLE knowledge_edges (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  to_node TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  confidence REAL,
  evidence_source TEXT,
  model_version TEXT,
  last_validated_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(from_node, to_node, relation)
)
```

## knowledge_nodes

```sql
CREATE TABLE knowledge_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, label)
)
```

## lab_notebook

```sql
CREATE TABLE lab_notebook (
  id TEXT PRIMARY KEY,
  entry_kind TEXT NOT NULL,
  ref_id TEXT,
  body_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

## leaderboard_entries

```sql
CREATE TABLE leaderboard_entries (
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
)
```

## meta

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

## model_performance

```sql
CREATE TABLE model_performance (
  id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  version TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
)
```

## model_transitions

```sql
CREATE TABLE model_transitions (
  id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  metrics_json TEXT,
  created_at INTEGER NOT NULL
)
```

## model_versions

```sql
CREATE TABLE model_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  first_seen_at INTEGER NOT NULL,
  UNIQUE(name, version)
)
```

## notifications

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,               -- workout_reminder|wellness_reminder|team_activity|group_activity|announcement
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
```

## optimization_runs

```sql
CREATE TABLE optimization_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','replan','benchmark')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  config_json TEXT NOT NULL,
  seed INTEGER,
  algorithm TEXT,
  versions_json TEXT,
  frontier_json TEXT,
  sensitivity_json TEXT,
  benchmark_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER
)
```

## organization_members

```sql
CREATE TABLE organization_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'athlete' CHECK (role IN ('admin','coach','athlete','researcher')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
)
```

## organization_teams

```sql
CREATE TABLE organization_teams (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  attached_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, team_id)
)
```

## organizations

```sql
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
)
```

## password_resets

```sql
CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
```

## predictions

```sql
CREATE TABLE predictions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  model_version TEXT,
  confidence REAL,
  created_at INTEGER NOT NULL
)
```

## race_simulations

```sql
CREATE TABLE race_simulations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  config_json TEXT NOT NULL,
  seed INTEGER,
  versions_json TEXT,
  summary_json TEXT,
  replay_json TEXT,
  race_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER
)
```

## races

```sql
CREATE TABLE races (
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
)
```

## reports

```sql
CREATE TABLE reports (
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
)
```

## research_analyses

```sql
CREATE TABLE research_analyses (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dataset_snapshot TEXT NOT NULL,
  config_json TEXT,
  seed INTEGER,
  versions_json TEXT,
  results_json TEXT,
  created_at INTEGER NOT NULL
)
```

## research_exclusions

```sql
CREATE TABLE research_exclusions (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  record_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

## research_features

```sql
CREATE TABLE research_features (
  research_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  feature TEXT NOT NULL,
  version TEXT NOT NULL,
  value REAL,
  quality REAL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (research_id, week_key, feature)
)
```

## research_findings

```sql
CREATE TABLE research_findings (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES research_analyses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
  reviewer_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
)
```

## research_snapshots

```sql
CREATE TABLE research_snapshots (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  study_tag TEXT NOT NULL,
  week_key TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  variables_json TEXT NOT NULL,
  sw_version TEXT,
  schema_version INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(research_id, study_tag, week_key)
)
```

## research_state_snapshots

```sql
CREATE TABLE research_state_snapshots (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  state_json TEXT NOT NULL,
  model_version TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(research_id, week_key)
)
```

## research_wellness

```sql
CREATE TABLE research_wellness (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  study_tag TEXT NOT NULL,
  date TEXT NOT NULL,
  sleep_hours REAL,
  sleep_quality INTEGER,
  soreness_level INTEGER,
  stress_level INTEGER,
  contributed_at INTEGER NOT NULL
)
```

## research_workouts

```sql
CREATE TABLE research_workouts (
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
, max_heart_rate REAL, min_heart_rate REAL, hr_zones_json TEXT, hr_drift_pct REAL, hr_series_json TEXT, equipment TEXT, sw_version TEXT, schema_version INTEGER, tz_offset_min INTEGER, device_type TEXT, sensor_source TEXT, firmware_version TEXT, measurement_confidence REAL, missing_flags TEXT, quality_flags TEXT, age_range TEXT, sex TEXT, height_band_cm INTEGER, years_rowing INTEGER, competition_level TEXT, club_type TEXT, training_environment TEXT, country TEXT)
```

## splits

```sql
CREATE TABLE splits (
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
)
```

## state_snapshots

```sql
CREATE TABLE state_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  trigger TEXT,
  state_json TEXT NOT NULL
)
```

## stroke_analyses

```sql
CREATE TABLE stroke_analyses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'erg' CHECK (kind IN ('erg','boat')),
  orientation TEXT,                     -- portrait|landscape (informational)
  recorded_on TEXT,
  duration_s REAL,
  fps REAL,
  video_ref TEXT,                       -- optional poster/data-ref; bytes live client-side/object-store
  marks_json TEXT NOT NULL DEFAULT '{}',-- { catches:[s], finishes:[s] }
  metrics_json TEXT,                    -- pipeline output (rate, ratio, consistency, …)
  observations_json TEXT,               -- [{ text, confidence, tSeconds }]
  pipeline_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

## stroke_annotations

```sql
CREATE TABLE stroke_annotations (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES stroke_analyses(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL DEFAULT 'athlete', -- athlete|coach
  t_seconds REAL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

## studies

```sql
CREATE TABLE studies (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
)
```

## team_members

```sql
CREATE TABLE team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  UNIQUE(team_id, user_id)
)
```

## teams

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  coach_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
)
```

## training_plans

```sql
CREATE TABLE training_plans (
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
)
```

## user_achievements

```sql
CREATE TABLE user_achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge TEXT NOT NULL,                  -- e.g. first_workout, meters_1m, streak_30
  label TEXT NOT NULL,
  context_json TEXT,
  achieved_at INTEGER NOT NULL,
  UNIQUE(user_id, badge)
)
```

## users

```sql
CREATE TABLE users (
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
, max_hr INTEGER, resting_hr INTEGER, role TEXT NOT NULL DEFAULT 'user', research_share_demographics INTEGER NOT NULL DEFAULT 1, token_version INTEGER NOT NULL DEFAULT 0, goal_weekly_meters INTEGER, height_cm REAL, experience_level TEXT, goal_2k_seconds REAL, preferred_race_distance TEXT, available_days INTEGER, session_minutes INTEGER, preferred_workout_types TEXT, injury_history TEXT, club TEXT, boat_class TEXT, sex TEXT, years_rowing INTEGER, competition_level TEXT, club_type TEXT, training_environment TEXT, country TEXT, region TEXT, research_admin INTEGER NOT NULL DEFAULT 0, experiment_consent TEXT NOT NULL DEFAULT 'none', experiment_consent_at INTEGER)
```

## wellness_checkins

```sql
CREATE TABLE wellness_checkins (
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
)
```

## workout_plans

```sql
CREATE TABLE workout_plans (
  id TEXT PRIMARY KEY,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  machine_type TEXT NOT NULL DEFAULT 'rower',
  plan_json TEXT NOT NULL,              -- {type:'time'|'distance'|'intervals', ...}
  is_daily_suggestion INTEGER NOT NULL DEFAULT 0,
  suggested_date TEXT,
  created_at INTEGER NOT NULL
)
```

## workouts

```sql
CREATE TABLE workouts (
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
, hr_series_json TEXT, hr_zones_json TEXT, max_heart_rate REAL, min_heart_rate REAL, user_note TEXT)
```

## Indexes & triggers

```sql
CREATE TRIGGER computation_log_immutable
  BEFORE UPDATE ON computation_log
  BEGIN SELECT RAISE(ABORT, 'computation_log is append-only'); END;
CREATE INDEX idx_achievements_user ON user_achievements(user_id);
CREATE INDEX idx_assignments_team ON assignments(team_id, scheduled_date);
CREATE INDEX idx_auth_events ON auth_events(kind, created_at);
CREATE INDEX idx_auth_events_email ON auth_events(email, created_at);
CREATE INDEX idx_computation_log ON computation_log(kind, created_at);
CREATE INDEX idx_computation_log_user ON computation_log(user_id, created_at);
CREATE INDEX idx_connections_addressee ON connections(addressee_id, status);
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);
CREATE INDEX idx_equipment_user ON equipment(user_id, retired);
CREATE INDEX idx_event_log ON event_log(type, created_at);
CREATE INDEX idx_experiments_user ON experiments(user_id, status);
CREATE INDEX idx_feed_comments ON group_feed_comments(feed_id, created_at);
CREATE INDEX idx_feed_group ON group_feed(group_id, created_at);
CREATE INDEX idx_force_workout ON force_curves(workout_id, stroke_index);
CREATE INDEX idx_group_challenges ON group_challenges(group_id, status);
CREATE INDEX idx_group_members_user ON group_members(user_id);
CREATE INDEX idx_group_messages ON group_messages(group_id, created_at);
CREATE UNIQUE INDEX idx_groups_invite ON groups(invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX idx_health_kind ON health_events(kind, created_at);
CREATE INDEX idx_inference_history ON inference_history(user_id, created_at);
CREATE INDEX idx_jobs_due ON jobs(status, run_at, priority);
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at);
CREATE INDEX idx_lab_notebook ON lab_notebook(entry_kind, created_at);
CREATE INDEX idx_lb_key ON leaderboard_entries(scope_type, scope_id, workout_key);
CREATE INDEX idx_model_performance ON model_performance(model_name, metric, created_at);
CREATE INDEX idx_notif_user ON notifications(user_id, read, created_at);
CREATE INDEX idx_notifications_created ON notifications(created_at);
CREATE INDEX idx_optimization_runs ON optimization_runs(user_id, created_at);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, used);
CREATE INDEX idx_predictions ON predictions(user_id, kind, created_at);
CREATE INDEX idx_race_simulations ON race_simulations(user_id, created_at);
CREATE INDEX idx_races_user ON races(user_id, race_date);
CREATE INDEX idx_research_analyses ON research_analyses(kind, created_at);
CREATE INDEX idx_research_exclusions ON research_exclusions(analysis_id);
CREATE INDEX idx_research_features ON research_features(feature, week_key);
CREATE INDEX idx_research_findings ON research_findings(status, created_at);
CREATE INDEX idx_research_snapshots ON research_snapshots(study_tag, week_key);
CREATE INDEX idx_research_snapshots_rid ON research_snapshots(research_id);
CREATE INDEX idx_research_state ON research_state_snapshots(week_key);
CREATE INDEX idx_rw_study ON research_workouts(study_tag, contributed_at);
CREATE INDEX idx_rwell_study ON research_wellness(study_tag, contributed_at);
CREATE INDEX idx_splits_workout ON splits(workout_id, split_index);
CREATE INDEX idx_state_snapshots ON state_snapshots(user_id, created_at);
CREATE INDEX idx_stroke_annotations ON stroke_annotations(analysis_id, t_seconds);
CREATE INDEX idx_stroke_user ON stroke_analyses(user_id, created_at);
CREATE INDEX idx_training_plans_user ON training_plans(user_id, status);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_workouts_assignment ON workouts(assignment_id);
CREATE INDEX idx_workouts_user ON workouts(user_id, started_at);
```

---
_Generated 2026-07-11T07:19:18.160Z by rpos.docs@1.0._
