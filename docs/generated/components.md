# Registered components

_Generated from the kernel version registry._

Totals: 6 feature · 35 model · 17 algorithm · 12 pipeline-stage · 3 strategy · 0 plugin

| Component | Kind | Version | Description |
|---|---|---|---|
| discovery.cohorts | model | 1.0 | Anonymous cohort summaries over the feature store |
| discovery.feature-store | model | 1.0 | Longitudinal research feature store (weekly derived variables per pseudonym) |
| discovery.hypotheses | algorithm | 1.0 | Automated hypothesis screens: correlations, archetype clustering, plateau analysis |
| discovery.stats-gate | algorithm | 1.0 | Statistical reporting gate: permutation p, bootstrap CI, BH correction, k-anonymity |
| experiments.bayes | algorithm | 1.0 | Beta-Bernoulli hypothesis confidence updating |
| experiments.evaluator | algorithm | 1.0 | A/B outcome evaluation with honest small-n statistics |
| experiments.hypothesis-registry | model | 1.0 | Model assumptions as first-class Bayesian-updated objects |
| experiments.knowledge-graph | model | 1.0 | Versioned knowledge graph of models, assumptions, variables, findings |
| experiments.model-validation | algorithm | 1.0 | Prediction-vs-outcome scoring, calibration, promotion rule |
| experiments.notebook | model | 1.0 | Append-only digital lab notebook |
| experiments.planner | algorithm | 1.0 | Safety-bounded, information-gain-ranked experiment protocols |
| optimizer.counterfactual | algorithm | 1.0 | What-if plan evaluation |
| optimizer.monte-carlo | algorithm | 1.0 | Seeded stochastic plan evaluation |
| optimizer.objectives | model | 1.0 | Multi-objective plan scoring |
| optimizer.pareto | algorithm | 1.0 | Non-dominated sorting + crowding trim |
| optimizer.problem | model | 1.0 | Problem assembly from twin state + analysis |
| optimizer.search.anneal | strategy | 1.0 | Plan search strategy: anneal |
| optimizer.search.beam | strategy | 1.0 | Plan search strategy: beam |
| optimizer.search.genetic | strategy | 1.0 | Plan search strategy: genetic |
| optimizer.sensitivity | algorithm | 1.0 | Scenario perturbation analysis |
| optimizer.simulate | model | 1.0 | Fitness–fatigue impulse-response forward simulator |
| physics.boat | model | 1.0 | Hull drag (P=k·v³, calibrated per class) and boat speed |
| physics.decomposition | model | 1.0 | Performance decomposition against the athlete model |
| physics.energy | model | 1.0 | Mechanical/metabolic work, calories, energy-system split |
| physics.environment | model | 1.0 | Air density, wind, current, water-temperature effects |
| physics.power | model | 1.0 | Critical-power / W′ estimation from the best-effort curve (2-parameter CP model) |
| physics.recovery | model | 1.0 | Multi-system exponential recovery kinetics |
| physics.stroke | model | 1.0 | Six-phase stroke decomposition (force-curve or rate-based) |
| physics.translation | model | 1.0 | Erg ↔ boat translation chain |
| regatta.athlete | model | 1.0 | Race-boat state from the Digital Twin (CP, W′, readiness, variability) + opponent archetypes |
| regatta.environment | model | 1.0 | Race-day conditions as distributions: wind, gusts, current, lanes |
| regatta.monte-carlo | algorithm | 1.0 | Seeded Monte Carlo regatta with sensitivity + median-race replay |
| regatta.race | model | 1.0 | Discrete-time race dynamics: coupled W′-balance, technique fade, hull + air drag |
| regatta.strategy | model | 1.0 | Normalized pacing profiles + opponent tendency blending |
| regatta.tactics | model | 1.0 | Optional probabilistic race events with documented base rates |
| regatta.what-if | algorithm | 1.0 | Bounded assumption modification vs a baseline run |
| rpos.audit-trail | algorithm | 1.0 | Immutable computation_log written on job completion |
| rpos.docs | algorithm | 1.0 | Documentation generated from live registries and schema |
| rpos.observability | algorithm | 1.0 | Platform snapshot + performance-regression watchdog |
| rpos.orchestrator | algorithm | 1.0 | Operator control surface over the kernel job system |
| rpos.organizations | model | 1.0 | Enterprise groundwork: orgs, role-scoped membership, team attachment |
| rpos.plugins | algorithm | 1.0 | Registered-component inventory + startup validation |
| twin.feature.cadence | feature | 1.0 | Features: rate_avg_spm, rate_cv_pct, distance_per_stroke_m |
| twin.feature.heart | feature | 1.0 | Features: hr_avg_bpm, hr_max_bpm, hr_drift_pct, hr_intensity_pct |
| twin.feature.load | feature | 1.1 | Features: duration_min, distance_m, intensity_factor, training_load, work_kj |
| twin.feature.pace | feature | 1.0 | Features: pace_avg_split_s, pace_cv_pct, pace_first_last_delta_s, pace_negative_split |
| twin.feature.power | feature | 1.0 | Features: power_avg_w, power_cv_pct, power_fade_pct, power_source |
| twin.feature.stroke | feature | 1.0 | Features: stroke_count, force_peak_avg, force_smoothness_idx, force_area_cv_pct |
| twin.model.adaptation | model | 1.0 | Digital-twin inference for category "adaptation" |
| twin.model.aerobic | model | 1.0 | Digital-twin inference for category "aerobic" |
| twin.model.anaerobic | model | 1.0 | Digital-twin inference for category "anaerobic" |
| twin.model.consistency | model | 1.0 | Digital-twin inference for category "consistency" |
| twin.model.efficiency | model | 1.0 | Digital-twin inference for category "efficiency" |
| twin.model.endurance | model | 1.0 | Digital-twin inference for category "endurance" |
| twin.model.fatigue | model | 1.0 | Digital-twin inference for category "fatigue" |
| twin.model.injury-risk | model | 1.0 | Digital-twin inference for category "injuryRisk" |
| twin.model.power | model | 1.0 | Digital-twin inference for category "power" |
| twin.model.readiness | model | 1.0 | Digital-twin inference for category "readiness" |
| twin.model.recovery | model | 1.0 | Digital-twin inference for category "recovery" |
| twin.model.technique | model | 1.0 | Digital-twin inference for category "technique" |
| twin.predictor.race | model | 1.0 | Riegel-extrapolated 2k/5k/6k predictions anchored on current 2k fitness |
| twin.stage.clean | pipeline-stage | 1.0 | Twin pipeline stage: clean |
| twin.stage.derive-metrics | pipeline-stage | 1.0 | Twin pipeline stage: derive-metrics |
| twin.stage.extract-features | pipeline-stage | 1.0 | Twin pipeline stage: extract-features |
| twin.stage.infer | pipeline-stage | 1.0 | Twin pipeline stage: infer |
| twin.stage.normalize | pipeline-stage | 1.0 | Twin pipeline stage: normalize |
| twin.stage.refresh-predictions | pipeline-stage | 1.0 | Twin pipeline stage: refresh-predictions |
| twin.stage.refresh-recommendations | pipeline-stage | 1.0 | Twin pipeline stage: refresh-recommendations |
| twin.stage.research-aggregate | pipeline-stage | 1.0 | Twin pipeline stage: research-aggregate |
| twin.stage.sensor-validate | pipeline-stage | 1.0 | Twin pipeline stage: sensor-validate |
| twin.stage.snapshot | pipeline-stage | 1.0 | Twin pipeline stage: snapshot |
| twin.stage.update-state | pipeline-stage | 1.0 | Twin pipeline stage: update-state |
| twin.stage.validate | pipeline-stage | 1.0 | Twin pipeline stage: validate |

---
_Generated 2026-07-11T07:19:18.160Z by rpos.docs@1.0._
