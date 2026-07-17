# Structured Practice Ladders — Bob's 27 & the 121 Checkout Ladder — Design Roadmap

> Status: **Both parts shipped 2026-07.** Two famous, self-contained solo
> practice routines with real scoring shapes (unlike freeform drills, each
> run produces a number worth ranking and laddering). Bundled in one doc
> because they share framing, but they were **independently shippable** —
> tracked as two separate items on `docs/open-roadmap-items.md`. Both items
> are now Done, so this doc has moved to `docs/archive/`, per `CLAUDE.md`'s
> "only archive once every split-out item is Done" rule.

## Part A — Bob's 27

The renowned doubles routine (Bob Anderson's): start with **27 points**;
throw 3 darts at D1, then D2, … through D20. Every dart that hits the
double adds its value (D1 hit = +2, three D1 hits = +6); if **all three
darts miss** a double, you *subtract* that double's value. Drop to 0 or
below and the run is over — a fail. Survive through D20 and your final
score is the run's result (perfect run = 27 + 3×(2+4+…+40) = 1287; anything
positive at the end is a "survival").

### Design

- **Game type**: `bobs_27`, solo-only (`contexts: ['practice']`), one leg
  per run — a run IS the game, like a Blitz run.
- **Rounds/data**: one `turns` row per double (round derived from prior
  turn count, the Baseball/SEC-25 pattern; the round's double is also
  stamped on `turns.target_score`, which already exists and is
  range-checked 1–170). `scored` = points **gained** this round (0–120 for
  D20); a subtraction is derived at read time — `scored === 0` on round *n*
  means `running -= 2n` — because `turns.scored` can't go negative, the
  same store-the-gain/derive-the-penalty shape `docs/archive/halve-it-roadmap.md`
  uses for its halving rule. `bust=1` marks the fatal round (running ≤ 0),
  the established Doubles Practice column-repurposing precedent.
- **Saved games**: running total replays deterministically from the rules
  above — pure function of turns, per `docs/archive/saved-games-roadmap.md`.
- **Stats**: bubbles (runs, survival rate, avg final score, doubles hit
  rate); Personal Bests (best final score, deepest double reached on a
  fail); a Home leaderboard on best final score (peak single-run value, no
  minimum floor — the Checkout Blitz precedent). These darts are real
  throws: they count toward heatmaps/doubles% like Doubles Practice's do —
  no hypothetical exclusion.
- **Badges**: a survival/score ladder (finish positive / 100+ / 250+ /
  500+ / 1000+), plus 🎯 **Full House** (hit all three darts on one
  double) and 🏔️ **The Full Anderson** (a perfect 1287) as one-offs — all
  via the existing data-driven ladder engine.

### Implementation notes (2026-07, shipped)

Built essentially as designed, with two small deviations:

- **`turns.target_score` was never used.** The design above suggested
  "also" stamping the round's double onto it; the shipped version derives
  `round` purely from the player's own prior-turn count in the game/set/leg
  (the same SEC-25/Baseball-inning pattern), both client-side and in the
  write-time guard — a second, redundant source of truth for the same
  number wasn't needed and would have been one more place for a stored
  value to drift out of sync with the turns that are supposed to define it.
- **The write-time guard is an exact match, not a max-gain cap.** Rather
  than "reject if gain exceeds 6× the round's double" (the ceiling this doc
  originally proposed), `addTurn()` recomputes the *exact* expected gain
  from the submitted darts (`hits * round*2`, where `hits` counts only
  darts on this round's own double) and rejects any mismatch — tighter than
  a ceiling check, and no harder to compute.

Everything else matches this doc's design: `bobs_27` game type, solo-only,
one leg = one run (`legsPerSet`/`setsPerGame` forced to 1, the practice-
Baseball "a run IS the game" shape); store-the-gain/derive-the-penalty data
model exactly as specified; the 5-field stat-bubble set, 2-field Personal
Bests, and peak-single-run Home leaderboard; the survival/score ladder
(Survivor/Century/Quarter Grand/Half Grand/Four Figures at 1/100/250/500/
1000) plus 🎯 Full House and 🏔️ The Full Anderson as one-off badges, all via
the existing data-driven ladder engine (`checkChuckinMilestoneTier()`,
reused wholesale). Saved games work exactly as this doc predicted — pure
replay from `turns`, no extra schema. Full write-up: `REFERENCE.md`'s "Bob's
27 rules" (§2), "Bob's 27 stats" (§3), and "Bob's 27 badges" (§4) sections;
committed tests in `backend/test/scoring.test.js`,
`backend/test/db.turn-consistency-guard.test.js`, and
`backend/test/db.bobs27-stats.test.js`.

The "v1 ships the standard die-at-zero, D1–D20 rules; variants only if
asked for" call under "Open questions" below held — no variants were built.

## Part B — The 121 Checkout Ladder

The classic checkout ladder: start on **121**. You get up to **9 darts**
(3 visits) to check out, double-out rules. Succeed → the target moves up
one (122); fail → it moves down one (120). Play as long as you like; the
run's story is how high you climbed.

### Design

- **Game type**: `checkout_ladder`, solo-only. Each target attempt is its
  own leg (`leg_no` increments per attempt) of ordinary X01-shaped visits
  from `remaining = target`; `turns.target_score` stamps the attempt's
  target (it exists and fits, 1–170), `checkout=1` marks a successful
  finish — this is deliberately the *physical* sibling of Checkout Trainer
  (which asks what you *would* throw; this makes you throw it), and the
  setup blurb should say so to keep the two from being confused, the same
  disambiguation the Checkout Trainer doc did against Checkout Sprint.
- **Ladder movement is derived, not stored**: current target = 121 + (legs
  won) − (legs lost), replayed from the turns — nothing pre-aggregated,
  and saved-games-compatible for free.
- **Engine reuse**: `evaluateVisit()` unmodified (a real X01 visit), the
  existing bust rules included — a bust just burns the visit. The 9-dart
  cap is the leg's only new rule: after 3 visits without a checkout the
  attempt fails and the next leg starts at target−1.
- **Stats**: bubbles (attempts, success rate, current ladder position);
  Personal Bests (**highest target ever reached** — the headline number —
  and fewest darts on the highest checkout); a Home leaderboard on highest
  target reached. Real throws — full physical-stat participation.
- **Badges**: a highest-rung ladder (125 / 130 / 140 / 150 / 160 / 170)
  plus 🧗 **Peak Bagged** (check out 170 on the ladder) — with the 170
  case earning X01's Big Fish? No: leg starts aren't 501 games; keep
  ladder badges self-contained and let Big Fish stay a real-match feat.
- Floor: the target never drops below 61 (keeps every attempt a genuine
  2–3 dart combination finish rather than a single-double grind).

### Implementation notes (2026-07, shipped)

Built essentially as designed, with one addition and one clarification the
design above didn't spell out:

- **A ceiling at 170, not just a floor at 61.** `turns.target_score` is the
  same shared column Checkout Trainer uses for "a checkout target," whose
  valid range tops out at 170 (the highest possible double-out finish, T20
  T20 Bull) — the design above only specified the 61 floor, but climbing
  indefinitely past 170 would eventually request a `targetScore` outside
  that column's own valid range and fail to write. The shipped version caps
  the climb at 170: clearing 170 repeatedly just keeps a run parked at the
  summit (and re-fires 🧗 Peak Bagged every time, since it's a recurring
  badge) rather than erroring out on run N+1.
- **The "highest-rung ladder" badges are checked against the position just
  climbed TO, not the target just cleared** — reaching rung 125 means a win
  that advances the target from 124 to 125, the same "value entering the
  next attempt" framing the design's own ladder-movement math already uses.
  🧗 Peak Bagged is the separate, deliberately different case: it fires on
  actually *checking out* 170 itself (`clearedTarget === 170`), which the
  ladder-rung badges don't otherwise capture (reaching rung 170 only
  requires clearing 169).

Everything else matches this doc's design: `checkout_ladder` game type,
solo-only, each attempt its own leg (`leg_no` increments per attempt),
`evaluateVisit()` reused completely unmodified, ladder movement derived
fresh from replaying every prior attempt's own outcome (never stored), the
3-visit/9-dart cap, the 4-bubble stat set, the 2-field Personal Bests
(highest target reached counts a failed peak attempt; fewest darts on the
highest checkout only looks at the highest attempt actually *won*), the
peak-single-run Home leaderboard, and the highest-rung ladder (125/130/140/
150/160/170) plus 🧗 Peak Bagged, both via the existing data-driven ladder
engine (`checkChuckinMilestoneTier()`, reused wholesale). Saved games work
exactly as this doc predicted — pure replay from `turns`
(`rebuildCheckoutLadderState()`), no extra schema. Full write-up:
`REFERENCE.md`'s "121 Checkout Ladder" section (§26); committed tests in
`backend/test/scoring.test.js`, `backend/test/db.turn-consistency-guard.test.js`,
and `backend/test/db.checkout-ladder-stats.test.js`.

The "lean: per-run starts at 121, lifetime highest-ever is the Personal
Best" call under "Open questions" below held — ladder position does NOT
persist across sessions/runs.

## Accessibility, security, and testing considerations

- **Accessibility**: both modes announce round/target transitions
  (`announce("D7 — three darts.")`, `announce("Ladder up — 124.")`); fatal/
  fail states use icon + text.
- **Security**: both reuse the existing turn write path; Bob's 27 gets a
  Baseball-style consistency guard (max gain = 6× the round's double);
  the ladder's visits are X01-shaped but from a non-501 start, so verify
  the SEC-22 X01 check keys on game_type (it does — these are new types)
  and add a per-type equivalent.
- **Testing**: committed tests for Bob's 27's gain/penalty/death
  derivation and a full-run replay; the ladder's up/down movement, the
  9-dart cap, the 61 floor, and highest-rung stat — every formula here is
  new calculation, squarely under CLAUDE.md's rule.

## Open questions for whoever picks this up

- Bob's 27 variants: some play "score can go negative and you keep going"
  or add D25 at the end — v1 ships the standard die-at-zero, D1–D20 rules;
  variants only if asked for.
- Ladder step size: ±1 is the classic; some play success +3/fail −1 to
  climb faster. Worth a config option later, not v1.
- Should ladder position **persist across sessions** (a lifetime ladder,
  resuming where you left off) instead of each run starting at 121? Real
  design fork: lifetime is more motivating but makes the leaderboard a
  grind-measure. Lean: per-run starts at 121, lifetime "highest ever" is
  the Personal Best — but confirm against actual use.
