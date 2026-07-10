// Hypothesis generation — automated exploration of the research feature
// space for statistically interesting, reproducible candidate patterns.
//
// Three screens, all deterministic per (dataset, seed):
//   1. Correlation screen: training-structure variables vs improvement,
//      BH-corrected as one family.
//   2. Archetype clustering: k-means over training-shape variables, with
//      between-cluster improvement comparisons (k-anonymity gated).
//   3. Plateau screen: flat-trajectory athletes vs improvers on monotony.
//
// Every candidate is a HYPOTHESIS: labeled exploratory, wrapped in
// confounders/limitations/follow-up, and queued for human review — the
// engine never claims causation and never publishes on its own.
import { mean, kmeans } from '../kernel/stats.js';
import { createRng, seedFrom } from '../kernel/rng.js';
import { correlationTest, groupComparison, gateScreen, MIN_ATHLETES, MIN_SUBGROUP } from './statsTests.js';

export const HYPOTHESIS_ENGINE_VERSION = 'discovery.hypotheses@1.0';

const STANDARD_CONFOUNDERS = [
  'Self-selection: athletes choose their own training — structure correlates with motivation, experience, and goals.',
  'Reverse causation: improving athletes may train more because they are improving.',
  'Measurement: erg-only data; no anchor to on-water performance or physiology labs.',
  'Survivorship: athletes who stopped contributing are underrepresented.',
];

/** The correlation screen's variable pairs (one BH family). */
const CORRELATION_SCREEN = [
  ['weekly_minutes', 'Weekly training volume'],
  ['sessions', 'Session frequency'],
  ['pct_hard_minutes', 'Share of hard training'],
  ['monotony', 'Training monotony'],
  ['split_volatility_pct', 'Within-week pace volatility'],
  ['hr_drift_mean', 'Heart-rate drift'],
];

/**
 * @param {Array} athletes  athleteAggregates() output
 * @param {number} seed     dataset-derived seed (deterministic per dataset)
 * @returns findings: [{ kind, title, narrative, stats, evidence, warnings,
 *                       confounders, limitations, followUp }]
 */
export function generateHypotheses(athletes, seed) {
  if (athletes.length < MIN_ATHLETES) {
    return {
      findings: [],
      skipped: `Dataset has ${athletes.length} eligible athletes; hypothesis generation requires ≥${MIN_ATHLETES}.`,
    };
  }
  const findings = [];

  /* ---------- 1. correlation screen (one BH family) ---------- */
  // Outcome: improvement slope (s/500m per week; NEGATIVE = improving).
  // Signs are flipped in the narrative so "positive association with
  // improvement" reads naturally.
  const outcome = athletes.map(a => a.improvement_slope);
  const corrTests = [];
  for (const [feature, label] of CORRELATION_SCREEN) {
    const xs = athletes.map(a => a[feature]);
    const stats = correlationTest(xs, outcome, { seed, label: feature });
    corrTests.push({
      kind: 'correlation',
      feature,
      title: `${label} vs long-term improvement`,
      stats,
    });
  }
  gateScreen(corrTests);
  for (const t of corrTests) {
    if (!t.stats.available) continue;
    // Report candidates worth a human's time: nontrivial effect that at
    // least survives correction OR has a CI clear of zero.
    const interesting = Math.abs(t.stats.effect) >= 0.25 && (t.stats.significant || (t.stats.ci95 && (t.stats.ci95.lo > 0 || t.stats.ci95.hi < 0)));
    if (!interesting) continue;
    const helps = t.stats.effect < 0; // negative rho with slope = associated with getting faster
    findings.push({
      kind: 'correlation',
      title: t.title,
      narrative: `Across ${t.stats.n} consenting athletes, higher ${t.title.split(' vs ')[0].toLowerCase()} is associated with ${helps ? 'FASTER' : 'SLOWER'} long-term pace development `
        + `(Spearman ρ = ${t.stats.effect}, 95% CI [${t.stats.ci95?.lo}, ${t.stats.ci95?.hi}], permutation p = ${t.stats.p}, BH-adjusted p = ${t.stats.pAdjusted}). `
        + 'An association in observational data — not evidence that changing this variable changes outcomes.',
      stats: t.stats,
      evidence: t.evidence,
      warnings: t.warnings,
      confounders: STANDARD_CONFOUNDERS,
      limitations: ['Improvement measured as the trailing 8-week slope of weekly mean split — sensitive to session-mix changes.'],
      followUp: 'Compare within-athlete periods (self-controlled design) before treating this as more than a screening signal.',
    });
  }

  /* ---------- 2. training archetypes (clustering) ---------- */
  const clusterVars = ['weekly_minutes', 'sessions', 'pct_hard_minutes'];
  const usable = athletes.filter(a => clusterVars.every(v => Number.isFinite(a[v])) && Number.isFinite(a.improvement_slope));
  if (usable.length >= MIN_ATHLETES) {
    // z-normalize so no variable dominates the distance metric.
    const stats = clusterVars.map(v => {
      const vals = usable.map(a => a[v]);
      const m = mean(vals);
      const s = Math.sqrt(vals.reduce((acc, x) => acc + (x - m) ** 2, 0) / vals.length) || 1;
      return { m, s };
    });
    const points = usable.map(a => clusterVars.map((v, i) => (a[v] - stats[i].m) / stats[i].s));
    const km = kmeans(points, Math.min(3, Math.floor(usable.length / MIN_SUBGROUP)), { rng: createRng(seedFrom(seed, 'kmeans')) });
    if (km && km.sizes.filter(s => s >= MIN_SUBGROUP).length >= 2) {
      const profiles = km.sizes.map((size, c) => ({
        cluster: c,
        size,
        profile: Object.fromEntries(clusterVars.map((v, i) => [v, Math.round((km.centroids[c][i] * stats[i].s + stats[i].m) * 10) / 10])),
        improvement: usable.filter((_, i) => km.assignments[i] === c).map(a => a.improvement_slope),
      })).filter(p => p.size >= MIN_SUBGROUP);
      // Compare the two largest reportable clusters on improvement.
      profiles.sort((a, b) => b.size - a.size);
      const [big, second] = profiles;
      if (big && second) {
        const cmp = groupComparison(big.improvement, second.improvement);
        findings.push({
          kind: 'archetype',
          title: `Training archetypes: ${profiles.length} recurring structures in the population`,
          narrative: `k-means over (weekly minutes, sessions, %hard) finds ${profiles.length} recurring training shapes among ${usable.length} athletes. `
            + profiles.map(p => `Archetype ${p.cluster + 1} (n=${p.size}): ~${p.profile.weekly_minutes} min/wk, ${p.profile.sessions} sessions, ${p.profile.pct_hard_minutes}% hard`).join('; ')
            + (cmp.available
              ? `. The two largest archetypes differ on improvement slope by Cohen's d = ${cmp.effect} (Welch p = ${cmp.p}, n=${cmp.nA}/${cmp.nB}).`
              : '. Between-archetype improvement comparison suppressed (subgroup below the anonymity floor).'),
          stats: { clustering: { k: profiles.length, sizes: profiles.map(p => p.size) }, comparison: cmp, n: usable.length, available: true, p: cmp.available ? cmp.p : null, effect: cmp.available ? cmp.effect : null },
          evidence: 'exploratory',
          warnings: cmp.available && cmp.p > 0.05 ? ['between-archetype improvement difference is not significant'] : [],
          confounders: STANDARD_CONFOUNDERS,
          limitations: ['Cluster count chosen by k-anonymity capacity, not model selection; archetypes are descriptive, not prescriptive.'],
          followUp: 'Track archetype membership over seasons: do athletes who CHANGE archetype change trajectory?',
        });
      }
    }
  }

  /* ---------- 3. plateau screen ---------- */
  const withSlope = athletes.filter(a => Number.isFinite(a.improvement_slope) && Number.isFinite(a.monotony) && a.weeks >= 6);
  const plateaued = withSlope.filter(a => Math.abs(a.improvement_slope) < 0.15);
  const improving = withSlope.filter(a => a.improvement_slope <= -0.15);
  if (plateaued.length >= MIN_SUBGROUP && improving.length >= MIN_SUBGROUP) {
    const cmp = groupComparison(plateaued.map(a => a.monotony), improving.map(a => a.monotony));
    if (cmp.available) {
      findings.push({
        kind: 'plateau',
        title: 'Plateaued athletes train more monotonously than improving athletes',
        narrative: `${plateaued.length} athletes show flat trajectories (|slope| < 0.15 s/wk) vs ${improving.length} clearly improving. `
          + `Plateaued athletes' training monotony differs by Cohen's d = ${cmp.effect} (Welch p = ${cmp.p}). `
          + 'If replicated, monotony could be an early plateau marker — association only at this stage.',
        stats: cmp,
        evidence: 'exploratory',
        warnings: cmp.p > 0.05 ? ['difference is not statistically significant'] : [],
        confounders: STANDARD_CONFOUNDERS,
        limitations: ['Plateau threshold (0.15 s/wk) is a modeling choice; sensitivity to it has not been established.'],
        followUp: 'Re-run with plateau thresholds 0.1 and 0.2 s/wk; check whether the association direction is stable.',
      });
    }
  }

  return { findings, screensRun: 3, athletesAnalyzed: athletes.length };
}
