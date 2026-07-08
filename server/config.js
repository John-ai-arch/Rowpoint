// RowPoint server configuration.
// Values come from environment variables where sensible; secrets are
// generated once and persisted to the data directory so tokens survive restarts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.ROWPOINT_DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function persistedSecret(name) {
  const file = path.join(DATA_DIR, `.${name}`);
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v.length >= 32) return v;
  } catch { /* fall through and create */ }
  const v = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, v, { mode: 0o600 });
  return v;
}

export const config = {
  dataDir: DATA_DIR,
  dbFile: process.env.ROWPOINT_DB || path.join(DATA_DIR, 'rowpoint.db'),
  port: Number(process.env.PORT || 3000),

  // §3.1 — Admin access is tied, server-side, to exactly this email address.
  // This is intentionally a hard-coded constant, NOT an environment variable
  // and NOT a database flag, per the specification.
  ADMIN_EMAIL: 'lambert.venema2027@gmail.com',

  // Signing secret for session tokens (HMAC-SHA256).
  tokenSecret: process.env.ROWPOINT_TOKEN_SECRET || persistedSecret('token_secret'),
  // Separate secret for deriving pseudonymous research IDs (§5.2), so a leak
  // of one secret never links the research corpus to account IDs.
  researchSecret: process.env.ROWPOINT_RESEARCH_SECRET || persistedSecret('research_secret'),
  // Dedicated key for encrypting database backups at rest (AES-256-GCM). Set it
  // as an env var if backups are shipped off-box, so a stolen disk snapshot
  // can't decrypt them with a secret that lived on the same disk.
  backupSecret: process.env.ROWPOINT_BACKUP_KEY || persistedSecret('backup_key'),

  // Automated encrypted backups (server/backup.js).
  backupDir: process.env.ROWPOINT_BACKUP_DIR || path.join(DATA_DIR, 'backups'),
  backupIntervalHours: Number(process.env.ROWPOINT_BACKUP_INTERVAL_HOURS || 24),
  backupRetention: Number(process.env.ROWPOINT_BACKUP_RETENTION || 14),
  backupsEnabled: process.env.ROWPOINT_BACKUPS_ENABLED !== '0',

  tokenTtlSeconds: 60 * 60 * 24 * 30, // 30 days
  verificationTtlSeconds: 60 * 60 * 24, // 24 h to use an email code

  // OAuth — real provider verification activates only when configured.
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  appleClientId: process.env.APPLE_CLIENT_ID || null,

  // Email delivery (Resend). When unset, the app runs in "dev mail" mode:
  // verification codes are surfaced directly in the UI instead of emailed.
  resendApiKey: process.env.RESEND_API_KEY || null,
  mailFrom: process.env.MAIL_FROM || 'RowPoint <onboarding@resend.dev>',

  // AI coach (server/ai/coach.js). When no key is set, the analysis-engine
  // fallback generates recommendations from the same training analysis and no
  // network call is ever made.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',

  // Dev conveniences (exposing the email outbox for testing) are enabled
  // unless explicitly running in production.
  devMode: process.env.NODE_ENV !== 'production',

  // Research opt-out retention policy (§5.1): we RETAIN past contributions on
  // opt-out (they were contributed under valid consent at write time) but stop
  // all future contribution immediately. Full account deletion (§14) removes
  // the user's research rows as well. This policy is stated verbatim in the UI.
  researchRetainPastOnOptOut: true,
};
