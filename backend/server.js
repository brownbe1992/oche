'use strict';
/* =============================================================================
   Oche server.

   Dependency-free: uses only Node's built-in `http` module and the database
   layer in db.js (which uses Node's built-in SQLite). Serves the single-page
   frontend AND a small JSON API on the same port, so there's no CORS to worry
   about and only one container to run.

       GET  /                      -> the app (frontend/index.html)
       GET  /api/health            -> { ok: true }
       GET  /api/players           -> [ { name, out } ]
       POST /api/players           -> add a player           { name, out }
       PUT  /api/players/rename    -> rename                 { from, to }
       PUT  /api/players/out       -> set finish rule        { name, out }
       DEL  /api/players           -> delete (?name=...)
       GET  /api/stats             -> computed stats per player
       POST /api/games             -> start a game           { category, legsPerSet, setsPerGame, players:[names] } -> { gameId }
       POST /api/games/:id/turns   -> record one turn        { player, set, leg, scored, trebleLess, bust, checkout, checkoutPoints }
       POST /api/games/:id/complete-> finish a game          { winner }
       POST /api/reset             -> wipe all games/turns (players kept)        [admin]
       POST /api/wipe-all          -> wipe all players/games/stats (admins kept) [admin]

       GET  /api/setup-required    -> { required } - true until the first admin exists
       POST /api/setup             -> create the first admin  { username, password } (only while setup-required)
       POST /api/login             -> { username, password } -> sets session cookie
       POST /api/logout            -> clears session cookie
       GET  /api/me                -> { loggedIn, username? }
       GET/POST/DELETE /api/admins -> manage admin accounts                      [admin]
       PUT  /api/admins/password   -> change an admin's password                 [admin]
       POST /api/players/verify-pin-> { name, pin } -> verify a player's PIN (public)
       PUT  /api/players/pin       -> set/reset a player's PIN  { name, pin }    [admin]
       DEL  /api/players/pin       -> remove a player's PIN (?name=...)         [admin]
       GET  /api/settings/scoreboard-layout -> { layout: 'full'|'compact'|'minimal' } (public)
       GET  /api/settings/default-input     -> { input: 'pad'|'board' } (public)
       GET  /api/settings/colorblind-mode   -> { enabled } (public)
       GET  /api/settings/voice-announcements -> { enabled, turnScore, noScore, checkoutReq, oneEighty, bigFish, matchProgress } (public)
       GET  /api/settings/card-tagline      -> { tagline } (public)

       POST /api/badges/award      -> { player, badgeId, once } -> { newlyEarned, count } (public)
       POST /api/badges/revoke     -> { player, badgeId } -> { count } (public, used by Undo Last Turn)
       GET  /api/players/badges    -> (?name=...) -> [ { badge_id, count, earned_at } ] (public)
       GET  /api/players/h2h-summary -> (?player=...&opponent=...&excludeGameId=) -> { totalGames, previousWinner } (public)
       GET  /api/players/around-the-world -> (?name=...) -> { hit, count, total } (public)
       POST /api/challenges/start  -> { player, gameId, challengeDate, format, target } (public)
       POST /api/challenges/complete -> { player, challengeDate, resultDarts } (public)
       GET  /api/challenges/status -> (?player=...&date=YYYY-MM-DD) -> { today, streak, history } (public)

   Routes marked [admin] require a logged-in admin session (cookie set by /api/login).
   Set COOKIE_SECURE=true when serving over HTTPS (e.g. behind a reverse proxy) so the
   session cookie gets the Secure flag; leave unset for plain-HTTP LAN deployments.

   Set OCHE_REQUIRE_AUTH=true to require an admin session for ALL write endpoints
   (creating players/games, recording turns, badges, challenges, the live feed) — reads
   stay public. Default off (open LAN behavior). GET /api/auth-config reports this flag
   so the frontend can gate gameplay behind login when it's on.

   Set TRUST_PROXY=true only when this server sits behind a reverse proxy you control,
   so the per-IP rate limiter uses X-Forwarded-For instead of the raw socket address —
   otherwise a client could spoof that header to evade or frame another IP.
   Set HA_BLOCK_PRIVATE=true to additionally block outbound Home Assistant requests to
   private/LAN address ranges (loopback and link-local/metadata addresses are always
   blocked regardless — see backend/netguard.js).
   ============================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db.js');
const auth = require('./auth.js');
const netguard = require('./netguard.js');

const PORT = process.env.PORT || 8046;
// When OCHE_REQUIRE_AUTH=true, every state-changing (write) API endpoint requires a
// logged-in admin session. Reads (stats, scoreboard, settings-for-display) stay public
// so viewing and the live scoreboard still work for everyone. Default OFF so existing
// LAN deployments are unaffected on upgrade; turn ON for any internet-exposed install.
const REQUIRE_AUTH = String(process.env.OCHE_REQUIRE_AUTH || '').toLowerCase() === 'true';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

// docs/security-audit-roadmap.md SEC-10: applied to every response (API and static).
// Both frontend HTML files use inline <script> and inline onclick handlers, and load
// Google Fonts cross-origin, so a strict nonce-based CSP would require a larger
// refactor (tracked separately) — 'unsafe-inline' still blocks an injected
// <script src="https://evil.example/x.js"> from a different origin, which is the
// realistic risk for a single-file app with no user-supplied HTML rendering.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

// docs/security-audit-roadmap.md SEC-3: derive the client IP for rate limiting.
// X-Forwarded-For is only honored when TRUST_PROXY=true (i.e. a trusted reverse proxy
// sets it) — otherwise any client could put an arbitrary value in that header to
// evade the limiter or frame another IP.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Reusable in-memory per-IP, per-bucket fixed-window rate limiter. Buckets are named
// so different endpoint classes (e.g. a strict "auth" budget vs. a loose "global"
// budget) don't share or interfere with each other. Resets on process restart and
// isn't shared across replicas — acceptable for this single-process, self-hosted app.
const rlBuckets = new Map(); // `${bucket}:${ip}` -> { count, resetAt }
function rateLimit(bucket, ip, max, windowMs) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  let e = rlBuckets.get(key);
  if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; rlBuckets.set(key, e); }
  e.count++;
  return e.count <= max;
}
function tooManyRequests(res, retryAfterSec) {
  send(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retryAfterSec) });
}
// Periodic prune so rlBuckets doesn't grow unbounded from one-off IPs.
const rlPrune = setInterval(() => {
  const now = Date.now();
  for (const [key, e] of rlBuckets) if (e.resetAt <= now) rlBuckets.delete(key);
}, 60000);
if (rlPrune.unref) rlPrune.unref();

// Returns the logged-in admin ({id, username}) for this request, or null.
function currentAdmin(req) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.SESSION_COOKIE];
  if (!token) return null;
  return db.getSessionAdmin(token);
}

// Call at the top of any admin-only route. Sends 401 and returns null if not authenticated.
function requireAdmin(req, res) {
  const admin = currentAdmin(req);
  if (!admin) { send(res, 401, { error: 'Admin login required' }); return null; }
  return admin;
}

// Call at the top of any state-changing (write) route. When OCHE_REQUIRE_AUTH is off
// this is a no-op (returns true, preserving open LAN behavior). When on, it requires a
// logged-in admin, sending 401 and returning false if absent. Returns true when the
// request may proceed.
function requireWrite(req, res) {
  if (!REQUIRE_AUTH) return true;
  return !!requireAdmin(req, res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1e6) {
        // destroy() with an error emits 'error' below, so the promise settles instead
        // of hanging forever (destroy() with no argument emits neither 'end' nor 'error').
        const err = new Error('Request body too large');
        err.status = 413;
        req.destroy(err);
      }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/display') rel = '/display.html';     // friendly URL for the scoreboard
  const filePath = path.normalize(path.join(FRONTEND_DIR, rel));
  // Path-traversal guard via path.relative: a plain string startsWith(FRONTEND_DIR)
  // check would also accept a sibling dir whose name merely starts with "frontend"
  // (e.g. frontend-backup). relative() is "" for the dir itself and starts with ".."
  // only when the resolved path escapes it — the robust form.
  const relToRoot = path.relative(FRONTEND_DIR, filePath);
  if (relToRoot !== '' && (relToRoot.startsWith('..') || path.isAbsolute(relToRoot))) {
    return send(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // single-page app: fall back to index.html for unknown non-API paths
      return fs.readFile(path.join(FRONTEND_DIR, 'index.html'), (e2, idx) =>
        e2 ? send(res, 404, { error: 'Not found' }) : send(res, 200, idx, { 'Content-Type': MIME['.html'] }));
    }
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  });
}

/* ---------- live scoreboard channel (Server-Sent Events) ----------
   The controller (iPad) POSTs the current game state to /api/live whenever it
   changes. Any scoreboard screens listening on /api/live/stream receive it
   immediately. State is kept only in memory — it's a live view, not a record. */
const liveClients = new Set();
let liveState = { active: false, ts: Date.now() };
function liveBroadcast() {
  const line = `data: ${JSON.stringify(liveState)}\n\n`;
  for (const res of liveClients) { try { res.write(line); } catch (e) { /* dropped */ } }
}
const heartbeat = setInterval(() => {
  for (const res of liveClients) { try { res.write(': ping\n\n'); } catch (e) {} }
}, 25000);
if (heartbeat.unref) heartbeat.unref();

// docs/security-audit-roadmap.md SEC-2: /api/live/stream is a public, unauthenticated
// GET (the display screen isn't logged in), so it isn't gated by requireWrite/
// requireAdmin — cap it directly instead, both in total and per source IP, so an
// unauthenticated client can't exhaust file descriptors/memory by opening unlimited
// SSE connections.
const MAX_SSE_TOTAL = 50;
const MAX_SSE_PER_IP = 5;
const sseByIp = new Map(); // ip -> open connection count

// SEC-2: POST /api/live accepts an arbitrary object today, bounded only by
// readJson()'s 1MB request-body cap, and re-broadcasts it verbatim to every
// connected screen. Restrict it to the fields liveSnapshot() in frontend/index.html
// actually produces (and display.html reads) and cap its serialized size, so a
// malformed/oversized payload can't bloat every broadcast.
const ALLOWED_LIVE_KEYS = new Set([
  'active', 'gameType', 'category', 'legsPerSet', 'setsPerGame', 'setNo', 'legNo',
  'currentIndex', 'players', 'darts', 'checkout', 'status', 'message', 'achievement',
  'gameOneEighties', 'gameBigFish', 'gameBusts', 'legSummary', 'practice', 'done',
  'lastTurnEvent', 'matchResult', 'legStart', 'checkoutTarget', 'turnSeq', 'ts',
]);
const MAX_LIVE_BYTES = 65536;
// Returns the sanitized state, or null if it's over the size cap (caller sends 413).
function sanitizeLiveState(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { active: false, ts: Date.now() };
  const out = {};
  for (const k of Object.keys(b)) if (ALLOWED_LIVE_KEYS.has(k)) out[k] = b[k];
  if (out.ts == null) out.ts = Date.now();
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_LIVE_BYTES) return null;
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const m = req.method;
    const ip = clientIp(req);

    // SEC-3: loose global budget on every request, ahead of any routing/work.
    if (!rateLimit('global', ip, 300, 60000)) return tooManyRequests(res, 60);

    if (!p.startsWith('/api/')) return serveStatic(req, res);

    if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true });
    // Public: lets the frontend know whether writes require an admin login, so it can
    // gate gameplay/roster changes behind login when OCHE_REQUIRE_AUTH is enabled.
    if (p === '/api/auth-config' && m === 'GET') return send(res, 200, { requireAuth: REQUIRE_AUTH });

    // ----- auth -----
    if (p === '/api/setup-required' && m === 'GET') return send(res, 200, { required: db.isSetupRequired() });
    if (p === '/api/setup' && m === 'POST') {
      // SEC-1: strict budget ahead of the scrypt hash this performs, so flooding
      // this endpoint can't pin the event loop. Own bucket (not shared with login/
      // verify-pin) — those are separate concerns with very different normal-use
      // request rates (verify-pin in particular fires every time a PIN player is
      // picked during ordinary gameplay) and shouldn't throttle each other.
      if (!rateLimit('setup', ip, 10, 60000)) return tooManyRequests(res, 60);
      const b = await readJson(req);
      const result = await db.createFirstAdmin(b.username, b.password);
      return send(res, 200, result);
    }
    if (p === '/api/login' && m === 'POST') {
      if (!rateLimit('login', ip, 10, 60000)) return tooManyRequests(res, 60);
      const b = await readJson(req);
      const { token, username } = await db.login(b.username, b.password);
      return send(res, 200, { ok: true, username }, { 'Set-Cookie': auth.sessionCookieHeader(token, auth.SESSION_TTL_MS / 1000) });
    }
    if (p === '/api/logout' && m === 'POST') {
      const cookies = auth.parseCookies(req);
      db.logout(cookies[auth.SESSION_COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearSessionCookieHeader() });
    }
    if (p === '/api/me' && m === 'GET') {
      const admin = currentAdmin(req);
      return send(res, 200, admin ? { loggedIn: true, username: admin.username } : { loggedIn: false });
    }

    if (p === '/api/admins' && m === 'GET')  { if (!requireAdmin(req, res)) return; return send(res, 200, db.listAdmins()); }
    if (p === '/api/admins' && m === 'POST') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, await db.createAdmin(b.username, b.password));
    }
    if (p === '/api/admins' && m === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, db.deleteAdmin(url.searchParams.get('id')));
    }
    if (p === '/api/admins/password' && m === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, await db.changeAdminPassword(b.id, b.password));
    }

    // ----- player PINs -----
    if (p === '/api/players/verify-pin' && m === 'POST') {
      if (!rateLimit('pin', ip, 10, 60000)) return tooManyRequests(res, 60);
      const b = await readJson(req);
      return send(res, 200, await db.verifyPlayerPin(b.name, b.pin));
    }
    if (p === '/api/players/pin' && m === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, await db.setPlayerPin(b.name, b.pin));
    }
    if (p === '/api/players/pin' && m === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, db.removePlayerPin(url.searchParams.get('name')));
    }

    // ----- live scoreboard channel -----
    if (p === '/api/live' && m === 'GET') return send(res, 200, liveState);
    if (p === '/api/live' && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req);
      const sanitized = sanitizeLiveState(b);
      if (sanitized === null) return send(res, 413, { error: 'Live payload too large' });
      liveState = sanitized;
      liveBroadcast();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/live/stream' && m === 'GET') {
      if (liveClients.size >= MAX_SSE_TOTAL) return send(res, 503, { error: 'Too many live connections' });
      const ipSseCount = sseByIp.get(ip) || 0;
      if (ipSseCount >= MAX_SSE_PER_IP) return send(res, 503, { error: 'Too many live connections from this address' });
      sseByIp.set(ip, ipSseCount + 1);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',   // disable proxy buffering so events arrive immediately
        ...SECURITY_HEADERS,
      });
      res.write(`data: ${JSON.stringify(liveState)}\n\n`);   // current state right away
      liveClients.add(res);
      req.on('close', () => {
        liveClients.delete(res);
        const remaining = (sseByIp.get(ip) || 1) - 1;
        if (remaining <= 0) sseByIp.delete(ip); else sseByIp.set(ip, remaining);
      });
      return; // keep the connection open
    }

    if (p === '/api/players' && m === 'GET')  return send(res, 200, db.listPlayers());
    if (p === '/api/players' && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.addPlayer(b.name, b.out, { pin: b.pin, dartWeight: b.dartWeight }));
    }
    if (p === '/api/players/rename' && m === 'PUT')      { if (!requireWrite(req, res)) return; const b = await readJson(req); return send(res, 200, db.renamePlayer(b.from, b.to)); }
    if (p === '/api/players/out' && m === 'PUT')         { if (!requireWrite(req, res)) return; const b = await readJson(req); return send(res, 200, db.setOut(b.name, b.out)); }
    if (p === '/api/players/dart-weight' && m === 'PUT') { if (!requireWrite(req, res)) return; const b = await readJson(req); return send(res, 200, db.setDartWeight(b.name, b.weight)); }
    if (p === '/api/players/dart-weights' && m === 'GET') return send(res, 200, db.getDartWeights(url.searchParams.get('name')));
    if (p === '/api/players' && m === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, db.deletePlayer(url.searchParams.get('name')));
    }
    if (p === '/api/players/stats' && m === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      const mode = url.searchParams.get('mode');
      if (!['h2h','practice','all'].includes(mode)) return send(res, 400, { error: 'mode must be h2h, practice, or all' });
      return send(res, 200, db.clearPlayerStats(url.searchParams.get('name'), mode));
    }

    if (p === '/api/summary'       && m === 'GET') return send(res, 200, db.getSummary());
    if (p === '/api/home-extra'    && m === 'GET') return send(res, 200, db.getHomeExtra());
    if (p === '/api/top-finishes'  && m === 'GET') return send(res, 200, db.getTopFinishesAll(10, url.searchParams.get('mode')));
    if (p === '/api/stats/180s'         && m === 'GET') return send(res, 200, db.getOneEightyStats(url.searchParams.get('mode')));
    if (p === '/api/stats/big-fish'     && m === 'GET') return send(res, 200, db.getBigFishStats(url.searchParams.get('mode')));
    if (p === '/api/stats/nine-darters' && m === 'GET') return send(res, 200, db.getNineDarterStats(url.searchParams.get('mode')));
    if (p === '/api/stats' && m === 'GET')  return send(res, 200, db.computeStats());
    if (p === '/api/players/top-finishes' && m === 'GET') {
      const mode = url.searchParams.get('mode');
      return send(res, 200, db.getTopFinishes(url.searchParams.get('name'), mode));
    }
    if (p === '/api/players/h2h' && m === 'GET') {
      return send(res, 200, db.getH2HRecord(url.searchParams.get('p1'), url.searchParams.get('p2')));
    }
    if (p === '/api/players/personal-bests' && m === 'GET') {
      const mode = url.searchParams.get('mode');
      return send(res, 200, db.getPersonalBests(url.searchParams.get('name'), mode));
    }
    if (p === '/api/players/stat-bubbles' && m === 'GET') {
      const mode = url.searchParams.get('mode');
      return send(res, 200, db.getPlayerStatBubbles(url.searchParams.get('name'), mode));
    }
    if (p === '/api/players/checkout-route' && m === 'GET') {
      const score = url.searchParams.get('score');
      if (!score) return send(res, 400, { error: 'score required' });
      return send(res, 200, db.getCheckoutRoutes(url.searchParams.get('name'), score, url.searchParams.get('mode')));
    }

    if (p === '/api/players/dart-analytics' && m === 'GET') {
      const mode = url.searchParams.get('mode');
      return send(res, 200, db.getDartAnalytics(url.searchParams.get('name'), mode));
    }

    if (p === '/api/players/avg-history' && m === 'GET') {
      const name = url.searchParams.get('name');
      const period = url.searchParams.get('period') || 'month';
      const metric = url.searchParams.get('metric') || 'avg';
      const validPeriods = ['today', 'week', 'month', 'year', 'all', 'custom'];
      if (!validPeriods.includes(period)) return send(res, 400, { error: 'Invalid period' });
      const opts = {};
      if (period === 'custom') {
        const start = url.searchParams.get('start') || '';
        const end   = url.searchParams.get('end')   || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
          return send(res, 400, { error: 'start and end must be YYYY-MM-DD' });
        opts.start = start;
        opts.end   = end;
      }
      const weight = url.searchParams.get('weight');
      if (weight && /^\d+$/.test(weight)) opts.dartWeight = Number(weight);
      const mode = url.searchParams.get('mode');
      if (mode === 'h2h' || mode === 'practice') opts.mode = mode;
      const tz = url.searchParams.get('tz');   // client UTC offset in minutes, for local-time bucketing
      if (tz && /^-?\d{1,4}$/.test(tz)) { const n = Number(tz); if (n >= -840 && n <= 840) opts.tz = n; }
      return send(res, 200, db.getMetricHistory(name, metric, period, opts));
    }
    if (p === '/api/reset' && m === 'POST') { if (!requireAdmin(req, res)) return; return send(res, 200, db.resetStats()); }
    if (p === '/api/wipe-all' && m === 'POST') { if (!requireAdmin(req, res)) return; return send(res, 200, db.wipeAllData()); }

    if (p === '/api/settings' && m === 'GET')  { if (!requireAdmin(req, res)) return; return send(res, 200, db.getSettings()); }
    // Public (no-auth) read of just the dart-timing flag — every device running the
    // scorer needs this during gameplay, not just an admin's browser.
    if (p === '/api/settings/dart-timing' && m === 'GET') { return send(res, 200, db.getDartTimingEnabled()); }
    // Public (no-auth) read of the scoreboard layout — the /display screen isn't
    // logged in as admin, it just needs to know which preset to render.
    if (p === '/api/settings/scoreboard-layout' && m === 'GET') { return send(res, 200, db.getScoreboardLayout()); }
    // Public (no-auth) read of the default scoring input — every device scoring a
    // game needs this, not just an admin's browser.
    if (p === '/api/settings/default-input' && m === 'GET') { return send(res, 200, db.getDefaultScoringInput()); }
    // Public (no-auth) read of the colorblind-mode flag — both the controller and the
    // /display screen need this, and neither is necessarily logged in as admin.
    if (p === '/api/settings/colorblind-mode' && m === 'GET') { return send(res, 200, db.getColorblindMode()); }
    // Public (no-auth) read of voice-announcement settings — the /display screen
    // (where announcements are spoken) isn't logged in as admin.
    if (p === '/api/settings/voice-announcements' && m === 'GET') { return send(res, 200, db.getVoiceAnnouncementSettings()); }
    // Public (no-auth) read of the shareable-card tagline — any device generating a
    // card needs this, not just the admin's browser.
    if (p === '/api/settings/card-tagline' && m === 'GET') { return send(res, 200, db.getCardTagline()); }
    if (p === '/api/settings' && m === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      // Only allow known setting keys through
      const boolKeys = ['collect_dart_timing','colorblind_mode','voice_enabled','voice_turn_score',
        'voice_no_score','voice_checkout_req','voice_180','voice_bigfish','voice_match_progress'];
      const allowed = ['ha_url',
        'ha_webhook_oneeighty','ha_webhook_bigfish','ha_webhook_bust','ha_webhook_ninedarter','ha_webhook_tonplus',
        'ha_webhook_momentcard',
        'ha_webhook_gamestart','ha_webhook_gameend','ha_webhook_setstart','ha_webhook_setend',
        'ha_webhook_legstart','ha_webhook_legend','pin_lockout_threshold','admin_lockout_threshold','scoreboard_layout',
        'default_scoring_input','card_tagline', ...boolKeys];
      const safe = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
      if ('pin_lockout_threshold' in safe) {
        const n = Number(safe.pin_lockout_threshold);
        if (!Number.isInteger(n) || n < 1 || n > 1000) return send(res, 400, { error: 'pin_lockout_threshold must be an integer between 1 and 1000' });
      }
      if ('admin_lockout_threshold' in safe) {
        const n = Number(safe.admin_lockout_threshold);
        if (!Number.isInteger(n) || n < 1 || n > 1000) return send(res, 400, { error: 'admin_lockout_threshold must be an integer between 1 and 1000' });
      }
      if ('card_tagline' in safe && safe.card_tagline.length > 140) {
        return send(res, 400, { error: 'card_tagline must be 140 characters or fewer' });
      }
      // SEC-9: ha_url and the webhook-ID fields were previously stored unbounded.
      if ('ha_url' in safe && String(safe.ha_url).length > 2048) {
        return send(res, 400, { error: 'ha_url must be 2048 characters or fewer' });
      }
      for (const k of allowed) {
        if (k.startsWith('ha_webhook_') && k in safe && String(safe[k]).length > 128) {
          return send(res, 400, { error: `${k} must be 128 characters or fewer` });
        }
      }
      for (const k of boolKeys) {
        if (k in safe) safe[k] = (safe[k] === '1' || safe[k] === true) ? '1' : '0';
      }
      if ('scoreboard_layout' in safe && !['full','compact','minimal'].includes(safe.scoreboard_layout)) {
        return send(res, 400, { error: 'scoreboard_layout must be one of: full, compact, minimal' });
      }
      if ('default_scoring_input' in safe && !['pad','board'].includes(safe.default_scoring_input)) {
        return send(res, 400, { error: 'default_scoring_input must be one of: pad, board' });
      }
      return send(res, 200, db.updateSettings(safe));
    }
    if (p === '/api/ha-test' && m === 'POST') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      const haUrl = String(b.url || '').trim().replace(/\/+$/, '');
      if (!haUrl) return send(res, 400, { error: 'No URL provided' });
      let parsedUrl;
      try { parsedUrl = new URL('/', haUrl); }
      catch(e) { return send(res, 400, { error: 'Invalid URL: ' + e.message }); }
      // SEC-4 egress guard: resolve once and connect to that resolved IP (with the
      // original hostname as Host/SNI), closing the DNS-rebinding window between
      // "checked" and "connected" — see backend/netguard.js.
      let resolvedIp;
      try { resolvedIp = await netguard.resolveAllowedHost(parsedUrl.hostname); }
      catch (e) { return send(res, 400, { error: e.message }); }
      const mod = parsedUrl.protocol === 'https:' ? require('https') : require('http');
      const result = await new Promise((resolve) => {
        const reqOpts = {
          hostname: resolvedIp,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: '/',
          method: 'HEAD',
          headers: { Host: parsedUrl.host },
        };
        if (parsedUrl.protocol === 'https:') reqOpts.servername = parsedUrl.hostname;
        const r2 = mod.request(reqOpts, res2 => { res2.resume(); resolve({ ok: true, status: res2.statusCode }); });
        r2.on('error', err => resolve({ ok: false, error: err.message }));
        r2.setTimeout(5000, () => { r2.destroy(); resolve({ ok: false, error: 'Connection timed out after 5 seconds' }); });
        r2.end();
      });
      return send(res, 200, result);
    }

    if (p === '/api/ha-webhook' && m === 'POST') {
      const b = await readJson(req);
      const allowed = ['oneeighty','bigfish','bust','ninedarter','tonplus','momentcard',
                       'gamestart','gameend','setstart','setend','legstart','legend'];
      if (!allowed.includes(b.event)) return send(res, 400, { error: 'Unknown event type' });
      const { event, ...payload } = b;
      const result = await db.fireHaWebhook(event, payload);
      return send(res, 200, result);
    }

    if (p === '/api/games' && m === 'POST') { if (!requireWrite(req, res)) return; const b = await readJson(req); return send(res, 200, db.createGame({ ...b, practice: b.practice ? 1 : 0 })); }

    let mt;
    if ((mt = p.match(/^\/api\/games\/(\d+)\/turns\/last$/)) && m === 'DELETE') {
      if (!requireWrite(req, res)) return;
      return send(res, 200, db.deleteLastTurn(Number(mt[1])));
    }
    if ((mt = p.match(/^\/api\/games\/(\d+)\/turns$/)) && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req); return send(res, 200, db.addTurn(Number(mt[1]), b));
    }
    if ((mt = p.match(/^\/api\/games\/(\d+)\/complete$/)) && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req); return send(res, 200, db.completeGame(Number(mt[1]), b.winner));
    }
    if ((mt = p.match(/^\/api\/games\/(\d+)\/events$/)) && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.recordEvent(Number(mt[1]), b.type, b.setNo ?? null, b.legNo ?? null));
    }

    // ----- badges (docs/achievements-badges-roadmap.md) -----
    if (p === '/api/badges/award' && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.awardBadge(b.player, b.badgeId, !!b.once));
    }
    if (p === '/api/badges/revoke' && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.revokeBadge(b.player, b.badgeId));
    }
    if (p === '/api/players/badges' && m === 'GET') {
      return send(res, 200, db.getPlayerBadges(url.searchParams.get('name')));
    }
    if (p === '/api/players/h2h-summary' && m === 'GET') {
      const exGid = Number(url.searchParams.get('excludeGameId'));
      return send(res, 200, db.getH2HSummary(url.searchParams.get('player'), url.searchParams.get('opponent'), Number.isFinite(exGid) ? exGid : null));
    }
    if (p === '/api/players/around-the-world' && m === 'GET') {
      return send(res, 200, db.getAroundTheWorldProgress(url.searchParams.get('name')));
    }

    // ----- daily challenge (docs/daily-challenge-roadmap.md) -----
    if (p === '/api/challenges/start' && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.startChallengeAttempt(b.player, b.gameId, b.challengeDate, b.format, b.target));
    }
    if (p === '/api/challenges/complete' && m === 'POST') {
      if (!requireWrite(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.completeChallengeAttempt(b.player, b.challengeDate, b.resultDarts));
    }
    if (p === '/api/challenges/status' && m === 'GET') {
      return send(res, 200, db.getChallengeStatus(url.searchParams.get('player'), url.searchParams.get('date')));
    }

    return send(res, 404, { error: 'Unknown endpoint' });
  } catch (err) {
    const status = err.status || 500;
    // Log server-side so a self-hoster can see failures in `docker logs` — previously
    // errors were only ever reported back to the client, with no server-side record.
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} ->`, err);
    // SEC-11: 4xx messages are app-authored (httpError() call sites) and safe to
    // return as-is; a 5xx means something unexpected threw, so return a generic
    // message rather than echoing err.message — the detail is already logged above.
    send(res, status, { error: status >= 500 ? 'Server error' : (err.message || 'Server error') });
  }
});

server.listen(PORT, () => console.log(`Darts scorer running on http://localhost:${PORT}`));
