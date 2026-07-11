// The discrete-time race engine — one race as a coupled dynamic system.
//
// Every boat is integrated at small time steps (default 250 ms):
//
//   strategy profile + start boost + execution noise + tactical events
//     → target per-rower power
//     → capped by the W′-balance reserve (Skiba differential model)
//     → degraded by fatigue-coupled technique loss
//     → crew hull power → propulsive force
//   hull drag (k·v², calibrated per class) + air drag (½ρ·CdA·(v+wind+gust)²)
//     → net force → acceleration → velocity → position (+ current, lane bias)
//
// The physiological states are COUPLED: burning W′ raises depletion, which
// degrades technique, which lowers effective power, which slows the boat and
// (via the strategy staying above CP) burns more W′. A boat that empties its
// reserve is "blown": it can no longer even hold CP (documented severe-fade
// assumption). Mental state is represented only as pacing variance and
// observable surges — never as psychology claims.
//
// Pure module, plain-number inputs only: it runs identically on the main
// thread and on worker threads, and never touches the database.
import { profileMultiplier } from './strategy.js';
import { eventModifiers } from './tactics.js';

export const RACE_MODEL_VERSION = 'regatta.race@1.0';

export const MARK_INTERVAL_M = 250;

/**
 * Simulate one race.
 *
 * @param {Array} boats  per-sim boat states (already sampled), each:
 *   { name, isUser, cpW, wPrimeJ, basePowerW, crewPowerFactor, kBase, cdA,
 *     effMassKg, paceCv, startQuality, fadeTendency, profile, events }
 * @param {object} env   sampled conditions from environment.sampleEnvironment
 * @param {object} opts  { distanceM, dtS, rng, record, recordEveryS }
 * @returns { finishTimes, ranks, markTimes, splits500, timeline }
 */
export function simulateRace(boats, env, { distanceM = 2000, dtS = 0.25, rng, record = false, recordEveryS = 1 } = {}) {
  const D = Math.max(250, distanceM);
  const marksCount = Math.floor(D / MARK_INTERVAL_M);
  const maxT = D / 1.2; // hard stop: nothing rows slower than 1.2 m/s for a whole race
  const NOISE_TAU_S = 8; // execution noise varies over strokes, not steps

  const states = boats.map((b, i) => ({
    b,
    v: 0, x: 0,
    wbal: Math.max(b.wPrimeJ, 1),
    noise: 0,
    finish: null,
    lastVGround: 0,
    marks: new Array(marksCount).fill(null),
    laneBias: env.laneBias?.[i] ?? 0,
  }));

  let gust = 0;
  const timeline = record ? [] : null;
  let nextRecordT = 0;
  let finished = 0;

  for (let t = 0; t < maxT && finished < states.length; t += dtS) {
    // One weather per race: every lane shares the gust process (OU around 0).
    gust += (-gust / env.gustTauS) * dtS + env.gustSd * Math.sqrt((2 * dtS) / env.gustTauS) * (rng ? rng.gaussian(0, 1) : 0);

    for (const s of states) {
      if (s.finish !== null) continue;
      const { b } = s;
      const f = s.x / D;

      // --- target power: strategy × start × noise × events -------------
      let mult = profileMultiplier(b.profile, f);
      if (t < 15) mult *= 1 + 0.30 * (b.startQuality ?? 0.7) * Math.exp(-t / 4);
      if (rng && b.paceCv > 0) {
        s.noise += (-s.noise / NOISE_TAU_S) * dtS + b.paceCv * Math.sqrt((2 * dtS) / NOISE_TAU_S) * rng.gaussian(0, 1);
      }
      const ev = b.events?.length ? eventModifiers(b.events, f, t) : null;
      let p = b.basePowerW * mult * (1 + s.noise) * (ev ? ev.power : 1);

      // --- coupled physiology: W′ reserve caps and technique degrades ---
      const depletion = 1 - s.wbal / b.wPrimeJ;
      const techEff = 1 - (b.fadeTendency ?? 0.5) * depletion * depletion * 0.10;
      p *= techEff;
      if (s.wbal <= 0) p = Math.min(p, b.cpW * 0.92);      // blown: can't even hold CP
      else p = Math.min(p, b.cpW + s.wbal / 20);            // reserve can't dump faster than ~20 s
      p = Math.max(p, 0);

      // Skiba differential W′-balance: burn above CP, refill below it in
      // proportion to how empty the tank is.
      if (p > b.cpW) s.wbal -= (p - b.cpW) * dtS;
      else s.wbal += (b.cpW - p) * (1 - s.wbal / b.wPrimeJ) * dtS;
      s.wbal = Math.min(Math.max(s.wbal, 0), b.wPrimeJ);

      // --- boat dynamics: force balance → acceleration ------------------
      const pHull = p * b.crewPowerFactor;                  // crew × sync × propulsive η
      const vEff = Math.max(s.v, 1.0);                      // force floor at the start (blades slip)
      const fProp = pHull / vEff;
      const rel = Math.max(s.v + env.headwindMps + gust, 0);
      const fDrag = b.kBase * env.waterDragFactor * (ev ? ev.drag : 1) * s.v * s.v
        + 0.5 * env.airDensity * b.cdA * rel * rel;
      s.v = Math.max(s.v + ((fProp - fDrag) / b.effMassKg) * dtS, 0);

      const vGround = Math.max(s.v * (1 + s.laneBias) + env.currentMps, 0.05);
      s.lastVGround = vGround;
      const xPrev = s.x;
      s.x += vGround * dtS;

      // --- marks and finish (interpolated crossings) ---------------------
      for (let m = Math.floor(xPrev / MARK_INTERVAL_M); m < Math.floor(Math.min(s.x, D) / MARK_INTERVAL_M); m++) {
        if (m < marksCount && s.marks[m] === null) {
          s.marks[m] = t + dtS - (s.x - (m + 1) * MARK_INTERVAL_M) / vGround;
        }
      }
      if (s.x >= D) {
        s.finish = t + dtS - (s.x - D) / vGround;
        s.x = D;
        finished++;
      }
    }

    if (timeline && t >= nextRecordT) {
      timeline.push({
        t: Math.round(t * 10) / 10,
        boats: states.map(s => ({
          x: Math.round(s.x * 10) / 10,
          v: Math.round(s.v * 100) / 100,
          wbal: Math.round((s.wbal / s.b.wPrimeJ) * 1000) / 1000,
        })),
      });
      nextRecordT += recordEveryS;
    }
  }

  // A boat still on the course at maxT gets an extrapolated finish so every
  // simulation yields a complete, rankable result (never NaN).
  const finishTimes = states.map(s => s.finish !== null
    ? s.finish
    : maxT + (D - s.x) / Math.max(s.lastVGround, 0.1));

  const order = finishTimes.map((ft, i) => [ft, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(states.length);
  order.forEach(([, boatIdx], rank) => { ranks[boatIdx] = rank; });

  // 500 m split DURATIONS from the mark crossings (marks every 250 m).
  const per500 = Math.floor(D / 500);
  const splits500 = states.map((s, i) => {
    const out = [];
    for (let k = 0; k < per500; k++) {
      const endMark = (k + 1) * (500 / MARK_INTERVAL_M) - 1;
      const startMark = k * (500 / MARK_INTERVAL_M) - 1;
      const tEnd = endMark < marksCount ? s.marks[endMark] : null;
      const tStart = k === 0 ? 0 : s.marks[startMark];
      out.push(tEnd !== null && tStart !== null ? Math.round((tEnd - tStart) * 100) / 100 : null);
    }
    // Last split closes on the finish line when D isn't a multiple of 500.
    if (out.length && out[out.length - 1] === null) {
      const tStart = s.marks[(per500 - 1) * 2 - 1] ?? 0;
      out[out.length - 1] = Math.round((finishTimes[i] - tStart) * 100) / 100;
    }
    return out;
  });

  return {
    finishTimes: finishTimes.map(x => Math.round(x * 100) / 100),
    ranks,
    markTimes: states.map(s => s.marks.map(m => (m === null ? null : Math.round(m * 100) / 100))),
    splits500,
    timeline,
  };
}
