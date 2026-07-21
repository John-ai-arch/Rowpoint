// §1.4 — Explicit connection state machine + machine manager. All UI depends
// on this module and the ErgDataSource shape only — never on raw GATT (§1.5).
//
//  IDLE → SCANNING → CANDIDATE_FOUND → CONNECTING → DISCOVERING_SERVICES
//       → READY → STREAMING → ACTIVE_WORKOUT → FINISHED → DISCONNECT_PROMPTED → IDLE
import { Concept2PM5Adapter, C2_SERVICE_DISCOVERY } from './pm5.js';
import { FTMSAdapter, FTMS_SERVICE } from './ftms.js';
import { SimulatedErgAdapter } from './simulator.js';
import { BluetoothManager } from './transport.js';

export const ConnState = {
  IDLE: 'idle', SCANNING: 'scanning', CANDIDATE_FOUND: 'candidate_found',
  CONNECTING: 'connecting', DISCOVERING: 'discovering_services', READY: 'ready',
  STREAMING: 'streaming', ACTIVE_WORKOUT: 'active_workout', FINISHED: 'finished',
  DISCONNECT_PROMPTED: 'disconnect_prompted', ERROR: 'error',
};

class ErgManager {
  constructor() {
    this.state = ConnState.IDLE;
    this.adapter = null;
    this.error = null;
    this.listeners = new Set();
    // Clean disconnect when the tab is backgrounded away/closed (§1.4).
    window.addEventListener('pagehide', () => { this.adapter?.disconnect?.(); });
  }

  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _set(state, error = null) {
    this.state = state; this.error = error;
    for (const fn of this.listeners) fn(state, error);
  }

  bluetoothAvailable() { return BluetoothManager.isAvailable(); }

  /** Silent reconnect needs persistent device permissions (getDevices) —
      present on native Web Bluetooth, absent on the iOS bridges. */
  silentReconnectSupported() { return BluetoothManager.canGetDevices(); }

  rememberedMachine() {
    try { return JSON.parse(localStorage.getItem('rp_last_machine') || 'null'); } catch { return null; }
  }
  _remember(adapter) {
    // Remember the physical machine by BOTH its stable hardware identifier
    // (PM5 serial, §1.2) and the browser's persistent device id, so
    // reconnectRemembered() can re-find it via getDevices() without a chooser.
    localStorage.setItem('rp_last_machine', JSON.stringify({
      machineId: adapter.machineId,
      deviceId: adapter.device?.id || null,
      name: adapter.device?.name || (adapter.kind === 'simulator' ? 'Simulator' : null),
      kind: adapter.kind, machineType: adapter.machineType, at: Date.now(),
    }));
  }

  /** kind: 'auto' scans C2 + FTMS together (§1.5); 'simulator' needs no hardware. */
  async connect(kind = 'auto', simulatorOptions = {}) {
    try {
      this._set(ConnState.SCANNING);
      let adapter;
      if (kind === 'simulator') {
        adapter = new SimulatedErgAdapter(simulatorOptions);
        this._set(ConnState.CANDIDATE_FOUND);
        this._set(ConnState.CONNECTING);
        this._set(ConnState.DISCOVERING);
        await adapter.connect();
      } else {
        if (!BluetoothManager.isAvailable()) {
          throw Object.assign(new Error(
            'Bluetooth is not available in this browser. Use Chrome/Edge over HTTPS (or localhost), a Web-Bluetooth browser like WebBLE on iPhone/iPad, or start the built-in simulator.'),
          { code: 'no_bluetooth' });
        }
        // Scan for both the Concept2 discovery UUID and FTMS 0x1826 at once;
        // the chooser lists only machines advertising one of the two (§1.5).
        const device = await BluetoothManager.requestDevice({
          filters: [{ services: [C2_SERVICE_DISCOVERY] }, { services: [FTMS_SERVICE] }],
          optionalServices: [
            'ce060010-43e5-11e4-916c-0800200c9a66',
            'ce060020-43e5-11e4-916c-0800200c9a66',
            'ce060030-43e5-11e4-916c-0800200c9a66',
            'ce060040-43e5-11e4-916c-0800200c9a66', // C2 PM heart-rate receive (HR forwarding)
            FTMS_SERVICE,
          ],
        });
        this._set(ConnState.CANDIDATE_FOUND);
        adapter = await this._connectDevice(device);
      }

      this.adapter = adapter;
      this._remember(adapter);
      this._set(ConnState.READY);
      return adapter;
    } catch (e) {
      this.adapter = null;
      this._set(ConnState.ERROR, classifyBleError(e));
      throw e;
    }
  }

  // Shared connect path: GATT connect with timeout, then pick the adapter by
  // PROBING which services the machine actually exposes — never by sniffing
  // its advertised name (names vary across firmware and manufacturers).
  async _connectDevice(device) {
    this._set(ConnState.CONNECTING);
    const server = await withTimeout(device.gatt.connect(), 15000,
      'Timed out connecting to the machine. Make sure the monitor is awake and no other phone is connected to it.');
    this._set(ConnState.DISCOVERING);
    let adapter;
    try {
      await server.getPrimaryService('ce060030-43e5-11e4-916c-0800200c9a66'); // C2 Rowing service present?
      adapter = new Concept2PM5Adapter(device, server);
    } catch {
      adapter = new FTMSAdapter(device, server);
    }
    await withTimeout(adapter.connect(), 20000,
      'Timed out discovering the machine\'s services. Move closer to the monitor and try again.');
    return adapter;
  }

  /**
   * Best-effort reconnect to the remembered physical machine WITHOUT the
   * chooser, using the transport's previously-granted devices. Returns the
   * adapter, or null when unsupported/not found — callers fall back to the
   * normal chooser flow. (On the iOS bridges getDevices() is unavailable, so
   * this resolves null and the user simply gets the chooser.)
   */
  async reconnectRemembered() {
    const remembered = this.rememberedMachine();
    if (!remembered?.deviceId || !BluetoothManager.canGetDevices()) return null;
    try {
      const devices = await BluetoothManager.getDevices();
      const device = devices.find(d => d.id === remembered.deviceId);
      if (!device) return null;
      this._set(ConnState.SCANNING);
      const adapter = await this._connectDevice(device);
      this.adapter = adapter;
      this._remember(adapter);
      this._set(ConnState.READY);
      return adapter;
    } catch (e) {
      this.adapter = null;
      this._set(ConnState.ERROR, classifyBleError(e));
      return null;
    }
  }

  markStreaming() { if (this.state === ConnState.READY) this._set(ConnState.STREAMING); }
  markActive() { this._set(ConnState.ACTIVE_WORKOUT); }
  markFinished() { this._set(ConnState.FINISHED); }

  async disconnect() {
    this._set(ConnState.DISCONNECT_PROMPTED);
    await this.adapter?.disconnect?.();
    this.adapter = null;
    this._set(ConnState.IDLE);
  }
}

// §1.4 — specific, human diagnoses instead of a generic "connection failed".
// Every classification keeps the browser's raw exception text in `raw` for
// telemetry; `message` is what the athlete sees and is always human language,
// never a raw exception.
export function classifyBleError(e) {
  const msg = String(e?.message || e);
  if (e?.code === 'no_bluetooth') return { code: 'no_bluetooth', message: msg, raw: msg };
  if (/User cancelled|chooser|NotFoundError/i.test(msg)) {
    return { code: 'cancelled', raw: msg, message: 'No machine selected. Make sure the monitor is awake (press any PM5 button) and try again.' };
  }
  if (/GATT operation already in progress|already connected|busy|in use/i.test(msg)) {
    return {
      code: 'machine_busy', raw: msg,
      message: 'This machine appears to be connected to another phone or tablet. Only one device can hold the Bluetooth connection at a time — ask the other user to disconnect, or pick a different erg.',
    };
  }
  if (/GATT Server is disconnected|Connection failed|NetworkError|timed out/i.test(msg)) {
    return {
      code: 'rf_or_range', raw: msg,
      message: 'The connection dropped while talking to the machine. If this keeps happening near many Wi-Fi routers or USB 3 devices, it is usually radio interference near the monitor rather than an app problem — try moving the phone closer to the PM5.',
    };
  }
  if (/security|permission|denied/i.test(msg)) {
    return { code: 'permission', raw: msg, message: 'Bluetooth permission was denied. RowPoint uses Bluetooth only to discover nearby rowing machines — we never use or store your location.' };
  }
  return {
    code: 'unknown', raw: msg,
    message: 'Something interrupted the Bluetooth connection. Turn the monitor on, keep your device close to it, and try again.',
  };
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export const ergManager = new ErgManager();
