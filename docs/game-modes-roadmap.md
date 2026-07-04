# Additional Game Modes — Design Roadmap

> Status: **Cricket is playable with full stats parity (build-order steps 1-4
> done); step 5 (Baseball) not started.** `frontend/index.html` has a `GAME_TYPES` registry
> with `x01` and `cricket` entries (`newMatchPlayer`, `evaluateVisit`,
> `resetForNextLeg`, `playerSnapshot`, `statDefs`); every call site dispatches
> through `GAME_TYPES[game.gameType]`. Backend `createGame()` accepts
> `gameType`/`config`; the nine-darter queries read `game_type`/`config` instead
> of a hardcoded `category='501'`.
>
> **Cricket (step 2) is fully playable end-to-end**: a classic-vs-custom New Game
> prompt (custom locked to exactly 7 targets, validated before Start), a dedicated
> Cricket scoring screen (`renderGameCricket`/`renderPadCricket` — Pad/Dartboard are
> never shown during a Cricket game), the marks/points/win-condition turn engine
> (`GAME_TYPES.cricket.evaluateVisit`, dispatched via `enterTurnCricket`/
> `onLegWonCricket`/`undoLastTurnCricket`), and a traditional chalkboard-style
> scorecard (rows=numbers, columns=players, slash/X/circled-X marks) shared by
> `renderGameCricket()` (controller) and `renderers.cricket.scorecard()`
> (`display.html` live scoreboard, orientation-aware per item 11). Verified: 12
> hand-checked scoring-engine scenarios (mark accumulation within a visit,
> opponent-closed gating, multi-opponent win checks), Playwright end-to-end (New
> Game validation, scoring screen, live board in both orientations, undo, full
> game completion), and a full X01 regression pass confirming zero
> cross-contamination between the two renderers.
>
> **Cricket stats parity (step 3) is done**: `GAME_TYPES.cricket.statDefs` is
> now `CRICKET_STAT_DEFS` (6 stats: MPR, 9 Marks, Win Rate, Games Played, Darts
> Thrown, Darts/Won Leg), backed by new `backend/db.js` functions
> (`getCricketStatBubbles`, `getCricketNineMarksStats`,
> `getCricketPersonalBests`, plus 6 new `getMetricHistory()` cases) scoped by
> `g.game_type='cricket'` and deriving marks at query time from
> `darts.sector`/`multiplier` matched against `games.config.numbers`. A new
> `turns.leg_won` column (game-type-agnostic "this turn won the leg" signal, set
> only by Cricket's write path) backs Cricket's Personal Bests, since Cricket
> has no `checkout` mechanism to key off like X01 does. 2 new Cricket
> achievements shipped alongside: **9 Marks** (3 darts, all trebles, summing to
> the maximum 9 — Cricket's 180 analog) and **Perfect Leg** (won the leg using
> the fewest darts physically possible for that match's target set — Cricket's
> nine-darter analog, mega-tier overlay). Verified: an 18-assertion scratch-DB
> unit suite for the new backend functions plus an X01 regression guard,
> Playwright end-to-end for both achievements firing correctly (and not
> firing prematurely).
>
> **Step 4 (Home/Player Profile game-type navigation) is done**: the Player
> Profile has a small X01/Cricket toggle (`playerGameType`) next to its existing
> Overall/H2H/Practice tabs, switching the stat bubbles, chart, and Personal
> Bests section between the two game types. The Home page gets the same
> pattern — a second `player-tabs` row (X01/Cricket, `homeGameType`) below the
> existing H2H/Practice tabs — with its own Cricket-shaped leaderboard set
> (not a reskin of X01's, since the stats don't map 1:1): a **Marks Per Round**
> leaderboard (`getCricketMprLeaderboard()`, a minimum-5-rounds floor so one
> lucky visit can't top the board), **Most Cricket Wins**
> (`getCricketWinLeaderboard()`, H2H only), and achievement sections for **9
> Marks** (reuses the existing `getCricketNineMarksStats()`) and **Perfect Leg**
> (`getCricketPerfectLegStats()`, a new leg-shaped leaderboard querying
> `turns.leg_won` legs whose total darts equal that match's config-derived
> minimum). All fetched in the same upfront `Promise.all` `renderHome()` already
> uses for X01, no separate loading state. Verified with a seeded scratch-DB
> (3 Cricket games) confirming leaderboard math and Playwright end-to-end
> confirming the toggle switches cleanly in both H2H/Practice modes with zero
> regression to the existing X01 leaderboards.
>
> **Not yet built**: Baseball (step 5). See "Suggested build order" below.

## Goal

Support multiple dart game types beyond X01 (501/301/170) — starting with a
customizable Cricket (choose any numbers to play, not just the standard 15–20 + Bull)
— built as a real extensible framework so more game types (Baseball and others) can be
added later without starting from scratch each time.

## Decisions made (2026)

| Decision | Choice |
|---|---|
| Architecture approach | Proper generalization now — refactor X01 into "the first plugin" in a real game-type framework, rather than bolting Cricket on separately |
| Cricket stats depth | ✅ Built. A dedicated Cricket stat (Marks Per Round) plus 5 more stat bubbles, Personal Bests, and profile charts (Player Profile), and its own Home page leaderboard set (MPR, Most Cricket Wins, 9 Marks, Perfect Leg) |
| Cricket variant scope for v1 | Standard cricket only (highest score wins). Cut-throat (points scored against opponents) deferred to later |
| Custom cricket target count | ✅ Built. Fixed at 7 targets — the same count as classic cricket (15, 16, 17, 18, 19, 20, Bull) — freely chosen from 1-20 + Bull, but never more or fewer than 7. Enforced at Start (`startGame()` blocks with an alert if the count is wrong) |
| Scoring screen during Cricket | ✅ Built. A dedicated Cricket scoring screen (traditional chalkboard scorecard — slash/X/circled-X marks), not the X01 Pad or Dartboard screens — it's the automatic default the instant a Cricket game is active, with no player choice to fall back to Pad/Dartboard |
| Live scoreboard orientation | ✅ Built. Cricket's `renderers.cricket` inherits portrait/landscape detection from the shared shell — see `docs/existing-app-prep-roadmap.md` item 11 |
| Cricket scorecard style | ✅ Built. A single shared chalkboard-style table (rows=numbers, columns=players) rather than per-player cards — matches how cricket is scored on a real board. Marks: slash (1), X (2), circled X (3+/closed) |

## Why this is bigger than "add cricket"

The app today isn't "a darts scorer that happens to support 501" — it's an **X01
scorer**. `games.category` is literally the starting score as a string. `turns` has
`checkout`/`checkout_points` columns. Every stat in `db.js` — 3-dart average,
treble-less %, ton+ finishes, 180s, Big Fish (170 checkout specifically), nine-darters
(hardcoded to `category='501'`) — is X01 arithmetic baked directly into SQL. Given
"many different games" with full stats parity, this is a foundational rework of the
scoring engine and stats pipeline, not an additive feature.

## What's already reusable

- **The `darts` table** (sector, multiplier, dart number) has zero X01-specific
  concepts — it's just physical dart data. Cricket's marks-per-number and "closed"
  state can be derived entirely from existing dart rows (treble = 3 marks, double = 2,
  single = 1), the same way the rest of the app already computes everything from raw
  data rather than pre-aggregating. **No new dart-level schema needed.**
- **The underlying tap→dart primitive** (`throwDart(sector, mult)` capturing a
  "sector + multiplier" event into `game.darts`) has no concept of which game is
  being played, and stays shared by every game type — confirmed unchanged by the
  Phase 1 refactor (see `docs/existing-app-prep-roadmap.md` item 5).
  **Correction from an earlier draft of this doc**: the *visible* scoring screen
  built on top of that primitive — the X01 number Pad and the interactive dartboard
  SVG — is **not** reused as-is for Cricket. Cricket needs its own dedicated scoring
  screen (see "New Game / Scoring screen changes" below): tapping directly on the
  in-play numbers with live marks/closed status shown inline is a different enough
  interaction from "enter this visit's score toward a countdown" that sharing the X01
  Pad/Dartboard components would mean bolting cricket-specific state onto a UI built
  entirely around a different mental model. What's reused is the *primitive*
  (sector+multiplier → a dart event), not the screen built on it.
- **The live scoreboard** already has a `gameType` field on its snapshot and a
  `renderers` dispatch table in `display.html`, built during the scoreboard redesign
  specifically so a Cricket renderer could plug in later without touching the X01 one
  (`frontend/display.html`, `renderers.x01`) — confirmed by Phase 1, which changed the
  `gameType` value from a hardcoded literal to a real field and needed zero changes to
  `display.html` as a result. That groundwork already means a Cricket game
  automatically gets its own scoreboard the instant `s.gameType==='cricket'` — no new
  dispatch mechanism needed, just a `renderers.cricket` entry. Orientation is also
  now covered: `renderers.x01` is portrait/landscape-aware (`docs/existing-app-prep-
  roadmap.md` item 11 — `matchMedia`-based detection, single-column portrait grid),
  and a future `renderers.cricket` entry renders through the same `#grid` container
  and column-count logic, so it inherits that awareness without its own retrofit.

## The architecture: a game-type plugin interface

Each game type implements the same shape:

- **Config schema** — what the New Game setup screen asks for. X01: starting score
  (501/301/170). Cricket: a classic-vs-custom choice first (see "New Game / Scoring
  screen changes" below), then which numbers are in play — a multi-select of any
  subset of 1–20 + Bull in custom mode, constrained to **exactly 7 selections** (the
  same count classic cricket uses: 15–20 + Bull), with the classic set offered as a
  one-tap preset. Baseball: inning count (normally fixed at 9).
- **Turn engine** — given the darts thrown this visit plus current per-player state,
  computes the new state: X01 decrements score and checks bust/checkout; Cricket
  updates marks-per-number and closed status and computes points scored (gated on
  whether opponents have closed that number); Baseball adds runs to the current
  inning.
- **Win condition checker** — X01: first to zero on a legal finishing dart. Cricket:
  first to close every in-play number while leading on points. Baseball: highest
  total runs after N innings.
- **Scoring screen** — the actual on-controller UI a player enters darts through. X01
  reuses the existing Pad/Dartboard input screens; Cricket gets its own dedicated
  screen and is never shown Pad or Dartboard (see "New Game / Scoring screen changes"
  below) — this is a per-game-type UI choice, not just a per-game-type turn engine.
- **Live scoreboard card renderer** — slots into `display.html`'s existing `renderers`
  table, and must support both portrait and landscape with automatic orientation
  detection — ✅ already true of the shared shell (`docs/existing-app-prep-roadmap.md`
  item 11), so a `renderers.cricket` entry only needs to design its card content for
  a narrow single-column cell, not build orientation detection itself.
- **Stats definitions** — each plugin defines its own stat vocabulary (see Cricket
  stats below), not just reusing X01's.

`newMatchPlayer()` and the turn-processing logic in `frontend/index.html` (currently
hardcoded to X01 fields like `score`, `doubleOut`) get refactored to delegate to the
active plugin. This refactor is Phase 1 of the build order below, done *without
changing X01 behavior at all* — proving the abstraction is sound before Cricket
depends on it.

> **Status: ✅ Phase 1 done.** `GAME_TYPES.x01` in `frontend/index.html` holds
> `newMatchPlayer`, `evaluateVisit`, `resetForNextLeg`, `playerSnapshot`, and
> `statDefs` (a pointer to `STAT_DEFS`); `game.gameType` is stamped once at
> `startGame()` and every downstream call site (`enterTurn`, `startNextLeg`,
> `liveSnapshot`) dispatches through `GAME_TYPES[game.gameType]` instead of calling
> the old functions by name. `display.html`'s `renderers` table already read
> `s.gameType` from the live snapshot, so it needed no change. Achievements
> (`CHAIN_CHECKS`, Metronome, etc.), `renderGame()`'s countdown scoring screen, and
> the New Game starting-score UI are deliberately **not** abstracted yet — Cricket
> gets its own scoring screen and achievement set (steps 2-3 below), there's nothing
> generic to extract from those until a second game type actually exists.

## Data model

> **Status: ✅ Schema groundwork done, and now actually used.** `games.game_type` and
> `games.config` exist and are populated as `'x01'` / `{startingScore: ...}` for every
> game today. `createGame()` (`backend/db.js`) now accepts optional `gameType`/
> `config` params instead of hardcoding them, so a future Cricket New Game flow can
> pass its own without another signature change. The nine-darter query fix mentioned
> below is done — see the note under "Known coupling" further down. Cricket actually
> using non-x01 `config` shapes is still not started.

- `games.game_type` (new column: `'x01' | 'cricket' | 'baseball' | ...`)
- `games.category` stays as the human-readable label (X01: "501" as today; Cricket:
  e.g. "Cricket (15–20, Bull)" or "Custom Cricket")
- `games.config` (new JSON column) — structured, machine-readable settings:
  `{ numbers: [15,16,17,18,19,20,25] }` for Cricket, `{ startingScore: 501 }` for X01,
  etc. This is the extensibility point — a new game type never needs a schema
  migration, just a new shape of JSON.
- No changes to `turns`/`darts` — Cricket's marks/closed state and points are computed
  from existing `darts` rows at query time, matching the existing "nothing is
  pre-aggregated" philosophy already documented in the README's Architecture section.
- **✅ Fixed**: the nine-darter detection query no longer hardcodes `g.category='501'`
  — all 6 occurrences (`nineDarterBase`, `getSummary`, `getPlayerStatBubbles`,
  `getMetricHistory`, and both `getNineDarterStats` queries) now read
  `g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501`. This required
  a one-time backfill (`db.js`, alongside the existing `player_count` backfill) since
  `config` itself was added without backfilling pre-existing rows — without it, every
  nine-darter thrown before that migration would have silently stopped counting.

## Cricket rules (standard, v1 scope)

- Players "close" a number by accumulating 3 marks on it (single dart = 1 mark,
  double = 2, treble = 3 — so one treble instantly closes a number).
- Once a player has closed a number and at least one opponent hasn't, additional
  marks on that number score points equal to the number's value × marks beyond what
  was needed to close it.
- Win condition: first to close every in-play number while leading on points wins.
  **Open edge case to nail down during implementation**: what happens when a player
  closes everything but trails on points — do they keep throwing defensively until
  someone else closes and overtakes, or does some other tie-break apply? Real cricket
  handles this by letting the closed-out-but-behind player continue to block
  opponents' scoring (since they can't score more themselves) until the point deficit
  is resolved one way or another; this needs to be modeled correctly in the win-check
  logic, not simplified away.
- Cut-throat (points scored against opponents instead of for yourself, lowest score
  wins) is explicitly out of scope for v1 — deferred since it inverts the scoring and
  win-condition logic and is cleaner to add once standard mode is solid.

## Cricket stats (full parity with X01)

- **Marks Per Round (MPR)** ✅ Built. Cricket's direct equivalent of 3-dart
  average: total marks scored ÷ rounds played, computed from `darts` matched
  against `games.config.numbers` the same way 3-dart average is derived from
  `turns.scored` — no persisted mark/closed state needed. `getCricketStatBubbles()`,
  `getCricketPersonalBests()`, and 6 new `getMetricHistory()` cases in
  `backend/db.js`; `CRICKET_STAT_DEFS` in `frontend/index.html`.
- **Cricket-specific achievements** ✅ Built, exactly as scoped here: **9 Marks**
  (three darts, each a treble on an in-play number, summing to the maximum
  9 marks — not required to be different numbers, matching 180's "the max
  possible visit" framing rather than a stricter "3 different numbers" rule)
  as Cricket's analog to a 180; **Perfect Leg** (won the leg using the fewest
  darts physically possible for that match's target set, computed dynamically
  from `config.numbers` since Bull can't be trebled and needs a 2-dart minimum)
  as the analog to a nine-darter.
- **Home page and Player Profile become game-type-aware** ✅ Built, both. Player
  Profile: a small X01/Cricket toggle next to the existing Overall/H2H/Practice
  tabs switches the stat bubbles, chart, and Personal Bests section between
  the two game types' own vocabularies. Home page: the same toggle pattern
  (a second `player-tabs` row, `homeGameType`) below the existing H2H/Practice
  tabs, feeding a genuinely Cricket-shaped leaderboard set — Marks Per Round
  (`getCricketMprLeaderboard()`), Most Cricket Wins (`getCricketWinLeaderboard()`,
  H2H only), and 9 Marks/Perfect Leg achievement sections
  (`getCricketNineMarksStats()`/`getCricketPerfectLegStats()`) — rather than a
  reskin of X01's average/180s-shaped cards. `player_badges`' Badge Case still
  stays one flat grid (X01 and Cricket badges mixed together) — acceptable for
  v1, no grouping UI built.

## Baseball (rules primer — for whoever builds this next)

9 innings, one per number 1–9. Each turn, a player throws 3 darts at that inning's
number: a single scores 1 run, a double 2, a treble 3, for that inning only. After 9
innings, highest total runs wins (extra innings on a tie, like real baseball). Slots
into the same plugin shape as Cricket — a turn engine that adds runs to the current
inning, a win condition of "highest total after N innings," and its own stat
vocabulary (e.g. runs per inning, best single inning). Recommended as the *second*
game type added, once the plugin seams have been proven on a real second
implementation (not just fitted to Cricket specifically).

## Other known variants (backlog, not designed yet)

- **Round the Clock** — hit 1 through 20 in order, then bull.
- **Shanghai** — single + double + treble on the same number in one visit is an
  instant win.
- **Killer** — elimination-style, players "kill" each other's assigned numbers.
- **High-Low / Halve-It** — miss a target number and your score halves.

## New Game / Scoring screen changes

New Game gets a game-type selector as a top-level choice (alongside the existing
H2H/Practice toggle), with the "Format" section becoming type-conditional: X01 shows
today's starting-score buttons; Cricket shows a **classic-vs-custom** choice first.
Legs/sets/best-of stays universal across types — that concept isn't X01-specific.

### Cricket's classic vs. custom prompt

- **Classic** — the standard 15, 16, 17, 18, 19, 20, Bull target set, pre-selected,
  no further input needed. This is the one-tap path for the common case.
- **Custom** — reveals a multi-select of every number 1–20 plus Bull (21 possible
  targets). The player may choose **any** combination, but the selection count is
  locked to exactly **7** — the same number of targets classic cricket uses. The
  "Start Game"/"Start Challenge"-equivalent button stays disabled (with a visible
  count, e.g. "4 of 7 selected") until exactly 7 are chosen — never fewer, never
  more. A "Start from classic" quick-fill button pre-checks the classic 7 as a
  starting point the player can then edit, rather than making them build the set
  from nothing.
- This constraint keeps every Cricket match — classic or custom — structurally
  identical (7 numbers to close), so the turn engine, win condition, and stats
  (Marks Per Round, etc.) never need to special-case "how many targets does this
  particular match have."

### Cricket's dedicated scoring screen

Cricket does not use the X01 Pad or Dartboard scoring screens at all — it gets its
own scoring screen showing the in-play numbers with each player's current
marks/closed status, and darts are entered by tapping directly on those numbers
(constrained to whichever 7 are in play for this match) rather than a generic 1-20
pad or a full dartboard SVG. The instant a game's `gameType` is `'cricket'`, this
screen is what's shown — automatically, with no player choice involved. The
existing `default_scoring_input` Settings toggle (Pad vs. Dartboard) is an X01-only
preference; it has no effect on, and no equivalent for, Cricket. Concretely: the
scoring-screen container that currently always renders X01's countdown/Pad/Dartboard
markup needs a `game.gameType` branch, the same way `enterTurn()`/`liveSnapshot()`
already branch through `GAME_TYPES[game.gameType]` — this is new work, since
`renderGame()` today has no such branch at all (Phase 1 deliberately left it
X01-only, see its status note above).

## Suggested build order

1. **✅ Done — Refactor, no new behavior** — extracted the existing X01 logic behind
   the plugin interface; verified X01 plays identically (Playwright + db.js unit
   tests) before anything else depends on the abstraction.
2. **✅ Done — Cricket engine + customizable numbers** — turn engine, win condition,
   New Game classic/custom config UI (exact-7-target validation), a dedicated
   Cricket scoring screen (marks/closed display, replacing Pad/Dartboard entirely
   for Cricket games), and a `renderers.cricket` live-scoreboard card
   (orientation-awareness inherited from the shared shell — item 11, done).
   Verified with 12 hand-checked scoring-engine scenarios, Playwright end-to-end,
   and a full X01 regression pass.
3. **✅ Done — Cricket stats parity** — MPR, 9-Marks leaderboard, Personal Bests
   (via the new `turns.leg_won` column), metric-history charts, and 2 new
   achievements (9 Marks, Perfect Leg). 18-assertion scratch-DB unit suite
   (backend functions + X01 regression guard) plus Playwright end-to-end for
   both achievements.
4. **✅ Done — Home/Stats page game-type navigation** — Player Profile's X01/Cricket
   toggle (bubbles/chart/Personal Bests) plus a matching Home page toggle
   feeding its own Cricket-shaped leaderboard set (MPR, Most Cricket Wins,
   9 Marks, Perfect Leg) rather than a reskin of X01's average/180s cards.
   Verified with a seeded scratch-DB confirming leaderboard math and
   Playwright end-to-end confirming the toggle switches cleanly with zero
   regression to the existing X01 leaderboards.
5. **Baseball** (or another variant) as the second proof that the plugin shape
   generalizes, not just fits Cricket specifically.

## Accessibility, security, and testing considerations

- **Accessibility**: ✅ Done. Cricket's scoring screen extends the app's existing
  `aria-pressed`/`role="group"` conventions (each target button carries an
  `aria-label` stating its exact mark count or closed status), and closed numbers
  are signaled with a circled X + `sr-only` text label, never color alone. The
  chalkboard scorecard (both the controller's `renderGameCricket()` and the live
  scoreboard's `renderers.cricket.scorecard()`) follows the same rule. Portrait/
  landscape parity is verified — Cricket's scorecard always forces a single
  column spanning the whole `#grid` regardless of orientation, so there's no
  separate code path to drift out of sync.
- **Testing**: ✅ Done, though as ad hoc scratch scripts rather than the formal test
  runner `docs/testing-and-observability-roadmap.md` still calls for (that slice is
  a separate, not-yet-built prerequisite — see that doc). The scoring engine
  (`evaluateVisitCricket`) was validated standalone against 12 hand-checked
  scenarios before being wired in: mark accumulation within a single visit
  (including a number closing mid-visit with the remaining darts scoring),
  opponent-closed gating, out-of-play-sector no-ops, and the win condition
  (including the closed-but-behind case, the exact-tie case, and a 3-player
  multi-opponent check). The exact-7 target-count validation and a full
  New-Game-to-game-completion flow were verified end-to-end with Playwright,
  alongside a full X01 regression pass confirming no cross-contamination between
  the two renderers.
- **Security**: no new credential/token surface from the plugin refactor or Cricket
  itself — reuses the existing game/turn recording and admin-auth model.

## Open questions for whoever picks this up

- **Resolved during implementation**: Bull is *not* mandatory in custom cricket —
  it's just one of the 21 selectable targets (1-20 + Bull), so a player can build a
  custom set of 7 purely numeric targets with no Bull at all if they choose to. Not
  a deliberate design statement that this is definitely correct — just the simplest
  choice consistent with "any 7 of 21," flagged here in case it's revisited.
- **Still open**: the exact win-condition tie edge case (an exact points tie at the
  moment the last number closes doesn't end the leg — verified behavior, not a bug,
  see REFERENCE.md §2) has no tie-break implemented. Whoever wants one needs to
  decide what it should be.
- Should legs/sets apply to Cricket the same way as X01, or does a Cricket "match"
  more naturally mean a fixed number of games rather than legs-within-a-set? (Built
  the same way as X01 for now — no decision was forced either way.)
- Priority after Cricket stats parity (build-order step 3): Baseball, or one of the
  other named variants?
