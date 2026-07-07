'use strict';
// Committed tests for the Dart Builder / loadout API routes added to
// backend/server.js (docs/dart-builder-roadmap.md). Mirrors
// server.export.test.js's spawn-a-real-server pattern since server.js isn't
// require()-able.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ADMIN_USER = 'dartbuilder_test_admin';
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
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-dartbuilderroutes-'));
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
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  return fetch(base + p, { ...opts, headers });
}

describe('dart-components + loadouts API routes', () => {
  test('GET /api/dart-components/options returns the fixed enum lists (public, no auth)', async () => {
    await withServer(8450, async ({ base }) => {
      const res = await fetch(`${base}/api/dart-components/options`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.barrel.shapes, ['straight', 'torpedo', 'ton']);
      assert.deepEqual(body.tipTextures, ['smooth', 'grooved']);
    });
  });

  test('POST /api/dart-components 401s without an admin session', async () => {
    await withServer(8451, async ({ base }) => {
      const res = await api(base, null, '/api/dart-components', {
        method: 'POST', body: JSON.stringify({ player: 'nobody', type: 'barrel', name: 'X' }),
      });
      assert.equal(res.status, 401);
    });
  });

  test('full component + loadout CRUD round-trip, then default-loadout set/clear', async () => {
    await withServer(8452, async ({ base, cookie }) => {
      await api(base, cookie, '/api/players', { method: 'POST', body: JSON.stringify({ name: 'route_alice' }) });

      const barrelRes = await api(base, cookie, '/api/dart-components', {
        method: 'POST', body: JSON.stringify({ player: 'route_alice', type: 'barrel', name: 'Barrel1', weightG: 24, material: 'brass', shape: 'straight', grip: 'smooth' }),
      });
      assert.equal(barrelRes.status, 200);
      const barrel = await barrelRes.json();

      const shaftRes = await api(base, cookie, '/api/dart-components', {
        method: 'POST', body: JSON.stringify({ player: 'route_alice', type: 'shaft', name: 'Shaft1', material: 'nylon', shape: 'fixed' }),
      });
      const shaft = await shaftRes.json();
      const flightRes = await api(base, cookie, '/api/dart-components', {
        method: 'POST', body: JSON.stringify({ player: 'route_alice', type: 'flight', name: 'Flight1', material: 'standard_poly', shape: 'standard' }),
      });
      const flight = await flightRes.json();

      const listRes = await fetch(`${base}/api/dart-components?name=route_alice`);
      assert.equal((await listRes.json()).length, 3);

      const updatedRes = await api(base, cookie, `/api/dart-components/${barrel.id}`, {
        method: 'PUT', body: JSON.stringify({ player: 'route_alice', type: 'barrel', name: 'Barrel1 Updated', weightG: 26 }),
      });
      assert.equal((await updatedRes.json()).weightG, 26);

      const loRes = await api(base, cookie, '/api/loadouts', {
        method: 'POST', body: JSON.stringify({ player: 'route_alice', name: 'Main', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id, tipTexture: 'grooved' }),
      });
      assert.equal(loRes.status, 200);
      const loadout = await loRes.json();
      assert.equal(loadout.barrel.id, barrel.id);

      const getRes = await fetch(`${base}/api/loadouts/${loadout.id}?name=route_alice`);
      assert.equal(getRes.status, 200);
      assert.equal((await getRes.json()).name, 'Main');

      const dupRes = await api(base, cookie, `/api/loadouts/${loadout.id}/duplicate`, {
        method: 'POST', body: JSON.stringify({ player: 'route_alice' }),
      });
      assert.equal((await dupRes.json()).name, 'Main (copy)');

      const setDefRes = await api(base, cookie, '/api/players/default-loadout', {
        method: 'PUT', body: JSON.stringify({ name: 'route_alice', loadoutId: loadout.id }),
      });
      assert.deepEqual(await setDefRes.json(), { ok: true, defaultLoadoutId: loadout.id });
      const getDefRes = await fetch(`${base}/api/players/default-loadout?name=route_alice`);
      assert.equal((await getDefRes.json()).id, loadout.id);

      const gameRes = await api(base, cookie, '/api/games', {
        method: 'POST', body: JSON.stringify({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name: 'route_alice', loadoutId: loadout.id }] }),
      });
      assert.equal(gameRes.status, 200);

      const statsRes = await fetch(`${base}/api/loadouts/${loadout.id}/stats?name=route_alice`);
      assert.equal(statsRes.status, 200);
      const stats = await statsRes.json();
      assert.equal(stats.gamesPlayed, 1);

      const delRes = await api(base, cookie, `/api/loadouts/${loadout.id}?player=route_alice`, { method: 'DELETE' });
      assert.deepEqual(await delRes.json(), { ok: true });

      const delCompRes = await api(base, cookie, `/api/dart-components/${flight.id}?player=route_alice`, { method: 'DELETE' });
      assert.deepEqual(await delCompRes.json(), { ok: true });
    });
  });
});
