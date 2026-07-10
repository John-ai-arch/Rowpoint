// Physiological inference models — observation → latent state.
//
// Each model owns one state category: it reads the training analysis and the
// recent extracted features and returns Estimates for its variables. Models
// are versioned, independent, and honest about grounding: a value computed
// from real observations is 'estimated' (or 'measured' when it IS the
// observation), a documented default standing in for missing data is
// 'assumed' — with correspondingly wide uncertainty. Returning {} (or null
// variables) means "nothing to update", never "zero".
//
// ctx = { user, analysis, recentWorkouts: [{ workoutId, startedAt, zone,
//         features }], nowS }
import { register } from '../kernel/registry.js';
import { makeEstimate } from '../kernel/estimate.js';
import { mean, cv, linearRegression } from '../kernel/stats.js';
import { readinessScore } from '../ai/performance.js';
import { wattsFromSplit } from './features/power.js';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Mean of one feature across recent workouts (nulls skipped). */
function recentFeature(ctx, name, { count = 10 } = {}) {
  const vals = ctx.recentWorkouts.slice(-count).map(w => w.features[name]).filter(Number.isFinite);
  return { value: vals.length ? mean(vals) : null, n: vals.length };
}

function defineModel({ name, version, category, infer }) {
  register({ name: `twin.model.${name}`, kind: 'model', version, description: `Digital-twin inference for category "${category}"` });
  const modelVersion = `twin.model.${name}@${version}`;
  return {
    name, version, category, modelVersion,
    infer(ctx) {
      const est = (value, opts) => makeEstimate({ value, modelVersion, updatedAt: ctx.nowS, ...opts });
      return infer(ctx, est) || {};
    },
  };
}

export const INFERENCE_MODELS = [

  defineModel({
    name: 'aerobic', version: '1.0', category: 'aerobic',
    infer(ctx, est) {
      const a = ctx.analysis.athlete || {};
      const out = {};
      if (a.best2kSeconds > 0) {
        // Index anchored on 2k split: 85 s/500m (elite) → 100, 135 s/500m → 30.
        const split = a.best2kSeconds / 4;
        out.capacityIndex = est(clamp(100 - (split - 85) * 1.4, 5, 100), {
          provenance: 'estimated',
          uncertainty: a.best2kVerified ? 3 : 8,
          confidence: a.best2kVerified ? 0.85 : 0.55,
          evidenceCount: Math.max(ctx.analysis.history?.totalWorkouts || 0, 1),
        });
      } else {
        out.capacityIndex = est(40, { provenance: 'assumed', uncertainty: 20, confidence: 0.2, evidenceCount: 0 });
      }
      const steady = ctx.analysis.paceProgression?.steadyPaceRecentS;
      if (steady > 0) {
        out.baseSpeed = est(500 / steady, {
          provenance: 'estimated', uncertainty: 0.1, confidence: 0.7,
          evidenceCount: ctx.analysis.volume?.last28d?.sessions || 1,
        });
      }
      return out;
    },
  }),

  defineModel({
    name: 'anaerobic', version: '1.0', category: 'anaerobic',
    infer(ctx, est) {
      const a = ctx.analysis.athlete || {};
      const fastest = ctx.analysis.prs?.fastestAvgSplitS;
      if (!(a.best2kSeconds > 0) || !(fastest > 0)) return {};
      // Margin above race pace: how many s/500m faster than 2k pace the
      // athlete has actually gone. 10s margin → index 100.
      const margin = a.best2kSeconds / 4 - fastest;
      return {
        sprintReserveIndex: est(clamp(margin * 10, 0, 100), {
          provenance: 'estimated', uncertainty: 12, confidence: 0.5,
          evidenceCount: ctx.analysis.history?.totalWorkouts || 1,
        }),
      };
    },
  }),

  defineModel({
    name: 'recovery', version: '1.0', category: 'recovery',
    infer(ctx, est) {
      const r = ctx.analysis.recovery || {};
      const w = ctx.analysis.wellness || {};
      const out = {};
      if (Number.isFinite(r.avgRecoveryDaysBetweenHard)) {
        out.avgRecoveryDays = est(r.avgRecoveryDaysBetweenHard, {
          provenance: 'measured', uncertainty: 0.3, confidence: 0.9,
          evidenceCount: r.hardSessionsLast7d || 1,
        });
      }
      // Recovery half-life: 24h baseline, pushed out by poor sleep/soreness
      // and worsening HR drift, pulled in by good sleep. Without wellness
      // check-ins this is a documented assumption, not an observation.
      let halfLife = 24;
      const hasWellness = (w.checkins14d || 0) > 0;
      if (hasWellness) {
        if (w.avgSleepHours != null && w.avgSleepHours < 6.5) halfLife += 6;
        else if (w.avgSleepHours != null && w.avgSleepHours >= 7.5) halfLife -= 3;
        if (w.avgSoreness != null && w.avgSoreness >= 3.5) halfLife += 6;
      }
      if (ctx.analysis.heartRate?.driftTrend === 'worsening') halfLife += 4;
      out.recoveryHalfLifeH = est(halfLife, {
        provenance: hasWellness ? 'estimated' : 'assumed',
        uncertainty: hasWellness ? 6 : 12,
        confidence: hasWellness ? 0.5 : 0.25,
        evidenceCount: w.checkins14d || 0,
      });
      return out;
    },
  }),

  defineModel({
    name: 'fatigue', version: '1.0', category: 'fatigue',
    infer(ctx, est) {
      const v = ctx.analysis.volume || {};
      const out = {};
      if (v.last7d) out.acuteLoad = est(v.last7d.minutes || 0, { provenance: 'measured', uncertainty: 0, confidence: 0.95, evidenceCount: v.last7d.sessions || 0 });
      if (Number.isFinite(v.weeklyAvgMinutes28d)) out.chronicLoad = est(v.weeklyAvgMinutes28d, { provenance: 'measured', uncertainty: 0, confidence: 0.95, evidenceCount: v.last28d?.sessions || 0 });
      if (Number.isFinite(v.acuteChronicRatio)) {
        out.acwr = est(v.acuteChronicRatio, { provenance: 'estimated', uncertainty: 0.15, confidence: 0.7, evidenceCount: v.last28d?.sessions || 1 });
      }
      return out;
    },
  }),

  defineModel({
    name: 'efficiency', version: '1.0', category: 'efficiency',
    infer(ctx, est) {
      const hr = ctx.analysis.heartRate || {};
      const out = {};
      if (Number.isFinite(hr.aerobicEfficiencyRecent)) {
        out.paceHrIndex = est(hr.aerobicEfficiencyRecent, {
          provenance: 'estimated', uncertainty: 0.1, confidence: 0.65,
          evidenceCount: hr.workoutsWithHr || 1,
        });
      }
      if (Number.isFinite(hr.driftRecentPct)) {
        out.hrDriftPct = est(hr.driftRecentPct, {
          provenance: 'measured', uncertainty: 1.5, confidence: 0.8,
          evidenceCount: hr.workoutsWithHr || 1,
        });
      }
      return out;
    },
  }),

  defineModel({
    name: 'consistency', version: '1.0', category: 'consistency',
    infer(ctx, est) {
      const v = ctx.analysis.volume || {};
      const out = {};
      if (v.last28d) {
        out.sessionsPerWeek = est((v.last28d.sessions || 0) / 4, { provenance: 'measured', uncertainty: 0.2, confidence: 0.9, evidenceCount: v.last28d.sessions || 0 });
      }
      const paceCv = recentFeature(ctx, 'pace_cv_pct');
      if (paceCv.value !== null) {
        out.paceVariability = est(paceCv.value, { provenance: 'estimated', uncertainty: 1, confidence: 0.6, evidenceCount: paceCv.n });
      }
      // Regularity from the spacing of recent sessions: CV of the gaps
      // between consecutive workouts, inverted onto 0-100.
      const times = ctx.recentWorkouts.map(w => w.startedAt).filter(Number.isFinite).sort((a, b) => a - b);
      if (times.length >= 4) {
        const gaps = [];
        for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 86400);
        const gapCv = cv(gaps);
        if (gapCv !== null) {
          out.scheduleRegularity = est(clamp(100 - gapCv * 60, 0, 100), {
            provenance: 'estimated', uncertainty: 10, confidence: 0.6, evidenceCount: gaps.length,
          });
        }
      }
      return out;
    },
  }),

  defineModel({
    name: 'technique', version: '1.0', category: 'technique',
    infer(ctx, est) {
      const out = {};
      const rateCv = recentFeature(ctx, 'rate_cv_pct');
      if (rateCv.value !== null) {
        out.rateDiscipline = est(clamp(100 - rateCv.value * 8, 0, 100), {
          provenance: 'estimated', uncertainty: 8, confidence: 0.6, evidenceCount: rateCv.n,
        });
      }
      const dps = recentFeature(ctx, 'distance_per_stroke_m');
      if (dps.value !== null) {
        out.distancePerStroke = est(dps.value, { provenance: 'measured', uncertainty: 0.3, confidence: 0.8, evidenceCount: dps.n });
      }
      const smooth = recentFeature(ctx, 'force_smoothness_idx');
      out.strokeSmoothness = smooth.value !== null
        ? est(smooth.value, { provenance: 'estimated', uncertainty: 8, confidence: 0.6, evidenceCount: smooth.n })
        // No force curves recorded — a wide, clearly-assumed midpoint.
        : est(50, { provenance: 'assumed', uncertainty: 25, confidence: 0.15, evidenceCount: 0 });
      return out;
    },
  }),

  defineModel({
    name: 'power', version: '1.0', category: 'power',
    infer(ctx, est) {
      const a = ctx.analysis.athlete || {};
      const out = {};
      // Critical power from the 2k anchor: a 2k is a near-maximal ~6-7 min
      // effort; CP sits at roughly 78% of 2k power for trained rowers
      // (2-parameter CP model fitted at typical rowing durations).
      if (a.best2kSeconds > 0) {
        const w2k = wattsFromSplit(a.best2kSeconds / 4);
        out.criticalPowerW = est(w2k * 0.78, {
          provenance: 'estimated', uncertainty: w2k * 0.06,
          confidence: a.best2kVerified ? 0.7 : 0.45,
          evidenceCount: ctx.analysis.history?.totalWorkouts || 1,
        });
      } else {
        const steadyW = recentFeature(ctx, 'power_avg_w');
        if (steadyW.value !== null) {
          // Steady aerobic work sits below CP; scale up modestly.
          out.criticalPowerW = est(steadyW.value * 1.15, {
            provenance: 'estimated', uncertainty: steadyW.value * 0.15, confidence: 0.35, evidenceCount: steadyW.n,
          });
        }
      }
      // W′: no all-out short-duration data yet — mass-scaled population prior
      // (~230 J/kg for trained rowers). The physics engine (Phase 2) refines
      // this from actual short-effort performances.
      const mass = Number(ctx.user.weight_kg) > 0 ? Number(ctx.user.weight_kg) : 75;
      out.wPrimeJ = est(mass * 230, { provenance: 'assumed', uncertainty: mass * 80, confidence: 0.2, evidenceCount: 0 });
      return out;
    },
  }),

  defineModel({
    name: 'endurance', version: '1.0', category: 'endurance',
    infer(ctx, est) {
      const prs = ctx.analysis.prs || {};
      const v = ctx.analysis.volume || {};
      const out = {};
      if (Number.isFinite(prs.longestMinutes) && prs.longestMinutes > 0) {
        out.longestSessionMin = est(prs.longestMinutes, { provenance: 'measured', uncertainty: 0, confidence: 0.95, evidenceCount: ctx.analysis.history?.totalWorkouts || 1 });
      }
      const weekly = v.weeklyAvgMinutes28d || 0;
      if (weekly > 0 || prs.longestMinutes > 0) {
        // Composite: up to 60 points for weekly volume (360 min/wk → full),
        // up to 40 for the longest single session (120 min → full).
        const idx = clamp(weekly / 6, 0, 60) + clamp((prs.longestMinutes || 0) / 3, 0, 40);
        out.enduranceIndex = est(idx, {
          provenance: 'estimated', uncertainty: 10, confidence: 0.6,
          evidenceCount: v.last28d?.sessions || 1,
        });
      }
      return out;
    },
  }),

  defineModel({
    name: 'readiness', version: '1.0', category: 'readiness',
    infer(ctx, est) {
      // Reuses the vetted readiness estimator — the twin records its output
      // as state so history/trend become queryable like any other variable.
      const r = readinessScore(ctx.analysis);
      return {
        score: est(r.score, {
          provenance: 'estimated', uncertainty: 10,
          confidence: (ctx.analysis.wellness?.checkins14d || 0) > 0 ? 0.7 : 0.5,
          evidenceCount: ctx.analysis.volume?.last28d?.sessions || 0,
        }),
      };
    },
  }),

  defineModel({
    name: 'adaptation', version: '1.0', category: 'adaptation',
    infer(ctx, est) {
      const out = {};
      // Pace trend: regression of steady-session pace on time (weeks) over
      // the recent window. Negative slope = getting faster.
      const steady = (ctx.analysis.recentWorkouts || [])
        .filter(w => (w.zone === 'ut2' || w.zone === 'ut1') && Number.isFinite(w.avgSplitS) && w.avgSplitS > 0);
      if (steady.length >= 4) {
        const t0 = Math.min(...steady.map(w => new Date(w.date).getTime()));
        const reg = linearRegression(
          steady.map(w => (new Date(w.date).getTime() - t0) / (7 * 86400 * 1000)),
          steady.map(w => w.avgSplitS),
        );
        if (reg) {
          out.paceTrendSPerWeek = est(reg.slope, {
            provenance: 'estimated',
            uncertainty: reg.slopeStdErr ?? Math.abs(reg.slope) * 0.5 + 0.2,
            confidence: clamp(0.3 + reg.n * 0.05, 0.3, 0.75),
            evidenceCount: reg.n,
          });
        }
      }
      // Plateau risk: monotonous training + a flat/declining pace trend.
      const monotonous = !!ctx.analysis.flags?.monotonous;
      const trend = ctx.analysis.paceProgression?.trend;
      if (trend && trend !== 'insufficient_data') {
        let risk = trend === 'improving' ? 15 : trend === 'stable' ? 45 : 70;
        if (monotonous) risk += 20;
        out.plateauRisk = est(clamp(risk, 0, 100), {
          provenance: 'estimated', uncertainty: 15, confidence: 0.45,
          evidenceCount: ctx.analysis.volume?.last28d?.sessions || 1,
        });
      }
      return out;
    },
  }),

  defineModel({
    name: 'injury-risk', version: '1.0', category: 'injuryRisk',
    infer(ctx, est) {
      const v = ctx.analysis.volume || {};
      const d = ctx.analysis.distribution28d || {};
      const f = ctx.analysis.flags || {};
      const r = ctx.analysis.recovery || {};
      const evidence = v.last28d?.sessions || 0;
      const out = {};
      // These are training-load risk indicators, not medical assessments —
      // the state model's descriptions say so and the UI repeats it.
      if (Number.isFinite(v.acuteChronicRatio)) {
        out.loadSpikeIndex = est(clamp((v.acuteChronicRatio - 1) * 120, 0, 100), {
          provenance: 'estimated', uncertainty: 12, confidence: 0.6, evidenceCount: evidence,
        });
      }
      const maxZonePct = Math.max(0, ...Object.values(d.zonePct || {}));
      if ((d.zoneMinutes && Object.values(d.zoneMinutes).some(m => m > 0))) {
        out.monotonyIndex = est(maxZonePct, { provenance: 'estimated', uncertainty: 8, confidence: 0.6, evidenceCount: evidence });
      }
      let risk = 0;
      if (f.rampTooFast) risk += 30;
      if (f.hardStacking) risk += 25;
      if (f.monotonous) risk += 15;
      if (f.highDrift) risk += 15;
      if ((r.hardSessionsLast7d || 0) >= 3) risk += 10;
      out.riskIndex = est(clamp(risk, 0, 100), {
        provenance: 'estimated', uncertainty: 15,
        confidence: evidence >= 8 ? 0.55 : 0.35, evidenceCount: evidence,
      });
      return out;
    },
  }),
];
