'use strict';
// Committed tests for backend/db.js's guided Around the World stat formulas
// (docs/archive/game-modes-roadmap.md "Guided Around the Clock / Around the World",
// REFERENCE.md §3) against a scratch SQLite database. Mirrors
// db.chuckin-stats.test.js's structure. getAroundTheWorldProgress()'s own
// 63-outcome-counting formula is already covered by db.leaderboards.test.js —
// this file covers the drill-specific wrapper stats plus (critically) the new
// NOT_CONTINUOUS_STREAM leg/pace exclusion: proving guided Around the World is
// excluded the same way Just Chuckin' It is, while guided Around the Clock (the
// opposite design choice — it has a real leg boundary) stays included, so the
// split in backend/db.js isn't just a blanket exclusion of both new game types.
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

function worldGame(playerName) {
  return db.createGame({
    category: 'Guided Around the World', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'around_the_world', config: {},
    players: [{ name: playerName }],
  });
}
// One continuous stream, set_no=leg_no=1 throughout — mirrors Chuckin's own
// per-dart-turn shape exactly (see throwDartChuckin()'s precedent).
function atwTurn(gameId, player, [sector, mult]) {
  db.addTurn(gameId, {
    player, set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null, legWon: false,
    darts: [{ dartNo: 1, sector, multiplier: mult }],
  });
}

function clockGame(playerName) {
  return db.createGame({
    category: 'Guided Around the Clock', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'around_the_clock', config: {},
    players: [{ name: playerName }],
  });
}
function atcTurn(gameId, player, leg, [sector, mult], ended) {
  db.addTurn(gameId, {
    player, set: 1, leg, scored: 0, bust: ended, checkout: false, checkoutPoints: null, legWon: false,
    darts: [{ dartNo: 1, sector, multiplier: mult }],
  });
}

describe('getAroundTheWorldDrillStatBubbles', () => {
  test('dartsThrown, sessionsPlayed, avgDartsPerSession, and progress/total', () => {
    const name = 'ATW_Bubbles_A';
    db.addPlayer(name);
    const g1 = worldGame(name);
    atwTurn(g1.gameId, name, [1, 1]);
    atwTurn(g1.gameId, name, [1, 2]);
    const g2 = worldGame(name);
    atwTurn(g2.gameId, name, [1, 3]);

    const bubbles = db.getAroundTheWorldDrillStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 3);
    assert.equal(bubbles.sessionsPlayed, 2);
    assert.equal(bubbles.avgDartsPerSession, 1.5);
    assert.equal(bubbles.total, 63);
    assert.equal(bubbles.progress, 3, 'S1, D1, T1 — three distinct lifetime outcomes');
  });

  test('progress is the same lifetime tracker other modes feed, not scoped to this drill alone', () => {
    const name = 'ATW_Bubbles_Cross';
    db.addPlayer(name);
    const x01Game = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 },
      players: [{ name }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    });
    const g = worldGame(name);
    atwTurn(g.gameId, name, [19, 1]); // a different outcome than the X01 dart above

    const bubbles = db.getAroundTheWorldDrillStatBubbles(name, 'practice');
    assert.equal(bubbles.progress, 2, 'the X01 T20 and the drill S19 both count toward the same lifetime total');
  });

  test('no sessions recorded yet returns zeros/nulls, not NaN/errors', () => {
    const name = 'ATW_Empty';
    db.addPlayer(name);
    const bubbles = db.getAroundTheWorldDrillStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 0);
    assert.equal(bubbles.sessionsPlayed, 0);
    assert.equal(bubbles.avgDartsPerSession, null);
    assert.equal(bubbles.progress, 0);
    assert.equal(bubbles.total, 63);
  });
});

describe('getAroundTheWorldPersonalBests', () => {
  test('sessionsPlayed and lifetime progress, not a per-round record (this mode never "wins")', () => {
    const name = 'ATW_PB_A';
    db.addPlayer(name);
    const g = worldGame(name);
    atwTurn(g.gameId, name, [1, 1]);
    const pb = db.getAroundTheWorldPersonalBests(name, 'practice');
    assert.equal(pb.sessionsPlayed, 1);
    assert.equal(pb.progress, 1);
    assert.equal(pb.total, 63);
  });
});

describe('getMetricHistory matches getAroundTheWorldDrillStatBubbles', () => {
  test('"atwdartsthrown" and "atwsessions" over "all" time equal the stat-bubble values', () => {
    const name = 'ATW_Metric_A';
    db.addPlayer(name);
    const g = worldGame(name);
    atwTurn(g.gameId, name, [1, 1]);
    atwTurn(g.gameId, name, [2, 1]);

    const bubbles = db.getAroundTheWorldDrillStatBubbles(name, 'practice');
    const dartsHistory = db.getMetricHistory(name, 'atwdartsthrown', 'all', { mode: 'practice' });
    const sessionsHistory = db.getMetricHistory(name, 'atwsessions', 'all', { mode: 'practice' });
    assert.equal(dartsHistory[0].value, bubbles.dartsThrown);
    assert.equal(sessionsHistory[0].value, 1);
  });
});

describe('getAroundTheWorldLeaderboard (Home page leaderboard)', () => {
  test('ranks players by lifetime progress descending, filtering out zero-progress players', () => {
    const some = 'ATW_Lb_Some', none = 'ATW_Lb_None';
    db.addPlayer(some); db.addPlayer(none);
    const g = worldGame(some);
    atwTurn(g.gameId, some, [1, 1]);
    atwTurn(g.gameId, some, [1, 2]);

    const rows = db.getAroundTheWorldLeaderboard();
    const someRow = rows.find(r => r.name === some);
    assert.equal(someRow.progress, 2);
    assert.ok(!rows.some(r => r.name === none), 'a player with zero lifetime progress is excluded entirely');
  });
});

describe('guided Around the World is excluded from leg/pace aggregates the same way Chuckin is (NOT_CONTINUOUS_STREAM), while guided Around the Clock stays included', () => {
  test('a long single-session Around the World game does not inflate getSummary().practiceLegs or getHomeExtra().todayLegs', () => {
    const name = 'ATW_LegExclusion';
    db.addPlayer(name);
    const beforeSummary = db.getSummary();
    const beforeExtra = db.getHomeExtra();

    const g = worldGame(name);
    for (let n = 1; n <= 10; n++) atwTurn(g.gameId, name, [n, 1]); // 10 darts, one continuous "leg"

    const afterSummary = db.getSummary();
    const afterExtra = db.getHomeExtra();
    assert.equal(afterSummary.practiceLegs, beforeSummary.practiceLegs, 'World darts must not count as a leg toward practiceLegs');
    assert.equal(afterExtra.today.legs, beforeExtra.today.legs, 'World darts must not count as a leg toward today.legs');
    // darts themselves DO still count — only the leg-shaped aggregates exclude it.
    assert.equal(afterSummary.darts, beforeSummary.darts + 10);
    assert.equal(afterExtra.today.darts, beforeExtra.today.darts + 10);
  });

  test('a completed guided Around the Clock round DOES count toward getSummary().practiceLegs and getHomeExtra().todayLegs', () => {
    const name = 'ATC_LegInclusion';
    db.addPlayer(name);
    const beforeSummary = db.getSummary();
    const beforeExtra = db.getHomeExtra();

    const g = clockGame(name);
    for (let n = 1; n <= 20; n++) atcTurn(g.gameId, name, 1, [n, 1], n === 20); // one completed round = one leg

    const afterSummary = db.getSummary();
    const afterExtra = db.getHomeExtra();
    assert.equal(afterSummary.practiceLegs, beforeSummary.practiceLegs + 1, 'a Clock round has a genuine leg boundary and should count, unlike World');
    assert.equal(afterExtra.today.legs, beforeExtra.today.legs + 1);
  });
});
