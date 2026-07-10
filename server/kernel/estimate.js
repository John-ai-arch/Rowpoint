// Estimate — the universal value type of the computational platform.
//
// Every engine (twin, physics, optimizer, discovery, experiments, regatta)
// exchanges Estimates, never bare numbers. An Estimate always carries how the
// value was obtained (provenance), how spread out it is (uncertainty), how
// much the producing model trusts it (confidence), which model version made
// it, and how much evidence backs it — so any downstream number can answer
// "where did this come from and how sure are we".
//
// Pure module: no database, no I/O, no engine imports.

/** How a value was obtained, from strongest to weakest grounding. */
export const PROVENANCE = ['measured', 'estimated', 'assumed', 'predicted'];

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Construct a validated Estimate.
 * @param {object} e
 * @param {number} e.value            central value
 * @param {number|null} [e.uncertainty] standard-deviation-like spread; null = unknown spread
 * @param {number} [e.confidence]     0..1 producer confidence in the estimate
 * @param {string} e.provenance       one of PROVENANCE
 * @param {string} [e.modelVersion]   "name@version" of the producing model
 * @param {number} [e.evidenceCount]  observations supporting this value
 * @param {number} [e.updatedAt]      unix seconds
 */
export function makeEstimate({ value, uncertainty = null, confidence = 0.5, provenance, modelVersion = null, evidenceCount = 1, updatedAt = Math.floor(Date.now() / 1000) }) {
  if (!isFiniteNum(value)) throw new TypeError(`Estimate value must be a finite number, got ${value}`);
  if (uncertainty !== null && (!isFiniteNum(uncertainty) || uncertainty < 0)) throw new TypeError(`Estimate uncertainty must be null or a finite number >= 0, got ${uncertainty}`);
  if (!isFiniteNum(confidence) || confidence < 0 || confidence > 1) throw new TypeError(`Estimate confidence must be in [0,1], got ${confidence}`);
  if (!PROVENANCE.includes(provenance)) throw new TypeError(`Estimate provenance must be one of ${PROVENANCE.join('|')}, got ${provenance}`);
  if (!Number.isInteger(evidenceCount) || evidenceCount < 0) throw new TypeError(`Estimate evidenceCount must be a non-negative integer, got ${evidenceCount}`);
  return { value, uncertainty, confidence, provenance, modelVersion, evidenceCount, updatedAt };
}

/** Directly observed by a sensor or entered by the user. */
export const measured = (value, opts = {}) => makeEstimate({ value, uncertainty: 0, confidence: 0.95, provenance: 'measured', ...opts });
/** Computed from real observations through a documented model. */
export const estimated = (value, opts = {}) => makeEstimate({ value, confidence: 0.7, provenance: 'estimated', ...opts });
/** A documented default standing in for missing information. */
export const assumed = (value, opts = {}) => makeEstimate({ value, confidence: 0.3, provenance: 'assumed', ...opts });
/** A forward-looking model output about something not yet observed. */
export const predicted = (value, opts = {}) => makeEstimate({ value, confidence: 0.5, provenance: 'predicted', ...opts });

/** Structural check without throwing (for deserialized data). */
export function isEstimate(x) {
  return !!x && typeof x === 'object'
    && isFiniteNum(x.value)
    && (x.uncertainty === null || (isFiniteNum(x.uncertainty) && x.uncertainty >= 0))
    && isFiniteNum(x.confidence) && x.confidence >= 0 && x.confidence <= 1
    && PROVENANCE.includes(x.provenance);
}

/**
 * Merge two Estimates of the same quantity by inverse-variance weighting.
 * An unknown (null) or zero uncertainty is treated as a small floor so a
 * "certain" value dominates without dividing by zero. Evidence accumulates;
 * provenance takes the stronger of the two; confidence is the
 * evidence-weighted mean, never exceeding the stronger input.
 */
export function combine(a, b) {
  if (!isEstimate(a) || !isEstimate(b)) throw new TypeError('combine() requires two Estimates');
  const floor = 1e-6;
  const va = Math.max((a.uncertainty ?? defaultSpread(a)) ** 2, floor);
  const vb = Math.max((b.uncertainty ?? defaultSpread(b)) ** 2, floor);
  const wa = 1 / va, wb = 1 / vb;
  const value = (a.value * wa + b.value * wb) / (wa + wb);
  const uncertainty = Math.sqrt(1 / (wa + wb));
  const evidenceCount = (a.evidenceCount || 0) + (b.evidenceCount || 0);
  const confidence = Math.min(
    Math.max(a.confidence, b.confidence),
    (a.confidence * (a.evidenceCount || 1) + b.confidence * (b.evidenceCount || 1)) / ((a.evidenceCount || 1) + (b.evidenceCount || 1)) + 0.1,
  );
  const provenance = PROVENANCE[Math.min(PROVENANCE.indexOf(a.provenance), PROVENANCE.indexOf(b.provenance))];
  return makeEstimate({
    value, uncertainty, confidence: round3(confidence), provenance,
    modelVersion: b.modelVersion || a.modelVersion,
    evidenceCount,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0) || Math.floor(Date.now() / 1000),
  });
}

/**
 * Blend a previous state Estimate with a new observation-derived one.
 * `weightNew` in (0,1] controls responsiveness (an exponential update);
 * evidence accumulates and uncertainty shrinks slowly with evidence so the
 * state stabilizes as observations accumulate.
 */
export function blend(prev, next, weightNew = 0.3) {
  if (!isEstimate(next)) throw new TypeError('blend() requires a new Estimate');
  if (!isEstimate(prev)) return next;
  const w = Math.min(Math.max(weightNew, 0.01), 1);
  const value = prev.value * (1 - w) + next.value * w;
  const spreadPrev = prev.uncertainty ?? defaultSpread(prev);
  const spreadNext = next.uncertainty ?? defaultSpread(next);
  const evidenceCount = (prev.evidenceCount || 0) + (next.evidenceCount || 0);
  // Spread blends toward the new observation but shrinks with total evidence.
  const uncertainty = (spreadPrev * (1 - w) + spreadNext * w) / Math.sqrt(1 + Math.log10(Math.max(evidenceCount, 1)));
  const confidence = round3(Math.min(0.99, prev.confidence * (1 - w) + next.confidence * w + Math.min(evidenceCount, 50) / 500));
  const provenance = PROVENANCE[Math.min(PROVENANCE.indexOf(prev.provenance), PROVENANCE.indexOf(next.provenance))];
  return makeEstimate({
    value, uncertainty: round6(uncertainty), confidence, provenance,
    modelVersion: next.modelVersion || prev.modelVersion, evidenceCount,
    updatedAt: next.updatedAt || Math.floor(Date.now() / 1000),
  });
}

/** Age an Estimate: confidence decays toward 0 with a configurable half-life. */
export function decayConfidence(est, ageDays, halfLifeDays = 28) {
  if (!isEstimate(est)) throw new TypeError('decayConfidence() requires an Estimate');
  if (!isFiniteNum(ageDays) || ageDays <= 0) return est;
  const factor = Math.pow(0.5, ageDays / halfLifeDays);
  return { ...est, confidence: round3(est.confidence * factor) };
}

// When spread is unreported, infer a working spread from provenance: the
// weaker the grounding, the wider the assumed spread relative to the value.
function defaultSpread(e) {
  const rel = { measured: 0.01, estimated: 0.1, assumed: 0.3, predicted: 0.2 }[e.provenance] ?? 0.2;
  return Math.abs(e.value) * rel + 1e-3;
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
