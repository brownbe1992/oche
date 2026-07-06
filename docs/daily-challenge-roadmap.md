# Daily/Weekly Challenge — Design Roadmap

> **Un-archived (2026-07)** — three new Daily Challenge badges and a dedicated
> Player Profile tab were added (per an explicit user request for "stats,
> reporting, badges, and achievements for daily challenges"), so this doc moved
> back out of `docs/archive/` per CLAUDE.md's "partially-done docs stay in
> `docs/`" convention. See `docs/open-roadmap-items.md` for the live
> completion tracker across all roadmaps.

> Status: **fully shipped**, including the "beat your best" live callout, the
> Player Profile history view (now its own tab, see below), and Daily-Challenge-
> specific badges. `completeChallengeAttempt()` (`backend/db.js`) now
> returns `isPersonalBest` (comparing against every other completed attempt of the
> same format, per-format direction: fewest darts/visits for Checkout Sprint/Speed
> to Zero/The Long Game, most bulls/trebles/points for Bullseye Gauntlet/Treble
> Run/Steady Hand), patched into a `#challenge-pb-banner` placeholder on the results
> screen once the round-trip resolves — same "celebrate immediately, patch in the
> extra detail a moment later" pattern used for achievement counts. **Player Profile:
> Daily Challenge history** (see below) is now built too — a new `getChallengeHistory()`
> backs its own **Daily Challenge** tab on the Player Profile (promoted, 2026-07,
> from a collapsible section that used to be duplicated inside every other tab)
> showing the lifetime completion record (played/completed/current streak/longest-
> ever streak), a per-format personal-best line reusing the exact same direction
> table as the "beat your best" check, the full attempt-by-attempt log, and (new)
> the Badge Case — now grouped X01/Cricket/Daily Challenge, so the three new
> challenge badges below are visible from this tab too. Current streak is
> delegated to `getChallengeStatus()` rather than re-derived, exactly as the
> original design called for; longest-ever streak is the same day-by-day walk
> without stopping at the first gap. All six
> challenge-type-pool formats are built and tested end-to-end, covering every
> suggested-build-order step:
> 1. Deterministic date-seeded generation (`todaysChallenge()` in `frontend/index.html`)
>    across all six formats.
> 2. A "Today's Challenge" entry point, treated as a third game mode on the New Game
>    screen (`setup.mode`: `'h2h' | 'practice' | 'challenge'`) alongside H2H and
>    Practice, not a separate special flow with its own picker. Selecting Daily
>    Challenge mode reuses the same single "Choose player" slot and PIN gate
>    (`onSlotChange()` → `withPinCheck()`) that Practice mode already uses, and the
>    same "Start game" button (relabeled "Start Challenge"), rather than a standalone
>    dropdown + button that had no PIN check of its own. The Home page keeps a
>    read-only teaser (today's challenge shape only, no player attached, no backend
>    call) linking to New Game.
> 3. Result tracking + the four formats beyond the original two: Bullseye Gauntlet
>    (most bulls in 3 visits), Steady Hand (closest to 20 per visit without going
>    over), Treble Run (most distinct trebles in 3 visits), and The Long Game (fewest
>    visits from 501 to under 40, no busts). These three dart-count-based formats and
>    Long Game don't play out a normal X01 win — `enterTurn()` detects each format's
>    completion condition directly (3 visits logged, or remaining drops under 40) and
>    ends the round early by invoking the same `onLegWon()` completion path the
>    original two formats use, rather than duplicating it.
> 4. Streak tracking + the Home page 7-day history strip, with per-format metric
>    labels (bulls/trebles/points/visits/darts) instead of a hardcoded "darts" unit.
> 5. Shareable results card (`dailychallenge` moment-card type), format-aware for all
>    six challenge types.

## Goal

A recurring, Wordle-style solo challenge that gives a player a reason to open the app
and throw a few darts even when nobody else is around to play H2H with. Purely local,
no infrastructure, built entirely on the existing Practice-mode engine.

## The key design problem: staleness

A single challenge *format* — even with the target number changing daily — gets old
fast. "Finish 121 in the fewest darts" today, "finish 96 in the fewest darts"
tomorrow, forever, is the same task with a different number bolted on. The fix is a
**pool of genuinely different challenge shapes**, picked deterministically by date
alongside the target itself, so consecutive days actually feel different rather than
just numerically different.

## Design

### Challenge type pool

All of these reuse the existing scoring engine unmodified — a challenge is just a
constrained Practice-mode session with a specific starting condition and success
metric:

1. **Checkout Sprint** — finish a specific score (121, 170, 96, ...) in the fewest
   darts. The original idea; still the most classic/recognizable format.
2. **Speed to Zero** — a full 501 leg, fewest total darts, no fixed checkout target —
   tests the whole leg, not just the finish.
3. **Bullseye Gauntlet** — most bulls (single or double) hit in 9 darts.
4. **Steady Hand** — score as close to exactly 20 as possible each visit *without*
   going over — an inverted skill test: precision at a *low* target instead of
   maximizing, genuinely different muscle than every other format here.
5. **Treble Run** — most different treble numbers hit in 9 darts — rewards spread/
   variety, not raw score.
6. **The Long Game** — fewest visits to get from 501 down to under 40 remaining
   without busting — an endurance/discipline format, distinct from the speed-focused
   ones above.

- **Deterministic generation**: both the format *and* the specific target/number for
  a given day are picked by a pure function of the date (e.g. a seeded pick from the
  pool + a curated list of interesting checkout targets for format 1) — no
  server-side randomness or stored state needed. Everyone attempting "today's
  challenge" on the same calendar day gets the identical challenge, the same way
  Wordle works.
- **Curated, not purely algorithmic, target selection** (for formats that need a
  target number, like Checkout Sprint) — a hand-picked list of interesting,
  achievable-but-non-trivial checkouts (121, 170, 96, 100, 141...) cycled
  deterministically, rather than generating arbitrary numbers that might land on a
  "bogey" score (like 169) that isn't checkoutable at all, or a trivially easy one
  (like 40) that doesn't feel like a real challenge.
- **Attempt flow**: a "Today's Challenge" entry point on the Home page, launching the
  constrained Practice-mode session using the existing scoring engine unmodified —
  no new scoring logic, just a pre-set starting condition and a success metric
  computed from the resulting turns the same way Personal Bests already computes
  "fewest darts to finish."
- **Result tracking**: outcome (darts taken, bulls hit, trebles hit, etc. — whichever
  metric that day's format uses) recorded against the challenge date. "Did not
  finish" (busted out or gave up) is a valid, trackable outcome too, not just success/
  failure — matches how a real Wordle "X/6" can also be a loss.
- **Streak tracking**: consecutive days/weeks attempted. This shares real underlying
  mechanics with the win-streak concept in `docs/archive/achievements-badges-roadmap.md` —
  attempt logging and streak computation are the same problem for both features and
  are worth building once, shared between them.
- **Results history strip** on the Home page — last 7 days' attempts (hit/miss/metric
  value per day), not just today's challenge in isolation, so a streak actually has
  somewhere visible to live rather than only existing as a number.
- **Shareable results card** — this is essentially free now that the card-generation
  engine exists (`docs/shareable-moments-roadmap.md`): "Today's Challenge: 121 in 4
  darts 🎯" with a **Share** button, Wordle-style. Genuine virality potential (people
  already share Wordle results unprompted) with zero new infrastructure — the card
  engine, the Share button, and the Home Assistant webhook delivery path all already
  exist and just need a new card type plugged in.

### Player Profile: Daily Challenge history

The New Game panel only ever shows the current streak and the last 7 days — there's
nowhere on a player's own profile to see the bigger picture. Requested addition: a
**Daily Challenge** section on the [Player Profile](../README.md#player-profile) page,
alongside the existing Badge Case, Personal Bests, and Top 10 Finishes, showing:

- **Lifetime completion record** — total attempts vs. total completions (the "X/6"
  Wordle-style stat), plus current streak and longest-ever streak.
- **Best result per format** — the six challenge types each have their own success
  metric (fewest darts, most bulls, most trebles, etc. — see `challengeMetricLabel()`
  in `frontend/index.html`), so this is six separate personal-best lines, not one
  combined number. Mirrors how Personal Bests already separates Best Leg Average from
  Fewest Darts to Finish rather than conflating unrelated metrics.
- **Full attempt history** — every calendar date this player has attempted the
  challenge, with the format played, the result (or "not finished"), so a player can
  scroll back through their run the way a Wordle stats screen does, not just the
  rolling 7-day window on New Game.

No new schema needed — `daily_challenge_attempts` already stores exactly this
(`challenge_date, format, target, completed, result_darts` per player), matching the
app's "nothing pre-aggregated" philosophy: this is new read-only queries and a new UI
section, not new data collection. The streak-computation logic in
`getChallengeStatus()` (`backend/db.js`) already does the hard part (walking
consecutive dates, handling an unplayed "today" without breaking a real streak) and
should be reused/extended rather than re-derived — a "longest-ever streak" is the same
walk without stopping at the first gap, and per-format bests are a `GROUP BY format`
over the same table.

### Daily Challenge badges + its own Player Profile tab (built 2026-07)

Requested addition: "stats, reporting, badges, and achievements for daily
challenges," with "a special daily challenge tab on player pages." Both halves
now exist:

- **Three new badges** (`BADGE_INFO` in `frontend/index.html`, detection in a
  new `checkChallengeBadges(playerName)` called right after every
  `/api/challenges/complete` response): 🔥 **Challenge Streak: Week**
  (`currentStreak === 7` exactly — recurring, can re-earn after a later streak
  reaches 7 again), 🏆 **Challenge Streak: Month** (`currentStreak === 30`
  exactly — recurring, mega-tier confetti overlay like Nine-Darter/Perfect
  Leg), and 🗓️ **Full Rotation** (every one of the 6 formats has at least one
  completed attempt ever — once-badge). The exact-crossing check (`===`, not
  `>=`) is deliberate: a `>=` check would refire the badge every single day of
  a long streak, since `awardRecurringBadge()` has no memory of "already fired
  today." The three pure trigger conditions live in `challengeBadgeSignals()`
  (`frontend/scoring.js`), covered by a committed `node:test` in
  `backend/test/scoring.test.js` per CLAUDE.md's testing convention, rather
  than being inline, untestable `if` blocks the way most X01 badges are.
- **Its own Player Profile tab** — the Daily Challenge history section used to
  be a `<details>` collapsible duplicated inside every one of the Overall/H2H/
  Practice tabs (the same content rendered three times over, once per tab).
  It's now a fourth `.player-tabs` entry (`switchPlayerTab('challenge')`),
  showing the history/streak report (unchanged) plus the Badge Case — which
  now groups badges into X01/Cricket/Daily Challenge sub-sections instead of
  one flat X01-vs-Cricket split, so the three new badges are visible from this
  tab without a separate mini badge display. The tab deliberately omits the
  X01/Cricket stat-bubbles/chart machinery the other three tabs use (game-
  type-specific, not applicable here).

## Suggested build order

1. Challenge-type pool + deterministic date-seeded generation (format + target),
   proven with just the two simplest formats (Checkout Sprint, Speed to Zero) before
   building out the rest.
2. "Today's Challenge" Home page entry point + constrained Practice-mode launch.
3. Result tracking + the remaining challenge formats (Bullseye Gauntlet, Steady Hand,
   Treble Run, The Long Game) — each is a new success-metric computation over the
   same underlying turn/dart data, not new scoring logic.
4. Streak tracking + the Home page results history strip.
5. Shareable results card, reusing the existing card-generation engine.
6. Player Profile: Daily Challenge history — lifetime completion record, best result
   per format, and full attempt history, per the section above.
7. Daily Challenge badges (Challenge Streak: Week/Month, Full Rotation) + promoting
   the history section into its own Player Profile tab, per the section above.

## Open questions for whoever picks this up

- Exact curated target list for Checkout Sprint days, and the full rotation/weighting
  across the challenge-type pool (equal rotation, or weighted toward the more
  approachable formats with occasional harder ones?) — a content decision best made
  by actually playing each format a few times, not guessed up front.
- Does this need to work for Cricket/Baseball once those exist (per
  `docs/game-modes-roadmap.md`), or is it inherently X01-specific by nature — several
  of the formats above (Checkout Sprint, Speed to Zero, The Long Game) are X01
  concepts that don't map cleanly onto marks-based or innings-based games, while
  others (Bullseye Gauntlet, Treble Run, Steady Hand) are really just "N darts,
  optimize for X" and could plausibly generalize. Worth revisiting once a second game
  type actually exists rather than speculating now.
- Whether a missed/failed day should break a streak immediately or have some grace
  (e.g. Duolingo-style streak freezes) — a product decision, not a technical one.
