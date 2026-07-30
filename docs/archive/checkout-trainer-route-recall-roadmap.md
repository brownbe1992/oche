# Checkout Trainer — "Route Recall" Sub-Mode Design Roadmap

> Status (2026-07): **✅ BUILT AND SHIPPED.** Every build-order step below is done.
> Two things the design got wrong were corrected on the way and are called out in
> place: the proposed enumeration alphabet (§"Resolved") and the assumption that
> only straight-out explodes (same section). This is the third sub-mode for Checkout
> Trainer (`docs/archive/checkout-trainer-roadmap.md`, fully shipped — Freeform
> and Checkout Blitz), proposed by the owner: "given a number, try to list all
> of the possible checkouts." Filed as its own doc rather than reopening the
> archived one, since Freeform/Blitz are complete and this is new, separable
> work — see `CLAUDE.md`'s roadmap-doc convention.
>
> **Storage note (2026-07, after this doc was written):** the sections below
> describing a submission as a `turns` row, and `turns.set_no` as the hunt
> counter, describe how this shipped, not how it works now. Checkout Trainer has
> since moved off `turns`/`darts` entirely and onto `checkout_trainer_rounds`,
> where the hunt counter is a column of its own (`hunt_no`) rather than a
> borrowed one — see `REFERENCE.md` §19 for why. The duplicate check also moved
> to the server, against the hunt's stored `route_key`s, rather than living only
> in the client's in-memory set. Everything else here — the grading, the coverage
> maths, the ceiling, the badges — is unchanged.

## Resolved (2026-07)

### Step 1 shipped: `allCheckoutRoutes()` / `routeKey()`

In `frontend/scoring.js`, with `backend/test/scoring.all-checkout-routes.test.js`
(12 cases) proving it before anything is built on top, exactly as the build order
below requires.

**This section's proposed alphabet was wrong, and the correction matters.** It said
to reuse `CO_FIRSTS` as the segment table to search over. `CO_FIRSTS` holds 42
segments — every treble, both bulls, every single — and **no doubles at all**. That
is precisely right for a *hint* (nobody aims a double as a setup dart) and it
silently loses real routes here: 110 = D20 T20 D15 is a finish a player can name,
and a `CO_FIRSTS`-based search never sees it. The enumerator uses the full
62-segment board instead. This is exactly the failure this doc's own testing note
warned about — an enumeration that misses a valid route tells a player a correct
answer is wrong — so it is worth stating plainly rather than quietly fixing.

Canonicalization is as this doc specified: an unordered multiset of setup darts
plus a designated final dart. Both halves matter — T20 then T19 is not a different
route from T19 then T20, but for 60, "D20 then D10" and "D10 then D20" genuinely
are two different routes, and one rule produces both answers.

Proven against an **independent brute-force oracle** over all 180 targets × both
out-modes × all three ceilings (1,080 set comparisons), plus legality, no
duplicates, ceiling monotonicity, the bogey numbers, and this doc's own suggested
sanity check that the shortest enumerated route matches `checkoutHint()`'s dart
count (compared as a *length*, since several targets have many equally short
routes and `checkoutHint()` returns whichever its preference order reaches first).

One deliberate difference from `checkoutHint()`: no `rem > 170` cutoff. That bound
is an X01 double-out convention, and 171 = T20 T20 T17 is a real straight-out
finish, so a general enumerator must not carry it.

### The route counts, and what they decided

The two open questions below both turned on numbers nobody had. Here they are:

| ceiling | finishable targets | total routes | worst target |
|---|---|---|---|
| double-out, 1 dart | 21 | 21 | 1 route |
| double-out, 2 darts | 102 | 1,323 | **36** (target 40) |
| double-out, 3 darts | 162 | 42,336 | **730** (target 58) |
| straight-out, 3 darts | 167 | 124,979 | **1,882** (target 60) |

At the 3-dart double-out ceiling, **81 of the 162 finishable targets have 200+
routes**. "Find them all" is not a task there, and no amount of UI copy makes it
one. This doc assumed straight-out was the explosion risk and that double-out
"sidesteps the worst of it" — **both explode**; double-out is merely a third the
size of straight-out.

**Owner's decision (2026-07), which resolves the first three open questions at
once:**

- **1- and 2-dart ceilings ship the drill as designed** — the complete set, the
  total revealed up front, the "🎉 Every route found!" completion moment, coverage %
  against a real denominator. The worst case is 36 routes, which is a genuine,
  closeable study task.
- **The 3-dart ceiling ships as a different thing wearing the same clothes**: an
  open-ended "how many can you find" score, with **no** total revealed, no finish
  line, and no completion moment. Coverage is still measurable against the real
  denominator internally, but it is not presented as a fraction to be closed.
- Consequently **no target needs excluding** (open question 2): the tier framing,
  not a blocklist, is what keeps every target meaningful.
- **Both out-modes are viable** under that framing, so double-out-only is no longer
  a necessary v1 restriction — though double-out remains the sensible default.

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

## What shipped (2026-07)

**Setup.** A third button in Checkout Trainer's sub-mode toggle, plus a dart-ceiling
toggle (1 / up to 2 / up to 3) that appears only for this sub-mode. A pinned target
from "Drill this checkout" now *keeps* Route Recall rather than forcing Freeform —
"drill everything I know about checking out 100" is exactly what a pin plus this
sub-mode means, and this doc predicted it would be the pin's natural home. Trick
questions are forced off: a bogey number has no routes, so a hunt for one would open
on an empty board with nothing to do.

**Core loop.** `submitRouteRecall()`. The target is held across submissions — the one
structural difference from every other mode in the app — and the three outcomes are:

| outcome | recorded | told |
|---|---|---|
| illegal | a turn with `bust=1` | which of *too many darts / past zero / doesn't reach / finishes off a double / that's a miss* |
| duplicate | **nothing at all** | "Already got that one — D20" |
| new | a turn with `checkout=1` | the route, and the tally |

A duplicate recording nothing is deliberate twice over: re-entering a route by
accident must cost nothing, and it also means "routes found" is simply the count of
`checkout=1` turns rather than something that has to be de-duplicated at read time.

**The found list is always on screen.** Without it, "have I already said T20 T20
D20?" makes this a memory test about a memory test.

**Data model** (this doc's open grouping question, resolved): `games.config.mode =
'route_recall'` plus `config.routeCeiling`; `turns.set_no` is the hunt number and
`turns.leg_no` the submission within it. **No new column** — `set_no` is already a
free-standing per-turn grouping integer and this sub-mode has no concept of sets to
conflict with it, which is exactly the "weigh it against reusing an existing column
before adding one" the open question asked for.

**Stats.** Best Route Coverage %, Toughest Full Clear and Routes Named (lifetime),
all in `getRouteRecallStats()`. Coverage is a fraction of a *real* denominator — the
target's complete route set at that hunt's ceiling — so 100% genuinely means every
one. "Toughest" full clear means the most ROUTES, not the biggest target: the route
count is what made it hard. The per-hunt arithmetic runs in JS over a grouped query
rather than in SQL, because the denominator depends on the hunt's ceiling *and* the
player's out-mode and only `allCheckoutRoutes()` knows it.

**Isolation, which is the part with no visible symptom.** Route Recall shares the
`checkout_trainer` game type, and its `checkout=1` means "a route you had not named
yet" while Freeform/Blitz's means "a legal answer to this round". Every Freeform and
Blitz statistic is therefore scoped with `NOT_ROUTE_RECALL`, or a Route Recall hunt
would silently move a player's Freeform accuracy. The exclusion uses `IS NOT
'route_recall'` rather than `!=` on purpose: `config.mode` is absent on rows written
before this sub-mode existed, and `!= NULL` is NULL, which would have erased every
pre-existing Checkout Trainer statistic instead.

**Ladder and badge.** `ROUTE_RECALL_MILESTONE_LADDERS` counts routes named (25 /
100 / 300 / 800 / 2000), deliberately its own ladder rather than feeding Freeform's
attempts ladder — those count different things, and merging them would let one Route
Recall session vault a player up a ladder that measures targets answered. 🗺️
**Cartographer** is the flagship: every route of a target that had 10 or more, in one
hunt. The floor is what stops it firing on "every route for 40 at one dart", which is
one route.

**Answered: do Route Recall rounds feed Freeform's lifetime ladders?** No — see
Isolation above. Same reasoning the archived doc used to keep Blitz out of the
session-endurance ladder: a ladder should measure one thing.

**Coverage.** `backend/test/scoring.route-recall-grading.test.js` (14 cases,
including a sweep asserting that *every* route the enumerator lists grades as `new` —
otherwise a hunt could display a total it is impossible to reach),
`backend/test/db.route-recall-stats.test.js` (8, including the isolation and the
legacy-row case), and the verify-ui `route-recall` check (16), which plays real hunts
and pins the things unit tests cannot see: that the target does not move on, that the
found list is rendered, that a duplicate is not styled as a mistake, and that the
revealed and open-ended tiers really do differ on screen.

**One defect found by its own tests.** The grader initially reported "that goes past
zero" for a route that landed exactly on zero off a single — `evaluateVisit()`'s
`bust` covers both mistakes. Telling a player their arithmetic was wrong when it was
their finish is both false and the wrong lesson, so the rejection reasons now
distinguish `overshoots` / `short` / `bad-finish`.

**Not built, deliberately: a timed variant.** This doc's own sequencing argument —
prove the untimed core loop first, exactly as Blitz was sequenced after Freeform —
still applies, and now has a mode to be proven against.

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

- ~~**Every mathematically valid route, or double-out only?**~~ **Resolved** — see
  "Resolved (2026-07)" above. The premise was wrong (double-out explodes too), and
  the per-tier framing solves it for both out-modes.
- ~~**Should some numbers be excluded from this mode entirely?**~~ **Resolved: no.**
  The 3-dart tier's open-ended framing means a 730-route target is a deep well
  rather than an impossible checklist.
- ~~**Reveal the total up front, or keep a hidden running count?**~~ **Resolved:
  both, by tier** — revealed at 1-2 darts, hidden at 3.
- ~~**Timed variant?**~~ **Deferred on this doc's own reasoning** — prove the untimed
  core loop in real play first, exactly as Blitz was sequenced after Freeform. Original
  note: Freeform has an untimed and a timed (Blitz) sibling —
  worth deciding whether Route Recall eventually gets its own timed variant
  ("find as many routes as you can for this one target in 60 seconds") or
  stays untimed-only, matching how Blitz itself was explicitly sequenced
  *after* Freeform was "proven and actually played a few times" in the
  archived doc's own build order — the same "prove the untimed core loop
  first" sequencing likely applies here too.
- ~~**Does a route found here count toward Freeform's existing lifetime ladders?**~~
  **Resolved: no**, and the stats are scoped to enforce it — see "Isolation" above.
- **Exact ladder thresholds and the one-off badge's own threshold** (10+
  routes suggested above) are first-pass placeholders, not final — tune
  against actual play once the mode exists, same as every other threshold
  in every other Checkout Trainer ladder.
- ~~**Grouping mechanism for "routes submitted against the same target"**~~
  **Resolved: `turns.set_no`**, an existing free-standing per-turn grouping integer.
  No new column, exactly the outcome this question asked to be weighed first.
