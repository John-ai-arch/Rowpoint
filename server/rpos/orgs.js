// Organizations — enterprise groundwork (clubs, schools, national teams).
//
// Deliberately minimal by design decision: the data model, role vocabulary,
// and authorization helpers exist now so future organization features need
// no schema rewrite, while the product surface stays a compact admin tool
// (create an organization, attach coached teams, see the roster). Roles
// reuse the platform's RBAC vocabulary; every check is server-side.
import { db } from '../db.js';
import { uuid, now } from '../util.js';

export const ORGS_VERSION = 'rpos.organizations@1.0';

export const ORG_ROLES = ['admin', 'coach', 'athlete', 'researcher'];

export function createOrganization(name, createdBy) {
  const id = uuid();
  db.prepare('INSERT INTO organizations (id, name, created_by, created_at) VALUES (?,?,?,?)')
    .run(id, String(name).slice(0, 120), createdBy, now());
  db.prepare('INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?,?,?,?)')
    .run(id, createdBy, 'admin', now());
  return getOrganization(id);
}

export function getOrganization(orgId) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  if (!org) return null;
  const teams = db.prepare(
    `SELECT t.id, t.name, t.code, ot.attached_at,
            (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count
     FROM organization_teams ot JOIN teams t ON t.id = ot.team_id WHERE ot.org_id = ?`).all(orgId);
  const members = db.prepare(
    `SELECT om.user_id, om.role, om.joined_at, u.display_name
     FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = ?`).all(orgId);
  return { ...org, teams, members };
}

export function listOrganizations() {
  return db.prepare(
    `SELECT o.*,
       (SELECT COUNT(*) FROM organization_teams t WHERE t.org_id = o.id) AS team_count,
       (SELECT COUNT(*) FROM organization_members m WHERE m.org_id = o.id) AS member_count
     FROM organizations o ORDER BY o.created_at DESC`).all();
}

/** Attach a team; the team's coach joins as an org coach if not a member. */
export function attachTeam(orgId, teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return { ok: false, reason: 'Unknown team.' };
  db.prepare('INSERT INTO organization_teams (org_id, team_id, attached_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
    .run(orgId, teamId, now());
  db.prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?,?,?,?)
              ON CONFLICT DO NOTHING`)
    .run(orgId, team.coach_id, 'coach', now());
  return { ok: true };
}

export function setMemberRole(orgId, userId, role) {
  if (!ORG_ROLES.includes(role)) return { ok: false, reason: `Role must be one of ${ORG_ROLES.join(', ')}.` };
  db.prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?,?,?,?)
              ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role`)
    .run(orgId, userId, role, now());
  return { ok: true };
}

/** The caller's role in an org (null when not a member) — the building
 *  block every future org-scoped feature authorizes against. */
export function orgRole(orgId, userId) {
  return db.prepare('SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId)?.role ?? null;
}
