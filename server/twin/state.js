// The Digital Twin's latent state model.
//
// This is the platform's single definition of WHAT we estimate about an
// athlete: twelve physiological/behavioral categories, each holding named
// continuously-evolving variables. Values are Estimates (kernel/estimate.js),
// never bare numbers — every variable carries confidence, uncertainty,
// provenance, evidence count, and the model version that produced it.
//
// Deliberately NOT a copy of database fields: these are hidden quantities
// inferred from observations. The model is additive-extensible — a future
// model registers new variables (or whole categories) without touching
// existing ones, and old snapshots containing retired variables still load
// (unknown entries are preserved, not rejected).

/**
 * category → variable → { label, unit, description, higherIsBetter }
 * `higherIsBetter: null` marks purely descriptive variables with no
 * good/bad direction (the UI shows those without trend coloring).
 */
export const STATE_MODEL = {
  aerobic: {
    capacityIndex: { label: 'Aerobic capacity', unit: 'index 0-100', higherIsBetter: true, description: 'Overall aerobic engine size, indexed from current 2k fitness (85s/500m elite → 100, 135s/500m → 30).' },
    baseSpeed: { label: 'Aerobic base speed', unit: 'm/s', higherIsBetter: true, description: 'Sustainable speed on steady aerobic (UT2/UT1) work over the last 3 weeks.' },
  },
  anaerobic: {
    sprintReserveIndex: { label: 'Sprint reserve', unit: 'index 0-100', higherIsBetter: true, description: 'How much faster than 2k pace the athlete can go on short work — the anaerobic margin above race pace.' },
  },
  recovery: {
    avgRecoveryDays: { label: 'Hard-session spacing', unit: 'days', higherIsBetter: null, description: 'Average days between recent high-intensity sessions.' },
    recoveryHalfLifeH: { label: 'Recovery half-life', unit: 'hours', higherIsBetter: false, description: 'Estimated time to shed half of a session\'s acute fatigue, modulated by sleep and soreness check-ins.' },
  },
  fatigue: {
    acuteLoad: { label: 'Acute load (7d)', unit: 'min', higherIsBetter: null, description: 'Training minutes over the last 7 days.' },
    chronicLoad: { label: 'Chronic load (28d weekly)', unit: 'min/week', higherIsBetter: null, description: 'Average weekly training minutes over the last 28 days.' },
    acwr: { label: 'Acute:chronic ratio', unit: 'ratio', higherIsBetter: null, description: 'Acute vs chronic workload ratio; sustained values ≥1.5 indicate a risky load spike.' },
  },
  efficiency: {
    paceHrIndex: { label: 'Aerobic efficiency', unit: 'm/min per bpm', higherIsBetter: true, description: 'Speed produced per heartbeat on aerobic work — rises as the aerobic system adapts.' },
    hrDriftPct: { label: 'HR drift', unit: '%', higherIsBetter: false, description: 'Average within-session heart-rate drift on recent workouts; rising drift is an early fatigue signal.' },
  },
  consistency: {
    sessionsPerWeek: { label: 'Session frequency', unit: '/week', higherIsBetter: null, description: 'Average sessions per week over the last 28 days.' },
    paceVariability: { label: 'Pace steadiness', unit: 'CV %', higherIsBetter: false, description: 'Within-workout split variability (coefficient of variation) on recent sessions.' },
    scheduleRegularity: { label: 'Schedule regularity', unit: 'index 0-100', higherIsBetter: true, description: 'How evenly training sessions are spaced (100 = metronomic, 0 = highly irregular).' },
  },
  technique: {
    rateDiscipline: { label: 'Rate discipline', unit: 'index 0-100', higherIsBetter: true, description: 'How steadily stroke rate is held within workouts.' },
    distancePerStroke: { label: 'Distance per stroke', unit: 'm', higherIsBetter: true, description: 'Meters travelled per stroke on recent work — a length/effectiveness proxy.' },
    strokeSmoothness: { label: 'Stroke smoothness', unit: 'index 0-100', higherIsBetter: true, description: 'Force-curve smoothness when force data exists; wide uncertainty otherwise.' },
  },
  power: {
    criticalPowerW: { label: 'Critical power', unit: 'W', higherIsBetter: true, description: 'Estimated highest sustainable mechanical power (from measured watts when present, otherwise pace-derived).' },
    wPrimeJ: { label: 'Anaerobic work capacity (W\')', unit: 'J', higherIsBetter: true, description: 'Finite work reserve above critical power. Phase-1 estimate is mass-scaled; refined by the physics engine.' },
  },
  endurance: {
    longestSessionMin: { label: 'Longest session', unit: 'min', higherIsBetter: true, description: 'Longest single session on record.' },
    enduranceIndex: { label: 'Endurance base', unit: 'index 0-100', higherIsBetter: true, description: 'Composite of weekly volume and long-session tolerance.' },
  },
  readiness: {
    score: { label: 'Training readiness', unit: '0-100', higherIsBetter: true, description: 'Readiness to absorb a hard session today (load, spacing, HR trend, wellness). A training-load estimate, not a medical assessment.' },
  },
  adaptation: {
    paceTrendSPerWeek: { label: 'Pace trend', unit: 's/500m per week', higherIsBetter: false, description: 'Slope of steady-state pace over the last 8 weeks; negative = getting faster.' },
    plateauRisk: { label: 'Plateau risk', unit: 'index 0-100', higherIsBetter: false, description: 'Risk that current training has stopped producing adaptation (monotony + flat pace trend).' },
  },
  injuryRisk: {
    loadSpikeIndex: { label: 'Load-spike risk', unit: 'index 0-100', higherIsBetter: false, description: 'Risk contribution from ramping load faster than the chronic base.' },
    monotonyIndex: { label: 'Monotony', unit: 'index 0-100', higherIsBetter: false, description: 'How concentrated training is in a single intensity zone.' },
    riskIndex: { label: 'Combined strain risk', unit: 'index 0-100', higherIsBetter: false, description: 'Composite of load spike, intensity stacking, monotony, and drift signals.' },
  },
};

export const CATEGORIES = Object.keys(STATE_MODEL);

/** Flat list of { category, variable, ...meta } for registries and docs. */
export function allVariables() {
  const out = [];
  for (const [category, vars] of Object.entries(STATE_MODEL)) {
    for (const [variable, meta] of Object.entries(vars)) out.push({ category, variable, ...meta });
  }
  return out;
}

export function variableMeta(category, variable) {
  return STATE_MODEL[category]?.[variable] || null;
}
