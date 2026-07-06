// §1.7 — Simulated PM5. Implements the exact ErgDataSource surface as the
// real adapters so every screen (live row, force curves, workout push, live
// team view, leaderboards) is fully exercisable with zero hardware — the
// browser-side equivalent of the raralabs/pm5-emulator workflow.
export class SimulatedErgAdapter {
  machineType = 'rower';
  kind = 'simulator';
  machineId = 'SIM-PM5-424242';

  /**
   * options:
   *  pacingProfile: 'even' | 'fly_and_die' | 'negative'  (drives §11.4 demos)
   *  basePaceS: base split in s/500m (default 130 = 2:10)
   *  timeScale: simulation speed multiplier (E2E tests run accelerated)
   *  hr: include heart-rate relay values (§1.6 path 2)
   */
  constructor(options = {}) {
    this.opt = { pacingProfile: 'even', basePaceS: 130, timeScale: 1, hr: true, ...options };
    this.listeners = new Set();
    this.forceListeners = new Set();
    this.live = {};
    this.plan = null;
    this._timer = null;
    this._running = false;
  }

  onMetrics(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onForceCurve(fn) { this.forceListeners.add(fn); return () => this.forceListeners.delete(fn); }
  _emit(extra = {}) { const snap = { ...this.live, ...extra, ts: Date.now() }; for (const fn of this.listeners) fn(snap); }

  async connect() {
    await sleep(350); // pretend to discover services
    this.live = { elapsedS: 0, distanceM: 0, strokeRate: 0, paceS: null, avgSplitS: null, watts: 0, heartRate: this.opt.hr ? 72 : null, strokeCount: 0, dragFactor: 118 };
    this._emit();
  }

  async disconnect() { this.stop(); }

  async sendWorkout(plan) {
    await sleep(250);
    // Mirror real firmware behavior: the machine re-validates and can reject
    // (§1.3). The simulator rejects sub-minimum pieces the same way a PM5 does.
    if (plan?.type === 'distance' && plan.distanceM < 100) {
      const err = new Error('The monitor rejected the workout as invalid (distance below the firmware minimum).');
      err.machineRejection = true;
      throw err;
    }
    if (plan?.type === 'time' && plan.durationS < 20) {
      const err = new Error('The monitor rejected the workout as invalid (duration below the firmware minimum).');
      err.machineRejection = true;
      throw err;
    }
    this.plan = plan;
  }

  /* ---- workout simulation ---- */

  start() {
    if (this._running) return;
    this._running = true;
    this._t0 = Date.now();
    this._elapsed = 0;
    this._distance = 0;
    this._strokes = 0;
    this._lastStrokeAt = 0;
    this._hr = 95;
    // Faster real ticks under acceleration so simulated split boundaries keep
    // sub-second resolution (accelerated runs are used by the E2E tests).
    const tickMs = this.opt.timeScale > 1 ? 50 : 500;
    this._timer = setInterval(() => this._tick(tickMs / 1000 * this.opt.timeScale), tickMs);
  }

  stop() { clearInterval(this._timer); this._timer = null; this._running = false; }

  _targetTotal() {
    const p = this.plan;
    if (!p || p.type === 'justrow') return { kind: 'open' };
    if (p.type === 'time') return { kind: 'time', total: p.durationS };
    if (p.type === 'distance') return { kind: 'distance', total: p.distanceM };
    if (p.type === 'intervals') {
      let t = 0;
      for (const iv of p.intervals) {
        t += iv.workType === 'time' ? iv.workTimeS : iv.workType === 'distance' ? (iv.workDistanceM / 500) * this.opt.basePaceS : 60;
        t += iv.restTimeS || 0;
      }
      return { kind: 'time', total: t };
    }
    return { kind: 'open' };
  }

  _progress() {
    const tgt = this._targetTotal();
    if (tgt.kind === 'time') return Math.min(this._elapsed / tgt.total, 1);
    if (tgt.kind === 'distance') return Math.min(this._distance / tgt.total, 1);
    return Math.min(this._elapsed / 1200, 1);
  }

  _paceNow() {
    const base = this.opt.basePaceS;
    const x = this._progress();
    let pace;
    switch (this.opt.pacingProfile) {
      case 'fly_and_die': pace = base - 7 + 16 * x; break;   // §11.4 started_too_hard demo
      case 'negative':    pace = base + 7 - 14 * x; break;   // started_too_easy demo
      default:            pace = base + Math.sin(x * 9) * 0.8;
    }
    return pace + (Math.random() - 0.5) * 1.2;
  }

  _tick(dt) {
    this._elapsed += dt;
    const pace = this._paceNow();
    const speed = 500 / pace; // m/s
    this._distance += speed * dt;

    const rate = Math.round(18 + 8 * (this.opt.basePaceS / pace) + (this.opt.pacingProfile === 'negative' ? this._progress() * 6 : 0));
    this._hr = Math.min(188, this._hr + dt * (0.55 + this._progress() * 0.5) + (Math.random() - 0.5));
    const watts = Math.round(2.8 / Math.pow(pace / 500, 3));

    // Stroke boundary → emit a force curve (§6 stroke-shape feature).
    if (this._elapsed - this._lastStrokeAt >= 60 / rate) {
      this._lastStrokeAt = this._elapsed;
      this._strokes++;
      for (const fn of this.forceListeners) fn(makeForceCurve(watts));
    }

    const tgt = this._targetTotal();
    const finished = tgt.kind !== 'open' && this._progress() >= 1;

    this.live = {
      elapsedS: round1(this._elapsed),
      distanceM: Math.round(this._distance),
      paceS: round1(pace),
      avgSplitS: round1((this._elapsed / Math.max(this._distance, 1)) * 500),
      strokeRate: rate,
      heartRate: this.opt.hr ? Math.round(this._hr) : null,
      watts,
      strokeCount: this._strokes,
      dragFactor: 118,
      finished,
    };
    this._emit();
    if (finished) this.stop();
  }
}

function makeForceCurve(watts) {
  // Plausible haystack-shaped drive curve, 24 samples, peak scaled by power.
  const n = 24, peak = 280 + watts * 0.55 + Math.random() * 40;
  const curve = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const shape = Math.pow(Math.sin(Math.PI * Math.pow(x, 0.82)), 1.35);
    curve.push(Math.round(peak * shape * (0.97 + Math.random() * 0.06)));
  }
  return curve;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;
