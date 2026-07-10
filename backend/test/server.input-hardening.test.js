'use strict';
// Committed regression test for backend/server.js + backend/auth.js input hardening
// (docs/security-audit-roadmap.md SEC-17). Malformed client-controlled input that
// reaches an unhandled decodeURIComponent()/JSON.parse() previously threw, became a
// 500, and — because the top-level catch persists every status >= 500 into the
// server_errors diagnostic table — let an unauthenticated caller flush genuine
// diagnostic history and inject misleading entries. Each such input is a CLIENT error
// (400) and must NOT be logged as a server fault.
//
// server.js isn't require()-able (it .listen()s at load and exports nothing), so this
// spawns it as a real child process against a scratch DB and hits it over HTTP — the
// same shape as server.auth-default.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const DB_PATH = path.join(__dirname, '..', 'db.js');

function waitForHealth(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://localhost:${port}/api/health`).then(r => { if (r.ok) resolve(); else retry(); }).catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error('server did not start in time')); return; }
      setTimeout(tryOnce, 100);
    };
    tryOnce();
  });
}

async function withServer(port, fn) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-inputtest-'));
  const dbPath = path.join(scratchDir, 'test.db');
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), DARTS_DB: dbPath, OCHE_REQUIRE_AUTH: 'false' },
    stdio: 'ignore',
  });
  try {
    await waitForHealth(port);
    await fn(port, dbPath);
  } finally {
    child.kill();
    // Wait briefly so the process releases the DB file before we read it in-process.
    await new Promise(r => setTimeout(r, 150));
  }
}

// Reads the server_errors table from the scratch DB in-process (a fresh require of
// db.js pointed at the same file), after the server child has exited.
function readServerErrors(dbPath) {
  const prev = process.env.DARTS_DB;
  process.env.DARTS_DB = dbPath;
  delete require.cache[require.resolve(DB_PATH)];
  const db = require(DB_PATH);
  const rows = db.getServerErrors(50);
  delete require.cache[require.resolve(DB_PATH)];
  if (prev === undefined) delete process.env.DARTS_DB; else process.env.DARTS_DB = prev;
  return rows;
}

describe('SEC-17 — malformed client input is a 400, never a logged 500', () => {
  test('malformed percent-encoding in a static path returns 400', async () => {
    await withServer(8481, async (port) => {
      const res = await fetch(`http://localhost:${port}/%ff`);
      assert.equal(res.status, 400);
    });
  });

  test('malformed session cookie on public GET /api/me returns 200 (not-logged-in), not 500', async () => {
    await withServer(8482, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/me`, { headers: { Cookie: 'oche_session=%ff' } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.loggedIn, false);
    });
  });

  test('malformed JSON body on public POST /api/login returns 400', async () => {
    await withServer(8483, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
      });
      assert.equal(res.status, 400);
    });
  });

  test('none of the malformed inputs above are persisted into the server_errors diagnostic table', async () => {
    let dbPathUsed;
    await withServer(8484, async (port, dbPath) => {
      dbPathUsed = dbPath;
      await fetch(`http://localhost:${port}/%ff`);
      await fetch(`http://localhost:${port}/api/me`, { headers: { Cookie: 'oche_session=%ff' } });
      await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
      });
    });
    const errs = readServerErrors(dbPathUsed);
    assert.equal(errs.length, 0, `server_errors should stay empty, got: ${JSON.stringify(errs)}`);
  });
});
