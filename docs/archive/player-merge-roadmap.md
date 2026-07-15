# Player Merge Tool — Design Roadmap

> Status: **Shipped (2026-07), doc archived.** Built essentially as designed
> below — every "proposed, not decided" recommendation was adopted as-is:
>
> - **`db.getMergePreview()`/`db.mergePlayers()`** (`backend/db.js`),
>   **`GET /api/players/merge-preview`** + **`POST /api/players/merge`**
>   (`requireAdmin`, rate-limited like the backup-restore routes, logged
>   server-side), and a **Settings → Admin & Danger Zone → Merge Players**
>   section (source/target pickers + a required "Preview merge…" step whose
>   modal shows per-table move counts, auto-resolutions, and — when blocked —
>   the full ⛔ conflict list with per-item resolution hints; there is no
>   merge button without a preview).
> - **Conflict policy as recommended**: shared game/tournament/league
>   enrollment and ambiguous same-day Daily Challenge attempts (both or
>   neither completed) **block outright**; a shared badge keeps
>   `MAX(count)`/`MIN(earned_at)`; a same-day challenge pair with exactly one
>   completed keeps the completed one; target vs source is always an explicit
>   admin choice; the target's name/out_mode/dart_weight/PIN/uuid always win.
> - **`player_uuid_aliases` shipped alongside, as this doc required** —
>   `importPlayerExport()`'s `resolveStub()` now falls back to it, so an old
>   export of a merged-away player resolves onto the survivor; a merge also
>   repoints existing aliases at the new survivor, so chained merges (A→B,
>   then B→C) resolve in one hop.
> - Beyond this doc's own FK inventory (written before league fixtures
>   existed): **`league_fixtures.player1_id`/`player2_id`** are reassigned
>   too, with the canonical `player1_id < player2_id` ordering re-established
>   after the swap — a source-vs-target fixture can never survive, since it
>   would require the shared league enrollment that already blocks.
> - The merge runs in a **single transaction** (the first explicit
>   BEGIN/COMMIT in this codebase — a 12-table rewrite is the case atomicity
>   exists for); any failure rolls back to the exact pre-merge state.
> - Open questions resolved as leaned: no soft-delete undo window (the
>   required preview is the safeguard), ambiguous challenge conflicts are
>   blocked (reusing the existing Daily Challenge reset tool to resolve),
>   multi-way merges are "merge twice", and the target's settings/PIN always
>   win.
>
> Committed tests: `db.merge.test.js` (every reassignment table, every
> blocker, both auto-resolutions, fixture re-canonicalization, the alias
> fallback through a real `importPlayerExport()`, chained merges),
> `server.merge.test.js` (route auth/validation and a real preview→merge
> round trip). Full detail: `REFERENCE.md`'s "Settings → Merge Players"
> section.

## Where this need comes from

Flagged explicitly as out of scope while building per-player export/import
(`docs/archive/data-export-roadmap.md`'s "Open questions"): `importPlayerExport()`'s
uuid-based resolution only ever merges an import's player/opponent stubs
onto an *existing* row with a matching `uuid` — it has no concept of "these
two different local rows, with two different uuids, are secretly the same
person." That's a real, separate, harder problem (whose games/turns/badges
win on conflict?) than anything import needed to solve, and it's also a
genuine everyday admin need independent of import entirely — a typo'd
second account, a player re-added after being deleted, or two names for one
person that nobody noticed were the same until later.

## Goal

Let an admin merge two player records that turn out to be the same real
person. One player (the **target**, the surviving identity) absorbs the
other's (the **source**) full history; the source's row is then deleted.
Explicitly an admin-only tool, same trust tier as the rest of Settings →
Admin & Danger Zone — this rewrites history across most of the schema at
once and is meant to be rare and deliberate, not a casual self-service
action.

## Design

### Every table with a foreign key into `players.id`

Grounded in `backend/db.js`'s actual schema (`grep -n "REFERENCES
players(id)"`), not guessed — this is the real, complete list a merge has
to touch:

| Table.column | Delete behavior | Conflict risk if source and target already share a row |
|---|---|---|
| `game_players.player_id` | `CASCADE`, composite `PRIMARY KEY (game_id, player_id)` | **Yes** — if source and target were both in the *same* game (e.g. one played the other before anyone noticed they're the same person) |
| `turns.player_id` | `CASCADE` | No |
| `games.winner_id` | `SET NULL` | No |
| `player_badges.player_id` | `CASCADE`, `UNIQUE(player_id, badge_id)` | **Yes** — if both independently earned the same badge |
| `daily_challenge_attempts.player_id` | `CASCADE`, `UNIQUE(player_id, challenge_date)` | **Yes** — if both attempted the Daily Challenge on the same date |
| `tournaments.champion_id` / `runner_up_id` | `SET NULL` | No |
| `tournament_players.player_id` | `CASCADE`, composite `PRIMARY KEY (tournament_id, player_id)` | **Yes** — if both were separately enrolled in the same tournament |
| `tournament_matches.player1_id` / `player2_id` / `winner_id` | `SET NULL` | No (no uniqueness constraint on these) |
| `league_players.player_id` | `CASCADE`, composite `PRIMARY KEY (league_id, player_id)` | **Yes** — if both were separately enrolled in the same league |
| `dart_components.player_id` | `CASCADE` | No |
| `loadouts.player_id` | `CASCADE` | No |
| `ghost_races.player_id` | `CASCADE` | No |

Roughly half the tables are a plain reassignment (`UPDATE ... SET
player_id = :targetId WHERE player_id = :sourceId`, or the equivalent for
non-`player_id`-named columns) with zero risk. The other half have a real
uniqueness constraint that a naive reassignment would violate the moment
source and target share a row in that table — this is the actual hard part
of the feature, not a detail to gloss over.

### Conflict resolution — proposed, not decided

None of these are assumed as final; they're a starting recommendation for
whoever picks this up to confirm, the same way this doc's own sibling docs
flag genuine product decisions rather than guessing silently:

- **`player_badges`** (shared badge): keep `MAX(count)` and
  `MIN(earned_at)` (the earliest of the two "first earned" timestamps),
  discard the source's row. Leans toward this over summing the counts,
  since a merge shouldn't be able to *inflate* a badge count beyond what
  either individual history actually earned.
- **`daily_challenge_attempts`** (same-day attempt from both): if exactly
  one of the two is `completed=1`, keep that one; if both or neither
  completed, this needs an explicit admin decision — there's no
  non-destructive default that doesn't silently drop a real attempt.
- **`game_players`/`tournament_players`/`league_players`** (source and
  target already share a game/tournament/league): **recommend blocking the
  merge entirely** until the admin resolves it by hand (e.g. deleting the
  offending game first), rather than attempting any automatic resolution.
  A "self played against self" game, or a bracket/season where the same
  real person occupies two slots, is a genuine structural oddity that a
  merge tool silently papering over risks quietly corrupting a bracket's
  advancement state or a league's standings — this is exactly the kind of
  case worth surfacing loudly, not resolving cleverly.
- **Which player is `target` vs. `source` is always an explicit admin
  choice**, never inferred (e.g. never "whichever was created first" or
  "whichever has more games") — the admin picks two players and explicitly
  designates the survivor, since the correctly-spelled/preferred name isn't
  always the older or more-played one.

### A required "preview" step before any write happens

Given the conflict risk above, this can't be a single "Merge" button with
no confirmation detail — the admin needs to see, before committing
anything: how many rows move from each conflict-free table, and an explicit
list of every conflicting game/badge/challenge-date/tournament/league
found, with the merge blocked (or requiring per-conflict resolution) until
none remain. This is a heavier version of the `uiConfirm()` pattern this
app already uses before other admin write actions (backup restore, wipe
all data) — not a new UI pattern to invent, just more detail in the preview
than those simpler cases need.

### The `players.uuid`/import interaction — a real cross-feature consideration

Merging **deletes** the source player's row, which means the source's
`uuid` stops resolving to anything. This matters specifically because of
`importPlayerExport()` (`docs/archive/data-export-roadmap.md`): if "Ben" (uuid `X`)
is later merged into "Benjamin," and someone re-imports an *old* export of
"Ben" from another server (still carrying uuid `X`), today's importer would
find no match for `X` and recreate a brand-new stub "Ben" row — silently
un-merging the history the admin had just consolidated. **Recommended
fix, to build alongside this feature, not as a separate follow-up**: a
small new table, following this app's standing "new context gets its own
table with a FK" convention —
`player_uuid_aliases (uuid TEXT PRIMARY KEY, player_id INTEGER REFERENCES
players(id) ON DELETE CASCADE, merged_at TEXT)`. A merge writes the
source's old `uuid` into this table pointing at the target's `id`, and
`importPlayerExport()`'s `resolveStub()` checks this alias table as a
fallback when a direct `players.uuid` match fails, before falling through
to "create a new player." Without this, the merge tool and the import
feature actively work against each other over time.

### Where this lives in the UI

Recommend **Settings → Admin & Danger Zone**, alongside Wipe All Data — an
irreversible, cross-table rewrite is the same trust tier as that section's
existing actions, not a casual per-player action reachable from the Players
roster page the way Rename is. Not decided; a per-player "Merge with…"
action on the roster/Profile page is the alternative, trading discoverability
for consistency with how Rename already works from there.

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility**: the preview step above is the main new surface — needs
  the same non-color-only conventions as the rest of this app (conflict
  rows need icon + text, not just a red highlight) and a real heading
  structure a screen reader can navigate, not just a wall of text in a
  modal.
- **Security**: admin-only (`requireAdmin`, unconditional — same tier as
  `/api/wipe-all` and the full-database export), no new credential/token
  surface. Worth a rate limit or at least careful logging given how
  destructive a mistaken merge is — merging the wrong two players loses no
  data outright (everything's reassigned, not deleted, except the
  conflict-resolution cases above) but is awkward to fully undo.
- **Testing**: this is exactly the kind of change `CLAUDE.md`'s "every new
  calculation gets a committed test" rule was written for, arguably more
  so than most — a merge touching 12 tables at once, several with real
  uniqueness constraints, needs committed test coverage for every
  conflict-free reassignment table AND every conflict case above
  (including a same-game conflict correctly blocking the merge, not
  silently corrupting `game_players`' composite primary key), plus the
  `player_uuid_aliases` fallback actually being checked by
  `importPlayerExport()` afterward — a genuinely large test surface, not
  incidental to the feature.

## Open questions for whoever picks this up

- **Reversibility**: is there any value in a lightweight "undo" window
  (e.g. keep the source's original rows soft-deleted for N days before hard
  deletion), or does the preview step above make that unnecessary since the
  admin has already reviewed everything before confirming? Leans toward
  "preview is enough, no separate undo window" for simplicity, not decided.
- **Same-day Daily Challenge conflict**: if *both* attempts are complete (or
  both incomplete), what's the actual resolution UI — a side-by-side
  comparison the admin picks from, or just "the merge is blocked until you
  manually delete one via the existing Daily Challenge admin reset tool
  first" (reusing a control that already exists rather than building a new
  one)? Leans toward the latter, not decided.
- **Bulk/multi-way merges**: this doc only designs a two-player merge. Is
  there ever a real need for merging 3+ duplicate rows at once, or is
  "merge twice" an acceptable answer if that ever comes up?
- **Should `dart_weight`/`out_mode`/PIN preferences ever come from the
  source instead of always keeping the target's?** E.g. if the source has a
  PIN set and the target doesn't, should the merge offer to carry the PIN
  over, or does the target's settings always win untouched? Leans toward
  "target's settings always win, PIN included" for simplicity and because
  silently transplanting a PIN onto a different player record has its own
  security texture worth a deliberate decision, not an assumption.
