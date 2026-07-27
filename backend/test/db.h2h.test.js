'use strict';
// Committed tests for backend/db.js's H2H record functions (REFERENCE.md §3
// "Head-to-Head") — getH2HRecord (win/loss counts) and getH2HSummary
// (previousWinner/totalGames, used by the Rematch/Grudge Match badges).
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

function h2hGame(names) {
  return db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: names.map(name => ({ name })) });
}
// completeGame() stamps completed_at via datetime('now') (second resolution) —
// tests that depend on chronological order set it explicitly, same technique as
// db.x01-stats.test.js's winStreak test.
function completeAt(gameId, winner, secondsFromNow) {
  db.completeGame(gameId, winner);
  db._db.prepare("UPDATE games SET completed_at = datetime('now', ? || ' seconds') WHERE id = ?").run(String(secondsFromNow), gameId);
}

describe('getH2HRecord', () => {
  test('counts completed, non-practice games between the two named players', () => {
    const p1 = 'H2H_Record_P1', p2 = 'H2H_Record_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    completeAt(h2hGame([p1, p2]).gameId, p1, 1);
    completeAt(h2hGame([p1, p2]).gameId, p1, 2);
    completeAt(h2hGame([p1, p2]).gameId, p2, 3);
    const rec = db.getH2HRecord(p1, p2);
    assert.equal(rec.p1Wins, 2);
    assert.equal(rec.p2Wins, 1);
    assert.equal(rec.total, 3);
  });

  test('is case-insensitive on player names, matching players.name COLLATE NOCASE', () => {
    const p1 = 'H2H_Case_Alice', p2 = 'H2H_Case_Bob';
    db.addPlayer(p1); db.addPlayer(p2);
    completeAt(h2hGame([p1, p2]).gameId, p1, 1);
    const rec = db.getH2HRecord(p1.toUpperCase(), p2.toLowerCase());
    assert.equal(rec.total, 1);
  });

  test('an unknown player name returns null', () => {
    db.addPlayer('H2H_Lonely');
    assert.equal(db.getH2HRecord('H2H_Lonely', 'H2H_Nobody'), null);
  });

  // Item 74 (2026-07). This previously counted, and was documented as
  // deliberate; it no longer does. A pairwise record answers "how have these two
  // done against each other", and a game a third person also played — or won —
  // is not a result between them. Tonight's Recap already applied exactly this
  // rule to its own pairwise grid, so the change makes the two agree rather
  // than introducing a new opinion.
  test('a 3+ player free-for-all does NOT count toward a pairwise record', () => {
    const p1 = 'H2H_FFA_P1', p2 = 'H2H_FFA_P2', p3 = 'H2H_FFA_P3';
    db.addPlayer(p1); db.addPlayer(p2); db.addPlayer(p3);
    completeAt(h2hGame([p1, p2, p3]).gameId, p3, 1); // a third player won it
    const rec = db.getH2HRecord(p1, p2);
    assert.equal(rec.total, 0, 'three people played; this was never a duel between p1 and p2');
    assert.equal(rec.p1Wins, 0);
    assert.equal(rec.p2Wins, 0);
  });

  test('a 3-player game WON by one of the two still does not count', () => {
    // The case that actually inflated records: the winner really did beat the
    // other named player — alongside somebody else. It is a win, and it counts
    // on the win-rate leaderboard; it is not a duel, so it does not count here.
    const p1 = 'H2H_FFA2_P1', p2 = 'H2H_FFA2_P2', p3 = 'H2H_FFA2_P3';
    db.addPlayer(p1); db.addPlayer(p2); db.addPlayer(p3);
    completeAt(h2hGame([p1, p2, p3]).gameId, p1, 1);
    assert.equal(db.getH2HRecord(p1, p2).total, 0);
  });

  test('duels alongside free-for-alls: only the duels are counted', () => {
    const p1 = 'H2H_Mix_P1', p2 = 'H2H_Mix_P2', p3 = 'H2H_Mix_P3';
    db.addPlayer(p1); db.addPlayer(p2); db.addPlayer(p3);
    completeAt(h2hGame([p1, p2]).gameId, p1, 1);          // a real duel
    completeAt(h2hGame([p1, p2, p3]).gameId, p1, 2);      // not a duel
    completeAt(h2hGame([p1, p2]).gameId, p2, 3);          // a real duel
    const rec = db.getH2HRecord(p1, p2);
    assert.equal(rec.total, 2, 'the three-player game is excluded');
    assert.equal(rec.p1Wins, 1);
    assert.equal(rec.p2Wins, 1);
  });
});

describe('getH2HSummary', () => {
  test('totalGames matches getH2HRecord\'s total, and previousWinner is the most recent winner', () => {
    const p1 = 'H2H_Summary_P1', p2 = 'H2H_Summary_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    completeAt(h2hGame([p1, p2]).gameId, p1, 1);
    const lastGame = h2hGame([p1, p2]);
    completeAt(lastGame.gameId, p2, 2); // most recent

    const summary = db.getH2HSummary(p1, p2);
    assert.equal(summary.totalGames, 2);
    assert.equal(summary.previousWinner, p2);
  });

  test('excludeGameId skips the just-finished game, revealing who won before it', () => {
    const p1 = 'H2H_Exclude_P1', p2 = 'H2H_Exclude_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    completeAt(h2hGame([p1, p2]).gameId, p1, 1);   // "who won last time before this one"
    const justFinished = h2hGame([p1, p2]);
    completeAt(justFinished.gameId, p2, 2);

    const summary = db.getH2HSummary(p1, p2, justFinished.gameId);
    assert.equal(summary.totalGames, 2, 'totalGames is NOT reduced by exclusion — only previousWinner looks behind it');
    assert.equal(summary.previousWinner, p1, 'the game right before the excluded one');
  });

  test('previousWinner is null when there is no game left after exclusion', () => {
    const p1 = 'H2H_Solo_Summary_P1', p2 = 'H2H_Solo_Summary_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const onlyGame = h2hGame([p1, p2]);
    completeAt(onlyGame.gameId, p1, 1);
    const summary = db.getH2HSummary(p1, p2, onlyGame.gameId);
    assert.equal(summary.previousWinner, null);
  });

  // Item 74 (2026-07) — the two badges this function exists for.
  test('The Rematch cannot fire as revenge for a game that was not a duel', () => {
    // previousWinner drives The Rematch ("revenge over X"). Before the pair
    // filter, a four-player game the opponent happened to win counted as the
    // last result between them, so beating them in an unrelated duel later
    // announced itself as revenge for a match that never happened.
    const p1 = 'H2H_Rematch_P1', p2 = 'H2H_Rematch_P2', p3 = 'H2H_Rematch_P3';
    db.addPlayer(p1); db.addPlayer(p2); db.addPlayer(p3);
    completeAt(h2hGame([p1, p2]).gameId, p1, 1);        // the real last duel: p1 won
    completeAt(h2hGame([p1, p2, p3]).gameId, p2, 2);    // later, but three-handed
    const summary = db.getH2HSummary(p1, p2);
    assert.equal(summary.totalGames, 1, 'only the duel counts');
    assert.equal(summary.previousWinner, p1, 'the three-player game is not "the last time these two met"');
  });

  test('previousWinner is never a player who was not in the game', () => {
    // The latent wrong answer the filter also removes: previousWinner resolves
    // the winner as "p1 or else p2", which is only sound for a two-participant
    // game. A three-player game won by somebody else entirely used to report p2
    // as the winner of a game p2 lost.
    const p1 = 'H2H_Ghost_P1', p2 = 'H2H_Ghost_P2', p3 = 'H2H_Ghost_P3';
    db.addPlayer(p1); db.addPlayer(p2); db.addPlayer(p3);
    completeAt(h2hGame([p1, p2, p3]).gameId, p3, 1);
    const summary = db.getH2HSummary(p1, p2);
    assert.equal(summary.totalGames, 0);
    assert.equal(summary.previousWinner, null, 'these two have never met, so nobody won last time');
  });

  test('Grudge Match counts duels only toward its 10-game milestone', () => {
    const p1 = 'H2H_Grudge_P1', p2 = 'H2H_Grudge_P2', p3 = 'H2H_Grudge_P3';
    db.addPlayer(p1); db.addPlayer(p2); db.addPlayer(p3);
    for (let i = 0; i < 6; i++) completeAt(h2hGame([p1, p2]).gameId, i % 2 ? p1 : p2, i + 1);
    for (let i = 0; i < 6; i++) completeAt(h2hGame([p1, p2, p3]).gameId, p3, 10 + i);
    assert.equal(db.getH2HSummary(p1, p2).totalGames, 6,
      'twelve games contained both players, but only six were between them');
  });

  test('an unknown player returns null', () => {
    db.addPlayer('H2H_Summary_Lonely');
    assert.equal(db.getH2HSummary('H2H_Summary_Lonely', 'H2H_Summary_Nobody'), null);
  });
});
