# League / Season Mode — Design Roadmap

> Status (2026-07): **Fully built and playable end-to-end** — schema
> (`leagues`/`league_players`, plus a nullable `games.league_id`), auto-tagging
> (an `onGameCreated` hook, no extra step in New Game for the common case; a
> small "log to which league?" picker only when a game genuinely qualifies for
> more than one active league at once), live standings computation (no
> maintained tally — see "resolved open questions" below), season lifecycle
> (active/ended, reversible), a Leagues nav tab (list/setup/detail screens), a
> Home page teaser, and a Player Profile "Leagues" stat block. Full detail:
> `REFERENCE.md` §18. This doc's own design below is kept as-written for
> context; where the shipped implementation resolved something differently
> than the original sketch, that's called out explicitly rather than silently
> edited away.

### Resolved open questions (were listed below as open; now decided and shipped)

- **Points system**: simple, admin-configurable `points_win`/`points_loss` per
  league (default 1/0) — no margin-of-victory or legs-won bonus texture.
  Simpler was chosen over "more texture," per this doc's own lean.
- **Multi-league enrollment**: **allowed** — a player can be enrolled in
  several concurrent active leagues. Any single game they play still only ever
  tags into **one** of them (resolved via the picker when genuinely
  ambiguous), so `games.league_id` stays a single nullable FK rather than
  needing a many-to-many game↔league link.
- **Per-league match format**: a league only constrains **category** (X01
  starting score) — legs/sets are NOT fixed by the league the way a
  tournament round fixes them. Every match is exactly the casual, unstructured
  match this doc's own "How this differs from tournament mode" section
  describes; whatever legs/sets the two players choose in New Game is what
  they play.
- **Standings storage**: shipped as a **live computation** over
  `games`/`game_players` (`getLeagueStandings()`), not the `league_players`
  denormalized tally the Design section below originally sketched — this
  doc's own text already flagged that as the preferred alternative ("this
  could equally be a live query over tagged games rather than a maintained
  tally column, avoiding drift"), and that's the path taken. `league_players`
  ended up holding only enrollment (`league_id, player_id, joined_at`), no
  tally columns at all.
- **Game-type scope**: **X01 only for v1** (the same four starting scores
  tournament mode uses). Cricket already has full H2H parity and the
  standings math is game-type-agnostic, so a Cricket-league extension is a
  clean, separately-scoped follow-up rather than a fundamental blocker — just
  not built now. Doubles Practice and Just Chuckin' It are excluded
  regardless, being solo/no-winner formats.

> **Related (2026-07)**: `docs/companion-website-roadmap.md` proposes cross-instance
> leagues run through a project-operated site, reusing this doc's standings logic —
> but everything below is scoped to one instance's own local `players` roster;
> extending the participant model to include matched/remote players is that other
> doc's job, not a change needed here yet.

## Goal

A lighter-weight, complementary alternative to the tournament-mode roadmap: instead of
a knockout bracket completed in one sitting, a **season** — a defined time period (a
week, a month, an ongoing "league night" series) over which regular casual matches
accumulate into a standings table, closer to how an actual pub darts league runs than
a single-elimination tournament.

## How this differs from tournament mode

Tournament mode (see `docs/tournament-mode-roadmap.md`) is bracket-structured: matches
are pre-determined by the bracket shape, and losing (in single-elim) ends your
participation. A league is unstructured by comparison: any two enrolled players can
play any casual H2H match at any time during the season, and every result — not just
bracket-scheduled ones — counts toward a cumulative standings table. These are
genuinely different formats worth keeping as separate features rather than trying to
unify them into one system.

## Design

- **`leagues`** table: `id, name, category, starts_at, ends_at, status, points_win,
  points_loss` (or a more elaborate points scheme if wanted — see open questions).
- **`league_players`** table: `league_id, player_id, points, played, won, lost` (a
  denormalized running tally, recomputed or incrementally updated as league-tagged
  games complete — consistent with the rest of the app's "compute from raw data"
  philosophy, this could equally be a live query over tagged games rather than a
  maintained tally column, avoiding drift).
- **Tagging a game as part of a league**: the simplest approach is a nullable
  `games.league_id` column — any normal H2H game started while a league is active
  (and both players are enrolled in it) gets tagged automatically, requiring no extra
  step from the players beyond picking their opponent as usual. This keeps league play
  indistinguishable from a regular casual match in terms of user effort.
- **Standings view**: a new screen (or a Home-page section) showing the current
  season's table — rank, player, played/won/lost, points, similar in visual style to
  the existing "Most Wins" leaderboard already on the Home page, just scoped to a
  specific league's tagged games rather than all-time H2H.
- **Season lifecycle**: a season has a start and end date; standings freeze once it
  ends, and a "past seasons" archive lets you look back at who won a given month
  without needing to keep manually filtering by date range.

## Accessibility, security, and testing considerations

Addressed as shipped (2026-07), per `CLAUDE.md`'s standing conventions:

- **Testing**: `backend/test/league.test.js` covers creation/validation,
  enrollment (including multi-league), the auto-tag hook's every eligibility
  case (0/1/>1 candidates, explicit valid/stale leagueId, every non-eligible
  game shape), standings computation (points formula, decided-vs-abandoned
  games, zero-played roster rows, sort order/tiebreak), season status
  transitions, and the `wipeAllData()`/`resetStats()` standing-rule
  interactions — a committed, re-runnable suite, not a one-off manual check.
- **Accessibility**: the standings view is a real `<table>` with
  `<caption class="sr-only">` and `<th scope="col">` headers (needs no
  separate linearized fallback, unlike the tournament bracket's spatial
  layout) — see `REFERENCE.md` §18. Status badges (Active/Ended) are icon +
  text together, never color alone.
- **Security**: no new credential/token surface — reuses the existing
  `requireWrite` admin-auth model on every write route; every input
  (name/category/dates/points) is bounded and validated at the write boundary
  the same way every other write in this app is.

## Resolved (see the status header at the top of this doc for the shipped shape)

- **Points system**: simple win=1/loss=0, admin-configurable per league —
  simpler was chosen, per this section's own original lean.
- **Multi-league enrollment**: allowed.
- **Per-match format**: a league only constrains category (X01 starting
  score); legs/sets are whatever each match's players choose, matching this
  doc's own "unstructured, casual" framing of the feature.
