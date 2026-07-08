// Automated encrypted database backups.
//
// Strategy: SQLite's `VACUUM INTO` produces a transactionally-consistent copy
// of the live database with no downtime and no half-written pages (safer than
// copying the file while WAL is active). That snapshot is then encrypted at
// rest with AES-256-GCM under a dedicated backup key, so a stolen backup file
// (or off-box copy) is useless without the key. Each backup carries a manifest
// with the plaintext SHA-256 and byte size for fast listing + integrity checks
// without decrypting; GCM's auth tag is the cryptographic integrity guarantee.
//
// Scheduling is a simple in-process timer (nightly by default). Old backups are
// pruned to a retention count. Failures are logged AND recorded to health_events
// so they surface on the admin dashboard as an operational alert.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './log.js';
import { uuid, now } from './util.js';

const log = logger('backup');
const MAGIC = Buffer.from('RPBK');           // file marker
const FORMAT_VERSION = 1;
const key = crypto.createHash('sha256').update(config.backupSecret).digest(); // 32 bytes

function ensureDir() { fs.mkdirSync(config.backupDir, { recursive: true }); }

function recordHealth(kind, detail) {
  try {
    db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,?,?)')
      .run(uuid(), kind, String(detail).slice(0, 500), null, now());
  } catch { /* telemetry must never break the backup path */ }
}

/**
 * Create one encrypted backup. Returns its manifest. Synchronous SQLite work is
 * fine here — VACUUM INTO is a single statement and backups run off the request
 * path.
 */
export function createBackup(reason = 'scheduled') {
  ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(config.backupDir, `.tmp-${stamp}.db`);
  const outFile = path.join(config.backupDir, `rowpoint-${stamp}.db.enc`);
  const manifestFile = `${outFile}.json`;
  try {
    // 1. Consistent snapshot of the live DB.
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const plain = fs.readFileSync(tmp);
    const sha256 = crypto.createHash('sha256').update(plain).digest('hex');

    // 2. Encrypt (AES-256-GCM) → [MAGIC|ver|iv(12)|tag(16)|ciphertext].
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(outFile, Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), iv, tag, ciphertext]), { mode: 0o600 });

    const manifest = {
      file: path.basename(outFile),
      createdAt: now(),
      reason,
      plaintextBytes: plain.length,
      encryptedBytes: fs.statSync(outFile).size,
      sha256,
      schemaVersion: Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0),
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.rmSync(tmp, { force: true });

    db.prepare("INSERT INTO meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(now()));
    prune();
    log.info(`Backup written: ${manifest.file} (${manifest.plaintextBytes} B, ${manifest.users} users, reason=${reason})`);
    return manifest;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    log.error(`Backup FAILED (${reason}): ${e.message}`);
    recordHealth('backup_failure', `${reason}: ${e.message}`);
    throw e;
  }
}

/** List existing backups (newest first) from their manifests. */
export function listBackups() {
  ensureDir();
  return fs.readdirSync(config.backupDir)
    .filter(f => f.endsWith('.db.enc.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(config.backupDir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Decrypt a backup into memory and verify integrity (GCM tag + SHA-256). */
export function decryptBackup(file) {
  const full = path.join(config.backupDir, path.basename(file));
  const buf = fs.readFileSync(full);
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a RowPoint backup file.');
  const version = buf[4];
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported backup format v${version}.`);
  const iv = buf.subarray(5, 17);
  const tag = buf.subarray(17, 33);
  const ciphertext = buf.subarray(33);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws on tamper
  return plain;
}

/** Verify a backup without restoring it: GCM auth + manifest SHA-256 match. */
export function verifyBackup(file) {
  const plain = decryptBackup(file);
  const sha256 = crypto.createHash('sha256').update(plain).digest('hex');
  let manifestSha = null;
  try { manifestSha = JSON.parse(fs.readFileSync(path.join(config.backupDir, `${path.basename(file)}.json`), 'utf8')).sha256; } catch { /* no manifest */ }
  const ok = !manifestSha || manifestSha === sha256;
  return { ok, sha256, manifestSha, bytes: plain.length };
}

/**
 * Restore a backup to a destination path (default: a sibling .restored file so
 * a running server is never overwritten out from under itself). The operator
 * then swaps it in while the server is stopped. Returns the destination path.
 */
export function restoreBackup(file, destPath) {
  const plain = decryptBackup(file);
  const dest = destPath || `${config.dbFile}.restored`;
  fs.writeFileSync(dest, plain, { mode: 0o600 });
  log.info(`Restored ${path.basename(file)} → ${dest} (${plain.length} B). Stop the server and move it into place to activate.`);
  return dest;
}

function prune() {
  const backups = listBackups();
  const excess = backups.slice(config.backupRetention);
  for (const b of excess) {
    fs.rmSync(path.join(config.backupDir, b.file), { force: true });
    fs.rmSync(path.join(config.backupDir, `${b.file}.json`), { force: true });
    log.info(`Pruned old backup ${b.file}`);
  }
}

let timer = null;
/**
 * Start the nightly backup timer. Runs one shortly after boot if the last
 * backup is older than the interval (or there is none), then on a fixed
 * cadence. Never throws into the caller — a backup failure is logged/alerted,
 * not fatal to the server.
 */
export function scheduleBackups() {
  if (!config.backupsEnabled) { log.info('Automated backups disabled (ROWPOINT_BACKUPS_ENABLED=0).'); return; }
  const intervalMs = Math.max(1, config.backupIntervalHours) * 3600 * 1000;
  const lastAt = Number(db.prepare("SELECT value FROM meta WHERE key = 'last_backup_at'").get()?.value || 0);
  const dueNow = !lastAt || (now() - lastAt) * 1000 >= intervalMs;
  const kick = () => { try { createBackup('scheduled'); } catch { /* already logged + alerted */ } };
  // Delay the first run a little so it never competes with boot work.
  setTimeout(kick, dueNow ? 10_000 : Math.max(10_000, intervalMs - (now() - lastAt) * 1000));
  timer = setInterval(kick, intervalMs);
  timer.unref?.();
  log.info(`Automated backups scheduled every ${config.backupIntervalHours}h (retention ${config.backupRetention}, dir ${config.backupDir}).`);
}

export function stopBackups() { if (timer) { clearInterval(timer); timer = null; } }

// CLI: `node server/backup.js [create|list|verify <file>|restore <file> [dest]]`
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const [cmd, arg, arg2] = process.argv.slice(2);
  try {
    if (cmd === 'create' || !cmd) console.log(JSON.stringify(createBackup('manual-cli'), null, 2));
    else if (cmd === 'list') console.log(JSON.stringify(listBackups(), null, 2));
    else if (cmd === 'verify') console.log(JSON.stringify(verifyBackup(arg), null, 2));
    else if (cmd === 'restore') console.log(`Restored to: ${restoreBackup(arg, arg2)}`);
    else { console.error(`Unknown command: ${cmd}`); process.exit(1); }
  } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
}
