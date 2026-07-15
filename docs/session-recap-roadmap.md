# End-of-Night Session Recap — Design Roadmap

> Status: **design phase, not started.**

## Goal

After an evening at the board, one tap produces the night's story: games
played and who won what, the best legs and visits, badges earned, and any
personal bests set — a digest worth looking at together (or sharing to the
group chat) while everyone's still standing around. The moment-card engine
already celebrates single events as they happen; this is the same energy
zoomed out to the whole session.

## Design

- **What counts as "the session"**: everything played on the current
  **local calendar date** — the same day-boundary convention the Daily
  Challenge and `getSummary()`'s `todayDarts` already use, so no new
  session-detection heuristic (gap-based session inference was considered
  and rejected: clever, unexplainable, and wrong exactly when an evening
  straddles a long dinner break). Midnight-straddling nights are the known
  tradeoff — see Open questions.
- **Backend**: `getSessionRecap(date)` — one read-time aggregation over
  that date's games (nothing stored, per the house rule):
  - per-player: games/legs won-lost, darts thrown, best visit, best leg
    (fewest darts / best average), 180s, ton+ checkouts;
  - head-to-head results grid for the night's matchups;
  - badges earned today (`player_badges.earned_at` date-scoped) and
    personal bests that were *set tonight* (compare each nightly best
    against the pre-tonight value of the existing Personal Bests queries);
  - notable moments in chronological order (180s, high checkouts,
    match wins) — the same event classes the moment cards already fire on.
  Solo drills (Chuckin/Checkout Trainer/guided drills) appear as a light
  "also tonight" line (rounds/darts), not fully itemized — the recap's
  spine is the games people played against each other.
- **Frontend**: a "🌙 Tonight's recap" teaser on the Home page, shown only
  when today has completed games (same conditional-teaser pattern as the
  Checkout Trainer/League teasers), opening a recap screen of stat blocks
  and a moments timeline. A **📤 Share** button renders the recap through
  the existing shareable-moment card generator as a single summary card —
  one new card layout, the rest of the pipeline (render, share/copy) is
  already built.
- **History**: the recap screen takes a date (default today) with a simple
  date picker — past nights are recomputable for free since nothing is
  session-stamped; "what did we play on the 4th?" comes along at no cost.

## Accessibility, security, and testing considerations

- **Accessibility**: the recap is a real document — heading per section,
  list semantics for the moments timeline, icon + text for moment types;
  the share card inherits the moment-card generator's existing text
  contrast rules.
- **Security**: one read-only endpoint (`GET /api/session-recap?date=`),
  same public-read tier as the stats endpoints it aggregates; date param
  validated `YYYY-MM-DD` like the challenge-reset route already does.
- **Testing**: committed tests for the aggregation — a fixture night with
  two players, mixed game types, a badge earned, and a personal best set
  tonight vs one that already existed (the pre-tonight comparison is the
  easiest formula to get subtly wrong); empty-date and solo-only-night
  shapes; date-boundary scoping (a game at 23:59 vs 00:01).

## Open questions for whoever picks this up

- **Midnight-straddling sessions**: calendar-date scoping splits a
  past-midnight night in two. Acceptable for v1 (matching Daily
  Challenge's own convention); if it grates in practice, a "night =
  date with a 4 AM rollover" offset is a contained change to one scoping
  predicate — noted here so the fix lands in the right place.
- Should the recap auto-surface (a prompt when the last game of the night
  completes)? Lean: no — a teaser is enough; auto-modals after every game
  would be noise on ordinary nights.
- Whether the Home Assistant webhook should get a `session_recap` event
  (nightly summary to a wall display) — natural follow-on for the HA
  recipe book, not v1.
