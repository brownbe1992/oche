# Additional Game Modes — Design Roadmap

> Status: **not started** (Cricket/Baseball themselves). Build-order step 1, the
> plugin refactor, is done: `frontend/index.html` now has a `GAME_TYPES` registry
> (`newMatchPlayer`, `evaluateVisit`, `resetForNextLeg`, `playerSnapshot`,
> `statDefs`), currently holding only `x01`, and every call site that used to call
> those functions directly now dispatches through `GAME_TYPES[game.gameType]` —
> proven behavior-identical to the pre-refactor code via Playwright (bust, double-out
> win, undo, 180 achievement, live scoreboard) and db.js unit tests. Backend
> `createGame()` now accepts optional `gameType`/`config` params (still defaulting to
> `'x01'`/derived-from-category for every caller today), and the nine-darter queries
> that hardcoded `category='501'` now read `game_type`/`config` instead (with a
> one-time backfill for historical rows, since `config` itself was never backfilled
> when the column was added). See the Data model section below for details. Cricket's
> own engine, config UI, scoring screen, and stats (build-order steps 2-4) are still
> not started. The spec for step 2 is now more fully fleshed out based on explicit
> feature requests: Cricket needs its own dedicated scoring screen (Pad/Dartboard are
> never used during a Cricket game, and the Cricket screen is the automatic default),
> a classic-vs-custom New Game prompt where custom mode locks the target count to
> exactly 7 (never more, never fewer), and an orientation-aware (portrait/landscape,
> auto-detected) live scoreboard — the last of which depends on a new prerequisite
> prep project, `docs/existing-app-prep-roadmap.md` item 11, retrofitting the
> *existing* X01 scoreboard with the same orientation-awareness first.

## Goal

Support multiple dart game types beyond X01 (501/301/170) — starting with a
customizable Cricket (choose any numbers to play, not just the standard 15–20 + Bull)
— built as a real extensible framework so more game types (Baseball and others) can be
added later without starting from scratch each time.

## Decisions made (2026)

| Decision | Choice |
|---|---|
| Architecture approach | Proper generalization now — refactor X01 into "the first plugin" in a real game-type framework, rather than bolting Cricket on separately |
| Cricket stats depth | Full parity with X01 — a dedicated Cricket stat (Marks Per Round), leaderboards, and profile charts, not just win/loss |
| Cricket variant scope for v1 | Standard cricket only (highest score wins). Cut-throat (points scored against opponents) deferred to later |
| Custom cricket target count | Fixed at 7 targets — the same count as classic cricket (15, 16, 17, 18, 19, 20, Bull) — freely chosen from 1-20 + Bull, but never more or fewer than 7 |
| Scoring screen during Cricket | A dedicated Cricket scoring screen (marks/closed grid), not the X01 Pad or Dartboard screens — it's the automatic default the instant a Cricket game is active, with no player choice to fall back to Pad/Dartboard |
| Live scoreboard orientation | Cricket's `display.html` renderer must detect and support both portrait and landscape. Retrofitting the *existing* X01 renderer with the same orientation-awareness is a prerequisite prep project — see `docs/existing-app-prep-roadmap.md` item 11 |

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
  dispatch mechanism needed, just a `renderers.cricket` entry. What it does **not**
  yet cover is orientation: neither `renderers.x01` today nor a future
  `renderers.cricket` has any portrait/landscape awareness — see
  `docs/existing-app-prep-roadmap.md` item 11.

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
  detection (see `docs/existing-app-prep-roadmap.md` item 11 for the X01 retrofit
  that needs to land first).
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

- **Marks Per Round (MPR)** — Cricket's direct equivalent of 3-dart average: total
  marks scored ÷ rounds played. Becomes Cricket's primary leaderboard/chart metric,
  computed from `darts` the same way 3-dart average is today.
- **Cricket-specific achievements** — e.g. "9 marks in one visit" (three darts, each a
  treble on a different open number) as Cricket's analog to a 180; fastest close
  (fewest darts to close all numbers) as an analog to a nine-darter.
- **Home page and Player Profile become game-type-aware** — today Home has one
  H2H/Practice toggle feeding X01-shaped leaderboards; the profile's Stat Bubbles are
  a fixed X01 list (`STAT_DEFS` in `frontend/index.html`). Full parity means these
  need a game-type dimension too (e.g. a game-type selector alongside the existing
  H2H/Practice tabs, each type showing its own bubble set and chart). This is real
  UI/navigation expansion, not just new SQL — flagging it clearly since "full parity"
  implies touching Home, Player Profile, and achievements/Hall-of-Fame sections, not
  just adding a Cricket scoring engine.

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
2. **Cricket engine + customizable numbers** — turn engine, win condition, New Game
   classic/custom config UI (exact-7-target validation), a dedicated Cricket scoring
   screen (marks/closed display, replacing Pad/Dartboard entirely for Cricket
   games), and an orientation-aware `renderers.cricket` live-scoreboard card — the
   last one depends on `docs/existing-app-prep-roadmap.md` item 11 landing first.
3. **Cricket stats parity** — MPR, leaderboards, profile charts, achievements.
4. **Home/Stats page game-type navigation** — the cross-cutting UI work to surface
   Cricket stats alongside X01's.
5. **Baseball** (or another variant) as the second proof that the plugin shape
   generalizes, not just fits Cricket specifically.

## Accessibility, security, and testing considerations

- **Accessibility**: Cricket's scoring screen (marks/closed display) is a new UI
  surface — it should extend the app's existing `aria-pressed`/`role="group"`
  control conventions rather than introducing a one-off pattern, and the
  closed-numbers display needs a non-color-only signal (per
  `docs/accessibility-roadmap.md`) for which numbers are closed vs. still open. The
  new portrait and landscape live-scoreboard layouts (both X01's retrofit and
  Cricket's new one) need to reach parity with each other too — orientation should
  never become "the one where the announcements/contrast work and the other one
  where they don't."
- **Testing**: the Cricket win-condition edge case flagged above (closed-but-behind-
  on-points) is exactly the kind of easy-to-get-wrong, pure win-condition logic
  `docs/testing-and-observability-roadmap.md` says new scoring logic should get real
  test coverage for — a good candidate to write the test for *before* the
  implementation, given the doc already knows the edge case is tricky. The exact-7
  target-count validation (New Game custom mode) is simple but worth a real test too,
  since it's a hard product rule ("never more, never fewer") rather than a soft
  suggestion.
- **Security**: no new credential/token surface from the plugin refactor or Cricket
  itself — reuses the existing game/turn recording and admin-auth model.

## Open questions for whoever picks this up

- Exact Cricket win-condition edge case (closed-but-behind-on-points) — see above.
- Should legs/sets apply to Cricket the same way as X01, or does a Cricket "match"
  more naturally mean a fixed number of games rather than legs-within-a-set?
- Priority after Cricket: Baseball, or one of the other named variants?
- Is Bull mandatory as one of custom cricket's 7 targets, or can a player build a
  custom set of 7 purely numeric targets (1-20) with no Bull at all? Real cricket
  always plays Bull; this doc doesn't decide whether the app should enforce that or
  leave it as a free choice within the 7.
