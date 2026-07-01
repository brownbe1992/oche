# Daily/Weekly Challenge — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

A recurring, Wordle-style solo challenge — e.g. "finish 121 in the fewest darts
possible today" — that gives a player a reason to open the app and throw a few darts
even when nobody else is around to play H2H with. Purely local, no infrastructure,
built entirely on the existing Practice-mode engine.

## Design

- **Challenge definition**: a specific starting score/checkout target, generated on a
  schedule (daily is the more Wordle-like cadence; weekly is a gentler commitment —
  worth deciding based on how often the target audience actually plays). Could be as
  simple as a deterministic pick from a curated list of interesting checkouts (121,
  170, etc.) seeded by the date, so everyone attempting "today's challenge" on the
  same day gets the same target — no server-side randomness or state needed, just a
  pure function of the date.
- **Attempt flow**: a "Today's Challenge" entry point on the Home page, launching a
  constrained Practice-mode session (starting score fixed to the challenge target,
  single leg) using the existing scoring engine unmodified.
- **Result tracking**: darts-to-finish (or "did not finish" if busted out / gave up)
  recorded against the challenge date, similar in shape to how Personal Bests already
  tracks "fewest darts to finish" — could reuse that computation, scoped to the
  challenge's specific target score rather than any finish.
- **Streak tracking**: consecutive days/weeks attempted, mirroring the "win streak"
  concept from the achievements-badges roadmap — these two features share a lot of
  underlying mechanics (attempt logging, streak computation) and could reasonably be
  built by the same effort.

## Open questions for whoever picks this up

- Should the challenge target be a fixed curated list cycling deterministically, or
  algorithmically generated (e.g. always a checkout that's achievable but non-trivial
  — no free 2s or 4s, no impossible-in-3-darts scores)?
- Does this need to work for Cricket/Baseball once those exist (per the game-modes
  roadmap), or is it X01-specific by nature given "fewest darts to finish a score" is
  an X01 concept that doesn't map cleanly onto marks-based or innings-based games?
