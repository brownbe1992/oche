# Household Rating (Elo) & Handicapping — Design Roadmap

> Status: **design phase, not started.** Two features in one doc because
> they answer the same household problem — players of different strengths —
> from opposite ends: the rating *measures* the gap, handicapping *closes*
> it. **Independently shippable**, tracked as two separate items on
> `docs/open-roadmap-items.md`; the rating is the natural first half.

## Part A — Household Elo rating

### Goal

A single evolving number per player that answers "who's actually on top
right now?" between tournaments — more responsive than win totals (beating
the house champion moves you more than beating the newest player), and
self-correcting as form changes.

### Design

- **Live-computed, never stored** — the schema's standing "nothing
  pre-aggregated" rule fits Elo unusually well: `getEloRatings()` walks
  every completed 2-player competitive game in `created_at, id` order and
  folds the standard update (start 1000, `K=32`,
  `expected = 1/(1+10^((Rb−Ra)/400))`, winner takes `K×(1−expected)`) —
  a few thousand games is a trivial walk at household scale, and it means
  ratings retroactively heal after `deleteLastTurn`, player merges, game
  deletions, or imports, with zero migration/backfill machinery. If a
  server ever accumulates enough games for this to be slow, cache it
  in-process per request, not in the schema.
- **Scope**: completed, non-practice, **2-player** games (Elo's expected-
  score math is pairwise; 3+ player games are out, stated not silently
  skipped), all competitive game types combined into **one household
  rating** — the number is "who beats whom", not "who's best at Cricket";
  per-game-type ratings are a later option if wanted (see Open questions).
  Tournament and league-fixture games count (they're real competitive
  results); Ghost/Daily Challenge/solo drills never enter (no second real
  player).
- **Surfaces**: a Home page "📈 Household Ratings" leaderboard (rating +
  W/L, sorted desc, min ~5 rated games before appearing so a 1-game player
  isn't ranked); a rating line on the Player Profile with a
  `getMetricHistory()`-style rating-over-time chart (the walk already
  produces the full history for free); a "±N" delta flash on the match-win
  moment card.
- **Badges**: 👑 **Top of the House** (hold #1 — awarded on first reaching
  it) and 🗡️ **Upset** (beat an opponent rated 150+ above you), both
  computable inside the same walk.

## Part B — Handicapping

### Goal

Let mismatched players have a real game: the stronger player starts an X01
leg from a higher score (501 vs 401), chosen per player at setup. Nothing
about the throwing changes — just the mountain's height.

### Design

- **X01 only for v1** — starting score is X01's natural handicap lever;
  Cricket/Baseball have no equivalent single knob and inventing one is a
  different (harder) design.
- **Schema**: per-player starting score is a per-game snapshot, so it
  follows the established `game_players` snapshot pattern
  (`out_mode`/`dart_weight`/`loadout_id` precedent): a nullable
  `game_players.start_score INTEGER` — `NULL` means "the game's own
  `config.startingScore`", a value overrides it for that player. Purely
  additive column; every existing game reads unchanged.
- **Setup UI**: an optional "Handicap" disclosure in the X01 options step
  — per-player start-score pickers (steps of 50 or 100 between 101 and the
  chosen category, e.g. 301/351/401/451 under 501), collapsed and neutral
  by default so even games carry zero extra friction.
- **Engine**: `newMatchPlayer()` seeds `player.score` from the override;
  leg/set resets reuse it. `evaluateVisit()` needs nothing — it never knew
  where scores start. Live scoreboard shows the per-player start ("Ben 501
  · Alaina 401") so the handicap is visible, not mysterious.
- **Stats**: averages/darts stats are unaffected (they're per-dart);
  win-based stats count handicapped wins as wins, deliberately — the point
  of a handicap is a fair contest. **Handicapped games are excluded from
  Elo** (Part A) — a compensated result says nothing about raw strength;
  the walk skips games where any `start_score` override is set. Personal
  Bests like Best Leg (fewest darts) should also exclude shortened starts
  (a 301-start 9-darter isn't a 501 nine-darter) — the existing
  category-scoping mostly covers this; verify during implementation.
- **The pairing**: once both halves exist, the setup screen can *suggest* a
  handicap from the Elo gap ("Alaina +100 start?") — a one-line nicety,
  explicitly not v1 of either half.

## Accessibility, security, and testing considerations

- **Accessibility**: the ratings board and handicap pickers are standard
  list/select surfaces under the existing checklist; the rating delta on
  the win card needs text ("+18"), not a green/red arrow alone.
- **Security**: both read existing data / add one snapshot column; no new
  credential or endpoint class. The handicap picker's values are validated
  server-side in `createGame()` (must be ≤ category, ≥ 61, integer) so a
  hostile client can't create a 2-point-start farm for win-rate stats.
- **Testing**: Elo is a textbook every-new-calculation case — committed
  tests with hand-computed sequences (two players trading wins, an upset's
  larger swing, the min-games floor, merge/delete healing by re-walk,
  handicapped-game exclusion). Handicap tests: per-player starts seed legs
  and sets correctly, `NULL` behaves exactly as today, server-side
  validation bounds, and the SEC-22 consistency check still holds (it
  keys on visit arithmetic, not the start value — verify, don't assume).

## Open questions for whoever picks this up

- **K-factor / provisional period**: flat K=32, or higher K for a player's
  first ~10 games (faster convergence)? Lean: flat 32 for v1; household
  sample sizes are small enough that provisional logic is tuning noise.
- **Per-game-type ratings** as a toggle on the board (X01-only Elo vs
  combined)? Lean: combined only until someone actually asks.
- Handicap presets ("give Alaina 100") vs raw per-player pickers — the
  picker is v1; presets are polish.
- Should a *leg head start* (spot a player 1 leg in a first-to-3) ship as
  a second handicap lever? Deferred — starting score covers the need with
  far less match-flow surgery.
