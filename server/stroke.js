// AI Stroke Analysis API (moat #2). Stores video-analysis records (timeline
// marks + pipeline output), coach/athlete annotations, and supports historical
// comparison. The heavy analysis lives in server/stroke/pipeline.js (modular,
// replaceable). Video bytes are referenced, never stored inline.
import { Router } from 'express';
import { db } from './db.js';
import { authRequired } from './middleware.js';
import { runPipeline, pipelineModules, PIPELINE_VERSION } from './stroke/pipeline.js';
import { uuid, now, badRequest, ApiError, safeJson, clampNum } from './util.js';

export const strokeRouter = Router();
strokeRouter.use(authRequired);

function cleanMarks(m) {
  const arr = (v) => (Array.isArray(v) ? v.map(Number).filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b).slice(0, 2000) : []);
  return { catches: arr(m?.catches), finishes: arr(m?.finishes) };
}

function analyze(row) {
  const marks = safeJson(row.marks_json, {}) || {};
  const ctx = { kind: row.kind, durationS: row.duration_s, fps: row.fps, marks };
  return runPipeline(ctx);
}

function present(row, { withMarks = false } = {}) {
  return {
    id: row.id, title: row.title, kind: row.kind, orientation: row.orientation,
    recordedOn: row.recorded_on, durationS: row.duration_s, fps: row.fps, videoRef: row.video_ref,
    metrics: safeJson(row.metrics_json, {}) || {},
    observations: safeJson(row.observations_json, []) || [],
    pipelineVersion: row.pipeline_version,
    marks: withMarks ? (safeJson(row.marks_json, {}) || {}) : undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/* ---- module catalogue (transparency) — must precede /:id ---- */
strokeRouter.get('/modules', (req, res) => {
  res.json({ modules: pipelineModules(), pipelineVersion: PIPELINE_VERSION });
});

/* ---- historical comparison — must precede /:id ---- */
strokeRouter.get('/compare', (req, res) => {
  const a = db.prepare('SELECT * FROM stroke_analyses WHERE id = ? AND user_id = ?').get(req.query.a, req.user.id);
  const b = db.prepare('SELECT * FROM stroke_analyses WHERE id = ? AND user_id = ?').get(req.query.b, req.user.id);
  if (!a || !b) throw new ApiError(404, 'One or both analyses were not found.', 'not_found');
  res.json({ a: present(a), b: present(b) });
});

strokeRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM stroke_analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ analyses: rows.map(r => present(r)) });
});

strokeRouter.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.title) throw badRequest('Give the analysis a title.', 'missing_field');
  const marks = cleanMarks(b.marks);
  const id = uuid();
  const durationS = clampNum(b.durationS, 0, 3600);
  const row0 = {
    kind: b.kind === 'boat' ? 'boat' : 'erg', duration_s: durationS, fps: clampNum(b.fps, 0, 480),
    marks_json: JSON.stringify(marks),
  };
  const out = runPipeline({ kind: row0.kind, durationS, fps: row0.fps, marks });
  db.prepare(`INSERT INTO stroke_analyses
      (id, user_id, title, kind, orientation, recorded_on, duration_s, fps, video_ref,
       marks_json, metrics_json, observations_json, pipeline_version, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, String(b.title).slice(0, 120), row0.kind,
      b.orientation === 'portrait' ? 'portrait' : b.orientation === 'landscape' ? 'landscape' : null,
      b.recordedOn || null, durationS, row0.fps, b.videoRef ? String(b.videoRef).slice(0, 300) : null,
      row0.marks_json, JSON.stringify(out.metrics), JSON.stringify(out.observations), out.pipelineVersion, now(), now());
  res.status(201).json({ analysis: present(db.prepare('SELECT * FROM stroke_analyses WHERE id = ?').get(id), { withMarks: true }), pipeline: { ran: out.ran, skipped: out.skipped } });
});

strokeRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM stroke_analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) throw new ApiError(404, 'Analysis not found.', 'not_found');
  const annotations = db.prepare(
    `SELECT a.*, u.display_name FROM stroke_annotations a JOIN users u ON u.id = a.author_id
     WHERE a.analysis_id = ? ORDER BY a.t_seconds IS NULL, a.t_seconds, a.created_at`).all(row.id);
  res.json({
    analysis: present(row, { withMarks: true }),
    annotations: annotations.map(a => ({ id: a.id, author: a.display_name, role: a.author_role, tSeconds: a.t_seconds, body: a.body, createdAt: a.created_at })),
  });
});

strokeRouter.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM stroke_analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) throw new ApiError(404, 'Analysis not found.', 'not_found');
  const b = req.body || {};
  const marks = b.marks ? cleanMarks(b.marks) : (safeJson(row.marks_json, {}) || {});
  const durationS = b.durationS !== undefined ? clampNum(b.durationS, 0, 3600) : row.duration_s;
  const out = runPipeline({ kind: row.kind, durationS, fps: row.fps, marks });
  db.prepare(`UPDATE stroke_analyses SET title = COALESCE(?, title), marks_json = ?, duration_s = ?,
      metrics_json = ?, observations_json = ?, pipeline_version = ?, updated_at = ? WHERE id = ?`)
    .run(b.title ? String(b.title).slice(0, 120) : null, JSON.stringify(marks), durationS,
      JSON.stringify(out.metrics), JSON.stringify(out.observations), out.pipelineVersion, now(), row.id);
  res.json({ analysis: present(db.prepare('SELECT * FROM stroke_analyses WHERE id = ?').get(row.id), { withMarks: true }) });
});

strokeRouter.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM stroke_analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) throw new ApiError(404, 'Analysis not found.', 'not_found');
  db.prepare('DELETE FROM stroke_analyses WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

/* ---- annotations: the owner, or a coach who coaches the owner ---- */
strokeRouter.post('/:id/annotations', (req, res) => {
  const row = db.prepare('SELECT * FROM stroke_analyses WHERE id = ?').get(req.params.id);
  if (!row) throw new ApiError(404, 'Analysis not found.', 'not_found');
  let role = null;
  if (row.user_id === req.user.id) role = 'athlete';
  else {
    const coaches = db.prepare(
      `SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id
       WHERE t.coach_id = ? AND m.user_id = ? LIMIT 1`).get(req.user.id, row.user_id);
    if (coaches) role = 'coach';
  }
  if (!role) throw new ApiError(403, 'You can only annotate your own analyses or those of athletes you coach.', 'forbidden');
  const body = String(req.body?.body || '').slice(0, 1000);
  if (!body) throw badRequest('Write an annotation.', 'missing_field');
  const t = req.body?.tSeconds != null ? clampNum(req.body.tSeconds, 0, row.duration_s || 3600) : null;
  const id = uuid();
  db.prepare('INSERT INTO stroke_annotations (id, analysis_id, author_id, author_role, t_seconds, body, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, row.id, req.user.id, role, t, body, now());
  res.status(201).json({ ok: true, id, role });
});
