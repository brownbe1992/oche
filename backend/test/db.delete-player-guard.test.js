'use strict';
// Committed test for backend/db.js's player-deletion guard extensibility
// (docs/archive/existing-app-prep-roadmap.md item 6) — mirrors the game-lifecycle hook
// mechanism (item 4, covered by db.lifecycle-hooks.test.js): a small, growing
// list of "is this player referenced by an active thing" checks that
// deletePlayer() consults before deleting, rather than hardcoding a specific
// future feature's logic directly into deletePlayer(). No guards are registered
// by any shipped feature yet — this proves the mechanism itself works correctly
// ahead of the first real consumer (tournament mode, league mode).
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

describe('registerDeletePlayerGuard', () => {
  test('with no guards registered, deletePlayer behaves exactly as before', () => {
    db.addPlayer('Guard_Baseline_Player');
    const result = db.deletePlayer('Guard_Baseline_Player');
    assert.deepEqual(result, { ok: true });
    assert.equal(db.listPlayers().find(p => p.name === 'Guard_Baseline_Player'), undefined);
  });

  test('a guard that objects blocks the delete with its exact reason, as a 409', () => {
    db.addPlayer('Guard_Blocked_Player');
    db.registerDeletePlayerGuard(player =>
      player.name === 'Guard_Blocked_Player' ? 'blocked: active in a tournament' : null);
    assert.throws(
      () => db.deletePlayer('Guard_Blocked_Player'),
      (err) => err.status === 409 && err.message === 'blocked: active in a tournament'
    );
    // The player still exists — the delete never happened.
    assert.ok(db.listPlayers().some(p => p.name === 'Guard_Blocked_Player'));
  });

  test('a guard that does not object (returns null) lets an unrelated player through', () => {
    db.addPlayer('Guard_Unrelated_Player');
    // The guard registered above only blocks 'Guard_Blocked_Player' — everyone else passes.
    const result = db.deletePlayer('Guard_Unrelated_Player');
    assert.deepEqual(result, { ok: true });
    assert.equal(db.listPlayers().find(p => p.name === 'Guard_Unrelated_Player'), undefined);
  });

  test('the first blocking guard wins; a later guard is never consulted once one already blocked', () => {
    let secondGuardCalled = false;
    db.addPlayer('Guard_FirstWins_Player');
    db.registerDeletePlayerGuard(player =>
      player.name === 'Guard_FirstWins_Player' ? 'blocked by the first guard' : null);
    db.registerDeletePlayerGuard(player => {
      if (player.name === 'Guard_FirstWins_Player') secondGuardCalled = true;
      return null;
    });
    assert.throws(
      () => db.deletePlayer('Guard_FirstWins_Player'),
      (err) => err.message === 'blocked by the first guard'
    );
    assert.equal(secondGuardCalled, false, 'a later guard is short-circuited once an earlier one already blocked');
  });

  test('deleting a nonexistent player is still a no-op success, guards are never consulted', () => {
    let guardCalled = false;
    db.registerDeletePlayerGuard(() => { guardCalled = true; return null; });
    const result = db.deletePlayer('Guard_Nonexistent_Player_Xyz');
    assert.deepEqual(result, { ok: true });
    assert.equal(guardCalled, false, 'no player row exists, so no guard needs to run');
  });
});
