# First-9 Average — Design Roadmap

> Status: **design phase, not started.**

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

## Open questions for whoever picks this up

- Include **101 games**? A 101 leg can end inside 9 darts nearly every
  time, which pollutes the stat's meaning. Lean: restrict to 301+
  categories (still "X01 only", one extra predicate), and say so on the
  bubble's hover text.
- Leaderboard in v1 or later? It's a one-liner once the formula exists —
  lean: ship it with the same min-20-legs floor Trebleless % uses.
