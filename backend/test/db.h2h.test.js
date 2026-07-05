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

  test('a 3+ player free-for-all still counts if both named players took part (documented, not a bug)', () => {
    const p1 = 'H2H_FFA_P1', p2 = 'H2H_FFA_P2', p3 = 'H2H_FFA_P3';
    db.addPlayer(p1); db.addPlayer(p2); db.addPlayer(p3);
    completeAt(h2hGame([p1, p2, p3]).gameId, p3, 1); // neither p1 nor p2 won, but both took part
    const rec = db.getH2HRecord(p1, p2);
    assert.equal(rec.total, 1, 'both were in this game, even though a third player won it');
    assert.equal(rec.p1Wins, 0);
    assert.equal(rec.p2Wins, 0);
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

  test('an unknown player returns null', () => {
    db.addPlayer('H2H_Summary_Lonely');
    assert.equal(db.getH2HSummary('H2H_Summary_Lonely', 'H2H_Summary_Nobody'), null);
  });
});
