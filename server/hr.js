// Server-side heart-rate helpers: series validation, summary statistics, and
// training-zone time computation. Mirrors the client's zone model (standard
// 50/60/70/80/90% of max-HR boundaries).
// (validation is range-checked inline — implausible samples are dropped)

export function effectiveMaxHr(user) {
  if (user?.max_hr) return user.max_hr;
  if (user?.birth_year) return Math.max(150, 220 - (new Date().getFullYear() - user.birth_year));
  return 190;
}

export function zoneBounds(maxHr) {
  return [0.5, 0.6, 0.7, 0.8, 0.9].map(f => Math.round(maxHr * f));
}

export function zoneIndex(bpm, maxHr) {
  const b = zoneBounds(maxHr);
  if (bpm < b[1]) return 0;
  if (bpm < b[2]) return 1;
  if (bpm < b[3]) return 2;
  if (bpm < b[4]) return 3;
  return 4;
}

/**
 * Sanitize a client-submitted HR series into [[tOffsetS, bpm], ...]:
 * monotonic, ≤1 Hz, plausible values only, capped length.
 */
export function sanitizeHrSeries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let lastT = -1;
  for (const item of raw.slice(0, 20000)) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const t = Number(item[0]);
    const bpm = Number(item[1]);
    // Implausible readings are garbage to be DROPPED, not clamped into range.
    if (!Number.isInteger(t) || t < 0 || t > 14400) continue;
    if (!Number.isFinite(bpm) || bpm < 25 || bpm > 250) continue;
    if (t <= lastT) continue;
    lastT = t;
    out.push([t, Math.round(bpm)]);
    if (out.length >= 14400) break;
  }
  return out;
}

/**
 * Summary over a sanitized series: min/max/avg BPM, seconds per zone, and HR
 * drift (second-half avg vs first-half avg, %) — a decoupling indicator.
 */
export function hrSummary(series, maxHr) {
  if (!series.length) return null;
  const bpms = series.map(([, b]) => b);
  const zones = [0, 0, 0, 0, 0];
  for (let i = 0; i < series.length; i++) {
    // Each sample covers the gap to the next sample (last one counts 1 s).
    const dt = i + 1 < series.length ? Math.min(series[i + 1][0] - series[i][0], 10) : 1;
    zones[zoneIndex(series[i][1], maxHr)] += Math.max(dt, 1);
  }
  const half = Math.floor(series.length / 2);
  const avgOf = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const firstAvg = half ? avgOf(bpms.slice(0, half)) : null;
  const secondAvg = half ? avgOf(bpms.slice(half)) : null;
  return {
    min: Math.min(...bpms),
    max: Math.max(...bpms),
    avg: Math.round(avgOf(bpms)),
    zoneSeconds: zones,
    maxHrUsed: maxHr,
    driftPct: firstAvg && secondAvg ? Math.round(((secondAvg - firstAvg) / firstAvg) * 1000) / 10 : null,
  };
}
