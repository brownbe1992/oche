# The Pressure Chamber — Design Roadmap

> Status: **complete** (core game shipped as roadmap item 28; the
> self-declare-before-verifying honesty mechanic — `declared_hit` + Honesty%,
> build-order step 10 — shipped as item 32). Every item split out from this doc
> is now Done, so this doc has moved to `docs/archive/`. See "Implementation
> notes" at the bottom for the full account of what shipped and every judgment
> call made where this doc left a number or a design question open.

## Goal

A training game for 1–4 players built to close the gap between "throws
beautifully alone" and "falls apart when something's on the line." A run is
**15 rounds**, each a fresh **Pressure Card**: a target, the stakes for
hitting/missing it, and a modifier that changes the rules for that round
only (a 5-second shot clock, an instant-loss condition, a doubled penalty,
narrated pressure). Players bank **Composure Points (CP)** across the run
and land on a **Composure Rating** (Ice/Steel/Copper/Tin/Rattled). Solo
players chase their own rating; 2–4 players can run the **identical card
sequence** head-to-head, so it's a fair contest of nerve, not just skill.

## How this differs from every existing mode (don't conflate)

- **Daily Challenge** (`docs/daily-challenge-roadmap.md`) is also a
  deterministically-generated, single-metric solo drill, but it's one
  format per calendar day with no modifier system and no multiplayer
  identical-sequence mode — Pressure Chamber's card-and-modifier engine is
  the genuinely new piece here, not the "seeded generation" idea itself
  (see Data model below for where that precedent is reused directly).
- **Halve-It** (`docs/archive/halve-it-roadmap.md`) is the closest existing
  precedent for "a fixed round sequence where missing has a real,
  derived-not-stored cost to your running score" — Pressure Chamber
  borrows that shape but adds a *variable* per-round modifier on top of a
  fixed target sequence, where Halve-It's only variable is the target
  itself.
- **Bob's 27 / the 121 Checkout Ladder** (`docs/archive/practice-ladders-roadmap.md`)
  are single-mechanic solo routines with no modifier layer and no H2H
  identical-sequence mode.
- This is **not** a new way to *play out* a leg of X01/Cricket — it's a
  standalone drill, like Halve-It/Shanghai, and gets its own doc rather
  than a `docs/game-modes-roadmap.md` section.

## Design

### Game type & structure

- **Game type**: `pressure_chamber` in `KNOWN_GAME_TYPES`, `contexts:
  ['practice', 'h2h']` (1 player solo, 2–4 players head-to-head — the
  existing player-count validation per context already generalizes to
  this range, no new min/max plumbing needed).
- **Rounds**: fixed at 15 per the pitch. Stored as `config.rounds: 15`
  rather than hardcoded, the same "store a currently-single value so a
  future variant needs no migration" precedent Checkout Blitz's
  `durationSec` and tournament's `legs_per_set` already set.
- **One `turns` row per round**, 3 darts underneath it (or fewer under
  Sudden Death — see Modifiers below) — the same per-dart-turn shape every
  other drill in this app uses.

### The card sequence is generated, never stored

The single most load-bearing design decision here: a round's card is a
**pure function of `(game.id, roundIndex)`** — `generatePressureCard(gameId,
roundIndex)` in `frontend/scoring.js`, using the same **deterministic
seeded-index** technique Daily Challenge's `_seededIndex(seedStr, poolSize)`
already established, just keyed on the game's own id instead of a calendar
date (`_seededIndex(`${gameId}|${roundIndex}|target`, TARGET_POOL.length)`,
same again for the modifier pool). Consequences:

- **Nothing about the card needs its own column.** No `target_sector`,
  no `modifier_id` — the same "derive it, don't store it" discipline
  Halve-It's halving and the Checkout Ladder's position both already use.
  Grading only ever needs the recorded `darts` for that turn plus a
  re-derivation of the card that produced it.
- **H2H "identical card sequence" falls out for free** — every player in
  the same `games` row shares one `game.id`, so every `generatePressureCard`
  call for round *N* returns the same card for all of them. No sequence
  needs to be pre-rolled and stored per game.
- **Saved games** (`docs/archive/saved-games-roadmap.md`) work by
  construction — a resumed run re-derives round *N*'s card from the
  player's own prior-turn count exactly the way Baseball derives its
  inning and Halve-It/Shanghai derive their round number.
- The **target pool** and **modifier pool** themselves are curated lists
  (a hand-picked set of interesting sector/ring/finish targets, and the
  8 modifiers below), the same "curated, not purely algorithmic" choice
  Daily Challenge made for its checkout target list — an arbitrary random
  target could land on something trivial (Single 5) or a nonsensical
  modifier pairing.

### Targets — two shapes, two grading paths

1. **Sector/ring targets** (`{type:'sector', sector, ring}`, e.g. Triple
   20, Double 16, plain 20) — graded on the **best of the round's darts**:
   an exact ring+sector match on any dart = full hit; the sector hit but
   the wrong ring (e.g. asked for Triple 20, landed a single 20) = partial;
   neither = miss. No existing engine function fits this (it isn't a
   scored visit, it's "did any dart land in this specific place") — a new
   pure `gradePressureSectorRound(target, darts)` in `scoring.js`.
2. **Finish targets** (`{type:'finish', score}`, e.g. "Finish 81 in 3
   darts") — reuses `evaluateVisit()` unmodified, exactly like Checkout
   Trainer's grading (a finish attempt is a normal X01 visit starting from
   `remaining = target.score`). No partial tier here — it's a legal finish
   or it isn't, the same binary Checkout Trainer's "legal?" check already
   models. `checkoutHint()` isn't needed for grading itself (Pressure
   Chamber doesn't ask the player to nominate a route in advance the way
   Checkout Trainer does — they just throw), but is worth reusing for a
   post-round "here's a route" reveal on a miss, echoing Checkout Trainer's
   own "leave the player having learned something" framing.

### The 8 Pressure Modifiers — what's digitally enforceable and what isn't

An honest split, since there's no camera in this app yet
(`docs/camera-scoring-roadmap.md` is still design-phase itself):

| Modifier | How it's represented |
|---|---|
| **Match Dart** | Grading rule change: only the round's **3rd dart** counts. For a sector target, darts 1–2 are ignored entirely for scoring. For a finish target, a checkout landing on dart 1 or 2 does **not** count as a legal Match Dart finish even though it normally would under `evaluateVisit()` — the round requires the finish to land specifically on dart 3. Worth stating explicitly since it's the one place this modifier changes finish-target semantics rather than just filtering which darts are read. |
| **No Warmup** | A real wall-clock deadline: `deadline = Date.now() + 5000` the instant the card is revealed, checked on each render tick — same `Date.now()`-based (not naive-countdown) precedent Checkout Blitz's timer already established, for the same reason (a backgrounded/throttled tab must not grant extra time). Dart 1 must be entered before the deadline or the round is scored as a miss automatically. |
| **Audience** | Flavor/instruction text only ("someone counts down from 10 out loud") — the app has no way to verify another human did this, so it's shown prominently on the card banner and left to the honor system, same as any tabletop game's unenforceable social rule. |
| **Double Down** | A stakes multiplier: this round's **miss** penalty is doubled. No grading change, just a different number fed into the CP formula below. |
| **Sudden Death** | Per-dart, not per-visit, entry: the round stops the instant a dart doesn't hit the target at all (not even a partial/wrong-ring hit) — darts not yet thrown are never asked for. This reuses the existing per-dart live-feedback pattern already used elsewhere (Dartboard mode, Doubles Practice) rather than needing new UI. |
| **Ghost Leg** | Flavor/instruction text only, same as Audience — a physical constraint the app can't verify. |
| **Comeback** | v1: a fixed, self-contained stakes swing for *this round only* (hit = bonus CP on top of the normal reward; miss = the round's miss penalty is doubled) — narrated as "recovering from a 20-point deficit" but not literally tracked as a persistent counter across the run. A genuinely richer version — a real deficit counter that compounds across multiple Comeback cards in one run — is real and more dramatic, but adds cross-round state this pure-function design otherwise avoids; flagged as an open question below rather than assumed. |
| **Dead Calm** | No modifier at all — the baseline target/stakes, unmodified. |

### Composure Points formula

Weighted by difficulty, per the pitch. A recommended first-pass shape
(numbers below are a starting point for playtesting, not final — flagged
again in Open questions):

- **Base CP** per target, scaled by how hard it is to hit at all: single
  sector < double < treble < bullseye < a finish target (itself scaled by
  the dart count `checkoutHint()` says the optimal route needs — a 2-dart
  finish is worth less than a 3-dart one).
- **Modifier multiplier** applied on top of the base (Dead Calm ×1.0 up
  through Sudden Death/Comeback around ×1.5) — this is the "Sudden Death
  Double 16 beats a no-modifier Triple 20" weighting the pitch calls for.
- **Full hit** → base × modifier multiplier. **Partial hit** → half that.
  **Miss** → lose a separate, smaller miss-penalty value (also
  base-and-modifier-scaled), doubled again under Double Down.

### Data model

Reuses the existing per-dart-turn shape unmodified — the card-generation
design above means this needs strikingly little new schema:

- `pressure_chamber` added to `KNOWN_GAME_TYPES`; `config.rounds: 15`.
- **No new column for the target or modifier** — both are re-derived from
  `(game.id, roundIndex)` whenever needed, per "The card sequence is
  generated, never stored" above.
- **Reuses the exact three-way `bust`/`checkout`/`leg_won` outcome
  Checkout Trainer already established**: `bust=1` = miss, `checkout=1,
  leg_won=0` = partial hit, `checkout=1, leg_won=1` = full hit. Same
  columns, same meaning, no reinvention.
- **`turns.scored`** stores the CP *gained* this round (always ≥0 — 0 on
  a miss, the half-value on partial, the full value on a full hit),
  satisfying the existing non-negative `scored` validation without any
  change to it. This is the same "store the gain, derive the rest" shape
  Halve-It's halving rule already uses for the same underlying reason
  (`scored` can't go negative).
- **A run's total CP** = `SUM(scored)` minus a **derived** total miss
  penalty: for every `bust=1` turn, re-run `generatePressureCard(gameId,
  roundIndex)` to recover that round's miss-penalty value (a pure
  function, cheap to recompute) and sum those. Nothing pre-aggregated —
  same read-time-computation philosophy as everywhere else in this schema.
- **One genuinely new nullable column**: `turns.declared_hit INTEGER` —
  the player's **self-declared** hit/miss call, made *before* their actual
  darts are read off the board, per "the one rule that ties it together."
  Only ever populated for this game type, the same purely-additive pattern
  every other one-off column (`target_score`, `zone`, …) already follows.
  A **consistency guard** in the spirit of SEC-25 (Baseball's server-side
  scored-vs-darts check) doesn't fully apply here — see Security below,
  this is the one place in this doc where server validation can't do the
  whole job, because the "declared before verifying" honesty is
  fundamentally a client-side/honor-system property, not something a
  single atomic write can prove.
- **Consistency guard that does apply**: the server derives round *N*'s
  card the same way the client did and rejects a submitted
  `scored`/`bust`/`checkout`/`leg_won` combination that combination
  couldn't produce — the same "recompute the expected shape server-side,
  reject a mismatch" principle SEC-25 established for Baseball/Shanghai.

### Composure Rating

Computed at read time from a run's total CP (never stored) against the
pitch's own table, unchanged:

| Score | Rating |
|---|---|
| 120+ | Ice |
| 90–119 | Steel |
| 60–89 | Copper |
| 30–59 | Tin |
| Below 30 | Rattled |

### Stats, Personal Bests, leaderboard

- **Stat bubbles**: runs completed, average CP, full-hit rate, partial-hit
  rate, honesty accuracy (see below).
- **Personal Bests**: best single-run CP total (a peak value, no minimum-
  attempts floor — the Checkout Blitz precedent), best Composure Rating
  ever reached, longest full-hit streak.
- **Home leaderboard**: best single-run CP, same "one row per player,
  their peak" shape as Checkout Blitz's own board.
- **Honesty %** — a secondary, non-CP-affecting stat comparing
  `declared_hit` against the actual `checkout`/`bust` outcome for the
  round. Framed as its own metric rather than folded into CP scoring,
  since the pitch's own CP table never assigns a point value to
  dishonesty — it's presented as a self-discipline signal, not a
  multiplier, and the exact "should honesty affect the rating itself" is
  flagged as an open question below rather than decided here.

### Achievements

Data-driven ladders off the existing `CHUCKIN_MILESTONE_LADDERS` engine
(`frontend/index.html` / `chuckinTiersReached()` in `scoring.js`) — same
mechanism, new metrics: lifetime runs completed, lifetime CP earned,
longest full-hit streak. One-off flavor badges tied to the modifiers
themselves: 🥶 **Ice** (reach the Ice rating in a run), 🎯 **Nerves of
Steel** (a full hit under Sudden Death), ⏱️ **No Warmup Needed** (a full
hit under No Warmup), 🃏 **Dead Calm, Steady Hands** (a full hit under
Dead Calm — the "no modifier" round the pitch itself calls "sometimes the
scariest of all").

### Live scoreboard

A `renderers.pressure_chamber` entry: round N/15, the current card (target
+ stakes + modifier banner, large and unmissable — the whole game hinges
on the player registering what's on the line before they throw), a visible
No Warmup countdown when that modifier is drawn, and each player's running
CP tally for H2H runs. The self-declare step (hit/miss button, before dart
entry) is its own screen state ahead of the normal dart-input widget.

## Accessibility, security, and testing considerations

- **Accessibility**: the modifier and stakes must never be color-only —
  icon + text on the card banner, matching every other status signal in
  this app. No Warmup's countdown needs periodic `aria-live` announcements
  (not silent, not every second) the same way Checkout Blitz's countdown
  does. Sudden Death's early-stop and a round's full/partial/miss result
  are state changes that need their own `announce()` call, not just a
  visual flash.
- **Security**: the SEC-25-style consistency guard above (server re-derives
  the expected card and rejects an inconsistent `scored`/outcome
  combination); `declared_hit` is explicitly **not** a scoring input and
  carries no leaderboard weight, which limits the blast radius of it being
  fundamentally unverifiable — see Open questions.
- **Testing**: `generatePressureCard()`'s determinism (same `(gameId,
  roundIndex)` always yields the same card — this is what H2H identical
  sequences and saved-games resume both depend on), `gradePressureSectorRound()`'s
  full/partial/miss logic, the CP formula (base × modifier multiplier,
  half-value partials, doubled-under-Double-Down misses), the derived-total-CP
  read (`SUM(scored)` minus re-derived miss penalties), and the Composure
  Rating threshold table — every one of these is new calculation, squarely
  under CLAUDE.md's "every new calculation gets a committed test" rule.

## Suggested build order

1. `generatePressureCard(gameId, roundIndex)` + the curated target/modifier
   pools, proven deterministic before anything else is built on top of it.
2. Sector-target grading (`gradePressureSectorRound()`) and finish-target
   grading (reusing `evaluateVisit()`), Dead Calm only (no modifiers yet) —
   a playable, un-modified 15-round solo run.
3. The CP formula + derived total-CP read + Composure Rating.
4. The 4 modifiers with no new UI need (Double Down, Comeback v1, Audience,
   Ghost Leg — stakes/flavor only, no new widget).
5. Match Dart's grading-rule change and Sudden Death's per-dart early stop.
6. No Warmup's wall-clock countdown (the one genuinely new UI element,
   same pattern as Checkout Blitz's timer).
7. H2H identical-sequence mode (2–4 players sharing one `game.id`).
8. Stat bubbles, Personal Bests, Home leaderboard.
9. Achievement ladders + one-off modifier badges.
10. The self-declare hit/miss step + Honesty % stat. **(Shipped as item 32 —
    see "Implementation notes" below.)**

## Open questions for whoever picks this up

- **Does Honesty % feed the Composure Rating at all**, or stay a purely
  informational side stat? The pitch frames the declare-before-verifying
  rule as a self-discipline tool, not a scoring mechanic — this doc
  defaults to "informational only," but a "Rattled" rating floor for
  chronic dishonest declarations is a real alternative worth playtesting.
- **Is `declared_hit` worth building at all in v1**, given it's the one
  piece of this design that can't be made tamper-resistant by a single
  atomic write — a determined client can always submit a `declared_hit`
  matching the real outcome in hindsight. A two-round-trip flow (declare,
  then a separate request records the actual darts) raises the bar
  slightly but doesn't close the gap entirely, since nothing stops a
  player from just looking at the board before tapping "declare" on a
  physical honor-system feature to begin with. Worth deciding whether this
  ships as "best-effort self-discipline tool" (this doc's assumption) or
  gets cut from v1 as not worth the schema for a mechanic the app can
  never actually verify.
- **Comeback's persistent-deficit version** — a real per-run counter that
  compounds across multiple Comeback draws (doubling on each miss, only
  clearing on a hit) is more dramatic than this doc's v1 (a fixed
  per-round swing) but needs genuine cross-round state, breaking the
  "everything's a pure function of `(gameId, roundIndex)`" design this
  whole doc otherwise relies on. Worth trying only once the simpler
  version is built and played.
- **Exact CP values** (base-per-target-type, modifier multipliers, the
  miss-penalty scale) are a first pass for playtesting, same as every
  other doc's provisional thresholds — not to be treated as final.
- **Curated pool size and rotation** — how large the target/modifier pools
  need to be before a 15-round run stops feeling repeat-y on replay, and
  whether the modifier pool should be weighted (Dead Calm more common than
  Sudden Death, say) rather than drawn uniformly.
- **Ghost Leg / Audience going from flavor-only to camera-verified** once
  `docs/camera-scoring-roadmap.md` exists — noted here as a natural future
  tie-in, not a v1 dependency.
- **Solo vs. H2H tie-breaking** — if two H2H players land the same total
  CP on the identical sequence, is that a genuine tie, or does a secondary
  metric (fewest misses, best single-round CP) break it? Not decided here.

## Implementation notes

Everything in this doc is now built, across two items — the core game (item 28)
and the self-declare honesty mechanic (item 32, see below). See `REFERENCE.md`
§34 for the full technical account (data model, consistency guard, formulas,
badges, the honesty mechanic, testing) and `docs/open-roadmap-items.md` for both
Done-ledger entries. This section closes out every "Open question" above and
records the judgment calls this build made where a number or a design decision
was left open.

### What shipped

The full core loop: `generatePressureCard(gameId, roundIndex)` (a pure
function of the real `games.id` and the round number, never stored), both
grading paths (sector/ring via a new `gradePressureSectorRound()`; finish
targets reusing `evaluateVisit()` completely unmodified, always double-out),
all 8 modifiers — including the 3 that need real engine changes, built in
full rather than deferred: **Match Dart** (only the round's 3rd dart counts,
and a finish checkout landing on dart 1 or 2 does not count), **Sudden
Death** (a genuine per-dart early stop, `evaluateDartPressureSector()`,
reusing the Doubles Practice per-dart live-feedback pattern), and **No
Warmup** (a real 5-second `Date.now()`-based wall-clock deadline, the
Checkout Blitz precedent). The Composure Points formula, the Composure
Rating table, the SEC-25-style consistency guard, saved games, stat bubbles,
Personal Bests, a Home leaderboard, the achievement ladders plus 4 one-off
flavor badges, and both the live scoreboard (`frontend/index.html`) and its
`/display` mirror are all built and tested — see "Testing" below.

**H2H** (2-4 players sharing one `game.id`) works exactly as the doc
predicted — it fell out for free once the core loop worked, needing no
special engine work beyond normal multi-player game-literal handling.

### The self-declare honesty mechanic (item 32 — shipped)

**Build-order step 10 — `declared_hit` + Honesty% — shipped as its own
separate, independently-tracked v2 item** (mirroring exactly how Halve-It's own
custom target editor was split out and then finished). A nullable
`turns.declared_hit` column (`1`=declared hit, `0`=declared miss, `NULL`
otherwise) stores the player's before-the-throw call; a declare screen sits
ahead of the dart pad (`renderPadPressureChamber()` shows two declare buttons
and hides the number pad / multi-row until a call is made, and No Warmup's clock
only arms once the call is committed); and an informational **Honesty %** stat
bubble (`getPressureChamberStatBubbles`' `honestyPct`) compares each declaration
against the round's real outcome (declared hit honest iff `checkout=1`, declared
miss honest iff `bust=1`). Exactly as this doc's own "Open questions" section
anticipated, the mechanic is the one part of the design that can never be made
tamper-resistant by a single atomic write (a determined client can submit a
declaration matching the outcome in hindsight) — so it ships deliberately as a
**best-effort, honor-system self-discipline signal**: never a scoring input,
never leaderboard weight, and with **no consistency guard** (the server
validates only the `0`/`1` shape and the pressure-chamber game-type gate). See
`REFERENCE.md` §34 and `backend/test/db.pressure-chamber-stats.test.js`.

### Answers to every other open question

- **Does Honesty % feed the Composure Rating at all?** No — it shipped
  **informational only**, exactly this doc's own default. Honesty% is presented
  as its own stat bubble and never folded into the CP total or the Composure
  Rating (the pitch always framed the declare-before-verifying rule as a
  self-discipline tool, not a scoring mechanic). The "Rattled floor for chronic
  dishonesty" alternative remains an untried playtest idea, not built.
- **Comeback's persistent-deficit version** — not built. This build ships
  only the doc's own v1 (a fixed per-round swing: a full hit adds a flat
  bonus, a miss doubles the penalty). A real cross-round deficit counter
  would need genuine state beyond `(gameId, roundIndex)`, which this whole
  design deliberately avoids — worth trying only once the simpler version has
  been played, exactly as the doc originally suggested.
- **Exact CP values** — a specific, internally-consistent first pass was
  chosen and is documented in both `frontend/scoring.js` (inline comments on
  `PRESSURE_BASE_CP`/`PRESSURE_MISS_PENALTY_BASE`/`PRESSURE_MODIFIERS`) and
  `REFERENCE.md` §34: base CP 5/10/15/20 for single/double/treble/bull, a
  finish target's base scaling with `checkoutHint()`'s own optimal dart count
  (15/20/25 for a 1/2/3-dart finish), miss penalties roughly a third of the
  matching base CP, and modifier multipliers from Dead Calm's 1.0 up through
  Sudden Death's 1.5 — the FORMULA'S SHAPE (base × modifier, half on partial,
  doubled miss penalty under Double Down/Comeback) is what's tested and
  guaranteed stable; these specific constants remain a playtesting starting
  point, exactly as this doc always framed them.
- **Curated pool size and rotation** — 14 target-pool entries (11 sector/ring,
  3 finish) and all 8 modifiers, drawn uniformly (no weighting toward Dead
  Calm over Sudden Death). Large enough that a 15-round run rarely repeats a
  target twice in practice; not weighted, since the doc itself only floated
  weighting as a "worth trying" idea, not a requirement.
- **Ghost Leg / Audience going camera-verified** — untouched, exactly as this
  doc anticipated; still gated on `docs/camera-scoring-roadmap.md` existing
  at all.
- **Solo vs. H2H tie-breaking** — decided and built:
  `pressureChamberDecideWinnerIndex()` (`frontend/scoring.js`) breaks a CP tie
  on fewest total misses, a further tie on fewest darts thrown, and a
  genuinely remaining coincidence on turn order — always returning a
  definite winner rather than introducing a distinct "draw" result/UI class
  this app has for no other game type. Real numeric CP totals make an exact
  3-way tie vanishingly unlikely in practice, which is why this was chosen
  over building draw-handling machinery for an edge case this unlikely.

### Testing

Every new calculation has a committed test, per `CLAUDE.md`'s standing
discipline: `generatePressureCard()`'s determinism, both grading paths (full/
partial/miss, Match Dart, Sudden Death's early stop), the CP formula (full/
partial/miss/Double-Down/Comeback/finish/Match-Dart-on-a-finish cases), the
Composure Rating thresholds, the tie-break chain, `evaluateVisitPressureChamber()`'s
round/match-completion timing, and `rebuildPressureChamberState()`'s replay —
all in `backend/test/scoring.test.js`. Stat/Personal-Bests/leaderboard
formulas and an X01/Cricket/Baseball/Shanghai/Halve-It/Pressure Chamber
cross-contamination regression are in `backend/test/db.pressure-chamber-stats.test.js`.
The SEC-25-style consistency guard's accept/reject cases are in
`backend/test/db.turn-consistency-guard.test.js`. `backend/test/display.ach-labels-parity.test.js`
was extended to cover the 4 new one-off badges and 3 new ladders. Verified
end-to-end with Playwright: practice and H2H New Game setup, a full 15-round
solo run to a Composure Rating, Sudden Death's early stop, Match Dart
grading, badges/stat bubbles/personal bests/leaderboards via the live API,
and the `/display` scorecard.
