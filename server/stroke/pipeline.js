// AI Stroke Analysis pipeline (moat #2) — an EXTENSIBLE, modular analysis
// platform, not a monolithic classifier. Each module implements the same tiny
// interface and is independently replaceable:
//
//   { id, name, version, available, requires(ctx)->bool, run(ctx)->result }
//
// where ctx = { kind, durationS, fps, marks:{catches:[s], finishes:[s]} } and a
// result = { metrics:{…}, observations:[{ text, confidence, tSeconds? }] }.
//
// Today the timeline marks are entered with assistance (the athlete/coach taps
// catch/finish on the video). The seam is deliberate: a future pose-estimation
// module produces the SAME marks automatically from raw frames, and every
// downstream module keeps working unchanged. Modules registered with
// available:false advertise that roadmap in the UI without pretending to run.
//
// Scientific integrity: every observation carries an explicit confidence, and
// nothing here claims certainty.

const round = (n, p = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const stdev = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/* -------- active modules -------- */

const strokeSegmentation = {
  id: 'stroke-segmentation', name: 'Stroke segmentation', version: '1.0', available: true,
  requires: (c) => (c.marks?.catches?.length || 0) >= 2,
  run: (c) => {
    const catches = [...c.marks.catches].sort((a, b) => a - b);
    const intervals = catches.slice(1).map((t, i) => t - catches[i]);
    return {
      metrics: { strokes: catches.length, avgStrokeS: round(mean(intervals), 2) },
      observations: [{ text: `Detected ${catches.length} strokes across ${round(c.durationS)}s.`, confidence: 0.9 }],
    };
  },
};

const strokeRate = {
  id: 'stroke-rate', name: 'Stroke-rate estimation', version: '1.0', available: true,
  requires: (c) => (c.marks?.catches?.length || 0) >= 2,
  run: (c) => {
    const catches = [...c.marks.catches].sort((a, b) => a - b);
    const intervals = catches.slice(1).map((t, i) => t - catches[i]);
    const avg = mean(intervals);
    const spm = avg ? 60 / avg : null;
    return {
      metrics: { strokeRateSpm: round(spm) },
      observations: spm ? [{ text: `Estimated stroke rate ≈ ${round(spm)} spm.`, confidence: 0.75 }] : [],
    };
  },
};

const driveRecoveryRatio = {
  id: 'ratio', name: 'Drive : recovery ratio', version: '1.0', available: true,
  requires: (c) => (c.marks?.catches?.length || 0) >= 2 && (c.marks?.finishes?.length || 0) >= 1,
  run: (c) => {
    const catches = [...c.marks.catches].sort((a, b) => a - b);
    const finishes = [...c.marks.finishes].sort((a, b) => a - b);
    const drives = [], recoveries = [];
    for (let i = 0; i < catches.length - 1; i++) {
      const fin = finishes.find(f => f > catches[i] && f < catches[i + 1]);
      if (fin == null) continue;
      drives.push(fin - catches[i]);
      recoveries.push(catches[i + 1] - fin);
    }
    const d = mean(drives), r = mean(recoveries);
    const ratio = d && r ? r / d : null;
    const obs = [];
    if (ratio != null) {
      obs.push({ text: `Drive:recovery ≈ 1:${round(ratio)}.`, confidence: 0.6 });
      if (ratio < 1.3) obs.push({ text: 'Recovery looks quick relative to the drive — you may be rushing the slide. A ratio nearer 1:2 lets the boat run.', confidence: 0.5 });
    }
    return { metrics: { driveS: round(d, 2), recoveryS: round(r, 2), ratio: round(ratio, 2) }, observations: obs };
  },
};

const rhythmConsistency = {
  id: 'consistency', name: 'Rhythm consistency', version: '1.0', available: true,
  requires: (c) => (c.marks?.catches?.length || 0) >= 4,
  run: (c) => {
    const catches = [...c.marks.catches].sort((a, b) => a - b);
    const intervals = catches.slice(1).map((t, i) => t - catches[i]);
    const m = mean(intervals), sd = stdev(intervals);
    const cv = m && sd != null ? sd / m : null;             // coefficient of variation
    const consistency = cv != null ? Math.max(0, Math.round((1 - cv) * 100)) : null;
    const obs = [];
    if (consistency != null) {
      obs.push({ text: `Rhythm consistency ≈ ${consistency}% (lower stroke-to-stroke variation is steadier).`, confidence: 0.6 });
      if (cv > 0.12) obs.push({ text: 'Stroke timing is uneven — a metronome or fixed-rate piece can smooth the rhythm.', confidence: 0.5 });
    }
    return { metrics: { consistencyPct: consistency, strokeTimeCv: round(cv, 3) }, observations: obs };
  },
};

// Documented FUTURE modules — the interface exists; they run nothing yet, so the
// UI can honestly show the roadmap instead of faking results.
const futureModules = [
  { id: 'pose-estimation', name: 'AI pose estimation (auto catch/finish)', version: '0', available: false },
  { id: 'body-position', name: 'Body-position & sequencing', version: '0', available: false },
  { id: 'handle-path', name: 'Handle-path tracking', version: '0', available: false },
  { id: 'symmetry', name: 'Left/right symmetry', version: '0', available: false },
  { id: 'video-stabilization', name: 'Video stabilization', version: '0', available: false },
];

const ACTIVE = [strokeSegmentation, strokeRate, driveRecoveryRatio, rhythmConsistency];
export const PIPELINE_VERSION = '1.0';

/** Public catalogue of modules (active + roadmap) for UI transparency. */
export function pipelineModules() {
  return [
    ...ACTIVE.map(m => ({ id: m.id, name: m.name, version: m.version, available: true })),
    ...futureModules,
  ];
}

/**
 * Run every applicable active module over the context and merge their outputs.
 * Modules whose `requires` is unmet are skipped (recorded in `skipped`), never
 * fabricated. Returns { metrics, observations, ran, skipped, pipelineVersion }.
 */
export function runPipeline(ctx) {
  const metrics = {};
  const observations = [];
  const ran = [], skipped = [];
  for (const m of ACTIVE) {
    if (!m.requires(ctx)) { skipped.push(m.id); continue; }
    try {
      const out = m.run(ctx);
      Object.assign(metrics, out.metrics || {});
      for (const o of out.observations || []) observations.push({ ...o, module: m.id });
      ran.push(m.id);
    } catch { skipped.push(m.id); }
  }
  observations.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return { metrics, observations, ran, skipped, pipelineVersion: PIPELINE_VERSION };
}
