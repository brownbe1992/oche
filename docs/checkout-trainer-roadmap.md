# Checkout Trainer — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

A pure mental/recall drill: the app shows a target score, and the player has to work
out — and enter — a legal checkout for it using the **fewest possible darts**, with no
dartboard involved at all. It's a checkout-knowledge trainer, not a throwing game —
meant to be usable standing in line or on a couch with just a laptop/tablet/phone, no
board nearby. No live scoreboard component is needed; this is a single-device,
solo-only experience from end to end.

Two modes, sharing one core mechanic: **Freeform** (untimed, runs until the player
stops — see "Design" below) and **Checkout Blitz** (a 60-second timed sprint, with its
own scoring, leaderboard, and achievements — see its own section further down).

## How this differs from every existing mode (important — don't conflate)

- **Daily Challenge's "Checkout Sprint" format** (`docs/daily-challenge-roadmap.md`)
  sounds similar but tests the opposite skill: the player **physically throws real
  darts** at a real target and the app measures how many it *actually* took them.
  Checkout Trainer never involves a real throw — the player is asked "what **would**
  you throw?" and graded instantly against the objectively optimal answer. One tests
  throwing performance; the other tests checkout knowledge/recall. They're
  complementary, not duplicates, and should stay distinct entry points.
- **Doubles Practice** (`docs/game-modes-roadmap.md`) is the closest *structural*
  precedent (solo, no win condition, per-dart evaluation) but is still a real throwing
  drill against a fixed target set. Checkout Trainer borrows its shape, not its
  content.
- This is **not** a new way to *play* darts (unlike Cricket/Baseball in
  `docs/game-modes-roadmap.md`), which is why it gets its own doc rather than a
  section there.

## Design: Freeform mode

### Core loop

1. The app picks a target score (see "Target selection" below) for the player's
   current out-mode (double-out or single-out, from their existing per-player
   setting).
2. The player enters their proposed checkout — up to 3 darts — using the **same
   dart-input widget already in the app** (Pad mode's number+multiplier grid, or
   Dartboard mode's SVG board, whichever the player currently has selected). No new
   input UI to build; this reuses `makeDart()`/`throwDart()` unmodified. The player
   can submit early after 1 or 2 darts if they believe that's already a finish.
3. On submit, grade the proposed route:
   - **Legal?** Does it reach exactly 0 from the target, with a double as the last
     dart under double-out (or single-out's looser "any last dart" rule)? Reuses
     `evaluateVisit()` (`frontend/scoring.js`) unmodified — a checkout attempt is
     exactly a normal X01 visit starting from `remaining = target`.
   - **Optimal?** Compare the dart count used against the objective minimum for that
     target, from **`checkoutHint(target, doubleOut, 3)`** (`frontend/scoring.js`,
     already built and exhaustively verified for every finishable score 2–170) —
     the number of space-separated tokens in its return value is the minimum dart
     count. Grading is by **dart count**, not exact route match: `checkoutHint()`
     only ever returns *a* valid optimal route, and real finishes commonly have
     multiple equally-optimal paths (same reasoning `getCheckoutRoutes()` already
     applies when showing "most common" routes rather than "the" route) — an
     answer using a *different* combination that still hits the minimum dart count
     must grade as optimal, not wrong.
4. **Feedback, immediately**: "✅ Optimal — 2 darts, that's the best possible" /
   "⚠️ Legal finish, but not optimal (you used 3 — 2 is possible)" / "❌ Not a legal
   finish" (explain why: didn't reach zero, went negative, or the last dart wasn't a
   double). On anything other than "optimal," **reveal** `checkoutHint()`'s route —
   the whole point is to leave the player having learned something, not just scored.
5. Move to the next target. Session runs freeform until the player ends it (same
   shape as Just Chuckin' It — no fixed round count), tallying accuracy (%
   legal) and optimal-rate (% matching the minimum) for the session.

### Target selection

Only draw from scores that are actually finishable under the player's current
out-mode — under double-out, that means skipping the known bogey numbers (169, 168,
166, 165, 163, 162, 159, and 1) entirely; asking for an impossible checkout would be a
bad-faith question, not a harder one. A difficulty toggle (e.g. "under 40" / "under
100" / "full range up to 170") is a natural, low-effort addition on top of a uniform
random pick from the legal set — left as an open question on exact tiers/weighting
below, the same way Daily Challenge's own doc left its curated-target-list content
decision open.

### Data model

Reuses the existing per-dart-turn shape Doubles Practice/Just Chuckin' It already
established (every dart is real `darts` rows under a `turns` row — nothing
game-type-specific needs a new storage shape):

- A new `game_type` value, e.g. `'checkout_trainer'`, added to `KNOWN_GAME_TYPES`
  (`backend/db.js`).
- **One new nullable column**: `turns.target_score INTEGER` — the target given for
  that round, needed because (unlike X01) there's no persistent "remaining score"
  game state to derive it from; only ever populated for this game type, the same
  purely-additive-nullable-column pattern `checkout_points`/`zone`/`miss_zone` etc.
  already use.
- **Reuse `turns.leg_won`** (already documented as "a game-type-agnostic 'this turn
  won the leg' signal," introduced for Cricket precisely so future modes wouldn't
  need their own copy) to mark "this round was answered with the objectively fewest
  darts" — the equivalent of Cricket's own reuse of the same column.
- **`turns.bust`/`turns.checkout` need no new columns either** — since `evaluateVisit()`
  is reused unmodified, every round attempt already comes back as one of exactly the
  three outcomes those two existing columns already distinguish: `bust=1` (not a
  legal finish), `bust=0, checkout=1, leg_won=0` (legal, but not optimal), or
  `bust=0, checkout=1, leg_won=1` (optimal). This three-way result is exactly what
  Checkout Blitz's scoring formula reads directly off of (see its own section below)
  — the whole grading model rides on columns that already exist, nothing new to store.
- **Must be excluded from every "physical dart" aggregate** the same way Just
  Chuckin' It's darts are (`NOT_CHUCKIN = "AND g.game_type != 'chuckin'"` in
  `backend/db.js`) — these darts represent a *proposed* route, not a real throw, and
  must not pollute sector heatmaps, treble rate, dart-pace, or any other
  physical-throwing stat. This is the exact same problem Just Chuckin' It already
  solved once; the fix is the same shape (generalize the exclusion constant to cover
  both game types, or add a sibling `NOT_HYPOTHETICAL`-style guard at each of the
  same call sites `NOT_CHUCKIN` already touches).
- `games.config` needs no new fields **for Freeform mode itself** (unlike Cricket's
  `numbers` or Doubles Practice's `doubles`) — the target lives per-round on
  `turns.target_score`, not per-game. (Checkout Blitz *does* add two `config` fields
  of its own — `mode`/`durationSec` — see its own Data model section below; Freeform
  mode predates and doesn't depend on either.)

### Stats / Personal Bests

Direct structural template: `getDoublesPracticeStatBubbles()` /
`getDoublesPracticePersonalBests()` (`backend/db.js`) — same "no win/loss, no
lifetime average in the usual sense" shape. Candidates:

- **Accuracy %** — legal finishes / total rounds attempted.
- **Optimal %** — rounds matching the minimum dart count / total rounds (the
  headline stat).
- **Toughest checkout mastered** — highest target ever answered optimally, a
  Personal-Bests-style single record (mirrors `bestLegAvg`/`bestRoundDarts`'s
  existing "one standout number" shape).
- A leaderboard (optimal %, minimum-rounds floor to avoid a single lucky answer
  topping the board — same convention `_trebleLess()`/`getCricketMprLeaderboard()`
  already use).

### Achievements: laddered milestones + a few fun one-offs

The core loop is deliberately **fast and repetitive** — a round is seconds, not
minutes, so a single session can rack up dozens of attempts and a dedicated player
will blow past normal X01 badge thresholds in no time. This is exactly the shape
**Just Chuckin' It** was built for, and the request there was the same as here almost
word-for-word: *"achievements specifically for this game mode, centered around major
milestones... ladder the achievements so there are a lot to earn and that earning
them starts early and often."* Reuse that solution wholesale rather than reinventing
it — `CHUCKIN_MILESTONE_LADDERS` (`frontend/index.html`) is a **data-driven** array
(`{metric, idPrefix, statNoun, descFor(threshold), tiers:[{threshold,label,icon}]}`),
generating every `BADGE_INFO`/`ACH_LABELS`/`ACH_DURATION` entry from one `.forEach()`
instead of hand-writing a badge object per tier, with the actual "has this cumulative
value crossed this threshold" comparison factored into a pure, unit-tested helper
(`chuckinTiersReached(tiers, value)`, `frontend/scoring.js`). A
`checkoutTiersReached()` sibling (or a generalized shared helper both game types call)
is the right shape here too. Like Chuckin's ladders, these are **once-earned,
permanent milestones** (`INSERT OR IGNORE`, not undo-revocable) — a low-stakes
practice mode's badge staying earned after an undone answer is a harmless edge case,
not worth the revert plumbing X01/Cricket's competitive-play badges need.

**Four ladders** (18 tiers total, matching Chuckin's own scale):

1. **Lifetime Attempts** (`checkout_trainer_attempts_`, metric = total rounds
   answered, legal or not) — pure dedication/volume, the most Chuckin-like of the
   four:
   | Threshold | Label | Icon |
   |---|---|---|
   | 50 | Warming the Arm | 🔥 |
   | 200 | Out-Chart Regular | 🎯 |
   | 500 | Double Vision | 👀 |
   | 1,500 | Checkout Junkie | 🧠 |
   | 5,000 | Human Out Chart | 🖩 |
   | 15,000 | Finisher's Instinct | 🧭 |
   | 50,000 | Legend of the Checkout | 👑 |

2. **Lifetime Optimal Answers** (`checkout_trainer_optimal_`, metric = rounds
   matching the minimum dart count) — the **headline ladder**, since hitting the
   objective optimum is the actual point of the game, not just attempting:
   | Threshold | Label | Icon |
   |---|---|---|
   | 25 | First Finish | 🎯 |
   | 100 | Century of Perfection | 💯 |
   | 300 | Route Master | 🗺️ |
   | 1,000 | Out-Chart Encyclopedia | 📚 |
   | 3,000 | Checkout Savant | 🧠 |
   | 10,000 | The Perfect Finisher | 👑 |

3. **Session Endurance** (`checkout_trainer_session_`, metric = attempts in one
   sitting) — direct structural twin of Chuckin's own session ladder:
   | Threshold | Label | Icon |
   |---|---|---|
   | 50 | Quick Study | ⏱️ |
   | 150 | Deep Dive | 🤿 |
   | 400 | Marathon Mind | 🏃 |
   | 1,000 | Iron Focus | 🔋 |

4. **Best Optimal Streak** (`checkout_trainer_streak_`, metric = longest-ever run
   of consecutive optimal answers, tracked the same way a win-streak is already
   computed elsewhere — walk-until-broken, not a maintained counter) — the
   skill/bragging-rights ladder, genuinely distinct from the two cumulative-count
   ladders above since one bad answer resets it to zero:
   | Threshold | Label | Icon |
   |---|---|---|
   | 5 | On a Roll | 🎲 |
   | 15 | Hot Hand | 🔥 |
   | 30 | Unstoppable | ⚡ |
   | 75 | In the Zone | 🧘 |
   | 150 | Flawless Machine | 🤖 |

**A few fun one-off badges** (not laddered — single flagship achievements, same
`once:true` semantics, same "no reimplementation, borrow the existing engine" spirit):

- **🐟 The 170 Club** — solve **170** (T20-T20-Bull, the maximum possible checkout)
  optimally at least once. A deliberate callback to X01's existing 🐟 **Big Fish**
  badge (a real 170 checkout) — same number, same fish pun, earned by *knowing* the
  route here instead of *throwing* it there.
- **🎯 One-Darter** — first time solving a target optimally in exactly 1 dart (any
  even number 2–40 via its double, or 50 via bull). Celebrates recognizing the
  simplest cases instantly rather than overthinking them.
- **🌟 Perfectionist** — finish a session of 15+ attempts with a 100% optimal rate
  (every single answer, no exceptions) — a per-session flawless-run badge, distinct
  from the lifetime streak ladder above (this one resets every session; the streak
  ladder tracks the best run ever, even if it spans multiple sessions).
- **💣 Bogey Buster** — *conditional on the "trick question" difficulty variant*
  (see Open Questions below): correctly answer "not possible" when given an actual
  bogey number, first time. Only makes sense to build if that variant ships; noted
  here so the achievement idea isn't lost if/when it does.

### No live scoreboard (deliberate, per the original request)

This game type never writes to `liveState` / needs an `ALLOWED_LIVE_KEYS` entry, and
`/display` never needs a renderer for it — genuinely simpler than every other mode in
that one respect. Worth stating explicitly so a future pass doesn't assume every game
type needs display-screen support.

## Design: Checkout Blitz (a 60-second timed sprint)

A second, distinct way to play Checkout Trainer, sharing every core mechanic above
(target selection, dart entry, legal/optimal grading) but wrapped in a countdown
clock and a score instead of a freeform practice session. Named **Checkout Blitz**
— deliberately **not** "Checkout Sprint," which already means something else
(Daily Challenge's real-throwing format, see "How this differs" above); reusing that
name here would be genuinely confusing between two different features. No live
scoreboard needed here either — same single-device framing as Freeform mode.

### Core loop delta

Same as Freeform's core loop (target → enter proposed darts → grade), with two
changes:

1. **A visible countdown** starts the moment the player begins the run (the one
   genuinely new UI element this whole feature needs — everything else reuses
   existing widgets). Implemented as a **wall-clock deadline**
   (`deadline = Date.now() + 60000`), checked on each render tick, not a naively
   decrementing counter — a `setInterval` alone drifts under background-tab
   throttling, which would let a backgrounded/unfocused run either cheat extra time
   or end early depending on browser behavior.
2. **Every submission — legal, illegal, optimal, or not — immediately serves the
   next target.** There's no "try again on the same number": a wrong or suboptimal
   answer just costs points, not time, keeping the pace constant. The clock is
   checked **between** rounds, not mid-entry — a round already in progress when the
   deadline passes is allowed to finish (grading it normally) before the run ends,
   so the timer never cuts a player off mid-dart-entry, which would feel broken
   rather than challenging.

### Scoring

Reuses the exact three-way `bust`/`checkout`/`leg_won` outcome the Data model
section above already established — no new columns, just a point value attached to
each:

- **Optimal** (`leg_won=1`) — **2 points**.
- **Legal but not optimal** (`checkout=1, leg_won=0`) — **1 point**.
- **Illegal** (`bust=1`) — **0 points**.

A run's final score is `SUM` of that per-round value across every `turns` row in the
game — computed at read time, nothing pre-aggregated, same philosophy as everywhere
else in this schema. The 2×/1×/0× weighting is deliberate, not arbitrary: it rewards
actually finding the optimal route over just rushing to *any* legal finish, which is
the whole point of the game — a player who prioritizes raw speed over correctness
should score worse than one who takes the extra half-second to get it right, and a
flat "1 point per legal finish" scoring scheme wouldn't create that tension at all.

### Data model additions

Only what Freeform mode didn't already need — everything else (game type,
`turns.target_score`, the bust/checkout/leg_won three-way outcome) is shared:

- `games.config.mode`: `'freeform' | 'blitz'`, read via `json_extract` the same way
  Cricket's `numbers` or Doubles Practice's `doubles` already are — **not** a second
  `game_type`, since Blitz and Freeform are mechanically identical (same target
  selection, same grading) and differ only in pacing/scoring, the same relationship
  X01's own H2H-vs-Practice split already has within *one* `game_type` (a mode flag
  plus scoped queries, not two parallel game types for what's fundamentally one
  game).
- `games.config.durationSec`: fixed at **60** for v1 (per the request), stored
  rather than hardcoded so a future variable-duration variant (90s, 3-minute) needs
  no migration — same "store it even though only one value exists today" precedent
  `tournament_rounds.legs_per_set` already set for a field that was single-valued at
  first and configurable later.
- No new column for the final score itself — it's `SUM`-derived from existing
  per-round outcomes at read time, same as everywhere else.

### Leaderboard

A classic arcade high-score table — **one row per player, their single best-ever
Blitz score**, ranked descending. Structurally closest to "Highest Checkout"
(`getHomeExtra()`) rather than a rate-based leaderboard like Most Wins or Trebleless
%: this is a **peak single-run value**, not an average or a percentage, so it needs
no minimum-attempts floor the rate-based leaderboards use to guard against a lucky
small sample. `getCheckoutBlitzLeaderboard()`: `{name, bestScore, achievedAt}` per
player, sorted by `bestScore` desc — direct structural sibling of
`getTopFinishesAll()`. A player's own lifetime-average Blitz score (distinct from
their personal best) is a natural Personal-Bests-style addition alongside it, same
"one standout number plus a lifetime average for context" shape `getPersonalBests()`
already uses for `bestLegAvg`/`lifetimeAvg`.

### Achievements

Its own ladder plus a couple of one-offs — genuinely different flavor from
Freeform's four ladders (volume/dedication over a lifetime) since Blitz is about
**peak performance under pressure**, not cumulative grinding. Built the same
data-driven way as every other ladder in this doc (see Freeform's Achievements
section above for the `CHUCKIN_MILESTONE_LADDERS` precedent this all reuses).

**One ladder — Best Blitz Score** (`checkout_trainer_blitz_`, metric = single
best-ever 60-second score, the same peak value the leaderboard ranks on):

| Threshold | Label | Icon |
|---|---|---|
| 10 | Quick Draw | 🤠 |
| 20 | Clockwork | ⏰ |
| 35 | Buzzer Beater | 🚨 |
| 50 | Against the Clock | ⏳ |
| 75 | Speed Demon | 💨 |
| 100 | One-Minute Wonder | 🌟 |

**Two one-off badges**:

- **💎 Perfect Minute** — every single round in one Blitz run graded optimal (no
  legal-but-suboptimal, no illegal answers at all), with a minimum of 5 rounds
  attempted in that run so a 1-round fluke can't trigger it — same "floor to prevent
  a lucky small sample" reasoning the leaderboards use, applied to a badge instead.
- **📸 Photo Finish** — submit a round that grades as legal (optimal or not) with
  under 1 second left on the clock. A pure flavor badge, genuinely difficult to
  engineer for on purpose, which is exactly what makes it fun to stumble into.

**Do Blitz rounds count toward Freeform's own ladders?** Lifetime Attempts, Lifetime
Optimal Answers, and Best Optimal Streak (Freeform's ladders 1, 2, and 4) count
rounds from **both** modes — a round is a round, regardless of which mode served it,
and a streak spanning a mode switch is still a real streak. **Session Endurance**
(Freeform's ladder 3) stays Freeform-only by construction — a 60-second Blitz run
could never realistically reach its thresholds (50+ rounds in one sitting), so
counting Blitz rounds toward it would be meaningless, not just redundant.

### UI integration

A sub-toggle inside the Checkout Trainer setup screen — **Freeform** / **Blitz** —
the same sibling-toggle pattern the New Game screen's `practice-type-normal` /
`practice-type-doubles` / `practice-type-chuckin` buttons already use for picking a
Practice sub-mode. Selecting Blitz shows the countdown timer element and locks the
difficulty choice for the run's duration (can't be changed mid-sprint); "End
session" (Freeform's own stop-whenever control) is replaced by the timer itself
ending the run automatically into a results screen — final score, the
optimal/legal/illegal breakdown, and any newly-earned personal bests or badges.

## Accessibility, security, and testing considerations

Not yet addressed anywhere in this doc, per `CLAUDE.md`'s standing conventions:

- **Testing**: the grading logic (legal-finish check, optimal-dart-count comparison)
  is pure and already-tested via `evaluateVisit()`/`checkoutHint()` — but the
  target-selection function (bogey-number exclusion, difficulty tiering), the new
  optimal-rate/accuracy formulas, **and Checkout Blitz's scoring formula (the
  2×/1×/0× point weighting, and the final-score `SUM`)** need their own committed
  `node:test` coverage, per CLAUDE.md's "every new calculation gets a permanent
  test" rule. The wall-clock-deadline timer logic itself is the one piece here that
  isn't a pure function of stored data — worth a lightweight client-side test (or at
  minimum a manual Playwright check) that a backgrounded/throttled tab doesn't grant
  extra time, since that's the one place this feature could be trivially cheesed.
- **Accessibility**: same standing checklist as every other new surface
  (`docs/accessibility-roadmap.md`) — the pass/fail/optimal feedback must not be
  color-only (icon + text, matching every other status signal in this app), and the
  dart-input widget being reused already has its own accessibility properties to
  inherit, not re-litigate. Checkout Blitz's countdown adds one new concern: a
  purely visual timer is invisible to a screen-reader user — needs periodic
  `aria-live` announcements (e.g. at 30s/10s/5s remaining, not every second, which
  would be noise) rather than relying on sight alone to know time is running out.
- **Security**: no new credential/token surface, no new write endpoint shape beyond
  the existing `addTurn`-style pattern (already validated/bounded) — reuses the
  existing auth model unchanged. Checkout Blitz's final score must be **computed
  server-side** from the recorded `turns` rows, never trusted from a client-submitted
  value — the same "server is the source of truth for anything leaderboard-ranked"
  principle every other cross-player leaderboard in this app already follows.

## Suggested build order

1. `target_score` column + `checkout_trainer` game type + the exclusion-from-physical-
   stats fix, proven with a fixed/hardcoded target list before wiring up real
   selection logic.
2. Target selection (bogey-number-aware random pick), reusing the existing Pad/
   Dartboard input widgets unmodified for entry.
3. Grading + immediate feedback (legal/optimal/reveal-the-answer), a freeform session
   loop (no fixed round count, same shape as Just Chuckin' It).
4. Stat bubbles + Personal Bests (accuracy %, optimal %, toughest checkout mastered),
   modeled directly on Doubles Practice's own functions.
5. The four milestone ladders (attempts, optimal answers, session endurance, best
   streak) — data-driven off one array, exactly like `CHUCKIN_MILESTONE_LADDERS`, so
   all 18 tiers come from one `.forEach()` rather than 18 hand-written definitions.
6. The one-off flagship badges (170 Club, One-Darter, Perfectionist), plus Bogey
   Buster if the trick-question difficulty variant ships.
7. Difficulty tiers and a leaderboard — later passes once the core loop is proven and
   actually played a few times.
8. **Checkout Blitz**, once Freeform mode is proven and actually played: the
   `config.mode`/`config.durationSec` fields, the wall-clock countdown timer, and the
   "serve the next target on every submission" pacing change.
9. Blitz scoring (server-computed, from the reused bust/checkout/leg_won outcome) +
   `getCheckoutBlitzLeaderboard()`.
10. Blitz's own ladder (Best Blitz Score) and one-off badges (Perfect Minute, Photo
    Finish) — same data-driven ladder mechanism as every other ladder in this doc.

## Open questions for whoever picks this up

- **Persisted game type vs. a lightweight, stateless calculator**: this doc's
  recommended design (above) treats it as a full `games`/`turns`/`darts`-backed game
  type, matching the precedent every other solo drill (Doubles Practice, Just
  Chuckin' It, Daily Challenge) already set — full Player Profile stats, history, and
  a natural home for future badges, at the cost of a bit more schema/plumbing than a
  pure client-side quiz. The genuinely lighter alternative — no persistence at all,
  just an in-session counter, closer to a literal "calculator" with no server
  round-trip per round — is real and worth weighing before committing, since it's a
  much smaller build. Worth deciding by how much the "lifetime stats on this" actually
  matters to whoever's using it, not guessed here.
- Exact difficulty tiers/weighting for target selection — a content decision, best
  made by actually playing it a few times (same framing Daily Challenge's own open
  questions used for its curated target list).
- **Trick-question difficulty variant**: occasionally give an actual bogey number and
  accept "not possible" as the correct answer, rather than only ever asking legally
  finishable targets. Not designed in detail here (needs its own UI affordance for
  "declare unsolvable," and its own grading branch) — the 💣 Bogey Buster badge above
  is written assuming this ships, but the core game is complete without it.
- Exact ladder threshold values above are a first pass, not final — tune against
  actual play the same way Chuckin's own thresholds were picked, not re-derived from
  first principles here.
- Whether this should offer a "practice this specific number" deep link from
  elsewhere in the app (e.g. from a Top Finishes row, "drill this checkout") — a nice
  affordance, not required for v1.
- **Checkout Blitz's exact point weighting** (2×/1×/0× above) is a first pass, not
  final — worth tuning against actual play the same way every other threshold in this
  doc is flagged as provisional. A flat 1-point-per-legal-finish scheme, or a bonus
  for chaining optimal answers (a Blitz-local combo multiplier, distinct from the
  lifetime streak ladder), are both real alternatives worth trying before settling.
- **Blitz's default difficulty**: time pressure already adds difficulty on top of
  whatever target range is in play — worth deciding whether Blitz should default to
  an easier range (e.g. "under 100") than Freeform's default, rather than reusing
  whatever difficulty setting Freeform last used, so a first-time Blitz run doesn't
  feel unfairly hard.
- **Configurable duration** (90 seconds, 3 minutes) beyond the requested fixed
  60-second sprint — `config.durationSec` is designed to support this without a
  migration, but a v1 should ship with just the one duration per the original
  request, not speculative variants.
- Whether the countdown gets an audible/visual "hurry up" cue in the final few
  seconds (e.g. a pulse or tick sound) — a nice-to-have polish pass, not a launch
  requirement, and needs to respect the same "icon/text over color/sound alone"
  accessibility principle as everything else if it ships.
