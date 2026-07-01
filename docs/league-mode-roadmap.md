# League / Season Mode — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

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

## Open questions for whoever picks this up

- Points system: straightforward win=1/loss=0, or something with more texture (bonus
  points for margin of victory, legs won within a loss, etc.)? Simpler is probably
  better for a casual home-league use case, but worth confirming against how the
  intended real-world league (if modeling an actual existing league) scores things.
- Should a player be able to be enrolled in multiple concurrent leagues (e.g. a
  friendly-group league and a household league running at the same time)?
- Does a league need its own format (starting score, legs/sets) distinct from what
  each individual match is set up with, or does it just track whatever format players
  choose per match?
