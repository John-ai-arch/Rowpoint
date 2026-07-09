// Standardized research variables (Feature B). Computes the reproducible,
// well-defined variables an observational study needs from a set of an athlete's
// workouts, preserving traceability to the source measurements. Each variable is
// tagged with a `type` — measured | derived | estimate — so downstream analysis
// never confuses a raw reading with a modelled quantity, and with a `unit`.
//
// Definitions live here and are surfaced verbatim in the auto data dictionary,
// so the software and its documentation can never drift apart.
const DAY = 86400;
const round = (n, p = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1)); };

const V = (value, type, unit, definition) => ({ value, type, unit, definition });

/**
 * @param {Array} workouts rows with { started_at, total_distance_m, total_time_s,
 *   avg_split_s, avg_stroke_rate, avg_heart_rate, hr_zones_json }
 * @param {number} nowS reference "now" (injectable)
 */
export function computeResearchVariables(workouts, nowS = Math.floor(Date.now() / 1000)) {
  const rows = (workouts || [])
    .filter(w => Number.isFinite(Number(w.started_at)))
    .map(w => ({
      at: Number(w.started_at),
      meters: Number(w.total_distance_m) || 0,
      minutes: (Number(w.total_time_s) || 0) / 60,
      split: Number(w.avg_split_s) || null,
      rate: Number(w.avg_stroke_rate) || null,
      hr: Number(w.avg_heart_rate) || null,
      zones: typeof w.hr_zones_json === 'string' ? safe(w.hr_zones_json) : w.hr_zones_json,
    }))
    .sort((a, b) => a.at - b.at);

  if (!rows.length) return { hasData: false, workouts: V(0, 'measured', 'count', 'Number of workouts in the record.') };

  const within = (days) => rows.filter(r => (nowS - r.at) <= days * DAY);
  const spanDays = Math.max(1, (rows[rows.length - 1].at - rows[0].at) / DAY);
  const spanWeeks = Math.max(1, spanDays / 7);

  // ---- volume & frequency ----
  const totalMeters = sum(rows.map(r => r.meters));
  const last7 = within(7), last28 = within(28);
  const weeklyMeters = round(sum(last28.map(r => r.meters)) / 4, 0);
  const weeklySessions = round(last28.length / 4, 2);
  const monthlyMeters = round(sum(last28.map(r => r.meters)), 0);

  // ---- training load (load unit = session minutes) ----
  const rolling7 = round(sum(last7.map(r => r.minutes)), 0);
  const rolling28 = round(sum(last28.map(r => r.minutes)), 0);
  const chronicWeekly = rolling28 / 4;
  const acwr = chronicWeekly > 5 ? round(rolling7 / chronicWeekly, 2) : null;

  // ---- Foster monotony & strain over the last 7 days (per-day loads) ----
  const dayLoads = [];
  for (let d = 0; d < 7; d++) {
    const from = nowS - (d + 1) * DAY, to = nowS - d * DAY;
    dayLoads.push(sum(rows.filter(r => r.at >= from && r.at < to).map(r => r.minutes)));
  }
  const dl = dayLoads;
  const monotony = mean(dl) && sd(dl) ? round(mean(dl) / sd(dl), 2) : null;
  const weekLoad = sum(dl);
  const strain = monotony != null ? round(weekLoad * monotony, 0) : null;

  // ---- intensity / zone distribution (from HR zones when present) ----
  const zoneSecs = [0, 0, 0, 0, 0];
  for (const r of last28) {
    const z = r.zones?.zoneSeconds;
    if (Array.isArray(z)) for (let i = 0; i < 5 && i < z.length; i++) zoneSecs[i] += Number(z[i]) || 0;
  }
  const zoneTotal = sum(zoneSecs);
  const hrZoneDistribution = zoneTotal
    ? zoneSecs.map(s => round((s / zoneTotal) * 100, 1))
    : null;
  const intensityDistribution = zoneTotal ? {
    easyPct: round(((zoneSecs[0] + zoneSecs[1]) / zoneTotal) * 100, 1),
    moderatePct: round((zoneSecs[2] / zoneTotal) * 100, 1),
    hardPct: round(((zoneSecs[3] + zoneSecs[4]) / zoneTotal) * 100, 1),
  } : null;

  // ---- stroke-rate distribution (histogram, 2-spm bins 16..40) ----
  const rates = rows.map(r => r.rate).filter(Number.isFinite);
  const strokeRateMean = round(mean(rates), 1);

  // ---- recovery spacing ----
  const daysBetween = rows.length >= 2
    ? round(mean(rows.slice(1).map((r, i) => (r.at - rows[i].at) / DAY)), 2) : null;

  // ---- consistency: share of weeks in the record with ≥1 session ----
  const weekKeys = new Set(rows.map(r => Math.floor(r.at / (7 * DAY))));
  const consistencyScore = round((weekKeys.size / Math.ceil(spanWeeks)) * 100, 0);

  // ---- performance progression (2k pieces ≈ 2000 m) ----
  const twoKs = rows.filter(r => Math.abs(r.meters - 2000) <= 25 && r.split > 0);
  let best2k = null, improvementRatePerMonth = null, timeToPrDays = null;
  if (twoKs.length) {
    best2k = Math.min(...twoKs.map(r => r.split * 4));
    if (twoKs.length >= 2) {
      const firstT = twoKs[0].split * 4, lastT = twoKs[twoKs.length - 1].split * 4;
      const months = Math.max(0.5, (twoKs[twoKs.length - 1].at - twoKs[0].at) / (30 * DAY));
      improvementRatePerMonth = round((firstT - lastT) / months, 2); // + = getting faster
      // time from first piece to the fastest piece
      const prRow = twoKs.reduce((b, r) => (r.split * 4 < b.split * 4 ? r : b), twoKs[0]);
      timeToPrDays = round((prRow.at - twoKs[0].at) / DAY, 0);
    }
  }

  // ---- fatigue estimate (clearly labelled: NOT a measurement) ----
  let fatigueEstimate = 'insufficient_data';
  if (acwr != null && monotony != null) {
    fatigueEstimate = (acwr >= 1.5 || (acwr >= 1.3 && monotony >= 2)) ? 'elevated'
      : acwr <= 0.8 ? 'low' : 'moderate';
  }

  return {
    hasData: true,
    workouts: V(rows.length, 'measured', 'count', 'Number of workouts in the record.'),
    totalMeters: V(round(totalMeters, 0), 'measured', 'm', 'Sum of workout distances.'),
    weeklyMeters: V(weeklyMeters, 'derived', 'm/week', 'Mean weekly distance over the last 28 days.'),
    weeklySessions: V(weeklySessions, 'derived', 'sessions/week', 'Mean sessions per week over the last 28 days.'),
    monthlyMeters: V(monthlyMeters, 'derived', 'm/28d', 'Distance in the last 28 days.'),
    rolling7dLoadMin: V(rolling7, 'derived', 'min', 'Total session minutes in the last 7 days (acute load).'),
    rolling28dLoadMin: V(rolling28, 'derived', 'min', 'Total session minutes in the last 28 days (chronic load).'),
    acuteChronicWorkloadRatio: V(acwr, 'derived', 'ratio', 'Acute (7d) load ÷ mean weekly chronic (28d) load. ~0.8–1.3 typical.'),
    trainingMonotony: V(monotony, 'derived', 'ratio', 'Foster monotony: mean daily load ÷ SD of daily load over 7 days.'),
    trainingStrain: V(strain, 'derived', 'AU', 'Foster strain: weekly load × monotony.'),
    intensityDistribution: V(intensityDistribution, 'derived', '%', 'Share of HR-zone time that is easy (Z1–2), moderate (Z3), hard (Z4–5) over 28 days.'),
    hrZoneDistributionPct: V(hrZoneDistribution, 'derived', '%', 'Percent of recorded HR time in each of 5 zones over 28 days.'),
    strokeRateMean: V(strokeRateMean, 'measured', 'spm', 'Mean average stroke rate across workouts.'),
    daysBetweenWorkouts: V(daysBetween, 'derived', 'days', 'Mean gap between consecutive workouts.'),
    consistencyScore: V(consistencyScore, 'derived', '%', 'Share of weeks in the record containing at least one session.'),
    best2kSeconds: V(best2k != null ? round(best2k, 1) : null, 'measured', 's', 'Fastest recorded 2000 m piece.'),
    improvementRatePerMonth: V(improvementRatePerMonth, 'derived', 's/month', '2k time improvement per month (positive = faster).'),
    timeToPersonalRecordDays: V(timeToPrDays, 'derived', 'days', 'Days from first 2k to the fastest 2k in the record.'),
    fatigueEstimate: V(fatigueEstimate, 'estimate', 'category', 'Heuristic from ACWR + monotony. An ESTIMATE, not a measurement or diagnosis.'),
  };
}

function safe(s) { try { return JSON.parse(s); } catch { return null; } }
