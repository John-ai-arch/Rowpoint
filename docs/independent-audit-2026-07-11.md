# RowPoint — Independent Production Audit (final)

**Date:** 2026-07-11 (second, independent audit session)
**Method:** Nothing from the previous audit was taken on trust. The full test
suites were re-executed as a baseline, every security-relevant server module
was re-read, dynamic-SQL sites were re-verified against their allowlists,
XSS escaping was mechanically swept across all 211 innerHTML sites, the
running application was walked in a real browser (desktop and 375 px mobile
viewports), and the deletion path was traced against every table in the
schema. Every claim below was verified in this session.

---

## 1. Verification summary (after fixes)

| Check | Result |
| --- | --- |
| Unit / API / integration tests (`npm test`) | **253 / 253 passing** (2 new regression tests added by this audit) |
| Browser e2e tests (`npm run test:e2e`) | **16 / 16 passing** |
| `npm audit --omit=dev` | 0 vulnerabilities (3 runtime deps) |
| Syntax check of every file touched by this audit | clean |
| Live verification | malformed-JSON → clean 400; dashboard/detail pages free of raw identifiers; settings copy consistent with actual behavior; no console errors; no horizontal overflow at 375 px |

## 2. Issues found by THIS audit — all fixed and tested

1. **Account deletion was incomplete** (privacy-policy violation). The scrub
   missed five stores with no FK to `users`:
   - `research_state_snapshots` and `research_features` — **pseudonymized
     research data survived deletion**, directly contradicting the policy
     line "Deleting your account deletes your research rows too."
   - `auth_events` — retained the account's **email address indefinitely**.
   - `health_events`, `email_outbox`, `jobs` — user-linked rows retained.
   - `group_week_history` — retained the user's **display name** snapshots.
   Fix: a single shared `server/accountDeletion.js` now used by both the
   self-service and the admin/GDPR deletion flows (they can no longer
   drift); display-name snapshots are anonymized to "Former member" so other
   members' historical ranks stay intact. Covered by extended API tests.

2. **No retention bound on security/telemetry logs.** `auth_events` (emails)
   and `health_events` grew forever. Fix: daily pruning (12 months / 6
   months) on the existing RPOS retention timer, and the privacy policy now
   states this retention explicitly.

3. **Live-session reconnect bug (WebSocket).** If a rower's connection
   dropped and they reconnected before the dead socket's `close` event was
   processed server-side, the late close clobbered the new connection's
   entry and evicted the rower from the channel 30 s later — they kept
   rowing but silently vanished from the coach's live grid. Fix: the close
   handler now ignores sockets that are no longer the user's current one.
   Covered by a new regression test in `realtime.test.js`.

4. **HR data retention was coupled to research consent** — opted-out users
   silently lost their own per-workout heart-rate chart, while the Settings
   screen promised opting out "never affects any feature." Fix: the
   athlete's own HR series is now always stored with their own workout;
   research consent gates only the pseudonymized research copy (checked at
   contribution time, unchanged). Settings copy updated; test updated.

5. **Admins could opt users IN to research** ("grant participation" on a
   user's behalf), i.e. data could enter the research corpus without any
   consent action by the person it belongs to. Fix: the endpoint and the
   admin UI are now revoke-only; consent can only be given by the athlete in
   their own Settings. Covered by an updated API test.

6. **Malformed client input surfaced as server errors.** Bad JSON or an
   oversized body returned a masked 500, wrote an `api_error` health event,
   and bumped the 5xx counters — so anyone could pollute the admin error log
   and metrics by posting garbage. Fix: body-parser failures now map to a
   clean 400 (`invalid_json`) / 413 (`payload_too_large`) with no health-log
   write. Covered by a new API test.

7. **OAuth endpoints had no rate limit** — each Google attempt costs the
   server an outbound verification round-trip (unauthenticated amplification
   vector). Fix: both OAuth endpoints rate-limited (30 / 15 min / IP).

8. **Raw internal identifiers were visible to users** (violates the
   professional-presentation bar):
   - Dashboard coach card showed the raw category enum (e.g.
     `steady_state`) in a `<code>` chip, and the source label leaked the
     internal name "analysis engine". Both replaced with human language;
     the machine-generated disclosure (§11.5) is preserved.
   - Workout detail showed `Classification: well_paced` (raw enum) and raw
     per-interval tags — humanized.
   - Coach team view showed raw `rationaleTag` / `pending_coach` status
     enums — humanized.
   - Plan Explorer run history showed `genetic@1.0`-style component ids;
     twin evidence modal showed kebab-case pipeline stage names — humanized.
   - The e2e dashboard test now asserts the coach card contains **no**
     snake_case identifier at all.

9. **UI copy defects:** live-row stroke-rate metric labeled "s/m" (reads as
   seconds-per-meter) → "stroke rate"; Progress tile "This week vs. This
   week−1" → proper localized "This week vs. last week" (EN+DE keys);
   "Longest streak: 1 days" → proper pluralization (EN+DE `_one` keys).

10. **Unknown BLE errors showed raw browser exception text** in the connect
    panel. Fix: unknown failures now show a calm human message; the raw
    exception is preserved in a `raw` field and still reaches telemetry.

## 3. Re-verified from the previous audit (spot checks passed)

- **AuthN/AuthZ:** scrypt hashing; HMAC tokens with token-version
  invalidation; verification hard-gate (no session until verified); RBAC
  re-read per request; every router auth-gated at mount; own-data checks on
  team/group/workout/twin/regatta endpoints; anti-enumeration on
  reset/resend/search.
- **Injection:** all 13 dynamic-SQL sites verified — every table/column name
  comes from a hard-coded constant or allowlist; all values via placeholders.
- **XSS:** the shared `esc()` helper is applied consistently across chat,
  feed, comments, leaderboards, admin surfaces; toasts use `textContent`;
  chat images validated server-side as bounded data-URLs; CSP allows no
  inline scripts. No unescaped user-string interpolation found.
- **CSRF:** double-submit cookie pattern with timing-safe compare, Bearer
  and bootstrap exemptions correct; WS upgrades check Origin for cookie auth.
- **Secrets:** generated per-instance with 0600 perms outside the repo, or
  env vars; distinct secrets for sessions / research pseudonyms / backups.
- **Backups:** VACUUM INTO snapshot → AES-256-GCM, manifest with SHA-256,
  verify/restore CLI, retention pruning, failure alerting.
- **Performance:** in-memory structures all bounded (rate-limit sweep,
  latency rings with path-explosion guard, event-log cap, outbox prune,
  per-user run caps, computation-log retention); WS channels cleaned up.
- **No debug endpoints in production** (`/api/dev/outbox` is dev-mode only);
  no stack traces in responses; error messages uniform JSON.
- **AI privacy:** no name/email in any Anthropic prompt (grep-verified);
  deterministic fallback when unconfigured; per-user rate limits.

## 4. Production-readiness assessment

**Score: 90 / 100** for the web/PWA product.

Ready for production web deployment at club-to-federation scale. Deductions:
−4 mobile store binaries still do not exist (documented Capacitor path only);
−3 single-node scale ceiling (~10k–50k active users) and no external load
test; −2 real-hardware BLE verification outstanding; −1 legal review
outstanding.

## 5. Remaining limitations and risks (explicit)

1. **iOS/Android binaries do not exist.** There is no Capacitor project in
   the repository — `APPSTORE.md` documents the wrapper path (native BLE
   plugins are mandatory; iOS has no Web Bluetooth). Store submission is not
   possible until that project is built on a Mac with developer accounts.
2. **Partial internationalization.** The i18n framework (EN/DE) is solid and
   most primary labels are localized, but many secondary strings are
   hard-coded English — German users see mixed-language screens. Either
   complete DE coverage or ship EN-only for launch.
3. **Research consent is opt-out at signup** (pre-checked toggle on a
   dedicated consent step, per design spec §5.1). Pre-checked consent is
   unlikely to satisfy GDPR's "unambiguous affirmative act" standard for EU
   users, and Apple reviewers may probe it. **Needs counsel review**; the
   mechanics for opt-in-by-default already exist (one default flip).
4. **Native confirm()/prompt() dialogs** remain in a few flows (reports,
   emoji reactions, admin confirmations) — functional but not premium;
   cosmetic, not blocking.
5. **Real-hardware BLE untested in this audit** (protocol code is
   fixture-tested; simulator path e2e-tested). Needs a physical PM5 + HR
   strap pass, including mid-workout disconnect/reconnect.
6. **Single-node ceiling** (serial job execution, SQLite single-writer) at
   roughly 10k–50k active users; documented migration path, not built.
7. **Email deliverability** depends on operator DNS + Resend configuration.

## 6. Items requiring real-device testing

- PM5 connect / mid-workout disconnect / reconnect / multi-device contention
  (the "machine busy" path), workout push via CSAFE, force-curve capture.
- HR strap: 8/16-bit HR, RR intervals, battery warnings, auto-reconnect.
- iOS/Android Capacitor builds: background BLE behavior, permission prompts
  (the strings are drafted in APPSTORE.md), WebView performance.

## 7. Items requiring legal review

- Privacy Policy and Terms (developer-drafted; accurate to behavior as of
  this audit — including the new security-log retention disclosure).
- The research **opt-out default** at signup (see §5.3 above) and the
  demographics default.
- COPPA/age handling: signup accepts birth years implying minors; the
  research pipeline coarsens age but there is no parental-consent flow.

## 8. Professional-presentation confirmation

After the fixes in §2.8–2.9, a mechanical sweep of every user-facing page
(and a live walk of dashboard, progress, athlete state, race lab, plan
explorer, workout detail, settings, teams, groups) found **no** snake_case /
camelCase identifiers, no raw enums, no JSON, no stack traces, no internal
ids, and no placeholder text in any non-admin surface. The only `<code>`
elements outside the admin console display a machine's hardware serial
number (user-meaningful device info) and an admin-issued temporary password.
The admin console (owner-only) intentionally retains technical detail — it
is an operations surface, not a user surface.

---

# Addendum — Mobile & Bluetooth hardening pass (2026-07-12)

A follow-up session focused on native-mobile readiness and the BLE layer.
Verified with the full suites (258 unit/API tests — 5 new — and 16 e2e).

## Fixed

1. **FTMS parser field-offset bug (both rower and bike data).** The
   Metabolic Equivalent flag (bit 10, 1 byte) was not skipped, so on any
   FTMS machine that reports METs every field after it — elapsed time —
   was read one byte off (garbage durations). Fixed per the Bluetooth SIG
   spec; regression-tested with crafted packets.
2. **FTMS parsers could throw on truncated packets** (the PM5 parsers
   guard lengths; these didn't). Now guarded — one malformed notification
   can never break the metric stream. Tested.
3. **Duplicate BLE listeners across reconnects.** `BleHeartRateMonitor`
   added a new measurement listener on every signal-loss reconnect
   (readings multiplied N× after N drops), and all three adapters (HRM,
   PM5, FTMS) stacked `gattserverdisconnected` handlers on the reused
   BluetoothDevice object across sessions. All listeners now use stable
   handler refs with remove-before-add, and intentional disconnects detach
   device-level handlers first (an intended teardown can no longer present
   as a surprise mid-workout disconnect). Unit-tested with a fake GATT
   stack: exactly one listener after any number of reconnects.
4. **HR `stats()` argument-list overflow risk**: `Math.min(...samples)`
   over a multi-hour session's samples; replaced with a single pass.
5. **Raw exception text in HR connect errors** (unknown-failure fallback)
   replaced with a human message; raw detail goes to the console.
6. **Foreground-return recovery**: returning to a visible tab/app with a
   lost strap signal now kicks a fresh silent-reconnect round immediately
   (backoff attempts reset) instead of waiting for a manual tap.
7. **iPhone safe areas**: top bar, toasts, content, and the tab bar now
   pad with `env(safe-area-inset-*)` (top/left/right added; bottom already
   existed) so nothing sits under the notch, status bar, or home indicator
   in standalone/native shells. Desktop rendering verified unchanged
   (insets resolve to the previous fallback values).
8. **Capacitor scaffolding**: `capacitor.config.json` added (app id
   `fit.rowpoint.app`, webDir `public`, iOS scheme) and APPSTORE.md updated
   with the exact Android 12+ manifest permission block
   (`BLUETOOTH_SCAN` with `neverForLocation` + `BLUETOOTH_CONNECT`) and the
   `server.url` wiring note.

## Explicitly NOT claimed as verified

- **Native iOS/Android builds still do not exist** and cannot be produced
  or tested from this environment (requires a Mac/Xcode, developer
  accounts, and devices). The native BLE adapters described in APPSTORE.md
  Phase 2 remain to be written and can only be validated on hardware.
- The PM5/FTMS/HRM listener-hygiene fixes are unit-tested against fake
  GATT objects; behavior against physical machines still needs a
  real-device pass (PM5 + strap), including mid-workout drop/reconnect.
