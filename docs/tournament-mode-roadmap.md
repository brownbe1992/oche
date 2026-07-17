# Tournament Mode — Design Roadmap

> Status (2026-07): **Single- AND double-elimination are built and playable
> end-to-end.** Single-elim: schema, bracket generation (arbitrary player counts,
> standard seeding, cascading byes), match lifecycle, the setup screen, a
> bracket-tree + "Up Next" view, live-scoreboard round labels, the player-deletion
> guard, tournament badges (§7) and Player Profile stats (§8). **Double-elimination
> (build-order step 2) now also ships** (2026-07, roadmap item 13): losers-bracket
> generation + grand-final/reset logic on the same schema (the
> `winner_next_*`/`loser_next_*` pointer pair, §1), restricted to exact powers of
> two (4/8/16/32/64/128) per §2's de-risking; a Single/Double toggle on the setup
> screen; and a functional grouped-column bracket view (Winners / Losers / Grand
> Final sections). Full mechanics writeup: `REFERENCE.md` §15.
>
> **One piece is still open**: the fancier winners/losers-**tabbed** *visual*
> bracket tree (build-order step 3), including the accessibility revisit its much
> deeper tree needs at 128 players — tracked as its own separate item on
> `docs/open-roadmap-items.md`. This doc stays open (not archived) until that ships
> too.

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
| Bracket format | **Both built (2026-07).** Single-elimination (arbitrary player counts) and double-elimination (item 13, restricted to exact powers of two 4/8/16/32/64/128 — see §2). Chosen via a Single/Double toggle on the setup screen. |
| Category scope | **Built.** Any X01 starting score (501/301/170/101) — the whole tournament uses one, chosen at setup. Not scoped to other game types (Cricket, etc.). |
| Match format across rounds | **Built.** Per-round configurable (legs/sets per round), same as originally decided — the setup screen pre-fills Bo3 early rounds stepping to Bo5 in the final, editable per round before generating. |
| Bracket visualization | **Built** (grouped-column layout, not a procedurally-generated SVG). Single-elim is one column per round; double-elim groups those columns into Winners / Losers / Grand Final sections. A linearized list view sits alongside for accessibility. The fancier winners/losers-**tabbed** tree is still open (build-order step 3). |
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

**Built (2026-07, item 13).** The de-risking recommendation below was taken exactly
as written: double-elimination is restricted to exact powers of two
(4/8/16/32/64/128), so there are zero byes and none of the cascading-bye complexity
this section warned about. `doubleElimStructure(k)` (`frontend/scoring.js`, shared
by backend generation and the frontend format table) lays out the winners bracket,
the alternating minor/drop losers rounds, and the grand final + reset;
`_generateDoubleElimBracket()` (`backend/db.js`) wires the `winner_next_*`/
`loser_next_*` pointer pairs; `_advanceTournamentMatch()`/`_resolveGrandFinal()`
handle losers-bracket drops and the conditional bracket reset. Committed tests in
`backend/test/tournament-double-elim.test.js`; full writeup in `REFERENCE.md` §15.
The original scoping notes are kept below for the design rationale.

Flagging this clearly — it was the highest-risk piece of the whole feature.

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
2. **✅ Done (2026-07, item 13)** — Losers bracket + grand final/reset logic layered
   on top of the same schema (double-elimination), restricted to exact powers of two.
   Ships with a Single/Double setup toggle and a functional grouped-column bracket
   view (Winners / Losers / Grand Final sections).
3. **Not started** — Visual bracket tree rendering with winners/losers **tabs**
   (double-elimination's version of the tree — single-elim's simpler tree is done,
   and double-elim currently uses the grouped-column view from step 2). Tracked as
   its own separate open item on `docs/open-roadmap-items.md`.
4. **✅ Done** — Per-round format setup UI, seeding UI (three methods, see the
   Decisions table), and tournament stats on player profiles (stretch, §8) —
   all built.
5. **✅ Done (2026-07, added after this doc's original scope)** — Tournament
   badges: 🏆 Champion, ⚔️ Giant Slayer (Tournament) (§7).

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions, these need designing in alongside the
feature, not bolted on after:

- **Accessibility**: **built** for single-elim's bracket tree — a linearized
  "Full bracket (list view)" text list sits alongside the tree (a `<details>`
  element, not hidden away), plus the "Up Next" list above both, so a screen-reader
  user has two non-spatial ways to follow the tournament, not just the tree. Match
  status is always icon + text (`TOURNEY_STATUS_ICON`/`TOURNEY_STATUS_LABEL`), never
  color alone. The two new badges (§7) reuse the existing achievement-overlay
  machinery unchanged — same icon+text+`announce()` screen-reader treatment every
  other badge already gets, nothing bespoke to design in. The double-elim view
  reuses the same linearized list view + Up Next list, so it has the same two
  non-spatial paths. **Still open**: double-elimination's much deeper tree (up to
  ~19 rounds combined for 128 players) will need the *visual tabbed tree* (step 3)
  designed with this in mind at that scale — the current grouped-column view stays
  readable, but the eventual tab layout must not regress it.
- **Testing**: **built** for both bracket types. `backend/test/tournament.test.js`
  covers single-elim: generation across several player counts (including the
  5-player bye-cascade case), a full simulated tournament to champion, walkover
  parity, validation, the player-deletion guard, the Champion/Giant Slayer badges,
  and `getTournamentStats()`. `backend/test/tournament-double-elim.test.js` covers
  double-elim: the shared `doubleElimStructure()` plan (N=4/8), generation (round
  counts, zero byes, WB seeding, bracket labels), the power-of-two and round-count
  validation, a full 4-player play-through that drives a winners-bracket loser to
  the title through the losers bracket **and** forces a grand-final bracket reset,
  the no-reset path (WB champ wins game one), an 8-player play-to-completion that
  proves every match is reachable (no dead-end pointers), and the double-elim
  `getTournamentStats()` best-finish labels.
- **Security**: no new credential/token surface, so no write-only-handling or
  brute-force question here — tournament data reuses the existing `games`/admin-auth
  model unchanged.

## Open questions — resolved

- **Resolved**: seeding method — built all three (random shuffle, manual reorder, by
  lifetime 3-dart average) rather than picking just one, since each is genuinely
  useful for a different situation and none was clearly better on its own.
- **Resolved (2026-07)**: exact power-of-two requirement for double-elim (see §2) —
  shipped **with** the restriction (4/8/16/32/64/128), exactly this doc's own §2
  recommendation, since it eliminates the cascading-bye problem entirely. Arbitrary
  double-elim counts remain a possible future refinement, but were not worth the
  complexity for v1. (Single-elim keeps its arbitrary-count bye-cascading.)
- **Still open**: should tournament matches be tied to a specific dart board /
  device, or can any device pick up the next "Up Next" match? Not addressed either
  way in this pass — any device with the app open can start any ready match today,
  which is the simpler default behavior, not a deliberate design statement.

## 7. Tournament-specific badges (built, 2026-07)

Tournament mode originally shipped with **zero badge integration** — a genuine
gap, not a deliberate omission. The original achievements-badges roadmap
explicitly flagged "should badges eventually tie into other roadmap items
(tournament seeding)?" as an open question back when tournament mode was still
a future item; tournament mode shipped and that question sat unrevisited until
now.

Two new badges, both one-time (`once:true`, same award style as Around the
Clock/World). Exact trigger conditions and test coverage: `REFERENCE.md` §4's
"Tournament badges" table, `backend/test/tournament.test.js`'s "tournament
badges (§7)" describe block:

- **🏆 Champion** — fires when `tournaments.status` transitions to `'completed'`
  and the player is that tournament's `champion_id`. **Built exactly as
  designed**: checked inline in `_advanceTournamentMatch()` (`backend/db.js`),
  the same function that already sets `champion_id`, not a second parallel
  hook.
- **⚔️ Giant Slayer (Tournament)** — fires when a match winner's `seed` number is
  numerically higher (a worse seed) than their beaten opponent's `seed` by 3 or
  more (`TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD`), mirroring the existing H2H
  Giant Slayer's "beat someone clearly stronger" spirit with a seed-based
  threshold instead of its average-based one. Its own `badgeId`
  (`tournament_giant_slayer`), distinct from the existing H2H `giantslayer` —
  same headline concept, different trigger mechanics, so reusing the same
  badge row would have conflated two different conditions under one count.
  Never fires on a bye advance (no real opponent was beaten).

Since neither the badge-award endpoint nor `onGameCompleted`'s hook has a
response channel back to the frontend, the live overlay celebration is
detected rather than driven directly: `finishUnit()`'s `game.tournamentMatchId`
branch re-fetches the winner's badge list after the match completes and diffs
it against the pre-match `earnedBadgeCache` snapshot — the same "already
earned?" check Around the World already uses — firing `queueBadge()`/
`fireMomentCard()` for whichever badge is newly present.

The seed-gap threshold (3) was picked as a reasonable first cut rather than
prototyped against real bracket data, same caveat the original badges doc gave
every Mental Game/Clutch badge — revisit if it turns out to fire too often or
too rarely once used for real.

## 8. Tournament stats on the Player Profile (built, 2026-07)

Referenced above (§6 build-order item 4) as a stretch goal, now built as its
own tracked item on `docs/open-roadmap-items.md`:

- A small **"Tournaments"** stat block on the Player Profile, in the H2H tab
  (gated to the X01 game-type toggle, since tournaments are X01-only) —
  wins (`champion_id` count), runner-up count (`runner_up_id`), and best finish
  reached (Final/Semifinal/Quarterfinal/Round N), derived from the furthest
  `tournament_rounds.round_no` this player was ever placed into (win, loss, or
  bye) across every tournament they've appeared in, converted to a label the
  same way bracket generation's own `_roundLabel()` does.
- All three are simple `COUNT`/`MAX`-style queries against `tournaments`/
  `tournament_players`/`tournament_rounds` — no new derived formula invented,
  just a new stats surface reusing existing tables. `GET
  /api/players/tournament-stats` (public), `getTournamentStats()`
  (`backend/db.js`), covered by `backend/test/tournament.test.js`'s
  "getTournamentStats (§8)" describe block.
