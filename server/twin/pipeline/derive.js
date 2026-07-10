// Stage 8 — derived metric generation. Cross-category composites computed
// FROM the updated state (never from raw workouts — the state is the source
// of truth downstream of stage 7). These power the API's summary view.
import { getState } from '../store.js';

export const deriveStage = {
  name: 'derive-metrics',
  version: '1.0',
  run(ctx) {
    const state = getState(ctx.userId);
    const val = (cat, v) => state[cat]?.[v]?.value ?? null;
    const conf = (cat, v) => state[cat]?.[v]?.confidence ?? 0;

    // Form: aerobic capacity discounted by current strain risk. Confidence is
    // the weakest link of its inputs — a composite is never more certain than
    // what it is built from.
    const capacity = val('aerobic', 'capacityIndex');
    const risk = val('injuryRisk', 'riskIndex');
    let formIndex = null, formConfidence = null;
    if (capacity !== null) {
      formIndex = Math.round(Math.max(0, Math.min(100, capacity - (risk ?? 0) * 0.3)));
      formConfidence = Math.min(conf('aerobic', 'capacityIndex'), risk !== null ? conf('injuryRisk', 'riskIndex') : 1);
    }

    const summary = {
      formIndex,
      formConfidence: formConfidence !== null ? Math.round(formConfidence * 100) / 100 : null,
      readiness: val('readiness', 'score'),
      strainRisk: risk,
      acwr: val('fatigue', 'acwr'),
      paceTrendSPerWeek: val('adaptation', 'paceTrendSPerWeek'),
    };
    ctx.derived = summary;
    return summary;
  },
};
