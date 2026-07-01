# Additional Game Modes — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

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
- **The dart-entry UI** (number pad, interactive dartboard SVG, multiplier buttons)
  just captures "sector + multiplier" taps — it has no concept of which game is being
  played. Reusable as-is for Cricket, Baseball, anything.
- **The live scoreboard** already has a `gameType` field on its snapshot and a
  `renderers` dispatch table in `display.html`, built during the scoreboard redesign
  specifically so a Cricket renderer could plug in later without touching the X01 one
  (`frontend/display.html`, `renderers.x01`). That groundwork pays off directly here.

## The architecture: a game-type plugin interface

Each game type implements the same shape:

- **Config schema** — what the New Game setup screen asks for. X01: starting score
  (501/301/170). Cricket: which numbers are in play (a multi-select of any subset of
  1–20 + Bull, with quick presets like "Standard: 15–20 + Bull" for convenience).
  Baseball: inning count (normally fixed at 9).
- **Turn engine** — given the darts thrown this visit plus current per-player state,
  computes the new state: X01 decrements score and checks bust/checkout; Cricket
  updates marks-per-number and closed status and computes points scored (gated on
  whether opponents have closed that number); Baseball adds runs to the current
  inning.
- **Win condition checker** — X01: first to zero on a legal finishing dart. Cricket:
  first to close every in-play number while leading on points. Baseball: highest
  total runs after N innings.
- **Live scoreboard card renderer** — slots into `display.html`'s existing `renderers`
  table.
- **Stats definitions** — each plugin defines its own stat vocabulary (see Cricket
  stats below), not just reusing X01's.

`newMatchPlayer()` and the turn-processing logic in `frontend/index.html` (currently
hardcoded to X01 fields like `score`, `doubleOut`) get refactored to delegate to the
active plugin. This refactor is Phase 1 of the build order below, done *without
changing X01 behavior at all* — proving the abstraction is sound before Cricket
depends on it.

## Data model

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
- **Known coupling to fix during the refactor**: the nine-darter detection query
  hardcodes `g.category='501'` (`db.js`, `computeStats`/`getSummary` area) — this
  becomes `g.game_type='x01' AND json_extract(config,'$.startingScore')=501`.

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
today's starting-score buttons; Cricket shows the number multi-select with presets.
Legs/sets/best-of stays universal across types — that concept isn't X01-specific.

## Suggested build order

1. **Refactor, no new behavior** — extract the existing X01 logic behind the plugin
   interface; prove X01 plays identically before anything else depends on the
   abstraction.
2. **Cricket engine + customizable numbers** — turn engine, win condition, New Game
   config UI, scoring-screen card (marks/closed display instead of a countdown).
3. **Cricket stats parity** — MPR, leaderboards, profile charts, achievements.
4. **Home/Stats page game-type navigation** — the cross-cutting UI work to surface
   Cricket stats alongside X01's.
5. **Baseball** (or another variant) as the second proof that the plugin shape
   generalizes, not just fits Cricket specifically.

## Open questions for whoever picks this up

- Exact Cricket win-condition edge case (closed-but-behind-on-points) — see above.
- Should legs/sets apply to Cricket the same way as X01, or does a Cricket "match"
  more naturally mean a fixed number of games rather than legs-within-a-set?
- Priority after Cricket: Baseball, or one of the other named variants?
