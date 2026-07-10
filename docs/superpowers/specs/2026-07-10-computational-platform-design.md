# RowPoint Computational Platform — Design Specification

**Date:** 2026-07-10
**Status:** Approved (design presented and accepted in session)
**Scope:** Phases 1–7 of the computational platform update + final production audit
**Decisions locked by the owner:**
1. All phases implemented straight through, one commit per phase, tests passing at each commit.
2. Zero new npm dependencies — pure JS on `node:sqlite`, CPU-heavy work on `node:worker_threads`.
3. Kernel-first architecture: shared computational plumbing is built in Phase 1 and every engine registers into it; Phase 7 is additive only.

---

## 1. Context

RowPoint today is a dependency-light Node 22 / Express 5 / `node:sqlite` server with a
no-build vanilla-JS PWA. It already has: a deterministic training-analysis engine
(`server/ai/trainingAnalysis.js`), an LLM coach with a deterministic fallback
(`server/ai/coach.js`), periodized planning (`server/ai/periodization.js`), a versioned
stroke pipeline (`server/stroke/pipeline.js`), a pseudonymized opt-out research layer
(`server/research/*`), RBAC with a research-admin role, and node:test + Playwright suites.

This update turns the app into a computational platform: every workout becomes an
observation feeding a persistent estimate of the athlete's hidden physiological state,
and six engines operate on that state.

### Non-goals

- No external infrastructure (Postgres, Redis, queues). SQLite + worker_threads only.
- No LLM calls inside the computational engines. Claude remains where it is today
  (phrasing coach text). Engines are deterministic and seed-reproducible.
- No replacement of existing features. The periodization engine, AI coach, research
  pipeline, groups, and leaderboards keep working unchanged; new systems subscribe to
  events rather than rewiring existing flows.
- No new sports. Extensibility is architectural (registries), not user-facing.

---

## 2. The Kernel (`server/kernel/`) — Phase 1

Small, engine-agnostic modules. **Rule: the kernel imports nothing from any engine.**
Engines communicate with each other only through kernel interfaces (events, jobs,
registry, graph). An architectural test enforces this by scanning import statements.

### 2.1 `events.js` — event bus
- In-process synchronous pub/sub: `on(type, handler)`, `emit(type, payload)`.
- Per-subscriber error isolation: one failing handler never breaks the emitter or
  other handlers; failures are logged to `health_events`.
- Every emit appends to `event_log (id, type, payload_json, created_at)` (capped,
  pruned) for auditability.
- Event catalog (extensible): `workout.saved`, `workout.deleted`, `workout.corrected`,
  `twin.updated`, `prediction.completed`, `recommendation.generated`,
  `optimization.completed`, `experiment.updated`, `research.snapshot`.
- Migration: the direct `onWorkoutSynced()` call in `server/workouts.js` remains
  synchronous in-request (its badge results are returned in the HTTP response), but the
  same sync path now also emits `workout.saved`; all *new* reactions subscribe.

### 2.2 `jobs.js` — background job system
- Table `jobs (id, kind, user_id, payload_json, status, priority, attempts,
  max_attempts, checkpoint_json, error, created_at, started_at, finished_at,
  duration_ms)`.
- In-process scheduler: polls for due jobs, respects priority, retries with backoff,
  supports cancellation and checkpoint/resume (jobs persist a checkpoint blob; a
  resumed job continues from it).
- Job kinds declare a handler and whether they run inline (fast) or on a worker
  thread (CPU-heavy: Monte Carlo, optimization search).
- Coalescing: enqueuing `(kind, user_id)` while an identical pending job exists
  replaces its payload instead of duplicating work.
- Execution metrics per kind (count, avg/max duration, failures) surface in RPOS
  observability.

### 2.3 `registry.js` — versioned model/algorithm/feature registry
- `register({ name, kind, version, description })` at module load; persisted to
  `model_versions (name, kind, version, description, first_seen_at, active)`.
- Kinds: `feature`, `model`, `algorithm`, `pipeline-stage`, `strategy`, `plugin`.
- Old versions are never deleted — historical outputs stay attributable.
- Lookup APIs power reproducibility records and the RPOS plugin view.

### 2.4 `estimate.js` — the universal value type
Every engine speaks Estimates, never bare numbers:
```js
{ value, uncertainty,          // symmetric sd-like spread; null if unknown
  confidence,                  // 0..1 subjective confidence in the estimate
  provenance,                  // 'measured' | 'estimated' | 'assumed' | 'predicted'
  modelVersion, evidenceCount, updatedAt }
```
Helpers: `measured()`, `estimated()`, `assumed()`, `predicted()`, `combine()`
(inverse-variance weighting), serialization/validation.

### 2.5 `graph.js` — computational dependency graph
- Nodes declare `{ name, dependsOn: [...], compute(ctx) }`.
- Dirty-flag propagation: marking a node stale (e.g. on `workout.saved`) marks all
  transitive dependents stale; a run recomputes only stale nodes in topological order.
- Cycle detection at registration. The Phase 1 twin pipeline and Phase 2+ engines
  register their stages as graph nodes.

### 2.6 `rng.js` — reproducible randomness
- Seedable deterministic PRNG (splitmix64-seeded xoshiro128**), plus
  gaussian/uniform/pick helpers. Every stochastic run records its seed; same seed +
  same versions ⇒ identical output. Verified by tests.

### 2.7 `stats.js` — shared statistics
- mean/sd/quantiles, linear regression + slope CIs, Pearson/Spearman, bootstrap CIs,
  Cohen's d, Benjamini–Hochberg correction, simple k-means, exponential decay fitting.
- Used by twin inference, discovery, experiments, and validation. Unit-tested against
  known fixtures.

---

## 3. Digital Twin Engine (`server/twin/`) — Phase 1

### 3.1 State representation
Latent state vector per athlete across 12 categories, each holding named variables
stored as Estimates:

| Category | Example variables |
| --- | --- |
| aerobic | capacity, baseSpeed, efficiencyTrend |
| anaerobic | capacity, sprintPower |
| recovery | halfLifeHours, chronicDebt |
| fatigue | acute, chronic, ratio (ACWR-style) |
| efficiency | paceHrRatio, drift |
| consistency | sessionRegularity, paceVariability |
| technique | strokeSmoothness, ratingDiscipline |
| power | criticalPower, wPrime |
| endurance | sustainableMinutes, longSessionTolerance |
| readiness | today, trend |
| adaptation | responseRate, plateauRisk |
| injuryRisk | loadSpike, monotony, strain |

Storage:
- `athlete_state (user_id, category, variable, value, uncertainty, confidence,
  provenance, model_version, evidence_count, updated_at)` — current state, upserted.
- `state_snapshots (id, user_id, created_at, trigger, state_json)` — append-only
  history for longitudinal analysis and reproducibility.
- `inference_history (id, user_id, workout_id, stage, detail_json, model_version,
  created_at)` — why each update happened (explainability).
- `feature_cache (workout_id, feature, version, value, computed_at)` — extracted
  features, recomputed only when the feature version changes.

New variables/categories are additive; unknown categories in old snapshots are
ignored on read (forward compatibility, tested).

### 3.2 Pipeline (12 stages, each its own module in `server/twin/pipeline/`)
validate → sensorValidate → clean → normalize → extractFeatures →
infer → updateState → deriveMetrics → refreshPredictions →
refreshRecommendations → researchAggregate → snapshot

- Runs as a `twin.update` background job per saved workout (coalesced per user).
- Each stage registers in the kernel registry with a version and appends an
  `inference_history` row.
- Feature extractors are plugins: modules in `server/twin/features/` export
  `{ name, version, extract(workout, ctx) }` and self-register. The existing
  `analyzeWorkouts` logic is wrapped as the first extractors (pace stats, zone
  distribution, HR drift, consistency, load, recovery spacing) — not rewritten.

### 3.3 API (`/api/twin`)
- `GET /api/twin/state` — own state, grouped by category, each var an Estimate.
- `GET /api/twin/history?variable=` — snapshot series for charts.
- `GET /api/twin/explain?variable=` — evidence trail from `inference_history`.
- Strictly own-data (authRequired + verified). Aggregate/anonymous views only via
  the existing research-admin role. No cross-athlete access, enforced by tests.

### 3.4 Frontend
New “Athlete State” page (`public/js/pages/twin.js`): category cards with confidence
bands, history sparklines, and an explainability drawer. EN + DE strings.

---

## 4. Computational Rowing Physics Engine (`server/physics/`) — Phase 2

Pure, deterministic modules; every output is an Estimate with provenance; missing
inputs widen uncertainty and set provenance to `assumed`, never fabricate data.

- `power.js` — critical-power / W′ estimation from workout history (2-param CP model
  over best sustained effort curve); documented equations.
- `stroke.js` — six-phase stroke decomposition (catch, connection, drive, finish,
  extraction, recovery): relative timing, power contribution, efficiency, rhythm.
  Uses force curves when present (`force_curves` table); erg cadence/pace heuristics
  otherwise, with correspondingly wider uncertainty.
- `environment.js` — air density, wind/current/water-temp effects; all optional
  inputs; unknowns become distributions, not point guesses.
- `drag.js` — hull drag model by shell type + crew mass; erg drag-factor handling.
- `boat.js` — boat classes (1x…8+), mass/crew configuration, momentum, crew
  synchronization factor (explainable assumption, documented).
- `energy.js` — mechanical work, metabolic work (documented efficiency ~20±3%),
  kcal, energy-system split by intensity/duration.
- `recovery.js` — post-workout recovery kinetics as continuous exponential decays
  (cardiovascular, muscular, neural, energy) with half-lives modulated by twin state.
- `translation.js` — erg↔boat chain: erg score → aerobic capacity → sustainable
  power → boat-specific speed → predicted race pace. Each link explainable; never a
  single conversion factor.
- `decomposition.js` — “why was this a 6:34”: aerobic/anaerobic/technique/fatigue/
  environment/execution contributions with confidence, fed back into the twin.

Physics outputs are consumed via twin pipeline stages (`infer`, `deriveMetrics`) and
exposed at `GET /api/twin/physics/:workoutId` (own workouts only). Validation tests:
extreme conditions, missing sensors, 30-second and 3-hour workouts, elite vs beginner
inputs, implausible values, numerical stability (no NaN/Infinity ever leaves a module).

---

## 5. Global Training Optimization Engine (`server/optimizer/`) — Phase 3

- `planSpace.js` — decision representation: a plan is a vector of day-slots
  (type, duration, intensity zone, rest/cross/strength/taper flags) over a
  configurable horizon (week → season).
- `constraints.js` — hard constraints (max daily/weekly volume, unavailable days,
  coach-prescribed sessions win, required rest spacing, race calendar, medical
  restrictions) — violations prune candidates, never scored away.
- `objectives.js` — multi-objective scoring against twin simulations: predicted 2k
  improvement, aerobic gain, fatigue, injury risk, adherence plausibility,
  peak-on-race-day probability, monotony. No default collapse to one score.
- `simulate.js` — fast forward-model: applies a candidate plan to a copy of the twin
  state using the physics recovery/adaptation kinetics (Banister-style
  impulse-response with personalized parameters), producing predicted state
  trajectories.
- `monteCarlo.js` — seeded stochastic evaluation (adherence, sleep, illness,
  physiological noise as distributions) on worker threads → outcome distributions.
- `search/` — pluggable strategies behind one interface `{ name, version,
  search(space, evaluate, budget) }`: `beam.js`, `anneal.js`, `genetic.js`.
  A benchmark harness compares strategies on fixture athletes and records results.
- `pareto.js` — non-dominated sorting → Pareto frontier; plans carry per-objective
  scores and a plain-language tradeoff explanation.
- `sensitivity.js` — perturb assumptions (missed workout, poor sleep week, ±10%
  volume) and report plan robustness.
- `counterfactual.js` — “what if” evaluation of a user-modified plan vs the
  recommendation.
- `runs.js` — every optimization persisted to `optimization_runs (id, user_id,
  config_json, seed, algorithm, versions_json, frontier_json, chosen_plan_json,
  created_at, duration_ms)` for full reproducibility.
- Adaptive replanning: `workout.saved` marks the athlete's optimization graph node
  stale; a coalesced background job re-optimizes incrementally (warm-starts from the
  previous frontier).

API (`/api/optimizer`): request run (rate-limited, job-backed with progress),
fetch frontier, fetch explanation, counterfactual evaluation.
Frontend: “Plan Explorer” page — frontier scatter, plan timelines, fatigue/adaptation
curves with uncertainty bands, what-if controls. The existing periodization generator
becomes one seeding heuristic for the initial population — it is not removed.

---

## 6. Scientific Discovery Engine (`server/discovery/`) — Phase 4

Operates **only** on pseudonymized research tables (`research_workouts`,
`research_wellness`, snapshots). No joins to `users` beyond the existing HMAC
pseudonym derivation at write time.

- `quality.js` — per-workout data-quality score (completeness, plausibility,
  duplicates, sensor dropout); analyses weight by quality; exclusions always recorded
  with reasons (`research_exclusions` table).
- `featureStore.js` — versioned derived variables per research pseudonym per period
  (weekly volume, intensity distribution, monotony, strain, drift, improvement slope,
  volatility, PR frequency, adaptation velocity) in `research_features (research_id,
  period, feature, version, value, quality, computed_at)`.
- `hypotheses.js` — automated candidate generation: correlation screens, k-means
  cohort clustering, trend/plateau/threshold detection, seasonal patterns. Every
  candidate is a *hypothesis* row, never a conclusion.
- `statsTests.js` — the reporting gate: effect size + bootstrap CI + BH-corrected
  significance + sample size + quality summary + sensitivity check; exploratory vs
  confirmatory clearly labeled; small samples flag warnings instead of results.
- `cohorts.js` — anonymous cohort builder (age band, sex, weight class, 2k band,
  volume band, minimum k-anonymity of 5 — cohorts smaller than 5 refuse to report).
- `longitudinal.js` — irregular-sampling-tolerant trajectory analyses.
- `review.js` — findings queue for the research admin: approve / dismiss / annotate;
  approved findings exportable as a research report (JSON/CSV). Nothing auto-publishes.
- Reproducibility: every analysis records dataset snapshot id, feature versions,
  config, seeds in `research_analyses`.

API (`/api/research-admin/discovery/*`) — research-admin only. Frontend: extends the
existing research dashboard page with Findings, Cohorts, and Quality tabs.

---

## 7. Autonomous Experimental Design & Validation Engine (`server/experiments/`) — Phase 5

- `hypothesisRegistry.js` — model assumptions as first-class rows: `hypotheses (id,
  statement, origin_model, confidence, supporting_json, contradicting_json,
  validation_history_json, populations, created_at, updated_at)`. Seeded with the
  documented assumptions of the physics + twin models.
- `knowledgeGraph.js` — `knowledge_nodes` / `knowledge_edges` with evidence source,
  confidence, model version, last-validated date; evolves via Bayesian updates;
  versioned snapshots.
- `planner.js` — experiment protocols for consenting users: objective, inclusion
  criteria, duration, outcome measures, stopping conditions (safety triggers stop
  immediately), expected information gain. Safety rule: experiments may only vary
  within the athlete's already-observed training envelope — never increase risk.
- `activeLearning.js` — when uncertainty is high and risk is low, the recommendation
  path may propose an information-rich alternative; opt-in per user, configurable,
  clearly labeled in the UI.
- `bayes.js` — beta/normal conjugate updating of hypothesis confidence from outcomes;
  every update recorded.
- `modelComparison.js` — competing model variants run side-by-side on the same
  inputs; calibration + error tracked in `model_performance`; a documented promotion/
  retirement rule (sustained superior calibration over N≥20 predictions) with every
  transition recorded.
- `notebook.js` — append-only lab notebook (`lab_notebook`) capturing hypothesis,
  rationale, versions, data snapshot, before/after confidence, outcome; exportable.
- `consent.js` — experiment participation is separate, explicit consent on top of
  research opt-in: opt in / opt out / pause / delete contributions. Enforced at
  write time like the existing research consent.
- Meta-learning: track calibration drift, error trends, uncertainty quality per model
  in `model_performance`; surfaced on the admin validation dashboard.

Frontend: Settings gains the experiment-consent block; admin gains a Validation tab
(calibration curves, error distributions, hypothesis confidence timeline, knowledge
graph stats). Admin-only; no PII anywhere in these views.

---

## 8. Digital Regatta Simulation Engine (`server/regatta/`) — Phase 6

- `athleteModel.js` — race-state per lane from the twin: sustainable power, W′
  reserve, fatigue sensitivity, technical degradation curve, start profile.
  Opponents: parameterized archetypes or manually-entered estimates for athletes;
  real teammate twins only in coach-run team simulations (coaches already have
  authorized visibility into their team's data — an athlete can never load another
  athlete's twin). Unknown opponents = wide distributions.
- `race.js` — discrete-time engine (250 ms steps): power → boat acceleration/velocity
  (physics drag model) → position; coupled state transitions (W′ depletion,
  cardiovascular strain, power decline, technique degradation, pacing decisions).
  Mental state is modeled only as pacing-variance uncertainty, never psychology claims.
- `strategy.js` — explicit strategies (even, negative split, fly-and-die, high-mid
  push, late sprint, custom per-500 targets); strategy optimization = optimizer search
  over strategy space against sampled opponent fields.
- `environment.js` — wind/gusts/current/temperature/lane effects as distributions.
- `tactics.js` — optional probabilistic events (missed stroke, equipment niggle,
  surge response) with documented base rates; off by default.
- `monteCarloRegatta.js` — N seeded race simulations (default 2,000; up to 10,000 as
  a background job) on worker threads → win/medal probability, finish-time and split
  distributions, rank matrix, sensitivity (which variables moved outcomes most).
- `whatIf.js` — modify assumptions (+2% power, different strategy/weather/lineup) and
  re-simulate; deltas reported against the baseline run.
- Persistence: `race_simulations (id, user_id, config_json, seed, versions_json,
  summary_json, created_at)`; full timeline of the median + selected percentile races
  stored for replay; validation hooks compare predictions to actual entered race
  results (`races` table already exists).

Frontend: “Race Lab” page — set up field/conditions/strategy, run sim (progress via
job polling), outcome distributions, and a canvas race replay with a time scrubber
showing boat positions, speeds, W′ reserve bands, and live win probability.

---

## 9. RowPoint Operating System (`server/rpos/`) — Phase 7 (additive only)

- `orchestrator.js` — unified view + control over kernel jobs: queue state, history,
  progress, retry/cancel; dependency-aware scheduling delegated to the kernel graph.
- `plugins.js` — manifest validation for everything registered (name, version, kind,
  dependencies, permissions); startup report of the loaded plugin set; rejects
  duplicate name+version with different implementations (hash check).
- `observability.js` — timings, cache hit rates, job throughput, DB latency, slow
  queries; extends the existing admin System tab; performance regression thresholds
  logged to `health_events`.
- `auditTrail.js` — immutable computation records (algorithm, versions, inputs hash,
  confidence, outputs hash, timestamp) — an append-only `computation_log` written by
  kernel job completion; admin-searchable.
- `docs.js` — generated documentation from live registries: architecture map, event
  catalog, job kinds, model/version inventory, DB schema dump, API route inventory —
  written to `docs/generated/` on demand (`npm run docs`).
- API versioning: new engine routes live under `/api/v1/…` aliases; existing routes
  keep working (backward compatibility statement + contract tests).
- Org groundwork: `organizations` + membership tables and role checks reusing the
  existing RBAC pattern (coach/athlete/admin/research-admin), minimal UI (admin can
  create an org and attach teams). Full org UX is out of scope.
- Offline-first, cross-platform: already handled by the PWA/offline queue; RPOS adds
  nothing user-facing here beyond keeping new pages functional offline-read.

---

## 10. Cross-cutting rules (all phases)

1. **Determinism & reproducibility** — every stochastic computation records seed +
   versions + config; a replay API re-executes and must byte-match summaries (tested).
2. **Explainability** — every Estimate traces to evidence (`inference_history`,
   run records); every user-facing number can answer “why”.
3. **Security** — own-data-only for athlete endpoints; research-admin for aggregates;
   admin for system views; all new mutating routes CSRF-covered; rate limits on
   expensive endpoints (optimizer/regatta runs); no PII in research/experiment paths.
4. **Performance** — dirty-graph incremental recompute; feature cache keyed by
   version; job coalescing; worker threads for CPU-heavy loops; LIMIT/paging on all
   list APIs; indexes on every new table's query paths. Target: twin update < 250 ms
   typical; 2,000-race Monte Carlo < 10 s on one worker.
5. **Cost** — no new services; no additional LLM calls; background jobs bounded by a
   global concurrency cap; all engines idle at zero cost when unused.
6. **Bilingual** — every new UI string ships in EN and DE locale files.
7. **DB conventions** — TEXT ids, unix-int timestamps, `CREATE TABLE IF NOT EXISTS` +
   `ensureColumn`, prepared statements, transactions via `inTransaction()`,
   `schema_version` bumped per phase.
8. **Testing per phase** — unit tests for every module; API contract tests; isolation
   test (kernel imports no engine; engines import only kernel + own dir);
   serialization round-trips; version-compatibility (old snapshots load);
   migration idempotency (schema applies twice cleanly). All added to `npm test`.

## 11. Phase exit criteria

Each phase commit must: pass the full test suite (old + new), add its tests to the
npm test script, bump `schema_version` if it added tables, register all new
models/features/algorithms in the kernel registry, and update README's layout section.

## 12. Final production audit (after Phase 7)

Full-repo pass: functional verification of every feature (old and new); security
review (authz on every new route, injection, CSRF, rate limits, headers); TODO/
placeholder/console.log sweep; performance checks (bundle-free SPA page weights, DB
indexes, N+1 queries); dependency audit (still 3 runtime deps); cost model at 100 /
1k / 10k / 100k / 1M users with assumptions; store-readiness checklist against
APPSTORE.md; accessibility spot checks; final report written to
`docs/production-readiness-2026-07.md` with a readiness score and known limitations.
Claims are verified against the actual codebase; anything unverifiable (real BLE
hardware, store review outcomes) is listed as a limitation, not asserted.
