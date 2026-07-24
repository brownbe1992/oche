# 2-4 Player H2H X01 — Design Roadmap

> Status: **Not started.** This is a for-fun feature request (not a traditional
> darts format), scoped out of the 2026-07 New Game wizard reorder
> (`REFERENCE.md` §20) specifically so it could be designed properly rather
> than rushed in as a side effect. Today X01 H2H is hard-capped at exactly 2
> players (`maxPlayersForSetup()` returns `2` for the `x01` key unconditionally
> — `frontend/index.html`). This doc is the plan for lifting that cap to 2-4.

## Goal

Let a household game of X01 (501/301/etc.) be played with 3 or 4 players in
the same match, taking turns in rotation, exactly the way Cricket/Baseball/
Shanghai/Halve-It/Pressure Chamber already do today — X01 is the one
traditional format still artificially restricted to a pair.

## Why this is smaller than it looks

Research done while building the New Game reorder (`REFERENCE.md` §20)
confirmed the backend has **no** X01-specific 2-player constraint anywhere:

- `createGame()` (`backend/db.js`) has no player-count check for `gameType ===
  'x01'` at all — the only two game-type-specific count checks in the entire
  function are Killer (`>= 2`, no upper bound) and Dead Man Walking (`=== 1`).
- The turn-rotation engine (`GAME_TYPES.x01`, `frontend/index.html`) already
  iterates `game.players` generically — it has no assumption baked in that
  `game.players.length === 2`, because Cricket/Baseball/Shanghai/Halve-It all
  already reuse the exact same rotation mechanics with 3+ players today.
- `_winLeaderboard(gameType)` (`backend/db.js`) — the shared win/loss tally
  function backing Cricket/Baseball/Shanghai/Halve-It/Pressure Chamber/Killer's
  own leaderboards — is already fully generic across any player count: credit
  the winner `+1 win/played`, every other participant `+1 played` (an implicit
  loss). No changes needed there to support X01.
- `getEloRatings()` (`backend/db.js`) already filters `WHERE g.player_count =
  2` (plus a defensive in-code length check) — 3-4 player X01 games are
  **automatically excluded** from Household Elo the same way every other 3+
  player format already is, with zero new code.

So this is genuinely a **frontend-only** feature: lift the Step 1 cap, adapt
the live scoreboard's layout for 3-4 simultaneous players, and decide how
wins/losses roll into the existing H2H stats (see below — already decided).

## Stats decision: merge into the existing H2H win-rate leaderboard

**Resolved (2026-07, owner's explicit choice):** a 3-4 player X01 match's
win/loss counts toward the **same** H2H win-rate stats a normal 1v1 X01 match
does — no new stat bucket, no separate "multiplayer X01" leaderboard.

This was decided from 3 options pitched to the owner:

1. **Merge into existing H2H win-rate (chosen)** — every participant except
   the winner takes a loss, exactly like Cricket/Baseball/Shanghai/Halve-It/
   Pressure Chamber/Killer already do via `_winLeaderboard()`. Simplest,
   requires no new schema or leaderboard, and matches the precedent every
   other multi-player format in this app already set — X01 would otherwise be
   the *only* game type that treats "3+ players" as something other than an
   ordinary game with more losers.
2. Separate multiplayer bucket — a second X01 win-rate stat scoped to
   `player_count > 2`, kept apart from 1v1 X01 stats. Rejected: adds a new
   leaderboard/stat surface for a format the owner described as "for fun," not
   a serious competitive mode worth its own ranking.
3. Exclude from all competitive stats — count as played but never affect
   win/loss. Rejected: inconsistent with how every other 3+ player format in
   the app already works (Cricket cut-throat, Baseball, Shanghai, Halve-It,
   Pressure Chamber, Killer all count normally), and would need a bespoke
   carve-out in `_winLeaderboard()` just for this one case.

Household Elo needs no explicit decision — it already only considers
2-player games (`getEloRatings()`'s `player_count = 2` filter, a deliberate
existing choice, since Elo is inherently pairwise), so 3-4 player X01 games
are automatically out of scope for it, the same as every other 3+ player
format today.

## Build-order

1. **Lift the cap** — `maxPlayersForSetup()` (`frontend/index.html`, §20):
   change the `x01` special-case from a hard `2` to the same
   `SETUP_GLOBAL_MAX_PLAYERS` (6) branch every other dual-capable type already
   falls through to, or a smaller X01-specific ceiling if 4 is deliberately
   chosen as the format's own cap (see "Open questions" below) rather than the
   app's general 6-player ceiling.
2. **Live scoreboard formatting** (`display.html` / the in-app scoring
   screen's scoreboard rendering, `renderGameX01()`/`renderers.x01` and
   whatever the live display mirrors): X01's scoreboard was built assuming
   exactly 2 columns/rows. Needs the same "N-player generic" treatment Cricket/
   Baseball's scorecards already use (`renderers.cricket.scorecard()`,
   orientation-aware per Cricket's own item 11 in `game-modes-roadmap.md`) —
   likely a shared layout helper rather than a bespoke X01-only 3/4-player
   variant, so a future 5th+ format doesn't need its own special case again
   (per `CLAUDE.md`'s "right depth, not a bandaid" convention). Concretely:
   remaining-score-per-player needs to fit 3-4 values instead of 2, and
   whichever "who's up next" / turn-order indicator X01 currently shows needs
   to generalize the same way Cricket's already does for 3+ players.
3. **Turn-order display / checkout suggestions**: confirm the existing
   turn-rotation engine's "next player" logic needs no change (Cricket/
   Baseball/Shanghai/Halve-It already prove it doesn't), and that checkout
   suggestion overlays (built assuming a 1v1 psychological framing — "what
   does *your opponent* need") read sensibly with 3-4 names instead of a
   single opponent's.
4. **Win/loss + Personal Bests**: verify `_winLeaderboard('x01')` (if X01 uses
   it directly) or X01's own equivalent win-tally path already treats every
   non-winner as a loss for 3+ players with no code change — Cricket/Baseball
   already prove the pattern, but X01's specific win-tally code path should be
   read and confirmed, not assumed, before shipping.
5. **9-darter / achievement checks**: confirm any X01-specific achievement or
   badge condition that implicitly assumes "the opponent" (singular) as a
   count-of-1 concept — e.g. any language like "beat your opponent's personal
   best" — still makes sense or needs adapting to "any other participant" once
   3-4 players are possible.
6. **Tests**: a committed `node:test` case (per `CLAUDE.md`'s "every new
   calculation gets a permanent test" convention) proving a 3-4 player X01
   game's win/loss correctly rolls into the same H2H win-rate leaderboard a
   1v1 X01 win/loss would, and that it's excluded from Household Elo.
7. **REFERENCE.md**: update §20 (New Game screen) and whichever section
   documents the X01 live scoreboard/turn engine, once built.

## Open questions for whoever picks this up

- **Exact player ceiling**: the user asked for "2-4," not "2-6" — should
  `maxPlayersForSetup()` cap X01 specifically at 4 (a genuinely new,
  X01-specific ceiling, distinct from every other dual-capable type's shared
  6-player cap), or reuse the existing global 6-player cap for consistency
  with Cricket/Baseball/etc.? The doc title assumes 4 is the intended ceiling,
  but this should be confirmed before Step 1's cap-lifting change ships.
- **Scoreboard layout for exactly 3 vs. exactly 4** players may need visually
  distinct treatments (a 3-column vs. a 2x2 grid, for example) — worth a
  `/frontend-design` pass once the data/turn-engine side is solid, rather than
  guessing at a layout up front.
- **Accessibility**: per `CLAUDE.md`'s standing accessibility convention, a
  4-player scoreboard needs to be checked for screen-reader announcement order
  (whose turn is it, in what sequence) just as carefully as the 2-player
  version already is — more simultaneous state on screen is exactly the kind
  of change that convention exists to catch early.
