# Dead Man Walking — Design Roadmap

> Status: **done.** Built as roadmap item 30 — see `docs/open-roadmap-items.md`'s
> completion ledger and `REFERENCE.md` §33 for the shipped implementation. The
> "Implementation notes" section at the bottom of this doc answers every open
> question below with what was actually decided/built.

## Goal

A solo drill that skips straight to the part of a leg that actually
matters. **15 rounds**; each round drops the player onto a real checkout
deficit — one of *their own* historically weakest finishes — with **one
fewer dart than they should reasonably need**. Close it → **Walked Out**.
Bust, or run out of darts → **Executed**. Across the session, the count of
Walked Out rounds lands on a result tier (Pardoned down to Executed). No
warmup, no easy numbers — the deficits are pulled from the player's own
worst history and keep recurring until they're solved.

## How this differs from every existing mode (don't conflate)

- **The 121 Checkout Ladder** (`docs/archive/practice-ladders-roadmap.md`, Part B)
  is the closest structural precedent — real X01-shaped visits from a
  non-501 starting deficit, `evaluateVisit()` and its existing bust rules
  reused unmodified, a fixed dart cap per attempt (its 9-dart/3-visit
  cap). Dead Man Walking borrows that shape wholesale but changes two
  things: the starting number is **personalized and adversarial** (always
  drawn from *this player's* worst checkouts, not a fixed 121), and the
  dart cap is **variable and tighter than the ladder's flat 9** — a
  computed *par minus one*, different every round. Where the ladder moves
  ±1 forever, Dead Man Walking is a fixed 15-round session with a tiered
  result at the end.
- **Coaching Insights** (`docs/archive/coaching-insights-roadmap.md`)
  already computes "this player's checkout route is inefficient" and "this
  player busts more on odd-vs-even remaining scores" as passive,
  read-only observations. Dead Man Walking is the same underlying
  weakness-detection idea (see Data model below, which reuses its exact
  remaining-score reconstruction technique) turned into an **active
  drill** rather than a profile-page callout.
- **Checkout Trainer** (`docs/archive/checkout-trainer-roadmap.md`) never
  involves a real throw — it asks "what would you throw," graded against
  a typed-in answer. Dead Man Walking is a real physical throwing drill,
  the same "mental sibling vs. physical sibling" distinction the Checkout
  Ladder doc already drew against Checkout Trainer, extended here too.
- **The Pressure Chamber** (`docs/archive/pressure-chamber-roadmap.md`) and
  **The Gauntlet** (`docs/archive/gauntlet-roadmap.md`) are both fixed-round,
  tiered-result solo drills, but their round content is either
  seed-generated from a curated pool (Pressure Chamber) or a hardcoded
  constant (Gauntlet's station order) — genuinely global content dressed
  up per-run. Dead Man Walking's round content is **frozen from a live
  query against this specific player's own history at the moment the
  session starts** (see Data model) — the one drill in this set whose
  content isn't reproducible from a formula or a constant, only from a
  snapshot taken at creation time.
- This is **not** a new way to play out a leg of X01 — a standalone drill,
  same footing as the others above, and gets its own doc.

## Design

### Session structure

- **Game type**: `dead_man_walking` in `KNOWN_GAME_TYPES`, `contexts:
  ['practice']` only — explicitly solo, matching the pitch.
- **15 rounds** per session (`config.rounds`, see below) — each round is
  its own **leg** (`leg_no` increments per round, same "each attempt is
  its own leg" shape the Checkout Ladder already uses), since a round can
  span more than one 3-dart visit.

### Sourcing the deficit — reusing Coaching Insights' own technique

A new `getWeakestCheckouts(playerName, count)` in `backend/db.js`, built
directly on the reconstruction technique Coaching Insight #3 (bust
pattern by parity) already established: **the remaining score entering
each turn isn't stored, so it's rebuilt with the same window-function
trick already in production** —
`json_extract(g.config,'$.startingScore') - COALESCE(SUM(t.scored) OVER
(PARTITION BY t.game_id, t.set_no, t.leg_no ORDER BY t.id ROWS BETWEEN
UNBOUNDED PRECEDING AND 1 PRECEDING), 0)`. Filtered to double-out X01
turns where that reconstructed remaining is a genuinely finishable
checkout (32–170, excluding the known bogey set the same way
`checkoutHint()`/the trick-question tier already do — never serve a
number that can't legally be finished), grouped by that remaining value,
this produces a per-number **weakness score** — bust rate and
non-completion rate at that number, weighted so a number seen only once
or twice can't dominate (the same sample-size floor Coaching Insights
already applies via `COACHING_MIN_NUMBER_DARTS`/`COACHING_MIN_ROUTE_USES`,
reused here as a `DMW_MIN_NUMBER_SAMPLES`-style constant rather than
invented fresh). The worst-ranked numbers with enough sample become the
session's candidate pool; 15 are drawn from it (with repeats allowed if a
player's genuinely-weak pool is smaller than 15).

- **"Avoided" checkouts** (the pitch's third category, alongside busted
  and missed) aren't independently detectable from recorded data with any
  confidence — there's no reliable signal in `turns`/`darts` for "the
  player deliberately routed around a specific number." This doc scopes
  the query to the two concretely measurable signals (bust rate,
  non-completion rate) and treats "avoided" as flavor framing rather than
  a third literal query input — flagged again below as an open question
  rather than silently dropped.
- **Cold start**: a player with too little X01 checkout history for a
  confident weakness ranking (a new player, or one who hasn't played
  enough double-out legs yet) falls back to the existing curated
  `CHALLENGE_CHECKOUTS` pool (`frontend/index.html`, already built for
  Daily Challenge) rather than inventing a second curated list — the same
  "reuse existing curated content for a cold start" precedent Daily
  Challenge itself set.

### Par — and the floor that keeps every round mathematically possible

The pitch's "par minus one" only makes sense if **par is a personalized,
skill-calibrated standard above the theoretical minimum** — not the
`checkoutHint()`-optimal dart count itself. (Using the objective optimal
as par directly would make *every* round mathematically impossible: you
cannot legally finish a checkout in fewer darts than its theoretical
minimum, so "optimal minus one" is never achievable. This is a real trap
in the original pitch's wording that the design below resolves rather
than reproduces.)

- **Par = the player's own historical average total darts-to-finish** for
  checkouts in the same difficulty band as this round's deficit (bands:
  roughly Low 32–60 / Mid 61–100 / High 101–170 — continuous banding is a
  fine alternative, not load-bearing). "Total darts" here already means
  across however many visits it actually took, matching how the app's
  existing `fewestDartsToFinish`-style Personal Bests already count darts
  across a real multi-visit checkout, just averaged instead of
  minimum-ed.
- **A hard floor**: `par = max(historicalAverage, checkoutHint(target,
  true, 3).split(' ').length + 1)` — guaranteeing `par − 1` is always at
  least the theoretical optimal dart count, so the round is always
  achievable in principle, just tight relative to what *this player*
  usually needs. This floor is the one concrete correctness fix this doc
  adds to the pitch as written, and needs its own committed test (see
  Testing below) proving no computed budget ever drops below the
  objective minimum.
- **No history yet in a band** (even after the cold-start fallback above
  supplies a target): default par to `objectiveOptimal + 2`, a generous
  grace amount, so the mode is playable session one without inventing a
  fake historical average.
- **Budget for the round = `par − 1` total darts**, across however many
  visits it takes to use them.

### Execution — per-dart evaluation, not per-visit

Because the budget won't generally be a multiple of 3, and a bust or a
finish must end the round the instant it happens (per the pitch's own
"the round ends immediately"), this can't wait for `evaluateVisit()`'s
usual batched 3-darts-at-once shape. A new pure
`evaluateDeadManDart(remaining, dart, doubleOut)` in `frontend/scoring.js`
evaluates **one dart at a time**, generalizing `evaluateVisit()`'s own
bust logic to a running score — the same "session-ending event can fire
on any dart, not just a 3-dart batch boundary" shape Doubles Practice
already established as this app's precedent for per-dart (not per-visit)
evaluation:

- New remaining < 0 → **bust → Executed**, round ends now.
- New remaining === 1 under double-out → **bust → Executed**.
- New remaining === 0: a valid double (or single-out's looser rule) →
  **Walked Out**; otherwise → **bust → Executed**.
- Otherwise: if this dart used up the round's entire budget without
  reaching 0 → **Executed** ("out of darts"), round ends now.
- Otherwise: continue — more darts remain in the budget.

Darts are still collected in ordinary 3-dart `turns` rows for storage
(nothing about the physical input widget changes), but the *live* stop
condition is checked after each dart, the same UI shape Doubles
Practice/Dartboard mode's per-dart feedback already uses.

### Data model

- `dead_man_walking` added to `KNOWN_GAME_TYPES`.
- **`config.rounds`**: an array of 15 `{target, par}` pairs, computed
  **once, server-side, at game creation** (inside `createGame()`, the
  same place `pinnedTarget`/other config fields are already validated)
  from `getWeakestCheckouts()` + the par calculation above, then frozen —
  never recomputed live from a player's still-changing history mid-session.
  This is deliberate: recomputing per-round against live data would make a
  resumed/saved game non-reproducible (the player's history could shift
  between rounds if... it can't, realistically, within one sitting, but
  freezing it at creation time is simpler to reason about, test, and
  replay than trying to make it a pure function of `(game.id, roundIndex)`
  the way Pressure Chamber's cards are — this is the one drill in the set
  where that's genuinely not possible, since the *source data* is a
  snapshot of external state, not a formula).
- **No new `turns` columns at all.** Each round is its own `leg_no`;
  `turns.target_score` (already exists) stores that round's deficit for
  cheap querying/display; `bust`/`checkout` are used in their **ordinary
  X01 sense**, no repurposing needed — a round is Walked Out iff any turn
  within its leg has `checkout=1`, Executed otherwise (whether by a real
  bust or by exhausting the budget without one — that distinction matters
  for live in-round UI feedback but not for anything stored or tallied).
- **Server-authoritative round generation.** `config.rounds` is computed
  by the server at creation, never accepted from the client — a hostile
  client choosing its own easy targets/generous pars for itself is exactly
  the kind of thing this needs to close off, unlike Pressure Chamber's
  seed (which is safe to trust either side precisely because it's a pure
  function nobody can bias).
- **Per-round dart-budget guard**: the same shape as the Checkout Ladder's
  existing 9-dart cap, generalized to a **variable** cap read from
  `config.rounds[roundIndex].par − 1` instead of a flat 9 — reject a turn
  that would push a round's cumulative recorded darts past its own budget.
- **Real physical throws** — full participation in heatmaps, treble/double
  rate, dart-pace, everything, same conclusion the Checkout Ladder and
  Bob's 27 both reached (this is genuinely thrown darts at a genuine
  target, not Checkout Trainer's hypothetical input).

### Result tiers

Computed at read time from the count of Walked Out rounds (legs with a
`checkout=1` turn) out of 15, never stored — same derive-don't-store
precedent every tiered result in this doc set uses:

| Walked Out | Result |
|---|---|
| 13–15 | Pardoned |
| 10–12 | Reprieve |
| 7–9 | Last Rites |
| 4–6 | The Walk |
| 0–3 | Executed |

### Stats, Personal Bests, leaderboard

- **Stat bubbles**: runs completed, average Walked Out count per run,
  bust rate vs. ran-out-of-darts rate (two distinct ways to fail, worth
  separating for the player even though both tally as "not Walked Out"),
  average darts of margin remaining on a Walked Out round.
- **Personal Best**: most Walked Out rounds in a single run — a
  **higher-is-better** metric (`MAX()`), the standard descending shape
  most "best run" boards in this app already use (contrast Gauntlet's
  deliberately ascending Scar count — this one isn't inverted).
- **Home leaderboard**: best (highest) Walked Out count, one row per
  player, their peak run.
- **A natural cross-feature tie-in** (not required for v1, worth noting so
  it isn't lost): a player who keeps getting Executed on the same number
  is exactly the audience for the existing "Drill this checkout" deep
  link (`docs/archive/checkout-drill-link-roadmap.md`,
  `config.pinnedTarget`) — a "Drill this number" affordance on a
  session-recap screen jumping straight into Checkout Trainer pinned to
  that specific weak number would close the loop between diagnosing a
  weakness here and mentally rehearsing the fix there.

### Achievements

Data-driven ladders off `CHUCKIN_MILESTONE_LADDERS` — lifetime runs
completed, lifetime Walked Out rounds, longest Walked-Out streak (within
or across runs). One-off badges: 🕊️ **Full Reprieve** (a perfect 15/15
Walked Out run — this mode's hardest single-session feat), ⚰️ **Pardoned**
(reach the 13–15 tier), and, in keeping with the mode's own dark humor,
a defiantly self-aware 💀 **Last Request** for going 0/15 — a "you
showed up" badge rather than a purely celebratory one, matching the tone
the pitch itself leans into.

### Live scoreboard

Same conclusion as Checkout Trainer/Gauntlet: single-device, solo, no
cross-device `/display` sync needed. A live in-progress display during
the run — current round N/15, the deficit, darts remaining out of budget
(a dart-count countdown, not a wall-clock one — different flavor from
Pressure Chamber's No Warmup timer), and the running Walked Out tally —
is ordinary single-page UI state.

### Saved games

A resumed run replays from the frozen `config.rounds` array plus a count
of completed legs (rounds) so far — pure function of stored config +
turns, per `docs/archive/saved-games-roadmap.md`, same as every other
drill in this set.

## Accessibility, security, and testing considerations

- **Accessibility**: the round's deficit and darts-remaining-in-budget
  need a persistent, always-visible text label (a "2 darts left" style
  countdown is a state a screen-reader user can't infer from a
  highlighted dartboard region alone) with periodic `aria-live`
  announcements as the budget runs low. A bust, a Walked Out, and an
  Executed-by-budget result are each state changes needing their own
  `announce()` call and icon + text, never color/flash alone.
- **Security**: `config.rounds` must be server-generated at creation, never
  client-supplied (above); the per-round dart-budget guard (above,
  generalizing the Checkout Ladder's flat 9-dart cap to a variable one);
  the existing X01 bust/checkout legality already covers core scoring, no
  new credential surface.
- **Testing**: `getWeakestCheckouts()`'s weakness ranking (bust/
  non-completion rate, the sample-size floor, bogey exclusion, the
  cold-start fallback to `CHALLENGE_CHECKOUTS`); the par calculation
  **and its floor** (a committed test proving the computed budget is
  never below the objective-optimal dart count for every finishable
  score 2–170, the same exhaustive-range verification `checkoutHint()`
  itself already has); `evaluateDeadManDart()`'s three-way outcome
  (bust/win/out-of-darts); the per-round budget server guard; and the
  result-tier thresholds. Every one of these is new calculation, squarely
  under CLAUDE.md's "every new calculation gets a committed test" rule.

## Suggested build order

1. `getWeakestCheckouts()` + the cold-start fallback, proven against
   fixture data before anything is built on top of it.
2. Par calculation + its floor, unit-tested across the full 2–170 range
   before it's wired into a real session.
3. `config.rounds` generation inside `createGame()`, server-authoritative.
4. `evaluateDeadManDart()` + the per-round dart-budget server guard — a
   bare playable 15-round session.
5. Result tiers + the live in-progress round/budget/tally display.
6. Personal Best (most Walked Out) + Home leaderboard.
7. Stat bubbles (bust vs. out-of-darts breakdown, average margin).
8. Achievement ladders + the 3 one-off badges.
9. The "Drill this number" cross-link into Checkout Trainer's existing
   pinned-target flow (optional, once the core loop is proven).

## Open questions for whoever picks this up

- **"Avoided" checkouts** — this doc's `getWeakestCheckouts()` only
  measures bust rate and non-completion rate, since "numbers the player
  routes around" has no reliable signal in recorded data. Worth revisiting
  if a concrete detection idea comes up (e.g., comparing a player's actual
  remaining-score-after-visit distribution against what an unbiased
  random route would produce), but not designed here.
- **Band granularity for the historical-average par** (three bands vs. a
  smoother continuous function of the target score) — three is this
  doc's starting recommendation for simplicity, not confirmed against
  real data.
- **Should Executed-by-bust and Executed-by-budget be tracked as visibly
  distinct outcomes** in the result screen/stats (this doc treats them as
  informationally separate but tally identically) — a real product
  question about how much nuance the end-of-run summary should surface.
- **Session personalization once `config.rounds` is frozen** — if a
  player's weak-checkout pool is thin (say only 6 genuinely weak numbers
  with enough sample), rounds 7–15 repeat from that same small pool. Worth
  deciding whether repeats should be flagged in the UI ("this one again")
  or presented identically to a fresh draw.
- **The "Drill this number" cross-link** into Checkout Trainer's
  `pinnedTarget` flow is a natural, not-yet-designed follow-on — noted
  above so it isn't lost, but genuinely a v2 concern once the core session
  loop exists and is actually played.
- Exact ladder thresholds and the one-off badges above are a first pass
  for playtesting, same "not final" caveat every other doc's numbers
  carry.

## Implementation notes (as shipped)

Everything in this doc was built as designed, with the following resolutions
to the open questions above:

- **"Avoided" checkouts** — not built. Confirmed, same as this doc's own
  reasoning: there's no reliable signal in recorded data for "the player
  routed around this number on purpose," so `getWeakestCheckouts()` measures
  only bust rate and non-completion rate, exactly as specified.
- **Band granularity** — shipped with three bands (Low 32–60 / Mid 61–100 /
  High 101–170, `DEAD_MAN_WALKING_BANDS` in `frontend/scoring.js`), this doc's
  own starting recommendation. Not tuned against real play data yet — a
  candidate for revisiting once there's a meaningful volume of real runs.
- **Executed-by-bust vs. Executed-by-budget distinctness** — resolved as:
  **not stored distinctly** (both collapse to "not Walked Out" for every
  tally, stat, and badge condition), but the live scoreboard's `announce()`
  calls and status text DO distinguish them in the moment ("EXECUTED — bust"
  vs. "EXECUTED — out of darts"), matching this doc's own framing that the
  distinction "matters for live feedback but not for anything stored or
  tallied."
- **Session personalization / repeats once `config.rounds` is frozen** — a
  thin weak-checkout pool does repeat targets across the 15 rounds (a real,
  uniform draw with replacement via `pickDeadManWalkingTargets()`), and
  repeats are **not** flagged in the UI as "this one again" — they're
  presented identically to any other round. Revisit if playtesting shows
  players are confused by an apparent duplicate.
- **The "Drill this number" cross-link** into Checkout Trainer's
  `pinnedTarget` flow — **not built**, exactly as this doc's own "Suggested
  build order" step 9 and this "Open questions" entry both frame it: optional
  future work, not part of the core session loop. Per this doc's own
  optional/v2 framing, it does not have its own tracked row on
  `docs/open-roadmap-items.md` — pick this doc back up directly if it's ever
  wanted.
- **Ladder thresholds and the 3 one-off badges** — shipped as specified in
  the Achievements section above (🕊️ Full Reprieve for 15/15, ⚰️ Pardoned for
  13+/15, 💀 Last Request for 0/15), plus a `4/4/3`-tier three-ladder set
  (lifetime runs completed, lifetime Walked Out rounds, longest Walked-Out
  streak) for 14 badges total. Unchanged from this doc's first pass; still
  not confirmed against real playtesting data.
- **A real bug found along the way, outside this doc's own scope**: building
  this drill's stats surfaced a pre-existing isolation gap in
  `getPersonalBests()`/`getPlayerStatBubbles()` — several X01-specific fields
  (`bestLegAvg`, `bestLeg`, `recentFormAvg`, `lifetimeAvg`, `avgDartsPerLeg`,
  `fewestDartsCheckout`) filtered on `t.checkout=1` with no `game_type='x01'`
  guard, so 121 Checkout Ladder's (and now Dead Man Walking's) own checkouts
  were silently leaking into X01's Personal Bests. Fixed alongside this
  feature; see `REFERENCE.md` §33's "Stats" section for the full writeup.

Every new calculation here (the weakness ranking, the par/floor formula, the
per-dart evaluator, the write-time budget guard, and the result tiers) has a
committed, re-runnable test in `backend/test/scoring.test.js`,
`backend/test/db.dead-man-walking-stats.test.js`, and
`backend/test/db.turn-consistency-guard.test.js`, per `CLAUDE.md`'s standing
testing rule.
