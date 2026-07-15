# Badge Expansion 2 — Darts-Culture One-Offs & Coverage Parity — Design Roadmap

> Status: **Part A done, 2026-07 — Part B not started.** Two independently
> shippable halves, tracked as two items on `docs/open-roadmap-items.md`:
> (A) culture one-offs + a lifetime-180s ladder — **shipped**, see
> `REFERENCE.md`'s Achievements section (the `CHAIN_CHECKS` table and the
> new "lifetime-180s milestone ladder" subsection) for the authoritative
> behavior; (B) badge-coverage parity for the modes the (now 99-badge)
> roster still shortchanges (Baseball: 2 badges, Doubles Practice: 0) —
> still open, see `docs/open-roadmap-items.md` item 29. This doc stays in
> `docs/` (not archived) until Part B ships too.

## Part A — Culture one-offs + the 180s ladder

Real-darts-culture moments players already shout about at the board, all
detectable from dart data the app already records (no schema changes):

- 🍳 **Bed & Breakfast** — the classic 26: a visit of exactly S20, S5, S1
  (any order — the canonical "hotel breakfast" splash around the 20).
  Exact-sector/multiplier match on the three darts, not just `scored ===
  26` (60+... other 26s aren't the joke). Recurring-count badge.
- 🏚️ **Madhouse** — win an X01 leg on **double 1**, the finish nobody
  wants to be left on. Checked where checkout darts are already inspected
  (the Staircase Finish precedent: a pure predicate on the winning visit's
  darts, unit-tested in `scoring.test.js`). Recurring.
- 🀄 **Shanghai visit** — single, double, AND treble of the same number in
  one X01 visit (any order, any number). A pure three-dart predicate like
  `isStaircaseFinish()`. Recurring. Deliberately independent of the
  Shanghai *game mode* (`docs/shanghai-roadmap.md`) — this is the feat
  landing inside a normal X01 leg; the mode's own instant-win badge is its
  own thing, and each doc references the other so they never merge.
- **Lifetime 180s ladder** — 180! is currently a recurring counter badge
  with no milestone tiers, an odd gap given how central 180s are and how
  well the data-driven ladder engine (`CHUCKIN_MILESTONE_LADDERS` shape)
  has worked five times now: tiers at **10 / 25 / 50 / 100 / 250** lifetime
  180s (labels along the lines of Ton-Eighty Club → Maximum Regular →
  Half-Century of Maximums → Century of Maximums → Maximum Machine).
  Lifetime count is already queryable (`getOneEightyStats()`); the ladder
  check follows the established fetch-base-once-then-count-locally pattern
  the Chuckin/Checkout Trainer ladders use.

All checked at visit-commit time in `enterTurn()` where 180/Staircase/No
Cigar hooks already live; undo-revocability follows each badge's nearest
precedent (recurring moment badges revoke on undo like their siblings;
ladder tiers are permanent, like every other ladder).

## Part B — Coverage parity: Baseball & Doubles Practice

The roster's per-mode spread is lopsided (Checkout Trainer 34, Baseball 2,
Doubles Practice 0). Not every mode needs 30 badges, but zero-and-two
leaves real feats uncelebrated:

- **Baseball** (existing: 🔥 Perfect Inning, 🏆 Perfect Game):
  - ⚾ **Walk-Off** — win in extra innings (a completed game whose deciding
    inning number is > 9; derivable from turns, no new state).
  - 🔄 **The Cycle** — one inning's visit containing a single, a double,
    AND a treble of the inning's number (exactly 6 runs the scenic way) —
    Baseball's cousin of the Shanghai visit, same pure-predicate shape.
  - **Lifetime runs ladder** — 100 / 500 / 1,500 / 5,000 career runs, the
    standard ladder engine over `SUM(scored)` on Baseball turns.
- **Doubles Practice** (existing: none):
  - **Lifetime doubles-hit ladder** — 50 / 250 / 1,000 / 5,000 doubles hit
    in the drill (the mode's core count, already computed for its stat
    bubbles).
  - 🎪 **Ring Master** — hit every double D1–D20 plus bull in Doubles
    Practice lifetime (a completion badge over sectors already recorded;
    kin to Around the World's completion shape). One-off, permanent.

## Accessibility, security, and testing considerations

- **Accessibility**: nothing new structurally — badges ride the existing
  overlay/Badge Case surfaces; each new badge needs its hover/tap
  description written in plain language (the "how to earn it" text is the
  accessibility surface here).
- **Security**: no new endpoints; awards go through the existing
  `awardBadge()` path and its badge-id shape validation.
- **Testing**: every trigger condition is a pure predicate or a threshold
  over an existing count — each gets a committed test
  (`scoring.test.js` for the dart-shape predicates: Bed & Breakfast's
  exact-sector rule vs an ordinary 26, Madhouse, Shanghai visit incl. the
  "two singles + treble is not a Shanghai" negative, The Cycle;
  ladder-threshold tests via the existing `chuckinTiersReached()` helper
  they'll reuse). REFERENCE.md's Achievements section and the badge-count
  totals (89 before Part A, now 99 — updated in README in three places
  plus the sum-of-parts sentence, since this exact count has drifted
  before) update in the same change. Part B's own badges get the same
  treatment when they ship.

## Resolved for Part A

- Ladder thresholds shipped exactly as first-passed above (10/25/50/100/250)
  — not re-derived.
- **Bed & Breakfast** is X01 only, per this doc's own lean — it's checked in
  `enterTurn()`'s `CHAIN_CHECKS`, a function Cricket's own turn-entry path
  (`enterTurnCricket()`) never calls, so this is structural rather than an
  extra condition to maintain.

## Open questions for whoever picks up Part B

- Whether Part B should wait for Shanghai/Halve-It (which arrive with
  their own badge sets) so the Badge Case reorganizes once — lean: no,
  parity is worth having now; new modes slot in fine.
