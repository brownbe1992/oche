# Oche Security Risk Assessment

## 1. Executive Summary

Oche is a self-hosted darts scoring application built with a deliberately minimal,
security-conscious architecture: a single Node.js process using **only built-in modules
(zero runtime npm dependencies)**, a local SQLite database, and a single-file frontend.
It has already been through **eight documented adversarial audit passes** (SEC-1 through
SEC-25 in `docs/security-audit-roadmap.md`), all of which are closed. The *application
code* is, by the standards of a self-hosted hobby project, unusually well hardened:
parameterised SQL throughout, scrypt password/PIN hashing with timing-safe comparison
and anti-enumeration dummy hashing, progressive-backoff account lockout, per-IP rate
limiting, a zero-trust write-auth gate, a strict CSRF posture (SameSite=Strict +
mandatory `application/json` Content-Type + no CORS), an SSRF egress guard, bounded
request bodies and SSE connections, a non-root container, and a full set of security
response headers including a CSP.

**The central finding of this assessment is therefore not a code bug.** It is that
**"exposed directly to the public Internet," as described, moves the dominant risk out
of the application — which is strong — and into four areas the application largely
cannot solve on its own:**

1. **The exposure model itself** — a single-process, single-home-server app placed on
   the open Internet with no CDN/WAF/DDoS layer in front of it.
2. **Single-factor administrative authentication** — one password stands between the
   Internet and full write access *and* full database replacement (backup restore).
   There is no MFA/WebAuthn, no breached-password check, and the per-IP rate limiter is
   weak against distributed/IPv6 attackers.
3. **Detection and response blindness** — there is no security audit log of successful
   logins, admin actions, backup restores, or data wipes; only 5xx errors are recorded.
4. **Infrastructure and operational unknowns** — TLS/reverse-proxy config, host OS
   hardening, firewalling, DNS, container resource limits, and encryption at rest are
   all outside the codebase and could not be verified for this assessment.

Given how strong the application layer is, none of these are reasons *not* to proceed —
but several should be addressed **before** direct public exposure. Our verdict is
**Ready with Changes**: ship the application as-is behind the right edge architecture
and after closing the single-factor-auth and audit-logging gaps, rather than binding it
straight to a public IP on a single password.

---

## 2. Assessment Metadata

| Field | Value |
| --- | --- |
| **Document Title** | Oche Security Risk Assessment |
| **Assessment Date** | 2026-07-16 |
| **Application Name** | Oche |
| **Application Version** | 0.15.0 |
| **Assessment Type** | Internet Exposure Risk Assessment |
| **AI Model Used** | Claude Opus 4.8 |
| **Reviewer** | AI Security Assessment |
| **Overall Security Score** | 72 / 100 |
| **Overall Deployment Readiness** | Ready with Changes |

---

## 3. Overall Security Score

**72 / 100.**

This single number blends two very different pictures and should not be read as a flat
grade:

- **Application security (code): ~88/100.** All tracked findings closed; strong crypto,
  input-validation, CSRF, SSRF, and DoS-bounding hygiene; zero-dependency supply chain.
- **Internet-exposure readiness (deployment + operations + auth strength + detection):
  ~60/100.** Single-factor admin auth, no MFA, weak per-IP limiting against distributed
  attackers, no audit logging, no WAF/CDN assumed, and multiple unverifiable infra
  controls.

The composite (weighted toward the exposure scenario the assessment was scoped to) lands
at **72**. Closing the five "Quick Wins" in §9 would realistically move this to the low
80s; adding MFA and an edge WAF/tunnel would move it into the high 80s.

---

## 4. Overall Deployment Readiness

**Ready with Changes.**

The application is ready to be deployed. The *deployment as literally described* —
"exposed directly to the public Internet" — is **not** ready without the changes in §9
(Quick Wins) and, ideally, the architecture in §11. The single most impactful change is
to **not expose it directly at all**: front it with a reverse-tunnel or WAF/CDN so there
is no open inbound port and no unauthenticated attacker can reach the origin. If direct
exposure is a hard requirement, then MFA on the admin account and an authentication
audit log become prerequisites rather than nice-to-haves.

---

## 5. Threat Model Summary

**Assets:** the admin credential (crown jewel — grants all writes + DB restore + wipe +
merge + player-PIN management); the SQLite database (player identities, full per-dart
history, admin password hash, session token hashes, player PIN hashes); session cookies;
the Home Assistant URL/credential if configured; availability of the live scoreboard.

**Trust boundaries:**
- Public Internet → origin (the critical boundary once exposed).
- Unauthenticated reader → authenticated admin (`requireWrite`/`requireAdmin`).
- App → outbound Home Assistant destination (`netguard.js` egress guard).
- Host root → non-root `node` process (container drops privileges after entrypoint chown).

**In-scope adversaries and current posture:**

| Adversary | Current mitigation | Residual |
| --- | --- | --- |
| Automated scanners / bots | Generic errors, no version header, no debug endpoints, no default creds (first-run setup) | First-run land-grab window (F-11); scanners still consume capacity |
| Credential stuffing / password spraying | Progressive backoff, per-IP login bucket (10/min), generic messages, dummy-hash timing defense | **No MFA, no breach check; per-IP limiter weak vs. distributed/IPv6 (F-2, F-3)** |
| Brute force (online) | scrypt cost + backoff + rate limit | Single-account griefing lockout accepted (SEC-8) |
| DoS / resource exhaustion | Async scrypt, SSE caps, body caps, rate limits, backpressure on uploads | **No L3/L4 protection; single process; per-IP global budget insufficient vs. botnet (F-4)** |
| Web attacks (XSS/CSRF/SQLi/SSRF/path traversal) | Parameterised SQL, SameSite+CT CSRF defense, egress guard, path.relative guard, CSP | **CSP uses `unsafe-inline` for scripts, weakening XSS depth (F-5)** |
| Malicious authenticated admin (compromised session) | Re-auth on backup restore | Backup restore = total data control; 30-day sessions (F-6, F-7) |
| Session hijacking / fixation | HttpOnly, SameSite=Strict, hashed tokens, new token per login (no fixation) | 30-day TTL; no rotation/idle timeout; cleartext risk if TLS misconfigured (F-1, F-7) |
| Supply chain | **Zero npm deps (major strength)**; only `node:22-alpine` + `su-exec` | Floating base-image tag, no pinning/scanning/SBOM (F-10) |
| Insider / host compromise / lateral movement | Non-root container, egress guard limits pivot | No encryption at rest; container caps not dropped; host unverifiable (F-8, F-9) |
| Zero-day (Node/SQLite/kernel) | Small attack surface, few moving parts | Floating tags + no automated patching cadence documented (F-10) |

**Out of scope / operator-owned (flagged, not assessable here):** host OS hardening, SSH,
firewall rules, DNS security, TLS cipher configuration, physical security, EDR. See §14.

---

## 6. Top 10 Highest Risks

1. **F-1 — TLS is entirely operator-provided; cleartext-session risk if misconfigured** (High)
2. **F-2 — Single-factor admin auth; no MFA/WebAuthn; no breached-password check** (High)
3. **F-4 — No edge DDoS/WAF layer in front of a single-process origin** (Medium-High)
4. **F-3 — In-memory per-IP rate limiter is weak against distributed/IPv6 attackers** (Medium)
5. **F-6 — Backup restore / wipe / merge are total-data primitives behind one password** (Medium)
6. **F-12 — No security audit log (successful logins, admin actions, restores)** (Medium)
7. **F-5 — CSP relies on `unsafe-inline` scripts, weakening XSS defense-in-depth** (Medium)
8. **F-7 — 30-day sessions, no rotation/idle-timeout, no per-device revocation UI** (Medium)
9. **F-11 — First-run setup land-grab window on a freshly exposed instance** (Medium)
10. **F-9 — Container lacks resource limits / read-only FS / capability drop** (Medium)

---

## 7. Detailed Findings

> Severity uses Critical/High/Medium/Low against the *internet-exposed* scenario. Several
> findings would be Low or N/A on the original trusted-LAN deployment; exposure is what
> raises them.

### F-1 — TLS termination and certificate lifecycle are entirely operator-provided

- **Description:** The app speaks only plain HTTP (`backend/server.js` has no TLS
  listener, by design). All confidentiality/integrity in transit depends on an external
  reverse proxy the operator must supply and configure. `COOKIE_SECURE=true` sets the
  cookie `Secure` flag and emits HSTS, but nothing verifies TLS is *actually* terminating
  in front — `COOKIE_SECURE=true` with no real HTTPS silently produces a cookie the
  browser will refuse to send, and `COOKIE_SECURE=false` on a public box sends a 30-day
  admin session cookie in cleartext. A one-time startup warning exists (SEC-24) but is
  easily missed in `docker logs`.
- **Attack Scenario:** Operator exposes port 8066 directly, or fronts it with an
  HTTP-only proxy, or forgets `COOKIE_SECURE`. An on-path attacker (rogue Wi-Fi, ISP,
  compromised upstream) reads the `oche_session` cookie and replays it for up to 30 days,
  gaining full admin write + DB-restore capability. Certificate expiry (unmanaged) causes
  a hard outage.
- **Likelihood:** Medium (self-hosters frequently misconfigure TLS).
- **Business Impact:** High — full account/data compromise on cookie theft; outage on
  cert expiry.
- **Severity:** **High**
- **Affected Components:** deployment topology; `auth.js` (`COOKIE_SECURE`), `server.js`
  (`SECURITY_HEADERS`, startup warning); `docker-compose.live-test.yml`.
- **Recommended Mitigation:** Ship a **known-good reverse proxy config with automatic
  TLS** (Caddy with Let's Encrypt is one file and auto-renews) rather than leaving it to
  the operator; make `COOKIE_SECURE=true` the default for any Internet profile; add an
  optional startup self-check that probes its own public URL for HTTPS and refuses to
  start (or loudly warns) if the session cookie would travel in cleartext.
- **Mitigation Tradeoffs:** Bundling a proxy adds a moving part and a second container;
  automatic TLS requires a real domain and open 80/443 for ACME.
- **Implementation Complexity:** Low-Medium.
- **Estimated Security Benefit:** High.
- **Residual Risk:** TLS downgrade/misissuance, compromised CA, or a proxy the operator
  swaps out incorrectly.
- **References:** OWASP ASVS V9 (Communications); CWE-319 (Cleartext Transmission);
  NIST SP 800-52r2; MITRE ATT&CK T1557 (Adversary-in-the-Middle).

### F-2 — Single-factor administrative authentication (no MFA/WebAuthn, no breach check)

- **Description:** The admin account is protected by a username + password only
  (`db.login()`), min length 8, max 256, no complexity or breached-password check. That
  one factor grants *every* write, plus database restore (arbitrary DB replacement),
  wipe-all-data, player-merge, and player-PIN management. There is no TOTP, no WebAuthn/
  passkey, no OAuth/OIDC option. Session TTL is 30 days.
- **Attack Scenario:** Credential-stuffing or password-spraying botnet targets the known
  `/api/login` endpoint. Because the rate limiter is **per-IP** (F-3), a distributed
  attacker spreads attempts across thousands of IPs; a reused or weak admin password
  (min 8 chars, no HIBP check) falls to an offline breach list. One success = total app
  compromise.
- **Likelihood:** Medium (Internet-facing login endpoints are attacked continuously; the
  outcome hinges on password strength, which the app does not enforce meaningfully).
- **Business Impact:** High — full compromise, including data destruction and injection
  via restore.
- **Severity:** **High**
- **Affected Components:** `db.login()`, `db.createFirstAdmin()`/`createAdmin()`
  (password policy), `auth.js` (sessions).
- **Recommended Mitigation:** Add **TOTP (RFC 6238) as an optional-but-recommended second
  factor**, or WebAuthn/passkeys (no new server dependency needed for TOTP — HMAC is in
  `crypto`). At minimum: raise the minimum password length to 12–14, add a
  breached-password check via HIBP k-anonymity range API (note: this is an outbound call
  and must route through the egress guard), and default the Internet profile to a shorter
  session TTL.
- **Mitigation Tradeoffs:** MFA adds enrollment/recovery UX and a recovery path to design
  (lost authenticator); HIBP adds an outbound dependency and egress consideration.
- **Implementation Complexity:** Medium (TOTP) / High (WebAuthn).
- **Estimated Security Benefit:** High.
- **Residual Risk:** Phishing/real-time MITM of TOTP; social-engineering of recovery.
- **References:** OWASP ASVS V2 (Authentication); OWASP API Security API2:2023 (Broken
  Authentication); NIST SP 800-63B; CWE-308 (Single-Factor Auth), CWE-521 (Weak Password
  Requirements); MITRE ATT&CK T1110 (Brute Force).

### F-3 — In-memory, per-IP rate limiter is weak against distributed and IPv6 attackers

- **Description:** `rateLimit()` is an in-process `Map` keyed on `bucket:ip`, using the
  first `X-Forwarded-For` hop only when `TRUST_PROXY=true`. It resets on restart, isn't
  shared across processes, and is **per single IP address**. On IPv6, an attacker commonly
  controls an entire /64 (or more) — effectively unlimited source addresses — so per-IP
  buckets (login 10/min, global 300/min) provide little protection. It is also purely a
  throttle, not a blocklist: there is no escalating ban for a persistent attacker.
- **Attack Scenario:** A botnet or a single host with an IPv6 /64 rotates source addresses
  to stay under 10 login attempts per IP per minute while collectively making thousands of
  attempts per minute against `/api/login`, neutralising the per-IP defense that
  complements the per-account backoff.
- **Likelihood:** Medium.
- **Business Impact:** Medium (amplifies F-2; also enables sustained resource pressure).
- **Severity:** **Medium**
- **Affected Components:** `server.js` `clientIp()`, `rateLimit()`, all buckets.
- **Recommended Mitigation:** Push rate limiting/abuse-blocking to the edge (WAF/CDN or
  `fail2ban` watching the auth log from F-12). Treat an IPv6 client by its /64 prefix, not
  its full address, for limiting. Consider a global (not just per-IP) ceiling on failed
  logins that trips a CAPTCHA/slowdown.
- **Mitigation Tradeoffs:** Edge tooling adds infrastructure; /64 grouping can over-limit
  legitimately shared prefixes (rare for a household app).
- **Implementation Complexity:** Low (edge) / Medium (in-app /64 + global ceiling).
- **Estimated Security Benefit:** Medium-High.
- **Residual Risk:** Sufficiently distributed attacks always evade rate limiting alone;
  MFA (F-2) is the real backstop.
- **References:** OWASP API4:2023 (Unrestricted Resource Consumption); CWE-307
  (Improper Restriction of Excessive Auth Attempts); CAPEC-16.

### F-4 — No edge DDoS/WAF layer in front of a single-process origin

- **Description:** Oche is one single-threaded Node process. The in-app defenses bound
  *logical* abuse (SSE count, body size, per-IP requests) but cannot absorb volumetric
  (L3/L4) or high-rate L7 floods. Direct Internet exposure puts the origin IP in reach of
  every scanner and booter service.
- **Attack Scenario:** A modest L7 flood (thousands of concurrent connections / requests
  per second) saturates the single event loop or the host's file descriptors/bandwidth;
  the live scoreboard and admin access go down. A volumetric L3/L4 attack takes the host
  offline entirely regardless of app logic.
- **Likelihood:** Low-Medium (hobby apps are rarely *targeted*, but opportunistic scanning
  and reflection are constant).
- **Business Impact:** Medium (availability only; no data loss).
- **Severity:** **Medium-High**
- **Affected Components:** exposure model; host; `server.js` (single process).
- **Recommended Mitigation:** Do not expose the origin directly. Use **Cloudflare Tunnel
  (no open inbound port at all)** or a CDN/WAF with DDoS protection; failing that, set
  connection/rate limits and timeouts at a reverse proxy and firewall the origin so only
  the proxy can reach it.
- **Mitigation Tradeoffs:** CDN/tunnel introduces a third-party dependency and a privacy
  consideration (traffic transits their network under TLS).
- **Implementation Complexity:** Low (Cloudflare Tunnel) to Medium.
- **Estimated Security Benefit:** High (availability).
- **Residual Risk:** Application-layer logic floods that pass the WAF; provider outages.
- **References:** OWASP API4:2023; NIST SP 800-53 SC-5 (DoS Protection); MITRE ATT&CK
  T1498/T1499.

### F-5 — Content-Security-Policy relies on `unsafe-inline` for scripts

- **Description:** The CSP (`server.js` `SECURITY_HEADERS`) is strong on origins
  (`default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action
  'self'`, no `connect-src` beyond self) but uses `script-src 'self' 'unsafe-inline'`
  because both frontend HTML files use inline `<script>` and `onclick` handlers. This
  means the CSP does **not** stop injected inline script — it only stops loading external
  script origins. The project has already found and fixed three stored/reflected XSS sinks
  (SEC-12, SEC-15, SEC-18); with `unsafe-inline`, any *future* reintroduced sink executes
  with no CSP backstop, and could exfiltrate the (HttpOnly, so script can't read it
  directly, but can still be abused for CSRF-on-behalf / UI redress) session or drive
  admin actions in-page.
- **Attack Scenario:** A future feature echoes attacker-controlled text (a player name, a
  live-payload field) into the DOM without escaping — the exact class already fixed twice.
  On an Internet-exposed instance where the input can come from an unauthenticated
  `POST /api/players` (public by default), the payload runs in an admin's browser with no
  CSP to block it.
- **Likelihood:** Low (no current sink) but **recurring historically**.
- **Business Impact:** Medium-High if it recurs.
- **Severity:** **Medium**
- **Affected Components:** `server.js` CSP; `frontend/index.html`, `frontend/display.html`.
- **Recommended Mitigation:** Move to a **nonce-based CSP** (per-response nonce on each
  inline `<script>`, drop `unsafe-inline`), and migrate inline `onclick=` handlers to
  addEventListener. This is a known larger refactor; track it explicitly. Interim: keep
  the standing "escape every echoed field" test discipline and add automated
  output-encoding tests around any DOM sink.
- **Mitigation Tradeoffs:** Nonce CSP requires templating the frontend (currently static
  single-file) — a real structural change to a deliberately build-step-free app.
- **Implementation Complexity:** High.
- **Estimated Security Benefit:** Medium (defense-in-depth; the primary control remains
  output encoding).
- **Residual Risk:** DOM-based XSS via unsafe JS sinks even with a good CSP.
- **References:** OWASP Top 10 A03:2021 (Injection); CWE-79; OWASP CSP Cheat Sheet;
  CAPEC-63.

### F-6 — Backup restore, wipe, and merge are total-data primitives behind one password

- **Description:** An authenticated admin can upload a ≤500MB SQLite file that **replaces
  the entire database** on next restart (`handleUploadRestore` → `backupLib.stageRestore`),
  wipe all data, or merge players. Restore re-verifies the password (`verifyAdminPassword`,
  good) and validates the file is SQLite (`validateSqliteFile`), but the primitive itself
  is complete data control — injection of arbitrary records, or destruction. It relies on
  the safety of the `node:sqlite` parser against a maliciously crafted DB file.
- **Attack Scenario:** If the single admin factor is compromised (F-2), the attacker
  doesn't just read/write via the API — they replace the DB wholesale (planting data, or
  wiping it), or upload a malformed SQLite file probing for a parser vulnerability.
- **Likelihood:** Low (requires admin compromise first).
- **Business Impact:** High (total data integrity/availability).
- **Severity:** **Medium** (gated by admin auth; elevate to High absent MFA).
- **Affected Components:** `handleUploadRestore`, `backup-lib.js`, `db.wipeAllData()`,
  player-merge route.
- **Recommended Mitigation:** Require the second factor (F-2) specifically for restore/
  wipe/merge; keep the existing password re-auth; log every restore/wipe/merge to the
  audit trail (F-12); keep off-box, versioned backups so a malicious restore/wipe is
  recoverable; consider a "confirm phrase" step (already partially present for merge).
- **Mitigation Tradeoffs:** Extra friction on legitimate recovery operations.
- **Implementation Complexity:** Low (given F-2/F-12 exist).
- **Estimated Security Benefit:** Medium.
- **Residual Risk:** A determined compromised-admin scenario; parser 0-day.
- **References:** OWASP API5:2023 (Broken Function Level Authorization); CWE-434 (partly);
  CWE-502 (deserialization-adjacent); NIST CP-9/CP-10 (backup/restore).

### F-7 — Long-lived sessions with no rotation, idle timeout, or per-device revocation UI

- **Description:** Session tokens live 30 days (`SESSION_TTL_MS`), are random 32-byte
  values stored only as SHA-256 hashes (good), created fresh per login (no fixation), and
  can be revoked per-admin (`deleteSessionsForAdmin`) or on logout. But there is no token
  rotation on privilege use, no idle timeout, no "these are your active sessions / log out
  everywhere" UI, and no device binding. A stolen cookie is valid for a month.
- **Attack Scenario:** Cookie captured via F-1 (cleartext) or a future F-5 sink is usable
  for 30 days with no rotation to invalidate it and no UI for the admin to notice/revoke a
  rogue session.
- **Likelihood:** Low-Medium.
- **Business Impact:** Medium.
- **Severity:** **Medium**
- **Affected Components:** `auth.js`, `db.js` session functions.
- **Recommended Mitigation:** Shorten TTL for the Internet profile (e.g. 7 days or a
  sliding idle window), rotate the token on re-auth for sensitive actions, and add an
  "active sessions" list with per-session revoke.
- **Mitigation Tradeoffs:** Shorter sessions mean more frequent logins on the shared
  household tablet — the exact friction the 30-day default was chosen to avoid.
- **Implementation Complexity:** Low-Medium.
- **Estimated Security Benefit:** Medium.
- **Residual Risk:** Theft-then-immediate-use within the window.
- **References:** OWASP ASVS V3 (Session Management); CWE-613 (Insufficient Session
  Expiration); NIST SP 800-63B §7.

### F-8 — No encryption at rest for the database or backups; PII in plaintext

- **Description:** `darts.db` and backup files are plaintext SQLite on the host volume.
  They contain player display names (potentially real names — free-text, only length- and
  control-char-bounded), full per-dart history, the admin password hash + salt, session
  token hashes, and player PIN hashes. Backups written to `darts_data/backups` are
  unencrypted.
- **Attack Scenario:** Host disk theft, a mounted-volume misconfig, a backup copied to
  cloud storage, or lateral movement after host compromise yields the full dataset and the
  (hashed, but offline-attackable) admin/PIN secrets.
- **Likelihood:** Low (requires host/disk/backup access).
- **Business Impact:** Medium (privacy + offline hash cracking of a weak admin password).
- **Severity:** **Medium**
- **Affected Components:** SQLite file, `backup.js`/`backup-lib.js`, host volume.
- **Recommended Mitigation:** Full-disk/volume encryption on the host (LUKS) — the
  pragmatic control; optionally encrypt exported backups (age/gpg) before they leave the
  box. Treat player names as PII: consider data minimisation and a documented retention
  policy.
- **Mitigation Tradeoffs:** App-level DB encryption is heavy for `node:sqlite` (no native
  SQLCipher) — disk encryption is the better fit; encrypted backups add key management.
- **Implementation Complexity:** Low (host disk encryption) / Medium (backup encryption).
- **Estimated Security Benefit:** Medium.
- **Residual Risk:** Data exposure while the volume is mounted/decrypted on a live compromised host.
- **References:** OWASP ASVS V6 (Stored Cryptography); CWE-311/312; GDPR data-minimisation
  principles (if any real names are stored).

### F-9 — Container lacks resource limits, read-only FS, and capability drop

- **Description:** The container runs as non-root (`su-exec node`, a genuine strength) with
  `no-new-privileges:true`, but `docker-compose.yml`/`.live-test.yml` set **no**
  `mem_limit`, `pids_limit`, `ulimits`, `read_only` root filesystem, or `cap_drop`. The
  in-code comment explains the omission (the entrypoint needs CAP_CHOWN briefly), but "all
  or nothing" isn't required — most capabilities can still be dropped.
- **Attack Scenario:** A resource-exhaustion bug or a flood (F-4) that slips the app's
  logical caps can consume all host memory/PIDs since nothing bounds the container.
  Post-compromise, a writable root FS and full default capability set widen lateral
  movement / persistence options.
- **Likelihood:** Low-Medium.
- **Business Impact:** Medium (availability; blast-radius containment).
- **Severity:** **Medium**
- **Affected Components:** `docker-compose*.yml`, `Dockerfile`, `docker-entrypoint.sh`.
- **Recommended Mitigation:** Add `mem_limit`, `pids_limit`, and `ulimits` (nofile) to the
  Internet profile; run `read_only: true` with a `tmpfs` for scratch and the data volume
  writable; `cap_drop: [ALL]` then `cap_add` only what the entrypoint chown needs
  (CHOWN, DAC_OVERRIDE, SETUID, SETGID) — or move the chown out of the container so all
  caps can be dropped.
- **Mitigation Tradeoffs:** Requires testing the exact minimal capability set against a
  real bind-mounted volume (the reason it was deferred); read-only FS can surface hidden
  write paths.
- **Implementation Complexity:** Medium.
- **Estimated Security Benefit:** Medium.
- **Residual Risk:** Container-escape 0-day; kernel-level issues.
- **References:** CIS Docker Benchmark 5.x; NIST SP 800-190; MITRE ATT&CK T1611.

### F-10 — Supply chain: floating base-image tag, no pinning/scanning/SBOM/signing

- **Description:** **Major strength first:** zero runtime npm dependencies removes the
  single largest supply-chain risk class outright. Residual: the `Dockerfile` pins
  `node:22-alpine` (a floating tag, not a digest) and installs `su-exec` from Alpine
  repos; there is no image digest pin, no image scanning, no SBOM, no image signing, and
  no documented patching cadence for the base image / Node runtime.
- **Attack Scenario:** A compromised or simply outdated `node:22-alpine` tag ships a
  vulnerable OpenSSL/Node/musl; without scanning or a rebuild cadence, the exposed origin
  runs a known-vulnerable runtime indefinitely.
- **Likelihood:** Low-Medium.
- **Business Impact:** Medium (depends on the specific CVE).
- **Severity:** **Medium**
- **Affected Components:** `Dockerfile`, build/release process (absent).
- **Recommended Mitigation:** Pin the base image by digest and bump deliberately; add
  `docker scout`/Trivy scanning to a lightweight CI step; generate an SBOM; establish a
  monthly rebuild-and-redeploy cadence so runtime CVEs get patched; sign images if a
  registry is used.
- **Mitigation Tradeoffs:** Digest pinning requires a deliberate update workflow (the
  tradeoff of reproducibility vs. auto-patching — mitigate with the scan cadence).
- **Implementation Complexity:** Low-Medium.
- **Estimated Security Benefit:** Medium.
- **Residual Risk:** 0-day in the runtime between rebuilds; registry compromise.
- **References:** OWASP CI/CD Top 10; SLSA framework; NIST SP 800-218 (SSDF); CIS Docker
  Benchmark 4.x.

### F-11 — First-run setup "land-grab" window on a freshly exposed instance

- **Description:** Until the first admin is created, `GET /api/setup-required` returns true
  and `POST /api/setup` will create the first admin for *whoever calls it first* (SEC-20
  fixed the concurrency race, not the fundamental first-come-first-served nature). If an
  instance is bound to a public IP *before* setup is completed, an Internet attacker can
  claim the admin account.
- **Attack Scenario:** Operator brings up the container publicly and goes to configure it a
  few minutes later; a scanner hits `/api/setup` first and owns the instance.
- **Likelihood:** Low-Medium (narrow but real, and scanners are fast).
- **Business Impact:** High (attacker becomes admin from the start).
- **Severity:** **Medium**
- **Affected Components:** `db.isSetupRequired()`, `POST /api/setup`, deployment order.
- **Recommended Mitigation:** **Complete first-run setup before exposing the instance**
  (operational — document prominently). Better: support a bootstrap admin via env
  (`OCHE_ADMIN_USER`/`OCHE_ADMIN_PASSWORD_HASH`) so no open setup window exists, and/or
  bind setup to loopback/private first. Rate-limited already (setup bucket 10/min), which
  doesn't help the land-grab.
- **Mitigation Tradeoffs:** Env-provided bootstrap adds a secret-handling path.
- **Implementation Complexity:** Low.
- **Estimated Security Benefit:** Medium-High.
- **Residual Risk:** Operator ignores the ordering guidance.
- **References:** CWE-1188 (Insecure Default Initialization); OWASP ASVS V2.

### F-12 — No security audit log (successful logins, admin actions, restores, wipes)

- **Description:** `server_errors` records only 5xx failures (SEC-17 explicitly keeps 4xx
  and normal operations out). There is **no** record of *successful* logins, from which IP,
  admin creation/deletion, password changes, backup restores, data wipes, or player merges.
  On an Internet-exposed box this is a detection/forensics blind spot: a compromise leaves
  no trail, and F-3's fail2ban-style mitigation has no log to watch.
- **Attack Scenario:** Attacker gains admin (F-1/F-2), operates, wipes/restores — the
  operator has no way to know it happened, when, or from where, and no source data to build
  alerting or IP-banning on.
- **Likelihood:** N/A (this is a gap, not an exploit) — it *amplifies* every other finding.
- **Business Impact:** Medium-High (blind detection/response; no forensics).
- **Severity:** **Medium**
- **Affected Components:** `server.js` (auth routes), `db.js` (a new `audit_log` table).
- **Recommended Mitigation:** Add an append-only `audit_log` (timestamp, event, admin id/
  username, source IP, outcome) covering login success/failure, logout, admin CRUD,
  password change, PIN set/remove, backup restore/wipe/merge; surface it in Settings
  (admin-only) like `server_errors`; make it consumable by fail2ban. Follow the codebase's
  own convention that new security surfaces get committed tests.
- **Mitigation Tradeoffs:** Auth logs contain IPs (minor PII) and need retention/rotation
  bounds (mirror `server_errors`' 500-row prune).
- **Implementation Complexity:** Low-Medium.
- **Estimated Security Benefit:** Medium-High (foundational for detection).
- **Residual Risk:** Log tampering after full host compromise (ship logs off-box to
  counter).
- **References:** OWASP Top 10 A09:2021 (Security Logging & Monitoring Failures); OWASP
  API Security; NIST SP 800-53 AU family; CWE-778 (Insufficient Logging).

### F-13 — `OCHE_REQUIRE_AUTH=false` is a one-variable path to a fully open public instance

- **Description:** The zero-trust default is correct (`REQUIRE_AUTH` fails closed on
  unrecognised values), and `docker-compose.live-test.yml` sets it `true`. But a single env
  flip to `false` opens *every* write endpoint to the anonymous Internet (and re-exposes the
  LAN-trust-only findings SEC-19/22/25). There is no guard that refuses to run auth-off
  while bound to a non-loopback/public interface.
- **Attack Scenario:** Operator copies a LAN compose snippet (many in this repo legitimately
  use `false`) onto the public box; every write — create games, poison stats, fire the HA
  webhook, delete data — is open to anyone.
- **Likelihood:** Low-Medium (copy-paste misconfiguration is common).
- **Business Impact:** High if it happens.
- **Severity:** **Medium** (misconfiguration-gated).
- **Affected Components:** `server.js` `REQUIRE_AUTH`; compose files; docs.
- **Recommended Mitigation:** Emit a **loud, repeated** startup warning (or refuse to start
  without an explicit `OCHE_I_UNDERSTAND_AUTH_IS_OFF=true`) when auth is off; document that
  auth-off is LAN-only and never valid on a public interface.
- **Mitigation Tradeoffs:** A hard refusal could surprise a deliberate trusted-LAN user;
  gate the refusal on detecting a public bind or make it override-able.
- **Implementation Complexity:** Low.
- **Estimated Security Benefit:** Medium.
- **Residual Risk:** Operator sets the override without understanding it.
- **References:** CWE-1188; OWASP A05:2021 (Security Misconfiguration).

### F-14 — Home Assistant integration: outbound SSRF surface (well-guarded) — verify config

- **Description:** If HA integration is configured, the app makes server-initiated outbound
  requests to an admin-set URL. `netguard.js` is a **strong** egress guard (blocks loopback,
  0.0.0.0/8, link-local incl. 169.254.169.254 metadata, IPv6 `::`/`::1`/fe80::/IPv4-mapped
  in both dotted and hex forms; resolves once to close DNS-rebinding; optional private-range
  block via `HA_BLOCK_PRIVATE`). Residual: private ranges are *allowed* by default (correct
  for LAN HA, but on a public box means the app can still reach the host's private network),
  and the HA token (if stored) must be write-only/never returned to the client.
- **Attack Scenario:** A compromised admin points `ha_url` at an internal service in the
  origin's private network (allowed by default) to pivot/scan, unless `HA_BLOCK_PRIVATE` is
  set.
- **Likelihood:** Low (requires admin; guard already blocks the high-value metadata/loopback
  targets).
- **Business Impact:** Low-Medium.
- **Severity:** **Low**
- **Affected Components:** `netguard.js`, HA webhook code, settings storage.
- **Recommended Mitigation:** Set `HA_BLOCK_PRIVATE=true` on any Internet-exposed instance
  that doesn't specifically need to reach a private HA; confirm the HA token is stored
  write-only and never serialised back to the client (the security-hardening checklist
  already flags this standing question); confirm it's excluded from any export.
- **Mitigation Tradeoffs:** `HA_BLOCK_PRIVATE=true` breaks a genuinely LAN-hosted HA target.
- **Implementation Complexity:** Low (config).
- **Estimated Security Benefit:** Low-Medium.
- **Residual Risk:** Admin-authorised outbound to an allowed host.
- **References:** OWASP A10:2021 (SSRF); CWE-918; CAPEC-664.

### F-15 — Public read endpoints expose all stats/scoreboard unauthenticated (by design) — confirm intent

- **Description:** Reads are intentionally public (`GET /api/players`, stats, `/api/live`,
  `/api/live/stream`, leaderboards) so the scoreboard works without login. On the Internet
  this means **anyone** can enumerate all player names and full statistics and watch the
  live feed. `?limit=` params were bounded (SEC-23). This is a deliberate design choice, not
  a bug — but on a public deployment it is a privacy decision worth making consciously.
- **Attack Scenario:** Anyone on the Internet reads the full roster (possibly real names)
  and all play history; scrapers harvest it.
- **Likelihood:** High (it's simply open).
- **Business Impact:** Low-Medium (privacy, depending on whether names are real).
- **Severity:** **Low**
- **Affected Components:** all public `GET` routes.
- **Recommended Mitigation:** Decide explicitly whether the public instance should expose
  reads at all. If not, add an optional "require auth for reads too" mode, or gate the whole
  app behind the tunnel/WAF (F-4) so only intended viewers reach it. Use display-only
  nicknames rather than real names (data minimisation).
- **Mitigation Tradeoffs:** Auth-on-reads breaks the no-login scoreboard use case.
- **Implementation Complexity:** Low-Medium.
- **Estimated Security Benefit:** Low-Medium (privacy).
- **Residual Risk:** Anything intentionally public is public.
- **References:** OWASP API3:2023 (Broken Object Property Level Authorization — informational);
  GDPR data-minimisation.

---

## 8. Attack Scenarios

**Scenario A — Credential stuffing → full takeover (chains F-2, F-3, F-1, F-12).**
An opportunistic botnet finds the exposed `/api/login`, spreads spray attempts across an
IPv6 /64 to stay under per-IP limits, and lands a reused admin password (no MFA, no breach
check, 8-char minimum). With a valid 30-day session it creates a second admin, exfiltrates
the roster/history, then wipes or restores the DB. The operator has no audit log and cannot
tell what happened or from where. **Primary breakers:** MFA (F-2) and an audit log +
fail2ban (F-12/F-3); tunnel/WAF (F-4) removes the exposed endpoint entirely.

**Scenario B — TLS misconfig → cookie replay (F-1, F-7).** Operator exposes the origin with
an HTTP-only proxy (or forgets `COOKIE_SECURE`). An on-path attacker on the admin's network
captures the 30-day `oche_session` cookie and replays it for a month; no rotation or
active-session UI reveals the rogue session. **Breakers:** enforced HTTPS + `Secure` +
shorter TTL + session-revocation UI.

**Scenario C — Future XSS reintroduction (F-5, F-15).** A new feature echoes an
unauthenticated `POST /api/players` name into the DOM unescaped (the exact class fixed in
SEC-12/15/18). Because the public read/write of player names is open and the CSP allows
`unsafe-inline` scripts, the payload runs in the admin's browser and drives in-page admin
actions. **Breakers:** nonce CSP + the standing output-encoding test discipline.

**Scenario D — Availability flood (F-4, F-9).** A cheap L7 flood saturates the single Node
event loop or exhausts host memory/PIDs (no container limits); the scoreboard and admin go
dark. **Breakers:** edge DDoS/WAF + container resource limits.

**Scenario E — Land-grab (F-11).** Instance is published before first-run setup; a scanner
POSTs `/api/setup` and becomes admin. **Breaker:** set up before exposing, or env-bootstrap
the admin.

---

## 9. Quick Wins

Low effort, high marginal value — do these before direct exposure:

1. **Front the origin with Cloudflare Tunnel (or a WAF/CDN)** so there's no open inbound
   port and DDoS/abuse is absorbed upstream. *(F-4, F-3, F-15; also the single biggest risk
   reducer.)*
2. **Guarantee HTTPS + `COOKIE_SECURE=true`** via a bundled auto-TLS reverse-proxy config
   (Caddy). Make it the documented default for any Internet profile. *(F-1)*
3. **Add a security audit log** (login success/failure + source IP, admin actions, restore/
   wipe/merge), surfaced in Settings and fail2ban-consumable. *(F-12, enables F-3)*
4. **Complete first-run setup before exposing**, and document it prominently; ideally add an
   env-bootstrap admin. *(F-11)*
5. **Add container resource limits** (`mem_limit`, `pids_limit`, `ulimits`) and set
   `HA_BLOCK_PRIVATE=true` if HA isn't LAN-hosted. *(F-9, F-14)*

Plus: raise the minimum admin password length to 12–14 and add a loud auth-off warning
(F-2 interim, F-13) — both are a few lines.

---

## 10. Long-Term Improvements

1. **MFA / WebAuthn (passkeys) for the admin account** — the definitive fix for F-2/
   Scenario A. TOTP is achievable with only built-in `crypto`.
2. **Nonce-based CSP** and migration off inline `onclick` handlers — closes F-5 properly
   (structural frontend refactor).
3. **Session hardening** — shorter/sliding TTL for the Internet profile, token rotation,
   active-sessions/revoke UI (F-7).
4. **Supply-chain maturity** — digest-pinned base image, Trivy/Scout scanning in CI, SBOM,
   monthly rebuild cadence, image signing (F-10).
5. **Container hardening to CIS** — read-only root FS + tmpfs, `cap_drop: [ALL]` + minimal
   `cap_add` (or move chown out of the container) (F-9).
6. **Encryption at rest** — host disk encryption (LUKS) and encrypted off-box backups
   (F-8).
7. **Encrypt/verify DB restore provenance** and require MFA for restore/wipe/merge (F-6).

---

## 11. Recommended Security Architecture

**Preferred (lowest attack surface):**

```
Admin/Viewer ──HTTPS──► Cloudflare (WAF + DDoS + TLS)
                            │  (Cloudflare Tunnel, outbound-only)
                            ▼
                    cloudflared ──► Oche container (localhost only, no public port)
                            │
                            ▼
                 Docker network (isolated) ──► /data volume (LUKS-encrypted host disk)
```

- **No open inbound port on the host** — the tunnel dials out; the origin is unreachable
  directly, neutralising scanners, direct DDoS, and F-4/F-11 exposure.
- **Cloudflare Access (or equivalent) in front of `/api/login` and admin paths** — adds an
  identity layer (SSO/one-time-PIN) *before* the app's own auth, effectively giving MFA and
  rate limiting for free while F-2 is implemented in-app.
- **Oche binds to loopback only**; `OCHE_REQUIRE_AUTH=true`, `COOKIE_SECURE=true`,
  `TRUST_PROXY=true` (trusting only the tunnel), `HA_BLOCK_PRIVATE=true`.
- **Container:** non-root (already), resource-limited, read-only FS + tmpfs, minimal caps.
- **Host:** disk encryption, minimal SSH (key-only, non-default, firewalled), automatic OS
  security updates, off-box encrypted backups, monthly image rebuilds.

**Acceptable alternative (if no third-party edge):** dedicated reverse proxy (Caddy,
auto-TLS) on the same host, origin firewalled to accept only the proxy, `fail2ban` watching
the new audit log, and the same container/host hardening. This keeps an open 443 and so
retains more of F-4 than the tunnel approach.

**Strongest challenge to the premise:** ask whether this test server needs to be *open to
the Internet* at all, versus reachable over **Tailscale/WireGuard** by the handful of people
who actually use it. A mesh-VPN gate removes essentially the entire unauthenticated Internet
attack surface (F-1 through F-4, F-11, F-13, F-15) at near-zero cost and is, for a
household darts app with a small known audience, very likely the *better architecture* than
public exposure plus a WAF. Recommend VPN-gating unless there is a concrete requirement for
anonymous public reach.

---

## 12. Security Hardening Checklist

**Edge / network**
- [ ] Origin not directly exposed (Cloudflare Tunnel / VPN / firewalled proxy).
- [ ] WAF + DDoS protection in front, or VPN-gated.
- [ ] TLS terminates in front; valid auto-renewing cert; TLS 1.2+ only.
- [ ] Origin firewalled to accept only the proxy/tunnel; IPv6 exposure considered.

**App config**
- [ ] `OCHE_REQUIRE_AUTH=true`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` (trusting only the
      proxy), `HA_BLOCK_PRIVATE=true` (unless LAN HA needed).
- [ ] First-run admin created **before** exposure; strong (12+ char) unique password.
- [ ] MFA/second-factor in place (in-app or via edge Access) — priority.

**Container / host**
- [ ] Resource limits (`mem_limit`, `pids_limit`, `ulimits`).
- [ ] `read_only` root FS + tmpfs; `cap_drop: [ALL]` + minimal `cap_add`; `no-new-privileges`
      (already set).
- [ ] Base image digest-pinned; image scanned; monthly rebuild/redeploy cadence.
- [ ] Host disk encryption; hardened SSH (key-only, firewalled); auto security updates.

**Detection / recovery**
- [ ] Audit log for auth + admin actions, surfaced and off-boxed; fail2ban wired to it.
- [ ] Automated, tested, off-box, encrypted backups; documented restore drill.
- [ ] Startup TLS/auth warnings monitored, not ignored.

---

## 13. Residual Risks

Even with every recommendation implemented:

- **Compromise of the edge/identity provider** (Cloudflare/VPN) or a real admin credential
  + MFA phish still yields access — MFA raises the bar, it doesn't eliminate the risk.
- **0-day** in Node, `node:sqlite`, the base image, or the kernel between rebuilds.
- **Malicious authenticated admin** retains full data control (restore/wipe) by design.
- **Sufficiently resourced DDoS** can still degrade availability despite a WAF.
- **DOM-based XSS** remains possible even with a nonce CSP if unsafe JS sinks are introduced.
- **Data exposure while the host is live and volumes are decrypted** during an active
  compromise (encryption at rest protects data-at-rest, not a running compromised host).

---

## 14. Assumptions

This assessment is grounded in the **application code and Docker/compose artifacts present
in the repository** at version 0.15.0. The following were **not** verifiable from the code
and are assumed/unknown — they materially affect the real-world risk and should be confirmed
before exposure:

- Actual reverse-proxy presence and TLS configuration (ciphers, protocol versions, HSTS
  preload).
- Host OS hardening, patch cadence, SSH configuration, and local firewall rules.
- DNS provider security (registrar lock, DNSSEC) and domain ownership.
- Whether a WAF/CDN/tunnel is or will be present.
- Container runtime flags actually applied at deploy time (compose files show intent, not
  the running config).
- Whether player names in practice contain real PII.
- Backup destination, encryption, and off-box storage.
- Whether the Home Assistant integration is enabled and how its token is stored.
- Physical security of the host.

Where these are unknown, findings assume the **less favourable** plausible configuration and
say so.

---

## 15. Confidence Level

**High** confidence in the *application-layer* assessment: the codebase is small, dependency-
free, and was read directly (auth, server routing/headers/rate-limiting, egress guard, DB
query construction, container/entrypoint, and the full SEC-1…SEC-25 audit history).

**Medium** confidence in the *deployment/operations* assessment, because TLS, host, network,
DNS, WAF, and runtime-flag realities are outside the repository and could not be observed
(see §14). The infrastructure findings are therefore framed as "verify before exposure"
rather than confirmed defects. Providing the actual reverse-proxy config, host hardening
details, and deploy-time container flags would raise this to High and likely adjust several
Medium findings up or down.

---

## 16. References

- **OWASP Top 10:2021** — A01 (Broken Access Control), A02 (Cryptographic Failures), A03
  (Injection/XSS), A05 (Security Misconfiguration), A07 (Identification & Authentication
  Failures), A09 (Logging & Monitoring Failures), A10 (SSRF).
- **OWASP API Security Top 10:2023** — API2 (Broken Authentication), API4 (Unrestricted
  Resource Consumption), API5 (Broken Function Level Authorization).
- **OWASP ASVS 4.0** — V2 (Authentication), V3 (Session Management), V6 (Stored
  Cryptography), V9 (Communications), V12 (Files/Resources).
- **NIST** — SP 800-63B (Digital Identity/Auth), SP 800-52r2 (TLS), SP 800-190 (Container
  Security), SP 800-53 (AU/SC/CP control families), SP 800-218 (SSDF).
- **CIS** — Docker Benchmark, CIS Controls v8 (esp. 4, 6, 8, 11, 16).
- **CWE** — 79, 287/308, 307, 311/312, 319, 434, 502, 521, 613, 778, 918, 1188.
- **CAPEC** — 16, 63, 664.
- **MITRE ATT&CK** — T1110 (Brute Force), T1557 (AiTM), T1498/T1499 (DoS), T1611 (Escape to
  Host).
- **Internal** — `docs/security-audit-roadmap.md` (SEC-1…SEC-25), `docs/security-hardening-roadmap.md`,
  `docs/archive/admin-login-backoff-roadmap.md`, `docs/archive/backups-roadmap.md`, `REFERENCE.md`
  (security model), `docs/security/AI Risk Assessment Prompt.md` (this methodology).

---

*Generated using the standing methodology in `docs/security/AI Risk Assessment Prompt.md`.
This is an AI-generated assessment for a self-hosted, owner-operated application; it is a
prioritisation aid, not a substitute for a human penetration test against the actual
deployed infrastructure.*
