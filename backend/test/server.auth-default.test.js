'use strict';
// Committed test for backend/server.js's OCHE_REQUIRE_AUTH default (zero-trust:
// every write requires an admin session by default; opt out with "false"/"0" for a
// fully-trusted LAN — see docs/security-hardening-roadmap.md and README.md's
// "Locking down writes" section).
//
// server.js isn't require()-able as a module — it calls .listen() immediately at
// load time and exports nothing — so the only way to exercise the actual env-var
// parsing + request-routing behavior end-to-end is to spawn it as a real child
// process against a scratch database and hit it over HTTP, the same way this exact
// scenario was manually verified with curl during development.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

function buildEnv(overrides) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

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

async function withServer(port, envOverrides, fn) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-servertest-'));
  const dbPath = path.join(scratchDir, 'test.db');
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: buildEnv({ ...envOverrides, PORT: String(port), DARTS_DB: dbPath }),
    stdio: 'ignore',
  });
  try {
    await waitForHealth(port);
    await fn(port);
  } finally {
    child.kill();
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {}
  }
}

describe('OCHE_REQUIRE_AUTH default (zero-trust: every write requires admin login by default)', () => {
  test('unset env var: requireAuth reports true, and an anonymous write is rejected (401)', async () => {
    await withServer(8391, { OCHE_REQUIRE_AUTH: undefined }, async (port) => {
      const cfg = await fetch(`http://localhost:${port}/api/auth-config`).then(r => r.json());
      assert.equal(cfg.requireAuth, true);

      const res = await fetch(`http://localhost:${port}/api/players`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'AnonAttempt' }),
      });
      assert.equal(res.status, 401);
    });
  });

  test('OCHE_REQUIRE_AUTH=false opts back into open-LAN behavior: anonymous writes succeed', async () => {
    await withServer(8392, { OCHE_REQUIRE_AUTH: 'false' }, async (port) => {
      const cfg = await fetch(`http://localhost:${port}/api/auth-config`).then(r => r.json());
      assert.equal(cfg.requireAuth, false);

      const res = await fetch(`http://localhost:${port}/api/players`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'AnonAttempt' }),
      });
      assert.equal(res.status, 200);
    });
  });

  test('OCHE_REQUIRE_AUTH=0 is also treated as an explicit opt-out', async () => {
    await withServer(8393, { OCHE_REQUIRE_AUTH: '0' }, async (port) => {
      const cfg = await fetch(`http://localhost:${port}/api/auth-config`).then(r => r.json());
      assert.equal(cfg.requireAuth, false);
    });
  });

  test('OCHE_REQUIRE_AUTH=true explicitly requests the (now-default) required behavior', async () => {
    await withServer(8394, { OCHE_REQUIRE_AUTH: 'true' }, async (port) => {
      const cfg = await fetch(`http://localhost:${port}/api/auth-config`).then(r => r.json());
      assert.equal(cfg.requireAuth, true);
    });
  });

  test('an unrecognized value fails closed (still required), not silently disabled', async () => {
    await withServer(8395, { OCHE_REQUIRE_AUTH: 'nonsense' }, async (port) => {
      const cfg = await fetch(`http://localhost:${port}/api/auth-config`).then(r => r.json());
      assert.equal(cfg.requireAuth, true);
    });
  });

  test('reads stay public regardless of the flag — GET /api/players never requires login', async () => {
    await withServer(8396, { OCHE_REQUIRE_AUTH: undefined }, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/players`);
      assert.equal(res.status, 200);
    });
  });

  test('the first-admin setup routes stay public even when auth is required (otherwise nobody could ever create the first account)', async () => {
    await withServer(8397, { OCHE_REQUIRE_AUTH: undefined }, async (port) => {
      const setupReq = await fetch(`http://localhost:${port}/api/setup-required`).then(r => r.json());
      assert.equal(setupReq.required, true);

      const res = await fetch(`http://localhost:${port}/api/setup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'firstadmin', password: 'correcthorsebattery' }),
      });
      assert.equal(res.status, 200);
    });
  });
});
