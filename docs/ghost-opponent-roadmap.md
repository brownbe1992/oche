# Ghost Opponent — Design Roadmap

> Status (2026-07): **the original race feature is fully shipped** (below, unchanged
> from when this doc was briefly archived). **Ghost Race Win/Loss Tracking is now
> also built** (further down) — a `ghost_races` table, `POST /api/ghost-races`,
> `GET /api/players/ghost-race-record`, and a "👻 Ghost races: W–L" line on the
> Player Profile next to the "Race this leg" button. **One item remains**: "Ghost
> race badges" (a Ghost Slayer first-win badge), which depended on the win/loss
> table existing and can now be picked up. Per `CLAUDE.md`'s archiving convention,
> this doc moves back to `docs/archive/` once that item is also done. See
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

---

## Ghost Race Win/Loss Tracking — ✅ Built (2026-07)

> Status: **built and verified end-to-end**, per the design below (one correction
> from the original design, noted in "Data model"). No longer tracked as an open
> item on `docs/open-roadmap-items.md`.

### Why this is a real gap today

A ghost race is already a genuine head-to-head race, not a solo score attempt —
`playGhostTurn()`/the human's own turn interleave, and whichever side hits its
checkout first calls `onLegWon()`. But per the "Recording semantics (as built)"
note above, **the ghost's turns are never persisted and the result itself is
never recorded anywhere** — the race outcome only ever exists as one line of text
on the "LEG COMPLETE" screen (`finishUnit('leg', winner)`), then it's gone. A
player racing their own past leg repeatedly today has no way to see "am I
actually getting better at beating my old self" over time.

### How a winner is already determined (no new game logic needed)

`onLegWon(wi)` already receives `wi` — the index of whichever `game.players[]`
entry just won. For a ghost race, `game.players[0]` is always the human and
`game.players[1]` is always the ghost (`newGhostPlayer()`). So `wi === 0` is a
human win, `wi === 1` is a ghost win — this is **already computed**, just never
looked at again after the leg-complete banner renders. Because turns strictly
alternate and only a checkout (never a bust) ends the leg, there is no tie case
to design for — every race resolves to exactly one winner.

### Data model

New context table, per `CLAUDE.md`'s standing convention (links into `games` via
its own table with a `game_id` FK, not a boolean on `games`):

**`ghost_races`**
`id, game_id, player_id, source_game_id, source_set_no, source_leg_no, result,
human_darts, ghost_darts, created_at`

- `game_id` — FK to the race's own new practice game (the one just played),
  `ON DELETE CASCADE`. This is the row `createGame()` already produces for every
  ghost race today (tagged `practice`); nothing new to create here.
- `source_game_id`/`source_set_no`/`source_leg_no` — which historical leg was
  raced (the same three values `getGhostLegScript()` already takes as params),
  `source_game_id ON DELETE CASCADE`. Lets a future history view say "you raced
  your Jul 5 leg and won," not just a bare counter.
- `result` — `'win'` \| `'loss'` (from the human's perspective), computed
  client-side exactly as described above and sent up once, not re-derived
  server-side (the server has no way to know which side is "the ghost" — that's
  purely a client-side construct that's never a real `game_players` row).
- `human_darts` / `ghost_darts` — total darts each side took to finish this
  specific race (the ghost's is usually but not always identical to the source
  leg's own dart count, since `playGhostTurn()` re-evaluates fresh through
  `evaluateVisit()` rather than replaying canned outcomes — see "Design (as
  built)" above). Nice-to-have flavor ("won by 2 fewer darts"), not required for
  a bare win/loss counter — could ship as `NULL`-permitted and backfilled later
  if the v1 build wants to descope it.
- `player_id` — `ON DELETE CASCADE`. Like `dart_components`/`loadouts`, this is
  **not** cleared by `resetStats()` implicitly the way profile data is — a ghost
  race result is stat/game data (an outcome of a specific practice game), so it
  belongs in the same category as `turns`/`games` and should be wiped by
  `resetStats()` alongside them. **Correction from the original design**: no
  explicit `DELETE FROM ghost_races` line was actually needed — `game_id` and
  `source_game_id` are both `ON DELETE CASCADE`, and SQLite fires cascades as
  part of executing each individual `DELETE` statement regardless of what other
  statements share the same `db.exec()` call, so `resetStats()`'s existing
  `DELETE FROM games` already clears every `ghost_races` row for free (the
  original design's "explicit is safer" reasoning was overcautious — verified
  by a committed test). `wipeAllData()` also needs no explicit line — covered
  twice over by both the `player_id` and game-FK cascades.
- **`getFullDatabaseExport()`** needs an explicit `ghostRaces: db.prepare('SELECT *
  FROM ghost_races').all()` line, per the same standing "any new user-data table
  must be added here" rule the tournament/loadout tables already follow.

### API

```
POST /api/ghost-races                       Record a race result
                                             { player, gameId, sourceGameId,
                                               sourceSetNo, sourceLegNo, result,
                                               humanDarts?, ghostDarts? }
GET  /api/players/ghost-race-record?name=   { wins, losses, totalRaces } summary (public)
```

`POST /api/ghost-races` is gated by `requireWrite`, same as every other
stat-writing endpoint (`/api/challenges/complete`, `/api/badges/award`) — no new
auth model needed. Called from `onLegWon()` right alongside the existing
`finishUnit('leg', w.name)` call, only when `game.hasGhost` is true — the source
leg reference (`game.ghostSourceLeg`) is captured onto the `game` object at race
start (mirroring `game.tournamentMatchId`'s pattern) rather than read from
`setup.ghostLeg` at race-end time, so it survives regardless of what the setup
screen's own state becomes in between.

**Shipped without** a per-race history list (`GET /api/players/ghost-races?name=&limit=`)
— the summary endpoint alone answers the "simply track wins/losses" ask this was
built for. Still a natural future extension (see "Open questions").

### Frontend surfacing — built

A **"👻 Ghost races: W–L"** line (`#ghost-race-record` span) next to the existing
"👻 Race this leg" button on the Player Profile, next to Best Leg Average —
plain text, not a new stat-bubble category. Populated by `loadGhostRaceRecord()`,
called right after `loadPersonalBests()`'s response renders (a no-op if the span
doesn't exist, e.g. on a non-X01 Personal Bests view or a player with no `bestLeg`
yet). Shows nothing (not "0W-0L") until the player has actually raced at least once.

### Accessibility, security, and testing — built

- **Accessibility**: no new UI interaction pattern — a plain text stat line, read
  by a screen reader exactly like every other Player Profile stat already is. The
  existing leg-complete `announce()` call already speaks the winner's name
  (human or ghost) at race end; no change was needed there.
- **Security**: `requireWrite`-gated like every other stat-writing endpoint.
  `recordGhostRace()` re-validates the source leg server-side by calling the
  existing `getGhostLegScript()` internally and rejecting if it returns `null` —
  a hostile client claiming a leg it never actually won (or belonging to another
  player) is rejected with the same "source leg not found" error, not trusted
  from the request body. Covered by `backend/test/db.ghost-race.test.js`'s
  dedicated "can't fabricate a fake win history" cases.
- **Testing**: `backend/test/db.ghost-race.test.js` (11 assertions) covers
  `recordGhostRace()`'s validation (result enum, unowned race game, an unwon
  source leg, a source leg belonging to a different player, a nonexistent race
  game, an unknown player) and `getGhostRaceRecord()`'s win/loss counting,
  plus the export/cascade behavior. Verified end-to-end with Playwright against
  a live server: a real 9-dart 501 checkout leg, raced twice — replayed
  identically for a human win, then deliberately missed every dart for a ghost
  win — correctly POSTs `result:'win'`/`result:'loss'` with accurate
  `humanDarts`/`ghostDarts`, and the Player Profile shows `1W–1L` after both.

### Open questions for whoever picks this up

- A fuller per-race history list (`GET /api/players/ghost-races?name=&limit=`,
  mirroring `getGhostCandidateLegs()`'s shape) remains a natural future
  extension — not built, since the plain counter already answers what was asked.

## Ghost race badges — design (not yet built; its dependency is now built)

> Status: **designed, not started.** Tracked as its own item on
> `docs/open-roadmap-items.md`, separate from win/loss tracking above since it's a
> genuinely separable follow-on — it needed the `ghost_races` table to exist
> first, not just the same PR. That table now exists (above), so this is unblocked.

One new badge, one-time (`once:true`, same style as Around the Clock/World):

- **👻 Ghost Slayer** — fires on a player's first-ever `result='win'` row in
  `ghost_races` (a simple `COUNT` check in the same `POST /api/ghost-races` write
  path, mirroring how every other once-badge is checked at its own trigger point
  rather than via a separate scan). A win-streak variant (beat the ghost N races
  in a row) was considered and rejected for v1 — it needs a "most recent N
  results" query that doesn't exist yet for any other badge, and a first win is
  the more universally-satisfying milestone (everyone gets exactly one first
  win; not everyone will string together a streak).
- Deliberately **one badge, not several** — the existing 22-badge set is curated,
  and this is a niche opt-in practice tool, not a core competitive mode; it
  doesn't need Cricket-style badge parity effort.
