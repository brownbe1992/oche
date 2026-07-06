# Backups & Disaster Recovery — Design Roadmap

> Status: **v1 ✅ Done** (v0.6.2). `backend/backup.js` implements exactly the design
> below — verified end-to-end against a real seeded database: backup written,
> restored from the `.db` file alone (no `-wal`/`-shm` needed), retention pruning
> tested. README's "Backups" section documents the cron schedule and restore steps.
> The Compose-profile sidecar remains an unbuilt stretch goal. **v2 (managing backups
> from Settings — download/retention/restore/upload) is designed below, not started.**
>
> **Size: Low complexity.** A self-contained script plus documentation — no schema or
> API changes to the running app, no new dependencies. **Usefulness: very high** — this
> protects genuinely irreplaceable personal data (years of games/stats live in one
> file), which is exactly the kind of thing that's easy to overlook until it's too
> late.

## Goal

Give every self-hoster a real, tested way to recover their player/game/stat history if
the database is ever lost or corrupted — not just a one-line README suggestion that's
never been verified to actually work.

## The evidence

- Every player, game, turn, and dart lives in a single SQLite file
  (`darts_data/darts.db`, per `docker-compose.yml`'s volume mount).
- The current README guidance is just "copy the `darts_data` folder" — no automation,
  no retention policy, and (as far as this project's history shows) no one has ever
  actually exercised a restore from that copy.
- **A real gotcha, confirmed in code**: `backend/db.js` runs
  `PRAGMA journal_mode = WAL;` on startup. In WAL mode, recently-committed data can
  live in a separate `-wal` file rather than the main `.db` file. A naive `cp` of just
  `darts.db` while the app is running can silently produce an **inconsistent or
  incomplete** snapshot — this isn't a hypothetical risk, it's how WAL mode works.
  Any backup approach needs to account for this rather than assume a plain file copy
  is safe.

## What's already in place (baseline)

- The Docker volume mount (`./darts_data:/data`) already means data survives container
  removal/recreation — a reasonable starting point, just not protection against disk
  failure, accidental deletion, or a corrupted database file.

## Design

- **Use `node:sqlite`'s built-in `backup()` function** — confirmed present in the Node
  version this project already requires (`engines: >=22.13.0` in `backend/package.json`
  — `node:sqlite` exists as of 22.5.0 but needs the `--experimental-sqlite` flag until
  22.13.0, a CI bug found and fixed 2026-07; verified available in the installed
  `v22.22.2`). This is a real online-backup API
  (mirrors SQLite's own backup mechanism) that produces a consistent snapshot
  regardless of WAL state, with **zero new dependencies** — keeping the project's
  "dependency-free" identity intact.
- A small standalone script (e.g. `backend/backup.js`) that calls `backup()` to write a
  timestamped copy into a `backups/` folder alongside the data directory.
- **Retention**: keep the last N daily backups (simple filename-date-based pruning,
  delete anything older than N days) — no need for anything more elaborate for a
  personal or small-household deployment.
- **Scheduling**: document running the script via host-level cron as the default
  approach (zero new containers, easiest to explain in the README). An automated
  in-container scheduler is a reasonable stretch goal, but should be an **opt-in
  Docker Compose profile** if built, matching the existing convention for optional
  services (`docs/existing-app-prep-roadmap.md` item 9) rather than something that
  runs by default for everyone.
- **Restore procedure must be written down and actually tested** — stop the container,
  replace `darts.db` (and remove any stale `-wal`/`-shm` files) with the backup,
  restart, verify the app reads the restored data correctly. This is the step most
  likely to be skipped if not called out explicitly; a backup that's never been
  restored from isn't a verified backup.

## Suggested build order

1. `backend/backup.js` — a script using `node:sqlite`'s `backup()` API to write one
   timestamped snapshot.
2. Retention/pruning logic (delete backups older than N days, configurable).
3. README section: how to schedule via host cron, plus the tested restore procedure.
4. **(Stretch)** an opt-in Compose profile for admins who'd rather not touch host cron.

## Open questions for whoever picks this up (v1)

- Default retention window (7 daily backups? 30?) — cheap to make configurable rather
  than guessing once.
- Whether backups should be encrypted at rest — likely out of scope for v1 given the
  threat model of a home-LAN, self-hosted deployment, but worth a conscious decision
  rather than a silent omission.

---

## v2: Managing backups from Settings (not started)

> **Size: Medium overall.** Download and retention management are Low/Low-Medium —
> straightforward admin-gated routes on top of what already exists. Restore and
> upload-to-restore are Medium/Medium-High — not because the code is exotic, but
> because they're two genuinely new problem areas for this codebase (swapping out a
> live, open database file; accepting an uploaded file at all). **Usefulness: high**
> for anyone who'd rather manage this from the app than SSH into the server — inspired
> by the equivalent feature in Dispatcharr, which the project owner already relies on
> and finds convenient.

### Goal

Let an admin download existing backups, manage retention, restore from a backup
already on the server, and upload/restore from an older backup file — all from
**Settings → Backups** — instead of needing shell access to the host.

### Design, piece by piece

**Download a backup** — list `darts_data/backups/` (name, size, timestamp) and stream
a chosen file back over an admin-gated route, the same `requireAdmin` pattern already
used everywhere else in `server.js`. No new problems to solve here.

**Manage retention** — today `BACKUP_RETENTION_DAYS` is an env var read only by the
standalone `backend/backup.js` script. For this to be manageable from Settings, it
needs to move into the `settings` table (same pattern as `pin_lockout_threshold` /
`admin_lockout_threshold`) so the UI and the cron-invoked script agree on one value,
plus a way to delete an individual backup on demand.

**Restore from an existing backup — the piece that actually needs careful design.**
The server holds the live `.db` file open in a running Node process (`db.js`'s module-
level `DatabaseSync`). Overwriting that file path on disk does **not** affect an
already-open file handle — on Linux, the running process keeps reading/writing the
*old* inode until it reopens the file. So "restore" can't be "copy the backup over
`darts.db`, done" — it has to:
1. Stage the chosen backup as the new `darts.db` (with any stale `-wal`/`-shm` files
   cleared, same gotcha as the backup side).
2. Force the app to actually reopen the file — either by exiting the process and
   relying on `restart: unless-stopped` in `docker-compose.yml` to relaunch it clean,
   or with a clear "restart now" instruction if an automatic self-restart feels too
   risky to trigger from inside a request handler.
3. Treat this as at least as destructive as the existing "Wipe all player & game data"
   flow (`askWipeAllData()` in `frontend/index.html`) — it's a full, irreversible
   replacement of the live database — and give it comparable confirmation weight, or
   stronger (see Open questions).

**Upload an old backup to restore from** — adds a capability the app has never needed
before: an actual file upload. Every existing endpoint goes through `readJson()`,
which buffers the whole body in memory and caps it at 1MB (see
`docs/testing-and-observability-roadmap.md`'s Part A) — real backup files will exceed
that as data grows over years, so this needs its own streaming-to-disk upload path,
not a reuse of `readJson()`. It also must **validate the uploaded file is actually a
legitimate SQLite database** (check the file header magic bytes, then open it
read-only and run `PRAGMA integrity_check`) before ever treating it as a restore
candidate — accepting an unvalidated file and pointing the app at it is a real risk,
not just a nicety, since the next step is replacing the live database with it.

### Suggested build order

1. Move `BACKUP_RETENTION_DAYS` into the `settings` table; add list/download/delete
   routes.
2. Settings UI: a "Backups" section listing existing snapshots with download/delete,
   plus the retention control.
3. Restore-from-existing-backup, including the stage-then-restart sequencing above,
   with confirmation UX at least as strong as the wipe-all-data flow.
4. Upload-to-restore: streaming upload endpoint + SQLite file validation, then reuses
   the same restore/restart flow from step 3.

### Open questions for whoever picks this up (v2)

- Should restoring require re-entering the admin password (not just an already-active
  session), given it's a stronger, less-reversible action than anything else currently
  gated behind a simple confirm dialog?
- Should the app attempt an automatic self-restart after staging a restore (cleaner
  UX, but code triggering its own process exit mid-request is worth being deliberate
  about), or always hand the admin an explicit "restart the container now" instruction?
- Whether upload size needs an explicit cap distinct from the 1MB JSON-body limit, and
  what a sane one is given realistic multi-year database sizes.
