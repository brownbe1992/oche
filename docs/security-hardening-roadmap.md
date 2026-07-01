# Security Hardening — Design Roadmap & Standing Checklist

> Status: **not started** (the concrete near-term fix below). Like
> `docs/accessibility-roadmap.md`, this is partly a bounded fix and partly a standing
> practice for every future feature — see `CLAUDE.md` for the binding cross-reference.
>
> **Size: Very low complexity** for the concrete fix below — it mirrors an
> already-proven pattern in this exact codebase almost line-for-line, not new design.
> **Usefulness: high** — closes a real, currently-unprotected brute-force path.

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
