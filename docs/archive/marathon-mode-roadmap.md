# Marathon Mode — Design Roadmap

> Status: **shipped (2026-07).** See "Implementation notes" at the bottom of
> this doc for exactly how each open question was resolved, and
> `REFERENCE.md` §30 for the full write-up.

## Goal

A solo endurance session, not a new way to score darts. Set a **45-minute**
timer, throw standard **501 practice legs back to back with no pause
between them**, and let the session's own data tell the story: dart count
per leg, which of three fatigue *patterns* (The Cliff / The Warm Machine /
The Flat Line) the trend line matches, and a **fatigue split** — first-half
vs. second-half average dart count — landing on a tier from Iron down to
Running on Empty.

## The headline design decision: this needs almost no new game logic

Every other solo drill in this doc set (Pressure Chamber, The Gauntlet,
Dead Man Walking) invents a bespoke per-round or per-station mechanic
layered on top of darts. **Marathon Mode invents nothing about how darts
are scored** — every leg is an ordinary, unmodified 501 practice leg,
`evaluateVisit()` untouched, no new bust rules, no new target shapes. The
entire novelty is (1) the **session structure** — chaining legs
automatically with no return to setup, bounded by a wall clock — and (2)
the **analysis layer** computed after the fact. That reframes almost the
whole design problem from "invent scoring rules" to "wire existing
X01 legs together and read the results back."

## How this differs from every existing mode (don't conflate)

- **Session Recap** (`docs/archive/session-recap-roadmap.md`) is the closest
  thematic precedent — a read-time aggregation over already-ordinary
  games, nothing new stored. But it's scoped to a **calendar day**, covers
  **everything** played (any game type, any opponent), and reports "what
  happened," not a fatigue trend. Marathon Mode is scoped to one
  **continuous, self-contained, solo, time-boxed session** with its own
  explicit start/end boundary, and its whole point is the trend/fatigue
  analysis, not a broad recap.
- **League/Tournament mode** (`docs/league-mode-roadmap.md`,
  `docs/archive/tournament-mode-roadmap.md`) are the direct **architectural**
  precedent, not a gameplay one — see Data model below.
- **Daily Challenge's "Speed to Zero" format** (a single full 501 leg,
  fewest darts) is a related but much narrower idea — one leg, no chaining,
  no trend.
- This is **not** a new way to score a leg of X01 — it's a session wrapper
  around legs that already exist unmodified, and gets its own doc the same
  way Session Recap did for the same reason (a wrapper concept, not a
  scoring concept).

## Design

### Architecture: reuse the exact "context table with a `game_id` FK" pattern, not a new game type

Per `CLAUDE.md`'s standing convention — "when a future feature needs to
track that a game belongs to some larger context... that context gets its
own table with a `game_id` foreign key pointing at `games`... apply the
same pattern to any other future context ... rather than adding a fourth or
fifth boolean flag to `games`" — Marathon Mode is exactly the case that
rule anticipates, and `league_fixtures` is the literal schema to mirror
(a lightweight junction table, nullable `game_id` FK, no lifecycle state of
its own beyond what the referenced game already has):

```sql
CREATE TABLE marathon_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  duration_minutes INTEGER NOT NULL DEFAULT 45,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at         TEXT   -- NULL while the session is still in progress
);

CREATE TABLE marathon_session_legs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES marathon_sessions(id) ON DELETE CASCADE,
  game_id    INTEGER REFERENCES games(id) ON DELETE SET NULL,
  leg_order  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_marathon_session_legs_session ON marathon_session_legs(session_id);
CREATE INDEX idx_marathon_session_legs_game    ON marathon_session_legs(game_id);
```

- **No new `game_type`.** Each leg is a completely ordinary `x01`,
  `practice`, single-leg/single-set `games` row (`legs_per_set=1,
  sets_per_game=1`, exactly what a normal quick solo 501 game already is
  today) — it contributes to lifetime X01 stats, Personal Bests, and the
  dartboard heatmap **exactly the same as any other practice leg**, with
  no exclusion needed (contrast Checkout Trainer's hypothetical,
  deliberately-excluded darts — these are fully real throws with no
  reason to be treated differently).
- **`duration_minutes`** stored rather than hardcoded 45, same "store a
  currently-single value for future configurability" precedent Checkout
  Blitz's `durationSec` already set.
- **`marathon_sessions.ended_at`** is the session's own lifecycle marker —
  `NULL` means still in progress (mirrors how `tournament_matches`/game
  completion is tracked by a nullable timestamp elsewhere in this schema).

### The chaining loop (frontend orchestration, not new backend game logic)

1. **Start**: insert a `marathon_sessions` row, then immediately create
   leg 1 via the **existing** `createGame()` path (an ordinary solo 501
   practice game) and link it via `marathon_session_legs(session_id,
   game_id, leg_order=1)`.
2. **On a leg's normal completion** (the existing X01 win/`onLegWon`-style
   completion hook every game type already fires): check the wall clock
   against `started_at + duration_minutes`. If time remains, immediately
   create the next leg the same way (`leg_order` incremented) and
   transition straight into its scoreboard — **no return to the New Game
   setup screen**, the one genuinely new frontend behavior this whole
   feature needs. If time has elapsed, set `ended_at` and show the
   analysis screen.
3. **The 45-minute check happens only at leg boundaries, never mid-leg.**
   Unlike Checkout Blitz's hard mid-round cutoff (a deliberate, previously
   litigated design choice for that feature), a leg here can't sensibly be
   interrupted mid-throw without corrupting an otherwise-normal X01 leg's
   data — so the session's *actual* total duration can run a little past
   45 minutes (however long the in-progress-at-the-deadline leg takes to
   finish). This is the deliberate tradeoff, not an oversight — flagged
   again in Open questions as the one place a stricter alternative was
   considered and set aside.
4. **Manual early stop**: an "End Marathon" control, same shape as
   Checkout Trainer Freeform's own "end session whenever" control, sets
   `ended_at` immediately and shows the analysis over whatever legs
   completed so far.
5. **Reuses `renderers.x01` unmodified** for every leg's live scoreboard —
   the only new UI is a persistent session banner (elapsed/remaining time,
   leg count so far) layered on top of the existing scoreboard, plus the
   post-session analysis screen. No `/display` work needed beyond what X01
   already has.

### Per-leg tracking — already exists, nothing new to store

The pitch's four tracked fields per leg are all already derivable from
existing X01 turn/dart data for that leg's `game_id`, no new columns:

- **Leg number** = `marathon_session_legs.leg_order`.
- **Dart count** = count of darts across that leg's `turns` for the player
  (the same number every existing "fewest darts to finish" Personal Best
  already computes per leg).
- **Checkout** = the winning turn's `checkout_points` (already tracked).
- **Busts** = count of that leg's turns with `bust=1` (already tracked).

### The analysis

Two new pure functions in `frontend/scoring.js` — the only genuinely new
calculations in this whole feature, and the two that need committed tests
per CLAUDE.md's rule:

- **`computeFatigueSplit(dartCountsPerLeg)`** — split the ordered leg list
  into a first half and second half (floor the split on an odd leg count:
  `first = legs.slice(0, Math.floor(n/2))`), average each half's dart
  count, and return `max(0, secondHalfAvg - firstHalfAvg)` — clamped at
  zero because a session where the player got *faster* in the second half
  isn't a fatigue problem to score against them (see Open questions on
  whether that deserves its own positive callout instead of just defaulting
  to the best tier).

  | Fatigue Split | Assessment |
  |---|---|
  | 0–2 darts | Iron |
  | 3–5 darts | Tested |
  | 6–9 darts | Fading |
  | 10+ darts | Running on Empty |

- **`classifyMarathonTrend(dartCountsPerLeg)`** — splits the session into
  three roughly-equal segments (early/middle/late), averages each, and
  classifies:
  - **The Cliff**: early ≈ middle (within a tolerance band), late
    meaningfully worse than both.
  - **The Warm Machine**: early meaningfully worse than middle, late ≈
    middle (an improvement that then holds).
  - **The Flat Line**: all three segment averages within the tolerance
    band of each other — the stated goal pattern.
  - **Inconclusive**: fewer legs than a stated minimum (this doc proposes
    **6**, matching the pitch's own example of "a drop around leg 6–8"
    implying sessions typically run well past that) to attempt a
    three-segment read at all — the same "don't compute a trend on too
    small a sample" discipline Coaching Insights' `COACHING_MIN_*`
    constants already enforce elsewhere in this app, reused here as the
    same kind of floor rather than invented from scratch.
  - Exact tolerance-band width is a first pass for playtesting, flagged
    again below.

### Stats, Personal Bests, leaderboard

- **Stat bubbles**: sessions completed, average legs per session, average
  fatigue split, lifetime trend-pattern breakdown (how many sessions came
  back Cliff/Warm Machine/Flat Line).
- **Personal Best**: **lowest** fatigue split ever (`MIN()` — ascending-is-
  better, the same shape The Gauntlet's Scar count already uses, not the
  more common descending "best run" shape); **most legs completed** in a
  single session (`MAX()`, a stamina/throughput metric).
- **Home leaderboard**: lowest-ever fatigue split, one row per player,
  their single best session — same peak-value, no-floor shape every other
  single-best-run board in this app already uses.
- **A Marathon-scoped average dart count** needs a join through
  `marathon_session_legs` rather than the existing `_scope({mode,
  gameType})` helper alone (that helper scopes by `mode`/`game_type`, not
  by session membership) — worth calling out as a genuinely new query
  shape, not a drop-in reuse of `_scope()`.

### Achievements

Data-driven ladders off `CHUCKIN_MILESTONE_LADDERS` — lifetime sessions
completed, lifetime legs completed inside Marathon sessions (a natural
volume ladder, since a single session can rack up a dozen-plus legs).
One-off badges: 🛡️ **Iron** (reach the Iron fatigue-split tier in a
session), 📉 **Flat Line** (a session classified Flat Line), and ⏱️
**Full Distance** (complete the full 45 minutes without an early "End
Marathon" stop) — a grit/completion badge distinct from the two
quality-of-performance badges above.

## Accessibility, security, and testing considerations

- **Accessibility**: the persistent session banner needs periodic
  `aria-live` announcements of elapsed/remaining time — a coarser cadence
  than Checkout Blitz's 30s/10s/5s (appropriate for a 60-second sprint,
  far too noisy for a 45-minute session; every 5–10 minutes is a more
  sensible starting point, tunable). Auto-continuing straight into the
  next leg with no setup screen needs its own `announce()` ("Leg 7
  starting.") so a screen-reader user isn't left wondering whether input
  is expected. The trend pattern and fatigue tier need icon + text, not a
  color-coded trend chart alone — the chart itself needs a text-table
  fallback, matching the existing heatmap's own accessibility treatment.
- **Security**: no new credential surface. The real guard is
  session/leg-linkage integrity — `leg_order` must be sequential with no
  gaps, a session with `ended_at` already set must reject any further
  linked legs, and a linked `game_id` must actually belong to the same
  player and be a genuine solo practice 501 game — the same kind of
  linkage-validity guard `league_fixtures`/`tournament_matches` already
  enforce for their own `game_id` FKs.
- **Testing**: `computeFatigueSplit()` and `classifyMarathonTrend()` both
  need committed tests against synthetic dart-count sequences representing
  each named pattern (a clear Cliff, a clear Warm Machine, a clear Flat
  Line) plus the too-few-legs "inconclusive" floor and the negative-split
  clamp-to-zero case; the tier-boundary lookups; and the session/leg
  linkage guards (reject a leg appended after `ended_at`, reject
  non-sequential `leg_order`).

## Suggested build order

1. `marathon_sessions`/`marathon_session_legs` schema, proven by manually
   linking a couple of ordinary practice games before any auto-chaining
   UI exists.
2. The chaining loop: start a session, auto-create leg 1, auto-advance on
   completion while time remains, end on timeout or manual stop.
3. The persistent session banner (elapsed/remaining, leg count) on top of
   the existing `renderers.x01` scoreboard.
4. `computeFatigueSplit()` + the 4 tiers, unit-tested first.
5. `classifyMarathonTrend()` + the inconclusive floor, unit-tested first.
6. The post-session analysis screen (trend chart + tier + pattern label).
7. Personal Bests (lowest fatigue split, most legs) + Home leaderboard.
8. Achievement ladders + the 3 one-off badges.

## Open questions for whoever picks this up

- **Hard mid-leg cutoff vs. this doc's "finish the in-progress leg, then
  stop" choice** — the recommended design never truncates a leg, which
  means real session length can run past 45 minutes by however long the
  final leg takes. A stricter alternative (a genuine hard stop, discarding
  or specially marking a truncated leg) was considered and set aside as
  needlessly complex for a solo drill with no opponent waiting — worth
  revisiting only if real sessions are running dramatically over.
- **Does a second-half *improvement* deserve its own positive signal**
  (a badge, a distinct label) rather than just clamping to 0 and reading
  as "Iron" identically to a session with zero fatigue at all? This doc
  defaults to the simpler clamp; a genuinely distinct "got stronger as it
  went" callout is a real, not-yet-designed enhancement.
- **Tolerance-band width** for `classifyMarathonTrend()`'s early/middle/late
  comparison, and the **6-leg minimum** for attempting classification at
  all, are both first-pass numbers for playtesting, not confirmed against
  real sessions.
- **Configurable session length** (30 minutes, 60 minutes) beyond the
  requested fixed 45 — `duration_minutes` is designed to support this
  without a migration, but v1 should ship with just the one duration per
  the original request.
- **Does Marathon Mode make sense for game types beyond X01** (Cricket,
  Baseball) — the pitch is explicitly framed around "standard 501 legs,"
  and the fatigue-split/trend analysis (dart count per leg) maps cleanly
  onto any per-leg-darts-thrown metric, so this could generalize, but
  isn't designed here and shouldn't be assumed for v1.

## Implementation notes (2026-07, shipped)

Built essentially exactly as designed, following this doc's own suggested
build order end to end. The open questions above were resolved as follows:

- **Hard mid-leg cutoff vs. finish-the-leg-then-stop**: shipped exactly as
  this doc's own recommended default — the wall clock is checked only at
  leg boundaries (`finishMarathonLeg()`), never mid-leg. A manual "End
  Marathon" tap, however, ends the session **immediately** (not "wait for
  the current leg"), abandoning whatever leg was in progress — its own
  darts/turns are still real and still count toward lifetime stats, the
  same "stats have been saved" precedent every other early-ended practice
  session already follows. That leg simply never appears in the completed-
  legs list `computeFatigueSplit()`/`classifyMarathonTrend()` read.
- **Second-half improvement**: shipped as this doc's own default — clamps
  to 0 (reads identically to a session with zero fatigue, "Iron"). No
  distinct positive callout was added; still a real, not-yet-designed
  enhancement if it's ever requested.
- **Tolerance-band width (±2 darts) and the 6-leg minimum** for
  `classifyMarathonTrend()`: shipped as this doc's own first-pass numbers,
  unconfirmed against real sessions, exactly as flagged.
- **Configurable session length**: `marathon_sessions.duration_minutes` is
  stored per-session and the backend (`startMarathonSession()`) already
  validates any value 5–240, but v1's own New Game entry always requests a
  flat 45 — no UI control to choose a different length yet.
- **Beyond X01**: not built. Every leg is still exactly a 501 practice game.

**A real, BUG-18-class bug found and fixed while building this**: the
generic X01 `onLegWon()` only ever cascades a leg win up into a full
`finishUnit('game', ...)` when `!game.practice` — practice mode's own
default is to treat every win as "just a leg," offering an endless "Next
leg" button forever, since an ordinary practice session has no match
structure to complete. Ghost Opponent races already needed (and got, back
when BUG-18 was originally found and fixed) a `|| game.hasGhost` carve-out
for exactly this reason. Marathon Mode legs are `practice=1` too (an
ordinary practice game is exactly what each leg genuinely is) — without the
same kind of carve-out, a leg win would never reach `finishMarathonLeg()`
at all, and every leg would just show the ordinary "Next leg" panel
forever, with no auto-chaining and no session ever actually ending. Fixed
by extending the existing condition to `(!game.practice || game.hasGhost ||
game.marathonSessionId)`, mirroring the ghost precedent exactly rather than
inventing a parallel mechanism.

A related decision made during the build, not covered by this doc's own
open questions: **Marathon Mode has no Save Game support**, the same scope
decision Killer already made — `isCurrentGameSavable()` explicitly excludes
any leg carrying a `marathonSessionId`, since the generic resume path
rebuilds a plain `rebuildX01State()` game object with no marathon linkage
at all; a resumed leg would silently finish as an ordinary standalone
practice game instead of continuing the session.

Everything else matches this doc's design: the `marathon_sessions`/
`marathon_session_legs` schema exactly as specified; every leg a completely
ordinary solo practice 501 X01 game (`legsPerSet=1`, `setsPerGame=1`,
contributing to lifetime X01 stats/Personal Bests/Nine-Darter unmodified);
`computeFatigueSplit()`/`classifyMarathonTrend()` in `frontend/scoring.js`,
unit-tested first per the suggested build order; the persistent session
banner (elapsed/remaining time, leg count, `aria-live`) layered above the
unmodified `renderers.x01` scoreboard; the post-session analysis screen;
6 stat bubbles, 2 Personal Bests (one ascending, one descending), a
lowest-fatigue-split Home leaderboard; and the achievement ladders/one-offs.
No `/display` work was needed beyond what X01 already has, exactly as this
doc anticipated. Full write-up: `REFERENCE.md` §30; committed tests in
`backend/test/scoring.test.js` and `backend/test/db.marathon-mode.test.js`.
