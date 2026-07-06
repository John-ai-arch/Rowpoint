// AI coach — LLM-powered workout recommendations.
//
// The pipeline: trainingAnalysis.js turns the athlete's complete history into
// a structured picture (volume, zone distribution, HR trends, pace
// progression, recovery, compliance, risk flags); this module sends that
// picture to Claude with a rowing-coach system prompt and a strict JSON output
// schema, and gets back a personalized recommendation with a full coaching
// explanation. Two safety guardrails are enforced in code regardless of what
// the model says: a coach's explicit assignment for today always wins, and a
// detected overtraining pattern always produces a rest recommendation.
//
// When no ANTHROPIC_API_KEY is configured (or the API call fails), the
// analysis-engine fallback produces the recommendation instead. It reasons
// over the same analysis — two athletes with different histories still get
// different recommendations — but its text is assembled from the data rather
// than written by a model, and it is labeled `source: "analysis_engine"` so
// the UI never presents engine output as LLM output.
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { config } from '../config.js';
import { logger } from '../log.js';
import { fmtSplit } from '../util.js';
import { validatePlan } from './planValidation.js';
import { ZONE_DESCRIPTIONS } from './trainingAnalysis.js';

const log = logger('ai-coach');

export const CATEGORIES = [
  'rest', 'recovery_row', 'steady_state', 'long_aerobic', 'threshold_intervals',
  'vo2max_intervals', 'sprint_intervals', 'race_pace', 'technique', 'return_easy',
  'cross_training', 'coach_assignment',
];

const CATEGORY_LABEL = {
  rest: 'Rest day',
  recovery_row: 'Recovery row',
  steady_state: 'Steady state',
  long_aerobic: 'Long aerobic row',
  threshold_intervals: 'Threshold intervals',
  vo2max_intervals: 'VO2max intervals',
  sprint_intervals: 'Sprint work',
  race_pace: 'Race-pace work',
  technique: 'Technique session',
  return_easy: 'Easy return session',
  cross_training: 'Cross training',
  coach_assignment: 'Coach-assigned workout',
};

/* ------------------------------------------------------------------ */
/* Anthropic client (lazy singleton)                                    */
/* ------------------------------------------------------------------ */

let _client = null;
function client() {
  if (!config.anthropicApiKey) return null;
  if (!_client) {
    _client = new Anthropic({
      apiKey: config.anthropicApiKey,
      timeout: 90_000,
      maxRetries: 1,
    });
  }
  return _client;
}

export const llmConfigured = () => !!config.anthropicApiKey;

/* ------------------------------------------------------------------ */
/* Output schema — the contract between the model and the app           */
/* ------------------------------------------------------------------ */

const RECOMMENDATION_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES.filter(c => c !== 'coach_assignment') },
    restDay: { type: 'boolean' },
    title: { type: 'string', description: 'Short workout title, e.g. "3 × 10:00 threshold @ r24-26"' },
    workout: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Precise session prescription: warm-up, main set, cool-down.' },
        durationMinutesLow: { type: 'integer' },
        durationMinutesHigh: { type: 'integer' },
        intensity: { type: 'string', enum: ['rest', 'very_low', 'low', 'moderate', 'high', 'very_high'] },
        targetPaceSPer500m: { type: ['number', 'null'], description: 'Target split in seconds per 500m, or null if pace-agnostic.' },
        targetHrPctLow: { type: ['integer', 'null'], description: 'Lower bound of target HR as % of max, or null.' },
        targetHrPctHigh: { type: ['integer', 'null'] },
        targetStrokeRate: { type: ['string', 'null'], description: 'e.g. "18-20" or null' },
        plan: {
          type: ['object', 'null'],
          description: 'Machine-programmable plan. For steady work: {"type":"time","durationS":N} or {"type":"distance","distanceM":N}. For intervals: {"type":"intervals","intervals":[{"workType":"time","workTimeS":N,"restTimeS":N}...]} (max 30 intervals). null for rest days.',
          properties: {
            type: { type: 'string', enum: ['time', 'distance', 'intervals', 'justrow'] },
            durationS: { type: ['integer', 'null'] },
            distanceM: { type: ['integer', 'null'] },
            intervals: {
              type: ['array', 'null'],
              items: {
                type: 'object',
                properties: {
                  workType: { type: 'string', enum: ['time', 'distance', 'calories'] },
                  workTimeS: { type: ['integer', 'null'] },
                  workDistanceM: { type: ['integer', 'null'] },
                  workCalories: { type: ['integer', 'null'] },
                  restTimeS: { type: ['integer', 'null'] },
                },
                required: ['workType'],
                additionalProperties: false,
              },
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
      required: ['description', 'durationMinutesLow', 'durationMinutesHigh', 'intensity',
        'targetPaceSPer500m', 'targetHrPctLow', 'targetHrPctHigh', 'targetStrokeRate', 'plan'],
      additionalProperties: false,
    },
    explanation: { type: 'string', description: '2-4 sentences of coaching voice addressed to the athlete explaining the session.' },
    whyAppropriate: { type: 'string', description: 'Why THIS athlete needs THIS session now, citing specific numbers from their data.' },
    targetSystem: { type: 'string', description: 'Physiological system targeted (e.g. aerobic base / lactate threshold / VO2max / anaerobic capacity / recovery).' },
    expectedAdaptations: { type: 'string', description: 'What repeated sessions like this develop.' },
    recoveryAdvice: { type: 'string', description: 'How to recover after this session and what tomorrow should look like.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    keyFactors: {
      type: 'array', maxItems: 6,
      items: { type: 'string' },
      description: 'The data points from the analysis that most drove this recommendation.',
    },
    alternative: {
      type: ['object', 'null'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
  },
  required: ['category', 'restDay', 'title', 'workout', 'explanation', 'whyAppropriate',
    'targetSystem', 'expectedAdaptations', 'recoveryAdvice', 'confidence', 'keyFactors', 'alternative'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are an experienced rowing coach writing today's training recommendation for one athlete inside the RowPoint training app.

You receive a structured JSON analysis of the athlete's complete training history: volume trends, training-zone distribution (${Object.values(ZONE_DESCRIPTIONS).join('; ')}), workout structure mix, heart-rate trends (drift, aerobic efficiency), pace progression, recovery spacing, personal records, wellness check-ins, compliance with previous recommendations, and risk flags.

Reason like a coach:
- Look for imbalances before prescribing: too much of one zone, missing zones, stacked hard days, thin aerobic base, ramping load, declining efficiency.
- If the athlete has done almost exclusively steady/aerobic work for weeks and is recovered, prescribe quality: threshold, VO2max, race-pace, or sprint work appropriate to their goal.
- If recent weeks are dense with hard sessions, prescribe recovery or easy aerobic volume.
- If they have not trained for several days, prescribe a sensible return session, never a maximal one.
- If heart-rate data shows high drift or declining aerobic efficiency, favor aerobic development.
- If they are preparing for a 2k test or race (goal type race_prep, or a near target date), bias toward sessions that build 2k performance, sharpening as the event approaches.
- Respect wellness signals (short sleep, high soreness, stress).
- Use their real numbers: prescribe target splits from their actual 2k split and recent paces, target HR from their max HR. Never invent a PR or a pace they have not shown.
- The pacing habit field tells you whether they chronically start pieces too hard — when true, include a pacing cue.
- If total history is thin, keep it conservative and say the plan will sharpen as they log more sessions.

Practical constraints:
- The workout plan must be programmable on a Concept2-style monitor: time pieces 20s-9h, distance pieces 100m-50km, at most 30 intervals, interval rest 0-595s.
- durationMinutesLow/High is the whole session including warm-up and cool-down.
- Write in second person, encouraging but concrete. No hedging boilerplate, no medical claims.
- whyAppropriate must cite at least two concrete numbers from the analysis.`;

/* ------------------------------------------------------------------ */
/* Main entry                                                           */
/* ------------------------------------------------------------------ */

/**
 * Generate today's recommendation from a training analysis.
 * Returns a recommendation object (see RECOMMENDATION_SCHEMA) plus
 * { source, guardrail? } metadata. Never throws.
 */
export async function generateRecommendation(analysis) {
  // Guardrail 1: never compete with an explicit coach assignment for today.
  if (analysis.constraints?.hasCoachAssignmentToday) {
    return coachAssignmentRecommendation();
  }

  let rec = null;
  if (llmConfigured()) {
    try {
      rec = await llmRecommendation(analysis);
    } catch (e) {
      log.error(`LLM recommendation failed, using analysis engine fallback: ${e.message}`);
    }
  }
  if (!rec) rec = fallbackRecommendation(analysis);

  // Guardrail 2: a detected overtraining pattern always yields rest/recovery,
  // even if the model (or engine) suggested otherwise.
  if (analysis.constraints?.overtrainingRisk && !rec.restDay && rec.category !== 'recovery_row') {
    const forced = restRecommendation(analysis);
    forced.source = rec.source;
    forced.guardrail = 'overtraining_risk_override';
    return forced;
  }
  return rec;
}

/* ------------------------------------------------------------------ */
/* LLM path                                                             */
/* ------------------------------------------------------------------ */

async function llmRecommendation(analysis) {
  const anthropic = client();
  const started = Date.now();
  const response = await anthropic.messages.parse({
    model: config.anthropicModel,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Here is today's analysis for the athlete. Produce today's recommendation.\n\n${JSON.stringify(analysis)}`,
    }],
    output_config: { format: jsonSchemaOutputFormat(RECOMMENDATION_SCHEMA) },
  });

  if (response.stop_reason === 'refusal') throw new Error('Model declined the request.');
  const rec = response.parsed_output;
  if (!rec) throw new Error('Empty or unparsable model response');

  const normalized = normalizeRecommendation(rec, analysis);
  log.info(`LLM recommendation generated in ${Date.now() - started}ms `
    + `(category=${normalized.category}, in=${response.usage?.input_tokens}, out=${response.usage?.output_tokens})`);
  normalized.source = 'llm';
  normalized.model = response.model;
  return normalized;
}

/** Validate/repair the model output so nothing un-programmable reaches the UI. */
function normalizeRecommendation(rec, analysis) {
  const out = { ...rec };
  out.category = CATEGORIES.includes(out.category) ? out.category : 'steady_state';
  out.restDay = !!out.restDay || out.category === 'rest';
  out.title = String(out.title || CATEGORY_LABEL[out.category]).slice(0, 120);
  out.confidence = ['low', 'medium', 'high'].includes(out.confidence) ? out.confidence : 'medium';
  out.keyFactors = Array.isArray(out.keyFactors) ? out.keyFactors.slice(0, 6).map(f => String(f).slice(0, 200)) : [];

  const w = out.workout || {};
  let lo = clampInt(w.durationMinutesLow, 0, 240, 30);
  let hi = clampInt(w.durationMinutesHigh, 0, 300, Math.max(45, lo));
  if (hi < lo) [lo, hi] = [hi, lo];
  out.workout = {
    description: String(w.description || '').slice(0, 1500),
    durationMinutes: out.restDay ? null : [lo, hi],
    intensity: ['rest', 'very_low', 'low', 'moderate', 'high', 'very_high'].includes(w.intensity)
      ? w.intensity : (out.restDay ? 'rest' : 'moderate'),
    targetPaceSPer500m: Number.isFinite(w.targetPaceSPer500m) && w.targetPaceSPer500m > 60 && w.targetPaceSPer500m < 300
      ? Math.round(w.targetPaceSPer500m * 10) / 10 : null,
    targetHrPct: Number.isFinite(w.targetHrPctLow) && Number.isFinite(w.targetHrPctHigh)
      ? [clampInt(w.targetHrPctLow, 40, 100, 60), clampInt(w.targetHrPctHigh, 40, 100, 75)] : null,
    targetStrokeRate: w.targetStrokeRate ? String(w.targetStrokeRate).slice(0, 20) : null,
    plan: null,
  };
  // Only accept a machine plan that passes the same validation the builder uses.
  if (!out.restDay && w.plan && validatePlan(w.plan).ok) out.workout.plan = w.plan;
  if (!out.restDay && !out.workout.plan) out.workout.plan = defaultPlanFor(out.category, lo, hi, analysis);

  for (const k of ['explanation', 'whyAppropriate', 'targetSystem', 'expectedAdaptations', 'recoveryAdvice']) {
    out[k] = String(out[k] || '').slice(0, 1500);
  }
  if (out.alternative && (!out.alternative.title || !out.alternative.description)) out.alternative = null;
  return out;
}

/* ------------------------------------------------------------------ */
/* Analysis-engine fallback (no LLM configured / LLM error)             */
/* ------------------------------------------------------------------ */

/**
 * Deterministic recommendation derived from the SAME training analysis the
 * LLM sees. This is not a canned template set: category, dosage, and the
 * cited reasons all come from the athlete's actual data, so different
 * histories produce different recommendations and the same athlete's
 * recommendation evolves as their history changes.
 */
export function fallbackRecommendation(analysis) {
  const a = analysis;
  const factors = [];
  const d = a.distribution28d || {};
  const rec = a.recovery || {};
  const vol = a.volume || {};
  const hr = a.heartRate || {};
  const goal = a.athlete?.goal || { type: 'general_fitness' };
  const twoKSplit = a.athlete?.best2kSplitS || null;

  const pick = (category, mins, intensity, why) => finalize({
    category, mins, intensity, why, factors, analysis: a,
  });

  // 1. Sustained overtraining signal → rest (also enforced by the guardrail).
  if (a.constraints?.overtrainingRisk) {
    return restRecommendation(a);
  }

  // 2. Returning after a break: easy re-entry, never a max session.
  if (rec.daysSinceLastWorkout !== null && rec.daysSinceLastWorkout >= 5) {
    factors.push(`${rec.daysSinceLastWorkout} days since your last session`);
    return pick('return_easy', [25, 40], 'low',
      `After ${rec.daysSinceLastWorkout} days off, the first session back should re-open the engine, not test it. Easy continuous rowing at conversation pace, focusing on length and rhythm.`);
  }

  // 3. Dense hard work recently → recovery.
  if (rec.hardSessionsLast7d >= 3 || (vol.acuteChronicRatio !== null && vol.acuteChronicRatio >= 1.5)) {
    if (rec.hardSessionsLast7d >= 3) factors.push(`${rec.hardSessionsLast7d} hard sessions in the last 7 days`);
    if (vol.acuteChronicRatio >= 1.5) factors.push(`this week's load is ${vol.acuteChronicRatio}× your 4-week average`);
    return pick('recovery_row', [20, 40], 'very_low',
      `Your recent training is front-loaded with intensity — the adaptation happens when you absorb it. Very easy rowing, nose-breathing pace, and stop while it still feels easy.`);
  }

  // 4. High HR drift / declining aerobic efficiency → aerobic development.
  if (hr.driftRecentPct !== null && hr.driftRecentPct >= 6) {
    factors.push(`average HR drift of +${hr.driftRecentPct}% within recent sessions`);
    return pick('steady_state', [40, 60], 'low',
      `Your heart rate is drifting upward noticeably within sessions (+${hr.driftRecentPct}% second half vs first), which points at aerobic durability as the limiter. Steady low-intensity work is what fixes that.`);
  }
  if (hr.aerobicEfficiencyTrend === 'declining') {
    factors.push('aerobic efficiency (speed per heartbeat) trending down');
    return pick('steady_state', [40, 60], 'low',
      'Your speed per heartbeat on aerobic work has slipped recently. A block of relaxed steady-state rebuilds the base that everything else sits on.');
  }

  // 5. Race prep close to the event → race-pace specificity.
  if (goal.type === 'race_prep' && goal.daysToEvent !== null && goal.daysToEvent >= 0 && goal.daysToEvent <= 21) {
    factors.push(`${goal.daysToEvent} days to your target event`);
    const paceTxt = twoKSplit ? ` at your goal 2k split (~${fmtSplit(twoKSplit)}/500m)` : '';
    return pick('race_pace', [35, 50], 'high',
      `With ${goal.daysToEvent} days to your event, specificity matters most: short race-pace pieces${paceTxt} with full recovery, rehearsing your start and your pacing plan.`);
  }

  // 6. Distribution gaps: monotone steady-state → quality; monotone intensity → base.
  const totalZoneMin = Object.values(d.zoneMinutes || {}).reduce((x, y) => x + y, 0);
  if (totalZoneMin >= 120) {
    if (d.aerobicPct >= 85 && rec.hardSessionsLast7d <= 1) {
      factors.push(`${d.aerobicPct}% of the last four weeks was low-intensity aerobic work`);
      // Rotate the quality prescription with history so it evolves: threshold
      // first, VO2 once threshold has been visited, sprints for race-prep.
      const missing = d.missingZones || [];
      if (goal.type === 'race_prep' && missing.includes('sprint') && !missing.includes('vo2')) {
        factors.push('no sprint work logged in four weeks');
        return pick('sprint_intervals', [30, 45], 'very_high',
          'Your aerobic base is well established and race prep needs top-end speed: short sprint intervals with long recoveries add the anaerobic edge your recent training completely lacks.');
      }
      if (missing.includes('vo2') && !missing.includes('threshold')) {
        factors.push('threshold visited recently, VO2max untouched');
        return pick('vo2max_intervals', [35, 50], 'very_high',
          'You have steady volume and some threshold work banked, but nothing near VO2max in four weeks — hard 3–5 minute intervals are the missing stimulus for your ceiling.');
      }
      factors.push(`only ${100 - d.aerobicPct}% of recent training above aerobic intensity`);
      return pick('threshold_intervals', [40, 60], 'high',
        'Weeks of almost exclusively steady rowing have built a solid base — now it needs a roof. Sustained threshold intervals raise the pace you can hold without blowing up.');
    }
    if (d.anaerobicPct >= 55) {
      factors.push(`${d.anaerobicPct}% of recent minutes at threshold intensity or above`);
      return pick('long_aerobic', [50, 75], 'low',
        `More than half of your recent training is at threshold or above — the ratio is inverted. A longer easy aerobic row restores the 80/20 balance that makes the hard days count.`);
    }
  }

  // 7. Undertraining: not enough volume to progress.
  if (a.flags?.undertraining) {
    factors.push(`only ${vol.last28d?.minutes ?? 0} training minutes in the last four weeks`);
    return pick('steady_state', [30, 45], 'moderate',
      'Your recent volume is below where adaptations happen. A comfortable steady session is the highest-value thing today — consistency first, intensity later.');
  }

  // 8. Balanced athlete → goal-directed pick, alternating base and quality
  //    based on spacing since the last hard session.
  const dueForHard = rec.daysSinceLastHard === null || rec.daysSinceLastHard >= 2;
  if (goal.type === 'race_prep' && dueForHard) {
    factors.push(rec.daysSinceLastHard === null ? 'no hard sessions on record yet' : `${rec.daysSinceLastHard} days since your last hard session`);
    return pick('threshold_intervals', [40, 60], 'high',
      'Your training is balanced and you are recovered from the last hard effort — a quality threshold session moves your race pace forward.');
  }
  if (!dueForHard) factors.push(`last hard session was only ${rec.daysSinceLastHard} day(s) ago`);
  factors.push(`goal: ${goal.type.replaceAll('_', ' ')}`);
  const mins = goal.type === 'weight_class' ? [45, 70] : [35, 60];
  return pick('steady_state', mins, goal.type === 'return_from_injury' ? 'very_low' : 'low',
    dueForHard
      ? 'Steady aerobic work is the backbone of your goal — relaxed pace, consistent rhythm, and let the fitness compound.'
      : 'You went hard recently, so today banks easy aerobic volume while that session settles in.');
}

/** Assemble a full recommendation object around a fallback decision. */
function finalize({ category, mins, intensity, why, factors, analysis }) {
  const a = analysis;
  const twoKSplit = a.athlete?.best2kSplitS || null;
  const target = targetForCategory(category, twoKSplit, a);
  const [lo, hi] = mins;
  const desc = buildSessionDescription(category, lo, hi, target);
  return {
    category,
    restDay: false,
    title: CATEGORY_LABEL[category],
    workout: {
      description: desc,
      durationMinutes: mins,
      intensity,
      targetPaceSPer500m: target.paceS,
      targetHrPct: target.hrPct,
      targetStrokeRate: target.rate,
      plan: defaultPlanFor(category, lo, hi, a),
    },
    explanation: why + (a.pacingHabit?.chronicStartsTooHard
      ? ' One habit to watch: you consistently start pieces faster than you finish them — hold your target for the first quarter even if it feels too easy.'
      : ''),
    whyAppropriate: buildWhy(a, factors),
    targetSystem: TARGET_SYSTEM[category],
    expectedAdaptations: ADAPTATIONS[category],
    recoveryAdvice: RECOVERY_ADVICE[category],
    confidence: a.history?.totalWorkouts >= 8 ? 'high' : a.history?.totalWorkouts >= 3 ? 'medium' : 'low',
    keyFactors: factors.slice(0, 6),
    alternative: ALTERNATIVES[category] || null,
    source: 'analysis_engine',
  };
}

export function restRecommendation(analysis) {
  const w = analysis.wellness || {};
  const factors = [];
  if (w.lowSleepHighSorenessDays >= 3) factors.push(`${w.lowSleepHighSorenessDays} recent days of short sleep combined with high soreness`);
  if (analysis.recovery?.hardSessionsLast7d >= 3) factors.push(`${analysis.recovery.hardSessionsLast7d} hard sessions in the last 7 days`);
  if (analysis.volume?.acuteChronicRatio >= 1.5) factors.push(`weekly load ${analysis.volume.acuteChronicRatio}× your 4-week average`);
  if (analysis.heartRate?.driftRecentPct >= 6) factors.push(`HR drift of +${analysis.heartRate.driftRecentPct}% within recent sessions`);
  return {
    category: 'rest',
    restDay: true,
    title: 'Rest day',
    workout: {
      description: 'No rowing today. Light walking or gentle stretching only.',
      durationMinutes: null, intensity: 'rest',
      targetPaceSPer500m: null, targetHrPct: null, targetStrokeRate: null, plan: null,
    },
    explanation: 'Your recent training and recovery signals together point one way: today the smartest training decision is rest. The work you have already done only turns into fitness when you let it.',
    whyAppropriate: buildWhy(analysis, factors.length ? factors : ['overtraining risk flags in your recent data']),
    targetSystem: 'Recovery — parasympathetic rebound, muscle repair, glycogen restoration.',
    expectedAdaptations: 'Supercompensation: the adaptations from your recent hard work consolidate, and injury/illness risk drops.',
    recoveryAdvice: 'Prioritize sleep tonight. If the pattern of short sleep and high soreness continues several more days, it is worth mentioning to your coach or a medical professional — this is not a clinical assessment.',
    confidence: 'high',
    keyFactors: factors.slice(0, 6),
    alternative: { title: '20:00 mobility & light spin', description: 'If total rest feels wrong, 20 minutes of easy cross-training or mobility work at a heart rate under 60% of max.' },
    healthPrompt: true,
    source: 'analysis_engine',
  };
}

function coachAssignmentRecommendation() {
  return {
    category: 'coach_assignment',
    restDay: false,
    title: 'Your coach-assigned workout',
    workout: {
      description: 'Do the workout your coach assigned for today — check your assigned workouts list.',
      durationMinutes: null, intensity: null,
      targetPaceSPer500m: null, targetHrPct: null, targetStrokeRate: null, plan: null,
    },
    explanation: 'Your coach has already planned your training for today — that workout comes first. RowPoint only suggests extra work on days your coach has not planned.',
    whyAppropriate: 'A coach assignment for today exists and has not been completed; the AI never competes with your coach\'s plan.',
    targetSystem: 'As prescribed by your coach.',
    expectedAdaptations: 'As prescribed by your coach.',
    recoveryAdvice: 'Follow your coach\'s guidance for the rest of the day.',
    confidence: 'high',
    keyFactors: ['uncompleted coach assignment scheduled for today'],
    alternative: null,
    source: 'guardrail',
  };
}

/* ------------------------------------------------------------------ */
/* Category metadata & plan construction                                */
/* ------------------------------------------------------------------ */

const TARGET_SYSTEM = {
  rest: 'Recovery.',
  recovery_row: 'Active recovery — circulation and technique under zero strain.',
  steady_state: 'Aerobic base (UT2/UT1) — mitochondrial density, fat oxidation, cardiac stroke volume.',
  long_aerobic: 'Aerobic endurance — durability, substrate efficiency, connective-tissue conditioning.',
  threshold_intervals: 'Lactate threshold — the highest pace you can sustain without accumulating fatigue.',
  vo2max_intervals: 'VO2max — maximal oxygen transport and utilization.',
  sprint_intervals: 'Anaerobic capacity and neuromuscular power.',
  race_pace: '2k-specific fitness — pacing, lactate tolerance, and race rhythm.',
  technique: 'Motor patterning — stroke efficiency at low intensity.',
  return_easy: 'Aerobic re-activation after time off.',
  cross_training: 'General aerobic fitness with reduced rowing-specific load.',
};

const ADAPTATIONS = {
  rest: 'Consolidation of recent training stimulus.',
  recovery_row: 'Faster clearance of residual fatigue; you absorb the previous hard work sooner.',
  steady_state: 'A bigger aerobic engine: lower heart rate at the same split, better endurance, faster recovery between hard pieces.',
  long_aerobic: 'Improved fatigue resistance late in long pieces and lower HR drift.',
  threshold_intervals: 'Your sustainable pace moves closer to your top pace — the single biggest lever on 2k and head-race times.',
  vo2max_intervals: 'A higher ceiling: more oxygen delivered per minute, which every other zone then benefits from.',
  sprint_intervals: 'Sharper starts and sprints, more power per stroke, better lactate tolerance.',
  race_pace: 'Confidence and economy at goal pace; your body learns exactly what race rhythm costs.',
  technique: 'More boat speed per watt through a longer, better-sequenced stroke.',
  return_easy: 'Restored training rhythm with minimal soreness, ready for normal loading within days.',
  cross_training: 'Maintained aerobic fitness while rowing-specific tissues get relative rest.',
};

const RECOVERY_ADVICE = {
  rest: 'Sleep is the priority. Eat normally — recovery days are not diet days.',
  recovery_row: 'Nothing extra needed; you should finish feeling better than you started.',
  steady_state: 'Normal meals and sleep cover this. You can train again tomorrow.',
  long_aerobic: 'Refuel with carbohydrate within an hour and hydrate; tomorrow should be easy or off.',
  threshold_intervals: 'Take at least one easy day before the next hard session; protein and sleep drive the adaptation.',
  vo2max_intervals: 'This is a big stimulus — give it 48 hours before the next high-intensity day.',
  sprint_intervals: 'Full recovery matters more than volume today; keep tomorrow aerobic and easy.',
  race_pace: 'Treat it like a mini race: cool down thoroughly, eat well, and keep tomorrow light.',
  technique: 'No meaningful recovery cost — train normally tomorrow.',
  return_easy: 'Expect mild soreness; another easy day tomorrow, then resume normal structure.',
  cross_training: 'Standard recovery; back on the erg whenever you like.',
};

const ALTERNATIVES = {
  recovery_row: { title: '30:00 easy bike or walk', description: 'Any modality works for recovery — keep the heart rate under 60% of max.' },
  steady_state: { title: '3 × 20:00 with 1:00 paddle', description: 'Same total volume, broken into thirds if a continuous piece feels mentally long.' },
  long_aerobic: { title: '2 × 30:00 / 2:00 rest', description: 'Splitting the long row keeps quality high if posture degrades late.' },
  threshold_intervals: { title: '30:00 alternating 3:00 firm / 2:00 light', description: 'A gentler threshold introduction with the same systemic target.' },
  vo2max_intervals: { title: '6 × 500m / 2:30 rest', description: 'Distance-based VO2 work if you prefer chasing meters to watching the clock.' },
  sprint_intervals: { title: '10 × 0:30 on / 1:30 off', description: 'Shorter reps, same anaerobic stimulus, easier to hold quality.' },
  race_pace: { title: '4 × 750m @ 2k pace / 5:00 rest', description: 'Slightly longer race-pace reps if your start practice is already solid.' },
  return_easy: { title: '20:00 row + 10:00 stretch', description: 'Even shorter re-entry if the layoff was due to illness.' },
};

function targetForCategory(category, twoKSplit, analysis) {
  const steadyPace = analysis?.paceProgression?.steadyPaceRecentS || null;
  const off = (s) => twoKSplit ? round1(twoKSplit + s) : null;
  switch (category) {
    case 'recovery_row': case 'return_easy':
      return { paceS: steadyPace ? round1(steadyPace + 4) : off(22), hrPct: [50, 65], rate: '16-18' };
    case 'steady_state':
      return { paceS: steadyPace || off(18), hrPct: [60, 72], rate: '18-20' };
    case 'long_aerobic':
      return { paceS: steadyPace ? round1(steadyPace + 2) : off(20), hrPct: [60, 70], rate: '17-19' };
    case 'threshold_intervals':
      return { paceS: off(7), hrPct: [80, 87], rate: '24-26' };
    case 'vo2max_intervals':
      return { paceS: off(2), hrPct: [88, 95], rate: '28-32' };
    case 'sprint_intervals':
      return { paceS: off(-3), hrPct: null, rate: '32-38' };
    case 'race_pace':
      return { paceS: twoKSplit, hrPct: null, rate: '28-32' };
    case 'technique':
      return { paceS: null, hrPct: [55, 65], rate: '16-20' };
    default:
      return { paceS: null, hrPct: null, rate: null };
  }
}

function buildSessionDescription(category, lo, hi, target) {
  const pace = target.paceS ? ` around ${fmtSplit(target.paceS)}/500m` : '';
  const rate = target.rate ? ` at ${target.rate} strokes/min` : '';
  switch (category) {
    case 'recovery_row': return `Warm up gently, then ${lo}–${hi} minutes of continuous very easy rowing${pace}${rate}. Conversation pace throughout — if in doubt, go easier.`;
    case 'return_easy': return `${lo}–${hi} minutes of relaxed continuous rowing${pace}${rate}. Focus on stroke length and rhythm, not numbers.`;
    case 'steady_state': return `10:00 warm-up building to steady pace, then ${Math.max(lo - 15, 20)}–${Math.max(hi - 15, 30)} minutes of continuous steady rowing${pace}${rate}, 5:00 cool-down.`;
    case 'long_aerobic': return `${lo}–${hi} minutes total: settle into a sustainable rhythm${pace}${rate} and hold it. Drink during the piece if over 50 minutes.`;
    case 'threshold_intervals': return `15:00 warm-up with 3 × 0:20 builds, then 3 × 10:00${pace}${rate} with 3:00 easy paddle between, 10:00 cool-down.`;
    case 'vo2max_intervals': return `15:00 warm-up, then 5 × 3:00 hard${pace}${rate} with 3:00 rest, 10:00 cool-down. Even effort across all five — the last should match the first.`;
    case 'sprint_intervals': return `Thorough 15:00 warm-up with builds, then 8 × 0:45 near-maximal${rate} with 2:15 full recovery, 10:00 cool-down.`;
    case 'race_pace': return `15:00 warm-up including 2 practice starts, then 3 × 500m at your 2k target${pace}${rate} with 4:00 rest, 10:00 cool-down.`;
    case 'technique': return `${lo}–${hi} minutes of drill work: pause drills, legs-only, quarter-slide builds — light pressure, full attention on sequencing.`;
    default: return `${lo}–${hi} minutes of rowing.`;
  }
}

/** A monitor-programmable plan for the main set of each category. */
export function defaultPlanFor(category, lo, hi, _analysis) {
  const mid = Math.round((lo + hi) / 2);
  let plan;
  switch (category) {
    case 'recovery_row': case 'return_easy': case 'steady_state': case 'technique':
      plan = { type: 'time', durationS: Math.max(mid, 20) * 60 }; break;
    case 'long_aerobic':
      plan = { type: 'time', durationS: Math.max(mid, 45) * 60 }; break;
    case 'threshold_intervals':
      plan = { type: 'intervals', intervals: Array.from({ length: 3 }, () => ({ workType: 'time', workTimeS: 600, restTimeS: 180 })) }; break;
    case 'vo2max_intervals':
      plan = { type: 'intervals', intervals: Array.from({ length: 5 }, () => ({ workType: 'time', workTimeS: 180, restTimeS: 180 })) }; break;
    case 'sprint_intervals':
      plan = { type: 'intervals', intervals: Array.from({ length: 8 }, () => ({ workType: 'time', workTimeS: 45, restTimeS: 135 })) }; break;
    case 'race_pace':
      plan = { type: 'intervals', intervals: Array.from({ length: 3 }, () => ({ workType: 'distance', workDistanceM: 500, restTimeS: 240 })) }; break;
    default:
      plan = { type: 'time', durationS: Math.max(mid, 20) * 60 };
  }
  return validatePlan(plan).ok ? plan : null;
}

function buildWhy(analysis, factors) {
  const v = analysis.volume || {}, d = analysis.distribution28d || {};
  const bits = [...factors];
  if (v.last7d) bits.push(`last 7 days: ${v.last7d.sessions} sessions / ${v.last7d.minutes} min`);
  if (d.zonePct) bits.push(`4-week mix: ${d.zonePct.ut2 + d.zonePct.ut1}% aerobic, ${d.zonePct.threshold}% threshold, ${d.zonePct.vo2 + d.zonePct.sprint}% high-intensity`);
  return `Based on your data — ${bits.join('; ')}.`;
}

/* ------------------------------------------------------------------ */
/* Post-workout feedback phrasing (LLM with deterministic fallback)     */
/* ------------------------------------------------------------------ */

export function templateFeedbackText(cls) {
  const f = fmtSplit(cls.firstThirdPace), l = fmtSplit(cls.lastThirdPace), a = fmtSplit(cls.avgPace);
  switch (cls.tag) {
    case 'started_too_hard':
      return `You went out hard: your opening third averaged ${f}/500m against a ${a} overall average, and the final third drifted to ${l}. Nothing wrong with ambition — but starting a touch more conservatively usually buys back more at the end than it costs at the start.`;
    case 'started_too_easy':
      return `You finished much faster (${l}/500m) than you started (${f}/500m) — a big negative split with rate still climbing at the end. That's strength in reserve: next time, trust yourself to take the middle of the piece a little quicker.`;
    case 'well_paced':
      return `Nicely paced: first third ${f}/500m, last third ${l}/500m, overall ${a} — all within a tight band. Even pacing like this is exactly how fast pieces are built.`;
    default:
      return 'Not enough split data was recorded to analyze pacing for this piece.';
  }
}

export async function phraseFeedback(classification) {
  const fallback = templateFeedbackText(classification);
  if (!llmConfigured()) return { text: fallback, source: 'template' };
  try {
    const response = await client().messages.create({
      model: config.anthropicModel,
      max_tokens: 1024,
      system: 'You are a rowing coach giving brief post-workout pacing feedback. Ground every statement in the numbers provided; never invent other numbers. 2-3 sentences, specific, encouraging, non-judgmental. Reply with only the feedback text.',
      messages: [{
        role: 'user',
        content: `Classification: ${classification.tag}\nFirst-third average pace: ${fmtSplit(classification.firstThirdPace)}/500m\nLast-third average pace: ${fmtSplit(classification.lastThirdPace)}/500m\nOverall average pace: ${fmtSplit(classification.avgPace)}/500m\nDetail: ${classification.detail || ''}`,
      }],
    });
    if (response.stop_reason === 'refusal') return { text: fallback, source: 'template_after_llm_error' };
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    if (text && text.length >= 20 && text.length <= 800) return { text, source: 'llm' };
    return { text: fallback, source: 'template_after_invalid_llm' };
  } catch (e) {
    log.warn(`Feedback phrasing LLM call failed: ${e.message}`);
    return { text: fallback, source: 'template_after_llm_error' };
  }
}

/* ------------------------------------------------------------------ */

function clampInt(v, min, max, fb) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(min, Math.min(max, Math.round(n)));
}
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
