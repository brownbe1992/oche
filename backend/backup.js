'use strict';
/* =============================================================================
   Stand-alone backup script for the darts SQLite database.

   Run manually (`node backend/backup.js`) or on a schedule via host cron — see
   the README's "Backups" section for the recommended crontab entry. Writes one
   timestamped, consistent snapshot per run, then prunes anything older than the
   retention window.

   Uses node:sqlite's built-in backup() API rather than a plain file copy: the
   database runs in WAL mode (see backend/db.js), so recently-committed data can
   still be sitting in a separate `-wal` file. backup() takes a real point-in-time
   snapshot regardless of WAL state, which a naive `cp darts.db ...` cannot
   guarantee. No new dependencies — same zero-dependency approach as the rest of
   the app.

   Env vars (all optional):
     DARTS_DB              path to the live database (same var the server uses)
     BACKUP_DIR            where snapshots are written (default: a `backups`
                            folder next to the database file)
     BACKUP_RETENTION_DAYS how many days of daily backups to keep (default: 7)
   ============================================================================= */
const { DatabaseSync, backup } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DARTS_DB || path.join(__dirname, '..', 'data', 'darts.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) > 0
  ? Number(process.env.BACKUP_RETENTION_DAYS) : 7;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-'); // filesystem-safe
}

function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('darts-') && f.endsWith('.db'));
  for (const name of entries) {
    const full = path.join(BACKUP_DIR, name);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      console.log(`Pruned old backup: ${name}`);
    }
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database found at ${DB_PATH} — nothing to back up.`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dest = path.join(BACKUP_DIR, `darts-${timestamp()}.db`);
  const source = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    await backup(source, dest);
  } finally {
    source.close();
  }
  console.log(`Backup written: ${dest}`);

  pruneOldBackups();
}

main().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
