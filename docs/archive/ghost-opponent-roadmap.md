# Ghost Opponent — Design Roadmap

> **Archived** — fully shipped, kept here for design-rationale history. See
> `docs/open-roadmap-items.md` for the live completion tracker across all roadmaps.

> Status: **✅ Done** (2026-07). Every item below is built and verified: a New Game
> "👻 Ghost" mode (X01-only for v1) lets a player pick one of their own past won X01
> legs and race it dart-by-dart. Backend: `getGhostCandidateLegs()`/
> `getGhostLegScript()` (`backend/db.js`) plus `getPersonalBests()`'s new `bestLeg`
> field; routes `GET /api/players/ghost-legs` and `GET /api/players/ghost-script`
> (`backend/server.js`). Frontend: the mode toggle + leg picker (New Game),
> `newGhostPlayer()`/`playGhostTurn()` (`frontend/index.html`), a "👻" Race-this-leg
> button next to Best Leg Average on the Player Profile. Verified end-to-end with
> Playwright against a scratch database: both a "ghost wins" and a "human wins"
> race, correct screen-reader announcements for both sides, no spurious H2H-only
> badges (Comeback Kid, Giant Slayer, etc.) fire against a ghost, the ghost never
> becomes a real `players` row, and `/home/user/oche/data` was untouched throughout.

## Goal

Practice against a replay of one of your own past legs — racing your prior self
dart-by-dart — using data the app already has in full fidelity. Solo practice today
just tracks a score; this turns it into a head-to-head experience without needing a
second live person.

## Why this is achievable without simulation

The `darts` table already records every individual dart (sector, multiplier, order)
for every turn ever played. A "ghost" doesn't need any statistical modeling or AI —
it can simply be an **exact historical leg replayed dart-by-dart** on a virtual second
player's turn, interleaved with the live player's own throws. This is dramatically
simpler than generating a plausible simulated opponent, and it's honest about what
it's showing: literally "can you beat your best leg average from last month," not an
approximation of one.

## Design (as built)

- **Scope: X01 only for v1.** Cricket has its own `leg_won`/MPR shape and would need
  its own candidate/script queries — deferred until actually requested, following
  the same "explicitly deferred, not silently missing" convention used for Cricket's
  Home-page leaderboards during game-modes-roadmap.md's own build.
- **Ghost selection**: a "👻 Ghost" mode button in New Game's Mode toggle
  (alongside H2H / Practice / Daily Challenge). Choosing it locks the game type to
  X01, the format to exactly 1 leg/1 set, and shows a leg picker
  (`GET /api/players/ghost-legs?name=...`) listing that player's own past won legs,
  most recent first, each showing date/category/average/darts. A "👻" button next
  to Best Leg Average on the Player Profile (`raceLeg()`) deep-links straight into
  this flow with that specific leg preselected, via `getPersonalBests()`'s new
  `bestLeg` field (`{gameId, setNo, legNo}` — previously only the scalar
  `bestLegAvg` was exposed, discarding which leg produced it).
- **The ghost's script**: `GET /api/players/ghost-script?gameId=&setNo=&legNo=&name=`
  returns that leg's turns in playback order, each with its raw `{sector,
  multiplier}` darts, plus the leg's actual recorded `outMode` (double/single-out) —
  scoped to "this player actually won this leg," so a script can only ever be built
  from a genuine past win, never an arbitrary leg.
- **Gameplay integration**: `startGame()` fetches the script, creates the game with
  *only* the human as a real participant (the ghost's name is never sent to
  `DB.beginGame()`/`createGame()` — it stays entirely client-side), and pushes a
  second `game.players[]` entry (`newGhostPlayer()`) tagged `isGhost:true` whose
  starting score matches the historical leg's own starting score (not whatever the
  New Game screen happened to be set to) and whose `doubleOut` matches that leg's
  actual `outMode` — replaying the identical darts under a different out-mode could
  turn a historical win into a bust, so the replay must reuse the original rule.
  After every human turn, `playGhostTurn()` auto-advances the ghost through its next
  scripted visit (re-evaluated fresh through the same `evaluateVisit()` the human
  uses, not just replayed as a canned outcome) — resolves the "historical pace vs.
  instant" open question below as **instant** (advances right after the human's own
  turn, with only a short fixed UX pause, not the leg's real elapsed time).
- **Recording semantics (as built)**: the game is tagged practice, the human's turns
  are recorded exactly like any practice leg, and the ghost's turns are **never**
  persisted (`DB.recordTurn()`/`addTurn()` is never called for the ghost side) — no
  `game_players` row, no stats, no leaderboard/badge eligibility for the ghost.
  Confirmed via Playwright: after a full ghost race, `GET /api/players` still lists
  only the real human player.
- **Live scoreboard integration**: the ghost's card shows "👻 Ghost (Jul 5)" (the
  historical leg's date) instead of a real player name — `renderGame()`/
  `liveSnapshot()`/`playerSnapshot()` needed **zero changes**: they already render
  any `game.players[]` entry generically from plain fields, so the ghost "just
  works" through the existing X01 rendering pipeline on both the scoring screen and
  `/display`.
- **No spurious opponent-based badges**: a ghost is not treated as a real H2H
  opponent — `onLegWon()`'s and `enterTurn()`'s `opp` computation is guarded with
  `!game.hasGhost`, so Comeback Kid, Giant Slayer, The Rematch, Grudge Match, and
  Nerves of Steel (all gated on having a real `opp`) can never fire from racing your
  own past leg. Badges based on the human's own performance (Big Fish, a 170
  checkout, Cruise Control, etc.) still fire normally — verified end-to-end.
- **Undo**: extended (not left as a known gap) — `enterTurn()`'s undo snapshot now
  also captures the ghost's pre-round state, and `undoLastTurn()` restores it, so
  undoing a human turn correctly rolls the ghost back to before its own auto-played
  reply too, rather than leaving it one scripted visit ahead.

## Accessibility, security, and testing

- **Accessibility**: `playGhostTurn()` calls the same `announce()` function used for
  the human's own turns, so a screen-reader user hears the ghost's outcome too
  ("👻 Ghost (Jul 5) checks out with 170. Leg won."), not just the live player's —
  verified via a `MutationObserver` on `#sr-announcer` in the Playwright check. The
  ghost's reply is deliberately delayed ~450ms (a fixed UX pause, not the historical
  elapsed time) partly so its announcement doesn't land in the same animation frame
  as the human's own and clobber it.
- **Testing**: `backend/test/db.ghost.test.js` (8 assertions) covers
  `getGhostCandidateLegs()` (won-legs-only filtering, Cricket-exclusion, an unknown
  player, the `limit` param) and `getGhostLegScript()` (ordering, ownership
  checks, a nonexistent/Cricket game returning `null`), plus `getPersonalBests()`'s
  new `bestLeg` null case. `backend/test/scoring.test.js` gained a "Ghost Opponent
  replay" suite: replaying a recorded 3-turn leg script through `evaluateVisit()`
  reproduces the same bust/win outcome at each step, and a second test proves *why*
  the replay must reuse the leg's own `out_mode` (the identical darts bust under a
  different out-mode than the one they were actually thrown under).
- **Security**: no new credential/token surface — reuses existing turn/leg data
  already recorded for the human player whose leg is being replayed, and
  `getGhostLegScript()` refuses to build a script for a leg the requesting player
  didn't actually win themselves.

## Resolved open questions

- **Historical pace vs. instant advance**: resolved as instant (a short fixed ~450ms
  UX pause, not the leg's real elapsed time) — simpler, and avoids an awkward
  waiting period if the historical leg had slow visits, per the tradeoff this
  section originally called out.
- **Exact-replay vs. a future "statistical ghost"**: unchanged from the original
  framing — this feature is the exact-replay version only. A simulated opponent
  drawn from a player's average/variance remains a distinct, unbuilt future
  enhancement, not part of this pass.

## Explicitly out of scope for v1 (unchanged from the original framing)

- Cricket ghost support (its own candidate/script queries, deferred).
- A "statistical ghost" (see above).
