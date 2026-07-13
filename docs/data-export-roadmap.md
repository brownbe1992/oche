# Data Export — Design Roadmap

> Status: **Full-database admin export done (2026-07). Per-player export done
> (2026-07), shipped with a materially different design than this doc
> originally sketched — see below. Re-import is a separate, not-yet-built
> item.**
>
> **What shipped (full-database)**: **Settings → Admin & Danger Zone → Data
> Export**, a single "Export all data" button that downloads a complete JSON
> dump via `GET /api/export-all` (`requireAdmin`). It excludes the `admins`,
> `sessions`, `settings`, and `server_errors` tables entirely and strips every
> PIN/credential column from the `players` rows it does include.
>
> **What shipped (per-player, 2026-07) — a deliberate redirection from this
> doc's original design, given by explicit product direction**:
> - **Admin-only, not PIN-gated, not on the Player Profile.** The original
>   design below proposed a player-PIN-gated "Export data" button on that
>   player's own Profile page. The actual direction given was the opposite:
>   admin-only, reached from a brand new admin page (**Settings → Admin &
>   Danger Zone → Data Export → "Export a player…"** → a player picker →
>   Export), gated by the admin session the same way the full-database export
>   already is. No PIN prompt anywhere in this flow.
> - **JSON only, and not the "computed stats object" shape.** CSV is
>   deliberately out of scope for this pass — it can't cleanly carry the
>   relational structure below, and CSV was always envisioned as a separate,
>   simpler "your own stats as a spreadsheet" feature that doesn't need to
>   solve any of what follows. The JSON shape shipped is also **not** the
>   "same shape `computeStats` already returns" this doc originally sketched
>   — it's a raw relational export (real `games`/`game_players`/`turns`/
>   `darts` rows), because the actual requirement driving this rebuild was
>   "ensure H2H data is included," and H2H isn't a computed-stats concept —
>   it's derived from real game rows involving two players.
> - **A new `players.uuid` column** (v4 UUID, assigned at creation,
>   backfilled for existing rows) — the portable per-player identity that
>   makes the opponent-preservation design below possible. See
>   `REFERENCE.md`'s "`players.uuid`" subsection for the exact mechanics.
> - **Full detail**: `REFERENCE.md`'s "Settings → Data Export" section.
>   Covered by committed tests (`db.export.test.js`'s `getPlayerExport`/
>   `players.uuid` describe blocks, `server.export.test.js`'s `GET
>   /api/players/export` describe block).

## Goal

First-class export of a player's (or the whole database's) history, and of the
whole database. Reinforces a real trust statement given the project's whole
self-hosted, no-telemetry positioning: **it's your data, and you can always take it
with you.** That's a meaningful differentiator against cloud-hosted competitors,
worth calling out explicitly rather than treating this as a minor utility feature.
The per-player export specifically is also framed as **portable** — built so a
player's history (including their opponents' side of shared games) can
eventually move to a different server intact, not just downloaded once and
filed away.

## Design (per-player export, as shipped)

`db.getPlayerExport(name)` — admin-only, called from the new "Export a
player…" admin page:

- Scopes to every `games` row the named player is in (`game_players`), plus
  every `turns`/`darts` row within those games — **including the opponents'
  own turns**, since a game like "Ben beat Alaina 3-1" can't be represented
  without Alaina's side of the board. This is the direct answer to "how do
  you ensure H2H data is included": H2H was never stored anywhere as its own
  fact (`getH2HRecord()` computes it live), so preserving it means bundling
  the real rows the live computation would read.
- Opponents are represented as **minimal identity stubs** — `{ uuid, name }`
  only, nothing else about them — plus their rows within games shared with
  the exported player. An opponent's *other* games, against other people,
  are never included. Exporting Ben never becomes a backdoor to exporting
  all of Alaina's own history.
- **The `uuid`, not the internal `id`, is the identity that matters across
  servers.** `id` is an autoincrement integer — guaranteed to collide the
  moment two independently-run Oche instances each have a player with
  `id=1`, since neither knows about the other. A v4 UUID needs no
  coordination between servers to stay effectively unique, which is exactly
  why every player now gets one at creation (backfilled for existing rows).
  This is what would let a *future* import path recognize "this opponent
  stub is the same conceptual player" on a different server without relying
  on name matching (names collide constantly — two "Mikes"; `name` is only
  unique *within* one server's own roster, `players.name` `UNIQUE COLLATE
  NOCASE`).
- Also includes the player's own profile row (`uuid`, `name`, `outMode`,
  `dartWeight`, `createdAt` — no PIN columns) and their own `player_badges`
  rows (not opponents' badges).
- **Deliberately out of scope for v1**: tournament/league/daily-challenge/
  ghost-race participation. Each of those ties into a structure bigger than
  one player's own record (a bracket, a season, a streak) and reconstructing
  them correctly on import is a harder problem than the games/turns/darts
  core this pass focused on shipping correctly.
- **`schemaVersion: 1`** is included in the export, unlike the full-database
  export (which has none) — added specifically because this shape is meant
  to be read back by a future importer someday, and an importer needs a
  version to check against.

## Full-database export (already shipped, unchanged by this pass)

A complete dump of all players/games/turns/darts, positioned as the "back up
everything" or "migrate to a new server" option, distinct from the raw
SQLite-file copy already documented in the README's Data Storage section.

## Accessibility, security, and testing considerations

- **Security**: per-player export is admin-only (`requireAdmin`), the same
  unconditional gate as the full-database export, `/api/wipe-all`, and the
  Backups routes — this fully resolves the access-control question this doc
  originally raised (whether per-player export needs its own PIN gate): it
  doesn't, because it was redirected to be admin-only instead of
  player-self-service, which sidesteps the "shared household device, anyone
  could be looking at anyone's profile" concern the PIN-gating proposal was
  responding to. `getPlayerExport()` itself never returns PIN/credential
  columns, matching the full-database export's existing write-only handling.
- **Testing**: covered — `db.export.test.js` has committed tests for
  `getPlayerExport()`'s game/turn/dart/opponent scoping (including a
  same-server two-player fixture proving an opponent's *unrelated* solo game
  does NOT leak into the export), the 404 on an unknown name, the empty-roster
  case, and `players.uuid`'s format/uniqueness; `server.export.test.js`
  covers the route's 401/400/404/200 status codes and response shape.
- **Accessibility**: the new "Export a player…" screen is a standard
  `<select>` + button — no special concern beyond the standing keyboard/
  focus-order checklist in `docs/accessibility-roadmap.md`. The existing
  "← Settings" back-button pattern (shared with other admin sub-pages) is
  reused rather than inventing new navigation.

## Open questions for whoever picks this up

- **Re-import** (taking an exported JSON file back into a different Oche
  instance) is a separate, not-yet-built item — the export design above
  (uuid identity, self-contained opponent stubs) was built specifically to
  make a future import lossless and correct, but import itself was
  explicitly out of scope for this pass. The recommended shape, if/when it's
  built: look up each opponent stub by `uuid` first (never by `name` alone);
  if not found locally, auto-create a minimal stub player row from the
  exported `uuid`+`name` so the game data has a real local row to attach to
  (preserving "Ben beat Alaina" even when Alaina herself was never
  separately imported). If that stub's real account is *later* imported
  separately and its `uuid` matches, the two should ideally merge into one
  player rather than end up as two — but merging two players' full histories
  is a genuinely harder problem than creating a stub, and deserves its own
  design pass rather than being solved speculatively here.
- **CSV export** (a simpler, non-portable "your own stats as a spreadsheet"
  format, one row per turn or per game) remains a real, separate idea — not
  attempted in this pass, and doesn't need to solve anything above since
  it's explicitly not meant to preserve/round-trip H2H data the way the JSON
  export does.
- Should per-player export eventually cover tournament/league/daily-challenge/
  ghost-race participation, or stay scoped to games/turns/darts indefinitely?
