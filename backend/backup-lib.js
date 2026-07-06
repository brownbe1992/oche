'use strict';
/* =============================================================================
   Shared backup/restore mechanics (docs/backups-roadmap.md).

   Used by two call sites that must always agree on paths, naming, and the WAL
   gotcha: backend/backup.js (the standalone cron script) and the admin-gated
   Settings routes in backend/server.js. Centralizing it here means there's one
   place that knows how to take a consistent snapshot and one place that knows
   how to safely stage a restore, rather than two copies drifting apart.
   ============================================================================= */
const { DatabaseSync, backup } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DARTS_DB || path.join(__dirname, '..', 'data', 'darts.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const DEFAULT_RETENTION_DAYS = 7;

// Every backup this module writes matches this exact pattern (see timestamp()
// below) — used to validate any filename before it's ever passed to fs
// operations, so a crafted `name` query param can't traverse outside BACKUP_DIR.
const BACKUP_NAME_RE = /^darts-[0-9TZ.-]+\.db$/;
function isValidBackupName(name) {
  return typeof name === 'string' && BACKUP_NAME_RE.test(name);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-'); // filesystem-safe
}

// Reads backup_retention_days from the settings table using an already-open
// connection (the caller already has one open for the backup() call below), so
// the cron script and the Settings-UI retention control always agree on one
// value without backup.js needing to pull in the rest of db.js. Falls back to
// the BACKUP_RETENTION_DAYS env var, then the hardcoded default, so upgrading
// this feature doesn't change existing cron behavior for anyone who never
// touches the new Settings control.
function resolveRetentionDays(conn) {
  try {
    const row = conn.prepare("SELECT value FROM settings WHERE key = 'backup_retention_days'").get();
    if (row && Number(row.value) > 0) return Number(row.value);
  } catch (e) { /* settings table may not exist yet on a very old snapshot being read this way */ }
  const envVal = Number(process.env.BACKUP_RETENTION_DAYS);
  return envVal > 0 ? envVal : DEFAULT_RETENTION_DAYS;
}

// Writes one timestamped, consistent snapshot (via node:sqlite's backup() API —
// safe regardless of WAL state, unlike a plain file copy) and prunes anything
// older than the retention window. Returns what happened so callers (the cron
// script's console.log, the on-demand Settings route) can report it.
async function createBackup() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`No database found at ${DB_PATH} — nothing to back up.`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `darts-${timestamp()}.db`;
  const dest = path.join(BACKUP_DIR, name);
  const source = new DatabaseSync(DB_PATH, { readOnly: true });
  let retentionDays;
  try {
    await backup(source, dest);
    retentionDays = resolveRetentionDays(source);
  } finally {
    source.close();
  }
  const { pruned } = pruneOldBackups(retentionDays);
  return { name, path: dest, retentionDays, pruned };
}

function pruneOldBackups(retentionDays) {
  const days = Number(retentionDays) > 0 ? Number(retentionDays) : DEFAULT_RETENTION_DAYS;
  if (!fs.existsSync(BACKUP_DIR)) return { pruned: [] };
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const pruned = [];
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!isValidBackupName(name)) continue;
    const full = path.join(BACKUP_DIR, name);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      pruned.push(name);
    }
  }
  return { pruned };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(isValidBackupName)
    .map(name => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// Resolves a backup name to its on-disk path, or throws if the name is invalid
// or doesn't exist — the one gate every route (download/delete/restore) must
// pass through before touching the filesystem.
function backupPath(name) {
  if (!isValidBackupName(name)) throw new Error('Invalid backup filename');
  const full = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(full)) throw new Error('Backup not found');
  return full;
}

function deleteBackup(name) {
  fs.unlinkSync(backupPath(name));
  return { ok: true };
}

// Validates that a file is actually a legitimate, non-corrupt SQLite database
// before it's ever treated as a restore candidate: the 16-byte file-header magic
// string, then a real read-only open + PRAGMA integrity_check. This has to run
// on both restore paths (an existing backup on disk, and an uploaded file) —
// pointing the live app at an unvalidated file is a real risk, not a nicety,
// since the very next step is replacing the live database with it.
const SQLITE_MAGIC = 'SQLite format 3\0';
function validateSqliteFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  let header;
  try {
    header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString('binary') !== SQLITE_MAGIC) {
    throw new Error('Not a valid SQLite database file');
  }
  let testDb;
  try {
    testDb = new DatabaseSync(filePath, { readOnly: true });
    const result = testDb.prepare('PRAGMA integrity_check').get();
    if (!result || result.integrity_check !== 'ok') {
      throw new Error('Database failed integrity check');
    }
  } catch (e) {
    throw new Error('Database failed integrity check: ' + e.message);
  } finally {
    if (testDb) testDb.close();
  }
}

// Stages `sourcePath` as the new live database file. This does NOT make the
// already-running server process pick it up — on Linux, an open file handle
// keeps reading/writing the old inode until the process reopens the file, so a
// restart is still required after this returns (docs/backups-roadmap.md's v2
// design deliberately hands the admin an explicit "restart now" instruction
// rather than the server triggering its own process exit mid-request).
function stageRestore(sourcePath) {
  for (const suffix of ['-wal', '-shm']) {
    const stale = DB_PATH + suffix;
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }
  fs.copyFileSync(sourcePath, DB_PATH);
}

module.exports = {
  DB_PATH, BACKUP_DIR, DEFAULT_RETENTION_DAYS,
  isValidBackupName, timestamp, resolveRetentionDays,
  createBackup, pruneOldBackups, listBackups, backupPath, deleteBackup,
  validateSqliteFile, stageRestore,
};
