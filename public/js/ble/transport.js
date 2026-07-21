// Bluetooth transport layer — the ONE place RowPoint touches a Web Bluetooth
// implementation. Everything above this module (PM5/FTMS/HR adapters,
// ergManager, hrManager, UI) goes through BluetoothManager; nothing else in
// the app references navigator.bluetooth directly.
//
//                        RowPoint app
//                             |
//                      BluetoothManager
//                       /            \
//     WebBluetoothTransport      WebBLETransport
//     (native Chrome/Edge/       (iOS bridge apps: WebBLE,
//      Opera/Android)             Bluefy → CoreBluetooth)
//                       \            /
//                        Concept2 PM5
//
// Both transports hand back the STANDARD Web Bluetooth object shapes
// (device → gatt → service → characteristic, DOM events), so the PM5/CSAFE
// protocol code is byte-for-byte identical on both — the PM5 never knows
// which transport carried its packets. The WebBLE transport only papers over
// the gaps in the iOS bridges' injected polyfill; it never fakes a feature
// the bridge cannot deliver (missing capabilities are reported as absent in
// capabilities() and callers degrade honestly).
//
// Transport detection (in priority order):
//   1. navigator.bluetooth implemented by the browser engine → WEB_BLUETOOTH.
//   2. navigator.bluetooth present but injected as plain JavaScript → an iOS
//      Web-Bluetooth bridge (WebBLE/Bluefy inject their polyfill into every
//      page) → WEBBLE, with normalization.
//   3. Neither → NONE; the UI shows the honest per-platform explainer.

export const Transport = {
  WEB_BLUETOOTH: 'webbluetooth',
  WEBBLE: 'webble',
  NONE: 'none',
};

/* ---------------- UUID canonicalization ----------------
   Native Web Bluetooth accepts 16/32-bit SIG aliases (0x180D) everywhere;
   the iOS bridge polyfills are inconsistent about numeric aliases and some
   lack the BluetoothUUID global entirely. Canonicalizing to full 128-bit
   lowercase strings works on every implementation. */

const SIG_BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

export function canonicalUuid(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
    return v.toString(16).padStart(8, '0') + SIG_BASE_SUFFIX;
  }
  return String(v).toLowerCase();
}

/** Map every service UUID in requestDevice options through canonicalUuid. */
export function normalizeRequestOptions(options = {}) {
  const out = { ...options };
  if (Array.isArray(out.filters)) {
    out.filters = out.filters.map(f =>
      Array.isArray(f.services) ? { ...f, services: f.services.map(canonicalUuid) } : { ...f });
  }
  if (Array.isArray(out.optionalServices)) {
    out.optionalServices = out.optionalServices.map(canonicalUuid);
  }
  return out;
}

/* ---------------- WebBLE object-graph normalization ----------------
   The bridge polyfills return plain JS objects, so missing methods are added
   IN PLACE (never wrapped in proxies): the PM5/HR adapters key their
   remove-before-add listener hygiene on object identity, and patching
   preserves it. Each object is patched at most once. */

const patchedObjects = new WeakSet();

function patchCharacteristic(ch) {
  if (!ch || typeof ch !== 'object' || patchedObjects.has(ch)) return ch;
  patchedObjects.add(ch);
  // WebBLE before 1.7 exposes only writeValue(), which the bridge performs as
  // a with-response GATT write — so delegating writeValueWithResponse to it is
  // exact, not an emulation. Without-response falls back the same way (a
  // with-response write is always acceptable where without-response was
  // requested; only latency differs).
  if (typeof ch.writeValueWithResponse !== 'function' && typeof ch.writeValue === 'function') {
    ch.writeValueWithResponse = (value) => ch.writeValue(value);
  }
  if (typeof ch.writeValueWithoutResponse !== 'function') {
    const fallback = typeof ch.writeValue === 'function' ? 'writeValue' : 'writeValueWithResponse';
    if (typeof ch[fallback] === 'function') {
      ch.writeValueWithoutResponse = (value) => ch[fallback](value);
    }
  }
  return ch;
}

// Replace obj[method] with a version that canonicalizes a UUID first argument
// and patches the resolved result (single object or array).
function wrapGetter(obj, method, patchResult) {
  const orig = obj[method];
  if (typeof orig !== 'function') return;
  obj[method] = async function (...args) {
    if (args.length && args[0] !== undefined) args[0] = canonicalUuid(args[0]);
    const res = await orig.apply(this, args);
    return Array.isArray(res) ? res.map(patchResult) : patchResult(res);
  };
}

function patchService(svc) {
  if (!svc || typeof svc !== 'object' || patchedObjects.has(svc)) return svc;
  patchedObjects.add(svc);
  wrapGetter(svc, 'getCharacteristic', patchCharacteristic);
  wrapGetter(svc, 'getCharacteristics', patchCharacteristic);
  return svc;
}

function patchServer(server) {
  if (!server || typeof server !== 'object' || patchedObjects.has(server)) return server;
  patchedObjects.add(server);
  wrapGetter(server, 'getPrimaryService', patchService);
  wrapGetter(server, 'getPrimaryServices', patchService);
  // Standard shape: connect() resolves to this same server object — but patch
  // whatever it actually returns in case a bridge hands back a fresh object.
  const origConnect = server.connect;
  if (typeof origConnect === 'function') {
    server.connect = async function (...args) {
      return patchServer(await origConnect.apply(this, args));
    };
  }
  return server;
}

/** Normalize a device returned by an iOS bridge to the full standard surface. */
export function normalizeWebBleDevice(device) {
  if (!device || typeof device !== 'object' || patchedObjects.has(device)) return device;
  patchedObjects.add(device);
  if (device.gatt) patchServer(device.gatt);
  return device;
}

/* ---------------- transport detection ---------------- */

function looksNativeBluetooth(env) {
  // Engine-implemented requestDevice stringifies to "[native code]"; the iOS
  // bridges inject plain JavaScript. This is the only reliable discriminator —
  // user-agent strings inside iOS wrapper apps imitate Safari.
  try {
    return /\{\s*\[native code\]\s*\}/.test(
      Function.prototype.toString.call(env.navigator.bluetooth.requestDevice));
  } catch {
    return false;
  }
}

export function detectTransport(env = globalThis) {
  const bt = env.navigator?.bluetooth;
  if (!bt || typeof bt.requestDevice !== 'function') return Transport.NONE;
  return looksNativeBluetooth(env) ? Transport.WEB_BLUETOOTH : Transport.WEBBLE;
}

/* ---------------- transports ---------------- */

const NO_CAPABILITIES = Object.freeze({
  chooser: false, getDevices: false, getAvailability: false,
  watchAdvertisements: false, writeWithResponse: false,
  writeWithoutResponse: false, notifications: false,
});

export class WebBluetoothTransport {
  kind = Transport.WEB_BLUETOOTH;
  label = 'Web Bluetooth (native)';

  constructor(env = globalThis) { this._env = env; }
  get _bt() { return this._env.navigator.bluetooth; }

  capabilities() {
    return {
      chooser: true,
      getDevices: typeof this._bt.getDevices === 'function',
      getAvailability: typeof this._bt.getAvailability === 'function',
      watchAdvertisements: typeof this._env.BluetoothDevice?.prototype?.watchAdvertisements === 'function',
      writeWithResponse: true,
      writeWithoutResponse: true,
      notifications: true,
    };
  }

  requestDevice(options) { return this._bt.requestDevice(options); }

  async getDevices() {
    return typeof this._bt.getDevices === 'function' ? this._bt.getDevices() : [];
  }

  async getAvailability() {
    if (typeof this._bt.getAvailability !== 'function') return null; // unknown
    try { return await this._bt.getAvailability(); } catch { return null; }
  }
}

export class WebBLETransport {
  kind = Transport.WEBBLE;
  label = 'WebBLE bridge (iOS/CoreBluetooth)';

  constructor(env = globalThis) { this._env = env; }
  get _bt() { return this._env.navigator.bluetooth; }

  capabilities() {
    return {
      chooser: true,
      // The iOS bridges keep no persistent device permissions, so silent
      // reconnect via getDevices() is genuinely unavailable — reported as
      // such, and the UI simply offers the chooser instead.
      getDevices: typeof this._bt.getDevices === 'function',
      getAvailability: typeof this._bt.getAvailability === 'function',
      watchAdvertisements: false, // no advertisement watching on any iOS bridge
      writeWithResponse: true,    // native on WebBLE ≥1.7, normalized below it
      writeWithoutResponse: true,
      notifications: true,
    };
  }

  async requestDevice(options) {
    const device = await this._bt.requestDevice(normalizeRequestOptions(options));
    return normalizeWebBleDevice(device);
  }

  async getDevices() {
    if (typeof this._bt.getDevices !== 'function') return [];
    const devices = await this._bt.getDevices();
    return (devices || []).map(normalizeWebBleDevice);
  }

  async getAvailability() {
    if (typeof this._bt.getAvailability !== 'function') return true; // bridge exists → radio exists
    try { return await this._bt.getAvailability(); } catch { return true; }
  }
}

/* ---------------- the manager ---------------- */

export class BluetoothManagerImpl {
  constructor(env = globalThis) {
    this._env = env;
    this._transport = undefined; // undefined = not yet detected; null = none
  }

  /** Active transport instance, detected once on first use. */
  get transport() {
    if (this._transport === undefined) {
      const kind = detectTransport(this._env);
      this._transport =
        kind === Transport.WEB_BLUETOOTH ? new WebBluetoothTransport(this._env)
        : kind === Transport.WEBBLE ? new WebBLETransport(this._env)
        : null;
      if (this._transport) console.info(`[ble] transport: ${this._transport.label}`);
    }
    return this._transport;
  }

  get transportKind() { return this.transport?.kind ?? Transport.NONE; }

  isAvailable() { return !!this.transport; }

  capabilities() { return this.transport?.capabilities() ?? { ...NO_CAPABILITIES }; }

  /** Whether silent reconnection to a previously-granted device can work here. */
  canGetDevices() { return this.capabilities().getDevices; }

  async requestDevice(options) {
    if (!this.transport) {
      throw Object.assign(
        new Error('Bluetooth is not available in this browser. Use Chrome/Edge on desktop or Android, or a Web-Bluetooth-enabled browser such as WebBLE or Bluefy on iPhone/iPad.'),
        { code: 'no_bluetooth' });
    }
    return this.transport.requestDevice(options);
  }

  /** Previously-granted devices; [] where the transport keeps no permissions. */
  async getDevices() {
    return this.transport ? this.transport.getDevices() : [];
  }

  /** true/false = adapter presence known; null = API can't say. */
  async getAvailability() {
    return this.transport ? this.transport.getAvailability() : false;
  }

  /** Structured snapshot for the diagnostics log / support dumps. */
  diagnostics() {
    return {
      transport: this.transportKind,
      label: this.transport?.label ?? 'none',
      capabilities: this.capabilities(),
      secureContext: this._env.isSecureContext !== false,
      userAgent: this._env.navigator?.userAgent ?? null,
    };
  }
}

export const BluetoothManager = new BluetoothManagerImpl();
