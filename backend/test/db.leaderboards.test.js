'use strict';
// Committed tests for backend/db.js's global X01 leaderboard functions
// (getOneEightyStats/getBigFishStats/getNineDarterStats — the "leaderboard +
// recent" shape already covered for Cricket in db.cricket-stats.test.js) and
// getAroundTheWorldProgress (directly tied to the addTurn() dart-validation
// fix — see db.turn-validation.test.js — since phantom dart combos would
// otherwise corrupt this exact 63-outcome count).
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

function turn(gameId, player, set, leg, { scored, darts = 3, bust = false, checkout = false, checkoutPoints = null, sector = 1, mult = 1 }) {
  const dartRows = Array.from({ length: darts }, () => ({ sector, multiplier: mult }));
  db.addTurn(gameId, { player, set, leg, scored, bust, checkout, checkoutPoints, darts: dartRows });
}

describe('getOneEightyStats', () => {
  test('leaderboard ranks by count desc; recent lists newest first', () => {
    const p1 = 'Leaderboard_180_P1', p2 = 'Leaderboard_180_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: p1 }, { name: p2 }] });
    turn(g.gameId, p1, 1, 1, { scored: 180, sector: 20, mult: 3 });
    turn(g.gameId, p1, 1, 2, { scored: 180, sector: 20, mult: 3 });
    turn(g.gameId, p2, 1, 1, { scored: 180, sector: 20, mult: 3 });
    const stats = db.getOneEightyStats('practice');
    assert.equal(stats.leaderboard[0].name, p1);
    assert.equal(stats.leaderboard[0].count, 2);
    assert.equal(stats.leaderboard[1].name, p2);
    assert.equal(stats.leaderboard[1].count, 1);
    assert.equal(stats.recent.length, 3);
  });

  test('a cricket 9-mark visit scoring 180 cricket points never counts (X01_ONLY scoping)', () => {
    const name = 'Leaderboard_180_Cricket';
    db.addPlayer(name); db.addPlayer('Leaderboard_180_Cricket_Opp');
    const g = db.createGame({
      category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'cricket', config: { numbers: [15, 16, 17, 18, 19, 20, 25] },
      players: [{ name }, { name: 'Leaderboard_180_Cricket_Opp' }],
    });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 180, bust: false, checkout: false,
      darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }] });
    const stats = db.getOneEightyStats('h2h');
    assert.ok(!stats.leaderboard.some(r => r.name === name));
  });
});

describe('getBigFishStats', () => {
  test('leaderboard counts checkout=1 AND checkout_points=170', () => {
    const p1 = 'Leaderboard_BF_P1', p2 = 'Leaderboard_BF_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: p1 }, { name: p2 }] });
    turn(g.gameId, p1, 1, 1, { scored: 170, checkout: true, checkoutPoints: 170 });
    turn(g.gameId, p2, 1, 1, { scored: 100, checkout: true, checkoutPoints: 100 }); // not a Big Fish
    const stats = db.getBigFishStats('practice');
    const names = stats.leaderboard.map(r => r.name);
    assert.ok(names.includes(p1));
    assert.ok(!names.includes(p2));
  });
});

describe('getNineDarterStats', () => {
  test('leaderboard + recent, same nine-darter definition as the stat bubble', () => {
    const name = 'Leaderboard_9D_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 141, darts: 3, checkout: true, checkoutPoints: 141 });
    const stats = db.getNineDarterStats('practice');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[name], 1);
    assert.equal(stats.recent.length, 1);
    assert.equal(stats.recent[0].name, name);
  });

  test('a non-501 category never counts, even with the same 3-turn/9-dart/checkout shape', () => {
    const name = 'Leaderboard_9D_NotFiveOhOne';
    db.addPlayer(name);
    const g = db.createGame({ category: '301', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 121, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 0, darts: 3, checkout: true, checkoutPoints: 0 });
    const stats = db.getNineDarterStats('practice');
    assert.ok(!stats.leaderboard.some(r => r.name === name));
  });
});

describe('getAroundTheWorldProgress', () => {
  test('counts DISTINCT (sector, multiplier) outcomes, out of the 63-outcome total', () => {
    const name = 'ATW_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    // 3 distinct outcomes, one of them repeated (should still count once).
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: false, checkout: false,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 2 }, { sector: 20, multiplier: 1 }] }); // repeat of S20
    db.addTurn(g.gameId, { player: name, set: 1, leg: 2, scored: 0, bust: false, checkout: false,
      darts: [{ sector: 25, multiplier: 2 }] }); // double bull

    const progress = db.getAroundTheWorldProgress(name);
    assert.equal(progress.total, 63);
    assert.equal(progress.count, 3, 'S20, D20, and double-bull — the repeated S20 counts once');
  });

  test('a player with no darts thrown yet has 0 progress, not an error', () => {
    const name = 'ATW_Fresh';
    db.addPlayer(name);
    const progress = db.getAroundTheWorldProgress(name);
    assert.equal(progress.count, 0);
    assert.equal(progress.total, 63);
  });
});
