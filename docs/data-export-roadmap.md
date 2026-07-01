# Data Export — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

First-class export of a player's (or the whole database's) history as CSV/JSON.
Cheap to build — it's largely reformatting data already returned by existing
endpoints — and it reinforces a real trust statement given the project's whole
self-hosted, no-telemetry positioning: **it's your data, and you can always take it
with you.** That's a meaningful differentiator against cloud-hosted competitors,
worth calling out explicitly rather than treating this as a minor utility feature.

## Design

- **Per-player export** — from the Player Profile page, a "Export data" action
  producing either:
  - **CSV** — one row per turn (or per game, as a coarser option), suitable for
    opening directly in a spreadsheet for a player who wants to do their own
    analysis. Straightforward given `turns`/`darts` are already flat, well-shaped
    tables.
  - **JSON** — the full computed stats object (same shape `computeStats`/
    `getPlayerStatBubbles`/etc. already return), useful for anyone wanting to feed it
    into their own tooling.
- **Full-database export** (admin-only, alongside the existing Danger Zone section) —
  a complete dump of all players/games/turns/darts, positioned as the "back up
  everything" or "migrate to a new server" option, distinct from the raw SQLite-file
  copy already documented in the README's Data Storage section — useful for someone
  who wants a portable, human-readable export rather than a binary database file.
- **No new backend computation needed for most of this** — it's primarily new
  endpoints that reformat existing query results as a downloadable file
  (`Content-Disposition: attachment`) rather than JSON returned to the page.

## Open questions for whoever picks this up

- Should CSV export happen per-turn (maximum fidelity, larger files) or per-game
  (more readable, less granular) — possibly worth offering both as an option.
- Is there value in a re-import path (taking an exported JSON/CSV back into a fresh
  instance), or is this strictly one-directional for now? Re-import raises real
  complexity (id remapping, conflict handling) that may not be worth it unless
  someone actually needs to migrate between servers.
