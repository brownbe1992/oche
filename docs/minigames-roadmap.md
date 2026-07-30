# Minigames — Design Roadmap

> Status (2026-07): **Nothing here is built yet.**
>
> - **Part A — Maths Trainer**: designed below, requested directly by the owner.
>   Not started. Tracked as item 10 on `docs/open-roadmap-items.md`.
> - **Part B — four further trainers**: **proposals only, awaiting the owner's
>   selection.** None is approved and none should be built until one is chosen.
>   Tracked as a single decision item (11) on the tracker, not as four build
>   items, precisely so nobody reads "on the roadmap" as "agreed."
>
> The **Minigames category itself** already exists on the New Game page (shipped
> 2026-07, `REFERENCE.md` §20) and currently holds one game: Checkout Trainer.
> This doc is about filling it.

---

## What a "minigame" is here, and why the family needs a definition

Checkout Trainer established the shape without naming it
(`docs/archive/checkout-trainer-roadmap.md` for its original design,
`REFERENCE.md` §19 for what shipped). A minigame in Oche is:

1. **Playable with no dartboard and no darts.** Not "works without a board" —
   *has no physical throw at all*. You can play it on a train.
2. **A trainer for one specific skill**, gradeable against an objectively correct
   answer the app can compute.
3. **Structurally excluded from every physical statistic.** Nothing it records may
   touch an average, a heatmap, a dart count, or a leaderboard belonging to a
   game actually played at a board.
4. **Its own achievements, its own timed variant, its own lifetime correctness
   stats** — a real mode with a real record, not a toy.

Point 3 is the one with teeth, and Checkout Trainer is the cautionary tale. It
writes real `turns` and `darts` rows (a checkout attempt genuinely *is* an X01
visit from `remaining = target`, so reusing `evaluateVisit()` was right), and the
price was two exclusion constants — `NOT_HYPOTHETICAL_DARTS` and
`NOT_CHECKOUT_TRAINER` — that had to be threaded through roughly fifteen separate
queries: roster totals, `getSummary()`'s day/week darts, six stat bubbles, four
`getMetricHistory()` chart metrics, four Personal Bests, checkout routes, loadout
stats, and the practice half of the roster's average. `REFERENCE.md` §19 lists
them. Miss one and a typed-in answer quietly becomes a career statistic — which
is exactly what happened: `getPersonalBests()`'s `fewestDartsCheckout` was the
severe leak, because a 1-dart optimal answer would both win "Fewest Darts to
Finish" and drag every average toward zero (Checkout Trainer turns write
`scored=0`).

**Every minigame after Checkout Trainer should avoid that job entirely by not
writing to `turns`/`darts` at all.** See "Data model" below. This is the single
most important design decision in this document, and it gets easier to get right
the first time than the fifth.

## Build the quiz engine once

Part A is one game. Part B proposes four more, and **all five are the same
interaction**: pose a generated question, offer four options, grade the tap,
record the round, keep a streak, optionally race a clock. If the Maths Trainer is
built as a bespoke mode and then the second one is built as another bespoke mode,
the codebase acquires five ways to do one thing — the tax `CLAUDE.md` calls out
as the one a newcomer pays forever.

So: **build the Maths Trainer's loop as a shared engine from the start**, even
though only one game uses it on day one. Concretely, one module owning

- the round lifecycle (pose → await tap → grade → reveal → next),
- the four-option presentation, keyboard handling and announcements,
- the timed-sprint clock, with the hard-stop discipline (below),
- the `*_rounds` write path and the shared correctness/streak stat queries,

with each minigame supplying only three things: a **question generator**, a
**distractor generator**, and its **display strings**. That boundary is what
makes minigame #5 a day of work instead of a week, and it is also the only way
the five stay consistent for the person playing them.

This is a recommendation, not a hedge: if the owner intends to build only the
Maths Trainer and none of Part B, a bespoke implementation is fine and cheaper.
The engine is worth it at two or more.

---

# Part A — Maths Trainer

## Goal

Learn the arithmetic of darts by recall rather than by counting up each time.
Two things a scoring player does constantly:

1. **Segment values** — "treble 19 is 57." Recognised instantly by experienced
   players, worked out laboriously by everyone else.
2. **Adding a visit** — "treble 17, thirteen, double 19 — that's 102." Three
   different multipliers, summed under mild time pressure, every visit of every
   leg.

Answers are **multiple choice, four options**, not a number pad. This is a
deliberate departure from Checkout Trainer and the reason the mode exists as its
own thing: a checkout has many valid routes and typing one is the answer, whereas
"what is treble 19" has exactly one right number, and recognising it among
plausible neighbours is closer to what the skill actually is. Recognition also
makes the mode playable one-handed in ten seconds, which is the point of a
minigame.

## How this differs from Checkout Trainer (important — don't conflate)

| | Checkout Trainer | Maths Trainer |
|---|---|---|
| Question | "How do you check out 81?" | "What is treble 19?" / "Add this visit" |
| Answer shape | up to 3 darts tapped on the Pad | one of four numbers |
| Right answers | many routes, graded on dart **count** | exactly one |
| Engine reuse | `evaluateVisit()` verbatim — an attempt IS an X01 visit | none; nothing here is a visit |
| Rows written | real `turns` + `darts` | neither (see below) |
| Skill trained | route recall | arithmetic fluency |

The overlap is presentational only. Do **not** try to fold this into
`checkout_trainer` as a fourth `config.mode`: that enum already carries
`freeform | blitz | route_recall`, all three of which share one target picker and
one dart-entry path. A mode with no darts at all shares neither, and the resulting
`if (mode === 'maths')` branches would run through every function in
`frontend/js/checkout-trainer.js`.

## The two question types

`config.questionType`, `'segment' | 'counting'`.

**`segment`** — one board segment, asked as a value.
> **What is treble 19?**  `52` · `57` · `55` · `59`

**`counting`** — a visit of 2 or 3 darts, asked as a total.
> **Treble 17, 13, double 19**  `95` · `102` · `100` · `108`

Both are one tap. Both reveal the correct answer immediately after, with the
arithmetic spelled out on a wrong answer (`T17 = 51, S13 = 13, D19 = 38 → 102`),
because a trainer that only says "wrong" teaches nothing. Checkout Trainer
already sets this precedent by revealing the optimal route.

## Difficulty

`config.difficulty`, `'easy' | 'hard'`, per question type:

| | Easy | Hard |
|---|---|---|
| `segment` | doubles and trebles of **10–19** — the segments that carry real scoring | the full 62-segment alphabet: singles, doubles and trebles of 1–20, outer bull, bull |
| `counting` | **2 darts** | **3 darts** |

**This is an interpretation of the request and should be confirmed.** The brief
said "the easy mode should be doubles/trebles of 10-19, and the hard mode should
be 2-3 dart answers," which reads as difficulty and question type being the same
dial — easy *is* segment mode, hard *is* counting mode. The table above instead
treats them as independent, so a player can drill 3-dart counting without first
being forced through single segments, and can still drill hard single segments
(D3, T7, the bull) which are genuinely harder to recall than T15 and which the
coupled reading makes unreachable. If the coupled reading was meant, collapse
`questionType`/`difficulty` into one four-value enum and drop the second toggle.
See "Open questions."

Note `CHECKOUT_TRAINER_DIFFICULTY_TIERS` is the existing precedent for a
difficulty dial baked into `config` at `startGame()` and immutable for the
session. Follow it.

## The four options — distractor generation is the whole game

This is the part that decides whether the mode teaches anything, and it is the
part most likely to be done carelessly. **Options must be answerable only by
knowing the answer.** A question offering `57 · 12 · 140 · 3` is solvable by
anyone who has seen a dartboard once; the three wrong answers have to be things a
player who *doesn't* know would plausibly pick.

`mathsDistractors(question, correct, rng)` → three wrong values, drawn from real
confusions:

- **Wrong multiplier, same number.** T19 → 38 (D19), 19 (S19). The single most
  common real error.
- **Right multiplier, adjacent number.** T19 → 54 (T18), 60 (T20), 51 (T17).
  Adjacency should be **board** adjacency where it differs from numeric — 19 sits
  next to 7 and 3 on the board, and a player reading the wrong wedge is a real
  failure mode.
- **Off by the number.** 57 ± 19 → 38, 76.
- **Digit transposition.** 57 → 75. Only when the result is in range.
- **Counting mode additionally**: swap one dart's multiplier (T17+13+D19 = 102 →
  with S17: 68, with D17: 85), or drop/duplicate a dart.

Hard rules, all testable:

1. Exactly four options; the correct answer appears exactly once.
2. All four distinct.
3. Every distractor in a plausible band — `1..60` for a single segment, `1..180`
   for a visit; never negative, never above the theoretical maximum.
4. **Distractors close to the correct answer.** Bound the spread (e.g. every
   distractor within ±25% or ±20 of the correct value, whichever is wider) so no
   option is eliminable on magnitude alone.
5. **No positional bias.** The correct answer's index must be uniform over many
   rolls. A generator that puts the truth in slot 2 slightly too often is a
   generator players learn instead of learning darts — and it would never be
   noticed by hand.
6. Deterministic given an injected `rng`, like `pickCheckoutTarget()` already is,
   so all of the above can be asserted rather than eyeballed.

**Per `CLAUDE.md`, this is a new calculation and ships with a committed
`node:test` in the same change.** Non-negotiable, and the interesting assertions
are rules 4 and 5 — the ones a human reviewer cannot check by looking.

## Timed mode

`config.mode`, `'freeform' | 'sprint'`. Sprint is 60 seconds
(`config.durationSec`, stored even though single-valued — the same precedent
Checkout Blitz and `tournament_rounds` already set).

**Reuse Checkout Blitz's clock discipline exactly, including the bug it already
fixed.** The deadline is wall-clock (`Date.now() + durationSec*1000`) checked on
each render tick, never a decrementing counter, so a throttled or backgrounded
tab cannot buy time. It is a **hard stop** enforced at three independent points,
whichever notices first ending the run: the answer handler refuses a tap at or
past the deadline, the submit path discards an ungraded in-flight answer past it,
and the tick itself ends an idle run within one tick of the buzzer. Checkout
Blitz shipped without the last two and a paused player could resume and answer
arbitrarily late, still scored and still eligible for its under-the-buzzer badge
(`REFERENCE.md` §19). Do not re-earn that.

Scoring: **1 point per correct answer, 0 for wrong.** Deliberately flatter than
Blitz's 2/1/0, which exists because Checkout Trainer has a third outcome (legal
but not optimal). There is no partial credit for a multiple-choice tap. Consider
whether a wrong answer should cost time rather than points — cheaper to reason
about than negative scores, and it keeps "score" monotonic. Left open.

## Data model

**A dedicated table, and no `turns`/`darts` rows at all.**

```sql
CREATE TABLE IF NOT EXISTS maths_trainer_rounds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       INTEGER NOT NULL REFERENCES games(id)   ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  round_no      INTEGER NOT NULL,
  question_type TEXT    NOT NULL,   -- 'segment' | 'counting'
  prompt        TEXT    NOT NULL,   -- canonical, machine-readable: 'T19' or 'T17,S13,D19'
  correct_answer INTEGER NOT NULL,
  options       TEXT    NOT NULL,   -- JSON array of the four offered values, in displayed order
  chosen_answer INTEGER,            -- NULL = never answered (clock ran out)
  correct       INTEGER NOT NULL DEFAULT 0,
  answered_ms   INTEGER,            -- time from question shown to tap
  answered_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maths_rounds_game   ON maths_trainer_rounds(game_id);
CREATE INDEX IF NOT EXISTS idx_maths_rounds_player ON maths_trainer_rounds(player_id);
```

`player_id REFERENCES players(id) ON DELETE CASCADE` matches `turns`/`darts`/
`game_players`; it is what makes player deletion and the player-merge feature work
without a special case. **Not `player_name`** — a name-keyed table would survive a
merge as orphaned history.

A `games` row is still written (`game_type='maths_trainer'`) so the mode has a
session, a `config`, a `completed_at` and a place on the Player Profile.

### Why not `turns`

Three independent reasons, in increasing order of importance:

1. **It doesn't fit.** A round has no darts, no `scored`, no bust, no checkout.
   Storing it in `turns` means overloading columns again — and `turns` is already
   the most overloaded table in the schema. `checkout` alone means "checked out"
   for three game types and "this was a legal attempt" for two others, which is
   exactly what produced `docs/bug-roadmap.md` BUG-27 and needed a
   `checkoutIsAttempt` registry flag to document. `bust` means "this dart ended
   the round" for Doubles Practice and "this dart completed the clock" for Around
   the Clock. Adding a sixth meaning is how that table got this way.
2. **`addTurn()` would need loosening.** A zero-dart turn is currently rejected
   outright except for a Checkout Trainer trick-question declaration, and that
   guard is a real one — it is what stops a client inventing turns with no
   evidence. Making every Maths Trainer round a zero-dart turn means widening the
   one guard protecting that invariant.
3. **It buys the exclusion problem.** This is the decisive one. Every
   `turns`-based statistic in the app would need a third exclusion constant
   threaded through it, and the requirement is absolute — the brief says these
   stats must not count toward anything else, "obviously." **A mode that writes no
   `turns` and no `darts` satisfies that by construction, in every query that
   exists today and every query written later.** No constant to remember, no
   fifteenth site to miss. The `NOT_CHECKOUT_TRAINER` exercise is not repeated,
   and cannot be forgotten.

One consequence to accept knowingly: the mode gets **no** free plumbing from the
`turns` ecosystem — not the shared stat helpers, not `getMetricHistory()`, not
resume-by-replay. Every statistic below is a purpose-written query. That is the
right trade for a mode whose "turn" is a tap, and it is the same trade a fifth
minigame will want.

Also: **no live scoreboard.** `pushLive()` already no-ops for `checkout_trainer`
and The Gauntlet; `maths_trainer` joins that skip list via `noLiveDisplay: true`.
Nothing about a quiz belongs on a TV across the room.

## Stats and Personal Bests

`getMathsTrainerStatBubbles()` / `getMathsTrainerPersonalBests()`, purpose-written
over `maths_trainer_rounds`, scoped per question type where it matters (segment
and counting correctness are different skills and averaging them together hides
both):

- **Correctness %** — correct ÷ answered, the headline.
- **Rounds answered** — lifetime volume.
- **Median answer time** — median, not mean: one interrupted round otherwise
  dominates. Reported per question type.
- **Best correct streak** — longest-ever consecutive-correct run, computed by
  walking rounds in order and resetting on any wrong answer, exactly as Checkout
  Trainer's Best Optimal Streak is (not a maintained counter, so it can never
  drift from the data).
- **Best Sprint score** — peak single 60-second run.
- **Weakest segment** — the segment with the worst correctness over a minimum
  sample (say 5 attempts). This is the one stat that closes the loop and makes the
  mode a trainer rather than a scoreboard: it tells the player *which* number they
  keep getting wrong. Consider a "drill this segment" deep link from it, mirroring
  §19a's "Drill this checkout" — same pattern, same value.

Leaderboard: `getMathsSprintLeaderboard()`, one row per player, best-ever Sprint
score, sorted desc — the peak-single-run shape (no minimum-attempts floor), like
`getCheckoutBlitzLeaderboard()`. Registered in the Home page's leaderboard
registry so it arrives covered by the `home-leaderboards` browser check, which is
driven off that registry rather than a hand-kept list.

Every one of these is a calculation and ships with tests in the same change.

## Achievements

Data-driven off milestone ladders reusing `checkChuckinMilestoneTier()` — the
engine is fully generic despite its name, and Checkout Trainer, Route Recall and
Chuckin all already reuse it. All once-earned, permanent, non-revocable
(`INSERT OR IGNORE`).

| Ladder | Metric | Tiers |
|---|---|---|
| Lifetime Rounds | rounds answered, right or wrong | 50 / 200 / 500 / 1,500 / 5,000 / 15,000 |
| Lifetime Correct | correct answers | 25 / 100 / 300 / 1,000 / 3,000 / 10,000 |
| Best Correct Streak | longest consecutive-correct run | 5 / 15 / 30 / 75 / 150 |
| Best Sprint Score | single best 60-second score | 10 / 20 / 30 / 45 / 60 |

One-off flagships:

- 🧠 **Instant Recall** — a correct answer in under one second.
- 🎓 **Full Board** — every one of the 62 segments answered correctly at least
  once (lifetime, segment mode).
- ⚡ **Flawless Minute** — a 10+-round Sprint with every answer correct.
- 🔢 **Ton Counter** — 25 correct 3-dart counting answers where the total was 100+.
- 🎲 **No Guessing** — 50 consecutive correct answers on Hard.

## Registry members

`maths_trainer` joins `KNOWN_GAME_TYPES` (`backend/db.js`) and `GAME_TYPES`
(`frontend/index.html`). `buildConfig` is required of every type and throws when
absent; `restoreSetup` is its inverse and is what Play Again reads — both Doubles
Practice and Checkout Trainer were silently missed there once, which is why
`backend/test/frontend.play-again-roundtrip.test.js` drives setup → config →
setup for every type. **A new type must add a case there in the same change.**

Expected shape:

```js
maths_trainer: {
  label: 'Maths Trainer',
  soloOnly: true,
  noCompletionStats: true,      // own results screen, like Checkout Trainer's
  noLiveDisplay: true,
  paperTheme: true,             // see below
  practiceUnit: { legsPerSet: 1, setsPerGame: 1 },
  category: (setup, config) => config.mode === 'sprint'
    ? 'Maths Sprint' : `Maths Trainer (${config.questionType})`,
  buildConfig: (setup) => ({ /* questionType, difficulty, mode, durationSec */ }),
  restoreSetup: (config) => { /* inverse */ },
  // NO evaluateVisit / throwDart / newMatchPlayer of the X01 shape —
  // nothing here is a visit. The engine owns the round lifecycle instead.
}
```

`padOnly` is **not** the right flag. It means "this mode scores on the Pad, not
the dartboard" — but this mode uses neither. It needs a genuinely new input
surface (four buttons), so expect a new registry member along the lines of
`inputSurface: 'quiz'` rather than a boolean bolted onto the Pad/board binary.
Whoever builds this should check whether `boardInputActive()` and
`renderGameShell()` assume every mode has one of the two existing surfaces; if
they do, that assumption is the first thing to generalise.

`paperTheme` **is** reusable as-is, and this was anticipated: its own comment in
the registry says it is deliberately a separate member from `padOnly` because
"'this mode can't use the dartboard' and 'this mode looks like paper' are
different claims, and a future no-board mode might well want one without the
other." This is that mode. The cream checkout-card skin is the right visual
language for the whole Minigames family — it already means "no board in the
room."

## Accessibility

Per `CLAUDE.md`, designed in, not bolted on. A four-option quiz has specific
hazards:

- **The four options are buttons in a group**, reachable and operable by keyboard,
  with a visible focus ring meeting the suite's luminance check. Number keys 1–4
  as a shortcut, since this mode is played fast.
- **Correct/wrong must never be colour-only.** Green and red fills are the obvious
  design and would be the entire signal. Pair every verdict with a glyph and text
  (`✓ Correct` / `✗ 57`), which also survives colourblind mode.
- **Announce each verdict through `#sr-announcer`** (`aria-live="polite"`), and the
  new question after it. A screen-reader user otherwise gets silence where the
  whole game is.
- **The Sprint clock must be perceivable non-visually** — announce at 30s/10s/5s
  rather than only shrinking a bar. Also consider whether Sprint should be
  offerable at all to a player who cannot read the options at speed; Freeform
  being the default and fully untimed is what keeps the mode usable either way.
- **Do not rely on tap position** — options shuffle every round by design (rule 5
  above), so muscle memory is not a substitute for reading.

## Security surface

Small but real, and the brief's "shouldn't count toward other stats" is partly a
security property once a client can post rounds.

- **Validate `config` at creation.** `createGame()` already rejects malformed
  config for Cricket, Shanghai, Halve-It, Killer and Checkout Trainer's pin
  rather than storing it verbatim — because a client-supplied `rounds: 9999` or a
  21-number Cricket set produced permanent, unremovable leaderboard entries.
  `questionType`, `difficulty` and `mode` are closed sets; `durationSec` is
  fixed. Reject anything else with a tagged 400.
- **Re-derive correctness server-side.** Unlike a checkout route, a Maths Trainer
  answer is trivially verifiable from the prompt: the server can recompute
  `correct_answer` from `prompt` and reject a submitted round whose `correct` flag
  disagrees. Do it. This is the same reasoning as SEC-22's scored-vs-darts
  consistency guard, at a fraction of the cost, and without it the Sprint
  leaderboard is a number the client is trusted to invent.
- **Bound `answered_ms`** and reject negatives — it feeds "Instant Recall" and a
  median.
- Rate limiting already applies at the server level; a fast quiz posting one row
  per tap is the highest-frequency write path in the app, so check the round write
  is a single insert and not a read-modify-write.

## Testing

`backend/test/` gets, in the same change as the code:

1. **Distractor generation** — the four hard rules above, especially the
   plausibility band and the absence of positional bias, across both question
   types, both difficulties, and every segment.
2. **Question generation** — every generated `prompt` parses back to the segments
   it names; `correct_answer` equals their true sum; easy-mode segment questions
   are all doubles/trebles of 10–19; counting questions carry the right dart count
   for their difficulty.
3. **Correctness/streak/median stats** — a seeded fixture with known answers,
   asserting each bubble, including that a streak resets on a wrong answer and
   that an unanswered (clock-expired) round counts as neither correct nor a
   streak-continuation.
4. **Isolation** — the assertion that matters most and the easiest to forget:
   play a full Maths Trainer session in a fixture, then assert that **every**
   pre-existing statistic is byte-identical to before it. Darts thrown, last
   played, every average, every Personal Best, every leaderboard. Written as a
   before/after snapshot rather than a list of named stats, so a statistic added
   later is covered automatically. This is the test that would have caught
   Checkout Trainer's `fewestDartsCheckout` leak.
5. **Play Again round-trip** — the new case in
   `frontend.play-again-roundtrip.test.js`, with deliberately non-default choices.

Browser side (`.claude/skills/verify-ui`): a new check driving a real session —
options are keyboard-operable, a verdict is announced, the Sprint clock hard-stops
at zero, and the results screen renders. Remember the suite's assertion count in
`run.js` must be raised in the same commit.

## Suggested build order

1. **Question + distractor generation in `frontend/scoring.js`**, with its tests.
   Pure functions, no UI, no schema — everything else depends on them and nothing
   depends on anything else. Verifiable in isolation.
2. **Schema + write path** (`maths_trainer_rounds`, the insert, the server-side
   re-derivation guard).
3. **The quiz engine and Freeform mode** end to end, one question type only
   (`segment`, Easy) — the thinnest thing that is really playable.
4. **The second question type and both difficulties.**
5. **Stats, Personal Bests, the Player Profile tab.** Including the isolation test.
6. **Sprint mode**, with the three-point hard stop and its leaderboard.
7. **Achievements** — ladders first, one-offs after.
8. **The "weakest segment" stat and its drill deep link**, if wanted. Genuinely
   separable; a good candidate to defer and track as its own item rather than
   letting it hold up the rest.

Steps 1–7 are one shippable mode. If step 8 is deferred it becomes its own
tracker row — per `CLAUDE.md`, never a "partially completed" item.

## Open questions

1. **Are question type and difficulty independent, or one dial?** The design above
   treats them as independent and says why; the brief reads as coupled. This
   changes the New Game options block and the `config` shape, so it is worth
   answering before step 3. *(Answering "coupled" makes the mode simpler.)*
2. **Does a wrong answer in Sprint cost time, or just score nothing?** Time
   penalties punish guessing, which is the failure mode a four-option quiz invites.
3. **Should Sprint offer a "no wrong answers" variant** that ends the run on the
   first mistake? A different and arguably better test of recall, and cheap once
   the engine exists.
4. **A Pocket Card equivalent on Home?** Checkout Trainer has one — a live
   unrecorded question answerable in place. A Maths Trainer question is even better
   suited to it (one tap, no route to enter). Same "deliberately not recorded"
   rules would apply, for the same three reasons §19 gives.
5. **Naming.** "Maths Trainer" follows the brief. "Numbers", "Mental Arithmetic"
   and "Counting" were the alternatives; the row's teaser matters more than the
   name for a category the player is scanning.

---

# Part B — four further minigames, proposed

**Status: proposals awaiting the owner's selection. None is approved.**

All four meet the four criteria at the top of this document: no board, no darts,
one trainable skill, objectively gradeable, and structurally isolated from
physical stats (same dedicated-table approach as Part A). All four are four-option
multiple choice, so all four are the shared engine plus a question generator — the
argument for building that engine once.

They are ordered by what they train, not by preference. Rough effort assumes the
engine exists.

## B1 — Bust or Safe *(risk judgment)*

> **You're on 46. You throw T15, S1.** → `Finished` · `Bust` · `Left 0, not a
> finish` · `Left 40`

Given a remaining score and a played sequence of darts, say what happened.
Trains the thing that actually costs legs: knowing when a route is unsafe, and
knowing that reaching zero on a single is not a finish under double-out.

- **Why it's good.** Bust awareness is a real, teachable, frequently-fumbled
  skill, and the mode can be graded with **zero new logic** — `evaluateVisit()`
  already returns exactly this verdict, and it is the same function Checkout
  Trainer reuses. The question generator's only job is to produce sequences
  weighted toward the interesting cases (near-misses, single-on-zero, exactly-one
  over) rather than uniformly random ones, which would be boringly safe most of
  the time.
- **Difficulty.** Easy: 2 darts, remaining under 60. Hard: 3 darts, any remaining,
  including single-out players' own rule.
- **Honours the per-player out-mode**, which is a nice touch no other trainer
  needs: a single-out player's correct answers genuinely differ.
- **Effort: Low.** The smallest of the four and the best first candidate.

## B2 — Countdown *(running subtraction under pressure)*

> **You're on 501. You score 140.** → `361` · `371` · `359` · `461`
> …then immediately: **You're on 361. You score 85.** → …

A whole leg of subtraction, chained, each answer becoming the next question's
starting score. Trains the single most-performed mental operation in darts, *in
the sequence it is actually performed* — which is what makes it different from
Part A's per-dart values.

- **Why it's good.** Distinct skill from Part A (subtraction from a running total
  vs. segment recall), trivially objective, and the chaining is the design idea:
  an error compounds, exactly as it does on a real scoreboard, so the mode teaches
  you to notice you've gone wrong. Ending a leg with a legitimate checkout is a
  natural win condition, giving the mode a shape Part A doesn't have.
- **Distractors** are the interesting part again: off-by-ten (the classic), the
  digit-transposed difference, the *sum* instead of the difference, and
  subtracting a plausible misread of the score.
- **Difficulty.** Easy: scores from a common set (26, 41, 45, 60, 100, 140, 180),
  starting at 501. Hard: arbitrary scores, arbitrary start, and occasional
  bust-or-not decisions once under 170 — at which point it converges with B1 and
  the two should probably stay separate rather than one growing into the other.
- **Effort: Low-Medium.** The chaining needs a little state the others don't.

## B3 — Cricket Marks *(a second rule system)*

> **You have 2 marks on 20. Your opponent has 3. You throw T20.** → `20 closed,
> 0 points` · `20 closed, 20 points` · `20 closed, 60 points` · `5 marks, 0
> points`

Trains Cricket scoring, which is genuinely confusing — marks, closing,
who-can-score-on-what, and cut-throat inverting the goal.

- **Why it's good.** The app has Cricket (standard *and* cut-throat) but nothing
  that teaches its arithmetic, and Cricket's rules are the most common source of
  "wait, why did that score?" of any mode in the app. It is also the only proposal
  that trains a **rule system** rather than arithmetic, which makes it the most
  differentiated of the four.
- **Objective**, and grounded in code that already exists: the marks/points
  transition is `enterTurnCricket()`'s own logic. Care needed so the trainer and
  the real mode cannot disagree — reuse the same function rather than
  reimplementing the rule, the same discipline the Pocket Card follows by calling
  `gradeCheckoutAttempt()`.
- **Difficulty.** Easy: standard, one number, no opponent state. Hard: cut-throat,
  full board state, "who does this score go to."
- **Effort: Medium.** The question generator has to construct a plausible board
  state, which is more than a random number.

## B4 — The Leave *(setup and strategy — highest value, weakest objectivity)*

> **You're on 121 with 3 darts.** Which first dart? → `T20` · `T17` · `T15` ·
> `S20`

Trains what to leave — arguably the most valuable non-throwing skill in darts,
and the one that separates players who score well from players who win.

- **Why it's good.** Nothing in the app teaches it, and it is pure judgment rather
  than arithmetic, so it complements all three above.
- **The problem, stated plainly.** "Best" is not fully objective. On 121, T20
  leaves 61 (T-out or 25+D18), T17 leaves 70 (a clean 2-dart finish), and which is
  better depends on which double the player favours and how they score. A trainer
  that marks a defensible answer wrong teaches the app's opinion, not darts —
  and unlike every other proposal here, a wrong grading is *plausible enough that
  the player will believe it*.
- **Proposed resolution.** Grade against a **stated, visible policy** rather than
  an implied truth: "prefer leaving a 2-dart finish; among those, prefer an even
  double; among those, prefer the fewest darts." Show the policy on screen and in
  the reveal, so the mode is honest about teaching *a* system. Offer at most one
  clearly-correct option per question and reject generated questions where the
  policy's top two candidates score within a threshold of each other — i.e. only
  ask questions that have a defensible answer. That filter is the real work.
- **Alternative if that feels too opinionated**: invert it to a purely objective
  question — "which of these leaves a 2-dart finish?" — losing some of the
  judgment but none of the correctness.
- **Effort: Medium-High**, almost entirely in the question filter, and it needs an
  owner decision on the policy before it can be built. **The only one of the four
  that is blocked on a design call rather than on effort.**

## Considered and rejected

- **Reverse Route** ("these three darts checked out — from what score?"). Too
  close to Part A's counting mode, which already asks for a sum; the inversion
  adds a puzzle flavour without a distinct skill.
- **Minimum Darts** ("fewest darts to finish 141?"). Already the thing Checkout
  Trainer grades on — its Optimal % *is* this skill, measured while doing
  something more useful.
- **Caller's Ear** (the app announces a score aloud; you pick the remainder).
  Genuinely distinct — trains listening, which a scorer really does — but it
  depends on the voice work in `docs/voice-announcements-i18n-roadmap.md` and
  would be unplayable for anyone with the audio off. Worth revisiting *after* that
  doc's items land, not before.
- **Averages quiz** ("60 darts, 501 scored — what's the 3-dart average?"). Trains
  statistical literacy rather than a darts skill, and nobody computes this at the
  board.

## If only one is built

**B1 (Bust or Safe).** Lowest effort by a distance, since `evaluateVisit()`
already produces the verdict; trains a skill that costs real legs; fully
objective, so there is no grading policy to agree; and it exercises the shared
engine's one genuinely different requirement — a verdict-shaped answer rather
than a numeric one — which is exactly what you want the second consumer of a new
engine to prove.
