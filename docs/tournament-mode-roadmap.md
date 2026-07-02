# Tournament Mode — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

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
| Bracket format | Single-elimination **and** double-elimination |
| Match format across rounds | Per-round configurable (e.g. Bo3 early rounds, Bo5/Bo7 later) |
| Bracket visualization | Full visual bracket tree (not just a round-by-round list) |

## 1. Data model

New tables, additive to the existing schema — no changes needed to `games`,
`game_players`, `turns`, or `darts`.

**`tournaments`**
`id, name, category, bracket_type ('single_elim'|'double_elim'), player_count, status ('seeding'|'in_progress'|'completed'), champion_id, runner_up_id, created_at, completed_at`

**`tournament_players`**
`tournament_id, player_id, seed, status ('active'|'eliminated'|'champion')`

**`tournament_rounds`** — one row per round so each can carry its own format:
`id, tournament_id, bracket ('winners'|'losers'|'grand_final'), round_no, label (e.g. "Quarterfinal", "Losers Round 3"), legs_per_set, sets_per_game`

Resolved at bracket-creation time and stored on the row — not looked up dynamically —
so changing the default format logic later never requires a migration.

**`tournament_matches`** — the core structure:
`id, round_id, slot, player1_id, player2_id, is_bye, game_id, winner_id, winner_next_match_id, winner_next_slot, loser_next_match_id, loser_next_slot, status`

The `winner_next_*` / `loser_next_*` pointer pair is the key design choice: it makes
single- and double-elimination *the same schema*. A single-elim match always has
`loser_next_match_id = null` (eliminated on loss). A winners-bracket match in
double-elim points its loser into a losers-bracket match instead of null. No
format-specific tables needed.

## 2. The hard part: double-elimination bracket generation

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
playing it out).

## 4. UI/UX

**Setup screen** (new — doesn't fit the existing 2-player-centric New Game flow):
tournament name, category, bracket type, player selection (needs a scalable
multi-select for up to 128 — a searchable checklist with a running count, "select
all," and manual seed reordering, not the current one-slot-at-a-time picker), then a
per-round format table (pre-filled with sensible defaults — e.g. Bo3 early rounds
stepping up to Bo5/Bo7 — that the admin can override per round) before generating the
bracket.

**Bracket view**: render it the same way the interactive dartboard already is —
procedurally generated SVG/positioned-div layout from data (the codebase already has
this pattern in `buildDartboard()`). Given the scale (winners + losers brackets, up to
~19 rounds combined for 128 players), split it into two scrollable/zoomable panels —
**Winners** and **Losers** as a tab switcher — rather than one enormous combined
canvas, with the Grand Final shown as a connecting element between them. This mirrors
how most bracket tools (Challonge, etc.) handle double-elim at scale.

**"Up Next" list**: tapping a specific match node in a zoomed-out 128-player tree is a
poor way to *start* a match. Add a simple list of just the matches currently ready to
play, across both brackets, as the actual entry point for launching a game — the tree
serves as the "view standings/progress" screen, not the primary interaction surface.

**During/after a match**: unchanged scoring screen and live scoreboard. Add the round
label (e.g. "Losers Round 3 · Match 2") to the live snapshot so `/display` can show
tournament context in the top bar — small addition to the existing `gameType`-style
snapshot fields (see `frontend/display.html`'s `renderers` dispatch table).

## 5. Integration points (no changes needed)

- **Stats**: tournament matches record as normal H2H games (`practice=0`), so they
  automatically count toward existing averages, win rates, H2H records, etc.
- **PINs, per-player finish rules, checkout hints, achievements**: all work unmodified
  since it's the same `game` object under the hood.
- **Player deletion mid-tournament**: needs a guard — block deleting a player who's
  `active` in an in-progress tournament, similar in spirit to the orphaned-game
  cleanup already built for regular player deletion (`db.js`'s `pruneOrphanedGames`).

## 6. Suggested build order

Given the scope, sequence this rather than build it all at once:

1. Schema + single-elimination generation/advancement + "Up Next" list UI (no tree
   yet) — proves out the game-linking and advancement-propagation logic on the simpler
   bracket shape.
2. Losers bracket + grand final/reset logic layered on top of the same schema.
3. Visual bracket tree rendering (winners/losers tabs).
4. Per-round format setup UI polish, seeding UI polish, tournament stats on player
   profiles (stretch — e.g. tournament wins / best finish on the player profile page).

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions, these need designing in alongside the
feature, not bolted on after:

- **Accessibility**: the bracket tree is a highly visual, spatial UI (up to ~19
  rounds for 128 players) with no non-visual equivalent designed here yet — a
  screen-reader user needs some linearized "who plays whom next, and what's the
  current state of my side of the bracket" view, not just the tree. The multi-select
  seeding UI also needs keyboard/focus-order treatment per
  `docs/accessibility-roadmap.md`'s standing checklist.
- **Testing**: the double-elimination bracket generator is the piece this doc itself
  calls out as "genuinely fiddly" and the highest-risk part of the whole feature —
  it's also pure, deterministic logic (seed list in, bracket structure out), exactly
  the kind of core logic `docs/testing-and-observability-roadmap.md` says new
  features should get real test coverage for as it's built, not verify by hand.
- **Security**: no new credential/token surface, so no write-only-handling or
  brute-force question here — tournament data reuses the existing `games`/admin-auth
  model unchanged.

## Open questions for whoever picks this up

- Seeding method: random draw (matches the app's existing "Shuffle" feature) vs. admin
  manually orders seeds vs. standard tournament seeding math (1 vs N, 2 vs N-1, ...)?
- Exact power-of-two requirement for double-elim (see §2) — acceptable, or is
  arbitrary-count support with cascading byes worth the complexity?
- Should tournament matches be tied to a specific dart board / device, or can any
  device pick up the next "Up Next" match?
