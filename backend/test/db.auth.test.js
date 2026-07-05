'use strict';
// Committed tests for backend/db.js's auth model (REFERENCE.md §9 "Security
// Model") — admin account CRUD, login lockout thresholds, session lifecycle, and
// player PIN lockout. Not attempting to reproduce the exact concurrent-request
// race the RETURNING-based fail-counter fix (REFERENCE.md §9) closes — that
// needs genuinely interleaved concurrent calls, not something node:test's
// sequential execution can exercise meaningfully. What's covered here is the
// observable threshold/lockout behavior itself.
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

describe('admin setup and account CRUD', () => {
  test('isSetupRequired is true before any admin exists, false after', async () => {
    assert.equal(db.isSetupRequired(), true);
    await db.createFirstAdmin('auth_admin_one', 'password123');
    assert.equal(db.isSetupRequired(), false);
  });

  test('createFirstAdmin refuses once setup is already complete', async () => {
    await expectStatus(db.createFirstAdmin('auth_admin_two', 'password123'), 403);
  });

  test('createAdmin validates username format and password length', async () => {
    await expectStatus(db.createAdmin('ab', 'password123'), 400); // too short a username
    await expectStatus(db.createAdmin('valid_name', 'short'), 400); // too short a password
    await assert.doesNotReject(db.createAdmin('auth_admin_two', 'password123'));
  });

  test('createAdmin rejects a duplicate username', async () => {
    await expectStatus(db.createAdmin('auth_admin_two', 'anotherpassword'), 409);
  });

  test('listAdmins returns every created admin', () => {
    const names = db.listAdmins().map(a => a.username);
    assert.ok(names.includes('auth_admin_one'));
    assert.ok(names.includes('auth_admin_two'));
  });

  test('deleteAdmin refuses to remove the last remaining admin', async () => {
    // Get down to exactly one admin first by removing every extra one created above.
    const admins = db.listAdmins();
    for (const a of admins.slice(1)) db.deleteAdmin(a.id);
    const remaining = db.listAdmins();
    assert.equal(remaining.length, 1);
    assert.throws(() => db.deleteAdmin(remaining[0].id), (err) => err.status === 400);
  });
});

describe('login and lockout', () => {
  test('correct credentials return a token and create a lookup-able session', async () => {
    await db.createAdmin('auth_login_user', 'correctpassword');
    const { token, username } = await db.login('auth_login_user', 'correctpassword');
    assert.equal(username, 'auth_login_user');
    const admin = db.getSessionAdmin(token);
    assert.equal(admin.username, 'auth_login_user');
  });

  test('wrong password: a generic error, not distinguishing bad username from bad password', async () => {
    await expectStatus(db.login('auth_login_user', 'wrongpassword'), 401);
    await expectStatus(db.login('nonexistent_user_xyz', 'whatever'), 401);
  });

  test('logout invalidates the session', async () => {
    const { token } = await db.login('auth_login_user', 'correctpassword');
    assert.ok(db.getSessionAdmin(token));
    db.logout(token);
    assert.equal(db.getSessionAdmin(token), null);
  });

  test('adminLockoutThreshold defaults to 5', () => {
    assert.equal(db.adminLockoutThreshold(), 5);
  });

  test('locks out after the default threshold of failed attempts, even with the right password', { timeout: 20000 }, async () => {
    await db.createAdmin('auth_lockout_user', 'therealpassword');
    for (let i = 0; i < 5; i++) {
      await expectStatus(db.login('auth_lockout_user', 'wrongpassword'), 401);
    }
    // The 6th attempt is locked out (423) even with the CORRECT password now.
    await expectStatus(db.login('auth_lockout_user', 'therealpassword'), 423);
  });

  test('changing an admin\'s password revokes all of that admin\'s existing sessions', async () => {
    await db.createAdmin('auth_pwchange_user', 'originalpassword');
    const { token } = await db.login('auth_pwchange_user', 'originalpassword');
    assert.ok(db.getSessionAdmin(token));
    const admin = db.listAdmins().find(a => a.username === 'auth_pwchange_user');
    await db.changeAdminPassword(admin.id, 'newpassword123');
    assert.equal(db.getSessionAdmin(token), null, 'the old session is gone after a password change');
  });
});

describe('player PIN protection', () => {
  test('a player with no PIN set can be verified by anyone', async () => {
    db.addPlayer('auth_pin_nopin');
    const result = await db.verifyPlayerPin('auth_pin_nopin', 'anything');
    assert.equal(result.ok, true);
  });

  test('correct PIN verifies; wrong PIN is rejected with a generic message', async () => {
    db.addPlayer('auth_pin_player');
    await db.setPlayerPin('auth_pin_player', '1234');
    const ok = await db.verifyPlayerPin('auth_pin_player', '1234');
    assert.equal(ok.ok, true);
    await expectStatus(db.verifyPlayerPin('auth_pin_player', '9999'), 401);
  });

  test('removePlayerPin clears it, making the player open again', async () => {
    db.addPlayer('auth_pin_remove');
    await db.setPlayerPin('auth_pin_remove', '5678');
    await expectStatus(db.verifyPlayerPin('auth_pin_remove', 'wrong'), 401);
    db.removePlayerPin('auth_pin_remove');
    const result = await db.verifyPlayerPin('auth_pin_remove', 'anything');
    assert.equal(result.ok, true);
  });

  test('pinLockoutThreshold defaults to 10', () => {
    assert.equal(db.pinLockoutThreshold(), 10);
  });

  test('locks out after the default threshold of failed PIN attempts', { timeout: 20000 }, async () => {
    db.addPlayer('auth_pin_lockout');
    await db.setPlayerPin('auth_pin_lockout', '4321');
    for (let i = 0; i < 10; i++) {
      await expectStatus(db.verifyPlayerPin('auth_pin_lockout', '0000'), 401);
    }
    await expectStatus(db.verifyPlayerPin('auth_pin_lockout', '4321'), 423);
  });

  test('setPlayerPin rejects a PIN outside 4-8 digits', async () => {
    db.addPlayer('auth_pin_badformat');
    await expectStatus(db.setPlayerPin('auth_pin_badformat', '123'), 400);
    await expectStatus(db.setPlayerPin('auth_pin_badformat', '123456789'), 400);
    await expectStatus(db.setPlayerPin('auth_pin_badformat', 'abcd'), 400);
  });
});
