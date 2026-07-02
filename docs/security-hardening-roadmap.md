# Security Hardening — Design Roadmap & Standing Checklist

> Status: **✅ Concrete fix done** (v0.6.2). Admin login now has the same lockout
> protection as player PINs — `login_fail_count`/`login_locked_until` columns on
> `admins`, a configurable `admin_lockout_threshold` (default 5) in **Settings →
> Admin accounts**, verified end-to-end (locks after the threshold, correct password
> still rejected while locked, resets on success). The standing checklist for future
> features (below) remains an ongoing practice, not a one-time task — like
> `docs/accessibility-roadmap.md`, this is partly a bounded fix (now done) and partly
> a standing practice for every future feature — see `CLAUDE.md` for the binding
> cross-reference.
>
> **Size: Very low complexity** for the concrete fix below — it mirrors an
> already-proven pattern in this exact codebase almost line-for-line, not new design.
> **Usefulness: high** — closes a real, currently-unprotected brute-force path.
>
> **Follow-up:** a second, broader adversarial audit (`docs/security-audit-roadmap.md`)
> found and fixed rate limiting, async password hashing, SSE/live-payload bounds, an
> outbound-request egress guard, a non-root container, and several smaller hardening
> items — all done except the webhook-auth decision below (SEC-7 in that doc), which is
> the same open item as the "TODO" section immediately following this one.

## Goal

Close the one concrete gap found in an otherwise solid security model, and keep a
standing checklist so future features (many of which introduce new credentials —
Home Assistant tokens, TURN credentials, match codes) don't quietly reintroduce
problems this app has already solved once.

## What's already solid (baseline, confirmed in code)

- Passwords and player PINs: scrypt hashing with random salts, `crypto.timingSafeEqual`
  comparison (`backend/auth.js`).
- Session tokens are hashed (SHA-256) before storage — never stored raw
  (`backend/db.js`, `auth.hashToken`).
- Cookies are HttpOnly + SameSite=Strict, with an optional Secure flag for HTTPS
  deployments (`COOKIE_SECURE`).
- Login and PIN-entry failures return **generic messages** ("Invalid username or
  password" / "Incorrect PIN") so neither leaks which part was wrong or whether a
  username/player exists.
- `login()` compares against a **fixed dummy hash on unknown usernames**
  (`DUMMY_PW_HASH`) specifically so response timing doesn't leak which usernames are
  registered — a real, deliberate anti-enumeration measure.
- `serveStatic()` has an explicit path-traversal guard (`filePath.startsWith(FRONTEND_DIR)`).
- Player PINs already have a full lockout system: `pin_fail_count`/`pin_locked_until`
  columns, a configurable threshold (`pin_lockout_threshold`, default 10), 5-minute
  lockout on exceeding it, reset on success (`backend/db.js`, `verifyPlayerPin()`).

## The gap

**The admin login itself never got the same brute-force protection.** `POST
/api/login` → `db.login()` has no rate limiting or lockout at all — unlike
`verifyPlayerPin()`, an attacker with network access can attempt the admin password
an unlimited number of times. This is a gap in something this codebase has already
solved once, just not applied to the account that matters most.

## Design: mirror the existing PIN lockout pattern, retargeted at `admins`

- Two new columns on `admins`, added the same additive way every other migration in
  this schema has been (`ALTER TABLE admins ADD COLUMN login_fail_count INTEGER NOT
  NULL DEFAULT 0`, `ALTER TABLE admins ADD COLUMN login_locked_until INTEGER`).
- `login()` gains the same three steps `verifyPlayerPin()` already has: check
  `login_locked_until` before attempting the password check, bump `login_fail_count`
  and lock after N consecutive failures, reset both on a successful login.
- Reuse the existing generic `INVALID_LOGIN` message and the existing
  `pin_lockout_threshold`-style settings pattern (either share that setting or add a
  distinct `admin_lockout_threshold` — see Open questions).

## Follow-up done (v0.7.x): auth-required-for-writes, and two stat-integrity fixes

A second audit (pretend-malicious, whole-codebase) found that while admin/settings
routes were gated, **every gameplay/stat write endpoint was unauthenticated**, and that
**player PINs were only enforced in the UI** — a direct `POST /api/games/:id/turns`
recorded turns as a PIN-protected player with no PIN. Addressed:

- **`OCHE_REQUIRE_AUTH` (env, default off).** When on, every write endpoint
  (`POST /api/players`, `PUT /api/players/rename|out|dart-weight`, `POST /api/games`,
  `/api/games/:id/turns|complete|events`, `DELETE .../turns/last`, `POST /api/live`,
  `/api/badges/award|revoke`, `/api/challenges/start|complete`) requires a logged-in
  admin session via a shared `requireWrite()` gate. Reads stay public so the scoreboard
  and stats still work for everyone. `GET /api/auth-config` exposes the flag; the
  frontend uses it to prompt for login before gameplay/roster writes. Default off so
  existing LAN installs are unchanged on upgrade; **turn it on for any internet-exposed
  deployment.** This is the chosen mitigation for the client-only-PIN gap — PINs stay a
  UI convenience; the auth gate is the real lock.
- **Stat reclassification fixed.** H2H-vs-practice classification now reads a frozen
  `games.player_count` (captured at creation, backfilled) instead of a live
  `COUNT(game_players)` subquery, so deleting or resetting a player can no longer flip
  an opponent's completed H2H games into "practice."
- **Hardening:** `addTurn` now rejects turns with no darts / out-of-range
  sector/multiplier (was a silent 3-dart-average inflation + stat-poisoning vector);
  the static-file traversal guard uses `path.relative` instead of a bare
  `startsWith(FRONTEND_DIR)` (which would also accept a sibling `frontend-*` dir).

## TODO — brainstorm & agree: authenticate webhook payloads (Home Assistant)

**Status: needs a design decision before implementing — do not just pick one.**

`POST /api/ha-webhook` is still unauthenticated (deliberately left out of the
auth-for-writes pass above, pending this discussion). Today it only ever fires to the
*already-admin-configured* HA URL, so it's not arbitrary SSRF — but an anonymous
request can still (a) trigger the homeowner's HA automations at will and (b) inject
arbitrary JSON fields into the outbound payload. The goal: **every webhook payload the
app emits should be attributable to an authenticated session of some kind**, so a
random internet client can't drive someone's smart home through this app.

Candidate approaches to weigh (pick together, don't assume):

1. **Fold it into `requireWrite`** — simplest: `/api/ha-webhook` requires an admin
   session like every other write when `OCHE_REQUIRE_AUTH` is on. Downside: the webhook
   is fired from gameplay code (`sendHaWebhook`) that today runs for any player at the
   oche, not just an admin — so this only works cleanly if gameplay already requires
   auth (which, with the flag on, it does). Likely the right default. Open question:
   what should happen when the flag is *off* — stay open (LAN trust) or always require
   admin for this specific endpoint regardless of the flag?
2. **Server-side firing only.** Stop exposing an HTTP trigger at all: move all webhook
   emission fully server-side, fired as a side effect of already-authenticated write
   endpoints (turn recorded → server decides whether it's a 180/Big Fish/etc. and fires
   the webhook itself). Removes the public trigger entirely and also removes the
   client's ability to forge payload fields. Bigger refactor (server must re-derive the
   achievement conditions the client currently computes), but the most robust.
3. **Signed/capability token.** Mint a short-lived HMAC token (derived from a server
   secret) when a game starts under an authenticated session, and require it on
   `/api/ha-webhook`. Flexible but adds token-lifecycle complexity for little gain over
   option 1 in a single-server LAN app.

Recommendation to open the discussion: **option 1 for now** (least churn, closes the
anonymous-trigger hole the moment `OCHE_REQUIRE_AUTH` is on), with **option 2 as the
eventual target** once we're comfortable moving achievement detection server-side —
which would also make the moment-card image payload (currently client-generated base64)
the last remaining client-trusted webhook input to reconsider. Decide before coding.

## Standing checklist for future features (not urgent, just tracked)

Several roadmap docs already thought carefully about secrets on their own:
`docs/environmental-logging-roadmap.md` flags the Home Assistant long-lived access
token as sensitive and recommends write-only handling (never returned to the client);
`docs/online-multiplayer-roadmap.md` specifies ephemeral, HMAC-derived TURN
credentials instead of a static shared secret specifically to avoid a known abuse
pattern. This doc doesn't repeat that design work — it just names the standing
question every future feature that stores a new credential or secret should ask:
**does this need write-only handling, and does whatever verifies it need brute-force
protection the same way logins and PINs already do?**

## Suggested build order

1. Two new columns on `admins` + mirror the PIN lockout queries in `backend/db.js`.
2. Update `login()` to check/bump/lock exactly like `verifyPlayerPin()` does today.
3. Surface lockout state in the login UI using the same generic-message pattern
   already used for PINs (no new UI pattern needed).

## Open questions for whoever picks this up

- Should admin lockout share `pin_lockout_threshold`, or get its own (stricter)
  threshold — compromising the admin account is more consequential than compromising
  a single player profile, so a lower failure count before lockout is probably
  warranted.
- Whether any other currently-unauthenticated endpoint (e.g. `POST /api/live`, trusted
  today as LAN-scoped by design — see the open question already raised in
  `docs/camera-scoring-roadmap.md`) needs its own rate limiting as the app gains more
  network-facing surface (mobile app, online multiplayer) — worth revisiting once
  those actually ship, not before.
