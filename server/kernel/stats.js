// Shared statistics for every computational engine.
//
// One vetted implementation instead of per-engine re-derivations: descriptive
// stats, regression with slope confidence intervals, correlation, bootstrap
// CIs (seeded — reproducible), effect sizes, Welch's t-test with a real
// t-distribution p-value, Benjamini–Hochberg multiple-comparison correction,
// k-means clustering, and exponential-decay fitting.
//
// All functions ignore non-finite inputs rather than propagating NaN, and
// return null when a statistic is undefined for the input — callers must
// treat null as "not enough data", never as zero. Pure module.

const finite = (xs) => xs.map(Number).filter(Number.isFinite);

export function mean(xs) {
  const f = finite(xs);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

export function variance(xs) {
  const f = finite(xs);
  if (f.length < 2) return null;
  const m = mean(f);
  return f.reduce((s, x) => s + (x - m) ** 2, 0) / (f.length - 1); // sample variance
}

export function sd(xs) {
  const v = variance(xs);
  return v === null ? null : Math.sqrt(v);
}

export function median(xs) { return quantile(xs, 0.5); }

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(xs, q) {
  const f = finite(xs).sort((a, b) => a - b);
  if (!f.length) return null;
  const pos = (f.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return f[lo] + (f[hi] - f[lo]) * (pos - lo);
}

/** Coefficient of variation (sd/|mean|); null if mean ~ 0 or n < 2. */
export function cv(xs) {
  const m = mean(xs), s = sd(xs);
  if (m === null || s === null || Math.abs(m) < 1e-12) return null;
  return s / Math.abs(m);
}

/**
 * Ordinary least squares y = slope·x + intercept.
 * Returns slope/intercept/r2/n plus the slope's standard error and 95% CI
 * (normal approximation for n>=30, t-quantile below) — null if n < 2 or x
 * has no variance.
 */
export function linearRegression(xs, ys) {
  const pts = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = Number(xs[i]), y = Number(ys[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (sxx < 1e-12) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (const [x, y] of pts) sse += (y - (slope * x + intercept)) ** 2;
  const r2 = syy < 1e-12 ? 1 : 1 - sse / syy;
  const slopeStdErr = n > 2 ? Math.sqrt((sse / (n - 2)) / sxx) : null;
  const tCrit = n > 2 ? tQuantile975(n - 2) : null;
  return {
    slope, intercept, r2, n, slopeStdErr,
    slopeCI95: slopeStdErr !== null ? [slope - tCrit * slopeStdErr, slope + tCrit * slopeStdErr] : null,
  };
}

export function pearson(xs, ys) {
  const pts = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = Number(xs[i]), y = Number(ys[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  if (pts.length < 3) return null;
  const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation (ties get average ranks). */
export function spearman(xs, ys) {
  const pts = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = Number(xs[i]), y = Number(ys[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  if (pts.length < 3) return null;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
      i = j + 1;
    }
    return ranks;
  };
  return pearson(rank(pts.map(p => p[0])), rank(pts.map(p => p[1])));
}

/**
 * Bootstrap confidence interval for any statistic of one sample.
 * Seeded rng required so results are reproducible.
 */
export function bootstrapCI(xs, statFn, { iterations = 1000, alpha = 0.05, rng }) {
  const f = finite(xs);
  if (f.length < 3 || !rng) return null;
  const stats = [];
  for (let it = 0; it < iterations; it++) {
    const sample = Array.from({ length: f.length }, () => f[rng.int(0, f.length - 1)]);
    const s = statFn(sample);
    if (Number.isFinite(s)) stats.push(s);
  }
  if (stats.length < iterations / 2) return null;
  return { lo: quantile(stats, alpha / 2), hi: quantile(stats, 1 - alpha / 2), n: f.length, iterations };
}

/** Cohen's d effect size between two samples (pooled sd). */
export function cohensD(a, b) {
  const fa = finite(a), fb = finite(b);
  if (fa.length < 2 || fb.length < 2) return null;
  const va = variance(fa), vb = variance(fb);
  const pooled = Math.sqrt(((fa.length - 1) * va + (fb.length - 1) * vb) / (fa.length + fb.length - 2));
  if (pooled < 1e-12) return null;
  return (mean(fa) - mean(fb)) / pooled;
}

/** Welch's t-test (unequal variances). Two-sided p from the t-distribution. */
export function welchT(a, b) {
  const fa = finite(a), fb = finite(b);
  if (fa.length < 2 || fb.length < 2) return null;
  const va = variance(fa) / fa.length, vb = variance(fb) / fb.length;
  if (va + vb < 1e-15) return null;
  const t = (mean(fa) - mean(fb)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (fa.length - 1) + vb ** 2 / (fb.length - 1));
  return { t, df, p: 2 * (1 - tCdf(Math.abs(t), df)), nA: fa.length, nB: fb.length };
}

/**
 * Benjamini–Hochberg FDR correction. Input: array of p-values.
 * Output: same-order array of { p, adjusted, significant } at the given q.
 */
export function benjaminiHochberg(pvals, q = 0.05) {
  const m = pvals.length;
  if (!m) return [];
  const order = pvals.map((p, i) => [Number(p), i]).sort((a, b) => a[0] - b[0]);
  const adjusted = new Array(m);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const [p, idx] = order[k];
    prev = Math.min(prev, (p * m) / (k + 1));
    adjusted[idx] = prev;
  }
  return pvals.map((p, i) => ({ p: Number(p), adjusted: adjusted[i], significant: adjusted[i] <= q }));
}

/**
 * k-means over points (arrays of equal dimension). Seeded initialization
 * (k-means++ style) so clustering is reproducible.
 */
export function kmeans(points, k, { rng, iterations = 50 } = {}) {
  const pts = points.filter(p => Array.isArray(p) && p.every(Number.isFinite));
  if (!rng || pts.length < k || k < 1) return null;
  const dist2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
  // k-means++ seeding
  const centroids = [pts[rng.int(0, pts.length - 1)].slice()];
  while (centroids.length < k) {
    const d = pts.map(p => Math.min(...centroids.map(c => dist2(p, c))));
    const total = d.reduce((a, b) => a + b, 0);
    if (total < 1e-12) { centroids.push(pts[rng.int(0, pts.length - 1)].slice()); continue; }
    let r = rng.float() * total;
    let idx = 0;
    while (r > d[idx] && idx < d.length - 1) { r -= d[idx]; idx++; }
    centroids.push(pts[idx].slice());
  }
  let assignments = new Array(pts.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) { const d = dist2(pts[i], centroids[c]); if (d < bestD) { bestD = d; best = c; } }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = pts.filter((_, i) => assignments[i] === c);
      if (!members.length) continue;
      for (let dim = 0; dim < centroids[c].length; dim++) {
        centroids[c][dim] = members.reduce((s, p) => s + p[dim], 0) / members.length;
      }
    }
    if (!changed) break;
  }
  const sizes = Array.from({ length: k }, (_, c) => assignments.filter(a => a === c).length);
  return { centroids, assignments, sizes };
}

/**
 * Fit y = a·e^(−k·t) by log-linear regression over strictly positive ys.
 * Returns { a, k, r2 } or null if fewer than 3 usable points.
 */
export function fitExponentialDecay(ts, ys) {
  const xs = [], ls = [];
  for (let i = 0; i < Math.min(ts.length, ys.length); i++) {
    const t = Number(ts[i]), y = Number(ys[i]);
    if (Number.isFinite(t) && Number.isFinite(y) && y > 0) { xs.push(t); ls.push(Math.log(y)); }
  }
  if (xs.length < 3) return null;
  const reg = linearRegression(xs, ls);
  if (!reg) return null;
  return { a: Math.exp(reg.intercept), k: -reg.slope, r2: reg.r2 };
}

/* ------------------- t-distribution internals -------------------
   CDF via the regularized incomplete beta function (continued fraction,
   Lentz's algorithm) — the standard numerically stable construction. */

function tCdf(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
  const x = df / (df + t * t);
  const ib = 0.5 * regIncBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - ib : ib;
}

/** 97.5th percentile of the t-distribution (bisection on tCdf). */
function tQuantile975(df) {
  let lo = 0, hi = 100;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < 0.975) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function regIncBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  // Continued fraction converges fastest for x < (a+1)/(a+b+2); use symmetry otherwise.
  if (x < (a + 1) / (a + b + 2)) return front * betaCf(a, b, x) / a;
  return 1 - regIncBeta(b, a, 1 - x);
}

function betaCf(a, b, x) {
  const EPS = 1e-12, TINY = 1e-30;
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Lanczos approximation, g=7 — accurate to ~15 significant digits.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
