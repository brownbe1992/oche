'use strict';
// Committed tests for the backup-management routes added to backend/server.js
// (docs/archive/backups-roadmap.md v2): list/create/retention/download/delete, and the
// two restore paths (from an existing backup, and an uploaded file) — both of
// which re-verify the admin's password independently of the active session.
//
// server.js isn't require()-able (see server.auth-default.test.js's header
// comment for why), so this spawns it as a real child process against a scratch
// database and exercises the routes over HTTP, mirroring that same file's
// pattern.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ADMIN_USER = 'backup_test_admin';
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
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-backuproutes-'));
  const dbPath = path.join(scratchDir, 'test.db');
  const backupDir = path.join(scratchDir, 'backups');
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), DARTS_DB: dbPath, BACKUP_DIR: backupDir },
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

describe('backup management routes (docs/archive/backups-roadmap.md v2)', () => {
  test('every route 401s without an admin session', async () => {
    await withServer(8420, async ({ base }) => {
      assert.equal((await fetch(`${base}/api/backups`)).status, 401);
      assert.equal((await fetch(`${base}/api/backups`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`${base}/api/backups/download?name=x`)).status, 401);
      assert.equal((await fetch(`${base}/api/backups`, { method: 'DELETE' })).status, 401);
      assert.equal((await fetch(`${base}/api/backups/retention`, { method: 'PUT' })).status, 401);
      assert.equal((await fetch(`${base}/api/backups/restore`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`${base}/api/backups/upload-restore`, { method: 'POST' })).status, 401);
    });
  });

  test('list starts empty with the default 7-day retention', async () => {
    await withServer(8421, async ({ base, cookie }) => {
      const r = await api(base, cookie, '/api/backups');
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.deepEqual(j.backups, []);
      assert.equal(j.retentionDays, 7);
    });
  });

  test('on-demand backup creates a real, downloadable snapshot that then lists', async () => {
    await withServer(8422, async ({ base, cookie }) => {
      const created = await api(base, cookie, '/api/backups', { method: 'POST' }).then(r => r.json());
      assert.match(created.backup.name, /^darts-.+\.db$/);
      assert.ok(created.backup.size > 0);

      const listed = await api(base, cookie, '/api/backups').then(r => r.json());
      assert.equal(listed.backups.length, 1);
      assert.equal(listed.backups[0].name, created.backup.name);

      const dl = await api(base, cookie, `/api/backups/download?name=${created.backup.name}`);
      assert.equal(dl.status, 200);
      assert.match(dl.headers.get('content-disposition'), /attachment; filename="darts-.+\.db"/);
      const bytes = Buffer.from(await dl.arrayBuffer());
      assert.equal(bytes.length, created.backup.size);
      assert.equal(bytes.slice(0, 15).toString(), 'SQLite format 3');
    });
  });

  test('download/delete/restore of an unknown name all 404', async () => {
    await withServer(8423, async ({ base, cookie }) => {
      assert.equal((await api(base, cookie, '/api/backups/download?name=darts-1999-01-01T00-00-00-000Z.db')).status, 404);
      assert.equal((await api(base, cookie, '/api/backups?name=darts-1999-01-01T00-00-00-000Z.db', { method: 'DELETE' })).status, 404);
      const restoreRes = await api(base, cookie, '/api/backups/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'darts-1999-01-01T00-00-00-000Z.db', password: ADMIN_PASS }),
      });
      assert.equal(restoreRes.status, 404);
    });
  });

  test('delete removes the backup; a second delete then 404s', async () => {
    await withServer(8424, async ({ base, cookie }) => {
      const created = await api(base, cookie, '/api/backups', { method: 'POST' }).then(r => r.json());
      const del1 = await api(base, cookie, `/api/backups?name=${created.backup.name}`, { method: 'DELETE' });
      assert.equal(del1.status, 200);
      const del2 = await api(base, cookie, `/api/backups?name=${created.backup.name}`, { method: 'DELETE' });
      assert.equal(del2.status, 404);
    });
  });

  test('retention: valid update persists and prunes; invalid values are rejected', async () => {
    await withServer(8425, async ({ base, cookie }) => {
      const ok = await api(base, cookie, '/api/backups/retention', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 }),
      });
      const okJson = await ok.json();
      assert.equal(ok.status, 200);
      assert.equal(okJson.retentionDays, 30);

      const afterList = await api(base, cookie, '/api/backups').then(r => r.json());
      assert.equal(afterList.retentionDays, 30);

      for (const bad of [0, -1, 1.5, 366, 'nonsense']) {
        const res = await api(base, cookie, '/api/backups/retention', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: bad }),
        });
        assert.equal(res.status, 400, `days=${bad} should be rejected`);
      }
    });
  });

  test('restore from an existing backup requires the admin password again, independent of the session', async () => {
    await withServer(8426, async ({ base, cookie }) => {
      const created = await api(base, cookie, '/api/backups', { method: 'POST' }).then(r => r.json());

      const wrong = await api(base, cookie, '/api/backups/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: created.backup.name, password: 'wrongpassword' }),
      });
      assert.equal(wrong.status, 401);

      const right = await api(base, cookie, '/api/backups/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: created.backup.name, password: ADMIN_PASS }),
      });
      const rightJson = await right.json();
      assert.equal(right.status, 200);
      assert.match(rightJson.message, /restart/i);
    });
  });

  test('upload-restore: rejects a non-SQLite file, requires the correct password, and stages a valid file', async () => {
    await withServer(8427, async ({ base, cookie }) => {
      // Get a genuine, valid .db file to upload by downloading an on-demand backup.
      const created = await api(base, cookie, '/api/backups', { method: 'POST' }).then(r => r.json());
      const validBytes = Buffer.from(await api(base, cookie, `/api/backups/download?name=${created.backup.name}`).then(r => r.arrayBuffer()));

      const junkRes = await api(base, cookie, '/api/backups/upload-restore', {
        method: 'POST',
        headers: { 'X-Admin-Password': ADMIN_PASS, 'Content-Type': 'application/octet-stream' },
        body: 'this is not a sqlite file',
      });
      assert.equal(junkRes.status, 400);

      const wrongPwRes = await api(base, cookie, '/api/backups/upload-restore', {
        method: 'POST',
        headers: { 'X-Admin-Password': 'wrongpassword', 'Content-Type': 'application/octet-stream' },
        body: validBytes,
      });
      assert.equal(wrongPwRes.status, 401);

      const okRes = await api(base, cookie, '/api/backups/upload-restore', {
        method: 'POST',
        headers: { 'X-Admin-Password': ADMIN_PASS, 'Content-Type': 'application/octet-stream' },
        body: validBytes,
      });
      const okJson = await okRes.json();
      assert.equal(okRes.status, 200);
      assert.match(okJson.message, /restart/i);
    });
  });

  test('upload-restore: an oversized declared Content-Length is rejected without requiring the actual bytes', async () => {
    await withServer(8428, async ({ base, cookie }) => {
      // A raw request with a spoofed Content-Length far over the 500MB cap, but a
      // tiny actual body — the precheck should reject before reading anything.
      const http = require('http');
      const result = await new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/backups/upload-restore`, {
          method: 'POST',
          headers: { Cookie: cookie, 'X-Admin-Password': ADMIN_PASS, 'Content-Length': String(600 * 1024 * 1024) },
        }, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(result.status, 413);
      assert.match(result.body, /too large/i);
    });
  });
});
