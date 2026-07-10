'use strict';
// Committed regression test for backend/db.js's completeGame() participant guard
// (docs/bug-roadmap.md BUG-9). completeGame() previously wrote games.winner_id from a
// client-supplied name with no check that the player actually took part in the game —
// crediting a phantom H2H game win in computeStats() and resetting the real
// participants' win streaks. The guard mirrors recordWalkover()'s own check and
// completes the guard BUG-4 added only to the tournament-advancement consumer.
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

function winnerIdOf(gameId) {
  return db._db.prepare('SELECT winner_id FROM games WHERE id = ?').get(gameId).winner_id;
}

describe('completeGame — winner must be a participant (BUG-9)', () => {
  test('rejects a non-participant winner with 400 and leaves winner_id NULL', async () => {
    await db.addPlayer('CG_Alice'); await db.addPlayer('CG_Bob'); await db.addPlayer('CG_Mallory');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'CG_Alice' }, { name: 'CG_Bob' }],
    });
    assert.throws(() => db.completeGame(gameId, 'CG_Mallory'), (err) => err.status === 400);
    assert.equal(winnerIdOf(gameId), null, 'winner_id must not be set to a non-participant');

    // And the phantom win must not appear in computed stats.
    const stats = db.computeStats();
    assert.deepEqual(stats['CG_Mallory'].h2hGamesWonByCat, {}, 'non-participant must not be credited a win');
  });

  test('accepts a real participant as the winner', async () => {
    await db.addPlayer('CG_Carol'); await db.addPlayer('CG_Dave');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'CG_Carol' }, { name: 'CG_Dave' }],
    });
    assert.doesNotThrow(() => db.completeGame(gameId, 'CG_Carol'));
    const carol = db._db.prepare("SELECT id FROM players WHERE name = 'CG_Carol'").get();
    assert.equal(winnerIdOf(gameId), carol.id);
  });

  test('allows completing with no winner (an abandoned game)', async () => {
    await db.addPlayer('CG_Eve'); await db.addPlayer('CG_Frank');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'CG_Eve' }, { name: 'CG_Frank' }],
    });
    assert.doesNotThrow(() => db.completeGame(gameId, null));
    assert.equal(winnerIdOf(gameId), null);
  });
});
