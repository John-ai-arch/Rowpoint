// §12 — Daily wellness check-in: one row per user per calendar day (same-day
// submissions edit the existing entry), trend endpoint, and contribution into
// the SAME research pipeline/toggle as workouts (§12.3 — no second consent).
import { Router } from 'express';
import { db } from './db.js';
import { authRequired } from './middleware.js';
import { uuid, now, todayStr, clampInt, clampNum, badRequest } from './util.js';
import { contributeWellness } from './research.js';

export const wellnessRouter = Router();
wellnessRouter.use(authRequired);

wellnessRouter.post('/checkin', (req, res) => {
  const b = req.body || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : todayStr();
  const sleepHours = clampNum(b.sleepHours, 0, 24);
  const sleepQuality = clampInt(b.sleepQuality, 1, 5);
  const soreness = clampInt(b.sorenessLevel, 1, 5);
  const stress = clampInt(b.stressLevel, 1, 5);
  if (sleepHours === null && sleepQuality === null && soreness === null && stress === null) {
    throw badRequest('Fill in at least one field.');
  }
  const existing = db.prepare('SELECT * FROM wellness_checkins WHERE user_id = ? AND date = ?').get(req.user.id, date);
  if (existing) {
    db.prepare(`UPDATE wellness_checkins SET sleep_hours=?, sleep_quality=?, soreness_level=?, stress_level=?, resting_notes=?, updated_at=? WHERE id=?`)
      .run(sleepHours, sleepQuality, soreness, stress, String(b.restingNotes || '').slice(0, 500) || null, now(), existing.id);
  } else {
    db.prepare(`INSERT INTO wellness_checkins (id, user_id, date, sleep_hours, sleep_quality, soreness_level, stress_level, resting_notes, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), req.user.id, date, sleepHours, sleepQuality, soreness, stress,
        String(b.restingNotes || '').slice(0, 500) || null, now(), now());
  }
  const row = db.prepare('SELECT * FROM wellness_checkins WHERE user_id = ? AND date = ?').get(req.user.id, date);
  const research = contributeWellness(req.user, row); // write-time opt-in check (§5.2)
  res.json({ checkin: row, edited: !!existing, research: { contributed: research.contributed } });
});

wellnessRouter.get('/today', (req, res) => {
  const row = db.prepare('SELECT * FROM wellness_checkins WHERE user_id = ? AND date = ?').get(req.user.id, todayStr());
  res.json({ checkin: row || null });
});

// 7/30-day trend view (§12.2).
wellnessRouter.get('/trend', (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 120);
  const since = todayStr(Date.now() - days * 86400000);
  const rows = db.prepare('SELECT date, sleep_hours, sleep_quality, soreness_level, stress_level, resting_notes FROM wellness_checkins WHERE user_id = ? AND date >= ? ORDER BY date')
    .all(req.user.id, since);
  res.json({ checkins: rows });
});
