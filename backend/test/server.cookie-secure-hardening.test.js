'use strict';
// Committed regression test for docs/security-audit-roadmap.md SEC-24:
// COOKIE_SECURE (and therefore the session cookie's Secure attribute) was opt-in
// with no runtime signal when it's left unset, and Strict-Transport-Security was
// never sent even when the operator did opt in. Verifies both: a one-time startup
// warning on stderr when COOKIE_SECURE is unset, and the HSTS header appearing on
// every response only when it's explicitly set to true (never sent over what the
// operator hasn't told the app is HTTPS).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

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

async function withServer(port, extraEnv, fn) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-cookiesecure-'));
  const dbPath = path.join(scratchDir, 'test.db');
  let stderr = '';
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), DARTS_DB: dbPath, OCHE_REQUIRE_AUTH: 'false', ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', d => { stderr += d.toString(); });
  try {
    await waitForHealth(port);
    await fn(port, () => stderr);
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 150));
  }
}

describe('SEC-24 — COOKIE_SECURE startup warning and conditional HSTS header', () => {
  test('COOKIE_SECURE unset: startup warning is printed, no HSTS header is sent', async () => {
    await withServer(8471, {}, async (port, getStderr) => {
      const res = await fetch(`http://localhost:${port}/api/health`);
      assert.equal(res.headers.get('strict-transport-security'), null);
      assert.match(getStderr(), /COOKIE_SECURE is not set/);
    });
  });

  test('COOKIE_SECURE=true: no warning, HSTS header is sent on every response', async () => {
    await withServer(8472, { COOKIE_SECURE: 'true' }, async (port, getStderr) => {
      const res = await fetch(`http://localhost:${port}/api/health`);
      assert.match(res.headers.get('strict-transport-security') || '', /max-age=15552000/);
      assert.doesNotMatch(getStderr(), /COOKIE_SECURE is not set/);
    });
  });
});
