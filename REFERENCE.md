# Oche — Reference Manual

This is the **specification** for how Oche is supposed to work: every stat's
exact formula, every achievement's exact trigger condition, the full database
schema, the full API surface, and the mechanics behind every feature.
`README.md` is the user-facing "what it does and how to run it" doc; this is the
"what it's supposed to do, and how to debug it when it doesn't" doc.

**This document is the statement of intended behavior — use it to find bugs.**
When auditing or bug-hunting, cross-reference the code against this document: a
mismatch between the two is a bug signal, and the presumption is that this
document describes the intent. If the code deviates from what's written here,
the code has a bug — fix the code. (This is exactly how the Average Pace bubble
bug was found: the spec said the bubble shows darts/minute; the code could never
display it.) Only when the deviation turns out to be a deliberate, intended
change is this document the thing to update — and in that case it must be
updated in the same change that altered the behavior, not as a followup. Either
way, the two must never be left disagreeing. See the "Reference manual"
convention in `CLAUDE.md`.

---

## Contents

- [1. Architecture](#1-architecture)
- [2. Core Scoring Engine](#2-core-scoring-engine)
- [3. Statistics — Every Formula](#3-statistics--every-formula)
- [4. Achievements & Badges](#4-achievements--badges)
- [5. The Achievement Queue (Simultaneous Achievements)](#5-the-achievement-queue-simultaneous-achievements)
- [6. Daily Challenge](#6-daily-challenge)
- [7. Live Scoreboard & Real-Time Sync](#7-live-scoreboard--real-time-sync)
- [8. Shareable Moments](#8-shareable-moments)
- [9. Security Model](#9-security-model)
- [10. Home Assistant Integration](#10-home-assistant-integration)
- [11. Accessibility](#11-accessibility)
- [12. Backups](#12-backups)
- [13. Database Schema](#13-database-schema)
- [14. API Reference](#14-api-reference)
- [15. Tournament Mode](#15-tournament-mode)
- [16. Dart Builder / Loadouts](#16-dart-builder--loadouts)
- [17. Dartboard Zone / Miss / Bounce-Out Tracking](#17-dartboard-zone--miss--bounce-out-tracking)
- [18. League Mode](#18-league-mode)
- [19. Checkout Trainer](#19-checkout-trainer)
- [19a. "Drill this checkout" deep link](#19a-drill-this-checkout-deep-link)
- [20. New Game Screen (3-Step Wizard)](#20-new-game-screen-3-step-wizard)
- [21. Known Limitations & Open Gaps](#21-known-limitations--open-gaps)
- [22. Troubleshooting](#22-troubleshooting)
- [23. Saved Games / Pause & Resume](#23-saved-games--pause--resume)
- [24. Household Elo Rating](#24-household-elo-rating)
- [25. Handicapping](#25-handicapping)
- [26. 121 Checkout Ladder](#26-121-checkout-ladder)
- [27. The Gauntlet](#27-the-gauntlet)
- [28. Killer](#28-killer)
- [29. End-of-Night Session Recap](#29-end-of-night-session-recap)
- [30. Marathon Mode](#30-marathon-mode)
- [31. Shanghai](#31-shanghai)
- [32. Halve-It](#32-halve-it)
- [33. Dead Man Walking](#33-dead-man-walking)
- [34. The Pressure Chamber](#34-the-pressure-chamber)

---

## 1. Architecture

```
oche/
├── backend/
│   ├── server.js    Dependency-free HTTP server (Node built-ins only)
│   ├── db.js         SQLite schema, migrations, and all stat/business-logic queries
│   ├── auth.js        Password/PIN hashing (scrypt), session tokens, cookie helpers
│   ├── netguard.js    Outbound-request egress guard (SSRF/DNS-rebinding protection)
│   └── backup.js       Stand-alone WAL-safe backup script
├── frontend/
│   ├── index.html    The entire app — one self-contained HTML file (the controller)
│   ├── scoring.js    Pure scoring logic (evaluateVisit/evaluateVisitCricket/
│   │                 evaluateVisitBaseball/checkout math), extracted from
│   │                 index.html so it's unit-testable
│   └── display.html  Read-only live scoreboard for a second screen
```

- **Backend**: a single `http.createServer` with zero npm dependencies. Uses
  `node:sqlite` (`DatabaseSync`, built into Node 22.13+ — it exists as of
  22.5.0 but stays behind the `--experimental-sqlite` flag, which this project
  never passes, until 22.13.0) in WAL mode with foreign
  keys enabled. All statistics are computed from raw `turns`/`darts` data at
  query time — nothing is pre-aggregated, so a new metric never needs a
  migration or a backfill, and stats are always internally consistent.
- **Frontend**: `frontend/index.html` is a single file — HTML, CSS, and vanilla
  JavaScript in one `<script>` block, no build step, no framework. It requires a
  reachable backend at the same origin; there is no offline/local-storage
  fallback, so stats never split across two unsynced stores. `frontend/display.html`
  is a much smaller read-only client, driven entirely by Server-Sent Events.
  `frontend/scoring.js` is the one exception to "everything lives in the inline
  `<script>`" — `evaluateVisit()`, `evaluateVisitCricket()`, and the checkout
  route calculator were extracted there (docs/testing-and-observability-roadmap.md
  Part B) so they're reachable from a `node:test` file. It's still loaded the same
  no-build-step way, via a plain `<script src="scoring.js">` before the main
  script, and every name it defines is still a plain global exactly as before the
  extraction — a dual-mode CommonJS export block at the bottom only activates
  under Node (`typeof module !== 'undefined'`), so nothing changes in the browser.
- **Client-server sync**: the controller's `Backend` object wraps `fetch()` calls
  to the API; `DB` (in `index.html`) wraps the specific game/turn/badge/challenge
  endpoints and owns a small internal promise queue (`DB._queue`) so that
  order-sensitive writes (e.g. "record this turn" before "check Around the World
  progress") never race each other client-side.
- **Live scoreboard**: the controller POSTs the full game state to `/api/live`
  after every dart and every turn; `/display` subscribes to `/api/live/stream`
  (SSE) and re-renders on every push. Live state lives in memory only on the
  server — it is never written to the database. See [§7](#7-live-scoreboard--real-time-sync).
- **Game-type plugin seam**: `frontend/index.html` has a `GAME_TYPES` registry with
  `newMatchPlayer`, `evaluateVisit`, `resetForNextLeg`, `playerSnapshot`, and
  `statDefs` per type — `x01`, `cricket`, `baseball`, and `doubles_practice`, among
  others. `game.gameType` is stamped once in `startGame()`; every downstream caller
  (`enterTurn`, `startNextLeg`, `liveSnapshot`) dispatches through
  `GAME_TYPES[game.gameType]` instead of calling those functions directly, and
  `display.html`'s `renderers[s.gameType]` table reads the same field. Cricket's and
  Baseball's turn commit/leg-progression/scoring-screen rendering
  (`enterTurnCricket`/`enterTurnBaseball`, `onLegWonCricket`/`onLegWonBaseball`,
  `renderGameCricket`/`renderGameBaseball`, `renderPadCricket`/`renderPadBaseball`)
  are separate sibling functions dispatched from the shared
  `enterTurn`/`onLegWon`/`renderGame`/`renderPad` entry points, rather than branches
  inside the X01-heavy originals — neither has an achievements, bust concept, or
  checkout-hint equivalent, so forcing them through the same code would mean a lot
  of irrelevant branching. See §2 for Cricket's and Baseball's scoring rules.
- **Player Profile/Home page game-type toggle**: each `GAME_TYPES` entry also
  carries 3 UI-facing fields (game-modes-roadmap.md "Toggle mechanism
  generalized") — `label` (button text), `bubbleKeyMap` (patched on right after
  its own key-map `const` is defined, to dodge that const's temporal-dead-zone
  inside the earlier `GAME_TYPES` object literal), and `personalBestsRenderer`/
  `homeTabRenderer` (`null` means "use the built-in X01-shaped default" in
  `renderPersonalBests()`/`renderHomeTabBody()`, not a special case). Both
  toggles render via `Object.values(GAME_TYPES).filter(g=>g.statDefs &&
  g.statDefs.length).map(...)` instead of one hardcoded button per type — the
  Home page's toggle row, previously static HTML, is now populated by
  `renderHomeGameTypeTabs()`. Only the toggle *mechanism* is generalized this
  way — each type's own backend stat-fetch functions and stat shapes stay
  bespoke; see game-modes-roadmap.md for why that part is deliberately left
  unsolved. A `soloOnly:true` flag (currently just `GAME_TYPES.doubles_practice`
  — a game type with no H2H mode at all) additionally hides that type's Home
  page tab while the H2H top-level tab is selected (`renderHomeGameTypeTabs()`),
  and `switchHomeTab('h2h')` bounces `homeGameType` back to `'x01'` if a
  solo-only type was active, rather than leaving a hidden tab's solo data
  showing mislabeled as H2H content.
- **Game-lifecycle hooks** (`backend/db.js`, `docs/archive/existing-app-prep-roadmap.md`
  item 4): `onGameCreated(fn)`/`onGameCompleted(fn)` register listener callbacks;
  `createGame()`/`completeGame()` fire theirs synchronously, in registration
  order, right after their core DB write (`created` payload:
  `{gameId, gameType, practice, category, playerCount}`; `completed` payload:
  `{gameId, winnerName}`). A throwing listener is caught and logged, not
  rethrown, so a broken future feature can't take down game creation/completion
  itself. Does not touch the existing client-side achievement checks
  (`frontend/index.html`'s `enterTurn()`/`onLegWon()`), a different layer
  entirely. **First real consumer (2026-07): tournament mode** (§15) registers
  an `onGameCompleted` listener that checks whether the finished game is linked
  to a `tournament_matches` row and advances the bracket if so — exactly the
  "tournament bracket advancement" use case this was built ahead of.
- **Player-deletion guard extensibility** (`backend/db.js`,
  `docs/archive/existing-app-prep-roadmap.md` item 6): mirrors the game-lifecycle hook
  pattern above. `registerDeletePlayerGuard(fn)` registers a check function that
  receives the player row and returns either a non-empty string (the reason to
  block the delete) or a falsy value (no objection); `deletePlayer()` consults
  every registered guard before deleting and throws a 409 with the first
  blocking reason it finds. **First real consumer (2026-07): tournament mode**
  (§15) registers a guard blocking deletion of a player who's still `active` in
  an in-progress tournament — exactly the "mid-tournament competitor" case this
  was built ahead of.
- **Server error log** (`backend/db.js`'s `server_errors` table,
  `docs/testing-and-observability-roadmap.md` Part A): `server.js`'s top-level
  `catch` calls `db.logServerError({method, path, status, message})` alongside
  its existing `console.error`, for `status >= 500` responses only — a 4xx is an
  expected client mistake (bad login, invalid PIN), not a server fault worth a
  diagnostic entry. To keep that boundary honest, malformed client-controlled
  input that reaches a decode/parse — a bad percent-escape in a static path or
  session cookie (`decodeURIComponent`), or an unparseable request body
  (`JSON.parse`) — is caught and returned as a `400`, never allowed to fall
  through as a generic `500` (`docs/security-audit-roadmap.md` SEC-17); otherwise
  an unauthenticated caller could emit 500s at will and flush the whole 500-row
  window. `logServerError()` prunes to the most recent 500 rows on
  every insert (a rolling diagnostic tail, not a full audit log), so a
  crash-loop can't grow the table unbounded. `GET /api/errors` (admin-only,
  `?limit=`, capped at 500) feeds Settings → Admin & Danger Zone → **Server
  Errors**, so a self-hoster can see recent failures without shell/`docker
  logs` access. The DB write is itself wrapped in a `try/catch` in `server.js`
  so a failure to log (e.g. the very error being logged was a DB fault) can't
  throw a second, unhandled exception from inside the error handler.
- **Automated test suite** (`backend/test/`, `docs/testing-and-observability-roadmap.md`
  Part B): Node's built-in `node:test` + `node:assert` (zero new dependency), run
  via `npm test` in `backend/` (also wired into `.github/workflows/test.yml` on
  every push/PR), 161 assertions across 11 files. `scoring.test.js` covers the
  extracted pure scoring logic above; `db.*.test.js` files cover `backend/db.js`'s
  X01/Cricket stat formulas and leaderboards, checkout-route/dart-analytics
  functions, `getOnThisDay`'s priority ordering, H2H record/summary lookups, Daily
  Challenge streak/personal-best/reset-cascade logic, badge award/revoke
  semantics, the game-lifecycle hooks, `addTurn()`'s input validation, the auth
  model (login/PIN lockout thresholds, session lifecycle, admin CRUD), and player
  CRUD/cascade + the settings store — each against its own scratch SQLite
  database (a temp file, never `data/darts.db`). Per CLAUDE.md's testing
  convention, any new stat formula, achievement condition, or other calculation
  gets a test added to one of these files (or a new one) in the same change that
  adds it — this is a safety net around the highest-risk shared logic,
  deliberately not aiming for 100% coverage. Writing this suite surfaced and
  fixed three small, low-severity bugs found nowhere else: `addTurn()`'s
  `set`/`leg` and `scored` fields used a bare `x || default` fallback that
  silently coerced an explicit `0`/non-numeric garbage into a "valid" default
  instead of the rejection the validation's own stated intent calls for (now
  `x != null ? x : default`); and `addPlayer()` created a player with a PIN
  without `await`-ing the PIN hash write, so its own `hasPin` return value (and
  therefore `POST /api/players`'s HTTP response) could report `false` for a
  player that was, in fact, just given a PIN.

---

## 2. Core Scoring Engine

### X01 bust/win rules — `GAME_TYPES.x01.evaluateVisit(player, darts, game)` (`frontend/index.html`)

The signature is `(player, darts, game)` for every game type (X01 only reads
`player.score`/`player.doubleOut`; Cricket also reads `game.players` to check
opponents' closed-number status — see below).

```js
const startScore = player.score, doubleOut = player.doubleOut;
const points = darts.reduce((s,d)=>s+d.value,0);
const remaining = startScore - points;
const last = darts[darts.length-1];
if (remaining < 0) bust = true;
else if (doubleOut && remaining === 1) bust = true;          // "1" is unfinishable in double-out
else if (remaining === 0) {
  if (doubleOut && !(last && last.isDouble)) bust = true;    // hit zero, but not on a double
  else win = true;
}
```

This is the single source of truth for every bust/win/checkout decision in the
app. Three ways to bust:
1. **Overshoot** — the visit's total exceeds the remaining score.
2. **Leaves exactly 1 in double-out mode** — mathematically unfinishable (no
   double scores 1).
3. **Reaches exactly 0, but the last dart isn't a double, in double-out mode** —
   this is how a genuine 3×T20 (180) can still bust: it zeroes the score, but
   the final dart is a treble, not a double, so it doesn't count. This is the
   exact mechanism behind the **Busted Maximum** achievement (§4).

A bust's `scored` value is `0` (never the attempted points) — this bust-zeroing
is what every stat formula in §3 keys off of.

### Leg/Set/Game progression — `onLegWon(winnerIndex)`

Called from `enterTurn()` whenever `ev.win` is true. Order of operations:
1. `w.legsWon += 1`.
2. If `!game.practice && w.legsWon >= game.legsPerSet` → **set won**:
   `w.setsWon += 1`, everyone's `legsWon` resets to 0.
   - If `w.setsWon >= game.setsPerGame` → **game (match) won**: fires the
     `gameend`/`setend`/`legend` HA webhooks, records `game_end`/`set_end`/`leg_end`
     timeline events, calls `DB.completeGame()`, then evaluates the match-level
     achievements (Nerves of Steel, Giant Slayer, The Rematch, Grudge Match — §4)
     before rendering the Game Over screen.
   - Otherwise: fires `setend`/`legend` webhooks, evaluates set-decider Nerves of
     Steel, renders the Set Complete screen.
3. Otherwise → **leg won only**: fires `legend` webhook, checks for an active
   Daily Challenge completion (§6), renders the Leg Complete screen.

Practice mode (`game.practice === true`) never reaches the "set won" branch at
all — a practice session is just a sequence of legs, no set/match structure.

### Undo — snapshot-based, one level deep

Every call to `enterTurn()` builds a full snapshot (`_snap`) of the acting
player's pre-turn state — scores, per-leg/per-game running totals, and every
piece of achievement/challenge tracking state (`legVisitScores`, `metronomeFired`,
`pendingIceInTheVeins`, `legWorstDeficit`, `singlesHit`, `legVisitLogs` length) —
stored as `game.lastTurnSnapshot`. `undoLastTurn()` restores every one of those
fields verbatim, truncates the leg/session turn-history arrays back to their
pre-turn length, calls `DB.deleteLastTurn()` to remove the persisted turn row,
and revokes any badge that turn awarded (`snap.badgeReverts`, populated by
`trackBadgeForUndo()` every time `awardRecurringBadge()`/an async milestone
award runs — see §4/§5 for the undo-vs-async-award race handling). Only one
level of undo exists — `game.lastTurnSnapshot` is set to `null` immediately
after an undo, so undo cannot be chained. Cricket has its own, much smaller
undo (`undoLastTurnCricket()`, dispatched from `undoLastTurn()`) — `marks`/
`points`/dart counts, `legWorstPointsDeficit` (Comeback Kid (Cricket) — §4,
added 2026-07 alongside Whitewash), and `badgeReverts`/`voided` for the two
Cricket achievements (9 Marks, Perfect Leg) plus the two Cricket-native badges
(Whitewash, Comeback Kid (Cricket)) — no Daily Challenge integration, since
challenges are X01-only.

### Cricket rules — `GAME_TYPES.cricket.evaluateVisit(player, darts, game)` (`evaluateVisitCricket()`, `frontend/scoring.js`)

A match's in-play numbers are locked to exactly 7, chosen at New Game time:
classic (15, 16, 17, 18, 19, 20, Bull) or a custom 7-of-21 selection, stored as
`game.config.numbers`. Per-player state is `{marks: {sector: count, ...},
points}` — no `score` field, no bust concept.

**Two variants share this one engine** (`game.config.variant: 'standard' |
'cutthroat'`, missing/unrecognized treated as `'standard'` — `docs/archive/cutthroat-cricket-roadmap.md`):
- **Standard**: closing a number the shooter has but an opponent hasn't lets
  further hits on it score points onto the **shooter's own** total. Highest
  score (once every number is closed) wins.
- **Cutthroat**: the same marks/closing rules, but those points land on
  **every opponent who still has the number open** instead — each gets the
  **full** amount, not a split — and the shooter's own total never moves from
  their own hits. Lowest score (once every number is closed) wins.

**Marks accumulate dart-by-dart within a visit**, not per-visit-total — a
number can go from open to closed mid-visit, with the remaining darts in that
same visit scoring points on it:

```js
darts.forEach(d => {
  if (!numbers.includes(d.sector)) return;        // miss or out-of-play: no-op
  const before = marks[d.sector] || 0;
  const after = before + d.mult;                  // single=1, double=2, treble=3
  marks[d.sector] = after;
  const newBeyond = Math.max(0, after - 3) - Math.max(0, before - 3);
  if (newBeyond > 0) {
    const openOpponents = opponents.filter(o => (o.marks[d.sector] || 0) < 3);
    if (openOpponents.length) {
      const value = newBeyond * d.sector;          // Bull's "sector" is 25
      pointsThisVisit += value;                     // the visit's total GENERATED value, either variant
      if (cutthroat) openOpponents.forEach(o => gains.set(o, gains.get(o) + value)); // full value to EACH open opponent
    }
  }
});
```

A mark only scores points once the shooter has closed that number (3+ marks —
the closing marks themselves are worth 0) **and** at least one opponent hasn't
closed it yet. Opponents' closed status is read as of the start of the visit
(only the shooter's own marks change during their own turn, so no separate
snapshot is needed). Real-darts bull scoring is inherited for free from the
existing `makeDart()` guard — single bull is 1 mark, double bull is 2, and a
"treble bull" tap is silently downgraded to a single (no triple bull exists).

**Data model**: `turns.scored` is always the points this visit *generated*
(`pointsThisVisit`), attributed to the shooter's row, regardless of which
player(s) it actually lands on — a single cutthroat visit can score onto
several players at once, and `turns` rows belong to the shooter, so there's no
per-recipient row to attribute it to instead. Each player's own *received*
total (`player.points`) is a live, in-memory quantity the client mutates
directly (standard: the shooter's own; cutthroat: every hit opponent's) and
the saved-games replay (`rebuildCricketState()`, `docs/archive/saved-games-roadmap.md`)
reconstructs identically by replaying `evaluateVisitCricket()`'s
`opponentGains` across every recorded turn — it is never derived from
`turns.scored` at query time. Cricket's mark-based stats (MPR, 9 Marks — §3)
are unaffected by variant either way, since they read darts/marks, not
`points`; no points-based Cricket leaderboard exists today, so none needs
variant-scoping.

**Logging a real off-target hit vs. a genuine miss** (`docs/bug-roadmap.md`
BUG-23): `renderPadCricket()`'s main pad only ever shows the match's 7 in-play
numbers plus `Miss` — but a dart landing on one of the other 14 numbers (1-14
in classic Cricket) is a real board hit, not a miss, and worth recording
accurately for Dart Analytics (§3 "Top Finishes / Checkout Routes") even though it scores nothing here
either way. A collapsed-by-default "Hit a different number ▾" picker lists
those 14 numbers (`CRICKET_ALL_NUMBERS` in `frontend/scoring.js` — the full
1-20-plus-Bull pool — minus `game.config.numbers`); tapping one calls the
exact same `throwDart(n)` the 7 real target buttons use, so it respects the
ambient single/double/treble selector and needed zero scoring-logic changes —
the `if (!numbers.includes(d.sector)) return;` no-op above already treats any
non-target sector identically regardless of which one it is. Only the input
was ever missing a way to produce a real sector instead of `0`.

**Win condition**: this player has closed all 7 numbers **and** — standard —
has strictly more points than every opponent, **or** — cutthroat — has
strictly fewer points than every opponent, compared as of *after* this
visit's own gains are applied (a visit that closes the shooter's last number
can, in cutthroat, also be the one that pushes an opponent's total up in the
same visit). If they've closed everything but the points check fails, the leg
just continues — real cricket lets them keep throwing/blocking normally, and
the per-dart rule above already lets them score against any opponent still
open on a number they've closed, with no extra logic needed.

**Known open edge case, not silently resolved, same in both variants**: an
exact points *tie* at the moment the last number closes is not a win by this
rule — the leg continues with no tie-break implemented. Verified behavior
(not a bug): two players tied 0-0 when the second one closes their last
number keep playing.

Leg/set/game progression (`onLegWonCricket`) mirrors X01's `onLegWon`
structurally (legs/sets advance the same way, same `DB.completeGame`/HA
webhook calls). Cricket's achievements (9 Marks, Perfect Leg — variant-agnostic,
mark/dart-based — plus cutthroat's own 🔪 Stone Cold, §4) are detected in
`enterTurnCricket()`/`onLegWonCricket()`; carries no Daily Challenge
integration, since the Daily Challenge formats don't apply to Cricket.
Cricket's stat vocabulary is documented in §3 ("Cricket stats").

**Comeback Kid (Cricket)'s deficit direction flips with the variant**: the
running "worst points deficit seen this leg" (`p.legWorstPointsDeficit`,
sampled before each visit's own points update, since neither player's points
have changed yet at that moment regardless of variant) is `opponent.points -
my.points` in standard (higher is better, so trailing means the opponent is
ahead) and `my.points - opponent.points` in cutthroat (lower is better, so
trailing means *I've* received more). The threshold itself
(`CRICKET_COMEBACK_THRESHOLD`, 20) and the badge condition
(`cricketComebackAchieved()`) are unchanged either way — only which side
"ahead" points at is variant-aware, computed in `enterTurnCricket()` rather
than in the pure `cricketComebackAchieved()` predicate itself. Whitewash
("the opponent closed zero numbers") reads identically in both variants — it
was never a points-based condition to begin with.

### Baseball rules — `GAME_TYPES.baseball.evaluateVisit(player, darts, game)` (`frontend/scoring.js`'s `evaluateVisitBaseball`)

docs/game-modes-roadmap.md's "Baseball" — core playable game only (no stat
vocabulary/achievements yet, tracked as a separate open item). 9 innings, one
per number 1-9, fixed (`game.config = {innings: 9}`, not a New Game choice).
Unlike Cricket's independent per-player `marks`, **the current inning is
game-level state** (`game.baseballInning`) — every player in the match shares
one live inning, since real darts baseball has everyone throwing at the same
number in lockstep. Per-player state is `{totalRuns, inningRuns: {inning:
runs, ...}}` — no `score` field, no bust concept, same shape family as
Cricket's `marks`/`points`.

**Only the current inning's own number scores**, evaluated dart-by-dart within
the 3-dart visit — a single scores 1 run, a double 2, a treble 3; anything
else (a different number, or a genuine miss) scores 0 for that dart:

```js
const target = inning <= 9 ? inning : 9;   // baseballInningTarget()
darts.forEach(d => { if (d.sector === target) runsThisVisit += d.mult; });
```

**The round only completes once the LAST player in the rotation has thrown**
(`isRoundComplete(game)`: `(game.current + 1) % game.players.length ===
(game.starter || 0)` — starter-RELATIVE, because `startNextLeg()` rotates
`game.starter` each leg, so the leg's final thrower is the player just before
the starter, not index n-1; read before `game.current` advances — the same
timing every other `evaluateVisit*()` relies on). A solo practice game is
always "last in rotation," so it advances one inning per visit. The **win condition is only checked on that round-completing visit,
and only once inning 9 has been reached**: every player's total (including
the just-evaluated visit) is compared, and the match ends only if there's a
single unique highest total — an exact tie among the leaders continues into
extra innings instead, still targeting number 9 (`baseballInningTarget()`
repeats 9 rather than cycling back to 1 — a judgment call, since the rules
primer this was built from doesn't specify an extra-innings target number).

Because the round-ending visit and the actual highest scorer aren't always
the same player (unlike X01/Cricket, where a win is always self-referential —
the player whose visit just ran is always the winner), `evaluateVisitBaseball()`
returns `{ matchComplete, winnerIndex }` rather than a simple `win: true`
implicitly meaning "this player." `enterTurnBaseball()` calls
`onLegWonBaseball(ev.winnerIndex)`, not `onLegWonBaseball(game.current)`.

Visit-based (3 darts per turn), same undo shape as X01/Cricket
(`undoLastTurnBaseball()`, dispatched from `undoLastTurn()`) — restores
`totalRuns`/`inningRuns`/dart counts and `game.baseballInning` from
`game.lastTurnSnapshot`. Leg/set/game progression (`onLegWonBaseball`)
mirrors `onLegWonCricket()` structurally **with one deliberate divergence**:
its outer gate is `if(w.legsWon >= game.legsPerSet)`, not X01/Cricket's
`if(!game.practice && ...)`. Practice-mode Baseball is forced to exactly
`legsPerSet=1`/`setsPerGame=1` at `startGame()` (`isPracticeBaseball`, the
same treatment every drill mode gets — Ghost, Chuckin, Doubles Practice,
etc.), so a practice Baseball leg *is* the whole game, unlike X01/Cricket's
genuinely open-ended practice legs. This is required, not cosmetic: unlike
X01/Cricket (whose leg-level stats read `turns.leg_won`, independent of
`games.completed_at`), every one of Baseball's own stat functions
(`getBaseballWonLegs()`, `gamesPlayed`/`winPct` in
`getBaseballStatBubbles()`) requires `g.completed_at IS NOT NULL` as its only
"this is a real result, not an abandoned mid-leg" signal — and
`DB.completeGame()` only ever fires from this same gate. Copying X01/Cricket's
`!game.practice` gate wholesale (as an earlier version of this function did)
meant a practice Baseball game could never be marked complete at all, so
`gamesPlayed`/Personal Bests stayed empty forever regardless of how many
practice games were played — `docs/bug-roadmap.md` BUG-22. H2H Baseball is
unaffected by this — `legsPerSet`/`setsPerGame` stay whatever the New Game
wizard's Bo3/Bo5/etc. picker set, so a genuine multi-leg H2H match still
requires every configured leg before completing. No achievements or Daily
Challenge integration (X01/Cricket's own don't apply to Baseball either). Scoring
screen (`renderPadBaseball`) reuses Cricket's exact "select a multiplier,
then tap the target" interaction with a single target button (this inning's
number) instead of Cricket's seven. Live scoreboard (`renderers.baseball` in
`display.html`) is the same chalkboard-table shape as Cricket's (rows =
innings 1-9, columns = players), always single-column regardless of
orientation. Baseball's stat vocabulary is documented in §3 ("Baseball stats").

### Bob's 27 rules — `GAME_TYPES.bobs_27.evaluateVisit(player, darts, game)` (`evaluateVisitBobs27()`, `frontend/scoring.js`)

`docs/archive/practice-ladders-roadmap.md` Part A — Bob Anderson's doubles-
practice routine. Solo only (`GAME_TYPES.bobs_27.soloOnly = true`), visit-based
(3 darts per round) like Baseball, with the same "always exactly one player,
`game.current` never moves" shape. Starts on 27; **the current round IS the
live double target** — round 1 targets D1, round 2 D2, ... round 20 D20, one
number per round, never repeating. Game-level round counter (`game.bobs27Round`,
mirroring `game.baseballInning`) rather than per-player, since the mode is
always solo.

**Each round's outcome is all-or-nothing per dart, summed**: every dart that
lands on *that round's own double* (`sector === round && multiplier === 2`)
adds `round * 2` to the running score; a round with zero such hits subtracts
`round * 2` instead — there's no partial credit for landing a single or treble
on the right number, and no penalty scaling by "how many darts missed":

```js
const hits = darts.filter(d => d.sector === round && d.isDouble).length;
const gain = hits * round * 2;
running += gain > 0 ? gain : -(round * 2);
```

A run ends the moment `running <= 0` (**dead**) or after round 20 completes
(survived) — both set `matchComplete`, checked identically to Baseball's
`ev.matchComplete` dispatch. `evaluateVisitBobs27()` returns `{running, gain,
scored, hits, dead, matchComplete, round}` — `scored` is deliberately just an
alias for `gain` (never negative), not the actual signed change to `running`;
see "store the gain, derive the penalty" below.

**"Store the gain, derive the penalty"**: `turns.scored` only ever holds a
round's *positive* gain (`0` on a miss-all round) — the penalty is never
written as a negative number anywhere. Both the live client and
`rebuildBobs27State({turns})` (the pure resume/replay rebuilder, `frontend/
scoring.js`, same "replay every turn with zero side effects" contract as
Baseball's and X01's own rebuilders) derive the actual running-score delta at
read time from `scored > 0 ? scored : -2*round` — `round` itself is never
stored either, always re-derived as that turn's own 1-indexed position within
the game (`ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY id)` server-side;
a plain loop counter client-side, since a player only ever has one turn per
round). This is the same design `docs/archive/halve-it-roadmap.md` proposed for a
similar "hit gains, miss loses" shape, applied here for the first time.

**Write-time guard** (`addTurn()`, `backend/db.js`, SEC-25-style, opted in via
`{enforceConsistency:true}`): rejects `checkout=true` outright (no checkout
concept); derives `round` from this player's own prior-turn count in this
game/set/leg (`+1`), rejecting anything past round 20; replays every prior
turn's `scored` to reconstruct the running score entering this round; computes
`expectedGain` from the submitted darts the same `hits * round*2` formula
above; 400s if `scored !== expectedGain`; computes `expectedRunning` from that
and 400s if the submitted `bust` flag doesn't match `expectedRunning <= 0`.
Never trusts the client's own `ev.dead`.

**Undo** (`undoLastTurnBobs27()`, dispatched from `undoLastTurn()`) — same
`lastTurnSnapshot` shape as Baseball's, restoring `running`/`roundResults`/
dart counts/`game.bobs27Round` and calling `DB.deleteLastTurn()`.

**"A run IS the game"** (practice Baseball's BUG-22 precedent, §2's own
Baseball write-up above): `legsPerSet`/`setsPerGame` are forced to 1 at
`startGame()` (bobs_27 is in `drillModes`), so the very first `matchComplete`
(survive-to-20 or die) auto-completes the whole game via the same generic
leg/set/game progression tree every other mode uses (`onLegWonBobs27`, mirrors
`onLegWonBaseball`'s structure including its "structurally unreachable but
kept for tree consistency" leg/set branches). Its own moment card picks a
survived-vs-died headline (`'RUN COMPLETE!'`/`'RUN OVER'`, `🎯`/`💀`) since
X01/Baseball's generic "MATCH WON!" framing reads wrong for a run that ended
in death. Bob's 27's stat vocabulary is documented in §3 ("Bob's 27 stats");
its badges in §4.

### Doubles Practice per-dart rules — `evaluateDartDoublesPractice(dart, targets)` (`frontend/scoring.js`)

docs/game-modes-roadmap.md's "Doubles Practice" drill mode — genuinely
different from every other game type: evaluated **per dart**, not per 3-dart
visit. A session-ending event can fire on dart 1, 2, or 3 of what would
otherwise be a visit, so `throwDart()` routes straight to
`throwDartDoublesPractice()` (a dedicated `game.gameType==='doubles_practice'`
branch, the same "hardcode a branch" precedent Cricket already established at
every one of its own call sites) instead of batching into `game.darts` at all.
Every dart commits immediately as its own 1-dart `turns` row (`addTurn()`
already allows 1-3 darts per turn); there is no "Enter turn" step for this mode.

Solo drill, no opponent, no legs/sets in the usual sense — a **round** is one
continuous session from the first dart until it ends, tracked via
`game.legNo` (reused as "round number," incremented by
`startNextRoundDoublesPractice()` each time a round ends — a plain counter, not
a real leg/set structure). `game.config.doubles` is the target set: an array of
sectors, 1-20 plus 25 for double-bull, chosen at New Game time via the same
multi-select-grid mechanism as Cricket's custom targets (no fixed count
requirement, unlike Cricket's locked-to-7 rule).

**"All simultaneously live"** (2026-07 decision) — every selected double is
live at once; no rotation, no random pick. The player throws at whichever
target they choose each dart:

```js
function evaluateDartDoublesPractice(dart, targets){
  if(dart.isDouble){
    if(targets.includes(dart.sector)) return { hit:true, ended:false, reason:null };
    return { hit:false, ended:true, reason:'wrong-double' };
  }
  if(dart.sector === 0) return { hit:false, ended:true, reason:'miss' };
  if(targets.includes(dart.sector)) return { hit:false, ended:true, reason:'so-close' };
  return { hit:false, ended:true, reason:'wrong-number' };
}
```

**Only a double on a target number keeps a round alive — every other outcome
ends it (2026-07 fix — see below)**:

- A **double on a target number** is a hit — the round continues, and
  `p.roundHits` increments.
- A **double on a number NOT in the target set** is "wrong double" — ends the
  round immediately.
- A **single OR treble on a target number** is "so close" — landed on the
  right number, just not through the double ring — and also ends the round.
  The roadmap doc's own text only calls out "a single" explicitly, but a treble
  on the target number is the identical miss (wrong ring, right number), so
  it's treated the same way — a deliberate completeness decision, not a new
  failure mode the roadmap didn't anticipate.
- A **single OR treble on a number NOT in the target set** is "wrong number" —
  also ends the round. (Fixed 2026-07: this used to be a silent no-op that let
  the round continue — a hit anywhere on the board other than a target's own
  single/treble was wrongly forgiven. A drill where any non-target-double dart
  is free defeats the point of the drill, so this now ends the round like every
  other non-hit outcome.)
- A **genuine total miss (sector 0)** also ends the round, for the same reason.
  Real double-bull scoring is inherited for free from `makeDartCore()`'s
  existing guard — an attempted "treble bull" tap is silently downgraded to a
  single, scored as "so close" if bull is a target, exactly like every other
  game type.

**Persistence**: every dart is recorded via `DB.recordTurn()` with `scored:0`
always (no numeric score concept in this mode), `bust: !!ev.ended` (repurposed
as "this dart ended the round," the closest existing column to that meaning —
`checkout`/`legWon` stay `false`/`0` always, since this mode has no win
condition to signal). No undo support in this v1 (a known, documented gap —
`game.darts` is never populated for this mode, so `undoDart()`/`undoLastTurn()`
don't apply; a misthrow just becomes part of the round's own tally).

Stat vocabulary is documented in §3 ("Doubles Practice stats").

### Just Chuckin' It — `throwDartChuckin(sector)` (`frontend/index.html`)

docs/game-modes-roadmap.md's "Just Chuckin' It" drill mode — freeform, entirely
unscored practice. No starting score, no bust, no win, no opponent, and unlike
Doubles Practice, **no round/leg concept at all**: a whole session is one
continuous stream of darts from the first throw until "End game" is pressed,
every dart its own 1-dart `turns` row sharing `set_no=1, leg_no=1` for the
entire session (a "session" = one `games` row, grouped by `t.game_id` in every
backend query — not `(game_id, set_no, leg_no)` the way every other game type
groups).

`throwDartChuckin()` is a dedicated `game.gameType==='chuckin'` branch (the same
"hardcode a branch at every call site" precedent as Doubles Practice —
`throwDart`, `renderGame`, `renderPad`, `undoLastTurn`, `liveSnapshot`,
`renderGameShell` all branch on this game type):

```js
function throwDartChuckin(sector){
  const dart = makeDart(sector, mult);
  const p = game.players[0];
  p.sessionDarts += 1;
  if(dart.isTreble) p.sessionTrebles += 1;
  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:0, bust:false, checkout:false, checkoutPoints:null, legWon:false,
    darts:[{ dartNo:1, sector:dart.sector, multiplier:dart.mult, thrownAt:dart.thrownAt }] });
  game.chuckinLastDart = { label:dart.label, isTreble:!!dart.isTreble };
  checkChuckinMilestones(p);
}
```

- Every dart is simply recorded — `scored`/`bust`/`checkout`/`legWon` are always
  `0`/`false`, since this mode has no numeric score and never busts or wins.
- **Undo is supported** (`undoLastTurnChuckin()`), one dart deep, restoring the
  session counters from a snapshot taken before the mutation and deleting the
  persisted turn — matching the one-level-deep undo convention used everywhere
  else in the app.
- After every dart, `checkChuckinMilestones(p)` checks the 3 milestone ladders
  (§4 "The 18 Just Chuckin' It milestone badges") entirely from **local**
  per-player state (`p.sessionDarts`/`p.sessionTrebles` plus a
  `lifetimeDartsBase`/`lifetimeTreblesBase` fetched once at game start) — not a
  network round-trip per dart. An earlier revision that re-queried the
  stat-bubbles endpoint after every single dart was found, during Playwright
  testing, to occasionally lose darts outright: at high enough throw rates it
  tripped the server's per-IP rate limiter, and a 429 on the `recordTurn` write
  itself is silently swallowed by `DB._queue`'s catch (see §9 "Rate limiting").
  Since this mode's entire premise is rapid successive throws, doubling the
  request rate per dart was a real risk, not a hypothetical one.

**Stats-leak exclusion** — the opposite of how Cricket was added. Cricket's
darts were deliberately folded INTO existing unscoped "all game types"
aggregates; Just Chuckin' It needs the reverse. A `NOT_CHUCKIN` SQL constant
(`` `AND g.game_type != 'chuckin'` ``, `backend/db.js`) excludes this game type
from 5 previously-unscoped "physical dart stats" queries: `getDartAnalytics()`,
`getAroundTheWorldProgress()`, `getHomeExtra()`'s `_pace()`/`todayLegs`/
`weekLegs`, and the `practiceLegs` counts in `getSummary()`/`computeStats()`.
Deliberately **not** folded into the central `_mf()`/`_scope()` helpers (§3
"Game scope filter helper"), since Chuckin's own stat functions explicitly scope
`gameType:'chuckin'` and would contradict a blanket exclusion placed there.

**The one documented exception, per explicit design intent**: total darts
thrown (lifetime, daily, and weekly) is NOT excluded — `getSummary().darts`,
`computeStats()`'s `allCounts` aggregate, and `getHomeExtra()`'s
`todayDarts`/`weekDarts` all remained fully unscoped with zero code changes,
since "darts thrown" already meant every physical dart thrown, Chuckin included
— the same design already documented for Cricket's darts (§3's denominator
table), just re-confirmed rather than re-derived for a fourth game type.

Stat vocabulary is documented in §3 ("Just Chuckin' It stats").

### Guided Around the Clock / Around the World — `throwDartAroundTheClock(sector)` / `throwDartAroundTheWorld(sector)` (`frontend/index.html`)

docs/game-modes-roadmap.md's "Guided Around the Clock / Around the World" drill
modes — two new game types, `around_the_clock` and `around_the_world`, each an
active practice-drill wrapper around a completion condition that already
existed passively (§4's `around_the_clock`/`around_the_world` badges). No
schema changes — both just added to `KNOWN_GAME_TYPES` (`backend/db.js`).

**Around the Clock** is structurally identical to Doubles Practice: a
**round** is one continuous session tracked via `game.legNo` (reused as
"round number," incremented by `startNextClockRound()`), ending the instant
all 20 numbers 1-20 have been hit as singles. The target set is **20 numbers
only, no bull** — matching the existing passive `around_the_clock` badge's
exact formula (`singlesHit.size >= 20`), a deliberate 2026-07 decision that
overrides this doc's own earlier draft wording of "+bull." The pure per-dart
rule lives in `frontend/scoring.js`:

```js
function evaluateDartAroundTheClock(dart, hitSet){
  const isSingleTarget = dart.sector >= 1 && dart.sector <= 20 && dart.mult === 1;
  const isNewHit = isSingleTarget && !hitSet.has(dart.sector);
  const completed = isNewHit && (hitSet.size + 1) === 20;
  return { isNewHit, completed };
}
```

- A **single on a number not yet in `hitSet`** is a new hit; `completed`
  fires exactly once, on the dart that brings the set to size 20.
- A **treble/double on a number, or any dart on bull** (sector 25, either
  multiplier) is a real dart thrown but never a hit — the "so close, not a
  hit" precedent Doubles Practice already established for its own targets,
  just with no round-ending failure mode here (this mode never "loses").
- `turns.bust` is repurposed exactly the way Doubles Practice repurposes it:
  `1` marks whichever dart completed the round (there is no "so-close"/
  "wrong-target" failure mode to distinguish here, only completion or
  abandonment — a round with no `bust=1` dart yet was abandoned, not
  completed).

**Around the World** is structurally identical to Just Chuckin' It: no round
boundary at all, one continuous stream of 1-dart turns per `games` row
(`set_no=leg_no=1` throughout), tracking progress toward the same lifetime
63-outcome set `getAroundTheWorldProgress()` already computes — **not** reset
per session, and the session never force-ends (reaching 63/63 is a notable
event, not a stop condition). `newMatchPlayerAroundTheWorld()` fetches the
lifetime baseline **once** at game start via the existing
`GET /api/players/around-the-world` endpoint, the same
`lifetimeDartsBase`/`lifetimeTreblesBase`-style precedent Chuckin's
`newMatchPlayerChuckin()` established, to avoid a per-dart network round-trip
and the rate-limiter/dropped-dart risk documented above for Chuckin.

**Undo** is supported for both, one dart deep, mirroring
`undoLastTurnDoublesPractice()`/`undoLastTurnChuckin()`'s snapshot-restore
shape exactly — including `badgeReverts`/`voided` plumbing (§4 "Undo
interaction") so undoing a round-completing (Clock) or lifetime-completing
(World) dart un-earns the `guided_clock`/`guided_world` badge it awarded.

**Live progress feedback** — the whole point of making these dedicated modes
rather than leaving the underlying tracking passive: a persistent on-screen
progress grid, `buildOutcomeGridHtml(hitSet, {cells, live})` (`frontend/
index.html`), extracted from what used to be inline inside
`renderAroundTheWorldProgress()` so the Player Profile's static "Around the
World Progress" section (§3) and both drills' live in-game views share one
implementation. `cells:'numbers'` renders the 20-cell Clock grid;
`cells:'all'` (default) renders the full 63-outcome World grid. `live:true`
wraps the grid in an `aria-live="polite"` region so screen readers announce
each new hit during an active drill (§11 accessibility — each cell also
carries a non-color checkmark + `aria-label`, closing a color-only gap that
existed in the original static grid too, upgraded for free by the
extraction). `frontend/display.html` gets its own compact mirror-copied port,
`buildOutcomeGridCompact()`, following the same "no shared module between the
two files" precedent Chuckin's live heatmap (`buildChuckinLiveHeatmap()`)
already established.

**Leg/pace exclusion** — Around the World shares Chuckin's exact "no round
boundary, one continuous stream" shape, so a new `NOT_CONTINUOUS_STREAM` SQL
constant (`` `AND g.game_type NOT IN ('chuckin','around_the_world')` ``,
`backend/db.js`) excludes it from the same leg-count/pace aggregates Chuckin
is excluded from via `NOT_CHUCKIN`: `getSummary()`/`computeStats()`'s
`practiceLegs`, `getHomeExtra()`'s `todayLegs`/`weekLegs`/`_pace()`. Around
the Clock — a genuine round=leg boundary, the same shape as Doubles Practice,
which is *not* excluded from these — stays included in all of them.
`getDartAnalytics()` and `getAroundTheWorldProgress()` deliberately keep
using the narrower `NOT_CHUCKIN` instead of the new constant: cross-game-type
sector analytics should include targeted-practice darts (the existing
Doubles Practice precedent), and excluding either new type from
`getAroundTheWorldProgress()` would break the very feature that query exists
to feed.

Stat vocabulary is documented in §3 ("Guided Around the Clock / Around the
World stats").

---

## 3. Statistics — Every Formula

Sections 3.1-3.N below are X01-only, read via `GAME_TYPES.x01.statDefs`
(`STAT_DEFS`). Cricket has its own separate stat vocabulary
(`GAME_TYPES.cricket.statDefs` / `CRICKET_STAT_DEFS`) — see "Cricket stats" at
the end of this section for its formulas (game-modes-roadmap.md build-order
step 3).

**How cricket games interact with these X01 stats** (`X01_ONLY` constant in
`backend/db.js`, now defined as `_scope({gameType:'x01'})` — see "Game scope
filter helper" below): cricket turns live in the same `turns` table, but
`turns.scored` means *cricket points earned* there, not X01 countdown points —
so every formula derived from `scored` (or from leg averages / trebleless legs /
180 detection) carries an explicit `g.game_type='x01'` filter. Without it, a
9-mark cricket visit on 20s (180 cricket points) counts as a "180" and cricket
points corrupt every average — this was found and fixed in the post-Cricket
audit. The exact split:

| Category | Cricket games… | Why |
|---|---|---|
| `scored`-derived (3-dart avg, 180s, 180s/leg, 100+/90− leg averages, trebleless %, recent-form avg, On This Day's 180 detection, metric-history equivalents) | **Excluded** (`X01_ONLY`) | `scored` means a different quantity in cricket |
| Opening-window stats (1st 3/1st 9 avg, 140/leg, Best First-9, Best First-9 Average leaderboard) | Excluded already | `OPENING_CATS` requires `game_type='x01'` plus `config.startingScore` in `(501,301,170,101)` |
| Checkout-based (Big Fish, ton+ finishes, highest checkout, checkout routes, fewest darts to finish, darts/leg, best leg avg) | **Excluded** (`X01_ONLY`) | cricket never writes `checkout=1`, but the 121 Checkout Ladder and Dead Man Walking now DO (a real `checkout=1` + `checkout_points` on a won round that isn't an X01 leg), so these can no longer rely on "only X01 writes `checkout=1`" — every checkout-based read is explicitly `X01_ONLY`-scoped (`docs/bug-roadmap.md` BUG-27). This covers `getSummary()`'s Ton+/Big Fish, `getPlayerStatBubbles()`'s Big Fish bubble, `getHomeExtra()`'s Ton+-rate/highest-checkout, `getBigFishStats()`, `getTopFinishesAll()`/`getTopFinishes()`, `getCheckoutRoutes()`, `getOnThisDay()`'s 170/100+ tiers, `getSessionRecap()`'s Ton+/highest-checkout/fewest-darts/moments, `getMetricHistory('bigfish')`, and `getPersonalBests()`'s own checkout fields |
| Physical-dart stats (Darts Thrown, Darts/Day, Average Pace, dart analytics sector/treble maps, Around the World progress) | **Included** | a dart thrown in cricket is a real dart; these count physical throws, not X01 arithmetic |
| Games / wins / win rate / win streak / H2H records / activity counters (legs, sets, darts, turns, today/this-week) | **Included** | a completed cricket H2H match is a real match; "Games Played" counts completed H2H matches of any game type. Per-category legs/sets **won** (`computeStats()`'s `h2hLegsWonByCat`/`h2hSetsWonByCat`) are built from `_h2hWonLegs()`, which credits each completed H2H leg to its real winner **per game type** — the `(checkout=1 OR leg_won=1)` winning-turn signal for X01/Cricket/Baseball/Checkout Ladder, `getShanghaiWonLegs()`'s hybrid for Shanghai, `getHalveItWonLegs()`'s final-total comparison for Halve-It, the highest-CP leg winner (`_pressureChamberLegTotals()`) for The Pressure Chamber, and a `rebuildKillerState()` replay for Killer (whose turns carry NO winner signal at all — its `addTurn()` branch rejects `checkout` and never writes `leg_won`, so the signal-based query counted every Killer record as 0 legs forever). This replaced a raw `(checkout=1 OR leg_won=1)` turn count that assumed one signal per won leg — true for X01/Cricket but not The Pressure Chamber (per-round `checkout=1`, so a run counted as up to 15 won legs) or Halve-It/Shanghai (points-wins carry no signal, so they counted 0) — `docs/bug-roadmap.md` BUG-29. The roster/profile "turns"/"darts thrown" totals are likewise unscoped (a cricket visit is a real visit); only the X01-scoped copies inside `h2hStats`/`practiceStats` feed the averages, and the H2H "avg darts per leg" (`h2hAvgDarts`) is `X01_ONLY` for the same reason (BUG-29) |

All formulas below are in `backend/db.js`. Two facts drive almost every one of
them:

- **`turns.scored` is already `0` for a busted visit** — the bust-zeroing
  happens app-side before the turn is even persisted. No stat formula needs to
  (or should) re-derive "did this bust" from raw dart values.
- **The "3-dart average" convention charges a bust as 3 darts in the
  denominator**, regardless of how many darts were actually thrown before the
  bust (`CASE WHEN t.bust=1 THEN 3 ELSE COUNT(d.id) END`). This is *not*
  universal — see the "Denominator conventions" table at the end of this
  section, because **not every "average"-sounding stat uses this convention**,
  and conflating them is the single most common source of "why don't these two
  numbers agree" confusion.

### Mode scoping (`_mf(mode)`, used almost everywhere)

- **H2H**: `g.practice = 0 AND g.player_count > 1`
- **Practice**: `g.practice = 1 OR g.player_count = 1` (explicit practice flag,
  OR any solo/1-player game — a 1-player "H2H" that never got a second
  participant still counts as practice)
- `g.player_count` is a column **frozen at game creation** (not a live
  `COUNT(game_players)`), specifically so deleting a participant later can never
  retroactively reclassify a game from H2H to practice.

### Home page (`getSummary()`, `getHomeExtra()`)

| Stat | Scope | Formula |
|---|---|---|
| `players` | unscoped | `COUNT(*) FROM players` |
| `games` | **H2H only — by design** | `COUNT(*) FROM games WHERE completed_at IS NOT NULL AND practice = 0 AND player_count > 1`. Practice, solo, and Daily Challenge sessions deliberately do **not** count as "Games Played" (product decision, 2026-07); completed cricket H2H matches **do** count (they're real matches — see the cricket-interaction table above). The explicit filter makes the practice exclusion intentional; independently, `completed_at` is only ever set on an H2H match win (`POST /api/games/:id/complete` is called from `onLegWon()`'s and `onLegWonCricket()`'s match-win branches — End Game navigates away without completing), so the filter is belt-and-braces rather than load-bearing today. |
| `sets` / `legs` | **H2H only** | Distinct `(game,set)` / `(game,set,leg)` combos with ≥1 turn recorded — **no completion requirement**, an in-progress leg still counts |
| `darts` | fully global | `COUNT(*) FROM darts` |
| `tonPlus` | fully global | `COUNT(*) FROM turns WHERE checkout=1 AND checkout_points>=100` |
| `oneEighties` | fully global | `COUNT(*) FROM turns WHERE scored=180` |
| `bigFish` | fully global | `COUNT(*) FROM turns WHERE checkout=1 AND checkout_points=170` |
| `nineDarters` | fully global | see "Nine-darter definition" below |
| `practiceLegs` | practice/solo only | same shape as `legs`, practice-scoped |

**Home page leaderboards** (`getHomeExtra()`):
- **Win leaderboard**: `won/played*100`, H2H-only, completed games only, `HAVING played >= 1`.
- **Fewest Trebleless Visits leaderboard**: `SUM(no-treble turns)/turns*100` —
  **per-turn** (not per-leg — see the Player Profile's `treblelessPct`, which is
  per-leg), `HAVING turns >= 10`. Ranked **ascending** deliberately: a trebleless
  visit is a visit that failed to find a treble, so fewer is better and rank #1 is
  the lowest rate (the leaderboard was titled "Most Trebleless Visits" until the
  2026-07 audit; the ordering was always ascending — the title was what changed).
- **Ton+ leaderboard**: `SUM(checkouts >=100)/checkouts*100` — rate among a
  player's own *finishing* visits, `HAVING checkouts >= 3`.
- **Best First-9 Average leaderboard** (`first9Rows`, docs/archive/first-nine-average-
  roadmap.md): each player's own per-leg 1st 9 AVG (`OPENING_CATS`-scoped,
  bust-as-3-darts denominator), averaged across their eligible legs, `HAVING
  legs >= 20` — the same lifetime-legs floor `COACHING_MIN_LEGS_FOR_FORM` uses
  elsewhere in this file, chosen so one or two lucky opening legs can't top the
  board over a genuinely well-established start. Ranked **descending**
  (unlike Fewest Trebleless Visits above) — a higher first-9 average is better.
- **Highest checkout**: `MAX(checkout_points)`, ties broken by earliest date; `overall`/`h2h`/`practice` variants.
- **Today/week activity**: legs/darts with `date(created_at)` today or in the
  trailing 7 days — **not mode-scoped** (H2H and practice both count), and not
  timezone-shifted (raw UTC date boundary).
- **Dart pace**: `60000 / AVG(gap between consecutive dart timestamps)`,
  clamped to `0 < gap < 60000ms`; only populated when "Collect per-dart timing" is on.

**Nine-darter definition** (used identically everywhere it appears): a leg in
category `'501'` where the player recorded exactly 3 turns, one of which was a
checkout, and exactly 9 total darts were thrown across those 3 turns. Locked to
`category='501'` specifically.

### Player Profile stat bubbles (`getPlayerStatBubbles(name, mode)`) — all 15

| Bubble | Denominator family | Formula |
|---|---|---|
| **Darts Thrown** | raw | `COUNT(*)` from `darts` |
| **Average** | 3-dart-avg | `totalPts / avgDarts * 3` where `avgDarts` sums `bust?3:COUNT(darts)` per turn |
| **180s** | raw count | `COUNT(*) WHERE scored=180` |
| **Big Fish** | raw count | `COUNT(*) WHERE checkout=1 AND checkout_points=170` |
| **9 Darters** | leg-level | nine-darter definition above, scoped to this player |
| **Darts / Day** | raw | `dartsThrown / COUNT(DISTINCT date(created_at))` |
| **Darts / Leg** | raw | `AVG(darts in leg)`, **won legs only** (`HAVING SUM(checkout)>0`) |
| **Trebleless %** | per-leg | `% of legs where SUM(is_treble)=0 across every dart in the leg` |
| **1st 3 AVG** | first-visit-only | `AVG(scored)` of each leg's first visit (`ROW_NUMBER()...rn=1`). **Scoped to exactly 501/301/170/101** — see below. |
| **1st 9 AVG** | 3-dart-avg | Sum of the first ≤3 visits' `scored`, over the bust-as-3 dart denominator, ×3, averaged across legs. **Scoped to exactly 501/301/170/101.** |
| **100+ AVG** | per-visit-avg | `% of legs where SUM(scored)/COUNT(turns) >= 100` — **note this denominator is turns, not darts** (see conventions table) |
| **90- AVG** | per-visit-avg | same shape, `<= 90` |
| **140/Leg** | first-visit-only | `% of opening visits scoring >=140`. **Scoped to exactly 501/301/170/101.** |
| **180s/Leg** | fraction | `legs containing ≥1 180 / total legs` |
| **Average Pace** | — | darts/minute, returned as the `pace` key — same formula as the Home page/chart versions (consecutive `thrown_at` gaps within a turn, clamped to `0 < gap < 60000ms`); `null` (bubble shows "—") until per-dart timing data exists. *Note: this key was missing from `getPlayerStatBubbles()`'s return object until the audit that produced this manual caught it — the bubble was permanently blank before that.* |

**Why 1st 3 AVG / 1st 9 AVG / 140/Leg are scoped to exactly 501, 301, 170, and 101
— never any other X01 starting score, and never any other game type — ever,
unless a future change explicitly says otherwise (2026-07 product decision)**:
these three "opening exchange" stats only mean something for the app's standard
X01 formats. A 170 leg was previously excluded on the theory that it's too short
for "opening darts" to be meaningful (it can finish, or bust, on the very first
visit) — that reasoning is superseded by the explicit decision to include it, so
it no longer applies. What's still excluded: any custom/non-standard X01 starting
score (e.g. a 701 leg) and Daily Challenge's non-scoring formats (Bullseye
Gauntlet, Steady Hand, Treble Run), which use a filler `1000` starting category
that isn't a real X01 leg at all — and, as always, every non-X01 game type
(Cricket, and whatever comes after it). This restriction is applied via
`AND g.game_type='x01' AND json_extract(g.config,'$.startingScore') IN
(501,301,170,101)`, referred to in the code as `OPENING_CATS` — checking
`game_type` explicitly (not just matching on `category`, a human-readable label)
means a future game type's category string can never accidentally collide with
these four values the way a bare string match could. If a future starting score
is added to X01 (per `docs/game-modes-roadmap.md`), it does **not** automatically
join this scope — it must be added to this exact `IN (...)` list explicitly, the
same deliberate step that added 170 and 101 here. `OPENING_CATS` is a
module-level constant in `backend/db.js` (declared beside `X01_ONLY`) — Best
First-9 (`getPersonalBests()`) and the Best First-9 Average leaderboard
(`getHomeExtra()`) both reuse it directly rather than a second copy of the
string, so all four "opening exchange" surfaces (2 stat bubbles, 1 Personal
Best, 1 leaderboard) can never drift out of scope with each other.

**Historical bug, fixed**: `1st 3 AVG`/`1st 9 AVG` originally summed raw
per-dart values instead of using the bust-zeroed `turns.scored` column, so a
busted opening visit's *attempted* score counted as if it had scored. `140/Leg`
(`score140pct`) had the identical bug pattern, plus was separately missing the
`OPENING_CATS` restriction entirely (fixed in a later pass — see git history for
both fixes). If a similar-looking stat is ever added, check it against both of
these before trusting it.

### Metric History (`getMetricHistory()`) — the chart's time-bucketed version

Buckets by period (`today`→hour, `week`/`month`/`custom`→day, `year`→ISO week,
`all`→month), timezone-shifted for bucket *labels* using the client's UTC
offset (`tz` param, minutes east of UTC) — the underlying date-range filters
still run in UTC. As of the last full audit, **every one of the 15 stat-bubble
formulas above is byte-for-byte identical between `getPlayerStatBubbles()` and
`getMetricHistory()`** — this was explicitly re-verified after the two historical
bugs above were fixed in both places. If you touch one, touch the other, and
re-verify they still match.

### Personal Bests (`getPersonalBests(name, mode)`)

- **Best Leg Average**: `MAX` of the 3-dart-avg-convention leg average (darts,
  bust-as-3), **won legs only**.
- **Best First-9** (`bestFirst9`, docs/archive/first-nine-average-roadmap.md): `MAX` of the
  same per-leg 1st 9 AVG computation the stat bubble averages (`OPENING_CATS`-scoped
  to 501/301/170/101, bust-as-3-darts denominator, first up-to-3 visits) —
  **not** restricted to won legs, unlike Best Leg Average: the opening 9 darts
  are already fully determined the moment the 3rd visit is recorded, regardless
  of whether (or how) the leg eventually ends, and the stat bubble it mirrors
  carries no such restriction either. No `bestLeg`-style leg-location companion
  field and no Ghost Opponent "Race this leg" button — Ghost mode can only
  replay a leg the player actually won, so pointing it at a possibly-unfinished
  first-9 record leg would frequently 404.
- **Fewest Darts to Finish**: `MIN` raw darts in a won leg.
- **Recent Form**: mean of the 3-dart-avg leg average over the **last 10 won
  legs by most-recent finishing turn's row id** (a proxy for chronological
  order, not a timestamp sort), shown with the delta vs. lifetime average.
- **Current Win Streak**: walks the player's last 50 completed H2H games
  newest→oldest, counting consecutive wins until the first loss; **capped at 50**
  (a longer real streak reports as 50); always `0` when `mode==='practice'`.

Note: `bestLegAvg`/`recentFormAvg`/`lifetimeAvg` use the darts-based 3-dart-avg
convention — **this is a different "leg average" than the stat bubbles'
100+ AVG/90- AVG**, which use the turns-count convention. The two will not
numerically agree on the same leg; this is a known, deliberate inconsistency
between two different formula families in the codebase, not a bug — but it's
the first thing to check if someone asks "why doesn't X match Y."

`getPersonalBests()` also returns **`bestLeg`**: `{gameId, setNo, legNo}` identifying
which specific leg produced `bestLegAvg` (`null` if no won legs exist yet) — feeds
the Player Profile's "👻" Race-this-leg button (§ Ghost Opponent, below).

### Ghost Opponent (`docs/archive/ghost-opponent-roadmap.md`) — race a replay of your own past leg

X01-only. Two backend functions in `backend/db.js`, both scoped so a script/leg list
can only ever be built from legs the requesting player genuinely won themselves:

- **`getGhostCandidateLegs(playerName, limit=20)`**: every X01 leg this player has
  won (`turns.checkout=1`), most recent first, each row giving `{gameId, setNo,
  legNo, date, category, practice, avg, darts}` — the browsable "past legs" list.
  `GET /api/players/ghost-legs?name=&limit=`.
- **`getGhostLegScript(gameId, setNo, legNo, playerName)`**: that leg's turns in
  playback order, each with its raw `{sector, multiplier}` darts, plus `category`,
  `config`, and the leg's actual recorded `outMode` (double/single-out) — returns
  `null` if the game doesn't exist, isn't X01, or this player didn't actually win
  that leg. `GET /api/players/ghost-script?gameId=&setNo=&legNo=&name=`.

Frontend (`frontend/index.html`): a "👻 Ghost" New Game mode fetches the script,
starts a practice game with **only the human** as a real DB participant (the ghost's
name is never sent to `createGame()`/`addTurn()` — it exists purely client-side as a
second `game.players[]` entry, `newGhostPlayer()`, tagged `isGhost:true`), starting
at the historical leg's own starting score and `doubleOut` (not whatever the New
Game screen happens to be set to — replaying the same darts under a different
out-mode could turn a historical win into a bust). After every human turn,
`playGhostTurn()` re-evaluates the ghost's next scripted visit through the same
`evaluateVisit()` the human uses (not a canned replay of the old outcome), then
hands control back — advances immediately (a short ~450ms fixed UX pause), not at
the leg's real historical pace. `onLegWon()`/`enterTurn()`'s `opp` computation is
guarded with `!game.hasGhost`, so Comeback Kid/Giant Slayer/The Rematch/Grudge
Match/Nerves of Steel (all opponent-based) can never fire against a ghost; badges
based on the human's own performance (Big Fish, Cruise Control, etc.) are unaffected.
The ghost's turns are never persisted — no `game_players` row, no stats, no
leaderboard/badge eligibility. **The race's own result IS tracked**, however
(2026-07, `docs/archive/ghost-opponent-roadmap.md`): `onLegWon(wi)` already knows which
side won (`wi===0` human, `wi===1` ghost, since turns strictly alternate and only
a checkout ends the leg — no tie case exists), and the leg-win handler records it
via `recordGhostRace()`/`POST /api/ghost-races` when `game.hasGhost` is set,
storing `result` (`'win'`\|`'loss'`, from the human's perspective) plus
`humanDarts`/`ghostDarts` in a new `ghost_races` table (§13) linked to both the
race's own game and the historical leg that was raced. Re-validates the source
leg server-side via the same `getGhostLegScript()` ownership check used to build
the script in the first place, so a hostile client can't fabricate a fake win
history. `GET /api/players/ghost-race-record` returns `{wins, losses, totalRaces}`,
surfaced as a plain "👻 Ghost races: W–L" line next to the Player Profile's
"Race this leg" button (`loadGhostRaceRecord()`). A win also checks the 👻 Ghost
Slayer badge (§4's badge table) — `recordGhostRace()`'s `ghostSlayerNewlyEarned`
return value tells `onLegWon()` whether to run the usual celebration sequence.

### Top Finishes / Checkout Routes

- **`getTopFinishesAll()`** (global leaderboard): one row per `(player, checkout
  score, out-mode)`, ranked by score descending, ties broken by earliest date.
- **`getTopFinishes(name)`** (per-player): same shape, **no tiebreaker** beyond
  score descending, hardcoded `LIMIT 10`.
- **`getDartAnalytics(name)`**: `topSectors` (top 15 exact sector+multiplier
  hits), `trebleRates` (per number 1–20, `% of throws at that number that were
  a treble`), `checkoutRoutes` (top 10 exact 3-dart sequences across all
  checkout scores). **Busted turns are excluded entirely** from all three.
  Trusts `darts.sector`/`darts.multiplier` as recorded, with no game-type-
  specific interpretation — so it's only ever as accurate as what each game
  type's own input UI can produce; Cricket's own picker was the one gap where
  that wasn't fully true (`docs/bug-roadmap.md` BUG-23, §2's Cricket rules).
- **`getCheckoutRoutes(name, score)`**: same route query, scoped to one specific
  checkout score, `LIMIT 5` — this is the "how do I usually hit this number"
  drill-down on the Top 10 Finishes list.

### Coaching Insights (`getCoachingInsights(name, mode)`, `docs/archive/coaching-insights-roadmap.md`)

X01 only (checkout-route and bust-parity insights are X01-specific concepts).
`GET /api/players/coaching-insights?name=&mode=`. No new data collection — built
entirely from `getDartAnalytics`, `getCheckoutRoutes`, and `getPersonalBests`. Every
insight requires a large-enough sample to reflect a real pattern rather than noise
("Strict" thresholds — the roadmap doc's own decision record); a wrong coaching
insight actively misleads a player about their own game, a worse failure mode than a
wrong descriptive stat. Returns an array of `{ type, tone, text }`, `tone` one of
`'weakness'`/`'strength'` (rendered as an icon + text tag, never color alone — see
§11 Accessibility):

- **`weak_number`**: a number (1–20) whose treble rate sits **≥10 percentage points**
  below the player's own overall treble rate (their own baseline, never a fixed
  external benchmark), requiring **≥40 darts thrown at that number**. Up to 2
  reported, worst first.
- **`checkout_route`**: the player's most-used route for their single most-hit
  checkout score (**≥10 uses** to qualify) takes more darts than
  `checkoutHint()`'s (`frontend/scoring.js`) dart-count-optimal route for that same
  score and the player's own out-mode.
- **`bust_parity`**: double-out only (single-out has no such bias — any score
  reaching exactly zero wins). Reconstructs the remaining score entering each turn
  (starting score minus the running sum of this player's prior `scored` points in
  that same leg, via a `SUM() OVER (PARTITION BY game_id,set_no,leg_no ORDER BY id
  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)` window — `turns` doesn't store
  remaining directly), scoped to genuine X01 starting scores (501/301/170/101) and
  the double-out `game_players.out_mode` used in that specific game. Turns where
  that reconstructed remaining falls in `[2, 170]` are grouped by parity (odd/even);
  each side needs **≥20 such attempts**. Flags whichever parity's bust rate is **≥15
  percentage points** higher than the other's.
- **`form_trend`**: plain-language wrapper around `getPersonalBests`'s existing
  `recentFormAvg`/`lifetimeAvg` delta, shown only once the player has **≥20 lifetime
  legs** (so the "last 10" window isn't simply most/all of their history) and the
  delta is **≥5** in either direction.

**Deferred to a future pass** (not built): a "Practice this" button pre-configuring a
practice session targeting the flagged weakness — see the roadmap doc's decision
record.

### Head-to-Head (`getH2HRecord()`, `getH2HSummary()`)

`getH2HRecord(p1, p2)`: counts completed, non-practice games where both named
players participated (via a double `game_players` join). **Note**: this does
*not* require exactly two participants — a 3+-player free-for-all where both
named players took part is still counted, since the join only guarantees "both
were in this game," not "only these two were in this game."

`getH2HSummary(p1, p2, excludeGameId)`: `{ totalGames, previousWinner }` —
`previousWinner` looks at the most recent qualifying game *excluding* the game
just finished (used immediately after a match completes, to answer "who won
last time before this one" for the Rematch/Grudge Match badges — see §4).

### On This Day (`getOnThisDay(name, tz)`)

Priority order for what counts as "notable" on today's exact calendar
month/day in a past year: **a 180 (priority 3) > a 170 checkout (priority 2) >
any 100+ checkout (priority 1)**. If more than one qualifying date exists across
different past years at the same priority, the **most recent year wins**. Date
matching is `%m-%d` only (month/day, ignoring year), timezone-shifted by the
passed `tz` offset. Returns `null` if nothing at priority ≥1 exists.

### Daily Challenge history (`getChallengeHistory()`, `getChallengeStatus()`)

See §6 for the full formats/streak/personal-best writeup.

### Denominator conventions — the single most useful debugging table

| Family | Bust's numerator contribution | Bust's denominator weight | Used by |
|---|---|---|---|
| **3-dart average** | 0 | **3** (fixed, regardless of darts actually thrown) | Average bubble, 1st 9 AVG, Best Leg Average, Recent Form, `computeStats`'s `avgDarts` |
| **Per-visit average** | 0 | **1** (counts as one turn, not weighted by darts) | 100+ AVG, 90- AVG |
| **Raw darts** | darts actually thrown pre-bust, no padding | n/a | Darts Thrown, Darts/Day, Darts/Leg, Fewest Darts to Finish |
| **First-visit only** | 0 if the leg's opening visit busted | n/a (single lookup) | 1st 3 AVG, 140/Leg |
| **Excluded entirely** | busted darts dropped from the query | n/a | Dart Analytics (top sectors, treble rates) |

If a stat "looks off," identify which family it should be in first — most
historical bugs here came from a metric accidentally using the wrong family, or
two sibling functions (bubbles vs. history) drifting onto different families
for the same named metric.

### Game scope filter helper (`_scope({mode, gameType})`, `backend/db.js`)

Every stats query needs to scope by mode (h2h/practice, via the existing
`_mf(mode)`) and, since Cricket landed, by game type too. `_scope()` composes
both into one SQL fragment instead of each query hand-rolling its own
`AND g.game_type='...'` alongside its mode filter
(`docs/archive/existing-app-prep-roadmap.md` item 1) — `gameType` is whitelisted
against `KNOWN_GAME_TYPES` (`['x01','cricket','baseball','doubles_practice',
'chuckin','checkout_trainer','around_the_clock','around_the_world','bobs_27',
'checkout_ladder','gauntlet','killer','shanghai','halve_it','dead_man_walking',
'pressure_chamber']`)
as defense-in-depth, though it's always an internally-controlled literal, never
raw request input.
`X01_ONLY` is now `_scope({gameType:'x01'})` (byte-identical string, so its
existing call sites needed no changes), and every Cricket query function below
routes through `_scope({mode, gameType:'cricket'})`. A future scoping
dimension (online matches, league membership) only needs to extend `_scope`'s
destructured params — Cricket's own dimension is now fully centralized this
way; the ~15-20 pre-existing mode-only query sites (`computeStats`,
`getSummary`, `getHomeExtra`, `getPersonalBests`, pace, etc.) still call
`_mf(mode)` directly and weren't migrated in this pass (out of scope, higher
regression risk on mature code, no current feature needs it yet).

### Cricket stats (`GAME_TYPES.cricket.statDefs` / `CRICKET_STAT_DEFS`)

A separate, smaller stat vocabulary from X01's — Cricket's `turns.scored` means
"cricket points earned," not countdown points, so none of these reuse the X01
formulas above; every query here is scoped via `_scope({mode, gameType:'cricket'})`
instead of `X01_ONLY`. Marks are always derived at query time from `darts.sector`/
`multiplier` matched against that game's `config.numbers` (`CRICKET_MARK_CASE`
in `backend/db.js` — a dart's marks are its multiplier if the sector is one of
the match's in-play numbers, else 0), not from any persisted mark/closed state.

**Stat bubbles** (`getCricketStatBubbles(name, mode)`):

| Key | Label | Formula |
|---|---|---|
| `cricketmpr` | MPR | `SUM(marks) / COUNT(rounds)` — a miss-only turn still counts as a round |
| `cricket9marks` | 9 Marks | Count of visits where exactly 3 darts were thrown and `SUM(marks)=9` (the maximum possible — 3 trebles on in-play numbers) |
| `cricketwinpct` | Win Rate | `won / played * 100` over completed Cricket games this player took part in |
| `cricketgames` | Games Played | Count of completed Cricket games this player took part in |
| `cricketdartsthrown` | Darts Thrown | Count of darts thrown in Cricket games (a cricket-scoped breakdown — the global "Darts Thrown" bubble already includes these darts too) |
| `cricketavgdartsperleg` | Darts / Won Leg | `AVG(darts thrown)` across legs where this player has a `leg_won=1` turn |

**Personal Bests** (`getCricketPersonalBests(name, mode)`, same 5-field shape as
X01's `getPersonalBests()` but keyed on `leg_won=1` instead of `checkout=1`):
`bestLegMpr` (max marks/rounds across won legs), `fewestDartsToClose` (min total
darts across won legs), `winStreak` (current consecutive-win streak, Cricket
games only), `recentFormMpr` (avg MPR over the last 10 won legs),
`lifetimeMpr` (avg MPR over every won leg).

**Metric history** (`getMetricHistory()`, same 6 keys as the stat bubbles above,
bucketed the same way as X01's metrics via `bld()`) — `cricketwinpct`/
`cricketgames` bucket by the game's completion date (a new per-game bucket
granularity `getMetricHistory` didn't previously need); the other 4 bucket
per-turn or per-leg like their X01 counterparts.

**Player Profile UI**: a small X01/Cricket toggle (`playerGameType`, mirroring
the existing `.player-tabs` pattern) next to the Overall/H2H/Practice tabs
switches which `statDefs` array/personal-bests shape/chart metric feeds the
bubbles, chart, and Personal Bests section.

**Home page leaderboards** (`renderHomeTabBodyCricket()`, a separate rendering
path from `renderHomeTabBody()` rather than shoehorned branches, since
Cricket's stat shapes don't map onto X01's): a second `homeGameType` toggle
(same `.player-tabs` pattern) below the existing H2H/Practice tabs switches
between X01's leaderboard set and Cricket's own:

| Leaderboard | Backend function | Notes |
|---|---|---|
| Marks Per Round | `getCricketMprLeaderboard(mode)` | All players ranked by MPR; `HAVING rounds >= 5` floor so one lucky visit can't top the board (mirrors `_trebleLess()`'s `turns >= 10` convention) |
| Most Cricket Wins | `getCricketWinLeaderboard()` | Same shape as `getHomeExtra()`'s `winLeaderboard`, scoped to `game_type='cricket'`; H2H only (no `mode` param — practice has no opponent to win against) |
| 9 Marks | `getCricketNineMarksStats(mode)` | Reused as-is from the achievements leaderboard already built for step 3 |
| Perfect Leg | `getCricketPerfectLegStats(mode)` | A won leg (`leg_won=1`) whose total darts equal that match's config-derived theoretical minimum — the same logic as the Perfect Leg achievement trigger in `enterTurnCricket()`, computed here in SQL via `json_each(g.config,'$.numbers')` instead of read from client state |

All four are fetched in the same upfront `Promise.all` `renderHome()` already
uses for X01 (`homeData.cricket.h2h`/`.practice`/`.wins`) — no separate loading
state or lazy-fetch-on-toggle.

### Baseball stats (`GAME_TYPES.baseball.statDefs` / `BASEBALL_STAT_DEFS`)

A separate, smaller stat vocabulary from both X01's and Cricket's — Baseball's
mechanics (fixed 9 innings, runs-based scoring, no bust/checkout/closing
concept) don't map onto either. Unlike Cricket's marks (derived from
`darts.sector`/`multiplier` matched against `config.numbers` at query time),
`turns.scored` for a Baseball turn already **is** that visit's runs
(`enterTurnBaseball()` writes `scored:ev.scored` directly), so every formula
below reads `turns.scored` as-is — no per-dart derivation needed. Every query
is scoped via `_scope({mode, gameType:'baseball'})`.

**Stat bubbles** (`getBaseballStatBubbles(name, mode)`):

| Key | Label | Formula |
|---|---|---|
| `baseballrpi` | RPI | Runs Per Inning — `SUM(scored) / COUNT(rounds)`, Baseball's analog of X01's 3-dart average / Cricket's MPR. A scoreless turn still counts as a round |
| `baseballperfectinnings` | Perfect Innings | Count of turns where `scored=9` — 3 darts, each a treble on that inning's target number, the maximum possible (Baseball's 180/9-Marks analog) |
| `baseballwinpct` | Win Rate | `won / played * 100` over completed Baseball games this player took part in |
| `baseballgames` | Games Played | Count of completed Baseball games this player took part in |
| `baseballdartsthrown` | Darts Thrown | Count of darts thrown in Baseball games (a baseball-scoped breakdown — the global "Darts Thrown" bubble already includes these too) |
| `baseballbestinning` | Best Inning | `MAX(scored)` across every turn — the player's personal-best single-inning run total (max possible 9) |

The same response also carries a raw `totalRuns` (`SUM(scored)`, the figure
`baseballrpi` is itself derived from) — not a UI bubble (no
`BASEBALL_BUBBLE_KEY_MAP` entry), only fetched via a no-`mode`-param call as
the lifetime-runs achievement ladder's base (docs/archive/culture-badges-roadmap.md
Part B, see §4).

**Personal Bests** (`getBaseballPersonalBests(name, mode)`, same 5-field shape
as X01's/Cricket's, adapted to what's actually meaningful for a fixed-inning-
count game): `bestLegRuns` (highest total runs in a single won leg),
`fewestDartsToWin` (fewest total darts across a won leg — reads as "won in
regulation vs. needed extra innings," since darts-per-leg in Baseball doesn't
vary with skill the way X01's does), `winStreak` (current consecutive-win
streak, Baseball games only), `recentFormRuns` (avg runs over the last 10 won
legs), `lifetimeRuns` (avg runs over every won leg).

**No `turns.leg_won` signal** — unlike X01 (`checkout=1`) and Cricket
(`turns.leg_won`, set by `enterTurnCricket()`), Baseball never writes a "this
turn won the leg" flag to any turn at all, because a Baseball leg's winner
isn't self-referential to a single player's own visit the way a checkout or
closing every Cricket number is: `evaluateVisitBaseball()`'s own win check can
resolve on a visit that belongs to the *losing* player (the round-ending visit
and the actual highest scorer aren't always the same player — see §2's
"Baseball rules"). Instead, `getBaseballWonLegs(playerId, mode)` derives a
"won leg" at query time: each player's total runs per `(game_id, set_no,
leg_no)`, compared against the max among that leg's participants — exactly
how the live game itself determines a winner. Scoped to `g.completed_at IS
NOT NULL` as a safety net: an abandoned mid-leg's partial totals can never be
mistaken for a real result, since an abandoned game never sets `completed_at`
at all — this can only ever under-count a real completed leg belonging to a
since-abandoned multi-leg match, never fabricate a win. (A known pitfall
avoided here: summing `turns.scored` while joined to `darts` fans out each
turn's value by its own dart count — every query above pre-aggregates per-turn
in a subquery first, the same precaution `getMetricHistory()`'s X01 `'avg'`
case and Cricket's marks derivation already take.)

**Metric history** (`getMetricHistory()`, same 6 keys as the stat bubbles
above) — `baseballwinpct`/`baseballgames` bucket by the game's completion
date, matching Cricket's own per-game bucket granularity; the other 4 bucket
per-turn, reading `turns.scored` directly with no darts join (so no fan-out
risk in these particular cases, unlike the Personal Bests leg-total queries
above).

**Player Profile UI**: `playerGameType` toggle, same mechanism as Cricket's.
**Home page leaderboards**: not built yet — `homeTabRenderer:false` explicitly
opts Baseball out of the Home page toggle (the same Chuckin/Doubles-Practice
precedent — `false`, not `null`, since `null` means "fall back to X01's own
leaderboard shape," which would silently render nonsense against Baseball's
totally different player-snapshot fields) until a real Baseball-shaped Home
leaderboard set is built, a separate follow-up step (the same order Cricket's
own build went: stats parity first, Home page navigation as its own later
step).

### Doubles Practice stats (`GAME_TYPES.doubles_practice.statDefs` / `DOUBLES_PRACTICE_STAT_DEFS`)

A much smaller vocabulary than X01/Cricket's — no win condition, no legs/sets,
so there's no "games played"/"win rate" concept here. A **hit** is a dart whose
`multiplier=2` and whose `sector` is in that game's own `config.doubles` array
— derived at query time via `DOUBLES_HIT_CASE` (`backend/db.js`), the same
`json_each(g.config, '$.doubles')` join pattern `CRICKET_MARK_CASE` already
uses against `config.numbers`, just with a simpler binary (0/1) result instead
of a 1-3 mark value. Every query is scoped via
`_scope({mode, gameType:'doubles_practice'})`.

**Stat bubbles** (`getDoublesPracticeStatBubbles(name, mode)`):

| Key | Label | Formula |
|---|---|---|
| `doublespracticepct` | Doubles % | `hits / dartsThrown * 100` — every dart ever thrown in this mode, lifetime |
| `doublespracticedartsperround` | Darts / Round | `dartsThrown / roundsPlayed` — a round is one `(game_id, set_no, leg_no)` grouping |
| `doublespracticehitsperround` | Doubles Hit / Round | `hits / roundsPlayed` |

The same response also carries a raw `hits` (the lifetime doubles-hit count
`doublespracticepct` is itself derived from) — not a UI bubble, only fetched
via a no-`mode`-param call as the lifetime doubles-hit ladder's base
(docs/archive/culture-badges-roadmap.md Part B, see §4).

**Personal Bests** (`getDoublesPracticePersonalBests(name, mode)`) — deliberately
just 2 fields, not the 5-field X01/Cricket shape: `bestRoundDarts` (the longest
round ever, by dart count — "how long did the streak last") and
`bestRoundHits` (the most doubles hit in a single round). No `winStreak`/
`recentForm`/`lifetime` fields — those are all win- or leg-won-gated concepts
(X01's `winStreak` needs H2H wins; Cricket's `recentFormMpr`/`lifetimeMpr` are
gated on `leg_won=1`) that don't map onto a mode with no win condition at all —
`doublespracticepct`'s lifetime figure above already answers "how am I doing
overall" for this mode.

**Metric history** (`getMetricHistory()`, all 3 keys above) — `doublespracticepct`
buckets per-dart like X01's `avg`; `doublespracticedartsperround`/
`doublespracticehitsperround` bucket per-round like Cricket's
`cricketavgdartsperleg`, but with **no win-gating `HAVING` clause** — every
round counts, however it ended, since a Doubles Practice round never "wins."

**Player Profile UI**: a third button on the same X01/Cricket `.player-tabs`
toggle (`playerGameType`) switches to this mode's `statDefs`/personal-bests
shape/chart metrics, exactly the same mechanism Cricket's toggle already uses
— no new toggle widget, no registry redesign. (This is the one
`Doubles Practice`-specific slice of `docs/game-modes-roadmap.md`'s larger,
still-open "generalizing per-game-type stats beyond a two-way toggle" backlog
item — extending 3 existing `playerGameType==='cricket'` ternaries to a third
branch, not the full N-game-type redesign that backlog item describes.)

**Home page leaderboards** (`getDoublesPracticeAccuracyLeaderboard()`,
`getDoublesPracticeBestRoundStats()`) — 2 boards, not Cricket's 4: no win-rate
leaderboard (no opponent to win against) and no achievement-count sections
(this mode has no achievements). Neither function takes a `mode` param —
Doubles Practice games are always `practice=1` (`startGame()` forces it via
`setup.practice`, set whenever `setup.mode !== 'h2h'`), so an h2h/practice
split would always leave the h2h side empty, the same reasoning as
`getCricketWinLeaderboard()`'s "H2H only by nature, no mode param" precedent,
just the opposite polarity.

- **Doubles % leaderboard** — direct structural analog of
  `getCricketMprLeaderboard()`: `hits / dartsThrown * 100` across every
  player, with the same minimum-5-rounds floor so one lucky round can't top
  the board.
- **Best Round leaderboard** — one row per player: their own best single
  round ever (most hits; a tie is broken by fewest darts, so a shorter path
  to the same hit count ranks higher). Not a "leaderboard"/"recent"
  achievement-count shape like Cricket's 9 Marks/Perfect Leg — a best round
  isn't a repeatable qualifying event, so this is structurally closer to
  `getPersonalBests()` extended across every player than to an achievement
  tally.

**Undo support**: `throwDartDoublesPractice()` snapshots player/round state
into `game.lastTurnSnapshot` before mutating (mirroring X01/Cricket's own
`lastTurnSnapshot` convention), and `undoLastTurnDoublesPractice()` restores
it and calls `DB.deleteLastTurn()` — "undo the last turn" and "undo the last
dart" are the same action in this mode, since every dart is its own committed
turn. No badge-revoke step is needed (this mode has no achievements).
Available only until `startNextRoundDoublesPractice()` runs (which clears the
snapshot, the same "one level of undo, gone once you move on" rule
`startNextLeg()` already enforces for X01/Cricket) — so a round-ending dart
can still be undone right up until "Start next round" is pressed. The
Player Profile/scoring-screen button is labeled "Undo Last Dart" for this
mode (not "Undo Last Turn"), and the separate "Undo Dart" button (which
un-stages an uncommitted dart from a batched 3-dart visit) is hidden
entirely — Doubles Practice has no staged-visit concept to undo from.

### Just Chuckin' It stats (`GAME_TYPES.chuckin.statDefs` / `CHUCKIN_STAT_DEFS`)

Heatmap-first, as explicitly requested: "the stats/reporting should be very
heatmap-heavy. We want to see patterns and trends over time, specifically
improvements." No win condition, no legs/sets, no opponent — every query is
scoped via `_scope({mode, gameType:'chuckin'})`.

**Stat bubbles** (`getChuckinStatBubbles(name, mode)`):

| Key | Label | Formula |
|---|---|---|
| `chuckindartsthrown` | Darts Thrown | `COUNT(*)` over every dart ever thrown in this mode, lifetime |
| `chuckinavg` | Three-Dart Average | `SUM(sector*multiplier) / dartsThrown * 3` — the standard darts average formula, identical to X01's, over every dart ever thrown (no grouping needed — see `oneEighties` below for the one metric that does need grouping) |
| `chuckin180s` | 180s | Count of completed, in-order 3-dart groups summing to exactly 180 — see "180s and the `chuckin180` achievement" below |
| `chuckintreblepct` | Treble % | `trebles / dartsThrown * 100` |
| `chuckinbullpct` | Bull % | `bulls / dartsThrown * 100` — a "bull" is any dart with `sector=25`, single or double |
| `chuckindoublepct` | Double % | `doubles / dartsThrown * 100` |
| `chuckinsessions` | Sessions Played | `COUNT(DISTINCT t.game_id)` |
| `chuckinavgdartspersession` | Avg Darts / Session | `dartsThrown / sessionsPlayed` |

All 8 return `null` (not `0`/`NaN`) when no darts have been thrown yet, matching
every other stat bubble's "no data" convention. `chuckinavg`/`chuckin180s` are
primary (shown by default); `chuckinavgdartspersession`/`chuckintreblepct`/
`chuckindoublepct`/`chuckinbullpct` moved behind "More stats" to make room.

**180s and the `chuckin180` achievement** — this mode otherwise has no turn/
visit boundary at all, so "assuming 3 darts per turn" (an explicit design
decision) means both the `oneEighties` stat and its achievement are computed
by grouping darts into non-overlapping runs of exactly 3, in throw order,
*never spanning two different sessions* (`CHUCKIN_GROUPS_OF_3`, `backend/db.js`
— a `ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY d.id)` window function,
`(rn-1)/3` giving the group index). A completed group whose 3 dart values sum
to exactly 180 (only physically possible as three treble 20s) counts. The
client mirrors this exact grouping live: `throwDartChuckin()` pushes each dart's
value onto `p.dartBuffer`, and once it reaches length 3, checks the sum and
resets the buffer — a fresh buffer at the start of every session, so a
trailing 1-2 darts left over at the end of one session never combines with the
next session's first darts, matching the backend's per-`game_id` partitioning
exactly. On a genuine 180, the client queues a **`chuckin180`** achievement
(`BADGE_INFO`/`ACH_LABELS`/`ACH_DURATION` in both `index.html` and
`display.html`) via `awardRecurringBadge()` — a moment-style badge like Hat
Trick, not a slow-building milestone, so **unlike** the 18 laddered milestones
above (deliberately not undo-revocable) it **is** revoked on undo: the
per-dart snapshot in `throwDartChuckin()` now carries `badgeReverts`/`voided`
fields (the same convention `trackBadgeForUndo()` already uses for X01/Cricket/
Doubles Practice), and `undoLastTurnChuckin()` processes them.

**Personal Bests** (`getChuckinPersonalBests(name, mode)`) — deliberately just 2
fields, following Doubles Practice's precedent that a drill mode's Personal
Bests don't need the 5-field X01/Cricket shape: `bestSessionDarts` (the longest
session ever, by dart count) and `bestSessionTrebles` (the most trebles hit in
a single session). No `winStreak`/`recentForm`/`lifetime` fields — this mode
has no win condition to gate a streak on, and `chuckintreblepct`'s lifetime
figure above already answers "how am I doing overall."

**Heatmap** (`getChuckinHeatmap(name, mode)`) — the one genuinely new reporting
shape this mode introduces: every `(sector, multiplier)` combination this
player has ever hit in Chuckin, with its hit count, feeding a non-interactive
dartboard visualization on the Player Profile (`buildChuckinHeatmap()`,
`frontend/index.html`) shaded by relative hit frequency (a single-hue scale
from dark to warm gold) with native `<title>` tooltips giving the exact count
per region on hover. Deliberately a **separate function** from
`buildDartboard()` (the interactive live-scoring board) rather than a reused/
extended version of it — duplicating the small set of shared geometry helpers
(`CX`/`CY`, ring radii, `xy()`, `annulus()`) locally was judged lower-risk than
adding a non-interactive rendering mode to the heavily-used live scoring
widget.

**Metric history** (`getMetricHistory()`, all 8 keys above) —
`chuckindartsthrown`/`chuckinavg`/`chuckintreblepct`/`chuckinbullpct`/
`chuckindoublepct` bucket per-dart like X01's `avg`; `chuckinsessions`/
`chuckinavgdartspersession` bucket per-session (grouped by `t.game_id`, using
the same `L` leg-bucketer Cricket/Doubles Practice use for their own per-round
metrics — a "session" here plays the same structural role a "leg" does
elsewhere); `chuckin180s` buckets by the timestamp of each qualifying group's
*last* dart (via `F`, the post-window-function bucketer X01's `first3avg`
already established the precedent for — no `t.` table alias is in scope once
the grouping subquery's own `created_at` column has been unwrapped).

**Player Profile UI**: its own button on the same N-way `.player-tabs`
game-type toggle (`playerGameType`) every other mode uses, switching to
`CHUCKIN_STAT_DEFS`/this Personal Bests shape/these chart metrics — plus the
dartboard heatmap section above (`#chuckin-heatmap-section`, hidden for every
other game type).

**Home page**: deliberately **not** on the Home page leaderboard toggle
(`GAME_TYPES.chuckin.homeTabRenderer = false`) — none of this mode's stats map
onto a competitive leaderboard shape (no wins, no opponent, nothing to rank
head-to-head), so it's excluded from that specific toggle's `Object.values(...)
.filter(g => g.statDefs && g.statDefs.length && g.homeTabRenderer !== false)`
check while still appearing on the Player Profile's own toggle (whose filter
doesn't check `homeTabRenderer` at all).

**Live Scoreboard**: `renderers.chuckin.card()` (`frontend/display.html`) shows
a live, **session-only** dartboard heatmap alongside the darts-thrown counter
and the running 3-dart average — a genuinely different dataset from the
lifetime one the Player Profile fetches via `getChuckinHeatmap()`, gradually
filling in as the session progresses rather than showing accumulated history.
`throwDartChuckin()` tallies hits into `p.heatmap` (a
`{sector_mult_zone_missZone_missDepth: count}` map — always 5 underscore-separated
segments: `zone` is `'inner'`/`'outer'` for a Dartboard-mode single and `''`
otherwise; `missZone`/`missDepth` are populated only for a positioned miss and
`''` otherwise — matching `buildDartHeatmap()`'s lifetime keying) and
`p.sessionScore` (feeding the average) on every dart;
`playerSnapshotChuckin()` flattens `p.heatmap` into the same
`{sector,multiplier,zone,missZone,missDepth,hits}` array shape
`getChuckinHeatmap()` already returns, so `display.html`'s renderer
(`buildChuckinLiveHeatmap()`, a
mirror-copied port of `buildChuckinHeatmap()`'s SVG geometry — no shared module
between the two files, per the established convention) can feed it straight in.
The renderer shades a number's inner and outer single regions independently
(`heat(n,1,'inner')` vs `heat(n,1,'outer')`) and, like the lifetime heatmap,
does not plot a zone-unspecified single (a Pad-mode dart) on either region
rather than lighting up both — `docs/bug-roadmap.md` BUG-20. It also renders
the outer **miss ring** — the same two near/far bands per wedge the lifetime
`buildDartHeatmap()` draws, on their own independent heat scale (`missHeat()`,
separate from the scoring-hit scale since miss and hit populations differ
wildly). A positioned miss (`sector 0` carrying `missZone`/`missDepth`, only
ever produced by a Dartboard-mode miss-ring tap) fills its wedge/depth band; an
unpositioned Pad-mode miss has nothing to plot, same as the lifetime board. To
make room for the miss bands the live SVG uses the same enlarged geometry as
`buildDartHeatmap()` (`viewBox` 660, `missNear:270`/`missFar:310`); the board
proper is unchanged, just no longer flush to the edge. Both the tally key
(`{sector_mult_zone_missZone_missDepth: count}`) and the flattened cell shape
(`{sector,multiplier,zone,missZone,missDepth,hits}`) carry the miss fields. No
`ALLOWED_LIVE_KEYS` change was needed — both fields ride inside the per-player
`players[]` array, whose nested shape isn't restricted by that allowlist (only
top-level payload keys are). Side-by-side with the session stats in landscape,
stacked in portrait (`.chuckin-layout`, reusing the same
`body.orientation-portrait` class every other orientation-aware element in
this file already toggles — item 11).

**Undo support**: `throwDartChuckin()` snapshots session-counter, heatmap,
score, and dart-buffer state into `game.lastTurnSnapshot` before mutating (the
same convention as every other per-dart-commit mode), and
`undoLastTurnChuckin()` restores it, calls `DB.deleteLastTurn()`, and (new)
revokes any `chuckin180` badge that dart awarded — see above.

### Bob's 27 stats (`GAME_TYPES.bobs_27.statDefs` / `BOBS_27_STAT_DEFS`)

Nothing is pre-aggregated (`backend/db.js`'s standing house style) — a run's
final score is derived at read time from its own turns via the identical
store-gain/derive-penalty formula §2's rules write-up and the write-time guard
both use: `27 + SUM(scored>0 ? scored : -2*round)`, `round` re-derived per
turn via `ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY id)` (unambiguous
since a bobs_27 game always has exactly one player/set/leg). A run that died
early and one that finished all 20 rounds both fall out of this same formula
for free — no separate "did they survive" input is needed beyond that game's
own turn count and `bust` flag. That only covers runs that actually **ended**,
though, so every run-level aggregate (runs/survival/avg/best/leaderboard)
additionally requires `g.completed_at IS NOT NULL` — a paused/abandoned/
in-progress run has no bust row simply because it hasn't died *yet*, and
counting it as a survived run with its partial total would let abandoning bad
runs inflate the stats (the same "an abandoned run's partial total isn't a
real result" rule Gauntlet's PBs apply). Only the dart-level Doubles Hit %
deliberately keeps counting every dart thrown. Every query is scoped via
`_scope({mode, gameType:'bobs_27'})`.

**Stat bubbles** (`getBobs27StatBubbles(name, mode)`):

| Key | Label | Formula |
|---|---|---|
| `bobs27survivalrate` | Survival Rate | `runsWithNoBustTurn / runs * 100` — a **completed** run "survives" if none of its turns has `bust=1`, independent of its final score's sign |
| `bobs27avgscore` | Avg Final Score | Mean of every completed run's own `27 + SUM(...)` final score (§2 formula), including died runs (their final score is typically ≤0) |
| `bobs27runs` | Runs Played | `COUNT(DISTINCT game_id)` over completed runs |
| `bobs27dartsthrown` | Darts Thrown | Count of darts thrown across every Bob's 27 run |
| `bobs27doubleshitrate` | Doubles Hit % | Of every dart actually thrown across every round, the fraction that landed on *that round's own* double (`sector=round AND multiplier=2`) — real board outcomes only, same "no hypothetical exclusion" convention Doubles Practice's own hit-rate bubble uses |

All 5 return `null` when the player has no Bob's 27 runs yet, matching every
other stat bubble's "no data" convention.

**Personal Bests** (`getBobs27PersonalBests(name, mode)`) — deliberately just
2 fields, following Chuckin/Doubles Practice's precedent that a drill mode
doesn't need X01/Cricket's 5-field shape: `bestFinalScore` (`MAX()` across
every run's own final score, no minimum floor — a died run can still be the
peak if it died deep enough into the ladder with enough gains along the way)
and `deepestDoubleOnFail` (`MAX(roundsReached)` scoped to only runs that
actually have a `bust=1` turn — a survived run has no "reached on a fail" to
report, so it's excluded entirely rather than counted as round 20).

**Home page leaderboard** (`getBobs27Leaderboard()`, `renderHomeTabBodyBobs27()`)
— an arcade-style high-score table: one row per player, their own single
best-ever run's final score (`MAX()` across every run, same "peak single run"
shape Checkout Blitz's own leaderboard uses), ranked descending, **no
minimum-runs floor** — a single legendary run (up to and including The Full
Anderson's 1287 itself, §4) is exactly the kind of feat this exists to
surface, not something a floor should hide behind "not enough games played."

**Player Profile UI**: its own button on the `.player-tabs` game-type toggle
(`playerGameType`), same mechanism as every other mode.

### Guided Around the Clock / Around the World stats (`GAME_TYPES.around_the_clock.statDefs` / `GAME_TYPES.around_the_world.statDefs`)

Two new, deliberately minimal vocabularies — neither mode has a win condition,
so there's no "games played"/"win rate" concept. Every query is scoped via
`_scope({mode, gameType:'around_the_clock'})` or `_scope({mode,
gameType:'around_the_world'})`.

**Around the Clock stat bubbles** (`getAroundTheClockStatBubbles(name, mode)`):

| Key | Label | Formula |
|---|---|---|
| `atccompletions` | Completions | Count of `(game_id,set_no,leg_no)` groups with `SUM(bust)=1` — a round that actually completed |
| `atcavgdartspercompletion` | Darts / Completion | `AVG(darts)` over only the completed-round groups above |
| `atcdartsthrown` | Darts Thrown | `COUNT(*)` over every dart ever thrown in this mode, lifetime (includes abandoned rounds) |

`getAroundTheClockStatBubbles()` also returns `sessionsPlayed` (completed +
abandoned rounds, `COUNT(DISTINCT game_id||'-'||leg_no)`) and
`completionRate` (`completions / sessionsPlayed * 100`) — both plain
stat-bubble fields, not chart-linked (no matching `getMetricHistory()` case).
All return `null`/`0` (not `NaN`) when no rounds have been recorded yet.

**Around the Clock Personal Bests** (`getAroundTheClockPersonalBests(name,
mode)`) — a single field, `bestCompletionDarts`: the fewest darts a
completed round has ever taken (`MIN(darts)` over completed-round groups,
`HAVING SUM(bust)=1`). No `winStreak`/`recentForm`/`lifetime` fields, same
reasoning as Doubles Practice/Chuckin above.

**Around the World stat bubbles** (`getAroundTheWorldDrillStatBubbles(name,
mode)`): `dartsThrown` (lifetime darts in this mode), `sessionsPlayed`
(`COUNT(DISTINCT game_id)`, Chuckin's exact pattern — no round concept),
`avgDartsPerSession`, plus `progress`/`total` — the **same lifetime,
cross-mode** 63-outcome count `getAroundTheWorldProgress()` already computes
(the badge table's 🌍 Around the World row above documents its exact
formula), not a drill-scoped count of its own. A dart thrown in this drill
that repeats an already-hit outcome still counts toward `dartsThrown` but not
toward `progress`.

**Around the World Personal Bests** (`getAroundTheWorldPersonalBests(name,
mode)`) — `sessionsPlayed` + the same `progress`/`total` fraction, not a
per-round record: this mode never "wins" and its progress is lifetime/
cross-session by design, so there's no round/session record to chase the way
every other drill mode has one.

**Metric history** (`getMetricHistory()`): `atcdartsthrown`/`atccompletions`/
`atcavgdartspercompletion` bucket per-dart or per-round (the latter two via
the same `L` leg-bucketer Doubles Practice's own per-round metrics use,
`HAVING SUM(bust)=1` gating out abandoned rounds); `atwdartsthrown`/
`atwsessions` bucket per-dart or per-session, mirroring Chuckin's own
`chuckindartsthrown`/`chuckinsessions` cases exactly. `completionRate` and
lifetime `progress` are deliberately **not** chart-linked — a per-bucket
ratio-of-two-counts and a cross-mode running total, respectively, neither of
which fits the existing per-bucket-rate shape without a materially different
query.

**Player Profile UI**: each mode gets its own button on the same N-way
`.player-tabs` game-type toggle (`playerGameType`) every other mode uses.
The existing "Around the World Progress" grid section
(`renderAroundTheWorldProgress()`, above) is unaffected by which tab is
active — it's a standalone section, not gated behind the per-game-type
toggle, so no duplicate grid was added for its own tab.

**Home page leaderboards**: `getAroundTheClockFastestLeaderboard()` (one row
per player, their fastest completion, ascending) and
`getAroundTheClockCompletionsLeaderboard()` (completions count, descending) —
2 boards mirroring Doubles Practice's precedent. `getAroundTheWorldLeaderboard()`
— 1 board (every player ranked by lifetime progress, descending, filtering out
players with zero progress) — not 2, since there's no obvious second ranking
axis for an open-ended, cross-session tracker. None take a `mode` param —
same "always practice=1 by construction" reasoning as Doubles Practice's own
Home boards.

**Live Scoreboard**: `renderers.around_the_clock.card()` /
`renderers.around_the_world.card()` (`frontend/display.html`) each show the
compact `buildOutcomeGridCompact()` progress grid alongside the running
hit/progress counter — `playerSnapshotAroundTheClock()`/
`playerSnapshotAroundTheWorld()` (`frontend/index.html`) send `hitNumbers`/
`hitOutcomes` (plain arrays, not just counts) inside the per-player
`players[]` array so the Live Scoreboard can render exactly which
numbers/outcomes are still outstanding, the same live feedback the controller
itself shows. Two new top-level `ALLOWED_LIVE_KEYS` entries,
`atcLastDart`/`atwLastDart` (the last-dart throwbox data — `roundOver`/
`roundEndReason` are reused as-is from Doubles Practice for Around the
Clock's round-end signal, no new keys needed there).

**Undo support**: both snapshot round/session state into
`game.lastTurnSnapshot` before mutating (the same convention as every other
per-dart-commit mode) including `badgeReverts`/`voided`, and
`undoLastTurnAroundTheClock()`/`undoLastTurnAroundTheWorld()` restore it,
call `DB.deleteLastTurn()`, and revoke any `guided_clock`/`guided_world`
badge that dart awarded.

---

## 4. Achievements & Badges

187 badges (33 X01 + 5 Cricket + 8 Baseball + 1 Shanghai + 2 Halve-It + 15 The
Pressure Chamber + 5 Doubles Practice + 7 Bob's 27 + 7 121 Checkout Ladder +
14 The Gauntlet + 14 Dead Man Walking + 3 Killer + 11 Marathon Mode +
2 Household Rating + 2 Tournament + 3 Daily Challenge + 19 Just Chuckin' It +
34 Checkout Trainer + 2 Practice Drills
— this header count previously drifted out of sync as later game types
(Shanghai onward) each shipped their own badges without it being updated;
fixed here to match README.md's own fully-enumerated total, which stayed
current the whole time)
— that split is by which table each is listed under below (and which section of
the Player Profile's Badge Case each renders in, via `BADGE_INFO`'s
`cricket`/`baseball`/`doublesPractice`/`challenge`/`chuckin`/`tournament`/`checkoutTrainer`/`drill`
flags — anything without one of those flags buckets as X01), not a strict statement
of which game types can trigger it: Checkout Trainer's own 34 badges are
documented in full in §19 rather than repeated here, since that section
already covers the mode end-to-end. Night Owl/
Early Bird (listed under X01) are one exception, checked from both
`enterTurn()` and `enterTurnCricket()` via a shared `awardTimeOfDayBadges()`
helper (2026-07 — previously Cricket-triggerable by neither, an accident of
code structure rather than a deliberate scoping decision); Ghost Slayer (also
listed under X01, since Ghost Opponent is X01-only) is another, checked
inline in `recordGhostRace()` (`backend/db.js`) rather than from the frontend
at all, since the win it depends on is already being written to the database
right there. The two Tournament badges (Champion, Giant Slayer (Tournament))
are the same shape — checked server-side in `_advanceTournamentMatch()` —
see their own table below. Tracked in the `player_badges` table (one row per
player+badge, with a running `count`). X01 detection logic otherwise lives in
`frontend/index.html`'s `enterTurn()`/`onLegWon()`; Cricket's 4 own badges
live in `enterTurnCricket()`/`onLegWonCricket()`; Baseball's 8 own badges
(docs/archive/culture-badges-roadmap.md Part B added 6 of them — Walk-Off, The Cycle,
and a 4-tier lifetime-runs ladder — to the 2 that already existed) live in
`enterTurnBaseball()`/`onLegWonBaseball()`; Doubles Practice's 5 own badges
(also Part B — this mode had none before) are checked in
`throwDartDoublesPractice()`; Daily Challenge's 3 badges
are checked in `checkChallengeBadges()`, called right after every
`/api/challenges/complete` response; Just Chuckin' It's 18 laddered milestones
are checked in `checkChuckinMilestones()`, called after every dart from
`throwDartChuckin()` — its 19th badge, `chuckin180`, is checked inline in that
same function (see §2/§3's own coverage of it); the 2 Practice Drills badges
(Guided Clock, Guided World) are checked inline in
`throwDartAroundTheClock()`/`throwDartAroundTheWorld()` (see §2/§3's own
coverage of them).

### Award modes

- **Recurring** (`once:false`): `awardRecurringBadge(player, badgeId, momentType,
  momentOpts)` → `POST /api/badges/award {once:false}` → `count` increments on
  every genuine occurrence (`ON CONFLICT ... DO UPDATE count=count+1`).
- **Once** (`once:true`): a direct `Backend.send('POST','/api/badges/award',
  {once:true})` call, checked for `newlyEarned` before celebrating — used for
  state-based badges whose trigger condition stays true forever once crossed
  (`INSERT OR IGNORE`, so re-checking an already-true condition never inflates
  the count past 1): **Around the Clock, Around the World, Ring Master, Grudge
  Match, First 100+ Checkout, Full Rotation, Ghost Slayer, Champion, Giant
  Slayer (Tournament)** — the last three are the exceptions to "a direct
  `Backend.send()` call": Ghost Slayer's `awardBadge(..., true)` call happens
  server-side, inside `recordGhostRace()` itself (see above), and its
  `newlyEarned` flag reaches the frontend as `recordGhostRace()`'s own
  `ghostSlayerNewlyEarned` field rather than a separate response. Champion and
  Giant Slayer (Tournament) go one step further: their `awardBadge(..., true)`
  calls happen inside `_advanceTournamentMatch()` with no response field for
  the frontend to read at all — the frontend instead detects a newly-earned
  badge after the fact by diffing `GET /api/players/badges` against the
  pre-match `earnedBadgeCache` snapshot (see the Tournament badges table
  below), since a normal `POST /api/games/:id/complete` triggers the award via
  the `onGameCompleted` hook with no room to thread a badge result back
  through that response.

### The 28 badges, exact trigger conditions

**Expanded-chain badges** (the `CHAIN_CHECKS` list in `enterTurn()` — collected
as an array and filtered by suppression pairs, not an if/else-if chain, so a
turn matching more than one condition queues all of them):

| Badge | Exact condition |
|---|---|
| 🎩 **Hat Trick** | `darts.length===3 && every dart isTreble && scored!==180 && !bust` |
| 🔴 **Bullseye Gauntlet** | `darts.filter(sector===25 && mult===2).length >= 2` (double bull hit twice in one visit) |
| 👯 **Double Trouble** | `win && darts.length>=2 && darts[len-2].isDouble && darts[len-1].isDouble` — the *last two* darts of the visit are both doubles. Dart 1 of a 3-dart visit (miss, single, or treble) is irrelevant. A 1-dart double-out checkout does **not** qualify — "consecutive" requires at least two. |
| 💨 **Where'd It Go?** | `darts.length===3 && every dart sector===0` (three misses) |
| 😩 **So Close...** | `darts.length===3 && !bust && [T20,T20,S20]` in that exact order (140 — one dart short of 180) |
| 💥 **Busted Maximum** | `bust && darts.length===3 && every dart is T20` — a genuine 180 attempt that still busts (see §2's bust rule #3: hit zero, but the last dart isn't a double). |
| 🤦 **No Cigar** | `bust && doubleOut && pointsThisVisit === score` — the visit's attempted points land on exactly the score that was needed, but the last dart wasn't a double (§2's bust rule #3, restated: hitting the target number itself instead of finishing on it). Distinguishable from an overshoot bust (`pointsThisVisit > score`) and a left-on-1 bust (`pointsThisVisit === score - 1`) by this exact equality. Never fires in single-out mode, since hitting the exact remaining there is a win, not a bust. |
| 😅 **Ton-titled to Nothing** | `bust && sum of attempted dart values >= 100` |
| 🪜 **Staircase Finish** | `win && isStaircaseFinish(preVisitScore, darts)` (`frontend/scoring.js`, unit-tested in `backend/test/scoring.test.js`) — checked out in exactly 3 darts by aiming at a double, missing to the single, and repeating that all the way down: `darts === [single(N), single(N/2), double(N/4)]` where `N = preVisitScore/2`. Only qualifies when `preVisitScore` is a multiple of 8 with `N<=20` and `N/4>=1` — the 5 qualifying starting scores are 8, 16, 24, 32, and 40 (e.g. 32: single 16, single 8, double 4; 40: single 20, single 10, double 5; 8: single 4, single 2, double 1). `preVisitScore` is read from `_snap.score` (the turn's snapshot, captured before `p.score` is mutated), not `p.score` itself, since by the time `CHAIN_CHECKS` runs `p.score` already reflects the post-visit value. |
| 🐂 **Triple Bull** | `win && darts.length===3 && every dart is sector===25 && mult===2` — checked out on 150 by hitting the double bull three separate times in one visit. There's no treble-bull ring (`makeDart()` already downgrades any attempted "treble bull" tap to a single), so this is three individual double-bull darts, not one dart at a x3 multiplier. Gets the same mega-tier confetti overlay as a nine-darter (`showAchievement()`'s `mega` check) — a comparably rare feat. |
| 🏹 **Bullseye Finish** | `win && the visit's last dart has sector===25 && mult===2` — the checkout's final dart is the double bull, at any total. Distinct from Bullseye Gauntlet (double bull hit twice *mid-visit*, not necessarily finishing there) and from Triple Bull (all three darts are the bull, not just the last one). |
| 🍳 **Bed & Breakfast** | `isBedAndBreakfast(darts)` (`frontend/scoring.js`, unit-tested in `backend/test/scoring.test.js`, docs/archive/culture-badges-roadmap.md Part A) — the classic "26" splash around the 20: a visit of exactly single 20, single 5, and single 1, in any order. An exact sector/multiplier match on all three darts, not merely `scored===26` (other routes to that same total aren't the joke). No `win`/`bust` requirement — the splash itself is the achievement, whatever the visit's outcome. |
| 🏚️ **Madhouse** | `isMadhouseFinish(win, darts)` (`frontend/scoring.js`, unit-tested) — won the leg and the visit's last dart is double 1, the finish nobody wants to be left on. Same "last dart" shape as Bullseye Finish above, with sector 1 in place of the bull. |
| 🀄 **Shanghai** | `isShanghaiVisit(darts)` (`frontend/scoring.js`, unit-tested) — a single, double, AND treble of the *same* number in one visit, any order, any number 1-20 (the bull is structurally excluded — there's no treble-bull ring, `makeDartCore()` already downgrades an attempted "treble bull" tap to a single). Deliberately independent of the Shanghai *game mode*'s own instant-win badge (§31, `docs/archive/shanghai-roadmap.md`) — this is the same feat landing inside a normal X01 leg; each doc cross-references the other so the two features never merge. |

**Suppression pairs**: two conditions above are deliberately treated as the same
event wearing two labels, not two distinct achievements — the more specific one
suppresses the generic one when both would otherwise match the same visit:
- **Busted Maximum** suppresses **Ton-titled to Nothing** (a busted 3×T20 is a
  100+ bust by definition).
- **Triple Bull** suppresses **Bullseye Finish** (a triple-bull checkout's last
  dart is trivially also the bull, but the more specific story wins).
- **Bullseye Gauntlet** suppresses **Double Trouble** (double-bull-twice is
  technically "last two darts both doubles" too).

Bed & Breakfast, Madhouse, and Shanghai each co-fire freely alongside any other
matching entry (no suppression pair) — their dart-shape requirements don't
overlap closely enough with an existing condition to be "the same event wearing
two labels": Bed & Breakfast requires an all-singles visit no other entry needs,
Madhouse only inspects the last dart's sector/multiplier (distinct from Bullseye
Finish's sector 25), and Shanghai's exact `{single, double, treble}` multiplier
set can never also satisfy Hat Trick (which requires all three darts to be
trebles).

All other badges are checked independently (own `if` blocks), so any of them can
co-fire with a chain badge or with each other in the same turn/leg:

| Badge | Exact condition |
|---|---|
| 🦉 **Night Owl** | Local hour `< 5` at the moment the turn is **committed** — shared `awardTimeOfDayBadges(p)` helper, called from both `enterTurn()` (X01) and `enterTurnCricket()` (checked per turn, not per individual dart tap; game-type-agnostic since 2026-07 — previously X01-only by accident of code structure, not a deliberate scoping decision). Celebration overlay fires once per session (`sessionBadgesShown.nightOwl`); the persistence call fires every qualifying turn regardless, in either game type. |
| 🐦 **Early Bird** | Local hour `>= 5 && < 7`, same per-turn check and once-per-session overlay gating as Night Owl — same shared helper, same X01+Cricket coverage. |
| 🎯 **Metronome** | 5 consecutive visits (raw attempted points, including busts) within 15 of each other: `max(last5) - min(last5) <= 15`. Fires at most once per leg (`p.metronomeFired`). |
| 🚗 **Cruise Control** | `win && every visit this leg scored >= 40` (raw attempted points). |
| ❄️ **Ice in the Veins** | `win && pendingIceInTheVeins && pointsThisVisit >= 50` — a 50+ checkout on the visit *immediately following* this player's own bust earlier in the leg. The eligibility flag is cleared after every visit (hit or miss both consume the window) so it only ever covers the very next visit. |
| 🧊 **Nerves of Steel** | Won a leg or set that was a genuine decider — both players tied at `legsPerSet - 1` legs (or `setsPerGame - 1` sets), entering this leg/set. Checked at two separate points in `onLegWon()`: once for a match-deciding set, once for a set-deciding (non-match) leg. |
| 🔥 **Comeback Kid** | `legWorstDeficit >= 100` — the largest `(myRemaining - opponentRemaining)` seen at any point this leg was ≥100, and this player still won the leg. Requires exactly 2 players (H2H or a 2-player practice match). |
| 🗡️ **Giant Slayer** | On a match win: `opponent's lifetime avg - winner's lifetime avg >= 15`. 2-player matches only. |
| 🔁 **The Rematch** | On a match win, an async `h2h-summary` lookup finds `previousWinner === opponent` — i.e. beat someone who beat you last time you two played. |
| 🥇 **First 100+ Checkout** | `win && pointsThisVisit >= 100`, **once-badge** — celebrates only the very first time it ever happens for that player. |
| ⚔️ **Grudge Match** | On a match win, the same `h2h-summary` lookup shows `totalGames >= 10` against this opponent. **Once-badge** per player — awarded to both the winner and the loser once the threshold is first crossed. |
| 🕐 **Around the Clock** | `singlesHit.size >= 20` — every number 1–20 hit as a single at least once **within the current game** (`singlesHit` is created fresh in `newMatchPlayer()` at every `startGame()`, persists across legs/sets within that game, and resets when a new game starts — not just on page reload). **Once-badge.** |
| 🌍 **Around the World** | Lifetime: all 63 dart outcomes hit at least once (20 numbers × single/double/treble = 60, plus outer bull, double bull, and a miss). Checked via an async progress query (`/api/players/around-the-world`), skipped once the client-side `earnedBadgeCache` already has it. **Once-badge.** |
| 👻 **Ghost Slayer** | First-ever `result==='win'` row this player writes to the `ghost_races` table (§13) — win a race against a replay of one of your own past legs (Ghost Opponent, below). Unlike every other badge in this table, checked server-side: `recordGhostRace()` (`backend/db.js`) calls `awardBadge(playerName, 'ghost_slayer', true)` on every win — `once` mode's `INSERT OR IGNORE` makes the call a no-op past the first time, so no separate first-win check is needed. **Once-badge.** |

**The lifetime-180s milestone ladder** (docs/archive/culture-badges-roadmap.md Part A,
`ONE_EIGHTY_MILESTONE_LADDERS` in `frontend/index.html`, checked from `enterTurn()`'s
existing `if(ev.scored===180){...}` block). 180! has always been a live
celebration (`queueBadge('180', p.name)`) but never a `player_badges` row at all —
it's one of the three older top-level stats (180/Big Fish/Nine-Darter, see
"Description text" below), so it had no milestone tiers despite how central
180s are and how well this data-driven ladder shape has worked for Just
Chuckin' It and Checkout Trainer. Reuses `CHUCKIN_MILESTONE_LADDERS`'s exact
`{metric,idPrefix,statNoun,descFor,tiers}` shape and `checkChuckinMilestoneTier()`
wholesale (that helper is fully generic despite its name, already shared with
Checkout Trainer's own ladders) — a single ladder, X01-only, whose value is
`(p.lifetimeOneEightiesBase||0) + p.sessionOneEighties`: `lifetimeOneEightiesBase`
is fetched once per game at `newMatchPlayer()` time via `GET /api/players/stat-
bubbles?name=<player>` with **no `mode` param** (`_mf(undefined)` returns `''`
server-side, so this is a genuinely unscoped H2H+practice lifetime count, not
one mode's own slice), and `sessionOneEighties` increments locally on every
180 this game — the same "avoid a network round-trip per dart/turn" reasoning
`newMatchPlayerChuckin()` documents for its own lifetime bases. **Permanent,
once-earned tiers** (`once:true`, never undo-revoked) — the roadmap doc's own
framing: "ladder tiers are permanent, like every other ladder," the same rule
Chuckin/Checkout Trainer's ladders already follow regardless of how
competitive the surrounding game mode is. Its `BADGE_INFO` rows carry **no
category flag** (unlike Chuckin's `chuckin:true`/Checkout Trainer's
`checkoutTrainer:true`) — X01 already has a Badge Case section to fold into,
unlike those two modes when their own ladders were built, so these 5 tiers
render inside the existing X01 section alongside the 28 badges above instead
of getting a new section of their own.

| Ladder | Metric | Tiers (threshold → label) |
|---|---|---|
| Lifetime 180s | `lifetimeOneEightiesBase + p.sessionOneEighties` | 10 Ton-Eighty Club 🎯 · 25 Maximum Regular 🔴 · 50 Half-Century of Maximums 🌟 · 100 Century of Maximums 💯 · 250 Maximum Machine 🤖 |

**Cricket badges** (checked in `enterTurnCricket()`/`onLegWonCricket()`,
`frontend/index.html`). 9 Marks/Perfect Leg (game-modes-roadmap.md build-order
step 3) are the direct analogs of 180 and the nine-darter; Whitewash/Comeback
Kid (Cricket) (2026-07, "New Cricket-native badges") are deliberately *not*
X01 ports — shaped around what makes a Cricket leg dramatic (closing numbers,
points) instead of forcing X01's checkout/remaining-score concepts onto a game
that has neither. Whitewash/Comeback Kid are both 2-player only, same
restriction as X01's own social/margin-of-victory badges, and both have their
pure trigger-condition logic in `frontend/scoring.js` (`isCricketWhitewash()`/
`cricketComebackAchieved()`), unit-tested in `backend/test/scoring.test.js`.
9 Marks and Perfect Leg fire identically in both Cricket variants (mark/dart-based,
not points-based); Whitewash reads the same in both too (never a points
condition); Comeback Kid's deficit *direction* flips per variant (§2's own
"Comeback Kid (Cricket)'s deficit direction flips with the variant" — the
badge condition itself, `legWorstPointsDeficit >= 20`, is unchanged). 🔪 Stone
Cold is cutthroat-only, checked at the whole-*game* level rather than per-leg:

| Badge | Exact condition |
|---|---|
| 🎯 **9 Marks** | `darts.length===3 && marksThisVisit===9` — 3 darts, each a treble on an in-play number, the maximum possible marks in one visit (same framing as 180 being the max possible X01 visit score). **Recurring.** |
| 🏆 **Perfect Leg** | `win && legDarts === theoreticalMinimum`, where the minimum is computed per match from `game.config.numbers`: each non-Bull number can close in a single treble (3 marks); Bull can't be trebled (`makeDart()` already downgrades a "treble bull" tap to a single), so it needs a minimum of 2 darts. A win at exactly this minimum already implies enough bonus marks were scored to strictly lead (the win condition in §2 guarantees that), so no separate points check is needed. **Recurring**, mega-tier overlay (confetti) like Nine-Darter. |
| 🧹 **Whitewash** | `isCricketWhitewash(opp.marks)` at the moment the leg is won — every value in the opponent's `marks` object is `< 3` (nobody closed), checked in `onLegWonCricket(wi)`. 2-player only. **Recurring.** |
| 🔥 **Comeback Kid (Cricket)** | `cricketComebackAchieved(w.legWorstPointsDeficit)` — `legWorstPointsDeficit >= 20` (Cricket's own threshold, chosen against Cricket's much smaller/more variable points scale than X01's 501 countdown, not X01's 100). `legWorstPointsDeficit` is the largest deficit seen at any point this leg, direction depending on variant (§2), tracked in `enterTurnCricket()` the same "sample before this visit's own update" timing X01's `legWorstDeficit` uses. 2-player only. **Recurring.** |
| 🔪 **Stone Cold** | `cricketStoneColdAchieved(w.gamePointsReceived, game.players.length)` — `game.players.length >= 3 && gamePointsReceived === 0`, checked at GAME-win time (not per-leg) in `onLegWonCricket(wi)`, cutthroat only (`game.config.variant === 'cutthroat'`). `w.gamePointsReceived` is a running total of every point ever received across the *whole match* (every leg, not leg-reset — parallel to `gameDarts`), bumped in `enterTurnCricket()` whenever this player is one of an opponent's `opponentGains`. Not resumable — like every other badge-trigger tracker, it starts fresh on a resumed game (`docs/archive/saved-games-roadmap.md`'s "what resume deliberately does NOT rebuild"). **Recurring**, mega-tier overlay (confetti) like Nine-Darter/Perfect Leg. |

**Baseball badges** (checked in `enterTurnBaseball()`/`onLegWonBaseball()`,
`frontend/index.html`) — the direct analogs of Cricket's 9 Marks/Perfect Leg,
mapped onto Baseball's own vocabulary: Perfect Inning is the per-visit max
(mirroring 9 Marks/180), Perfect Game is the per-leg max (mirroring Perfect
Leg/Nine-Darter). Walk-Off and The Cycle (docs/archive/culture-badges-roadmap.md Part
B — Baseball/Doubles Practice coverage parity) round the set out to 4:

| Badge | Exact condition |
|---|---|
| 🔥 **Perfect Inning** | `dartsThrown===3 && ev.runsThisVisit===9` — 3 darts, each a treble on that inning's target number, the maximum possible runs in one visit. Checked per-visit in `enterTurnBaseball()`, the same "doesn't depend on the leg's outcome" timing 9 Marks uses. **Recurring.** |
| 🏆 **Perfect Game** | `w.inningRuns[i]===9` for every one of innings 1–9 — a won leg with the maximum possible 9 runs in every single inning (81 total). Checked in `onLegWonBaseball(wi)` once the leg's winner and full `inningRuns` are known, the same leg-outcome timing Perfect Leg uses. **Recurring**, mega-tier overlay (confetti) like Nine-Darter/Perfect Leg. |
| ⚾ **Walk-Off** | `game.baseballInning > 9` at the moment the leg is won — the match ran past the regulation 9 innings before a sole leader emerged. Checked in `onLegWonBaseball(wi)`; `game.baseballInning` still holds the deciding visit's own inning number at that point, since `enterTurnBaseball()` only increments it *after* dispatching to `onLegWonBaseball()` on `ev.matchComplete`. **Recurring.** |
| 🔄 **The Cycle** | `isBaseballCycle(darts, ev.target)` (`frontend/scoring.js`, unit-tested in `backend/test/scoring.test.js`) — a single, double, AND treble of the *current inning's own number* in one visit (6 runs the scenic way), Baseball's cousin of Shanghai visit parameterized by the fixed inning target instead of "any number 1-20." Checked per-visit in `enterTurnBaseball()`, same timing as Perfect Inning; mutually exclusive with it (three trebles vs. one of each), so no suppression pairing is needed. **Recurring.** |

**The Baseball lifetime-runs ladder** (docs/archive/culture-badges-roadmap.md Part B,
`BASEBALL_RUNS_MILESTONE_LADDERS` in `frontend/index.html`, checked from
`enterTurnBaseball()` after every visit). Reuses `checkChuckinMilestoneTier()`
wholesale, same as the lifetime-180s ladder above — a single ladder, whose
value is `(p.lifetimeRunsBase||0) + p.sessionRuns`: `lifetimeRunsBase` is
fetched once per game at `newMatchPlayerBaseball()` time via the same
no-`mode`-param `GET /api/players/stat-bubbles` pattern (now returning
`totalRuns` from `getBaseballStatBubbles()`), and `sessionRuns` accumulates
locally across every visit this game (not reset per leg, unlike
`p.totalRuns`). **Permanent, once-earned tiers** (`once:true`, never
undo-revoked), `baseball:true` — Baseball already has a Badge Case section to
fold into.

| Ladder | Metric | Tiers (threshold → label) |
|---|---|---|
| Lifetime Runs | `lifetimeRunsBase + p.sessionRuns` | 100 Rookie Season ⚾ · 500 Everyday Player 🧢 · 1,500 All-Star ⭐ · 5,000 Hall of Fame 🏟️ |

**Doubles Practice badges** (docs/archive/culture-badges-roadmap.md Part B — this mode
had zero badges before this change). Both checked in
`throwDartDoublesPractice()`, `frontend/index.html`, right after a dart
registers as a "hit" (a double landed on one of that round's own
`config.doubles` targets — the same `ev.hit` `evaluateDartDoublesPractice()`
already computes). Both are explicitly **one-off, permanent** per the roadmap
doc — neither calls `trackBadgeForUndo()`, so unlike Around the Clock/World
(this mode's nearest structural analogs), an undone dart never revokes
either, matching the milestone ladders' own "permanent, once-earned"
treatment instead:

**The lifetime doubles-hit ladder** (`DOUBLES_HIT_MILESTONE_LADDERS`) reuses
`checkChuckinMilestoneTier()` wholesale, same shape as the runs/180s ladders
above — value is `(p.lifetimeHitsBase||0) + p.sessionHits`: `lifetimeHitsBase`
fetched once per game at `newMatchPlayerDoublesPractice()` time via
`GET /api/players/stat-bubbles?...&gameType=doubles_practice` (now returning
`hits` from `getDoublesPracticeStatBubbles()`), `sessionHits` accumulates
locally across every round this game (not reset per round, unlike
`p.roundHits`). `doublesPractice:true` — the new Badge Case section this
change adds (`renderPlayerBadges()`'s `doublesPracticeIds` bucket).

| Ladder | Metric | Tiers (threshold → label) |
|---|---|---|
| Lifetime Doubles Hit | `lifetimeHitsBase + p.sessionHits` | 50 Ring Finder 🎯 · 250 Double Duty 🔁 · 1,000 Precision Expert 🔬 · 5,000 Doubles Legend 👑 |

🎪 **Ring Master** — hit every double D1 through D20 plus the bull (21
distinct targets) in Doubles Practice, lifetime. Direct structural analog of
the passive Around the World badge: `GET /api/players/doubles-hit-sectors`
(`getDoublesPracticeHitSectors()`, `backend/db.js` — same `{hit,count,total}`
shape as `getAroundTheWorldProgress()`, just scoped to this mode's own "hit"
definition via `DOUBLES_HIT_CASE` instead of every raw dart outcome) is
queried after every hit, behind `DB._queue` so the query only runs once that
dart's own `DB.recordTurn()` write has landed; `prog.count >= prog.total`
triggers a direct `Backend.send(..., {once:true})` call, checked for
`newlyEarned`, guarded by `earnedBadgeCache` so an already-earned player skips
the query entirely on every subsequent hit.

**Bob's 27 badges** (`docs/archive/practice-ladders-roadmap.md` Part A, checked
in `enterTurnBobs27()`/`onLegWonBobs27()`, `frontend/index.html`):

| Badge | Exact condition |
|---|---|
| 🎯 **Full House** | `dartsThrown===3 && hits===3` — all three darts landed on the round's own double, the maximum possible gain for that round (Bob's 27's own "180" for a single visit). Checked per-visit in `enterTurnBobs27()`. **Recurring.** |
| 🏔️ **The Full Anderson** | `w.running === 1287` at run-end — every one of the 20 rounds hit with all three darts (27 + 3×2×(1+2+...+20) = 1287), the maximum possible run. Checked once in `onLegWonBobs27(wi)`, mega-tier overlay (confetti) like Nine-Darter/Perfect Leg/Perfect Game/Stone Cold. **Recurring**, though only ever achievable once per run by construction. |

**The survival/score ladder** (`BOBS27_SCORE_MILESTONE_LADDERS`, checked once
in `onLegWonBobs27(wi)` against `w.running`) reuses `checkChuckinMilestoneTier()`
wholesale, same generic engine as the lifetime ladders above — **but its
"value" is genuinely different in kind**: every other ladder's value is a
lifetime-cumulative counter (`lifetimeXBase + p.sessionX`) that only ever
grows across a player's whole history; this ladder's value is **this single
run's own final score**, checked once at the moment the run ends, never
accumulated across runs. `checkChuckinMilestoneTier()` is agnostic to where
its `value` argument comes from — it just tests tiers against a number and
caches "have I ever crossed this tier," which works identically whether that
number is a running lifetime total or a fresh per-run score — so no engine
changes were needed, only a different call site. **Permanent, once-earned
tiers** (`once:true`), its own Badge Case section (`renderPlayerBadges()`'s
`bobs27Ids` bucket).

| Ladder | Metric | Tiers (threshold → label) |
|---|---|---|
| Survival/Score | This run's own final `running` score | 1 Survivor 🛡️ · 100 Century 💯 · 250 Quarter Grand 🌟 · 500 Half Grand 🚀 · 1000 Four Figures 👑 |

**Tournament badges** (`docs/archive/tournament-mode-roadmap.md` §7 — checked server-side
in `_advanceTournamentMatch()`, `backend/db.js`, the same function that already
sets `winner_id`/`champion_id`, rather than a second parallel hook. Like Ghost
Slayer, the frontend never computes these conditions itself — it only detects a
newly-earned badge by diffing `GET /api/players/badges` against the pre-match
`earnedBadgeCache` snapshot, inside `finishUnit()`'s `game.tournamentMatchId`
branch, to fire the live celebration):

| Badge | Exact condition |
|---|---|
| 🏆 **Champion** | Awarded to the winning player exactly where `_completeTournament()` sets `tournaments.champion_id` — the single-elim final, or the double-elim grand final / reset decider. **Once-badge.** |
| ⚔️ **Giant Slayer (Tournament)** | On any real (non-bye) tournament match result — awarded by `_maybeAwardTournamentGiantSlayer()` per match, so a double-elim winners-bracket upset counts even though that loser only drops to the losers bracket: `winner's tournament_players.seed - loser's seed >= 3` (`TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD`) — the winner was seeded at least 3 slots worse than the opponent they beat. (In the grand final it's awarded only on the decisive result, never on a game-one loss that triggers a reset, so a reset can't double-count one conquest.) Uses its own `badgeId` (`tournament_giant_slayer`) rather than the H2H `giantslayer` row. **Once-badge.** |

**Daily Challenge badges** (checked in `checkChallengeBadges(playerName)`,
`frontend/index.html` — called right after every `/api/challenges/complete`
response resolves, using the same `{currentStreak, bestByFormat}` shape
`getChallengeHistory()` already returns to the Player Profile's Daily Challenge
tab, §6). The three pure trigger conditions live in `challengeBadgeSignals()`
(`frontend/scoring.js`, unit-tested in `backend/test/scoring.test.js`), not
inline in `index.html`, so they're covered by a committed `node:test`:

| Badge | Exact condition |
|---|---|
| 🔥 **Challenge Streak: Week** | `currentStreak === 7` exactly (an exact crossing check, not `>=`, so a long streak doesn't refire this every day). **Recurring** — a later streak that reaches 7 again after breaking can re-earn it. |
| 🏆 **Challenge Streak: Month** | `currentStreak === 30` exactly, same exact-crossing reasoning as above. **Recurring**, mega-tier overlay (confetti) like Nine-Darter/Perfect Leg. |
| 🗓️ **Full Rotation** | Every one of the 6 Daily Challenge formats (§6) has at least one *completed* attempt, ever (`bestByFormat` only ever contains completed attempts — see `getChallengeHistory()`'s own query — so this is already "at least once", not merely "attempted"). **Once-badge.** |

**The 18 Just Chuckin' It milestone badges** (checked in
`checkChuckinMilestones(playerName)`, `frontend/index.html` — called after
every dart from `throwDartChuckin()`). Requested explicitly: "achievements
specifically for this game mode, centered around major milestones... ladder
the achievements so there are a lot to earn and that earning them starts early
and often." All 18 tiers, across 3 ladders, are generated from a single
`CHUCKIN_MILESTONE_LADDERS` data array (not 18 hand-written badge definitions)
via a `.forEach()` that populates `BADGE_INFO`/`ACH_LABELS`/`ACH_DURATION` —
each ladder is `{metric, idPrefix, statNoun, descFor(threshold), tiers:
[{threshold, label, icon}, ...]}`. `badge_id` is always `idPrefix + threshold`
(e.g. `chuckin_darts_100`); the last tier of each ladder gets a longer
celebration duration (5000ms vs. the usual 3000ms), matching the "biggest
completionist milestone gets a longer beat" convention Around the World already
set.

The trigger condition itself — "has this cumulative value reached this
threshold" — is `chuckinTiersReached(tiers, value)` in `frontend/scoring.js`
(unit-tested in `backend/test/scoring.test.js`, following
`challengeBadgeSignals()`'s precedent of keeping the actual comparison out of
`index.html` so it's covered by a committed test), not reimplemented inline.
Every tier check is a plain `value >= threshold` (not an exact-crossing check
like the Daily Challenge streak badges above — a milestone, once reached, stays
reached), guarded by `earnedBadgeCache` so an already-earned tier is never
re-POSTed. **All 18 are once-badges** (never re-fire once earned) and **none
support undo-revocation** — a deliberate deviation from Around the Clock/
World's precedent, since a low-stakes practice-mode milestone staying earned on
an undone dart is a harmless edge case, not worth the added
`badgeReverts`/`snap.voided` plumbing those modes need for genuine
competitive-play corrections.

| Ladder | Metric | Tiers (threshold → label) |
|---|---|---|
| Lifetime Darts | `lifetimeDartsBase + p.sessionDarts` (computed locally — see §2's Just Chuckin' It section for why this isn't a network fetch per dart) | 100 Warming Up 🔥 · 500 In the Groove 🎯 · 1,000 Getting Serious 💪 · 2,500 Dedicated 📈 · 5,000 Grinder ⚙️ · 10,000 Iron Arm 🦾 · 25,000 Practice Makes Perfect 🏹 · 50,000 Machine 🤖 · 100,000 Legend of the Oche 👑 |
| Session Darts | `p.sessionDarts` (this session only, resets to 0 on a new game) | 100 Solid Session ⏱️ · 250 Marathon Session 🏃 · 500 Endurance Test 🧗 · 1,000 Iron Session 🔋 |
| Lifetime Trebles | `lifetimeTreblesBase + p.sessionTrebles` | 10 First Trebles 🎯 · 50 Treble Trouble 💥 · 100 Treble Century 💯 · 500 Treble Master 🌟 · 1,000 Treble Legend 🐐 |

**The 19th Just Chuckin' It badge, `chuckin180`** ("180! 🎯"), is a genuinely
different shape from the 18 above — a moment-style badge (Chuckin's own analog
of X01's own 180, since this mode has no `scored` field to detect it from) checked
inline in `throwDartChuckin()` rather than in `checkChuckinMilestones()`.
**Recurring** (fires every qualifying group of 3, not once-only) and **does
support undo-revocation** — see §2/§3's coverage of `CHUCKIN_GROUPS_OF_3`/
`p.dartBuffer` for the exact "assumes 3 darts per turn" grouping rule and why
this one badge, unlike the 18 milestones, gets the full `badgeReverts`/
`snap.voided` treatment.

**The 2 Guided Around the Clock / Around the World badges** (checked inline in
`throwDartAroundTheClock()`/`throwDartAroundTheWorld()`, `frontend/index.html`).
Deliberately distinct from the existing passive `around_the_clock`/
`around_the_world` badges above (2026-07 decision) — completing a guided
drill session celebrates the session itself; the two passive badges keep
firing exactly as they always have, from any mode, unrelated to these:

| Badge | Exact condition |
|---|---|
| 🧭 **Guided Clock** | A guided Around the Clock round completes — `evaluateDartAroundTheClock()`'s `completed` flag fires (all 20 numbers 1-20 hit as singles). **Once-badge**, undo-revocable (§2's "Guided Around the Clock / Around the World" section). |
| 🗺️ **Guided World** | The lifetime Around the World progress count reaches 63/63 as a direct result of a dart thrown during a guided Around the World session (checked inline after every dart, via the same `baselineHitSet + sessionHitSet` running total `playerSnapshotAroundTheWorld()` reports). **Once-badge**, undo-revocable. |

### Description text

Every badge (except 180/Big Fish/Nine-Darter, which are older top-level stats,
not `player_badges` rows) has an entry in `BADGE_INFO` (`frontend/index.html`) —
`{ icon, label, desc }`. The `desc` field is reused verbatim in three places:
the Badge Case tooltip, the live achievement overlay's explanation line, and the
screen-reader announcement (§11). There is no separate copy to maintain in
three places — if you change a badge's description, change it once in
`BADGE_INFO`.

Seven badges' live-overlay "type" key differs from their persisted `badge_id`
(a historical naming mismatch, bridged by `ACH_TYPE_TO_BADGE_ID`):
`first100checkout`→`first_100_checkout`, `grudgematch`→`grudge_match`,
`aroundtheclock`→`around_the_clock`, `aroundtheworld`→`around_the_world`,
`ghostslayer`→`ghost_slayer`, `tournamentchampion`→`tournament_champion`,
`tournamentgiantslayer`→`tournament_giant_slayer`.

### Undo interaction

`trackBadgeForUndo(snap, player, badgeId)` is called every time a badge is
awarded, appending to that turn's `snap.badgeReverts` list. If `undoLastTurn()`
runs before an async `once`-badge's award response arrives, `snap.voided` is set
`true` first — so the late-arriving award response revokes itself immediately
on arrival (`POST /api/badges/revoke`) instead of registering into a revert list
that will never be read again, regardless of which happens first.

This only revokes the badge server-side (the Badge Case record). The
client-side celebration itself is a separate concern, handled by
`cancelQueuedAchievementsForSnapshot()` — see §5.

---

## 5. The Achievement Queue (Simultaneous Achievements)

A single turn (or leg win, or an async milestone confirmation) can genuinely
earn more than one badge at once — e.g. a decider leg won after a big comeback
against a stronger opponent is Comeback Kid *and* Nerves of Steel *and* Giant
Slayer simultaneously. The overlay can only show one thing at a time, so every
celebration is queued and drained sequentially rather than the newest one
silently clobbering whatever was already showing.

**`queueBadge(type, player, snap, countText)`** — pushes
`{type, player, ts, snap, countText}` onto `achievementQueue`; if nothing is
currently draining, kicks off `pumpAchievementQueue()`. `countText` is an
optional, already-formatted string shown on the overlay (`'First time!'` for
once-badges, which pass it directly since they already have the award response
in scope; omitted for recurring badges, whose count isn't known yet at queue
time — see `patchAchievementCount()` below). `snap` is the turn's `game.lastTurnSnapshot`
reference — it defaults to `game.lastTurnSnapshot` at call time (correct for
the synchronous majority of call sites, called directly from `enterTurn()`/
`onLegWonCricket()`/etc.), but the handful of call sites that queue a badge
from inside an async `.then()` (Around the Clock/World, First 100+ Checkout,
Full Rotation, The Rematch, Grudge Match, Ghost Slayer, Champion, Giant Slayer
(Tournament)) pass their own already-captured snap variable explicitly instead,
since `game.lastTurnSnapshot` may have moved on to a newer turn by the time the
response arrives. Two call sites
(`challengeweek`, `challengemonth`) pass `null` deliberately — Daily Challenge
streak badges have no undo-tracking at all (a separate, pre-existing gap;
see `trackBadgeForUndo()` below), so no real snap exists to tag them with.

**`pumpAchievementQueue()`** — dequeues one item, stores its `snap` on
`currentAchSnap` (so `cancelQueuedAchievementsForSnapshot()`, below, can
recognize "the thing on screen right now belongs to the turn just undone"),
sets `pendingAchievement` (the field broadcast to `/display` — see §7) to
that item, calls `pushLive()` so this specific item gets its own broadcast
(not just whatever `pushLive()` call happened to already be at the end of
`enterTurn()`), calls `showAchievement()` to paint the overlay, calls
`announce()` for the screen-reader region (§11), then sets a timer for
`ACH_DURATION[type]` (2500ms default, up to 6000ms for a nine-darter) that
hides the overlay and recurses into `pumpAchievementQueue()` again — draining
the rest of the queue one item at a time, each getting its own full display
duration.

**`cancelQueuedAchievementsForSnapshot(snap)`** — called by every
`undoLastTurn*()` right after marking that turn's snapshot `voided` and
sending its `badgeReverts` to `POST /api/badges/revoke` (§4). Filters
`achievementQueue` down to entries not tagged with `snap` (removing any
not-yet-shown celebration earned by the turn just undone), and if the
*currently showing* achievement is tagged with `snap`, dismisses it
immediately (clears the timer, hides the overlay, removes confetti) and
advances to the next real item instead of waiting out its full
`ACH_DURATION`. This closes a real bug: `undoLastTurn()` always revoked the
badge server-side, but before this existed, the *client-side celebration*
for the undone turn had no way to know the turn it was queued for had been
undone — it would sit in `achievementQueue` (sometimes for a long time, since
the queue is otherwise strictly FIFO) and eventually surface during some
later, unrelated turn, playing out its full animation over whatever was
actually happening at that moment. Since the overlay is a full-screen
takeover, this made an unrelated *later* bust look like the live scoreboard's
bust flash "only shows for a split second" — the stale achievement was
popping up and then timing out on top of it, not the bust flash itself
misbehaving. Only entries tagged with the exact undone snapshot are touched;
an achievement genuinely earned by a different turn (still queued behind it,
or showing concurrently in front of it) is left alone.

**Known limitation**: this only prevents a *not-yet-broadcast* queued
achievement from surfacing later. `/display` runs its own independent
overlay timer once an achievement has been broadcast via SSE (see §7) — if
the undo happens after the broadcast already reached a connected `/display`
device, that device's own in-flight countdown finishes on its own; there is
no "cancel" message sent over SSE to retract an already-delivered
achievement. In practice this only matters for the few seconds between a
broadcast and an undo of that same turn, not the original bug (a stale
achievement surfacing arbitrarily far in the future).

**`showAchievement(type, player, countText)`** — the pure "paint one badge"
primitive: sets the overlay text/name/description/count, toggles the
mega-celebration class for nine-darters (with confetti), shows the Share
button. It never manages timing itself — that's entirely
`pumpAchievementQueue()`'s job — and as of the queue rework it's *only* ever
called from `pumpAchievementQueue()`, never directly.

**Moment card + live-overlay count**: `awardRecurringBadge(player, badgeId,
momentType, momentOpts)` fires the overlay celebration synchronously (via
`queueBadge`, before any network round-trip), but the real count is only known
once the `POST /api/badges/award` response resolves — its `.then()` handles
both places that show it: if `count > 1`, `" · Earned N× total"` is appended to
the shareable moment card's `statLine`, and the exact same `"Earned N× total"`
text is patched into the still-showing live overlay via
`patchAchievementCount(badgeId, playerName, countText)`. This is deliberate:
the celebration itself is never delayed waiting on the network, but both the
overlay and the card (each looked at a moment later, if at all) end up with
accurate data. `patchAchievementCount()` is guarded by `currentAchType`/
`currentAchPlayer` — a no-op if the queue has already moved on to a different
badge or a different player's instance of the same badge type by the time the
response arrives (graceful, not a bug; typically near-instant on a LAN).
Once-badges (`once:true` — Around the Clock/World, Guided Clock/World, Grudge
Match, First 100+ Checkout, Full Rotation, Ghost Slayer, every Just Chuckin'
It milestone tier) skip this
entirely: they already have the award response in scope at the point they call
`queueBadge()` inside their own `.then()`, so they pass the literal string
`'First time!'` immediately rather than a numeric count — showing `count === 1`
as a number would read oddly for something that, by construction, can only ever
happen once.

`display.html` mirrors this via a second `/api/live` push carrying the same
`achievement.ts` with `countText` now populated — its `ts`-based dedup would
normally ignore a repeat push, so `lastAchCountText` tracks the count text
separately and patches `#ach-count` in place (no re-render, no restarted
confetti) whenever it changes while the overlay is still showing.

**Suppression pairs are resolved before anything is queued** — see §4's
`CHAIN_CHECKS` filtering, which runs once per turn before any `queueBadge()`
calls happen for that turn's chain badges.

**Broadcast coverage**: every queued badge sets `pendingAchievement` generically
— `/display` receives and shows all 20 badge types, not just 180/Big
Fish/Nine-Darter (which is all it originally supported, before the queue
rework also fixed this coverage gap as a side effect of centralizing the
broadcast point).

Full design rationale: `docs/archive/simultaneous-achievements-roadmap.md`.

---

## 6. Daily Challenge

### Deterministic generation — `todaysChallenge(dateStr)`

No server-side randomness or stored state. A pure function of the calendar
date:

```js
function _seededIndex(s, mod){
  let h = 0;
  for (const ch of s) h = (h*31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % mod;
}
format = CHALLENGE_FORMATS[_seededIndex(dateStr + '|format', 6)];
target = format==='checkout_sprint' ? CHALLENGE_CHECKOUTS[_seededIndex(dateStr + '|target', 12)] : null;
```

Same date always produces the same format (and, for Checkout Sprint, the same
target) on every client — no coordination needed. `CHALLENGE_CHECKOUTS` pool:
`[121, 96, 100, 141, 170, 40, 32, 50, 60, 80, 110, 130]`.

### The six formats — exact win condition and "better" direction

| Format | Win condition | Metric | Direction |
|---|---|---|---|
| **Checkout Sprint** | A real X01 leg starting at the seeded target score | Darts to finish | **Fewer is better** |
| **Speed to Zero** | A full 501 leg | Total darts | **Fewer is better** |
| **Bullseye Gauntlet** | Exactly 3 visits (9 darts), from a filler `1000` starting category | `COUNT(darts with sector===25)` across all 3 visits | **More is better** |
| **Steady Hand** | Exactly 3 visits, filler `1000` start | `SUM(each visit's total, only if <=20, else 0)` across all 3 visits | **More is better** |
| **Treble Run** | Exactly 3 visits, filler `1000` start | `size of Set(sectors hit as a treble)` across all 3 visits (distinct numbers, not raw treble count) | **More is better** |
| **The Long Game** | 501 leg; remaining drops below 40 with **no busts allowed at any point** | Visits taken to get under 40 | **Fewer is better**; a bust before reaching the target is an immediate DNF (`activeChallenge = null`), not a lower/worse score |

Checkout Sprint and Speed to Zero complete via the normal `ev.win` path in
`enterTurn()` → `onLegWon()`. The other four end mid-visit, inside `enterTurn()`
itself (`game.legVisitLogs` accumulates each visit's darts; once the
visit/bust-free condition is met, `activeChallenge.overrideMetric` is set and
`onLegWon()` is called directly, reusing its leg-completion machinery rather
than duplicating it).

`CHALLENGE_BETTER_DIRECTION` (`backend/db.js`) encodes the same fewer/more
distinction server-side, for personal-best comparison:
```js
{ checkout_sprint:'asc', speed_to_zero:'asc', long_game:'asc',
  bullseye_gauntlet:'desc', treble_run:'desc', steady_hand:'desc' }
```

### One attempt per player per calendar day

`daily_challenge_attempts` has `UNIQUE(player_id, challenge_date)`. Enforced at
three layers:
1. **Frontend gate**: `startGame()` in challenge mode checks
   `/api/challenges/status` *before* creating a game — if today's attempt exists,
   it alerts and refuses to start (previously a second tap created a real
   filler-category game that silently wasn't tracked as a challenge).
2. **Server 409**: a second `startChallengeAttempt` INSERT for the same date hits
   the UNIQUE constraint and throws `409` — the race backstop for the gate. The
   frontend surfaces this (the game degrades to plain practice with an explicit
   alert, no longer silently).
3. **Locked completion**: `completeChallengeAttempt` only updates rows with
   `completed = 0`, so a repeat completion can never overwrite a locked-in result.

### Admin reset (Settings → Daily Challenge)

`DELETE /api/challenges/attempt?player=&date=` (**admin-only**) →
`resetChallengeAttempt()`: deletes the attempt's linked `games` row, which cascades
away the game's turns, darts, `game_players`, `timeline_events`, **and the
`daily_challenge_attempts` row itself** (its `game_id` FK also cascades) — wiping
every stat recorded during the attempt and unlocking a clean retake of that day's
challenge. Badges earned during the wiped attempt are deliberately **not** revoked
(a badge celebrates something that physically happened at the board). Resetting an
attempt that is *currently being played* deletes the live game's row out from under
it — subsequent turn writes for that game fail server-side (FK) and are dropped by
the client's fire-and-forget queue; an admin should do resets between sessions, not
mid-throw. Surfaced in Settings → Daily Challenge: player picker + date (defaults
to today) + a confirm dialog spelling out what gets deleted.

### Streaks — two independently-implemented walks

- **Current streak** (`getChallengeStatus()`): walks backward day-by-day from
  today (or from yesterday, if today hasn't been attempted yet — an unplayed
  "today" doesn't break a real streak on its own), stopping at the first
  missing date or DNF. An *attempted*-but-uncompleted today gets no yesterday
  grace — the walk starts at today, hits the incomplete row, and reports 0.
  Since `completed=0` also describes an attempt still in progress, the streak
  reads 0 mid-attempt until the completion lands (the day's single attempt is
  spent either way). Capped by a 400-day lookback.
- **Longest-ever streak** (`getChallengeHistory()`): walks the *entire* history
  forward chronologically, resetting the running count to 0 on any DNF, and to
  1 (not carrying over) whenever there's a >1-day gap between completed
  attempts, tracking the max run seen. **Deliberately not derived from the
  current-streak function** — they answer different questions and are
  independent by design, so there's no "drift" risk between them the way there
  can be between sibling stat functions.

### Personal best detection

`completeChallengeAttempt()` compares the just-completed result against every
*other* completed attempt of the same format (`challenge_date != today`), using
`CHALLENGE_BETTER_DIRECTION` to pick `MIN` or `MAX`, and returns
`{ ok, isPersonalBest }`. The frontend patches a gold "New personal best!"
banner into a `#challenge-pb-banner` placeholder on the results screen once
this async response resolves — the results screen itself renders immediately,
unblocked (same pattern as the achievement queue's count-patching).

### Player Profile history view

`getChallengeHistory(player, date)` returns: `played`/`completed` totals
(unscoped, all-time), `currentStreak` (delegates to `getChallengeStatus`),
`longestStreak` (the independent walk above), `bestByFormat` (per-format best
result using the same direction table), and `attempts` (full log, newest first,
capped at 400 rows).

Rendered in its own **Daily Challenge** tab on the Player Profile (`.player-tabs`,
alongside Overall/H2H/Practice, `switchPlayerTab('challenge')`) — previously a
collapsible section tucked inside every other tab, promoted to a dedicated tab
so the streak/history report and the Badge Case (which now groups X01/Cricket/
Daily Challenge badges separately) live together in one place. The tab
intentionally omits the X01/Cricket stat-bubbles/chart machinery those other
tabs use — the history view is game-type-agnostic and doesn't need it.

---

## 7. Live Scoreboard & Real-Time Sync

### Transport

`GET /api/live` returns the current in-memory snapshot; `GET /api/live/stream`
is a Server-Sent Events connection that receives the current state immediately
on connect, then every subsequent `POST /api/live` push, plus a 25-second
heartbeat comment to keep the connection alive through proxies. State is
**never persisted** — a server restart resets it to `{active:false}`.

Connection caps (not the general rate limiter): `MAX_SSE_TOTAL=50` total open
connections, `MAX_SSE_PER_IP=5` per IP — `503` once either is hit. The per-IP
counter is only incremented (and its cleanup listener registered) *after* the
SSE handshake (`writeHead`/initial `write`) actually succeeds, so a socket that
dies mid-handshake can't leak a permanently-stuck slot.

### Payload shape (`liveSnapshot()`, `frontend/index.html`)

Built fresh on every `pushLive()` call from the current `game` object: active
flag, category/legs/sets/current-player-index, per-player data (shape depends
on `gameType` — X01: score/averages/darts breakdowns via `playerSnapshotX01`;
Cricket: `marks`/`points`/darts breakdowns via `playerSnapshotCricket`;
Baseball: `totalRuns`/`inningRuns`/darts breakdowns via `playerSnapshotBaseball`;
Chuckin: session darts/trebles plus a live `heatmap` array and `sessionAvg` via
`playerSnapshotChuckin`, §3's "Live Scoreboard" coverage; Around the Clock/
World: `hitNumbers`/`hitOutcomes` plain arrays plus a running hit/progress
count via `playerSnapshotAroundTheClock`/`playerSnapshotAroundTheWorld`, §3's
"Guided Around the Clock / Around the World" coverage), current visit's
darts, checkout hint (X01 only — always empty for Cricket/Baseball), status,
`pendingAchievement` (§5), one-shot fields (`lastTurnEvent`, `matchResult`,
`legStart` — cleared immediately after each push, so they only ever announce
once), a `checkoutTarget` for voice announcements, `baseballInning` (Baseball
only — which inning, 1-9 or beyond on a tie, is currently live; per-player
runs ride inside `players[]` above instead), and (tournament matches
only, §15) `tournamentRoundLabel`. `ALLOWED_LIVE_KEYS` on the server
allow-lists exactly these top-level fields (not the per-player shape inside
`players`, which is how Cricket's/Baseball's differently-shaped player objects
— and Chuckin's `heatmap`/`sessionAvg` — pass through unchanged) — anything else
in a `POST /api/live` body is silently dropped (413 if the sanitized payload
still exceeds 64KB). **Adding any new top-level `liveSnapshot()` field must add
it to `ALLOWED_LIVE_KEYS` in the same change** — `tournamentRoundLabel` itself
was initially missed here during development and silently dropped by the
allow-list until caught in end-to-end testing, exactly the failure mode this
note now exists to prevent happening again.

Cricket's live scoreboard (`renderers.cricket.scorecard()` in `display.html`,
mirrored by `renderGameCricket()` on the controller in `frontend/index.html`)
is a single traditional chalkboard-style table — not per-player cards like X01.
Rows are the match's in-play numbers (highest to lowest, Bull last); columns
are players. Each cell renders the mark count as a slash (1 mark), an X (2
marks), or a circled X (3+ marks/closed) — the circle is the non-color-only
"closed" signal (`docs/accessibility-roadmap.md`), not a color change alone. A
`Pts` footer row shows each player's running total, and the currently-throwing
player's column is highlighted. Because this is one shared table rather than
one card per player, `render()` forces the live-scoreboard grid to a single
column for Cricket regardless of player count or orientation.

### Layout presets

`full` / `compact` / `minimal`, chosen in Settings or overridden per-screen via
`?layout=` in the URL. Checkout suggestions, achievement flashes, and the match
bar always show in every layout; `compact`/`minimal` hide the denser rows (dart
counts, leg/game averages, per-game 180/Big Fish/Bust counters).

### Orientation (portrait vs. landscape)

`display.html` detects orientation via `window.matchMedia('(orientation:
portrait)')`, toggling an `orientation-portrait` body class and re-rendering the
last-received snapshot immediately on change — a mounted tablet or phone can be
rotated mid-match, so this isn't a one-time check at load. In portrait, the
player-card grid always uses a single column (`grid-template-columns` computed
in `render()`) regardless of player count, since portrait's narrow width would
otherwise cram score text into side-by-side cells sized for landscape's
wide-and-short shape; landscape keeps its existing player-count-based column
logic (1/2/3 columns). The top bar also gets `flex-wrap` in portrait so
brand/format/game-stats/live-indicator wrap onto a second line instead of
overflowing a narrow viewport. This applies uniformly to both the live
per-player grid and the between-leg/game summary cards, since both render
through the same `#grid` container and column-count logic.

### Voice announcements (`/display` only)

Uses the browser's built-in `SpeechSynthesis` API — no server involvement, no
external service, off by default via a master switch with each call-out
independently toggleable. A sequential queue (`_announceQueue`/`_processQueue`
in `display.html`) plays speech/sound events one at a time so overlapping
events (e.g. a Big Fish that also wins the leg) don't talk over each other.
The 180 call-out ("One! Hundred! and! Eighty!!") is built as four separate
utterances with escalating pitch and slowing rate per word, since the Web
Speech API can't bend pitch or stretch a vowel mid-utterance. The Big Fish
sound is a procedurally-synthesized noise-burst "splash" (filtered decaying
noise via `AudioContext`), not a recorded file — kept dependency/licensing-free.

---

## 8. Shareable Moments

`buildMomentCard({icon, headline, player, statLine, desc, footer})` renders an
800×800 JPEG (quality 0.88) canvas card entirely client-side — no server
round-trip, no image hosting. Below the icon/headline/player name, `statLine`
(if given) draws the specific-occurrence recap (e.g. "500 lifetime darts" or
"501 · Won 3-1 in legs") and `desc` (if given) draws a second, muted, wrapped
line beneath it — the actual **explanation of the achievement** (e.g. "Throw
500 lifetime darts in Just Chuckin' It."), chained off whichever of
player/statLine was drawn last so it never overlaps either. `fireMomentCard(type,
opts)` is the one choke point nearly every achievement/moment card goes
through; it resolves `desc` automatically via `achDescFor(type)` (the same
lookup the live achievement overlay and voice announcements already use — see
§4) whenever the caller doesn't supply its own, so every card gets a real
explanation without each of the ~50 call sites needing to pass one. It then
stores the card in `momentCards[type]` and fires the corresponding Home
Assistant webhook (base64-encoded image) if one is configured.
`shareMomentCard(type)` reads the stored canvas and opens the native Web Share
sheet (or falls back to a plain image download).

`achDescFor()`'s fallback chain (§4) is the single source for every
explanation: a badge id's `BADGE_INFO[id].desc` first, then `ACH_DESC_FALLBACK`
for the handful of card types that aren't a persisted badge (`180`/`bigfish`/
`ninedarter`, plus `matchwin`/`dailychallenge`, which fire a card on every
occurrence rather than a one-off milestone). `checkout100` (the On This Day
flashback's own label for a 100+ checkout, not a real `badge_id`) has its own
`ACH_DESC_FALLBACK` entry for the same reason.

**Exceptions — call sites that don't go through `fireMomentCard()`, and so
resolve `desc` themselves**:
- The On This Day flashback (§3) calls `buildMomentCard()` directly and skips
  the HA webhook, since it fires on *every* profile page view, not on a real
  occurrence — routing it through `fireMomentCard()` would spam an HA webhook
  every time someone opens a profile page. Passes `desc: achDescFor(data.type)`
  itself.
- `sharePersonalBest(kind, value)` (Player Profile → Personal Bests → 📤 Share,
  for Best Leg Average / Fewest Darts to Finish) — these aren't badges (no
  `BADGE_INFO` entry, so `achDescFor()` doesn't apply), so it carries its own
  short `desc` per kind.

**Player Profile "Moments" gallery** (`docs/archive/shareable-moments-roadmap.md`):
the Badge Case (§4) doubles as this — every *earned* badge tile gets a 📤 Share
button (`shareEarnedBadge(badgeId)`) that regenerates that badge's card on
demand (icon, label, current player, and — since this reads straight from
`BADGE_INFO[badgeId]`, which already has it — `desc`) and shares/downloads it
via the same `shareOrSaveCanvas()` path, independent of whether the achievement
overlay is still showing or was ever tapped at the time. This is a genuine
"moment from the past" replay, not a stored image — resolving the roadmap
doc's own open question ("cache cards, or regenerate on demand?") in favor of
regenerating, consistent with this app's standing "recompute at query time,
store nothing pre-aggregated" philosophy. Not-yet-earned badges (dimmed/
greyscale in the Badge Case) get no Share button, since there's nothing to
regenerate. (This re-share path previously omitted `statLine`/`desc` entirely —
a re-shared badge card showed only the icon, headline, and player name, with
no explanation of what was earned — see `docs/bug-roadmap.md` BUG-21.)

---

## 9. Security Model

### Password/PIN hashing

`crypto.scrypt` (async wrapper, `auth.scryptAsync`) — never the synchronous
`scryptSync`, which would block Node's single event loop for ~50-100ms per call
and let a flood of login attempts stall the entire server including the live
scoreboard. `login()` pays the same scrypt cost for both real and unknown
usernames (a lazily-cached dummy hash) so response timing can't be used to
enumerate valid usernames.

### Lockout mechanics

- **Admin login — progressive backoff** (`docs/archive/admin-login-backoff-roadmap.md`,
  replaces the old flat threshold+5-minute-lock design): `login()`/
  `verifyAdminPassword()` share one formula, `adminLockoutDelayMs(fails)`. The
  first `admin_lockout_grace` consecutive failures (default 3) cost **no delay
  at all** — real admins mistype passwords. Each failure past that grace window
  doubles the wait — `base * 2^(fails - grace - 1)` seconds, `base` from
  `admin_lockout_base_seconds` (default 2s) — capped at
  `admin_lockout_max_seconds` (default 900s = 15 min). Worked example at the
  defaults: fails 1-3 → no delay; 4 → 2s; 5 → 4s; 6 → 8s; ...13 → capped at
  900s; every failure after that stays at the cap. **There is no point at which
  a correct password stops working** — once `login_locked_until` has passed,
  the very next attempt is evaluated normally; a correct password succeeds
  immediately and resets the counter to zero. The 423 response includes the
  computed remaining wait ("Try again in 4 seconds." / "...about 3 minutes.").
  All three values are configurable in Settings → Admin accounts (grace 0–100,
  base 1–3600s, max 1–86400s).
- **Player PIN**: unchanged, a flat threshold (default 10,
  `DEFAULT_PIN_LOCKOUT_THRESHOLD`), configurable 1–1000, 5-minute lockout —
  deliberately out of scope for the admin-login backoff redesign above (see
  that doc's own open questions).
- Both counters use a `RETURNING`-based `UPDATE` (`bumpLoginFail`/`bumpPinFail`)
  so the lockout decision compares against the actual post-increment persisted
  count, not a value read before the async `verifySecret()` yield — this closes
  a race where concurrent failed attempts could each read the same stale count
  and let an extra guess past the threshold.
- Per-account lockout is a deliberate, accepted-tradeoff defense, not a
  complete one — an attacker who knows a username/player name can still grief
  that one account into lockout (though now only into a growing wait, never a
  full block — see above). The per-IP rate limiter (below) is the primary
  defense against a flood; lockout is the backstop for slow, distributed attempts.
- **Recovery**: `backend/admin-recovery.js` (a standalone CLI, same precedent
  as `backend/backup.js` — direct filesystem/container access, no HTTP
  surface) provides `list`/`reset-password <username>`/`clear-lockout
  <username>` for a forgotten admin password or a stuck lockout when no other
  admin can log in to fix it. `changeAdminPassword()` clears
  `login_fail_count`/`login_locked_until` as part of any password change,
  closing a gap where resetting a locked-out admin's password alone would not
  have restored access until the lock naturally expired — this applies to
  both the normal in-app Settings flow and the recovery CLI's
  `reset-password`. `clearAdminLockout()` clears the same two columns without
  touching the password, for an admin who remembers their password fine but
  is just locked out. `listAdmins()` additionally returns
  `loginFailCount`/`loginLockedUntil` so the CLI's `list` subcommand can show
  lockout status without a separate query.

### Rate limiting (`server.js`, `rateLimit(bucket, ip, max, windowMs)`)

| Bucket | Limit | Applies to |
|---|---|---|
| `global` | 300 req / 60s per IP | Every request, before routing |
| `setup` | 10 / 60s per IP | `POST /api/setup` only |
| `login` | 10 / 60s per IP | `POST /api/login` only |
| `pin` | 10 / 60s per IP | `POST /api/players/verify-pin` only |
| `backup-restore` | 10 / 60s per IP | `POST /api/backups/restore` and `POST /api/backups/upload-restore` only — both re-verify a password, the same password-guessing-surface reasoning as `login` |

Each bucket is separate specifically so gameplay PIN checks never get throttled
by unrelated setup/login traffic (they were briefly merged into one shared
`'auth'` bucket during development and caused exactly this cross-endpoint
interference — kept split ever since). `clientIp()` only trusts
`X-Forwarded-For` when `TRUST_PROXY=true` is explicitly set — otherwise a
reverse-proxied deployment collapses every client onto the proxy's one address,
sharing a single budget across the whole household; `clientIp()` prints a
one-time startup-adjacent warning (not per-request) the first time it observes
`X-Forwarded-For` while `TRUST_PROXY` is unset, so this misconfiguration
actually surfaces instead of silently degrading (`docs/bug-roadmap.md` BUG-15).

Every write endpoint additionally requires `Content-Type: application/json`
(`415` otherwise, checked in `readJson()` before the body is even read) —
closes a CSRF path where a cross-origin page's "simple" request (no CORS
preflight) could otherwise drive a write under the `OCHE_REQUIRE_AUTH=false`
LAN-trust opt-out (`docs/security-audit-roadmap.md` SEC-19). `readJson()` also
accumulates the request body as raw `Buffer` chunks (decoded to a string
exactly once, at the end) rather than concatenating per-chunk decoded strings —
the size cap is enforced in real bytes rather than decoded character length as
a result (`docs/bug-roadmap.md` BUG-10 / SEC-21 respectively).

**Client-side interaction with the `global` bucket**: a request that gets a 429
is not retried — `DB._queue`'s `.catch(logErr)` (`frontend/index.html`) logs it
to the console and moves on, so a rejected `recordTurn()` write is silently lost
from that point forward. In practice this is only reachable at throw rates far
beyond human play, but it's the reason Just Chuckin' It's milestone-badge check
(§2/§4) was rewritten to avoid a network round-trip on every single dart —
found during testing, doubling the request rate per dart in that mode was
enough to occasionally trip this exact path.

### `OCHE_REQUIRE_AUTH` — the write-gating switch

Two auth gates exist: **`requireAdmin`** always requires a logged-in admin
session; **`requireWrite`** behaves exactly like `requireAdmin` unless
`OCHE_REQUIRE_AUTH` is explicitly set to `"false"` or `"0"` (case-insensitive),
in which case it's a no-op (public). Zero-trust default: reads (stats,
scoreboard, settings-for-display) always stay public, but every write
(recording turns, starting games, awarding badges) requires a logged-in admin
session even on a fully-trusted LAN — the app never assumes a device on the
network is safe just because it's on the network. An unrecognized env value
fails closed (still required), not silently disabled. Set
`OCHE_REQUIRE_AUTH=false` to opt back into the pre-2026-07 open-LAN behavior
(reads and gameplay writes both open, only destructive/admin actions require
login) for a fully-trusted household network. See
`docs/security-hardening-roadmap.md` for the design history of this default
flip.

### The setup wizard and `Auth.ensureCanWrite()` (`frontend/index.html`)

`Auth.ensureCanWrite(onOk)` is the client-side gate every write action calls
through (add/rename a player, start a game, etc.): if the server doesn't
require auth or the client is already logged in, `onOk()` runs immediately.
Otherwise it needs an existing admin account to log into — but if
`Auth.setupRequired` is true (zero admins exist yet), there's nothing to log
into, so it opens the **setup wizard** (`showWizard(onOk)`) instead of the
login modal, which would otherwise be a dead end. `showWizard`/`submitWizard`
thread `onOk` through via `window.__wizardOk`: on successful admin creation,
the originally-attempted action resumes automatically (e.g. the "add player"
prompt that triggered the gate appears right after); skipping the wizard
clears `window.__wizardOk` and simply abandons that action, and the *same*
prompt reappears the next time any write is attempted, since `setupRequired`
hasn't changed. The wizard's own copy branches on `Auth.requireAuth`: under
the zero-trust default, skipping means no games can be started at all (stats
and the live scoreboard remain viewable); under `OCHE_REQUIRE_AUTH=false`,
skipping only leaves Settings/PIN management open, exactly as before this
default existed. The unconditional first-load popup (`showWizard()` with no
argument, gated on `!localStorage.getItem('oche_wizard_dismissed')`) uses the
same generic "created" confirmation it always has, since there's no pending
action to resume in that path.

Server-side, `createFirstAdmin()` (`db.js`) guards against two concurrent
`POST /api/setup` calls both succeeding: the actual insert is one atomic `INSERT
... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM admins)` statement, not a
separate check followed by an insert — closing the window that used to exist
between checking `isSetupRequired()` and finishing the ~50-100ms scrypt hash
(`docs/security-audit-roadmap.md` SEC-20). The plain `isSetupRequired()` check
at the top of the function remains, purely as a fast-path that skips the hash
entirely when setup is obviously already done.

### Egress guard (`netguard.js`) — outbound-request SSRF/DNS-rebinding protection

Used before any server-initiated request to an admin-configured destination
(currently: the Home Assistant URL). `resolveAllowedHost(hostname)` resolves
the hostname **once**, checks the resolved IP, and returns that literal IP for
the caller to connect to — the caller sends the original hostname only as the
`Host` header / TLS SNI. This closes the DNS-rebinding window between "checked"
and "connected" that a naive re-resolve-at-connect-time approach would leave
open.

- **Always blocked**: loopback (`127.0.0.0/8`, `::1`) and link-local
  (`169.254.0.0/16` — this includes the cloud-metadata address — and `fe80::/10`).
- **Allowed by default, blockable via `HA_BLOCK_PRIVATE=true`**: private/LAN
  ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) — most self-hosted Home
  Assistant installs live here, so they're allowed by default.

### Response headers (every response)

`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, and a `Content-Security-Policy` restricting
`default-src`/`script-src`/`style-src`/`font-src`/`img-src`/`connect-src` to
`'self'` (plus Google Fonts for fonts/styles, `data:` for images). Note the CSP
uses `'unsafe-inline'` for `script-src`/`style-src` — not a strict nonce-based
policy, since inline `<script>`/`onclick` handlers are still used throughout
`index.html`/`display.html` (a known, documented gap, not an oversight — see
`docs/security-audit-roadmap.md` SEC-10). When `COOKIE_SECURE=true`, every
response also gets `Strict-Transport-Security: max-age=15552000;
includeSubDomains` — conditional on that flag specifically (not unconditional),
since sending HSTS over plain HTTP would be actively harmful for the default
LAN deployment. Leaving `COOKIE_SECURE` unset prints a one-time startup warning
(`docs/security-audit-roadmap.md` SEC-24) rather than silently shipping the
session cookie without its `Secure` flag.

Every static file served by `serveStatic()` (`index.html`, `display.html`,
`scoring.js`, and any 404 SPA-fallback response) additionally gets
`Cache-Control: no-store`. There's no build step or filename hashing — the
frontend is served as plain files at fixed paths — so without an explicit
no-cache directive, a browser (mobile Safari in particular) can keep serving
an old cached copy indefinitely after a server upgrade. `/api/*` responses are
unaffected by this header (each API call already opts out of caching itself
via `fetch(..., {cache: 'no-store'})` in `Backend.get()`).

The boot sequence (`(async function init(){...})()`, bottom of
`frontend/index.html`) wraps both `DB.detect()` and `DB.loadAll()` in
try/catch, falling back to `showBackendErrorScreen()`'s "Can't reach the
database" retry screen on either failure. `DB.loadAll()`'s guard matters
independently of `DB.detect()`'s: the backend can be reachable (`DB.detect()`
passes) while the specific `/api/players`/`/api/stats` calls it makes still
fail (a stale cached page whose assumptions no longer match the live server,
a request dropped mid-restart, etc.) — without its own guard, that failure
left every section of the page frozen on its static "Loading…" placeholder
forever with no error shown, indistinguishable from the app having actually
lost its data.

### Sessions

Server-side, keyed by a SHA-256 hash of the raw token (the raw token itself is
never stored) — the client only holds an `HttpOnly`, `SameSite=Strict` cookie
(`Secure` too, when `COOKIE_SECURE=true`). 30-day TTL. Expired sessions are
lazily deleted on lookup and swept on every successful login.

### Known, accepted gaps

None currently open. `POST /api/ha-webhook` (the inbound trigger that fires an
already-configured HA webhook) is gated by `requireWrite` like every other
state-changing endpoint (SEC-7, `docs/security-audit-roadmap.md`) — requires a
logged-in admin session by default, the same as `POST /api/games` or any other
write, unless `OCHE_REQUIRE_AUTH=false` opts back into open-LAN behavior.

---

## 10. Home Assistant Integration

Outbound-only, opt-in. `fireHaWebhook(event, payload)` (`backend/db.js`) looks
up `ha_url` + `ha_webhook_<event>` from Settings; if either is blank, it's a
no-op (`{skipped:true}`). Otherwise it resolves the host via `netguard` (§9),
POSTs `{ ...payload, event, timestamp }` as JSON to
`<ha_url>/api/webhook/<webhook_id>`, with a 5-second timeout.

**Event list**: `oneeighty`, `bigfish`, `bust`, `ninedarter`, `tonplus`,
`momentcard` (payload includes the base64 image), `gamestart`, `gameend`,
`setstart`, `setend`, `legstart`, `legend` — each has its own independent
webhook ID field in Settings, so you can wire up only the events you care about.

---

## 11. Accessibility

### Screen-reader announcements (`#sr-announcer`, `frontend/index.html`)

A visually-hidden (`.vh` class) `aria-live="polite" aria-atomic="true"` region.
`announce(text)` clears the region's content, then sets the new text on the
next animation frame — necessary because most screen readers won't re-announce
a live region whose text content didn't change (e.g. two busts in a row need
this clear-then-set to both actually be spoken).

Two, and only two, triggers — deliberately scoped to avoid talking over every
intermediate dart tap:
1. **`enterTurn()`'s committed result** — "Alice scores 60, 201 remaining." /
   "Alice busts, stays on 140." / "Alice checks out with 40. Leg won."
2. **Every achievement as `pumpAchievementQueue()` shows it** (§5) — player
   name, badge label, and the same `BADGE_INFO[...].desc` text used everywhere
   else.

`display.html` is **not** currently covered — an open question in
`docs/accessibility-roadmap.md` about whether the shared/ambient scoreboard
display warrants the same investment as the primary controller.

### Colorblind-friendly palette

Admin toggle in Settings; swaps the app's red/green double/treble color coding
(dartboard rings, Pad mode buttons, win/bust status text, live scoreboard
checkout flashes and dart-class colors) for a blue/orange palette. Applies to
both the controller and `/display`.

### Outcome progress grid (`buildOutcomeGridHtml()`, `frontend/index.html`)

The Player Profile's "Around the World Progress" grid and the two guided
drills' (Around the Clock/World) live in-game progress grids all share one
implementation, `buildOutcomeGridHtml(hitSet, {cells, live})`. Each cell
signals "hit" with a non-color checkmark glyph + a per-cell `aria-label`
("Single 5, hit"/"Single 5, not yet hit"), not gold background color alone —
closing a color-only gap that existed in the original, Player-Profile-only
version of this grid before the two drill modes were built
(docs/game-modes-roadmap.md "Guided Around the Clock / Around the World").
The live in-drill usage (`live:true`) additionally wraps the grid in an
`aria-live="polite"` region so a screen reader announces each new hit as it
happens, without adding that live-announcement behavior to the static
Player Profile section (which only ever renders once per page load).

### Input paths

**Pad mode is the app's decided accessible input path** (docs/accessibility-roadmap.md,
2026-07) — not just an alternate UI skin. Number grid + Single/Double/Treble
buttons, ordinary focusable `<button>` elements: no dartboard shape to
perceive and no precise tap-target aiming required, unlike the SVG Dartboard's
sector/ring hit-testing. `default_scoring_input` in Settings picks which mode a
new game opens with; the Settings copy (both the Scoring section that owns the
setting and the Accessibility section, which cross-references it) says so
directly, so an admin setting up the app for a low-vision or motor-impaired
player knows which mode to pick.

### Contrast (WCAG AA)

Audited 2026-07 (relative-luminance contrast ratios computed against every
text-color/background pairing, not assumed). `--green` (`#2fa050`, was
`#1b8a3a`) and `--bust` (`#ea6058`, was `#e2473d`) were both brightened —
their previous values fell short of 4.5:1 as text against `--surface` and/or
`--board` (the "leg won" status line, Cricket's closed-number marks, bust
status, and settings/wizard error banners). `--red` (`#c8102e`) stays
unchanged — it's only ever used as a border/background color (passes the
lower 3:1 UI-component bar) except the Pad's "Bull" label, which now uses a
dedicated `--red-text` (`#ff8a93`) instead. The dartboard SVG's own "Bull"
center-circle label (a hardcoded hex, not a CSS variable) is dark text in
colorblind mode and cream otherwise — the orange colorblind-mode substitute for
red made that label unreadable at the default cream, a genuine regression the
audit caught. Full punch list: `docs/accessibility-roadmap.md`.

### Type size

Audited 2026-07: catalogued every sub-13px `font-size` in `frontend/index.html`.
The compact 10-12px tier (field labels, chips, secondary metadata) is a
deliberate, working design choice, kept as-is — zoom isn't disabled and none
of it is essential/blocking content. Two 9px outliers that were actually
primary (non-decorative) labels were bumped to the existing 10.5px tier:
`.bubble-label` (names each stat bubble's number) and `.cs-throw-chip` (the
Cricket scorecard's sole textual "whose turn" indicator). `display.html`'s
`vmin`-based scale is a different concern (scales with the physical display),
not covered by this pass.

### Known open gaps

None currently open — see `docs/accessibility-roadmap.md`'s own "Open
questions" section for the two genuinely unresolved design questions (how much
`aria-live="polite"` vs. `"assertive"` should vary by event type, and whether
`display.html` warrants the same investment as the controller), which aren't
gaps so much as open design calls for whoever picks them up next.

---

## 12. Backups

### The mechanics (`backend/backup-lib.js`)

Shared by both call sites below — the exact same WAL-aware snapshot/restore
code, so the cron script and the Settings UI never drift apart. Uses
`node:sqlite`'s built-in `backup()` API (not a plain file copy), since the
database runs in WAL mode and recent writes can still be sitting in a separate
`-wal` file that a naive `cp` would miss. Writes a timestamped snapshot to
`<data-dir>/backups/darts-<timestamp>.db`, then prunes anything older than the
retention window (`settings.backup_retention_days`, default 7 — falls back to
the `BACKUP_RETENTION_DAYS` env var, then the hardcoded default, if that
setting has never been touched). No new dependencies.

A restore candidate — whether an existing backup on disk or an uploaded file —
is always validated before it's used: the 16-byte SQLite file-header magic
string, then a real read-only open and `PRAGMA integrity_check`. `stageRestore()`
then copies the validated file to a `.restore-pending` sidecar **next to** the
live database — it never touches the live database file itself
(`docs/bug-roadmap.md` BUG-11: the earlier version copied straight over the live
file while the server process still held it open, so any write landing in the
window before the required restart risked corrupting the just-restored data).
`applyPendingRestoreIfAny()`, called once at the very next
process startup — in `db.js`, before the live `DatabaseSync` connection is ever
opened — is what actually applies it: clears any stale `-wal`/`-shm` files next
to the live database, then atomically renames the pending file over it. Nothing
can be mid-write against the live path at that point, since it hasn't been
opened yet this process, so there's no window for corruption. **This still does
not make the already-running server pick anything up** — the pending file sits
untouched until that next startup — so every restore path still ends with the
same explicit "restart the container/process now" instruction rather than the
server restarting itself; the difference is entirely in what happens to the
live file in the meantime.

### `node backend/backup.js` — the cron script

Run manually or on a schedule via host cron (see README for the recommended
crontab line). Writes one snapshot per run via the shared library above, then
prunes. Env vars: `DARTS_DB` (same var the server uses), `BACKUP_DIR` (default:
a `backups` folder next to the database), `BACKUP_RETENTION_DAYS` (default 7,
overridden by the Settings UI's retention control once one is set).

### Opt-in Compose-profile sidecar (`docker-compose.yml`'s `backups` service)

An alternative to host cron for anyone who'd rather not touch their server's
crontab: a second service in `docker-compose.yml` gated behind
`profiles: ["backups"]`, invisible to a plain `docker compose up` and started
only via `docker compose --profile backups up -d`. It reuses the exact same
image, entrypoint (ownership fix + drop to the non-root `node` user), and
`./darts_data` volume as the main `darts` service — no separate image, no new
dependency — with its `command` overridden to
`sh -c "while true; do node backend/backup.js; sleep 86400; done"` instead of
`node backend/server.js`. This runs one backup immediately on container start,
then every 24h — a simple loop, not a wall-clock-pinned schedule (it won't
necessarily land at exactly 3am the way the host-cron recipe does). Retention
is resolved exactly the same way as every other call site (`resolveRetentionDays()`
in `backup-lib.js`): the `settings.backup_retention_days` value if one has been
set from Settings → Backups, else `BACKUP_RETENTION_DAYS`, else the 7-day
default.

### Settings → Backups (admin-gated UI + API)

Lets an admin manage backups from the app instead of needing shell access to
the host — download existing backups, change the retention window, take an
on-demand backup, and restore from either an existing backup or an uploaded
file.

- **List/download/delete** — `GET /api/backups` → `{ backups:[{name,size,mtime}],
  retentionDays }`; `GET /api/backups/download?name=...` streams the file;
  `DELETE /api/backups?name=...`. Every `name` is validated against the exact
  filename pattern `createBackup()` produces before touching the filesystem, so
  a crafted name can't traverse outside the backups directory.
- **On-demand backup** — `POST /api/backups` takes a snapshot right now, so an
  admin can generate (and then download) one without host cron already being
  configured.
- **Retention** — `PUT /api/backups/retention` `{ days }` (1-365) writes
  `settings.backup_retention_days` and immediately re-prunes with the new value,
  rather than waiting for the next cron run.
- **Restore from an existing backup** — `POST /api/backups/restore`
  `{ name, password }`. Restoring replaces the *entire* live database, so it's
  treated as at least as destructive as "Wipe all data" (Settings → Danger
  Zone): it re-verifies the admin's password via `db.verifyAdminPassword(id,
  password)` even though the browser already has an active session, rather than
  relying on the session alone. That function reuses `login()`'s exact
  `login_fail_count`/`login_locked_until` lockout columns and threshold — a
  genuine additional password-guessing surface on the same account, not a
  separate concern.
- **Restore from an uploaded file** — `POST /api/backups/upload-restore`. The
  body is the raw `.db` file (not JSON), streamed straight to a temp file on
  disk rather than buffered — every other write endpoint goes through
  `readJson()`'s 1MB cap, which a real backup file will exceed as data grows
  over years. Capped at 500MB (`Content-Length` is checked up front so an
  oversized declared upload is rejected before any bytes are read; the actual
  byte count is also checked mid-stream as a backstop). Since the body isn't
  JSON, the admin's password travels in an `X-Admin-Password` request header
  instead, verified *before* the upload starts streaming so a bad password
  doesn't cost the bandwidth of a large rejected upload.
- All of the above are gated by `requireAdmin` unconditionally (not
  `requireWrite`) — managing or restoring the whole database is at least as
  sensitive as `/api/wipe-all` and `/api/admins`, which use the same
  unconditional gate regardless of `OCHE_REQUIRE_AUTH`.

### Settings → Data Export (admin-only)

`docs/archive/data-export-roadmap.md`'s original design proposed a per-player,
PIN-gated export reachable from a Player Profile page; that was reopened with
fresh product direction (2026-07) and shipped differently — **admin-only**,
reached from a dedicated admin page (`Settings → Admin & Danger Zone → Data
Export → Export a player…`), not from the Player Profile, and not PIN-gated
(the admin session cookie is the gate, same as the full-database export).

- **`db.getFullDatabaseExport()`** returns `{ exportedAt, players, games,
  gamePlayers, turns, darts, timelineEvents, playerBadges,
  dailyChallengeAttempts, tournaments, tournamentPlayers, tournamentRounds,
  tournamentMatches, dartComponents, loadouts, ghostRaces, leagues,
  leaguePlayers, leagueFixtures, playerUuidAliases, savedGames,
  marathonSessions, marathonSessionLegs }` — every
  player/game/stat table (including the four
  tournament tables, `docs/bug-roadmap.md` BUG-6, the three league tables,
  §18, the merge tool's uuid-alias table, the saved-games pause slots, and
  the two Marathon session tables — session groupings/durations can't be
  reconstructed from the raw leg games alone), reformatted as plain JSON. It
  deliberately excludes the `admins`, `sessions`, `settings`, and `server_errors`
  tables entirely (internal/credential tables, not "your darts data"), and the
  `players` rows only select `id, uuid, name, out_mode, created_at, dart_weight` —
  `pin_hash`/`pin_salt`/`pin_fail_count`/`pin_locked_until` never leave the
  server, exported or not, the same write-only handling every other credential in
  this app gets. **Standing rule:** any new user-data table must be added to this
  export (and to `wipeAllData()`/`resetStats()`, BUG-7) in the same change that
  creates it.
- **`GET /api/export-all`** (`requireAdmin`, unconditional — same gate as the
  Backups routes and `/api/wipe-all`) streams that object as a
  `Content-Disposition: attachment` download named
  `oche-export-<YYYY-MM-DD>.json`.
- **`db.getPlayerExport(name)`** (per-player export, admin-only) returns
  `{ exportedAt, schemaVersion: 1, player, games, gamePlayers, turns, darts,
  opponents, playerBadges }`, scoped to one player's own history — but H2H
  isn't stored anywhere (`getH2HRecord()` computes it live from
  `games`/`game_players`/`turns`), so preserving it means bundling the real
  game/turn/dart rows for every game this player is in, **including
  opponents' own turns within those same games** (a result like "Ben beat
  Alaina" can't be represented without Alaina's side of the board). Opponents
  get only a minimal identity stub — `{ id, uuid, name }` — plus their rows
  within games shared with this player; their other games against other
  people are never included. `player` is `{ id, uuid, name, outMode,
  dartWeight, createdAt }` (no PIN columns, same write-only handling as the
  full-database export). The `id` on both `player` and each `opponents`
  entry is the SOURCE server's own local integer id — meaningful only
  together with this same export payload (it's what `games`/`gamePlayers`/
  `turns` reference as `player_id`/`winner_id`), never a portable identity on
  its own; `uuid` is the one that's portable. Throws `httpError(404)` for an
  unknown name. Deliberately out of scope for v1: tournament/league/
  daily-challenge/ghost-race participation — see `docs/archive/data-export-roadmap.md`
  for the reasoning.
- **`GET /api/players/export`** (`?name=...`, `requireAdmin`) streams that
  object as a `Content-Disposition: attachment` download named
  `oche-export-<sanitized-name>-<YYYY-MM-DD>.json`. `400` with no `name`
  param, `404` for an unknown player.
- **`db.getPlayerCsvExport(name, kind)`** (CSV spreadsheet export, admin-only)
  — the deliberately simpler, **non-portable** "your own stats as a
  spreadsheet" flavor: no uuids, no opponents' turns, no import path (so
  unlike the JSON export it cannot reconstruct H2H and isn't meant to).
  `kind='games'` returns one row per game the player is in, with per-game
  aggregates of **their own turns only**: `game_id, started_at, completed_at,
  game_type, category, legs_per_set, sets_per_game, practice, opponents,
  result, turns, darts_thrown, points_scored, avg_per_turn, best_turn, busts,
  checkouts, highest_checkout` — `opponents` is the other participants'
  names, `; `-joined and alphabetized; `result` is relative to this player
  (`won` / `lost` / `completed` for a finished game with no recorded winner /
  `unfinished`); `avg_per_turn` is `points_scored / turns` rounded to 2
  decimals (empty when they had no turns); `highest_checkout` is
  `MAX(checkout_points)` over their `checkout=1` turns (empty when none).
  `kind='turns'` returns one row per turn **they threw** (never an
  opponent's), ordered by game then turn id: `turn_id, game_id, game_type,
  category, turn_at, set_no, leg_no, scored, bust, checkout, checkout_points,
  leg_won, target_score, declared_unsolvable, darts, darts_detail` —
  `darts_detail` is each
  dart in throw order as `S`/`D`/`T`+sector notation (`T20 S5 D16`), with
  `25` for a single bull, `BULL` for the 50, and `MISS` for sector 0. Column
  semantics follow the underlying schema, so `scored`/`checkout`/`bust` mean
  whatever they mean for that row's `game_type` (Cricket's `scored` is
  points, `target_score` is Checkout-Trainer-only, etc.). Encoding is
  RFC-4180 (cells containing `"`, `,`, or newlines are quoted with `""`
  doubling; CRLF line endings), and any string cell starting with
  `=`/`+`/`-`/`@`/tab is prefixed with `'` — the standard CSV-formula-
  injection neutralization, since player names may legally start with those
  characters. Throws `httpError(404)` for an unknown name, `httpError(400)`
  for a `kind` other than `games`/`turns`.
- **`GET /api/players/export-csv`** (`?name=...&kind=games|turns`,
  `requireAdmin`) streams that CSV as a `Content-Disposition: attachment`
  download named `oche-export-<sanitized-name>-<kind>-<YYYY-MM-DD>.csv`
  (`Content-Type: text/csv; charset=utf-8`). `kind` defaults to `games` when
  omitted; `400` with no `name` param or a bad `kind`, `404` for an unknown
  player.
- **`db.importPlayerExport(payload)`** (per-player import, admin-only) — the
  counterpart to `getPlayerExport()`. `400`s if `payload.schemaVersion !== 1`
  or the shape is otherwise malformed. Resolves the main player and every
  opponent stub by **`uuid` first** (never `name` alone, since `name` is only
  unique within one server's own roster): a `uuid` match reuses that existing
  local row; failing that, the **`player_uuid_aliases` table** (written by
  the player-merge tool, see "Settings → Merge Players" below) is checked so
  an old export of a since-merged-away player resolves onto the surviving
  row instead of recreating a stub duplicate; no match on either creates a
  new row from the exported `uuid`+`name`,
  uniquifying the name (`"Name (2)"`, `"Name (3)"`, …) if it collides with an
  unrelated local player that has a *different* uuid, rather than silently
  merging two different people's histories onto one row. Every referenced
  player must resolve this way before any game/turn/dart is touched, building
  a source-id → local-id map from the `id` fields `getPlayerExport()` embeds.
  Games/turns/darts are then inserted directly via raw SQL — deliberately
  bypassing `createGame()`/`addTurn()`/`completeGame()` and their lifecycle
  hooks (league auto-tagging, badge-award checks, HA webhooks), since this is
  a historical data restore, not a live game being played, and the export's
  own `playerBadges` already carries exactly which badges the source earned.
  The insert column lists must round-trip every stat-bearing column the
  export's `SELECT *` carries: `game_players.start_score` (the handicap
  marker `NOT_HANDICAPPED` filters on), `turns.declared_unsolvable`,
  `turns.declared_hit` (the Honesty % input), and `turns.affected_player_id`
  — the last remapped through the same source-id → local-id map as every
  other player reference, never copied raw. Each uses `?? null`/`?? 0`
  fallbacks so exports written before a column existed stay importable.
  `games.config` is validated as JSON at the boundary (`400` on a malformed
  entry — the read paths parse it unguarded), and a **killer** game's
  name-keyed `config.numbers` is re-keyed to each participant's RESOLVED
  local name (the import-path twin of `_rewriteKillerConfigNames()`:
  `resolveStub()` can attach a game to a differently-named local player via
  a uuid match onto a renamed row, a merge-survivor alias, or a collision
  uniquify to `"Name (2)"` — an unmapped key would make the whole game
  replay inert). Configs orphaned by pre-fix renames/merges are healed once
  at boot by `reconcileKillerConfigNames()` (remaps only the unambiguous
  one-orphan-key/one-unclaimed-participant case).
  `league_id` is always imported as `NULL` (leagues aren't part of a
  per-player export). **Duplicate-import guard**: before inserting each game,
  checks for an existing local game with the same
  `created_at`/`category`/`game_type`/`legs_per_set`/`sets_per_game` and the
  exact same (already-remapped) participant id set — if found, that game (and
  its turns/darts) are skipped rather than duplicated, computed live at
  import time rather than needing a separate "have I imported this before"
  tracking table. This is also what makes re-importing the same file twice a
  safe no-op, and what lets an opponent stub get transparently upgraded in
  place if that opponent's own full export is imported later (their uuid
  matches the existing stub row, and their shared games are recognized as
  already-present duplicates — only their genuinely new games get added).
  Returns `{ ok, player: {name, uuid, created, renamed}, opponents: [...],
  gamesImported, gamesSkipped, turnsImported, dartsImported, badgesImported }`.
- **`POST /api/players/import`** (`requireAdmin`) — body is exactly the JSON
  `GET /api/players/export` produces. Uses a raised body-size cap
  (`MAX_PLAYER_IMPORT_BYTES`, 20MB vs. the usual 1MB `readJson()` default —
  a prolific player's full history can genuinely exceed 1MB as JSON).
- The Settings → Admin & Danger Zone → **Data Export** section, and the
  dedicated `#screen-player-export` screen it links to, cover both
  directions: **"Export all data"** navigates straight to `/api/export-all`
  (unchanged); **"Export a player…"** opens `#screen-player-export`
  (`renderPlayerExportScreen()`), which has a `<select>` (populated from the
  already-loaded `roster` array) + "Export data" button for export, a
  "Spreadsheet (CSV) export" subsection with "Games CSV" / "Turns CSV"
  buttons (`exportSelectedPlayerCsv(kind)`, navigating to
  `/api/players/export-csv` for the same selected player), and a
  file input + "Import" button (`askImportPlayer()`) below it for import —
  reads the chosen file client-side (catching malformed JSON before it ever
  reaches the network), confirms via `uiConfirm()`, then `POST`s the parsed
  payload to `/api/players/import` and shows the result summary via
  `uiAlert()`. The browser's existing admin session cookie authenticates
  every request in both directions, no separate credential in the URL or body.

### `players.uuid` — a portable per-player identity

Every player gets a random v4 UUID (`crypto.randomUUID()`) at creation,
stored in `players.uuid` (backfilled for pre-existing rows via a one-time
migration loop, since — unlike every other `ALTER TABLE` backfill in this
codebase — each row needs a *distinct* generated value, not a single
computed `UPDATE`). This exists specifically to make the per-player export
above meaningful across independent servers: the autoincrement `id` is
guaranteed to collide the moment two separately-run instances both have a
player with `id=1`, but a v4 UUID needs no coordination between servers to
stay effectively unique. `id` remains the internal join/FK target
everywhere — `uuid` is exposed in exports (full-database and per-player) as
the portable identity `importPlayerExport()` (above) keys its player/opponent
resolution on.

### Settings → Merge Players (admin-only)

`docs/archive/player-merge-roadmap.md`. Combines two player records that are
really the same person (a typo'd second account, someone added twice): the
**target** (an explicit admin choice, never inferred from age/game count)
absorbs the **source**'s full history and the source's row is deleted. Lives
in **Settings → Admin & Danger Zone → Merge Players** — two `<select>`s
(source = "duplicate to merge away", target = "player who keeps everything")
and a **Preview merge…** button; there is no merge without a preview.

- **`db.getMergePreview(sourceName, targetName)`** / **`GET
  /api/players/merge-preview`** (`?source=...&target=...`, `requireAdmin`) —
  computes everything a merge WOULD do without writing a byte: `{ ok,
  blocked, source, target, moves, resolutions, blockers }`. `moves` is
  per-table counts of the source's rows (games, turns, gameWins, badges,
  challengeAttempts, tournamentEnrollments, tournamentTitles,
  tournamentMatchSlots, leagueEnrollments, leagueFixtures, dartComponents,
  loadouts, ghostRaces, marathonSessions, uuidAliases); `resolutions` lists what will be
  auto-resolved (`sharedBadges`, `resolvableChallengeDates`); `blockers`
  lists what stops the merge outright (`sharedGames`, `sharedTournaments`,
  `sharedLeagues`, `ambiguousChallengeDates`). `404` unknown player, `400`
  same player.
- **`db.mergePlayers(sourceName, targetName)`** / **`POST
  /api/players/merge`** (`{ source, target }`, `requireAdmin`, rate-limited
  10/min like the backup-restore routes, logged server-side) — re-derives
  the same blockers itself (the API can't be called blind or raced past the
  preview) and `400`s if any exist; otherwise runs the whole rewrite in a
  **single transaction** (any failure rolls back to the exact pre-merge
  state) across every table with a FK into `players.id`:
  - **Plain reassignment** (no uniqueness constraint, or no shared row can
    exist once the blockers pass): `game_players`, `turns` (both `player_id`
    AND `affected_player_id` — the Killer whose-life-changed column has no FK,
    so a missed reassignment would dangle silently rather than error),
    `games.winner_id`, `daily_challenge_attempts`,
    `tournaments.champion_id`/`runner_up_id`, `tournament_players`,
    `tournament_matches.player1_id`/`player2_id`/`winner_id`,
    `league_players`, `dart_components`, `loadouts`, `ghost_races`,
    `marathon_sessions` (the one players-FK table with no games link —
    unreassigned, the final source-player DELETE would CASCADE the whole
    Marathon history away).
  - **Killer configs**: `games.config.numbers` is keyed by player *name*, so
    every killer game being absorbed gets its source-name key rewritten to
    the target's name (`_rewriteKillerConfigNames()` — the same rewrite
    `renamePlayer()` applies), or the merged history would replay with an
    orphaned assignment and zero out everyone's replay-derived Killer stats.
  - **`player_badges`** (both earned the same badge): the target keeps
    `MAX(count)` — a merge must never inflate a count beyond what either
    history actually earned — and `MIN(earned_at)`; the source's remaining
    unshared badges reassign as-is.
  - **`daily_challenge_attempts`** (same date from both, exactly one
    completed — the only unblocked kind): the completed attempt survives,
    whichever side it came from.
  - **`league_fixtures`**: `player1_id`/`player2_id` reassign, then any
    pair the swap left inverted is re-canonicalized back to
    `player1_id < player2_id` (the invariant
    `getPendingFixturesForPlayers()`'s order-independent lookup relies on).
    A source-vs-target fixture can never survive to this point — it would
    require a shared league, which blocks.
  - **`loadouts.is_default`**: if the target already has a default loadout,
    the source's default flag is cleared — the target never ends up with
    two defaults, same "target's own settings/preferences always win" rule
    as name/`out_mode`/`dart_weight`/PIN/`uuid` (none of which ever change).
  - **Blocked outright** — shared game (`game_players`' composite PK would
    collide, and a "played themselves" row is a structural oddity worth
    surfacing, not papering over), shared tournament or league enrollment
    (same collision + silent bracket/standings corruption risk), and a
    same-date challenge pair where both or neither completed (no
    non-destructive default; the admin deletes one first via the existing
    Settings → Daily Challenge reset tool).
  - **Identity**: aliases already pointing at the source repoint to the
    target (a chained merge A→B→C leaves A's alias resolving to C in one
    hop), the source's own `uuid` is recorded in `player_uuid_aliases`
    pointing at the target, and the source row is deleted via plain SQL —
    not `deletePlayer()`, whose guards exist to protect exactly the history
    that has just become the target's. Returns the same
    `moves`/`resolutions` shape as the preview, captured pre-write.

**Why `player_uuid_aliases` exists**: merging deletes the source's row, so
its `uuid` would stop resolving — and a *later* import of an old export
still carrying that uuid (from another server) would silently recreate a
stub duplicate of the player the admin just consolidated.
`importPlayerExport()`'s `resolveStub()` therefore checks the alias table as
a fallback whenever a direct `players.uuid` match fails, before falling
through to "create a new player" — resolving old exports onto the survivor.

---

## 13. Database Schema

Engine: `node:sqlite` (`DatabaseSync`), `PRAGMA journal_mode=WAL`,
`PRAGMA foreign_keys=ON`. Every table below reflects current state after all
`ALTER TABLE` migrations (each wrapped in `try/catch`, so re-running them on an
already-migrated database is a safe no-op).

### `players`
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `name` | `TEXT NOT NULL UNIQUE COLLATE NOCASE` | Case-insensitive unique |
| `uuid` | `TEXT` (unique index) | v4 UUID assigned at creation, backfilled for pre-existing rows — see "`players.uuid`" below. Portable per-player identity for export; `id` stays the internal join/FK target |
| `out_mode` | `TEXT NOT NULL DEFAULT 'double'` | `'double'` \| `'single'` — default checkout rule |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |
| `dart_weight` | `INTEGER` | **Retired as a write path** (`docs/archive/dart-builder-roadmap.md`) — no UI sets this anymore; a selected loadout's barrel weight is the only source for `game_players.dart_weight` going forward (see §16). Existing values are left in place, unread by any current code path (`getPlayer`/`listPlayers` still return it for API back-compat, but nothing writes it, and `createGame()` never falls back to it) |
| `pin_hash` / `pin_salt` | `TEXT` | scrypt hash/salt; `NULL` = no PIN, anyone may play as this player |
| `pin_fail_count` | `INTEGER NOT NULL DEFAULT 0` | Incremented via `RETURNING` (see §9) |
| `pin_locked_until` | `INTEGER` | Epoch ms |

### `games`
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `category` | `TEXT NOT NULL` | For X01 games: the starting score as a string (`'501'`/`'301'`/`'170'`/`'101'`, or a filler `'1000'` for Daily Challenge's non-scoring formats). Cricket games write a display label instead (`'Cricket (15-20, Bull)'` or `'Custom Cricket'`); Chuckin games write `"Just Chuckin' It"`; the two guided drills write `'Guided Around the Clock'`/`'Guided Around the World'`. Category-scoped stat filters (`OPENING_CATS`'s `IN (501,301,170,101)`, nine-darter detection) either match X01 values explicitly or filter on `game_type`+`config`, so the non-X01 labels never collide with them |
| `legs_per_set` / `sets_per_game` | `INTEGER NOT NULL` | |
| `created_at` / `completed_at` | `TEXT` | `completed_at` is `NULL` for in-progress/abandoned games |
| `winner_id` | `INTEGER REFERENCES players(id) ON DELETE SET NULL` | Set by `completeGame()`. **Must be a participant of the game** — `completeGame()` rejects a `winner` name that isn't in this game's `game_players` with a `400` (`docs/bug-roadmap.md` BUG-9), the same participant check `recordWalkover()` enforces; a `null` winner (abandoned game) is allowed. Behavior for legitimate input is unchanged — the frontend only ever completes with a real participant |
| `practice` | `INTEGER NOT NULL DEFAULT 0` | Explicit practice flag, set at creation |
| `game_type` | `TEXT NOT NULL DEFAULT 'x01'` | `'x01'`, `'cricket'`, `'baseball'`, `'doubles_practice'`, `'chuckin'`, `'checkout_trainer'`, `'around_the_clock'`, `'around_the_world'`, `'bobs_27'`, `'checkout_ladder'`, `'gauntlet'`, `'killer'`, `'shanghai'`, `'halve_it'`, `'dead_man_walking'`, or `'pressure_chamber'` (`KNOWN_GAME_TYPES` in `backend/db.js`). `createGame()` accepts it as an optional param, defaulting to `'x01'`; each New Game flow passes its own. Nine-darter detection queries filter on this + `config` instead of `category='501'`, and every `scored`-derived stat scopes on it via `X01_ONLY`/`_scope()` (§3). |
| `config` | `TEXT` | JSON — `{startingScore}` for X01 rows (backfilled for rows created before this column existed), `{numbers: [seven in-play numbers]}` for Cricket rows (the source of truth for mark derivation, `CRICKET_MARK_CASE` in §3), `{innings: 9}` for Baseball rows (fixed, not yet a New Game choice), `{doubles: [target sectors]}` for Doubles Practice rows (`DOUBLES_HIT_CASE` in §3), `{}` for Chuckin rows, both guided-drill rows, and Bob's 27 rows (no config needed — Bob's 27 always plays the fixed D1-D20 ladder), `{targets: [...]}` for Halve-It rows (§32), `{rounds: [15 frozen {target, par} pairs]}` for Dead Man Walking rows — computed once server-side at creation and never client-supplied or recomputed (§33), and `{rounds: 15}` for Pressure Chamber rows (fixed, server-overridden regardless of client input — §34) |
| `player_count` | `INTEGER` | **Frozen** participant count at creation (not a live subquery) — see §3's mode-scoping note |
| `league_id` | `INTEGER REFERENCES leagues(id) ON DELETE SET NULL` | Nullable — set by the `onGameCreated` auto-tag hook (§18), never by `createGame()`'s own INSERT. `NULL` for every game that isn't a tagged league match (the overwhelming majority) |

### `game_players` (composite `PRIMARY KEY (game_id, player_id)`)
| Column | Type | Notes |
|---|---|---|
| `game_id` | `INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | |
| `out_mode` | `TEXT NOT NULL DEFAULT 'double'` | Per-game checkout rule actually used (may differ from the player's current default) |
| `dart_weight` | `INTEGER` | Snapshot at game start — **as of `docs/archive/dart-builder-roadmap.md`**, sourced from the selected loadout's barrel `weight_g` (`NULL` if no loadout was selected), not from `players.dart_weight` (see §16) |
| `loadout_id` | `INTEGER REFERENCES loadouts(id) ON DELETE SET NULL` | The loadout selected for this player in this game, if any (§16). Nullable — playing without a loadout remains fully valid |
| `start_score` | `INTEGER` | X01 handicapping only (§25): this player's own handicap starting score for this game, when it differs from the game-wide `games.category` score. `NULL` for every non-handicapped player and every non-X01 game. The presence of any non-NULL value in a game is what the `NOT_HANDICAPPED` exclusion (nine-darter/fewest-darts/first-9 leaderboards, Elo) filters on, so it must survive export/import round trips |

### `turns` (one row per visit, indexed on `player_id` and `game_id`)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `game_id` / `player_id` | `INTEGER NOT NULL, FK, ON DELETE CASCADE` | |
| `set_no` / `leg_no` | `INTEGER NOT NULL` | Must be a positive integer (`addTurn()` rejects `0` or negative explicitly — an explicit `0` is validation-rejected, not silently treated as the "omitted" default of `1`) |
| `scored` | `INTEGER NOT NULL` | Effective points — `0` on a bust, app-computed (not a raw dart sum). Means "X01 countdown points" for `game_type='x01'` but "cricket points earned this visit" for `game_type='cricket'` — same column, different quantity (see `X01_ONLY` in §3). `addTurn()` rejects a non-numeric value outright rather than silently coercing it to `0`. For `game_type='x01'` specifically, `POST /api/games/:id/turns` (the one production caller that opts into `addTurn()`'s `enforceConsistency` flag) additionally rejects a `scored` that doesn't match the sum of that visit's dart face values (`0` required on a bust; `checkout_points` must equal `scored` on a checkout) — `docs/security-audit-roadmap.md` SEC-22. For `game_type='baseball'` the same caller also rejects a `scored` that doesn't equal this visit's runs — the sum of dart `multiplier`s that hit the inning's target number, where the inning is derived server-side from the player's own prior turn count in the leg (`min(inning, 9)` for extra innings); a Baseball turn must also be neither a bust nor a checkout (`docs/security-audit-roadmap.md` SEC-25). For `game_type='bobs_27'`, `scored` is that round's own *gain only* — never a negative penalty (see §2's "store the gain, derive the penalty"); the same caller derives the round from the player's own prior turn count (capped at 20), rejects a `scored` that doesn't match `hits * round*2` on the submitted darts, rejects `checkout=true` outright, and requires `bust` to match whether replaying every prior round's gain/penalty plus this round's own would drop the running score to 0 or below (`docs/archive/practice-ladders-roadmap.md` Part A). Still deliberately skipped for Cricket (`scored` is computed from mark-closing state, not a dart-value sum, so the same rule would reject legitimate Cricket visits) and for Doubles Practice / Chuckin / Checkout Trainer / Around the Clock / World (non-arithmetic or non-points `scored`) |
| `bust` / `checkout` | `INTEGER NOT NULL DEFAULT 0` | Booleans. Cricket turns always write `bust=0, checkout=0` — cricket has neither concept. Doubles Practice repurposes `bust` as "this dart ended the round" (so-close or wrong-double, §2) — the closest existing column to that meaning, since this mode has no bust/win concept of its own either; `checkout` stays `0` always. Guided Around the Clock repurposes `bust` the identical way: `1` marks whichever dart completed the round (all 20 numbers hit) — there's no "so-close"/"wrong-target" failure mode here, only completion or abandonment. Guided Around the World writes `bust=0` always (no round to end, matching Chuckin's own turns) |
| `checkout_points` | `INTEGER` | Only set when `checkout=1` (X01 only) |
| `leg_won` | `INTEGER NOT NULL DEFAULT 0` | Game-type-agnostic "this turn won the leg" signal, set only by Cricket's write path (`enterTurnCricket()`) — Cricket has no checkout mechanism, so its Personal Bests (fewest darts to close, best MPR in a leg) need their own marker instead of reusing `checkout` (which keeps its narrower X01 double-out meaning). X01 turns always leave this `0` and its own Personal Bests keep using `checkout=1`, unchanged. Checkout Trainer repurposes it as "answered with the objectively fewest darts" (§19) |
| `target_score` | `INTEGER` | Checkout Trainer only (§19): the target offered for that round — unlike X01 there's no persistent "remaining score" state to derive it from afterward. `NULL` for every other game type; `addTurn()` range-checks it to 1–170 |
| `declared_unsolvable` | `INTEGER NOT NULL DEFAULT 0` | Checkout Trainer trick questions only (§19): `1` marks a round answered by declaring "no possible checkout" instead of tapping out darts — the only turn shape allowed to carry **zero** dart rows (`addTurn()` rejects it outside `checkout_trainer` games, with any darts attached, or with a nonzero `scored`). The verdict still lives on `bust`/`checkout`/`leg_won` (correct call → `checkout=1, leg_won=1`; wrong call → `bust=1`); this flag exists so "a real checkout was solved" queries (Toughest Checkout Solved) can exclude declarations |
| `affected_player_id` | `INTEGER` | Killer only (§ Killer): which player's life total this dart changed (`NULL` = no effect, thrower's own id = self-effect, another id = an attack). `NULL` for every other game type |
| `declared_hit` | `INTEGER` | The Pressure Chamber only (§34): the player's before-the-throw self-declaration — `1` = declared hit, `0` = declared miss, `NULL` = no declaration / every other game type. **Not a scoring input** and carries no leaderboard weight; feeds only the informational Honesty % stat. Deliberately has **no consistency guard** (unverifiable by design — an honor-system signal); `addTurn()` validates only its shape (`0`/`1`) and rejects it outside `pressure_chamber` games |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### `darts` (one row per physical dart, indexed on `turn_id` and `(sector,multiplier)`)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `turn_id` | `INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE` | |
| `dart_no` | `INTEGER NOT NULL` | 1/2/3, position within the visit |
| `sector` | `INTEGER NOT NULL` | `0`=miss, `1`–`20`=numbered wedge, `25`=bull area |
| `multiplier` | `INTEGER NOT NULL` | `1`=single, `2`=double, `3`=treble. `addTurn()` rejects the physically impossible combinations `(25,3)` (no treble bull exists) and `(0,2)`/`(0,3)` (a miss is always stored as multiplier 1) — the client never produces them, and left unchecked they'd count as phantom distinct outcomes against Around the World's 63-outcome total |
| `scored` | `INTEGER GENERATED ALWAYS AS (...)  STORED` | Miss=0, inner bull=50, outer bull=25, else `sector*multiplier` |
| `is_treble` | `INTEGER GENERATED ALWAYS AS (...) STORED` | 1 iff `multiplier=3` on a numbered sector (1-20) |
| `is_double` | `INTEGER GENERATED ALWAYS AS (...) STORED` | 1 iff `multiplier=2` and not a miss (includes double bull) |
| `thrown_at` | `TEXT` | ISO timestamp, only populated when "Collect per-dart timing" is on |
| `zone` | `TEXT` | `'inner'`\|`'outer'`\|`NULL` (docs/archive/dartboard-zone-tracking-roadmap.md) — which physical region of a **single hit** (sector 1-20, multiplier 1) was tapped: between bull and treble ("inner") or between treble and double ("outer"). Only ever populated by a Dartboard-mode tap; `NULL` for Pad-mode singles, every double/treble/bull (no inner/outer distinction exists there), and every row from before this feature existed |
| `miss_zone` | `INTEGER` | `1`-`20`\|`NULL` — the wedge number nearest a **positioned miss** (Dartboard-mode tap on the miss ring outside the double). Always set together with `miss_depth`, never on a hit (`sector≠0`) |
| `miss_depth` | `TEXT` | `'near'`\|`'far'`\|`NULL` — how close a positioned miss was: the band immediately outside the double ("near") vs. further out ("far"). Always set together with `miss_zone` |
| `bounced` | `INTEGER` | `1`=this dart struck a real number/ring but bounced or fell out before it counted, `NULL` otherwise. `sector`/`multiplier` stay exactly `0`/`1` regardless — to every existing consumer (`evaluateVisit()`, every badge, `getGhostLegScript()`, `getFullDatabaseExport()`) a bounced dart is a completely ordinary miss row; v1 tracks only that it happened, not where (see REFERENCE.md §17) |

### `timeline_events`
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `game_id` | `INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE` | |
| `set_no` / `leg_no` | `INTEGER` (nullable) | |
| `event_type` | `TEXT NOT NULL` | Free-form (`leg_start`, `leg_end`, `set_start`, `set_end`, `game_start`, `game_end`); no `CHECK` constraint |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### `player_badges` (`UNIQUE(player_id, badge_id)`)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | |
| `badge_id` | `TEXT NOT NULL` | See §4 for the full list |
| `count` | `INTEGER NOT NULL DEFAULT 1` | See §4's award-mode explanation |
| `earned_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | First-earned timestamp only, not updated on later increments |

### `daily_challenge_attempts` (`UNIQUE(player_id, challenge_date)`, indexed on `(player_id, challenge_date)`)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `game_id` | `INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE` | Links to the practice game the attempt was played in — per the "games-context" convention (own table + FK, not a boolean on `games`) |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | |
| `challenge_date` | `TEXT NOT NULL` | `YYYY-MM-DD`, client-local |
| `format` | `TEXT NOT NULL` | One of the 6 formats in §6 |
| `target` | `INTEGER` | Checkout target for `checkout_sprint`; `NULL` otherwise |
| `result_darts` | `INTEGER` | The format's metric value (despite the name, not literally always "darts" — see §6); `NULL` until completed |
| `completed` | `INTEGER NOT NULL DEFAULT 0` | |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### Tournament mode (`docs/archive/tournament-mode-roadmap.md`, single- and double-elimination — see §15)

**`tournaments`**
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `name` | `TEXT NOT NULL` | |
| `category` | `TEXT NOT NULL` | X01 starting score as a string: `'501'`\|`'301'`\|`'170'`\|`'101'` — every match in the tournament uses this same format |
| `bracket_type` | `TEXT NOT NULL DEFAULT 'single_elim' CHECK (IN ('single_elim','double_elim'))` | `'single_elim'` or `'double_elim'` — chosen at creation (§15). Double-elim is restricted to exact powers of two (4/8/16/32/64/128) |
| `player_count` | `INTEGER NOT NULL` | Frozen at creation |
| `status` | `TEXT NOT NULL DEFAULT 'in_progress' CHECK (IN ('in_progress','completed'))` | |
| `champion_id` / `runner_up_id` | `INTEGER REFERENCES players(id) ON DELETE SET NULL` | Set together, atomically, the instant the final resolves |
| `created_at` / `completed_at` | `TEXT` | |

**`tournament_players`** (`PRIMARY KEY (tournament_id, player_id)`)
| Column | Type | Notes |
|---|---|---|
| `tournament_id` | `INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | |
| `seed` | `INTEGER NOT NULL` | 1 = best seed; the order `players` was submitted in at creation (already seeded client-side — see §15) |
| `status` | `TEXT NOT NULL DEFAULT 'active' CHECK (IN ('active','eliminated','champion'))` | Read by the player-deletion guard (§1, §15) |

**`tournament_rounds`** — one row per round, so each carries its own format
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `tournament_id` | `INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE` | |
| `bracket` | `TEXT NOT NULL DEFAULT 'winners' CHECK (IN ('winners','losers','grand_final'))` | `'winners'` for every single-elim round; a double-elim tournament also has `'losers'` rounds and two `'grand_final'` rounds (the final and its reset decider) |
| `round_no` | `INTEGER NOT NULL` | 1-based, earliest round first |
| `label` | `TEXT NOT NULL` | `"Quarterfinal"`/`"Semifinal"`/`"Final"`/`"Round N"` — computed once at creation, not looked up dynamically (see §15) |
| `legs_per_set` / `sets_per_game` | `INTEGER NOT NULL` | This round's own match format |

**`tournament_matches`** — the core bracket structure
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `round_id` | `INTEGER NOT NULL REFERENCES tournament_rounds(id) ON DELETE CASCADE` | |
| `slot` | `INTEGER NOT NULL` | 1-based position within the round |
| `player1_id` / `player2_id` | `INTEGER REFERENCES players(id) ON DELETE SET NULL` | `NULL` until known — either seeded directly (round 1) or filled by a prior match's winner propagating in |
| `is_bye` | `INTEGER NOT NULL DEFAULT 0` | Round-1 only — set when the bracket size exceeds the real player count (see §15) |
| `game_id` | `INTEGER REFERENCES games(id) ON DELETE SET NULL` | The normal `games` row this match's play created — `NULL` until started, stays `NULL` forever for a walkover |
| `winner_id` | `INTEGER REFERENCES players(id) ON DELETE SET NULL` | Set once, never changed |
| `winner_next_match_id` / `winner_next_slot` | `INTEGER` / `INTEGER (1 or 2)` | Where the winner advances to |
| `loser_next_match_id` / `loser_next_slot` | `INTEGER` / `INTEGER` | Where the loser drops to. `NULL` for single-elim (a loss eliminates) and for double-elim losers-bracket matches (a second loss eliminates); set on double-elim winners-bracket matches so the loser drops into the losers bracket |

A match's **status** (`pending`/`ready`/`in_progress`/`complete`) is derived at read
time by `getTournament()`, never stored: `winner_id` set → `complete`; else `game_id`
set → `in_progress`; else both player slots filled → `ready`; else `pending`. Same
"compute from raw data" philosophy as the rest of the schema (§1).

### League mode (`docs/archive/league-mode-roadmap.md`, X01 or Cricket — see §18)

**`leagues`**
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `name` | `TEXT NOT NULL` | |
| `game_type` | `TEXT NOT NULL DEFAULT 'x01'` | `'x01'`\|`'cricket'`. Additive column (every pre-Cricket league defaults to `'x01'`) — determines which `category` vocabulary applies |
| `category` | `TEXT NOT NULL` | For `game_type='x01'`: starting score as a string, `'501'`\|`'301'`\|`'170'`\|`'101'`. For `game_type='cricket'`: `'Cricket (15-20, Bull)'`\|`'Custom Cricket'` — the same two-value label a Cricket H2H game is already tagged with at creation, reused as-is. Every auto-tagged game must match `game_type` **and** `category` exactly |
| `status` | `TEXT NOT NULL DEFAULT 'active' CHECK (IN ('active','ended'))` | Manual admin toggle (`setLeagueStatus()`), reversible. Gates whether *new* games can auto-tag in — already-tagged games keep their `league_id` regardless of a later status change |
| `starts_at` / `ends_at` | `TEXT NOT NULL` / `TEXT` | `YYYY-MM-DD`. `ends_at` nullable = open-ended/ongoing season; independently gates auto-tag eligibility alongside `status` |
| `points_win` / `points_loss` | `INTEGER NOT NULL DEFAULT 1` / `INTEGER NOT NULL DEFAULT 0` | Admin-configurable per league — simple win/loss points, no margin-of-victory texture (resolved open question, see §18) |
| `created_at` / `ended_at` | `TEXT` | `ended_at` set when `status` transitions to `'ended'`, cleared on reopen |

No `player_count` column (unlike `tournaments.player_count`, which is frozen
because the bracket *shape* depends on it) — a league's roster can grow any
time during the season, so its count is always a live `COUNT(league_players)`.

**`league_players`** (`PRIMARY KEY (league_id, player_id)`)
| Column | Type | Notes |
|---|---|---|
| `league_id` | `INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | A player may be enrolled in multiple concurrent leagues |
| `joined_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

No `points`/`played`/`won`/`lost` tally columns — deliberately, unlike the
roadmap doc's original sketch. Standings are computed **live** by
`getLeagueStandings()` from `games`/`game_players` at read time (§18), so there
is nothing here that can drift out of sync with what actually happened.

**`league_fixtures`** — league fixtures / pending matches (§18), following
`tournament_matches`' own shape rather than `league_players`' direct-column one
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `league_id` | `INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE` | |
| `player1_id` / `player2_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | Always stored in canonical (lower id first) order, fixed at generation time |
| `game_id` | `INTEGER REFERENCES games(id) ON DELETE SET NULL` | `NULL` until this fixture is linked to a game (`createGame({ leagueFixtureId })`) |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

A fixture's **status** (`pending`/`in_progress`/`fulfilled`) is derived at read
time by `getLeagueFixtures()`, never stored — same "compute from raw data"
philosophy as a tournament match's status: `game_id IS NULL` → `pending`; else
the linked game's `completed_at IS NULL` → `in_progress`; else `fulfilled`.

### `settings` (key/value)
`key TEXT PRIMARY KEY`, `value TEXT NOT NULL DEFAULT ''` (booleans stored as
`'1'`/`'0'`). Known keys: `collect_dart_timing`, `colorblind_mode`,
`voice_enabled`, `voice_turn_score`, `voice_no_score`, `voice_checkout_req`,
`voice_180`, `voice_bigfish`, `voice_match_progress`, `ha_url`,
`ha_webhook_<event>` (×12, see §10), `pin_lockout_threshold`,
`admin_lockout_grace`, `admin_lockout_base_seconds`, `admin_lockout_max_seconds`,
`scoreboard_layout`, `default_scoring_input`,
`card_tagline`.

### `admins`
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `username` | `TEXT NOT NULL UNIQUE COLLATE NOCASE` | Regex `^[A-Za-z0-9_.-]{3,32}$` |
| `password_hash` / `password_salt` | `TEXT NOT NULL` | scrypt |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |
| `login_fail_count` | `INTEGER NOT NULL DEFAULT 0` | |
| `login_locked_until` | `INTEGER` | Epoch ms |

### `sessions`
| Column | Type | Notes |
|---|---|---|
| `token_hash` | `TEXT PRIMARY KEY` | SHA-256 of the raw token — raw token never stored |
| `admin_id` | `INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE` | |
| `created_at` / `expires_at` | `INTEGER NOT NULL` | Epoch ms, indexed on `expires_at` |

### `server_errors`
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |
| `method` / `path` / `status` / `message` | nullable | One row per server-side 5xx response (§1's "Server error log"); pruned to the most recent 500 rows on every insert. **Malformed client input never reaches here** — a bad percent-escape in the path, a malformed session cookie, or an unparseable JSON body are all classified as `400` client errors, not `500` faults (`docs/security-audit-roadmap.md` SEC-17), so an unauthenticated caller can't flush this diagnostic tail |

### `dart_components` (§16, `docs/archive/dart-builder-roadmap.md`)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | Personal catalog — not shared/global |
| `type` | `TEXT NOT NULL CHECK IN ('barrel','shaft','flight')` | No `'tip'` type — tip texture lives on `loadouts` directly (see below) |
| `name` | `TEXT NOT NULL` | |
| `length_mm` | `TEXT` | A preset **range label** (e.g. `"medium"`), not a raw millimeter number. Applies to barrel/shaft; always `NULL` for flight (flight length reduces to `shape`) |
| `weight_g` | `INTEGER` | Barrel only in practice — one of the same 10g–40g individual values `dartWeightOptions()` always offered, now entered once on the barrel instead of picked per-game. Always `NULL` for shaft/flight |
| `material` | `TEXT` | Closed enum, different list per `type` — see `getDartComponentOptions()` |
| `shape` | `TEXT` | Barrel: `straight`\|`torpedo`\|`ton`. Shaft: conceptually "type" (`fixed`\|`spinning`), stored in this column rather than a separate one. Flight: `standard`\|`slim`\|`kite`\|`pear` |
| `grip` | `TEXT` | Barrel only: `smooth`\|`knurled`\|`ringed` — surface texture, kept separate from `shape` (silhouette) |
| `notes` | `TEXT` | Free text |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### `loadouts` (§16)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | |
| `name` | `TEXT NOT NULL` | |
| `barrel_id` / `shaft_id` / `flight_id` | `INTEGER REFERENCES dart_components(id) ON DELETE SET NULL` | Each individually nullable — a loadout can be saved "in progress." Can't be *selected* for a game until all three are filled (checked at game-creation time, not save time) |
| `tip_texture` | `TEXT CHECK IN ('smooth','grooved')` | Nullable. Lives here, not as a `dart_components` row — no reusable catalog of named "tip parts" the way barrel/shaft/flight have |
| `dart_count` | `INTEGER NOT NULL DEFAULT 3` | Informational/display only — not a multiplier fed into any stat; the weight used for `game_players.dart_weight` is always the barrel's per-dart `weight_g` |
| `is_default` | `INTEGER NOT NULL DEFAULT 0` | At most one `1` per `player_id`, enforced by `setDefaultLoadout()` (clears every other of that player's loadouts in the same operation, never by a DB constraint) |
| `created_at` / `updated_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### `ghost_races` (§10 Ghost Opponent)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `game_id` | `INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE` | The race's own new practice game |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | |
| `source_game_id` / `source_set_no` / `source_leg_no` | `INTEGER NOT NULL`, `source_game_id ON DELETE CASCADE` | Which historical leg was raced |
| `result` | `TEXT NOT NULL CHECK IN ('win','loss')` | From the human's perspective; computed client-side (`wi===0` in `onLegWon()`), re-validated server-side against the source leg, not derived independently (the ghost is never a real `game_players` row) |
| `human_darts` / `ghost_darts` | `INTEGER` (nullable) | Total darts each side took to finish this specific race |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### `player_uuid_aliases` (player merge — "Settings → Merge Players")
| Column | Type | Notes |
|---|---|---|
| `uuid` | `TEXT PRIMARY KEY` | A merged-away player's old `uuid` — kept resolvable so an old export still imports onto the survivor instead of recreating a stub duplicate |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | The surviving player this uuid now resolves to. A merge repoints any aliases that targeted the (now-deleted) source, so a chained merge always resolves in one hop |
| `merged_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### `saved_games` (§23 Saved Games — "save for later" pause slots)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `game_id` | `INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE` | The paused in-progress game — `UNIQUE`, one pause slot per game. No snapshot blob: everything needed to resume is derived by replaying the game's own recorded turns (see §23) |
| `saved_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### `marathon_sessions` (Marathon Mode — the "games-context table" convention, not a new game_type)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | The one players-FK table with no games link — so `resetStats()` clears it explicitly (a games wipe can't cascade it) and `mergePlayers()` must reassign it (or the source-player delete would cascade the history away) |
| `duration_minutes` | `INTEGER NOT NULL DEFAULT 45` | |
| `started_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |
| `ended_at` | `TEXT` | `NULL` = session still in progress (mirrors `games.completed_at`'s nullable-lifecycle-marker shape) |

### `marathon_session_legs`
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `session_id` | `INTEGER NOT NULL REFERENCES marathon_sessions(id) ON DELETE CASCADE` | |
| `game_id` | `INTEGER REFERENCES games(id) ON DELETE SET NULL` | The leg's ordinary solo practice 501 game — only ever populated server-side by `startMarathonSession()`/`startNextMarathonLeg()`, never client-supplied. `SET NULL` on game deletion, so a stats reset reverts legs to unlinked rather than deleting session history structure |
| `leg_order` | `INTEGER NOT NULL` | |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |

### Cascade summary

Deleting a `player` cascades: their `game_players` rows, `turns` (and
transitively their `darts`), `player_badges`, `daily_challenge_attempts`,
`tournament_players`, their `dart_components`/`loadouts` rows, their
`ghost_races` rows, their `marathon_sessions` rows (and transitively their
`marathon_session_legs`), and any `player_uuid_aliases` rows pointing at them.
Deleting a `game` cascades its `saved_games` row (if paused) and SET-NULLs any
`marathon_session_legs.game_id` pointing at it. `deletePlayer()`
then prunes any `games` row left with zero remaining `game_players` (also run
once at boot to self-heal older databases). Any `tournament_matches`/`tournaments`
row referencing the deleted player (`player1_id`/`player2_id`/`winner_id`/
`champion_id`/`runner_up_id`) sets that column to `NULL` rather than cascading —
the bracket's shape and results stay intact, only the departed player's name is
lost from it (the same tradeoff already accepted for `games.winner_id`). The
player-deletion guard (§1, §15) blocks this entirely while the player is still
`active` in an in-progress tournament, so this SET NULL path only ever fires for
an already-eliminated player or a completed tournament. Deleting a single
`dart_components` row similarly sets any `loadouts.barrel_id`/`shaft_id`/
`flight_id` slot referencing it back to `NULL` rather than deleting the whole
loadout.

---

## 14. API Reference

Full endpoint list, auth requirements, and exact request/response shapes now
live in `README.md`'s [API Reference](README.md#api-reference) section — kept
there (not duplicated here) since it's the version meant for someone building
against the API. This document's job is the *why*/*exact internal logic*
behind each one; cross-reference by endpoint name.

**Two auth gates, not one**: `requireAdmin` always requires a logged-in admin
session; `requireWrite` behaves the same way by default and is only a no-op
when `OCHE_REQUIRE_AUTH` is explicitly set to `"false"`/`"0"` (see §9). Routes
documented as `[admin]` in the README use `requireAdmin`; everything else that
mutates state uses `requireWrite`, which requires a logged-in admin by default
even on a normal LAN deployment.

**Rate-limit buckets**: see §9's table — `global` (300/60s, every request),
`setup`/`login`/`pin` (10/60s each, their own endpoint only). SSE uses separate
hard connection caps, not a `rateLimit()` bucket.

---

## 15. Tournament Mode

`docs/archive/tournament-mode-roadmap.md`. **Single- AND double-elimination** —
`tournaments.bracket_type` (`'single_elim'` default | `'double_elim'`) chosen on
the setup screen. Both share one schema: the `winner_next_*`/`loser_next_*`
pointer-pair design (§13) makes a losers-bracket drop just "a loser with a
`loser_next_match_id` instead of `NULL`." X01 only — any of the four starting
scores (501/301/170/101). Backend: `backend/db.js`'s tournament section.
Frontend: `frontend/index.html`'s "TOURNAMENT MODE" block, reachable via the
**Tournaments** nav button. Tournament mode is now **feature-complete** — both
bracket types, the setup screen, the tabbed double-elim bracket view, badges, and
Player Profile stats all ship.

### Design principle: a tournament match IS a normal game

Starting a tournament match calls the exact same `createGame()` a regular New
Game H2H match would (same `category`/`legsPerSet`/`setsPerGame`/`players`,
`practice=0`), just with `tournament_matches.game_id` recording which match it
belongs to. Every existing mechanism — PINs, per-player finish rules, checkout
hints, undo, the live scoreboard, achievements, and every stat/leaderboard —
works completely unmodified, because as far as any of those are concerned it's
indistinguishable from any other H2H game.

### Seeding (client-side, not a backend concern)

`createTournament({name, category, players, rounds})`'s `players` array is
**already in final seed order** (index 0 = seed 1) by the time it reaches the
backend — exactly like `createGame()`'s own `players` array order has always
determined throw order, with no server-side reordering. The New Game setup
screen offers three seeding methods, all computed in `frontend/index.html`:

- **Random** — a Fisher-Yates shuffle of the selected players (`shuffleTournamentSeed()`), the same algorithm the app's existing "🔀 Shuffle" New Game feature already uses.
- **Manual order** — the admin reorders the selected list directly (▲/▼ per row, `moveTournamentSeed()`), starting from whatever order they were checked in.
- **By 3-dart average** — `loadTournamentSeedByAverage()` fetches each selected player's existing lifetime average via the already-public `GET /api/players/personal-bests?name=` endpoint (no new backend surface needed) and sorts best-average-first; a player with no recorded legs yet (`lifetimeAvg == null`) sorts **last**, never treated as a misleadingly literal zero.

### Bracket generation (`createTournament()`, `backend/db.js`)

`createTournament({name, category, players, rounds, bracketType})` dispatches to
`_generateSingleElimBracket()` or `_generateDoubleElimBracket()` on
`bracketType`. Both take the seed-ordered `players` and the per-round
`rounds` format array; the expected `rounds` length is the round count for that
bracket shape (single: `log2(bracketSize)`; double:
`doubleElimStructure(k).length`), validated up-front.

**Single-elimination** — given N players and `bracketSize` = the smallest power of
two ≥ N:

- **Standard tournament seeding placement** (`_bracketSeedOrder()`): recursively
  expands `[1,2]` → `[1,4,2,3]` → `[1,8,4,5,2,7,3,6]` → ..., pairing each
  existing seed `s` against `(size+1-s)` at the next size up. This guarantees
  seed 1 and seed 2 can't meet before the final, and — proven by this
  construction, not just asserted — that byes (seed numbers > N, which only
  ever occupy round-1 slots) never double up in a single round-1 match, since
  `bracketSize - N` (the bye count) is always `< bracketSize/2` by definition
  of "smallest power of two ≥ N."
- **Round rows are built final-first**: `tournament_rounds`/`tournament_matches`
  for the LAST round are inserted before the first, so every earlier round's
  matches can set `winner_next_match_id` pointing at an already-existing row in
  the next round (rather than needing a second pass to backfill pointers).
- **Byes auto-resolve immediately, cascading forward**: a round-1 match with
  exactly one real player (`is_bye=1`) advances that player via the same
  `_advanceTournamentMatch()` propagation function used for a real result — so
  a round-2 match fed by **two separate** round-1 byes ends up immediately
  `ready` (both real players known) without either underlying bye match ever
  needing to be "played." This is the one genuinely subtle case in the whole
  feature — covered explicitly in `backend/test/tournament.test.js`'s 5-player
  case (byes cascading into an already-`ready` semifinal).
- **Round labels** (`_roundLabel()`): computed once at creation from how many
  rounds remain until the final — `0` → `"Final"`, `1` → `"Semifinal"`, `2` →
  `"Quarterfinal"`, else `"Round N"` — and stored on `tournament_rounds.label`,
  not recomputed on read.

**Double-elimination** — v1 is restricted to exact powers of two (4/8/16/32/64/128,
`TOURNAMENT_DOUBLE_ELIM_COUNTS`), the deliberate de-risking from the roadmap's §2:
with an exact power of two there are **zero byes**, so the losers bracket has no
cascading-bye problem to solve. The round plan comes from
`doubleElimStructure(k)` in `frontend/scoring.js` (shared with the frontend's
per-round format table so counts/labels can never drift): `k` winners rounds
(match counts N/2, N/4, …, 1), then `2k−2` losers rounds alternating a **minor**
round (LB survivors pair off) and a **major/drop** round (that round's
winners-bracket losers enter), then the **Grand Final** and its conditional
**Grand Final (Reset)** decider — `3k` rounds and `2N−1` matches total (the
reset only ever gets played out when the reset condition is met).
`_generateDoubleElimBracket()` creates every round/match up-front, then wires the
pointer pairs in a second UPDATE pass:
  - Winners winners advance normally; the winners-final winner → Grand Final slot 1.
  - Winners-round-1 losers pair into losers round 1; each later winners round `i`
    (≥2) drops its losers into losers round `2(i−1)` slot 2 (`loser_next_*`).
  - Losers minor rounds feed the next drop round 1:1 (slot 1); drop rounds pair
    their winners into the next minor round; the **losers final** winner → Grand
    Final slot 2.
  So by construction Grand Final slot 1 is always the winners-bracket champion and
  slot 2 the losers-bracket champion. (Anti-rematch losers-bracket seeding — the
  optional refinement that reorders which LB survivors meet — is a deliberate v1
  simplification: the bracket is a valid, fully-playable pairing, just not the
  rematch-minimizing one.)

### Match lifecycle

1. **`startTournamentMatch(matchId)`**: validates the match is `ready` (both
   players known, no `winner_id`, no `game_id` yet already), then calls
   `createGame()` with that round's own `legs_per_set`/`sets_per_game` and the
   two players' own current out-mode preference, and stores the resulting
   `game_id` back on the match row.
2. **On completion**: an `onGameCompleted` hook (registered once at module
   load — see §1's "Game-lifecycle hooks") checks whether the finished game's
   id matches a `tournament_matches.game_id`; if so it calls
   `_advanceTournamentMatch(matchId, winnerId)`, which records the winner and then:
   the **loser** drops into `loser_next_match_id`'s slot if set (a
   double-elimination winners-bracket loss) or is marked `eliminated` in
   `tournament_players` if not (single-elim, or a losers-bracket loss); the
   **winner** fills `winner_next_match_id`'s slot, or — if there is no next match
   (a single-elim final) — the tournament completes via `_completeTournament()`
   (sets `champion_id`/`runner_up_id`/`status='completed'`/`completed_at`, marks
   the winner `champion`). **Giant Slayer** (§7) is awarded per real (non-bye)
   match by `_maybeAwardTournamentGiantSlayer()`, so a winners-bracket upset still
   counts even though that loser only drops rather than being eliminated.
   The **grand final** is settled separately by `_resolveGrandFinal()` (a plain
   "no next match → complete" rule can't express the conditional decider): if the
   winners-bracket champion (slot 1) wins game one the tournament ends; if the
   losers-bracket champion (slot 2) wins game one, both hold exactly one loss, so
   the pre-created **reset** match is populated with the same two finalists and
   becomes `ready` — the tournament only completes once that decider resolves.
   `_advanceTournamentMatch()` **guards** before doing any of that
   (`docs/bug-roadmap.md` BUG-4): it silently returns if the match already has a
   `winner_id` (a replayed/forged completion can't overwrite a decided match) or
   if `winnerId` isn't one of the match's two players (a completion naming a
   non-participant can't inject an outsider into the bracket or as champion). The
   walkover path enforces the same two invariants explicitly; generation-time bye
   advances pass both (the bye match has a null `winner_id` and its winner is its
   one real player).
3. **Walkover** (`recordWalkover(matchId, winnerName)`): records a result
   without playing it out, calling the same `_advanceTournamentMatch()`
   propagation. Allowed any time `winner_id` is still `null` — **regardless of
   whether `game_id` is already set** — which is deliberately what covers the
   roadmap doc's "a tournament match can't just be left as a plain unfinished
   game" requirement: `askEndGame()` on the frontend refuses a plain abandon
   for a tournament match (`game.tournamentMatchId` set) and sends the admin
   back to the bracket to record a walkover instead, which then works whether
   that match was never started or was started and abandoned mid-way.

### Frontend integration points

- **PIN gate**: the New Game screen's per-slot PIN check
  (`withPinCheck()`) has no equivalent entry point for a tournament match,
  since players are fixed by bracket position rather than picked into slots —
  `beginTournamentMatch()` re-applies the same `withPinCheck()` gate for both
  players before actually starting the match, so a PIN-protected player in a
  tournament is exactly as protected as one in a regular New Game.
- **Live scoreboard round label**: `game.tournamentRoundLabel` (set when the
  match object is built) feeds `liveSnapshot()`'s `tournamentRoundLabel` field,
  which `display.html`'s `fmtText()` prefixes onto the existing top-bar text
  (`"Quarterfinal · 501 · first to 3 legs · Leg 1"`) — see §7's note on
  `ALLOWED_LIVE_KEYS`, which this field must stay registered in.
- **Post-game navigation**: `finishUnit('game', ...)`'s "GAME OVER" screen
  shows a **"Back to bracket"** button instead of "New game" when
  `game.tournamentMatchId` is set — the bracket has already advanced
  server-side by the time this renders (the hook fired from the preceding
  `DB.completeGame()`), so this is purely a navigation convenience.
- **Accessibility**: the bracket tree (`renderTournamentDetail()`'s
  `.tourney-bracket` columns) is a spatial/visual layout with a linearized
  text-list equivalent right below it (a `<details>` "Full bracket (list
  view)") plus the "Up Next" list above both — per
  `docs/accessibility-roadmap.md`'s standing checklist that a spatial UI is
  never the *only* way to follow along. Match status (`pending`/`ready`/
  `in_progress`/`complete`) is always icon + text label together
  (`TOURNEY_STATUS_ICON`/`TOURNEY_STATUS_LABEL`), never color alone.

### Frontend: double-elimination setup and bracket view

- **Setup** (`renderTournamentSetup()`): a Single/Double-elimination toggle
  (`setTournamentBracketType()`). Double-elim blocks Create with an explanatory
  note unless the selected count is one of `TOURNAMENT_DOUBLE_ELIM_COUNTS`
  (4/8/16/32/64/128). The per-round format table derives its rows and labels from
  `tournamentRoundPlan()`, which for double-elim calls the **same**
  `doubleElimStructure()` the backend generates from.
- **Bracket view** (`renderTournamentDetail()`): matches are grouped into per-round
  columns. Single-elim (only the winners bracket) shows the columns directly, no
  tabs. Double-elim renders a **Winners / Losers / Grand Final tab switcher**
  (`.tourney-tabs`, `role="tablist"`) showing one bracket panel
  (`role="tabpanel"`) at a time — the roadmap's §4 "two scrollable panels with a
  tab switcher," which keeps the deep double-elim tree (up to ~19 rounds at 128
  players) readable rather than stacking every bracket in one long scroll.
  `tournamentBracketTab` holds the active tab (module-level, persists across the
  re-renders an action triggers; reset in `openTournament()`); `setTournamentBracketTab()`
  re-renders from `tournamentDetailCache` with no network round-trip. The tablist
  is a standard roving-tabindex WAI-ARIA pattern — the selected tab has
  `tabindex="0"`, the rest `-1`, and `tournamentTabKeydown()` handles
  ArrowLeft/Right + Home/End, moving both selection and focus. The linearized
  "Full bracket (list view)" and "Up Next" lists (both bracket-agnostic, always
  visible) remain the non-spatial way to follow either bracket type.

### Deliberately out of scope for this pass

- **Anti-rematch losers-bracket seeding** — the pairing is valid and fully
  playable but not rematch-minimizing (see generation above).
- **A "Practice this" style deep link or bracket-tree drag/zoom** — not requested.

### Tournament badges and Player Profile stats (§7-8, built)

- **Champion / Giant Slayer (Tournament) badges** — see §4's "Tournament
  badges" table for exact trigger conditions. Both are awarded inline from
  `_advanceTournamentMatch()` (`backend/db.js`), not a second parallel hook —
  Champion right where `champion_id` itself is set, Giant Slayer (Tournament)
  right where the loser is marked `eliminated`. Since neither `POST
  /api/games/:id/complete` nor the `onGameCompleted` hook has any response
  channel back to the frontend, the live celebration is detected instead —
  `finishUnit()`'s `game.tournamentMatchId` branch fetches `GET
  /api/players/badges` after the match completes and diffs it against the
  pre-match `earnedBadgeCache` snapshot (the same "already earned?" check
  Around the World already uses), firing `queueBadge()`/`fireMomentCard()` for
  whichever badge is newly present.
- **`GET /api/players/tournament-stats`** (`?name=...`, public) →
  `{ wins, runnerUps, bestFinish }`, backed by `getTournamentStats()`
  (`backend/db.js`). `wins`/`runnerUps` are plain `COUNT(*)` queries against
  `tournaments.champion_id`/`runner_up_id`. `bestFinish` is the furthest round
  label (`"Final"`/`"Semifinal"`/`"Quarterfinal"`/`"Round N"`) this player was
  ever placed into across every tournament they've appeared in (win, loss, or
  bye) — computed per tournament as `MAX(tournament_matches.round_no)` among
  rows naming this player, converted to "rounds from final" via the same
  `_roundLabel()` helper bracket generation already uses, then the single best
  (closest-to-final) result across all their tournaments is kept. Rendered as
  a "Tournaments" `pp-section` on the Player Profile's H2H tab (gated to the
  X01 game-type toggle, since tournaments are X01-only), loaded by
  `loadTournamentStats()`.

---

## 16. Dart Builder / Loadouts

`docs/archive/dart-builder-roadmap.md`. Backend: `backend/db.js`'s "dart builder /
loadouts" section (component/loadout CRUD, `_resolveLoadoutForParticipant()`,
`getLoadoutStats()`). Frontend: `frontend/index.html`'s "DART BUILDER /
LOADOUTS" block, reachable via a player's profile ("🎯 Manage Loadouts") or the
New Game screen's per-slot "🎯 [loadout name / No loadout]" pill.

### Data model

- **`dart_components`** (§13) — a player's personal catalog of barrel/shaft/flight
  parts. No `tip` type: steel-vs-soft-tip changes the whole board/game (out of
  scope, consistent with the app's steel-tip assumption throughout), and tip
  *texture* (smooth/grooved) is a single attribute of the assembled loadout, not
  a reusable named part the way barrels/shafts/flights are.
- **`loadouts`** (§13) — exactly one component per type (each slot individually
  nullable while "in progress") plus `tip_texture` and `dart_count`. A loadout
  can't actually be *used in a game* until barrel/shaft/flight are all filled —
  `_resolveLoadoutForParticipant()` enforces this at game-creation time, not at
  save time, throwing if an incomplete loadout is selected.
- **`game_players.loadout_id`** — resolved once at game creation and snapshotted
  (mirrors `dart_weight`/`out_mode`'s existing snapshot pattern), so renaming or
  deleting a loadout later never rewrites a past game's history.
- **Closed enums, no free-text escape hatch** (a deliberate v1 decision):
  `getDartComponentOptions()` in `backend/db.js` is the single source of truth
  both the server (validation) and client (dropdown rendering) read from — the
  frontend never hardcodes a second copy of a shape/material/grip list.

### `players.dart_weight` is retired as a write path

The player-page and Add-Player-modal "Dart Weight" dropdown (`dartWeightOptions()`)
is gone from the UI entirely. Going forward, `game_players.dart_weight` is
sourced **only** from the selected loadout's barrel `weight_g` — no loadout
selected means `NULL`, even for a player who still has an old `players.dart_weight`
value sitting on their row from before this feature shipped. That old data is
left orphaned deliberately (no migration into a fabricated "legacy loadout") —
see §13's `players` table note. The `weight` stat-history filter
(`getDartWeights()`, `GET /api/players/:name/history?weight=`) is unchanged and
keeps reading whatever ended up in `game_players.dart_weight`, regardless of
which mechanism (old per-player picker or new loadout) wrote it.

### PIN gating

Two mutating actions are gated behind a PIN-protected player's own PIN, both by
virtue of living inside the Player Profile's existing PIN-gated
`player-controls` block (`unlockPlayerSettings()`/`playerSettingsUnlocked` —
the same gate that already protects the finish-rule toggle) rather than a new
check mechanism: setting/changing the **Default Loadout** selector, and opening
**"🎯 Manage Loadouts"** into the Dart Builder screen at all. A player without a
PIN keeps today's no-PIN-required behavior. Selecting *which* of a player's
existing loadouts to use for the current game (the New Game screen's picker) is
**not** separately PIN-gated beyond the existing per-slot `withPinCheck()` — it's
a selection among already-visible options for immediate play, not a
customization action, the same way finish-rule/out-mode picks on New Game aren't
separately gated either.

### Stats scoping

`getLoadoutStats(playerName, loadoutId)` lives only on the Dart Builder screen
for the loadout currently open — not a Player Profile filter dropdown. It's a
dedicated query, not a `_scope()` extension: `_scope()` composes game-level
dimensions (mode, game type), but a loadout selection is a per-player-per-game
attribute on `game_players` (same shape as `dart_weight`/`out_mode`), so scoping
by it needs a join keyed on `(game_id, player_id)`. `gamesPlayed`/`wins` are
anchored on `game_players`/`games` directly (not `turns`) — a game with zero
turns recorded so far still counts as "played" under its loadout; this was an
actual bug caught during end-to-end verification (originally joined through
`turns`, silently excluding a just-started or abandoned-with-no-turns game),
fixed before shipping, regression-tested in `backend/test/dart-builder.test.js`.
Returns games played, wins, darts thrown, 3-dart average, 180 count, and
checkout count — all reusing `getPlayerStatBubbles()`'s exact existing formulas
(no new derived formula invented), just re-scoped.

### Loadout comparison view (2026-07)

A third `dartBuilderView` state (`'compare'`, alongside `'list'`/`'edit'`),
reached from a "⚖️ Compare Loadouts" button on the loadout list screen (shown
once a player has 2+ loadouts). No new backend query — `openDartBuilderCompare()`
fetches every one of the player's loadouts via the existing `listLoadouts()`
plus one `getLoadoutStats()` call per loadout (`Promise.all`, not sequential),
caches both in memory for the screen visit, then renders a side-by-side table:
components, games played, wins, win % (`wins/gamesPlayed*100`, rounded — not a
new tested formula, the same untested presentational arithmetic the roster
page's own win-rate chip already uses), darts thrown, 3-dart average, 180s,
checkouts. Every loadout is selected by default; tapping a loadout's toggle
button (`aria-pressed`, same accessible toggle-group pattern the Custom Cricket
number picker already uses) adds/removes its column from the table **without
re-fetching** — `_dartBuilderCompareStats` is only cleared (forcing a fresh
fetch) when the screen is freshly entered via `openDartBuilderCompare()`, since
there's no way to mutate a loadout from within the compare screen itself.
Requires at least 2 loadouts selected to render a table (guides toward
selecting more otherwise); requires at least 2 loadouts to exist at all to
reach the screen in the first place. Verified end-to-end with Playwright
against a live server: two loadouts with genuinely different recorded games
(one win/one loss, different darts/averages/180s/checkouts) render correct,
distinct per-column figures, and toggling a column off then back on correctly
removes/restores it without corrupting the cached stats.

### Visual icon/diagram per barrel shape/grip and flight shape (2026-07)

Closes the accessibility gap the v1 dropdowns left open (terms like "torpedo,"
"knurled," or "kite" aren't self-explanatory by name alone). Rather than
replacing the barrel-shape/barrel-grip/flight-shape `<select>` elements with a
non-native picker (a real accessibility regression risk if built without full
keyboard support), they're replaced with an **icon-button group** — the same
accessible toggle-group shape (`role="group"`, per-button `aria-pressed`) the
Custom Cricket number picker already uses, so keyboard/focus behavior stays
equal or better, not worse. `COMPONENT_ICONS` (`frontend/index.html`) holds one
small hand-coded inline SVG per enum value (10 total: 3 barrel shapes, 3 barrel
grips, 4 flight shapes) — plain geometric outlines using `currentColor`, the
same "no external assets, hand-coded SVG" convention `buildDartboard()` already
established, not a photorealistic illustration. `iconPickerHtml(fieldId,
iconSetKey, values, groupLabel, selected)` renders one field's button row plus
a **hidden `<input>`** carrying `fieldId` — deliberately kept as the exact same
element id (`ce-shape`/`ce-grip`) the old `<select>` used, so
`submitComponentEditor()`'s existing `document.getElementById(id).value` reads
needed **zero changes**. Each icon is `aria-hidden="true"` (decorative only —
the button's own text label, not the icon, is the accessible name, so meaning
is never conveyed by shape alone); shaft's "Type" field (fixed/spinning) is
unaffected, staying a plain `<select>` since it was never named in the
accessibility gap. Verified end-to-end with Playwright: clicking an icon
button updates the hidden input's value and `aria-pressed` state correctly,
and the saved component persists the clicked value.

### "Quick-add full set" one-shot entry form (2026-07)

A fourth `dartBuilderView` state (`'quickadd'`), reached from a "⚡ Quick Add
Full Set" button on the loadout list screen. No new backend endpoint —
`submitDartBuilderQuickAdd()` orchestrates the same `createComponent()` ×3 +
`createLoadout()` calls the normal 3-modal flow already makes, sequentially
(not `Promise.all` — stopping partway on a validation failure is preferable to
firing all three in parallel and reconciling which succeeded), just from one
screen with all of a barrel/shaft/flight's fields (name, length, weight/type,
material, shape/grip via the same icon pickers above) plus the loadout's own
name and tip texture, and one Save button instead of three separate "+ New
{type}" round trips followed by a fourth loadout-save step. Field ids are
`qa-{type}-{field}`-prefixed so all three components' forms can coexist on one
page without id collisions with each other or with the (unrelated,
not-simultaneously-open) component-editor modal. On success, navigates
straight to the new loadout's edit view (its stats section, showing 0s until
first played). On a partial failure (e.g. the flight name is missing after the
barrel and shaft already saved), the error message explicitly notes that
already-created components remain in the player's catalog, assignable from the
normal editor — nothing is silently lost, since a `dart_components` row is a
real, independently useful entity on its own, not scoped to the loadout it was
created alongside. Verified end-to-end with Playwright: one submit creates all
three components plus a loadout linking them, with icon-picker shape/grip
selections correctly persisted on the barrel and flight.

### Deliberately out of scope for this pass

- **Optional photo upload per component** — considered, explicitly dropped
  (2026-07): it was framed as an *alternative* to a generic shape/grip icon
  set, not additive to one, and the icon set above already covers that need.
  Not tracked further.
- **A literal CoD/Halo-gunsmith illustration** (centered dart, fanning
  leader-line callouts) — shipped instead as a stacked grouped-section form,
  functionally equivalent and inherently mobile-responsive (no wide layout to
  collapse), just visually plainer than the roadmap doc's original sketch.

---

## 17. Dartboard Zone / Miss / Bounce-Out Tracking

`docs/archive/dartboard-zone-tracking-roadmap.md`. Dartboard-mode-only positional
metadata riding alongside ordinary `darts` rows — no scoring behavior change,
purely a data-granularity and heatmap-visualization feature. Backend:
`getDartHeatmap()`/`getBounceOutCount()` in `backend/db.js`. Frontend:
`buildDartboard()`, `buildDartHeatmap()`, `throwDart()`/`throwDartBoard()`/
`throwBounceOut()` in `frontend/index.html`.

### Zone tracking — inner vs. outer single

A real dartboard number wedge has two physically distinct single-scoring
regions (inner: between bull and treble; outer: between treble and double),
both scoring identically. `buildDartboard()` already draws them as separate
SVG paths (`R.bullOut`→`R.trebleIn` and `R.trebleOut`→`R.doubleIn`); each
path's `onclick` now passes a third argument — `throwDartBoard(sector, 1,
'inner')` / `throwDartBoard(sector, 1, 'outer')` — that threads through
`throwDart()` into the dart object as `d.zone`, then into `darts.zone` via
`addTurn()`. A double, treble, or bull hit never carries a zone (no
inner/outer distinction physically exists for those), and a Pad-mode single
never can either (a Multiplier+Number grid has no geometric tap position) —
`zone` stays `NULL` for both, permanently, by design; **scope is Dartboard-mode
singles only, never retrofitted or backfilled**.

### Miss-area tracking — a two-band positional miss ring

`buildDartboard()`'s 20 angular wedges extend radially outward past the
double ring into two new rings — `R.missNear` (270) and `R.missFar` (310),
the SVG's `viewBox` enlarged from `"0 0 500 500"` to `"0 0 660 660"` (board
recentered at `CX=CY=330`) to fit them. Tapping a miss-ring segment records
`sector:0, multiplier:1, missZone:<nearest wedge 1-20>, missDepth:'near'|'far'`
— `throwDartBoard(0, 1, null, wedgeNum, 'near'|'far')`. **The old flat
`#board-miss-btn` (Dartboard-mode's only miss entry point) no longer exists**
— every Dartboard-mode miss now has to land in one of the two rings. Pad
mode's own inline-created Miss button (built by `renderPad()`, a completely
separate code path) is untouched and still produces a positionless miss
(`missZone`/`missDepth` both `NULL`). `miss_zone`/`miss_depth` are always set
or unset together; `sector`/`multiplier` stay exactly `0`/`1` for every miss
regardless of input mode, so every existing `sector===0` consumer
(`evaluateVisit()`, the "Where'd It Go?" badge, `getGhostLegScript()` replay)
needs zero changes.

### Bounce-out tracking (v1 — flat count, no position)

A **third, distinct dart outcome** from a genuine miss: the dart struck a
real number/ring but didn't stay long enough to count. `darts.bounced=1`
marks it, with `sector`/`multiplier` still exactly `0`/`1` — to every
existing consumer a bounced dart is a completely ordinary miss row. One
**"Bounce Out" button** (`throwBounceOut()` → `throwDart(0, undefined,
undefined, undefined, true)`) sits where the old flat Miss button used to,
available in every game type and both input modes — including Cricket's
own dedicated pad (`renderPadCricket()`), which has no Pad/Dartboard toggle of
its own to hang that availability off of — **except Checkout Trainer**, whose
Pad-mode scoring screen hides Bounce Out, the inline Miss button, and Undo
Last Turn entirely (`renderGameShell()`/`renderPad()`, `frontend/index.html`):
a checkout attempt is a deliberate, low-pressure drill against a target, not a
live match, so those three controls have no meaningful role there. No toggle, no position captured,
one dart committed immediately per press. Surfaced as a plain "Bounce-outs: N"
count line next to the Player Profile's heatmap (`getBounceOutCount()`, `GET
/api/players/bounce-outs`), not a spatial marker — v1 genuinely has no
position to plot. **v2 (positional capture) is explicitly deferred**, gated on
`docs/camera-scoring-roadmap.md` existing — manually reconstructing where a
dart struck *after* it already fell isn't reliable data; a camera has genuine
ground truth at the moment of impact, a human guessing under time pressure
doesn't.

### The generalized dartboard heatmap (X01, Cricket, Baseball, Doubles Practice, Chuckin)

Originally Chuckin-exclusive (`getChuckinHeatmap()`/`buildChuckinHeatmap()`);
generalized since `darts` is the one universal per-dart table every game type
writes into. `getChuckinHeatmap(playerName, mode)` is now a thin wrapper
around `getDartHeatmap(playerName, gameType, mode)`, scoped via the same
`_scope({mode, gameType})` helper every other per-game-type query already
uses. `GET /api/players/chuckin-heatmap` is kept exactly as-is for backward
compatibility; `GET /api/players/dart-heatmap?name=&gameType=&mode=` is the
generalized surface. The Player Profile's "Dartboard Heatmap" section
(`dart-heatmap-section`/`dart-heatmap-body`, inside the shared `chartSection`
markup) shows on every game-type tab that has one — `loadDartHeatmap()` fires
for whichever tab is currently active, except Checkout Trainer (hidden
entirely, since its taps aren't real thrown darts).

`buildDartHeatmap(cells, {ariaLabel, noZoneTracking})` renders three things
per number: the inner-single and outer-single regions (each independently
shaded by hit count), and the miss ring (shaded by `missHeat(wedge, depth)`,
its **own independent heat-scale normalization**, not shared with the
scoring regions, since hit and miss counts are wildly different population
sizes per player).

A **zone-unspecified single** — `d.zone` is only ever set by the geometric
Dartboard-mode board's own single-region taps (`buildDartboard()`'s `oc(sec,
1,'inner'|'outer')`) — is handled two different ways, depending on whether
the game type can ever produce a zone value at all (`docs/bug-roadmap.md`
BUG-24):
- **X01, Chuckin, Doubles Practice** (`noZoneTracking` unset/false — these all
  have a real Dartboard-mode alternative to Pad mode, so an unzoned single
  reflects the player's own input-mode choice): excluded from the heatmap
  entirely, by product decision — real hit data, just not attributable to
  inner or outer, so rather than show any visual trace of it, it's simply not
  plotted. (An earlier version drew a faint diagonal hatch overlay across
  both single regions for that number instead of omitting it — changed
  2026-07 per a live user bug report: the hatch box read as a display glitch,
  not a meaningful third state.) It's still never silently folded into either
  real bucket or split 50/50 — omitted is not the same as miscounted.
- **Cricket, Baseball** (`noZoneTracking` true — `renderPadCricket()`/
  `renderPadBaseball()` are always used regardless of the `dartboardMode`
  preference, so these two game types can **never** produce a zone value;
  every single they ever record is unzoned, permanently, not by choice):
  the exclusion is skipped, and both the inner and outer sub-regions read one
  merged bucket (every single for that number, zone ignored) instead of two
  separately-keyed always-empty ones — so the whole single ring lights up
  with the real total, tooltip reading e.g. `"15: 3 hits"` with no
  "(inner)"/"(outer)" claim, rather than staying permanently blank. Applying
  the X01-style exclusion here had silently hidden every single hit —
  including on real Cricket targets — from these two game types' own
  heatmaps entirely.

The flat `topSectors` list (§3, Dart Analytics) is a separate surface and
keeps its own distinct textual treatment (`dartLabelFromParts()` appends `"
(zone unknown)"` to a zone-less single, never to a double/treble/bull, which
never had a zone concept at all) — unaffected by either heatmap behavior
above, since that's a text list, not the heatmap, and was never gated on zone
at all.

### Testing

`backend/test/db.chuckin-stats.test.js`'s "getDartHeatmap — zone-scoped
grouping" and "getBounceOutCount" describe blocks; `backend/test/db.turn-
validation.test.js`'s "addTurn — zone/missZone/missDepth/bounced validation"
block; `backend/test/scoring.test.js`'s regression proving this metadata never
changes `evaluateVisit()`'s outcome; `backend/test/dart-heatmap.test.js`'s
`noZoneTracking` describe block (`docs/bug-roadmap.md` BUG-24), vm-extracting
`buildDartHeatmap()` directly from `frontend/index.html`. See
`docs/archive/dartboard-zone-tracking-roadmap.md`'s own "Testing" section for
the full list, including a manual end-to-end Playwright verification pass
against a running server.

---

## 18. League Mode

`docs/archive/league-mode-roadmap.md`. X01 or Cricket, per `leagues.game_type`
(Doubles Practice/Just Chuckin' It/Checkout Trainer are structurally excluded
regardless — all solo/no-winner formats). Backend: `backend/db.js`'s league
section. Frontend: `frontend/index.html`'s "leagues" block, reachable via the
**Leagues** nav button.

### Design principle: a league game IS a normal game, tagged after the fact

Unlike a tournament match (which has its own bracket position/round/advancement
state, tracked via a separate `tournament_matches` row with its own `game_id`
FK — see §13, §15), a league match has no such structure: it's just an ordinary
casual H2H game that happens to get tagged. Per `CLAUDE.md`'s "context tables
link into `games` via FK" convention, the link is therefore a direct nullable
`games.league_id` column (see §13) rather than a junction table — the one
deliberate exception to the "own table with a `game_id` FK" shape, because
there's no match-level state for a separate table to hold.

### Standings are computed LIVE, never maintained

`league_players` holds only enrollment (`league_id, player_id, joined_at`) — no
`points`/`played`/`won`/`lost` tally columns. `getLeagueStandings(leagueId)`
(`backend/db.js`) fetches the enrolled roster, then a separate aggregate query
over `games`/`game_players` scoped to `WHERE g.league_id = ? AND g.winner_id IS
NOT NULL` (only a **decided** result counts — an abandoned game completed with a
null winner, which `completeGame()` allows, is not a result either way), and
merges the two in JS the same base-row-then-patch-in-aggregate idiom
`computeStats()` already uses elsewhere. `points = won * pointsWin + lost *
pointsLoss` (both admin-configurable per league, default 1/0 — simple win/loss,
no margin-of-victory texture per the roadmap doc's own resolved open question).
Sort: points desc, then win% desc (a zero-played enrolled player's `null` win%
sorts last among equal points via a `?? -1` fallback, never confused with a real
0% record), then name. Nothing here can drift out of sync, because nothing is
stored beyond the raw games/enrollment it's computed from — the same standing
design principle `computeStats()`/`getHomeExtra()` already follow.

### Auto-tagging (`onGameCreated` hook, no `onGameCompleted` needed)

`createGame()` collects each participant's id during its existing player-adding
loop (`participantIds`) and passes both that and an optional client-supplied
`leagueId` into the `created` lifecycle-hook payload (see §1's "Game-lifecycle
hooks"). A league-mode `onGameCreated` listener does the actual tagging:

1. Skip unless the game is X01 or Cricket, non-practice, exactly 2 players.
2. If `leagueId` was supplied (from the New Game "log to league?" picker below),
   **re-validate** it via `_findEligibleLeagues(category, playerIds, gameType)`
   rather than trusting it blindly — a few seconds may have passed since the
   picker's own `GET /api/leagues/eligible` call, so a stale/invalid choice
   falls through to auto-detection instead of failing game creation.
3. Otherwise, auto-detect: `_findEligibleLeagues()` returns every `active`
   league matching this game's `game_type` **and** `category`, with both
   players currently enrolled, whose date window (`starts_at`..`ends_at`,
   `ends_at` nullable = open-ended) includes today. **Exactly one** candidate
   auto-tags silently — the common case, no picker ever shown. **Zero or more
   than one** leaves the game untagged; a non-frontend API caller that doesn't
   supply a `leagueId` gets no guess either way. Filtering on `game_type` means
   an X01 game can never tag into a Cricket league (or vice versa) even when
   both leagues enroll the same two players.

Unlike tournament mode, league mode registers **no** `onGameCompleted` hook —
there's no propagation step to react to (no "next slot" to fill). A completed
game with `league_id`/`winner_id` already set is simply read directly at
standings-query time.

### Season lifecycle

`leagues.status` (`'active'`/`'ended'`) is a manual admin toggle
(`setLeagueStatus()`, reversible — reopening a league ended by mistake is
supported) that gates whether **new** games can auto-tag into it; already-tagged
games keep their `league_id` regardless. `ends_at` independently gates
eligibility the same way (a league past its end date stops accepting new tagged
games even if `status` is still `'active'`) — there's no background/cron job
inside the app process to flip `status` automatically, so this is deliberately
two independent signals rather than one that needs scheduled maintenance.
"Standings freeze" once a season ends is automatic by construction (no new
games can attach), not a separate snapshot step — a "past seasons" archive is
just `listLeagues()` including ended ones, each still fully viewable.

### `wipeAllData()` / `resetStats()` — an intentional asymmetry

`wipeAllData()` explicitly `DELETE FROM leagues` (cascading `league_players`) —
the same BUG-7 fix tournament mode needed: wiping all `players` cascades away
`league_players` for free, but nothing references the `leagues` **parent** row,
so without this a league shell (name/category/dates, now with an empty roster)
would survive a total wipe. `resetStats()` deliberately does **NOT** touch
`leagues`/`league_players` — unlike tournament's `tournament_matches.game_id`,
nothing in the leagues schema points at a `games` row, so wiping every game
leaves a league in a fully self-consistent state: standings simply recompute
live to all-zero, never a stranded half-updated shell the way tournament
brackets were pre-BUG-7. A league's own config is closer to player-profile
configuration data (which also survives a stats reset) than to tournament's
mid-flight bracket state.

`resetStats()` **does** explicitly `DELETE FROM marathon_sessions` (cascading
`marathon_session_legs`) — the same BUG-7 class as tournaments: nothing in
`marathon_sessions` references a `games` row (only `player_id`), and
`marathon_session_legs.game_id` is `ON DELETE SET NULL`, so without the
explicit delete a stats reset would leave completed sessions behind as phantom
history (`sessionsCompleted > 0` with zero legs). `wipeAllData()` needs no
marathon line — the players wipe cascades `marathon_sessions` (and
transitively the legs) for free.

### No player-deletion guard (a deliberate non-decision, not an oversight)

Tournament mode registers a `registerDeletePlayerGuard()` (§15) because an
active bracket structurally depends on that exact player existing at a specific
slot. League mode registers none: deleting an enrolled player cascades away
only their own `league_players`/`game_players`/`turns` rows — the surviving
opponent's `game_players` row and the game's own `winner_id` are untouched
(`games.winner_id ON DELETE SET NULL` only fires if the *deleted* player was the
winner), so standings simply recompute over what remains. This is only safe
*because* standings are computed live rather than incrementally maintained — a
guard would have been necessary under the roadmap doc's original
maintained-tally suggestion, not this one.

### Frontend integration points

- **New Game "log to league?" picker — retired (2026-07)**: `updateLeaguePicker()`/
  `#league-picker-wrap`/`setup.leagueId` and the H2H banner they sat beside
  (`updateH2HBanner()`/`#h2h-banner`, `GET /api/players/h2h`) were all removed
  when the New Game screen became a 3-step wizard (`docs/archive/new-game-flow-roadmap.md`)
  — superseded by Step 2's fixture-based "League Game" entry, see below and §18's
  own "League fixtures / pending matches" section. `GET /api/leagues/eligible`
  and the server-side `onGameCreated` auto-tag hook's own 0/1/>1-candidate
  fallback (unrelated to any picker) are both unaffected and still fully
  functional — only the frontend picker UI and its now-unreachable HTTP
  companion (`/api/players/h2h`; `getH2HRecord()` itself stays, still used
  internally by per-player export/import and still covered by its own tests)
  are gone.
- **League setup screen**: a `game_type` toggle (X01/Cricket) alongside the
  existing category picker, which switches between the X01 starting-score
  `<select>` and a Cricket classic/custom `<select>` depending on the chosen
  game type (`setLeagueGameType()`, `renderLeagueSetup()`).
- **Home page teaser**: `getHomeExtra()` includes a plain `activeLeagues`
  id/name list; `renderHomePulse()` renders it as a lightweight "Active
  Leagues" card (name + link into the full Leagues screen) only when at least
  one exists — no embedded mini-standings, to keep the Home page diff small.
- **Player Profile "Leagues" stat block**: `GET /api/players/league-summary`
  (public) → `getPlayerLeagueSummary()`, every league this player belongs to
  plus their current rank/points in each, rendered the same
  loading-placeholder-then-patch-in pattern `loadTournamentStats()` already
  uses (`loadPlayerLeagueStats()`), gated to the X01 **and** Cricket tabs
  (unlike tournament stats, which stay X01-only).
- **Standings table**: a real `<table>` with `<caption class="sr-only">` and
  `<th scope="col">` headers (`renderLeagueDetail()`) — deliberately not the
  `.hof-row` flex-leaderboard pattern used for single-stat leaderboards
  elsewhere, since a proper `<table>` is more accessible for a genuinely
  multi-column grid (rank/name/played/won/lost/win%/points) and needs no
  separate linearized fallback the way the tournament bracket's spatial view
  does. Status badges are icon + text together (`LEAGUE_STATUS_ICON`/
  `LEAGUE_STATUS_LABEL`), never color alone, matching every other status badge
  in the app.
- **Calendar-date formatting**: `starts_at`/`ends_at` are pure `YYYY-MM-DD`
  values with no time-of-day component — rendered via a dedicated
  `fmtCalendarDate()` that parses the string directly, **not** the existing
  `fmtDate()` (which is built for UTC timestamps and reinterprets them through
  local `Date` getters; doing that to a bare calendar date shifts it by a day
  in any negative-UTC-offset timezone).

### League fixtures / pending matches (`docs/archive/league-mode-roadmap.md`)

A scheduled-but-unplayed pairing, tracked separately from the direct
`games.league_id` tagging above — `league_fixtures` follows `tournament_matches`'
own "own table + `game_id` FK" shape instead (see the schema table above),
because a fixture needs to exist *before* any game does.

- **Round-robin generation** (`_generateRoundRobinFixtures()`, `backend/db.js`):
  single round-robin — one fixture per unique enrolled pair, generated at
  league creation for the initial roster and again for just the new pairings
  whenever a player joins an already-active league (`enrollLeaguePlayer()`,
  which is now a no-duplicate no-op on re-enrolling an already-enrolled
  player). No admin-driven manual fixture creation/cancellation.
- **Linking is explicit, not inferred**: `createGame()` accepts an optional
  `leagueFixtureId`. When present it's fully validated up front (fixture
  exists, has no game linked yet, the submitted players are exactly this
  fixture's pair, and `gameType`/`category` match the fixture's own league) —
  a mismatch **rejects** game creation (unlike a stale `leagueId` hint, which
  falls through silently). On success, `league_fixtures.game_id` and
  `games.league_id` are set directly, before the `created` lifecycle hook
  fires. The league auto-tag `onGameCreated` listener checks whether
  `games.league_id` is already non-null and returns immediately if so — a
  fixture-linked game never re-runs the fuzzy eligibility match, even when the
  pair shares more than one active league.
- **`GET /api/leagues/pending-fixture?p1=&p2=`** (public) →
  `getPendingFixturesForPlayers()` — every pending fixture across every
  active league both players share, order-independent on the pair, callable
  *before* any game type/category is chosen (unlike `/api/leagues/eligible`).
- **Read-only Fixtures list** on the League detail screen
  (`renderLeagueDetail()`, embedded in `GET /api/leagues/:id`'s `fixtures`
  array via `getLeagueFixtures()`): every fixture with its derived status
  (`FIXTURE_STATUS_ICON`/`FIXTURE_STATUS_LABEL` — Pending/In progress/Played,
  icon + text together).
- **New Game "League Game" entry** (§20's Step 2, `docs/archive/new-game-flow-roadmap.md`):
  once Step 1 finishes with exactly 2 players, `setupGoToStep2()` calls the
  pending-fixture endpoint above and, if it returns anything, injects a
  "🏆 League Game" option at the top of Step 2's dropdown
  (`renderSetupStep2Content()`). Selecting it (`applyLeagueGameSelection()`)
  auto-fills `setup.gameType`/`setup.start`/`setup.cricketPreset` from the
  fixture's league and sets `setup.leagueFixtureId`, skipping the X01
  starting-score question entirely (hidden whenever League Game is selected,
  since the league already pins it) — a Custom Cricket league still needs its
  7 targets chosen in Step 3, since the league's category doesn't pin the
  exact numbers. 2+ pending fixtures reveal a second "Which league match?"
  dropdown, the same secondary-dropdown slot X01's own flavor question uses.
  `setup.leagueFixtureId` threads through `startGame()`'s `game` object and
  `DB.beginGame()`'s `POST /api/games` payload.
- **`wipeAllData()`/`resetStats()`**: `league_fixtures` needs no explicit
  delete in either — `wipeAllData()`'s `DELETE FROM leagues` cascades it
  (`league_id ON DELETE CASCADE`, also independently covered by the players
  delete via `player1_id`/`player2_id ON DELETE CASCADE`); `resetStats()`
  deleting every game reverts every linked fixture back to `pending`
  (`game_id ON DELETE SET NULL`, not `CASCADE`) rather than stranding or
  deleting the fixture row — correct, since the game that would have
  fulfilled it no longer exists.

### Deliberately out of scope

- **Multi-league auto-tagging** — a game only ever tags into **one** league
  (`games.league_id` stays a single nullable FK); a player can be enrolled in
  several concurrent leagues, but any one game they play logs to at most one of
  them (resolved via the picker when genuinely ambiguous, per above).
- **League deletion** — matches tournament mode's own precedent (create + read
  + one state-changing lifecycle action, no delete route); a league can only be
  ended, never removed, short of `wipeAllData()`.
- **Double round-robin, manual fixtures, and end-of-season unplayed-fixture
  callouts** — each resolved as "not for v1" rather than left open; see
  `docs/archive/league-mode-roadmap.md`'s "League fixtures / pending matches" section
  for the reasoning behind each.

---

## 19. Checkout Trainer

Full design: `docs/archive/checkout-trainer-roadmap.md`. A pure mental-recall drill —
no dartboard throwing involved at all — genuinely different from Daily
Challenge's "Checkout Sprint" format (which measures a real physical throw at
a real target). The app gives a target score; the player taps out a proposed
checkout using the same Pad/Dartboard widgets every other mode uses, and it's
graded instantly against the objectively optimal route. Two sub-modes sharing
one core mechanic: untimed **Freeform** and the 60-second **Checkout Blitz**
sprint.

**Scoring-screen UI**: the Pad-mode scoring screen hides three controls that
every other game type shows — the "Bounce Out" button, the inline "Miss"
button, and "Undo Last Turn" (`renderGameShell()`/`renderPad()`,
`frontend/index.html`, gated on `game.gameType === 'checkout_trainer'`). A
checkout attempt is a deliberate, low-pressure recall drill against a target
rather than a live match with an opponent to track, so a bounced/missed dart
and turn-level undo have no meaningful role — "Undo Dart" (which un-stages an
uncommitted dart within the current attempt) and "Submit checkout" (this
mode's relabeled Enter Turn) remain, since a checkout attempt is still a
staged up-to-3-dart visit. When the session has trick questions on
(`config.trickQuestions`), a "🚫 No possible checkout" button appears
alongside Submit — the declaration answer path (see **Trick questions**
below).

**Game type**: `checkout_trainer`, one of `KNOWN_GAME_TYPES` (`backend/db.js`).
Every dart-count attempt is its own 1-3 dart `turns` row — the same per-dart-
turn shape Doubles Practice/Just Chuckin' It already use — reusing
`evaluateVisit()` (`frontend/scoring.js`) completely unmodified: a checkout
attempt genuinely IS a normal X01 visit starting from `remaining = target`.

**Schema**: `turns.target_score INTEGER` (nullable) — the target offered for
that round; only ever populated for this game type, since (unlike X01) there's
no persistent "remaining score" state to derive it from afterward.
`turns.declared_unsolvable INTEGER NOT NULL DEFAULT 0` — `1` marks a
trick-question round answered by declaring "no possible checkout" (see
**Trick questions** below); the only turn shape allowed to carry zero dart
rows. `games.config.mode`: `'freeform' | 'blitz'` — a mode flag, not a second
`game_type`, since both sub-modes share identical target selection and grading
and differ only in pacing/scoring (the same relationship X01's own H2H-vs-
Practice split has within one `game_type`). `games.config.durationSec`: fixed
at `60` for Blitz, `null` for Freeform. `games.config.difficulty`: one of
`'under40' | 'under100' | 'over100' | 'full'` (default `'full'`) — set once at
New Game via the Checkout Trainer options section's difficulty toggle
(`setCheckoutTrainerDifficulty()`, `frontend/index.html`) and immutable for the
rest of that session, same "baked into `config` at `startGame()`" treatment
`mode`/`durationSec` already get. `games.config.trickQuestions`: boolean
(default `false`) — the trick-question variant's own New Game toggle
(`setCheckoutTrainerTricks()`), baked in the same way.

**Grading** (`frontend/scoring.js`):
- `pickCheckoutTarget(doubleOut, rng, difficulty, trickChance, pinnedTarget)` —
  picks a uniform-random integer target within the selected difficulty tier's
  `[low,high]` bound (`CHECKOUT_TRAINER_DIFFICULTY_TIERS`), intersected with
  the out-mode's own floor (`2` under double-out since `1` is an unfinishable
  bogey, `1` under single-out). `difficulty` defaults to `'full'` (`[1,170]`
  intersected with the out-mode floor — the original, tier-less range) when
  omitted or unrecognized, so every pre-existing caller keeps working
  unchanged. Tiers: `under40` `[1,39]`, `under100` `[1,99]`, `over100`
  `[100,170]`, `full` `[1,170]`. Re-rolls while `checkoutHint()` reports the
  candidate unfinishable, reusing `checkoutHint()`'s own `''` unfinishable
  signal instead of a separate hardcoded bogey-number list. `trickChance`
  (0..1, default `0` — the pre-trick behavior byte-for-byte): probability
  this round instead serves a deliberately **unsolvable** bogey number from
  the tier (`listUnsolvableTargets()`, also derived from `checkoutHint()`'s
  `''` signal — `159/162/163/165/166/168/169` under double-out,
  `163/166/169` under single-out, all above 100 so the Under 40/Under 100
  tiers simply fall through to a normal target). Set to
  `CHECKOUT_TRAINER_TRICK_CHANCE` (0.125, ~1 round in 8) when the session has
  `config.trickQuestions` on. `pinnedTarget` (§19a, "Drill this checkout" deep
  link) short-circuits every difficulty/trick roll above: if set and
  finishable under `doubleOut` (checked via the same `checkoutHint()` signal),
  it's returned immediately regardless of `rng`; an unfinishable pin (a bogey
  number, or `1` under double-out) is ignored and falls through to the normal
  roll.
- `gradeCheckoutAttempt(target, doubleOut, darts)` — returns
  `{legal, usedDarts, optimalDarts, optimal, hint}`. `legal` mirrors
  `evaluateVisit()`'s `win` flag (reached exactly zero, valid last dart under
  double-out). `optimal` additionally requires `usedDarts === optimalDarts`
  (`optimalDarts` = `checkoutHint(target, doubleOut, 3)`'s token count) —
  grading is by dart **count**, not exact route match, since multiple routes
  can tie for the objective minimum. A route submitted against a bogey
  target grades illegal with `hint: ''` — the UI shows the "trick question"
  reveal for that case instead of an empty "best route".
- `gradeCheckoutDeclaration(target, doubleOut)` — the trick-question
  variant's second answer path (the "🚫 No possible checkout" button).
  Correct exactly when `checkoutHint()` has no route for the target; returns
  `{declared: true, correct, legal, optimal, usedDarts: 0, optimalDarts,
  hint}` where a **correct** declaration sets `legal`/`optimal` both true (it
  IS that round's best possible answer) and a **wrong** one sets both false,
  with `hint` carrying the route that proves the target was finishable.

Every attempt writes exactly one of three outcomes onto the existing
`bust`/`checkout`/`leg_won` columns (no new columns needed beyond
`target_score`/`declared_unsolvable`): `bust=1` = not a legal finish;
`bust=0, checkout=1, leg_won=0` = legal but not optimal; `bust=0, checkout=1,
leg_won=1` = optimal. Checkout Blitz's scoring formula reads directly off
this three-way outcome — declarations included (a correct call is `leg_won=1`
= 2 points; a wrong one is `bust=1` = 0 points), recorded with
`declared_unsolvable=1` and zero dart rows (`declareUnsolvable()`,
`frontend/index.html`, which discards any half-staged darts — "there's no
checkout" supersedes a half-entered route).

**Trick questions** (docs: the roadmap doc's "Trick-question difficulty
variant", shipped 2026-07): an opt-in New Game toggle
(`config.trickQuestions`, off by default). When on, ~1 round in 8 serves an
actual bogey number, the scoring screen shows a "🚫 No possible checkout"
button alongside "Submit checkout", and the correct answer is pressing it —
tapping out any route against a bogey grades illegal with a "trick question"
reveal, and declaring a *finishable* target unsolvable is equally wrong (the
real route is revealed). Correct declarations count as optimal answers
everywhere the three-way outcome is read (Accuracy/Optimal %, all four
milestone ladders, the streak, Blitz's 2 points) but are excluded from
Toughest Checkout Solved via `declared_unsolvable` and can never trigger the
route-specific one-offs (170 Club, One-Darter — the declaration path never
runs those checks).

**Physical-stat exclusion — stricter than Chuckin's**: these darts are a
*proposed* route, not a real throw, and must have **zero footprint on any
pre-existing stat, full stop** (explicit product decision) — not just the
sector-heatmap/treble-rate/dart-pace exclusions Just Chuckin' It's own darts
already get, but also the raw "total darts thrown"/"last played" counters
that Chuckin (a real physical throw) deliberately keeps counting toward.
Two exclusion constants in `backend/db.js`:
- `NOT_HYPOTHETICAL_DARTS` (generalized from the earlier Chuckin-only
  `NOT_CHUCKIN`) excludes both `'chuckin'` and `'checkout_trainer'` from
  sector heatmaps, treble rate, dart-pace, and Around the World progress.
- `NOT_CHECKOUT_TRAINER`, a narrower Checkout-Trainer-only sibling, additionally
  excludes it (but not Chuckin) from every "pure total darts thrown" counter
  Chuckin is a deliberate exception to: `computeStats()`'s roster `turns`/
  `dartsThrown`, `getSummary()`'s `darts`/`todayDarts`/`weekDarts`, the roster
  "last played" timestamp, `getPlayerStatBubbles()`'s own `dartsThrown`/
  `avgDartsPerDay`/`avgDartsPerLeg` (the X01 profile tab's bubbles),
  `getMetricHistory()`'s `dartsthrown`/`avgdartsperday`/`avgdartsperleg`/`pace`
  chart metrics, `getPersonalBests()`'s `bestLegAvg`/`fewestDartsCheckout`/
  `recentFormAvg`/`lifetimeAvg` (X01's own Personal Bests — `t.checkout=1` is
  only ever set by X01 and Checkout Trainer, so this was the most severe leak:
  a 1-dart optimal Checkout Trainer answer could otherwise both win "Fewest
  Darts to Finish" and drag every average toward zero, since Checkout Trainer
  turns always write `scored=0`), `getCheckoutRoutes()`'s "most common checkout
  routes" list, `getLoadoutStats()`'s per-loadout `dartsThrown`/`checkouts`, and
  the practice-side half of the roster's `avgDartsPerLeg`. The Player Profile's
  dartboard-heatmap section is hidden entirely on the Checkout Trainer tab
  (`frontend/index.html`'s `loadDartHeatmap()`) rather than showing a heatmap of
  typed-in answers.

**Stats** (`getCheckoutTrainerStatBubbles`/`getCheckoutTrainerPersonalBests`,
`backend/db.js`):
- **Accuracy %** = legal finishes ÷ total attempts.
- **Optimal %** = attempts matching the minimum dart count ÷ total attempts
  (the headline stat — hitting the objective optimum is the actual point of
  the game).
- **Toughest Checkout Solved** = `MAX(target_score)` where `leg_won=1 AND
  declared_unsolvable=0 AND json_extract(games.config,'$.pinnedTarget') IS
  NULL` — a correctly-called trick question grades `leg_won=1` but its bogey
  target was never a checkout anyone *solved*, so without the
  `declared_unsolvable` exclusion one correct "169 is a bogey" call would
  permanently pin this Personal Best at 169. The `pinnedTarget` exclusion
  (§19a) is the same idea for a different reason: grinding one known-good
  number repeatedly via a "Drill this checkout" pin shouldn't set a "toughest
  ever" record the random target pool never actually produced. Scoped by the
  game row's `config`, no schema change — every turn in a pinned game shares
  the same `pinnedTarget`.
- **Best Optimal Streak** = longest-ever run of consecutive optimal answers,
  computed by walking every attempt in order and resetting on any non-optimal
  result (not a maintained counter). Freeform and Blitz rounds both count
  toward every one of these — a round is a round regardless of which sub-mode
  served it.

**Checkout Blitz scoring**: per-round point value read straight off the
three-way outcome above — optimal = **2 points**, legal-but-not-optimal =
**1 point**, illegal = **0 points**. A run's final score is `SUM` of that
value across every `turns` row in the game, computed at read time — nothing
pre-aggregated. `getCheckoutBlitzLeaderboard()` (`backend/db.js`): one row per
player, their single best-ever run score (`{name, bestScore, achievedAt}`,
sorted desc) — a peak single-run value, so no minimum-attempts floor the
rate-based leaderboards (Doubles Practice accuracy, Cricket MPR) use.
`getCheckoutBlitzPersonalStats(playerName)`: that player's own peak score plus
a lifetime average across every run. The Blitz countdown is a wall-clock
deadline (`Date.now() + durationSec*1000`), checked on each render tick rather
than a naively decrementing counter, so a backgrounded/throttled tab can't
grant extra time. **The deadline is a hard stop** (fixed 2026-07 — a previous
version let a round already mid-entry finish and grade normally past the
buzzer; a paused player could resume and submit a checkout arbitrarily long
after time was actually up, still counted and still eligible for Photo
Finish below). Three equally-authoritative checks enforce this, whichever
notices first ending the run (`endBlitzRun()`, idempotent via
`game.blitzEnded`): `throwDartCheckoutTrainer()` refuses any dart once
`Date.now() >= deadline`, `submitCheckoutAttempt()` discards (ungraded,
unrecorded) an already-tapped-out attempt submitted past the deadline, and
`tickCheckoutBlitzTimer()` ends an idle run within one 250ms tick of the
buzzer even with no further input at all.

**Achievements** (`frontend/index.html`) — data-driven off
`CHECKOUT_TRAINER_MILESTONE_LADDERS` (4 ladders, 22 tiers, both sub-modes
combined except Session Endurance which is Freeform-only by construction) and
`CHECKOUT_BLITZ_MILESTONE_LADDERS` (1 ladder, 6 tiers), reusing the exact
`CHUCKIN_MILESTONE_LADDERS`/`checkChuckinMilestoneTier()` engine wholesale
(the helper is fully generic despite its name). All once-earned, permanent,
non-revocable milestones (`INSERT OR IGNORE`), same as Chuckin's own ladders:

| Ladder | Metric | Tiers |
|---|---|---|
| Lifetime Attempts | total rounds answered, legal or not | 50 / 200 / 500 / 1,500 / 5,000 / 15,000 / 50,000 |
| Lifetime Optimal Answers | rounds matching the minimum dart count | 25 / 100 / 300 / 1,000 / 3,000 / 10,000 |
| Session Endurance (Freeform only) | attempts in one sitting | 50 / 150 / 400 / 1,000 |
| Best Optimal Streak | longest-ever consecutive-optimal run | 5 / 15 / 30 / 75 / 150 |
| Best Blitz Score | single best-ever 60-second score | 10 / 20 / 35 / 50 / 75 / 100 |

Plus six one-off flagship badges: 🐟 **The 170 Club** (solve 170 optimally),
🎯 **One-Darter** (first 1-dart optimal solve), 🌟 **Perfectionist** (end a
15+-attempt Freeform session with a 100% optimal rate — checked in
`askEndGame()`), 💎 **Perfect Minute** (every round in a 5+-round Blitz run
graded optimal — checked in `endBlitzRun()`), 📸 **Photo Finish** (a legal
Blitz round submitted with under 1 second left on the clock — a correct
trick-question declaration under the buzzer qualifies too, same "legal
answer" bar), and 💣 **Bogey Buster** (with trick questions on, correctly
call "no possible checkout" on an actual bogey number for the first time —
awarded in `declareUnsolvable()`).

**No live scoreboard**: this game type never writes to `liveState` and
`/display` never renders it — `pushLive()` is a deliberate no-op for
`game.gameType === 'checkout_trainer'` (The Gauntlet later joined the same
skip list — see its own "No live-scoreboard sync" section).

Nothing from the original design remains deferred: difficulty tiers shipped
first (the `config.difficulty` toggle above), and the trick-question/
bogey-number variant with its 💣 Bogey Buster badge shipped 2026-07 as the
mode's final open roadmap item.

### 19a. "Drill this checkout" deep link

Full design: `docs/archive/checkout-drill-link-roadmap.md`. One tap from a checkout
worth practicing straight into a Checkout Trainer session drilling exactly
that number, instead of hoping the random target picker eventually serves it.

**Entry points** — a small `🎯 Drill` button (`drillButtonHtml(jName, score)`,
`frontend/index.html`):
- every **Top Finishes** row, both the Player Profile's own list
  (`loadTopFinishes()`) and the Home page's cross-player "Top Checkouts"
  leaderboard (`hofSection()`);
- a **Coaching Insights** card, but only the `checkout_route` insight type
  (`getCoachingInsights()`, `backend/db.js`) — the only one carrying a
  concrete drillable number (`insight.score`, the player's most-established
  checkout score). `weak_number`/`bust_parity`/`form_trend` describe a
  pattern rather than a single target and carry no `score` field, so
  `renderCoachingInsights()` only renders the button where one exists.

Every Drill button's `onclick` calls `event.stopPropagation()` first so it
never also triggers the row's own `toggleFinishRoute()` expansion.

**Schema**: `games.config.pinnedTarget` (nullable integer, `checkout_trainer`
only) — when set, every round of that session serves that same target instead
of calling the random picker (see `pickCheckoutTarget()` above). No new
column: it rides `games.config` exactly like `mode`/`difficulty`/
`trickQuestions`. `createGame()` (`backend/db.js`) validates it server-side
for any `checkout_trainer` game — must be an integer in `[2,170]` — the same
write-boundary treatment every other config field gets; a game of any other
`gameType` ignores the field entirely if present.

**Deep-link mechanics** (`frontend/index.html`), the same preselect-then-
confirm pattern `raceLeg()` (§ Ghost Opponent) already established for
jumping into Ghost mode from a Personal Best:
- `drillCheckout(playerName, targetScore)` sets `setup.slots = [playerName]`,
  stashes `targetScore` into the one-shot module-level `_checkoutDrillPin`,
  sets `_enteringSetupFromDrill = true`, calls `setMode('checkout_trainer')`,
  then `show('setup')`.
- `setMode()`'s `checkout_trainer` branch consumes `_checkoutDrillPin` into
  `setup.checkoutTrainerPin` (resetting the one-shot variable to `null`)
  every time it runs — so any OTHER way of reaching this mode (the Step 2
  dropdown, the post-Blitz "Play again" button) naturally lands with no pin,
  even if a stale one is sitting in `setup.checkoutTrainerPin` from an
  earlier drill this session. A pin forces `setCheckoutTrainerMode('freeform')`
  and `setCheckoutTrainerTricks(false)` — **Freeform only**: a Blitz run of
  one repeated answer isn't a speed test, and trick questions are meaningless
  against a target guaranteed solvable. `startGame()`'s `config` builder
  guards the same two fields again independently at the actual write path, in
  case a stale toggle state ever disagreed with `setup.checkoutTrainerPin`.
- `show('setup')` consumes `_enteringSetupFromDrill` synchronously (mirroring
  `_enteringSetupFromRaceLeg`) to jump straight to Step 3 — the player and
  mode are already fixed, so Steps 1-2 have nothing left to ask. Unlike the
  Ghost deep link (which focuses Step 3's default first control), focus lands
  on the Start button instead, since the pin chip/toggles aren't the natural
  first stop here — the player already chose exactly what to drill.

**Setup screen**: `#checkout-trainer-pin-chip` (hidden unless
`setup.checkoutTrainerPin` is set) shows "🎯 Drilling: *N*" plus a `✕` button
(`clearCheckoutTrainerPin()`) — the pin is inspectable and cancelable, never
invisible state. `renderCheckoutTrainerPinChip()` also disables the Checkout
Blitz and trick-questions-on buttons while a pin is active (Freeform and
trick-questions-off stay enabled, since they're exactly the state a pin
already forces). Applying a pin announces "Checkout Trainer set to drill *N*."
via the shared `announce()` `aria-live` region; clearing one announces "Drill
target cleared."

**Stats/badges**: pinned rounds are ordinary Checkout Trainer rounds in every
other respect — they count toward Accuracy/Optimal %, every milestone ladder,
and Checkout Blitz scoring unchanged (moot in practice since a pin forces
Freeform). The one deliberate exception is **Toughest Checkout Solved**,
which excludes pinned rounds entirely (see above) — repetition is the whole
point of the drill, so it must never manufacture a "toughest ever" record.

---

## 20. New Game Screen (3-Step Wizard)

Full design: `docs/archive/new-game-flow-roadmap.md`. Replaced the old single
all-controls-visible `#screen-setup` card with a 3-step flow — Who's playing? →
Choose a game → More options — so a player only ever sees the controls relevant
to what they've already chosen. Purely a restructuring of *when/how* the
existing controls are shown; no change to `startGame()`'s validation or the
`game` object it builds for any mode except the new League Game entry (§18).

### Step 1 — "Who's playing?"

`renderPlayers()` (name unchanged from the old always-visible-rows layout, body
rewritten) draws a select → "Add someone else?" loop into `#players-list`: each
already-filled `setup.slots` entry renders as a name row (stat line, loadout
pill, remove button); the one slot still awaiting a pick (if any) renders as a
plain `<select>`. Once every slot is filled, a prompt appears — **Add
existing** (`addExistingPlayer()`), **New player** (`addNewPlayer()`), or **No,
continue** (`setupGoToStep2()`) — repeating until "No, continue" or the
existing 6-player cap. A "🔀 Shuffle order" button appears once 2+ players are
selected (`shufflePlayers()`, unchanged). Solo-only modes (Daily
Challenge/Ghost/Doubles Practice/Just Chuckin' It/Checkout Trainer/both guided
drills) are never truncated to 1 player *here* — Step 2's own dropdown
filtering (below) makes them structurally unreachable once 2+ players are
picked, so there's nothing to enforce yet at this step.

### Step 2 — "Choose a game"

One flat `<select id="setup-mode-select">`, replacing the old Mode row +
Practice-type sub-toggle + X01/Cricket/Baseball toggle. `NEW_GAME_MODE_OPTIONS`
(`frontend/index.html`) is a flat list of `{ key, label, contexts, blurb,
apply() }` — `contexts` is `['practice']`, `['practice','h2h']`, or (League
Game only, injected dynamically rather than listed statically) `['h2h']`.
`setupVisibleOptions()` filters by `setupPlayerCount()` (1 player → `practice`
context, 2+ → `h2h` context) — with 2+ players only X01/Cricket/Baseball (plus
League Game, if eligible) are ever offered, which is what makes picking either
one *be* the H2H choice; no separate H2H toggle exists anymore.
`renderSetupStep2Content()` rebuilds the dropdown on every entry into Step 2
and reconciles a since-invalidated prior selection (e.g. the player went Back
to Step 1 and added a second player after picking a practice-only mode) by
falling back to X01 rather than leaving a stale, no-longer-offered option
selected. `onSetupModeSelect()` calls the chosen entry's `apply()`, which is
just `setMode()`/`setGameType()` called exactly as the old controls did —
nothing about validation or the eventual `game` object changed, only what
triggers the call.

- **X01 flavor**: selecting X01 reveals `#setup-flavor-section` as a starting-
  score `<select>` (501/301/170/101, `onSetupFlavorSelect()` sets
  `setup.start`) — the same secondary-dropdown slot League Game's "which
  league match?" question reuses (never shown simultaneously, since only one
  primary entry is selected at a time).
- **How-to-play blurb**: `#setup-blurb-body` shows each entry's static `blurb`
  text, generalizing the old scattered per-mode `-info-section` blocks (now
  removed) to every mode uniformly.
- **Daily Challenge**: not a static blurb — `renderSetupChallengeBlurb()`
  fetches `GET /api/challenges/status` the moment it's *selected* (moved from
  Play Now time, where the same call previously only ran as a
  race-condition backstop) for `setup.slots[0]` (guaranteed non-empty, since
  Step 1 requires ≥1 player first). Already attempted today (`status.today`
  truthy) → a blocking message replaces the blurb and `#setup-step2-continue`
  is disabled for this selection; the player can still pick something else and
  proceed normally. Not yet attempted → the same streak/history status
  Home page's challenge teaser shows, Continue enabled.
- **League Game**: see §18's "League fixtures / pending matches" section for
  the full mechanism (`setupGoToStep2()`'s pending-fixture fetch,
  `applyLeagueGameSelection()`, the "which league match?" secondary dropdown).

### Step 3 — "More options"

Every mode-specific options block (Cricket targets **and** its Standard/
Cut-throat variant toggle — `docs/archive/cutthroat-cricket-roadmap.md`,
`setCricketVariant()` — both feed `startGame()`'s `config` the same way the
targets themselves already did — Ghost's leg picker, Doubles Practice's
target grid, Checkout Trainer's Freeform/Blitz toggle + difficulty tiers, the
H2H legs/sets Format controls) is unchanged in behavior, just relocated under
this step — each block's own `hidden` toggling by `setMode()`/`setGameType()`
still works exactly as before, independent of which step wrapper it happens
to sit inside. `#start-btn` (labeled "Play Now"
for H2H/Practice/X01/Cricket/Baseball, a per-mode verb otherwise — "Start
Challenge", "Start race", etc., unchanged) calls the existing `startGame()`
unmodified.

**Step 3 is skipped entirely for modes with nothing to configure there**
(BUG-25, `docs/bug-roadmap.md`): `setupStep3HasContent()` checks whether any
of the five conditional sections above (`cricket-options-section`,
`ghost-options-section`, `doubles-options-section`,
`checkout-trainer-options-section`, `h2h-options`) is currently un-hidden;
`setupGoToStep3()` — Step 2's "Continue" button handler — calls `startGame()`
directly instead of `showSetupStep(3)` when none of them are. This affects
X01 practice, Baseball practice, Chuckin, Around the Clock, Around the World,
and Daily Challenge, none of which have any Step 3 content; Cricket (any
context), Ghost, Doubles Practice, Checkout Trainer, and every H2H mode
(including League Game, which forces H2H) are unaffected and still stop on
Step 3 as described above.

### Wizard navigation and step-entry reconciliation

`showSetupStep(n)` (`setupStep` 1/2/3) toggles the three step wrappers,
updates the step-label text, and calls the global `announce()` (`#sr-announcer`,
`aria-live="polite"`) so screen-reader users hear the step change; it also
moves focus to each new step's first control (the first player `<select>`/
button in Step 1, the mode `<select>` in Step 2, the Back button in Step 3) so
focus is never silently left on a now-hidden control. Back buttons
(`setupBackTo(n)`) restore, not reset, whatever was already selected on the
step being returned to — nothing in `setup` is cleared by navigating backward,
only by a genuinely fresh entry into the screen.

`show('setup')` resets `setup.slots`/`loadoutByName`/`leagueFixtureId`/
`pendingFixtures` and starts at Step 1 on every normal entry (nav click, a
post-game "Try Again"/"New Game" button, etc.) — **except** when
`_enteringSetupFromRaceLeg` is set, which `raceLeg()` (Player Profile's "Race
this leg" entry point) sets synchronously right before calling `show('setup')`,
alongside presetting `setup.slots` to the one player being raced and calling
`setMode('ghost')`. That flag is consumed (read + reset to `false`)
synchronously inside `show('setup')` itself — deliberately **not** the same as
`_ghostLegTarget` (which preselects a specific leg once `renderGhostLegPicker()`'s
own fetch resolves, and is only cleared when a match is actually found in that
player's leg history) — a raceLeg() entry must jump straight to Step 3 and
must never get stuck doing so on every later "New game" nav click even when
that player turns out to have zero ghost-race-able legs.

### Retired

`updateH2HBanner()`/`#h2h-banner`/`GET /api/players/h2h` and
`updateLeaguePicker()`/`#league-picker-wrap`/`setup.leagueId` — see §18's
"New Game 'log to league?' picker — retired" note.

---

## 21. Known Limitations & Open Gaps

Cross-referenced from the `docs/*.md` roadmap docs — these are real,
already-shipped limitations, not just unbuilt future features:

- **Account-lockout griefing is an accepted tradeoff**, not fixed — an attacker
  who knows a username/player can deliberately lock that one account —
  `docs/security-audit-roadmap.md` SEC-8.
- **No `COOKIE_SECURE=false`-over-HTTPS warning**, and **CSP uses
  `'unsafe-inline'`** rather than a strict nonce-based policy — SEC-6/SEC-10 in
  the same doc.
- **`display.html` has no screen-reader announcements** — an open question in
  `docs/accessibility-roadmap.md` about whether the shared/ambient display
  warrants the same investment as the controller.
- **No WCAG contrast audit has been performed.**
- **Online multiplayer's data model isn't fully specified** — needs its own
  `online_matches` table with a `game_id` FK (per the binding convention below),
  not a value stuffed into `games.category` — `docs/online-multiplayer-roadmap.md`.
- **Practice / solo / Daily Challenge games intentionally don't count as "Games
  Played"** (decided 2026-07; the §3 `games` row now filters them explicitly). They
  also never receive `completed_at` (only an H2H match win calls `completeGame`), so
  they don't appear in "Last game played" either — turns are still persisted
  per-visit, so all throwing stats are unaffected.
- **Navigating away mid-game (tapping the "OCHE" logo) exits the scoring screen with
  no confirmation and no resume path** — the in-progress game becomes unreachable
  (though its turns are already persisted per-visit). Renaming a player mid-game also
  doesn't update `game.players[].name`, so a resume path, if added, would need to
  reconcile that. Unspecified state-machine behavior, not a data-loss bug.
- **`getH2HSummary().previousWinner` can mislabel in a 3+-player free-for-all** — the
  double `game_players` join counts any game where both named players took part (not
  exactly-two-player games, per §3's note), so if a *third* player won the most-recent
  such game, `previousWinner` still reports one of the two named players. Only reaches
  the Rematch/Grudge badges, which the controller evaluates for 2-player matches only,
  so it's latent in practice.
- **Tournament mode is feature-complete** — single- and double-elimination,
  generation/advancement/reset logic, the setup screen, the tabbed double-elim
  bracket view, badges, and Player Profile stats all ship (§15). (Optional future
  refinements only: anti-rematch losers-bracket seeding, arbitrary double-elim
  counts, a bracket-tree drag/zoom.)
- See the individual `docs/*.md` files for full design detail on every other
  not-yet-built feature (league mode, Baseball/other game-mode variants,
  camera scoring, mobile app, online multiplayer, and more).

---

## 22. Troubleshooting

The general method, before the specific symptoms below: **this document is the
spec.** Find the section describing what the misbehaving feature is supposed to
do, then diff the actual code against it. If the code doesn't match the
documented behavior, you've found the bug — fix the code. If the code matches
the spec but the behavior still seems wrong, the spec itself may encode a bad
decision — that's a design discussion, not a silent code change; whatever the
outcome, update this document in the same change.

**"This stat looks wrong."** First check §3's denominator-conventions table —
identify which family the stat should be in, then check whether the actual SQL
matches that family. Second-most-common cause: a category-scoping filter
(`OPENING_CATS`, H2H-vs-practice `_mf()`) that's missing or wrong. Third: check
`getMetricHistory()` against `getPlayerStatBubbles()` for the same metric —
they should be byte-for-byte identical; if they've drifted, that's the bug.

**"A badge fired that shouldn't have, or didn't fire when it should have."**
Check §4's exact condition against the actual `enterTurn()`/`onLegWon()` code —
conditions are precise (e.g. Double Trouble needs the *last two* darts to be
doubles, not any two). Check the suppression-pairs table if two related badges
seem to be competing. Check `evaluateVisit()`'s three bust rules (§2) if a
scoring-adjacent badge (Busted Maximum, No Cigar, Ton-titled to Nothing) seems to be
firing on the wrong side of a bust/win boundary.

**"Only one badge showed when a turn should have earned several."** Check that
the call site is going through `queueBadge()` (§5), not calling
`showAchievement()` directly — anything bypassing the queue will still clobber.

**"The live scoreboard isn't updating."** Check the SSE connection caps in §7
(`MAX_SSE_TOTAL`/`MAX_SSE_PER_IP`) — a stuck-open dead connection could be
holding a slot. Check `ALLOWED_LIVE_KEYS` if a new field was added to
`liveSnapshot()` but isn't showing up on `/display` — it needs to be added to
that allow-list too, or the server silently drops it.

**"A Home Assistant webhook isn't firing."** Check `netguard.js`'s rules (§9)
first — a webhook silently returns `{skipped:true}` if `ha_url` or the specific
event's webhook ID is blank, and throws a caller-visible error (not silent) if
the resolved host is blocked (loopback/link-local always; private-range only if
`HA_BLOCK_PRIVATE=true`).

**"Someone got locked out and I don't know why."** Check §9's lockout
mechanics — default thresholds are 5 (admin) / 10 (PIN) failed attempts, 5-minute
lockout, configurable in Settings. The `RETURNING`-based increment means the
count is always accurate even under concurrent attempts.

---

## 23. Saved Games / Pause & Resume

`docs/archive/saved-games-roadmap.md`. Pause an in-progress game and come back to it
later — the New Game screen offers **Resume** or **Abandon** for a matching
in-progress match instead of forcing it to be finished or thrown away.
Backend: `backend/db.js`'s "Saved games" section. Frontend:
`frontend/index.html`'s `saveCurrentGame()`/`resumeGame()`/Saved Games list
block. Pure replay-rebuild math: `frontend/scoring.js`'s
`rebuildX01State()`/`rebuildCricketState()`/`rebuildBaseballState()`/
`rebuildAroundTheClockState()`/`rebuildAroundTheWorldState()`/`rebuildBobs27State()`.

### Scope — what's savable

**Any H2H game** (any participant count the mode allows) or **solo practice
game**, X01/Cricket/Baseball/guided Around the Clock/guided Around the World/
Bob's 27 (`SAVABLE_GAME_TYPES`, defined identically in both `backend/db.js` and
`frontend/index.html` — the server never trusts the client's own copy). Bob's
27 is savable for the same reason the guided drills are and Doubles Practice/
Chuckin/Checkout Trainer aren't: it has a genuine mid-run "position" worth
resuming — the current round and running score — rather than being open-ended
with nothing lost by starting fresh.
**Tournament matches and league fixture games are savable** — normal games
under the hood, so nothing extra is needed beyond restoring their
`tournamentMatchId`/`leagueFixtureId` linkage on resume (see below).
**Not savable**: Daily Challenge (one attempt per calendar day is the whole
format), Ghost mode (the opponent is a replay with in-memory script position),
Doubles Practice/Just Chuckin' It/Checkout Trainer (open-ended solo drills
with no meaningful "position" — ending and starting fresh loses nothing).

### Schema — a context table, never a boolean on `games`

Per `CLAUDE.md`'s standing convention (`tournament_matches.game_id` /
`league_fixtures.game_id` precedent), except `game_id` here is `UNIQUE` and
`ON DELETE CASCADE` rather than nullable/`SET NULL` — a saved game always
points at exactly one real `games` row, and deleting that row (a total wipe,
a stats reset) should take the pause state with it:

```sql
CREATE TABLE saved_games (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id   INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  saved_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

That's the whole table — "this game is paused" is the only new fact.
Everything needed to resume is **derived from the turns/darts already
recorded live** (see "Resuming" below) — no snapshot blob, no schema-versioned
client state to drift. Wired into `getFullDatabaseExport()` (ordinary "your
data," no secrets); needs **no extra code** in `wipeAllData()`/`resetStats()`
— `game_id ON DELETE CASCADE` means wiping the games it touches already
cascades away any pause state for free, same as `tournament_matches`.
Deliberately **NOT** in the per-player portable export (`getPlayerExport()`)
— a pause is local workflow state, not portable history; an imported
incomplete game simply arrives unsaved, its stats intact.

### One saved game per matchup

At most one saved game per **(exact participant set, game type)**
(`findSavedGameForParticipants()`, order-independent — compares sorted,
case-insensitive name lists). `saveGame(gameId)` rejects (409) a second save
into an occupied slot rather than replacing or stacking; saving an
already-saved game id is an idempotent no-op (`{ok:true, alreadySaved:true}`,
double-tap protection).

### Saving

**"⏸ Save for later"** — icon + text, in both the persistent game-screen
header and the bottom button row (outside `.oche`'s per-turn re-rendered
content, so it survives the "leg won — Next leg?" transition screen too,
which only replaces `.oche`'s own innerHTML). Visibility is driven by
`updateSaveButtonVisibility()`, called from `renderGameShell()` (every new
game/leg) and from `finishUnit()`'s game-complete branch (`game.done`).
`saveCurrentGame()` warns if darts are staged in the current, uncommitted
visit ("The N darts of the current turn haven't been entered and won't be
kept" — **staged darts are always discarded**, never stored; only committed
turns exist server-side), then `POST /api/games/:id/save` → `saveGame()`
(`backend/db.js`) re-validates eligibility server-side (game exists,
`completed_at IS NULL`, `game_type` is in `SAVABLE_GAME_TYPES`) before
inserting the row — never trusting the client's own check. On success, the
client clears `game`, pushes an inactive `pushLive()` snapshot (so `/display`
stops showing the paused match as live — same pattern `askEndGame()` uses),
and returns to the New Game screen.

### Where saved games surface

1. **The resume prompt** — `startGame()` checks, at Start time (after the
   final participant set/game type are known, not buried in step 1) via
   `findMatchingSavedGame()` against the same `GET /api/saved-games` list the
   list below renders from (no bespoke lookup). A match interrupts with a
   real 3-action modal (`showResumeOrAbandonPrompt()`): **Resume**,
   **Abandon & start fresh**, or **Cancel**. Skipped for Ghost/Daily
   Challenge (`setup.mode`), even though their `gameType` is `'x01'` — neither
   mode is itself savable.
2. **The Saved Games list** (`refreshSavedGamesList()`) — a New Game step-1
   section, above the player slots, shown only when at least one exists.
   Each row: players, category, a one-line position summary
   (`savedGamePositionLabel()`), saved date, and **Resume**/**Abandon**
   buttons — real buttons/headings, not click-anywhere divs.

Both surfaces read `getSavedGames()` (`backend/db.js`): one row per saved
game with a **position summary computed via the exact same pure rebuild
functions the real resume uses** (`_savedGamePosition()`) — never a second,
parallel "roughly where things stand" implementation that could drift from
what resuming actually produces.

### Resuming — replay, not snapshot

`GET /api/games/:id/resume-state` (`getResumeState()`) returns the game's
full metadata plus every committed turn **in original chronological order**
(`{playerIndex, setNo, legNo, darts:[{sector,mult}]}` — `playerIndex` is
recovered from `game_players`' insertion-order rowid, the same order
`createGame()` inserted participants in). Each player entry also carries
`startScore` (`game_players.start_score`, `null` when unhandicapped):
`rebuildX01State()` takes the per-player `startScores` alongside the
game-wide score, and `resumeGame()` constructs each X01 player from their
own value — a handicapped player replayed from the game-wide score would
come back with an inflated remaining and their legitimate checkouts/busts
replayed as neither (the same per-player application live play's
`setup.handicaps` does at `startGame()` and every leg reset). The client rebuilds the live `game`
object by feeding every turn back through the **pure**
`rebuildX01State()`/`rebuildCricketState()`/`rebuildBaseballState()`/
`rebuildAroundTheClockState()`/`rebuildAroundTheWorldState()` functions
(`frontend/scoring.js`) — the same `evaluateVisit()`/`evaluateVisitCricket()`/
`evaluateVisitBaseball()`/`evaluateDartAroundTheClock()` engines that scored
each turn live, called from a dedicated, side-effect-free orchestrator
instead of the live `enterTurn()`/`onLegWon()`/`startNextLeg()` UI functions
(which carry real side effects — DB writes, badge awards, HA webhooks,
rendering — that must never re-fire for turns the server already recorded
once). `resumeGame()` (`frontend/index.html`) then builds full player objects
via each type's own `GAME_TYPES.*.newMatchPlayer()` (for normal defaults and
async lifetime-ladder-base fetches, exactly as any new game gets) and
overlays the rebuilt core fields on top — remaining scores/marks+points/
innings+runs, legs/sets won, current set/leg, whose turn (deterministic from
the turn sequence plus the same leg-starter rotation `startNextLeg()` applies
live — a **trailing leg win with no next-leg turn recorded yet** — saved on
the "leg won — Next leg?" screen before that button was ever tapped — is
handled explicitly: the rebuild functions apply one more rotation/reset pass
so the resumed game lands on the new leg's first throw, never the stale
summary screen). `DB.gameId` is pointed back at the existing game id, so
subsequent turns append to the same game; the live scoreboard picks the match
back up on the next `pushLive()`.

**What resume deliberately does NOT rebuild** (cosmetic, session-scoped,
already lost today by a page refresh mid-game): past-leg summary cards
(`game.legSummary`), the one-level undo snapshot (`lastTurnSnapshot: null` —
undo is unavailable for the first turn after resume, same as the first turn
of any game), voice-announcement/celebration state, and every per-leg
badge-trigger tracker (Metronome streaks, Comeback Kid deficits, Around the
Clock's lifetime `singlesHit`, etc.) — a resumed leg's in-leg-so-far badge
opportunities are cosmetically lost, the same tradeoff Chuckin/Checkout
Trainer's own milestone ladders already accept elsewhere.

**Tournament/league-fixture linkage restore**: `getResumeState()` looks up
`tournament_matches`/`league_fixtures` by `game_id` and returns
`tournamentMatchId`/`leagueFixtureId` alongside the replay payload;
`resumeGame()` threads them straight back onto `game.tournamentMatchId`/
`game.leagueFixtureId` exactly as `_reallyBeginTournamentMatch()`/
`startGame()` set them the first time, so completion advances the
bracket/fulfills the fixture exactly as if never paused.

**Divergence guard** (two devices racing the same resume): `getResumeState()`
re-verifies the game is still incomplete AND still has a `saved_games` row
immediately before deleting it — a 409 ("not currently saved — it may
already have been resumed or abandoned elsewhere") beats silently
double-driving one game from two controllers. The delete happens **as part
of the same read** (a deliberate GET-with-a-side-effect, not a separate
mutation call) — "the game is simply live again," and a separate mutation
call would let a network hiccup between the two leave a phantom
`saved_games` row.

### Abandoning

`DELETE /api/saved-games/:id` (`:id` is the **game id**, matching every other
saved-games route's numbering — not the `saved_games` row's own id) deletes
only the `saved_games` row; the game stays a permanently incomplete `games`
row, and **stats recorded during it are kept** (matches `askEndGame()`'s
existing behavior for quitting a live game). A **tournament-linked** saved
game can't just be orphaned this way — `askAbandonSavedGame()` detects
`tournamentMatchId` (surfaced by `getSavedGames()`) and instead deletes the
`saved_games` row THEN routes to the bracket (`show('tournament')`) with the
same message `askEndGame()` already gives for quitting a *live* tournament
match, so the admin can record a walkover there. The saved-games row is
deleted proactively in this path (not left for `recordWalkover()` to clean
up) because `_advanceTournamentMatch()` never touches `games.completed_at` —
a walked-over match's underlying game stays incomplete forever, so leaving
`saved_games` in place would strand it in the list indefinitely, pointing at
a match the bracket has already moved on from.

### Interactions with existing features

- **Player deletion**: `registerDeletePlayerGuard()` blocks deleting a player
  who's in a currently-saved game ("abandon it (or resume and finish it)
  before deleting") — cheaper and louder than an auto-abandon side effect
  buried inside a delete.
- **Player merge**: a saved game between source and target is already a
  shared game (blocks the merge via the existing `sharedGames` check). A
  saved game against a THIRD player can still collide after reassignment —
  `_savedGameCollisions()` detects when the merge would leave the target
  with two saved games in one (participants, game type) slot (something
  normal play can never produce) and blocks it, consistent with every other
  shared-row case in `_mergeBlockers()`. No explicit reassignment SQL is
  needed in `mergePlayers()`'s own write transaction — `saved_games` has no
  `player_id` column, so it "follows" `game_players.player_id`'s
  reassignment automatically.
- **Backups/restore**: nothing special — `saved_games` rides along in the
  SQLite file like every other table.

### API

```
GET  /api/saved-games            -> saved-game list + one-line position summaries (public)
POST /api/games/:id/save         -> pause an in-progress game for later
GET  /api/games/:id/resume-state -> the full replay payload -- ALSO deletes the
                                     saved_games row (divergence guard, see above)
DEL  /api/saved-games/:id        -> abandon a saved game (:id is the game id) -- stats kept
```

Save/resume/abandon are all `requireWrite` (same tier as recording a turn —
pausing is gameplay, not admin surgery); the resume-state endpoint exposes
only data already readable via existing stats endpoints, and mutates
(deletes the `saved_games` row) as an explicit, documented exception to
GET-is-safe (see "Divergence guard" above).

### Testing

Committed tests: `backend/test/scoring.test.js` (`rebuildX01State`/
`rebuildCricketState`/`rebuildBaseballState`/`rebuildAroundTheClockState`/
`rebuildAroundTheWorldState` — mid-game state across a leg boundary, a
trailing leg win with no next-leg turn recorded, a practice game's
`!practice` set-completion gate, a full 9-inning Baseball leg, and Around the
Clock/World's own simpler shapes) and `backend/test/db.saved-games.test.js`
(save/list/resume-state/abandon lifecycle, the one-per-matchup constraint,
server-side eligibility checks, the two-device divergence guard, tournament-
match linkage restore through a full resume-then-complete-then-bracket-
advances cycle, the player-deletion guard, and the merge-collision block).

---

## 24. Household Elo Rating

`docs/archive/rating-and-handicap-roadmap.md` Part A. A single evolving number per
player answering "who's actually on top right now?" — more responsive than
raw win totals (beating the house champion moves you more than beating the
newest player), self-correcting as form changes.

### Live-computed, never stored

`getEloRatings()` (`backend/db.js`) walks every completed, non-practice,
2-player game — across every competitive game type combined into **one
household rating** (deliberately "who beats whom," not a per-game-type
number; Tournament and league-fixture games count, since they're real
competitive results; Ghost/Daily Challenge/solo drills never enter, since
there's no second real player) — in `(created_at, id)` order, folding the
textbook update: start 1000, `K=32`, `expected = 1/(1+10^((opponent-mine)/
400))`, the winner gains `round(K*(1-expected))` and the loser loses the
*exact same amount* (a simple zero-sum split, not each side independently
rounding its own formula, which could drift apart by a point). This means
ratings retroactively heal after `deleteLastTurn`, player merges, game
deletions, or imports, with zero migration/backfill machinery — the
standing "nothing pre-aggregated" schema philosophy applied to Elo. A few
thousand games is a trivial walk at household scale; revisit only if a
server ever accumulates enough games for this to matter.

**Handicapped games are excluded** (§25 below): the walk's `WHERE` clause
skips any game where either `game_players` row has a non-`NULL`
`start_score` — a compensated result says nothing about raw strength.

### Surfaces

- **Home page** "📈 Household Ratings" leaderboard (`getEloLeaderboard()`,
  `GET /api/stats/elo-leaderboard`) — rating + W/L, sorted descending, a
  **minimum 5 rated games** before a player appears (`ELO_MIN_GAMES`), so a
  1-game player isn't ranked off a single result. Lives in
  `renderHomePulse()` (piggybacked onto `getHomeExtra()`'s existing payload,
  the same way the Active Leagues teaser is), not inside
  `renderHomeTabBody()`'s per-game-type dispatch — the rating deliberately
  spans every competitive game type, so pinning it to whichever per-type tab
  happens to be selected (the way "Most Wins" today only visibly shows on
  the X01 tab despite its own query already spanning every type) would
  misleadingly suggest it's type-scoped.
- **Player Profile** "📈 Household Rating" section (`getPlayerElo(name)`,
  `GET /api/players/elo?name=`) — rating, W-L record, and rank (`#N of M`
  qualifying players, or "Not yet ranked" below the 5-game floor — rank is
  computed against the *same* qualifying pool the Home leaderboard uses, so
  "rank #1" and "topping the Home leaderboard" are always the same claim)
  plus a rating-over-time sparkline (`drawEloSparkline()`, a bespoke minimal
  SVG rather than reusing `drawAvgChart()` — that function is tightly
  coupled to `activeStatDefs()`/`selectedStat`'s period-picker/value-
  formatter machinery, none of which applies to a single always-on number
  with no period picker). Shown once inside the `overall`/`h2h` tabs'
  shared `h2hSection`, unconditional on the per-game-type toggle (`gt`) —
  unlike Tournaments/Leagues just above it, which *are* gated on `gt`.
- **Match-win delta**: `checkEloOnMatchWin(w, opp)` (`frontend/index.html`)
  is called from the "game (match) won" branch of every H2H-capable game
  type's own `onLegWon`/`onLegWonCricket`/`onLegWonBaseball`, right after
  `DB.completeGame()` so the just-finished game is already reflected in the
  walk by the time the async fetch resolves. Guards on `opp` (null for
  solo/practice/3+-player games — Baseball's own gate isn't `!game.practice`
  the way X01/Cricket's is, per BUG-22, so `opp` is derived fresh there
  rather than assumed) and `!game.practice` (excludes a Ghost race even
  though it has a real `opp` object). Patches a `#elo-delta-banner`
  placeholder on the GAME OVER screen once the fetch resolves (`📈
  Household rating: 1016 (+16)`) — the same "celebrate the win now, patch in
  extra detail once confirmed" pattern `#challenge-pb-banner` already uses,
  since the rating can't be known synchronously at match-end time.

### Badges

| Badge | Exact condition |
|---|---|
| 👑 **Top of the House** | `qualifies && rank === 1` for the winner, checked via the same async fetch as the delta banner. **Once-badge** — manually managed (`Backend.send(..., {once:true})` + explicit `trackBadgeForUndo()`) rather than trusted to `awardRecurringBadge()`'s own internal `game.lastTurnSnapshot` read, since by the time this network round-trip resolves the live game state may have moved on — the same precaution Grudge Match's own async check already takes. Mega-tier overlay (confetti) like Nine-Darter/Perfect Leg/Champion. |
| 🗡️ **Upset** | `lastCompetitiveGame.isUpset` for the winner — the loser's *pre-game* rating was 150+ above the winner's pre-game rating (`getEloRatings()` captures both pre-game ratings before applying the update, so this checks the gap that made the win an upset in the first place, not the post-game ratings). **Recurring** — mirrors The Rematch's own async `awardRecurringBadge()` call. |

Both get their own Badge Case section ("Household Rating") on the Player
Profile — cross-game-type, so folding into X01's section (the way most
one-off badges do) would misrepresent their scope, the same reasoning
Bob's 27's own `bobs27:true` flag already established.

### API

```
GET /api/stats/elo-leaderboard     Home page leaderboard (rating+W/L, min 5 rated games, no mode param)
GET /api/players/elo?name=         Single-player view: rating, wins, losses, played,
                                    qualifies, rank, ratedPlayers, history (rating after
                                    each rated game), lastCompetitiveGame (global — the
                                    most recently completed rated game, for the delta
                                    banner/badge checks right after a match ends)
```

### Testing

`backend/test/db.elo.test.js`: hand-verified K=32 arithmetic for a single
win (1000→1016/984) and a rematch (999/1001, proving the zero-sum delta
application), plus derivation-only checks (not re-verifying the same
formula a third time) for the Upset threshold, the min-5-games floor,
practice/3+-player/handicapped-game exclusion, and `getPlayerElo()`'s
qualifies/rank fields. Verified end-to-end with Playwright: a real 2-player
X01 match played through the actual UI, confirming `/api/players/elo`
returns the exact hand-computed rating, the Home page's Household Ratings
section renders (including the below-floor empty state), and the Player
Profile's Household Rating section renders the correct rating/record/rank.

---

## 25. Handicapping

`docs/archive/rating-and-handicap-roadmap.md` Part B. Lets mismatched players have a
real game: the stronger player starts an X01 leg from a higher score (e.g.
501 vs. 401), chosen per player at setup. Nothing about the throwing
changes — just the mountain's height. **X01 only** — starting score is
X01's natural handicap lever; Cricket/Baseball have no equivalent single
knob.

### Schema

`game_players.start_score INTEGER` — nullable, a per-game snapshot
following the established `out_mode`/`dart_weight`/`loadout_id` precedent.
`NULL` (the default for every existing row and every game that doesn't use
it) means "the game's own `config.startingScore`"; a value overrides it for
that player only — the game's own `category`/`config.startingScore` stay
whatever the *other* (unhandicapped) participant is really playing, since
they aren't handicapped. Purely additive; every existing game reads
unchanged.

### Write-time validation (`createGame()`, `backend/db.js`)

Server-side, never trusting the client's own setup-screen eligibility check
(the same precedent `pinnedTarget`/Cricket's `config.variant` already
establish): a supplied `startScore` must be for an X01 game (400 otherwise),
an integer, `>= 101` (the lowest starting score this app supports at all),
and **strictly less than** the game's own category value — equal-or-above
isn't a real handicap, and would otherwise still wrongly exclude that
player from Elo/nine-darter/fewest-darts credit for a game they didn't
actually shorten. Checked for every participant before any `game_players`
row is written.

### Setup UI

An optional, collapsed-by-default "Handicap" `<details>` disclosure inside
the X01 options step (`renderHandicapOptions()`, `frontend/index.html`) —
shown only when `setup.gameType === 'x01'` and 2+ player slots are filled.
One per-player `<select>` (steps of 50 between 101 and the chosen
category's own value minus 50, plus a "No handicap" default), keyed by
`setup.handicaps = {playerName: overrideStartScore}`. Rebuilt fresh on
every call from current setup state (mirroring `renderPlayers()`'s own "just
re-render" convention) rather than patched incrementally, and re-derived
whenever the mode/game type/starting category changes
(`renderSetupFlavorAndBlurb()`) or Step 3 is entered
(`setupGoToStep3()`, in case Step 1's slots changed since).

### Engine

`newMatchPlayer(name, start)` seeds both `p.score` and a new `p.startScore`
field from `start` — `startGame()` passes `setup.handicaps[name] ||
startScore` per player instead of the one shared `startScore` every other
game type gets. `resetPlayerForNextLegX01()` resets `p.score` to
`p.startScore` (this player's own start), not `game.start` (the shared
category) — a handicap is chosen once at setup and holds for every
subsequent leg/set of the same match, not just its first leg.
`evaluateVisitX01()`/the bust/checkout logic need nothing — they never knew
where scores start.

### Live scoreboard

`playerSnapshotX01()` includes `startScore` in the live payload (rides
inside the already-unrestricted per-player `players[]` array — no
`ALLOWED_LIVE_KEYS` change needed). `display.html`'s `renderers.x01.card()`
shows a "STARTED 401" tag next to a player's name whenever their own
`startScore` differs from the game's `category` — visible only for the
handicapped player, so the handicap is legible from the second screen
without cluttering an even match.

### Interaction with other features

- **Household Elo (§24) excludes handicapped games entirely** —
  `getEloRatings()`'s own `WHERE` clause skips any game where either
  participant's `game_players.start_score` is non-`NULL`, since a
  compensated result says nothing about raw strength.
- **Win-based stats count a handicapped win as a real win, deliberately** —
  the whole point of a handicap is a fair contest, so `getSummary()`/win-rate/
  streak stats are unaffected.
- **"Fewest darts to finish"-shaped Personal Bests and nine-darter
  detection exclude a handicapped leg** — a shortened start makes finishing
  in fewer darts mechanically easier, not a skill feat. A new `NOT_HANDICAPPED`
  SQL fragment (`backend/db.js`, alongside `NOT_CHECKOUT_TRAINER`) — `NOT
  EXISTS (... game_players ... start_score IS NOT NULL)`, scoped to the
  *same* player and game the surrounding query is already reading —
  excludes it from all 6 nine-darter-detection call sites
  (`nineDarterBase`, `getSummary`, `getPlayerStatBubbles`,
  `getMetricHistory`'s `ninedarters` case, both `getNineDarterStats`
  queries) and `getPersonalBests()`'s `fewestDartsCheckout`. **Average-based
  stats (`bestLegAvg`, `recentFormAvg`, `lifetimeAvg`, 3-dart average, 1st-9
  average) are deliberately NOT excluded** — a leg average is
  starting-score-agnostic (points scored ÷ darts thrown), so a shortened
  start doesn't inflate it the way "fewest darts" does; excluding those too
  would just be throwing away real, fairly-earned data.

### Testing

`backend/test/db.handicap.test.js`: `createGame()`'s validation (rejects a
non-X01 game type, rejects out-of-range/non-integer values, accepts a valid
override), nine-darter detection excluding a handicapped player's
shortened-start finish while the *same game's* unhandicapped opponent keeps
full credit, and `fewestDartsCheckout` excluding a handicapped leg while a
genuine unhandicapped one still sets it normally. Verified end-to-end with
Playwright: a real 2-player X01 match set up through the actual New Game UI
(one player handicapped to 401, the other a real 501), confirming both
players' starting scores are exactly right, the match completes, and the
handicapped winner's Elo rating correctly shows zero rated games afterward.

## 26. 121 Checkout Ladder

`docs/archive/practice-ladders-roadmap.md` Part B. The classic solo checkout
ladder: start on **121**, double out, up to **3 visits (9 darts)** to check
it out. Check out and the target climbs one rung; use all 3 visits without
checking out and it drops one rung (floored at **61**). Play as long as you
like — the story is how high you climb. Deliberately the *physical* sibling
of Checkout Trainer (§19): that mode asks what you'd *throw*; this one makes
you actually throw it.

### Design

`checkout_ladder` game type, solo-only (`GAME_TYPES.checkout_ladder.soloOnly
= true`). Each target attempt is its own **leg** (`turns.leg_no` increments
per attempt) of ordinary X01-shaped visits — `evaluateVisit()` (the same
shared X01 evaluator, `frontend/scoring.js`) is reused **completely
unmodified**; the 3-visit cap and the ladder's up-one/down-one movement are
the only new rules layered on top. The game never completes — no
`finishUnit('game', ...)`/`DB.completeGame()` call anywhere in this chain,
matching Doubles Practice/Just Chuckin' It's "runs until End Game is
pressed" shape (`games.completed_at` stays `NULL` forever, same as those two
modes).

### Ladder movement is derived, not stored

The current target is never trusted from any stored value — it's derived
fresh, every time, by replaying every prior attempt's own recorded outcome:
start at 121; a win (`checkout=1`) climbs one rung; a loss (3 visits
recorded, no checkout) drops one rung, floored at 61. **Capped at 170**
(not just the highest badge rung but a hard ceiling): `turns.target_score`
is the same shared column Checkout Trainer uses for "a checkout target,"
whose valid range tops out at 170 (the highest possible double-out finish,
T20 T20 Bull) — repeatedly clearing 170 just keeps a run parked at the
summit rather than requesting a target outside that column's own valid
range. This "nothing pre-aggregated" replay happens in three independent
places that must all agree: the write-time guard (`backend/db.js`
`addTurn()`), the stats/personal-bests reads (`_checkoutLadderAttempts()`),
and the pure rebuild function used for saved-game resume
(`rebuildCheckoutLadderState()`, `frontend/scoring.js`).

### Write-time validation (`addTurn()`, `backend/db.js`)

A `checkout_ladder` turn is checked the same way an X01 visit is
(`scored` must equal the sum of the darts thrown, or `0` on a bust;
`checkoutPoints` must equal `scored` on a checkout), plus two new rules:
- **At most 3 visits per attempt** — a 4th turn recorded against the same
  `(game_id, leg_no)` is rejected (the attempt should already have resolved).
- **`targetScore` must match the attempt's derived ladder position** —
  computed server-side from every turn with a strictly smaller `leg_no`
  (grouped by leg, a leg with any `checkout=1` turn counts as a win,
  otherwise a loss), never trusted from the client. A first attempt must
  target 121; any other value is rejected.

### Engine (`frontend/index.html`)

`newMatchPlayerCheckoutLadder(name)` seeds `p.score = 121`, `doubleOut:
true` (always double-out regardless of that player's own X01 finish-rule
preference elsewhere). `enterTurnCheckoutLadder()` (dispatched from
`enterTurn()`) commits a visit via `evaluateVisit()` unmodified, tracks
`game.checkoutLadderVisits` (0-2 while an attempt is still live), and on a
win or a 3rd used visit hands off to `resolveCheckoutLadderAttempt()`,
which climbs/drops `game.checkoutLadderTarget` and then calls
`startNextLeg(false)` — the **same generic leg-transition function X01
itself uses** (increments `game.legNo`, resets each player via
`resetForNextLeg()`, clears `currentLegTurns`/`lastTurnSnapshot`,
re-renders) rather than a bespoke reimplementation of that bookkeeping.
`startNextLeg()` gets one small `checkout_ladder`-specific addition
(resetting `game.checkoutLadderVisits` to 0), the same pattern
`baseballInning`'s own reset there already established. Undo
(`undoLastTurnCheckoutLadder()`) only reaches back into the still-live
attempt — once an attempt resolves, `lastTurnSnapshot` is cleared by the
leg transition, so (same as every other game type) a player can't undo past
a leg boundary.

### Stats, Personal Bests, Home leaderboard

- **Stat bubbles** (`getCheckoutLadderStatBubbles`): `attempts`,
  `successRate` (wins ÷ attempts), `currentPosition` (replays only the
  *temporally latest game's* own resolved attempts — "where would my next
  attempt in that run start from," the closest a lifetime bubble can get to
  a genuinely live position for a mode with no persistent cross-session
  ladder), `dartsThrown`. An attempt only counts once it's **resolved** —
  won, or all 3 visits used (`a.won || a.visits >= 3`, the same check
  `rebuildCheckoutLadderState()` applies): the temporally-last `(game, leg)`
  group can be a still-in-progress attempt (permanently so for a paused/
  abandoned game), and treating it as a completed failure would drop
  `currentPosition` a rung and inflate `attempts`/`successRate` before the
  attempt actually ends. The position replay uses the same 61–170 bounds the
  rebuild enforces (+1 per win capped at 170, −1 per fail floored at 61).
- **Personal Bests** (`getCheckoutLadderPersonalBests`): `highestTargetReached`
  (a peak — attempted, win or fail, since standing at rung 150 already means
  you climbed that high regardless of how that attempt ends) and
  `fewestDartsOnHighestCheckout` (darts thrown on the highest attempt
  actually *won*, which can be lower than `highestTargetReached` if the
  peak attempt itself failed).
- **Home leaderboard** (`getCheckoutLadderLeaderboard`): one row per player,
  their own highest-ever target reached (`MAX(turns.target_score)`), no
  minimum-attempts floor — same "a single best run" precedent Checkout
  Blitz's own board established.
- Real throws: darts count toward heatmaps/doubles% like every other
  physical game type — no hypothetical exclusion.

### Badges

- A highest-rung ladder (`CHECKOUT_LADDER_MILESTONE_LADDERS`, the same
  data-driven `checkChuckinMilestoneTier()` engine every other milestone
  ladder in this app uses): Climbing 🧗 (125), Ascending ⛰️ (130), High
  Ground 🏕️ (140), Summit Push 🚩 (150), Near The Top 🌤️ (160), Peak Rung
  🏔️ (170) — checked against the **new** target just climbed to, so a tier
  fires the moment a climb first reaches that rung.
- 🧗 **Peak Bagged** (`checkoutladderpeakbagged`) — the separate, harder
  feat of actually *checking out* 170 (T20 T20 Bull, the same double-out
  maximum X01's Big Fish celebrates), not just reaching that rung. Recurring
  (`awardRecurringBadge`) — climbing back up to 170 and clearing it again in
  a later run is a real repeatable feat, not a one-off.

### Live scoreboard

`playerSnapshotCheckoutLadder(p)` rides the per-player `players[]` array
(`score`, `out:'double'`, dart counts); `liveSnapshot()` adds
`checkoutLadderTarget`/`checkoutLadderVisits` (mirroring `bobs27Round`'s own
game-level field) and treats this game type as X01-shaped for the
checkout-hint calculation (`isX01` also matches `'checkout_ladder'`, since
it's a genuine double-out visit). `display.html`'s
`renderers.checkout_ladder.card()` mirrors X01's own card almost exactly —
swapping the "Leg N" standing line for "Target N · Attempt N · Visit N/3."

### Saved games

Follows `docs/archive/saved-games-roadmap.md` for free — the ladder's own
"nothing pre-aggregated" design means `rebuildCheckoutLadderState()`
(`frontend/scoring.js`) is a pure replay of `turns`, no extra schema needed.
`_savedGamePosition()` (`backend/db.js`) returns `{target, legNo,
remaining}` for this game type; `savedGamePositionLabel()`
(`frontend/index.html`) renders it as "Target N · attempt N · N remaining."

### Testing

`backend/test/scoring.test.js`: `rebuildCheckoutLadderState()`'s up/down
movement, the 61 floor, a still-live (unresolved) attempt, and a bust
burning a visit without ending the attempt early.
`backend/test/db.turn-consistency-guard.test.js`: the write-time guard's
dart-sum/checkout-points checks, the 3-visit cap, `targetScore` validation
after both a win and a loss, and the 170 ceiling never producing an
out-of-range `targetScore`. `backend/test/db.checkout-ladder-stats.test.js`:
all three stats/PB/leaderboard functions, including the
"`highestTargetReached` counts a failed peak attempt but
`fewestDartsOnHighestCheckout` only looks at the highest **won** target"
distinction. Verified end-to-end with Playwright: a real solo game climbing
121→126 across 6 real 3-dart double-out checkouts (confirming the 🧗
Climbing badge fires at 125), a failed attempt dropping the target back
down, undo restoring state mid-attempt, save/resume round-tripping a
mid-attempt position exactly, and the live `/display` scoreboard rendering
the target/attempt/visit line with no console errors.

## 27. The Gauntlet

`docs/archive/gauntlet-roadmap.md`. A solo endurance warm-up: **20 stations**, one
per board number, played in a **fixed clock-adjacency order** that never
sits two consecutive stations near each other on the board
(`GAUNTLET_STATION_ORDER = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5]`
— itself the standard clockwise dartboard walk, identical every run,
forever). At each station, 3 darts must each complete a specific task **in
strict throw order**: dart 1 the single, dart 2 the treble, dart 3 the
double — no partial credit, and no re-matching across positions (a double
thrown as dart 1 doesn't count for dart 3's own task). Misses earn **Scars**;
2 misses gets one repeat attempt at that same station; 3 misses is a **Deep
Scar** (no repeat, and it counts double toward the run's total). Runs ~15
minutes and always ends after all 20 stations settle — unlike Checkout
Ladder/Doubles Practice's perpetual "runs until End Game," a run **IS** the
game (the same shape practice Baseball/Bob's 27 both established).

### Design

`gauntlet` game type, solo-only, `legsPerSet`/`setsPerGame` forced to 1.
Every turn is stamped `set=1, leg=1` — there's no leg/set progression
concept at all for this mode; station identity lives entirely in
`turns.target_score`, not in `leg_no` (contrast Checkout Ladder, where
`leg_no` increments per attempt).

### The Scar / repeat rule

| Misses this attempt | Outcome |
|---|---|
| 0 | Clean pass — advance |
| 1 | 1 Scar — carry it, advance |
| 2 | **One repeat attempt**, same station — the retry's own result is final regardless of what it comes back as (even another 2 or 3) |
| 3 | **Deep Scar** directly, no repeat offered — advance |

A station **settles** the moment either its first attempt scores something
other than 2, or a second attempt (the repeat) exists for it at all — this
single derivation (`rebuildGauntletState()`, `frontend/scoring.js`) is
shared by the write-time guard, every stats query, and saved-game resume, so
"which stations are settled, is one awaiting its repeat, what's the running
Scar tally" is computed exactly once and can never drift between call sites.

### Per-dart grading (`evaluateGauntletStation`, `frontend/scoring.js`)

Pure, positional: `evaluateGauntletStation(stationNumber, darts)` checks
`darts[0]` against the station's single, `darts[1]` against its treble,
`darts[2]` against its double — each independently, never best-fit across
positions. Returns `{hits:[bool,bool,bool], misses}`. A missing dart (an
attempt somehow cut short) counts as a miss for that slot, though in
practice every Gauntlet attempt is always exactly 3 darts (no bust/win
early-exit condition the way X01 has).

### Scar tally and result tiers

`gauntletTotalScars(finalMisses)` (`frontend/scoring.js`) sums every
station's **final** (post-any-repeat) miss count, **doubling** any station
whose final result is 3 (a Deep Scar contributes 6, not 3) — derived at read
time, never stored pre-multiplied, the same "store the raw number, derive
the special-case scaling" shape Halve-It's halving rule uses.
`gauntletResultTier(totalScars)`:

| Scars | Result |
|---|---|
| 0–5 | Unmarked |
| 6–12 | Scarred but Standing |
| 13–20 | Bloodied |
| 21–30 | Broken Down |
| 31+ | The Gauntlet Wins |

### Data model

Reuses the existing per-dart-turn shape; no new columns. `turns.target_score`
(already exists, already range-checked 1–170, comfortably covers 1–20)
stores which station this attempt was for — read back directly rather than
derived from prior-turn count, since a repeat attempt would otherwise break
the usual "turn count maps 1:1 to position" trick (SEC-25/Baseball-inning
style). `turns.scored` stores the raw miss count for that specific attempt
(0–3). Whether a station was repeated is derivable from row count (more
than one `turns` row sharing the same `(game_id, target_score)`); no
`was_repeat` column exists. Every dart is a real physical throw — full
participation in heatmaps/treble-rate/dart-pace, no hypothetical exclusion
(same conclusion Bob's 27/Checkout Ladder both reached).

### Write-time validation (`addTurn()`, `backend/db.js`)

`scored` (miss count) must be 0–3; `checkout`/`bust` must both be false
(Gauntlet has neither concept). The **sequence guard** (only the next
station in `GAUNTLET_STATION_ORDER`, or the current station's own pending
repeat) and the **repeat-count guard** (at most 2 rows per station, and only
if the first came back as exactly 2) collapse into a single check:
`rebuildGauntletState()` re-derives "which station is expected next" from
every prior turn for this player+game, and the submitted `targetScore` must
match it exactly — this one comparison rejects both a skipped-ahead station
and a 3rd attempt at an already-settled one. Once all 20 stations are
settled, no further turn is accepted at all.

### Engine (`frontend/index.html`)

`enterTurnGauntlet()` (dispatched from `enterTurn()`) commits a 3-dart
attempt via `evaluateGauntletStation()`. If the (non-repeat) attempt scores
exactly 2, `game.gauntletAwaitingRepeat` is set and the SAME station is
re-attempted next — no station advance, no push to
`game.gauntletFinalMisses`. Otherwise the attempt is final: pushed to
`gauntletFinalMisses`, `gauntletStationIndex` advances, and once it reaches
20, `onGauntletComplete()` runs — the one point in this game type's whole
lifecycle that reaches `finishUnit('game', ...)`, calling `DB.completeGame()`
and building the run's own "GAME OVER" summary (Total Scars + Result tier,
`finishUnit()`'s `gauntletSummary` block, mirroring Bob's 27's own
`bobs27Summary`). Undo (`undoLastTurnGauntlet()`) only reaches back into the
still-live attempt — once an attempt settles and the station advances,
`lastTurnSnapshot` only covers up to that settling turn (same "can't undo
past a leg boundary" rule every other game type follows).

### Stats, Personal Bests, Home leaderboard, Scar Map

- **Stat bubbles** (`getGauntletStatBubbles`): runs completed, average total
  Scars per completed run, clean-station rate (% of every settled station,
  across all runs — completed or not — finished with 0 misses on its final
  attempt), Deep Scar rate, retry rate.
- **Personal Best** (`getGauntletPersonalBests`): **lowest** total Scars
  across completed runs only — ascending-is-better, the opposite polarity
  from most "best run" Personal Bests in this app (`MIN()`, not `MAX()`,
  same shape X01's `fewestDartsCheckout` uses).
- **Home leaderboard** (`getGauntletLeaderboard`): one row per player, their
  own lowest-ever total Scars — sorted **ascending** (lower is better), the
  one leaderboard in this app sorted that direction.
- **The Scar Map** (`getGauntletScarMap`) — the actual point of the game:
  for every **completed** run, each station's final miss count averaged per
  station number across every run a player has ever finished. Rendered
  (`renderGauntletScarMap()`) as a 20-cell severity-shaded grid in
  `GAUNTLET_STATION_ORDER`'s own order (already the standard clockwise
  board walk, so no separate layout math is needed to read as "around the
  board"), plus a plain text table alongside it for screen readers
  (docs/archive/gauntlet-roadmap.md's own accessibility requirement).

### Achievements

Three data-driven ladders off the existing `checkChuckinMilestoneTier()`
engine: lifetime runs completed (`GAUNTLET_RUNS_MILESTONE_LADDERS`, base+session,
fetched once at game start the way Chuckin's own lifetime bases are),
lifetime clean stations (`GAUNTLET_CLEAN_STATIONS_MILESTONE_LADDERS`, same
pattern), and — checked once, at run completion, against **that run's own
peak value**, the Bob's 27 final-score pattern, not a lifetime accumulator —
longest streak of consecutive clean stations within one run
(`GAUNTLET_STREAK_MILESTONE_LADDERS`). Plus three one-offs: 💎 **Flawless
Gauntlet** (all 20 stations, zero Scars anywhere — deliberately not mutually
exclusive with 🥋 Unmarked, since a flawless run is trivially also an
Unmarked-tier run), 🥋 **Unmarked** (finish in the 0–5 tier), and 🩹 **Second
Wind** (pass a repeat attempt clean after failing the original with 2).

### No live-scoreboard sync

Same conclusion Checkout Trainer reached, for the same reason: single-device,
solo, no second-screen `/display` broadcast. Enforced INSIDE `pushLive()`
itself (`game.gameType === 'gauntlet'` early-returns, same skip as
checkout_trainer) — the mode's own code path never pushes, but generic call
sites (achievement broadcasts, end-game) run for every mode, and before the
skip they leaked Gauntlet snapshots that `/display` could only render through
the X01 fallback card with no station/scar fields. No `renderers.gauntlet`
exists in `display.html` — an ordinary in-game UI state
(`renderGameGauntlet()`) is enough, the same as Checkout Trainer's own
scoring screen.

### Saved games

Fully reconstructable: current station = `rebuildGauntletState()`'s own
`currentStation` (the first `GAUNTLET_STATION_ORDER` entry with no settled
final result yet, or the pending repeat's station if one is live), running
Scar tally = `gauntletTotalScars()` of the settled `finalMisses` so far —
pure functions of recorded turns, per `docs/archive/saved-games-roadmap.md`.
The run's own clean-streak counters (`gauntletCleanStreak`/
`gauntletBestCleanStreak`) aren't part of that shared rebuild function (they're
a frontend-only running counter, not needed by the write-time guard or any
stats query) — re-derived on resume as a pure pass over the settled
`finalMisses` array instead.

### Testing

`backend/test/scoring.test.js`: `evaluateGauntletStation()`'s strict
positional grading (including "no re-matching across positions" and a
missing dart counting as a miss), `gauntletTotalScars()`/`gauntletResultTier()`'s
Deep-Scar-doubling and tier boundaries, and `rebuildGauntletState()`'s
settle/repeat/done derivation. `backend/test/db.turn-consistency-guard.test.js`:
the sequence guard, the repeat-count guard, the scored-range guard, and
rejecting any turn once all 20 stations are settled.
`backend/test/db.gauntlet-stats.test.js`: all four stats/PB/leaderboard/Scar-Map
functions, including the "clean-station rate counts every settled station
across completed AND in-progress runs, but avgTotalScars/Personal
Best/leaderboard/Scar Map only ever look at completed runs" distinction.
Verified end-to-end with Playwright: a full 20-station run (17 clean, one
2-miss station resolved by a clean repeat earning 🩹 Second Wind, one Deep
Scar, and a final clean station) landing on 6 total Scars/"Scarred but
Standing" and awarding the 5/10/15 streak-ladder tiers correctly; the
Checkout Ladder stat-bubble parity bug found and fixed along the way (see
below); a partial run saved and resumed with its station index, final
misses, and awaiting-repeat state exactly intact; and undo restoring
mid-attempt state correctly.

### Bug found and fixed while building this: Checkout Ladder's stat bubbles were never wired up

While patching `GAME_TYPES.gauntlet.bubbleKeyMap` onto the shared
`bubbleKeyMap`-assignment list (`frontend/index.html`), the equivalent line
for `checkout_ladder` (item 22, shipped just before this one) turned out to
have never been added at all — `GAME_TYPES.checkout_ladder.bubbleKeyMap` was
`undefined`, so `activeBubbleKeyMap()` silently returned `undefined` the
moment a player switched the Player Profile toggle to Checkout Ladder,
blanking its stat bubble values. Fixed in the same change (both lines added
together) rather than left for a future session to rediscover — the same
class of gap BUG-26 was for the badge-label maps, just for the bubble-key
maps instead.

## 28. Killer

`docs/game-modes-roadmap.md`'s "Killer" section (ruleset sourced from
dartscorner.com's published rules). Elimination-format **H2H** — the only
game type in this app whose set of legal per-player targets isn't fixed or
shared: each player is randomly assigned their own number, 1-20, when the
match starts. Real best-of-N legs/sets (like Cricket/Baseball), never forced
to 1 the way every solo drill in this app is — Killer never appears in the
1-player/practice New Game context at all (a new `h2hOnly` flag on
`GAME_TYPES`, the inverse of the existing `soloOnly` flag).

### Number assignment (`assignKillerNumbers`, `frontend/scoring.js`)

Assigned **server-side**, inside `createGame()` (`backend/db.js`) — never
trusted from the client. A Fisher-Yates shuffle (`shuffleKillerNumbers`, an
injectable-RNG pure function so it's deterministically testable) of the pool
`[1..20]`, zipped one-to-one against the match's player names. Assigned once
per **match** (not re-derived per leg — `resetPlayerForNextLegKiller()`
explicitly preserves `player.number` while resetting every other per-leg
field), and re-rolled fresh on every new game row — a rematch/"Play again"
always calls `startGame()` → `createGame()` again, so it gets a brand-new
random assignment rather than reusing the previous match's numbers.
`createGame()`'s return value carries the assignment back to the client as
`config.numbers` (`{playerName: number}`) — the *only* way the client ever
learns them; `DB.beginGame()` (`frontend/index.html`) assigns each
`game.players[i].number` from that response before the scoreboard's first
render.

### Becoming a killer, and attacking (`evaluateDartKiller`, `frontend/scoring.js`)

Every player starts at **0 lives** on their own number. Hitting your own
number scores lives at the same rate every ring scores elsewhere in this
app — single = 1, double = 2, treble = 3. The instant a player's own-number
life total reaches the match's own `config.lives` threshold (2, 3, or 5 —
chosen at New Game setup; 3 is the sourced standard default), they become a
**killer** and can start attacking. Until then, every dart at anyone else's
number is a no-op. Once a killer, hitting an **opponent's** assigned number
removes lives from their total at the identical rate (single = −1, double =
−2, treble = −3) — this directly mirrors the multiplier, not a flat
per-hit cost. **Self-kill**: hitting your own **double** after you're already
a killer costs exactly **1 life**, a flat cost never scaled by multiplier —
hitting your own single/treble again post-threshold is a no-op. A player
reduced to 0 lives is eliminated immediately, mid-visit if that's when it
happens; the last player left with lives > 0 wins the leg the instant every
other player hits 0 — this can end a leg mid-round, unlike X01/Cricket where
the round always finishes for players who already went.

`evaluateDartKiller(dart, throwerName, players)` is a **per-dart**
evaluation, not a batched 3-dart visit — the same architectural pattern
Doubles Practice established, required here because a single visit's three
darts can each affect a **different** player (a self-life-build on dart 1,
an attack on a different opponent on dart 2). It returns `null` for a no-op
dart, or `{affectedName, delta, isGain, selfKill}` describing exactly whose
life total changes and by how much; `rebuildKillerState({names, numbers,
turns, threshold})` replays a whole leg's turns through it to derive
lives/`isKiller`/`eliminated`/kills for every player at any point in the
turn history — shared identically by the write-time consistency guard and
every stats query.

### Data model

Because one visit's darts can each affect a different player, a single
`turns` row per **visit** could never represent Killer's own effects — this
needed a genuine schema change, not just new application logic. A new
nullable `turns.affected_player_id` column (FK to `players`) records which
player a dart's life-change landed on; only Killer ever populates it. As a
consequence, Killer stores **one `turns` row per dart** (not per visit) —
the one game type in this app that does. `turns.scored` stores the plain
non-negative magnitude of the change (0-3); direction (gain vs. loss) is
never stored, only derived by replaying `evaluateDartKiller()` again at read
time. `checkout`/`bust` are always false (Killer has neither concept).
`games.config` stores `{lives, numbers: {playerName: 1-20}}` — keyed by
player **name**, not id, matching every other part of the write path
(turns, badges, stats) that already keys on name.

### Write-time validation (`addTurn()`, `backend/db.js`)

Validates `checkout=false`/`bust=false`/`scored` in 0-3/exactly one dart per
turn, then replays the leg's full turn history via `rebuildKillerState()`
and rejects the incoming turn unless its claimed `affectedPlayer`/`scored`
exactly matches `evaluateDartKiller()`'s own independently-computed
expectation for that dart. Also rejects a turn once the leg already has a
winner, or if the thrower is already eliminated. Turn-order itself (whether
this player is really "next") is **not** enforced — matching the existing
precedent that no consistency guard in this app enforces turn order, only
arithmetic.

### Engine (`frontend/index.html`)

Per-dart commit, no staged "Enter Turn" step — `throwDartKiller(sector,
zone, missZone, missDepth, bounced)` has the identical signature every other
per-dart-commit mode's handler does (Doubles Practice, Just Chuckin' It), so
the existing interactive Dartboard SVG scoring screen is reused unmodified;
no bespoke Killer pad was needed. A "visit" is still up to 3 darts (fewer if
the thrower self-eliminates early) before turn passes to the next
non-eliminated player — `game.killerDartsThisVisit` tracks progress through
it, and `advanceKillerTurn()` skips eliminated players (a static
`(current+1)%n` the way X01 advances doesn't work here). `onKillerLegWon()`
mirrors `onLegWonBaseball()`'s own legs/sets/match tree (Killer gets its own
bespoke leg-win handler, not the generic X01 one, since X01's assumes
X01-shaped player fields). Undo (`undoLastTurnKiller()`) restores both the
thrower's and the affected player's state from a single snapshot — same
"can't undo past a visit boundary" rule every other game type follows.

### Live scoreboard

The one new game type this batch with live-scoreboard sync (`pushLive()`
calls throughout `throwDartKiller`/`advanceKillerTurn`/`renderGameKiller`).
`renderers.killer` (`display.html`) renders one card per player: number,
lives as pips (`●`/`○`) with an `aria-label` stating the exact count (never
color-only), killer status (🔪), and a distinct "ELIMINATED" flash state —
mirroring `renderGameKiller()`'s own in-game content. `game.legSummary` has
its own Killer-shaped branch (number, kills, eliminated, won) for the
end-of-leg summary cards, rather than falling through to X01's shape.

### Stats, Personal Bests, Home leaderboard

- **Stat bubbles** (`getKillerStatBubbles`): games played, win rate (from
  `games.winner_id`, the same source Baseball's win rate uses), average
  kills per leg, average lives lost per leg, and "survived without becoming
  a killer" rate (rode out the whole leg alive, never crossing the
  threshold) — all derived from leg replay via `rebuildKillerState()`.
- **Personal Best** (`getKillerPersonalBests`): most kills in a single leg
  (`MAX()` across every leg played).
- **Home leaderboard** (`getKillerWinLeaderboard`): one row per player,
  `{name, played, won, rate}` — reuses `getBaseballWinLeaderboard()`'s exact
  shape unmodified, since Killer has a real `games.winner_id` the way
  Baseball does (unlike Gauntlet/Checkout Ladder, which have no opponent to
  win against).

### Achievements

Three one-off, all-recurring badges (no lifetime ladder, unlike Gauntlet/Bob's
27) — 🩸 **First Blood** (the match's first elimination, whichever leg it
happens in — `game.killerFirstBloodAwarded` lives on the game object itself,
never reset per leg, so it fires at most once per match), 🛡️ **Untouchable**
(win the match having never lost a single life across any leg —
`gameLivesLost` is match-lifetime, never reset by
`resetPlayerForNextLegKiller()`), and 🙈 **Own Worst Enemy** (eliminate
yourself via your own double after becoming a killer).

### Deliberately out of scope: no save/resume support

Unlike every other H2H game type, `SAVABLE_GAME_TYPES` does not include
`killer`. Mid-match state is fully re-derivable from replaying `turns`
either way (`rebuildKillerState()` already does exactly this for stats), so
this is a scope decision, not a technical limitation — worth revisiting if
ever requested.

### Testing

`backend/test/scoring.test.js`: `shuffleKillerNumbers`/`assignKillerNumbers`'s
even distribution and no-duplicates guarantee, `evaluateDartKiller()`'s full
matrix (own-number builds at each multiplier, attacks at each multiplier,
self-kill on double only, no-ops on an eliminated target or a post-threshold
single/treble on your own number), and `rebuildKillerState()`'s lives/killer/
eliminated/kills/winner derivation across a full leg. `backend/test/db.turn-
consistency-guard.test.js`: `createGame()`'s number-assignment validation
(min 2 distinct names, `lives` range), and the full scored/affectedPlayer
guard matrix. `backend/test/db.killer-stats.test.js`: all three stats/PB/
leaderboard functions, including the zeroed/null shape for a player with no
Killer history. Verified end-to-end with Playwright: the New Game setup flow
(lives-threshold selector, H2H-only visibility), random distinct number
assignment surfaced via `DB.beginGame()`'s `config.numbers` handling, a
single treble instantly clearing the become-a-killer threshold, an attack
eliminating an opponent (including the degenerate case of eliminating a
player who never built any lives), First Blood and Untouchable firing
correctly, a full multi-leg best-of-N match playing out to the correct
winner (leg wins that don't reach `legsPerSet` correctly stop at "LEG
COMPLETE" rather than ending the match), the GAME OVER summary panel, stat
bubbles/Personal Best/win leaderboard via the API, and the live `/display`
`renderers.killer` card (number, lives-as-pips, throwing indicator).

## 29. End-of-Night Session Recap

`docs/archive/session-recap-roadmap.md`. A one-tap digest of everything played on a
single **local calendar date**. Timestamps are stored UTC, so the client also
sends its UTC offset (`&tz=${-new Date().getTimezoneOffset()}` — minutes
**east** of UTC, the same one wire convention avg-history and on-this-day
use) and `getSessionRecap(date, tz)` shifts every `date()` bucket by it via
the shared `_tzModifier()` — without this, a user west of UTC had every game
after ~7-8pm local land in tomorrow's recap. An absent/invalid `tz` falls
back to 0 (raw UTC dates — old-client behavior).
A night that genuinely straddles the LOCAL midnight still splits in two, an
accepted v1 tradeoff, same as Daily Challenge's own. (`getSummary()`'s
`todayDarts` deliberately keeps the raw UTC boundary — see its own section.)
Purely read-time: `getSessionRecap()` (`backend/db.js`) aggregates over
existing `turns`/`games`/`player_badges` rows — nothing is stored, so any
past date is recomputable for free.

### Scope: H2H is the spine, solo is a footnote

Per the roadmap doc's own framing ("the recap's spine is the games people
played against each other"): every **completed** H2H game (`practice=0`,
`player_count>1`, `completed_at` on the given date) is fully itemized —
per-matchup win/loss records for 2-player games, a flat list for 3+ player
games. Non-H2H activity (practice or solo, any game type) is folded into a
light `soloActivity` summary grouped by player+game type (legs/rounds +
darts thrown, `legs` omitted for the continuous-stream types — Chuckin,
Checkout Trainer, guided Around the World — where a "leg" is meaningless),
never itemized.

### Response shape (`GET /api/session-recap?date=YYYY-MM-DD`)

```
{
  date, totalGames,               // totalGames = completed H2H games only
  h2hGames: [ {gameId, category, gameType, completedAt, winnerId, winnerName, players:[name,...]} ],
  h2hResultsByMatchup: [ {players:[a,b], games:[{gameId,category,gameType,winner}], record:{name:wins}} ],
  perPlayer: [ {name, gamesPlayed, gamesWon, gamesLost, dartsThrown, oneEighties,
                tonPlusCheckouts, bestVisit, bestLegAvg} ],
  soloActivity: [ {name, gameType, legs, darts} ],
  badgesEarnedTonight: [ {player, badgeId, count, earnedAt} ],
  personalBestsSetTonight: [ {player, metric, value, previousBest} ],
  moments: [ {ts, type, player, text} ],   // chronological
}
```

- **`perPlayer`'s `bestVisit`/`bestLegAvg` are X01-only** (same scope
  `getPersonalBests()`'s own `bestLegAvg` uses) — extending "best leg" to
  every other game type's own formula is left for a future pass rather than
  ballooning this one aggregation. `gamesWon`/`gamesLost`/`dartsThrown`/
  `oneEighties`/`tonPlusCheckouts` cover every game type a player touched
  that date (darts thrown excludes Checkout Trainer's non-physical darts,
  same `NOT_CHECKOUT_TRAINER` convention as `getHomeExtra()`'s own
  `todayDarts`).
- **`h2hResultsByMatchup`** only covers exactly-2-player games, grouped by
  the unordered player pair in first-played order; a 3+ player game has no
  single pairwise record and is listed only in `h2hGames`.
- **`badgesEarnedTonight`** returns the raw `badge_id` only — label/icon/
  description resolve through the frontend's own `BADGE_INFO` map (the
  single source of truth for that data everywhere else badges surface, not
  duplicated server-side).

### Personal bests set tonight

The roadmap doc's own flagged risk ("the pre-tonight comparison is the
easiest formula to get subtly wrong"). For each player active on the date,
three well-defined single-number X01 records are each computed twice — once
scoped to `date(t.created_at) = ?` (tonight) and once to `date(t.created_at)
< ?` (every day strictly before it) — and a record only lands in
`personalBestsSetTonight` if tonight's own best exists **and** either no
pre-tonight value exists at all, or tonight's value beats it in the correct
direction:

| Metric | Direction | Pre-tonight baseline query |
|---|---|---|
| `legAvg` | ascending (higher wins) | `MAX` of every won leg's average, dated before tonight |
| `fewestDartsCheckout` | descending (lower wins) | `MIN` darts across every won leg, dated before tonight (`NOT_HANDICAPPED`-scoped, same as `getPersonalBests()`) |
| `highestCheckout` | ascending (higher wins) | `MAX(checkout_points)`, dated before tonight |

A worse leg played later the same night never adds a second entry for a
metric already recorded as beaten earlier that night — the comparison is
always "tonight's own best vs. the pre-tonight baseline," not per-leg.

### Moments timeline

A chronological merge of the same event classes the live moment cards
already fire on — 180s (X01-only), ton+/Big Fish checkouts
(`checkout_points >= 100`, `170` specifically tagged `bigfish`), H2H match
wins, and badges earned that date — sorted ascending by timestamp so the
recap reads start-to-finish like the night actually happened.

### Frontend

A **🌙 Tonight's recap** teaser card on the Home page (`renderHomeRecapTeaser()`),
hidden entirely until a network round-trip confirms `totalGames > 0` for
today — unlike the Daily Challenge teaser just above it (purely derived
client-side, no fetch needed), "did anyone finish a game tonight" can't be
known without asking the server. Wired into both `show('home')` and the
page's own boot sequence (the initial load never calls `show('home')` since
the Home screen starts already `.on` in the static markup — the same reason
`renderHomeChallengeTeaser()` needed its own explicit boot-time call).

The recap screen itself (`renderSessionRecapBody()`) takes a date (a plain
`<input type="date">`, default today) and renders Results / Tonight-per-player
/ Also tonight / Badges / Personal bests / Moments sections, each hidden when
empty. **📤 Share** renders the night through the existing shareable-moment
card generator (`fireMomentCard('sessionrecap', {...})` → `shareMomentCard()`)
as a single summary card — headline "TONIGHT'S RECAP", the date as the
"player" line, and a stat-line summary (game count, player count, top-180
scorer, badge count) — no new canvas code, matching the roadmap doc's own
"one new card layout, the rest of the pipeline already built."

### Testing

`backend/test/db.session-recap.test.js`: invalid-date rejection, an
empty-activity date, a full 2-player H2H fixture (results grid, per-player
stats, moments), personal-bests-set-tonight firing only on a genuine
improvement over the pre-tonight baseline (and not re-firing for a worse leg
played later the same night), badge date-scoping, solo-activity grouping
kept separate from the H2H spine, and date-boundary scoping (a turn just
before midnight vs. just after land in two different recaps). Verified
end-to-end with Playwright: the Home teaser appearing after a completed H2H
match, the recap screen's full render, and the Share button producing a real
downloaded card image.

## 30. Marathon Mode

`docs/archive/marathon-mode-roadmap.md`. A 45-minute solo endurance session —
not a new way to score darts, a **session wrapper** chaining ordinary,
completely unmodified 501 practice legs back to back with no return to the
New Game screen between them. `game.gameType` stays `'x01'` for every leg
throughout; only `marathon_session_legs`'s own `game_id` FK marks a leg as
belonging to a session (the `league_fixtures`-style "context table with a
`game_id` FK" pattern per CLAUDE.md — never a new `game_type`).

### Data model

```sql
marathon_sessions (id, player_id, duration_minutes, started_at, ended_at)
marathon_session_legs (id, session_id, game_id, leg_order, created_at)
```

`ended_at` NULL means the session is still in progress. Every leg's `game_id`
is created **server-side**, inside `startMarathonSession()`/
`startNextMarathonLeg()` themselves (`backend/db.js`) — no endpoint ever
accepts a client-supplied `game_id` to link, which means the roadmap doc's
own flagged worry about validating an externally-supplied `game_id` never
actually applies: there's nothing to validate.

### The chaining loop

`POST /api/marathon/sessions` creates the session row and leg 1's own
ordinary solo practice 501 game in one call. Each leg plays through the
**completely unmodified** X01 engine (`renderers.x01`, `enterTurn()`,
`evaluateVisit()` — no marathon-specific scoring code anywhere). The instant
a leg is won, `finishMarathonLeg()` (`frontend/index.html`) checks the wall
clock against `startedAtMs + durationMinutes*60000` — **only at this leg
boundary, never mid-leg** (a deliberate tradeoff: real session length can run
a little past 45 minutes by however long the final leg takes, rather than
ever truncating a leg in progress). If time remains, it calls `POST
/api/marathon/sessions/:id/legs` (creates and links the next leg's game,
rejecting with 409 once the session has already ended) and transitions
straight into that leg's live scoreboard via `beginMarathonLeg()` — no return
to New Game. A persistent banner (`renderMarathonBanner()`) sits above the
scoreboard showing elapsed/remaining time and leg count, `aria-live` on a
~15s cadence, with an **End Marathon** control that ends the session
**immediately** (not "wait for this leg to finish") via `POST
/api/marathon/sessions/:id/end` — idempotent, so retrying a dropped response
can't double-process anything.

### A real bug found and fixed while building this (BUG-18-class)

The generic X01 `onLegWon()` only cascades a leg win up into a full
`finishUnit('game', ...)` when `!game.practice` — practice mode's own
default is to treat every win as "just a leg" and offer an endless "Next
leg" button, since an ordinary practice session has no match structure to
complete. Ghost Opponent races already needed (and got, when BUG-18 was
originally found) a `|| game.hasGhost` carve-out for the identical reason —
a ghost race is `practice=true` but is always exactly 1 leg/1 set and must
still reach `finishUnit('game', ...)`. Marathon Mode legs are `practice=1`
too (an ordinary practice game is exactly what each leg genuinely is);
without the same carve-out, a leg win would never reach
`finishMarathonLeg()` at all — every leg would just show the ordinary "Next
leg" panel forever, with no auto-chaining and no session ever ending. Fixed
by extending the existing condition to `(!game.practice || game.hasGhost ||
game.marathonSessionId)`, mirroring the ghost precedent exactly.

### The analysis (`frontend/scoring.js`)

Two pure functions, the only genuinely new calculations this feature needs
(every other per-leg figure — dart count, checkout, busts — is already
derivable from existing X01 turn/dart data, no new columns):

- **`computeFatigueSplit(dartCountsPerLeg)`** — splits the ordered leg list
  into a first half and second half (`Math.floor(n/2)` in the first half,
  the roadmap doc's own "floor the smaller half" convention), averages each,
  and returns `max(0, secondHalfAvg - firstHalfAvg)` — clamped at zero, since
  a session where the player got *faster* in the second half isn't a
  fatigue problem to score against them. A 0- or 1-leg session (no second
  half to compare) returns `{ split: null, tier: null }` — "unmeasurable",
  not "measured perfectly flat" — so every consumer (PBs, the average, the
  leaderboard via PBs, and the frontend's Iron badge check / session-end
  panel) naturally skips it with a null check; without that, a one-leg
  session recorded the mathematically unbeatable 0 and pinned the
  PB/leaderboard forever.

  | Fatigue Split | Tier |
  |---|---|
  | 0–2 darts | Iron |
  | 3–5 darts | Tested |
  | 6–9 darts | Fading |
  | 10+ darts | Running on Empty |

- **`classifyMarathonTrend(dartCountsPerLeg)`** — fewer than
  `MARATHON_TREND_MIN_LEGS` (6) legs is always `'Inconclusive'`. Otherwise
  splits into three roughly-equal segments (early/middle/late,
  `Math.floor(n/3)`-sized early/middle, remainder in late) and reads the
  shape within a ±`MARATHON_TREND_TOLERANCE` (2 darts) band: all three
  segments mutually within tolerance → **Flat Line**; early≈middle, late
  meaningfully worse → **The Cliff**; early meaningfully worse than middle,
  late≈middle → **The Warm Machine**; any other shape (a steady gradual
  climb, fatigue then partial recovery, etc.) → **Inconclusive** rather than
  forcing a label onto ambiguous data. Both the minimum-legs floor and the
  tolerance width are first-pass numbers, not confirmed against real
  sessions (the roadmap doc's own caveat).

### Stats, Personal Bests, Home leaderboard

- **Stat bubbles** (`getMarathonStatBubbles`): sessions completed, average
  legs per session, average fatigue split, and a 3-way lifetime trend-pattern
  breakdown (Cliff/Warm Machine/Flat Line session counts) — all scoped to
  **ended** sessions only (`ended_at IS NOT NULL`); the fatigue-split average
  only averages sessions with a non-null (measured) `fatigueSplit` and reads
  `null` when no session qualifies. An
  `'h2h'` mode request always reads as zero sessions (Marathon Mode is
  inherently solo — the same answer a SQL-side `_scope()` join would reach,
  computed directly instead).
- **Personal Bests** (`getMarathonPersonalBests`): **lowest** fatigue split
  ever (`MIN()` — ascending-is-better, the same polarity The Gauntlet's Scar
  count uses, over sessions with a measured non-null split only) and **most
  legs completed** in a single session (`MAX()`, a stamina/throughput metric,
  any session with at least one completed leg).
- **Home leaderboard** (`getMarathonLeaderboard`): one row per player, their
  own lowest-ever fatigue split, sorted **ascending** — the same direction
  The Gauntlet's own leaderboard uses.

### Achievements

Two data-driven ladders off the existing `checkChuckinMilestoneTier()`
engine (once-earned, not recurring): lifetime sessions completed (1/5/15/30)
and lifetime legs completed inside Marathon sessions (25/100/250/500). Plus
three one-off, all-recurring condition badges, checked once a session ends:
🛡️ **Iron** (session's own fatigue tier is Iron), 📉 **Flat Line** (session
classified Flat Line), and ⏱️ **Full Distance** (the session ended because
the wall clock ran out, never on a manual "End Marathon" stop).

### Deliberately out of scope: no save/resume support

Same scope decision Killer already made. `isCurrentGameSavable()`
explicitly excludes any leg carrying a `marathonSessionId` — the generic
resume path rebuilds a plain `rebuildX01State()` game object with no
marathon linkage at all, so a resumed leg would silently finish as an
ordinary standalone practice game instead of continuing the session.

### Testing

`backend/test/scoring.test.js`: `computeFatigueSplit()`'s floor-half split,
zero-clamping, tier boundaries, and 0/1-leg edge case; `classifyMarathonTrend()`'s
too-few-legs floor and all three named patterns plus the no-match
Inconclusive fallback. `backend/test/db.marathon-mode.test.js`: session/leg
creation and linkage guards (rejects once ended, rejects a player mismatch),
per-leg dart-count/checkout/bust derivation (excluding an in-progress leg
from the analysis series), and the stats/PB/leaderboard functions. Verified
end-to-end with Playwright: the full New Game → Marathon Mode flow, the
persistent banner, a leg auto-chaining into the next on completion, a
manual "End Marathon" stop, the analysis screen, badges (First Marathon,
Iron), and Player Profile/Home page wiring.

## 31. Shanghai

`docs/archive/shanghai-roadmap.md`. The classic pub game — `game_type='shanghai'`, a
genuine new game type, structurally a sibling of Baseball: a fixed round
sequence, all players in lockstep on one shared live round
(`game.shanghaiRound`, game-level state, not per-player). Round 1 targets the
number 1, round 2 the number 2, and so on through `config.rounds` (default
**7**, the common pub format; a **20**-round long-form option is offered on
the setup screen — `NEW_GAME_MODE_OPTIONS`'s `shanghai` entry, `setShanghaiRounds()`).
Per-player state is `{totalPoints, roundPoints: {round: points, ...}}` — no
`score` field, no bust/checkout concept, the same shape family as Baseball's
`totalRuns`/`inningRuns`.

### Scoring — `GAME_TYPES.shanghai.evaluateVisit(player, darts, game)` (`frontend/scoring.js`'s `evaluateVisitShanghai`)

**Only the current round's own number scores**, evaluated dart-by-dart within
the 3-dart visit — a single scores 1× the round number, a double 2×, a treble
3×; anything else (a different number, or a genuine miss) scores 0 for that
dart:

```js
const target = shanghaiRoundTarget(round, maxRounds); // round <= maxRounds ? round : maxRounds
darts.forEach(d => { if (d.sector === target) pointsThisVisit += d.mult * target; });
```

**A Shanghai — single, double, AND treble of the round's own number, in one
visit, any order — wins the WHOLE match instantly, mid-round**
(`isShanghaiWin(darts, target)`), regardless of running point totals. This is
the one genuine difference from Baseball's shape: Baseball's win condition is
always decided by totals after the fixed round count; Shanghai's can end
early, self-referentially, on the exact visit that threw it.

Absent a Shanghai, **the round only completes once the LAST player in the
rotation has thrown** (the shared starter-relative `isRoundComplete(game)` —
see Baseball's own section for the formula and why it is NOT index n-1; read
before `game.current` advances, same timing convention as
`evaluateVisitBaseball()`), and **the win condition is only checked on that
round-completing visit, and only once `config.rounds` has been reached**:
every player's total (including the just-evaluated visit) is compared, and
the match ends only if there's a single unique highest total — an exact tie
among the leaders continues into extra rounds instead, still targeting the
final round's own number (`shanghaiRoundTarget()` caps at `maxRounds` rather
than cycling back to 1, matching Baseball's extra-innings precedent per the
roadmap doc's own "Open questions" answer).

Because a final-round win isn't always self-referential to the round-ending
visit (exactly Baseball's own situation — the player whose turn ends the
round and the player with the higher point total aren't always the same
person), `evaluateVisitShanghai()` returns `{ matchComplete, winnerIndex }`
rather than a simple `win: true` implicitly meaning "this player."
`enterTurnShanghai()` calls `onLegWonShanghai(ev.winnerIndex)`, not
`onLegWonShanghai(game.current)`.

### `turns.leg_won` — set ONLY for a genuine instant Shanghai

Unlike Baseball (which never sets `turns.leg_won` at all, see §Baseball
stats), Shanghai's win condition is a genuine hybrid: an instant Shanghai
really is self-referential to one visit, the same signal Cricket/Killer use
`turns.leg_won` for — so `enterTurnShanghai()` passes `legWon: !!ev.shanghai`
on every turn it records. **A final-round win decided by point totals is
never flagged this way** — only the Shanghai-throwing visit itself ever sets
it. `getShanghaiWonLegs()` (`backend/db.js`) reads this hybrid signal at
query time: legs with a `leg_won=1` turn use that player directly; every
other completed leg falls back to comparing `SUM(scored)` totals per
`(game, set, leg, player)`, exactly `getBaseballWonLegs()`'s own derivation.
This matters for correctness, not just symmetry: a player who throws a
Shanghai on an early round can have a LOWER running point total than an
opponent who was still leading on points right up until that visit ended the
match — a pure "highest total wins" derivation (Baseball's own shape) would
misattribute the win to the wrong player for that case, so Shanghai cannot
use Baseball's derivation unmodified.

### Consistency guard (SEC-25-style, `addTurn()` in `backend/db.js`)

Same shape as Baseball's own guard: the round is re-derived from the
player's own prior-turn count in that game/set/leg
(`shanghaiRoundTarget(priorTurns + 1, maxRounds)`), and a hostile `scored`
that the round's own number can't produce is rejected. `bust`/`checkout`
are rejected outright (the game has neither concept). **Ceiling note**: the
roadmap doc's own draft text says "max legit visit = 6× the round number,
and a Shanghai visit is exactly 6×" — this undersells it. Three trebles of
the round's own number is a real, legal, non-Shanghai visit worth 9× the
round number, more than a Shanghai's 6× — so the actual ceiling this guard
enforces (naturally, via summing each dart's own contribution) is 9×, not
6×. A correctness fix over the doc's literal wording, not a deviation from
its actual intent — the same class of correction Dead Man Walking's own
open-roadmap-items.md entry independently made over its own pitch doc.

### Saved games

Position is a pure function of recorded turns, same as every other savable
game type: `rebuildShanghaiState({names, legsPerSet, maxRounds, turns})`
(`frontend/scoring.js`) replays `running totals + round number` from the
turn sequence, reused identically by `_savedGamePosition()` (write-time) and
`resumeGame()`'s `shanghai` branch (read-time resume). `'shanghai'` is in
both `SAVABLE_GAME_TYPES` lists (`backend/db.js` and `frontend/index.html`).

### Live scoreboard

`renderGameShanghai()` (`frontend/index.html`) and `renderers.shanghai`
(`frontend/display.html`) both render a per-round score grid (players ×
rounds) — same shared chalkboard-table shape as Baseball's own, extended into
extra rounds once reached. **Row labels show the round's own TARGET NUMBER**
(not the round index) so the grid always matches what's actually live to
score against — meaningfully different from Baseball's row labels (which
show the inning index, since Baseball's target number and inning index are
always numerically identical anyway; Shanghai's round index and target
number diverge once extra rounds begin, e.g. round 9 of a 7-round game still
targets 7). `renderPadShanghai()` hides the dartboard entirely and shows one
big single-button pad for the round's target + Miss, mirroring
`renderPadBaseball()` — only one number is ever live. The instant-Shanghai
moment fires `announce()` plus an icon+text 🀄 moment card banner (never
color/confetti alone, per the roadmap doc's own accessibility note).

### Stats (`GAME_TYPES.shanghai.statDefs` / `SHANGHAI_STAT_DEFS`)

A separate, smaller stat vocabulary, structurally mirroring Baseball's own —
`turns.scored` for a Shanghai turn already **is** that visit's points
(`enterTurnShanghai()` writes `scored:ev.scored` directly), so every formula
reads it as-is. Every query is scoped via `_scope({mode, gameType:'shanghai'})`.

**Stat bubbles** (`getShanghaiStatBubbles(name, mode)`):

| Key | Label | Formula |
|---|---|---|
| `shanghaippr` | Points/Round | Points Per Round — `SUM(scored) / COUNT(rounds)`, Shanghai's analog of Baseball's RPI |
| `shanghaisthrown` | Shanghais Thrown | `SUM(leg_won)` — count of turns that were a genuine instant Shanghai |
| `shanghaiwinpct` | Win Rate | `won / played * 100` over completed Shanghai games this player took part in |
| `shanghaigames` | Games Played | Count of completed Shanghai games this player took part in |
| `shanghaidartsthrown` | Darts Thrown | Count of darts thrown in Shanghai games |
| `shanghaibestround` | Best Round | `MAX(scored)` across every turn — the player's personal-best single-round points |

**Personal Bests** (`getShanghaiPersonalBests(name, mode)`, built on
`getShanghaiWonLegs()`'s hybrid derivation above): `bestLegPoints`,
`fewestDartsToWin`, `winStreak`, `recentFormPoints` (avg over the last 10 won
legs), `lifetimePoints` (avg over every won leg) — same 5-field shape as
Baseball's own.

**Home page leaderboards**: Points Per Round (`getShanghaiPprLeaderboard()`,
5-round floor, mirrors `getBaseballRpiLeaderboard()`), Shanghais Thrown
(`getShanghaiShanghaisStats()`, leaderboard + recent feed off `leg_won=1`,
mirrors `getBaseballPerfectInningsStats()`), and Most Shanghai Wins
(`getShanghaiWinLeaderboard()`, H2H only, identical shape to
`getBaseballWinLeaderboard()`). No Perfect-Game analog — a Shanghai win is
instant, not a perfect-every-round feat, so there's nothing for one to mean.

### Badges

🀄 **Shanghai!** (recurring) — win a Shanghai game instantly. Fires from
`enterTurnShanghai()` the moment `ev.shanghai` is true, via the same
`queueBadge`/`awardRecurringBadge` pair every other in-visit badge uses.

### Testing

`backend/test/scoring.test.js`: `shanghaiRoundTarget()`'s in-range/extra-round
capping, `isShanghaiWin()`'s exact single+double+treble match (including the
"two singles and a treble is NOT a Shanghai" negative case), and
`evaluateVisitShanghai()`'s scoring/instant-win/final-round-tie/non-final-round/
extra-round cases. `backend/test/db.shanghai-stats.test.js`: stat-bubble
formulas, the hybrid `getShanghaiWonLegs()` derivation (both the instant-Shanghai
path and the final-round-points path, plus an abandoned-game exclusion), the
PPR/win leaderboards, and an X01/Cricket/Baseball/Shanghai cross-contamination
regression. `backend/test/db.turn-consistency-guard.test.js`: the SEC-25-style
guard's accept/reject cases, including the 6×-vs-9× ceiling correctness fix
and the extra-round target-advancement case. Verified end-to-end with
Playwright: the full New Game → Shanghai flow (practice and H2H), an instant
mid-round Shanghai win, a final-round decider correctly awarded to the
higher-points player rather than whoever's turn ended the round, badges/stat
bubbles/personal bests/win leaderboard, and the live `/display` scorecard.

## 32. Halve-It

`docs/archive/halve-it-roadmap.md`. The classic pressure game —
`game_type='halve_it'`, structurally another Baseball/Shanghai sibling (a
fixed round sequence, all players in lockstep on one shared live round,
`game.halveItRound`) with no instant-win condition at all — the match only
ever completes once the final round settles, same shape as Baseball (never
Shanghai's early-exit case). Per-player state is `{total, roundTotals:
{round: runningTotalAfterThatRound, ...}}` — `roundTotals` stores the
CUMULATIVE running total after each round (not a per-round delta the way
Baseball's `inningRuns`/Shanghai's `roundPoints` do), since a bare `0` on a
halved round would hide the halving that just happened.

### Targets — `config.targets`

An ordered array of `{sector, ring?}` pairs. `ring` omitted means any ring of
that sector counts at face value (single = sector, double = 2×sector, treble
= 3×sector); `ring` present (`'single'`/`'double'`/`'treble'`) restricts
scoring to exactly that ring. The default is the classic 7-round set —
20, 16, double 7, 14, treble 10, 17, Bull (`HALVE_IT_DEFAULT_TARGETS` in
`frontend/scoring.js`).

**Custom target editor.** The New Game setup screen offers a Classic/Custom
toggle (`#halve-it-options-section`, same shape as Cricket's custom-numbers
picker). Classic omits `config.targets` entirely and the game plays the
default; Custom exposes a per-round editor (`setHalveItPreset`,
`addHalveItTargetRow`, `updateHalveItTarget`, `renderHalveItTargetRows`,
`resolveHalveItTargets` in `frontend/index.html`) building an ordered
1–20-round sequence of `{sector, ring?}` rows — each row a native `<select>`
for the sector (Bull 25, or 20…1) and one for the required ring (Any / Single
/ Double / Treble, with Treble hidden for Bull). A custom set is sent as
`config.targets` and the game's category label reads **"Custom Halve-It"**
instead of "Halve-It".

**Server-side validation (`createGame()`, `backend/db.js`).** When
`game_type='halve_it'` and `config.targets` is supplied it must be an array of
1–20 entries; each entry's `sector` must be an integer 1–20 or 25 (Bull), each
`ring` (if present) one of `single`/`double`/`treble`, and a treble-25 round is
rejected outright (the Bull has no treble ring, so the round could never be
won). Each entry is normalised to `{sector}` or `{sector, ring}`, stripping any
extra fields before storage. Omitting `config.targets` is always valid and
keeps `HALVE_IT_DEFAULT_TARGETS`. Covered by
`backend/test/db.halve-it-stats.test.js`.

### Scoring — `GAME_TYPES.halve_it.evaluateVisit(player, darts, game)` (`frontend/scoring.js`'s `evaluateVisitHalveIt`)

```js
function halveItDartValue(d, target){
  if(!target || d.sector !== target.sector) return 0;
  if(target.ring && d.mult !== HALVE_IT_RING_MULT[target.ring]) return 0;
  return d.mult * d.sector;
}
```

This single formula covers Bull for free: `makeDartCore()` already downgrades
an attempted "treble bull" tap to a single (there's no treble-bull ring), so
`mult*sector` alone yields 25/50 for single/double bull with no bull-specific
branch anywhere.

**The halving rule**: if a visit's total gain across all 3 darts is exactly
`0` (every dart missed the target/ring entirely — hitting it always scores
`>0`, so `gained===0` is unambiguous), the running total **halves, rounding
UP**: `total = Math.ceil(priorTotal / 2)`. Round-up is deliberate — round-down
risks a permanent `1 → 0 → 0` death spiral, while round-up's floor is `1 → 1`,
never lower (both are covered by committed tests). A non-halved visit simply
adds its gain: `total = priorTotal + gained`.

**The round only completes once the LAST player in the rotation has thrown**
(the shared starter-relative `isRoundComplete(game)` — see Baseball's own
section for the formula; same timing convention as Baseball/Shanghai), and **the win condition is only checked on that
round-completing visit, and only once every configured target has been
reached**: totals are compared, and the match ends only on a single unique
highest total — a tie continues into extra rounds, repeating the final
target (`halveItRoundTarget()` caps at the target list's own length rather
than cycling back to round 1, the same Baseball/Shanghai extra-round
precedent — this doc's own design section didn't explicitly address ties,
so this fills that gap using the established convention rather than
inventing a new one). Like Baseball/Shanghai, a final-round win isn't always
self-referential to the round-ending visit, so `evaluateVisitHalveIt()`
returns `{ matchComplete, winnerIndex }` rather than assuming the current
player won; `enterTurnHalveIt()` calls `onLegWonHalveIt(ev.winnerIndex)`.

### `turns.bust` — repurposed as the halving flag, `turns.scored` as the gain

Following the exact column-repurposing precedent Doubles Practice/guided
Around the Clock already established for `bust`: `turns.scored` stores the
visit's **gain only** (`0` on a halved visit, never the halving delta
itself — the same "store the gain, derive the rest" shape Bob's 27's own
penalty already uses), and `turns.bust=1` marks a halved visit for cheap
querying. `turns.checkout`/`turns.leg_won` are never set (no checkout or
self-referential-win concept exists here).

### Consistency guard (SEC-25-style, `addTurn()` in `backend/db.js`)

Same shape as Baseball/Shanghai's own guards — the round is re-derived from
the player's own prior-turn count (`halveItRoundTarget(priorTurns+1,
targets)`), and a hostile `scored` the target/ring can't produce is
rejected. `checkout` is rejected outright. **Unlike** Shanghai/Baseball,
`bust` is NOT rejected — it's validated for **consistency** instead: `bust`
must be `true` iff the derived gain is exactly `0`, since `bust` here
legitimately means "this visit halved the total," not "this is illegal."

### Stats not computable by a single SQL aggregate — the one genuine complication this drill has that Baseball/Shanghai don't

Because the running total is **order-dependent** (`ceil(total/2)` interspersed
with additions, not a flat sum), it can't be derived with `SUM(scored)` the
way RPI/PPR are. `_replayHalveItLegTotals(mode)` (`backend/db.js`) replays
every matching turn once, in order, computing each `(game, set, leg,
player)` group's final total exactly the way `rebuildHalveItState()` does for
live resume — same "nothing pre-aggregated, replay the raw turns" philosophy,
just read-only and grouped for stats instead of resuming a game.
`getHalveItWonLegs(playerId, mode)` derives each completed leg's winner from
this replay by comparing final totals (Halve-It has no `leg_won=1` signal at
all, ever — there's no instant-win condition, so unlike Shanghai's hybrid
derivation this is a pure Baseball-style comparison with no self-referential
case to special-case).

### Stats (`GAME_TYPES.halve_it.statDefs` / `HALVE_IT_STAT_DEFS`)

**Stat bubbles** (`getHalveItStatBubbles(name, mode)`): Avg Final Total
(`avgFinalTotal`, averaged over every completed leg via the replay above),
Times Halved (`SUM(bust)`), Win Rate, Games Played, Darts Thrown, and Best
Round (`MAX(scored)` — highest single-round gain, the same "peak single-round
figure in the bubbles, not Personal Bests" split Baseball's own Best Inning
uses).

**Personal Bests** (`getHalveItPersonalBests(name, mode)`, built on
`getHalveItWonLegs()`): `bestFinalTotal`, `fewestDartsToWin`, `winStreak`,
`recentFormTotal` (last 10 won legs), `lifetimeTotal` — same 5-field shape as
Baseball's/Shanghai's own.

**Home page leaderboards**: Highest Final Total (`getHalveItBestTotalLeaderboard()`,
one row per player, their peak total across BOTH won and lost legs — same
no-minimum-floor "single best-ever run" shape as Checkout Ladder's/Checkout
Blitz's own boards, not gated on having actually won) and Most Halve-It Wins
(`getHalveItWinLeaderboard()`, H2H only, identical shape to Baseball's/
Shanghai's own).

### Badges

🪓 **Halved at the Death** (recurring) — the winner's own most recent visit
(the one that decided the leg) halved their total, and they still won.
Tracked via a per-player `lastVisitHalved` flag, overwritten every visit.
🛡️ **No Half Measures** (recurring) — won the leg without ever being halved,
tracked via a per-player `everHalved` flag, reset every leg. Both are
leg-OUTCOME badges (checked once the winner is known, in `onLegWonHalveIt()`),
the same split Baseball's Perfect Game/Walk-Off use.

### Live scoreboard

`renderGameHalveIt()` (`frontend/index.html`) and `renderers.halve_it`
(`frontend/display.html`) both render a per-round chalkboard grid — row
labels show the round's own **target label** ("Double 7", "Bull"), not a
bare number, and each cell shows the **running total after that round**
(never a per-round delta) with a `½` marker on a halved round, so the
halving is visible without relying on color alone (per the roadmap doc's own
accessibility note). `display.html` has no shared `scoring.js` module, so
`liveSnapshot()` sends the FULL `halveItTargets` array (not just the live
round's own target) so its renderer can compute every row's label itself.
`renderPadHalveIt()` shows one button for the round's live target — an
unrestricted round works exactly like Baseball's/Shanghai's own single-target
pad; a ring-restricted round (e.g. double 7) shows the ring prefix on the
button (`D7`) and relies on the same ambient multi-row selector Bob's 27's own
pad already uses, since `halveItDartValue()` naturally scores the wrong ring
as `0` regardless of which button was tapped.

### Saved games

Position is a pure function of recorded turns: `rebuildHalveItState({names,
legsPerSet, targets, turns})` (`frontend/scoring.js`) replays running totals
+ round number from the turn sequence — including `everHalved`/
`lastVisitHalved` per player, so a resumed leg's badge check still sees the
whole leg's halving history, not just turns recorded after the resume.
Reused identically by `_savedGamePosition()` (write-time) and `resumeGame()`'s
`halve_it` branch (read-time). `'halve_it'` is in both `SAVABLE_GAME_TYPES`
lists (`backend/db.js` and `frontend/index.html`).

### Testing

`backend/test/scoring.test.js`: `halveItRoundTarget()`'s in-range/extra-round
capping and empty-list fallback, `halveItDartValue()`'s unrestricted/
ring-restricted/wrong-sector/bull cases, and `evaluateVisitHalveIt()`'s
hit/halve/round-up/final-round/tie/extra-round cases. `backend/test/db.halve-it-stats.test.js`:
stat-bubble formulas, `getHalveItWonLegs()`'s pure-total derivation (including
a case proving the order-dependent replay differs from a naive
`SUM(scored)`), the best-total/win leaderboards, an
X01/Cricket/Baseball/Shanghai/Halve-It cross-contamination regression, and
`createGame()`'s custom-target validation/normalisation (well-formed accept,
extra-field stripping, malformed-array reject, treble-Bull reject, omitted-OK).
`backend/test/db.turn-consistency-guard.test.js`: the SEC-25-style guard's
accept/reject cases, including the bust-must-match-the-derived-halving
consistency check and the ring-restricted/extra-round target-advancement
cases. Verified end-to-end with Playwright: the full New Game → Halve-It
practice flow (a hit, a halving with correct round-up math, a ring-restricted
round, a full 7-round game to completion), the 🛡️ No Half Measures badge,
stat bubbles/personal bests/best-total leaderboard, the live scorecard's
target-label row headers, and the `/display` scorecard.

## 33. Dead Man Walking

`docs/archive/dead-man-walking-roadmap.md`. A solo drill that skips the warmup:
**15 rounds** (`game_type='dead_man_walking'`, solo-only), each one dropping
the player mid-checkout on one of *their own* historically weakest X01
finishes, with a personalized dart budget one tighter than they'd usually
need. Close it → **Walked Out**. Bust, or run out of darts → **Executed**.
The count of Walked Out rounds out of 15 lands on a result tier at the end,
Pardoned down to Executed. Structurally the closest existing precedent is
the 121 Checkout Ladder (§26) — real X01-shaped visits from a non-501
deficit, reusing X01's own bust/win legality — but two things are
genuinely different: the deficit and dart budget are **personalized and
frozen server-side at creation**, never client-supplied or recomputed
mid-session, and a bust here is **immediately fatal to the round** (no
second visit to retry within the same round the way the Ladder's
up-to-3-visits shape allows).

### Sourcing the deficit — `getWeakestCheckouts(playerName, count)` (`backend/db.js`)

Reuses Coaching Insight #3's own remaining-score reconstruction technique
(§3's "Bust pattern by parity" formula) verbatim: the remaining score
entering each X01 turn isn't stored, so it's rebuilt with the same
window-function trick —

```sql
json_extract(g.config,'$.startingScore')
  - COALESCE(SUM(t.scored) OVER (
      PARTITION BY t.game_id, t.set_no, t.leg_no
      ORDER BY t.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) AS remaining
```

— filtered to this player's own double-out X01 turns (`gp.out_mode='double'`,
`g.game_type='x01'`, `startingScore IN (501,301,170,101)`) where the
reconstructed `remaining` falls in **32–170** (the doc's own range —
below 32 isn't "genuinely weak" territory for this drill), grouped by that
exact remaining value into a per-number **weakness score**:

```
weaknessScore = 0.5 * bustRate + 0.5 * nonCompletionRate
```

(deliberately overlapping — every bust is also a non-completion, so a
number the player busts on often is weighted extra versus one merely left
unfinished without busting). A `DMW_MIN_NUMBER_SAMPLES` floor (8, a first
pass mirroring Coaching Insights' own `COACHING_MIN_ROUTE_USES`) excludes any
remaining value seen too rarely to trust. Bogey numbers (159/162/163/165/166/
168/169 under double-out) are excluded via `checkoutHint()`'s own `''`
unfinishable signal — the same source of truth the Checkout Trainer
trick-question tier already uses — never served as a round's deficit.
Results sort worst-first (ties broken by larger sample, then lower number)
and cap at `count`. **"Avoided" checkouts** (a third failure mode the
original pitch mentions) aren't measured — there's no reliable signal in
recorded data for "the player routed around this number on purpose," per
the roadmap doc's own "Open questions."

**A known characteristic, not a bug**: a fresh leg's very first turn is
itself an "encounter" this same query reconstructs, at `remaining =
startingScore` (170 or 101, since 501/301 fall outside `checkoutHint()`'s
170-max range and are excluded by the bogey filter) — a real X01 player's
opening visit essentially never checks out immediately, so a player with a
lot of 170- or 101-category play will tend to see that exact category
number itself surface as a moderately "weak" pool entry. This is the same
reconstruction-technique artifact Coaching Insight #3's own bust-parity
check already carries (just diluted there across an odd/even bucket rather
than concentrated on one specific number) — inherited by faithfully reusing
that technique, not introduced fresh here, and not addressed by this doc.

**Cold start**: a player with too little double-out X01 history (an empty
pool) falls back to `CHALLENGE_CHECKOUTS` (`frontend/scoring.js` — moved
there from `frontend/index.html` specifically so this server-side path can
share it, since Daily Challenge's own copy was frontend-only) — the same
"reuse existing curated content" precedent Daily Challenge itself set.
`pickDeadManWalkingTargets(pool, 15, rng)` (`frontend/scoring.js`) then draws
15 targets from whichever pool applies, **with replacement** (a real,
uniform random draw, not a fixed cycle — repeats are expected whenever a
player's own weak pool is smaller than 15).

### Par — `deadManWalkingParForTarget(target, historicalAverage)` (`frontend/scoring.js`)

The pitch's "par minus one" only makes sense if par is a personalized
standard **above** the theoretical minimum — using `checkoutHint()`'s own
optimal dart count as par directly would make every round mathematically
impossible (you cannot finish in fewer darts than the theoretical minimum).
This doc's own correctness fix:

```
par = historicalAverage != null
  ? max(historicalAverage, objectiveOptimal + 1)   // the floor
  : objectiveOptimal + 2                            // no history yet in this band
```

`historicalAverage` (`_dmwHistoricalAverageDarts(playerId, band)`,
`backend/db.js`) is this player's own **average total darts-to-finish**
across their real won X01 double-out legs whose `checkout_points` (stored
directly on the checkout turn — no reconstruction needed here, unlike the
weakness query above) falls in the same **band** as this round's target:
Low 32–60 / Mid 61–100 / High 101–170 (`DEAD_MAN_WALKING_BANDS`,
`deadManWalkingBandFor()`, `frontend/scoring.js` — three bands is this
build's chosen granularity, a first pass per the roadmap doc's own "Band
granularity" open question, not confirmed against real play). "Total
darts" already spans every visit in a won leg (including any earlier busts
within it), the same convention `fewestDartsCheckout`/`getShanghaiWonLegs()`
already use for "how many darts did this checkout actually take." The floor
(`objectiveOptimal + 1`) is the one concrete, testable correctness property
this doc adds: **the round's actual dart budget (`par - 1`) can never drop
below the objective-optimal dart count**, verified by an exhaustive test
across every finishable score 2–170 (`backend/test/scoring.test.js`, the
same rigor `checkoutHint()`'s own exhaustive test already has).

### `config.rounds` — frozen, server-authoritative, never client-supplied

`games.config.rounds` is an array of exactly 15 `{target, par}` pairs,
computed **once, server-side, inside `createGame()`** (`_buildDeadManWalkingRounds()`,
`backend/db.js`) from a live snapshot of the player's own history at that
exact moment, then frozen for the whole session — recomputing it live
mid-session would make a resumed/saved game non-reproducible, and (the real
security point) **a client can never supply or influence `config.rounds`
at all** — any `config` the request body carries for this game type is
simply ignored, closing off a hostile client choosing its own easy
targets/generous pars for itself. The one way the client learns its own 15
personalized rounds is the same channel Killer's number assignment already
uses: `createGame()`'s response carries `{gameId, config: {rounds}}` back,
and `DB.beginGame()` (`frontend/index.html`) threads it onto the live
`game.config.rounds` the moment the POST resolves.

### Execution — per-dart, not per-visit (`evaluateDeadManDart`/`resolveDeadManDart`, `frontend/scoring.js`)

Because the budget won't generally be a multiple of 3, and a bust or a
finish must end the round the **instant** it happens, this can't wait for
`evaluateVisit()`'s batched 3-darts-at-once shape — a new pure per-dart
evaluator generalizes its own bust/win logic:

```js
function evaluateDeadManDart(remaining, dart, doubleOut){
  const newRemaining = remaining - dart.value;
  let bust=false, win=false;
  if(newRemaining < 0) bust = true;
  else if(doubleOut && newRemaining === 1) bust = true;
  else if(newRemaining === 0){
    if(doubleOut && !dart.isDouble) bust = true;
    else win = true;
  }
  return { newRemaining: bust ? remaining : newRemaining, bust, win };
}
```

`resolveDeadManDart(remaining, dart, doubleOut, dartsUsedThisRound, budget)`
composes this with the round's own budget: a dart that neither busts nor
wins but exhausts the budget still ends the round — **Executed, out of
darts** — a real, valid, non-bust visit that simply ran out of room
(`scored` keeps its genuine point value; this is NOT stored as `bust=1`,
since nothing about the scoring itself failed). Both `frontend/index.html`'s
live per-dart preview (`throwDart()`'s `dead_man_walking` branch) and the
actual commit (`enterTurnDeadManWalking()`) call this SAME function, so they
can never disagree about which of the three outcomes just happened.

### Data model — ordinary X01 columns, reused in their normal sense

**No new columns at all.** Each round is its own `leg_no` (`turns.target_score`
stores that round's frozen deficit); `bust`/`checkout` are used in their
**ordinary X01 sense**, no repurposing — a round is **Walked Out** iff any
turn within its leg has `checkout=1`, **Executed** otherwise, whether by a
real bust (`bust=1` on the terminal turn) or by exhausting the budget
without one (`bust=0`, `checkout=0`, but the round settled anyway because
`darts used == budget`). This doc's own open question ("should the two
Executed flavors be visibly distinct?") is resolved as: **not stored
distinctly** (both collapse to "not Walked Out" for every tally/stat/badge),
but the live UI/`announce()` calls DO distinguish them in the moment
("EXECUTED — bust" vs. "EXECUTED — out of darts"), matching the doc's own
framing that the distinction "matters for live feedback but not for
anything stored or tallied."

### Write-time guard (`addTurn()`, `backend/db.js`)

Same dart-sum/bust/checkoutPoints arithmetic as the `'x01'`/`'checkout_ladder'`
branches, reused wholesale, plus what's genuinely new here: a **per-round
variable dart-budget guard**, generalizing the Checkout Ladder's flat
9-dart/3-visit cap to a variable `config.rounds[leg-1].par - 1`. `targetScore`
is validated against the FROZEN round the server itself computed at
creation (never a live-derived climbing target the way the Ladder's own
guard re-derives). A round already resolved (any prior turn has
`checkout=1` or `bust=1`, OR the cumulative recorded darts already equal
the budget) rejects any further turn against that same leg outright.

### Round progression — a dedicated function, not an X01 `onLegWon()` carve-out

Every prior fixed-round-per-visit game type in this app (Baseball/Shanghai/
Halve-It) is "one visit = one round," each with its own dedicated
`onLegWon*()` reimplementing leg/set/game bookkeeping from scratch. Dead Man
Walking is structurally closer to a real X01 leg that can span **multiple**
visits (a round only settles once a genuine bust/win/out-of-darts event
fires) — but a bust here is immediately fatal to the round, unlike Checkout
Ladder's forgiving up-to-3-visits shape, and **two of the three ways a
round can end (a bust, or running out of darts) are never an X01 leg-win
EVENT at all** — there's no `onLegWon()` hook to carve into for them the
way Marathon Mode's own practice-leg carve-out (`|| game.marathonSessionId`)
worked. `resolveDeadManWalkingRound(walkedOut)` (`frontend/index.html`) is
therefore its own dedicated progression function: it tallies the round,
advances `game.legNo`, and either seeds the next round's own frozen
target/par (rounds 1–14 settling) or calls `onDeadManWalkingComplete()` →
`finishUnit('game', ...)` (round 15 settling) — `legsPerSet`/`setsPerGame`
are forced to 15/1 at `startGame()` time purely so the live scoreboard's
"Round N of 15" framing has somewhere sane to read `game.legNo` from; the
actual 15-round-and-stop logic lives entirely in this function, never in
the generic `legsPerSet`/`setsPerGame` machinery (which this mode never
actually checks, the same "a run IS the game" shape Gauntlet/Bob's 27 use,
just with 15 legs instead of 1).

### Result tiers (derived, never stored)

| Walked Out | Result |
|---|---|
| 13–15 | Pardoned |
| 10–12 | Reprieve |
| 7–9 | Last Rites |
| 4–6 | The Walk |
| 0–3 | Executed |

`deadManWalkingResultTier(walkedOutCount)` (`frontend/scoring.js`), computed
fresh at read time (the GAME OVER screen, the moment-card headline) — never
stored, same derive-don't-store precedent every tiered result in this app
uses.

### Stats (`GAME_TYPES.dead_man_walking.statDefs` / `DEAD_MAN_WALKING_STAT_DEFS`)

Because a round's own termination reason (Walked Out / bust / out-of-darts)
isn't a single `SUM()`-able column, `_replayDeadManWalkingLegs(mode)`
(`backend/db.js`) replays every matching `(game, player, leg)` group once —
the same "nothing pre-aggregated" complication Halve-It's own
`_replayHalveItLegTotals()` hit — reading each leg's config to know its own
frozen `par` (for the margin calculation below).

**Stat bubbles** (`getDeadManWalkingStatBubbles(name, mode)`): Runs
Completed, Avg Walked Out / Run, Bust Rate (% of rounds Executed by a real
bust), Out-of-Darts Rate (% Executed by running out of budget without
busting — two DISTINCT tallies, both ways to not Walk Out), Avg Margin
(Walked Out) (average darts of budget left unused on a Walked Out round —
`(par-1) - dartsUsed`), and Longest Walked-Out Streak (see below). `totalWalkedOut`
(the exact lifetime sum, not derived by re-multiplying the average) also
rides along in this same response as the raw ingredient the lifetime
achievement ladder reads.

**Personal Best** (`getDeadManWalkingPersonalBests(name, mode)`): **one
field**, `mostWalkedOut` — the most Walked Out rounds in a single run, a
**higher-is-better** peak (`MAX()`, the standard descending "best run" shape
most Personal Bests in this app use — contrast The Gauntlet's own
deliberately-ascending Scar count, which this one is NOT). No win-streak/
recent-form/lifetime-average fields — there's no opponent, the same reasoning
Bob's 27/Checkout Ladder/The Gauntlet's own single-or-few-field Personal
Bests already settled on.

**Home leaderboard** (`getDeadManWalkingLeaderboard()`): best (highest)
Walked Out count, one row per player, their peak run — no mode param
(always solo/practice), same "no h2h/practice split needed" precedent
Doubles Practice's own leaderboards established.

**Longest Walked-Out Streak** (`getDeadManWalkingLongestStreak(playerName)`):
a **lifetime, cross-run** figure (the roadmap doc's own "within or across
runs") — a flat chronological scan of every round this player has ever
played, across every game (`ORDER BY MIN(t.id)`, since `game_id` increases
with creation time and turn id orders rounds within a game correctly too),
counting the longest run of consecutive Walked Out rounds. This naturally
lets a streak begun at the tail of one run continue into the next run's
opening rounds, which a per-run-only calculation (checked once at each
run's own end, the way Gauntlet's own clean-station streak is) could never
represent.

**A real isolation bug found and fixed along the way**: `getPersonalBests()`'s
`bestLegAvg`/`bestLeg`/`recentFormAvg`/`lifetimeAvg` (the X01 Personal
Bests) and `getPlayerStatBubbles()`'s `avgDartsPerLeg`, plus
`getPersonalBests()`'s `fewestDartsCheckout`, all relied on `t.checkout=1`
as an implicit "this is a real X01 leg" signal with no explicit
`game_type='x01'` filter — true only as long as X01 (and Checkout Trainer,
excluded separately via `NOT_CHECKOUT_TRAINER`) were the only game types
that ever set `checkout=1`. Checkout Ladder broke that assumption when it
shipped, and Dead Man Walking's own real Walked Out checkouts made it
concrete: a committed isolation-regression test (played a full Dead Man
Walking run) caught `bestLegAvg`/`bestLeg`/`recentFormAvg`/`lifetimeAvg` all
changing from `null` to real (wrong) values. `bestLeg` in particular feeds
the Ghost Opponent "Race this leg" button, explicitly X01-only
(`docs/archive/ghost-opponent-roadmap.md`) — pointing it at a
personalized-deficit Dead Man Walking round would have made that button
silently replay the wrong thing. Fixed by adding `X01_ONLY` to all three
queries. (`dartsThrown`/`avgDartsPerDay`/`bigFish`/`fewestDartsCheckout`
remain deliberately global/cross-game-type — §3's own "Physical-dart stats"
scoping table already documents that as intentional, not part of this fix.)

### Badges

Data-driven ladders off the same `checkChuckinMilestoneTier()` engine every
other milestone ladder in this app uses — two lifetime ladders (`DMW_RUNS_MILESTONE_LADDERS`:
runs completed; `DMW_WALKED_OUT_MILESTONE_LADDERS`: lifetime Walked Out
rounds, the Chuckin base+session pattern) plus one **lifetime, cross-run**
streak ladder (`DMW_STREAK_MILESTONE_LADDERS`), checked at the end of
EVERY run against a fresh server-computed value
(`getDeadManWalkingLongestStreak()`) rather than a per-run local counter the
way Gauntlet's own streak ladder is — since this streak can genuinely span
multiple runs. Three one-off badges, all recurring, framed with the mode's
own dark, self-aware humor per the roadmap doc's tone note:

| Badge | Exact condition |
|---|---|
| 🕊️ **Full Reprieve** | `walkedOutCount === 15` — a perfect run |
| ⚰️ **Pardoned** | `walkedOutCount >= 13` — reached the top result tier |
| 💀 **Last Request** | `walkedOutCount === 0` — "you showed up," not purely celebratory, matching the mode's own tone |

### Live scoreboard

Dead Man Walking DOES broadcast to `/display` (unlike Checkout Trainer and
Gauntlet, which skip the push in `pushLive()` itself):
`enterTurnDeadManWalking()`/`renderGameDeadManWalking()` push every committed
turn, and `renderers.dead_man_walking` in `display.html` renders the card —
round N/15, remaining score, darts left this round, and the Walked Out tally —
from three DMW-only top-level live keys (`dmwBudget`, `dmwDartsUsed`,
`dmwWalkedOut`, registered in `ALLOWED_LIVE_KEYS`; the round number rides on
the generic `legNo`, remaining score inside `players[]`). The end-of-run
summary card reads the DMW `legSummary` entry's `walkedOut`. Its badge ids are
also hand-copied into `display.html`'s `ACH_LABELS`/`ACH_DURATION`/`ACH_DESC`
maps, per the standing convention, so the live achievement overlay's headline
isn't blank while these badges are earned. `renderGameDeadManWalking()`
(`frontend/index.html`) shows current round N/15, the deficit (`p.score`),
a **dart-count countdown** (never a wall-clock one — a deliberately
different flavor from The Pressure Chamber's own timer) computed as
`budget - dartsUsedThisRound`, and the running Walked Out tally, all as
persistent always-visible text (not merely inferred from a highlighted
dartboard region), with the darts-remaining line also `aria-live` so it's
announced as the budget runs low. A bust, a Walked Out, and an
Executed-by-budget result each get their own `announce()` call and
icon+text status change (never color/flash alone).

### Saved games

`rebuildDeadManWalkingState({rounds, turns})` (`frontend/scoring.js`) is a
pure replay of recorded turns against the frozen `config.rounds` array —
reused identically by the write-time guard's "already resolved" check,
`_savedGamePosition()` (write-time list summary), and `resumeGame()`'s
`dead_man_walking` branch (read-time resume). `'dead_man_walking'` is in
both `SAVABLE_GAME_TYPES` lists (`backend/db.js` and `frontend/index.html`).
`_savedGamePosition()`'s own field names (`dmwRound`/`dmwTotalRounds`/
`dmwTarget`/`dmwWalkedOutCount`/`dmwDartsUsedThisRound`/`dmwBudget`)
deliberately avoid colliding with Bob's 27's/Checkout Ladder's own `round`/
`target` fields, since `savedGamePositionLabel()` (`frontend/index.html`)
branches on field PRESENCE across every game type's differently-shaped
position object.

### Accessibility and security

Same accessibility treatment as every live scoreboard in this app (see
"Live scoreboard" above) — no color-only signals, persistent text labels,
`aria-live` on the darts-remaining countdown. Security: `config.rounds` is
server-generated at creation and never client-supplied (see "`config.rounds`"
above); the per-round dart-budget guard (see "Write-time guard" above); no
new credential/secret surface.

### Testing

`backend/test/scoring.test.js`: `deadManWalkingBandFor()`'s band boundaries;
`deadManWalkingParForTarget()`'s historical-average/floor/cold-start-default
cases, plus the **exhaustive** floor-never-violated test across every
finishable score 2–170; `pickDeadManWalkingTargets()`'s deterministic draw
with an injectable rng; `evaluateDeadManDart()`'s three-way bust/win/continue
outcomes; `resolveDeadManDart()`'s budget-exhaustion "out of darts" case;
`deadManWalkingResultTier()`'s threshold boundaries; `rebuildDeadManWalkingState()`'s
Walked-Out/bust/out-of-darts/still-in-progress/session-complete replay
cases. `backend/test/db.turn-consistency-guard.test.js`: the write-time
guard's dart-sum/checkoutPoints/budget-exhaustion/already-resolved/
beyond-15-rounds cases, using `createGame()`'s own real (cold-start)
`config.rounds` rather than hand-picked values. `backend/test/db.dead-man-walking-stats.test.js`:
`getWeakestCheckouts()`'s ranking/sample-floor/bogey-exclusion/single-out-
exclusion/other-game-type-exclusion cases; the par calculation's
historical-average and cold-start-default paths via real `createGame()`
calls; all four stats/PB/leaderboard functions; the lifetime cross-run
streak (including a streak spanning the tail of one run into the head of
the next); and an isolation-regression suite proving Dead Man Walking turns
never leak into X01's own arithmetic-scoped stats (and the `X01_ONLY` fix
above) or vice versa. Verified end-to-end with Playwright: both the
real-weak-checkout-history path (a seeded player with genuine bust/
completion history driving a deterministic, personalized `config.rounds`)
and the cold-start fallback path (a fresh player drawing from
`CHALLENGE_CHECKOUTS`), a Walked Out round, an Executed-by-bust round, an
Executed-by-out-of-darts round, a full 15-round run reaching a real result
tier (Pardoned) with the correct streak-ladder and `dmwpardoned` badges,
stat bubbles/Personal Best/Home leaderboard via the live API, and
save-for-later/resume round-tripping mid-run state (round, target, Walked
Out tally) exactly.

## 34. The Pressure Chamber

`docs/archive/pressure-chamber-roadmap.md`. A 15-round pressure-training drill —
`game_type='pressure_chamber'`, `config.rounds: 15` (fixed, server-overridden
regardless of whatever the client sends, the same never-trust-the-client
precedent Killer's number assignment already established), 1-4 players
(`contexts: ['practice', 'h2h']`). Structurally another Baseball/Shanghai/
Halve-It sibling — a fixed round sequence, all players in lockstep on one
shared live round (`game.pressureChamberRound`) — but with a genuinely new
mechanic none of those three have: each round's **Pressure Card** (a target +
a situational modifier) is a **pure function of `(gameId, roundIndex)`**,
never stored, re-derived identically by the live client, the write-time
consistency guard, and every read-time stats query.

### The card sequence — generated, never stored

`generatePressureCard(gameId, roundIndex)` (`frontend/scoring.js`):

```js
function generatePressureCard(gameId, roundIndex){
  const targetIdx = _pcSeededIndex(`${gameId}|${roundIndex}|target`, PRESSURE_TARGET_POOL.length);
  const modifierIdx = _pcSeededIndex(`${gameId}|${roundIndex}|modifier`, PRESSURE_MODIFIERS.length);
  return { round: roundIndex, target: PRESSURE_TARGET_POOL[targetIdx], modifier: PRESSURE_MODIFIERS[modifierIdx] };
}
```

`_pcSeededIndex()` is `scoring.js`'s own copy of `frontend/index.html`'s
`_seededIndex(seedStr, poolSize)` (the same deterministic string-hash used by
Daily Challenge) — duplicated rather than shared because `scoring.js` has no
reach into `index.html`'s globals and vice versa, and both the live client
*and* `backend/db.js` need to call `generatePressureCard()` directly. Because
the seed is `gameId` (the real `games.id`, never a per-player value), every
player sharing one `games` row sees byte-identical cards round for round —
H2H's "identical sequence" falls out of this for free, no sequence pre-rolled
or stored anywhere. **No `target_sector`/`modifier_id` column exists at all**
— grading only ever needs the recorded `darts` for that round plus a
re-derivation of the card that produced it.

`PRESSURE_TARGET_POOL` (14 curated entries, `frontend/scoring.js`) has two
shapes: `{type:'sector', sector, ring, label, difficulty}` (ring one of
`'single'/'double'/'treble'`) and `{type:'finish', score, label,
difficulty:'finish'}` (2, 3, or 4-figure finish targets: 40/81/121).
`PRESSURE_MODIFIERS` (8 entries) carries `{key, label, icon, flavor,
cpMultiplier, missMultiplier?, comebackBonus?, matchDart?, suddenDeath?,
noWarmup?}` — see "The 8 modifiers" below for exactly what each flag changes.

### Grading — two shapes, two paths

**Sector/ring targets** — `gradePressureSectorRound(target, darts,
matchDartOnly)`: "best of the round's darts" — an exact ring+sector match on
ANY dart is a **full** hit; the sector hit but the wrong ring is a
**partial**; neither is a **miss**. Under Match Dart (`matchDartOnly`), darts
1-2 are ignored entirely — only a genuine 3rd dart is ever consulted (fewer
than 3 darts thrown is always a miss under this modifier).

**Finish targets** — `pressureRoundOutcome()` reuses `evaluateVisit()`
**unmodified** (`{score: target.score, doubleOut:true}` — always double-out,
a judgment call this doc settles since the roadmap doc itself didn't pin it
down): a legal double-out finish is a **full** hit, anything else (a bust, an
illegal last dart, a non-double checkout) is a **miss** — there is no partial
tier for a finish target. Under Match Dart, a legal finish reached on dart 1
or 2 does **not** count — `darts.length===3` is required alongside `ev.win`,
since a real visit only ever contains as many darts as were actually thrown
before a checkout ended it.

`darts` passed into any Pressure Chamber grading function must be full
dart-core objects (`makeDartCore()`'s own `{sector, mult, value, isDouble,
...}` shape) — sector grading only reads `.sector`/`.mult`, but finish
grading's `evaluateVisit()` call needs `.value`/`.isDouble` too, so every real
caller (the live client, `backend/db.js`'s write-time guard) always deals in
full dart-core objects, never raw `{sector, mult}` pairs.

### The 8 modifiers — what's digitally enforceable and what isn't

| Modifier | Key | Effect |
|---|---|---|
| Dead Calm | `dead_calm` | Baseline — `cpMultiplier:1.0`, no other flags. |
| Double Down | `double_down` | `cpMultiplier:1.0`, `missMultiplier:2` — doubles the miss penalty only; a full/partial hit's reward is unchanged. |
| Comeback | `comeback` | `cpMultiplier:1.4`, `missMultiplier:2`, `comebackBonus:true` — a full hit adds a flat bonus (half the base CP) on top of the normal reward; a miss doubles the penalty, same as Double Down. |
| Audience | `audience` | `cpMultiplier:1.15`. Flavor/instruction text only (`flavor` shown on the card banner) — unenforceable, honor system. |
| Ghost Leg | `ghost_leg` | `cpMultiplier:1.15`. Same unenforceable honor-system shape as Audience. |
| Sudden Death | `sudden_death`, flag `suddenDeath:true` | `cpMultiplier:1.5`. **Enforced**: the round stops the instant a dart isn't a full hit at all (sector/ring targets only — see below), via a real per-dart engine function, not just flavor text. |
| Match Dart | `match_dart`, flag `matchDart:true` | `cpMultiplier:1.3`. **Enforced**: only the round's 3rd dart counts (see grading above). |
| No Warmup | `no_warmup`, flag `noWarmup:true` | `cpMultiplier:1.25`. **Enforced**: a real 5-second wall-clock deadline (`Date.now()`-based, the Checkout Blitz precedent) from card reveal to dart 1. |

**Sudden Death's per-dart early stop** (`evaluateDartPressureSector(dart,
target)`, mirroring `evaluateDartDoublesPractice()`'s `{hit, ended, reason}`
shape): stops the instant a dart isn't a full hit — including a
partial/wrong-ring hit, per the roadmap doc's own explicit wording. **Judgment
call**: scoped to sector/ring targets only — a finish target under Sudden
Death grades exactly as it would under Dead Calm, since "hit" isn't a single
binary per-dart event the way it is for a sector target (the roadmap doc left
this combination unspecified).

**No Warmup's deadline** is enforced **client-side only**, the same
established limitation Checkout Blitz's own deadline already has (neither
`backend/db.js` nor `server.js` know anything about wall-clock timing — only
`scored`/`bust`/`checkout`/`leg_won` arithmetic is ever validated
server-side). The client auto-commits a genuine miss dart (`sector:0`) the
instant the deadline passes with no dart 1 yet thrown, so the server's
consistency guard always re-derives from the SAME real darts the client
graded — never a client-only "trust me, this was late" flag.

### Composure Points formula

`computePressureRoundResult(card, darts)` (`frontend/scoring.js`):

- **Base CP** by target difficulty (`PRESSURE_BASE_CP`): single 5, double 10,
  treble 15, bull 20. A finish target's base
  (`pressureFinishBaseCp(score)`) instead scales with `checkoutHint()`'s own
  optimal dart count: `10 + optimalDarts*5` (15/20/25 for a 1/2/3-dart
  finish) — a 2-dart finish is worth less than a 3-dart one, per the roadmap
  doc.
- **Miss-penalty base** (`PRESSURE_MISS_PENALTY_BASE`), always smaller than
  the base CP: single 2, double 4, treble 6, bull 8, finish 10.
- **Full hit**: `gained = round(baseCp * modifier.cpMultiplier)`, plus a flat
  `round(baseCp * 0.5)` bonus under Comeback.
- **Partial hit**: `gained = round(baseCp * modifier.cpMultiplier / 2)`.
- **Miss**: `gained = 0` (never negative — satisfies `turns.scored`'s
  existing non-negative validation unchanged); `missPenalty =
  round(missBase * modifier.cpMultiplier * (modifier.missMultiplier || 1))` —
  "base-and-modifier-scaled," per the roadmap doc's own formula wording, with
  Double Down/Comeback's `missMultiplier` doubling it again on top.

All of these numeric constants are a first-pass playtesting default per the
roadmap doc's own explicit framing ("not final") — what's actually tested is
the FORMULA'S SHAPE (base × modifier, half on partial, doubled miss penalty
under Double Down/Comeback), not these specific values.

### Composure Rating

Derived at read time from a run's total CP, never stored (monotonic
thresholds, so "the best rating ever reached" is always just
`pressureComposureRating()` of the single highest total CP ever recorded —
no separate tracking needed):

| Total CP | Rating |
|---|---|
| 120+ | Ice |
| 90–119 | Steel |
| 60–89 | Copper |
| 30–59 | Tin |
| Below 30 | Rattled |

### Data model — `turns.scored`/`bust`/`checkout`/`leg_won`

Reuses Checkout Trainer's exact 3-way outcome verbatim: `bust=1` = miss,
`checkout=1, leg_won=0` = partial, `checkout=1, leg_won=1` = full. No new
columns of any kind — `turns.scored` stores the CP **gained** this round
(never the miss penalty, which is never stored anywhere). A run's total CP
is:

```
total = SUM(scored) − SUM(pressureMissPenaltyForCard(card) for every bust=1 turn)
```

recomputed at read time by re-rolling `generatePressureCard(gameId, round)`
for every missed round — the same "derive the rest, don't store it"
philosophy Halve-It's halving rule already established, just simpler here
since the total isn't order-dependent (a plain `SUM` minus a derived
subtraction, not a running replay — `_pressureChamberLegTotals(mode)` in
`backend/db.js`).

### Consistency guard (SEC-25-style, `addTurn()` in `backend/db.js`)

The round is derived from the player's own prior-turn count in this
game/set/leg (`priorTurns+1`, the same SEC-25 pattern Baseball/Shanghai/
Halve-It's own guards use), rejected outright past round 15 (no extra-rounds
extension exists for this game type — see tie-breaking below). The card is
re-derived via `generatePressureCard(gameId, round)` and
`computePressureRoundResult(card, dartsCore)` recomputes the expected
`scored`/`bust`/`checkout`/`leg_won`; any mismatch is rejected.

### Solo vs. H2H tie-breaking (a judgment call — the roadmap doc's own last open question)

`pressureChamberDecideWinnerIndex(totals)` (`frontend/scoring.js`): highest
total CP wins outright; a CP tie breaks on fewest total misses (the more
composed run); a further tie breaks on fewest darts thrown (efficiency); a
genuine remaining coincidence resolves to whichever player is earlier in turn
order. **Always returns a definite winner** — this app has no distinct "draw"
result/UI class for any other game type, and a real numeric CP total makes an
exact 3-way tie vanishingly unlikely in practice, so this was chosen over
introducing one just for this feature.

### Stats (`GAME_TYPES.pressure_chamber.statDefs` / `PRESSURE_CHAMBER_STAT_DEFS`)

**Stat bubbles** (`getPressureChamberStatBubbles(name, mode)`): Avg Run CP,
Full-Hit Rate, Partial-Hit Rate (all `getPressureChamberStatBubbles`'
`avgCp`/`fullHitRate`/`partialHitRate` — the roadmap doc's own explicit list),
plus Win Rate/Runs Completed/Darts Thrown for parity with Shanghai's/
Halve-It's own bubble sets, and **Honesty %** (`honestyPct` — see the
self-declare mechanic below). `totalCpEarned` (lifetime CP, clamped at 0 per
run before summing) also rides in this response as the achievement-ladder
base — see Achievements below.

### Self-declare honesty mechanic — `turns.declared_hit` + Honesty %

Before each visit's darts are read off the board, the player makes a
**self-declaration**: tapping "🎯 I'll hit it" or "❌ I'll miss" on a declare
screen that sits ahead of the normal dart pad (`renderPadPressureChamber()`
shows the two declare buttons and hides the number pad / S·D·T multi-row until
a call is made; No Warmup's 5-second clock only arms once the call is made, not
when the card first shows). The call is stored on the new nullable
`turns.declared_hit` column (`1` = declared hit, `0` = declared miss, `NULL` =
no declaration / every other game type). It is transient per-visit client state
(`game.pressureDeclared`, reset to `NULL` each turn, never saved or resumed) and
is passed to `db.recordTurn()` as `declaredHit`.

`declared_hit` is **explicitly not a scoring input** and carries no leaderboard
weight. It feeds only the informational **Honesty %** stat
(`getPressureChamberStatBubbles`' `honestyPct`/`declaredRounds`): of every round
where a declaration was made, the percentage that matched the round's real
outcome — a declared hit is honest iff the round graded at least a partial hit
(`checkout=1`), a declared miss is honest iff the round busted (`bust=1`).
`honestyPct` is `null` until at least one declaration exists. Unlike every other
new column there is **no consistency guard** for `declared_hit`: the server can
never prove the declaration was truly made before verifying (a determined client
can submit one matching the outcome in hindsight), so it is an honor-system
self-discipline signal by design. `addTurn()` validates only its shape (`0`/`1`)
and rejects it on any non-`pressure_chamber` game, the same gating
`declared_unsolvable` uses for Checkout Trainer. Covered by
`backend/test/db.pressure-chamber-stats.test.js` (honest→100%, mixed→50%,
undeclared→`null`, and the game-type/shape guards).

**Personal Bests** (`getPressureChamberPersonalBests(name, mode)`):
`bestRunCp` (a peak, no minimum-attempts floor — the Checkout Blitz/Halve-It
precedent), `bestRating` (`pressureComposureRating(bestRunCp)` — see
Composure Rating above for why no separate tracking is needed), and
`longestFullHitStreak` (the best of every completed run's own peak
consecutive-full-hit streak).

**Home page leaderboard**: Best Run CP (`getPressureChamberBestCpLeaderboard(mode)`,
one row per player, their peak total across BOTH won and lost runs — same
no-minimum-floor shape as Halve-It's own board, each row annotated with its
Composure Rating) and Most Pressure Chamber Wins
(`getPressureChamberWinLeaderboard()`, H2H only, identical shape to
Halve-It's/Shanghai's own).

### Achievements

Three data-driven ladders, `chuckinTiersReached()`/`checkChuckinMilestoneTier()`-powered
(the `CHUCKIN_MILESTONE_LADDERS` engine, reused wholesale): **lifetime runs
completed** (`PRESSURE_RUNS_MILESTONE_LADDERS`, 4 tiers, 5/25/100/250),
**lifetime CP earned** (`PRESSURE_CP_MILESTONE_LADDERS`, 4 tiers,
500/2,000/5,000/15,000, base+session fetched once per game like Baseball's
own `lifetimeRunsBase`), and **longest full-hit streak in a single run**
(`PRESSURE_STREAK_MILESTONE_LADDERS`, 3 tiers, 5/8/12 — checked once at run
end against that run's own peak streak, the Bob's 27/Gauntlet-streak
pattern, not a lifetime accumulator).

**Judgment call**: unlike every sibling game type's own leg-outcome badges
(checked only for the match winner in `onLegWon*()`), Composure Rating is a
**personal** achievement even in H2H — the roadmap doc's own Goal section
says "solo players chase their own rating; 2-4 players can run the identical
card sequence head-to-head," meaning a losing player who still reaches Ice
should still earn it. `onLegWonPressureChamber()` therefore checks 🥶 Ice and
every lifetime ladder for **every player**, not just the leg winner (all
players' round-15 turns are already recorded by the time it fires, since the
round only advances once everyone's thrown) — win/loss progression
(`legsWon`/`setsWon`) is still applied to the winner only.

Four one-off flavor badges, all recurring, checked the moment a round is
graded in `enterTurnPressureChamber()`: 🥶 **Ice** (reach the Ice Composure
Rating, 120+ CP, in a single run), 🎯 **Nerves of Steel** (a full hit under
Sudden Death), ⏱️ **No Warmup Needed** (a full hit under No Warmup), 🃏
**Dead Calm, Steady Hands** (a full hit under Dead Calm — "sometimes the
scariest of all," per the roadmap doc).

### Live scoreboard

`renderGamePressureChamber()` (`frontend/index.html`) and
`renderers.pressure_chamber` (`frontend/display.html`) both render a
per-round chalkboard grid (rows = rounds 1-15, cells showing ✅/➗/❌ for a
settled round — icon+text via a `title`/`aria-label`, never color alone) plus
a large, unmissable **Pressure Card banner** below the table: the current
round's target, modifier (icon + label + flavor text), and stakes
(full-hit/miss CP values) — "the whole game hinges on the player registering
what's on the line before they throw," per the roadmap doc's own
accessibility note. A live No Warmup countdown (`aria-live`, cued at 3s/1s
remaining — not every second) shows when that modifier is drawn.
`display.html` has no shared `scoring.js` module, so `liveSnapshot()` sends
the FULL 15-round card sequence up front (`pressureChamberCards`, same
"can't derive it there" reasoning `halveItTargets` already documents) plus
the live round/deadline.

`renderPadPressureChamber()` is deliberately the FULL 1-20+Bull number grid
(the same shape X01's own default Pad-mode grid uses), **not** a single
restricted target button like Halve-It's/Bob's 27's own pads — a finish-
target round can legitimately need a multi-number checkout route, and even a
sector-target round needs to record a genuine off-target hit, not just
"hit or miss." Always Pad-mode, **never the Dartboard SVG** — Sudden Death's
per-dart early stop and No Warmup's wall-clock deadline both need
`throwDart()` to route through this one commit path, not race a second live
input surface. Because of this, Pressure Chamber's own singles are always
zone-unspecified, the same BUG-24 gap class Cricket/Baseball/Shanghai already
have (`noZoneTracking` in `frontend/index.html` includes `'pressure_chamber'`).

### Saved games

Position is a pure function of recorded turns:
`rebuildPressureChamberState({gameId, names, legsPerSet, maxRounds, turns})`
(`frontend/scoring.js`) replays CP totals/misses/full-hit streaks/round
number from the turn sequence, reusing `evaluateVisitPressureChamber()`
directly. Reused identically by `_savedGamePosition()` (write-time) and
`resumeGame()`'s `pressure_chamber` branch (read-time). `'pressure_chamber'`
is in both `SAVABLE_GAME_TYPES` lists (`backend/db.js` and
`frontend/index.html`).

### The self-declare honesty mechanic (build-order step 10, shipped)

The roadmap doc's own build-order step 10 — `declared_hit`, a self-declare
hit/miss step before darts are read, and an Honesty% stat comparing the
declaration against the real outcome — **shipped** as its own v2 item (split out
of the core-game v1 the same way Halve-It's custom target editor was). Its full
data model, the declare-screen UI, the informational Honesty % stat, and the
"no consistency guard, honor-system by design" rationale are documented under
"Self-declare honesty mechanic" above. With this item done,
`docs/archive/pressure-chamber-roadmap.md` is fully complete and moved to
`docs/archive/`.

### Testing

`backend/test/scoring.test.js`: `generatePressureCard()`'s determinism
(including a same-gameId-different-round and different-gameId sweep),
`gradePressureSectorRound()`'s full/partial/miss + Match Dart cases,
`evaluateDartPressureSector()`'s Sudden Death early-stop cases,
`pressureBaseCp()`/`pressureFinishBaseCp()`/`pressureMissPenaltyBase()`'s
scaling, `pressureMissPenaltyForCard()`'s pure-function-of-the-card property,
`computePressureRoundResult()`'s full/partial/miss/Double-Down/Comeback/
finish/Match-Dart-on-a-finish cases, `pressureComposureRating()`'s threshold
table, `isPressureIceRun()`/`isPressureModifierFullHit()`,
`pressureChamberDecideWinnerIndex()`'s CP/misses/darts/order tie-break chain,
`evaluateVisitPressureChamber()`'s round/match-completion timing, and
`rebuildPressureChamberState()`'s replay + leg-progression cases.
`backend/test/db.pressure-chamber-stats.test.js`: stat-bubble formulas
(deriving expected values from the real engine, never hand-picked numbers),
Personal Bests, the best-CP/win leaderboards, and an X01/Cricket/Baseball/
Shanghai/Halve-It/Pressure Chamber cross-contamination regression (both
directions). `backend/test/db.turn-consistency-guard.test.js`: the SEC-25-style
guard's accept/reject cases (a genuine full hit, a claimed-but-unreal full
hit, a genuine miss, an inconsistent 3-way outcome, the 16th-round rejection,
and a finish-target grading case). `backend/test/display.ach-labels-parity.test.js`
extended to cover the 4 new one-off badges and 3 new ladders. Verified
end-to-end with Playwright: the full New Game → Pressure Chamber practice and
H2H flows, a full 15-round solo run to a Composure Rating, badges/stat
bubbles/personal bests/leaderboards via the API, and the live `/display`
scorecard.
