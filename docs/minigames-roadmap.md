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

**Who this is for, in the owner's own words: people who haven't learned the
doubles and trebles of the higher numbers.** Not a fluency polish for someone who
already knows them — a way to acquire them in the first place. That framing
decides several things below, so it is stated first rather than left implied.

Two skills, and they are a **progression**, not two difficulties of one thing:

1. **Know the segment values cold** — "treble 19 is 57," *off the top of your
   head*. Not 19 × 3 worked out in a second and a half. The target state is
   recognition, the way you recognise a word rather than spelling it out.
2. **Then total a visit at a glance** — look at three darts in the board and have
   the number, in a split second, without walking through them one at a time.

Skill 2 is built on skill 1: you cannot add T17 + 13 + D19 quickly while you are
still computing what T17 *is*. So the modes are sequential, and the app should
treat them that way — the segment mode is where a beginner starts, and the
counting mode is what it is for.

### Speed is the metric, not just correctness

This is the most important consequence of the clarification, and it inverts what
an obvious implementation would measure.

**A right answer that took four seconds is a failure of this mode's actual goal.**
The player computed it; they did not know it. Correctness alone cannot tell those
apart, and a mode reporting "94% correct" to someone who is multiplying by three
every single time would be telling them they had learned something they hadn't.

So the design carries an explicit **instant threshold** — a per-answer distinction
between *known* and *worked out*:

- **Known**: correct, and answered inside the threshold.
- **Worked out**: correct, but slower.
- **Wrong**: incorrect, or not answered at all.

The threshold needs choosing with a real number (start around **1.5 s** for a
single segment, more for a 3-dart total, and make it a named constant so it can be
tuned rather than hunted for). The headline statistic is then "**segments you know
cold**" — how many of the pool you answer instantly and reliably — not a raw
percentage. See Stats.

Answers are **multiple choice, four options**, not a number pad, and for this goal
that is the right shape rather than merely a convenient one: typing 57 measures
your thumbs, and a recall drill wants the gap between seeing "T19" and knowing
"57" measured as directly as possible. Four options also make the sub-second
answer physically possible, which a keypad does not. Recognition among plausible
neighbours is also the honest test — see the distractor rules, which exist so that
recognising the answer requires knowing it.

### "No dartboard" means no *physical* board

Worth being explicit, because skill 2 is literally "look at the board and do the
maths." An **on-screen board diagram is not a dartboard in the room** — the mode
stays fully playable on a train, which is the criterion at the top of this
document. The counting mode's board-style prompt (below) is a rendered SVG, and it
is the thing that makes skill 2 trainable at all rather than a text-comprehension
exercise.

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

`config.questionType`, `'segment' | 'counting'` — skill 1 and skill 2 from the
Goal, in that order.

**`segment`** — one board segment, asked as a value. Skill 1.
> **What is treble 19?**  `52` · `57` · `55` · `59`

**`counting`** — a visit of 2 or 3 darts, asked as a total. Skill 2.
> **Treble 17, 13, double 19**  `95` · `102` · `100` · `108`

Both are one tap. Both reveal the correct answer immediately after, with the
arithmetic spelled out on a wrong answer (`T17 = 51, S13 = 13, D19 = 38 → 102`),
because a trainer that only says "wrong" teaches nothing. Checkout Trainer
already sets this precedent by revealing the optimal route. On a *slow but correct*
answer the reveal should say so too — "right, but you worked it out" — since that
is the distinction the mode exists to close.

### Counting mode needs a board prompt, not only a text one

The brief for skill 2 is "**quickly look at the board** and do the maths in a split
second after throwing three darts." A text prompt reading "Treble 17, 13, double
19" does not train that. It trains adding three numbers you have already been
told — the reading has been done *for* you, and the reading is half the skill.

So `counting` carries a prompt style, `config.promptStyle`:

| | Prompt | Trains |
|---|---|---|
| `text` | "Treble 17, 13, double 19" | the arithmetic alone |
| `board` | three dart markers drawn on a dartboard diagram | **reading the board *and* the arithmetic** — the real thing |

`board` is the one that matches the request, and `text` is worth keeping as the
gentler rung: a beginner who cannot yet find T17 on a wedge should be able to
practise the addition without also hunting the board. Expect `board` to become the
default once someone has played both.

**This is cheap to build, which is the main reason to do it properly.**
`BOARD_GEOM` (`frontend/index.html`) already exposes `xy(radius, degrees)` plus the
ring radii (`trebleIn/trebleOut`, `doubleIn/doubleOut`, `bullIn/bullOut`), which is
exactly what placing a marker at a segment's centre needs — mid-ring radius, sector
centre angle. `buildDartboard()` already draws the board from that same geometry.
A static, non-interactive board with three dots on it is a small amount of new SVG
over machinery that exists and is already shared with `display.html`.

Two things to get right in the visual:

- **The markers must be unambiguous.** A dot near a ring boundary is a question
  about the renderer, not about darts. Place markers at the *centre* of the ring
  band, never near an edge, and consider a short leader line or a number on each
  dart (1, 2, 3) so the player can tell which is which when two land close
  together.
- **It must not become a colour-only puzzle.** The board's own red/green already
  encodes double/treble, and a colourblind player reading marker positions against
  a recoloured board (colourblind mode remaps `--red`/`--green`) must still be able
  to tell a treble ring from a double ring. Position does most of that work; check
  it rather than assume it.

## Difficulty

`config.difficulty`, `'easy' | 'hard'`:

| | Easy | Hard |
|---|---|---|
| `segment` | doubles and trebles of **10–20** | the same pool, plus the awkward extras — bull/outer bull, and doubles of the low odd numbers — and a **tighter instant threshold** |
| `counting` | **2 darts** | **3 darts** |

**The segment pool deliberately does not open out to all 62 segments on Hard**, and
that is a change from this doc's first draft. The clarification is that the mode
exists to learn *the higher numbers'* multiples — and singles are already known by
anyone who can read (S13 is 13), while D3 and T4 are trivial to compute. Padding
the pool with them would dilute every session with questions that need no practice,
and would make the headline "segments you know cold" statistic look better as it got
less meaningful. **The escalation for skill 1 is speed, not coverage** — which
follows directly from the goal being instant recall rather than breadth.

10–20 rather than 10–19: T20 = 60 and D20 = 40 are probably already known, but
excluding 20 from a pool the player is reading off a real board is a strange gap,
and two easy questions in the mix cost nothing.

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
6. **No arithmetic shortcut that isn't the skill.** Every treble is a multiple of
   3 and every double is even, so a treble question offering `57 · 38 · 55 · 59`
   can be solved by *anyone who knows that rule* without knowing T19 — 57 is the
   only multiple of 3. That is a genuine darts insight, but it is not the one being
   trained, and a generator that leaks it will produce a player who scores well and
   still can't call T19 at the board. So for a treble question prefer distractors
   that are themselves multiples of 3, and for a double question prefer even ones.
   The wrong-multiplier distractor (T19 → 38) is valuable enough to keep in the mix
   deliberately — just not as the *only* implausible-by-arithmetic option, which is
   what makes it a giveaway.
7. Deterministic given an injected `rng`, like `pickCheckoutTarget()` already is,
   so all of the above can be asserted rather than eyeballed.

**Per `CLAUDE.md`, this is a new calculation and ships with a committed
`node:test` in the same change.** Non-negotiable, and the interesting assertions
are rules 4, 5 and 6 — the three a human reviewer cannot check by looking, and
rule 6 is the one most likely to be absent without anyone noticing, because the
questions still *look* fine.

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
  prompt_style  TEXT    NOT NULL DEFAULT 'text',  -- 'text' | 'board' (counting only)
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
-- The segment table and "known cold" both group by prompt for one player.
CREATE INDEX IF NOT EXISTS idx_maths_rounds_prompt ON maths_trainer_rounds(player_id, prompt);
```

`player_id REFERENCES players(id) ON DELETE CASCADE` matches `turns`/`darts`/
`game_players`; it is what makes player deletion and the player-merge feature work
without a special case. **Not `player_name`** — a name-keyed table would survive a
merge as orphaned history.

**`answered_ms` is load-bearing, not telemetry.** Every "known cold" statistic, the
instant ladders and the whole known-vs-worked-out distinction are derived from it,
so it is as much a first-class field here as `correct` is. Two consequences: it must
be recorded for *every* round including wrong ones (a fast wrong answer and a slow
wrong answer are different learner behaviours), and there is deliberately **no**
stored `instant` boolean — the threshold is applied at read time. Storing a verdict
computed from a tunable constant would freeze that constant into history and make
retuning it silently rewrite the past.

`prompt` stores the canonical segment notation rather than display text, which is
what makes the segment table and the per-segment queries a `GROUP BY prompt` rather
than string-parsing English.

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

- **Segments known cold** — *the headline*, e.g. "14 of 22." A segment counts as
  known when its recent answers are correct **and inside the instant threshold**
  (define "recent" concretely — last 3 attempts, or a rolling window — and require
  a minimum sample so one lucky fast tap doesn't promote it). This is the number
  that answers "am I actually learning this?", which raw correctness cannot.
- **Still working them out** — its complement, and the more useful half for a
  learner: correct but slow. A player at "94% correct, 3 known cold" is being told
  something true and actionable that "94% correct" alone actively hides.
- **The segment table** — every segment in the pool with its correctness and median
  time, so the player can see the shape of what they know. **This is the mode's
  most valuable screen, not a nice-to-have** (see the note below on build order).
- **Median answer time** per question type — median, not mean: one interrupted
  round otherwise dominates.
- **Correctness %** — kept, but deliberately *not* the headline, for the reason
  above.
- **Rounds answered** — lifetime volume.
- **Best instant streak** — longest run of consecutive *known* (correct and inside
  the threshold) answers. Walked over the rounds in order and reset on any miss,
  exactly as Checkout Trainer's Best Optimal Streak is — not a maintained counter,
  so it cannot drift from the data.
- **Best Sprint score** — peak single 60-second run.
- **Weakest segment** — the worst segment over a minimum sample, by *time* as much
  as by correctness. This is what closes the loop and makes the mode a trainer
  rather than a scoreboard: it names the number you keep stalling on. A "drill this
  segment" deep link mirroring §19a's "Drill this checkout" is the natural next
  step, and for a learner it is arguably the whole product.

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
| **Segments Known Cold** | segments answered instantly and reliably (the headline stat) | 3 / 6 / 10 / 15 / 22 |
| Lifetime Rounds | rounds answered, right or wrong | 50 / 200 / 500 / 1,500 / 5,000 / 15,000 |
| Lifetime Instant Answers | correct **and** inside the threshold | 25 / 100 / 300 / 1,000 / 3,000 |
| Best Instant Streak | longest consecutive-instant run | 5 / 15 / 30 / 75 / 150 |
| Best Sprint Score | single best 60-second score | 10 / 20 / 30 / 45 / 60 |

**Segments Known Cold is the ladder that matters** — it is the only one that tracks
the thing the mode is for, and its top tier is "you have learned the whole pool,"
which is a real finish line rather than an arbitrary big number. The old
correctness-only ladder is deliberately replaced by the instant-answers one:
rewarding slow correct answers would reward the habit the mode is trying to remove.

One-off flagships:

- 🧠 **Off the Top of My Head** — every double and treble in the Easy pool answered
  instantly at least once. The badge that means "I have actually learned these."
- ⚡ **Flawless Minute** — a 10+-round Sprint with every answer correct.
- 👁️ **At a Glance** — 25 instant, correct 3-dart totals from the **board** prompt.
  Deliberately board-only: this is skill 2 as the owner described it, and the text
  prompt does not demonstrate it.
- 🔢 **Ton Counter** — 25 correct 3-dart counting answers where the total was 100+.
- 🎲 **No Guessing** — 50 consecutive correct answers on Hard.

Note the earlier draft's 🎓 **Full Board** (all 62 segments) is dropped: the pool no
longer opens out to 62, and a badge for answering S7 correctly would reward
nothing. "Off the Top of My Head" replaces it against the pool that matters.

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
  buildConfig: (setup) => ({ /* questionType, promptStyle, difficulty, mode, durationSec */ }),
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
- **Bound `answered_ms`, and treat it as a scored field.** Reject negatives and
  implausibly small values. It is not telemetry — it drives the instant ladders and
  the "segments known cold" headline, so a client that reports 1 ms for every answer
  earns the mode's flagship badge for nothing. This is the one field here worth
  guarding as carefully as `correct`, and it is easy to overlook precisely because
  in most apps a timing field *is* just telemetry.
- Rate limiting already applies at the server level; a fast quiz posting one row
  per tap is the highest-frequency write path in the app, so check the round write
  is a single insert and not a read-modify-write.

## Testing

`backend/test/` gets, in the same change as the code:

1. **Distractor generation** — the hard rules above, across both question types,
   both difficulties and every segment in the pool. The three that need real
   assertions rather than a glance: the plausibility band, the absence of positional
   bias, and **no arithmetic shortcut** — i.e. a treble question's options are not
   distinguishable by divisibility by 3 alone, which is the rule whose absence looks
   like nothing is wrong.
2. **Question generation** — every generated `prompt` parses back to the segments
   it names; `correct_answer` equals their true sum; easy-mode segment questions
   are all doubles/trebles of 10–20; counting questions carry the right dart count
   for their difficulty; and the Hard segment pool never contains a plain single
   (the pool-narrowing decision, asserted rather than trusted to stay).
3. **The instant threshold and "known cold"** — a seeded fixture of rounds with
   deliberately chosen `answered_ms` values either side of the threshold, asserting
   that a correct-but-slow answer counts as correct and **not** as known; that a
   segment is promoted to known only once its window qualifies; that it is demoted
   again when a slow answer enters the window; and that no stored boolean is
   involved, i.e. changing the threshold constant reclassifies existing history.
   This is the mode's core calculation and the one a reader is most likely to assume
   works.
4. **Board-prompt geometry** — for every segment in the pool, the marker position
   lands inside the intended ring band and not within a tolerance of either edge.
   A prompt that renders a treble as an ambiguous dot is a wrong question, and it is
   invisible to every other test here.
5. **Correctness/streak/median stats** — a seeded fixture with known answers,
   asserting each bubble, including that a streak resets on a wrong answer and
   that an unanswered (clock-expired) round counts as neither correct nor a
   streak-continuation.
6. **Isolation** — the assertion that matters most and the easiest to forget:
   play a full Maths Trainer session in a fixture, then assert that **every**
   pre-existing statistic is byte-identical to before it. Darts thrown, last
   played, every average, every Personal Best, every leaderboard. Written as a
   before/after snapshot rather than a list of named stats, so a statistic added
   later is covered automatically. This is the test that would have caught
   Checkout Trainer's `fewestDartsCheckout` leak.
7. **Play Again round-trip** — the new case in
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
   (`segment`, Easy) — the thinnest thing that is really playable. **Record
   `answered_ms` from this step**, even before anything reads it: it is not a
   later addition, and a session recorded without it is a session that can never
   answer the mode's central question.
4. **The segment table and "segments known cold."** Promoted from the end of this
   list, where an earlier draft had it as an optional extra. For a player who has
   not learned these numbers, "which ones do I still not know" *is* the product —
   a percentage tells them nothing they can act on. Shipping steps 1–3 without it
   would be shipping a quiz, not a trainer.
5. **Counting mode: `text` prompt, then the `board` prompt.** Two rungs, in that
   order. The board prompt is what the brief's second skill actually asks for, so
   it is not optional, but the text prompt is the cheaper half and gets the
   arithmetic path working before any SVG is involved.
6. **Both difficulties**, including the tighter Hard threshold.
7. **The rest of the stats, Personal Bests, the Player Profile tab.** Including the
   isolation test.
8. **Sprint mode**, with the three-point hard stop and its leaderboard.
9. **Achievements** — ladders first, one-offs after.
10. **The "drill this segment" deep link** from the weakest-segment stat. Genuinely
    separable, and the one thing here that is fair to defer — track it as its own
    item rather than letting it hold up the rest.

Steps 1–9 are one shippable mode. If step 10 is deferred it becomes its own
tracker row — per `CLAUDE.md`, never a "partially completed" item.

The reordering is the clarification's doing: the first draft built the whole quiz
and treated the per-segment breakdown and the board prompt as extras. Both are
now core, because the mode is for someone learning these values rather than
someone testing values they already have.

## Open questions

1. ~~**Are question type and difficulty independent, or one dial?**~~ **Resolved by
   the owner's clarification (2026-07): independent, because the two question types
   are a *progression of two skills*, not two difficulties of one.** You cannot
   total a visit quickly while still computing what T17 is, so segment mode is where
   a beginner starts and counting mode is what it is for — and each needs its own
   difficulty dial. The clarification also narrowed the Hard segment pool (speed,
   not more segments) and added the board prompt; see those sections.
2. **What exactly is the instant threshold, and does it differ per question type?**
   The design says ~1.5 s for a single segment and more for a 3-dart total, as a
   named constant. It wants a real number from someone who has played it — it is
   the dial the whole "known cold" statistic hangs off, and too tight makes the
   mode feel punitive while too loose makes it congratulate you for arithmetic.
   Worth revisiting after step 4 with real data rather than guessing twice.
3. **Does a wrong answer in Sprint cost time, or just score nothing?** Time
   penalties punish guessing, which is the failure mode a four-option quiz invites.
4. **Should Sprint offer a "no wrong answers" variant** that ends the run on the
   first mistake? A different and arguably better test of recall, and cheap once
   the engine exists.
5. **A Pocket Card equivalent on Home?** Checkout Trainer has one — a live
   unrecorded question answerable in place. A Maths Trainer question is even better
   suited to it (one tap, no route to enter). Same "deliberately not recorded"
   rules would apply, for the same three reasons §19 gives.
6. **Naming.** "Maths Trainer" follows the brief. "Numbers", "Mental Arithmetic"
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
