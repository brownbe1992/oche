'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-15: a reverse-proxy
// deployment that forgets TRUST_PROXY=true makes every request look like it comes
// from the proxy's single address (clientIp() falls back to req.socket.remoteAddress,
// which is the proxy's own connection), so the whole household shares one rate-limit
// budget with no signal telling the operator why. clientIp() now warns once (not
// per-request) the first time an X-Forwarded-For header is observed while
// TRUST_PROXY is unset.
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
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-trustproxy-'));
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

describe('BUG-15 — TRUST_PROXY misconfiguration warning', () => {
  test('TRUST_PROXY unset: an X-Forwarded-For request triggers a one-time warning, not a warning per request', async () => {
    await withServer(8473, {}, async (port, getStderr) => {
      await fetch(`http://localhost:${port}/api/health`, { headers: { 'X-Forwarded-For': '1.2.3.4' } });
      await fetch(`http://localhost:${port}/api/health`, { headers: { 'X-Forwarded-For': '5.6.7.8' } });
      await fetch(`http://localhost:${port}/api/health`, { headers: { 'X-Forwarded-For': '9.9.9.9' } });
      const occurrences = (getStderr().match(/X-Forwarded-For but TRUST_PROXY is not set/g) || []).length;
      assert.equal(occurrences, 1, 'must warn exactly once, not per-request');
    });
  });

  test('TRUST_PROXY unset, no X-Forwarded-For ever sent: no warning at all', async () => {
    await withServer(8474, {}, async (port, getStderr) => {
      await fetch(`http://localhost:${port}/api/health`);
      await fetch(`http://localhost:${port}/api/health`);
      assert.doesNotMatch(getStderr(), /X-Forwarded-For but TRUST_PROXY is not set/);
    });
  });

  test('TRUST_PROXY=true: no warning even with X-Forwarded-For present', async () => {
    await withServer(8475, { TRUST_PROXY: 'true' }, async (port, getStderr) => {
      await fetch(`http://localhost:${port}/api/health`, { headers: { 'X-Forwarded-For': '1.2.3.4' } });
      assert.doesNotMatch(getStderr(), /X-Forwarded-For but TRUST_PROXY is not set/);
    });
  });
});
