// Concept2 PM5 adapter (§1.2) — Web Bluetooth implementation of ErgDataSource.
// Field offsets follow the published "Concept2 PM5 Bluetooth Smart
// Communication Interface Definition"; every field is a fixed-width
// little-endian value at a known offset. Workout programming and heart-rate
// forwarding follow the "PM CSAFE Communication Definition" rev 0.27.
import {
  CSAFE, MIN_INTERFRAME_GAP_MS, encodeWorkout, encodeTerminateWorkout,
  encodeForcePlotRequest, parseForcePlotResponse, parseFrame, describeMachineStatus,
} from './csafe.js';

export const C2_SERVICE_DISCOVERY = 'ce060000-43e5-11e4-916c-0800200c9a66';
export const C2_SERVICE_INFO      = 'ce060010-43e5-11e4-916c-0800200c9a66';
export const C2_SERVICE_CONTROL   = 'ce060020-43e5-11e4-916c-0800200c9a66';
export const C2_SERVICE_ROWING    = 'ce060030-43e5-11e4-916c-0800200c9a66';
// C2 PM Heart Rate service (CSAFE spec rev 0.27, IDs 0x0040/0x0041): the app
// WRITES heart-rate readings to the PM5, which then displays them on the
// monitor and logs them with the workout — the mechanism ErgData uses to put
// watch/strap heart rate on the PM5 screen.
export const C2_SERVICE_HR        = 'ce060040-43e5-11e4-916c-0800200c9a66';

const CH = {
  SERIAL:          'ce060012-43e5-11e4-916c-0800200c9a66',
  // Per the C2 interface definition: ...0021 is receive (central writes CSAFE
  // frames TO the PM), ...0022 is transmit (PM notifies responses back).
  CTRL_TX:         'ce060021-43e5-11e4-916c-0800200c9a66', // app → machine CSAFE frames (write)
  CTRL_RX:         'ce060022-43e5-11e4-916c-0800200c9a66', // machine → app responses (notify)
  GENERAL_STATUS:  'ce060031-43e5-11e4-916c-0800200c9a66',
  ADDITIONAL_1:    'ce060032-43e5-11e4-916c-0800200c9a66',
  ADDITIONAL_2:    'ce060033-43e5-11e4-916c-0800200c9a66',
  STROKE_DATA:     'ce060035-43e5-11e4-916c-0800200c9a66',
  SPLIT_DATA:      'ce060037-43e5-11e4-916c-0800200c9a66',
  FORCE_CURVE:     'ce06003d-43e5-11e4-916c-0800200c9a66',
  HR_WRITE:        'ce060041-43e5-11e4-916c-0800200c9a66',
};

// PM5 workout type the monitor should report after each plan type lands
// (general status byte 6) — used to VERIFY the program actually took effect.
const EXPECTED_WORKOUT_TYPE = {
  justrow: [CSAFE.WT_JUSTROW_SPLITS, 0x00],
  time: [CSAFE.WT_FIXEDTIME_SPLITS],
  distance: [CSAFE.WT_FIXEDDIST_SPLITS],
  calories: [CSAFE.WT_FIXEDCALORIE_SPLITS],
  intervals: [CSAFE.WT_VARIABLE_INTERVAL],
};

const STROKESTATE_RECOVERY = 4;

const u16le = (dv, o) => dv.getUint16(o, true);
const u24le = (dv, o) => dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Build the 20-byte packet for the PM heart-rate receive characteristic
 * (CSAFE spec rev 0.27, ID 0x0041). Layout, little-endian ("Lo, Hi"):
 *   0: source type (0 = BT heart-rate profile values)
 *   1-2: energy expended | 3-4: RR interval (1/1024 s) | 5-6: HR value
 *   7: HR-measurement status flags | 8-11: ANT fields (unused) | 12-19: spare
 * Exported standalone so it is unit-testable without a Bluetooth stack.
 */
export function buildHrPacket(bpm, { rrMs = null } = {}) {
  const b = new Uint8Array(20);
  const rr = Number.isFinite(rrMs) && rrMs > 0 ? Math.min(Math.round(rrMs * 1024 / 1000), 0xFFFF) : 0;
  b[3] = rr & 0xFF; b[4] = (rr >> 8) & 0xFF;
  const hr = Math.max(0, Math.min(Math.round(bpm), 0xFFFF));
  b[5] = hr & 0xFF; b[6] = (hr >> 8) & 0xFF;
  b[7] = 0x01 | (rr ? 0x10 : 0); // SIG HRM flags: 16-bit HR value (+ RR present)
  return b;
}

/**
 * Decode one Force Curve characteristic notification (BLE spec 0x003D):
 * byte0 MS nibble = total notifications for this curve, LS nibble = number of
 * 16-bit LE words here; byte1 = sequence number within the curve.
 * Mutates `accum`; returns the completed curve on the final chunk, else null.
 * Exported standalone so it is unit-testable without a Bluetooth stack.
 */
export function parseForceCurveNotification(dv, accum) {
  if (dv.byteLength < 2) return null;
  const words = dv.getUint8(0) & 0x0F;
  const totalChunks = (dv.getUint8(0) >> 4) & 0x0F;
  const seq = dv.getUint8(1);
  if (seq === 0) accum.length = 0;
  for (let i = 0; i < words && 2 + i * 2 + 1 < dv.byteLength; i++) {
    accum.push(u16le(dv, 2 + i * 2));
  }
  if (seq >= totalChunks - 1 && accum.length) {
    const curve = [...accum];
    accum.length = 0;
    return curve;
  }
  return null;
}

export class Concept2PM5Adapter {
  machineType = 'rower';
  kind = 'pm5';

  constructor(device, server = null) {
    this.device = device;            // BluetoothDevice from the chooser
    this.server = server;            // optionally pre-connected GATT server
    this.listeners = new Set();
    this.forceListeners = new Set();
    this.live = {};
    this._forceAccum = [];
    // 'notify' (0x003D characteristic) | 'poll' (CSAFE GET_FORCEPLOTDATA
    // fallback for PM5v1, which the BLE spec notes has no 0x003D) |
    // 'unsupported' (no path available on this monitor).
    this.forceCurveMode = 'unsupported';
    this._forceNotifySeen = false;
    this._recoveriesWithoutForce = 0;
    this._prevStrokeState = null;
    this._pollingForce = false;
    // HR forwarding to the monitor: { supported, reason } — reason is
    // 'unsupported' (older firmware/no service) or 'permission' (device was
    // paired before this app version listed the HR service; re-pair once).
    this.hrForward = { supported: false, reason: 'unsupported' };
    this._hrWriteBusy = false;
    this._hrLastWrite = 0;
    this._hrFailures = 0;
    // One GATT operation at a time per device (Web Bluetooth requirement) —
    // every write on this adapter is serialized through this queue.
    this._gattQueue = Promise.resolve();
    this._rxBuf = [];
    this._pendingProgram = null;     // resolver for a programming response
    this._pendingForce = null;       // resolver for a force-plot response
    this._programming = false;
    this._charHandlers = new Map();  // uuid → bound handler (remove-before-add)
  }

  onMetrics(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onForceCurve(fn) { this.forceListeners.add(fn); return () => this.forceListeners.delete(fn); }
  _emit() { const snap = { ...this.live, ts: Date.now() }; for (const fn of this.listeners) fn(snap); }

  static async requestDevice() {
    // Scan for the Concept2 discovery UUID (§1.2 connection flow step 1).
    // Web Bluetooth shows the OS chooser (sorted by RSSI by the browser),
    // standing in for the app-side RSSI sort of the native implementation.
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [C2_SERVICE_DISCOVERY] }],
      optionalServices: [C2_SERVICE_INFO, C2_SERVICE_CONTROL, C2_SERVICE_ROWING, C2_SERVICE_HR],
    });
  }

  async connect() {
    const server = (this.server && this.server.connected) ? this.server : await this.device.gatt.connect();
    this.server = server;
    // Stable peripheral identifier (§1.2): serial number from the Information
    // service, so we can re-find the same physical erg in a gym of PM5s.
    try {
      const info = await server.getPrimaryService(C2_SERVICE_INFO);
      const serialCh = await info.getCharacteristic(CH.SERIAL);
      const v = await serialCh.readValue();
      this.machineId = new TextDecoder().decode(v.buffer).replace(/\0+$/, '');
    } catch { this.machineId = this.device.id; }

    const rowing = await server.getPrimaryService(C2_SERVICE_ROWING);
    await this._sub(rowing, CH.GENERAL_STATUS, (dv) => this._parseGeneralStatus(dv));
    await this._sub(rowing, CH.ADDITIONAL_1, (dv) => this._parseAdditional1(dv));
    await this._sub(rowing, CH.ADDITIONAL_2, (dv) => this._parseAdditional2(dv));
    await this._sub(rowing, CH.STROKE_DATA, (dv) => this._parseStrokeData(dv));

    // Force curve (0x003D): present on PM5v2+; PM5v1 does not have it (BLE
    // spec V1.29 note). A transient GATT failure gets one retry; a missing
    // characteristic falls back to CSAFE polling via the control service.
    try {
      await this._sub(rowing, CH.FORCE_CURVE, (dv) => this._onForceCurveNotify(dv));
      this.forceCurveMode = 'notify';
    } catch {
      try {
        await sleep(400);
        await this._sub(rowing, CH.FORCE_CURVE, (dv) => this._onForceCurveNotify(dv));
        this.forceCurveMode = 'notify';
      } catch (e) {
        this.forceCurveMode = 'unsupported'; // upgraded to 'poll' below if control exists
        console.warn('[pm5] force curve characteristic unavailable:', e?.message || e);
      }
    }

    try {
      const control = await server.getPrimaryService(C2_SERVICE_CONTROL);
      this._ctrlTx = await control.getCharacteristic(CH.CTRL_TX);
      const rx = await control.getCharacteristic(CH.CTRL_RX);
      await this._subChar(rx, (dv) => this._onControlNotify(dv));
      if (this.forceCurveMode === 'unsupported') this.forceCurveMode = 'poll';
    } catch { this._ctrlTx = null; }

    // Heart-rate forwarding service (newer PM5 firmware).
    try {
      const hrSvc = await server.getPrimaryService(C2_SERVICE_HR);
      this._hrChar = await hrSvc.getCharacteristic(CH.HR_WRITE);
      this.hrForward = { supported: true, reason: null };
    } catch (e) {
      this._hrChar = null;
      this.hrForward = {
        supported: false,
        reason: /security|not allowed|permission/i.test(String(e)) ? 'permission' : 'unsupported',
      };
    }

    // Stable handler ref + remove-before-add: the browser reuses the same
    // BluetoothDevice object across connect cycles, so an anonymous listener
    // here would stack one copy per session on the same physical erg.
    this._onGattDisconnected ??= () => {
      for (const fn of this.listeners) fn({ ...this.live, disconnected: true, ts: Date.now() });
    };
    this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
  }

  // Subscribe with a stable per-characteristic handler (remove-before-add):
  // the browser hands back the same characteristic objects across connect
  // cycles on the same physical erg, so anonymous listeners would stack.
  async _sub(service, uuid, handler) {
    const ch = await service.getCharacteristic(uuid);
    await this._subChar(ch, handler);
  }
  async _subChar(ch, handler) {
    await ch.startNotifications();
    const bound = (e) => handler(e.target.value);
    const prev = this._charHandlers.get(ch.uuid);
    if (prev) ch.removeEventListener('characteristicvaluechanged', prev);
    this._charHandlers.set(ch.uuid, bound);
    ch.addEventListener('characteristicvaluechanged', bound);
    this._chars ??= new Map();
    this._chars.set(ch.uuid, ch);
  }

  async disconnect() {
    // Intentional teardown: detach the disconnect handler first so ending a
    // session never presents as an unexpected mid-workout disconnect, and
    // detach every characteristic listener so a later session on the same
    // physical erg starts clean.
    try { this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected); } catch { /* never fatal */ }
    try {
      for (const [uuid, handler] of this._charHandlers) {
        this._chars?.get(uuid)?.removeEventListener('characteristicvaluechanged', handler);
      }
      this._charHandlers.clear();
    } catch { /* never fatal */ }
    try { this.device.gatt.disconnect(); } catch { /* already gone */ }
  }

  /* ---- Rowing Data parsing (offsets per the C2 spec tables) ---- */

  _parseGeneralStatus(dv) {
    // 0-2 elapsed (0.01s) | 3-5 distance (0.1m) | 6 workoutType | 7 intervalType
    // 8 workoutState | 9 rowingState | 10 strokeState | 11-13 totalWorkDistance
    if (dv.byteLength < 11) return;
    this.live.elapsedS = u24le(dv, 0) / 100;
    this.live.distanceM = u24le(dv, 3) / 10;
    this.live.workoutType = dv.getUint8(6);
    this.live.workoutState = dv.getUint8(8);
    this.live.rowingState = dv.getUint8(9);
    this.live.strokeState = dv.getUint8(10);
    this.live.dragFactor = dv.byteLength > 18 ? dv.getUint8(18) : this.live.dragFactor;
    this._maybePollForceCurve();
    this._emit();
  }

  _parseAdditional1(dv) {
    // 0-2 elapsed | 3-4 speed (0.001 m/s) | 5 strokeRate | 6 heartRate (255=none)
    // 7-8 currentPace (0.01 s/500m) | 9-10 avgPace (0.01 s/500m)
    if (dv.byteLength < 11) return;
    this.live.strokeRate = dv.getUint8(5);
    const hr = dv.getUint8(6);
    this.live.heartRate = hr === 255 ? null : hr; // HR relay path (§1.6 path 2)
    this.live.paceS = u16le(dv, 7) / 100 || null;
    this.live.avgSplitS = u16le(dv, 9) / 100 || null;
    this._emit();
  }

  _parseAdditional2(dv) {
    // 0-2 elapsed | 3 intervalCount | 4-5 avgPower | 6-7 totalCalories
    // 8-9 splitAvgPace | 10-11 splitAvgPower ...
    if (dv.byteLength < 12) return;
    this.live.intervalCount = dv.getUint8(3);
    this.live.watts = u16le(dv, 4);
    this.live.calories = u16le(dv, 6);
    this._emit();
  }

  _parseStrokeData(dv) {
    // 0-2 elapsed | 3-5 distance | 6 driveLength (0.01m) | 7 driveTime (0.01s)
    // 8-9 recoveryTime (0.01s) | 10-11 strokeDistance (0.01m)
    // 12-13 peakForce (0.1 lbf) | 14-15 avgForce (0.1 lbf) | 16-17 workPerStroke | 18-19 strokeCount
    if (dv.byteLength < 20) return;
    this.live.driveLengthM = dv.getUint8(6) / 100;
    this.live.peakForce = u16le(dv, 12) / 10;
    this.live.avgForce = u16le(dv, 14) / 10;
    this.live.strokeCount = u16le(dv, 18);
    this._emit();
  }

  /* ---- Force curve: notification path (PM5v2+) ---- */

  _onForceCurveNotify(dv) {
    this._forceNotifySeen = true;
    const curve = parseForceCurveNotification(dv, this._forceAccum);
    if (curve) for (const fn of this.forceListeners) fn(curve);
  }

  /* ---- Force curve: CSAFE polling fallback (spec "Get Force Curve") ----
     Watches the stroke state from general status; on each transition into
     recovery, drains GET_FORCEPLOTDATA until the monitor reports no more
     samples, then emits one complete curve. Also self-heals the notify path:
     if the 0x003D subscription looked fine but no data ever arrives, switch
     to polling after a few silent strokes. */

  _maybePollForceCurve() {
    const prev = this._prevStrokeState;
    this._prevStrokeState = this.live.strokeState;
    if (prev === this.live.strokeState || this.live.strokeState !== STROKESTATE_RECOVERY) return;
    if (this.forceCurveMode === 'notify' && !this._forceNotifySeen) {
      if (++this._recoveriesWithoutForce >= 4 && this._ctrlTx) {
        console.warn('[pm5] no force-curve notifications after 4 strokes — falling back to CSAFE polling');
        this.forceCurveMode = 'poll';
      }
    }
    if (this.forceCurveMode !== 'poll' || !this.forceListeners.size) return;
    if (this._pollingForce || this._programming || !this._ctrlTx) return;
    this._pollingForce = true;
    this._pollForcePlot()
      .catch(() => { /* transient — next stroke polls again */ })
      .finally(() => { this._pollingForce = false; });
  }

  async _pollForcePlot() {
    const curve = [];
    for (let i = 0; i < 16; i++) {
      const res = await this._csafeRequest(encodeForcePlotRequest(20), 'force', 1200);
      const plot = res && parseForcePlotResponse(res.payload);
      if (!plot) break;
      curve.push(...plot.samples);
      if (plot.bytesRead < 20) break;
    }
    if (curve.length >= 4) for (const fn of this.forceListeners) fn(curve);
  }

  /* ---- Control service: CSAFE request/response plumbing ---- */

  // Responses arrive as ≤20-byte notifications and one CSAFE frame can span
  // several of them — accumulate until the stop flag (0xF2 cannot appear
  // inside a frame thanks to byte stuffing).
  _onControlNotify(dv) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    for (const b of bytes) {
      if (b === CSAFE.START || b === CSAFE.EXT_START) this._rxBuf = [];
      this._rxBuf.push(b);
      if (b === CSAFE.STOP && this._rxBuf.length > 2) {
        const frame = Uint8Array.from(this._rxBuf);
        this._rxBuf = [];
        this._dispatchResponse(parseFrame(frame));
      }
      if (this._rxBuf.length > 256) this._rxBuf = []; // never grow unbounded
    }
  }

  _dispatchResponse(parsed) {
    if (!parsed) return;
    // Route by content: force-plot responses echo the 0x1A wrapper with the
    // GET_FORCEPLOTDATA command id; everything else answers programming.
    const isForce = parsed.payload[0] === CSAFE.SETUSERCFG1
      && parsed.payload.includes(CSAFE.PM_GET_FORCEPLOTDATA);
    const slot = isForce ? '_pendingForce' : '_pendingProgram';
    const pending = this[slot];
    if (pending) { this[slot] = null; clearTimeout(pending.timer); pending.resolve(parsed); }
  }

  // Write one CSAFE frame (in ≤20-byte chunks for default-MTU compatibility)
  // and await the matching response. All writes are serialized on the GATT
  // queue; the response wait happens outside it so notifications can land.
  _csafeRequest(frame, kind, timeoutMs) {
    const slot = kind === 'force' ? '_pendingForce' : '_pendingProgram';
    // A stale pending (e.g. a failed write followed by a quick retry) must
    // not linger and swallow the new request's response — supersede it.
    const stale = this[slot];
    if (stale) { this[slot] = null; clearTimeout(stale.timer); stale.resolve(null); }
    let pending;
    const response = new Promise((resolve) => {
      pending = {
        resolve,
        timer: setTimeout(() => {
          if (this[slot] === pending) { this[slot] = null; resolve(null); } // null = timed out
        }, timeoutMs),
      };
      this[slot] = pending;
    });
    const write = this._enqueue(async () => {
      for (let i = 0; i < frame.length; i += 20) {
        await this._ctrlTx.writeValueWithResponse(frame.slice(i, i + 20));
      }
    });
    return write.then(() => response);
  }

  _enqueue(job) {
    const run = this._gattQueue.then(job);
    this._gattQueue = run.catch(() => { /* keep the queue alive after a failed write */ });
    return run;
  }

  /* ---- Control service: push workouts (§1.3) ---- */

  async sendWorkout(plan) {
    if (!this._ctrlTx) {
      throw new Error('This monitor does not expose the Concept2 control service, so workouts cannot be programmed onto it. Update the PM5 firmware with the Concept2 Utility, or start the workout from the monitor.');
    }
    this._programming = true;
    try {
      // A monitor mid-workout (or sitting on a finished-workout summary)
      // rejects new programming — terminate first, exactly as ErgData does.
      if (Number.isFinite(this.live.workoutState) && this.live.workoutState !== 0) {
        const res = await this._csafeRequest(encodeTerminateWorkout(), 'program', 3000);
        if (res === null) throw new Error('The monitor did not acknowledge ending its current workout. Press Menu on the PM5, then send the workout again.');
        await sleep(150);
      }

      const frames = encodeWorkout(plan);
      for (let i = 0; i < frames.length; i++) {
        if (i > 0) await sleep(MIN_INTERFRAME_GAP_MS + 10); // spec: ≥50 ms between frames
        const parsed = await this._csafeRequest(frames[i], 'program', 3000);
        if (parsed === null) {
          throw new Error('Timed out waiting for the monitor to acknowledge the workout. Check the PM5 is awake and still connected, then try again.');
        }
        if (!parsed.valid) {
          throw new Error('The monitor sent a corrupted acknowledgement (checksum mismatch). Move closer to the PM5 and try again.');
        }
        const err = describeMachineStatus(parsed.status);
        if (err) {
          // The machine's validation is authoritative (§1.3) — surface it as-is.
          const e = new Error(err);
          e.machineRejection = true;
          throw e;
        }
      }

      // Verify the monitor really switched to the programmed workout: general
      // status byte 6 reports the active workout type within a second or two.
      const expected = EXPECTED_WORKOUT_TYPE[plan?.type || 'justrow'] || [];
      const deadline = Date.now() + 2500;
      let verified = false;
      while (Date.now() < deadline) {
        if (expected.includes(this.live.workoutType)) { verified = true; break; }
        await sleep(200);
      }
      return { verified, workoutType: this.live.workoutType };
    } finally {
      this._programming = false;
    }
  }

  /* ---- Heart-rate forwarding to the monitor (§1.6 path 1) ---- */

  /**
   * Best-effort forward of one heart-rate reading to the PM5 so the monitor
   * shows and logs it exactly as a directly-paired belt would. Throttled to
   * 2 Hz, drops readings while a write is in flight (a fresher one always
   * follows), and disables itself after repeated failures rather than
   * spamming a broken link. Returns false when forwarding isn't possible.
   */
  sendHeartRate(bpm, extras = {}) {
    if (!this._hrChar || !this.hrForward.supported || !Number.isFinite(bpm) || bpm <= 0) return false;
    const now = Date.now();
    if (this._hrWriteBusy || now - this._hrLastWrite < 500) return true; // dropped, fresher follows
    this._hrWriteBusy = true;
    this._hrLastWrite = now;
    this._enqueue(() => this._hrChar.writeValueWithResponse(buildHrPacket(bpm, extras)))
      .then(() => { this._hrFailures = 0; })
      .catch((e) => {
        if (++this._hrFailures >= 3) {
          this.hrForward = { supported: false, reason: 'write_failed' };
          console.warn('[pm5] heart-rate forwarding disabled after repeated write failures:', e?.message || e);
        }
      })
      .finally(() => { this._hrWriteBusy = false; });
    return true;
  }
}
