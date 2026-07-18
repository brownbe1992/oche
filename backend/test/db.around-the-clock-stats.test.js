'use strict';
// Committed tests for backend/db.js's guided Around the Clock stat formulas
// (docs/archive/game-modes-roadmap.md "Guided Around the Clock / Around the World",
// REFERENCE.md §3) against a scratch SQLite database. Mirrors
// db.doubles-practice-stats.test.js's structure and its X01/Cricket-isolation
// regression-check pattern, extended to this fifth game_type. Not exhaustive; see
// db.x01-stats.test.js's header comment for the same "focused, not 100% coverage"
// framing.
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

function clockGame(playerName) {
  return db.createGame({
    category: 'Guided Around the Clock', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'around_the_clock', config: {},
    players: [{ name: playerName }],
  });
}
// Every dart is its own 1-dart turn — bust=1 marks whichever dart completed the
// round (all 20 numbers hit as singles), matching throwDartAroundTheClock()'s
// own shape. leg is the round counter (repurposed leg_no).
function atcTurn(gameId, player, leg, [sector, mult], ended) {
  db.addTurn(gameId, {
    player, set: 1, leg, scored: 0, bust: ended, checkout: false, checkoutPoints: null, legWon: false,
    darts: [{ dartNo: 1, sector, multiplier: mult }],
  });
}
// Throws singles 1..20 in order into the given round, marking the 20th as the
// round-ending dart.
function completeRound(gameId, player, leg) {
  for (let n = 1; n <= 20; n++) atcTurn(gameId, player, leg, [n, 1], n === 20);
}

describe('getAroundTheClockStatBubbles', () => {
  test('dartsThrown, sessionsPlayed, completions, completionRate, avgDartsPerCompletion', () => {
    const name = 'ATC_Bubbles_A';
    db.addPlayer(name);
    const g = clockGame(name);
    completeRound(g.gameId, name, 1); // 20 darts, completed
    // Round 2: abandoned after 5 darts (no bust=1 dart ever recorded).
    for (let n = 1; n <= 5; n++) atcTurn(g.gameId, name, 2, [n, 1], false);

    const bubbles = db.getAroundTheClockStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 25);
    assert.equal(bubbles.sessionsPlayed, 2);
    assert.equal(bubbles.completions, 1);
    assert.equal(bubbles.completionRate, 50);
    assert.equal(bubbles.avgDartsPerCompletion, 20);
  });

  test('a treble/double on a number is a real dart thrown but never advances completion', () => {
    const name = 'ATC_NoBull';
    db.addPlayer(name);
    const g = clockGame(name);
    // Treble/double 5 don't count as the single-5 hit; round never completes.
    atcTurn(g.gameId, name, 1, [5, 3], false);
    atcTurn(g.gameId, name, 1, [5, 2], false);
    const bubbles = db.getAroundTheClockStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 2);
    assert.equal(bubbles.completions, 0);
    assert.equal(bubbles.completionRate, 0);
  });

  test('no rounds recorded yet returns nulls/zeros, not NaN/errors', () => {
    const name = 'ATC_Empty';
    db.addPlayer(name);
    const bubbles = db.getAroundTheClockStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 0);
    assert.equal(bubbles.sessionsPlayed, 0);
    assert.equal(bubbles.completions, 0);
    assert.equal(bubbles.completionRate, null);
    assert.equal(bubbles.avgDartsPerCompletion, null);
  });
});

describe('getAroundTheClockPersonalBests', () => {
  test('bestCompletionDarts tracks the fastest completed round, ignoring abandoned/slower ones', () => {
    const name = 'ATC_PB_A';
    db.addPlayer(name);
    const g = clockGame(name);
    completeRound(g.gameId, name, 1); // 20 darts, completed — the fast one
    // Round 2: completed, but with a repeat dart on number 1 first -> 21 darts.
    atcTurn(g.gameId, name, 2, [1, 1], false);
    for (let n = 1; n <= 20; n++) atcTurn(g.gameId, name, 2, [n, 1], n === 20);
    // Round 3: abandoned, never completed — must not count as a "best".
    atcTurn(g.gameId, name, 3, [1, 1], false);

    const pb = db.getAroundTheClockPersonalBests(name, 'practice');
    assert.equal(pb.bestCompletionDarts, 20, 'round 1 (20 darts) beats round 2 (21 darts); round 3 never completed');
  });

  test('no completed rounds yet returns null', () => {
    const name = 'ATC_PB_Empty';
    db.addPlayer(name);
    const g = clockGame(name);
    atcTurn(g.gameId, name, 1, [1, 1], false); // abandoned, never completed
    const pb = db.getAroundTheClockPersonalBests(name, 'practice');
    assert.equal(pb.bestCompletionDarts, null);
  });
});

describe('getMetricHistory matches getAroundTheClockStatBubbles/PersonalBests', () => {
  test('"atcdartsthrown" over "all" time equals the stat-bubble dartsThrown', () => {
    const name = 'ATC_Metric_A';
    db.addPlayer(name);
    const g = clockGame(name);
    completeRound(g.gameId, name, 1);

    const bubbles = db.getAroundTheClockStatBubbles(name, 'practice');
    const history = db.getMetricHistory(name, 'atcdartsthrown', 'all', { mode: 'practice' });
    assert.equal(history.length, 1, 'one bucket for one calendar month of activity');
    assert.equal(history[0].value, bubbles.dartsThrown);
  });

  test('"atccompletions" and "atcavgdartspercompletion" only count completed rounds', () => {
    const name = 'ATC_Metric_B';
    db.addPlayer(name);
    const g = clockGame(name);
    completeRound(g.gameId, name, 1); // 20 darts, completed
    atcTurn(g.gameId, name, 2, [1, 1], false); // abandoned

    const completions = db.getMetricHistory(name, 'atccompletions', 'all', { mode: 'practice' });
    const avgDarts = db.getMetricHistory(name, 'atcavgdartspercompletion', 'all', { mode: 'practice' });
    assert.equal(completions[0].value, 1);
    assert.equal(avgDarts[0].value, 20);
  });
});

describe('getAroundTheClockFastestLeaderboard (Home page leaderboard)', () => {
  test('one row per player, their own fastest completion, sorted ascending by darts', () => {
    const fast = 'ATC_Fast_A', slow = 'ATC_Fast_B';
    db.addPlayer(fast); db.addPlayer(slow);
    const gf = clockGame(fast);
    completeRound(gf.gameId, fast, 1); // 20 darts
    const gs = clockGame(slow);
    atcTurn(gs.gameId, slow, 1, [1, 1], false); // one repeat before completing
    for (let n = 1; n <= 20; n++) atcTurn(gs.gameId, slow, 1, [n, 1], n === 20); // 21 darts

    const rows = db.getAroundTheClockFastestLeaderboard();
    const fastRow = rows.find(r => r.name === fast), slowRow = rows.find(r => r.name === slow);
    assert.equal(fastRow.darts, 20);
    assert.equal(slowRow.darts, 21);
    assert.ok(rows.indexOf(fastRow) < rows.indexOf(slowRow), 'fewer darts ranks first');
  });

  test('a player with only abandoned rounds (never completed) does not appear', () => {
    const name = 'ATC_Fast_NeverDone';
    db.addPlayer(name);
    const g = clockGame(name);
    atcTurn(g.gameId, name, 1, [1, 1], false);
    const rows = db.getAroundTheClockFastestLeaderboard();
    assert.ok(!rows.some(r => r.name === name));
  });
});

describe('getAroundTheClockCompletionsLeaderboard (Home page leaderboard)', () => {
  test('counts completions per player, sorted descending', () => {
    const a = 'ATC_Comp_A', b = 'ATC_Comp_B';
    db.addPlayer(a); db.addPlayer(b);
    const ga = clockGame(a);
    completeRound(ga.gameId, a, 1);
    const gb = clockGame(b);
    completeRound(gb.gameId, b, 1);
    completeRound(gb.gameId, b, 2);

    const rows = db.getAroundTheClockCompletionsLeaderboard();
    const aIdx = rows.findIndex(r => r.name === a), bIdx = rows.findIndex(r => r.name === b);
    assert.equal(rows.find(r => r.name === a).completions, 1);
    assert.equal(rows.find(r => r.name === b).completions, 2);
    assert.ok(bIdx < aIdx, 'b\'s 2 completions rank above a\'s 1');
  });
});

describe('guided Around the Clock does not pollute X01/Cricket/Chuckin stats (regression, mirrors the earlier X01_ONLY/NOT_CHUCKIN audits)', () => {
  test('an X01 player\'s 3-dart average is unaffected by a guided Around the Clock game, but dartsThrown grows', () => {
    const name = 'ATC_Isolation';
    db.addPlayer(name);
    const x01Game = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 },
      players: [{ name }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 3 }],
    });
    const beforeX01 = db.getPlayerStatBubbles(name, 'practice');

    const g = clockGame(name);
    completeRound(g.gameId, name, 1); // 20 darts

    const afterX01 = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(afterX01.avgDarts, beforeX01.avgDarts, 'X01 3-dart average sums must not shift after an unrelated Around the Clock game');
    // dartsThrown IS a deliberately all-game-types aggregate — it SHOULD grow by
    // the 20 Around the Clock darts, confirming they're real physical darts.
    assert.equal(afterX01.dartsThrown, beforeX01.dartsThrown + 20);
  });
});
