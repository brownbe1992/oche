'use strict';
/* =============================================================================
   Stand-alone backup script for the darts SQLite database.

   Run manually (`node backend/backup.js`) or on a schedule via host cron — see
   the README's "Backups" section for the recommended crontab entry. Writes one
   timestamped, consistent snapshot per run, then prunes anything older than the
   retention window.

   The actual backup()/prune mechanics live in backup-lib.js, shared with the
   admin-gated Settings routes in server.js (docs/archive/backups-roadmap.md v2) so both
   call sites always agree on paths, naming, and the WAL gotcha.

   Env vars (all optional):
     DARTS_DB              path to the live database (same var the server uses)
     BACKUP_DIR            where snapshots are written (default: a `backups`
                            folder next to the database file)
     BACKUP_RETENTION_DAYS how many days of daily backups to keep (default: 7) —
                            overridden by the Settings UI's retention control
                            (settings.backup_retention_days) once one is set.
   ============================================================================= */
const lib = require('./backup-lib.js');

lib.createBackup().then(({ path: dest, pruned }) => {
  console.log(`Backup written: ${dest}`);
  for (const name of pruned) console.log(`Pruned old backup: ${name}`);
}).catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
