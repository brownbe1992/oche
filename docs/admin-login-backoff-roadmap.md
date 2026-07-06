# Admin Login Backoff (Progressive Delay Instead of a Hard Lockout) — Design Roadmap

> Status: **Not started.**
>
> **Size: Low-Medium complexity** — replaces one existing mechanism
> (`login_locked_until` as a flat 5-minute lock after N failures) with a different
> formula over the same column; no new schema, no new dependency. The care needed is
> in getting the formula and its edge cases right, not in the plumbing.
> **Usefulness: Medium** — closes a real (if low-severity) griefing gap documented as
> an accepted tradeoff in `docs/security-audit-roadmap.md` **SEC-8**, and directly
> answers a real worry: today, an attacker who knows the admin username can
> deliberately fail logins to keep the real admin locked out for as long as they keep
> trying. This design's whole point is that a legitimate admin can never be **fully**
> locked out — only slowed down, and the real admin can always still get in with
> zero waiting by simply providing the correct password sooner (see "How this differs
> from a hard lockout" below).
>
> **Companion doc**: `docs/archive/admin-account-recovery-roadmap.md` (a CLI recovery
> script, now shipped) is a different angle on the same underlying worry — this doc makes lockout itself
> less of a problem to begin with; that doc gives an operator a way out if it still
> happens (or if the password is simply forgotten, which no lockout design fixes).
> They're independent and either can be built without the other, but they pair well.

## Goal

Replace the current flat "lock the account for 5 minutes after N failed attempts"
admin-login lockout with a **progressive delay** that grows with each consecutive
failure but never produces a hard, unconditional block — so brute-forcing the admin
password stays computationally infeasible, while the one real admin (who knows the
correct password) is never in a state where entering it correctly still fails.

## The current mechanism (baseline, confirmed in code)

`backend/db.js` `login()`:
1. Looks up the admin by username, checks `login_locked_until > now` — if true,
   **throws a 423 regardless of whether the submitted password is correct** (the
   locked-check runs unconditionally, before the password-correctness check is even
   consulted for the throw decision).
2. Pays the scrypt hashing cost either way (real hash for a known username, a cached
   dummy hash for an unknown one — the SEC-1 anti-timing-enumeration measure).
3. On a wrong password, bumps `login_fail_count` (via a `RETURNING`-based `UPDATE` so
   concurrent attempts can't race the same stale count past the threshold — see
   REFERENCE.md's lockout mechanics section) and, once it reaches
   `admin_lockout_threshold` (default 5, configurable 1-1000 in Settings), sets
   `login_locked_until = now + 5 minutes` — a **flat** delay, the same regardless of
   how many times the threshold has already been crossed.
4. A successful login resets `login_fail_count`/`login_locked_until` to their
   defaults.

`docs/security-audit-roadmap.md`'s **SEC-8** already names the consequence
explicitly: "an attacker who knows an admin username can deliberately fail logins to
keep that account locked out (a targeted DoS on that user)" — accepted as a tradeoff
rather than fixed, on the grounds that the per-IP rate limiter (SEC-3) is the primary
defense against a *flood*, and a scheme that only locks an account after its own IP
has separately been throttled would be "a real behavior change with its own
subtlety, out of scope for that pass." This doc is that follow-up design.

## How this differs from a hard lockout

The key property: **the delay is a "try again after this time" window, not a
counter of remaining attempts that can hit zero.** Concretely:

- Each wrong password schedules `login_locked_until = now + delay(fails)`, where
  `delay()` grows with the consecutive-failure count (see formula below) instead of
  jumping straight to a flat 5 minutes at some threshold.
- There is **no point at which a correct password stops working.** Once
  `login_locked_until` has passed, the very next attempt is evaluated normally — if
  it's the correct password, it succeeds immediately, resetting the counter to zero.
  An attacker who doesn't know the password will keep re-triggering ever-longer
  delays; the real admin, the moment they type the right password (even mid-delay
  window — see the open question on this below), gets back in.
- This directly answers "how do we harden this without ever fully locking out a
  single admin": a single admin is never in a state with zero remaining
  attempts — only in a state where the *next* attempt is scheduled slightly later
  than the last one.

## Design: a doubling delay over the same `login_locked_until` column

No new schema is needed — `admins.login_fail_count` / `admins.login_locked_until`
already exist and already mean exactly what this design needs ("how many consecutive
failures" and "not allowed to try again until"). The change is entirely in the
**formula** `login()` uses to compute the lock window, not in the columns
themselves.

- **Grace window**: the first few failures (e.g. 3 — real admins mistype passwords)
  cost no delay at all, matching how a first typo shouldn't already feel punitive.
- **Doubling beyond the grace window**: each failure past the grace count doubles the
  delay — e.g. `delay = min(maxDelaySeconds, baseSeconds * 2^(fails - graceAttempts))`
  with a sane `baseSeconds` (e.g. 2) and a cap (`maxDelaySeconds`, e.g. 900 = 15
  minutes) so the formula can't grow unbounded from a very long attack run. A concrete
  worked example with `base=2s, grace=3, max=900s`: failures 1-3 → no delay; failure 4
  → 2s; 5 → 4s; 6 → 8s; ... failure 13 → ~1024s, clamped to the 900s cap; every
  failure after that stays at the 900s cap. This reaches "impractically slow to brute
  force" (minutes between guesses) within roughly a dozen attempts while the early,
  most-likely-to-be-a-typo attempts stay frictionless.
- **Settings**: replace (or extend — see open questions) `admin_lockout_threshold`
  with the 2-3 new tunables (grace attempts, base delay, max delay), following the
  exact validation pattern `PUT /api/settings` already uses for
  `pin_lockout_threshold`/`admin_lockout_threshold` (integer, bounded range, 400 on
  anything else).
- **The 423 response should say how long**, not just "try again in a few minutes" —
  since the wait is now variable, return a `Retry-After`-style hint (the exact
  remaining seconds, or a rounded "try again in about N minutes") so a real admin
  waiting it out isn't left guessing, mirroring the `Retry-After` header the
  rate-limiter (SEC-3) already sets on its own 429s.
- **Per-IP interaction (unchanged, still the primary defense)**: the existing `login`
  rate-limit bucket (SEC-3, 10/60s/IP) still bounds how fast any single attacking IP
  can even generate failures in the first place — this design changes what happens to
  the *account* as failures accumulate, not the IP-level throttle, which stays exactly
  as it is.

## Suggested build order

1. Add the new settings keys (grace/base/max, or fold into a single JSON-ish
   settings blob if that reads cleaner than three flat keys — a judgment call for
   whoever implements this) with sane defaults, validated the same way the existing
   lockout-threshold settings are.
2. Replace `login()`'s flat "bump count, lock 5 min at threshold" branch with the
   doubling-delay computation above, still using the existing `RETURNING`-based
   increment to avoid the same race the current code already guards against.
3. Update the 423 response body to include the computed remaining wait.
4. Update `REFERENCE.md`'s lockout-mechanics section and
   `docs/security-audit-roadmap.md`'s SEC-8 entry to point at this new mechanism
   instead of "accepted tradeoff, unchanged" — this is the fix SEC-8 deferred.
5. A committed `node:test` (extending `backend/test/db.auth.test.js`, which already
   covers the current flat-lockout threshold) proving: the grace window doesn't
   delay early failures, the delay doubles as designed, it's capped at the max, and —
   the property that matters most — **a correct password succeeds immediately once
   the current window has elapsed**, never staying blocked once the wait is over.

## Open questions for whoever picks this up

- **Does a correct password submitted *during* an active delay window succeed
  immediately, or does it still have to wait out the window?** The design above
  assumes the latter (the delay is a hard "not yet" until it elapses, regardless of
  whether the password would have been right) — mostly so the lockout state doesn't
  become itself an oracle for "is this the right password" via timing. But it's worth
  a deliberate decision, not a default: skip-the-wait-on-correct-password is more
  convenient for the real admin but reveals slightly more through timing.
- Should this fully **replace** `admin_lockout_threshold`, or coexist with it (e.g. a
  hard cap still exists after some very large number of failures, as a backstop)? The
  simplest version removes the flat threshold entirely in favor of the formula; a more
  conservative rollout could keep both.
- Whether the grace/base/max values should be admin-configurable at all, or just
  fixed constants — the existing lockout threshold is configurable, so precedent
  leans toward configurable, but three new tunables is more Settings surface than one.
- Whether `verifyPlayerPin()` should get the same treatment. It currently mirrors the
  old flat-lockout admin design; this doc scopes to admin login only since that's the
  account whose complete lockout is the more consequential failure mode, but the two
  could reasonably converge on the same mechanism later.
