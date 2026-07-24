# First-9 Average — Design Roadmap

> Status: **done, 2026-07.** Full mechanics documented in `REFERENCE.md`'s
> Player Profile stat bubbles / Personal Bests / Home page leaderboards
> sections — see those for the authoritative behavior. The bubble and chart
> metric (`first9avg`) turned out to already exist from an earlier session's
> "opening exchange" stats work (`first3avg`/`first9avg`/`score140pct`,
> 2026-07) but were never wired up to a Personal Best or leaderboard, and had
> a stale UI label left over from before that work's own 101-inclusion
> decision — see "Open questions," below, for how this picked up from there.

## Goal

The standard professional scoring stat the app conspicuously lacks: a
player's 3-dart average over the **first 9 darts of each leg** — pure
scoring power before checkout pressure distorts the number. It's the stat
commentators quote alongside overall average, and it's entirely derivable
from data already recorded. The wishlist has checkout % on it; this is the
same family and arguably the bigger omission.

## Design

- **Formula** (X01 only, H2H and practice, scoped by the existing
  `_scope()` mechanism like every other stat): for each leg, take the
  player's first up-to-3 visits (their first 9 darts — a leg they finish in
  fewer simply contributes what it has), sum `pointsThisVisit`-style scored
  values and darts thrown, then `first9avg = totalScored / totalDarts × 3`
  across all legs. Note **busted visits score 0 but their darts count** —
  same convention the overall 3-dart average already uses, stated
  explicitly so the two stats stay comparable. Checkout Trainer's
  `checkout=1` turns are already fenced off by game_type; the usual
  `NOT_CHECKOUT_TRAINER`-family exclusions don't even come into play since
  this is `game_type='x01'` scoped from the start.
- **Leg grouping**: turns already carry `set_no`/`leg_no` per game — "first
  3 visits of a leg" is a window over the player's turns ordered by id
  within each (game, set, leg) group. One new `db.js` stat function
  (`getFirstNineAverage()` folded into `getPlayerStatBubbles()`), no schema
  change of any kind.
- **Surfaces**:
  - a **First-9 Avg** stat bubble on the Player Profile's X01 tab;
  - a `getMetricHistory()` metric (`first9avg`) so it charts over time like
    the other averages;
  - a **Best First-9 (single leg)** Personal Best — the standout-number
    shape `bestLegAvg` already uses;
  - optionally a Home leaderboard (min-legs floor, same convention as the
    other rate-based boards).
- **REFERENCE.md**: the formula above goes into the stats section verbatim
  in the same change — this is precisely the "cross-reference the spec to
  find bugs" class of stat.

## Accessibility, security, and testing considerations

- **Accessibility**: a stat bubble + chart metric on existing surfaces —
  nothing new beyond their existing conventions; the bubble label should
  spell out "First 9" rather than an unexplained "F9".
- **Security**: read-only stat on existing endpoints; nothing new.
- **Testing**: committed db tests with hand-computed fixtures — a normal
  leg (exactly 3 visits counted, the 4th ignored), a short leg (finished in
  2 visits, 6 darts counted), a busted first visit (0 points, 3 darts),
  multi-leg aggregation, and H2H/practice scoping. The chart metric and
  Personal Best get the same fixture treatment. CLAUDE.md's
  every-new-calculation rule, straightforwardly.

## Resolved at build time

- **Include 101 games?** This doc's own lean was 301+ only, but by the time
  this item was picked up, `first9avg` (along with `first3avg`/`score140pct`)
  had already been built in an earlier session with an explicit, documented
  2026-07 product decision to include **all four** standard starting scores
  (501/301/170/101) — `OPENING_CATS` in `backend/db.js`, see `REFERENCE.md`'s
  "Why 1st 3 AVG / 1st 9 AVG / 140/Leg are scoped to exactly 501, 301, 170,
  and 101" for the full rationale. That decision stands; this build reused it
  rather than re-litigating it. The one real gap it left behind: the Player
  Profile bubble and stats-legend text still said "(501/301 only)" — a stale
  label from before that decision, fixed in this same change.
- **Leaderboard in v1 or later?** Shipped now — "Best First-9 Average" on the
  Home page, `HAVING legs >= 20` (the same floor `COACHING_MIN_LEGS_FOR_FORM`
  uses elsewhere for "trust a small-sample average"), ranked descending.
- **Best First-9 Personal Best**: shipped — `bestFirst9` in
  `getPersonalBests()`, deliberately **not** restricted to won legs the way
  `bestLegAvg` is (see `REFERENCE.md`'s Personal Bests section for why), and
  with no Ghost Opponent "Race this leg" button (Ghost mode requires a leg
  the player actually won, which a first-9 record leg isn't guaranteed to be).
