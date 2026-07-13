'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-11: a staged restore used to
// copy straight over the LIVE database file while the server process still held it
// open, so any write landing between "restore staged" and the admin's manual
// restart risked corrupting the just-restored data. The fix stages to a sidecar
// (.restore-pending) file instead, applied only at the next process startup —
// before db.js ever opens the live database.
//
// The deterministic, byte-level proof that staging no longer touches DB_PATH lives
// in backup-lib.test.js (it compares the live file's raw bytes/mtime before and
// after stageRestore() directly — reading through SQLite's own query layer here
// can't reliably distinguish old vs new behavior, since WAL-mode caching and an
// already-open file descriptor's "delete/overwrite while open" semantics on Linux
// mean a running process can still see self-consistent query results even when the
// path-visible file underneath it has changed). This test complements that with an
// end-to-end integration check of the full documented flow: stage a restore while a
// server is running (confirming its OWN on-disk file bytes are untouched, and that
// it keeps working normally afterward), then spawn a fresh server process against
// the SAME database path (simulating the documented "restart the container/process
// now" step) and confirm THAT process now reflects the restored content.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ADMIN_USER = 'restore_test_admin';
const ADMIN_PASS = 'correcthorsebattery';

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

function startServer(port, dbPath, backupDir) {
  return spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), DARTS_DB: dbPath, BACKUP_DIR: backupDir },
    stdio: 'ignore',
  });
}

function api(base, cookie, p, opts = {}) {
  return fetch(base + p, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });
}

async function login(base) {
  await fetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}

async function playerNames(base) {
  return (await (await fetch(`${base}/api/players`)).json()).map(p => p.name);
}

describe('BUG-11 — two-phase backup restore', () => {
  test('staging a restore does not touch the live database of a still-running process; the next process startup applies it', async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-restore2phase-'));
    const dbPath = path.join(scratchDir, 'test.db');
    const backupDir = path.join(scratchDir, 'backups');
    const port1 = 8461, port2 = 8462;
    let child1, child2;
    try {
      // --- Process A: create "Original", back up, then add "AfterBackup" ---
      child1 = startServer(port1, dbPath, backupDir);
      await waitForHealth(port1);
      const base1 = `http://localhost:${port1}`;
      const cookie = await login(base1);
      await api(base1, cookie, '/api/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Original' }) });
      const created = await api(base1, cookie, '/api/backups', { method: 'POST' }).then(r => r.json());
      await api(base1, cookie, '/api/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'AfterBackup' }) });
      assert.deepEqual((await playerNames(base1)).sort(), ['AfterBackup', 'Original']);

      const dbBytesBeforeStage = fs.readFileSync(dbPath);
      const dbMtimeBeforeStage = fs.statSync(dbPath).mtimeMs;

      // Stage a restore back to the pre-"AfterBackup" backup.
      const stageRes = await api(base1, cookie, '/api/backups/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: created.backup.name, password: ADMIN_PASS }),
      });
      assert.equal(stageRes.status, 200);

      // The core BUG-11 assertion, checked at the byte level (not just via a query
      // through the still-open connection, which can't reliably distinguish this —
      // see this file's header comment): the live file on disk must be completely
      // untouched by staging.
      assert.deepEqual(fs.readFileSync(dbPath), dbBytesBeforeStage, 'DB_PATH bytes must be unchanged immediately after staging');
      assert.equal(fs.statSync(dbPath).mtimeMs, dbMtimeBeforeStage, 'DB_PATH must not even be touched (same mtime)');
      assert.ok(fs.existsSync(dbPath + '.restore-pending'), 'the pending sidecar file must exist instead');

      // And the still-running process must keep working normally afterward.
      assert.deepEqual((await playerNames(base1)).sort(), ['AfterBackup', 'Original']);
      await api(base1, cookie, '/api/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'StillWorks' }) });
      assert.ok((await playerNames(base1)).includes('StillWorks'));

      child1.kill();
      await new Promise(r => setTimeout(r, 200));

      // --- Process B: a fresh process against the SAME db path (the "restart now" step) ---
      child2 = startServer(port2, dbPath, backupDir);
      await waitForHealth(port2);
      const base2 = `http://localhost:${port2}`;
      const names = await playerNames(base2);
      assert.ok(names.includes('Original'), 'the restored backup\'s data must be present after the restart');
      assert.ok(!names.includes('AfterBackup'), 'data written after the backup was taken must be gone (the restore actually applied)');
      assert.ok(!names.includes('StillWorks'), 'data written after staging (to the old live file) must also be gone — the pending file fully replaced it');

      // The pending marker must be consumed — a second restart must NOT reapply it.
      child2.kill();
      await new Promise(r => setTimeout(r, 200));
      assert.ok(!fs.existsSync(dbPath + '.restore-pending'), 'the pending marker must be removed once applied');
    } finally {
      if (child1) child1.kill();
      if (child2) child2.kill();
      await new Promise(r => setTimeout(r, 150));
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {}
    }
  });
});
