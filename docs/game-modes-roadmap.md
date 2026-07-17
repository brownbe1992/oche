# Additional Game Modes — Design Roadmap

> Status: **Cricket is playable with full stats parity (build-order steps 1-4
> done). Step 5 (Baseball) is now also playable with full stats/achievements
> parity** — turn engine, New Game setup, dedicated scoring screen, live
> scoreboard, stat bubbles/Personal Bests/metric history, achievements/badges,
> matchwin moment card/Share button/practice stat panel, and Home page
> leaderboards (see "Baseball" below). `frontend/index.html`
> has a `GAME_TYPES` registry with `x01`, `cricket`, and `baseball` entries
> (`newMatchPlayer`, `evaluateVisit`, `resetForNextLeg`, `playerSnapshot`,
> `statDefs`); every call site dispatches through `GAME_TYPES[game.gameType]`.
> Backend `createGame()` accepts `gameType`/`config`; the nine-darter queries read
> `game_type`/`config` instead of a hardcoded `category='501'`.
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
> **Killer is now built and shipped (2026-07)** — elimination-format H2H, per the
> rules primer below (dartscorner.com's published ruleset). See "Killer"'s own
> "Implementation notes" subsection for exactly how each open question was
> resolved; full write-up in `REFERENCE.md` §28.
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
> design.
>
> **Just Chuckin' It is built (2026-07)** — the second "Practice Drill Modes"
> candidate, and the first game type with no round/leg concept at all (a whole
> session is one continuous stream of 1-dart turns). Heatmap-first stats
> (`getChuckinStatBubbles`/`getChuckinPersonalBests`/`getChuckinHeatmap`, 6
> `getMetricHistory()` cases) with darts thrown as the one deliberate exception to
> "no stats leak into any other game type's calculations," plus 18 laddered
> milestone achievements generated from a single data-driven ladder array. See
> "Just Chuckin' It" below and REFERENCE.md §2/§3/§6 for the full design.
>
> **✅ Done (2026-07): the Player Profile/Home page game-type toggle is now N-way**,
> not three hardcoded buttons — see "Toggle mechanism generalized" below. The
> *backend* half of that same section (a bespoke SQL function set per game type,
> and the Home page's upfront fetch list growing the same way) is still open and
> deliberately not attempted for Baseball — real design work for whoever builds it
> next, not resolved by the toggle-mechanism generalization. (Just Chuckin' It's
> own backend function set shipped as part of building it, following the same
> "bespoke per game type" pattern this section anticipated.)
>
> **✅ Built (2026-07): Night Owl/Early Bird now fire from Cricket turns too**
> (were X01-only by accident of code structure, not design — see "Cricket badge
> parity"), via a shared `awardTimeOfDayBadges(p)` helper. **✅ Built (2026-07):
> two new Cricket-native badges** (🧹 Whitewash, 🔥 Comeback Kid (Cricket)) —
> see "New Cricket-native badges" below. **One item remains**, tracked on
> `docs/open-roadmap-items.md`: a Guided Around the Clock/World practice drill
> mode (a fourth Practice Drill Mode, turning the existing passive completion
> tracking into something actively practicable with live progress feedback).

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
| Cricket variant scope for v1 | Standard cricket only (highest score wins). Cut-throat (points scored against opponents) deferred to later — done, see `docs/archive/cutthroat-cricket-roadmap.md` |
| Custom cricket target count | ✅ Built. Fixed at 7 targets — the same count as classic cricket (15, 16, 17, 18, 19, 20, Bull) — freely chosen from 1-20 + Bull, but never more or fewer than 7. Enforced at Start (`startGame()` blocks with an alert if the count is wrong) |
| Scoring screen during Cricket | ✅ Built. A dedicated Cricket scoring screen (traditional chalkboard scorecard — slash/X/circled-X marks), not the X01 Pad or Dartboard screens — it's the automatic default the instant a Cricket game is active, with no player choice to fall back to Pad/Dartboard |
| Live scoreboard orientation | ✅ Built. Cricket's `renderers.cricket` inherits portrait/landscape detection from the shared shell — see `docs/archive/existing-app-prep-roadmap.md` item 11 |
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
  Phase 1 refactor (see `docs/archive/existing-app-prep-roadmap.md` item 5).
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
  detection — ✅ already true of the shared shell (`docs/archive/existing-app-prep-roadmap.md`
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
  wins) was explicitly out of scope for v1 — deferred since it inverts the scoring and
  win-condition logic and was cleaner to add once standard mode was solid. **Done,
  see `docs/archive/cutthroat-cricket-roadmap.md`.**

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

## ✅ Toggle mechanism generalized (2026-07); backend stat-fetch generalization still open

Requested: every game mode's own stats (three-dart average, trebleless %, etc. or
whatever that mode's equivalent is) should be viewable on the Player Profile, for
*every* mode that exists — not just X01 and Cricket. This had two genuinely
separate parts, and only the first is built:

**✅ Built: the toggle widgets and their dispatch are now N-way, not hardcoded
per type.** `GAME_TYPES` (`frontend/index.html`) gained 3 UI-facing fields per
entry — `label`, `personalBestsRenderer`, `homeTabRenderer` (a `null` renderer
means "use the built-in X01-shaped default," not a special case) — alongside
`statDefs`, which already existed. Both the Player Profile's and the Home page's
game-type toggle now render via `Object.values(GAME_TYPES).filter(g=>g.statDefs
&& g.statDefs.length).map(...)` instead of one hardcoded `<button>` per known
type, and `renderPersonalBests()`/`renderHomeTabBody()` dispatch to a custom
renderer via `GAME_TYPES[type].personalBestsRenderer`/`.homeTabRenderer` instead
of an `if(type==='cricket') ... if(type==='doubles_practice') ...` chain. The
Home page's toggle row was static HTML before this — it's now populated by a new
`renderHomeGameTypeTabs()`, called from `renderHome()`. `activeBubbleKeyMap()`
reads `GAME_TYPES[playerGameType].bubbleKeyMap` (patched onto each entry right
after `BUBBLE_KEY_MAP`/`CRICKET_BUBBLE_KEY_MAP`/`DOUBLES_PRACTICE_BUBBLE_KEY_MAP`
are each defined, since referencing a `const` before its own declaration line
would hit its temporal-dead-zone); `activeGameTypeParam()` was already fully
mechanical (`'&gameType='+type` for anything but `'x01'`) and needed no stored
field at all. **Net effect**: adding Baseball (or, as it turned out, Just
Chuckin' It) to these two toggles means adding one `GAME_TYPES` entry with its
own bespoke stat-fetch/render functions plugged in — not touching the
toggle-rendering or dispatch code at either site, which was the actual goal of
"N-way before a third mode ships" (even though Doubles Practice, the third mode,
had already shipped with one more hardcoded branch by the time this
generalization pass landed — this retrofits that branch away, not just prevents
a fourth one). Just Chuckin' It (built 2026-07) confirmed this net effect held
exactly as predicted: it plugged into both toggles with zero changes to the
toggle-rendering or dispatch code itself, needing only its own `GAME_TYPES`
entry plus `homeTabRenderer:false` (opting out of the Home toggle specifically,
since none of its stats map onto a leaderboard shape there).

**Still genuinely open for Baseball — Just Chuckin' It didn't resolve it
generically, it just paid the same cost again**: the backend scaling concern.
Cricket's stats needed a full parallel set of functions
(`getCricketStatBubbles`, `getCricketPersonalBests`, `getCricketMprLeaderboard`,
`getCricketWinLeaderboard`, `getCricketPerfectLegStats`, 6 `getMetricHistory()`
cases); Doubles Practice needed its own smaller parallel set on top; Just
Chuckin' It added a third (`getChuckinStatBubbles`, `getChuckinPersonalBests`,
`getChuckinHeatmap`, 6 more `getMetricHistory()` cases). Going from 4 to 5+ game
types (Baseball) by hand-writing yet another fully parallel set of SQL functions
*per type, forever* is a cost worth reconsidering before it compounds — whether
some of this can generalize (e.g. a single parameterized stat-bubble query keyed
by each type's own formula definitions, rather than a bespoke SQL function per
type) is a real, separate design problem. Forcing an abstraction across X01
(leg/win-gated), Cricket (marks-based), and the drill modes (no legs, no
opponent, no win concept at all) without a concrete consumer to validate the
shape against risked exactly the kind of premature generalization that's worse
than the per-type duplication it would replace when this was first written —
now with three drill-shaped and non-drill-shaped data points banked (Cricket,
Doubles Practice, Just Chuckin' It), whoever tackles Baseball next has a much
better-informed basis for deciding whether it's finally worth generalizing. The
Home page's upfront `Promise.all` fetch list (`renderHome()`) has the same
"grows by N endpoints per type" shape and is left unresolved for the same
reason (Just Chuckin' It opted out of it entirely via `homeTabRenderer:false`,
so it didn't add to this list at all).
- The **drill modes don't fit the existing per-type stats shape at all** —
  `getPersonalBests()`-style "best leg / fewest darts / win streak" concepts assume
  legs and opponents neither drill mode has (Doubles Practice worked around this
  with its own deliberately-smaller 2-field Personal Bests shape, not a
  generalization of X01/Cricket's 5-field one; Just Chuckin' It hit the exact
  same question and landed on its own 2-field shape too — best session by darts,
  best session by trebles — confirming this was a real, recurring shape, not a
  one-off).
- **Still open, unrelated to the mechanism above**: whether the toggle should
  show every registered game type unconditionally (today's behavior, unchanged
  by this pass) or only the ones a given player has actually played, so a player
  who's never touched Cricket doesn't see an all-empty Cricket tab. Genuinely
  undecided, not resolved by this pass — see "Open questions" below.

## Baseball — ✅ Built (2026-07, full stats/achievements parity — see "Still open" below)

9 innings, one per number 1–9. Each turn, a player throws 3 darts at that inning's
number: a single scores 1 run, a double 2, a treble 3, for that inning only. After 9
innings, highest total runs wins (extra innings on a tie, like real baseball). Slots
into the same plugin shape as Cricket — a turn engine that adds runs to the current
inning, a win condition of "highest total after N innings," and its own stat
vocabulary (e.g. runs per inning, best single inning) — the latter deliberately not
built this pass (see "Still open" below), confirming the doc's own framing above that
Baseball is the second real proof the plugin shape generalizes beyond Cricket.

- **Innings fixed at 9**, not a New Game config option — the same "one-tap, no
  further input" precedent as Classic Cricket. `games.config` is `{ innings: 9 }`.
- **The current inning is game-level state, not per-player** — unlike Cricket's
  independent `marks` per player, every player in a Baseball match shares one live
  inning (`game.baseballInning`), since real darts baseball has everyone throwing at
  the same number in lockstep. It only advances once the *last* player in the
  rotation has thrown (`evaluateVisitBaseball()`'s `roundComplete`, checked via
  `game.current === game.players.length - 1` — still un-advanced at evaluation time,
  the same timing every other `evaluateVisit*()` relies on). A solo practice game is
  always "last in rotation," so it advances one inning per visit, as expected.
- **Only the current inning's number scores** — a dart landing anywhere else
  (including a genuine miss) scores 0 runs for that dart, evaluated dart-by-dart
  within the 3-dart visit (`evaluateVisitBaseball()` in `frontend/scoring.js`).
- **Win condition**: only checked on the last player's visit of a round, once inning
  9 has been reached — computes every player's total (including the just-evaluated
  visit) and ends the match only if there's a single unique highest total; a tie
  among the leaders continues into extra innings instead.
- **Extra-innings target number — a judgment call, not sourced**: the rules primer
  above left this unspecified (darts baseball is built around exactly 9 numbers,
  1-9, one per regular inning, so "just keep going" needs *some* number once you run
  out). Resolved as **repeating number 9** each extra inning (`baseballInningTarget()`
  in `frontend/scoring.js`) rather than cycling back to 1 — flagged here exactly like
  Killer's own undocumented judgment calls below, in case a real house-rule source
  ever contradicts it.
- **Visit-based (3 darts per turn), same undo shape as X01/Cricket** — not
  Doubles Practice's per-dart shape. `enterTurnBaseball()`/`undoLastTurnBaseball()`/
  `onLegWonBaseball()` mirror Cricket's own turn-commit/undo/leg-progression
  functions almost exactly; the one structural difference is that Baseball's
  winner (passed to `onLegWonBaseball(wi)`) is *computed* from total runs rather
  than assumed to be whoever's visit just ran, since the round-ending visit and the
  actual highest scorer aren't always the same player.
- **Scoring screen**: reuses Cricket's exact "select a multiplier, then tap the
  target" interaction (the shared multi-row control), just with one target button
  (this inning's number) instead of Cricket's seven — no new input paradigm
  invented. `renderPadBaseball()`/`renderGameBaseball()` (chalkboard scorecard:
  rows = innings 1-9, columns = players, foot row = running total — visually
  identical shape to Cricket's own scorecard, reusing its `.cs-table` CSS wholesale).
- **Live scoreboard**: `renderers.baseball` in `display.html`, same chalkboard-table
  shape as Cricket's, always single-column regardless of orientation (the shared
  `isScorecardLayout` check now covers both game types).
- Legs/sets apply the same way X01/Cricket do — one leg = one complete 9(+)-inning
  match — same "built the same way as X01 for now, no decision forced" resolution
  the open-questions section below already gives Cricket for this exact question.

**✅ Done (2026-07) — stats pass**: `GAME_TYPES.baseball.statDefs`
(`BASEBALL_STAT_DEFS`) is now populated — 6 stat bubbles (RPI, Perfect
Innings, Win Rate, Games Played, Darts Thrown, Best Inning), a 5-field
Personal Bests shape (`getBaseballPersonalBests()`), and 6 matching
`getMetricHistory()` cases, all backed by new `backend/db.js` functions
(`getBaseballStatBubbles`, `getBaseballPersonalBests`, `getBaseballWonLegs`).
Baseball now shows up on the Player Profile's game-type toggle. The one
genuinely novel design problem this required: Baseball has no `turns.leg_won`
signal the way X01 (`checkout=1`) and Cricket (`turns.leg_won`, set at write
time) do, because a Baseball leg's winner isn't self-referential to a single
player's own visit — `evaluateVisitBaseball()`'s round-ending visit and the
actual highest scorer aren't always the same player. Resolved by deriving
"won legs" entirely at query time (`getBaseballWonLegs()`): each player's
total runs per `(game,set,leg)` compared against the max among that leg's
participants, scoped to `g.completed_at IS NOT NULL` as a safety net against
an abandoned mid-leg being mistaken for a real result — rather than adding a
new write-path signal the way Cricket did. **Home page leaderboards
deliberately not built this pass** — `homeTabRenderer:false` (not `null`)
explicitly opts Baseball out of the Home page toggle for now, the same
Chuckin/Doubles-Practice precedent, since `null` would have silently rendered
X01's leaderboard shape against Baseball's totally different fields (a bug
caught during this pass's own live verification, before it shipped). Verified
with a 5-case committed unit suite (`backend/test/db.baseball-stats.test.js`,
mirroring `db.cricket-stats.test.js`'s structure — including a case that
specifically proves personal-bests attribution follows total runs, not
whichever player's turn happened to end the round) and a live Playwright
check of the full chain: New Game → a full H2H match → Player Profile stat
bubbles/Personal Bests/metric-history chart, all rendering correctly.

**✅ Done (2026-07) — achievements, moment card/Share/practice panel, Home page
leaderboards**: the three items left open by the stats pass above are now built,
each the direct Baseball-vocabulary analog of a Cricket precedent.

- **Baseball-native achievements**: 🔥 Perfect Inning (`dartsThrown===3 &&
  ev.runsThisVisit===9` — 3 trebles on target in one visit, checked per-visit in
  `enterTurnBaseball()`, the same timing 9 Marks uses) and 🏆 Perfect Game (a won
  leg with `inningRuns[i]===9` for every one of innings 1-9 — 81 total, checked
  leg-outcome-side in `onLegWonBaseball(wi)`, the same timing Perfect Leg uses;
  mega-tier confetti overlay like Nine-Darter/Perfect Leg). Both **recurring**,
  both flagged `baseball:true` in `BADGE_INFO` so the Player Profile's Badge Case
  gets its own "Baseball" section (mirroring the Cricket section). Full trigger
  conditions in REFERENCE.md §4.
- **Matchwin moment card, Share button, per-leg comparison table**: Baseball
  now gets its own `h2hStatsHtmlBaseball()` (mirroring X01's `h2hStatsHtml()`,
  since Cricket's own version reads X01-shaped fields — `p.gamePoints`/
  `avgDarts` — that don't exist on a Baseball player) plumbed into
  `finishUnit()`. `matchWinStatLine()` needed no Baseball-specific version at
  all — it only reads `legsWon`/`setsWon`/`category`/`players.length`, already
  generic across every game type. The Share button, previously excluded for
  Baseball the same way it's excluded for Cricket (`isCricket || isBaseball` in
  `finishUnit()`), now only excludes Cricket — Baseball gets the same
  `shareMomentCard('matchwin')` flow X01 has. (A `pracStatsHtmlBaseball()`
  dual-column "This Leg/This Session" panel briefly existed alongside this for
  practice mode's `kind==='leg'` screen, but was removed by
  `docs/bug-roadmap.md` BUG-22 — practice Baseball is now always exactly 1 leg/
  1 set, so that branch became unreachable; see BUG-22 for why.)
- **Home page leaderboards** (`renderHomeTabBodyBaseball()`, mirroring
  `renderHomeTabBodyCricket()` exactly): `homeTabRenderer` flipped from `false`
  to the new renderer, so Baseball now appears on the Home page's game-type
  toggle. Four boards, the direct RPI/Perfect Inning/Wins/Perfect Game analogs of
  Cricket's MPR/9 Marks/Wins/Perfect Leg — `getBaseballRpiLeaderboard(mode)`,
  `getBaseballPerfectInningsStats(mode)`, `getBaseballWinLeaderboard()` (H2H
  only, no `mode` param), `getBaseballPerfectGameStats(mode)` — all new
  `backend/db.js` functions, fetched in the same upfront `renderHome()`
  `Promise.all` Cricket's own four already use (`homeData.baseball.h2h`/
  `.practice`/`.wins`).

Verified with an 11-case addition to `backend/test/db.baseball-stats.test.js`
(4 new `describe` blocks for the leaderboard functions, mirroring
`db.cricket-stats.test.js`'s own coverage of its 4 equivalents) and a live
Playwright check of the full chain: a perfect 9-inning, 81-run H2H match →
both achievements firing and appearing in the Badge Case → GAME OVER screen
showing the Share button and per-leg stat panel → Home page's Baseball tab
showing all four leaderboards populated correctly.

**Still open (deliberately out of scope)**:
- **Committed tests**: `backend/test/scoring.test.js`'s
  `evaluateVisitBaseball`/`baseballInningTarget` suite (16 cases) covers target
  scoring, round/match completion, the exact-tie-continues-to-extra-innings rule,
  and the extra-innings target — per CLAUDE.md's "every new calculation gets a
  committed test" convention. No Playwright end-to-end pass covering the whole
  New-Game-to-completion flow as a single automated script yet (verified live and
  by hand instead, both for the core game and for this stats pass).

## Killer (rules primer — for whoever builds this next)

Elimination-style: each player is racing to be the last one with lives remaining,
not the first to reach a score. Genuinely different from every game type above in
one way that matters architecturally — **the set of legal targets is per-player and
assigned when the match starts**, not a fixed shared target set like Cricket's
`config.numbers`.

**Ruleset sourced from dartscorner.com's published Killer rules** (their page
couldn't be fetched directly — this session's egress policy returns a 403 on that
host — so this was retrieved via search instead, cross-checked across two separate
search passes that both converged on the same numbers, with the dartscorner.com/
dartscorner.co.uk page cited as the source in the results). This replaces an
earlier draft of this section that got the life mechanic wrong (guessed at a flat
"start with N lives, double = become a killer" model) — the real mechanic scales
by ring throughout, in both directions:

- **Assigning numbers (physical game)**: each player throws one dart with their
  *non-dominant* hand; whatever number it lands in becomes their assigned number
  for the rest of the game (no bull); a duplicate re-throws until landing on an
  unclaimed number. Turn order is then decided separately — everyone throws at the
  bull with their dominant hand, closest to bull goes first. Neither mechanic maps
  onto a digital scorer as-is (there's no "throw to claim a number" input flow
  anywhere else in the app): assigning numbers **randomly at Start** is the
  pragmatic digital equivalent (same "locked in for real" moment Cricket's exact-7
  validation happens at, not re-rolled per leg), and turn order can just follow
  the existing player-entry-order convention every other game type already uses
  rather than simulating a closest-to-bull throw-off — both are judgment calls to
  confirm, not further sourced facts.
- **Becoming a "killer" — scales by ring, not a fixed double requirement**: every
  player starts at **0** lives on their own number. Hitting your own number scores
  lives toward killer status at the same rate every ring always scores elsewhere
  in this app — single = 1 life, double = 2, treble = 3. The instant a player's
  own-number life total reaches **3** (dartscorner's stated standard, not merely a
  suggestion — a treble on the very first dart clears it in one throw and can even
  overshoot to a starting pool above 3), they become a killer and can start
  attacking. Until then, every dart they throw — at their own number or anyone
  else's — either builds toward this threshold (own number) or does nothing
  (anyone else's number). This still needs **per-dart evaluation**, the same
  architectural wrinkle Doubles Practice already established: a player can cross
  the killer threshold on dart 1 of a visit and use darts 2–3 of that *same* visit
  to attack, so the turn engine can't wait for a full 3-dart visit like X01/Cricket
  do — `evaluateDartKiller(dart, playerState)` per dart, mirroring
  `evaluateDartDoublesPractice()`'s precedent in `frontend/scoring.js`.
- **Attacking opponents — resolves the old "how many lives does a hit remove"
  open question**: once a killer, hitting an opponent's assigned number removes
  lives from their total at the identical rate — single = −1, double = −2,
  treble = −3. It directly mirrors the multiplier, not a flat 1 per hit as an
  earlier draft of this section had left undecided.
- **Self-kill ("friendly fire") — resolves the old open question, and the real
  answer is asymmetric**: only hitting your **own double** after you're already a
  killer costs you exactly 1 life (a flat cost, *not* scaled by multiplier the way
  attacking is) — you can accidentally eliminate yourself this way. No source
  describes an effect from hitting your own single or treble again once you're
  already a killer, so the practical read is that those are no-ops post-threshold
  — the only two documented outcomes of hitting your own number are "build toward
  becoming a killer" (pre-threshold, any ring) and "lose exactly 1 life via your
  own double" (post-threshold, double only). Worth flagging as an inference from
  what's documented rather than a directly-quoted rule, in case a future source
  contradicts it.
- **Elimination and win condition**: a player reduced to 0 lives is eliminated
  immediately, mid-visit if that's when it happens (whether from an opponent's
  attack or a self-kill) — turn order (which already needs to skip eliminated
  players entirely) must re-derive "whose turn is next" dynamically rather than
  from a static player list, the same class of problem Cricket's win-check already
  solves for "closed but trailing" players who keep throwing defensively. Last
  player left with lives > 0 wins the leg the instant every other player hits 0 —
  this can end a leg mid-round, unlike X01/Cricket where the round always finishes
  for players who already went.
- **Config schema**: `{ lives: 3, numbers: { <playerId>: <1-20> } }` — `lives` is
  the become-a-killer threshold (and, since players start at 0, effectively their
  starting life pool too), defaulting to dartscorner's standard value of 3 but
  exposed as a New Game option rather than hardcoded, the same way X01 exposes its
  starting score as a config choice instead of a single fixed number — some house
  variants play to a higher threshold. The per-player number assignment lives
  inside `games.config` too (assigned once at Start, not re-derived), following
  the same "no schema migration, just a new JSON shape" extensibility point this
  doc already established for Cricket/Baseball's config — unlike Cricket's shared
  `config.numbers`, this is a map, not a flat list, since every player's legal
  "own number" differs.
- **Scoring screen**: unlike Cricket (locked to exactly 7 targets, so a small
  dedicated tap-grid made sense), Killer darts can land on *any* of the 20 numbers
  (someone else's assigned number, an unassigned number, or your own) plus
  misses — much closer to X01's full-board input shape. The existing interactive
  Dartboard SVG scoring screen may be reusable as-is (tap anywhere on the board,
  the turn engine figures out whose number was hit and whether it matters, and
  which ring) rather than needing a new bespoke pad the way Cricket did — a real
  "check before building" candidate once this is picked up, not an assumption to
  build on without verifying first. Whatever screen is used still needs to show,
  per player: their assigned number, current life count, and killer status at a
  glance — none of which the existing X01/Cricket screens display today.
- **Live scoreboard**: a new `renderers.killer` card showing each player's number,
  lives (as discrete pips, not just a number — see accessibility note below), and
  killer status; eliminated players need a distinct "out" visual state rather than
  just disappearing from the card.
- **Stats** (sketch, not finalized): kills-per-game, average lives lost per leg,
  win rate, and a "survived without becoming a killer" style curiosity stat don't
  exist yet in any form — this needs its own `GAME_TYPES.killer.statDefs` and
  backend functions the same way Cricket/Baseball would, not a reuse of X01's or
  Cricket's vocabulary. Achievement ideas floated but not scoped: first blood
  (first kill of a match), an "Untouchable" analog for winning without ever losing
  a life, and — now that self-kill is a confirmed real mechanic, not a maybe — an
  "Own Worst Enemy" badge for eliminating yourself via your own double. Parking
  these here rather than designing them prematurely.
- **Accessibility**: life count must never be color-only (this doc's own standing
  rule, `docs/accessibility-roadmap.md`) — pips plus an `aria-label` stating the
  exact count, and killer/eliminated status needs a non-color signal (icon + text)
  the same way Cricket's closed-number state already does.

### Open questions specific to Killer

- **Minimum player count**: should New Game block Killer below 3 players (the way
  Cricket's exact-7 validation blocks an invalid target count), or just let a
  2-player game play out even though it's a degenerate case (whoever kills the
  other first, which is really just X01 with extra steps)?
- **Number reassignment**: numbers are assigned once at Start for the whole
  match — does a rematch/"play again" re-roll assignments, or keep the same ones?
  Leans toward re-roll (matches Cricket's classic/custom being re-chosen per
  match), not decided.
- **Turn order**: simulate the source's closest-to-bull throw-off, or just reuse
  the existing player-entry-order convention every other game type uses? Leans
  toward the latter for consistency with the rest of the app, not decided.
- **Is the become-a-killer threshold (`config.lives`) actually worth making
  configurable**, or should it just be hardcoded to the sourced standard of 3
  since no variant has been requested yet? Leans toward configurable (cheap to
  build, matches X01's precedent of exposing this kind of number), not decided.

### Implementation notes (2026-07, shipped)

Built essentially as designed. The open questions above were resolved as follows:

- **Minimum player count**: no dedicated block below 3 — Killer just requires
  2+ players like every other H2H game type (a new `h2hOnly` flag, the inverse
  of the existing `soloOnly` flag, keeps it off the practice/1-player New Game
  list entirely). A 2-player game is allowed and does play out as "X01 with
  extra steps," exactly as this doc anticipated, rather than being blocked.
- **Number reassignment**: re-rolled every time, not persisted — numbers are
  assigned inside `createGame()` fresh for every new game row (`assignKillerNumbers()`),
  so a rematch/"Play again" (which always calls `startGame()` again) gets a
  brand-new random assignment, resolving this doc's "leans toward re-roll" note.
- **Turn order**: the existing player-entry-order convention, not a simulated
  closest-to-bull throw-off — resolving this doc's other open lean.
- **`config.lives` configurable**: yes — a New Game setup section offers 2/3/5,
  defaulting to the sourced standard of 3.
- **Config schema**: shipped as `{ lives, numbers: { <playerName>: <1-20> } }` —
  keyed by player **name**, not player id, since `assignKillerNumbers()` zips
  the shuffled 1-20 pool directly against the same name strings every other
  part of the write path already keys on (turns, badges, stats).
- **Scoring screen**: the existing interactive Dartboard SVG is reused
  unmodified, confirming this doc's suspicion — `throwDartKiller(sector, zone,
  missZone, missDepth, bounced)` has the exact same signature as every other
  per-dart-commit mode's handler (Doubles Practice, Just Chuckin' It), so no
  new bespoke pad was needed.
- **Per-dart evaluation required a genuine schema change, not just a code
  wrinkle**: because one 3-dart visit's darts can each affect a *different*
  player (a self-life-build on dart 1, an attack on dart 2), a single `turns`
  row per *visit* could never represent it — this needed a new nullable
  `turns.affected_player_id` column, one row per *dart* for this game type
  only. Validated as an actual architectural necessity, not a convenience,
  before building it.
- **Live scoreboard**: shipped as designed — a new `renderers.killer` card
  (number, lives as pips with an `aria-label` stating the exact count, killer
  status, a distinct "ELIMINATED" state) plus `game.legSummary`'s own
  Killer-shaped branch for the end-of-leg summary cards.
- **Stats**: shipped `GAME_TYPES.killer.statDefs` (games played, win rate, avg
  kills/leg, avg lives lost/leg, and the "survived without becoming a killer"
  curiosity stat this doc floated), a Personal Best (most kills in a leg), and
  a win-rate leaderboard (reusing `getBaseballWinLeaderboard()`'s exact shape,
  since Killer has a real `games.winner_id` the way Baseball does).
- **Achievements**: all three floated ideas shipped exactly as sketched — 🩸
  First Blood (first elimination of the match), 🛡️ Untouchable (won without
  ever losing a life), 🙈 Own Worst Enemy (eliminated via your own double).
- **Accessibility**: life count is pips + an `aria-label` stating the exact
  count, never color-only; killer/eliminated status is an icon + text label
  (🔪 Killer / ☠️ Eliminated), not a color signal.

**Deliberately out of scope, decided during the build (not covered by this
doc's own open questions)**: **no save/resume support** — `SAVABLE_GAME_TYPES`
does not include `killer`, unlike every other H2H game type. Mid-match state
(who's a killer, remaining lives, who's eliminated) is fully re-derivable from
replaying `turns` either way, so this is a scope call, not a technical
limitation — worth revisiting if it's ever requested. Turn-order enforcement
(rejecting a turn from a player who isn't actually up next) was also left out
of the write-time consistency guard, matching the existing precedent that no
guard in this app enforces turn order, only arithmetic.

Full write-up: `REFERENCE.md` §28; committed tests in
`backend/test/scoring.test.js`, `backend/test/db.turn-consistency-guard.test.js`,
`backend/test/db.killer-stats.test.js`.

## Other known variants (backlog, not designed yet)

- **Round the Clock** — hit 1 through 20 in order, then bull.
- **Shanghai** — single + double + treble on the same number in one visit is an
  instant win.
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

## Practice Drill Modes (2026-07 — Doubles Practice and Just Chuckin' It both built)

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
established, not a registry redesign. **Just Chuckin' It (built 2026-07, see its
own section below) took the identical treatment** — its own dedicated
`throwDartChuckin()`/`renderGameChuckin()` functions, no round/leg concept
whatsoever (unlike Doubles Practice's repurposed `legNo`-as-round-counter — a
Chuckin session has no round boundary at all, just one continuous stream of darts
per `games` row).

### Just Chuckin' It — ✅ Built (2026-07)

Freeform, completely unscored practice — no starting score, no countdown, no bust, no
win, just recording dart after dart until the player stops. The point is pure
warm-up/muscle-memory reps without any game pressure at all, with heatmap-heavy
reporting to see accuracy patterns/trends over time.

- **`game_type='chuckin'`**, always solo (single-slot New Game screen, `setMode('chuckin')`),
  one continuous session per `games` row — the whole session shares `set_no=1,
  leg_no=1` (no round/leg concept at all, unlike Doubles Practice's repurposed
  `legNo`-as-round-counter). "A session" = `t.game_id` grouping throughout
  `backend/db.js`, not `(game_id, set_no, leg_no)`.
- **Turn engine**: every dart is its own 1-dart turn, committed immediately via a
  dedicated `throwDartChuckin(sector)` (same "hardcode a `gameType` branch at every
  shared call site" precedent as Doubles Practice — `throwDart`, `renderGame`,
  `renderPad`, `undoLastTurn`, `liveSnapshot`, `renderGameShell`) — no bust/win
  evaluation of any kind.
- **The exclusion principle this section originally flagged turned out to be exactly
  right**: a `NOT_CHUCKIN` SQL constant (`AND g.game_type != 'chuckin'`) excludes
  Chuckin from 5 previously-unscoped "physical dart stats" queries
  (`getDartAnalytics`, `getAroundTheWorldProgress`, `getHomeExtra`'s pace/today/week
  legs, the practice-legs counts in `getSummary()`/`computeStats()`) — deliberately
  *not* folded into the central `_mf()`/`_scope()` helpers, since Chuckin's own stat
  functions explicitly scope `gameType:'chuckin'` and would contradict a blanket
  exclusion placed there. **The one documented exception, per the user's explicit
  request, is total darts thrown** (lifetime, daily, and weekly) — those three
  aggregates were already fully unscoped with zero `game_type` filtering and needed
  no code change at all, since "darts thrown" already meant literally every physical
  dart, Chuckin included.
- **Stats, heatmap-first as requested**: `getChuckinStatBubbles()` (darts thrown,
  treble/bull/double counts+%, sessions played, avg darts/session),
  `getChuckinPersonalBests()` (best session by darts and by trebles — no
  win/streak-shaped fields, since a session never "wins"), and
  `getChuckinHeatmap()` (per-`(sector,multiplier)` hit counts feeding a
  non-interactive dartboard heatmap on the Player Profile, shaded by relative hit
  frequency with hover tooltips for exact counts — a separate `buildChuckinHeatmap()`
  duplicating (not reusing) the live scoring dartboard's geometry helpers, to avoid
  any risk to the heavily-used interactive board). 6 matching `getMetricHistory()`
  cases for trend charts. Reachable via its own button on the Player Profile's N-way
  game-type toggle (`homeTabRenderer:false` opts it out of the *Home* page's
  leaderboard toggle specifically, since none of its stats map onto a Home
  leaderboard shape — deferred, not a gap).
- **✅ Done (2026-07, follow-up pass): Three-Dart Average + 180s + the `chuckin180`
  achievement + a live Scoreboard dartboard heatmap.** `getChuckinStatBubbles()`
  gained `avg` (the standard 3-dart average, same formula as X01) and
  `oneEighties` (a count derived by grouping darts into non-overlapping runs of
  3, in throw order, never spanning two sessions — `CHUCKIN_GROUPS_OF_3`'s
  `ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY d.id)` window function),
  plus matching `chuckinavg`/`chuckin180s` metric-history cases. A 19th badge,
  **`chuckin180`** ("180! 🎯"), fires whenever a completed group of 3 sums to
  exactly 180 — checked inline in `throwDartChuckin()` via the identical
  grouping rule replayed client-side in a rolling `p.dartBuffer`. Unlike the 18
  milestones (deliberately not undo-revocable), `chuckin180` **is** revoked on
  undo — it's a moment-style badge like Hat Trick, not a slow-building
  milestone, so the per-dart snapshot now carries `badgeReverts`/`voided` the
  same way X01/Cricket/Doubles Practice's snapshots already do. The Live
  Scoreboard (`renderers.chuckin.card()`, `display.html`) also gained a live,
  **session-only** dartboard heatmap (a separate, gradually-filling-in dataset
  from the Player Profile's lifetime one — `buildChuckinLiveHeatmap()`, a
  mirror-copied port of the Player Profile's own SVG geometry, no shared module
  between the two files) alongside the running darts-thrown counter and 3-dart
  average, laid out side-by-side in landscape and stacked in portrait. No
  `ALLOWED_LIVE_KEYS` change was needed — the new `heatmap`/`sessionAvg` fields
  ride inside the already-unrestricted per-player `players[]` array.
- **✅ Done (2026-07, same pass): a brief explanation on the New Game page** —
  a `chuckin-info-section`, shown only when the Just Chuckin' It sub-mode is
  selected, explaining the mode's purpose in plain language.
- **18 laddered milestone achievements**, exactly as requested ("ladder the
  achievements so there are a lot to earn and that earning them starts early and
  often"): 3 ladders — lifetime darts thrown (9 tiers: 100 → 100,000), trebles hit
  in a single session (4 tiers: 100 → 1,000), and lifetime trebles hit (5 tiers: 10
  → 1,000) — generated from a single `CHUCKIN_MILESTONE_LADDERS` data array (not 18
  hand-written badge definitions) feeding `BADGE_INFO`/`ACH_LABELS`/`ACH_DURATION`.
  Checked after every dart via `checkChuckinMilestones()`, computed **entirely from
  local per-player state** (`p.sessionDarts`/`p.sessionTrebles` plus a
  `lifetimeDartsBase`/`lifetimeTreblesBase` fetched once at game start) rather than
  a network round-trip per dart — this mode is built around rapid successive
  throws, and an earlier revision that re-queried the stats endpoint after every
  single dart was found (during Playwright testing) to occasionally lose darts
  outright: enough requests-per-second tripped the server's per-IP rate limiter,
  and a 429 on the `recordTurn` write itself is silently swallowed by the client's
  write queue. No undo-revocation (deliberate deviation from Around the
  Clock/World's precedent — a low-stakes practice-mode milestone staying earned on
  an undone dart is a harmless edge case, not worth the added plumbing).

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
- **Built later (2026-07)**: achievements/badges for this mode — none were
  requested in this pass, but `docs/archive/culture-badges-roadmap.md` Part B
  subsequently added a lifetime doubles-hit milestone ladder plus 🎪 **Ring
  Master** (hit every double D1–D20 + bull lifetime), `DOUBLES_HIT_MILESTONE_LADDERS`
  in `frontend/index.html`.
- **Fixed (2026-07, follow-up pass): the Doubles Practice Home page tab no
  longer shows while H2H is selected.** Since this mode has no H2H equivalent
  at all, its Home leaderboard tab only makes sense under Practice — a new
  `soloOnly:true` flag on `GAME_TYPES.doubles_practice` hides it from
  `renderHomeGameTypeTabs()` while the top-level H2H tab is active, and
  `switchHomeTab('h2h')` bounces `homeGameType` back to `'x01'` if this type
  was showing, rather than leaving its solo data visible mislabeled as H2H
  content.
- **Changed (2026-07, same pass): moved off the New Game page's top-level Mode
  row.** Doubles Practice and Just Chuckin' It are both solo practice
  variants, not their own mode alongside H2H/Practice/Daily Challenge/Ghost —
  they now live behind a "Practice type" sub-toggle that only appears once
  Practice is selected (the top-level Practice button stays pressed for all
  three sub-modes). Purely a New Game UI reorganization — no change to
  `setMode()`'s underlying state handling or any game logic.

### Guided Around the Clock / Around the World — ✅ Built (2026-07)

> Distinct from the plain "Round the Clock" backlog bullet above (§Other known
> variants) — that's a proposed brand-new **game type** with its own win
> condition (a genuine match, playable H2H); this is a **drill**, the same
> shape as Doubles Practice/Just Chuckin' It — solo, no opponent, ends when
> the player finishes or quits.

Around the Clock (every number 1-20 hit as a single, within one game) and
Around the World (all 63 dart outcomes, lifetime) were previously **passive**
completion badges only — checked incidentally during whatever game you
happened to be playing (`singlesHit` in X01's `newMatchPlayer()`,
`getAroundTheWorldProgress()`'s async lifetime query), never something you
actively sat down to practice. They now also each have a dedicated drill mode
built on the identical mechanism, with live progress feedback — the existing
passive badges are unchanged and keep firing exactly as before, from any mode.

- **Built**: two new game types, `around_the_clock` and `around_the_world` —
  their own `throwDartAroundTheClock()`/`renderGameAroundTheClock()` and
  `throwDartAroundTheWorld()`/`renderGameAroundTheWorld()` pairs (the same
  "hardcode a `gameType` branch" precedent both existing drills established,
  not a registry redesign). No schema changes at all — both just added to
  `KNOWN_GAME_TYPES`.
- **Resolved (was an open question): Around the Clock's target set is 20
  numbers only, no bull** — matches the existing passive `around_the_clock`
  badge's exact formula (`singlesHit.size >= 20`) exactly, even though this
  section's earlier draft said "+bull". A round ends the instant all 20 are
  hit as singles; `game.legNo` is repurposed as a round counter and
  `turns.bust` as "this dart completed the round," the identical repurposing
  Doubles Practice already established for both columns. "Start Next Clock"
  starts a fresh round in the same `games` row.
- **Around the World**: no round boundary at all — structurally identical to
  Chuckin (one continuous stream of 1-dart turns per `games` row, `set_no=
  leg_no=1` throughout), tracking progress toward the same lifetime 63-outcome
  set `getAroundTheWorldProgress()` already computes (not reset per session).
  The session never force-ends; reaching 63/63 is a notable event, not a stop
  condition.
- **Live progress feedback** — the whole point of making these dedicated
  modes rather than leaving them passive: a persistent on-screen progress
  grid (which numbers/outcomes are done, which remain), reusing the existing
  Player Profile "Around the World Progress" grid concept
  (`docs/archive/achievements-badges-roadmap.md` flagged that view as
  "meaningfully more UI work than everything else combined" when it first
  shipped). `buildOutcomeGridHtml()` was extracted from
  `renderAroundTheWorldProgress()`'s guts into a shared helper (`cells:'all'`
  for the 63-outcome World grid, `cells:'numbers'` for the 20-cell Clock
  grid) that both the static Player Profile section and the two drills' live
  in-game views now share — reusing it here is the payoff of that earlier
  work, not a second build from scratch. As part of the extraction, each cell
  gained a non-color checkmark + `aria-label` and the live views wrap it in an
  `aria-live="polite"` region (docs/accessibility-roadmap.md's standing "not
  color alone" requirement — this upgrades the existing static Player Profile
  grid's accessibility for free, not a separate pass). The Live Scoreboard
  (`display.html`) gets its own compact mirror-copied port,
  `buildOutcomeGridCompact()`, following the same "no shared module between
  the two files" precedent Chuckin's live heatmap already established.
- **New leg/pace exclusion, separate from `NOT_CHUCKIN`**: Around the World
  shares Chuckin's exact "no round boundary, one continuous stream" shape, so
  a new `NOT_CONTINUOUS_STREAM` constant (`backend/db.js`) excludes it from
  the same leg-count/pace aggregates Chuckin is already excluded from
  (`practiceLegs`, `todayLegs`/`weekLegs`, `_pace()`) — but Around the Clock
  (genuine round=leg boundary, same shape as Doubles Practice, which is *not*
  excluded) stays included in all of them. `getDartAnalytics()` and
  `getAroundTheWorldProgress()` deliberately keep using the narrower
  `NOT_CHUCKIN` instead — the former because targeted-practice darts belong in
  cross-game-type sector analytics (the existing Doubles Practice precedent),
  the latter because it's literally the tracker this feature exists to feed.
- **Stats**: `getAroundTheClockStatBubbles()`/`getAroundTheClockPersonalBests()`
  (dartsThrown, sessionsPlayed, completions, completionRate,
  avgDartsPerCompletion, bestCompletionDarts — "darts taken to complete" and
  "fastest completion," exactly as originally planned) and
  `getAroundTheWorldDrillStatBubbles()`/`getAroundTheWorldPersonalBests()`
  (dartsThrown, sessionsPlayed, avgDartsPerSession, plus the same lifetime
  progress fraction the Player Profile grid shows — "sessions played," as
  planned; no per-round "fastest completion" concept, since this mode never
  finishes). Confirmed no new formulas were needed — completion is boolean
  per-number/per-outcome tracking, wrapped in a session/round grouping query.
  Two new Home page leaderboard boards for Around the Clock (Fastest
  Completion, Most Completions) and one for Around the World (Lifetime
  Progress), mirroring Doubles Practice's Home tab precedent.
- **Resolved (was an open question): guided-session completion awards new,
  distinct badges** — `guided_clock` (🧭) and `guided_world` (🗺️), grouped
  into a new "Practice Drills" Badge Case section — rather than reusing the
  existing passive `around_the_clock`/`around_the_world` badges, which keep
  firing unrelated to this feature. Both are wired through the same
  per-dart-snapshot `badgeReverts`/`voided` undo-revocation mechanism every
  other moment-style badge uses, so undoing the completing dart un-earns it.

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
5. **✅ Done (2026-07) — Baseball**, full stats/achievements parity, as the
   second proof that the plugin shape generalizes, not just fits Cricket
   specifically. Turn engine (`evaluateVisitBaseball()`), New Game setup (fixed
   9 innings, no further config), dedicated scoring screen and
   `renderers.baseball` live-scoreboard card (chalkboard shape, reusing
   Cricket's exact layout/CSS). Verified with a 16-case committed unit suite
   (`backend/test/scoring.test.js`) covering inning-target scoring, round/match
   completion, the exact-tie-continues rule, and extra innings.
   **✅ Player Profile stats parity** (`getBaseballStatBubbles()`/
   `getBaseballPersonalBests()`/`getBaseballWonLegs()`, 6 stat bubbles, 5-field
   Personal Bests, 6 metric-history cases).
   **✅ Achievements, matchwin moment card/Share button/practice stat panel,
   and Home page leaderboards** (`getBaseballRpiLeaderboard()`/
   `getBaseballPerfectInningsStats()`/`getBaseballWinLeaderboard()`/
   `getBaseballPerfectGameStats()`, `renderHomeTabBodyBaseball()`, Perfect
   Inning/Perfect Game badges) — see "Baseball" above for the full write-up.
6. **✅ Done (2026-07): generalize the Player Profile/Home page game-type toggle**
   beyond hardcoded per-type buttons — see "Toggle mechanism generalized" above.
   The toggle mechanism itself is N-way now; the backend stat-fetch side of the
   same concern (a bespoke SQL function set per type, forever) — Just Chuckin' It's
   own bespoke set shipped as part of item 9 below, and Baseball's own followed in
   a later pass (see item 5's update above) — confirming the pattern holds without
   ever needing the generic-parameterized-query redesign this section originally
   floated as an open question.
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
9. **✅ Done — Just Chuckin' It** — the second Practice Drill Mode built, resolving
   its own match-vs-drill question the same way Doubles Practice did (reusing
   `practice`/`game_type` as-is, no round/leg concept whatsoever). Heatmap-first
   Player Profile stats, a `NOT_CHUCKIN` exclusion audit across 5 previously-
   unscoped queries (with total-darts-thrown as the one deliberate exception),
   and 18 laddered milestone achievements generated from a single data-driven
   ladder array. Verified with a committed scratch-DB unit suite (backend stat
   functions + an X01/Cricket isolation regression check + the achievement
   threshold comparison, `frontend/scoring.js`'s `chuckinTiersReached()`) and
   Playwright end-to-end (New Game setup, per-dart scoring screen, undo, the
   `/display` live scoreboard, the Player Profile tab with dartboard heatmap and
   trend chart, and all 3 milestone ladders firing correctly in both
   `index.html` and `display.html`, including a real per-dart rate-limit/data-
   loss bug this testing caught and fixed).

## Cricket badge parity — one gap fixed, one still open

Cricket shipped with exactly 2 badges (9 Marks, Perfect Leg) against X01's 20 —
thin, and part of that gap was an accidental side effect of code structure, not
a deliberate scoping decision.

### 1. ✅ Built (2026-07): Night Owl / Early Bird are no longer X01-only

Was: Night Owl/Early Bird were only checked from `enterTurn()` — X01's own
turn-commit function — never `enterTurnCricket()`. Neither badge's condition
(`local hour < 5` / `>= 5 && < 7`) has anything to do with X01 specifically; a
Cricket player who only ever played at 4am could never earn either badge,
purely because the check lived in the wrong function, not because of a real
design decision to exclude Cricket.

Fixed by extracting the shared logic into `awardTimeOfDayBadges(p)`
(`frontend/index.html`), called from both `enterTurn()` and
`enterTurnCricket()` — same `badgeId`s, so a player's count is shared across
game types (these are about *when* you play, not *what* you play). Undo works
for free: `awardRecurringBadge()` reads `game.lastTurnSnapshot` generically
(whichever the caller most recently set), so no Cricket-specific undo handling
was needed. Verified end-to-end with Playwright against a live server: a
Cricket turn committed at a monkey-patched `Date.prototype.getHours() = 3`
fires `POST /api/badges/award {badgeId:'nightowl'}`, and an X01 turn at hour 6
still fires `earlybird` unchanged (regression check).

### 2. New Cricket-native badges (not X01 ports) — ✅ Built (2026-07)

Rather than forcing X01 concepts (checkout-based Comeback Kid, average-based
Giant Slayer) onto a game with no checkouts and a different averaging concept
(MPR), two badges shaped around what actually makes a Cricket leg dramatic —
both 2-player only, same restriction as X01's own social/margin-of-victory
badges:

- **🧹 Whitewash** (`cricketwhitewash`) — won a leg without the opponent
  closing a single number. The pure trigger condition,
  `isCricketWhitewash(opponentMarks)` (`frontend/scoring.js`, unit-tested in
  `backend/test/scoring.test.js` — the same "extract for testability"
  precedent `challengeBadgeSignals()`/`chuckinTiersReached()` already set),
  checked in `onLegWonCricket(wi)` (`frontend/index.html`) once the leg's
  winner and opponent are known — a genuine Cricket-native dominance signal,
  the same spirit as X01's margin-of-victory badges but shaped around
  Cricket's own win condition (closing numbers) instead of remaining score.
- **🔥 Comeback Kid (Cricket)** (`cricketcomebackkid`) — won a leg after
  trailing on points by 20+ at some point during it, mirroring X01 Comeback
  Kid's structure but tracking Cricket's own `points` field instead of X01's
  remaining-score deficit. A new `p.legWorstPointsDeficit` field on the
  Cricket player record (`newMatchPlayerCricket()`) accumulates the running
  worst deficit per-visit in `enterTurnCricket()`, the exact same "sample
  before this visit's own update, using the opponent's currently-committed
  points" timing X01's `legWorstDeficit` already uses — restored on undo the
  same way every other per-leg achievement-tracking field is. The threshold
  itself (20 points — Cricket's points scale is much smaller/more variable
  than X01's 501 countdown, so X01's 100-point threshold doesn't transfer
  directly) is a separate pure function, `cricketComebackAchieved()`
  (`frontend/scoring.js`, unit-tested), chosen with the user rather than
  guessed. Has its own `badgeId`, distinct trigger mechanics from the X01
  version (same reasoning as the tournament Giant Slayer note above).

Both badges reuse the existing generic recurring-badge machinery
(`awardRecurringBadge()`/`POST /api/badges/award {once:false}`) — no backend
schema or route changes were needed. Verified end-to-end with Playwright
against a live server: a 2-player Cricket leg where the opponent never marks a
single number correctly fires Whitewash; a separate leg where the eventual
winner trails by 57 points (well past the 20-point threshold) before closing
everything out for the win correctly fires Comeback Kid (Cricket) — and a
leg where the "trailing" opponent *did* close a number along the way
correctly does **not** also fire Whitewash, confirming the two conditions
don't leak into each other.

A Cricket equivalent of Giant Slayer/The Rematch/Grudge Match (all of which key
off an X01-specific lifetime-average or H2H-summary lookup) was considered and
deliberately left **out of scope** for this pass — it would need a
Cricket-specific "lifetime MPR" comparison surface that doesn't exist yet
anywhere else in the app, which is a bigger lift than the two badges above.

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
  the round" (see REFERENCE.md §2/§13). **Resolved the same way for Just
  Chuckin' It** (built 2026-07) — also just `practice`/`game_type` as-is, but
  with no round concept repurposed at all: a whole session is one continuous
  stream of 1-dart turns sharing `set_no=1, leg_no=1`.
- **Resolved** (was: for Doubles Practice, how does a multi-double session pick
  which double is "live"): **all simultaneously live**, no rotation, no random
  pick — see the "Doubles Practice" section above.
- **New**: does the per-game-type stats toggle (Player Profile/Home page)
  generalize by literally listing every `GAME_TYPES` entry, or only the ones a
  given player has actually played (so a player who's never touched Cricket
  doesn't see an all-empty Cricket tab)? Leans toward the latter, not decided.
