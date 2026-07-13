'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-13: deleteLastTurn(gameId)
// deleted whatever turn was newest for the game, with no way to tell the server
// which turn the caller actually meant — fine for the app's designed single-device
// usage, but silently deletes the WRONG turn if a second device/tab is scoring the
// same game. addTurn() now returns the new turn's id; deleteLastTurn() accepts an
// optional turnId and, when supplied, requires it to match the game's actual newest
// turn before deleting anything.
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

function x01Game(players) {
  return db.createGame({
    category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
    players: players.map(name => ({ name })),
  });
}

function turnsFor(gameId) {
  return db._db.prepare('SELECT id FROM turns WHERE game_id = ? ORDER BY id').all(gameId).map(r => r.id);
}

describe('addTurn — returns the new turn\'s id (BUG-13 prerequisite)', () => {
  test('addTurn resolves with { ok: true, turnId }', () => {
    const { gameId } = x01Game(['DLT_Alice']);
    const result = db.addTurn(gameId, {
      player: 'DLT_Alice', set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    });
    assert.equal(result.ok, true);
    assert.equal(typeof result.turnId, 'number');
    assert.deepEqual(turnsFor(gameId), [result.turnId]);
  });
});

describe('deleteLastTurn — optional turnId guard (BUG-13)', () => {
  test('without a turnId, deletes whatever is newest (unchanged backward-compatible behavior)', () => {
    const { gameId } = x01Game(['DLT_Bob']);
    const t1 = db.addTurn(gameId, { player: 'DLT_Bob', set: 1, leg: 1, scored: 60, darts: [{ dartNo: 1, sector: 20, multiplier: 3 }] });
    const t2 = db.addTurn(gameId, { player: 'DLT_Bob', set: 1, leg: 1, scored: 40, darts: [{ dartNo: 1, sector: 20, multiplier: 2 }] });
    db.deleteLastTurn(gameId);
    assert.deepEqual(turnsFor(gameId), [t1.turnId], 'the newest turn (t2) was deleted, t1 remains');
  });

  test('with a matching turnId, deletes normally', () => {
    const { gameId } = x01Game(['DLT_Carol']);
    const t1 = db.addTurn(gameId, { player: 'DLT_Carol', set: 1, leg: 1, scored: 60, darts: [{ dartNo: 1, sector: 20, multiplier: 3 }] });
    const t2 = db.addTurn(gameId, { player: 'DLT_Carol', set: 1, leg: 1, scored: 40, darts: [{ dartNo: 1, sector: 20, multiplier: 2 }] });
    assert.doesNotThrow(() => db.deleteLastTurn(gameId, t2.turnId));
    assert.deepEqual(turnsFor(gameId), [t1.turnId]);
  });

  test('with a stale turnId (another device/tab recorded a newer turn since), rejects with 409 and deletes nothing', () => {
    const { gameId } = x01Game(['DLT_Dave']);
    const t1 = db.addTurn(gameId, { player: 'DLT_Dave', set: 1, leg: 1, scored: 60, darts: [{ dartNo: 1, sector: 20, multiplier: 3 }] });
    // Simulate a second device recording another turn after t1, which the first
    // device (holding onto t1's id as "the last one it saw") doesn't know about.
    const t2 = db.addTurn(gameId, { player: 'DLT_Dave', set: 1, leg: 1, scored: 40, darts: [{ dartNo: 1, sector: 20, multiplier: 2 }] });
    assert.throws(() => db.deleteLastTurn(gameId, t1.turnId), (err) => err.status === 409);
    assert.deepEqual(turnsFor(gameId), [t1.turnId, t2.turnId], 'nothing was deleted — the stale request must not touch t2');
  });

  test('a turnId for a turn that never existed also rejects with 409', () => {
    const { gameId } = x01Game(['DLT_Eve']);
    const t1 = db.addTurn(gameId, { player: 'DLT_Eve', set: 1, leg: 1, scored: 60, darts: [{ dartNo: 1, sector: 20, multiplier: 3 }] });
    assert.throws(() => db.deleteLastTurn(gameId, 999999999), (err) => err.status === 409);
    assert.deepEqual(turnsFor(gameId), [t1.turnId]);
  });
});
