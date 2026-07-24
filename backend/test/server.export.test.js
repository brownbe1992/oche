'use strict';
// Committed tests for GET /api/export-all (docs/archive/data-export-roadmap.md), the
// admin-only full-database export route added to backend/server.js. Mirrors
// server.backups.test.js's spawn-a-real-server pattern since server.js isn't
// require()-able.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ADMIN_USER = 'export_test_admin';
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
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-exportroutes-'));
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

describe('GET /api/export-all (docs/archive/data-export-roadmap.md)', () => {
  test('401s without an admin session', async () => {
    await withServer(8440, async ({ base }) => {
      assert.equal((await fetch(`${base}/api/export-all`)).status, 401);
    });
  });

  test('200s with an admin session, streams valid JSON with an attachment header, and excludes secrets', async () => {
    await withServer(8441, async ({ base, cookie }) => {
      await api(base, cookie, '/api/players', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'export_route_player', out: 'double' }),
      });

      const res = await api(base, cookie, '/api/export-all');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="oche-export-.+\.json"/);
      assert.equal(res.headers.get('content-type'), 'application/json');

      const text = await res.text();
      const dump = JSON.parse(text);
      assert.ok(dump.players.some(p => p.name === 'export_route_player'));
      assert.equal(dump.admins, undefined);
      assert.equal(dump.sessions, undefined);
      assert.equal(dump.settings, undefined);
      assert.equal(text.includes('password_hash'), false);
    });
  });
});

describe('GET /api/players/export (docs/archive/data-export-roadmap.md, per-player export)', () => {
  test('401s without an admin session', async () => {
    await withServer(8442, async ({ base }) => {
      assert.equal((await fetch(`${base}/api/players/export?name=whoever`)).status, 401);
    });
  });

  test('400s with no name param, 404s for an unknown player, 200s with an attachment header for a real one', async () => {
    await withServer(8443, async ({ base, cookie }) => {
      assert.equal((await api(base, cookie, '/api/players/export')).status, 400);
      assert.equal((await api(base, cookie, '/api/players/export?name=nobody_here')).status, 404);

      await api(base, cookie, '/api/players', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'export_player_route_target', out: 'double' }),
      });

      const res = await api(base, cookie, '/api/players/export?name=export_player_route_target');
      assert.equal(res.status, 200);
      // Filename sanitizes the name (non-alphanumeric -> '-'), so check the shape rather
      // than an exact transliteration of the underscore-heavy test player name.
      assert.match(res.headers.get('content-disposition'), /attachment; filename="oche-export-export-player-route-target-.+\.json"/);
      assert.equal(res.headers.get('content-type'), 'application/json');

      const dump = JSON.parse(await res.text());
      assert.equal(dump.player.name, 'export_player_route_target');
      assert.ok(dump.player.uuid);
      assert.equal(dump.player.pin_hash, undefined);
    });
  });
});

describe('POST /api/players/import (docs/archive/data-export-roadmap.md, per-player import)', () => {
  test('401s without an admin session', async () => {
    await withServer(8444, async ({ base }) => {
      const res = await fetch(`${base}/api/players/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 401);
    });
  });

  test('400s for a malformed body, and a real export/import round trip 200s with the expected summary', async () => {
    await withServer(8445, async ({ base, cookie }) => {
      assert.equal((await api(base, cookie, '/api/players/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })).status, 400);

      // Round trip through the real HTTP routes: create a player, export them, then
      // feed that exact export straight back into the import route. Same server, so
      // this exercises the "re-import is a safe no-op" path end-to-end (the player
      // already resolves by uuid and has no games to skip-as-duplicate).
      await api(base, cookie, '/api/players', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'import_route_target', out: 'double' }),
      });
      const exportRes = await api(base, cookie, '/api/players/export?name=import_route_target');
      const exported = await exportRes.json();

      const importRes = await api(base, cookie, '/api/players/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported),
      });
      assert.equal(importRes.status, 200);
      const result = await importRes.json();
      assert.equal(result.ok, true);
      assert.equal(result.player.name, 'import_route_target');
      assert.equal(result.player.created, false, 'already exists locally, matched by uuid');
      assert.equal(result.gamesImported, 0);
      assert.equal(result.gamesSkipped, 0);
    });
  });
});
