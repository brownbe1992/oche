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
- [15. Known Limitations & Open Gaps](#15-known-limitations--open-gaps)
- [16. Troubleshooting](#16-troubleshooting)

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
│   ├── scoring.js    Pure scoring logic (evaluateVisit/evaluateVisitCricket/checkout
│   │                 math), extracted from index.html so it's unit-testable
│   └── display.html  Read-only live scoreboard for a second screen
```

- **Backend**: a single `http.createServer` with zero npm dependencies. Uses
  `node:sqlite` (`DatabaseSync`, built into Node 22.5+) in WAL mode with foreign
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
  `statDefs` per type — `x01` and, as of the Cricket build, `cricket`.
  `game.gameType` is stamped once in `startGame()`; every downstream caller
  (`enterTurn`, `startNextLeg`, `liveSnapshot`) dispatches through
  `GAME_TYPES[game.gameType]` instead of calling those functions directly, and
  `display.html`'s `renderers[s.gameType]` table reads the same field. Cricket's turn
  commit/leg-progression/scoring-screen rendering (`enterTurnCricket`,
  `onLegWonCricket`, `renderGameCricket`, `renderPadCricket`) are separate sibling
  functions dispatched from the shared `enterTurn`/`onLegWon`/`renderGame`/`renderPad`
  entry points, rather than branches inside the X01-heavy originals — Cricket has no
  achievements, bust concept, or checkout hints, so forcing it through the same code
  would mean a lot of irrelevant branching. See §2 for Cricket's scoring rules.
- **Game-lifecycle hooks** (`backend/db.js`, `docs/existing-app-prep-roadmap.md`
  item 4): `onGameCreated(fn)`/`onGameCompleted(fn)` register listener callbacks;
  `createGame()`/`completeGame()` fire theirs synchronously, in registration
  order, right after their core DB write (`created` payload:
  `{gameId, gameType, practice, category, playerCount}`; `completed` payload:
  `{gameId, winnerName}`). A throwing listener is caught and logged, not
  rethrown, so a broken future feature can't take down game creation/completion
  itself. Pure infrastructure today — no listeners are registered — meant for
  the next feature that needs to react to a game starting/finishing (HA
  polling, tournament bracket advancement, league standings) without editing
  these two core functions again. Does not touch the existing client-side
  achievement checks (`frontend/index.html`'s `enterTurn()`/`onLegWon()`), a
  different layer entirely.
- **Server error log** (`backend/db.js`'s `server_errors` table,
  `docs/testing-and-observability-roadmap.md` Part A): `server.js`'s top-level
  `catch` calls `db.logServerError({method, path, status, message})` alongside
  its existing `console.error`, for `status >= 500` responses only — a 4xx is an
  expected client mistake (bad login, invalid PIN), not a server fault worth a
  diagnostic entry. `logServerError()` prunes to the most recent 500 rows on
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
undo (`undoLastTurnCricket()`, dispatched from `undoLastTurn()`) — no
achievements/challenge state to restore, just `marks`/`points`/dart counts.

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
| Opening-window stats (1st 3/1st 9 avg, 140/leg) | Excluded already | `OPENING_CATS` restricts to category `'501'`/`'301'` |
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
| **1st 3 AVG** | first-visit-only | `AVG(scored)` of each leg's first visit (`ROW_NUMBER()...rn=1`). **Scoped to 501/301 only** — see below. |
| **1st 9 AVG** | 3-dart-avg | Sum of the first ≤3 visits' `scored`, over the bust-as-3 dart denominator, ×3, averaged across legs. **Scoped to 501/301 only.** |
| **100+ AVG** | per-visit-avg | `% of legs where SUM(scored)/COUNT(turns) >= 100` — **note this denominator is turns, not darts** (see conventions table) |
| **90- AVG** | per-visit-avg | same shape, `<= 90` |
| **140/Leg** | first-visit-only | `% of opening visits scoring >=140`. **Scoped to 501/301 only.** |
| **180s/Leg** | fraction | `legs containing ≥1 180 / total legs` |
| **Average Pace** | — | darts/minute, returned as the `pace` key — same formula as the Home page/chart versions (consecutive `thrown_at` gaps within a turn, clamped to `0 < gap < 60000ms`); `null` (bubble shows "—") until per-dart timing data exists. *Note: this key was missing from `getPlayerStatBubbles()`'s return object until the audit that produced this manual caught it — the bubble was permanently blank before that.* |

**Why 1st 3 AVG / 1st 9 AVG / 140/Leg are scoped to 501/301 only**: a 170 leg is
short enough that "first visit" isn't a meaningful opening-strength window (it
routinely finishes in one visit, and can bust on that very first visit — which
501/301 legs can't structurally do at that low a remaining score); Daily
Challenge's non-scoring formats (Bullseye Gauntlet, Steady Hand, Treble Run) use
a filler `1000` starting category that isn't a real X01 leg at all. This
restriction is applied via a literal `AND g.category IN ('501','301')` clause,
referred to in the code as `OPENING_CATS`.

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

### Ghost Opponent (`docs/ghost-opponent-roadmap.md`) — race a replay of your own past leg

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
leaderboard/badge eligibility.

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
(`docs/existing-app-prep-roadmap.md` item 1) — `gameType` is whitelisted
against `KNOWN_GAME_TYPES` (`['x01','cricket']`) as defense-in-depth, though
it's always an internally-controlled literal, never raw request input.
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

---

## 4. Achievements & Badges

22 badges (20 X01 + 2 Cricket), tracked in the `player_badges` table (one row
per player+badge, with a running `count`). X01 detection logic lives in
`frontend/index.html`'s `enterTurn()`/`onLegWon()`; Cricket's 2 badges live in
`enterTurnCricket()`/`onLegWonCricket()`.

### Award modes

- **Recurring** (`once:false`): `awardRecurringBadge(player, badgeId, momentType,
  momentOpts)` → `POST /api/badges/award {once:false}` → `count` increments on
  every genuine occurrence (`ON CONFLICT ... DO UPDATE count=count+1`).
- **Once** (`once:true`): a direct `Backend.send('POST','/api/badges/award',
  {once:true})` call, checked for `newlyEarned` before celebrating — used for
  state-based badges whose trigger condition stays true forever once crossed
  (`INSERT OR IGNORE`, so re-checking an already-true condition never inflates
  the count past 1): **Around the Clock, Around the World, Grudge Match, First
  100+ Checkout**.

### The 20 badges, exact trigger conditions

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
| 😅 **Ton-titled to Nothing** | `bust && sum of attempted dart values >= 100` |

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
| 🦉 **Night Owl** | Local hour `< 5` at the moment the turn is **committed** (`enterTurn()` — checked per turn, not per individual dart tap). Celebration overlay fires once per session (`sessionBadgesShown.nightOwl`); the persistence call fires every qualifying turn regardless. |
| 🐦 **Early Bird** | Local hour `>= 5 && < 7`, same per-turn check and once-per-session overlay gating as Night Owl. |
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

**Cricket badges** (checked in `enterTurnCricket()`/`onLegWonCricket()`,
`frontend/index.html` — game-modes-roadmap.md build-order step 3, the direct
analogs of 180 and the nine-darter):

| Badge | Exact condition |
|---|---|
| 🎯 **9 Marks** | `darts.length===3 && marksThisVisit===9` — 3 darts, each a treble on an in-play number, the maximum possible marks in one visit (same framing as 180 being the max possible X01 visit score). **Recurring.** |
| 🏆 **Perfect Leg** | `win && legDarts === theoreticalMinimum`, where the minimum is computed per match from `game.config.numbers`: each non-Bull number can close in a single treble (3 marks); Bull can't be trebled (`makeDart()` already downgrades a "treble bull" tap to a single), so it needs a minimum of 2 darts. A win at exactly this minimum already implies enough bonus marks were scored to strictly lead (the win condition in §2 guarantees that), so no separate points check is needed. **Recurring**, mega-tier overlay (confetti) like Nine-Darter. |

### Description text

Every badge (except 180/Big Fish/Nine-Darter, which are older top-level stats,
not `player_badges` rows) has an entry in `BADGE_INFO` (`frontend/index.html`) —
`{ icon, label, desc }`. The `desc` field is reused verbatim in three places:
the Badge Case tooltip, the live achievement overlay's explanation line, and the
screen-reader announcement (§11). There is no separate copy to maintain in
three places — if you change a badge's description, change it once in
`BADGE_INFO`.

Four badges' live-overlay "type" key differs from their persisted `badge_id`
(a historical naming mismatch, bridged by `ACH_TYPE_TO_BADGE_ID`):
`first100checkout`→`first_100_checkout`, `grudgematch`→`grudge_match`,
`aroundtheclock`→`around_the_clock`, `aroundtheworld`→`around_the_world`.

### Undo interaction

`trackBadgeForUndo(snap, player, badgeId)` is called every time a badge is
awarded, appending to that turn's `snap.badgeReverts` list. If `undoLastTurn()`
runs before an async `once`-badge's award response arrives, `snap.voided` is set
`true` first — so the late-arriving award response revokes itself immediately
on arrival (`POST /api/badges/revoke`) instead of registering into a revert list
that will never be read again, regardless of which happens first.

---

## 5. The Achievement Queue (Simultaneous Achievements)

A single turn (or leg win, or an async milestone confirmation) can genuinely
earn more than one badge at once — e.g. a decider leg won after a big comeback
against a stronger opponent is Comeback Kid *and* Nerves of Steel *and* Giant
Slayer simultaneously. The overlay can only show one thing at a time, so every
celebration is queued and drained sequentially rather than the newest one
silently clobbering whatever was already showing.

**`queueBadge(type, player)`** — pushes `{type, player, ts}` onto
`achievementQueue`; if nothing is currently draining, kicks off
`pumpAchievementQueue()`.

**`pumpAchievementQueue()`** — dequeues one item, sets `pendingAchievement`
(the field broadcast to `/display` — see §7) to that item, calls `pushLive()`
so this specific item gets its own broadcast (not just whatever `pushLive()`
call happened to already be at the end of `enterTurn()`), calls
`showAchievement()` to paint the overlay, calls `announce()` for the
screen-reader region (§11), then sets a timer for `ACH_DURATION[type]` (2500ms
default, up to 6000ms for a nine-darter) that hides the overlay and recurses
into `pumpAchievementQueue()` again — draining the rest of the queue one item
at a time, each getting its own full display duration.

**`showAchievement(type, player)`** — the pure "paint one badge" primitive:
sets the overlay text/name/description, toggles the mega-celebration class for
nine-darters (with confetti), shows the Share button. It never manages timing
itself — that's entirely `pumpAchievementQueue()`'s job — and as of the queue
rework it's *only* ever called from `pumpAchievementQueue()`, never directly.

**Moment card + count**: `awardRecurringBadge(player, badgeId, momentType,
momentOpts)` fires the overlay celebration synchronously (via `queueBadge`,
before any network round-trip), but defers firing the shareable moment card
until the `POST /api/badges/award` response confirms the real count — if
`count > 1`, `" · Earned N× total"` is appended to the card's `statLine`. This
is deliberate: the celebration is never delayed waiting on the network, but the
card (which the player looks at a moment later, if at all) gets accurate data.

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
Cricket: `marks`/`points`/darts breakdowns via `playerSnapshotCricket`),
current visit's darts, checkout hint (X01 only — always empty for Cricket),
status, `pendingAchievement` (§5), one-shot fields (`lastTurnEvent`,
`matchResult`, `legStart` — cleared immediately after each push, so they only
ever announce once), and a `checkoutTarget` for voice announcements.
`ALLOWED_LIVE_KEYS` on the server allow-lists exactly these top-level fields
(not the per-player shape inside `players`, which is how Cricket's differently-
shaped player objects pass through unchanged) — anything else in a
`POST /api/live` body is silently dropped (413 if the sanitized payload still
exceeds 64KB).

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

- **Admin login**: default threshold 5 failed attempts (`DEFAULT_ADMIN_LOCKOUT_THRESHOLD`),
  configurable 1–1000 in Settings. 5-minute lockout.
- **Player PIN**: default threshold 10 (`DEFAULT_PIN_LOCKOUT_THRESHOLD`), same
  configurable range, same 5-minute lockout.
- Both counters use a `RETURNING`-based `UPDATE` (`bumpLoginFail`/`bumpPinFail`)
  so the lockout decision compares against the actual post-increment persisted
  count, not a value read before the async `verifySecret()` yield — this closes
  a race where concurrent failed attempts could each read the same stale count
  and let an extra guess past the threshold.
- Per-account lockout is a deliberate, accepted-tradeoff defense, not a
  complete one — an attacker who knows a username/player name can still grief
  that one account into lockout. The per-IP rate limiter (below) is the primary
  defense against a flood; lockout is the backstop for slow, distributed attempts.

### Rate limiting (`server.js`, `rateLimit(bucket, ip, max, windowMs)`)

| Bucket | Limit | Applies to |
|---|---|---|
| `global` | 300 req / 60s per IP | Every request, before routing |
| `setup` | 10 / 60s per IP | `POST /api/setup` only |
| `login` | 10 / 60s per IP | `POST /api/login` only |
| `pin` | 10 / 60s per IP | `POST /api/players/verify-pin` only |

Each bucket is separate specifically so gameplay PIN checks never get throttled
by unrelated setup/login traffic (they were briefly merged into one shared
`'auth'` bucket during development and caused exactly this cross-endpoint
interference — kept split ever since). `clientIp()` only trusts
`X-Forwarded-For` when `TRUST_PROXY=true` is explicitly set.

### `OCHE_REQUIRE_AUTH` — the write-gating switch

Two auth gates exist: **`requireAdmin`** always requires a logged-in admin
session; **`requireWrite`** is a no-op (public) unless `OCHE_REQUIRE_AUTH=true`,
in which case it behaves exactly like `requireAdmin`. By default the app trusts
its LAN — reads and gameplay writes (recording turns, starting games, awarding
badges) are open, and only destructive/admin actions require login. Setting
`OCHE_REQUIRE_AUTH=true` locks every write behind an admin session, for
internet-exposed deployments.

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
`docs/security-audit-roadmap.md` SEC-10).

### Sessions

Server-side, keyed by a SHA-256 hash of the raw token (the raw token itself is
never stored) — the client only holds an `HttpOnly`, `SameSite=Strict` cookie
(`Secure` too, when `COOKIE_SECURE=true`). 30-day TTL. Expired sessions are
lazily deleted on lookup and swept on every successful login.

### Known, accepted gaps

None currently open. `POST /api/ha-webhook` (the inbound trigger that fires an
already-configured HA webhook) is gated by `requireWrite` like every other
state-changing endpoint (SEC-7, `docs/security-audit-roadmap.md`) — public by
default (LAN trust) unless `OCHE_REQUIRE_AUTH=true`, in which case it requires a
logged-in admin session the same as `POST /api/games` or any other write.

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

### Input paths

Pad mode (number grid + Single/Double/Treble buttons, ordinary focusable
`<button>` elements) is a fully non-visual-board-dependent way to score — not
just an alternate UI skin. `default_scoring_input` in Settings picks which mode
a new game opens with.

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

### Known open gaps

Small (11-12px) secondary text sizes haven't been checked against a
minimum-readable guideline. See `docs/accessibility-roadmap.md` for the full
standing checklist and priority order.

---

## 12. Backups

`node backend/backup.js` — uses `node:sqlite`'s built-in `backup()` API (not a
plain file copy), since the database runs in WAL mode and recent writes can
still be sitting in a separate `-wal` file that a naive `cp` would miss.
Writes a timestamped snapshot to `<data-dir>/backups/darts-<timestamp>.db`,
then prunes anything older than `BACKUP_RETENTION_DAYS` (default 7). No new
dependencies. Intended to be run via host cron (see README for the recommended
crontab line).

**To restore**: stop the app, replace `darts.db` with the chosen backup file,
remove any stale `darts.db-wal`/`darts.db-shm` sitting next to it, restart.

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
| `out_mode` | `TEXT NOT NULL DEFAULT 'double'` | `'double'` \| `'single'` — default checkout rule |
| `created_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` | |
| `dart_weight` | `INTEGER` | Current default weight in grams; snapshotted per-game into `game_players.dart_weight` |
| `pin_hash` / `pin_salt` | `TEXT` | scrypt hash/salt; `NULL` = no PIN, anyone may play as this player |
| `pin_fail_count` | `INTEGER NOT NULL DEFAULT 0` | Incremented via `RETURNING` (see §9) |
| `pin_locked_until` | `INTEGER` | Epoch ms |

### `games`
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `category` | `TEXT NOT NULL` | For X01 games: the starting score as a string (`'501'`/`'301'`/`'170'`, or a filler `'1000'` for Daily Challenge's non-scoring formats). Cricket games write a display label instead (`'Cricket (15-20, Bull)'` or `'Custom Cricket'`). Category-scoped stat filters (`OPENING_CATS`'s `IN ('501','301')`, nine-darter detection) either match X01 values explicitly or filter on `game_type`+`config`, so the cricket labels never collide with them |
| `legs_per_set` / `sets_per_game` | `INTEGER NOT NULL` | |
| `created_at` / `completed_at` | `TEXT` | `completed_at` is `NULL` for in-progress/abandoned games |
| `winner_id` | `INTEGER REFERENCES players(id) ON DELETE SET NULL` | |
| `practice` | `INTEGER NOT NULL DEFAULT 0` | Explicit practice flag, set at creation |
| `game_type` | `TEXT NOT NULL DEFAULT 'x01'` | `'x01'` or `'cricket'` (`KNOWN_GAME_TYPES` in `backend/db.js`). `createGame()` accepts it as an optional param, defaulting to `'x01'`; the Cricket New Game flow passes `'cricket'`. Nine-darter detection queries filter on this + `config` instead of `category='501'`, and every `scored`-derived stat scopes on it via `X01_ONLY`/`_scope()` (§3). |
| `config` | `TEXT` | JSON — `{startingScore}` for X01 rows (backfilled for rows created before this column existed), `{numbers: [seven in-play numbers]}` for Cricket rows (the source of truth for mark derivation, `CRICKET_MARK_CASE` in §3) |
| `player_count` | `INTEGER` | **Frozen** participant count at creation (not a live subquery) — see §3's mode-scoping note |

### `game_players` (composite `PRIMARY KEY (game_id, player_id)`)
| Column | Type | Notes |
|---|---|---|
| `game_id` | `INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE` | |
| `player_id` | `INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE` | |
| `out_mode` | `TEXT NOT NULL DEFAULT 'double'` | Per-game checkout rule actually used (may differ from the player's current default) |
| `dart_weight` | `INTEGER` | Snapshot of `players.dart_weight` at game start |

### `turns` (one row per visit, indexed on `player_id` and `game_id`)
| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `game_id` / `player_id` | `INTEGER NOT NULL, FK, ON DELETE CASCADE` | |
| `set_no` / `leg_no` | `INTEGER NOT NULL` | Must be a positive integer (`addTurn()` rejects `0` or negative explicitly — an explicit `0` is validation-rejected, not silently treated as the "omitted" default of `1`) |
| `scored` | `INTEGER NOT NULL` | Effective points — `0` on a bust, app-computed (not a raw dart sum). Means "X01 countdown points" for `game_type='x01'` but "cricket points earned this visit" for `game_type='cricket'` — same column, different quantity (see `X01_ONLY` in §3). `addTurn()` rejects a non-numeric value outright rather than silently coercing it to `0` |
| `bust` / `checkout` | `INTEGER NOT NULL DEFAULT 0` | Booleans. Cricket turns always write `bust=0, checkout=0` — cricket has neither concept |
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

### `settings` (key/value)
`key TEXT PRIMARY KEY`, `value TEXT NOT NULL DEFAULT ''` (booleans stored as
`'1'`/`'0'`). Known keys: `collect_dart_timing`, `colorblind_mode`,
`voice_enabled`, `voice_turn_score`, `voice_no_score`, `voice_checkout_req`,
`voice_180`, `voice_bigfish`, `voice_match_progress`, `ha_url`,
`ha_webhook_<event>` (×12, see §10), `pin_lockout_threshold`,
`admin_lockout_threshold`, `scoreboard_layout`, `default_scoring_input`,
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
| `method` / `path` / `status` / `message` | nullable | One row per server-side 5xx response (§1's "Server error log"); pruned to the most recent 500 rows on every insert |

### Cascade summary

Deleting a `player` cascades: their `game_players` rows, `turns` (and
transitively their `darts`), `player_badges`, and `daily_challenge_attempts`.
`deletePlayer()` then prunes any `games` row left with zero remaining
`game_players` (also run once at boot to self-heal older databases).

---

## 14. API Reference

Full endpoint list, auth requirements, and exact request/response shapes now
live in `README.md`'s [API Reference](README.md#api-reference) section — kept
there (not duplicated here) since it's the version meant for someone building
against the API. This document's job is the *why*/*exact internal logic*
behind each one; cross-reference by endpoint name.

**Two auth gates, not one**: `requireAdmin` always requires a logged-in admin
session; `requireWrite` is a no-op unless `OCHE_REQUIRE_AUTH=true` (see §9).
Routes documented as `[admin]` in the README use `requireAdmin`; everything
else that mutates state uses `requireWrite` and is public by default on a
normal LAN deployment.

**Rate-limit buckets**: see §9's table — `global` (300/60s, every request),
`setup`/`login`/`pin` (10/60s each, their own endpoint only). SSE uses separate
hard connection caps, not a `rateLimit()` bucket.

---

## 15. Known Limitations & Open Gaps

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
- **Data export has no per-player access-control story drafted** — flagged in
  `docs/data-export-roadmap.md` as needing the same PIN-gating other
  player-specific actions get, before it's built.
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
- See the individual `docs/*.md` files for full design detail on every
  not-yet-built feature (tournament mode, league mode, Cricket/game modes,
  camera scoring, mobile app, ghost opponent, coaching insights, and more).

---

## 16. Troubleshooting

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
scoring-adjacent badge (Busted Maximum, Ton-titled to Nothing) seems to be
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
