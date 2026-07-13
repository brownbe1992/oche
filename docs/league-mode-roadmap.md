# League / Season Mode — Design Roadmap

> Status (2026-07): **Core league mode is fully built and playable
> end-to-end** — schema (`leagues`/`league_players`, plus a nullable
> `games.league_id`), auto-tagging (an `onGameCreated` hook, no extra step in
> New Game for the common case; a small "log to which league?" picker only
> when a game genuinely qualifies for more than one active league at once),
> live standings computation (no maintained tally — see "resolved open
> questions" below), season lifecycle (active/ended, reversible), a Leagues
> nav tab (list/setup/detail screens), a Home page teaser, a Player Profile
> "Leagues" stat block, and **Cricket league support** (a `leagues.game_type`
> column alongside X01, a setup-screen game-type selector, and full
> X01/Cricket cross-isolation in the auto-tag hook). Full detail:
> `REFERENCE.md` §18. This doc's own design below is kept as-written for
> context; where the shipped implementation resolved something differently
> than the original sketch, that's called out explicitly rather than silently
> edited away.
>
> **Un-archived (2026-07): a new "League fixtures / pending matches" item is
> now open** — see its own section below, added to support
> `docs/new-game-flow-roadmap.md`'s "League Game" New Game entry. This is a
> deliberate reversal of a decision this doc made and shipped against below
> ("a league only constrains category... every match is exactly the casual,
> unstructured match," no bracket-scheduled fixtures) — flagged explicitly
> here rather than silently contradicted. Everything summarized above this
> note is still fully shipped and unaffected; only the new section below is
> open.

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
- **Game-type scope**: **X01 or Cricket** — `leagues.game_type` (`'x01'` |
  `'cricket'`, default `'x01'` for every pre-Cricket league) alongside the
  original v1 `category` column. X01's `category` stays the numeric starting
  score (`'501'|'301'|'170'|'101'`); a Cricket league's `category` reuses the
  exact two-value label a Cricket H2H game is already tagged with at creation
  (`'Cricket (15-20, Bull)'` for the classic preset, `'Custom Cricket'` for
  any custom target set) rather than inventing a parallel vocabulary — this
  means every custom-numbers Cricket game shares one league category
  regardless of which specific numbers were chosen, the same "a league
  doesn't fix the exact match format" looseness an X01 league already applies
  to legs/sets. The `onGameCreated` auto-tag hook and `getEligibleLeagues()`
  both now filter on `game_type` in addition to `category`, so an X01 game
  can never tag into a Cricket league (or vice versa) even when both leagues
  enroll the same two players — verified by committed cross-isolation tests.
  Standings computation (`_computeLeagueStandings()`) needed **zero changes**
  — it was already game-type-agnostic, exactly as this doc originally
  predicted. Doubles Practice, Just Chuckin' It, and Checkout Trainer remain
  excluded, being solo/no-winner formats.

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

- **`leagues`** table: `id, name, game_type, category, starts_at, ends_at, status,
  points_win, points_loss` (or a more elaborate points scheme if wanted — see open
  questions). `game_type` (`'x01'|'cricket'`, shipped as a follow-up to the original
  v1 design — see "Game-type scope" above) determines which category vocabulary
  `category` draws from.
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

## League fixtures / pending matches (new, not started)

**Goal**: let a New Game session recognize when the two selected players have
a scheduled-but-unplayed match in a shared active league, and offer it as a
one-tap "League Game" shortcut (`docs/new-game-flow-roadmap.md`'s Step 2)
that pre-fills that league's game type/category rather than asking again.
Today a league only auto-tags a game *after* the players independently
happen to pick a matching category — there's no concept of "this pairing
still owes the league a match," which is exactly what this section adds.

- **New table, following this app's standing "own table with a `game_id` FK
  into `games`" convention** (`CLAUDE.md`, already the shape
  `tournament_matches` uses): `league_fixtures — id, league_id, player1_id,
  player2_id, game_id (nullable FK → games.id), created_at`. No stored status
  column, matching `tournament_matches`'s own "derive it, don't store it"
  precedent: a fixture is **pending** while `game_id` is null, **in
  progress** once a `games` row is linked but not yet completed, and
  **fulfilled** once that game completes — the fixture's own row never needs
  a write on game completion, only on creation.
- **Linking a fixture to a game is explicit, not inferred**: unlike the
  existing `onGameCreated` auto-tag hook (which fuzzy-matches any newly
  created H2H game against eligible leagues by category), choosing "League
  Game" in New Game means the player explicitly picked a specific fixture —
  so `setup`/`startGame()` carries a `leagueFixtureId` through to game
  creation, and the backend sets `league_fixtures.game_id` directly on that
  row. This avoids the ambiguity the existing fuzzy-match hook has to solve
  for (ties `games.league_id` to the right league automatically too, for
  free, without needing the existing 0/1/>1-candidate eligibility logic at
  all for fixture-originated games).
- **New endpoint**: a pending-fixture lookup keyed on just the player pair
  (`GET /api/leagues/pending-fixture?p1=&p2=`), callable right after Step 1
  of the New Game flow — *before* any game type is chosen, unlike the
  existing `/api/leagues/eligible` check this doc's shipped picker uses
  today (which requires `category`/`gameType` as query params, since it only
  ever ran after those were already chosen). Returns every pending fixture
  across every active league both players share (could be more than one, if
  they're enrolled in multiple leagues with each other).
- **Selecting "League Game"**: with exactly one pending fixture, auto-fills
  `setup.gameType`/`setup.start` (or the Cricket preset) from
  `leagues.game_type`/`category` and sets `setup.leagueFixtureId` — legs/sets
  still get asked in Step 3 as normal (a league still doesn't fix match
  format, per the "Resolved open questions" above, unchanged by this
  section). A Custom Cricket league still needs its 7 targets chosen in Step
  3 too, for the same reason — the league's `category` value
  (`'Custom Cricket'`) doesn't pin the exact numbers. With 2+ pending
  fixtures (the player pair shares more than one active league), selecting
  "League Game" reveals a secondary "Which league match?" dropdown, mirroring
  the X01-flavor-dropdown pattern `docs/new-game-flow-roadmap.md` already
  establishes for X01's starting score.

### Open questions for whoever picks this up

- **Fixture generation**: how do pending fixtures get created in the first
  place? The natural default is a full round-robin generated once, at league
  creation (and again for just the new pairings whenever a player joins an
  already-active league) — but this isn't decided. An admin-driven "schedule
  a match" action is the alternative, trading automation for control.
- **Double round-robin**: does each enrolled pair get exactly one fixture per
  season (single round-robin), or two (a return match, common in real pub
  leagues)? Leans toward single for v1 simplicity, not decided.
- **Unfulfilled fixtures at season end**: if a fixture is still pending when
  a league's season ends, does it just quietly stop mattering (the season
  view already freezes standings on end), or should the standings/season
  summary call out unplayed fixtures explicitly?
- **Manual fixtures**: should an admin be able to create or cancel an
  individual fixture outside the round-robin generation (e.g. to add a
  specific replay match), or is round-robin generation the only source of
  fixtures for v1?
- **Interaction with today's ambiguity picker**: today's "log to which
  league?" picker (shown when a game qualifies for 2+ leagues by category
  alone) and this section's fixture lookup are two different mechanisms that
  can both apply to the same pair of players — does a fixture-originated
  game skip the old picker entirely (since `leagueFixtureId` already pins the
  league unambiguously), confirming the existing auto-tag hook should treat
  fixture-linked games as already resolved and not re-run its own eligibility
  check on them?

## Accessibility, security, and testing considerations

Addressed as shipped (2026-07) for everything above the "League fixtures"
section; the fixtures feature itself still needs its own pass once built
(a new write path, a new read endpoint, and UI states in New Game), per
`CLAUDE.md`'s standing conventions:

- **Testing**: `backend/test/league.test.js` covers creation/validation,
  enrollment (including multi-league), the auto-tag hook's every eligibility
  case (0/1/>1 candidates, explicit valid/stale leagueId, every non-eligible
  game shape), standings computation (points formula, decided-vs-abandoned
  games, zero-played roster rows, sort order/tiebreak), season status
  transitions, the `wipeAllData()`/`resetStats()` standing-rule interactions,
  and Cricket league support (gameType validation, category-per-gameType, and
  X01/Cricket cross-isolation in both directions, including the same two
  players enrolled in one league of each type) — a committed, re-runnable
  suite, not a one-off manual check.
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
