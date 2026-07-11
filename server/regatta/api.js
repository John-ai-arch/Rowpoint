// Regatta API — strictly own-data; simulations are job-backed and
// rate-limited. The one deliberate widening: a COACH may put real teammates
// in lanes (crew lineups and opponent boats), verified against the coach's
// own team membership on every request — coaches already have authorized
// visibility into their team's training, and an athlete can never load
// another athlete's twin through this surface.
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, verifiedRequired } from '../middleware.js';
import { rateLimit } from '../ratelimit.js';
import { ApiError, badRequest, safeJson, clampInt, clampNum } from '../util.js';
import { providersOf } from '../kernel/providers.js';
import { athleteRaceParams, archetypeBoat, manualBoat, crewParams, prepareBoats, ARCHETYPES } from './athleteModel.js';
import { STRATEGIES } from './strategy.js';
import { EVENT_TYPES } from './tactics.js';
import { WHATIF_MODS, evaluateWhatIf } from './whatIf.js';
import { createSimulation, enqueueSimulation } from './index.js';

export const regattaRouter = Router();
regattaRouter.use(authRequired, verifiedRequired);

const MAX_LANES = 8;

function boatClasses() {
  const phys = providersOf('regatta.boat-physics')[0];
  return phys ? Object.keys(phys.BOAT_CLASSES) : ['1x'];
}

/** True when `coachId` coaches a team that `athleteId` belongs to. */
function coachOf(coachId, athleteId) {
  return !!db.prepare(
    `SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id
     WHERE t.coach_id = ? AND m.user_id = ? LIMIT 1`).get(coachId, athleteId);
}

/** Vocabulary for the Race Lab UI. */
regattaRouter.get('/meta', (req, res) => {
  res.json({
    boatClasses: boatClasses(),
    strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, s]) => [k, { label: s.label, description: s.description }])),
    archetypes: Object.fromEntries(Object.entries(ARCHETYPES).map(([k, a]) => [k, { label: a.label }])),
    tacticalEvents: Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, e]) => [k, { label: e.label, baseRate: e.baseRate }])),
    whatIfMods: WHATIF_MODS,
    limits: { maxLanes: MAX_LANES, iterations: { min: 500, max: 10000, default: 2000 }, distanceM: { min: 500, max: 10000 } },
  });
});

/** The athlete's own race parameters (for the setup screen, with provenance). */
regattaRouter.get('/athlete', (req, res) => {
  res.json({ params: athleteRaceParams(req.user) });
});

/** Start a race simulation (background job). */
regattaRouter.post('/simulate', rateLimit('regatta_run', 6, 60 * 60 * 1000), (req, res) => {
  const b = req.body || {};

  const boatClass = boatClasses().includes(b.boatClass) ? b.boatClass : '1x';
  const distanceM = clampInt(b.distanceM, 500, 10000, 2000);
  const strategy = STRATEGIES[b.strategy] ? b.strategy : (b.strategy === 'custom' ? 'custom' : 'even');
  const customQuarters = strategy === 'custom' && Array.isArray(b.customQuarters)
    ? b.customQuarters.slice(0, 4).map(Number) : null;
  const iterations = clampInt(b.iterations, 500, 10000, 2000);

  /* ---- authorization FIRST: real athletes may only appear in a coach's
     own simulation. Checked before anything else so an unauthorized request
     is always refused as such, never masked by a later validation error. */
  const lineup = Array.isArray(b.lineup) ? b.lineup.slice(0, 8).map(String) : null;
  for (const memberId of lineup || []) {
    if (memberId !== req.user.id && !coachOf(req.user.id, memberId)) {
      throw new ApiError(403, 'Lineups may only contain rowers from teams you coach.', 'not_your_athlete');
    }
  }
  const rawOpponents = Array.isArray(b.opponents) ? b.opponents.slice(0, MAX_LANES - 1) : [{ kind: 'archetype', archetype: 'matched' }];
  for (const o of rawOpponents) {
    if (o?.kind === 'teammate' && !coachOf(req.user.id, String(o.userId || ''))) {
      throw new ApiError(403, 'Only a coach may enter their own team\'s athletes as opponents.', 'not_your_athlete');
    }
  }

  /* ---- the user's boat: own twin, or a coach lineup of teammates ---- */
  const userParams = athleteRaceParams(req.user);
  if (!userParams.available) throw badRequest(userParams.reason, 'insufficient_data');

  let userBoat;
  if (lineup?.length) {
    const members = [];
    for (const memberId of lineup) {
      if (memberId === req.user.id) { members.push(userParams); continue; }
      const member = db.prepare('SELECT * FROM users WHERE id = ?').get(memberId);
      if (!member) throw badRequest('Unknown lineup member.');
      const p = athleteRaceParams(member);
      if (!p.available) throw badRequest(`${member.display_name || 'A crew member'} has no usable power estimate yet.`, 'insufficient_data');
      members.push(p);
    }
    userBoat = { ...crewParams(members), name: String(b.crewName || 'Your crew').slice(0, 40), isUser: true, kind: 'crew' };
  } else {
    userBoat = { ...userParams, name: 'You', isUser: true, kind: 'user' };
  }
  delete userBoat.available;

  /* ---- opponents: archetypes, manual rivals, or coached teammates ---- */
  const opponents = [];
  for (const o of rawOpponents) {
    if (!o || typeof o !== 'object') continue;
    if (o.kind === 'manual') {
      const boat = manualBoat(o, userParams);
      if (!boat) throw badRequest('Manual opponents need a plausible 2k time (or 500m split).');
      opponents.push(boat);
    } else if (o.kind === 'teammate') {
      const mate = db.prepare('SELECT * FROM users WHERE id = ?').get(String(o.userId));
      if (!mate) throw badRequest('Unknown teammate.');
      const p = athleteRaceParams(mate);
      if (!p.available) throw badRequest(`${mate.display_name || 'That athlete'} has no usable power estimate yet.`, 'insufficient_data');
      opponents.push({ ...p, available: undefined, name: String(mate.display_name || 'Teammate').slice(0, 40), kind: 'teammate', aggression: 0.4, sprintTendency: 0.4 });
    } else {
      opponents.push(archetypeBoat(String(o.archetype || 'matched'), userParams, o.name ? String(o.name).slice(0, 40) : null));
    }
  }
  if (!opponents.length) throw badRequest('A race needs at least one opponent.');

  /* ---- lane order: user placed at the requested lane ---- */
  const laneCount = opponents.length + 1;
  const userLane = clampInt(b.userLane, 1, laneCount, Math.ceil(laneCount / 2));
  const field = [...opponents];
  field.splice(userLane - 1, 0, userBoat);

  /* ---- environment (validated raw inputs; distributions built downstream) */
  const env = b.environment && typeof b.environment === 'object' ? b.environment : {};
  const environment = {
    windSpeedMps: clampNum(env.windSpeedMps, 0, 25),
    windDirectionDeg: clampNum(env.windDirectionDeg, 0, 360),
    headingDeg: clampNum(env.headingDeg, 0, 360),
    currentMps: clampNum(env.currentMps, -3, 3),
    temperatureC: clampNum(env.temperatureC, -10, 45),
    waterTemperatureC: clampNum(env.waterTemperatureC, 0, 35),
    altitudeM: clampNum(env.altitudeM, 0, 3000),
    laneAdvantagePct: Array.isArray(env.laneAdvantagePct)
      ? env.laneAdvantagePct.slice(0, laneCount).map(v => clampNum(v, -1, 1)) : null,
  };

  /* ---- optional link to a planned race (validation loop) ---- */
  let raceId = null;
  if (b.raceId) {
    const race = db.prepare('SELECT id FROM races WHERE id = ? AND user_id = ?').get(String(b.raceId), req.user.id);
    if (!race) throw badRequest('Unknown race.');
    raceId = race.id;
  }

  const config = {
    distanceM, boatClass, strategy, customQuarters,
    iterations,
    tactics: b.tactics === true,
    compareStrategies: b.compareStrategies === true,
    environment,
    boats: prepareBoats(field, { boatClass, distanceM }),
  };
  const { runId } = createSimulation(req.user.id, config, raceId);
  const jobId = enqueueSimulation(req.user.id, runId);
  res.status(202).json({ ok: true, runId, jobId });
});

/** Own runs, newest first (compact list). */
regattaRouter.get('/runs', (req, res) => {
  const rows = db.prepare(
    `SELECT id, status, race_id, created_at, finished_at, duration_ms, error
     FROM race_simulations WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.user.id);
  res.json({ runs: rows });
});

/** One run in full: config, versions, outcome distributions (no replay). */
regattaRouter.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM race_simulations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!run) throw new ApiError(404, 'Simulation not found.', 'not_found');
  const config = safeJson(run.config_json, {}) || {};
  res.json({
    run: {
      id: run.id,
      status: run.status,
      seed: run.seed,
      raceId: run.race_id,
      config: {
        distanceM: config.distanceM, boatClass: config.boatClass, strategy: config.strategy,
        iterations: config.iterations, tactics: config.tactics, compareStrategies: config.compareStrategies,
        environment: config.environment,
        boats: (config.boats || []).map(b => ({ name: b.name, isUser: !!b.isUser, kind: b.kind, archetype: b.archetype || null })),
      },
      versions: safeJson(run.versions_json, []),
      summary: safeJson(run.summary_json, null),
      error: run.error,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
      durationMs: run.duration_ms,
    },
  });
});

/** The median-race computational replay (fetched on demand — it is large). */
regattaRouter.get('/runs/:id/replay', (req, res) => {
  const run = db.prepare('SELECT replay_json FROM race_simulations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!run) throw new ApiError(404, 'Simulation not found.', 'not_found');
  res.json({ replay: safeJson(run.replay_json, null) });
});

/** What-if: bounded assumption changes, re-simulated against the baseline. */
regattaRouter.post('/whatif', rateLimit('regatta_whatif', 30, 60 * 60 * 1000), (req, res) => {
  const { runId, mods } = req.body || {};
  const run = db.prepare('SELECT * FROM race_simulations WHERE id = ? AND user_id = ?').get(String(runId || ''), req.user.id);
  if (!run) throw new ApiError(404, 'Simulation not found.', 'not_found');
  if (run.status !== 'completed') throw badRequest('Simulation has not completed.');
  const config = safeJson(run.config_json, null);
  const summary = safeJson(run.summary_json, null);
  if (!config || !summary) throw badRequest('Run record is incomplete.');
  res.json({ evaluation: evaluateWhatIf(config, summary, mods || {}) });
});
