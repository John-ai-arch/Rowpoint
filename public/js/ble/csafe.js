// CSAFE frame encoder for the PM5 Control service (§1.3).
// Frames: 0xF1 <stuffed contents> <checksum> 0xF2, where checksum is the XOR
// of the unstuffed contents and bytes 0xF0–0xF3 inside the frame are escaped
// as 0xF3, (byte & 0x03).
//
// Workout programming follows the "Proprietary CSAFE Workout Configuration"
// examples in the Concept2 "PM CSAFE Communication Definition" rev 0.27
// (the same sequences ErgData sends): PM-proprietary commands wrapped in the
// 0x76 C2 wrapper, multi-byte values BIG-endian, and every sequence closed
// with PM_SET_SCREENSTATE(workout, PREPARETOROWWORKOUT) — that final command
// is what makes the monitor leave its menu and show the programmed workout.
export const CSAFE = {
  START: 0xF1, STOP: 0xF2, ESCAPE: 0xF3, EXT_START: 0xF0,
  // Wrappers for PM proprietary commands
  WRAP_PMCFG: 0x76,      // C2 proprietary wrapper — workout configuration
  SETUSERCFG1: 0x1A,     // PM3-compat wrapper — used for GET_FORCEPLOTDATA
  // PM proprietary commands (per the PM5 CSAFE spec)
  PM_SET_WORKOUTTYPE: 0x01,
  PM_SET_WORKOUTDURATION: 0x03,
  PM_SET_RESTDURATION: 0x04,
  PM_SET_SPLITDURATION: 0x05,
  PM_SET_TARGETPACETIME: 0x06,
  PM_SET_SCREENSTATE: 0x13,
  PM_CONFIGURE_WORKOUT: 0x14,
  PM_SET_INTERVALTYPE: 0x17,
  PM_SET_WORKOUTINTERVALCOUNT: 0x18,
  PM_GET_FORCEPLOTDATA: 0x6B,
  // duration type identifiers
  DUR_TIME: 0x00, DUR_CALORIES: 0x40, DUR_DISTANCE: 0x80, DUR_WATTMIN: 0xC0,
  // workout type ids
  WT_JUSTROW_SPLITS: 0x01,
  WT_FIXEDDIST_SPLITS: 0x03,
  WT_FIXEDTIME_SPLITS: 0x05,
  WT_FIXEDTIME_INTERVAL: 0x06,
  WT_FIXEDDIST_INTERVAL: 0x07,
  WT_VARIABLE_INTERVAL: 0x08,
  WT_FIXEDCALORIE_SPLITS: 0x0A,
  // interval type ids
  IT_TIME: 0x00, IT_DIST: 0x01, IT_CALORIE: 0x06,
  // screen state
  SCREENTYPE_WORKOUT: 0x01,
  SCREENVALUE_PREPARETOROW: 0x01,
  SCREENVALUE_TERMINATE: 0x02,
};

// The PM physical link caps CSAFE frames at 120 bytes INCLUDING flags,
// checksum and byte stuffing (spec "Frame Contents"); longer workouts are
// split into multiple complete frames. Minimum inter-frame gap is 50 ms —
// the adapter enforces that between writes.
export const MAX_FRAME_BYTES = 120;
export const MIN_INTERFRAME_GAP_MS = 50;

export function buildFrame(contents) {
  let checksum = 0;
  const stuffed = [];
  for (const b of contents) {
    checksum ^= b;
    if (b >= 0xF0 && b <= 0xF3) { stuffed.push(CSAFE.ESCAPE, b & 0x03); }
    else stuffed.push(b);
  }
  if (checksum >= 0xF0 && checksum <= 0xF3) {
    return Uint8Array.from([CSAFE.START, ...stuffed, CSAFE.ESCAPE, checksum & 0x03, CSAFE.STOP]);
  }
  return Uint8Array.from([CSAFE.START, ...stuffed, checksum, CSAFE.STOP]);
}

export function parseFrame(bytes) {
  const arr = [...bytes];
  if (arr[0] !== CSAFE.START && arr[0] !== CSAFE.EXT_START) return null;
  const end = arr.lastIndexOf(CSAFE.STOP);
  if (end < 2) return null;
  const un = [];
  for (let i = 1; i < end; i++) {
    if (arr[i] === CSAFE.ESCAPE) { un.push(0xF0 | (arr[++i] & 0x03)); }
    else un.push(arr[i]);
  }
  const checksum = un.pop();
  let x = 0; for (const b of un) x ^= b;
  return { valid: x === checksum, status: un[0], payload: un.slice(1) };
}

// Per the spec, multi-byte values inside PM proprietary commands are sent
// MOST-significant byte first (e.g. 2000 m = 00 00 07 D0).
const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const be32 = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];

// Frame length AFTER framing/stuffing — used to keep every frame ≤120 bytes.
function framedSize(contents) {
  let checksum = 0, n = 2; // start + stop flags
  for (const b of contents) { checksum ^= b; n += (b >= 0xF0 && b <= 0xF3) ? 2 : 1; }
  n += (checksum >= 0xF0 && checksum <= 0xF3) ? 2 : 1;
  return n;
}

const SCREEN_GO = [CSAFE.PM_SET_SCREENSTATE, 2, CSAFE.SCREENTYPE_WORKOUT, CSAFE.SCREENVALUE_PREPARETOROW];

/**
 * Pack indivisible command blocks into as few 0x76-wrapped frames as fit the
 * 120-byte limit, appending the SET_SCREENSTATE "go" only to the FINAL frame
 * (the monitor must not switch screens until the whole workout is loaded).
 */
function chunkIntoFrames(blocks) {
  const fits = (cmds) => framedSize([CSAFE.WRAP_PMCFG, cmds.length, ...cmds]) <= MAX_FRAME_BYTES;
  const frames = [];
  let cur = [];
  for (const block of blocks) {
    if (cur.length && !fits([...cur, ...block])) { frames.push(cur); cur = []; }
    cur = [...cur, ...block];
  }
  if (!fits([...cur, ...SCREEN_GO])) { frames.push(cur); cur = []; }
  frames.push([...cur, ...SCREEN_GO]);
  return frames.map(c => buildFrame([CSAFE.WRAP_PMCFG, c.length, ...c]));
}

/**
 * Encode a validated WorkoutPlan (§1.3) into the CSAFE command frames to write
 * to the Control characteristic, matching the spec's worked examples byte for
 * byte. Client-side validation happens BEFORE this; the machine's own
 * response remains authoritative and is surfaced verbatim.
 * Returns an array of Uint8Array frames to write in order.
 */
export function encodeWorkout(plan) {
  if (!plan || plan.type === 'justrow') {
    return chunkIntoFrames([[CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_JUSTROW_SPLITS]]);
  }
  if (plan.type === 'time') {
    const cs = Math.round(plan.durationS * 100);          // 0.01 s units
    const splitCs = Math.max(Math.round(cs / 5), 2000);   // PM5 minimum split 20 s
    return chunkIntoFrames([[
      CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_FIXEDTIME_SPLITS,
      CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_TIME, ...be32(cs),
      CSAFE.PM_SET_SPLITDURATION, 5, CSAFE.DUR_TIME, ...be32(splitCs),
      CSAFE.PM_CONFIGURE_WORKOUT, 1, 1,
    ]]);
  }
  if (plan.type === 'distance') {
    const m = Math.round(plan.distanceM);
    const splitM = Math.max(Math.round(m / 5), 100);      // PM5 minimum split 100 m
    return chunkIntoFrames([[
      CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_FIXEDDIST_SPLITS,
      CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_DISTANCE, ...be32(m),
      CSAFE.PM_SET_SPLITDURATION, 5, CSAFE.DUR_DISTANCE, ...be32(splitM),
      CSAFE.PM_CONFIGURE_WORKOUT, 1, 1,
    ]]);
  }
  if (plan.type === 'calories') {
    const cals = Math.round(plan.calories);
    return chunkIntoFrames([[
      CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_FIXEDCALORIE_SPLITS,
      CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_CALORIES, ...be32(cals),
      CSAFE.PM_SET_SPLITDURATION, 5, CSAFE.DUR_CALORIES, ...be32(Math.max(Math.round(cals / 5), 1)),
      CSAFE.PM_CONFIGURE_WORKOUT, 1, 1,
    ]]);
  }
  if (plan.type === 'intervals') {
    // Programmed as a VARIABLE interval workout (like ErgData's presets):
    // the PM5 then knows the total interval count and shows "interval n of N".
    // Per the spec's variable-interval example, each interval is announced
    // with WORKOUTINTERVALCOUNT, described with INTERVALTYPE + duration +
    // rest (+ optional target pace), and committed with CONFIGURE_WORKOUT.
    const blocks = plan.intervals.map((iv, i) => {
      const block = [CSAFE.PM_SET_WORKOUTINTERVALCOUNT, 1, i];
      if (i === 0) block.push(CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_VARIABLE_INTERVAL);
      if (iv.workType === 'time') {
        block.push(CSAFE.PM_SET_INTERVALTYPE, 1, CSAFE.IT_TIME);
        block.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_TIME, ...be32(Math.round(iv.workTimeS * 100)));
      } else if (iv.workType === 'calories') {
        block.push(CSAFE.PM_SET_INTERVALTYPE, 1, CSAFE.IT_CALORIE);
        block.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_CALORIES, ...be32(Math.round(iv.workCalories)));
      } else {
        block.push(CSAFE.PM_SET_INTERVALTYPE, 1, CSAFE.IT_DIST);
        block.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_DISTANCE, ...be32(Math.round(iv.workDistanceM)));
      }
      block.push(CSAFE.PM_SET_RESTDURATION, 2, ...be16(Math.round(iv.restTimeS ?? 0)));
      if (Number.isFinite(iv.targetPaceS) && iv.targetPaceS > 0) {
        block.push(CSAFE.PM_SET_TARGETPACETIME, 4, ...be32(Math.round(iv.targetPaceS * 100)));
      }
      block.push(CSAFE.PM_CONFIGURE_WORKOUT, 1, 1);
      return block;
    });
    return chunkIntoFrames(blocks);
  }
  return chunkIntoFrames([[CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_JUSTROW_SPLITS]]);
}

/** Terminate the current workout (spec "CSAFE Miscellaneous" example). */
export function encodeTerminateWorkout() {
  return buildFrame([CSAFE.WRAP_PMCFG, 4,
    CSAFE.PM_SET_SCREENSTATE, 2, CSAFE.SCREENTYPE_WORKOUT, CSAFE.SCREENVALUE_TERMINATE]);
}

/** Request the next chunk of force-plot samples (spec "Get Force Curve"). */
export function encodeForcePlotRequest(bytes = 20) {
  return buildFrame([CSAFE.SETUSERCFG1, 3, CSAFE.PM_GET_FORCEPLOTDATA, 1, bytes]);
}

/**
 * Parse a GET_FORCEPLOTDATA response payload (after the status byte):
 * [0x1A, wrapLen, 0x6B, cmdLen, bytesRead, data... (16-bit LE words)].
 * Returns the decoded samples, or null when this isn't a force-plot response.
 */
export function parseForcePlotResponse(payload) {
  const i = payload.indexOf(CSAFE.PM_GET_FORCEPLOTDATA);
  if (i < 0 || i + 2 > payload.length) return null;
  const cmdLen = payload[i + 1];
  const bytesRead = payload[i + 2];
  if (!Number.isFinite(cmdLen) || bytesRead > cmdLen - 1) return null;
  const words = [];
  for (let o = 0; o + 1 < bytesRead; o += 2) {
    const lo = payload[i + 3 + o], hi = payload[i + 3 + o + 1];
    if (lo === undefined || hi === undefined) break;
    words.push(lo | (hi << 8));
  }
  return { bytesRead, samples: words };
}

// CSAFE response status byte (spec Table 9): bits 0x30 report how the frame
// we just sent was handled — that is the authoritative accept/reject signal.
// Low nibble is the server state machine (0 = error state).
export function describeMachineStatus(status) {
  const prev = status & 0x30;
  if (prev === 0x10) return 'The monitor rejected the workout as invalid (bad interval or duration for this firmware).';
  if (prev === 0x20) return 'The monitor could not read the command (corrupted frame) — try again.';
  if (prev === 0x30) return 'The monitor is busy — finish or cancel what the PM5 is doing, then try again.';
  if ((status & 0x0F) === 0) return 'The monitor reported an internal error state. Press Menu on the PM5 and try again.';
  return null;
}
