'use strict';
// Committed regression test for docs/security-audit-roadmap.md SEC-20:
// createFirstAdmin()'s check-then-insert was not atomic, so two concurrent
// POST /api/setup requests could both create an admin during the first-run window.
//
// Unlike the login fail-counter race db.auth.test.js's header comment declines to
// reproduce in-process, this race genuinely interleaves under node:test's normal
// sequential test execution: auth.hashSecret() awaits Node's real (libuv
// threadpool-backed) async crypto.scrypt, so two concurrent createFirstAdmin()
// calls both actually suspend at that await point before either reaches the
// database — the exact window the vulnerability lived in. Promise.all() below
// drives both calls through that real interleaving, not a simulated one.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-setup-race-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

describe('SEC-20 — createFirstAdmin() is atomic against concurrent /api/setup calls', () => {
  test('two concurrent calls with different usernames: exactly one succeeds', async () => {
    assert.equal(db.isSetupRequired(), true);

    const results = await Promise.allSettled([
      db.createFirstAdmin('race_alice', 'password123'),
      db.createFirstAdmin('race_bob', 'password123'),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, `expected exactly one call to succeed, got: ${JSON.stringify(results)}`);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.status, 403, 'the losing call must fail closed (403), not silently no-op or 500');

    const admins = db.listAdmins();
    assert.equal(admins.length, 1, 'exactly one admin account must exist after the race, not zero and not two');
    assert.ok(admins[0].username === 'race_alice' || admins[0].username === 'race_bob');
    assert.equal(db.isSetupRequired(), false);
  });

  test('a third call after the race also fails closed', async () => {
    await assert.rejects(db.createFirstAdmin('race_charlie', 'password123'), (err) => err.status === 403);
    assert.equal(db.listAdmins().length, 1, 'still exactly one admin — the third caller must not have snuck in');
  });
});
