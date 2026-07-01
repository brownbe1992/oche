# Backups & Disaster Recovery — Design Roadmap

> Status: **✅ Done** (v0.6.2). `backend/backup.js` implements exactly the design
> below — verified end-to-end against a real seeded database: backup written,
> restored from the `.db` file alone (no `-wal`/`-shm` needed), retention pruning
> tested. README's "Backups" section documents the cron schedule and restore steps.
> The Compose-profile sidecar remains an unbuilt stretch goal.
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
  version this project already requires (`engines: >=22.5.0` in `backend/package.json`;
  verified available in the installed `v22.22.2`). This is a real online-backup API
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

## Open questions for whoever picks this up

- Default retention window (7 daily backups? 30?) — cheap to make configurable rather
  than guessing once.
- Whether backups should be encrypted at rest — likely out of scope for v1 given the
  threat model of a home-LAN, self-hosted deployment, but worth a conscious decision
  rather than a silent omission.
