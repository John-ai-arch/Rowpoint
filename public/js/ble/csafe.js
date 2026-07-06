// CSAFE frame encoder for the PM5 Control service (§1.3).
// Frames: 0xF1 <stuffed contents> <checksum> 0xF2, where checksum is the XOR
// of the unstuffed contents and bytes 0xF0–0xF3 inside the frame are escaped
// as 0xF3, (byte & 0x03). Per the Concept2 PM CSAFE spec.
export const CSAFE = {
  START: 0xF1, STOP: 0xF2, ESCAPE: 0xF3, EXT_START: 0xF0,
  // Public CSAFE long commands
  SETPROGRAM: 0x24,
  // PM proprietary wrapper + configuration commands (from the PM5 CSAFE spec)
  SETUSERCFG1: 0x1A,
  PM_SET_WORKOUTTYPE: 0x01,
  PM_SET_WORKOUTDURATION: 0x03,
  PM_SET_RESTDURATION: 0x04,
  PM_SET_SPLITDURATION: 0x05,
  PM_CONFIGURE_WORKOUT: 0x14,
  PM_SET_SCREENSTATE: 0x13,
  // duration type identifiers
  DUR_TIME: 0x00, DUR_CALORIES: 0x40, DUR_DISTANCE: 0x80, DUR_WATTS: 0xC0,
  // workout type ids (subset)
  WT_JUSTROW_SPLITS: 0x01,
  WT_FIXEDDIST_SPLITS: 0x03,
  WT_FIXEDTIME_SPLITS: 0x05,
  WT_FIXEDTIME_INTERVAL: 0x06,
  WT_FIXEDDIST_INTERVAL: 0x07,
  WT_VARIABLE_INTERVAL: 0x08,
};

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

const u16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];          // little-endian
const u32 = (v) => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];

function wrapPM(pmCommands) {
  // CSAFE_SETUSERCFG1_CMD wraps PM-proprietary commands.
  return [CSAFE.SETUSERCFG1, pmCommands.length, ...pmCommands];
}

/**
 * Encode a validated WorkoutPlan (§1.3) into the CSAFE command frames to write
 * to the Control characteristic. Client-side validation happens BEFORE this;
 * the machine's own response remains authoritative and is surfaced verbatim.
 * Returns an array of Uint8Array frames to write in order.
 */
export function encodeWorkout(plan) {
  const frames = [];
  const pm = [];
  if (!plan || plan.type === 'justrow') {
    pm.push(CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_JUSTROW_SPLITS);
    pm.push(CSAFE.PM_CONFIGURE_WORKOUT, 1, 0x01);
  } else if (plan.type === 'time') {
    const cs = Math.round(plan.durationS * 100); // duration in 0.01s units
    pm.push(CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_FIXEDTIME_SPLITS);
    pm.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_TIME, ...u32(cs));
    pm.push(CSAFE.PM_SET_SPLITDURATION, 5, CSAFE.DUR_TIME, ...u32(Math.max(Math.round(cs / 5), 2000)));
    pm.push(CSAFE.PM_CONFIGURE_WORKOUT, 1, 0x01);
  } else if (plan.type === 'distance') {
    pm.push(CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_FIXEDDIST_SPLITS);
    pm.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_DISTANCE, ...u32(Math.round(plan.distanceM)));
    pm.push(CSAFE.PM_SET_SPLITDURATION, 5, CSAFE.DUR_DISTANCE, ...u32(Math.max(Math.round(plan.distanceM / 5), 100)));
    pm.push(CSAFE.PM_CONFIGURE_WORKOUT, 1, 0x01);
  } else if (plan.type === 'intervals') {
    // Variable-interval programming: one SET_WORKOUTDURATION + SET_RESTDURATION
    // pair per interval, per the PM5 variable-interval flow.
    pm.push(CSAFE.PM_SET_WORKOUTTYPE, 1, CSAFE.WT_VARIABLE_INTERVAL);
    for (const iv of plan.intervals) {
      if (iv.workType === 'time') {
        pm.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_TIME, ...u32(Math.round(iv.workTimeS * 100)));
      } else if (iv.workType === 'distance') {
        pm.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_DISTANCE, ...u32(Math.round(iv.workDistanceM)));
      } else {
        pm.push(CSAFE.PM_SET_WORKOUTDURATION, 5, CSAFE.DUR_CALORIES, ...u32(Math.round(iv.workCalories)));
      }
      pm.push(CSAFE.PM_SET_RESTDURATION, 2, ...u16(Math.round(iv.restTimeS ?? 0)));
    }
    pm.push(CSAFE.PM_CONFIGURE_WORKOUT, 1, 0x01);
  }
  frames.push(buildFrame(wrapPM(pm)));
  return frames;
}

// Map machine status codes in a CSAFE response to human-readable errors so the
// UI can surface the machine's own rejection (§1.3) instead of a generic fail.
export function describeMachineStatus(status) {
  const st = status & 0x0F;
  const map = {
    0x0: null,                       // OK
    0x1: null,                       // OK (pending)
    0x9: 'The monitor rejected the workout as invalid (bad interval or duration for this firmware).',
    0xA: 'The monitor is in an incompatible state — finish or cancel the current workout on the PM5 first.',
  };
  return map[st] ?? (st >= 0x8 ? `The monitor returned error state 0x${st.toString(16)}.` : null);
}
