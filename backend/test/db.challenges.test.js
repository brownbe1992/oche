'use strict';
// Committed tests for backend/db.js's Daily Challenge logic (REFERENCE.md §6) —
// one-attempt-per-day locking, personal-best detection, streak semantics (including
// the DNF-today fix from this session's audit), and the admin reset cascade.
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

function practiceGame(playerName) {
  return db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: playerName }] });
}

describe('startChallengeAttempt / completeChallengeAttempt', () => {
  test('basic round trip: start, complete, status reflects it', () => {
    const name = 'Challenge_Basic';
    db.addPlayer(name);
    const g = practiceGame(name);
    db.startChallengeAttempt(name, g.gameId, '2021-06-01', 'speed_to_zero', null);
    db.completeChallengeAttempt(name, '2021-06-01', 30);
    const status = db.getChallengeStatus(name, '2021-06-01');
    assert.equal(status.today.completed, 1);
    assert.equal(status.today.result_darts, 30);
  });

  test('a second attempt on the same calendar day is rejected with 409', () => {
    const name = 'Challenge_Duplicate';
    db.addPlayer(name);
    const g1 = practiceGame(name);
    db.startChallengeAttempt(name, g1.gameId, '2021-06-01', 'speed_to_zero', null);
    const g2 = practiceGame(name);
    assert.throws(
      () => db.startChallengeAttempt(name, g2.gameId, '2021-06-01', 'speed_to_zero', null),
      (err) => err.status === 409
    );
  });

  test('completion is locked: a repeat completion is a no-op, does not overwrite the result', () => {
    const name = 'Challenge_Locked';
    db.addPlayer(name);
    const g = practiceGame(name);
    db.startChallengeAttempt(name, g.gameId, '2021-06-01', 'speed_to_zero', null);
    db.completeChallengeAttempt(name, '2021-06-01', 25);
    const second = db.completeChallengeAttempt(name, '2021-06-01', 999); // an attempted overwrite
    assert.equal(second.alreadyCompleted, true);
    const status = db.getChallengeStatus(name, '2021-06-01');
    assert.equal(status.today.result_darts, 25, 'the original result survives, not the repeat\'s 999');
  });

  test('completing with no matching attempt for that date is a 404', () => {
    const name = 'Challenge_NoAttempt';
    db.addPlayer(name);
    assert.throws(
      () => db.completeChallengeAttempt(name, '2021-06-01', 30),
      (err) => err.status === 404
    );
  });
});

// docs/security-audit-roadmap.md SEC-14 / docs/bug-roadmap.md BUG-1: the write path
// previously stored challengeDate/format via bare String(...) with no validation,
// even though every READ path (getChallengeStatus, resetChallengeAttempt) requires
// challengeDate to match ^\d{4}-\d{2}-\d{2}$ and the streak walks assume it parses
// as a real calendar date — a malformed write would count toward
// getChallengeHistory()'s totals but corrupt the streak walk silently.
describe('startChallengeAttempt / completeChallengeAttempt — date/format validation', () => {
  test('rejects a malformed challengeDate on start', () => {
    const name = 'Challenge_BadDateStart';
    db.addPlayer(name);
    const g = practiceGame(name);
    assert.throws(() => db.startChallengeAttempt(name, g.gameId, '2021-6-1', 'speed_to_zero', null), (err) => err.status === 400);
    assert.throws(() => db.startChallengeAttempt(name, g.gameId, 'not-a-date', 'speed_to_zero', null), (err) => err.status === 400);
  });

  test('rejects an unknown format on start', () => {
    const name = 'Challenge_BadFormat';
    db.addPlayer(name);
    const g = practiceGame(name);
    assert.throws(() => db.startChallengeAttempt(name, g.gameId, '2021-06-01', 'made_up_format', null), (err) => err.status === 400);
  });

  test('accepts every known format', () => {
    const formats = ['checkout_sprint', 'speed_to_zero', 'bullseye_gauntlet', 'steady_hand', 'treble_run', 'long_game'];
    formats.forEach((format, i) => {
      const name = 'Challenge_Format_' + i;
      db.addPlayer(name);
      const g = practiceGame(name);
      const date = `2021-07-${String(i + 1).padStart(2, '0')}`;
      assert.doesNotThrow(() => db.startChallengeAttempt(name, g.gameId, date, format, format === 'checkout_sprint' ? 40 : null));
    });
  });

  test('rejects a malformed challengeDate on complete', () => {
    const name = 'Challenge_BadDateComplete';
    db.addPlayer(name);
    const g = practiceGame(name);
    db.startChallengeAttempt(name, g.gameId, '2021-06-02', 'speed_to_zero', null);
    assert.throws(() => db.completeChallengeAttempt(name, '2021-6-2', 30), (err) => err.status === 400);
  });
});

describe('personal best detection (CHALLENGE_BETTER_DIRECTION)', () => {
  test('speed_to_zero (fewer darts is better): first ever completion is trivially a PB, a worse one is not, a better one is', () => {
    const name = 'Challenge_PB_Asc';
    db.addPlayer(name);
    const g1 = practiceGame(name);
    db.startChallengeAttempt(name, g1.gameId, '2021-01-01', 'speed_to_zero', null);
    const first = db.completeChallengeAttempt(name, '2021-01-01', 30);
    assert.equal(first.isPersonalBest, true, 'nothing to compare against yet');

    const g2 = practiceGame(name);
    db.startChallengeAttempt(name, g2.gameId, '2021-01-02', 'speed_to_zero', null);
    const worse = db.completeChallengeAttempt(name, '2021-01-02', 35); // more darts = worse
    assert.equal(worse.isPersonalBest, false);

    const g3 = practiceGame(name);
    db.startChallengeAttempt(name, g3.gameId, '2021-01-03', 'speed_to_zero', null);
    const better = db.completeChallengeAttempt(name, '2021-01-03', 27); // fewer darts = better
    assert.equal(better.isPersonalBest, true);
  });

  test('bullseye_gauntlet (more is better): direction is reversed', () => {
    const name = 'Challenge_PB_Desc';
    db.addPlayer(name);
    const g1 = practiceGame(name);
    db.startChallengeAttempt(name, g1.gameId, '2021-01-01', 'bullseye_gauntlet', null);
    db.completeChallengeAttempt(name, '2021-01-01', 3);

    const g2 = practiceGame(name);
    db.startChallengeAttempt(name, g2.gameId, '2021-01-02', 'bullseye_gauntlet', null);
    const worse = db.completeChallengeAttempt(name, '2021-01-02', 2); // fewer bulls = worse
    assert.equal(worse.isPersonalBest, false);

    const g3 = practiceGame(name);
    db.startChallengeAttempt(name, g3.gameId, '2021-01-03', 'bullseye_gauntlet', null);
    const better = db.completeChallengeAttempt(name, '2021-01-03', 5); // more bulls = better
    assert.equal(better.isPersonalBest, true);
  });
});

describe('getChallengeStatus — current streak', () => {
  test('an attempted-but-DNF\'d today reads streak 0, even after a real prior streak', () => {
    const name = 'Challenge_Streak_DNF';
    db.addPlayer(name);
    const yesterday = practiceGame(name);
    db.startChallengeAttempt(name, yesterday.gameId, '2021-03-01', 'speed_to_zero', null);
    db.completeChallengeAttempt(name, '2021-03-01', 20);
    const today = practiceGame(name);
    db.startChallengeAttempt(name, today.gameId, '2021-03-02', 'speed_to_zero', null);
    // no completion for today's attempt — a DNF
    const status = db.getChallengeStatus(name, '2021-03-02');
    assert.equal(status.streak, 0, 'attempted-but-incomplete today breaks the streak immediately, no yesterday grace');
  });

  test('an UNATTEMPTED today keeps the prior streak (the day isn\'t over yet)', () => {
    const name = 'Challenge_Streak_Grace';
    db.addPlayer(name);
    const g1 = practiceGame(name);
    db.startChallengeAttempt(name, g1.gameId, '2021-03-01', 'speed_to_zero', null);
    db.completeChallengeAttempt(name, '2021-03-01', 20);
    const status = db.getChallengeStatus(name, '2021-03-02'); // no row at all for 03-02
    assert.equal(status.streak, 1, 'yesterday\'s completion still counts even though today has no attempt yet');
  });

  test('a completed today extends the streak', () => {
    const name = 'Challenge_Streak_Today';
    db.addPlayer(name);
    const g1 = practiceGame(name);
    db.startChallengeAttempt(name, g1.gameId, '2021-03-01', 'speed_to_zero', null);
    db.completeChallengeAttempt(name, '2021-03-01', 20);
    const g2 = practiceGame(name);
    db.startChallengeAttempt(name, g2.gameId, '2021-03-02', 'speed_to_zero', null);
    db.completeChallengeAttempt(name, '2021-03-02', 18);
    const status = db.getChallengeStatus(name, '2021-03-02');
    assert.equal(status.streak, 2);
  });
});

describe('getChallengeHistory — longest-ever streak (independent forward walk)', () => {
  test('resets to 1 (not 0) after a >1-day gap between completions, and to 0 after a DNF', () => {
    const name = 'Challenge_Longest';
    db.addPlayer(name);
    const mk = (date, complete) => {
      const g = practiceGame(name);
      db.startChallengeAttempt(name, g.gameId, date, 'speed_to_zero', null);
      if (complete) db.completeChallengeAttempt(name, date, 20);
    };
    mk('2020-01-01', true);
    mk('2020-01-02', true); // consecutive -> run 2
    mk('2020-01-04', true); // gap of 2 days -> run resets to 1, not 0
    mk('2020-01-05', true); // consecutive -> run 2
    mk('2020-01-06', false); // DNF -> run resets to 0
    mk('2020-01-07', true); // run 1
    const history = db.getChallengeHistory(name, '2020-01-07');
    assert.equal(history.longestStreak, 2);
    assert.equal(history.played, 6);
    assert.equal(history.completed, 5);
  });

  test('bestByFormat picks the right direction per format', () => {
    const name = 'Challenge_BestByFormat';
    db.addPlayer(name);
    const mk = (date, format, result) => {
      const g = practiceGame(name);
      db.startChallengeAttempt(name, g.gameId, date, format, null);
      db.completeChallengeAttempt(name, date, result);
    };
    mk('2020-02-01', 'speed_to_zero', 30);
    mk('2020-02-02', 'speed_to_zero', 25); // better (fewer)
    mk('2020-02-03', 'bullseye_gauntlet', 2);
    mk('2020-02-04', 'bullseye_gauntlet', 4); // better (more)
    const history = db.getChallengeHistory(name, '2020-02-04');
    assert.equal(history.bestByFormat.speed_to_zero, 25);
    assert.equal(history.bestByFormat.bullseye_gauntlet, 4);
  });
});

describe('resetChallengeAttempt (admin reset)', () => {
  test('deletes the linked game (and its turns/darts) and the attempt row, unlocking a retake', () => {
    const name = 'Challenge_Reset';
    db.addPlayer(name);
    const g = practiceGame(name);
    db.startChallengeAttempt(name, g.gameId, '2021-07-01', 'speed_to_zero', null);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60, bust: false, checkout: false,
      darts: [{ sector: 20, multiplier: 1 }] });
    db.completeChallengeAttempt(name, '2021-07-01', 20);

    db.resetChallengeAttempt(name, '2021-07-01');

    const gameRow = db._db.prepare('SELECT id FROM games WHERE id = ?').get(g.gameId);
    assert.equal(gameRow, undefined, 'the linked game is gone');
    const turnRows = db._db.prepare('SELECT id FROM turns WHERE game_id = ?').all(g.gameId);
    assert.equal(turnRows.length, 0, 'its turns cascade-deleted with it');
    const status = db.getChallengeStatus(name, '2021-07-01');
    assert.equal(status.today, null, 'no attempt record remains for that date');

    // A fresh attempt for the same date is now allowed (UNIQUE constraint cleared).
    const g2 = practiceGame(name);
    assert.doesNotThrow(() => db.startChallengeAttempt(name, g2.gameId, '2021-07-01', 'speed_to_zero', null));
  });

  test('resetting a nonexistent attempt is a 404', () => {
    const name = 'Challenge_ResetMissing';
    db.addPlayer(name);
    assert.throws(
      () => db.resetChallengeAttempt(name, '2021-07-01'),
      (err) => err.status === 404
    );
  });
});
