// §1.5 — FTMS adapter (Bluetooth SIG Fitness Machine Service 0x1826) for
// non-Concept2 machines: standardized Rower Data (0x2AD1) and Indoor Bike
// Data (0x2AD2). Same ErgDataSource shape as the PM5 adapter, so nothing
// above this layer knows which machine it's talking to.
export const FTMS_SERVICE = 0x1826;
const ROWER_DATA = 0x2ad1;
const BIKE_DATA = 0x2ad2;
const FEATURE = 0x2acc;

export class FTMSAdapter {
  kind = 'ftms';

  constructor(device, server = null) {
    this.device = device;
    this.server = server;            // optionally pre-connected GATT server
    this.machineType = 'rower'; // refined after service discovery
    this.listeners = new Set();
    this.forceListeners = new Set(); // FTMS has no force curves; stays empty
    this.live = {};
    this.machineId = device.id;
  }

  onMetrics(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onForceCurve(fn) { this.forceListeners.add(fn); return () => this.forceListeners.delete(fn); }
  _emit() { const snap = { ...this.live, ts: Date.now() }; for (const fn of this.listeners) fn(snap); }

  static async requestDevice() {
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [FEATURE],
    });
  }

  async connect() {
    const server = (this.server && this.server.connected) ? this.server : await this.device.gatt.connect();
    this.server = server;
    const svc = await server.getPrimaryService(FTMS_SERVICE);
    const chars = await svc.getCharacteristics();
    const has = (uuid) => chars.some(c => c.uuid === BluetoothUUID.getCharacteristic(uuid));
    if (has(ROWER_DATA)) {
      this.machineType = 'rower';
      await this._subscribe(svc, ROWER_DATA, (dv) => this._parseRowerData(dv));
    } else if (has(BIKE_DATA)) {
      this.machineType = 'bike';
      await this._subscribe(svc, BIKE_DATA, (dv) => this._parseBikeData(dv));
    } else {
      throw new Error('This fitness machine exposes no rower or bike data characteristic.');
    }
    this.device.addEventListener('gattserverdisconnected', () => {
      for (const fn of this.listeners) fn({ ...this.live, disconnected: true, ts: Date.now() });
    });
  }

  async _subscribe(svc, uuid, handler) {
    const ch = await svc.getCharacteristic(uuid);
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value));
  }

  async disconnect() { try { this.device.gatt.disconnect(); } catch { /* gone */ } }

  // FTMS Rower Data (0x2AD1): flags-driven variable layout, little-endian.
  _parseRowerData(dv) {
    const flags = dv.getUint16(0, true);
    let o = 2;
    if (!(flags & 0x0001)) { // More Data bit 0 == 0 → stroke rate + count present
      this.live.strokeRate = dv.getUint8(o) / 2; o += 1;
      this.live.strokeCount = dv.getUint16(o, true); o += 2;
    }
    if (flags & 0x0002) { o += 1; }                                   // avg stroke rate
    if (flags & 0x0004) { this.live.distanceM = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); o += 3; }
    if (flags & 0x0008) { const p = dv.getUint16(o, true); this.live.paceS = p || null; o += 2; }        // instantaneous pace, s/500m
    if (flags & 0x0010) { const p = dv.getUint16(o, true); this.live.avgSplitS = p || null; o += 2; }    // average pace
    if (flags & 0x0020) { this.live.watts = dv.getInt16(o, true); o += 2; }
    if (flags & 0x0040) { o += 2; }                                   // avg power
    if (flags & 0x0080) { o += 2; }                                   // resistance
    if (flags & 0x0100) { this.live.calories = dv.getUint16(o, true); o += 5; } // energy triplet
    if (flags & 0x0200) { this.live.heartRate = dv.getUint8(o) || null; o += 1; }
    if (flags & 0x0800) { this.live.elapsedS = dv.getUint16(o, true); o += 2; }
    this._emit();
  }

  _parseBikeData(dv) {
    const flags = dv.getUint16(0, true);
    let o = 2;
    if (!(flags & 0x0001)) { this.live.speedKmh = dv.getUint16(o, true) / 100; o += 2; }
    if (flags & 0x0002) { o += 2; }
    if (flags & 0x0004) { this.live.cadence = dv.getUint16(o, true) / 2; o += 2; }
    if (flags & 0x0008) { o += 2; }
    if (flags & 0x0010) { this.live.distanceM = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); o += 3; }
    if (flags & 0x0020) { o += 2; }
    if (flags & 0x0040) { this.live.watts = dv.getInt16(o, true); o += 2; }
    if (flags & 0x0080) { o += 2; }
    if (flags & 0x0100) { this.live.calories = dv.getUint16(o, true); o += 5; }
    if (flags & 0x0200) { this.live.heartRate = dv.getUint8(o) || null; o += 1; }
    if (flags & 0x0800) { this.live.elapsedS = dv.getUint16(o, true); o += 2; }
    this._emit();
  }

  async sendWorkout() {
    // FTMS target-setting via the Control Point (0x2AD9) varies widely by
    // manufacturer; structured-workout push is PM5-only for now (§1.5 keeps
    // this behind the common interface so callers just get a clear error).
    throw new Error('Pushing structured workouts is supported on Concept2 PM5 monitors only (for now). You can still row and record freely.');
  }
}
