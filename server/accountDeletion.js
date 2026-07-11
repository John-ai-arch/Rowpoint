// Full account deletion (§10.1(v), §14) — the single implementation used by
// BOTH the self-service flow (users.js) and the admin/GDPR flow (admin.js),
// so the two can never drift apart.
//
// Most personal data is removed by ON DELETE CASCADE from the users row
// (workouts + splits + force curves, wellness, teams, groups content, social
// graph, notifications, plans, races, equipment, stroke analyses, twin state,
// runs, experiments). This module removes everything the cascades CANNOT
// reach, because the privacy policy promises deletion is complete:
//
//  - every pseudonymous research table (keyed by research_id, not user id)
//  - security logs (auth_events stores the EMAIL of every login attempt)
//  - client/ops telemetry rows (health_events)
//  - queued mail (email_outbox rows carry the address; dev mode carries codes)
//  - background jobs queued for the account
//  - display-name snapshots preserved in group leaderboard history (the rows
//    stay so other members' ranks don't shift, but the name is anonymized)
//
// Deliberately RETAINED: audit_log and computation_log. Both are append-only
// accountability records; after deletion they reference only identifiers that
// no longer resolve to any person.
import { db, inTransaction } from './db.js';
import { researchId } from './util.js';

export function deleteUserAccount(user) {
  const rid = researchId(user.id);
  inTransaction(() => {
    db.prepare('DELETE FROM research_workouts WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM research_wellness WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM research_snapshots WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM research_state_snapshots WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM research_features WHERE research_id = ?').run(rid);
    db.prepare('DELETE FROM auth_events WHERE user_id = ? OR email = ?').run(user.id, user.email);
    db.prepare('DELETE FROM health_events WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM email_outbox WHERE to_email = ?').run(user.email);
    db.prepare('DELETE FROM jobs WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE group_week_history SET display_name = ? WHERE user_id = ?').run('Former member', user.id);
    // The account row goes last: its FK cascades remove everything else.
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
}
