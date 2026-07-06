# RowPoint

A full web implementation of the RowPoint specification: BLE erg connectivity
(Concept2 PM5 + FTMS via Web Bluetooth, plus a built-in simulator), a
universal Bluetooth heart-rate-monitor subsystem (any SIG-standard strap:
Polar/Garmin/Wahoo/Coospo/…, with zones, auto-reconnect, battery, history
analysis), coach/rower accounts with team codes, live simultaneous team view
and leaderboards, an opt-out research data program, a deterministic-rules AI
training assistant with LLM phrasing, daily wellness check-ins, a social
layer, and a single hard-coded admin account. Installable as an app (PWA);
see APPSTORE.md for the iOS App Store path and DEPLOY.md for hosting.

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
(optionally with that code) in a second browser/incognito window. The **admin
dashboard** unlocks only for a verified account with the email
`lambert.venema2027@gmail.com` — enforced server-side on every request.

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

Coverage highlights: the spec's §11.2 worked example (6 coach sessions +
twice-a-day goal → 60–90 min low-intensity steady state), pacing classifier,
CSAFE framing, verification gating, research opt-out write-time semantics,
admin access control + audit logging, email-search rate limiting, live
metric fan-out and presence/staleness over WebSocket, and full coach → rower →
live session → leaderboard → AI feedback journeys in a real browser.

## Configuration (env vars)

| Var | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `ROWPOINT_DATA_DIR` | Data directory (SQLite DB + generated secrets) |
| `ANTHROPIC_API_KEY` | Enables LLM phrasing for suggestions/feedback (§11.3). Without it, deterministic templates are used — the app is fully functional either way. |
| `ANTHROPIC_MODEL` | Default `claude-sonnet-4-6` |
| `GOOGLE_CLIENT_ID` | Enables Google sign-in (ID-token verification) |
| `APPLE_CLIENT_ID` | Placeholder for Sign in with Apple (needs Apple Developer credentials) |
| `NODE_ENV=production` | Disables the dev outbox endpoint |

## Engineering decisions (where the spec left room)

- **Web-first build** (per your direction): the client is a dependency-free ES-module SPA served by the API server. All BLE logic sits behind the spec's `ErgDataSource` abstraction (`public/js/ble/ergSource.js`), so the future native apps can port the adapters 1:1 (CoreBluetooth/BluetoothGatt in place of Web Bluetooth).
- **SQLite instead of Postgres**: `node:sqlite` keeps the system fully self-contained and testable; the schema is plain portable SQL (TEXT ids, unix-int timestamps) designed to move to Postgres unchanged. All queries are prepared statements.
- **Auth**: scrypt password hashing, HMAC-signed stateless tokens, and STRICT email verification — signup and login issue no session until the code is confirmed (product decision superseding §2.1's local-use allowance). Google sign-in uses the real Google Identity Services flow when `GOOGLE_CLIENT_ID` is set and verifies ID tokens server-side; Apple returns a clear 501 until Apple Developer credentials exist (endpoints + account-linking in place, per §10.1's "build both at once").
- **Heart-rate subsystem**: `public/js/ble/sensors.js` is the platform abstraction (`HeartRateManager` + monitor classes) — full SIG HRM packet decoding (8/16-bit BPM, RR intervals, energy expended), battery + device-info services, known-device memory (rename/forget/prefer), exponential-backoff auto-reconnect at launch/workout-start/signal-loss, 5-second rolling smoothing, and configurable zones (custom max HR or 220−age). Per-workout HR time series are stored server-side (`hr_series_json`) with zone-seconds and HR-drift summaries computed at sync time. Web Bluetooth's chooser is the scan surface (filtered to HR-service devices only); native builds implement true scan lists on the same interface.
- **Admin**: the owner email is a hard-coded constant in `server/config.js`, re-checked server-side on **every** admin request (`adminRequired`); there is no `is_admin` column anywhere. All six §3.2 capabilities are built, and every admin action writes to `audit_log`.
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
server/            Express API, SQLite schema, auth, teams, workouts,
                   wellness, social, research pipeline, admin, WebSocket hub
server/ai/         rules engine · pacing classifier · plan validation · LLM phrasing
public/            SPA (no build step): pages, BLE adapters, charts, offline queue
tests/             unit + API + realtime (node:test), e2e/ (Playwright)
```
