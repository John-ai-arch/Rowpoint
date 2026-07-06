# Publishing RowPoint on the iOS App Store — full step-by-step guide

Two honest facts up front, because they shape the whole plan:

1. **iOS has no Web Bluetooth.** Safari and every iOS WebView cannot talk to
   BLE devices from web code. So "wrap the website" alone is not enough — the
   App Store build must use **native Bluetooth** through a plugin. RowPoint
   was architected for this: everything above `ErgDataSource` (ergs) and the
   `HeartRateManager` interface (sensors) is platform-independent, so only
   those two adapter layers get native implementations.
2. **Apple rejects "just a website in a shell" (Guideline 4.2).** The
   Capacitor build below is fine *because* it adds native capability
   (Bluetooth) the web version can't have on iOS — call that out in your
   review notes.

The recommended path is **Capacitor** (capacitorjs.com): it wraps the
existing `public/` app in a real iOS project and gives you native plugins.

## Phase 0 — Prerequisites (1–2 days, mostly waiting on Apple)

1. A Mac with the current Xcode from the App Store (required — there is no
   way to build/submit iOS apps without one; a cheap option is renting a
   cloud Mac from MacStadium or using a friend's machine for submission days).
2. Enroll in the **Apple Developer Program** at developer.apple.com — $99/yr,
   requires a D-U-N-S number if enrolling as a company (individuals skip it).
   Approval takes ~24–48 h.
3. Deploy the RowPoint backend publicly first (see DEPLOY.md) — the iOS app
   is a client of that same server; nothing server-side changes.

## Phase 1 — Create the iOS project (half a day)

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init RowPoint fit.rowpoint.app --web-dir public
npx cap add ios
```

Edit `capacitor.config.ts`: set `server.url` to your deployed HTTPS backend
(so the wrapped app talks to the same live server and accounts as the web
version), and set `ios.scheme` to `RowPoint`.

Open it in Xcode: `npx cap open ios`. Set your team under Signing &
Capabilities; it should build and run on a simulator immediately — the whole
app works except Bluetooth.

## Phase 2 — Native Bluetooth (the real work, 1–2 weeks)

Install the community BLE plugin (a thin, well-maintained CoreBluetooth
bridge): `npm install @capacitor-community/bluetooth-le && npx cap sync`.

Then write two small platform adapters — the app already defines the exact
interfaces:

- `public/js/ble/pm5.js` / `ftms.js` → a `CapacitorErgAdapter` using the
  plugin's `requestLEScan` (this gives you the REAL in-app scan list with
  RSSI that web code can't have), `connect`, `startNotifications`, `write`.
  All UUIDs, byte parsing, and CSAFE encoding are already in these files and
  are byte-identical on native — you're only swapping the transport calls.
- `public/js/ble/sensors.js` → same swap for the `BleHeartRateMonitor` class.
  `parseHrMeasurement`, zones, known-device memory, auto-reconnect logic all
  run unchanged; on native you additionally get free-form scanning, true
  background reconnection, and RSSI for every device in the list.

Add to `ios/App/App/Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>RowPoint uses Bluetooth to connect to your rowing machine and heart rate monitor. It never uses or stores your location.</string>
```

## Phase 3 — Apple's compliance checklist (specific to RowPoint)

Work through these before submission; each is a known rejection reason:

1. **Sign in with Apple** — required because the app offers Google sign-in
   (Guideline 4.8). Add the "Sign in with Apple" capability in Xcode, create
   a Services ID in the developer portal, set `APPLE_CLIENT_ID` on the
   server, and finish the token-verification path in `server/auth.js`
   (`/oauth/apple` — the endpoint and account-linking logic exist; it needs
   your Apple keys to verify tokens against Apple's JWKS).
2. **Privacy manifest** (`PrivacyInfo.xcprivacy`) — declare collected data
   types (health/fitness, email) and any required-reason APIs. Xcode →
   Product → Generate Privacy Report to confirm every bundled SDK has one.
3. **App Privacy labels** in App Store Connect — declare: email (linked to
   identity), health & fitness data (workouts, heart rate — linked), and
   note the research program's pseudonymized use.
4. **In-app account deletion** — already built (Settings → Delete account);
   just point it out in review notes (Guideline 5.1.1(v)).
5. **Privacy policy URL** — must be public and must cover the research
   opt-out program, wellness data, heart-rate data, and the AI features.
   Have the consent language legally reviewed before launch.
6. **AI disclosure** — the metadata and review notes must state that workout
   suggestions/feedback are AI-generated (they're already labeled in-app).
7. **Demo accounts for App Review** — create one verified coach and one
   verified rower on your production server and put both logins in the
   review notes, plus one saved simulated workout so reviewers see live
   screens without hardware. Mention the erg/HR simulators explicitly.
8. **Health data rule of thumb** — RowPoint reads HR from BLE straps
   directly (not HealthKit), so no HealthKit entitlement is needed yet. If
   you later add Apple Watch/HealthKit sync, add the entitlement + usage
   strings then.

## Phase 4 — Assets & App Store Connect (1–2 days)

1. appstoreconnect.apple.com → My Apps → **New App** (bundle id
   `fit.rowpoint.app`, name "RowPoint").
2. Screenshots: 6.9" and 6.5" iPhone sizes minimum — run the app on
   simulators and capture the dashboard, live row screen, coach live view,
   heart-rate page, and workout summary.
3. App icon: reuse `public/icons/icon-512.png` as the base; Xcode needs a
   1024×1024 marketing icon.
4. Description, keywords, support URL, marketing URL, age rating
   questionnaire (the social features mean "infrequent user-generated
   content" — answer honestly), price (free).

## Phase 5 — TestFlight, then release (1–2 weeks including review)

1. Xcode → Product → **Archive** → Distribute → App Store Connect. The build
   appears in TestFlight in ~15 minutes.
2. Test on real devices with a real PM5 and a real HR strap — this is where
   native BLE issues surface. Invite teammates via TestFlight (up to 10,000
   external testers after a one-time beta review).
3. When stable: App Store Connect → your app → select the build → **Submit
   for Review**. First reviews typically take 1–3 days. If rejected, the
   resolution center message tells you exactly which guideline — fix, reply,
   resubmit (same-day re-reviews are common).

## Android note

The identical Capacitor project ships to Google Play
(`npx cap add android`): you'll need the Data Safety form, an `.aab` bundle,
the closed-testing requirement for new personal accounts (12 testers / 14
days before production), and `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` runtime
permissions — the permission-rationale copy is already written in the app.

## Cost & time summary

Apple Developer Program $99/yr; a Mac (or rented cloud Mac ~$50/mo only for
the weeks you need it); realistic calendar time from "web app live" to "App
Store approved": **3–5 weeks**, dominated by the native BLE adapter work and
review round-trips.
