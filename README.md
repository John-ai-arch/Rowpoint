# RowPoint

A full web implementation of the RowPoint specification: BLE erg connectivity
(Concept2 PM5 + FTMS via Web Bluetooth, plus a built-in simulator), a
universal Bluetooth heart-rate-monitor subsystem (any SIG-standard strap:
Polar/Garmin/Wahoo/Coospo/…, with zones, auto-reconnect, battery, history
analysis), coach/rower accounts with team codes, live simultaneous team view
and leaderboards, an opt-out research data program, an LLM-powered AI coach
that analyzes each athlete's complete training history (volume, zone
distribution, HR trends, pace progression, recovery, adherence) to generate
personalized daily recommendations, daily wellness check-ins, a friend/social
layer, a full **Groups** system (dashboards, ~19 automatic leaderboards,
challenges, collaborative goals, live chat, achievement badges, roles,
public/private discovery, and analytics), and role-based admin access with a
comprehensive dashboard. Installable as an app (PWA); see APPSTORE.md for the
iOS App Store path and DEPLOY.md for hosting.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

**Email verification is mandatory** — there is no way into the app with an
unverified address (no token is even issued until the code is confirmed).
Locally, with no mail provider configured, the app runs in dev-mail mode and
shows the 6-digit code right on the verification screen. On a real deployment
set `RESEND_API_KEY` and codes arrive by email (see DEPLOY.md).

Sign up as a **coach** to get a team code instantly; sign up as a **rower**
(optionally with that code) in a second browser/incognito window. Admin access
is **role-based** (RBAC, re-checked server-side on every request); the owner
account `lambert.venema2027@gmail.com` is assigned the Admin role
automatically the moment it is created and verified, and can grant/revoke the
role for other accounts from the admin dashboard.

No hardware handy? The Row screen has an erg **Simulator** with pacing
profiles ("fly & die" demos the started-too-hard AI feedback), and the Heart
Rate page has a **simulated monitor**. With real hardware, use Chrome/Edge
over HTTPS or localhost: **Connect erg** scans for the Concept2 discovery
UUID and FTMS 0x1826 simultaneously; **Heart Rate → Connect** lists only
devices advertising the standard Heart Rate Service. Sign-in provider
buttons (Google/Apple) only render when configured server-side
(`GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID`), so an unconfigured provider can
never show an error.

## Tests

```bash
npm test           # unit + API + realtime (node:test)
npm run test:e2e   # Playwright browser flows (starts its own server)
```

Coverage highlights: the training-analysis engine (zone classification from
real pace/HR data, distribution, recovery spacing, risk flags), the AI coach's
guardrails (coach assignment always wins; overtraining always yields rest) and
its property that different histories produce different recommendations,
pacing classifier, CSAFE framing, verification gating, research opt-out
write-time semantics + HR-retention consent, RBAC role grant/revoke, admin
password reset, AI adherence tracking, security event logging, admin access
control + audit logging, email-search rate limiting, live metric fan-out and
presence/staleness over WebSocket, and full coach → rower → live session →
leaderboard → AI feedback journeys in a real browser.

## Configuration (env vars)

| Var | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `ROWPOINT_DATA_DIR` | Data directory (SQLite DB + generated secrets) |
| `ANTHROPIC_API_KEY` | Enables the LLM coach: Claude reasons over each athlete's full training analysis to write the daily recommendation and post-workout feedback. Without it, the analysis-engine fallback generates recommendations from the same data — the app is fully functional either way. |
| `ANTHROPIC_MODEL` | Default `claude-opus-4-8` |
| `GOOGLE_CLIENT_ID` | Enables Google sign-in (ID-token verification) |
| `APPLE_CLIENT_ID` | Placeholder for Sign in with Apple (needs Apple Developer credentials) |
| `NODE_ENV=production` | Disables the dev outbox endpoint; enables HSTS |
| `ROWPOINT_TOKEN_SECRET` | Session-signing secret. Set it as an env var so sessions survive a disk migration (otherwise persisted to the data disk). |
| `ROWPOINT_RESEARCH_SECRET` | Secret for deriving pseudonymous research IDs. Set as an env var for durability. |

## Production hardening

- **Cookie sessions + CSRF**: the browser authenticates with an **HttpOnly,
  Secure, SameSite=Lax** `rp_session` cookie (script can't read it, so an XSS
  payload can't steal the token — unlike the old localStorage token). A readable
  `rp_csrf` cookie backs a **stateless double-submit CSRF** check on every
  cookie-authenticated mutating request (`server/cookies.js`). Programmatic
  clients keep using `Authorization: Bearer` and are CSRF-exempt by construction
  (no ambient cookie). Legacy Bearer/localStorage sessions are transparently
  migrated to a cookie on the first `/auth/me`, so the cutover forces no one to
  re-log-in. The WebSocket authenticates from the same cookie on its handshake.
- **Session security**: HMAC-signed stateless tokens carry a per-user
  `token_version`; `POST /api/auth/logout`, a self-service password reset, and an
  admin password reset all bump it, invalidating every previously-issued token
  server-side (a leaked token can't outlive a logout or reset). Missing versions
  default to 0 so the upgrade is backward-compatible.
- **Self-service password recovery**: `POST /api/auth/forgot-password` →
  `POST /api/auth/reset-password`. Reset codes are single-use, hashed at rest
  (keyed HMAC), expire in an hour, and are IP-rate-limited; responses never
  reveal whether an account exists (anti-enumeration); a successful reset bumps
  `token_version` (signs the account out everywhere) and is audit-logged.
- **Rate limiting**: sliding-window limits on login, signup, email
  verification, resend, **forgot/reset password**, and the **LLM refresh** path
  (`server/ratelimit.js`), plus the existing email-search anti-enumeration limit.
- **Crash reporting**: uncaught browser errors and unhandled promise rejections
  are captured (sanitized, deduplicated, capped) to `health_events` and surface
  as client-crash trends in the admin dashboard alongside API/BLE/sync failures.
- **Schema versioning**: the schema is built and evolved idempotently
  (`CREATE ... IF NOT EXISTS` + additive `ensureColumn`); a recorded
  `schema_version` in the `meta` table gates any future destructive migration
  and is surfaced on the admin System tab.
- **Security headers**: a tuned `Content-Security-Policy` (same-origin;
  inline styles only — no inline scripts; Google Identity + Fonts allowed;
  `object-src 'none'`, `frame-ancestors 'none'`), `Permissions-Policy`
  (`bluetooth=(self)`, everything else denied), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, and
  `Strict-Transport-Security` in production.
- **Data integrity**: each workout sync commits the workout, its splits, and
  force curves in a single transaction (`inTransaction()` in `db.js`) — a
  mid-write failure rolls back cleanly, never leaving a workout without splits.
- **Observability**: `GET /api/healthz` is an unauthenticated readiness probe
  that verifies the process **and** a live DB query (503 if the DB is down);
  request latency (avg/max/slow-count) feeds the admin System tab; boot-time
  warnings flag an ephemeral data directory before it silently wipes accounts.

## Engineering decisions (where the spec left room)

- **Web-first build** (per your direction): the client is a dependency-free ES-module SPA served by the API server. All BLE logic sits behind the spec's `ErgDataSource` abstraction (`public/js/ble/ergSource.js`), so the future native apps can port the adapters 1:1 (CoreBluetooth/BluetoothGatt in place of Web Bluetooth).
- **SQLite instead of Postgres**: `node:sqlite` keeps the system fully self-contained and testable; the schema is plain portable SQL (TEXT ids, unix-int timestamps) designed to move to Postgres unchanged. All queries are prepared statements.
- **Auth**: scrypt password hashing, HMAC-signed stateless tokens, and STRICT email verification — signup and login issue no session until the code is confirmed (product decision superseding §2.1's local-use allowance). Google sign-in uses the real Google Identity Services flow when `GOOGLE_CLIENT_ID` is set and verifies ID tokens server-side. **Sign in with Apple is fully implemented**: the client uses Apple's official Sign-In JS SDK and the server verifies the Apple ID-token JWT against Apple's JWKS (RS256 signature, issuer, audience, expiry) with the same account-linking/first-run-profile logic as Google — it activates the moment `APPLE_CLIENT_ID` (your Services ID) is set, and returns a clear 501 until then. Both providers' CSP domains are allowlisted.
- **Heart-rate subsystem**: `public/js/ble/sensors.js` is the platform abstraction (`HeartRateManager` + monitor classes) — full SIG HRM packet decoding (8/16-bit BPM, RR intervals, energy expended), battery + device-info services, known-device memory (rename/forget/prefer), exponential-backoff auto-reconnect at launch/workout-start/signal-loss, 5-second rolling smoothing, and configurable zones (custom max HR or 220−age). Per-workout HR time series are stored server-side (`hr_series_json`) with zone-seconds and HR-drift summaries computed at sync time. Web Bluetooth's chooser is the scan surface (filtered to HR-service devices only); native builds implement true scan lists on the same interface.
- **Adaptive Training Intelligence**: `server/ai/periodization.js` turns a goal race + date into a full **periodized multi-week plan** (reverse-periodized Base → Build → Threshold → Peak → Taper → Race, with per-week volume ramps, deload weeks, and concrete pace-targeted session prescriptions derived from the athlete's 2k split). `server/training.js` (`/api/training/*`) exposes the athlete profile, plan generation, one-tap **adaptation** (re-tunes upcoming weeks from the same training analysis the daily coach uses — reducing load when behind or fatigued, forcing recovery on overtraining signals, progressing when fitness rises — every change carrying an explicit scientific reason), and deterministic **weekly/monthly coaching reviews** (volume vs target, HR/efficiency trends, strengths, focus, estimated fitness). Coaches see and annotate each athlete's plan. The `Training Plan` page renders the phase timeline, the current week's prescriptions with the physiological rationale for each, the weekly review, and the adaptation history — fully bilingual (EN/DE).
- **AI coach**: `server/ai/trainingAnalysis.js` deterministically distills the athlete's complete history — weekly/monthly volume, UT2→sprint zone distribution (pace-vs-2k bands with HR fallback), structure mix, HR drift and aerobic-efficiency trends, pace progression, recovery spacing, PRs, wellness, adherence to prior recommendations, and risk flags. `server/ai/coach.js` sends that analysis to Claude (structured JSON output: workout, explanation, why-appropriate, physiological target, expected adaptations, recovery advice, confidence, alternative), validates the returned plan against the same monitor limits the builder uses, and enforces two code-level guardrails regardless of model output: a coach assignment for today always wins, and detected overtraining always yields rest. Without an API key, an analysis-engine fallback reasons over the same data (labeled distinctly in the UI — engine output is never presented as LLM output). Adherence is tracked per recommendation and rolled up in admin AI analytics.
- **Admin**: role-based access control (`users.role`, re-read server-side on **every** admin request via `adminRequired`); the owner email in `server/config.js` is auto-assigned the Admin role at creation/verification and can never be demoted or locked out. The dashboard covers user/workout/research/AI statistics, user management (roles, password reset, research grant/revoke, workout history, feedback), system health (uptime, DB, storage, API usage), security (auth event log, failed logins), data management (CSV/JSON/SQL exports, DB backup), moderation, and broadcast — and every admin action writes to `audit_log`.
- **Research opt-out policy** (§5.1 asked us to pick one and state it): past contributions are **retained** on opt-out, future contribution stops immediately (checked at write time); **account deletion removes research rows entirely**. This is stated verbatim in the signup consent screen and Settings. Research rows are keyed by an HMAC-derived pseudonymous ID under a secret separate from the token secret, with coarsened demographics (birth decade, not year).
- **Study tagging**: one row per active study tag (row-per-study rather than tables-per-study), so the admin dashboard filters per experiment as §5.2 suggests.
- **Coach vs. AI**: suggestions are delivered to rowers immediately but surface on the coach's team page the same day with approve/override; an override replaces the AI text with the coach's note. A coach assignment scheduled today always preempts any suggestion (§11.5).
- **Force curves**: stored one row per stroke with a JSON sample array server-side (the spec's per-sample client table would multiply row counts ~30×); rendered live during rowing and scrub-able per stroke in workout detail.
- **Units**: pace is always /500m (universal erg convention in both unit systems); long distances and body weight follow the metric/imperial toggle.
- **Splits**: computed client-side every 500 m from the live stream; the trailing partial split is kept if >25 m.
- **CSAFE encoder** (`public/js/ble/csafe.js`): standard 0xF1/0xF2 framing, XOR checksum, 0xF0–0xF3 byte stuffing, PM-proprietary command wrapping for time/distance/variable-interval workouts, ≤20-byte writes for default MTU. Client-side validation runs first; the machine's response is parsed and its rejection surfaced verbatim (§1.3). Verify command IDs against the current Concept2 CSAFE spec revision before shipping against real fleet firmware.
- **PM5 parsing offsets** are implemented per the published interface definition (general status / additional status 1–2 / stroke data / force curve reassembly). Test against the raralabs pm5-emulator or real hardware before release; the built-in simulator covers all app logic above the adapter layer.
- **Not in this phase** (next milestones from §13): watchOS HR source, Strava/Concept2-Logbook/TrainingPeaks/HealthKit integrations (the `ExternalIntegration` shape is trivial to add server-side now that OAuth token storage patterns exist), push notifications (in-app notification center is built), and the store-submission checklist items that only apply to native binaries.

## Before a real launch (not code)

The §5.1 consent language, retention policy, GDPR posture, and any IRB
applicability need review by qualified counsel — the toggle, pipeline, and
pseudonymization are engineered, but the legal/ethical framework requires
human sign-off. Same for store privacy manifests/data-safety labels when the
native apps ship.

## Layout

```
server/            Express API, SQLite schema, auth (RBAC), teams, workouts,
                   wellness, social, groups, research pipeline, admin, metrics,
                   WebSocket hub
server/kernel/     computational kernel: event bus, SQLite-backed job system
                   (worker-thread offload), versioned model registry, Estimate
                   type (value+confidence+provenance), dependency graph,
                   seeded RNG, shared statistics
server/twin/       Digital Twin engine: latent athlete-state model (12
                   categories), 12-stage inference pipeline (validate → clean →
                   extract → infer → update → predict → snapshot), feature-
                   extractor plugins, own-data /api/twin
server/ai/         training analysis engine · LLM coach (+ analysis-engine
                   fallback) · pacing classifier · plan validation
server/groups.js   group dashboards, leaderboards, challenges, goals, chat,
                   achievements, discovery, analytics + workout-sync hooks
public/            SPA (no build step): pages, BLE adapters, charts, offline queue
tests/             unit + API + realtime + kernel + twin (node:test), e2e/ (Playwright)
```
