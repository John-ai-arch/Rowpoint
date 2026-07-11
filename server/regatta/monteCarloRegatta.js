// Monte Carlo regatta — thousands of seeded races, one probability picture.
//
// The simulator never outputs "the" race. Each iteration draws one plausible
// world (who shows up in each lane, that day's wind and current, execution
// noise, optional tactical events) and integrates the full race. The
// aggregate is an outcome DISTRIBUTION: win/medal probability, finish-time
// quantiles, a rank matrix, per-500 split spreads, a leader-probability
// curve along the course, and a sensitivity ranking of which uncertain
// variables actually moved the result.
//
// Reproducibility: iteration i uses rng seedFrom(seed, i) — the same seed
// and versions replay byte-identically, including the stored race replay
// (which is literally iteration `replayIndex` re-run with recording on).
// Pure module: runs identically inline and on worker threads.
import { createRng, seedFrom } from '../kernel/rng.js';
import { quantile, mean, pearson } from '../kernel/stats.js';
import { simulateRace, MARK_INTERVAL_M } from './race.js';
import { resolveProfile, STRATEGIES } from './strategy.js';
import { sampleEvents } from './tactics.js';
import { makeEnvironmentModel, sampleEnvironment } from './environment.js';

export const MC_REGATTA_VERSION = 'regatta.monte-carlo@1.0';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Draw one race-day realization of every boat. rng order is the contract
 *  that makes replays exact — never reorder these draws. */
function sampleBoats(boats, strategy, customQuarters, rng) {
  return boats.map((b) => {
    const cp = Math.max(rng.gaussian(b.cpW, b.cpSd), b.cpW * 0.7) * (b.readinessFactor ?? 1);
    const wp = Math.max(rng.gaussian(b.wPrimeJ, b.wpSd), b.wPrimeJ * 0.3);
    const aggression = b.isUser ? 0 : clamp(rng.gaussian(b.aggression ?? 0.5, 0.12), 0, 1);
    const sprintTendency = b.isUser ? 0 : clamp(rng.gaussian(b.sprintTendency ?? 0.5, 0.12), 0, 1);
    return {
      ...b,
      cpW: cp,
      wPrimeJ: wp,
      basePowerW: cp + wp / b.duration0S, // 2-parameter CP model, matching physics.power
      aggression,
      sprintTendency,
      profile: b.isUser
        ? resolveProfile({ strategy, customQuarters })
        : resolveProfile({ strategy: 'even', aggression, sprintTendency }),
      events: null,
    };
  });
}

/** Monte Carlo time step. Coarser than the engine's 250 ms default — inside
 *  the design's 100–500 ms window — because bulk statistics over thousands
 *  of races don't need sub-stroke resolution. The stored replay re-runs its
 *  iteration with the SAME step, so it reproduces exactly. */
export const MC_DT_S = 0.5;

function runIteration(boats, envModel, config, i, { record = false } = {}) {
  const rng = createRng(seedFrom(config.seed, i));
  const env = sampleEnvironment(envModel, rng);
  const sampled = sampleBoats(boats, config.strategy, config.customQuarters, rng);
  if (config.tactics) {
    const events = sampleEvents(sampled, rng);
    sampled.forEach((b, idx) => { b.events = events[idx]; });
  }
  const race = simulateRace(sampled, env, {
    distanceM: config.distanceM, dtS: MC_DT_S, rng, record, recordEveryS: config.recordEveryS ?? 1,
  });
  return { race, env, sampled };
}

/**
 * @param {object} config { boats (prepared descriptors, one isUser), environment,
 *   distanceM, strategy, customQuarters, tactics, iterations, seed,
 *   compareStrategies }
 * @param {function} [onProgress] optional (done, total) callback
 */
export function runRegattaMC(config, onProgress = null) {
  const boats = config.boats;
  const iterations = clamp(Math.round(config.iterations) || 2000, 100, 10000);
  const userIdx = Math.max(boats.findIndex(b => b.isUser), 0);
  const envModel = makeEnvironmentModel(config.environment || {}, boats.length);
  const cfg = { ...config, iterations };

  const marksCount = Math.floor(config.distanceM / MARK_INTERVAL_M);
  const finish = boats.map(() => new Array(iterations));
  const rank = boats.map(() => new Array(iterations));
  const leadCount = boats.map(() => new Array(marksCount).fill(0));
  const userMarks = Array.from({ length: marksCount }, () => []);
  const userSplitCount = Math.floor(config.distanceM / 500);
  const userSplits = Array.from({ length: userSplitCount }, () => []);
  const factors = { userCp: [], userWp: [], headwind: [], current: [], oppStrength: [], laneBias: [] };

  for (let i = 0; i < iterations; i++) {
    const { race, env, sampled } = runIteration(boats, envModel, cfg, i);
    for (let b = 0; b < boats.length; b++) {
      finish[b][i] = race.finishTimes[b];
      rank[b][i] = race.ranks[b];
    }
    for (let m = 0; m < marksCount; m++) {
      let best = Infinity, bestB = 0;
      for (let b = 0; b < boats.length; b++) {
        const tm = race.markTimes[b][m];
        if (tm !== null && tm < best) { best = tm; bestB = b; }
      }
      leadCount[bestB][m]++;
      if (race.markTimes[userIdx][m] !== null) userMarks[m].push(race.markTimes[userIdx][m]);
    }
    race.splits500[userIdx].forEach((s, k) => { if (s !== null && k < userSplitCount) userSplits[k].push(s); });
    factors.userCp.push(sampled[userIdx].cpW / boats[userIdx].cpW);
    factors.userWp.push(sampled[userIdx].wPrimeJ / boats[userIdx].wPrimeJ);
    factors.headwind.push(env.headwindMps);
    factors.current.push(env.currentMps);
    factors.oppStrength.push(boats.length > 1
      ? mean(sampled.filter((_, b) => b !== userIdx).map((s, b) => s.cpW)) : 0);
    factors.laneBias.push(env.laneBias[userIdx] ?? 0);
    if (onProgress && (i + 1) % 500 === 0) onProgress(i + 1, iterations);
  }

  /* ------------------------------ aggregate ------------------------------ */

  const q = (xs, p) => r2(quantile(xs, p));
  const userFinish = finish[userIdx];
  const winProb = mean(rank[userIdx].map(r => (r === 0 ? 1 : 0)));
  const medalProb = mean(rank[userIdx].map(r => (r <= 2 ? 1 : 0)));

  const rankMatrix = boats.map((_, b) => {
    const counts = new Array(boats.length).fill(0);
    for (const r of rank[b]) counts[r]++;
    return counts.map(c => r3(c / iterations));
  });
  const expectedOrder = boats
    .map((boat, b) => ({ name: boat.name, isUser: !!boat.isUser, meanRank: r2(mean(rank[b]) + 1) }))
    .sort((a, b) => a.meanRank - b.meanRank);

  const sensitivityDefs = [
    ['userCp', 'Your sustainable power on the day'],
    ['userWp', 'Your anaerobic reserve (W′)'],
    ['headwind', 'Headwind'],
    ['current', 'Course current'],
    ['oppStrength', 'Opponent field strength'],
    ['laneBias', 'Your lane'],
  ];
  const sensitivity = sensitivityDefs
    .map(([key, label]) => {
      const r = pearson(factors[key], userFinish);
      return { factor: key, label, r: Number.isFinite(r) ? r3(r) : 0 };
    })
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  /* -------- replay: the median race, re-run with recording on -------- */
  const medianTime = quantile(userFinish, 0.5);
  let replayIndex = 0, bestDelta = Infinity;
  for (let i = 0; i < iterations; i++) {
    const d = Math.abs(userFinish[i] - medianTime);
    if (d < bestDelta) { bestDelta = d; replayIndex = i; }
  }
  const replayRun = runIteration(boats, envModel, cfg, replayIndex, { record: true });

  /* -------- optional: rank every strategy against this field -------- */
  let strategyComparison = null;
  if (config.compareStrategies) {
    const per = clamp(Math.floor(iterations / 5), 200, 1000);
    strategyComparison = Object.keys(STRATEGIES).map((stratKey) => {
      const sCfg = { ...cfg, strategy: stratKey, customQuarters: null, seed: seedFrom(config.seed, 'strategy', stratKey) };
      const times = [], wins = [];
      for (let i = 0; i < per; i++) {
        const { race } = runIteration(boats, envModel, sCfg, i);
        times.push(race.finishTimes[userIdx]);
        wins.push(race.ranks[userIdx] === 0 ? 1 : 0);
      }
      return { strategy: stratKey, label: STRATEGIES[stratKey].label, winProb: r3(mean(wins)), medianS: r2(quantile(times, 0.5)), iterations: per };
    }).sort((a, b) => b.winProb - a.winProb);
  }

  return {
    summary: {
      version: MC_REGATTA_VERSION,
      iterations,
      dtS: MC_DT_S,
      seed: config.seed,
      distanceM: config.distanceM,
      boatClass: boats[0]?.boatClass || '1x',
      strategy: config.strategy,
      tactics: !!config.tactics,
      boats: boats.map((b, i) => ({ lane: i + 1, name: b.name, isUser: !!b.isUser, kind: b.kind || 'user', archetype: b.archetype || null })),
      user: {
        lane: userIdx + 1,
        winProb: r3(winProb),
        medalProb: r3(medalProb),
        finish: { p5: q(userFinish, 0.05), p25: q(userFinish, 0.25), p50: q(userFinish, 0.5), p75: q(userFinish, 0.75), p95: q(userFinish, 0.95) },
        splits500: userSplits.map(xs => (xs.length ? { p10: q(xs, 0.1), p50: q(xs, 0.5), p90: q(xs, 0.9) } : null)),
      },
      finishTimes: boats.map((b, i) => ({ name: b.name, p5: q(finish[i], 0.05), p50: q(finish[i], 0.5), p95: q(finish[i], 0.95) })),
      rankMatrix,
      expectedOrder,
      leaderCurve: {
        marksM: Array.from({ length: marksCount }, (_, m) => (m + 1) * MARK_INTERVAL_M),
        probs: leadCount.map(row => row.map(c => r3(c / iterations))),
      },
      positionBand: userMarks.map((xs, m) => ({
        m: (m + 1) * MARK_INTERVAL_M,
        p10: xs.length ? q(xs, 0.1) : null, p50: xs.length ? q(xs, 0.5) : null, p90: xs.length ? q(xs, 0.9) : null,
      })),
      sensitivity,
      strategyComparison,
      environment: {
        model: { headwindMean: r2(envModel.headwindMean), headwindSd: r2(envModel.headwindSd), currentMean: r2(envModel.currentMean), waterDragFactor: r3(envModel.waterDragFactor) },
        provenance: envModel.provenance,
      },
    },
    replay: {
      recordEveryS: cfg.recordEveryS ?? 1,
      iteration: replayIndex,
      note: 'The simulated race whose outcome sits at the median of the distribution — one plausible race, not a prediction.',
      boats: boats.map((b, i) => ({ lane: i + 1, name: b.name, isUser: !!b.isUser })),
      finishTimes: replayRun.race.finishTimes,
      splits500: replayRun.race.splits500,
      timeline: replayRun.race.timeline,
    },
  };
}
