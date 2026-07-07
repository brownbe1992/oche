# Tournament Mode — Design Roadmap

> Status (2026-07): **Single-elimination is fully built and playable end-to-end** —
> schema (`tournaments`/`tournament_players`/`tournament_rounds`/`tournament_matches`),
> bracket generation (arbitrary player counts, standard seeding placement, cascading
> byes), match lifecycle (start/advance/walkover via the existing `onGameCompleted`
> hook), a New Game-adjacent setup screen (name/category/player-select/seeding/
> per-round format), a bracket-tree + "Up Next" view, live-scoreboard round labels, and
> the player-deletion guard. **Double-elimination is explicitly deferred** — not
> started, tracked as its own item on `docs/open-roadmap-items.md` — the schema's
> `winner_next_*`/`loser_next_*` pointer-pair design (§1 below) already supports it
> without a migration, so this doc stays open (not archived) until that item ships
> too. Full mechanics writeup: `REFERENCE.md` §15.

> **Related (2026-07)**: `docs/companion-website-roadmap.md` proposes cross-instance
> tournaments run through a project-operated site. This doc's bracket-generation logic
> is exactly what that would reuse — but everything below is scoped to one instance's
> own local `players` roster; extending the participant model to include matched/
> remote players is that other doc's job, not a change needed here yet.

## Goal

Bracket-style tournament play — e.g. 8, 16, or up to 128 players — built on top of the
existing 1v1 scoring engine rather than a parallel system. A tournament match should
*be* a normal `games` row under the hood, so PINs, checkout hints, undo, live
scoreboard, and all existing stats keep working with zero changes to the scoring engine
itself. The tournament layer is purely bracket orchestration sitting on top.

## Decisions made (2026)

These were chosen deliberately over simpler defaults, so the design below is scoped
for them:

| Decision | Choice |
|---|---|
| Bracket format | ~~Single-elimination **and** double-elimination~~ **Revised (2026-07, explicit build decision): single-elimination only.** Double-elimination deferred to its own future item — see the status header above. |
| Category scope | **Built.** Any X01 starting score (501/301/170/101) — the whole tournament uses one, chosen at setup. Not scoped to other game types (Cricket, etc.). |
| Match format across rounds | **Built.** Per-round configurable (legs/sets per round), same as originally decided — the setup screen pre-fills Bo3 early rounds stepping to Bo5 in the final, editable per round before generating. |
| Bracket visualization | **Built**, but simpler than "full visual bracket tree" implied — single-elimination's tree is one column per round (no winners/losers split to manage), not a procedurally-generated SVG. A linearized list view sits alongside it for accessibility. |
| Seeding | **Built.** Three methods, all client-side: random shuffle, manual reorder, or by existing lifetime 3-dart average (best first, no-data-yet sorts last). See REFERENCE.md §15. |

## 1. Data model

New tables, additive to the existing schema — no changes needed to `games`,
`game_players`, `turns`, or `darts`.

**`tournaments`**
`id, name, category, bracket_type ('single_elim'|'double_elim'), player_count, status ('in_progress'|'completed'), champion_id, runner_up_id, created_at, completed_at`

(Built with just `'in_progress'`/`'completed'`, no separate `'seeding'` state —
bracket generation is one synchronous call, `createTournament()`, so there's no
partially-set-up tournament to represent a third status for.)

**`tournament_players`**
`tournament_id, player_id, seed, status ('active'|'eliminated'|'champion')`

**`tournament_rounds`** — one row per round so each can carry its own format:
`id, tournament_id, bracket ('winners'|'losers'|'grand_final'), round_no, label (e.g. "Quarterfinal", "Losers Round 3"), legs_per_set, sets_per_game`

Resolved at bracket-creation time and stored on the row — not looked up dynamically —
so changing the default format logic later never requires a migration.

**`tournament_matches`** — the core structure:
`id, round_id, slot, player1_id, player2_id, is_bye, game_id, winner_id, winner_next_match_id, winner_next_slot, loser_next_match_id, loser_next_slot`

(Built without a stored `status` column — `pending`/`ready`/`in_progress`/`complete`
is derived at read time from the other columns instead, matching the rest of the
schema's "nothing pre-aggregated" philosophy.)

The `winner_next_*` / `loser_next_*` pointer pair is the key design choice: it makes
single- and double-elimination *the same schema*. A single-elim match always has
`loser_next_match_id = null` (eliminated on loss). A winners-bracket match in
double-elim points its loser into a losers-bracket match instead of null. No
format-specific tables needed.

## 2. The hard part: double-elimination bracket generation

**Not built — deferred, see the status header above.** Single-elimination's own
generation (arbitrary player count, standard seeding placement, cascading byes) is
built and tested; everything in this section is still exactly as originally scoped,
unstarted, for whoever picks up double-elimination next.

Flagging this clearly — it's the highest-risk piece of the whole feature.

Single-elimination generation is straightforward (halve each round, byes auto-advance).
Double-elimination is a well-known but genuinely fiddly combinatorial problem:

- The losers bracket doesn't have a clean 1:1 relationship with winners-bracket rounds
  — it alternates "drop rounds" (new losers enter) and "survivor rounds" (LB players
  face each other). For 128 players that's roughly 12 losers-bracket rounds against 7
  winners-bracket rounds.
- Byes are the messy part. If the winners bracket isn't a clean power of two, a bye in
  WB round 1 means there's no "loser" to drop into the corresponding LB slot — that
  slot needs its own bye, and this can cascade.
- The grand final has a conditional second match ("bracket reset"): if the
  losers-bracket finalist wins game one, they've only got one overall loss same as the
  winners-bracket finalist, so a second match decides it; if the winners-bracket
  finalist wins game one, the tournament just ends there.

**Recommendation to de-risk this:** restrict double-elimination brackets to exact
powers of two (4, 8, 16, 32, 64, 128) for v1. The tournament-setup screen should either
require selecting one of those counts, or pad the roster with clearly-labeled "bye"
slots up to the next power of two *before* generation — rather than handling arbitrary
counts with cascading byes in both brackets at once. Single-elimination can still
gracefully handle arbitrary counts since bye propagation there is simple and
well-understood.

## 3. Match lifecycle

**Built, exactly as described below** (single-elim: step 4's "propagates the loser
into `loser_next_match_id`/slot (double-elim)" branch doesn't exist yet — a loser is
always just marked eliminated). See `REFERENCE.md` §15 for the exact function names.

1. Tournament created → bracket generated → all `tournament_matches` rows exist
   upfront (most with `player1_id`/`player2_id` null until earlier matches resolve),
   with byes auto-resolved immediately (cascading where needed).
2. A match becomes **ready** once both players are known.
3. Starting a ready match creates a normal `games` row (reusing the existing
   `POST /api/games` path) with the round's configured category/legs/sets, launches
   the existing scoring screen pre-populated with those two players, and stores the
   `game_id` back on the `tournament_matches` row.
4. On game completion (`POST /api/games/:id/complete`), a hook checks if that game is
   linked to a tournament match: if so, it writes `winner_id`, propagates the winner
   into `winner_next_match_id`/slot, propagates the loser into
   `loser_next_match_id`/slot (double-elim) or marks them eliminated (single-elim / LB
   loss), and re-evaluates whether the newly-fed matches are now "ready."
5. Tournament completes when the grand final (and bracket reset, if triggered)
   resolves; `champion_id`/`runner_up_id` get set, status → completed.

**Abandoning a match mid-way** needs a firm rule since the bracket depends on a
definite result: disallow a plain "End game" for tournament matches and require either
finishing it or recording an explicit walkover/forfeit (admin picks a winner without
playing it out). **Built**: `askEndGame()` refuses the normal abandon flow for a
tournament match and sends the admin back to the bracket instead; `recordWalkover()`
is allowed regardless of whether the match's game was ever started, so it recovers an
abandoned mid-game match too, not just a never-started one.

## 4. UI/UX

**Setup screen** — **built**, though simpler than "up to 128 players" implied: a
checkbox list rather than a searchable virtualized picker (a household's player
roster is realistically tens of names, not hundreds), the three seeding methods from
the Decisions table above, and the per-round format table with editable legs/sets
per round before generating.

**Bracket view** — **built**, but as a plain flex column per round (`.tourney-bracket`
in `frontend/index.html`) rather than a procedurally-generated SVG — single-
elimination has no winners/losers split to render, so the "two scrollable panels
with a tab switcher" design below is double-elimination-specific and still unbuilt.

**"Up Next" list** — **built**, exactly as described: the actual entry point for
starting a match, listing every `ready` match (plus any `in_progress` one, for a
Walkover-only recovery action) across the single bracket.

**During/after a match** — **built**: the round label
(`game.tournamentRoundLabel`, e.g. `"Final"`) feeds `liveSnapshot()` and is prefixed
onto `/display`'s existing top-bar text by `fmtText()`. Simpler than the
`"Losers Round 3 · Match 2"` example above since there's only one bracket to label.

## 5. Integration points (no changes needed)

**Built exactly as scoped** — nothing in this section needed a single change to
`games`/`turns`/`darts` or the scoring engine:

- **Stats**: tournament matches record as normal H2H games (`practice=0`), so they
  automatically count toward existing averages, win rates, H2H records, etc.
- **PINs, per-player finish rules, checkout hints, achievements**: all work unmodified
  since it's the same `game` object under the hood. (PINs needed one small addition
  not originally anticipated here: `beginTournamentMatch()` re-applies the New Game
  screen's own `withPinCheck()` gate, since a tournament match has no per-slot picker
  of its own to have applied it already — see `REFERENCE.md` §15.)
- **Player deletion mid-tournament**: **built** — a guard blocks deleting a player
  who's `active` in an in-progress tournament, registered via the existing
  `registerDeletePlayerGuard` extensibility point (`docs/archive/existing-app-prep-roadmap.md`
  item 6) exactly as anticipated here.

## 6. Suggested build order

1. **✅ Done — Schema + single-elimination generation/advancement + "Up Next" list UI**
   (no tree yet at this step) — proved out the game-linking and
   advancement-propagation logic on the simpler bracket shape. Shipped with the
   bracket tree too (simple enough for single-elim that it wasn't worth a separate
   step) plus the full setup screen, walkover, and PIN gate — see the status header.
2. **Not started** — Losers bracket + grand final/reset logic layered on top of the
   same schema (double-elimination).
3. **Not started** — Visual bracket tree rendering with winners/losers tabs
   (double-elimination's version of the tree — single-elim's simpler tree is done).
4. **Partially done** — Per-round format setup UI: done. Seeding UI: done (three
   methods, see the Decisions table). Tournament stats on player profiles (stretch):
   not built.

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions, these need designing in alongside the
feature, not bolted on after:

- **Accessibility**: **built** for single-elim's bracket tree — a linearized
  "Full bracket (list view)" text list sits alongside the tree (a `<details>`
  element, not hidden away), plus the "Up Next" list above both, so a screen-reader
  user has two non-spatial ways to follow the tournament, not just the tree. Match
  status is always icon + text (`TOURNEY_STATUS_ICON`/`TOURNEY_STATUS_LABEL`), never
  color alone. **Still open**: double-elimination's much deeper tree (up to ~19
  rounds combined for 128 players) will need this revisited at that scale — the
  simple list-view approach may not stay ergonomic that large.
- **Testing**: **built** for single-elimination — `backend/test/tournament.test.js`
  covers bracket generation across several player counts (including the 5-player
  bye-cascade case), a full simulated tournament to champion, walkover parity with a
  played match, validation, and the player-deletion guard. The double-elimination
  bracket generator remains the piece this doc itself calls out as "genuinely
  fiddly" and the highest-risk part of the whole feature — still needs the same
  level of test coverage once it's built.
- **Security**: no new credential/token surface, so no write-only-handling or
  brute-force question here — tournament data reuses the existing `games`/admin-auth
  model unchanged.

## Open questions — resolved (single-elimination) / still open (double-elimination)

- **Resolved**: seeding method — built all three (random shuffle, manual reorder, by
  lifetime 3-dart average) rather than picking just one, since each is genuinely
  useful for a different situation and none was clearly better on its own.
- **Still open**: exact power-of-two requirement for double-elim (see §2) —
  acceptable, or is arbitrary-count support with cascading byes worth the
  complexity? Single-elimination's own bye-cascading (arbitrary counts, no
  power-of-two requirement) is built and proven, so this is purely a
  double-elimination-specific question now.
- **Still open**: should tournament matches be tied to a specific dart board /
  device, or can any device pick up the next "Up Next" match? Not addressed either
  way in this pass — any device with the app open can start any ready match today,
  which is the simpler default behavior, not a deliberate design statement.
