# RowPoint — Production Readiness Report

**Date:** 2026-07-11
**Scope:** Full-repository audit after completion of the Computational Platform
update (Phases 1–7 of the 2026-07-10 design spec) — see
`docs/superpowers/specs/2026-07-10-computational-platform-design.md`.
**Method:** Every claim below was verified against the actual codebase and by
executing the test suites and the running application in this audit session.
Anything that could not be verified on this machine is listed under
*Limitations*, not asserted.

---

## 1. Verification summary

| Category | Result |
| --- | --- |
| Unit / API / integration tests (`npm test`) | **251 / 251 passing** (unit, api, realtime, kernel, twin, physics, optimizer, discovery, experiments, regatta, rpos) |
| Browser end-to-end tests (`npm run test:e2e`, Playwright/Chromium) | **16 / 16 passing** — full coach + rower + admin journeys through the real UI, including the erg simulator, wellness, research toggle, CSV export, HR management |
| Dependency audit (`npm audit --omit=dev`) | **0 vulnerabilities** |
| Runtime dependencies | **3** (`express`, `ws`, `@anthropic-ai/sdk`) — everything else is Node built-ins (`node:sqlite`, `node:worker_threads`, `node:crypto`) |
| TODO / FIXME / HACK / placeholder / mock sweep | **0 findings** in `server/` and `public/` (remaining `console.log` calls are CLI tools, the logger implementation, dev-mode mail, and the startup line — all intentional) |
| Placeholder / stubbed features | **None found.** Every routed page renders real data; every API route has a real implementation |
| Live verification | Race Lab (Phase 6) and the admin Platform tab (Phase 7) exercised in a real browser against the dev server: simulation → distributions → replay scrubber → what-if; audit trail row appearance; organization creation. Zero console errors |

## 2. Issues found by this audit — and how each was resolved

1. **Regatta Monte Carlo missed its performance budget.** The design target is
   a 2,000-race simulation in < 10 s on one worker; measured 12.4 s
   (6 boats, 2000 m). Fixed by (a) sampling each boat's pacing profile onto a
   lookup table once per race instead of interpolating anchors every step, and
   (b) running bulk statistics at a 0.5 s step (inside the design's 100–500 ms
   window; the stored replay re-runs its iteration at the same step, so
   reproducibility is preserved and the step is recorded in every summary).
   Now **5.2 s**, statistically equivalent output (P(win) 0.158 vs 0.162).
2. **Unbounded audit-trail growth.** `computation_log` gained a row per
   background job but was pruned only at boot, and twin updates are
   high-volume. Fixed: kind-aware retention (30 days for routine `twin.*`
   rows, whose explainability record already lives in `inference_history`;
   180 days for high-value run records) on a daily timer.
3. **Unbounded per-user run storage.** `race_simulations` (~100 KB replay per
   run) and `optimization_runs` (~tens of KB per run, created on every synced
   workout via replanning) grew without limit. Fixed: keep-newest-30 caps per
   user, applied at job completion.
4. **The Playwright e2e suite could not run outside the original Linux CI**
   (hard-coded `/opt/pw-browsers/chromium`, `rm -rf` + env-prefix shell
   command). Fixed: the pinned browser path is used only when it exists, and
   the web server is launched by a cross-platform Node script
   (`tests/e2e/serve.js`). Verified by running the full suite on Windows.
5. **The e2e suite was broken by the first-run language chooser** — every UI
   flow stalled on the language screen (a regression introduced when the
   chooser shipped, invisible because the suite wasn't being run). Fixed by
   seeding the language choice through Playwright `storageState`
   (`tests/e2e/state.js`), matching what a real returning user has.
6. **Ambiguous strict-mode locator** in the research-toggle e2e test
   ("Opted out" matches both the toast and the settings blurb). Fixed by
   scoping the assertion to the toast.
7. **Date-sensitive test failure** in the discovery suite: synthetic athletes
   were seeded relative to "now", so training blocks straddled ISO-week
   boundaries when the suite ran on a Saturday/Sunday and a volume assertion
   compared partial weeks. Fixed by aligning the seed epoch to a Monday
   (fixed during Phase 6; noted here because the audit re-verified it).
8. **Missing legal pages** (App Store / Play Store blocker): no in-app Privacy
   Policy or Terms of Service existed. Added `public/legal/privacy.html` and
   `public/legal/terms.html` — written to describe the app's *actual* data
   practices (pseudonymized opt-out research, export, full deletion, BLE
   scope, AI usage) — linked from the sign-in screen and Settings in EN + DE.
   **The operator should have counsel review these before store submission.**

## 3. Previously requested features — intact

The 251-test suite executed after every audit fix covers the pre-platform
feature set (auth + verification + recovery, workouts + splits + PRs, teams +
assignments + live view, groups/social, wellness, training plans + season
planner, equipment, stroke analysis, observatory/benchmarks, research
platform + admin dashboards, notifications, offline sync, BLE parsing, HR
zones) and the platform phases 1–7. The e2e suite additionally walks the
signup → team → assignment → row → feedback → wellness → research-toggle →
admin journeys through the real UI. **All pass; no feature was removed or
stubbed by the platform update.**

## 4. Security posture (verified in code + tests)

- **AuthN/AuthZ:** scrypt password hashing; HMAC-signed expiring tokens with
  token-version invalidation; email verification hard gate; RBAC re-read from
  the DB on every admin request; separate research-admin grant; own-data
  enforcement on every athlete endpoint (tested with cross-user probes on twin,
  optimizer, regatta, platform jobs); coach-gated teammate lanes in the regatta
  engine (403 before any other validation, no account enumeration).
- **Web:** strict CSP (no inline scripts), HSTS in production,
  X-Content-Type-Options/Frame-Options/Referrer-Policy/Permissions-Policy,
  double-submit CSRF on cookie-authenticated mutations (covers `/api/v1`
  aliases automatically), rate limits on auth and on every expensive
  computational endpoint (optimizer 6/h, regatta 6/h, what-ifs 30–60/h).
- **Injection:** all SQL via prepared statements; the two dynamic table-name
  sites introduced in Phase 7 (`auditTrail` output locators, `observability`
  table counts) read from hard-coded allowlists only.
- **Data at rest:** encrypted (AES-256-GCM) automated backups; secrets
  generated per-instance and persisted outside the repo; research
  pseudonymization uses a dedicated secret so a token-secret leak cannot
  de-pseudonymize the research corpus.
- **Immutability:** `computation_log` rejects UPDATEs by trigger (tested).

## 5. Performance (measured)

- 2,000-race / 6-boat Monte Carlo regatta: **5.2 s** on one worker thread
  (budget 10 s); runs as a background job, never blocks the API.
- Twin pipeline per synced workout: **~50–150 ms** (measured in the audit
  trail of the live dev server).
- Optimizer run (budget 1200 evaluations + MC + sensitivity): **~0.7 s**.
- API latency (dev server, from the new RPOS percentiles): p95 < 20 ms on all
  route groups exercised.
- The RPOS watchdog now alerts to `health_events` when any route group's p95
  or any job kind's average crosses its documented budget.
- Known ceiling: jobs execute serially per process (SQLite single-writer by
  design), so one long simulation delays queued twin updates by its runtime
  (bounded: priorities reorder the queue between jobs). Acceptable at the
  scales below; the job table design permits a worker-pool upgrade without
  schema change.

## 6. Cost model

Assumptions: single Node process + SQLite on a persistent disk
(Render/Railway/Fly-class pricing, 2026); email via Resend (free ≤ 3k/mo);
AI coach optional (deterministic fallback when unset) — Anthropic calls are
cached per day and user-rate-limited, so AI cost scales with *active* users,
not requests. Typical active user ≈ 1–3 MB/year of database growth (workouts
+ state + capped run records; replays and audit rows are retention-capped).

| Scale | Infrastructure | Est. monthly cost | Notes |
| --- | --- | --- | --- |
| 100 users | 512 MB instance + 1 GB disk | **$7–20** | Email free tier; AI ≈ $1–5 |
| 1,000 users | 2 GB instance + 10 GB disk | **$35–90** | Email $20 tier; AI $5–35 |
| 10,000 users | 4–8 GB instance + 50–100 GB disk | **$200–650** | AI $50–300 (rate-limited); consider a second process for job workers |
| 100,000 users | **Re-architecture required** | ~$1,500–5,000 | Single-writer SQLite + serial jobs no longer fit; managed Postgres + 2–4 app instances + object storage for replays. The kernel job/event/provider contracts were designed so engines survive this migration |
| 1,000,000 users | Re-architected, multi-region | ~$15,000–60,000 | Not supportable on the current single-node design — an explicit, documented limitation, not a hidden one |

No cost cliff exists below ~10k users: there are no per-request third-party
calls, engines are deterministic (no LLM), background jobs are coalesced and
rate-limited, and every growing table has a cap or retention policy.

## 7. Store readiness

- **Web/PWA:** ready — manifest, service worker, offline queue, responsive
  layouts, dark/light theme, EN+DE, account deletion in-app, CSV export,
  privacy policy + terms linked from sign-in and Settings.
- **iOS/Android:** the required path is documented step-by-step in
  `APPSTORE.md` (Capacitor wrapper with native BLE plugins — iOS has no Web
  Bluetooth; a bare WebView wrapper would be rejected under Guideline 4.2).
  Permission strings, background-BLE notes, and review-note guidance are in
  that document. Building and submitting requires a Mac + developer accounts
  and could not be performed in this audit.
- Common rejection causes checked: no placeholder icons/screens in the web
  app, no hardcoded developer values (admin email is an intentional, specified
  constant), legal pages now present, account deletion present, no tracking.

**Confidence:** Web deployment — high (90%+). App Store / Play Store approval
after executing the documented Capacitor path — moderate (≈75%): the plan
addresses the known rejection reasons, but store review outcomes cannot be
guaranteed from a code audit.

## 8. Remaining limitations (explicit)

1. **Real BLE hardware untested in this audit.** The PM5/HRM protocol code is
   unit-tested against recorded packet fixtures (including corrupt/partial
   packets), and the e2e suite exercises the simulator path, but no physical
   erg or strap was available.
2. **iOS/Android binaries do not exist yet** — see §7.
3. **Single-node scale ceiling** at roughly the 10k–50k active-user mark
   (§5, §6). A documented migration path exists; it is not built.
4. **The legal pages are developer-drafted** to match actual behavior; they
   are not a substitute for counsel review before commercial distribution.
5. **Load testing** beyond single-machine measurements (e.g. sustained
   concurrent WebSocket live-view fan-out at thousands of users) was not
   performed in this session.
6. **Email deliverability** in production depends on the operator configuring
   Resend (or another provider) and DNS; dev mode is self-contained.

## 9. Production readiness score

**88 / 100.**

Deductions: −5 single-node architecture ceiling and untested high-scale load;
−4 mobile binaries not yet built (documented path only); −2 real-hardware BLE
verification outstanding; −1 legal review outstanding.

The application is ready for production web deployment at club-to-federation
scale today: zero known security issues, zero failing tests, zero placeholder
implementations, bounded costs with no surprise-bill vectors identified, and
every computational claim traceable to a versioned, reproducible record.
