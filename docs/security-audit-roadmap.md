# Security Audit Roadmap (adversarial whole-codebase review)

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

### SEC-7 — `POST /api/ha-webhook` is unauthenticated  **(MED — decision pending, do not just pick one)**

**Where:** `backend/server.js` `/api/ha-webhook` (deliberately left out of the
auth-for-writes pass, pending a design decision).

**Attack:** an anonymous request can trigger the homeowner's HA automations at will and
inject arbitrary JSON fields into the outbound payload (destination is still the
admin-configured URL, so not arbitrary SSRF — that's SEC-4).

**Fix:** see the full options and recommendation already written up under "TODO —
brainstorm & agree" in `docs/security-hardening-roadmap.md`. Summary: (1) fold into
`requireWrite`, (2) move webhook firing fully server-side, or (3) signed capability
token. Recommendation: option 1 now, option 2 later. **Agree the approach before coding.**

---

### SEC-8 — Lockout enables griefing  **(LOW, accepted tradeoff — document)**

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

**Where:** `server.js` `PUT /api/settings` caps `card_tagline` (≤140) and the two
lockout thresholds, but `ha_url` and the webhook-ID fields are stored unbounded (admin
only).

**Fix:** cap each accepted string setting (e.g. `ha_url` ≤2048, webhook IDs ≤128) in the
allow-list validation before `updateSettings`. Reject over-length with 400.

**Verify:** oversized value returns 400.

---

### SEC-10 — No security response headers  **(LOW, hardening)**

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
  change. Sound. (The only issue is the *blocking* nature of scrypt — SEC-1.)
- **Path traversal:** fixed (`path.relative`), re-verified with `curl --path-as-is`.
- **Daily-challenge seed:** `Math.abs()` returns a positive double even for INT32_MIN;
  no negative-modulo crash.

---

## Suggested implementation order

1. **SEC-3** (build the reusable per-IP rate limiter) — unblocks SEC-1 and SEC-2.
2. **SEC-1** (async scrypt + rate-limit auth) — highest unauthenticated-DoS payoff.
3. **SEC-2** (SSE caps + bounded live payload).
4. **SEC-4** (HA egress guard) — the network-pivot risk the deployment cares most about.
5. **SEC-5** (non-root container) + **SEC-6** (secure-default docs/compose).
6. **SEC-7** (decide + implement webhook auth — agree first).
7. **SEC-9, SEC-10, SEC-11** (bounded settings, headers, generic 5xx) — quick hardening.
8. **SEC-8** (revisit lockout vs. IP throttling once SEC-3 lands).

## Standing practice

Every new endpoint: decide read vs. write (gate writes via `requireWrite`), bound every
accepted input, and rate-limit anything that does expensive work (crypto, outbound
requests, or DB writes) before that work runs. Every new outbound request: run it
through the SEC-4 egress guard. Every new credential/secret: write-only handling +
brute-force protection (see `docs/security-hardening-roadmap.md`).
