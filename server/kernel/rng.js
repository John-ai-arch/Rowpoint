// Seedable deterministic randomness for reproducible computation.
//
// Every stochastic run on the platform (Monte Carlo plan evaluation, race
// simulation, bootstrap statistics) records its seed; re-running with the
// same seed and the same model versions must produce identical output. That
// property is what makes predictions auditable and research reproducible —
// so nothing on the platform may use Math.random().
//
// Core generator: xoshiro128** seeded via splitmix32. Pure module.

/** Derive a 32-bit seed from any mix of strings/numbers (order-sensitive). */
export function seedFrom(...parts) {
  let h = 0x9e3779b9;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13;
    }
    h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  }
  return h >>> 0;
}

/**
 * Create a deterministic PRNG stream from a numeric or string seed.
 * Returned object exposes uniform/gaussian/int/pick/shuffle helpers; all
 * derive from the same underlying stream so one seed fixes everything.
 */
export function createRng(seed = Date.now()) {
  const seed32 = typeof seed === 'number' ? (seed >>> 0) : seedFrom(seed);

  // splitmix32 expands one 32-bit seed into the four xoshiro state words.
  let sm = seed32 || 1;
  const splitmix = () => {
    sm = (sm + 0x9e3779b9) >>> 0;
    let z = sm;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  let s0 = splitmix(), s1 = splitmix(), s2 = splitmix(), s3 = splitmix();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1; // xoshiro state must be non-zero

  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const nextUint32 = () => {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9)) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };

  let gaussSpare = null; // Box–Muller produces pairs; cache the spare

  const rng = {
    seed: seed32,
    /** Uniform float in [0, 1). */
    float() { return nextUint32() / 4294967296; },
    /** Uniform float in [lo, hi). */
    uniform(lo, hi) { return lo + (hi - lo) * rng.float(); },
    /** Uniform integer in [lo, hi] inclusive. */
    int(lo, hi) { return lo + Math.floor(rng.float() * (hi - lo + 1)); },
    /** Normally distributed sample (Box–Muller). */
    gaussian(mean = 0, sd = 1) {
      if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return mean + sd * v; }
      let u, v, s;
      do { u = rng.float() * 2 - 1; v = rng.float() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      gaussSpare = v * m;
      return mean + sd * (u * m);
    },
    /** True with probability p. */
    chance(p) { return rng.float() < p; },
    /** Uniformly random element of a non-empty array. */
    pick(arr) {
      if (!Array.isArray(arr) || !arr.length) throw new TypeError('rng.pick() requires a non-empty array');
      return arr[rng.int(0, arr.length - 1)];
    },
    /** New array with the elements shuffled (Fisher–Yates); input untouched. */
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** Independent child stream — deterministic given this stream's state. */
    fork(label = 'fork') { return createRng(seedFrom(seed32, label, nextUint32())); },
  };
  return rng;
}
