# 2-4 Player H2H X01 — Design Roadmap

> Status: **Done (2026-07).** X01 head-to-head now allows 2-4 players.
> `maxPlayersForSetup()` returns `4` for the `x01` key; every other
> dual-capable type keeps the app's global 6-player ceiling. The build turned
> out to be as small as the research below predicted — one cap, one wrapping
> label, and one accessibility addition — because the turn engine, the leg/set
> tree, the completion panel and the live board were all already generic over
> `game.players`. What that meant in practice is recorded per build-order step
> below.
>
> This is a for-fun feature request (not a traditional darts format), scoped
> out of the 2026-07 New Game wizard reorder (`REFERENCE.md` §20) specifically
> so it could be designed properly rather than rushed in as a side effect.

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

## Build-order — as built

1. **Lift the cap** — **done.** `maxPlayersForSetup()` (`frontend/index.html`)
   returns `4` for the `x01` key. Not the global 6: the owner asked for "2-4,"
   and it is a format decision rather than a technical limit — a 501 leg is
   long, and at six players the wait between your own visits stops being a game
   you are playing and becomes one you are watching. Every other dual-capable
   type still falls through to `SETUP_GLOBAL_MAX_PLAYERS`, and
   `selectSetupGame()`'s existing truncation already trims a 6-player Cricket
   roster down to 4 the moment X01 is picked, unchanged.

2. **Live scoreboard formatting** — **done, and mostly already done.** The
   `/display` half arrived with the 2026-07 live-scoreboard redesign:
   `renderers.x01.lane()` renders one full-width lane per player, the lane
   container is a flex column that takes N players without configuration, and
   the top bar's standing chips and the post-leg result view's lanes are built
   from `s.players.map(...)`. Verified live at four players at 1920×1080 — four
   lanes, four standing chips, the verdict line, no overflow.

   The **in-app scoring screen** needed one real fix. `renderGameX01()` was
   already generic (`game.players.forEach(...)` building `.pscore` rows), and
   both orientations hold four rows without scrolling — landscape's rail fits
   them at 96px each, portrait at 59px, with the board unaffected in both. What
   broke was the row's name line: a long name left just enough width for
   "DOUBLE" and pushed "OUT" onto a second line, so one row in a 3-4 player
   stack rendered a line taller than its neighbours. `.pscore .nm-out` is now
   `white-space: nowrap` — the tag is a single label, and it wraps as a unit or
   not at all.

   No separate 3-vs-4 treatment was needed (see "Open questions", resolved).

3. **Turn-order display / checkout suggestions** — **confirmed, no change.**
   The rotation is `nextActiveIndexFrom()`, a modulo walk over `game.players`
   that skips `dnf`, shared by the mid-leg advance, the between-legs starter
   rotation and the bow-out re-anchor. It has no two-player assumption, and now
   has committed tests at three and four players
   (`backend/test/frontend.multiplayer-x01.test.js`). Checkout suggestions are
   computed for the current thrower only (`checkoutHint(cur.score, ...)`) and
   carry no "what your opponent needs" framing, so they read the same at four
   players as at two.

4. **Win/loss + Personal Bests** — **confirmed, no change.** X01 has no
   dedicated `_winLeaderboard('x01')`; its wins roll into the all-game-types
   board (`getHomeExtra()`, `backend/db.js`), which is the same body with no
   `gameType` scope. That body already credits the winner `+1 won/+1 played`
   and every other participant `+1 played` regardless of count, which is
   exactly the merge decision recorded above. Household Elo's
   `player_count = 2` filter excludes 3-4 player games automatically.

5. **9-darter / achievement checks** — **confirmed, no change.** Every
   opponent-framed X01 badge (Comeback Kid, Giant Slayer, Nerves of Steel, The
   Rematch, Grudge Match) is already gated on
   `const opp = active.length === 2 ? ... : null` in `onLegWon()` — a gate that
   exists because bow-outs can shrink a Cricket match to a genuine two-player
   decider, and which now does double duty here: at three or four players `opp`
   is null and those badges simply never fire, so no wording implying a single
   opponent is ever shown for a match that had three. The per-player badges
   (180, Big Fish, nine-darter) are counted per thrower and are unaffected.

6. **Tests** — **done.** `backend/test/frontend.multiplayer-x01.test.js` pins
   the ceiling (X01 is 4, and narrower than the global constant, which it reads
   out of the source rather than restating), that no other type inherited it,
   the rotation at three and four players including bow-outs, and the new
   screen-reader phrase. The win/loss roll-up the original step asked for is
   already covered by the existing `_winLeaderboard()` suites, which are
   player-count-agnostic by construction.

7. **REFERENCE.md** — **done.** §20's `maxPlayersForSetup()` bullet now
   documents the 4-player X01 ceiling, and §2 records the next-thrower
   announcement.

## Open questions — resolved

- **Exact player ceiling**: **4**, X01-specific, for the reason in step 1
  above. Confirmed by the owner's original "2-4" framing.
- **Scoreboard layout for exactly 3 vs. exactly 4**: **no distinct treatments
  needed.** Both screens are lists rather than fixed grids — the in-app rail
  stacks `.pscore` rows and `/display` stacks lanes — so three and four differ
  only in how many rows there are. A 2x2 grid was considered and rejected: it
  would break the top-to-bottom reading order that matches throw order, which
  is the one thing a scoreboard for a rotating game has to preserve.
- **Accessibility**: **addressed.** With three or four at the oche, "who is up
  now" stops being inferable from the turn result alone — a sighted player
  reads it off the ▸ throwing flag, and a screen-reader user had no equivalent.
  `announceTurn()` now appends "*Name* to throw." to each committed visit,
  silent at one or two active players (where the next thrower is the only other
  person in the room) and silent when a bow-out has shrunk the match back to
  two. It is appended to the result rather than spoken as a second `announce()`
  because two calls in the same tick both clear and re-set one live region on
  the same frame, so the second would replace the result it was meant to
  follow. Applied to every multi-visit turn-based mode, not just X01 — Cricket,
  Baseball, Shanghai, Halve-It and Pressure Chamber all already run at 3+
  players and had the identical gap.

## Noted, deliberately not changed

`getH2HRecord()` / `getH2HSummary()` (`backend/db.js`) count **any**
non-practice game containing both named players, with no `player_count = 2`
filter — so a 4-player X01 game the winner took also lands in their pairwise
record against each of the three losers. This is pre-existing behaviour (every
3+ player Cricket/Baseball/Shanghai/Halve-It/Pressure Chamber/Killer game has
always been counted the same way) and is consistent with the merge decision
above, so lifting the X01 cap does not change it. Whether a pairwise "Ben leads
Sam 5-3" *should* include games that were not duels is a separate question,
tracked on `docs/open-roadmap-items.md`.
