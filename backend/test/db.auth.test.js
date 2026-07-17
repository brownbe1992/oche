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

  // docs/archive/admin-login-backoff-roadmap.md: adminLockoutDelayMs(fails) is the pure
  // formula login()/verifyAdminPassword() both use — grace window costs no delay,
  // then doubles per consecutive failure past it, capped at the configured max.
  // Tested directly against the documented defaults (grace=3, base=2s, max=900s)
  // and its own worked example (fails 1-3 -> 0; 4 -> 2s; 5 -> 4s; 6 -> 8s; 13 -> capped).
  describe('adminLockoutDelayMs formula', () => {
    test('the grace window (default 3) costs no delay at all', () => {
      assert.equal(db.adminLockoutDelayMs(0), 0);
      assert.equal(db.adminLockoutDelayMs(1), 0);
      assert.equal(db.adminLockoutDelayMs(2), 0);
      assert.equal(db.adminLockoutDelayMs(3), 0);
    });

    test('doubles per consecutive failure past the grace window', () => {
      assert.equal(db.adminLockoutDelayMs(4), 2000);
      assert.equal(db.adminLockoutDelayMs(5), 4000);
      assert.equal(db.adminLockoutDelayMs(6), 8000);
    });

    test('is capped at the configured max (default 900s)', () => {
      assert.equal(db.adminLockoutDelayMs(13), 900000); // 2*2^9=1024s, clamped to 900s
      assert.equal(db.adminLockoutDelayMs(50), 900000);
    });

    test('respects overridden grace/base/max settings', () => {
      db.updateSettings({ admin_lockout_grace: '0', admin_lockout_base_seconds: '1', admin_lockout_max_seconds: '5' });
      assert.equal(db.adminLockoutDelayMs(1), 1000); // no grace at all now: 1st failure already delays
      assert.equal(db.adminLockoutDelayMs(2), 2000);
      assert.equal(db.adminLockoutDelayMs(10), 5000); // capped at the new 5s max
      // Restore the defaults for every test after this one in the file.
      db.updateSettings({ admin_lockout_grace: '3', admin_lockout_base_seconds: '2', admin_lockout_max_seconds: '900' });
    });
  });

  test('a real admin is never fully locked out: the grace window lets a few typos through with zero delay', async () => {
    await db.createAdmin('auth_lockout_user', 'therealpassword');
    for (let i = 0; i < 3; i++) {
      await expectStatus(db.login('auth_lockout_user', 'wrongpassword'), 401);
    }
    // Still inside the grace window — the correct password works immediately, no wait.
    const { username } = await db.login('auth_lockout_user', 'therealpassword');
    assert.equal(username, 'auth_lockout_user');
  });

  test('a 4th consecutive failure schedules a real delay, and the correct password works again the instant it elapses', { timeout: 20000 }, async () => {
    await db.createAdmin('auth_lockout_delay_user', 'therealpassword');
    for (let i = 0; i < 4; i++) {
      await expectStatus(db.login('auth_lockout_delay_user', 'wrongpassword'), 401);
    }
    // The 4th failure's 2s delay is active now — even the CORRECT password is rejected with 423.
    await expectStatus(db.login('auth_lockout_delay_user', 'therealpassword'), 423);
    await new Promise(r => setTimeout(r, 2100));
    // Once the wait has elapsed, the correct password succeeds immediately — never
    // permanently locked out, unlike the old flat-lockout design.
    const { username } = await db.login('auth_lockout_delay_user', 'therealpassword');
    assert.equal(username, 'auth_lockout_delay_user');
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

// verifyAdminPassword (docs/archive/backups-roadmap.md v2) re-verifies an already-known
// admin's password without creating a session — gates restoring a database
// backup, which is at least as destructive as "Wipe all data" and shouldn't rely
// on an active session alone. It deliberately reuses login()'s exact
// login_fail_count/login_locked_until columns and threshold, since this is a
// genuine additional password-guessing surface on the same account.
describe('verifyAdminPassword (backup-restore re-auth)', () => {
  test('correct password succeeds without creating a session', async () => {
    await db.createAdmin('auth_vap_user', 'therealpassword');
    const admin = db.listAdmins().find(a => a.username === 'auth_vap_user');
    const result = await db.verifyAdminPassword(admin.id, 'therealpassword');
    assert.deepEqual(result, { ok: true });
  });

  test('wrong password is rejected with a generic message', async () => {
    const admin = db.listAdmins().find(a => a.username === 'auth_vap_user');
    await expectStatus(db.verifyAdminPassword(admin.id, 'wrongpassword'), 401);
  });

  test('an unknown admin id is rejected with 404', async () => {
    await expectStatus(db.verifyAdminPassword(999999, 'whatever'), 404);
  });

  test('shares the same progressive-backoff formula and columns as login()', { timeout: 20000 }, async () => {
    await db.createAdmin('auth_vap_lockout_user', 'therealpassword');
    const admin = db.listAdmins().find(a => a.username === 'auth_vap_lockout_user');
    for (let i = 0; i < 4; i++) {
      await expectStatus(db.verifyAdminPassword(admin.id, 'wrongpassword'), 401);
    }
    // The 4th failure's delay is active now (423) even with the CORRECT password —
    // and login() itself is locked out too, since they share the same columns.
    await expectStatus(db.verifyAdminPassword(admin.id, 'therealpassword'), 423);
    await expectStatus(db.login('auth_vap_lockout_user', 'therealpassword'), 423);
    await new Promise(r => setTimeout(r, 2100));
    const result = await db.verifyAdminPassword(admin.id, 'therealpassword');
    assert.deepEqual(result, { ok: true });
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
