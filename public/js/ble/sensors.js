// Universal BLE fitness-sensor subsystem.
//
// Architecture: a generic BleSensorManager base handles connection lifecycle,
// known-device memory, auto-reconnect, and battery/device-info reads for ANY
// Bluetooth SIG sensor profile. HeartRateManager specializes it for the
// official Heart Rate Service (0x180D). Future sensors (cycling power 0x1818,
// speed/cadence 0x1816, running speed 0x1814) are added by subclassing with a
// different service UUID + packet parser — the rest of the app only ever
// talks to the manager's common surface (states, events, readings).
//
// Platform note (documented, not hidden): Web Bluetooth performs device
// discovery through the browser's chooser, which we filter to ONLY devices
// advertising the Heart Rate Service — speakers, keyboards and headphones
// never appear. Free-form RSSI scanning of arbitrary advertisements is not
// available to web apps; for already-permitted devices we use
// watchAdvertisements() (where supported) for RSSI/proximity and silent
// reconnection. The native iOS/Android ports implement scan lists on this
// same interface with CoreBluetooth/BluetoothLeScanner.

import { BluetoothManager } from './transport.js';

export const HR_SERVICE = 0x180d;
const HR_MEASUREMENT = 0x2a37;
const BATTERY_SERVICE = 0x180f;
const BATTERY_LEVEL = 0x2a19;
const DEVICE_INFO_SERVICE = 0x180a;
const MANUFACTURER_NAME = 0x2a29;
const FIRMWARE_REV = 0x2a26;

export const SensorState = {
  UNAVAILABLE: 'bluetooth_unavailable',
  DISCONNECTED: 'disconnected',
  SCANNING: 'scanning',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  SIGNAL_LOST: 'signal_lost',
  RECONNECTING: 'reconnecting',
};

/**
 * Structured Web-Bluetooth support detection (no i18n here — the UI layer
 * composes translated messages from these codes). Never assumes Bluetooth
 * exists; identifies WHY it's unavailable so we can give an honest, specific
 * explanation per browser instead of a generic error.
 * @returns {{ supported:boolean, browser:'ios'|'apple'|'firefox'|'chromium'|'other', secure:boolean, transport:string }}
 */
export function bluetoothSupportInfo() {
  const supported = BluetoothManager.isAvailable();
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isFirefox = /firefox|fxios/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/chrome|chromium|crios|edg|opr|android/i.test(ua);
  const isChromium = /chrome|chromium|crios|edg|opr/i.test(ua) && !isFirefox;
  let browser = 'other';
  if (isIOS) browser = 'ios';
  else if (isSafari) browser = 'apple';
  else if (isFirefox) browser = 'firefox';
  else if (isChromium) browser = 'chromium';
  const secure = typeof window === 'undefined' ? true : window.isSecureContext !== false;
  return { supported, browser, secure, transport: BluetoothManager.transportKind };
}

/**
 * Ask the browser whether a Bluetooth adapter is actually present & powered
 * (Chrome implements getAvailability). Distinguishes "browser has no Web
 * Bluetooth" from "adapter off". Returns true/false, or null when unknown.
 */
export async function bluetoothAvailability() {
  return BluetoothManager.getAvailability();
}

/**
 * Decode a Heart Rate Measurement packet per the Bluetooth SIG Heart Rate
 * Profile. Handles: flags byte, 8/16-bit BPM, energy-expended field, RR
 * intervals (multiple), and gracefully ignores anything it doesn't know.
 * Exported standalone so it is unit-testable without any Bluetooth stack.
 * @param {DataView} dv
 * @returns {{bpm:number|null, rrIntervalsMs:number[], energyExpendedKj:number|null, sensorContact:boolean|null}}
 */
export function parseHrMeasurement(dv) {
  const out = { bpm: null, rrIntervalsMs: [], energyExpendedKj: null, sensorContact: null };
  try {
    if (!dv || dv.byteLength < 2) return out;
    const flags = dv.getUint8(0);
    let o = 1;
    if (flags & 0x01) { // 16-bit heart rate
      if (dv.byteLength < o + 2) return out;
      out.bpm = dv.getUint16(o, true); o += 2;
    } else {
      out.bpm = dv.getUint8(o); o += 1;
    }
    if ((flags & 0x04)) out.sensorContact = !!(flags & 0x02); // contact supported → contact bit valid
    if (flags & 0x08) { // energy expended present (uint16, kJ)
      if (dv.byteLength >= o + 2) { out.energyExpendedKj = dv.getUint16(o, true); }
      o += 2;
    }
    if (flags & 0x10) { // RR intervals, 1/1024s each, as many as fit
      while (o + 1 < dv.byteLength) {
        out.rrIntervalsMs.push(Math.round(dv.getUint16(o, true) / 1024 * 1000));
        o += 2;
      }
    }
    // Corrupt/absurd packets never propagate.
    if (!Number.isFinite(out.bpm) || out.bpm <= 0 || out.bpm > 250) out.bpm = null;
  } catch { /* corrupt packet — swallow, keep last good value */ }
  return out;
}

/* ---------------- known-device memory (multi-device, per spec) ---------------- */

const DEVICES_KEY = 'rp_hr_devices';
const SETTINGS_KEY = 'rp_hr_settings';

export function knownDevices() {
  try { return JSON.parse(localStorage.getItem(DEVICES_KEY) || '[]'); } catch { return []; }
}
function saveKnownDevices(list) { localStorage.setItem(DEVICES_KEY, JSON.stringify(list.slice(0, 12))); }

export function hrSettings() {
  const defaults = { autoReconnect: true, remember: true, smoothing: true, maxHr: null, restingHr: null };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return defaults; }
}
export function saveHrSettings(patch) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...hrSettings(), ...patch }));
}

export function renameDevice(id, nickname) {
  saveKnownDevices(knownDevices().map(d => d.id === id ? { ...d, nickname: String(nickname).slice(0, 40) } : d));
}
export function forgetDevice(id) { saveKnownDevices(knownDevices().filter(d => d.id !== id)); }
export function preferDevice(id) {
  saveKnownDevices(knownDevices().map(d => ({ ...d, preferred: d.id === id })));
}

/* ---------------- heart-rate zones ---------------- */

export const ZONE_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#fb923c', '#f87171'];
export const ZONE_NAMES = ['Z1 · Recovery', 'Z2 · Endurance', 'Z3 · Tempo', 'Z4 · Threshold', 'Z5 · Max'];

// Standard 50/60/70/80/90% of max-HR boundaries; max HR is user-configurable
// with an age-based default (see effectiveMaxHr).
export function zoneBounds(maxHr) {
  return [0.5, 0.6, 0.7, 0.8, 0.9].map(f => Math.round(maxHr * f));
}
export function zoneForBpm(bpm, maxHr) {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const b = zoneBounds(maxHr);
  if (bpm < b[1]) return 0;
  if (bpm < b[2]) return 1;
  if (bpm < b[3]) return 2;
  if (bpm < b[4]) return 3;
  return 4;
}
export function effectiveMaxHr(user) {
  const s = hrSettings();
  if (s.maxHr) return s.maxHr;
  if (user?.maxHr) return user.maxHr;
  if (user?.birthYear) return Math.max(150, 220 - (new Date().getFullYear() - user.birthYear));
  return 190;
}

/* ---------------- the manager ---------------- */

class HeartRateManagerImpl {
  constructor() {
    this.state = BluetoothManager.isAvailable() ? SensorState.DISCONNECTED : SensorState.UNAVAILABLE;
    this.monitor = null;            // active BleHeartRateMonitor | SimulatedHeartRateMonitor
    this.bpm = null;
    this.rr = [];
    this.battery = null;
    this.rssi = null;
    this.connectedAt = null;
    this.deviceInfo = null;         // { id, name, manufacturer, firmware }
    this._listeners = new Map();    // event -> Set<fn>
    this._recent = [];              // [ms, bpm] for 5s rolling average
    this._session = null;           // { startedMs, samples: [[tOffsetS, bpm]] }
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._batteryTimer = null;
    this._batteryWarned = 0;
    // Returning to the foreground: if the strap signal was lost while the OS
    // had the page paused (or the backoff ran out of attempts in the
    // background), kick one fresh silent-reconnect round immediately instead
    // of waiting for a manual tap. Guarded — this module also loads under
    // Node for the unit tests, where there is no document.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !this.monitor) return;
        if (this.state !== SensorState.SIGNAL_LOST && this.state !== SensorState.DISCONNECTED) return;
        if (!hrSettings().autoReconnect) return;
        this._reconnectAttempts = 0;
        this._scheduleReconnect();
      });
    }
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }
  _emit(event, payload) {
    for (const fn of this._listeners.get(event) || []) { try { fn(payload); } catch (e) { console.error(e); } }
  }
  _setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', { state, detail });
  }

  available() { return BluetoothManager.isAvailable() || this.monitor?.kind === 'simulated'; }

  /* ---- connect via chooser (filtered to HR service ONLY) ---- */
  async connect() {
    if (!BluetoothManager.isAvailable()) {
      this._setState(SensorState.UNAVAILABLE);
      throw new Error('Bluetooth is not available in this browser. Heart rate monitors need Chrome or Edge over HTTPS (or a Web-Bluetooth browser like WebBLE on iPhone/iPad) — or use the simulated monitor to explore the feature.');
    }
    this._setState(SensorState.SCANNING);
    let device;
    try {
      device = await BluetoothManager.requestDevice({
        filters: [{ services: [HR_SERVICE] }],   // only true HR monitors appear
        optionalServices: [BATTERY_SERVICE, DEVICE_INFO_SERVICE],
      });
    } catch (e) {
      this._setState(SensorState.DISCONNECTED);
      if (/cancelled|NotFoundError/i.test(String(e))) {
        throw new Error('No monitor selected. Make sure the strap is worn (most only advertise with skin contact) and try again.');
      }
      if (/permission|security|denied/i.test(String(e))) {
        throw new Error('Bluetooth permission was denied. RowPoint uses Bluetooth only to talk to your fitness sensors — enable it in your browser settings and retry.');
      }
      throw e;
    }
    return this._connectDevice(device);
  }

  async connectSimulated(profile = {}) {
    await this._teardown();
    this._setState(SensorState.CONNECTING);
    this.monitor = new SimulatedHeartRateMonitor(profile);
    await this._wireMonitor(this.monitor);
    return this.deviceInfo;
  }

  async _connectDevice(device) {
    await this._teardown();
    this._setState(SensorState.CONNECTING);
    try {
      this.monitor = new BleHeartRateMonitor(device);
      await withTimeout(this._wireMonitor(this.monitor), 20000, 'Timed out connecting to the monitor. Move it closer and make sure it is not paired to another app.');
      return this.deviceInfo;
    } catch (e) {
      this.monitor = null;
      this._setState(SensorState.DISCONNECTED);
      throw new Error(friendlyHrError(e));
    }
  }

  async _wireMonitor(monitor) {
    monitor.onReading((reading) => this._onReading(reading));
    monitor.onBattery((pct) => this._onBattery(pct));
    monitor.onRssi((rssi) => { this.rssi = rssi; this._emit('rssi', rssi); });
    monitor.onDisconnect(() => this._onDisconnect());
    await monitor.connect();

    this.deviceInfo = monitor.info();
    this.connectedAt = Date.now();
    this._reconnectAttempts = 0;
    this._setState(SensorState.CONNECTED);
    this._emit('device', this.deviceInfo);
    this._rememberCurrent();
    // Battery: initial read done by monitor; refresh every 5 minutes.
    clearInterval(this._batteryTimer);
    this._batteryTimer = setInterval(() => monitor.readBattery?.(), 5 * 60 * 1000);
    this._batteryTimer.unref?.();
  }

  _rememberCurrent() {
    if (!hrSettings().remember || !this.deviceInfo?.id) return;
    const list = knownDevices().filter(d => d.id !== this.deviceInfo.id);
    const existing = knownDevices().find(d => d.id === this.deviceInfo.id) || {};
    list.unshift({
      ...existing,
      id: this.deviceInfo.id,
      name: this.deviceInfo.name,
      manufacturer: this.deviceInfo.manufacturer || existing.manufacturer || null,
      lastConnected: Date.now(),
      preferred: existing.preferred ?? list.every(d => !d.preferred),
      simulated: this.deviceInfo.simulated || false,
    });
    saveKnownDevices(list);
    this._emit('devices', knownDevices());
  }

  /* ---- readings ---- */
  _onReading({ bpm, rrIntervalsMs }) {
    if (bpm === null) return; // corrupt packet — keep last good value
    const nowMs = Date.now();
    this.rr = rrIntervalsMs || [];
    // 5-second rolling window for the smoothed display value.
    this._recent.push([nowMs, bpm]);
    while (this._recent.length && this._recent[0][0] < nowMs - 5000) this._recent.shift();
    const smoothed = Math.round(this._recent.reduce((s, [, b]) => s + b, 0) / this._recent.length);
    this.bpm = bpm;
    if (this._session) {
      this._session.samples.push([Math.round((nowMs - this._session.startedMs) / 1000), bpm]);
    }
    // Emitted immediately — no artificial delay; UI can choose raw or smoothed.
    this._emit('bpm', { bpm, smoothed, rr: this.rr, ts: nowMs });
  }

  _onBattery(pct) {
    this.battery = pct;
    this._emit('battery', pct);
    if (pct !== null && pct < 20 && this._batteryWarned !== (pct < 10 ? 10 : 20)) {
      this._batteryWarned = pct < 10 ? 10 : 20;
      this._emit('banner', {
        kind: pct < 10 ? 'error' : 'warn',
        text: `Heart rate monitor battery ${pct < 10 ? 'critically low' : 'low'} (${pct}%).`,
      });
    }
  }

  /* ---- disconnect + automatic reconnection ---- */
  _onDisconnect() {
    if (!this.monitor) return;
    this.bpm = null;
    this._setState(SensorState.SIGNAL_LOST);
    this._emit('banner', { kind: 'warn', text: 'Heart Rate Monitor Disconnected — workout recording continues.', reconnecting: hrSettings().autoReconnect });
    if (hrSettings().autoReconnect) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    if (this._reconnectAttempts >= 8) { this._setState(SensorState.DISCONNECTED); return; }
    const delay = Math.min(1000 * Math.pow(1.7, this._reconnectAttempts++), 15000);
    this._reconnectTimer = setTimeout(async () => {
      if (!this.monitor) return;
      this._setState(SensorState.RECONNECTING);
      try {
        await this.monitor.reconnect();
        this.connectedAt = Date.now();
        this._reconnectAttempts = 0;
        this._setState(SensorState.CONNECTED);
        this._emit('banner', { kind: 'success', text: 'Heart rate monitor reconnected.' });
      } catch {
        this._scheduleReconnect();
      }
    }, delay);
    this._reconnectTimer.unref?.();
  }

  /**
   * Silent auto-reconnect to the preferred/most-recent known monitor — called
   * on app launch and when a workout starts (no user interaction on success).
   * Uses getDevices() for previously-permitted devices; resolves null when
   * unsupported, nothing known, or out of range.
   */
  async tryAutoReconnect() {
    if (this.state === SensorState.CONNECTED || this.state === SensorState.CONNECTING) return this.deviceInfo;
    const s = hrSettings();
    if (!s.autoReconnect || !BluetoothManager.canGetDevices()) return null;
    const known = knownDevices().filter(d => !d.simulated);
    if (!known.length) return null;
    const target = known.find(d => d.preferred) || known[0];
    try {
      const devices = await BluetoothManager.getDevices();
      const device = devices.find(d => d.id === target.id);
      if (!device) return null;
      this._setState(SensorState.RECONNECTING);
      await this._connectDevice(device);
      return this.deviceInfo;
    } catch {
      this._setState(SensorState.DISCONNECTED);
      return null;
    }
  }

  /* ---- workout session recording ---- */
  startRecording() {
    this._session = { startedMs: Date.now(), samples: [] };
  }
  isRecording() { return !!this._session; }
  stopRecording() {
    const session = this._session;
    this._session = null;
    if (!session) return null;
    // Downsample to ≤1 Hz (straps can notify faster) and cap at 4 h.
    const seen = new Set();
    const samples = [];
    for (const [t, bpm] of session.samples) {
      if (seen.has(t) || t > 14400) continue;
      seen.add(t);
      samples.push([t, bpm]);
    }
    return samples;
  }

  stats() {
    // Session stats when recording, else stats over the recent window.
    // Single pass, no spread: a multi-hour session holds tens of thousands of
    // samples, and Math.min(...huge) overflows the JS argument-list limit.
    const src = this._session?.samples?.length ? this._session.samples : this._recent;
    if (!src.length) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const [, b] of src) { if (b < min) min = b; if (b > max) max = b; sum += b; }
    return { current: this.bpm, min, max, avg: Math.round(sum / src.length) };
  }

  async disconnect() {
    clearTimeout(this._reconnectTimer);
    clearInterval(this._batteryTimer);
    await this._teardown();
    this._setState(SensorState.DISCONNECTED);
  }

  async _teardown() {
    const m = this.monitor;
    this.monitor = null;
    this.bpm = null; this.battery = null; this.rssi = null;
    this.connectedAt = null; this._recent = [];
    try { await m?.disconnect(); } catch { /* gone */ }
  }
}

/* ---------------- real BLE monitor ---------------- */

export class BleHeartRateMonitor {
  kind = 'ble';

  constructor(device) {
    this.device = device;
    this._reading = () => {}; this._battery = () => {}; this._rssi = () => {}; this._disc = () => {};
    this._battLevel = null;
    this._manufacturer = null;
    this._firmware = null;
    // Stable handler references so re-subscribing (reconnects) can always
    // remove-before-add, and disconnect() can detach everything — the same
    // BluetoothDevice/characteristic objects are reused by the browser across
    // sessions, so an unremoved listener would stack and multiply readings.
    this._onMeasurement = (e) => this._reading(parseHrMeasurement(e.target.value));
    this._onBatteryNotify = (e) => this._battery(e.target.value.getUint8(0));
    this._onAdvertisement = (e) => this._rssi(e.rssi);
    this._onGattDisconnected = () => this._disc();
  }

  onReading(fn) { this._reading = fn; }
  onBattery(fn) { this._battery = fn; }
  onRssi(fn) { this._rssi = fn; }
  onDisconnect(fn) { this._disc = fn; }

  info() {
    return {
      id: this.device.id, name: this.device.name || 'Heart rate monitor',
      manufacturer: this._manufacturer, firmware: this._firmware, simulated: false,
    };
  }

  // GATT discovery: locate the official HR service + measurement
  // characteristic, subscribe to notifications (event-driven, no polling).
  // Shared by connect() and reconnect(); remove-before-add keeps exactly ONE
  // measurement listener no matter how many reconnect cycles the session has
  // been through (the browser hands back the same characteristic object).
  async _subscribeMeasurement(server) {
    const hr = await server.getPrimaryService(HR_SERVICE);
    const meas = await hr.getCharacteristic(HR_MEASUREMENT);
    await meas.startNotifications();
    meas.removeEventListener('characteristicvaluechanged', this._onMeasurement);
    meas.addEventListener('characteristicvaluechanged', this._onMeasurement);
  }

  async connect() {
    const server = await this.device.gatt.connect();
    await this._subscribeMeasurement(server);

    // Optional battery service — many but not all straps expose it.
    try {
      const batt = await server.getPrimaryService(BATTERY_SERVICE);
      this._battChar = await batt.getCharacteristic(BATTERY_LEVEL);
      await this.readBattery();
      try {
        await this._battChar.startNotifications();
        this._battChar.removeEventListener('characteristicvaluechanged', this._onBatteryNotify);
        this._battChar.addEventListener('characteristicvaluechanged', this._onBatteryNotify);
      } catch { /* battery notify unsupported — periodic reads cover it */ }
    } catch { this._battery(null); }

    // Optional device information.
    try {
      const info = await server.getPrimaryService(DEVICE_INFO_SERVICE);
      this._manufacturer = await readString(info, MANUFACTURER_NAME);
      this._firmware = await readString(info, FIRMWARE_REV);
    } catch { /* not exposed */ }

    // Signal strength via advertisement watching, where the browser supports it.
    try {
      if (this.device.watchAdvertisements) {
        this.device.removeEventListener('advertisementreceived', this._onAdvertisement);
        this.device.addEventListener('advertisementreceived', this._onAdvertisement);
        await this.device.watchAdvertisements();
      }
    } catch { /* unsupported — RSSI shows as n/a */ }

    this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
  }

  async reconnect() {
    await this.device.gatt.connect();
    await this._subscribeMeasurement(this.device.gatt);
  }

  async readBattery() {
    try {
      if (!this._battChar) return;
      const v = await this._battChar.readValue();
      this._battery(v.getUint8(0));
    } catch { /* transient read failure */ }
  }

  async disconnect() {
    // Detach every device-level listener FIRST: an intentional teardown must
    // not fire the signal-lost path, and a replaced monitor on the same
    // physical device must not leave stale handlers behind.
    try {
      this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      this.device.removeEventListener('advertisementreceived', this._onAdvertisement);
    } catch { /* never fatal */ }
    try { this.device.gatt.disconnect(); } catch { /* gone */ }
  }
}

async function readString(service, uuid) {
  try {
    const ch = await service.getCharacteristic(uuid);
    const v = await ch.readValue();
    return new TextDecoder().decode(v.buffer).replace(/\0+$/, '').trim() || null;
  } catch { return null; }
}

/* ---------------- simulated monitor (demo + tests) ---------------- */

export class SimulatedHeartRateMonitor {
  kind = 'simulated';

  constructor({ base = 118, drift = true, intervalMs = 1000 } = {}) {
    this.base = base; this.drift = drift; this.intervalMs = intervalMs;
    this._reading = () => {}; this._battery = () => {}; this._rssi = () => {}; this._disc = () => {};
    this._t = 0;
  }
  onReading(fn) { this._reading = fn; }
  onBattery(fn) { this._battery = fn; }
  onRssi(fn) { this._rssi = fn; }
  onDisconnect(fn) { this._disc = fn; }

  info() { return { id: 'sim-hrm-1', name: 'Simulated HRM', manufacturer: 'RowPoint', firmware: '1.0.0', simulated: true }; }

  async connect() {
    await new Promise(r => setTimeout(r, 250));
    this._battery(84);
    this._rssi(-58);
    const tick = () => {
      this._t++;
      const wander = Math.sin(this._t / 23) * 9 + Math.sin(this._t / 7) * 3;
      const climb = this.drift ? Math.min(this._t * 0.15, 45) : 0;
      const bpm = Math.round(this.base + wander + climb + (Math.random() - 0.5) * 2);
      const rr = Math.round(60000 / bpm);
      this._reading({ bpm, rrIntervalsMs: [rr], energyExpendedKj: null, sensorContact: true });
    };
    tick(); // first reading immediately — live data within a second of connecting
    this._timer = setInterval(tick, this.intervalMs);
  }
  async reconnect() { await this.connect(); }
  async readBattery() { this._battery(84); }
  async disconnect() { clearInterval(this._timer); }
  simulateSignalLoss() { clearInterval(this._timer); this._disc(); }
}

/* ---------------- helpers ---------------- */

function friendlyHrError(e) {
  const msg = String(e?.message || e);
  if (/Heart Rate.*not found|No Services|getPrimaryService/i.test(msg)) {
    return 'That device does not expose the standard Heart Rate Service, so RowPoint cannot read from it.';
  }
  if (/GATT Server is disconnected|Connection failed|NetworkError/i.test(msg)) {
    return 'Connection to the monitor dropped during setup. Make sure it isn\'t connected to another app or watch, then retry.';
  }
  if (/timed out/i.test(msg)) return msg; // withTimeout messages are already human
  // Unknown failures: never surface a raw browser exception to the athlete.
  console.warn('[hr] connect failed:', msg);
  return 'Could not finish connecting to the monitor. Make sure it is awake, worn, and nearby, then try again.';
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms))]);
}

export const hrManager = new HeartRateManagerImpl();
