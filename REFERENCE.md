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
- [20. Known Limitations & Open Gaps](#20-known-limitations--open-gaps)
- [21. Troubleshooting](#21-troubleshooting)

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

### Cricket rules — `GAME_TYPES.cricket.evaluateVisit(player, darts, game)` (`frontend/index.html`)

Standard cricket only (v1 scope decision — cut-throat deferred). A match's
in-play numbers are locked to exactly 7, chosen at New Game time: classic
(15, 16, 17, 18, 19, 20, Bull) or a custom 7-of-21 selection, stored as
`game.config.numbers`. Per-player state is `{marks: {sector: count, ...},
points}` — no `score` field, no bust concept.

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
    const opponentOpen = opponents.some(o => (o.marks[d.sector] || 0) < 3);
    if (opponentOpen) pointsThisVisit += newBeyond * d.sector;   // Bull's "sector" is 25
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

**Win condition**: this player has closed all 7 numbers **and** has strictly
more points than every opponent. If they've closed everything but don't lead,
the leg just continues — real cricket lets them keep throwing/blocking
normally, and the per-dart rule above already lets them score against any
opponent still open on a number they've closed, with no extra logic needed.

**Known open edge case, not silently resolved**: an exact points *tie* at the
moment the last number closes is not a win by this rule — the leg continues
with no tie-break implemented. Verified behavior (not a bug): two players
tied 0-0 when the second one closes their last number keep playing.

Leg/set/game progression (`onLegWonCricket`) mirrors X01's `onLegWon`
structurally (legs/sets advance the same way, same `DB.completeGame`/HA
webhook calls). Cricket's two achievements (9 Marks, Perfect Leg — §4) are
detected in `enterTurnCricket()` before it runs; `onLegWonCricket` itself
carries no achievement or Daily Challenge integration, since X01's
clutch/social badges and the Daily Challenge formats don't apply to Cricket.
Cricket's stat vocabulary is documented in §3 ("Cricket stats").

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
(`game.current === game.players.length - 1`, read before `game.current`
advances — the same timing every other `evaluateVisit*()` relies on). A solo
practice game is always "last in rotation," so it advances one inning per
visit. The **win condition is only checked on that round-completing visit,
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
mirrors `onLegWonCricket()` structurally; no achievements or Daily Challenge
integration (X01/Cricket's own don't apply to Baseball either). Scoring
screen (`renderPadBaseball`) reuses Cricket's exact "select a multiplier,
then tap the target" interaction with a single target button (this inning's
number) instead of Cricket's seven. Live scoreboard (`renderers.baseball` in
`display.html`) is the same chalkboard-table shape as Cricket's (rows =
innings 1-9, columns = players), always single-column regardless of
orientation.

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
| Opening-window stats (1st 3/1st 9 avg, 140/leg) | Excluded already | `OPENING_CATS` requires `game_type='x01'` plus `config.startingScore` in `(501,301,170,101)` |
| Checkout-based (Big Fish, ton+ finishes, highest checkout, checkout routes, fewest darts to finish, darts/leg, best leg avg) | Naturally excluded | cricket never writes `checkout=1`, and these are all scoped to won legs / checkout rows |
| Physical-dart stats (Darts Thrown, Darts/Day, Average Pace, dart analytics sector/treble maps, Around the World progress) | **Included** | a dart thrown in cricket is a real dart; these count physical throws, not X01 arithmetic |
| Games / wins / win rate / win streak / H2H records / activity counters (legs, sets, darts, turns, today/this-week) | **Included** | a completed cricket H2H match is a real match; "Games Played" counts completed H2H matches of any game type. Per-category legs/sets **won** (`computeStats()`'s `h2hLegsWonByCat`/`h2hSetsWonByCat`) count a won leg via `(checkout=1 OR leg_won=1)` — X01 signals a won leg with `checkout`, Cricket with `leg_won`. The roster/profile "turns"/"darts thrown" totals are likewise unscoped (a cricket visit is a real visit); only the X01-scoped copies inside `h2hStats`/`practiceStats` feed the averages |

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
same deliberate step that added 170 and 101 here.

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
'chuckin','checkout_trainer','around_the_clock','around_the_world']`) as
defense-in-depth, though it's always an internally-controlled literal, never
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
`throwDartChuckin()` tallies hits into `p.heatmap` (a `{sector_mult: count}`
map) and `p.sessionScore` (feeding the average) on every dart;
`playerSnapshotChuckin()` flattens `p.heatmap` into the same
`{sector,multiplier,hits}` array shape `getChuckinHeatmap()` already returns,
so `display.html`'s renderer (`buildChuckinLiveHeatmap()`, a mirror-copied port
of `buildChuckinHeatmap()`'s SVG geometry — no shared module between the two
files, per the established convention) can feed it straight in. No
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

86 badges (23 X01 + 4 Cricket + 2 Tournament + 3 Daily Challenge + 19 Just
Chuckin' It + 33 Checkout Trainer + 2 Practice Drills) — that split is by
which table each is listed under below (and which section of the Player
Profile's Badge Case each renders in, via `BADGE_INFO`'s
`cricket`/`challenge`/`chuckin`/`tournament`/`checkoutTrainer`/`drill` flags —
anything without one of those flags buckets as X01), not a strict statement
of which game types can trigger it: Checkout Trainer's own 33 badges are
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
live in `enterTurnCricket()`/`onLegWonCricket()`; Daily Challenge's 3 badges
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
  the count past 1): **Around the Clock, Around the World, Grudge Match, First
  100+ Checkout, Full Rotation, Ghost Slayer, Champion, Giant Slayer
  (Tournament)** — the last three are the exceptions to "a direct
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

### The 23 badges, exact trigger conditions

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

**Suppression pairs**: two conditions above are deliberately treated as the same
event wearing two labels, not two distinct achievements — the more specific one
suppresses the generic one when both would otherwise match the same visit:
- **Busted Maximum** suppresses **Ton-titled to Nothing** (a busted 3×T20 is a
  100+ bust by definition).
- **Bullseye Gauntlet** suppresses **Double Trouble** (double-bull-twice is
  technically "last two darts both doubles" too).

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

**Cricket badges** (checked in `enterTurnCricket()`/`onLegWonCricket()`,
`frontend/index.html`). 9 Marks/Perfect Leg (game-modes-roadmap.md build-order
step 3) are the direct analogs of 180 and the nine-darter; Whitewash/Comeback
Kid (Cricket) (2026-07, "New Cricket-native badges") are deliberately *not*
X01 ports — shaped around what makes a Cricket leg dramatic (closing numbers,
points) instead of forcing X01's checkout/remaining-score concepts onto a game
that has neither. Both are 2-player only, same restriction as X01's own
social/margin-of-victory badges, and both have their pure trigger-condition
logic in `frontend/scoring.js` (`isCricketWhitewash()`/
`cricketComebackAchieved()`), unit-tested in `backend/test/scoring.test.js`:

| Badge | Exact condition |
|---|---|
| 🎯 **9 Marks** | `darts.length===3 && marksThisVisit===9` — 3 darts, each a treble on an in-play number, the maximum possible marks in one visit (same framing as 180 being the max possible X01 visit score). **Recurring.** |
| 🏆 **Perfect Leg** | `win && legDarts === theoreticalMinimum`, where the minimum is computed per match from `game.config.numbers`: each non-Bull number can close in a single treble (3 marks); Bull can't be trebled (`makeDart()` already downgrades a "treble bull" tap to a single), so it needs a minimum of 2 darts. A win at exactly this minimum already implies enough bonus marks were scored to strictly lead (the win condition in §2 guarantees that), so no separate points check is needed. **Recurring**, mega-tier overlay (confetti) like Nine-Darter. |
| 🧹 **Whitewash** | `isCricketWhitewash(opp.marks)` at the moment the leg is won — every value in the opponent's `marks` object is `< 3` (nobody closed), checked in `onLegWonCricket(wi)`. 2-player only. **Recurring.** |
| 🔥 **Comeback Kid (Cricket)** | `cricketComebackAchieved(w.legWorstPointsDeficit)` — `legWorstPointsDeficit >= 20` (Cricket's own threshold, chosen against Cricket's much smaller/more variable points scale than X01's 501 countdown, not X01's 100). `legWorstPointsDeficit` is the largest `(opponent.points - my.points)` seen at any point this leg, tracked in `enterTurnCricket()` the same "sample before this visit's own update" timing X01's `legWorstDeficit` uses. 2-player only. **Recurring.** |

**Tournament badges** (`docs/tournament-mode-roadmap.md` §7 — checked server-side
in `_advanceTournamentMatch()`, `backend/db.js`, the same function that already
sets `winner_id`/`champion_id`, rather than a second parallel hook. Like Ghost
Slayer, the frontend never computes these conditions itself — it only detects a
newly-earned badge by diffing `GET /api/players/badges` against the pre-match
`earnedBadgeCache` snapshot, inside `finishUnit()`'s `game.tournamentMatchId`
branch, to fire the live celebration):

| Badge | Exact condition |
|---|---|
| 🏆 **Champion** | Awarded to the winning player exactly where `_advanceTournamentMatch()` sets `tournaments.champion_id` (no `winner_next_match_id` — this was the final). **Once-badge.** |
| ⚔️ **Giant Slayer (Tournament)** | On any tournament match result: `winner's tournament_players.seed - loser's seed >= 3` (`TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD`) — the winner was seeded at least 3 slots worse than the opponent they beat. Never fires on a bye advance (no real opponent was beaten). Mirrors the H2H Giant Slayer's headline concept with a seed-based threshold instead of an average-based one, and uses its own `badgeId` (`tournament_giant_slayer`) rather than the H2H `giantslayer` row, since the two trigger mechanics don't share a meaning. **Once-badge.** |

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

`buildMomentCard({icon, headline, player, statLine, footer})` renders an 800×800
JPEG (quality 0.88) canvas card entirely client-side — no server round-trip, no
image hosting. `fireMomentCard(type, opts)` builds the card, stores it in
`momentCards[type]`, and fires the corresponding Home Assistant webhook
(base64-encoded image) if one is configured. `shareMomentCard(type)` reads the
stored canvas and opens the native Web Share sheet (or falls back to a plain
image download).

**Exception — passive/repeat-view features don't use `fireMomentCard()`
directly**: the On This Day flashback (§3) calls `buildMomentCard()` directly
and skips the HA webhook, since it fires on *every* profile page view, not on a
real occurrence — routing it through `fireMomentCard()` would spam an HA
webhook every time someone opens a profile page.

**Player Profile "Moments" gallery** (`docs/archive/shareable-moments-roadmap.md`):
the Badge Case (§4) doubles as this — every *earned* badge tile gets a 📤 Share
button (`shareEarnedBadge(badgeId)`) that regenerates that badge's card on
demand (icon, label, current player) and shares/downloads it via the same
`shareOrSaveCanvas()` path, independent of whether the achievement overlay is
still showing or was ever tapped at the time. This is a genuine "moment from
the past" replay, not a stored image — resolving the roadmap doc's own open
question ("cache cards, or regenerate on demand?") in favor of regenerating,
consistent with this app's standing "recompute at query time, store nothing
pre-aggregated" philosophy. Not-yet-earned badges (dimmed/greyscale in the
Badge Case) get no Share button, since there's nothing to regenerate.

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

`docs/data-export-roadmap.md`'s original design proposed a per-player,
PIN-gated export reachable from a Player Profile page; that was reopened with
fresh product direction (2026-07) and shipped differently — **admin-only**,
reached from a dedicated admin page (`Settings → Admin & Danger Zone → Data
Export → Export a player…`), not from the Player Profile, and not PIN-gated
(the admin session cookie is the gate, same as the full-database export).

- **`db.getFullDatabaseExport()`** returns `{ exportedAt, players, games,
  gamePlayers, turns, darts, timelineEvents, playerBadges,
  dailyChallengeAttempts, tournaments, tournamentPlayers, tournamentRounds,
  tournamentMatches, dartComponents, loadouts, ghostRaces, leagues,
  leaguePlayers }` — every player/game/stat table (including the four
  tournament tables, `docs/bug-roadmap.md` BUG-6, and the two league tables,
  §18), reformatted as plain JSON. It
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
  daily-challenge/ghost-race participation — see `docs/data-export-roadmap.md`
  for the reasoning.
- **`GET /api/players/export`** (`?name=...`, `requireAdmin`) streams that
  object as a `Content-Disposition: attachment` download named
  `oche-export-<sanitized-name>-<YYYY-MM-DD>.json`. `400` with no `name`
  param, `404` for an unknown player.
- **`db.importPlayerExport(payload)`** (per-player import, admin-only) — the
  counterpart to `getPlayerExport()`. `400`s if `payload.schemaVersion !== 1`
  or the shape is otherwise malformed. Resolves the main player and every
  opponent stub by **`uuid` first** (never `name` alone, since `name` is only
  unique within one server's own roster): a `uuid` match reuses that existing
  local row; no match creates a new row from the exported `uuid`+`name`,
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
  already-loaded `roster` array) + "Export data" button for export, and a
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
| `game_type` | `TEXT NOT NULL DEFAULT 'x01'` | `'x01'`, `'cricket'`, `'baseball'`, `'doubles_practice'`, `'chuckin'`, `'checkout_trainer'`, `'around_the_clock'`, or `'around_the_world'` (`KNOWN_GAME_TYPES` in `backend/db.js`). `createGame()` accepts it as an optional param, defaulting to `'x01'`; each New Game flow passes its own. Nine-darter detection queries filter on this + `config` instead of `category='501'`, and every `scored`-derived stat scopes on it via `X01_ONLY`/`_scope()` (§3). |
| `config` | `TEXT` | JSON — `{startingScore}` for X01 rows (backfilled for rows created before this column existed), `{numbers: [seven in-play numbers]}` for Cricket rows (the source of truth for mark derivation, `CRICKET_MARK_CASE` in §3), `{innings: 9}` for Baseball rows (fixed, not yet a New Game choice), `{doubles: [target sectors]}` for Doubles Practice rows (`DOUBLES_HIT_CASE` in §3), `{}` for Chuckin rows and both guided-drill rows (no config needed — every number/multiplier is always "in play") |
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

### `turns` (one row per visit, indexed on `player_id` and `game_id`)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `game_id` / `player_id` | `INTEGER NOT NULL, FK, ON DELETE CASCADE` | |
| `set_no` / `leg_no` | `INTEGER NOT NULL` | Must be a positive integer (`addTurn()` rejects `0` or negative explicitly — an explicit `0` is validation-rejected, not silently treated as the "omitted" default of `1`) |
| `scored` | `INTEGER NOT NULL` | Effective points — `0` on a bust, app-computed (not a raw dart sum). Means "X01 countdown points" for `game_type='x01'` but "cricket points earned this visit" for `game_type='cricket'` — same column, different quantity (see `X01_ONLY` in §3). `addTurn()` rejects a non-numeric value outright rather than silently coercing it to `0`. For `game_type='x01'` specifically, `POST /api/games/:id/turns` (the one production caller that opts into `addTurn()`'s `enforceConsistency` flag) additionally rejects a `scored` that doesn't match the sum of that visit's dart face values (`0` required on a bust; `checkout_points` must equal `scored` on a checkout) — `docs/security-audit-roadmap.md` SEC-22. Deliberately X01-only: Cricket's `scored` is computed from mark-closing state, not a dart-value sum, so the same rule would reject legitimate Cricket visits |
| `bust` / `checkout` | `INTEGER NOT NULL DEFAULT 0` | Booleans. Cricket turns always write `bust=0, checkout=0` — cricket has neither concept. Doubles Practice repurposes `bust` as "this dart ended the round" (so-close or wrong-double, §2) — the closest existing column to that meaning, since this mode has no bust/win concept of its own either; `checkout` stays `0` always. Guided Around the Clock repurposes `bust` the identical way: `1` marks whichever dart completed the round (all 20 numbers hit) — there's no "so-close"/"wrong-target" failure mode here, only completion or abandonment. Guided Around the World writes `bust=0` always (no round to end, matching Chuckin's own turns) |
| `checkout_points` | `INTEGER` | Only set when `checkout=1` (X01 only) |
| `leg_won` | `INTEGER NOT NULL DEFAULT 0` | Game-type-agnostic "this turn won the leg" signal, set only by Cricket's write path (`enterTurnCricket()`) — Cricket has no checkout mechanism, so its Personal Bests (fewest darts to close, best MPR in a leg) need their own marker instead of reusing `checkout` (which keeps its narrower X01 double-out meaning). X01 turns always leave this `0` and its own Personal Bests keep using `checkout=1`, unchanged |
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

### Tournament mode (`docs/tournament-mode-roadmap.md`, single-elimination only — see §15)

**`tournaments`**
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `name` | `TEXT NOT NULL` | |
| `category` | `TEXT NOT NULL` | X01 starting score as a string: `'501'`\|`'301'`\|`'170'`\|`'101'` — every match in the tournament uses this same format |
| `bracket_type` | `TEXT NOT NULL DEFAULT 'single_elim' CHECK (IN ('single_elim','double_elim'))` | Always `'single_elim'` today — the column exists so a future double-elimination pass (tracked separately, not yet started) needs no migration |
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
| `bracket` | `TEXT NOT NULL DEFAULT 'winners' CHECK (IN ('winners','losers','grand_final'))` | Always `'winners'` today (no losers bracket in single-elim) |
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
| `loser_next_match_id` / `loser_next_slot` | `INTEGER` / `INTEGER` | Always `NULL` in v1 (single-elim has no losers bracket) — reserved for a future double-elimination pass, per the roadmap doc's original schema design |

A match's **status** (`pending`/`ready`/`in_progress`/`complete`) is derived at read
time by `getTournament()`, never stored: `winner_id` set → `complete`; else `game_id`
set → `in_progress`; else both player slots filled → `ready`; else `pending`. Same
"compute from raw data" philosophy as the rest of the schema (§1).

### League mode (`docs/league-mode-roadmap.md`, X01 or Cricket — see §18)

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

### Cascade summary

Deleting a `player` cascades: their `game_players` rows, `turns` (and
transitively their `darts`), `player_badges`, `daily_challenge_attempts`,
`tournament_players`, their `dart_components`/`loadouts` rows, and their
`ghost_races` rows. `deletePlayer()`
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

`docs/tournament-mode-roadmap.md`. Single-elimination only — double-elimination
is explicitly deferred (tracked as its own Not-started item on
`docs/open-roadmap-items.md`; the schema's `winner_next_*`/`loser_next_*`
pointer-pair design already supports it without a migration, see §13). X01
only — any of the four starting scores (501/301/170/101). Backend:
`backend/db.js`'s tournament section. Frontend: `frontend/index.html`'s
"TOURNAMENT MODE" block, reachable via the **Tournaments** nav button.

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

Given N players and `bracketSize` = the smallest power of two ≥ N:

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

### Match lifecycle

1. **`startTournamentMatch(matchId)`**: validates the match is `ready` (both
   players known, no `winner_id`, no `game_id` yet already), then calls
   `createGame()` with that round's own `legs_per_set`/`sets_per_game` and the
   two players' own current out-mode preference, and stores the resulting
   `game_id` back on the match row.
2. **On completion**: an `onGameCompleted` hook (registered once at module
   load — see §1's "Game-lifecycle hooks") checks whether the finished game's
   id matches a `tournament_matches.game_id`; if so it calls
   `_advanceTournamentMatch(matchId, winnerId)`, which records the winner,
   marks the loser `eliminated` in `tournament_players`, and either fills the
   winner into `winner_next_match_id`'s slot or — if there is no next match
   (this was the final) — sets `tournaments.champion_id`/`runner_up_id`/
   `status='completed'`/`completed_at` and marks the winner `champion`.
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

### Deliberately out of scope for this pass

- **Double-elimination** — schema supports it (§13), generation/advancement
  logic doesn't exist yet. Tracked separately on `docs/open-roadmap-items.md`.
- **A "Practice this" style deep link or bracket-tree drag/zoom** — not
  requested; the simple column layout was sufficient for single-elimination's
  much shallower tree (no winners/losers split to manage).

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

### The generalized dartboard heatmap (X01, Cricket, Doubles Practice, Chuckin)

Originally Chuckin-exclusive (`getChuckinHeatmap()`/`buildChuckinHeatmap()`);
generalized since `darts` is the one universal per-dart table every game type
writes into. `getChuckinHeatmap(playerName, mode)` is now a thin wrapper
around `getDartHeatmap(playerName, gameType, mode)`, scoped via the same
`_scope({mode, gameType})` helper every other per-game-type query already
uses. `GET /api/players/chuckin-heatmap` is kept exactly as-is for backward
compatibility; `GET /api/players/dart-heatmap?name=&gameType=&mode=` is the
generalized surface. The Player Profile's "Dartboard Heatmap" section
(`dart-heatmap-section`/`dart-heatmap-body`, inside the shared `chartSection`
markup) now shows on all four game-type tabs instead of Chuckin only —
`loadDartHeatmap()` fires for whichever tab is currently active, replacing the
old `if(playerGameType !== 'chuckin') return` early-out.

`buildDartHeatmap(cells, {ariaLabel})` renders three things per number: the
inner-single and outer-single regions (each independently shaded by hit
count), and the miss ring (shaded by `missHeat(wedge, depth)`, its **own
independent heat-scale normalization**, not shared with the scoring regions,
since hit and miss counts are wildly different population sizes per player).
A **zone-unspecified single** (Pad mode, or a pre-feature row) is excluded
from the heatmap entirely, by product decision — real hit data, just not
attributable to inner or outer, so rather than show any visual trace of it,
it's simply not plotted. (An earlier version drew a faint diagonal hatch
overlay across both single regions for that number instead of omitting it —
changed 2026-07 per a live user bug report: the hatch box read as a display
glitch, not a meaningful third state.) It's still never silently folded into
either real bucket or split 50/50 — omitted is not the same as miscounted.
The flat `topSectors` list is a separate surface and keeps its own distinct
textual treatment (`dartLabelFromParts()` appends `" (zone unknown)"` to a
zone-less single, never to a double/treble/bull, which never had a zone
concept at all) — unaffected by this change, since that's a text list, not
the heatmap.

### Testing

`backend/test/db.chuckin-stats.test.js`'s "getDartHeatmap — zone-scoped
grouping" and "getBounceOutCount" describe blocks; `backend/test/db.turn-
validation.test.js`'s "addTurn — zone/missZone/missDepth/bounced validation"
block; `backend/test/scoring.test.js`'s regression proving this metadata never
changes `evaluateVisit()`'s outcome. See `docs/archive/dartboard-zone-tracking-
roadmap.md`'s own "Testing" section for the full list, including a manual
end-to-end Playwright verification pass against a running server.

---

## 18. League Mode

`docs/league-mode-roadmap.md`. X01 or Cricket, per `leagues.game_type`
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

- **New Game "log to league?" picker**: `updateLeaguePicker()`, modeled
  directly on the existing H2H-record banner (`updateH2HBanner()`) including its
  same abort-token pattern for a rapidly-changing selection. Calls `GET
  /api/leagues/eligible?players=A,B&category=&gameType=` reactively whenever
  the H2H opponent pair, game type, category (X01 starting score, or Cricket's
  classic-vs-custom preset), or custom-vs-classic Cricket toggle changes; shows
  a `<select>` only when more than one active league matches (the 0-or-1-match
  case tags server-side with no picker at all). `setup.leagueId` threads
  through `startGame()`'s `game` object and `DB.beginGame()`'s `POST
  /api/games` payload — purely a hint the server-side hook re-validates, never
  trusted outright.
- **League setup screen**: a `game_type` toggle (X01/Cricket, mirroring the New
  Game screen's own toggle) alongside the existing category picker, which
  switches between the X01 starting-score `<select>` and a Cricket
  classic/custom `<select>` depending on the chosen game type
  (`setLeagueGameType()`, `renderLeagueSetup()`).
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

### Deliberately out of scope for this pass

- **Cricket (or any non-X01) leagues** — the standings math is game-type-
  agnostic (Cricket already has full H2H parity — `winner_id`, a win
  leaderboard), but `leagues.category` would need a second `game_type` column
  and the setup screen a game-type selector; deferred as a clean, separately-
  scoped follow-up rather than built speculatively now.
- **Multi-league auto-tagging** — a game only ever tags into **one** league
  (`games.league_id` stays a single nullable FK); a player can be enrolled in
  several concurrent leagues, but any one game they play logs to at most one of
  them (resolved via the picker when genuinely ambiguous, per above).
- **League deletion** — matches tournament mode's own precedent (create + read
  + one state-changing lifecycle action, no delete route); a league can only be
  ended, never removed, short of `wipeAllData()`.

---

## 19. Checkout Trainer

Full design: `docs/checkout-trainer-roadmap.md`. A pure mental-recall drill —
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
staged up-to-3-dart visit.

**Game type**: `checkout_trainer`, one of `KNOWN_GAME_TYPES` (`backend/db.js`).
Every dart-count attempt is its own 1-3 dart `turns` row — the same per-dart-
turn shape Doubles Practice/Just Chuckin' It already use — reusing
`evaluateVisit()` (`frontend/scoring.js`) completely unmodified: a checkout
attempt genuinely IS a normal X01 visit starting from `remaining = target`.

**Schema**: `turns.target_score INTEGER` (nullable) — the target offered for
that round; only ever populated for this game type, since (unlike X01) there's
no persistent "remaining score" state to derive it from afterward.
`games.config.mode`: `'freeform' | 'blitz'` — a mode flag, not a second
`game_type`, since both sub-modes share identical target selection and grading
and differ only in pacing/scoring (the same relationship X01's own H2H-vs-
Practice split has within one `game_type`). `games.config.durationSec`: fixed
at `60` for Blitz, `null` for Freeform. `games.config.difficulty`: one of
`'under40' | 'under100' | 'over100' | 'full'` (default `'full'`) — set once at
New Game via the Checkout Trainer options section's difficulty toggle
(`setCheckoutTrainerDifficulty()`, `frontend/index.html`) and immutable for the
rest of that session, same "baked into `config` at `startGame()`" treatment
`mode`/`durationSec` already get.

**Grading** (`frontend/scoring.js`):
- `pickCheckoutTarget(doubleOut, rng, difficulty)` — picks a uniform-random
  integer target within the selected difficulty tier's `[low,high]` bound
  (`CHECKOUT_TRAINER_DIFFICULTY_TIERS`), intersected with the out-mode's own
  floor (`2` under double-out since `1` is an unfinishable bogey, `1` under
  single-out). `difficulty` defaults to `'full'` (`[1,170]` intersected with
  the out-mode floor — the original, tier-less range) when omitted or
  unrecognized, so every pre-existing caller keeps working unchanged. Tiers:
  `under40` `[1,39]`, `under100` `[1,99]`, `over100` `[100,170]`, `full`
  `[1,170]`. Re-rolls while `checkoutHint()` reports the candidate
  unfinishable, reusing `checkoutHint()`'s own `''` unfinishable signal
  instead of a separate hardcoded bogey-number list.
- `gradeCheckoutAttempt(target, doubleOut, darts)` — returns
  `{legal, usedDarts, optimalDarts, optimal, hint}`. `legal` mirrors
  `evaluateVisit()`'s `win` flag (reached exactly zero, valid last dart under
  double-out). `optimal` additionally requires `usedDarts === optimalDarts`
  (`optimalDarts` = `checkoutHint(target, doubleOut, 3)`'s token count) —
  grading is by dart **count**, not exact route match, since multiple routes
  can tie for the objective minimum.

Every attempt writes exactly one of three outcomes onto the existing
`bust`/`checkout`/`leg_won` columns (no new columns needed beyond
`target_score`): `bust=1` = not a legal finish; `bust=0, checkout=1, leg_won=0`
= legal but not optimal; `bust=0, checkout=1, leg_won=1` = optimal. Checkout
Blitz's scoring formula reads directly off this three-way outcome.

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
- **Toughest Checkout Solved** = `MAX(target_score)` where `leg_won=1`.
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

Plus five one-off flagship badges: 🐟 **The 170 Club** (solve 170 optimally),
🎯 **One-Darter** (first 1-dart optimal solve), 🌟 **Perfectionist** (end a
15+-attempt Freeform session with a 100% optimal rate — checked in
`askEndGame()`), 💎 **Perfect Minute** (every round in a 5+-round Blitz run
graded optimal — checked in `endBlitzRun()`), 📸 **Photo Finish** (a legal
Blitz round submitted with under 1 second left on the clock).

**No live scoreboard**: this game type never writes to `liveState` and
`/display` never renders it — `pushLive()` is a deliberate no-op for
`game.gameType === 'checkout_trainer'`, a genuinely simpler surface than every
other mode in that one respect.

**Deferred (not built)**: the trick-question/bogey-number difficulty variant
("declare this unsolvable") and its conditional 💣 Bogey Buster badge, and
difficulty tiers (under-40/under-100/full-range) beyond the single full-range
(2-170) target pool — both tracked as their own open items on
`docs/open-roadmap-items.md` rather than left silently unbuilt.

---

## 20. Known Limitations & Open Gaps

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
- **Double-elimination tournaments aren't built** — single-elimination only
  (§15); the schema already supports double-elim without a migration, but the
  generation/advancement logic doesn't exist yet. Tracked as its own item on
  `docs/open-roadmap-items.md`.
- See the individual `docs/*.md` files for full design detail on every other
  not-yet-built feature (league mode, Baseball/other game-mode variants,
  camera scoring, mobile app, online multiplayer, and more).

---

## 21. Troubleshooting

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
