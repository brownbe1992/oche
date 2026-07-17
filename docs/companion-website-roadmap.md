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
- **`docs/archive/tournament-mode-roadmap.md`** and **`docs/league-mode-roadmap.md`** are both
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

## Authentication: API keys, not site-account logins from the instance

**Resolved** (was part of open question 4 below): the self-hosted instance never
handles a companion-site *password* at all. The flow is:

1. The admin creates an account on the companion website itself, in a browser — has
   nothing to do with the self-hosted instance.
2. From that site account, the admin generates an API key.
3. The admin pastes that key into a new Settings field on the self-hosted instance
   (e.g. "Companion Site → API Key"), stored the same **write-only** way this app
   already treats every other credential (admin password hash, player PIN hash,
   the Home Assistant webhook token) — accepted, hashed/stored, never echoed back
   once saved.
4. Every outbound report is sent as a bearer token on that key, through the same
   `netguard.js` egress guard already enforced for Home Assistant webhooks (open
   question 1 below).

This mirrors the shape this app already uses for Home Assistant (an outbound URL +
optional bearer token in Settings) rather than inventing a new pattern — one more
entry in the same family, not a new credential model. It's deliberately **not** a
username/password login flow from the instance, for reasons that compound rather
than being independent nice-to-haves:

- **Blast radius**: if one self-hosted instance is compromised, only that scoped key
  leaks — never the account password, which would also grant access to every other
  instance the same admin might run.
- **Selective revocation**: the site can invalidate one instance's key without
  forcing a password change (and re-entry into every other instance's Settings) for
  a household running more than one.
- **No server-to-server session handling on the site's side** — the ingest endpoint
  just validates a bearer token per request, the same shape as any ordinary API-key
  auth, rather than the site needing to accept and manage login sessions from
  automated clients.

Key generation should use the same high-entropy random-token approach `auth.js`
already uses for session tokens (`crypto.randomBytes(...).toString('hex')`), and the
site's ingest endpoint needs its own rate limiting on top of the account-level limits
in "Anti-fraud / data integrity" below — the same progressive-backoff instinct this
app already applies to admin login and player PIN attempts, applied to key
validation attempts instead of password attempts.

This resolves the *authentication mechanism* half of open question 4 below. The
*identity model* half (is a site account 1:1 with a single local player, or does one
key cover a whole household's roster) is still genuinely open — see question 4.

## Anti-fraud / data integrity

No self-reported system can be made cheat-proof — the site has no way to
independently confirm a physical dart game happened. The realistic goal isn't
"impossible to fake," it's **"not worth faking, and cheap to catch and undo when
someone tries."** A layered set of defenses, ordered roughly by how cheap each is to
build relative to how much abuse it actually blocks:

1. **Recompute from raw data, don't trust reported values — this is the anti-fraud
   argument for resolving open question 2 in favor of (a).** Recomputing every stat
   server-side from the raw per-game data in the report, using the same canonical
   formulas `REFERENCE.md` documents, can't prove a game was physically played, but
   it *can* reject internally-impossible data for free: a 3-dart visit scoring more
   than 180, a leg "won" in fewer darts than the starting score allows, a checkout
   that isn't a legal finish. That's validation logic the self-hosted scoring engine
   already enforces client/server-side — reusing it server-side on the companion
   site rejects a large share of low-effort fabricated reports (someone just POSTing
   plausible-looking JSON without a real game behind it) at essentially zero
   marginal design cost beyond the formula-drift work question 2 already requires.
2. **Rate/volume limits tied to physical reality.** A household can only throw so
   many darts in a day. Cap plausible submission volume per account (games/hour,
   darts/day) and throttle or flag anything that exceeds what a human playing darts
   could actually produce — cheap, and blocks scripted bulk-flooding specifically.
3. **Concentrate real scrutiny on record-breaking claims, not routine reports.**
   The abuse motivation is almost always "get to the top of a leaderboard" — nobody
   bothers faking a mediocre average. Rather than heavily gating every report,
   flag anything that would set a record or land in the top N of any leaderboard
   for a manual review queue before it's shown publicly. Proportionate: near-zero
   friction for the overwhelming majority of legitimate, unremarkable data; real
   scrutiny concentrated exactly where the incentive to cheat actually lives.
4. **New accounts don't count toward public leaderboards immediately.** A short
   probation period (account age or a minimum submission count) before an account's
   results appear publicly blunts throwaway-account abuse without adding friction
   real users would notice.
5. **Traceable provenance, so bad data can be purged after the fact, not just
   blocked going forward.** Every stored result needs to keep its source-account
   attribution rather than being anonymized on ingest — specifically so that when an
   account *is* confirmed faking data (via the record-review queue above, or a
   report from another user), every contribution it ever made can be identified and
   stripped from historical/global leaderboards, and its API key revoked, not just
   the account banned for future submissions.

**Deliberately out of scope, and not recommended even later**: identity verification
(ID checks, payment friction, phone verification) — wildly disproportionate for a
darts leaderboard, and directly against this project's self-hosted, privacy-
respecting ethos (see "the honest tension" above). The realistic ceiling for this
kind of system is raising the cost of cheating above the reward, not eliminating it.

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
   averaged together into one leaderboard. **Leans strongly toward (a)** now that
   "Anti-fraud / data integrity" above needs the same recomputation to catch
   internally-impossible reported data — not formally decided, but the two questions
   share one answer rather than being independent.
3. **Matchmaking model**: skill-based (needs a rating system this app has never had —
   Elo/Glicko or similar, itself a new design surface) vs. simple open-lobby matching.
   A rating system also raises the question of what a rating even represents across
   different game types/formats (X01 501 vs. Cricket vs. a Daily Challenge format) —
   likely several independent ratings, not one.
4. **Account/identity model** — the authentication *mechanism* is resolved (API
   keys, see above); still open: is a companion-site account 1:1 with a local
   `players` row, or can one household's local player be linked/unlinked from a site
   account independently (e.g. a PIN-protected local player choosing to link their
   stats to a site account, or unlink later without losing local history)? Also
   still open: does one API key cover a whole household's roster (simplest — the
   site just receives "household X's report," no per-player site identity at all
   for v1) or does matchmaking eventually require individual players to have their
   own site identity distinct from their household's key? This determines whether
   opting out later is a clean, well-defined operation or a messy one.
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

1. Companion-site account system + API-key generation/revocation (see
   "Authentication" above) + the opt-in reporting toggle and API-key field in
   Settings (off by default) — no matchmaking or leaderboards yet, just "does a
   report successfully and safely leave this instance." Recompute-from-raw-data
   (not trust-reported-values) and basic rate limiting should be built into the
   ingest endpoint from this very first step, not bolted on once a leaderboard
   already exists — retrofitting anti-fraud after bad data has already shaped a
   public leaderboard's history is a much worse position than starting with it.
2. Daily Challenge global leaderboard only (per the formula-drift argument above) —
   the smallest, lowest-risk correct slice, and the one place "leaderboards for all
   stats, including daily challenges" can ship first without a formula-versioning
   design being finished yet. This is also the first point any of "Anti-fraud / data
   integrity"'s leaderboard-specific measures (record-review queue, new-account
   probation) actually have something to protect — build them alongside this step,
   not deferred to a later pass.
3. X01/Cricket global leaderboards, once the formula-drift versioning story (open
   question 2) is actually decided, not assumed.
4. Matchmaking (lobby/queue), handing matched pairs off to
   `docs/online-multiplayer-roadmap.md`'s existing P2P design to actually play, rather
   than building a second live-transport mechanism.
5. Cross-instance tournaments/leagues, extending `docs/archive/tournament-mode-roadmap.md` and
   `docs/league-mode-roadmap.md`'s existing bracket/standings logic to a participant
   model that includes matched/remote players, per the relationship section above.
