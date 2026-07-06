'use strict';
// Committed tests for backend/admin-recovery.js's underlying db.js support
// (docs/archive/admin-account-recovery-roadmap.md) — the CLI itself is thin
// argument-parsing/stdin-reading around these functions (per the roadmap doc's
// own suggestion, tested at the db.js level rather than by spawning the CLI
// process). Proves the exact design gap the roadmap doc calls out: login()'s
// lockout check runs before the password is even consulted, so resetting a
// locked-out admin's password must ALSO clear the lockout columns, or the
// admin still can't log back in with the correct new password.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

function expectStatus(promise, status) {
  return assert.rejects(promise, (err) => err.status === status);
}

async function lockOut(username, wrongPassword) {
  for (let i = 0; i < 5; i++) {
    await expectStatus(db.login(username, wrongPassword), 401);
  }
}

describe('admin-recovery: reset-password clears a stuck lockout', () => {
  test('changeAdminPassword() lets a locked-out admin log in immediately with the new password', async () => {
    await db.createAdmin('recovery_reset_user', 'theoldpassword');
    const admin = db.listAdmins().find(a => a.username === 'recovery_reset_user');

    await lockOut('recovery_reset_user', 'wrongpassword');
    // Confirmed locked: even the correct OLD password is rejected with 423.
    await expectStatus(db.login('recovery_reset_user', 'theoldpassword'), 423);

    await db.changeAdminPassword(admin.id, 'thenewpassword123');

    // The exact failure mode the roadmap doc calls out: without clearing the
    // lockout columns, this next line would still throw 423 even though the
    // password is now correct.
    const { username } = await db.login('recovery_reset_user', 'thenewpassword123');
    assert.equal(username, 'recovery_reset_user');
  });

  test('listAdmins() reflects the cleared lockout state', () => {
    const admin = db.listAdmins().find(a => a.username === 'recovery_reset_user');
    assert.equal(admin.loginFailCount, 0);
    assert.equal(admin.loginLockedUntil, null);
  });
});

describe('admin-recovery: clear-lockout leaves the password untouched', () => {
  test('clearAdminLockout() lets a locked-out admin log in immediately with their EXISTING password', async () => {
    await db.createAdmin('recovery_clearlockout_user', 'unchangedpassword');
    const admin = db.listAdmins().find(a => a.username === 'recovery_clearlockout_user');

    await lockOut('recovery_clearlockout_user', 'wrongpassword');
    await expectStatus(db.login('recovery_clearlockout_user', 'unchangedpassword'), 423);

    const result = db.clearAdminLockout(admin.id);
    assert.deepEqual(result, { ok: true });

    const { username } = await db.login('recovery_clearlockout_user', 'unchangedpassword');
    assert.equal(username, 'recovery_clearlockout_user');
  });

  test('an unknown admin id is rejected with 404', () => {
    assert.throws(() => db.clearAdminLockout(999999), (err) => err.status === 404);
  });
});

describe('admin-recovery: listAdmins() lockout visibility', () => {
  test('a freshly-created admin shows zero failed attempts and no lockout', async () => {
    await db.createAdmin('recovery_fresh_user', 'somepassword');
    const admin = db.listAdmins().find(a => a.username === 'recovery_fresh_user');
    assert.equal(admin.loginFailCount, 0);
    assert.equal(admin.loginLockedUntil, null);
  });

  test('a partially-failed (not yet locked) admin shows a nonzero count with no lockout', async () => {
    await db.createAdmin('recovery_partial_user', 'correctpassword');
    await expectStatus(db.login('recovery_partial_user', 'wrongpassword'), 401);
    await expectStatus(db.login('recovery_partial_user', 'wrongpassword'), 401);
    const admin = db.listAdmins().find(a => a.username === 'recovery_partial_user');
    assert.equal(admin.loginFailCount, 2);
    assert.equal(admin.loginLockedUntil, null);
  });

  test('a locked-out admin shows a future loginLockedUntil timestamp', async () => {
    await db.createAdmin('recovery_locked_user', 'correctpassword');
    await lockOut('recovery_locked_user', 'wrongpassword');
    const admin = db.listAdmins().find(a => a.username === 'recovery_locked_user');
    assert.equal(admin.loginFailCount, 5);
    assert.ok(admin.loginLockedUntil > Date.now(), 'lockout should be in the future');
  });
});
