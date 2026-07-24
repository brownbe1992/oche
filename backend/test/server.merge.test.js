'use strict';
// Committed tests for GET /api/players/merge-preview and POST /api/players/merge
// (docs/archive/player-merge-roadmap.md, admin-only player merge). Mirrors
// server.export.test.js's spawn-a-real-server pattern since server.js isn't
// require()-able. The merge *logic* (12-table reassignment, conflict policy,
// uuid aliases) is covered by db.merge.test.js; this file covers the routes'
// auth/validation/status codes and a real preview -> merge round trip.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ADMIN_USER = 'merge_test_admin';
const ADMIN_PASS = 'correcthorsebattery';

function waitForHealth(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://localhost:${port}/api/health`).then(r => {
        if (r.ok) resolve(); else retry();
      }).catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error('server did not start in time')); return; }
      setTimeout(tryOnce, 100);
    };
    tryOnce();
  });
}

async function withServer(port, fn) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-mergeroutes-'));
  const dbPath = path.join(scratchDir, 'test.db');
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), DARTS_DB: dbPath },
    stdio: 'ignore',
  });
  try {
    await waitForHealth(port);
    const base = `http://localhost:${port}`;
    await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    const loginRes = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    await fn({ base, cookie });
  } finally {
    child.kill();
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {}
  }
}

function api(base, cookie, p, opts = {}) {
  return fetch(base + p, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });
}
function addPlayer(base, cookie, name) {
  return api(base, cookie, '/api/players', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, out: 'double' }),
  });
}

describe('player merge routes (docs/archive/player-merge-roadmap.md)', () => {
  test('both routes 401 without an admin session', async () => {
    await withServer(8470, async ({ base }) => {
      assert.equal((await fetch(`${base}/api/players/merge-preview?source=a&target=b`)).status, 401);
      assert.equal((await fetch(`${base}/api/players/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'a', target: 'b' }),
      })).status, 401);
    });
  });

  test('preview: 400 missing params / same player, 404 unknown player, 200 with the full shape', async () => {
    await withServer(8476, async ({ base, cookie }) => {
      assert.equal((await api(base, cookie, '/api/players/merge-preview?source=a')).status, 400);
      assert.equal((await api(base, cookie, '/api/players/merge-preview?source=nobody&target=nobody2')).status, 404);

      await addPlayer(base, cookie, 'merge_route_src');
      await addPlayer(base, cookie, 'merge_route_tgt');
      assert.equal((await api(base, cookie, '/api/players/merge-preview?source=merge_route_src&target=merge_route_src')).status, 400);

      const res = await api(base, cookie, '/api/players/merge-preview?source=merge_route_src&target=merge_route_tgt');
      assert.equal(res.status, 200);
      const p = await res.json();
      assert.equal(p.blocked, false);
      assert.equal(p.source.name, 'merge_route_src');
      assert.equal(p.target.name, 'merge_route_tgt');
      assert.equal(typeof p.moves.games, 'number');
      assert.deepEqual(p.blockers.sharedGames, []);
    });
  });

  test('merge: a real preview -> merge round trip through the HTTP routes, and a blocked merge 400s', async () => {
    await withServer(8477, async ({ base, cookie }) => {
      await addPlayer(base, cookie, 'merge_route_a');
      await addPlayer(base, cookie, 'merge_route_b');

      // Give the source a game so the merge moves something real.
      const g = await (await api(base, cookie, '/api/games', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: 'merge_route_a' }] }),
      })).json();
      await api(base, cookie, `/api/games/${g.gameId}/turns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player: 'merge_route_a', set: 1, leg: 1, scored: 60,
          darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] }),
      });

      const mergeRes = await api(base, cookie, '/api/players/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'merge_route_a', target: 'merge_route_b' }),
      });
      assert.equal(mergeRes.status, 200);
      const result = await mergeRes.json();
      assert.equal(result.ok, true);
      assert.equal(result.moves.games, 1);

      // The source is gone from the roster; merging again 404s.
      const players = await (await api(base, cookie, '/api/players')).json();
      assert.equal(players.some(p => p.name === 'merge_route_a'), false);
      assert.equal((await api(base, cookie, '/api/players/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'merge_route_a', target: 'merge_route_b' }),
      })).status, 404);

      // A blocked merge (shared game) 400s with the blocked message.
      await addPlayer(base, cookie, 'merge_route_c');
      await api(base, cookie, '/api/games', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
          players: [{ name: 'merge_route_b' }, { name: 'merge_route_c' }] }),
      });
      const blocked = await api(base, cookie, '/api/players/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'merge_route_c', target: 'merge_route_b' }),
      });
      assert.equal(blocked.status, 400);
      assert.match((await blocked.json()).error, /Merge blocked: 1 shared game/);
    });
  });
});
