'use strict';
// Committed tests for backend/db.js's Doubles Practice stat formulas
// (docs/archive/game-modes-roadmap.md "Doubles Practice", REFERENCE.md §3) against a
// scratch SQLite database. Mirrors db.cricket-stats.test.js's structure and its
// X01/Cricket-isolation regression-check pattern, extended to the third
// game_type. Not exhaustive; see db.x01-stats.test.js's header comment for the
// same "focused, not 100% coverage" framing.
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

function doublesGame(playerName, doubles) {
  return db.createGame({
    category: `Doubles Practice (${doubles.map(n => n === 25 ? 'Bull' : 'D' + n).join(', ')})`,
    legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'doubles_practice', config: { doubles },
    players: [{ name: playerName }],
  });
}
// Every dart is its own 1-dart turn — bust=1 marks the round-ending dart
// (so-close or wrong-double), matching throwDartDoublesPractice()'s own shape.
function dpTurn(gameId, player, set, leg, [sector, mult], ended) {
  db.addTurn(gameId, {
    player, set, leg, scored: 0, bust: ended, checkout: false, checkoutPoints: null, legWon: false,
    darts: [{ dartNo: 1, sector, multiplier: mult }],
  });
}

describe('getDoublesPracticeStatBubbles', () => {
  test('doublesPct, avgDartsPerRound, avgHitsPerRound, roundsPlayed, dartsThrown', () => {
    const name = 'DP_Bubbles_A';
    db.addPlayer(name);
    const g = doublesGame(name, [16, 8]);
    // Round 1 (leg 1): D16 hit, D8 hit, single-16 ends it ("so close") -> 3 darts, 2 hits.
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [8, 2], false);
    dpTurn(g.gameId, name, 1, 1, [16, 1], true);
    // Round 2 (leg 2): a double on 20 (not a target) ends it immediately ("wrong double").
    dpTurn(g.gameId, name, 1, 2, [20, 2], true);

    const bubbles = db.getDoublesPracticeStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 4);
    assert.equal(bubbles.roundsPlayed, 2);
    assert.equal(bubbles.avgDartsPerRound, 2, '(3+1)/2 rounds');
    assert.equal(bubbles.avgHitsPerRound, 1, '(2+0)/2 rounds');
    assert.equal(bubbles.doublesPct, 50, '2 hits / 4 darts * 100');
  });

  test('a treble on a target number counts as a dart thrown but never a hit', () => {
    const name = 'DP_Treble';
    db.addPlayer(name);
    const g = doublesGame(name, [16]);
    // Treble 16 is "so close" (right number, wrong ring) — ends the round, 0 hits.
    dpTurn(g.gameId, name, 1, 1, [16, 3], true);

    const bubbles = db.getDoublesPracticeStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 1);
    assert.equal(bubbles.doublesPct, 0);
  });

  test('double-bull (sector 25, mult 2) counts as a hit when bull is a target', () => {
    const name = 'DP_Bull';
    db.addPlayer(name);
    const g = doublesGame(name, [25]);
    dpTurn(g.gameId, name, 1, 1, [25, 2], false);
    dpTurn(g.gameId, name, 1, 1, [25, 1], true); // single bull -> so-close, ends round

    const bubbles = db.getDoublesPracticeStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 2);
    assert.equal(bubbles.doublesPct, 50);
  });

  test('no rounds recorded yet returns nulls, not NaN/errors', () => {
    const name = 'DP_Empty';
    db.addPlayer(name);
    const bubbles = db.getDoublesPracticeStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 0);
    assert.equal(bubbles.roundsPlayed, 0);
    assert.equal(bubbles.doublesPct, null);
    assert.equal(bubbles.avgDartsPerRound, null);
    assert.equal(bubbles.avgHitsPerRound, null);
  });
});

describe('getDoublesPracticePersonalBests', () => {
  test('bestRoundDarts and bestRoundHits track the single best round, not the average', () => {
    const name = 'DP_PB_A';
    db.addPlayer(name);
    const g = doublesGame(name, [16, 8, 4]);
    // Round 1: short round, ends on dart 1 (wrong double).
    dpTurn(g.gameId, name, 1, 1, [20, 2], true);
    // Round 2: a long streak of hits before ending -> the personal best round.
    dpTurn(g.gameId, name, 1, 2, [16, 2], false);
    dpTurn(g.gameId, name, 1, 2, [8, 2], false);
    dpTurn(g.gameId, name, 1, 2, [4, 2], false);
    dpTurn(g.gameId, name, 1, 2, [16, 1], true); // so-close, ends round 2 at 4 darts, 3 hits

    const pb = db.getDoublesPracticePersonalBests(name, 'practice');
    assert.equal(pb.bestRoundDarts, 4, 'round 2 (4 darts) beats round 1 (1 dart)');
    assert.equal(pb.bestRoundHits, 3, 'round 2 had 3 hits vs round 1\'s 0');
  });

  test('no rounds recorded yet returns nulls', () => {
    const name = 'DP_PB_Empty';
    db.addPlayer(name);
    const pb = db.getDoublesPracticePersonalBests(name, 'practice');
    assert.equal(pb.bestRoundDarts, null);
    assert.equal(pb.bestRoundHits, null);
  });
});

describe('getMetricHistory matches getDoublesPracticeStatBubbles (docs/archive/game-modes-roadmap.md)', () => {
  test('"doublespracticepct" over "all" time equals the stat-bubble value', () => {
    const name = 'DP_Metric_A';
    db.addPlayer(name);
    const g = doublesGame(name, [16]);
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [16, 1], true);

    const bubbles = db.getDoublesPracticeStatBubbles(name, 'practice');
    const history = db.getMetricHistory(name, 'doublespracticepct', 'all', { mode: 'practice' });
    assert.equal(history.length, 1, 'one bucket for one calendar month of activity');
    assert.equal(history[0].value, bubbles.doublesPct);
  });

  test('"doublespracticedartsperround" and "doublespracticehitsperround" are consistent with the per-round personal bests', () => {
    const name = 'DP_Metric_B';
    db.addPlayer(name);
    const g = doublesGame(name, [16]);
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [20, 2], true); // wrong double, 3 darts, 2 hits this round

    const dartsHistory = db.getMetricHistory(name, 'doublespracticedartsperround', 'all', { mode: 'practice' });
    const hitsHistory = db.getMetricHistory(name, 'doublespracticehitsperround', 'all', { mode: 'practice' });
    assert.equal(dartsHistory[0].value, 3);
    assert.equal(hitsHistory[0].value, 2);
  });
});

describe('getDoublesPracticeAccuracyLeaderboard (Home page leaderboard, docs/archive/game-modes-roadmap.md "known gaps")', () => {
  test('requires at least 5 rounds (mirrors getCricketMprLeaderboard\'s 5-round floor convention)', () => {
    const under = 'DP_Acc_Under5', over = 'DP_Acc_Over5';
    db.addPlayer(under); db.addPlayer(over);
    const gu = doublesGame(under, [20]);
    for (let i = 0; i < 4; i++) dpTurn(gu.gameId, under, 1, i + 1, [20, 2], true); // 4 rounds, all hits -> excluded
    const go = doublesGame(over, [20]);
    for (let i = 0; i < 5; i++) dpTurn(go.gameId, over, 1, i + 1, [20, 2], true); // 5 rounds, all hits -> included, 100%
    const rows = db.getDoublesPracticeAccuracyLeaderboard();
    const names = rows.map(r => r.name);
    assert.ok(!names.includes(under), 'under the 5-round floor is excluded entirely');
    const overRow = rows.find(r => r.name === over);
    assert.equal(overRow.pct, 100);
    assert.equal(overRow.rounds, 5);
  });

  test('pct is computed across darts, not rounds, and rows sort descending by pct', () => {
    const lo = 'DP_Acc_Lo', hi = 'DP_Acc_Hi';
    db.addPlayer(lo); db.addPlayer(hi);
    const gl = doublesGame(lo, [20]);
    // 5 rounds, 1 hit + 1 miss(wrong double) each -> 5 hits / 10 darts = 50%
    for (let i = 0; i < 5; i++) {
      dpTurn(gl.gameId, lo, 1, i * 2 + 1, [20, 2], false);
      dpTurn(gl.gameId, lo, 1, i * 2 + 2, [19, 2], true);
    }
    const gh = doublesGame(hi, [20]);
    // 5 rounds, straight hit-then-end each -> 5 hits / 5 darts = 100%
    for (let i = 0; i < 5; i++) dpTurn(gh.gameId, hi, 1, i + 1, [20, 2], true);
    const rows = db.getDoublesPracticeAccuracyLeaderboard();
    const loRow = rows.find(r => r.name === lo), hiRow = rows.find(r => r.name === hi);
    assert.equal(loRow.pct, 50);
    assert.equal(hiRow.pct, 100);
    assert.ok(rows.indexOf(hiRow) < rows.indexOf(loRow), 'higher accuracy ranks first');
  });
});

describe('getDoublesPracticeBestRoundStats (Home page leaderboard, docs/archive/game-modes-roadmap.md "known gaps")', () => {
  test('one row per player, their own best round by hits (ties broken by fewest darts)', () => {
    const name = 'DP_Best_A';
    db.addPlayer(name);
    const g = doublesGame(name, [16, 8]);
    // Round 1: 1 hit, 2 darts
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [20, 2], true);
    // Round 2: 2 hits, 3 darts -- the best round
    dpTurn(g.gameId, name, 1, 2, [16, 2], false);
    dpTurn(g.gameId, name, 1, 2, [8, 2], false);
    dpTurn(g.gameId, name, 1, 2, [20, 2], true);
    const rows = db.getDoublesPracticeBestRoundStats();
    const row = rows.find(r => r.name === name);
    assert.equal(row.hits, 2);
    assert.equal(row.darts, 3);
  });

  test('a tie on hits is broken by fewer darts', () => {
    const name = 'DP_Best_Tie';
    db.addPlayer(name);
    const g = doublesGame(name, [16]);
    // Round 1: 1 hit in 3 darts (2 misses padded via so-close never firing early here —
    // just two extra non-ending darts before the ender)
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [20, 2], true); // 2 hits, 3 darts total
    // Round 2: same 2 hits, but in only 2 darts -- should win the tiebreak
    dpTurn(g.gameId, name, 1, 2, [16, 2], false);
    dpTurn(g.gameId, name, 1, 2, [16, 2], true); // wrong-double-shaped end but still counts as a hit dart above
    const rows = db.getDoublesPracticeBestRoundStats();
    const row = rows.find(r => r.name === name);
    assert.equal(row.hits, 2);
    assert.equal(row.darts, 2, 'round 2 hit the same 2-hit mark in fewer darts');
  });

  test('multiple players sort by hits descending', () => {
    const a = 'DP_Best_MultiA', b = 'DP_Best_MultiB';
    db.addPlayer(a); db.addPlayer(b);
    const ga = doublesGame(a, [20]);
    dpTurn(ga.gameId, a, 1, 1, [20, 2], true); // 1 hit, 1 dart
    const gb = doublesGame(b, [20]);
    dpTurn(gb.gameId, b, 1, 1, [20, 2], false);
    dpTurn(gb.gameId, b, 1, 1, [20, 2], false);
    dpTurn(gb.gameId, b, 1, 1, [19, 2], true); // 2 hits, 3 darts
    const rows = db.getDoublesPracticeBestRoundStats();
    const aIdx = rows.findIndex(r => r.name === a), bIdx = rows.findIndex(r => r.name === b);
    assert.ok(bIdx < aIdx, 'b\'s 2-hit best round ranks above a\'s 1-hit best round');
  });
});

describe('Doubles Practice does not pollute X01/Cricket stats (regression, mirrors the earlier X01_ONLY/CRICKET_ONLY audit)', () => {
  test('an X01 player\'s 3-dart average and darts-thrown-in-X01-scope are unaffected by a Doubles Practice game', () => {
    const name = 'DP_Isolation';
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

    const g = doublesGame(name, [16]);
    dpTurn(g.gameId, name, 1, 1, [16, 2], false);
    dpTurn(g.gameId, name, 1, 1, [20, 2], true);

    const afterX01 = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(afterX01.avgDarts, beforeX01.avgDarts, 'X01 3-dart average sums must not shift after an unrelated Doubles Practice game');
    // dartsThrown IS a deliberately all-game-types aggregate (matches Cricket's darts
    // already counting toward it per REFERENCE.md) — it SHOULD grow by the 2 Doubles
    // Practice darts, confirming they're real physical darts, not silently dropped.
    assert.equal(afterX01.dartsThrown, beforeX01.dartsThrown + 2);
  });
});
