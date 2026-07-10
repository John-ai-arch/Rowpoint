// The statistical gate — no candidate pattern becomes a reportable finding
// without passing through here. Every reported effect carries: effect size,
// a seeded-bootstrap confidence interval, a permutation p-value (exact-by-
// construction, no distributional assumption), multiple-comparison
// correction across its screen, sample size, data quality, and warnings.
// Findings are ALWAYS labeled exploratory: this platform generates
// hypotheses; it does not confirm them.
import { spearman, cohensD, welchT, quantile, benjaminiHochberg } from '../kernel/stats.js';
import { createRng, seedFrom } from '../kernel/rng.js';

export const STATS_GATE_VERSION = 'discovery.stats-gate@1.0';

export const MIN_ATHLETES = 8;   // below this, no analysis runs at all
export const MIN_SUBGROUP = 5;   // k-anonymity floor for any reported subgroup

/** Paired rows with both values finite. */
function pairs(xs, ys) {
  const out = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) out.push([xs[i], ys[i]]);
  }
  return out;
}

/**
 * Permutation p-value for any paired statistic: shuffle y against x many
 * times (seeded) and count statistics at least as extreme as observed.
 * Two-sided; add-one smoothing so p is never exactly 0.
 */
export function permutationP(xs, ys, statFn, { iterations = 1000, rng }) {
  const p = pairs(xs, ys);
  if (p.length < 4 || !rng) return null;
  const px = p.map(v => v[0]), py = p.map(v => v[1]);
  const observed = statFn(px, py);
  if (!Number.isFinite(observed)) return null;
  let extreme = 0;
  for (let i = 0; i < iterations; i++) {
    const shuffled = rng.shuffle(py);
    const s = statFn(px, shuffled);
    if (Number.isFinite(s) && Math.abs(s) >= Math.abs(observed) - 1e-12) extreme++;
  }
  return (extreme + 1) / (iterations + 1);
}

/** Seeded paired-bootstrap CI for a paired statistic. */
export function pairedBootstrapCI(xs, ys, statFn, { iterations = 1000, alpha = 0.05, rng }) {
  const p = pairs(xs, ys);
  if (p.length < 4 || !rng) return null;
  const stats = [];
  for (let i = 0; i < iterations; i++) {
    const sample = Array.from({ length: p.length }, () => p[rng.int(0, p.length - 1)]);
    const s = statFn(sample.map(v => v[0]), sample.map(v => v[1]));
    if (Number.isFinite(s)) stats.push(s);
  }
  if (stats.length < iterations / 2) return null;
  return { lo: round3(quantile(stats, alpha / 2)), hi: round3(quantile(stats, 1 - alpha / 2)) };
}

/**
 * Full correlation test between two athlete-level variables:
 * Spearman effect + permutation p + bootstrap CI. Deterministic per seed.
 */
export function correlationTest(xs, ys, { seed, label }) {
  const n = pairs(xs, ys).length;
  if (n < MIN_ATHLETES) return { available: false, n, reason: `needs ≥${MIN_ATHLETES} athletes, have ${n}` };
  const effect = spearman(xs, ys);
  if (effect === null) return { available: false, n, reason: 'no variance in one variable' };
  const rngP = createRng(seedFrom(seed, label, 'perm'));
  const rngB = createRng(seedFrom(seed, label, 'boot'));
  return {
    available: true,
    statistic: 'spearman-rho',
    effect: round3(effect),
    ci95: pairedBootstrapCI(xs, ys, spearman, { rng: rngB }),
    p: permutationP(xs, ys, spearman, { rng: rngP }),
    n,
  };
}

/** Two-group comparison: Welch t + Cohen's d + group sizes (k-anon gated). */
export function groupComparison(a, b) {
  if (a.length < MIN_SUBGROUP || b.length < MIN_SUBGROUP) {
    return { available: false, reason: `subgroups below the k-anonymity floor (${MIN_SUBGROUP})`, nA: a.length, nB: b.length };
  }
  const w = welchT(a, b);
  if (!w) return { available: false, reason: 'insufficient variance', nA: a.length, nB: b.length };
  return {
    available: true,
    statistic: 'welch-t',
    effect: round3(cohensD(a, b)),
    effectLabel: "Cohen's d",
    t: round3(w.t),
    p: round3(w.p),
    nA: a.length,
    nB: b.length,
  };
}

/**
 * Apply BH correction across one screen of tests and attach standard
 * epistemics to each: evidence level, warnings, practical significance.
 */
export function gateScreen(tests, { q = 0.05 } = {}) {
  const testable = tests.filter(t => t.stats?.available && Number.isFinite(t.stats.p));
  const adjusted = benjaminiHochberg(testable.map(t => t.stats.p), q);
  testable.forEach((t, i) => {
    t.stats.pAdjusted = round3(adjusted[i].adjusted);
    t.stats.significant = adjusted[i].significant;
  });
  for (const t of tests) {
    t.evidence = 'exploratory'; // never anything else from this engine
    t.warnings = [];
    if (!t.stats?.available) { t.warnings.push(t.stats?.reason || 'not testable'); continue; }
    if (t.stats.n !== undefined && t.stats.n < 15) t.warnings.push(`small sample (n=${t.stats.n}) — unstable estimate`);
    if (t.stats.ci95 && t.stats.ci95.lo <= 0 && t.stats.ci95.hi >= 0) t.warnings.push('confidence interval crosses zero');
    if (Math.abs(t.stats.effect ?? 0) < 0.2) t.warnings.push('effect below practical-significance threshold (|effect| < 0.2)');
    if (t.stats.significant === false) t.warnings.push('does not survive multiple-comparison correction');
  }
  return tests;
}

const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
