// Unit tests: training analysis engine + AI coach fallback, pacing classifier,
// plan validation, CSAFE framing, HR parsing, feedback phrasing fallback.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ROWPOINT_DATA_DIR = process.env.ROWPOINT_DATA_DIR || '/tmp/rowpoint-unit';
delete process.env.ANTHROPIC_API_KEY; // fallback paths under test

const { analyzeWorkouts, classifyWorkoutZone, ZONES } = await import('../server/ai/trainingAnalysis.js');
const { fallbackRecommendation, generateRecommendation, defaultPlanFor, CATEGORIES, templateFeedbackText, phraseFeedback } = await import('../server/ai/coach.js');
const { classifyPacing, classifyIntervals, PACING } = await import('../server/ai/pacing.js');
const { validatePlan } = await import('../server/ai/planValidation.js');
const {
  buildFrame, parseFrame, encodeWorkout, encodeTerminateWorkout,
  encodeForcePlotRequest, parseForcePlotResponse, describeMachineStatus, CSAFE,
} = await import('../public/js/ble/csafe.js');
const { buildHrPacket, parseForceCurveNotification, Concept2PM5Adapter } = await import('../public/js/ble/pm5.js');
const {
  Transport, detectTransport, canonicalUuid, normalizeRequestOptions,
  normalizeWebBleDevice, WebBLETransport, BluetoothManagerImpl,
} = await import('../public/js/ble/transport.js');
const { parseHrMeasurement, BleHeartRateMonitor } = await import('../public/js/ble/sensors.js');
const { FTMSAdapter } = await import('../public/js/ble/ftms.js');
const { sanitizeHrSeries, hrSummary, zoneIndex, effectiveMaxHr } = await import('../server/hr.js');
const { computeResearchVariables } = await import('../server/research/variables.js');
const { qualityFlags } = await import('../server/research/quality.js');

/* ---------------- research variables + quality (research platform) ---------------- */

test('computeResearchVariables produces labelled derived variables with units', () => {
  const now = 1_700_000_000;
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ started_at: now - i * 3 * 86400, total_distance_m: 6000, total_time_s: 1500, avg_split_s: 125, avg_stroke_rate: 24, avg_heart_rate: 150, hr_zones_json: JSON.stringify({ zoneSeconds: [600, 500, 300, 80, 20] }) });
  rows.push({ started_at: now - 40 * 86400, total_distance_m: 2000, total_time_s: 420, avg_split_s: 105, avg_stroke_rate: 32 });
  rows.push({ started_at: now - 5 * 86400, total_distance_m: 2000, total_time_s: 410, avg_split_s: 102.5, avg_stroke_rate: 33 });
  const v = computeResearchVariables(rows, now);
  assert.equal(v.hasData, true);
  assert.equal(v.weeklyMeters.type, 'derived');
  assert.equal(v.weeklyMeters.unit, 'm/week');
  assert.ok(v.acuteChronicWorkloadRatio.value > 0);
  assert.ok(v.intensityDistribution.value.easyPct > v.intensityDistribution.value.hardPct, 'mostly easy');
  assert.equal(v.best2kSeconds.value, 410, 'fastest 2k captured');
  assert.equal(v.fatigueEstimate.type, 'estimate', 'fatigue is explicitly an estimate, not a measurement');
  // empty input degrades gracefully
  assert.equal(computeResearchVariables([], now).hasData, false);
});

test('qualityFlags catches implausible and incomplete records without deleting them', () => {
  assert.deepEqual(qualityFlags({ total_distance_m: 2000, total_time_s: 420, avg_split_s: 105, avg_stroke_rate: 30, avg_heart_rate: 170 }, [{}]), [], 'clean record has no flags');
  assert.ok(qualityFlags({ total_distance_m: 0, total_time_s: 0 }, []).includes('zero_distance'));
  assert.ok(qualityFlags({ total_distance_m: 500, total_time_s: 30, avg_split_s: 40 }, [{}]).includes('impossible_pace'));
  assert.ok(qualityFlags({ total_distance_m: 500, total_time_s: 120, avg_heart_rate: 300 }, [{}]).includes('unrealistic_heart_rate'));
  assert.ok(qualityFlags({ total_distance_m: 5000, total_time_s: 1200, avg_split_s: 120 }, [{}]).includes('incomplete_sensors'), 'no HR + no power flagged');
});

/* ---------------- training analysis + coach fallback ---------------- */

const NOW = 1750000000; // fixed "now" so the analysis is fully deterministic
const DAY = 86400;

// A synthetic workout `daysAgo` days before NOW. best2k of 420s → 2k split
// 105 s/500m, so split 125 classifies UT2, 112 threshold, 107 VO2, 102 sprint.
function mkWorkout(daysAgo, { minutes = 40, split = 125, hr = null, plan = null } = {}) {
  return {
    started_at: NOW - daysAgo * DAY,
    total_distance_m: Math.round((minutes * 60 / split) * 500),
    total_time_s: minutes * 60,
    avg_split_s: split,
    avg_stroke_rate: 20,
    avg_heart_rate: hr,
    max_heart_rate: hr ? hr + 15 : null,
    machine_type: 'rower',
    workout_plan_json: plan ? JSON.stringify(plan) : null,
    hr_zones_json: null,
    ai_feedback_json: null,
    assigned_by_coach_id: null,
  };
}

function mkAnalysis(workouts, { best2kSeconds = 420, goalType = 'general_fitness', daysToEvent = null, constraints = {} } = {}) {
  const base = analyzeWorkouts(workouts, { best2kSeconds, maxHr: 190 }, NOW);
  return {
    athlete: {
      accountType: 'rower', age: 30, weightKg: 80, weightClass: null,
      best2kSeconds, best2kSplitS: best2kSeconds / 4, best2kVerified: true,
      maxHr: 190, restingHr: 55,
      goal: { type: goalType, targetEvent: null, targetDate: null, daysToEvent, weeklySessions: null, weeklyMinutes: null },
    },
    ...base,
    wellness: { checkins14d: 0, avgSleepHours: null, avgSoreness: null, avgStress: null, lowSleepHighSorenessDays: 0 },
    compliance: { suggestionsLast30d: 0, followed: 0, followRatePct: null },
    constraints: { hasCoachAssignmentToday: false, overtrainingRisk: false, ...constraints },
  };
}

test('workout zone classification follows standard pace bands relative to 2k split', () => {
  const athlete = { best2kSeconds: 420, maxHr: 190 }; // 2k split 105
  assert.equal(classifyWorkoutZone({ avg_split_s: 125 }, athlete), 'ut2');
  assert.equal(classifyWorkoutZone({ avg_split_s: 117 }, athlete), 'ut1');
  assert.equal(classifyWorkoutZone({ avg_split_s: 112 }, athlete), 'threshold');
  assert.equal(classifyWorkoutZone({ avg_split_s: 107 }, athlete), 'vo2');
  assert.equal(classifyWorkoutZone({ avg_split_s: 102 }, athlete), 'sprint');
  // HR fallback when no 2k benchmark exists
  assert.equal(classifyWorkoutZone({ avg_heart_rate: 120 }, { maxHr: 190 }), 'ut2');
  assert.equal(classifyWorkoutZone({ avg_heart_rate: 180 }, { maxHr: 190 }), 'sprint');
});

test('analysis computes volume, distribution, and recovery from real history', () => {
  const workouts = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28].map(d => mkWorkout(d));
  const a = analyzeWorkouts(workouts, { best2kSeconds: 420, maxHr: 190 }, NOW);
  assert.equal(a.history.totalWorkouts, 10);
  assert.equal(a.volume.last7d.sessions, 3);
  assert.equal(a.volume.last28d.sessions, 10);
  assert.equal(a.distribution28d.zonePct.ut2, 100); // all steady UT2
  assert.equal(a.recovery.daysSinceLastWorkout, 1);
  assert.equal(a.recovery.hardSessionsLast7d, 0);
  assert.ok(a.distribution28d.missingZones.includes('threshold'));
  assert.ok(a.distribution28d.missingZones.includes('vo2'));
});

test('weeks of exclusively steady work → coach prescribes quality (threshold intervals)', () => {
  const workouts = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28].map(d => mkWorkout(d));
  const rec = fallbackRecommendation(mkAnalysis(workouts));
  assert.equal(rec.category, 'threshold_intervals');
  assert.equal(rec.restDay, false);
  assert.equal(rec.source, 'analysis_engine');
  assert.ok(rec.whyAppropriate.length > 20);
  assert.ok(rec.workout.plan, 'quality session comes with a programmable plan');
  assert.equal(validatePlan(rec.workout.plan).ok, true);
});

test('a week dense with hard intervals → recovery row, not more intensity', () => {
  const workouts = [
    mkWorkout(1, { split: 107, minutes: 30 }), mkWorkout(2, { split: 107, minutes: 30 }),
    mkWorkout(4, { split: 106, minutes: 30 }), mkWorkout(6, { split: 108, minutes: 30 }),
    ...[9, 12, 15, 18, 21, 24, 27].map(d => mkWorkout(d)),
  ];
  const rec = fallbackRecommendation(mkAnalysis(workouts));
  assert.equal(rec.category, 'recovery_row');
  assert.equal(rec.workout.intensity, 'very_low');
});

test('several days without training → easy return session, never maximal', () => {
  const workouts = [7, 10, 13, 16].map(d => mkWorkout(d));
  const rec = fallbackRecommendation(mkAnalysis(workouts));
  assert.equal(rec.category, 'return_easy');
  assert.notEqual(rec.workout.intensity, 'very_high');
  assert.notEqual(rec.workout.intensity, 'high');
});

test('2k race prep close to the event → race-pace specificity', () => {
  const workouts = [
    mkWorkout(2), mkWorkout(4, { split: 112 }), mkWorkout(6),
    ...[9, 11, 13, 15, 17, 19, 21, 23, 25, 27].map(d => mkWorkout(d)),
  ];
  const rec = fallbackRecommendation(mkAnalysis(workouts, { goalType: 'race_prep', daysToEvent: 10 }));
  assert.equal(rec.category, 'race_pace');
  assert.equal(rec.workout.targetPaceSPer500m, 105); // their actual 2k split
});

test('different histories produce different recommendations', () => {
  const steady = fallbackRecommendation(mkAnalysis([1, 4, 7, 10, 13, 16, 19, 22, 25, 28].map(d => mkWorkout(d))));
  const stale = fallbackRecommendation(mkAnalysis([8, 11, 14].map(d => mkWorkout(d))));
  const hardWeek = fallbackRecommendation(mkAnalysis([
    mkWorkout(1, { split: 107, minutes: 30 }), mkWorkout(2, { split: 107, minutes: 30 }),
    mkWorkout(4, { split: 106, minutes: 30 }), ...[9, 12, 15, 18, 21, 24, 27].map(d => mkWorkout(d)),
  ]));
  const categories = new Set([steady.category, stale.category, hardWeek.category]);
  assert.equal(categories.size, 3, `expected 3 distinct recommendations, got ${[...categories]}`);
});

test('deterministic given identical analysis; recommendation is explainable', () => {
  const workouts = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28].map(d => mkWorkout(d));
  const a = mkAnalysis(workouts);
  assert.deepEqual(fallbackRecommendation(a), fallbackRecommendation(a));
  const rec = fallbackRecommendation(a);
  assert.ok(rec.keyFactors.length >= 1, 'key factors cite the data behind the pick');
  assert.ok(rec.targetSystem.length > 5);
  assert.ok(rec.expectedAdaptations.length > 5);
  assert.ok(rec.recoveryAdvice.length > 5);
  assert.ok(['low', 'medium', 'high'].includes(rec.confidence));
});

test('coach assignment today always wins (guardrail)', async () => {
  const rec = await generateRecommendation(mkAnalysis([mkWorkout(1)], { constraints: { hasCoachAssignmentToday: true } }));
  assert.equal(rec.category, 'coach_assignment');
});

test('overtraining risk always yields rest with a health prompt (guardrail)', async () => {
  const workouts = [1, 2, 3, 4, 5].map(d => mkWorkout(d, { split: 107, minutes: 40 }));
  const rec = await generateRecommendation(mkAnalysis(workouts, { constraints: { overtrainingRisk: true } }));
  assert.equal(rec.restDay, true);
  assert.equal(rec.category, 'rest');
  assert.equal(rec.healthPrompt, true);
});

test('every recommendation category yields a monitor-valid plan (or null for rest)', () => {
  for (const c of CATEGORIES) {
    const plan = defaultPlanFor(c, 30, 50, null);
    if (plan !== null) assert.equal(validatePlan(plan).ok, true, `invalid plan for ${c}`);
  }
  assert.ok(Array.isArray(ZONES) && ZONES.length === 5);
});

/* ---------------- pacing classifier ---------------- */

const mkSplits = (paces, rates) => paces.map((p, i) => ({
  avg_pace_s_per_500m: p, time_s: p, distance_m: 500, avg_stroke_rate: rates?.[i] ?? 24,
}));

test('fly-and-die → started_too_hard', () => {
  const r = classifyPacing(mkSplits([118, 121, 125, 129, 133, 137]));
  assert.equal(r.tag, PACING.TOO_HARD);
  assert.ok(r.firstThirdPace < r.avgPace);
});

test('big negative split with rising rate → started_too_easy', () => {
  const r = classifyPacing(mkSplits([135, 133, 130, 126, 123, 120], [20, 21, 22, 24, 26, 29]));
  assert.equal(r.tag, PACING.TOO_EASY);
});

test('even splits → well_paced', () => {
  const r = classifyPacing(mkSplits([125, 125.5, 124.8, 125.2, 124.9, 125.1]));
  assert.equal(r.tag, PACING.WELL_PACED);
});

test('fewer than 3 splits → insufficient_data', () => {
  assert.equal(classifyPacing(mkSplits([120, 121])).tag, PACING.INSUFFICIENT);
});

test('per-interval classification finds a repeated error (§11.4)', () => {
  const hard = mkSplits([115, 120, 126]);
  const r = classifyIntervals([hard, hard, mkSplits([120, 120, 120])]);
  assert.equal(r.overall, PACING.TOO_HARD);
  assert.equal(r.perInterval.length, 3);
});

/* ---------------- plan validation (§1.3) ---------------- */

test('plan validation enforces PM5-style limits with instant feedback', () => {
  assert.equal(validatePlan({ type: 'distance', distanceM: 2000 }).ok, true);
  assert.equal(validatePlan({ type: 'distance', distanceM: 50 }).ok, false);
  assert.equal(validatePlan({ type: 'time', durationS: 10 }).ok, false);
  assert.equal(validatePlan({ type: 'intervals', intervals: [] }).ok, false);
  assert.equal(validatePlan({ type: 'intervals', intervals: Array.from({ length: 31 }, () => ({ workType: 'time', workTimeS: 60 })) }).ok, false);
  assert.equal(validatePlan({ type: 'intervals', intervals: [{ workType: 'distance', workDistanceM: 500, restTimeS: 60 }] }).ok, true);
  assert.equal(validatePlan({ type: 'intervals', intervals: [{ workType: 'distance', workDistanceM: 500, restTimeS: 9999 }] }).ok, false);
});

/* ---------------- CSAFE framing ---------------- */

test('CSAFE frame roundtrip with byte stuffing and checksum', () => {
  const contents = [0x1A, 0x03, 0xF2, 0x01, 0xF0]; // includes bytes needing escape
  const frame = buildFrame(contents);
  assert.equal(frame[0], 0xF1);
  assert.equal(frame[frame.length - 1], 0xF2);
  // No unescaped control bytes inside
  for (let i = 1; i < frame.length - 1; i++) {
    if (frame[i] >= 0xF0 && frame[i] <= 0xF3) assert.equal(frame[i], 0xF3, `unescaped byte at ${i}`);
    if (frame[i] === 0xF3) i++; // skip escaped payload byte
  }
  const parsed = parseFrame(Uint8Array.from([0xF1, 0x81, 0x00, 0x81, 0xF2])); // status frame w/ checksum
  assert.ok(parsed.valid);
});

test('encodeWorkout emits frames for all plan types', () => {
  for (const plan of [
    { type: 'justrow' },
    { type: 'time', durationS: 1800 },
    { type: 'distance', distanceM: 2000 },
    { type: 'intervals', intervals: [{ workType: 'distance', workDistanceM: 500, restTimeS: 60 }, { workType: 'time', workTimeS: 120, restTimeS: 90 }] },
  ]) {
    const frames = encodeWorkout(plan);
    assert.ok(frames.length >= 1);
    assert.ok(frames[0] instanceof Uint8Array);
    assert.equal(frames[0][0], 0xF1);
  }
});

/* ---- Golden frames from the Concept2 PM CSAFE Communication Definition
   rev 0.27, "Proprietary CSAFE Workout Configuration" worked examples —
   these sequences are exactly what ErgData sends to program the monitor. */

const hex = (u8) => [...u8].map(b => b.toString(16).padStart(2, '0')).join(' ');

test('encodeWorkout matches the spec JustRow example byte-for-byte', () => {
  assert.equal(hex(encodeWorkout({ type: 'justrow' })[0]),
    'f1 76 07 01 01 01 13 02 01 01 61 f2');
});

test('encodeWorkout matches the spec fixed-distance 2000m example byte-for-byte', () => {
  // 2000 m with 400 m splits: big-endian values, 0x76 wrapper, closed with
  // CONFIGURE_WORKOUT + SET_SCREENSTATE(workout, prepare-to-row).
  assert.equal(hex(encodeWorkout({ type: 'distance', distanceM: 2000 })[0]),
    'f1 76 18 01 01 03 03 05 80 00 00 07 d0 05 05 80 00 00 01 90 14 01 01 13 02 01 01 28 f2');
});

test('encodeWorkout matches the spec fixed-time 20:00 example byte-for-byte', () => {
  assert.equal(hex(encodeWorkout({ type: 'time', durationS: 1200 })[0]),
    'f1 76 18 01 01 05 03 05 00 00 01 d4 c0 05 05 00 00 00 5d c0 14 01 01 13 02 01 01 e0 f2');
});

test('encodeWorkout variable-interval frame matches the spec example structure', () => {
  // Spec example: v500m/1:00r, 3:00/0:00r, 1000m/0:00r, 5:00/2:00r @1:40 pace.
  const frames = encodeWorkout({ type: 'intervals', intervals: [
    { workType: 'distance', workDistanceM: 500, restTimeS: 60, targetPaceS: 100 },
    { workType: 'time', workTimeS: 180, restTimeS: 0, targetPaceS: 100 },
    { workType: 'distance', workDistanceM: 1000, restTimeS: 0, targetPaceS: 100 },
    { workType: 'time', workTimeS: 300, restTimeS: 120, targetPaceS: 100 },
  ] });
  assert.equal(frames.length, 1);
  // Contents exactly as listed in the spec's per-byte table (its printed
  // checksum contradicts its own bytes, so assert the XOR instead).
  assert.equal(hex(frames[0].slice(0, frames[0].length - 2)),
    'f1 76 6f 18 01 00 01 01 08 17 01 01 03 05 80 00 00 01 f4 04 02 00 3c 06 04 00 00 27 10 14 01 01'
    + ' 18 01 01 17 01 00 03 05 00 00 00 46 50 04 02 00 00 06 04 00 00 27 10 14 01 01'
    + ' 18 01 02 17 01 01 03 05 80 00 00 03 e8 04 02 00 00 06 04 00 00 27 10 14 01 01'
    + ' 18 01 03 17 01 00 03 05 00 00 00 75 30 04 02 00 78 06 04 00 00 27 10 14 01 01'
    + ' 13 02 01 01');
  const parsed = parseFrame(frames[0]);
  assert.ok(parsed.valid, 'checksum must be self-consistent');
});

test('encodeWorkout chunks long interval lists into ≤120-byte frames, screen-state only at the end', () => {
  const frames = encodeWorkout({ type: 'intervals', intervals:
    Array.from({ length: 30 }, (_, i) => ({ workType: 'distance', workDistanceM: 500 + i, restTimeS: 60 })) });
  assert.ok(frames.length > 1);
  const indices = [];
  frames.forEach((f, fi) => {
    assert.ok(f.length <= 120, `frame ${fi} is ${f.length} bytes`);
    const p = parseFrame(f);
    assert.ok(p.valid);
    // parseFrame treats command frames as [status, ...]; reconstruct contents:
    const contents = [p.status, ...p.payload];
    assert.equal(contents[0], 0x76, 'C2 proprietary wrapper');
    assert.equal(contents[1], contents.length - 2, 'wrapper byte count');
    for (let i = 2; i < contents.length;) {
      const cmd = contents[i], len = contents[i + 1];
      if (cmd === CSAFE.PM_SET_WORKOUTINTERVALCOUNT) indices.push(contents[i + 2]);
      if (cmd === CSAFE.PM_SET_SCREENSTATE) {
        assert.equal(fi, frames.length - 1, 'screen state only in the final frame');
        assert.equal(i + 2 + len, contents.length, 'screen state is the last command');
      }
      i += 2 + len;
    }
  });
  assert.deepEqual(indices, Array.from({ length: 30 }, (_, i) => i), 'contiguous interval indices');
  // First frame must declare the variable-interval workout type.
  const first = parseFrame(frames[0]);
  assert.ok([first.status, ...first.payload].join(',').includes([CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_VARIABLE_INTERVAL].join(',')));
});

test('terminate + force-plot request frames match the spec examples', () => {
  const term = encodeTerminateWorkout();
  assert.equal(hex(term.slice(0, term.length - 2)), 'f1 76 04 13 02 01 02');
  assert.ok(parseFrame(term).valid);
  // Spec "Get Force Curve" example: F1 1A 03 6B 01 14 67 F2
  assert.equal(hex(encodeForcePlotRequest(20)), 'f1 1a 03 6b 01 14 67 f2');
});

test('describeMachineStatus reads the CSAFE Table 9 status bits', () => {
  assert.equal(describeMachineStatus(0x81), null);            // OK, ready state
  assert.equal(describeMachineStatus(0x01), null);            // OK (toggle 0)
  assert.match(describeMachineStatus(0x91), /rejected/);      // prev frame rejected
  assert.match(describeMachineStatus(0x21), /corrupted|read/); // bad frame
  assert.match(describeMachineStatus(0xB1), /busy/);          // not ready
  assert.match(describeMachineStatus(0x80), /error/i);        // error state nibble
});

/* ---------------- PM5 heart-rate forwarding + force curve parsing ---------------- */

test('buildHrPacket lays out the 20-byte PM heart-rate packet (CSAFE spec 0x0041)', () => {
  const p = buildHrPacket(152, { rrMs: 400 });
  assert.equal(p.length, 20);
  assert.equal(p[0], 0);                       // BT source
  assert.equal(p[5] | (p[6] << 8), 152);       // HR value LE
  assert.equal(p[3] | (p[4] << 8), Math.round(400 * 1024 / 1000)); // RR in 1/1024 s
  assert.equal(p[7], 0x11);                    // flags: 16-bit HR + RR present
  const noRr = buildHrPacket(70);
  assert.equal(noRr[7], 0x01);
  assert.equal(noRr[3] | (noRr[4] << 8), 0);
});

test('parseForceCurveNotification assembles a curve across chunks (BLE spec 0x003D)', () => {
  const dv = (...bytes) => new DataView(Uint8Array.from(bytes).buffer);
  const accum = [];
  // Curve of 12 words in 2 chunks: byte0 = (total chunks << 4) | words here.
  const chunk0 = dv(0x29, 0, 10, 0, 20, 0, 30, 0, 40, 0, 50, 0, 60, 0, 70, 0, 80, 0, 90, 0);
  const chunk1 = dv(0x23, 1, 100, 0, 90, 0, 40, 0);
  assert.equal(parseForceCurveNotification(chunk0, accum), null);
  assert.equal(accum.length, 9);
  const curve = parseForceCurveNotification(chunk1, accum);
  assert.deepEqual(curve, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 90, 40]);
  assert.equal(accum.length, 0, 'accumulator resets after emitting');
  // A fresh curve starting at sequence 0 discards any stale partial data.
  accum.push(999);
  assert.equal(parseForceCurveNotification(chunk0, accum), null);
  assert.deepEqual(accum.slice(0, 2), [10, 20]);
});

test('parseForcePlotResponse decodes the spec example response payload', () => {
  // Response payload (after status): 1A 23 6B 21 14 <20 data bytes + padding>
  const payload = [0x1A, 0x23, 0x6B, 0x21, 0x14,
    0x41, 0x00, 0x41, 0x00, 0x79, 0x00, 0xAE, 0x00, 0xB8, 0x00,
    0xB9, 0x00, 0xBA, 0x00, 0xB9, 0x00, 0xB9, 0x00, 0xB6, 0x00,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const res = parseForcePlotResponse(payload);
  assert.equal(res.bytesRead, 20);
  assert.deepEqual(res.samples, [0x41, 0x41, 0x79, 0xAE, 0xB8, 0xB9, 0xBA, 0xB9, 0xB9, 0xB6]);
  assert.equal(parseForcePlotResponse([0x76, 0x05, 0x01]), null);
});

/* ---------------- HR measurement parsing (Bluetooth SIG HRM profile) ---------------- */

const dv = (...bytes) => new DataView(Uint8Array.from(bytes).buffer);

test('HRM parsing: 8-bit heart rate (flags 0x00)', () => {
  const r = parseHrMeasurement(dv(0x00, 72));
  assert.equal(r.bpm, 72);
  assert.deepEqual(r.rrIntervalsMs, []);
  assert.equal(r.energyExpendedKj, null);
});

test('HRM parsing: 16-bit heart rate (flags 0x01)', () => {
  const r = parseHrMeasurement(dv(0x01, 0x2c, 0x01)); // 300 → out of range → null
  assert.equal(r.bpm, null);
  const r2 = parseHrMeasurement(dv(0x01, 0xb4, 0x00)); // 180
  assert.equal(r2.bpm, 180);
});

test('HRM parsing: energy expended field is decoded and skipped correctly', () => {
  // flags 0x08: u8 HR + u16 energy
  const r = parseHrMeasurement(dv(0x08, 140, 0x10, 0x27)); // energy 10000 kJ
  assert.equal(r.bpm, 140);
  assert.equal(r.energyExpendedKj, 10000);
});

test('HRM parsing: multiple RR intervals (flags 0x10)', () => {
  // RR = 1024 → 1000 ms; 512 → 500 ms
  const r = parseHrMeasurement(dv(0x10, 60, 0x00, 0x04, 0x00, 0x02));
  assert.equal(r.bpm, 60);
  assert.deepEqual(r.rrIntervalsMs, [1000, 500]);
});

test('HRM parsing: sensor contact bits + combined flags', () => {
  // flags 0x16 = 16-bit HR? no: 0x16 = contact supported+detected (0x06) + RR (0x10)
  const r = parseHrMeasurement(dv(0x16, 150, 0x00, 0x03));
  assert.equal(r.bpm, 150);
  assert.equal(r.sensorContact, true);
  assert.equal(r.rrIntervalsMs.length, 1);
});

test('HRM parsing: corrupt/short packets never throw, yield null bpm', () => {
  assert.equal(parseHrMeasurement(dv(0x01)).bpm, null);      // truncated 16-bit
  assert.equal(parseHrMeasurement(dv()).bpm, undefined ?? null); // empty
  assert.equal(parseHrMeasurement(null).bpm, null);
  assert.equal(parseHrMeasurement(dv(0x00, 0)).bpm, null);   // zero bpm invalid
});

test('HRM reconnect keeps exactly ONE measurement listener (no stacking across drops)', async () => {
  // Fake GATT surface: the browser reuses the same characteristic object
  // across reconnects, so each re-subscribe must remove-before-add.
  const measListeners = [];
  const meas = {
    startNotifications: async () => {},
    addEventListener: (_t, fn) => measListeners.push(fn),
    removeEventListener: (_t, fn) => { const i = measListeners.indexOf(fn); if (i >= 0) measListeners.splice(i, 1); },
  };
  const hrService = { getCharacteristic: async () => meas };
  const gatt = {
    connect: async () => gatt,
    // Only the HR service exists; battery/device-info lookups reject (both optional).
    getPrimaryService: async (uuid) => { if (uuid === 0x180d) return hrService; throw new Error('not present'); },
    disconnect: () => {},
  };
  const deviceListeners = new Map(); // event → count
  const device = {
    id: 'strap-1', name: 'Test Strap', gatt,
    addEventListener: (t) => deviceListeners.set(t, (deviceListeners.get(t) || 0) + 1),
    removeEventListener: (t) => deviceListeners.set(t, Math.max(0, (deviceListeners.get(t) || 0) - 1)),
  };

  const m = new BleHeartRateMonitor(device);
  await m.connect();
  await m.reconnect();
  await m.reconnect(); // two signal-loss recoveries in one session
  assert.equal(measListeners.length, 1, 'one measurement listener after any number of reconnects');
  assert.equal(deviceListeners.get('gattserverdisconnected'), 1, 'one device disconnect listener');

  // Readings flow through the single listener.
  let reads = 0;
  m.onReading(() => reads++);
  measListeners[0]({ target: { value: dv(0x00, 132) } });
  assert.equal(reads, 1, 'a reading fires the callback exactly once');

  // Intentional teardown detaches the device-level listeners.
  await m.disconnect();
  assert.equal(deviceListeners.get('gattserverdisconnected'), 0, 'disconnect removes device listeners');
});

/* ---------------- FTMS parsing (Bluetooth SIG Fitness Machine Service) ---------------- */

const ftmsRower = () => new FTMSAdapter({ id: 'ftms-1', name: 'Test Rower' });

test('FTMS rower data: metabolic-equivalent flag (bit 10) shifts fields correctly', () => {
  const a = ftmsRower();
  // flags 0x0F01: More Data (no stroke fields) + energy (0x0100) + HR (0x0200)
  // + MET (0x0400) + elapsed time (0x0800).
  // Layout: flags(2) energy(5) hr(1) met(1) elapsed(2)
  a._parseRowerData(dv(0x01, 0x0F, /*energy*/ 0x64, 0x00, 0x10, 0x00, 0x05, /*hr*/ 148, /*met*/ 38, /*elapsed 600s*/ 0x58, 0x02));
  assert.equal(a.live.calories, 100);
  assert.equal(a.live.heartRate, 148);
  assert.equal(a.live.elapsedS, 600, 'elapsed time parsed at the right offset despite the MET byte');
});

test('FTMS rower data: full packet without MET still parses (regression guard)', () => {
  const a = ftmsRower();
  // flags 0x0800 + bit0=1: only elapsed time present.
  a._parseRowerData(dv(0x01, 0x08, 0x2C, 0x01)); // 300 s
  assert.equal(a.live.elapsedS, 300);
});

test('FTMS parsing: truncated packets never throw, keep last good values', () => {
  const a = ftmsRower();
  a._parseRowerData(dv(0x01, 0x08, 0x2C, 0x01)); // good: elapsed 300
  // Claims distance (bit2) but the buffer ends — must not throw.
  a._parseRowerData(dv(0x05, 0x00, 0x11));
  a._parseRowerData(dv(0x05));                    // shorter than the flags field
  a._parseBikeData(dv(0x41, 0x00, 0x22));         // bike: claims power, truncated
  assert.equal(a.live.elapsedS, 300, 'previous good values survive corrupt packets');
});

test('FTMS bike data: MET flag (bit 10) shifts elapsed time correctly', () => {
  const a = ftmsRower();
  // flags 0x0F01: bit0=1 (no speed) + energy + HR + MET + elapsed.
  a._parseBikeData(dv(0x01, 0x0F, /*energy*/ 0x32, 0x00, 0x08, 0x00, 0x02, /*hr*/ 121, /*met*/ 52, /*elapsed 90s*/ 0x5A, 0x00));
  assert.equal(a.live.heartRate, 121);
  assert.equal(a.live.elapsedS, 90);
});

/* ---------------- HR series summary & zones (server) ---------------- */

test('sanitizeHrSeries: enforces monotonic time, plausible bpm, caps', () => {
  const out = sanitizeHrSeries([[0, 100], [1, 500], [1, 110], [2, 120], ['x', 130], [3, 20], [4, 140]]);
  // 500 bpm dropped (implausible, not clamped); 110 at the same second kept;
  // non-numeric time dropped; 20 bpm dropped.
  assert.deepEqual(out, [[0, 100], [1, 110], [2, 120], [4, 140]]);
  assert.deepEqual(sanitizeHrSeries('nope'), []);
});

test('hrSummary: min/max/avg, zone seconds, and drift', () => {
  const series = [];
  for (let t = 0; t < 60; t++) series.push([t, t < 30 ? 100 : 150]); // half easy, half hard
  const s = hrSummary(series, 200);
  assert.equal(s.min, 100);
  assert.equal(s.max, 150);
  assert.equal(s.avg, 125);
  assert.equal(s.zoneSeconds.length, 5);
  // 100 bpm @ max 200 → Z1 (<120); 150 bpm → Z3 (140–159)
  assert.ok(s.zoneSeconds[0] >= 29);
  assert.ok(s.zoneSeconds[2] >= 29);
  assert.equal(s.zoneSeconds[4], 0);
  assert.equal(s.driftPct, 50); // 150 vs 100
});

test('zone boundaries and effective max HR defaults', () => {
  assert.equal(zoneIndex(100, 200), 0);
  assert.equal(zoneIndex(125, 200), 1);
  assert.equal(zoneIndex(145, 200), 2);
  assert.equal(zoneIndex(165, 200), 3);
  assert.equal(zoneIndex(195, 200), 4);
  assert.equal(effectiveMaxHr({ max_hr: 187 }), 187);
  const age30 = new Date().getFullYear() - 30;
  assert.equal(effectiveMaxHr({ birth_year: age30 }), 190);
  assert.equal(effectiveMaxHr({}), 190);
});

/* ---------------- Bluetooth transport layer (Web Bluetooth / WebBLE) ---------------- */

test('detectTransport: native → webbluetooth, injected polyfill → webble, absent → none', () => {
  assert.equal(detectTransport({}), Transport.NONE, 'no navigator');
  assert.equal(detectTransport({ navigator: {} }), Transport.NONE, 'no bluetooth object');
  // Math.max stands in for an engine-implemented function: its source
  // stringifies to "[native code]" exactly like the real requestDevice.
  assert.equal(detectTransport({ navigator: { bluetooth: { requestDevice: Math.max } } }),
    Transport.WEB_BLUETOOTH, 'engine-implemented requestDevice');
  assert.equal(detectTransport({ navigator: { bluetooth: { requestDevice: async () => {} } } }),
    Transport.WEBBLE, 'plain-JS requestDevice = injected iOS bridge polyfill');
});

test('canonicalUuid: SIG aliases expand, strings lowercase, full UUIDs pass through', () => {
  assert.equal(canonicalUuid(0x180d), '0000180d-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalUuid(0x1826), '00001826-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalUuid('CE060030-43E5-11E4-916C-0800200C9A66'), 'ce060030-43e5-11e4-916c-0800200c9a66');
  assert.equal(canonicalUuid('ce060021-43e5-11e4-916c-0800200c9a66'), 'ce060021-43e5-11e4-916c-0800200c9a66');
});

test('normalizeRequestOptions maps numeric service UUIDs, preserves everything else', () => {
  const out = normalizeRequestOptions({
    filters: [{ services: [0x180d] }, { namePrefix: 'PM5' }],
    optionalServices: [0x180f, 'CE060040-43E5-11E4-916C-0800200C9A66'],
  });
  assert.deepEqual(out.filters[0].services, ['0000180d-0000-1000-8000-00805f9b34fb']);
  assert.deepEqual(out.filters[1], { namePrefix: 'PM5' });
  assert.deepEqual(out.optionalServices,
    ['0000180f-0000-1000-8000-00805f9b34fb', 'ce060040-43e5-11e4-916c-0800200c9a66']);
});

test('BluetoothManager without any transport: honest unavailability, no throws', async () => {
  const m = new BluetoothManagerImpl({ navigator: {} });
  assert.equal(m.isAvailable(), false);
  assert.equal(m.transportKind, Transport.NONE);
  assert.deepEqual(await m.getDevices(), []);
  assert.equal(await m.getAvailability(), false);
  assert.equal(m.capabilities().writeWithResponse, false);
  await assert.rejects(m.requestDevice({}), (e) => e.code === 'no_bluetooth');
});

test('WebBLE transport: canonicalized chooser options, no fake getDevices, capability map', async () => {
  let seenOptions = null;
  const env = {
    navigator: {
      bluetooth: { requestDevice: async (o) => { seenOptions = o; return { id: 'd1', gatt: {} }; } },
    },
  };
  const tr = new WebBLETransport(env);
  await tr.requestDevice({ filters: [{ services: [0x1826] }], optionalServices: [0x2acc] });
  assert.deepEqual(seenOptions.filters[0].services, ['00001826-0000-1000-8000-00805f9b34fb']);
  assert.deepEqual(await tr.getDevices(), [], 'no persistent permissions on the bridge → empty, never invented');
  const caps = tr.capabilities();
  assert.equal(caps.getDevices, false);
  assert.equal(caps.watchAdvertisements, false);
  assert.equal(caps.writeWithResponse, true);
  assert.equal(await tr.getAvailability(), true, 'bridge present implies a radio');

  const m = new BluetoothManagerImpl(env);
  assert.equal(m.transportKind, Transport.WEBBLE);
  assert.equal(m.diagnostics().transport, Transport.WEBBLE);
});

/* ---- fake WebBLE object graph: plain JS objects with ONLY the pre-1.7
   surface (writeValue, no writeValueWithResponse) — the worst real bridge. */

function fakeWebBleChar(uuid, { readValue, onWrite } = {}) {
  const ch = {
    uuid,
    _listeners: [],
    startNotifications: async () => ch,
    stopNotifications: async () => ch,
    addEventListener(type, fn) { if (type === 'characteristicvaluechanged') ch._listeners.push(fn); },
    removeEventListener(type, fn) { const i = ch._listeners.indexOf(fn); if (i >= 0) ch._listeners.splice(i, 1); },
    notify(bytes) {
      const value = new DataView(Uint8Array.from(bytes).buffer);
      for (const fn of [...ch._listeners]) fn({ target: { value, uuid } });
    },
  };
  if (readValue) ch.readValue = readValue;
  if (onWrite) ch.writeValue = async (data) => onWrite(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
  return ch;
}

test('WebBLE normalization: write methods patched in place, identity preserved', async () => {
  const writes = [];
  const ch = fakeWebBleChar('ce060021-43e5-11e4-916c-0800200c9a66', { onWrite: (b) => writes.push([...b]) });
  const svc = { getCharacteristic: async () => ch };
  const server = { connect: async () => server, getPrimaryService: async () => svc };
  const device = { id: 'd1', gatt: server, addEventListener() {}, removeEventListener() {} };

  normalizeWebBleDevice(device);
  const s = await device.gatt.connect();
  const got1 = await (await s.getPrimaryService(0xce06)).getCharacteristic(0x2a37);
  const got2 = await (await s.getPrimaryService(0xce06)).getCharacteristic(0x2a37);
  assert.equal(got1, ch, 'patched IN PLACE — same object the bridge returned');
  assert.equal(got1, got2, 'identity stable across repeat lookups (listener hygiene depends on it)');

  await got1.writeValueWithResponse(Uint8Array.from([1, 2, 3]));
  await got1.writeValueWithoutResponse(Uint8Array.from([4]));
  assert.deepEqual(writes, [[1, 2, 3], [4]], 'both spec methods delegate to the bridge writeValue');

  // An implementation that already has the split API is left untouched.
  const modern = { writeValue: async () => 'plain', writeValueWithResponse: async () => 'withResp' };
  const svc2 = { getCharacteristic: async () => modern };
  const server2 = { getPrimaryService: async () => svc2 };
  normalizeWebBleDevice({ id: 'd2', gatt: server2 });
  const gotModern = await (await server2.getPrimaryService(1)).getCharacteristic(2);
  assert.equal(await gotModern.writeValueWithResponse(), 'withResp', 'existing method not overwritten');
});

test('FTMS connect probes characteristics directly (no getCharacteristics/BluetoothUUID)', async () => {
  const bike = fakeWebBleChar('00002ad2-0000-1000-8000-00805f9b34fb');
  const svc = {
    // Only the bike characteristic exists; the rower lookup rejects like a
    // real GATT miss. No getCharacteristics(), no BluetoothUUID global.
    getCharacteristic: async (uuid) => {
      if (canonicalUuid(uuid) === '00002ad2-0000-1000-8000-00805f9b34fb') return bike;
      throw new Error('characteristic not found');
    },
  };
  const server = { connected: true, getPrimaryService: async () => svc };
  const device = { id: 'ftms-ios', name: 'Bike', gatt: server, addEventListener() {}, removeEventListener() {} };
  const a = new FTMSAdapter(device, server);
  await a.connect();
  assert.equal(a.machineType, 'bike');
  bike.notify([0x01, 0x08, 0x2C, 0x01]); // elapsed 300 s
  assert.equal(a.live.elapsedS, 300, 'notifications flow through the probed characteristic');
});

test('PM5 workout programming over the WebBLE surface: 4×1000m/2:00 rest, byte-identical CSAFE', async () => {
  const U = (tail) => `ce0600${tail}-43e5-11e4-916c-0800200c9a66`;
  const txChunks = [];      // every raw GATT write (must each be ≤20 bytes)
  const txFrames = [];      // reassembled CSAFE frames as the PM5 would see them
  let txBuf = [];
  const hrWrites = [];

  const ctrlRx = fakeWebBleChar(U('22'));
  const generalStatus = fakeWebBleChar(U('31'));
  const ctrlTx = fakeWebBleChar(U('21'), {
    onWrite: (bytes) => {
      assert.ok(bytes.length <= 20, `GATT write chunked to ≤20 bytes (got ${bytes.length})`);
      txChunks.push([...bytes]);
      txBuf.push(...bytes);
      if (txBuf[txBuf.length - 1] === 0xF2) {
        txFrames.push([...txBuf]);
        txBuf = [];
        // The "PM5" acknowledges each frame (status 0x81 = accepted, state 1)
        // and reports the programmed workout type on general status.
        setTimeout(() => {
          ctrlRx.notify([...buildFrame([0x81])]);
          generalStatus.notify([0, 0, 0, 0, 0, 0, CSAFE.WT_VARIABLE_INTERVAL, 0, 0, 0, 0]);
        }, 0);
      }
    },
  });
  const serial = fakeWebBleChar(U('12'), {
    readValue: async () => new DataView(new TextEncoder().encode('PM5-431234567\0').buffer),
  });
  const hrWrite = fakeWebBleChar(U('41'), { onWrite: (b) => hrWrites.push([...b]) });
  const forceCurve = fakeWebBleChar(U('3d'));
  const add1 = fakeWebBleChar(U('32'));
  const add2 = fakeWebBleChar(U('33'));
  const stroke = fakeWebBleChar(U('35'));

  const byUuid = Object.fromEntries(
    [serial, ctrlTx, ctrlRx, generalStatus, add1, add2, stroke, forceCurve, hrWrite].map(c => [c.uuid, c]));
  const services = {
    [U('10')]: true, [U('20')]: true, [U('30')]: true, [U('40')]: true,
  };
  const mkSvc = () => ({
    getCharacteristic: async (uuid) => {
      const ch = byUuid[canonicalUuid(uuid)];
      if (!ch) throw new Error('characteristic not found');
      return ch;
    },
  });
  const server = {
    connect: async () => server,
    getPrimaryService: async (uuid) => {
      if (!services[canonicalUuid(uuid)]) throw new Error('service not found');
      return mkSvc();
    },
  };
  const device = { id: 'ios-pm5', name: 'PM5 431234567', gatt: server, addEventListener() {}, removeEventListener() {} };

  normalizeWebBleDevice(device);                       // ← the WebBLE transport's only intervention
  const adapter = new Concept2PM5Adapter(device);
  await adapter.connect();

  assert.equal(adapter.machineId, 'PM5-431234567', 'serial read through the bridge readValue');
  assert.equal(adapter.forceCurveMode, 'notify');
  assert.equal(adapter.hrForward.supported, true);
  assert.equal(typeof ctrlTx.writeValueWithResponse, 'function', 'pre-1.7 bridge gained the spec write method');

  // Seed the monitor state the adapter waits for (idle → no terminate needed).
  generalStatus.notify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  const plan = {
    type: 'intervals',
    intervals: Array.from({ length: 4 }, () => ({ workType: 'distance', workDistanceM: 1000, restTimeS: 120 })),
  };
  const result = await adapter.sendWorkout(plan);
  assert.equal(result.verified, true, 'monitor reported the variable-interval workout type');

  // The exact bytes the PM5 receives are IDENTICAL to the desktop encoding —
  // the transport layer never touches CSAFE content.
  const expected = encodeWorkout(plan).map(f => [...f]);
  assert.deepEqual(txFrames, expected, 'CSAFE frames byte-identical over the WebBLE surface');

  // Heart-rate forwarding writes the 20-byte packet through the same bridge.
  assert.equal(adapter.sendHeartRate(142), true);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(hrWrites.length, 1);
  assert.equal(hrWrites[0].length, 20);
  assert.equal(hrWrites[0][5], 142);

  // Force-curve notifications stream through the patched characteristic.
  const curves = [];
  adapter.onForceCurve(c => curves.push(c));
  forceCurve.notify([0x12, 0x00, 0x34, 0x00, 0x68, 0x00]); // 1 chunk, 2 LE words
  assert.deepEqual(curves, [[0x34, 0x68]]);

  await adapter.disconnect();
});

/* ---------------- feedback phrasing fallback ---------------- */

test('without ANTHROPIC_API_KEY post-workout feedback uses deterministic templates', async () => {
  const cls = { tag: 'started_too_hard', firstThirdPace: 118, lastThirdPace: 133, avgPace: 126 };
  const { text, source } = await phraseFeedback(cls);
  assert.equal(source, 'template');
  assert.equal(text, templateFeedbackText(cls));
  assert.ok(text.includes('1:58.0'), 'feedback cites the real opening pace');
});
