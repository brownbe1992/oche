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

## Design

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
- **Must be excluded from every "physical dart" aggregate** the same way Just
  Chuckin' It's darts are (`NOT_CHUCKIN = "AND g.game_type != 'chuckin'"` in
  `backend/db.js`) — these darts represent a *proposed* route, not a real throw, and
  must not pollute sector heatmaps, treble rate, dart-pace, or any other
  physical-throwing stat. This is the exact same problem Just Chuckin' It already
  solved once; the fix is the same shape (generalize the exclusion constant to cover
  both game types, or add a sibling `NOT_HYPOTHETICAL`-style guard at each of the
  same call sites `NOT_CHUCKIN` already touches).
- `games.config` needs no new fields (unlike Cricket's `numbers` or Doubles
  Practice's `doubles`) — the target lives per-round on `turns.target_score`, not
  per-game.

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

## Accessibility, security, and testing considerations

Not yet addressed anywhere in this doc, per `CLAUDE.md`'s standing conventions:

- **Testing**: the grading logic (legal-finish check, optimal-dart-count comparison)
  is pure and already-tested via `evaluateVisit()`/`checkoutHint()` — but the
  target-selection function (bogey-number exclusion, difficulty tiering) and the new
  optimal-rate/accuracy formulas need their own committed `node:test` coverage, per
  CLAUDE.md's "every new calculation gets a permanent test" rule.
- **Accessibility**: same standing checklist as every other new surface
  (`docs/accessibility-roadmap.md`) — the pass/fail/optimal feedback must not be
  color-only (icon + text, matching every other status signal in this app), and the
  dart-input widget being reused already has its own accessibility properties to
  inherit, not re-litigate.
- **Security**: no new credential/token surface, no new write endpoint shape beyond
  the existing `addTurn`-style pattern (already validated/bounded) — reuses the
  existing auth model unchanged.

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
