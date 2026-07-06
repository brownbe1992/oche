# Online Multiplayer (P2P + Live Video Verification) — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

> **Related (2026-07)**: `docs/companion-website-roadmap.md` proposes a project-
> operated site for cross-instance matchmaking — it's the discovery/lobby layer that
> could hand a matched pair off to *this* doc's P2P design to actually play, rather
> than reinventing a second live-transport mechanism. That doc doesn't change anything
> here; it's upstream of it.

## Goal

Peer-to-peer live scoring between two players on independent self-hosted Oche
instances anywhere in the world, with live video streaming so each player can
visually verify the other's throws, without compromising the project's self-hosted,
easy-to-deploy identity any more than is fundamentally unavoidable.

## Decisions made (2026)

| Decision | Choice |
|---|---|
| Signaling server | Project-provided default, but self-hostable — a small open-source relay component |
| TURN/video relay | Bring-your-own credentials only — the project never operates relay infrastructure itself |
| Online match stats | Tracked separately from local H2H stats, not merged into the same trusted leaderboard pool |

## The honest tension, stated up front

Every other roadmap doc has kept the project's core identity intact — self-hosted,
nothing leaves your network unless explicitly configured (Home Assistant is
outbound-only and opt-in; the mobile-app roadmap recommends a VPN specifically to
*avoid* any internet-facing exposure). True P2P between two strangers' networks
"anywhere in the world" cannot fully preserve that: two devices behind arbitrary home
routers generally cannot discover and connect to each other without *some* third
party helping them rendezvous first (NAT traversal fundamentals, not a design
oversight to route around). The decisions above define exactly how much shared
infrastructure this feature needs, and are designed to minimize both the amount and
the sensitivity of what's shared.

## Core mechanism: one WebRTC connection, two purposes

A single WebRTC peer connection can carry both a **DataChannel** (tiny JSON messages,
one per dart — the score-sync mechanism) and **media tracks** (camera video for live
verification) at the same time. This isn't "a P2P scoring system" plus a separate
"video call system" — it's one connection, two payload types. The DataChannel traffic
is negligible bandwidth; the video traffic is not, and that asymmetry drives most of
the infrastructure and sequencing decisions below.

## Infrastructure required

**STUN** — needed for NAT traversal discovery (a peer learning its own public-facing
address). Already a solved, free problem: public STUN servers (Google's,
Cloudflare's, etc.) are ubiquitous infrastructure every WebRTC application already
relies on. No hosting burden here.

**Signaling** (project-provided default, self-hostable) — a small, low-bandwidth relay
whose only job is helping two specific peers exchange connection-negotiation messages
(SDP offers/answers, ICE candidates) before a direct connection exists. It never sees
game data or video — only short-lived setup metadata. Ships as an open-source
component with a project-maintained default instance for zero-friction onboarding,
while any install can point at a self-hosted copy instead — the same "sensible
default, fully swappable" pattern the Home Assistant integration already uses, just
applied to a piece of infrastructure the project itself provides a default for.

For anyone self-hosting the signaling relay locally rather than using the project
default, it should be an opt-in Docker Compose profile (or separate compose file),
not always-on in the default `docker-compose.yml` — same convention as the camera
scoring vision service, see `docs/existing-app-prep-roadmap.md` item 9.

**TURN** (bring-your-own only) — the piece that costs real, ongoing bandwidth. When
direct P2P fails (a meaningful fraction of real-world peer pairs, due to symmetric NAT
or restrictive firewalls — and video makes this worse, since it needs sustained
throughput rather than small message bursts), TURN relays *all* traffic between the
two peers rather than just helping them find each other. The project never operates
this. An admin can optionally configure their own TURN credentials (self-hosted
`coturn`, or a commercial provider's free tier) in Settings for better reliability;
without it, matches work whenever the two networks allow a direct connection and fail
gracefully — with clear "couldn't establish a connection" messaging, not a silent
hang — when they don't.

## Security

- **Transport encryption is inherent to WebRTC** — DTLS for the data channel, SRTP for
  media — so eavesdropping on the connection (direct P2P or TURN-relayed) is already
  handled by the protocol.
- **Match codes need the same discipline as the app's existing PIN protections** —
  short-lived, single-use, sufficiently random codes for pairing two specific players,
  expiring after use or after a short timeout. Same underlying principle as the
  existing PIN lockout design (`backend/db.js`'s `pinLockoutThreshold`): prevent
  guessing or hijacking a session that wasn't intended for you.
- **TURN credentials must be ephemeral, never a static shared secret** — the standard,
  necessary pattern is a short-lived, HMAC-derived time-limited username/password
  issued per session. A TURN server with a static secret is a well-known abuse target
  (used as a free open proxy for unrelated traffic); ephemeral scoped credentials
  prevent that.
- **The signaling server should see the absolute minimum possible** — connection
  negotiation metadata only, never game state or any video/audio content. Gameplay and
  video stay end-to-end between the two peers (or peer-to-relay-to-peer via TURN,
  still encrypted, without the relay operator being able to read it).
- **A real identity/trust gap, stated plainly rather than papered over**: the app's
  existing PIN system protects "who can play as a given profile" *within one shared
  household instance* — it has no concept of authenticating a stranger connecting from
  a completely independent instance. Two independent SQLite databases have no shared
  source of truth. **Live video verification does social/visual trust work here, not
  cryptographic work** — it lets two humans see each other actually throwing, the same
  way an honesty-based casual match works today, but it does not cryptographically
  prove a result to either side's database after the fact. This is an honest
  limitation of the design, not a gap to design around as if it didn't exist.

## Scalability, and staying self-hostable

- **Scoring itself scales trivially** — peer-to-peer, no central server processing
  game logic for match volume, regardless of how many matches happen across every
  install combined.
- **Signaling is lightweight enough not to be a real scaling concern** — brief bursts
  of small JSON messages per match setup. A single small always-on service handles
  enormous concurrent match-setup volume without meaningful cost, whether that's the
  project's default instance or a self-hosted copy.
- **TURN relay bandwidth is the one piece that is genuinely not free at scale**,
  especially with video involved — exactly why it's bring-your-own rather than
  project-operated. This keeps the core project's operating cost and liability at
  zero: installing Oche never requires running new infrastructure, and self-hosters
  who want maximum connection reliability can opt into bringing their own relay
  capacity, but nobody is forced to for the app to work as shipped.
- Net effect: the "self-hosted and easy to deploy" promise holds for the core app. The
  only place this feature asks anything of the wider ecosystem beyond a single
  self-hoster's own server is the small, low-sensitivity signaling default —
  everything expensive or trust-sensitive is opt-in and externalized to whoever wants
  it.

## Data model: online matches get their own table, not a `games` column

Per the stats-trust decision, online matches don't merge into the trusted local H2H
stats pool. Each side of a match independently records its own copy of the game
(players, turns, darts) to its own local database — both instances process the same
live stream of dart events off the shared DataChannel in real time, so absent active
tampering they naturally converge on the same recorded result without needing a
shared authoritative database.

Per the binding convention in `CLAUDE.md` (already applied to tournament mode's
`tournament_matches.game_id` and league mode's `games.league_id`), this is a new
**`online_matches`** table with a `game_id` FK back into `games` — *not* a value
stuffed into `games.category` (which already means the X01 starting score, e.g.
`'501'`/`'301'`/`'170'` — every existing category-scoped stat query, including
`getPlayerStatBubbles()`'s `first3avg`/`first9avg`/`score140pct`, filters on that
column expecting exactly those values, so overloading it with `'Online'` would
silently break them) and *not* a new `is_online` boolean bolted onto `games` either.
A minimal shape: `online_matches(game_id INTEGER PRIMARY KEY REFERENCES games(id),
match_code TEXT, peer_verified INTEGER)` — stats/leaderboard queries that need to
exclude online matches join against (or anti-join) this table, exactly like league
mode's queries already key off `games.league_id IS NULL`/`IS NOT NULL`.

## UX: connecting two remote instances

New Game gets an "Online Match" mode. One player generates a short match code and
shares it out-of-band (text, Discord, whatever) — the app doesn't need to solve player
discovery or accounts, just connection brokering given a shared code. The other player
enters the code on their own instance; both hit the signaling relay with that code,
exchange negotiation info, and a direct (or TURN-relayed, if configured and needed)
connection forms between the two Oche installs.

## Live video verification specifics

Ephemeral only — never recorded or stored on either side. This is both the safer
default given the project's no-telemetry/no-cloud-storage ethos, and the most
defensible privacy posture given the internet traversal this feature already
requires elsewhere. It's a second media track on the same WebRTC connection already
carrying the score DataChannel, not a separate recording pipeline.

## Suggested build order

1. **Signaling relay** (project default + self-hostable) + match-code pairing flow, no
   game logic yet — prove two independent Oche instances can find and negotiate a
   connection.
2. **DataChannel score sync** — dart-by-dart events flowing P2P, each side recording
   its own game locally with an `online_matches` row (see Data model above).
3. **STUN-only P2P connectivity**, with clear failure messaging when a direct
   connection isn't possible (no TURN yet).
4. **BYO TURN configuration** in Settings, with ephemeral credential issuance.
5. **Video track for live verification** — the highest-bandwidth, most TURN-dependent
   piece, deliberately built last once the lower-bandwidth path is solid.
6. **Online-match stats/leaderboards** (queried via the `online_matches` join, not a
   `games.category` value), kept visibly distinct from local H2H throughout the UI.

## Open questions for whoever picks this up

- Exact match-code lifetime/format, and what happens if a code is entered after the
  intended opponent already connected (or never shows up).
- Whether the project's default signaling instance needs its own rate-limiting/abuse
  protection, given it's shared infrastructure even though low-sensitivity.
- Whether a lightweight non-cryptographic "both sides confirm this is the final
  score" handshake at match end is worth adding on top of the passive
  convergence-via-shared-datachannel model, short of full non-repudiation.
