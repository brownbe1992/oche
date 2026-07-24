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

// Committed regression test for a gap found reviewing the forfeit/DNF feature
// (docs/open-roadmap-items.md "Forfeiting a multiplayer game"): completeGame()
// had no "already ended" guard at all, unlike its siblings forfeitPlayer()/
// abandonGame(), which both reject a game whose completed_at or dnf_at is
// already set. Without it, two devices/tabs scoring the same game (the same
// class of race docs/bug-roadmap.md BUG-13 already documents for
// deleteLastTurn()) could each call completeGame() with a different winner —
// the second call would silently overwrite games.winner_id and re-fire the
// 'completed' lifecycle hook — or stamp completed_at onto a row that already
// has dnf_at set, violating the "never both" invariant every completed_at/
// dnf_at consumer relies on.
describe('completeGame — rejects a game that has already ended', () => {
  test('a second completeGame() call on an already-completed game is rejected, winner_id unchanged', async () => {
    await db.addPlayer('CG_Gina'); await db.addPlayer('CG_Hank');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'CG_Gina' }, { name: 'CG_Hank' }],
    });
    db.completeGame(gameId, 'CG_Gina');
    const gina = db._db.prepare("SELECT id FROM players WHERE name = 'CG_Gina'").get();
    assert.equal(winnerIdOf(gameId), gina.id);
    assert.throws(() => db.completeGame(gameId, 'CG_Hank'), (err) => err.status === 409);
    assert.equal(winnerIdOf(gameId), gina.id, 'a rejected replay must not overwrite the real winner');
  });

  test('completeGame() is rejected on a game already marked DNF (abandoned)', async () => {
    await db.addPlayer('CG_Ivy'); await db.addPlayer('CG_Jack');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'CG_Ivy' }, { name: 'CG_Jack' }],
    });
    db.abandonGame(gameId);
    assert.throws(() => db.completeGame(gameId, 'CG_Ivy'), (err) => err.status === 409);
    assert.equal(winnerIdOf(gameId), null, 'completed_at/winner_id must never be set on a DNF game');
  });
});
