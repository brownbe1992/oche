# Data Export — Design Roadmap

> Status: **Every item done, doc archived (2026-07). Full-database admin
> export done (2026-07). Per-player export AND import both done (2026-07),
> shipped with a materially different design than this doc originally
> sketched — see below. CSV export done (2026-07) — the last open item.**
>
> **What shipped (CSV export, 2026-07)**: `db.getPlayerCsvExport(name, kind)`
> / `GET /api/players/export-csv?name=...&kind=games|turns` (`requireAdmin`),
> reachable from the same `#screen-player-export` admin page as the JSON
> export ("Spreadsheet (CSV) export" — "Games CSV" / "Turns CSV" buttons
> under the same player picker). Exactly the "simpler, non-portable 'your
> own stats as a spreadsheet'" idea this doc always envisioned — see
> "Design (CSV export, as shipped)" below.
>
> **What shipped (full-database)**: **Settings → Admin & Danger Zone → Data
> Export**, a single "Export all data" button that downloads a complete JSON
> dump via `GET /api/export-all` (`requireAdmin`). It excludes the `admins`,
> `sessions`, `settings`, and `server_errors` tables entirely and strips every
> PIN/credential column from the `players` rows it does include.
>
> **What shipped (per-player export, 2026-07) — a deliberate redirection from
> this doc's original design, given by explicit product direction**:
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
>
> **What shipped (per-player import, 2026-07) — this doc's own recommended
> design, built essentially as sketched**: `db.importPlayerExport(payload)` /
> `POST /api/players/import`, reachable from the same `#screen-player-export`
> admin page as export, below a file-upload control. Resolves the main
> player and every opponent stub **by `uuid` first**, uniquifying the name on
> a collision with an unrelated local player rather than merging two
> different people's histories; inserts games/turns/darts directly
> (bypassing `createGame()`/`addTurn()`/`completeGame()`'s lifecycle hooks,
> since this is a historical restore, not a live game); and skips any game
> that already exists locally by fingerprint (created_at + format +
> participant set), which is what makes **re-importing the same file twice a
> safe no-op**, and what lets **an opponent stub transparently upgrade to a
> full account** when that opponent's own export is imported later — see
> "Design (import, as shipped)" below. Verified end-to-end in a real browser
> across two independently-run server instances (export from one, import
> into the other, confirmed the imported player's H2H record reconstructs
> correctly via the app's normal live computation on the target server).
>
> **Full detail**: `REFERENCE.md`'s "Settings → Data Export" section.
> Covered by committed tests (`db.export.test.js`'s `getPlayerExport`/
> `players.uuid`/`importPlayerExport` describe blocks, `server.export.test.js`'s
> `GET /api/players/export`/`POST /api/players/import` describe blocks).

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

## Design (import, as shipped)

`db.importPlayerExport(payload)` — admin-only, called from a file input +
"Import" button on the same `#screen-player-export` page as export, below
the export controls. `payload` is exactly the JSON `getPlayerExport()`
produces (a `.json` file downloaded from this or another Oche server).

- **Rejects immediately** if `payload.schemaVersion !== 1` or the shape is
  otherwise malformed (missing `player`/`games`/`gamePlayers`/`turns`/
  `darts`/`opponents` arrays) — `400`, checked client-side too (the file is
  read and `JSON.parse`d in the browser before the request is even sent, so
  a non-JSON file never reaches the network).
- **Player resolution happens first, entirely, before any game/turn/dart is
  touched** — the main player and every opponent stub are each resolved by
  looking up `players.uuid` for a match:
  - **Match found** → reuse that existing local row. This is the same
    lookup regardless of whether the local row is a "real," independently-
    created local player or a stub created by an *earlier* import — which
    is what makes the "opponent stub later gets upgraded" scenario work for
    free, with no separate merge step: if Alaina only ever existed locally
    as a stub (created while importing Ben's export), and Alaina's *own*
    full export is imported later, her `uuid` matches that stub row, so her
    additional games attach to the *same* row rather than creating a second
    "Alaina."
  - **No match** → create a new player row from the exported `uuid`+`name`.
    If that `name` collides with an unrelated local player (a different
    `uuid` — a genuine coincidence, not the same person), the imported name
    is uniquified (`"Name (2)"`, incrementing) rather than silently reusing
    the unrelated player's row — merging two different people's histories
    onto one row would be actively harmful, worse than a slightly-odd
    display name the admin can rename by hand afterward. The import result
    reports whether each player was newly created and/or renamed, so this
    is visible, not silent.
- **Games/turns/darts are inserted directly via raw SQL**, deliberately
  bypassing `createGame()`/`addTurn()`/`completeGame()` and their lifecycle
  hooks (league auto-tagging, badge-award checks, HA webhooks) — this is a
  historical data restore, not a live game being played. The export's own
  `playerBadges` array already carries exactly which badges the source
  earned, imported directly rather than re-derived. `league_id` is always
  imported as `NULL` (leagues were never part of a per-player export to
  begin with).
- **Duplicate-import guard, computed at import time rather than tracked**:
  before inserting each game, checks for an existing local game with the
  same `created_at`/`category`/`game_type`/`legs_per_set`/`sets_per_game`
  and the exact same (already-remapped) participant id set — if one exists,
  that game (and its turns/darts) are skipped, not duplicated. This is what
  makes re-importing the same file twice a safe no-op (verified end-to-end:
  importing the same export a second time reported 0 games added, 1
  already present, and the target's H2H record stayed at `total: 1`, not
  doubled) — with no separate "have I imported this file before" tracking
  table needed, matching this schema's standing "nothing pre-aggregated"
  philosophy.
- Returns a summary: `{ ok, player: {name, uuid, created, renamed},
  opponents: [...], gamesImported, gamesSkipped, turnsImported,
  dartsImported, badgesImported }`, shown to the admin as a plain-language
  result message.

## Design (CSV export, as shipped)

`db.getPlayerCsvExport(name, kind)` — admin-only, the "your own stats as a
spreadsheet" flavor, deliberately simpler than (and separate from) the JSON
export/import above:

- **Non-portable by design**: no uuids, no opponents' turns, no import path.
  It never needed to solve H2H preservation — that's the JSON export's job.
  Opponents appear only as a names column on the games CSV, so this can never
  become a backdoor to anyone else's turn data.
- **`kind='games'`** — one row per game the player is in, with per-game
  aggregates of their own turns only (points, avg/turn rounded to 2 decimals,
  best turn, busts, checkouts, highest checkout, darts thrown) plus game
  context (type/category/format/practice), an alphabetized `; `-joined
  opponents column, and a `result` relative to that player
  (won/lost/completed/unfinished).
- **`kind='turns'`** — one row per turn they threw, in game-then-turn order,
  carrying the turn row's own columns plus each dart in plain notation
  (`T20 S5 D16`; `25` = single bull, `BULL` = 50, `MISS` = sector 0) as a
  space-joined `darts_detail` column — no fixed dart_1/dart_2/dart_3 columns,
  so a turn with any dart count fits.
- **Column semantics follow the schema**: `scored`/`checkout`/`bust` mean
  whatever they mean for that row's `game_type`, same as the underlying
  tables — the CSV is honest raw-ish data, not a re-interpretation layer.
- **Encoding**: RFC-4180 (quote+double `"` cells containing `"`/`,`/newlines,
  CRLF line endings), and — per `CLAUDE.md`'s standing security-surface
  convention — any string cell starting with `=`/`+`/`-`/`@`/tab is prefixed
  with `'`, the standard CSV-formula-injection neutralization. Player names
  are the one user-controlled string in these files and only control
  characters are rejected at creation, so a name like `=HYPERLINK(...)` is
  legal roster data the CSV layer has to defuse, not something the roster
  can be trusted to never contain.
- **Testing**: committed — `db.export-csv.test.js` proves every calculated
  column's math (per `CLAUDE.md`'s every-new-calculation rule), the
  own-rows-only scoping (an opponent's turns in a shared game never leak into
  the player's aggregates or turn rows), the dart notation, the RFC-4180
  quoting + formula guard (via an implementation-independent CSV parser), the
  header-only empty case, and the 404/400 errors; `server.export-csv.test.js`
  covers the route's 401/400/404/200 statuses, `text/csv` + attachment
  headers, and the `kind` default.

## Full-database export (already shipped, unchanged by this pass)

A complete dump of all players/games/turns/darts, positioned as the "back up
everything" or "migrate to a new server" option, distinct from the raw
SQLite-file copy already documented in the README's Data Storage section.

## Accessibility, security, and testing considerations

- **Security**: both export and import are admin-only (`requireAdmin`), the
  same unconditional gate as the full-database export, `/api/wipe-all`, and
  the Backups routes — this fully resolves the access-control question this
  doc originally raised (whether per-player export needs its own PIN gate):
  it doesn't, because it was redirected to be admin-only instead of
  player-self-service, which sidesteps the "shared household device, anyone
  could be looking at anyone's profile" concern the PIN-gating proposal was
  responding to. `getPlayerExport()` itself never returns PIN/credential
  columns, matching the full-database export's existing write-only handling;
  `importPlayerExport()` never accepts or writes one either (imported
  players always start with no PIN, since an export never carries one).
  Import's request body uses a raised size cap (`MAX_PLAYER_IMPORT_BYTES`,
  20MB) rather than the usual 1MB `readJson()` default, since a prolific
  player's history can genuinely exceed 1MB as JSON.
- **Testing**: covered — `db.export.test.js` has committed tests for
  `getPlayerExport()`'s game/turn/dart/opponent scoping (including a
  same-server two-player fixture proving an opponent's *unrelated* solo game
  does NOT leak into the export), the 404 on an unknown name, the empty-roster
  case, `players.uuid`'s format/uniqueness, and `importPlayerExport()`'s
  fresh-import/H2H-reconstruction/re-import-is-a-no-op/name-collision/
  stub-upgrade behavior; `server.export.test.js` covers both routes'
  401/400/404/200 status codes and response shapes, including a real
  export→import round trip through the actual HTTP endpoints. Additionally
  verified end-to-end in a real browser across two independently-run server
  instances (not just two rows in one shared test database) — exported a
  player with an H2H game from one server, imported into a second, empty
  server, and confirmed the target's own live `getH2HRecord()` computation
  reconstructs the correct result; re-imported the same file into the same
  target a second time and confirmed it was reported as a no-op with the
  H2H record unchanged; and confirmed a non-JSON file is rejected
  client-side with a clear message before any request is sent.
- **Accessibility**: the "Export a player…" screen (export controls + the
  import file input/button below them) uses standard `<select>`/`<input
  type=file>`/button controls — no special concern beyond the standing
  keyboard/focus-order checklist in `docs/accessibility-roadmap.md`. The
  existing "← Settings" back-button pattern (shared with other admin
  sub-pages) is reused rather than inventing new navigation; import results
  are shown through the same `uiAlert()`/`uiConfirm()` modal components
  every other admin write action already uses.

## Open questions for whoever picks this up

- **Resolved (tracked separately): merging two already-separate local
  players** (neither one a stub — two players who were each independently
  created/played on this same server, who a human recognizes as actually
  the same person) is explicitly **not** handled by import —
  `importPlayerExport()`'s uuid-based resolution only ever merges an
  import's player/opponent stubs onto an *existing* row with a matching
  `uuid`; it has no concept of "these two different local rows, with two
  different uuids, are secretly the same person." Now has its own design
  doc, `docs/player-merge-roadmap.md` — a general duplicate-player-merge
  tool, useful on its own regardless of import, and a genuinely harder
  problem (whose games/turns/badges win on conflict?) than anything this
  feature needed to solve. That doc also flags a real interaction worth
  building alongside it: merging deletes the source player's row, which
  would break a *future* re-import of an old export still carrying that
  player's now-orphaned `uuid` unless the merge tool records a
  `player_uuid_aliases` mapping this importer's `resolveStub()` can fall
  back to.
- **Duplicate-detection is an exact fingerprint match**, not fuzzy — a game
  re-exported/re-imported with a `created_at` that differs even by a second
  (clock skew between two machines, a hand-edited export file) won't be
  recognized as the same game and will be inserted again. Not observed in
  practice (the timestamp is preserved byte-for-byte from the original
  export in every tested scenario), but worth flagging as a known,
  unhandled edge case rather than a guaranteed-impossible one.
- **Resolved: CSV export** (a simpler, non-portable "your own stats as a
  spreadsheet" format, one row per turn or per game) — shipped 2026-07 as
  its own pass, see "Design (CSV export, as shipped)" above. As predicted,
  it needed to solve none of the portability/H2H machinery above.
- Should per-player export eventually cover tournament/league/daily-challenge/
  ghost-race participation, or stay scoped to games/turns/darts indefinitely?
