# "Drill This Checkout" Deep Link — Design Roadmap

> Status: **done, 2026-07.** Promoted the affordance the archived Checkout
> Trainer doc left as an open question ("practice this specific number" deep
> link) into a tracked item, and shipped it — it stitches two already-shipped
> features together for very little new surface. Full mechanics documented in
> `REFERENCE.md` §19a; see that section for the authoritative behavior.

## Goal

Wherever the app shows you a checkout worth practicing, one tap should put
you in Checkout Trainer drilling exactly that number — instead of hoping
the random target picker eventually serves it. Two natural sources today:

- a **Top Finishes** row (Player Profile / Home) — "you hit 121 once; drill
  it";
- a **Coaching Insights** checkout-route finding — the insight that already
  says a specific finish is going badly is the perfect place to offer the
  fix.

## Design

- **A pinned-target mode in Checkout Trainer**: `config.pinnedTarget`
  (1–170, finishable under the player's out-mode) — when set, every round
  serves that same target instead of calling the random picker. Repetition
  is the point: answer it, see the route, answer it again until it sticks.
  Freeform only (a Blitz run of one repeated answer is memorization
  theater, and trick questions are meaningless with a pinned known-good
  target — both toggles hide/disable when a pin is set).
- **Entry points**: a small "🎯 Drill" button on each Top Finishes row and
  on applicable Coaching Insights cards. Tapping it jumps to the New Game
  wizard with Checkout Trainer preselected and the pin applied — the same
  preselect-then-confirm pattern `raceLeg()` already uses to deep-link
  Ghost mode from a Personal Best, which is the implementation template
  (including how the preselection is consumed exactly once).
- **Setup screen**: when a pin is active, the Checkout Trainer options
  section shows "Drilling: 121 ✕" with a clear-pin control — the deep link
  must be inspectable and cancelable, not invisible state.
- **Stats/badges**: pinned rounds are ordinary Checkout Trainer rounds —
  they count toward attempts/optimal ladders and session stats unchanged.
  One deliberate exception: **Toughest Checkout Solved excludes pinned
  rounds** (`turns.target_score` alone can't tell — stamp pinned rounds
  the same way trick declarations got `declared_unsolvable`, i.e. a tiny
  additive marker, or scope by `config.pinnedTarget` via the game row,
  which needs no schema change and is the lean answer) — grinding one
  number 40 times shouldn't set a "toughest ever" record the random pool
  didn't produce. Session Endurance and Perfectionist behave normally.

## Accessibility, security, and testing considerations

- **Accessibility**: the Drill button is icon + text; the active-pin chip
  on the setup screen is announced when applied ("Checkout Trainer set to
  drill 121."); focus lands on the setup screen's Start button after the
  jump, per the wizard's existing focus-management conventions.
- **Security**: no new endpoint — the pin rides `games.config` through the
  existing `createGame()` path; validate server-side that a pinned target
  is an integer 2–170 like every other config field.
- **Testing**: committed tests for the pinned picker (always serves the
  pin; rejects/ignores an unfinishable pin per out-mode), the
  toughest-checkout exclusion scope, and the config validation; a
  Playwright pass for the deep-link jump from a real Top Finishes row.

## Resolved at build time

- **Neighborhood serving (target ±2)** was considered and explicitly dropped
  from v1, per the note above — the pin always drills the exact number
  clicked. Would need a second, additive change (a `pinnedNeighborhood`
  flag) if ever built.
- **Which Coaching Insight types carry a concrete drillable number**:
  confirmed to be `checkout_route` only (`getCoachingInsights()`,
  `backend/db.js`) — `weak_number`/`bust_parity`/`form_trend` each describe a
  pattern across many darts/legs, not a single checkout score to pin. The
  `checkout_route` insight now carries a `score` field for exactly this
  purpose; `renderCoachingInsights()` (`frontend/index.html`) only renders
  the 🎯 Drill button where `insight.score` is present.
