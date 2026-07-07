# Data Export — Design Roadmap

> Status: **Full-database admin export done (2026-07); per-player export
> re-opened (2026-07) with fresh product direction, not yet built.**
>
> **What shipped**: the full-database admin export only — **Settings → Admin &
> Danger Zone → Data Export**, a single "Export all data" button that downloads
> a complete JSON dump via `GET /api/export-all` (`requireAdmin`). It excludes
> the `admins`, `sessions`, `settings`, and `server_errors` tables entirely and
> strips every PIN/credential column from the `players` rows it does include —
> see `REFERENCE.md`'s §12 "Settings → Data Export" for the exact mechanics.
> Covered by committed tests (`db.export.test.js`, `server.export.test.js`).
>
> **What's re-opened**: this doc originally said any revival of per-player
> export "would need fresh product direction, not just implementation of the
> design below" — that direction has now been given (CSV export specifically
> was the requested gap; reviving it alongside the already-designed per-player
> JSON export and PIN-gating below, since they were one coherent unit of design
> work, not three separable ones). Tracked as its own item on
> `docs/open-roadmap-items.md`. The "Design" and "Security" sections below are
> the real spec to build from — they were fully designed already, just shelved
> pending this direction, not written from scratch now.

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

## Accessibility, security, and testing considerations

- **Security — this needs real access-control design, not just "no new computation
  needed."** As drafted above, per-player export is reachable from anyone browsing
  to that player's Profile page, with no gating mentioned — but this app already
  gates other player-specific actions (recording a turn as that player, in
  PIN-protected setups) behind that player's own PIN specifically because it's a
  shared household device where anyone can be looking at anyone's profile. A full
  turn-by-turn/dart-by-dart history export is a meaningfully bigger exposure than
  viewing already-aggregated stats on screen — it should require the requesting
  player's own PIN (when one is set) the same way other write/reveal actions do,
  not just be reachable because the profile page happens to be open. The
  full-database admin export is already correctly scoped (admin-only, Danger Zone).
- **Testing**: the export formatting itself is low-risk reformatting, but the
  access-control check above is exactly the kind of security-relevant logic worth a
  test once it exists, per `docs/testing-and-observability-roadmap.md`.
- **Accessibility**: the export action itself is a simple button/download — no
  special concern beyond the standing keyboard/focus-order checklist in
  `docs/accessibility-roadmap.md`.

## Open questions for whoever picks this up

- Should CSV export happen per-turn (maximum fidelity, larger files) or per-game
  (more readable, less granular) — possibly worth offering both as an option.
- Is there value in a re-import path (taking an exported JSON/CSV back into a fresh
  instance), or is this strictly one-directional for now? Re-import raises real
  complexity (id remapping, conflict handling) that may not be worth it unless
  someone actually needs to migrate between servers.
