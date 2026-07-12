# Companion Website (Cloud Stats, Matchmaking, Leagues/Tournaments) — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

A project-operated website that a self-hosted Oche instance can opt into: it reports
player stats/data back to the site, the site facilitates matchmaking between players
across different self-hosted instances, and — building on that — potentially
cross-instance tournaments or leagues. The site also hosts global leaderboards across
every tracked stat, including Daily Challenge results, aggregated across every
opted-in instance rather than just one household's local roster.

## The honest tension, stated up front (mirrors `docs/online-multiplayer-roadmap.md`)

Every other roadmap doc — including online multiplayer's P2P design — has kept the
project's core identity intact: self-hosted, nothing leaves your network unless you
explicitly configure it (Home Assistant webhooks are outbound-only and opt-in; the
mobile-app roadmap recommends a VPN specifically to *avoid* internet exposure). This
feature is different in kind, not just degree: it requires a **project-operated,
always-on, persistent hosted service** that instances phone home to on an ongoing
basis — not a one-time relay handshake for a single P2P session (online multiplayer's
signaling server), and not a fire-and-forget webhook to a service *you* already run
(Home Assistant). That's a real shift in what "self-hosted" means for whoever opts in,
and it needs to be named plainly rather than glossed over:

- **Strictly opt-in, off by default.** No stat ever leaves the local SQLite database
  unless an admin explicitly enables reporting in Settings and creates a companion-site
  account. An instance that never opts in should be provably unaffected — no
  background polling, no silent telemetry, nothing.
- **The site needs its own account system** — something this app has never had. Local
  PINs gate *who plays as whom on one instance*; they say nothing about identity across
  different households' instances. Matchmaking a stranger requires the site to know who
  a "player" is independent of any one instance, which is a materially different trust
  model than anything built so far.
- **Reported data is a deliberate export, not raw replication.** The site should
  receive an explicit, versioned "stat report" payload (final per-game/per-leg
  results, aggregate stat snapshots) — never a live mirror of the local database, and
  never anything let alone dart-by-dart data unless a future opt-in specifically
  extends to that (e.g. for a live matchmaking session, see below). Whatever the
  payload shape ends up being, it's a new, narrow contract to design and document, not
  "just point it at `/api/*`."

## How this relates to the three existing "beyond one instance" roadmaps

This doc is easy to conflate with three already-designed features that all sound
adjacent but solve different problems — worth being explicit about the boundary so
whoever picks any of these up doesn't duplicate the others' work:

- **`docs/online-multiplayer-roadmap.md`** (P2P + live video) solves *how two already-
  paired instances play a live match together* — a direct WebRTC connection, no
  ongoing server involvement beyond a one-time signaling handshake. This doc's
  matchmaking piece is upstream of that: *finding* an opponent in the first place. A
  natural relationship, not a duplication: this site could be the discovery/lobby layer
  that hands two matched players off to the existing P2P design to actually play,
  rather than reinventing a second live-transport mechanism.
- **`docs/tournament-mode-roadmap.md`** and **`docs/archive/league-mode-roadmap.md`** are both
  explicitly scoped to *one instance's own local roster* — a bracket or a season table
  built from players who all already exist on that one household's Oche. Neither
  currently has any concept of a participant who isn't a local player row. Cross-
  instance tournaments/leagues (this doc's "potentially even tournaments or leagues")
  are a genuine extension of those designs, not a replacement — the bracket/standings
  *logic* in both docs is reusable, but the participant model underneath would need to
  grow from "a local `players.id`" to "a local player, or a companion-site account
  playing a matched/remote match," which those two docs don't attempt today.
- **`docs/daily-challenge-roadmap.md`** already generates the same challenge
  deterministically from the calendar date alone (`todaysChallenge(dateStr)`) — every
  instance, opted in or not, already computes an identical challenge for a given day
  with zero synchronization needed. That makes it the single easiest global
  leaderboard to build correctly: "fewest darts for today's Checkout Sprint, across
  every reporting instance" is directly comparable with no format-drift risk, unlike
  X01/Cricket leaderboards (see the drift risk called out below).

## Architecture: a new context, not a new column (per `CLAUDE.md`)

Per this repo's standing convention, a game that gets reported to the companion site
is a new **context** layered on top of the existing `games` table via its own table
with a `game_id` foreign key — the same shape already adopted by tournament mode
(`tournament_matches.game_id`) and league mode (`games.league_id`) — never a new
`is_cloud_reported` boolean bolted directly onto `games`. A plausible shape: a
`cloud_reports` table (`game_id` FK, `reported_at`, `remote_match_id` or similar,
`sync_status`), so `games` itself stays exactly as generic as it is today regardless
of how many "was this shared somewhere" contexts eventually exist alongside practice/
league/tournament.

## Open design questions for whoever picks this up

1. **Reporting mechanism**: a periodic batched push (cron-style, reusing the same
   outbound-request egress guard `netguard.js` already enforces for Home Assistant
   webhooks) vs. a push-on-game-completion webhook-style call vs. the instance polling
   the site. A batched push most closely matches "nothing leaves unless configured"
   and avoids a live outbound connection existing at all times.
2. **Formula-drift risk**: every stat this repo tracks has a single authoritative
   formula documented in `REFERENCE.md` (e.g. `OPENING_CATS`'s exact 501/301/170/101
   scoping, the trebleless-visit definition, MPR's marks-per-round formula). A global
   leaderboard on the companion site needs to either (a) recompute identically from
   raw reported per-game data using the *exact same* formulas, kept in lockstep with
   `REFERENCE.md` as local formulas evolve, or (b) trust each instance's locally-
   computed stat values as reported, accepting that a stale/forked instance could
   report under a different formula version than the current one. Whichever is chosen,
   it needs a versioning story so old and new formula results are never silently
   averaged together into one leaderboard.
3. **Matchmaking model**: skill-based (needs a rating system this app has never had —
   Elo/Glicko or similar, itself a new design surface) vs. simple open-lobby matching.
   A rating system also raises the question of what a rating even represents across
   different game types/formats (X01 501 vs. Cricket vs. a Daily Challenge format) —
   likely several independent ratings, not one.
4. **Account/identity model**: is a companion-site account 1:1 with a local `players`
   row, or can one household's local player be linked/unlinked from a site account
   independently (e.g. a PIN-protected local player choosing to link their stats to a
   site account, or unlink later without losing local history)? This determines
   whether opting out later is a clean, well-defined operation or a messy one.
5. **What "leaderboards for all stats" actually aggregates**: literally every stat
   bubble/Personal Best this app tracks (per README's stats list), or a curated subset
   for the site's v1? Given the formula-drift risk above, starting with the smallest
   correct set (Daily Challenge leaderboards, per the easy-win argument above) rather
   than all of X01 + Cricket + Daily Challenge stats at once is the lower-risk order.
6. **Privacy controls**: per-stat opt-in/opt-out (e.g. report win/loss and Daily
   Challenge results but not full dart-by-dart analytics), the ability to permanently
   delete previously-reported data from the site, and whether a player's real display
   name is required or a site-only handle is used instead — none of this has been
   decided yet and each choice changes the account-model question above.
7. **Hosting/ownership**: unlike every other roadmap doc, this one requires the
   *project itself* to operate persistent infrastructure (the site, its database, its
   auth) indefinitely, not just a small relay component someone could self-host
   instead (online multiplayer's signaling server is explicitly self-hostable; this
   site's central leaderboard/matchmaking role is not meaningfully self-hostable in
   the same way — a self-hosted "companion site" would just be another isolated
   island, defeating the cross-instance matchmaking point). Worth being honest that
   this is the one roadmap item whose value is capped by someone actually operating
   and paying for that infrastructure long-term.

## Suggested build order (once someone picks this up)

1. Companion-site account system + the opt-in reporting toggle in Settings (off by
   default) — no matchmaking or leaderboards yet, just "does a report successfully and
   safely leave this instance."
2. Daily Challenge global leaderboard only (per the formula-drift argument above) —
   the smallest, lowest-risk correct slice, and the one place "leaderboards for all
   stats, including daily challenges" can ship first without a formula-versioning
   design being finished yet.
3. X01/Cricket global leaderboards, once the formula-drift versioning story (open
   question 2) is actually decided, not assumed.
4. Matchmaking (lobby/queue), handing matched pairs off to
   `docs/online-multiplayer-roadmap.md`'s existing P2P design to actually play, rather
   than building a second live-transport mechanism.
5. Cross-instance tournaments/leagues, extending `docs/tournament-mode-roadmap.md` and
   `docs/archive/league-mode-roadmap.md`'s existing bracket/standings logic to a participant
   model that includes matched/remote players, per the relationship section above.
