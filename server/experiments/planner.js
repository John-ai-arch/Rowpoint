// Experiment planner — low-risk, information-rich protocols for consenting
// athletes.
//
// Selection principle (active learning): target the hypothesis whose
// posterior is most uncertain (confidence nearest 0.5) among those the
// athlete is eligible for — maximum expected information gain per unit of
// athlete time. Safety principle: a protocol may only prescribe session
// types and durations the athlete has ALREADY demonstrated (their observed
// training envelope), plus explicit stopping conditions checked on every
// twin update. Experiments never increase risk to learn faster.
import { db } from '../db.js';
import { uuid, now, safeJson } from '../util.js';
import { providersOf } from '../kernel/providers.js';
import { buildTrainingAnalysis } from '../ai/trainingAnalysis.js';
import { listHypotheses } from './hypothesisRegistry.js';
import { hypothesisUncertainty } from './bayes.js';
import { appendNotebook } from './notebook.js';

export const PLANNER_VERSION = 'experiments.planner@1.0';

/** Protocol templates. Each targets one hypothesis with an A/B contrast. */
export const TEMPLATES = {
  'rest-interval-quality': {
    hypothesisId: 'longer-rest-interval-quality',
    title: 'Interval rest: 60s vs 120s',
    objective: 'Does doubling rest between hard 500m repetitions improve pace consistency within the session?',
    durationDays: 28,
    outcomeMeasure: 'Within-session pace CV on interval workouts (feature pace_cv_pct), arm A weeks vs arm B weeks.',
    arms: {
      A: 'Weeks 1–2: interval sessions with ~60s rest between repetitions.',
      B: 'Weeks 3–4: the same interval sessions with ~120s rest.',
    },
    requiresZone: 'threshold',
    inclusion: { minWorkouts28d: 8, minIntervalSessions: 2 },
  },
  'steady-volume-block': {
    hypothesisId: 'steady-volume-aerobic',
    title: 'Steady-volume emphasis block',
    objective: 'Does a 20% shift of existing training time toward UT2 change aerobic efficiency (pace per heartbeat)?',
    durationDays: 28,
    outcomeMeasure: 'Aerobic efficiency (twin efficiency.paceHrIndex) trend, block vs the athlete\'s prior 4 weeks.',
    arms: {
      A: 'Your prior 4 weeks (baseline — already recorded).',
      B: 'Weeks 1–4: same total time, ~20% more of it as steady UT2.',
    },
    requiresZone: 'ut2',
    inclusion: { minWorkouts28d: 10, needsHr: true },
  },
  'hard-session-spacing': {
    hypothesisId: 'recovery-half-life',
    title: 'Hard-session spacing: 48h vs 72h',
    objective: 'Does an extra recovery day between hard sessions change performance on the second session?',
    durationDays: 28,
    outcomeMeasure: 'Relative pace on the second hard session of each pair (48h-spaced vs 72h-spaced pairs).',
    arms: {
      A: 'Weeks 1–2: hard sessions spaced ~48h apart.',
      B: 'Weeks 3–4: hard sessions spaced ~72h apart.',
    },
    requiresZone: 'threshold',
    inclusion: { minWorkouts28d: 8, minHardPerWeek: 2 },
  },
};

/** Stopping conditions — evaluated on every twin update for active experiments. */
export const STOPPING_CONDITIONS = [
  { key: 'low-readiness', description: 'Training readiness falls below 40.', check: (state) => (state.readiness?.score?.value ?? 100) < 40 },
  { key: 'high-strain', description: 'Combined strain risk exceeds 60.', check: (state) => (state.injuryRisk?.riskIndex?.value ?? 0) > 60 },
  { key: 'overtraining-flag', description: 'The analysis engine raises its overtraining guardrail.', check: (state, analysis) => !!analysis?.constraints?.overtrainingRisk },
];

function twinState(userId) {
  const provider = providersOf('twin.state-access')[0];
  return provider ? provider.getState(userId) : {};
}

/** Athlete's observed training envelope — the safety boundary. */
function observedEnvelope(analysis) {
  const zones = Object.entries(analysis.distribution28d?.zoneMinutes || {})
    .filter(([, min]) => min > 0).map(([z]) => z);
  return {
    zones,
    maxSessionMinutes: Math.max(30, Math.round(analysis.prs?.longestMinutes || 45)),
    sessionsPerWeek: Math.round((analysis.volume?.last28d?.sessions || 0) / 4),
  };
}

/**
 * Eligibility of one athlete for one template — every failure named.
 */
export function checkEligibility(template, analysis, state) {
  const reasons = [];
  const envelope = observedEnvelope(analysis);
  const inc = template.inclusion;
  const workouts28 = analysis.volume?.last28d?.sessions || 0;
  if (workouts28 < inc.minWorkouts28d) reasons.push(`needs ≥${inc.minWorkouts28d} workouts in the last 28 days (has ${workouts28})`);
  if (inc.needsHr && (analysis.heartRate?.workoutsWithHr || 0) < 6) reasons.push('needs regular heart-rate data');
  if (inc.minHardPerWeek && (analysis.recovery?.hardSessionsLast7d || 0) < inc.minHardPerWeek) reasons.push(`needs ≥${inc.minHardPerWeek} hard sessions/week already`);
  if (template.requiresZone && !envelope.zones.includes(template.requiresZone)) {
    reasons.push(`prescribes ${template.requiresZone} work the athlete has not already been doing — outside the observed envelope`);
  }
  if ((state.injuryRisk?.riskIndex?.value ?? 0) > 40) reasons.push('current strain risk too high to start an experiment');
  if (analysis.constraints?.overtrainingRisk) reasons.push('overtraining signals present');
  return { eligible: reasons.length === 0, reasons, envelope };
}

/**
 * Propose the most informative eligible experiment for a consenting athlete.
 * Returns the created experiment row (status 'proposed') or an explanation.
 */
export function proposeExperiment(user, { templateKey = null } = {}) {
  if (user.experiment_consent !== 'active') {
    return { proposed: false, reason: 'Experiment participation is not enabled (Settings → Research & experiments).' };
  }
  const open = db.prepare("SELECT id FROM experiments WHERE user_id = ? AND status IN ('proposed','active')").get(user.id);
  if (open) return { proposed: false, reason: 'An experiment is already proposed or running.' };

  const analysis = buildTrainingAnalysis(user);
  const state = twinState(user.id);
  const hypotheses = new Map(listHypotheses().map(h => [h.id, h]));

  // Rank templates by hypothesis uncertainty (max expected information gain).
  const candidates = Object.entries(TEMPLATES)
    .filter(([key]) => !templateKey || key === templateKey)
    .map(([key, tpl]) => ({
      key, tpl,
      uncertainty: hypothesisUncertainty(hypotheses.get(tpl.hypothesisId)?.confidence ?? 0.5),
      eligibility: checkEligibility(tpl, analysis, state),
    }))
    .sort((a, b) => b.uncertainty - a.uncertainty);

  const pick = candidates.find(c => c.eligibility.eligible);
  if (!pick) {
    return {
      proposed: false,
      reason: 'No experiment currently fits your training safely.',
      details: candidates.map(c => ({ template: c.key, blockedBy: c.eligibility.reasons })),
    };
  }

  const protocol = {
    version: PLANNER_VERSION,
    template: pick.key,
    title: pick.tpl.title,
    objective: pick.tpl.objective,
    hypothesisId: pick.tpl.hypothesisId,
    hypothesisStatement: hypotheses.get(pick.tpl.hypothesisId)?.statement,
    arms: pick.tpl.arms,
    durationDays: pick.tpl.durationDays,
    outcomeMeasure: pick.tpl.outcomeMeasure,
    expectedInformationGain: Math.round(pick.uncertainty * 100) / 100,
    envelope: pick.eligibility.envelope,
    stoppingConditions: STOPPING_CONDITIONS.map(s => s.description).concat(['You stop or pause participation at any time — no questions asked.']),
    safetyNote: 'This protocol only rearranges training you already do; it never adds intensity or volume beyond your recorded envelope.',
  };
  const id = uuid();
  db.prepare(`INSERT INTO experiments (id, user_id, hypothesis_id, template, protocol_json, status, created_at)
      VALUES (?,?,?,?,?,'proposed',?)`)
    .run(id, user.id, pick.tpl.hypothesisId, pick.key, JSON.stringify(protocol), now());
  appendNotebook('experiment-proposed', id, {
    template: pick.key, hypothesisId: pick.tpl.hypothesisId,
    expectedInformationGain: protocol.expectedInformationGain,
    confidenceBefore: hypotheses.get(pick.tpl.hypothesisId)?.confidence,
  });
  return { proposed: true, experimentId: id, protocol };
}

/** Stop an active experiment if any stopping condition fires. */
export function checkStoppingConditions(userId) {
  const exp = db.prepare("SELECT * FROM experiments WHERE user_id = ? AND status = 'active'").get(userId);
  if (!exp) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const state = twinState(userId);
  const analysis = buildTrainingAnalysis(user);
  for (const cond of STOPPING_CONDITIONS) {
    if (cond.check(state, analysis)) {
      db.prepare("UPDATE experiments SET status = 'stopped', stop_reason = ? WHERE id = ?").run(cond.key, exp.id);
      appendNotebook('experiment-stopped', exp.id, { reason: cond.key, description: cond.description, automatic: true });
      return { stopped: true, reason: cond.key };
    }
  }
  return { stopped: false };
}

export function presentExperiment(row) {
  return {
    id: row.id,
    status: row.status,
    template: row.template,
    protocol: safeJson(row.protocol_json, {}),
    startedAt: row.started_at,
    endsAt: row.ends_at,
    outcome: safeJson(row.outcome_json, null),
    stopReason: row.stop_reason,
    createdAt: row.created_at,
  };
}
