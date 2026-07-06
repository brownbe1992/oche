# Admin Account Recovery CLI — Design Roadmap

> Status: **Done.** `backend/admin-recovery.js` ships `list`/`reset-password
> <username>`/`clear-lockout <username>`, exactly as designed below.
> `changeAdminPassword()` (option 2, the recommended fix) now always clears
> `login_fail_count`/`login_locked_until`, and `listAdmins()` returns lockout
> status so `list` shows it directly. Concurrent-write safety against a live
> running server was verified, not just assumed. All three open questions are
> resolved: the interactive TTY prompt asks for the new password twice (piped
> stdin is trusted as a single read, matching `openssl passwd -stdin`); the
> README documents `docker exec -it oche node backend/admin-recovery.js ...`
> as the primary invocation path; `list` shows lockout status. Committed
> coverage: `backend/test/admin-recovery.test.js`. See
> `docs/open-roadmap-items.md` for the tracker entry.
>
> **Size: Low complexity** — a standalone script following the exact precedent
> `backend/backup.js` already set (zero new dependencies, invoked via
> `node backend/<script>.js`, operating directly on the same SQLite file the running
> server uses). No API changes, no new HTTP surface. **Usefulness: Medium-High** — the
> one gap nothing else in this app currently covers: a forgotten admin password, with
> no admin account able to log in to reset it and no email/SMS to fall back on.
>
> **Companion doc**: `docs/archive/admin-login-backoff-roadmap.md` makes an admin *locked out
> by an attacker* less likely to matter (the real admin can always still get back in
> given the correct password); this doc is the tool for the case that backoff design
> can't fix at all — **the password itself is genuinely forgotten**, or every admin
> account somehow got deleted, or an operator inherited a box with no known
> credentials. They're independent; either can be built without the other.

## Goal

Give a self-hoster who has direct access to the machine/container (already the
trust boundary this whole app's threat model rests on — see
`docs/security-audit-roadmap.md`'s threat model section) a documented, tested way to
reset a forgotten admin password or clear a stuck lockout, **without email, without
new external dependencies, and without a new HTTP-reachable attack surface.**

## Why not email-based recovery

Ruled out deliberately, not by default:

- It would be this project's **first outbound dependency on a mail provider/SMTP
  library** — a real break from the "zero external dependencies, single Docker
  container, nothing leaves your network unless you configure a webhook" identity
  the rest of the app (and README) already advertises.
- It requires the self-hoster to have already configured SMTP credentials
  *somewhere* just in case they later forget a password — an awkward chicken-and-egg
  setup burden for a feature most installs would never touch.
- A self-hosted, single/few-admin app already has a natural, zero-dependency
  recovery channel that email-based SaaS products don't: **whoever can already exec
  into the container or reach the host filesystem has already cleared a higher trust
  bar than "controls an email inbox."** The recovery mechanism should use that
  channel, not invent a new one.

## Why a CLI script, not an HTTP endpoint

An HTTP-reachable "reset my password" route — even one gated by some secondary
secret — is new network-facing attack surface for exactly the scenario where the
normal auth layer has already failed or is untrusted. A local script run by someone
who already has host/container access sidesteps that entirely: the security boundary
is "can this person exec into the box," which is also the boundary every other
sensitive operation in this app (editing `docker-compose.yml`, reading the raw
`darts.db` file, rotating `COOKIE_SECURE`/`OCHE_REQUIRE_AUTH`) already assumes.
`backend/backup.js` is the existing precedent for "a script that operates directly on
the live database file, run by the operator, not exposed over HTTP" — this follows
the same shape.

## A real design gap this doc surfaces (not just plumbing)

Naively, "reset the password" sounds like it's just a call to the existing
`changeAdminPassword(id, password)` — but that alone is **not sufficient** to recover
a currently-locked-out account, for a subtle reason worth calling out explicitly:

`db.js` `login()`'s locked-check runs **unconditionally, before the password-
correctness check is consulted for the throw decision** —

```js
if (locked) {
  throw httpError(423, 'Too many failed login attempts. Try again in a few minutes.');
}
```

— so if `login_locked_until` is still in the future, login throws 423 **even with
the freshly-reset, correct password.** `changeAdminPassword()` today does not touch
`login_fail_count`/`login_locked_until` at all (only a *successful login* resets
those, via `q.resetLoginFail`, which obviously can't happen while locked). A recovery
script that only calls `changeAdminPassword()` would silently fail to actually
restore access until the existing 5-minute lock happens to expire on its own — not
the instant, reliable recovery this feature is supposed to provide.

**Two ways to close this, worth deciding deliberately rather than discovering by
surprise during testing:**
1. Have the recovery script explicitly clear `login_fail_count`/`login_locked_until`
   as a second write alongside the password change (needs a new exported `db.js`
   function, e.g. `clearAdminLockout(id)`, since nothing today does this outside of a
   successful login).
2. **Recommended**: extend `changeAdminPassword()` itself to always clear both
   columns as part of a password change — arguably correct behavior for the *normal*
   in-app flow too (an admin who successfully changes their own password from
   Settings has no reason to still be carrying a stale lockout), and it gives the
   recovery script exactly what it needs for free, with no new exported function.

## Design

- **New standalone script**, e.g. `backend/admin-recovery.js`, following
  `backend/backup.js`'s conventions exactly: reads `DARTS_DB` from the environment
  (same variable the server and `backup.js` both already use), opens the same SQLite
  file directly via `node:sqlite`'s `DatabaseSync` (or, more simply, requires
  `backend/db.js` itself the way the test suite already does — see
  `backend/test/db.auth.test.js`'s `process.env.DARTS_DB` + `require('../db.js')`
  pattern — reusing the existing prepared statements and validation instead of
  hand-rolling new SQL). Zero new dependencies.
- **Subcommands, mirroring what an operator would actually need**:
  - `list` — print every admin username (and creation date), so an operator who
    doesn't remember exact usernames doesn't have to open the database with a raw
    SQLite client first.
  - `reset-password <username>` — sets a new password for that admin (see "reading
    the new password safely" below) and clears any lockout (per the design-gap
    section above).
  - `clear-lockout <username>` — for the case where the admin remembers their
    password fine but got locked out (by an attacker or their own mistyping) and
    just wants the wait removed, without changing the password at all.
  - Deliberately **not** included: creating a brand-new admin from scratch. That
    already exists as `createFirstAdmin()`/`GET /api/setup-required` when zero admins
    exist, and `createAdmin()` from within an authenticated session otherwise — this
    script's job is recovery of an *existing* account, not bypassing setup.
- **Reading the new password safely**: avoid a plain CLI argument (`node script.js
  someuser hunter2`), since that leaks the password into shell history and process
  listings (`ps`) for the duration of the process. Read it from **stdin** instead
  (`echo -n 'newpassword' | node backend/admin-recovery.js reset-password someuser`,
  or an interactive prompt if stdin is a TTY) — the same shape tools like `htpasswd`
  or `openssl passwd -stdin` already use for exactly this reason. Document the
  shell-history caveat either way (piping still leaves the echoed value in the
  *invoking* shell's history unless the operator is careful — that's an operator-side
  concern the script's design can reduce but not eliminate).
- **Runs against the live database while the server is still running.** SQLite's WAL
  mode (already enabled by `db.js` on startup) supports concurrent readers/writers
  with proper locking, so a brief, infrequent write from a second short-lived process
  should be safe without stopping the container — but this assumption should be
  **verified during implementation** (a real concurrent-write test against a running
  server, not just assumed), matching this codebase's existing "verified against a
  live scratch server" standard rather than a documented-but-untested claim.
- **No confirmation prompt beyond running the command itself** — same reasoning as
  `backend/backup.js`: whoever can already run `node backend/admin-recovery.js`
  inside the container has already cleared the trust bar this whole recovery
  mechanism assumes.
- **Output should log what changed** (e.g. "Password reset for admin 'alice';
  lockout cleared.") so the operator has confirmation the operation actually took
  effect, especially useful if run inside a `docker exec` session with limited
  scrollback.

## Suggested build order

1. Decide the `changeAdminPassword()` lockout-clearing question above (recommended:
   extend it to always clear lockout — cheap, and closes the design gap for both the
   normal in-app flow and this script at once).
2. `backend/admin-recovery.js` with `list` / `reset-password` / `clear-lockout`,
   reading the new password from stdin.
3. A committed `node:test` (new `backend/test/admin-recovery.test.js`, or folded into
   `db.auth.test.js` if the script is thin enough to test at the `db.js` function
   level) proving: `reset-password` on a locked-out admin actually allows an
   immediate subsequent login with the new password (the exact failure mode the
   design-gap section above describes), and `clear-lockout` alone (no password
   change) does the same for the "forgot I was locked out, remember the password
   fine" case.
4. README: a new subsection (alongside the existing "Backups" section, same style)
   documenting when and how to use this — what it needs (`DARTS_DB` pointed at the
   right file, container must have the volume mounted the same way), and the
   shell-history caveat around choosing how to pipe in the new password.
5. `REFERENCE.md`: a short mention in the auth/lockout section pointing at this as
   the documented recovery path, so "I forgot the admin password" has one obvious
   place to look.

## Open questions for whoever picks this up

- Should `reset-password` require confirming the new password twice (typed/piped
  twice) to guard against a typo locking the operator into a password they didn't
  intend, the same way the in-app "Change password" flow presumably should (worth
  checking whether it already does)?
- Should this script also support running via `docker exec` directly documented as
  the primary invocation path (`docker exec -it oche node backend/admin-recovery.js
  list`), given most self-hosters interact with this app through Docker rather than
  a bare `node` process — the README section should pick one primary path and show
  it first, with the other as an alternative.
- Whether `list` should also surface whether an account is *currently* locked (and
  for how much longer), which would make `clear-lockout` feel like a more
  deliberate, informed action rather than a shot in the dark.
