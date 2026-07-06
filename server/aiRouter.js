// AI coach API. Builds a full training analysis from the athlete's complete
// history (trainingAnalysis.js), generates a personalized recommendation via
// the LLM coach (coach.js, with an analysis-engine fallback), caches one
// recommendation per user per day, tracks adherence, and gives coaches
// visibility + override — the AI augments the coach's plan, never silently
// competes with it.
import { Router } from 'express';
import { db } from './db.js';
import { authRequired } from './middleware.js';
import { buildTrainingAnalysis } from './ai/trainingAnalysis.js';
import { generateRecommendation } from './ai/coach.js';
import { logger } from './log.js';
import { uuid, now, todayStr, safeJson, ApiError } from './util.js';

const log = logger('ai-router');

export const aiRouter = Router();
aiRouter.use(authRequired);

/* ---------------- today's recommendation ---------------- */

aiRouter.get('/suggestion', async (req, res) => {
  const date = todayStr();
  const refresh = req.query.refresh === '1';
  let row = db.prepare('SELECT * FROM ai_suggestions WHERE user_id = ? AND date = ?').get(req.user.id, date);
  if (row && !refresh) {
    return res.json({ suggestion: presentSuggestion(row) });
  }

  const analysis = buildTrainingAnalysis(req.user);
  const rec = await generateRecommendation(analysis);

  if (row) db.prepare('DELETE FROM ai_suggestions WHERE id = ?').run(row.id);
  const id = uuid();
  db.prepare(`INSERT INTO ai_suggestions
      (id, user_id, date, structured_json, rationale_tag, text, status, source, confidence, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, date, JSON.stringify(rec), rec.category, rec.explanation,
      'delivered', rec.source, rec.confidence, now());
  log.info(`Recommendation for user ${req.user.id}: ${rec.category} (source=${rec.source}, confidence=${rec.confidence})`);
  row = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?').get(id);
  res.json({ suggestion: presentSuggestion(row) });
});

/* ---------------- the analysis itself (training balance UI) ---------------- */

aiRouter.get('/analysis', (req, res) => {
  res.json({ analysis: buildTrainingAnalysis(req.user) });
});

function presentSuggestion(row) {
  const rec = safeJson(row.structured_json) || {};
  return {
    id: row.id,
    date: row.date,
    text: row.text,
    recommendation: rec,
    // Backwards-compatible fields (older clients / coach view / tests).
    structured: rec,
    rationaleTag: row.rationale_tag,
    status: row.status,
    source: row.source || rec.source || null,
    confidence: row.confidence || rec.confidence || null,
    followed: row.followed === 1 ? true : row.followed === 0 ? false : null,
    coachNote: rec.coachNote || row.coach_note || null,
    aiGenerated: true, // UI disclosure flag — this content is machine-generated
  };
}

/**
 * Called by the workout sync path: the day's recommendation is marked
 * followed as soon as a workout lands on its date (rest-day recommendations
 * are resolved by the analysis pass instead — absence of training = followed).
 */
export function markSuggestionFollowed(userId, startedAtS) {
  const date = todayStr(startedAtS * 1000);
  db.prepare('UPDATE ai_suggestions SET followed = 1 WHERE user_id = ? AND date = ?').run(userId, date);
}

/* ---- coach visibility & override: coaches see each rower's suggestion of
   the day and can override it with their own note, which replaces the AI
   text. ---- */

aiRouter.get('/team/:teamId/suggestions', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ? AND coach_id = ?').get(req.params.teamId, req.user.id);
  if (!team) throw new ApiError(403, 'You are not the coach of this team.', 'forbidden');
  const rows = db.prepare(
    `SELECT s.*, u.display_name FROM ai_suggestions s
     JOIN team_members m ON m.user_id = s.user_id AND m.team_id = ?
     JOIN users u ON u.id = s.user_id
     WHERE s.date = ? ORDER BY u.display_name`).all(team.id, todayStr());
  res.json({
    suggestions: rows.map(r => ({
      id: r.id, userId: r.user_id, displayName: r.display_name, text: r.text,
      rationaleTag: r.rationale_tag, status: r.status,
      structured: safeJson(r.structured_json),
    })),
  });
});

aiRouter.post('/suggestions/:id/override', (req, res) => {
  const row = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?').get(req.params.id);
  if (!row) throw new ApiError(404, 'Suggestion not found.', 'not_found');
  // The overriding user must coach a team the rower belongs to.
  const coaches = db.prepare(
    `SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id
     WHERE t.coach_id = ? AND m.user_id = ? LIMIT 1`).get(req.user.id, row.user_id);
  if (!coaches) throw new ApiError(403, 'You do not coach this rower.', 'forbidden');
  const note = String(req.body?.note || '').slice(0, 500);
  const approve = !!req.body?.approve;
  const structured = safeJson(row.structured_json) || {};
  if (!approve) structured.coachNote = note || 'Your coach has replaced today\'s AI suggestion — check with them.';
  db.prepare('UPDATE ai_suggestions SET status = ?, structured_json = ?, coach_id = ?, text = ? WHERE id = ?')
    .run(approve ? 'approved' : 'overridden', JSON.stringify(structured), req.user.id,
      approve ? row.text : (note || 'Your coach has replaced today\'s AI suggestion — check with them.'), row.id);
  res.json({ ok: true });
});
