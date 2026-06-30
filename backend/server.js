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

   Routes marked [admin] require a logged-in admin session (cookie set by /api/login).
   Set COOKIE_SECURE=true when serving over HTTPS (e.g. behind a reverse proxy) so the
   session cookie gets the Secure flag; leave unset for plain-HTTP LAN deployments.
   ============================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db.js');
const auth = require('./auth.js');

const PORT = process.env.PORT || 8046;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/display') rel = '/display.html';     // friendly URL for the scoreboard
  const filePath = path.normalize(path.join(FRONTEND_DIR, rel));
  if (!filePath.startsWith(FRONTEND_DIR)) return send(res, 403, { error: 'Forbidden' }); // path traversal guard
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const m = req.method;

    if (!p.startsWith('/api/')) return serveStatic(req, res);

    if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true });

    // ----- auth -----
    if (p === '/api/setup-required' && m === 'GET') return send(res, 200, { required: db.isSetupRequired() });
    if (p === '/api/setup' && m === 'POST') {
      const b = await readJson(req);
      const result = db.createFirstAdmin(b.username, b.password);
      return send(res, 200, result);
    }
    if (p === '/api/login' && m === 'POST') {
      const b = await readJson(req);
      const { token, username } = db.login(b.username, b.password);
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
      return send(res, 200, db.createAdmin(b.username, b.password));
    }
    if (p === '/api/admins' && m === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, db.deleteAdmin(url.searchParams.get('id')));
    }
    if (p === '/api/admins/password' && m === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.changeAdminPassword(b.id, b.password));
    }

    // ----- player PINs -----
    if (p === '/api/players/verify-pin' && m === 'POST') {
      const b = await readJson(req);
      return send(res, 200, db.verifyPlayerPin(b.name, b.pin));
    }
    if (p === '/api/players/pin' && m === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      return send(res, 200, db.setPlayerPin(b.name, b.pin));
    }
    if (p === '/api/players/pin' && m === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, db.removePlayerPin(url.searchParams.get('name')));
    }

    // ----- live scoreboard channel -----
    if (p === '/api/live' && m === 'GET') return send(res, 200, liveState);
    if (p === '/api/live' && m === 'POST') {
      const b = await readJson(req);
      liveState = b && typeof b === 'object' ? b : { active: false, ts: Date.now() };
      liveBroadcast();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/live/stream' && m === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',   // disable proxy buffering so events arrive immediately
      });
      res.write(`data: ${JSON.stringify(liveState)}\n\n`);   // current state right away
      liveClients.add(res);
      req.on('close', () => liveClients.delete(res));
      return; // keep the connection open
    }

    if (p === '/api/players' && m === 'GET')  return send(res, 200, db.listPlayers());
    if (p === '/api/players' && m === 'POST') {
      const b = await readJson(req);
      return send(res, 200, db.addPlayer(b.name, b.out, { pin: b.pin, dartWeight: b.dartWeight }));
    }
    if (p === '/api/players/rename' && m === 'PUT')      { const b = await readJson(req); return send(res, 200, db.renamePlayer(b.from, b.to)); }
    if (p === '/api/players/out' && m === 'PUT')         { const b = await readJson(req); return send(res, 200, db.setOut(b.name, b.out)); }
    if (p === '/api/players/dart-weight' && m === 'PUT') { const b = await readJson(req); return send(res, 200, db.setDartWeight(b.name, b.weight)); }
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

    if (p === '/api/settings' && m === 'GET')  { if (!requireAdmin(req, res)) return; return send(res, 200, db.getSettings()); }
    // Public (no-auth) read of just the dart-timing flag — every device running the
    // scorer needs this during gameplay, not just an admin's browser.
    if (p === '/api/settings/dart-timing' && m === 'GET') { return send(res, 200, db.getDartTimingEnabled()); }
    if (p === '/api/settings' && m === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const b = await readJson(req);
      // Only allow known setting keys through
      const allowed = ['ha_url',
        'ha_webhook_oneeighty','ha_webhook_bigfish','ha_webhook_bust','ha_webhook_ninedarter','ha_webhook_tonplus',
        'ha_webhook_gamestart','ha_webhook_gameend','ha_webhook_setstart','ha_webhook_setend',
        'ha_webhook_legstart','ha_webhook_legend','pin_lockout_threshold','collect_dart_timing'];
      const safe = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
      if ('pin_lockout_threshold' in safe) {
        const n = Number(safe.pin_lockout_threshold);
        if (!Number.isInteger(n) || n < 1 || n > 1000) return send(res, 400, { error: 'pin_lockout_threshold must be an integer between 1 and 1000' });
      }
      if ('collect_dart_timing' in safe) safe.collect_dart_timing = (safe.collect_dart_timing === '1' || safe.collect_dart_timing === true) ? '1' : '0';
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
      const mod = parsedUrl.protocol === 'https:' ? require('https') : require('http');
      const result = await new Promise((resolve) => {
        const r2 = mod.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: '/',
          method: 'HEAD',
        }, res2 => { res2.resume(); resolve({ ok: true, status: res2.statusCode }); });
        r2.on('error', err => resolve({ ok: false, error: err.message }));
        r2.setTimeout(5000, () => { r2.destroy(); resolve({ ok: false, error: 'Connection timed out after 5 seconds' }); });
        r2.end();
      });
      return send(res, 200, result);
    }

    if (p === '/api/ha-webhook' && m === 'POST') {
      const b = await readJson(req);
      const allowed = ['oneeighty','bigfish','bust','ninedarter','tonplus',
                       'gamestart','gameend','setstart','setend','legstart','legend'];
      if (!allowed.includes(b.event)) return send(res, 400, { error: 'Unknown event type' });
      const { event, ...payload } = b;
      const result = await db.fireHaWebhook(event, payload);
      return send(res, 200, result);
    }

    if (p === '/api/games' && m === 'POST') { const b = await readJson(req); return send(res, 200, db.createGame({ ...b, practice: b.practice ? 1 : 0 })); }

    let mt;
    if ((mt = p.match(/^\/api\/games\/(\d+)\/turns\/last$/)) && m === 'DELETE') {
      return send(res, 200, db.deleteLastTurn(Number(mt[1])));
    }
    if ((mt = p.match(/^\/api\/games\/(\d+)\/turns$/)) && m === 'POST') {
      const b = await readJson(req); return send(res, 200, db.addTurn(Number(mt[1]), b));
    }
    if ((mt = p.match(/^\/api\/games\/(\d+)\/complete$/)) && m === 'POST') {
      const b = await readJson(req); return send(res, 200, db.completeGame(Number(mt[1]), b.winner));
    }
    if ((mt = p.match(/^\/api\/games\/(\d+)\/events$/)) && m === 'POST') {
      const b = await readJson(req);
      return send(res, 200, db.recordEvent(Number(mt[1]), b.type, b.setNo ?? null, b.legNo ?? null));
    }

    return send(res, 404, { error: 'Unknown endpoint' });
  } catch (err) {
    send(res, err.status || 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Darts scorer running on http://localhost:${PORT}`));
