// Concept2 PM5 adapter (§1.2) — Web Bluetooth implementation of ErgDataSource.
// Field offsets follow the published "Concept2 PM5 Bluetooth Smart
// Communication Interface Definition"; every field is a fixed-width
// little-endian value at a known offset.
import { encodeWorkout, parseFrame, describeMachineStatus } from './csafe.js';

export const C2_SERVICE_DISCOVERY = 'ce060000-43e5-11e4-916c-0800200c9a66';
export const C2_SERVICE_INFO      = 'ce060010-43e5-11e4-916c-0800200c9a66';
export const C2_SERVICE_CONTROL   = 'ce060020-43e5-11e4-916c-0800200c9a66';
export const C2_SERVICE_ROWING    = 'ce060030-43e5-11e4-916c-0800200c9a66';

const CH = {
  SERIAL:          'ce060012-43e5-11e4-916c-0800200c9a66',
  // Per the C2 interface definition (and every mature open-source PM5 client,
  // e.g. ergometer.js): ...0021 is TRANSMIT-TO-PM (central writes CSAFE
  // frames), ...0022 is RECEIVE-FROM-PM (notifications with responses).
  CTRL_TX:         'ce060021-43e5-11e4-916c-0800200c9a66', // app → machine CSAFE frames (write)
  CTRL_RX:         'ce060022-43e5-11e4-916c-0800200c9a66', // machine → app responses (notify)
  GENERAL_STATUS:  'ce060031-43e5-11e4-916c-0800200c9a66',
  ADDITIONAL_1:    'ce060032-43e5-11e4-916c-0800200c9a66',
  ADDITIONAL_2:    'ce060033-43e5-11e4-916c-0800200c9a66',
  STROKE_DATA:     'ce060035-43e5-11e4-916c-0800200c9a66',
  SPLIT_DATA:      'ce060037-43e5-11e4-916c-0800200c9a66',
  FORCE_CURVE:     'ce06003d-43e5-11e4-916c-0800200c9a66',
};

const u16le = (dv, o) => dv.getUint16(o, true);
const u24le = (dv, o) => dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);

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
    this._ctrlResolve = null;
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
      optionalServices: [C2_SERVICE_INFO, C2_SERVICE_CONTROL, C2_SERVICE_ROWING],
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
    const sub = async (uuid, handler) => {
      const ch = await rowing.getCharacteristic(uuid);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value));
    };
    await sub(CH.GENERAL_STATUS, (dv) => this._parseGeneralStatus(dv));
    await sub(CH.ADDITIONAL_1, (dv) => this._parseAdditional1(dv));
    await sub(CH.ADDITIONAL_2, (dv) => this._parseAdditional2(dv));
    await sub(CH.STROKE_DATA, (dv) => this._parseStrokeData(dv));
    try { await sub(CH.FORCE_CURVE, (dv) => this._parseForceCurve(dv)); } catch { /* older firmware */ }

    try {
      const control = await server.getPrimaryService(C2_SERVICE_CONTROL);
      this._ctrlTx = await control.getCharacteristic(CH.CTRL_TX);
      const rx = await control.getCharacteristic(CH.CTRL_RX);
      await rx.startNotifications();
      rx.addEventListener('characteristicvaluechanged', (e) => this._onControlResponse(e.target.value));
    } catch { this._ctrlTx = null; }

    this.device.addEventListener('gattserverdisconnected', () => {
      for (const fn of this.listeners) fn({ ...this.live, disconnected: true, ts: Date.now() });
    });
  }

  async disconnect() { try { this.device.gatt.disconnect(); } catch { /* already gone */ } }

  /* ---- Rowing Data parsing (offsets per the C2 spec tables) ---- */

  _parseGeneralStatus(dv) {
    // 0-2 elapsed (0.01s) | 3-5 distance (0.1m) | 6 workoutType | 7 intervalType
    // 8 workoutState | 9 rowingState | 10 strokeState | 11-13 totalWorkDistance
    if (dv.byteLength < 11) return;
    this.live.elapsedS = u24le(dv, 0) / 100;
    this.live.distanceM = u24le(dv, 3) / 10;
    this.live.workoutState = dv.getUint8(8);
    this.live.rowingState = dv.getUint8(9);
    this.live.strokeState = dv.getUint8(10);
    this.live.dragFactor = dv.byteLength > 18 ? dv.getUint8(18) : this.live.dragFactor;
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

  _parseForceCurve(dv) {
    // byte0: high nibble = total characteristics in this curve, low nibble =
    // number of 16-bit data words here; byte1 = sequence; then LE words.
    if (dv.byteLength < 2) return;
    const words = dv.getUint8(0) & 0x0F;
    const seq = dv.getUint8(1);
    if (seq === 0) this._forceAccum = [];
    for (let i = 0; i < words && 2 + i * 2 + 1 < dv.byteLength; i++) {
      this._forceAccum.push(u16le(dv, 2 + i * 2));
    }
    const totalChunks = (dv.getUint8(0) >> 4) & 0x0F;
    if (seq >= totalChunks - 1 && this._forceAccum.length) {
      const curve = [...this._forceAccum];
      this._forceAccum = [];
      for (const fn of this.forceListeners) fn(curve);
    }
  }

  /* ---- Control service: push workouts (§1.3) ---- */

  _onControlResponse(dv) {
    const parsed = parseFrame(new Uint8Array(dv.buffer));
    if (this._ctrlResolve) {
      const err = parsed && describeMachineStatus(parsed.status);
      this._ctrlResolve({ ok: parsed?.valid && !err, machineError: err || (parsed?.valid ? null : 'Malformed response from the monitor.') });
      this._ctrlResolve = null;
    }
  }

  async sendWorkout(plan) {
    if (!this._ctrlTx) throw new Error('This monitor does not expose the control service.');
    const frames = encodeWorkout(plan);
    for (const frame of frames) {
      const response = new Promise((resolve) => {
        this._ctrlResolve = resolve;
        setTimeout(() => { if (this._ctrlResolve) { this._ctrlResolve({ ok: true, timeout: true }); this._ctrlResolve = null; } }, 3000);
      });
      // Write ≤20-byte chunks for default-MTU compatibility.
      for (let i = 0; i < frame.length; i += 20) {
        await this._ctrlTx.writeValueWithResponse(frame.slice(i, i + 20));
      }
      const result = await response;
      if (!result.ok) {
        // The machine's validation is authoritative (§1.3) — surface it as-is.
        const err = new Error(result.machineError || 'The monitor rejected the workout.');
        err.machineRejection = true;
        throw err;
      }
    }
  }
}
