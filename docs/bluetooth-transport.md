# Bluetooth Transport Layer (Web Bluetooth + iOS WebBLE)

*Added 2026-07-20. Companion to the PM5 protocol notes in the CSAFE spec memos
and `public/js/ble/csafe.js`.*

## Why

iOS provides no Web Bluetooth in Safari or in any App-Store browser that uses
the system WebKit engine directly. The practical way to reach a Concept2 PM5
from a web app on iPhone/iPad is a **bridge browser** — an app such as
**WebBLE** (Green Park Software) or **Bluefy** that hosts the page in a
WKWebView and injects a JavaScript `navigator.bluetooth` polyfill which relays
GATT operations to CoreBluetooth.

RowPoint now selects its Bluetooth transport automatically. The PM5/CSAFE
protocol code is **shared and byte-identical** on every transport; the PM5
never knows which one carried its packets.

## Architecture

```
                       RowPoint UI (row.js, hrm.js, …)
                                   |
              ergManager (ergSource.js)   hrManager (sensors.js)
                                   |
     Concept2PM5Adapter · FTMSAdapter · BleHeartRateMonitor · Simulated*
              (pm5.js — CSAFE protocol, SHARED, unchanged)
                                   |
                     BluetoothManager (transport.js)   ← the ONLY module
                       /                        \         that touches
        WebBluetoothTransport             WebBLETransport  navigator.bluetooth
        (native Chrome/Edge/              (iOS bridges: WebBLE,
         Opera, desktop+Android)           Bluefy → CoreBluetooth)
                       \                        /
                            Concept2 PM5
```

`transport.js` exposes:

- `BluetoothManager.isAvailable()` / `.transportKind` / `.capabilities()`
- `BluetoothManager.requestDevice(options)` — chooser on every transport
- `BluetoothManager.getDevices()` — previously-granted devices, `[]` where the
  transport keeps no permissions (never invented)
- `BluetoothManager.getAvailability()` / `.diagnostics()`

### Transport detection (priority order)

1. `navigator.bluetooth.requestDevice` implemented by the browser engine
   (stringifies to `[native code]`) → **webbluetooth**, full passthrough.
2. `navigator.bluetooth` present but plain JavaScript → an injected iOS bridge
   polyfill → **webble**, with normalization.
3. Neither → **none**; the UI shows the per-platform explainer, which on iOS
   now recommends opening RowPoint inside WebBLE/Bluefy, and always offers the
   simulator.

UA strings are never consulted for transport choice (iOS wrappers imitate
Safari); only for the human-readable help text.

### WebBLE normalization (what it does and does not do)

The bridge polyfills return plain JS objects, so missing methods are added
**in place** (no proxies — the adapters' remove-before-add listener hygiene
keys on object identity):

- `writeValueWithResponse`/`writeValueWithoutResponse` → delegate to
  `writeValue` on bridges older than WebBLE 1.7. The bridge performs
  `writeValue` as a with-response GATT write, so the delegation is exact.
- Every service/characteristic UUID is canonicalized to a full 128-bit
  lowercase string (`0x180D → 0000180d-…-00805f9b34fb`) — the bridges are
  inconsistent about numeric SIG aliases and may lack the `BluetoothUUID`
  global. For the same reason `ftms.js` now probes data characteristics with
  direct `getCharacteristic` calls instead of `getCharacteristics()`.
- Capabilities genuinely absent on the bridges are **reported absent, not
  faked**: `getDevices()` (silent reconnect) and `watchAdvertisements()`
  (RSSI). Callers already degrade: the reconnect button simply doesn't render
  and the chooser is used instead; RSSI shows as n/a.

## Verified WebBLE capability matrix (v1.7, Feb 2024)

| Feature | WebBLE | Effect on RowPoint |
|---|---|---|
| Chooser scan + service filters | ✓ | PM5/FTMS/HR discovery works |
| GATT connect + service discovery | ✓ | full connection flow |
| `readValue` | ✓ | PM5 serial → stable machine id |
| Write with response | ✓ (≥1.7 native, older via `writeValue`) | CSAFE frames, HR forwarding |
| Notifications + DOM events | ✓ | telemetry, CSAFE responses, force curve |
| Continuous streaming | ✓ | all four rowing characteristics |
| **Workout programming (CSAFE over 0x0021/0x0022)** | ✓ | PM5 displays and runs the workout |
| `getDevices()` | ✗ | no silent reconnect — chooser each session |
| `watchAdvertisements()` | ✗ | no RSSI display |
| Descriptors | ✗ | not used by RowPoint |

The unit suite drives the real `Concept2PM5Adapter` through a fake pre-1.7
WebBLE object graph (plain objects, `writeValue` only) and asserts the
4×1000 m / 2:00-rest programming sequence is **byte-identical** to the desktop
encoding, chunked ≤20 bytes, acknowledged, and verified
(`tests/unit.test.js`, "Bluetooth transport layer" section).

## Diagnostics

- `window.RowPointBLE.log` — ring buffer of every programming exchange
  (plan, frame hex, write result, response hex + status, verification).
- `window.RowPointBLE.diagnostics()` — active transport, capability map,
  secure-context flag, UA.
- `localStorage.rp_ble_debug = '1'` — verbose console for high-volume events.
- The `connect:capabilities` and `program:start` log events now include the
  transport name.

## Testing on hardware

- **Desktop (Chrome/Edge)**: unchanged flow; `[ble] transport: Web Bluetooth
  (native)` appears once in the console.
- **iPhone/iPad**: install WebBLE or Bluefy from the App Store, open the
  RowPoint URL (HTTPS) inside it, Connect → chooser lists the PM5. Console
  shows `[ble] transport: WebBLE bridge (iOS/CoreBluetooth)`. Send a workout;
  the PM5 must leave the menu and show the interval screen. If it doesn't, tap
  "Copy diagnostic log" on the row page and file the dump.
- Known bridge limitation to expect on iOS: no "reconnect to last machine"
  button (no persistent permissions) — this is by design, not a bug.
