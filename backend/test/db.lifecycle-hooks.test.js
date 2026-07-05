'use strict';
// Committed test for backend/db.js's game-lifecycle hook mechanism
// (docs/existing-app-prep-roadmap.md item 4, REFERENCE.md §1 "Game-lifecycle
// hooks") — ported from a scratch script used to verify it earlier this session,
// which was never committed. Covers payload shapes, multi-listener registration
// order, and the error-isolation guarantee (one broken listener can't block
// another, or take down createGame()/completeGame() itself).
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

// One permanent tracking listener per event, registered once — hooks have no
// unregister mechanism (by design, matching the rest of this codebase's hook-style
// listeners), so each test filters these shared logs down to its own gameId
// rather than re-registering a fresh listener per test.
const createdEvents = [];
const completedEvents = [];
db.onGameCreated(payload => createdEvents.push(payload));
db.onGameCompleted(payload => completedEvents.push(payload));

describe('onGameCreated', () => {
  test('fires synchronously with the documented payload shape', () => {
    const name = 'Lifecycle_Created_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 3, setsPerGame: 2, practice: 0, players: [{ name }, { name: 'Lifecycle_Created_Opp' }] });
    db.addPlayer('Lifecycle_Created_Opp');
    const event = createdEvents.find(e => e.gameId === g.gameId);
    assert.ok(event, 'the listener received an event for this game');
    assert.equal(event.gameType, 'x01');
    assert.equal(event.practice, false);
    assert.equal(event.category, '501');
    assert.equal(event.playerCount, 2);
  });

  test('reports gameType and category correctly for a Cricket game, and practice as a real boolean', () => {
    const name = 'Lifecycle_Cricket_Player';
    db.addPlayer(name);
    const g = db.createGame({
      category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'cricket', config: { numbers: [15, 16, 17, 18, 19, 20, 25] },
      players: [{ name }],
    });
    const event = createdEvents.find(e => e.gameId === g.gameId);
    assert.equal(event.gameType, 'cricket');
    assert.equal(event.practice, true);
    assert.equal(event.playerCount, 1);
  });

  test('multiple listeners all fire, in registration order', () => {
    const order = [];
    db.onGameCreated(() => order.push('second'));
    db.onGameCreated(() => order.push('third'));
    const name = 'Lifecycle_Order_Player';
    db.addPlayer(name);
    db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.deepEqual(order, ['second', 'third']);
  });

  test('a throwing listener does not prevent createGame() from succeeding, or block other listeners', () => {
    let sawEventDespiteThrow = false;
    db.onGameCreated(() => { throw new Error('boom — simulated broken future feature'); });
    db.onGameCreated(() => { sawEventDespiteThrow = true; });
    const name = 'Lifecycle_ErrorIsolation_Player';
    db.addPlayer(name);
    // console.error noise is expected here — the hook mechanism logs a caught
    // listener error rather than swallowing it silently.
    let result;
    assert.doesNotThrow(() => { result = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] }); });
    assert.ok(result.gameId, 'createGame still returns normally');
    assert.equal(sawEventDespiteThrow, true, 'a listener registered after the throwing one still ran');
  });
});

describe('onGameCompleted', () => {
  test('fires with {gameId, winnerName} right after the DB write', () => {
    const name = 'Lifecycle_Completed_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.completeGame(g.gameId, name);
    const event = completedEvents.find(e => e.gameId === g.gameId);
    assert.ok(event);
    assert.equal(event.winnerName, name);
  });

  test('winnerName is null when no winner is given', () => {
    const name = 'Lifecycle_NoWinner_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.completeGame(g.gameId, null);
    const event = completedEvents.find(e => e.gameId === g.gameId);
    assert.equal(event.winnerName, null);
  });

  test('a throwing listener does not prevent completeGame() from succeeding', () => {
    db.onGameCompleted(() => { throw new Error('boom — simulated broken future feature'); });
    const name = 'Lifecycle_CompletedErrorIsolation_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.doesNotThrow(() => db.completeGame(g.gameId, name));
  });
});
