# Architecture map

_Generated from the live codebase — do not edit._

## server/ai/

- **coach.js** — AI coach — LLM-powered workout recommendations.
- **lab.js** — Personal Analytics Laboratory data (vision #13). Turns the athlete's workout history into the datasets professional sports-science tools plot: pace vs
- **pacing.js** — §11.4 — Post-workout pacing classification. Pure, explainable rules over split-level data; runs before any text generation.
- **performance.js** — Performance intelligence: a daily Training Readiness estimate and a race-time predictor. Both are deterministic and fully explainable (every number shows
- **periodization.js** — Adaptive periodization engine — the intelligence behind long-term training plans. Like trainingAnalysis.js, everything here is deterministic, explainable
- **planValidation.js** — Client/server-side workout plan validation (§1.3). These mirror the PM5's documented constraints so users get instant feedback BEFORE connecting; the
- **trainingAnalysis.js** — Training analysis engine — the data layer behind the AI coach.

## server/discovery/

- **analyses.js** — Discovery orchestration + reproducibility.
- **api.js** — Discovery API — research-administrator only, every action audited. Mounted at /api/research-admin/discovery. Athletes and coaches can never
- **cohorts.js** — Anonymous cohort builder over the discovery feature store.
- **featureStore.js** — Research feature store — versioned longitudinal derived variables.
- **hypotheses.js** — Hypothesis generation — automated exploration of the research feature space for statistically interesting, reproducible candidate patterns.
- **index.js** — Scientific Discovery Engine — wiring.
- **statsTests.js** — The statistical gate — no candidate pattern becomes a reportable finding without passing through here. Every reported effect carries: effect size,

## server/experiments/

- **api.js** — Experiments API.
- **bayes.js** — Bayesian belief updating for hypotheses — Beta-Bernoulli conjugacy.
- **evaluator.js** — Experiment outcome evaluation — honest, small-n statistics.
- **hypothesisRegistry.js** — The hypothesis registry — every model assumption as a first-class object.
- **index.js** — Autonomous Experimental Design & Validation Engine — wiring.
- **knowledgeGraph.js** — The versioned knowledge graph — what the platform believes and why.
- **modelComparison.js** — Model validation & comparison — the meta-learning loop.
- **notebook.js** — The digital lab notebook — an append-only scientific record.
- **planner.js** — Experiment planner — low-risk, information-rich protocols for consenting athletes.

## server/kernel/

- **estimate.js** — Estimate — the universal value type of the computational platform.
- **events.js** — Platform event bus — the decoupling layer between subsystems.
- **graph.js** — Computational dependency graph with per-key dirty tracking.
- **jobs.js** — Background job system — SQLite-backed queue, in-process scheduler.
- **providers.js** — Cross-engine capability contracts.
- **registry.js** — Versioned registry of every model, algorithm, feature extractor, pipeline stage, and plugin on the platform.
- **rng.js** — Seedable deterministic randomness for reproducible computation.
- **stats.js** — Shared statistics for every computational engine.

## server/optimizer/

- **api.js** — Optimizer API — strictly own-data; runs are job-backed and rate-limited.
- **constraints.js** — Hard constraints — candidate plans that violate any of these are PRUNED, never merely scored down. Soft preferences belong in objectives.js; this
- **counterfactual.js** — Counterfactual evaluation — "what if I trained differently?"
- **index.js** — Global Training Optimization Engine — wiring.
- **mcWorker.js** — Worker-thread entry for Monte Carlo plan evaluation. Receives pure data, returns pure data — no database handle ever crosses the thread boundary
- **monteCarlo.js** — Monte Carlo plan evaluation — distributions, not point estimates.
- **objectives.js** — Multi-objective scoring — a plan's simulated trajectory becomes a vector of named objectives. There is NO default collapse to one number: the
- **pareto.js** — Pareto layer: non-dominated sorting + crowding-distance trimming.
- **planSpace.js** — Training-plan decision space.
- **problem.js** — Problem assembly: one athlete + one run config → the optimization problem (athlete simulator params, seed plans, constraints, evaluator, race index).
- **sensitivity.js** — Sensitivity analysis — how much does the recommendation move when the world doesn't cooperate? Each scenario deterministically perturbs either
- **simulate.js** — Forward model — what a candidate plan does to THIS athlete.

## server/physics/

- **api.js** — Physics API — strictly own-data, like every athlete-facing engine route.
- **boat.js** — Boat model: shell classes, hull drag, and boat speed from applied power.
- **decomposition.js** — Performance decomposition — "why was this a 6:34", not just "it was".
- **energy.js** — Energy expenditure model.
- **environment.js** — Environmental effects model.
- **index.js** — Computational Rowing Physics Engine — wiring.
- **power.js** — Power production model — critical power (CP) and anaerobic work capacity (W′) estimated from the athlete's own performance history.
- **recovery.js** — Recovery kinetics — continuous decay, never discrete labels.
- **stroke.js** — Stroke dynamics — a six-phase decomposition of the rowing stroke:
- **translation.js** — Erg ↔ boat translation — an explainable chain, never one conversion factor.

## server/regatta/

- **api.js** — Regatta API — strictly own-data; simulations are job-backed and rate-limited. The one deliberate widening: a COACH may put real teammates
- **athleteModel.js** — Race-boat assembly — every lane's state, built from the Digital Twin.
- **environment.js** — Regatta environment — race-day conditions as probability distributions.
- **index.js** — Digital Regatta Simulation Engine — wiring.
- **mcWorker.js** — Worker-thread entry for Monte Carlo regatta simulation. Receives pure data (prepared boat descriptors, environment inputs, seed), returns pure data —
- **monteCarloRegatta.js** — Monte Carlo regatta — thousands of seeded races, one probability picture.
- **race.js** — The discrete-time race engine — one race as a coupled dynamic system.
- **strategy.js** — Race strategy catalog — explicit pacing plans, never implicit behavior.
- **tactics.js** — Tactical race events — optional, probabilistic, documented base rates.
- **whatIf.js** — What-If Lab — modify assumptions, re-simulate, report deltas honestly.

## server/research/

- **analytics.js** — Research analytics engine (Feature C) — the admin-only research platform's computation core. Builds an anonymous per-participant dataset from
- **dictionary.js** — Auto-generated data dictionary (Feature D). Documents every exported field — its meaning, unit, type (measured/derived/estimate), collection method, and
- **export.js** — Research export pipeline (Feature D). Produces fully-anonymized datasets in CSV (Excel-compatible) or JSON, each carrying a reproducibility manifest and
- **quality.js** — Research data-quality framework (Feature B core). Per-record quality control: flag impossible / implausible / incomplete values so analysts can EXCLUDE
- **variables.js** — Standardized research variables (Feature B). Computes the reproducible, well-defined variables an observational study needs from a set of an athlete's

## server/rpos/

- **api.js** — RPOS API — the platform's operator and progress surface.
- **auditTrail.js** — Platform audit trail — every background computation, recorded immutably.
- **docs.js** — Generated documentation — from the LIVE platform, never hand-maintained.
- **index.js** — RowPoint Operating System (RPOS) — wiring.
- **observability.js** — Platform observability — one snapshot of how the machine is running.
- **orchestrator.js** — Orchestrator — operator-grade control over the platform's computation.
- **orgs.js** — Organizations — enterprise groundwork (clubs, schools, national teams).
- **plugins.js** — Plugin framework — the platform's registered-component contract, enforced.

## server/stroke/

- **pipeline.js** — AI Stroke Analysis pipeline (moat #2) — an EXTENSIBLE, modular analysis platform, not a monolithic classifier. Each module implements the same tiny

## server/twin/

- **api.js** — Digital Twin API — strictly own-data.
- **index.js** — Digital Twin engine — wiring.
- **inference.js** — Physiological inference models — observation → latent state.
- **state.js** — The Digital Twin's latent state model.
- **store.js** — Digital Twin persistence: current state, append-only snapshots, and the inference audit trail. All writes go through here so the storage contract


---
_Generated 2026-07-11T07:19:18.160Z by rpos.docs@1.0._
