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
> **Not yet built**: Baseball (step 5), Just Chuckin' It. See "Suggested build
> order" below.
>
> **Doubles Practice is built (2026-07)** — the first of the two "Practice Drill
> Modes" candidates below to ship. A genuinely different shape from every other
> game type: no legs/sets/opponent/win-condition, and per-DART evaluation
> instead of per-visit (`evaluateDartDoublesPractice()` in `frontend/scoring.js`,
> a new `throwDartDoublesPractice()` bypassing the batched-3-dart pipeline
> entirely). "All simultaneously live" was the resolved answer to this doc's own
> open question about multi-double sessions. Ships with its own 3 stat bubbles
> (Doubles %, Darts/Round, Doubles Hit/Round) and a 2-field Personal Bests
> shape, reachable via a third button on the existing Player Profile X01/Cricket
> toggle — see "Doubles Practice" below and REFERENCE.md §2/§3 for the full
> design. Just Chuckin' It (freeform, unscored) remains not started.
>
> **New candidates logged (2026-07, not designed/built yet)**: **Just Chuckin' It** (freeform,
> unscored practice — see "Practice Drill Modes" below); and a generalization of
> the existing Player Profile X01/Cricket/Doubles-Practice toggle to work for an
> arbitrary number of game types instead of three hardcoded ones — see
> "Generalizing per-game-type stats" below, since every mode listed here needs
> its own place to show its own stats.

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
  reskin of X01's average/180s-shaped cards. `player_badges`' Badge Case is now
  grouped into an "X01" sub-section (20 badges) and a "Cricket" sub-section
  (2 badges) — a `cricket:true` flag on `BADGE_INFO`'s 2 Cricket entries splits
  `renderPlayerBadges()`'s single flat grid into the two, no schema or backend
  change needed (the grouping is purely a client-side rendering split, since
  `player_badges` itself only ever needed a free-form `badge_id` string).

## Generalizing per-game-type stats beyond a two-way toggle (new, 2026-07 — design not started)

Requested: every game mode's own stats (three-dart average, trebleless %, etc. or
whatever that mode's equivalent is) should be viewable on the Player Profile, for
*every* mode that exists — not just X01 and Cricket. Today this is genuinely
hardcoded to exactly two: `playerGameType` (`frontend/index.html`) is a plain
`'x01' | 'cricket'` string, and the Player Profile's game-type selector is two
literal buttons (`switchPlayerGameType('x01')` / `switchPlayerGameType('cricket')`),
not a loop over anything. The matching Home page toggle (`homeGameType`) is built
the same hardcoded way. Every new mode this doc adds (Baseball, and now the two
Practice Drill Modes above) needs a place to show its own stats, so this two-way
toggle needs to become **N-way** before a third mode ships, not after:

- The toggle itself needs to iterate over the registered game types (`GAME_TYPES`
  in `frontend/index.html`, or a filtered view of it — a drill mode with no
  `statDefs` at all shouldn't render an empty tab) rather than two hardcoded
  buttons, on both the Player Profile and the Home page.
- **The backend scaling concern**: Cricket's stats needed a full parallel set of
  functions (`getCricketStatBubbles`, `getCricketPersonalBests`,
  `getCricketMprLeaderboard`, `getCricketWinLeaderboard`,
  `getCricketPerfectLegStats`, 6 new `getMetricHistory()` cases) — a real, but
  one-time, cost when going from 1 to 2 game types. Going from 2 to 4-5 (Baseball,
  Just Chuckin' It, Doubles Practice) by hand-writing another fully parallel set of
  functions *per type, forever* is a cost worth reconsidering before it compounds —
  whether some of this can generalize (e.g. a single parameterized stat-bubble
  query keyed by each type's own formula definitions, rather than a bespoke
  SQL function per type) is an open design question for whoever tackles this,
  not something this note resolves.
- The **drill modes above don't fit the existing per-type stats shape at all** —
  `getPersonalBests()`-style "best leg / fewest darts / win streak" concepts assume
  legs and opponents that Just Chuckin' It and Doubles Practice don't have. Their
  stat vocabularies (see each mode's own section above) are different enough that
  "just add a `statDefs` array like Cricket's" may not be the right fit without
  some adaptation.
- This is the natural next step after step 4 (already done for X01/Cricket) in the
  build order below, and a prerequisite for showing *any* stats for whichever mode
  ships next — Baseball or a Practice Drill Mode both need it.

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

## ✅ Built: 101 as a fourth X01 starting score (2026-07)

X01's starting-score picker (`frontend/index.html`) is now a `<select id="start-score-
select">` with four options — **501/301/170/101** — rather than the old 3-button
`.seg` control, since a dropdown reads tidier at 4 options and scales cleanly if a
future value is ever added. `pickStart(btn,v)` was replaced by `pickStartSelect(sel)`
(`setup.start = Number(sel.value)`); `restoreSetup()`'s "reselect the last-used
starting score" logic now sets the `<select>`'s `.value` instead of toggling
`aria-pressed` on a set of buttons. No new backend plumbing was needed: `category` was
already handled as a generic string/number everywhere in `backend/db.js`, and
`OPENING_CATS` (the "opening exchange" stats' scoping — 1st 3 AVG, 1st 9 AVG, 140/Leg)
already included `501/301/170/101` from an earlier product decision (see `REFERENCE.md`
§3), so no follow-up was needed for 101 specifically. The nine-darter detection queries
stay hardcoded to `startingScore=501` — deliberate, not a gap, since a nine-darter is a
501-specific concept (the minimum dart count to check out from 501) and 101 doesn't
want its own analog. Verified end-to-end with Playwright: dropdown renders all 4
options, selecting 101 sets `setup.start`, a full 101 leg plays and checks out
correctly, and personal bests/stat bubbles report correct values scoped to 101. Any
*future* X01 starting score added after 101 would still need a deliberate decision (and
an explicit edit to `OPENING_CATS`'s `IN (...)` list) about whether it also joins the
opening-exchange scope — that part still doesn't happen automatically.

## Practice Drill Modes (2026-07 — Doubles Practice built, Just Chuckin' It not started)

Two new modes requested that are a genuinely different *shape* from every game type
above: no legs, no sets, no win condition, no opponent, ever. X01/Cricket/Baseball are
all **matches** — someone wins, someone (maybe) loses, `game.legsPerSet`/
`setsPerGame`/`onLegWon()` all assume that shape exists. These two are **drills** —
open-ended solo practice that ends when the player decides (or when a specific miss
condition fires), with their own stat vocabulary, not a match outcome.

**Resolved for Doubles Practice** (built 2026-07, see its own section below): the
`games.mode` `'match'`-vs-`'drill'` question this section originally raised turned
out not to need a real answer — it shipped by reusing the existing `practice`/
`game_type` combination as-is, repurposing `game.legNo` as a plain "round number"
counter (incremented client-side, not a real leg/set structure) and `turns.bust` as
"this dart ended the round" (the closest existing column to that meaning). The
existing plugin interface (config schema, turn engine, scoring screen, stats) was
designed around "eventually someone wins," and Doubles Practice routes around that
entirely via its own dedicated `throwDartDoublesPractice()`/`renderGameDoublesPractice()`
functions rather than forcing the win-condition-shaped machinery to fit — the same
"hardcode a `gameType` branch at each call site" precedent Cricket already
established, not a registry redesign. **Still an open question for Just Chuckin'
It** — it may or may not want the same treatment; not decided.

### Just Chuckin' It

Freeform, completely unscored practice — no starting score, no countdown, no bust, no
win, just recording dart after dart until the player stops. The point is pure
warm-up/muscle-memory reps without any game pressure at all.

- **New `game_type` value** (e.g. `'chuckin'`), always solo, no H2H equivalent makes
  sense for this mode (there's nothing to compare between two players — no score, no
  winner). Whether `practice=1` even means anything meaningful here, or whether this
  mode should always be excluded from the practice/H2H toggle entirely, is an open
  question.
- **Turn engine**: none, really — every dart is just recorded via the existing
  `addTurn()`/`darts` write path with no bust/win evaluation at all. The 3-dart
  "visit" grouping could still apply purely for input-UX consistency (reusing the
  existing Pad/Dartboard widgets as-is), but nothing about a visit "matters" beyond
  being recorded.
- **Its own stat category, and — critically — darts thrown in this mode must NOT
  count toward any other stat**, including the currently-unscoped "all game types"
  aggregates. This is the *opposite* of how Cricket was added: Cricket's darts were
  deliberately folded INTO existing unscoped totals (the "all-time turns/darts"
  audit fix earlier this session added an `allCounts` aggregate specifically so
  Cricket darts count toward the roster's all-time totals). Just Chuckin' It needs
  the reverse — every currently-"unscoped" aggregate in `backend/db.js` needs an
  explicit exclusion for this `game_type`, not just X01/Cricket-specific queries.
  Easy to get backwards by copying the Cricket-inclusion precedent instead of
  inverting it — flagging this explicitly so whoever builds it doesn't assume
  "new game_type + existing scope helper" is automatically safe here the way it was
  for Cricket.
- **Stat ideas** (not decided): total darts thrown this session/lifetime, a
  sector/multiplier hit-frequency breakdown and treble rate — this is exactly the
  shape `getDartAnalytics()` already computes (per-sector hit counts, treble rate
  per number), so this mode's stats may be mostly "point `getDartAnalytics()` at
  `game_type='chuckin'`" rather than new query design, once the exclusion concern
  above is handled.

### Doubles Practice — ✅ Built (2026-07)

Choose one or more doubles to aim at; keep throwing until a genuine
miss-condition ends the round. Misses (darts that land nowhere near — a total
miss, the wire, an unrelated number) do **not** end anything — only two very
specific outcomes do:

1. **Hitting a single (or treble) on a target number** — landed on the right
   number, just not through to the double ring. The "so close" failure mode.
   (The treble case wasn't explicitly called out when this doc was first
   written — decided during implementation as the same miss, just a different
   ring, not a new failure mode.)
2. **Hitting a different double** — wildly off-target, a different kind of miss.

Both are round-enders; a plain miss just means "keep throwing." This was a
real architectural wrinkle — every other game type in this app evaluates
**one full visit** (up to 3 darts) at a time via `evaluateVisit()`, then decides
bust/win/continue. Doubles Practice's ending condition can fire on **any single
dart**, including dart 1 or 2 of what would otherwise be a 3-dart visit, so it
needed genuine per-dart evaluation — a new `evaluateDartDoublesPractice(dart,
targets)` in `frontend/scoring.js`, with `throwDart()` routing straight to a
dedicated `throwDartDoublesPractice()` (the same "hardcode a `gameType`
branch" precedent Cricket already established), bypassing the batched-3-dart
pipeline entirely. Every dart commits immediately as its own 1-dart `turns`
row — no "Enter turn" step for this mode. Full formula and schema details:
REFERENCE.md §2 ("Doubles Practice per-dart rules") and §3 ("Doubles Practice
stats").

- **Resolved**: this is a new `game_type` value (`'doubles_practice'`).
  `config: {doubles: [...]}` — a subset of D1–D20 plus double-bull (sector 25),
  chosen at New Game setup via the same multi-select-grid mechanism as
  Cricket's custom-target picker, with no fixed count requirement (unlike
  Cricket's locked-to-7 rule).
- **Resolved (was an open question)**: multi-double sessions use **"all
  simultaneously live"** — every selected double stays live at once, no forced
  rotation and no random pick. The player throws at whichever target they
  choose each dart; a hit on any selected double counts, and the round only
  ends on a so-close or wrong-double dart, regardless of which target that was.
- **Built**: darts per round, doubles hit per round, and doubles % — all 3
  shipped as `GAME_TYPES.doubles_practice.statDefs`/`DOUBLES_PRACTICE_STAT_DEFS`,
  reachable via a third button on the existing Player Profile X01/Cricket
  toggle. Personal Bests (`bestRoundDarts`, `bestRoundHits`) ship too, using a
  deliberately smaller 2-field shape than X01/Cricket's 5 — this mode has no
  win condition, so `winStreak`/`recentForm`/`lifetime` fields don't map onto it.
- **✅ Built (2026-07): undo support.** Every dart still commits immediately as
  its own 1-dart turn, but `throwDartDoublesPractice()` now snapshots state into
  `game.lastTurnSnapshot` first (the same convention X01/Cricket use), and a new
  `undoLastTurnDoublesPractice()` restores it and calls `DB.deleteLastTurn()` —
  "undo the last turn" and "undo the last dart" are the same action here. Undo
  reaches back through a round-ending dart too, right up until "Start next
  round" is pressed (which clears the snapshot, mirroring `startNextLeg()`'s own
  "one level of undo only" rule). The scoring screen's button reads "Undo Last
  Dart" for this mode; the separate "Undo Dart" button (for un-staging an
  uncommitted dart mid-visit) is hidden — there's no staged-visit concept here
  to undo from.
- **✅ Built (2026-07): Home page leaderboard set.** A third
  X01/Cricket/Doubles-Practice toggle button on the Home page, feeding 2
  boards (not Cricket's 4, since this mode has no opponent to win against and
  no achievements yet): a **Doubles %** leaderboard
  (`getDoublesPracticeAccuracyLeaderboard()`, same 5-round floor as Cricket's
  MPR board) and a **Best Round** leaderboard
  (`getDoublesPracticeBestRoundStats()`, one row per player — their own best
  single round by hits, ties broken by fewest darts). Neither takes a `mode`
  param, since this game type is always `practice=1` by construction — an
  h2h/practice split would always leave the h2h side empty.
- **Still not built**: achievements/badges for this mode (none were requested
  for this pass).

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
6. **New, not designed yet**: generalize the Player Profile/Home page game-type
   toggle beyond X01/Cricket/Doubles Practice (see "Generalizing per-game-type
   stats" above) — this naturally comes before or alongside whichever of
   Baseball/Just Chuckin' It ships next, since neither has anywhere
   to show its stats without it. Doubles Practice's own toggle button was
   added as a minimal 3rd-branch extension of the existing 2-way mechanism, not
   this full generalization — that's still open.
7. **✅ Done — Doubles Practice** — the first Practice Drill Mode built. Per-dart
   evaluation (`evaluateDartDoublesPractice()`), "all simultaneously live"
   multi-double sessions, its own 3 stat bubbles + 2-field Personal Bests, New
   Game target picker, dedicated scoring screen and `display.html` renderer.
   Undo support and a 2-board Home page leaderboard set shipped in a later pass
   (see its own section above) — only "achievements/badges" remains
   deliberately not built for this mode. Verified with a committed scratch-DB
   unit suite (pure evaluator + backend stat functions + an X01/Cricket
   isolation regression check) and Playwright end-to-end (New Game setup, a
   full round ending each of the two ways, the Player Profile toggle, the live
   scoreboard on both the controller and `/display`, undo of both a plain dart
   and a round-ending dart, and the Home page leaderboard toggle).
8. **✅ Done — 101 as a fourth X01 starting score** (see "Quick addition" above).
   **New, not designed yet**: Just Chuckin' It — needs its own design pass
   first (the match-vs-drill architectural question raised in its section is
   still open for it, even though Doubles Practice resolved it for itself by
   just reusing `practice`/`game_type` as-is).

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
- **New**: do the Practice Drill Modes need their own `games.mode` distinction
  (`'match'` vs. `'drill'`), or can they reuse `practice`/`game_type` as-is?
  **Resolved for Doubles Practice** (built 2026-07): no new distinction needed —
  it reuses `practice`/`game_type` as-is, with `game.legNo` repurposed as a
  plain "round number" counter and `turns.bust` repurposed as "this dart ended
  the round" (see REFERENCE.md §2/§13). Still open for Just Chuckin' It,
  whichever mode is built next.
- **Resolved** (was: for Doubles Practice, how does a multi-double session pick
  which double is "live"): **all simultaneously live**, no rotation, no random
  pick — see the "Doubles Practice" section above.
- **New**: does the per-game-type stats toggle (Player Profile/Home page)
  generalize by literally listing every `GAME_TYPES` entry, or only the ones a
  given player has actually played (so a player who's never touched Cricket
  doesn't see an all-empty Cricket tab)? Leans toward the latter, not decided.
