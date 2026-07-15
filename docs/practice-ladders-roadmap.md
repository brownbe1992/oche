# Structured Practice Ladders — Bob's 27 & the 121 Checkout Ladder — Design Roadmap

> Status: **design phase, not started.** Two famous, self-contained solo
> practice routines with real scoring shapes (unlike freeform drills, each
> run produces a number worth ranking and laddering). Bundled in one doc
> because they share framing, but they are **independently shippable** —
> tracked as two separate items on `docs/open-roadmap-items.md`.

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
  same store-the-gain/derive-the-penalty shape `docs/halve-it-roadmap.md`
  uses for its halving rule. `bust=1` marks the fatal round (running ≤ 0),
  the established Doubles Practice column-repurposing precedent.
- **Saved games**: running total replays deterministically from the rules
  above — pure function of turns, per `docs/saved-games-roadmap.md`.
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
