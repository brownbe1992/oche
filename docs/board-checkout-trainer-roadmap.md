# "The Visit" — Board Checkout Trainer, Design Roadmap

> Status (2026-07): **Proposed, owner-requested, not built.** Tracked as item 17 on
> `docs/open-roadmap-items.md`.
>
> The brief, as given: *a minigame where the player is given a checkout number (i.e.
> 97) and taps on the dartboard scoring pad how they'd check out that number. No
> hints. Feedback afterwards on whether it was a correct checkout, or whether there
> was a more optimal route. Same visual style as the other two minigames, just using
> the dartboard score pad instead. A time component, but not as fast — the timing
> should replicate a normal turn in a leg.*
>
> Filed as its own doc rather than reopening the archived
> `docs/archive/checkout-trainer-roadmap.md`, following the precedent
> `docs/archive/checkout-trainer-route-recall-roadmap.md` set: the existing
> sub-modes are complete, and this is new, separable work.

---

## Read this section first: how much of this already exists

**Most of the question this mode asks is already implemented.** Checkout Trainer's
Freeform sub-mode gives you a target, you tap out a route, and it grades the route
as optimal / legal-but-not-optimal / illegal and reveals the best line when you
fall short. `gradeCheckoutAttempt()` and `checkoutHint()` do all of that today,
server-side re-derivation included (`REFERENCE.md` §19).

So this doc is not "build a checkout trainer." It is **three specific changes to
one that exists**, and the whole value of the mode rests on them:

| | Checkout Trainer (Freeform) | This mode |
|---|---|---|
| **Input** | The number pad. Pick a multiplier, then a number. | The **dartboard**. Tap where the dart goes. |
| **Hints during entry** | Shows the running remainder after every dart — *"Leaves 41. Tap another dart."* | **Nothing.** You see the darts you tapped, and no arithmetic. |
| **Clock** | None (Freeform) or 60s across a whole run (Blitz) | **Per round**, roughly one real visit. Resets each target. |

### Why those three changes make it a different skill, and not a reskin

This is the part worth being honest about, because "the same mode with a different
button layout" would not be worth building.

- **The board tests where the numbers are.** Naming treble 19 is one skill; finding
  19 on a board — between 3 and 7, on the left — is a different one, and it is the
  one you use standing at the oche. A player who is fluent on the pad and slow on
  the board has found something real about themselves.
- **Removing the running remainder is what makes it a checkout test.** With
  *"Leaves 41"* on screen you can tap T20 and let the app tell you what's left; the
  mode becomes subtraction-with-help. Without it you have to hold the whole route
  in your head before the first dart, which is what actually happens at a board.
  **This is the single most important requirement in the brief** — the mode is
  substantially pointless without it.
- **The visit clock changes what "knowing it" means.** Blitz asks how many you can
  do in a minute, which rewards volume on easy targets. A per-round clock asks the
  narrower and more useful question: could you have done this one *in the time you
  actually get*, standing there, once.

If any of the three is dropped in build, the mode collapses back into Freeform and
should not ship as a separate thing.

---

## Decision: a fourth sub-mode, not a new game type

`games.config.mode = 'board'`, alongside `'freeform'`, `'blitz'` and
`'route_recall'` on `game_type = 'checkout_trainer'`.

**Why.** It asks the same question with the same grader, and
`checkout_trainer_rounds` already holds everything it produces: `target_score`,
`route`, `route_key`, `legal`, `optimal`, `used_darts`, `optimal_darts`. A new
game type would mean a second table holding identical columns, a second grader
call, a second registry entry, and a second set of stat queries — four copies of
things that already exist, to model a difference that is entirely about input and
pacing.

**The counter-argument, stated fairly.** The sub-modes are diverging. Route Recall
already answers a different question under the same `game_type` and needed its own
exclusion to stop it polluting Freeform's accuracy; this adds a fourth. At some
point "one game type, four modes" becomes the thing hiding the complexity rather
than containing it. The line this doc draws: a sub-mode is right while the
*question* is the same and only the *asking* differs. That holds here. It would
not hold for a fifth mode that graded something else.

### Its stats do not merge with Freeform/Blitz

Same reasoning Route Recall's isolation rests on. A board mistap — meaning to hit
19 and catching 3 — is a real and interesting failure, but it is not "did not know
the checkout," and folding it into the lifetime Accuracy % would make that number
mean two things at once. `_ctRows()` currently excludes Route Recall with
`json_extract(g.config,'$.mode') IS NOT 'route_recall'`; this mode joins that
exclusion, and gets its own reader.

**Watch for**: that predicate becomes `NOT IN ('route_recall','board')`. Write it
as a list from the start rather than chaining a second `IS NOT`, so the fifth
sub-mode is a one-word edit.

---

## The obstacle this mode has to clear: BUG-32's miss rings

Checkout Trainer is `padOnly: true` **on purpose**, and the reason is written on
the registry entry:

> The dartboard input contradicts that: it carries two full miss rings (near/far,
> per wedge, […]) sitting immediately outside the double ring — exactly where a
> thumb lands when it's aiming for the number printed at the board's edge. A mistap
> there silently records a Miss, and a Miss turns a correct route into an illegal
> one: on target 50, [Miss, D16] grades "Not a legal finish for 50. Best route:
> Bull," which is indistinguishable to the player from the app mis-grading a route
> they entered correctly.

**A mode built on the dartboard has to answer that, not ignore it.** It is the one
thing most likely to make this feel broken.

**Resolution: the miss rings are not rendered for this mode.** A proposed route can
never contain a miss — you cannot *intend* to miss — so the region that produces
one has no meaning here and should not exist. This is the same move already made on
the pad, where "Miss" and "Bounce Out" are hidden for this game type; it applies the
existing decision to the other input rather than inventing a new rule.

Concretely: a render flag on `buildDartboard()` (or a wrapper class the existing
builder reads) that omits the two outer annuli and shrinks the `viewBox` back to the
board itself. `BOARD_GEOM` already carries every radius involved, and the
pre-miss-ring `viewBox` is in the git history of
`docs/archive/dartboard-zone-tracking-roadmap.md`'s change.

**Also drop zone tracking.** The board records inner/outer single zones; for a
proposed route, "inner 20" and "outer 20" are both S20. `dartLabel()` already
ignores zone, so grading is unaffected — but the stored `route` should not carry it
either, or two identical routes will look different.

---

## What "no hints" means exactly

The brief says no hints. That needs a line drawn, because some feedback is
navigation rather than help.

**Removed:**
- The running remainder. `throwDartCheckoutTrainer()`'s *"Leaves 41. Tap another
  dart, or press Submit now."* is the hint that matters and it goes.
- *"That overshoots the target"* on a bust, and *"That's a finish!"* on a win. Both
  tell you the answer before you commit to it. In this mode you submit blind.
- Any indication of how many darts the target needs. Freeform doesn't show this
  either, but it must not creep in via a "2-dart finish" label on the target.

**Kept:**
- **The darts you have tapped, as labels.** You must be able to see your own input
  to correct a mistap. Showing that you tapped T20 is not telling you anything you
  did not just do; computing 97 − 60 for you is.
- **Undo Dart.** Same reason. A board mistap you cannot take back turns the mode
  into a test of touchscreen accuracy.
- **Everything after Submit.** The full reveal — legal, optimal, the better route
  when there is one — is the entire point of the feedback and stays exactly as
  Freeform does it.

---

## The clock

**One clock per round, not per session.** It starts when the target appears and
resets on the next one. This is the structural difference from Blitz, which runs
one 60-second clock across a whole run.

**Default: 20 seconds**, adjustable at New Game. That is a relaxed single visit —
long enough to read the number, decide, and tap three darts without racing, which
is what "replicate a normal turn in a leg" asks for. It is deliberately not tight:
the mode is not a speed drill, and a clock that regularly expires would turn it back
into one.

**When the clock expires**, whatever is on the board is submitted and graded as it
stands. That mirrors a real visit — time is up, those are your darts. A round that
expires with **nothing** entered is recorded as an unanswered round: not legal, not
optimal, and flagged so it can be told apart from a wrong answer, because "did not
know it" and "did not commit in time" are different learner behaviours and the
stats should not merge them.

**Hard stop, three enforcement points**, exactly as Blitz and the Maths Trainer
Sprint do it, and for the same reason (a backgrounded tab must not buy time): dart
entry refuses past the deadline, submit refuses past the deadline, and the render
tick ends an idle round on its own. `blitzDeadlinePassed()` is a pure predicate
already shared by all three of Blitz's checks and applies unchanged.

**Open question (owner call):** should the default be *derived* from the
household's own throwing pace rather than fixed? The app already computes darts per
minute (`getPlayerStatBubbles().pace`), so "your normal visit" could be literal
rather than a guess. Attractive, and possibly too clever — a clock that differs per
player makes the leaderboard incomparable, and a player with no timing data gets the
fixed default anyway. Recommendation: **ship the fixed default**, and revisit only
if 20s turns out to feel wrong.

---

## Schema

Two additive columns on `checkout_trainer_rounds`. Both default safely, so existing
rows and the other three sub-modes are untouched.

| Column | Type | Notes |
|---|---|---|
| `answered_ms` | `INTEGER` | Time from target shown to submit. `NULL` for the sub-modes that don't time a round. The mode's own speed stats read this; it is guarded on write the way `maths_trainer_rounds.answered_ms` is, since a client reporting 200ms for everything would otherwise own the leaderboard |
| `timed_out` | `INTEGER NOT NULL DEFAULT 0` | `1` when the clock expired with nothing entered. Distinct from `declared_unsolvable` (which is also zero-dart but is an *answer*), and distinct from an illegal route (which is a wrong answer rather than no answer) |

Nothing else is needed. `target_score`, `route`, `route_key`, `legal`, `optimal`,
`used_darts` and `optimal_darts` already mean here exactly what they mean for
Freeform.

**Server-side re-derivation is unchanged and non-negotiable.**
`addCheckoutTrainerRound()` already re-grades every submitted route with
`gradeCheckoutAttempt()`, reading the player's out-mode from their own
`game_players` row. This mode adds `answered_ms`/`timed_out` to that payload and
nothing else; the verdict still comes from the server.

---

## Stats and Personal Bests

Scoped to `config.mode = 'board'` only, per the isolation decision above.

- **Optimal %** — the headline, same as Freeform. On the board and blind, this is a
  much harder number to move, which is the point.
- **Legal %** — how often the route finished at all.
- **Beat the clock %** — rounds submitted before expiry. A player at 95% here is
  being given too long; a player at 50% is being rushed. This is the stat that tells
  the owner whether 20 seconds was the right default, so it should exist from day one.
- **Median time to submit**, over completed rounds. Median rather than mean for the
  reason the Maths Trainer documents: one round left open while somebody answered
  the door would dominate a mean.
- **Best streak** of consecutive optimal-and-in-time rounds.

**Personal Bests:** toughest checkout solved optimally *inside the clock* (excluding
declarations and pinned targets, the same two exclusions §19 already applies), and
fastest optimal solve of a 3-dart finish.

---

## Achievements

Follows the family's existing shape rather than inventing one: laddered milestones
on lifetime rounds and lifetime optimal answers, plus a small set of one-offs. Two
worth specifying because they are particular to this mode:

- **🎯 Eyes Closed** — an optimal 3-dart checkout submitted inside the clock, with
  no undo used in the round.
- **🕰️ Never Rushed** — a full session where every round was submitted before the
  clock expired.

Same convention as Chuckin's and Checkout Trainer's ladders: once-earned and
permanent (`INSERT OR IGNORE`), not undo-revocable.

---

## Visual style

`paperTheme: true` already applies to `checkout_trainer`, so the cream sheet, the
Bebas/Inter/Kalam type and the inset hairline come for free. **What does not exist
yet is a paper-styled dartboard** — `body.paper-mode` styles `.oche`, `.pad` and
`.multi`, but never the board SVG, because `padOnly` means it has never rendered in
this theme.

**Do not write a fourth board renderer.** There are already three geometry
consumers — `buildDartboard()` (interactive), `buildDartHeatmap()` (profile), and
`mathsBoardHtml()` (the Maths Trainer's printed prompt) — all on `BOARD_GEOM` and
`DB_SECTORS`. `mathsBoardHtml()` is the proof the palette works: cream washes
(`rgba(20,22,15,.22)` / `.11` alternating), `--paper-edge` rules, `--paper-soft`
numerals. The right build is a **paper skin on `buildDartboard()`** — the existing
interactive builder, with the miss rings omitted and the fills/strokes taken from
that palette — not a new one.

---

## Accessibility

Per `docs/accessibility-roadmap.md`, considered as part of the design rather than
afterwards. The board is the hard part here, because it is the first time this app
asks for *positional* input in a mode built around a clock.

- **The board must be fully keyboard-operable**, and this mode makes that a
  requirement rather than a nicety: a player who cannot use it has no way to play at
  all, where in every other mode the pad is an alternative. A number-then-ring
  entry (type 19, press T) reaching the same `throwDartBoard()` is the likely shape.
- **The clock must be announced**, not only drawn — at minimum a warning at a few
  seconds remaining, via the existing `announce()` live region.
- **Colour must not be the only signal** for the verdict. Freeform's ✅/⚠️/❌ prefixes
  already carry it in text; keep them.
- **The reveal must be readable on cream.** The Maths Trainer shipped a
  cream-on-pale contrast bug in exactly this kind of after-the-fact state; that is a
  known trap on this theme, not a hypothetical.

## Security surface

Per `docs/security-hardening-roadmap.md`. No new credential, no new token, so the
checklist is short — but two things:

- `answered_ms` is **client-supplied and leaderboard-bearing**, which is the exact
  shape `addMathsTrainerRound()` already guards: reject implausibly fast values,
  clamp implausibly slow ones. Reuse those bounds rather than picking new ones.
- The verdict stays server-derived. Adding a timed mode must not become a reason to
  start trusting a client-sent `legal`/`optimal`.

## Testing

Per `CLAUDE.md`'s standing rule, the calculations get committed tests in the same
change:

1. **The clock predicate** — expiry, the three enforcement points, and that a
   backgrounded gap cannot buy time. Pure, so `node:test`.
2. **`timed_out` vs the other zero-dart shapes** — that an expired empty round is
   told apart from a declaration and from an illegal route, in the stats and not
   only in the column.
3. **The new stat readers**, including that a `board` round moves none of Freeform's
   or Blitz's numbers — the isolation assertion, written as a before/after snapshot
   like the existing ones rather than a list of named stats.
4. **Browser**: that the miss rings are absent, that no running remainder appears
   during entry, that the reveal renders legibly on cream, and that the clock
   hard-stops. None of those is visible to `node:test`; the missing-remainder one in
   particular is a *negative* assertion and is the mode's core requirement.

---

## Suggested build order

1. **The paper skin + miss-ring suppression on `buildDartboard()`.** Highest risk
   and it gates everything; if the board cannot be made to look and behave right,
   the mode does not work.
2. **The sub-mode wiring** — `config.mode = 'board'`, the New Game option, the
   category label, and the `_ctRows()` exclusion becoming a list.
3. **Entry with hints removed**, submitting blind, reusing the existing grader.
4. **The clock**, with all three hard-stop points.
5. **The two schema columns and the write path.**
6. **Stats, Personal Bests, the Home tab.**
7. **Achievements.**
8. **Tests**, browser check, `REFERENCE.md` §19c, README, tracker.

Steps 1–3 are a playable mode. Everything after is what makes it a *recorded* one.

---

## Open questions

1. **The name.** "The Visit" is the working title and says what it is: one visit, on
   the clock. Alternatives considered: "On the Board", "Blind Checkout", "Take Your
   Visit". Owner's call, and worth making before the category label ships.
2. **Where it appears in New Game.** Precedent says a sub-mode toggle under Checkout
   Trainer, alongside Freeform / Blitz / Route Recall. The counter is that it is the
   least like the other three from the player's point of view — different input,
   different rules — and might deserve its own Minigames row. Sub-mode is the
   cheaper and more consistent answer; a separate row is the more discoverable one.
3. **Difficulty tiers.** Freeform's four (`under40`/`under100`/`over100`/`full`) apply
   unchanged and probably should. Not obviously worth its own scheme.
4. **Trick questions.** Freeform's bogey-number variant would work here, but with no
   running remainder and a clock running, calling an unsolvable target may be more
   frustrating than instructive. Recommendation: leave it off in v1.
