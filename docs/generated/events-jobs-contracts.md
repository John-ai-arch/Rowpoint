# Event catalog

_Generated from the kernel event bus._

| Event | Subscribers |
|---|---|
| experiment.updated | — |
| job.completed | rpos-audit |
| job.failed | rpos-audit |
| optimization.completed | — |
| prediction.completed | — |
| race.result-recorded | regatta |
| recommendation.generated | — |
| research.finding-reviewed | experiments |
| research.snapshot | discovery |
| twin.updated | experiments |
| workout.corrected | twin |
| workout.deleted | twin |
| workout.saved | twin, optimizer, experiments |

# Provider contracts

| Contract | Providers |
|---|---|
| ai.suggestion-advisor | experiments |
| regatta.boat-physics | physics |
| twin.inference-model | physics-power |
| twin.state-access | twin |

# Job kinds

- discovery.run
- experiments.evaluate
- optimizer.run
- regatta.simulate
- twin.rebuild
- twin.update

---
_Generated 2026-07-11T07:19:18.160Z by rpos.docs@1.0._
