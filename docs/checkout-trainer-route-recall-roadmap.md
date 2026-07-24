# Checkout Trainer — "Route Recall" Sub-Mode Design Roadmap

> Status (2026-07): **Not started.** This is a new third sub-mode for Checkout
> Trainer (`docs/archive/checkout-trainer-roadmap.md`, fully shipped — Freeform
> and Checkout Blitz), proposed by the owner: "given a number, try to list all
> of the possible checkouts." Filed as its own doc rather than reopening the
> archived one, since Freeform/Blitz are complete and this is new, separable
> work — see `CLAUDE.md`'s roadmap-doc convention.

## Goal

A third Checkout Trainer sub-mode built around **breadth of recall, not just
correctness**: given a target score, the player keeps entering distinct legal
checkout routes for it — not just the one optimal (fewest-darts) answer — until
they've either found every route that exists (at the mode's own dart-count
ceiling) or choose to stop. Freeform asks "what's *a* legal way to check this
out, and is it the best one?"; **Route Recall** asks "how many *different* ways
do you actually know?" — a genuinely different skill (route breadth/pattern
recognition across a whole number, not a single best-answer lookup), same
"no dartboard, pure recall" framing as the rest of Checkout Trainer.

## How this differs from Freeform and Blitz (important — don't conflate)

- **Freeform**: one target, one attempt, graded legal/optimal, then moves on.
  Route Recall keeps the *same* target across many attempts until the player
  exhausts (or gives up on) that one number.
- **Blitz**: a 60-second sprint across many *different* targets, one attempt
  each, optimized for speed. Route Recall is untimed by default (see "Timed
  variant?" below) and deliberately stays on one target — speed isn't the
  point, coverage is.
- Neither Freeform nor Blitz's grading needs to know how many valid routes
  exist for a target — they only ever check the *one* route the player just
  entered against `checkoutHint()`'s single optimal answer. Route Recall is
  the first place in this app that needs to know the **complete set** of
  legal routes for a target, which is new work — see "New required logic"
  below.

## Design

### Core loop

1. Pick a target the same way Freeform does (`pickCheckoutTarget()`, difficulty
   tiers, bogey-aware) — **or** let the player pin a specific number directly,
   a natural fit here since "drill everything I know about checking out 100"
   is a deliberate study choice, not something you'd want left to chance every
   time. (The archived Checkout Trainer doc's own open questions already
   flagged a "practice this specific number" deep link as a nice-to-have not
   built for v1 — this mode is the natural home for it.)
2. The player enters a route (same reused dart-input widget, up to the mode's
   dart-count ceiling — see below). On submit:
   - **Illegal** (doesn't reach zero, or the last dart isn't a valid finisher
     under the current out-mode): rejected with the same "why" feedback
     Freeform already gives. Doesn't count as an attempt toward the target's
     route list either way.
   - **Legal, but already found**: told so immediately ("You've already got
     that one — T20 T20 D-Bull") without penalty, so re-entering a route by
     accident doesn't feel like a wasted guess. Requires the same-multiset
     comparison "New required logic" below defines (order-independent for all
     but the final dart).
   - **Legal and new**: added to the player's found list for this target,
     shown so far (a running "N of M found" or "N found" tally, depending on
     whether the total is disclosed — see "Should the total be revealed?"
     below), and — if the whole set for this target's dart-count ceiling is
     now exhausted — an immediate "🎉 Every route found!" completion moment.
3. The player can stop at any point (a "Move to a new target" control, same
   framing as Freeform's own "no fixed round count") — an incomplete route
   list is still graded as a genuine attempt (see Stats below), not discarded.

### New required logic: exhaustive route enumeration

Every existing checkout function in `frontend/scoring.js` finds **one** route
and stops (`checkoutHint()` returns the first match at each dart count;
`coFinish2()`/`coFinish3()` short-circuit the same way). Route Recall needs a
genuinely new function — call it `allCheckoutRoutes(rem, doubleOut, maxDarts)`
— that enumerates **every** distinct valid route instead of stopping at the
first. Design notes, not full implementation:

- **Routes are compared as an unordered multiset of segments, with one
  ordering constraint**: the *last* dart must be a legal finisher (a double
  under double-out; anything under single-out) — the first 1-2 darts have no
  meaningful order of their own (T20 then T19 isn't a "different route" from
  T19 then T20), so the enumeration and the "already found?" comparison both
  need to canonicalize on a segment multiset + designated-last-dart basis, not
  a literal input sequence.
- **Reuse the same segment tables `checkoutHint()` already has** (`CO_FIRSTS`,
  `CO_DOUBLES`, `coSingle()`/`coTreble()`) as the alphabet to search over,
  replacing its early `return` statements with an accumulate-and-continue
  loop — the underlying scoring rules (what counts as a legal finisher,
  double-out vs. straight-out) don't change at all, only the search stops
  after enumerating instead of after the first hit.
- **Every mathematically valid route, or a curated subset?** A pure exhaustive
  search over "any 1-3 darts summing to the target" is not the same list a
  real player would recognize as "checkout routes" — e.g. for straight-out,
  literally any dart combination reaching zero counts, which could be a large
  and not-very-instructive list for some targets. Needs a decision (see Open
  Questions) on whether double-out mode (the far more common practice
  context) is the only one this mode ships for at all, sidestepping the
  worst of the explosion, with straight-out deferred or capped differently.

### Dart-count ceiling

Rather than always searching up to 3 darts (Freeform/Blitz's fixed ceiling),
Route Recall should let the **ceiling itself be a difficulty axis** — "find
every 1-dart finish for 40" is a short, approachable drill; "find every route
at up to 3 darts for 100" is a much bigger hunt. Suggested tiers: **1-dart
only**, **up to 2 darts**, **up to 3 darts** (matching the game's existing
3-dart-visit ceiling everywhere else) — selected the same way Freeform's
difficulty toggle already is, a per-session setup choice baked into
`games.config`.

### Should the total be revealed?

Two real options, not resolved here:

- **Revealed up front** ("14 routes exist for this target at this dart-count
  ceiling — find them all"): turns it into a concrete, closeable task with a
  clear finish line, good for the "🎉 completion moment" above.
- **Hidden until exhausted or given up on** (a running "you've found N so
  far" count, total revealed only at the end): keeps the drill feeling more
  like open-ended exploration, and avoids a large number feeling
  intimidating before the player has even started. Likely the safer default
  for very route-rich targets (see the explosion problem above) — revealing
  "1 of 47" up front could read as discouraging rather than motivating.

### Data model

Follows the existing Checkout Trainer shape (`turns.target_score`, reused
`bust`/`checkout` columns) as far as it goes, plus what this mode alone needs:

- Same `checkout_trainer` game type, `games.config.mode` gains a third value
  (`'route_recall'`, alongside `'freeform'`/`'blitz'`) — not a new game type,
  same reasoning the archived doc already gave for Blitz sharing one type
  with Freeform.
- Each **submitted route** is still one `turns` row (reusing the exact
  per-dart-turn shape every other sub-mode uses) — no new column needed to
  store an individual route.
- What's new: a way to group every route submitted **against the same target
  within the same "hunt"** so the UI/grading can tell "you found 5 routes for
  this target so far" apart from "you found 5 routes across 5 different
  targets today." The cleanest fit without a new join table: a
  `turns.route_recall_round` integer (or reuse `turns.set_no`, already a
  free-standing per-turn grouping integer used differently by other game
  types) incremented once per target the player commits to, alongside
  `turns.target_score` staying constant across every route submitted for that
  round. Needs a concrete decision once this is picked up — sketched, not
  finalized, here.
- **Same total-exclusion-from-physical-stats requirement the rest of Checkout
  Trainer already established** (`NOT_HYPOTHETICAL_DARTS`/
  `NOT_CHECKOUT_TRAINER`) — these are typed-in proposed routes, not real
  throws, and must have zero footprint on heatmaps, treble rate, pace, or any
  X01 Personal Best, exactly like Freeform/Blitz darts today.

### Stats / Personal Bests

Distinct from Freeform's accuracy/optimal-rate shape, since this mode's whole
point is coverage, not single-answer correctness:

- **Best Coverage %** — routes found ÷ total routes that exist for that
  target/dart-ceiling combination, best-ever single-round value (mirrors
  `bestLegAvg`/`bestRoundDarts`'s "one standout number" shape). A player who
  fully exhausts a target gets 100%.
- **Toughest Full Clear** — highest-route-count target ever fully exhausted
  (a genuinely different "toughest" than Freeform's own "toughest checkout
  mastered," which only cares about the optimal route, not every route).
- **Total Distinct Routes Learned (lifetime)** — a cumulative, never-decreasing
  count of every unique (target, route) pair the player has ever correctly
  entered across every Route Recall round they've played, the natural
  "volume/dedication" ladder metric this mode's version of `CHUCKIN_MILESTONE_LADDERS`
  would key off, mirroring Freeform's own Lifetime Attempts/Lifetime Optimal
  Answers ladders.

### Achievements

Sketched only — exact thresholds need the same "tune against actual play, not
first principles" treatment every other ladder in this app's design docs
gets:

- A **Lifetime Distinct Routes Learned** ladder, same data-driven
  `{threshold, label, icon}` shape as every other milestone ladder in this
  codebase (`CHUCKIN_MILESTONE_LADDERS` precedent).
- A **one-off flagship badge** for the single toughest full clear — e.g.
  "🗺️ Cartographer" for fully exhausting a target with 10+ distinct routes at
  the 3-dart ceiling in one round.
- Whether Route Recall rounds should feed Freeform's existing lifetime
  ladders too (a route entered here is still a real recall answer) is an
  open question, same shape as the archived doc's own "do Blitz rounds count
  toward Freeform's ladders" decision — that one resolved yes for the
  volume/streak ladders, no for the session-endurance one; this mode likely
  wants a similar case-by-case answer rather than a blanket yes/no.

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions, not yet addressed beyond this sketch:

- **Testing**: `allCheckoutRoutes()` is the one genuinely new piece of pure
  logic this mode needs, and it needs committed, exhaustive test coverage
  before anything is built on top of it — a wrong enumeration (missing a
  valid route, or double-counting one under a different ordering) would
  silently corrupt every "already found?"/"is this complete?" check downstream.
  Cross-checking its output count against `checkoutHint()`'s own optimal-dart-
  count answer for a sample of targets (the enumeration's *shortest* route
  should always match `checkoutHint()`'s answer) is a good sanity check to
  build the test suite around.
- **Accessibility**: same standing checklist as every other Checkout Trainer
  surface — the "already found"/"new route"/"complete" feedback must not be
  color-only (icon + text, matching every other status signal in this app).
  A running "N found" counter should be announced via `aria-live="polite"` on
  update, not just visually updated, so a screen-reader user can track
  progress without re-reading the whole found-list after every submission.
- **Security**: no new credential/token surface; reuses the existing
  Checkout Trainer write path (`addTurn`-style, already validated/bounded).
  No new cross-player leaderboard is proposed here, so no new "server is the
  source of truth" concern beyond what Checkout Trainer already established.

## Suggested build order

1. `allCheckoutRoutes(rem, doubleOut, maxDarts)` in `frontend/scoring.js`,
   proven with exhaustive committed tests before anything else touches it —
   the one piece of new logic everything else in this mode depends on.
2. Resolve the "every mathematically valid route, or a curated/double-out-only
   subset" open question (see below) before building the UI — this decides
   whether straight-out mode ships at all for v1.
3. Core loop: target selection (reusing Freeform's), route submission +
   already-found/new/complete grading, a dart-count-ceiling setup toggle.
4. Decide and ship the "reveal the total up front vs. hidden running count"
   UX question — affects the core loop's own copy/feedback, so needs
   resolving before polish, not after.
5. Stats/Personal Bests (Best Coverage %, Toughest Full Clear, Total Distinct
   Routes Learned), modeled on Freeform's own functions.
6. The milestone ladder + one-off flagship badge, data-driven off one array
   exactly like every other ladder in this app.
7. Decide whether Route Recall rounds feed Freeform's existing lifetime
   ladders, and wire that up if so.

## Open questions for whoever picks this up

- **Every mathematically valid route, or double-out only?** Straight-out
  mode's "any dart can finish" rule could make some targets' full route list
  large and not very instructive (see "New required logic" above) — worth
  deciding whether v1 ships double-out only (the far more common real-world
  practice context anyway) and defers straight-out, rather than solving the
  explosion problem for both from day one.
- **Should some numbers be excluded from this mode entirely** if their full
  route count at the 3-dart ceiling is too large to be a meaningful "find
  them all" task (as opposed to a difficulty tier just being harder)? Needs
  real numbers run through `allCheckoutRoutes()` once it exists before this
  can be answered with actual data rather than a guess.
- **Reveal the total up front, or keep a hidden running count?** Both
  options are sketched above as real alternatives, not decided.
- **Timed variant?** Freeform has an untimed and a timed (Blitz) sibling —
  worth deciding whether Route Recall eventually gets its own timed variant
  ("find as many routes as you can for this one target in 60 seconds") or
  stays untimed-only, matching how Blitz itself was explicitly sequenced
  *after* Freeform was "proven and actually played a few times" in the
  archived doc's own build order — the same "prove the untimed core loop
  first" sequencing likely applies here too.
- **Does a route found here count toward Freeform's existing lifetime
  ladders** (Lifetime Attempts, Lifetime Optimal Answers, Best Optimal
  Streak)? Sketched as an open case-by-case decision above, not resolved.
- **Exact ladder thresholds and the one-off badge's own threshold** (10+
  routes suggested above) are first-pass placeholders, not final — tune
  against actual play once the mode exists, same as every other threshold
  in every other Checkout Trainer ladder.
- **Grouping mechanism for "routes submitted against the same target"**
  (`turns.route_recall_round` sketched above) is a first-pass idea, not a
  committed schema decision — whoever builds this should weigh it against
  reusing an existing per-turn grouping column before adding a new one.
