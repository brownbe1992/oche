'use strict';
// Committed tests for GET /api/players/export-csv (docs/archive/data-export-roadmap.md, the
// admin-only CSV spreadsheet export route added to backend/server.js). Mirrors
// server.export.test.js's spawn-a-real-server pattern since server.js isn't
// require()-able. The CSV *content* math is covered by db.export-csv.test.js; this
// file covers the route's auth/validation/status codes and download headers.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ADMIN_USER = 'exportcsv_test_admin';
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
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-exportcsvroutes-'));
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

describe('GET /api/players/export-csv (docs/archive/data-export-roadmap.md, CSV spreadsheet export)', () => {
  test('401s without an admin session', async () => {
    await withServer(8465, async ({ base }) => {
      assert.equal((await fetch(`${base}/api/players/export-csv?name=whoever&kind=games`)).status, 401);
    });
  });

  test('400s with no name or a bad kind, 404s for an unknown player', async () => {
    await withServer(8466, async ({ base, cookie }) => {
      assert.equal((await api(base, cookie, '/api/players/export-csv')).status, 400);
      assert.equal((await api(base, cookie, '/api/players/export-csv?name=nobody_here')).status, 404);

      await api(base, cookie, '/api/players', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'csv_route_kind_check', out: 'double' }),
      });
      const bad = await api(base, cookie, '/api/players/export-csv?name=csv_route_kind_check&kind=darts');
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /kind must be one of/);
    });
  });

  test('200s for both kinds with a text/csv attachment header, defaulting kind to games', async () => {
    await withServer(8467, async ({ base, cookie }) => {
      await api(base, cookie, '/api/players', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'csv_route_target', out: 'double' }),
      });

      for (const [query, expectedKind, expectedHeaderStart] of [
        ['&kind=games', 'games', 'game_id,started_at'],
        ['&kind=turns', 'turns', 'turn_id,game_id'],
        ['', 'games', 'game_id,started_at'], // kind omitted -> games
      ]) {
        const res = await api(base, cookie, `/api/players/export-csv?name=csv_route_target${query}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
        assert.match(res.headers.get('content-disposition'),
          new RegExp(`attachment; filename="oche-export-csv-route-target-${expectedKind}-.+\\.csv"`));
        const text = await res.text();
        assert.ok(text.startsWith(expectedHeaderStart), `${expectedKind} CSV starts with its header row`);
      }
    });
  });
});
