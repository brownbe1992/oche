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
       POST /api/reset             -> wipe all games/turns (players kept)
   ============================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db.js');

const PORT = process.env.PORT || 8046;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
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
    if (p === '/api/players' && m === 'POST') { const b = await readJson(req); return send(res, 200, db.addPlayer(b.name, b.out)); }
    if (p === '/api/players/rename' && m === 'PUT')      { const b = await readJson(req); return send(res, 200, db.renamePlayer(b.from, b.to)); }
    if (p === '/api/players/out' && m === 'PUT')         { const b = await readJson(req); return send(res, 200, db.setOut(b.name, b.out)); }
    if (p === '/api/players/dart-weight' && m === 'PUT') { const b = await readJson(req); return send(res, 200, db.setDartWeight(b.name, b.weight)); }
    if (p === '/api/players/dart-weights' && m === 'GET') return send(res, 200, db.getDartWeights(url.searchParams.get('name')));
    if (p === '/api/players' && m === 'DELETE') return send(res, 200, db.deletePlayer(url.searchParams.get('name')));

    if (p === '/api/summary'       && m === 'GET') return send(res, 200, db.getSummary());
    if (p === '/api/top-finishes'  && m === 'GET') return send(res, 200, db.getTopFinishesAll());
    if (p === '/api/stats/180s'    && m === 'GET') return send(res, 200, db.getOneEightyStats());
    if (p === '/api/stats/big-fish'&& m === 'GET') return send(res, 200, db.getBigFishStats());
    if (p === '/api/stats' && m === 'GET')  return send(res, 200, db.computeStats());
    if (p === '/api/players/top-finishes' && m === 'GET') {
      const mode = url.searchParams.get('mode');
      return send(res, 200, db.getTopFinishes(url.searchParams.get('name'), mode));
    }
    if (p === '/api/players/avg-history' && m === 'GET') {
      const name = url.searchParams.get('name');
      const period = url.searchParams.get('period') || 'month';
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
      return send(res, 200, db.getAvgHistory(name, period, opts));
    }
    if (p === '/api/reset' && m === 'POST') return send(res, 200, db.resetStats());

    if (p === '/api/games' && m === 'POST') { const b = await readJson(req); return send(res, 200, db.createGame({ ...b, practice: b.practice ? 1 : 0 })); }

    let mt;
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
