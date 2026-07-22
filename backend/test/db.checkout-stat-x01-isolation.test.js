'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-27: checkout-based X01 stats
// (Ton+, Big Fish, Highest Checkout, Top Finishes, On This Day, Session Recap, and the
// Big-Fish metric-history chart) must count only real X01 checkouts. The 121 Checkout
// Ladder and Dead Man Walking both write a genuine checkout=1 + checkout_points on a won
// round, which is NOT an X01 leg, so every checkout-based aggregate that keyed on
// "checkout=1" without an X01_ONLY guard silently folded those drill checkouts in. This
// test plays a Checkout Ladder run alongside a real X01 game and asserts each aggregate
// reflects only the X01 checkouts.
//
// Turns are inserted via db.addTurn() WITHOUT {enforceConsistency:true} (the established
// fixture convention across this suite) so checkout/checkoutPoints can be hand-picked.
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

const X01 = 'ISO_X01';
const DRILL = 'ISO_DRILL';

function x01Game(name) {
  return db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
}
function ladderGame(name) {
  return db.createGame({ category: '121 Checkout Ladder', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'checkout_ladder', players: [{ name }] });
}
// A checkout turn with a hand-picked checkoutPoints; leg is per-attempt so each is its own leg.
function checkoutTurn(gameId, player, leg, points, { targetScore } = {}) {
  db.addTurn(gameId, {
    player, set: 1, leg, scored: points, bust: false, checkout: true, checkoutPoints: points, targetScore,
    darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 25, multiplier: 2 }],
  });
}

describe('BUG-27 — checkout-based X01 stats exclude Checkout Ladder / Dead Man Walking checkouts', () => {
  db.addPlayer(X01);
  db.addPlayer(DRILL);

  // Drill checkouts are inserted FIRST (earlier created_at) so an unscoped "highest
  // checkout" tie-break would pick the drill row — proving the X01_ONLY guard, not the
  // ordering, is what excludes it.
  const dg = ladderGame(DRILL);
  checkoutTurn(dg.gameId, DRILL, 1, 170, { targetScore: 170 }); // would-be Big Fish
  checkoutTurn(dg.gameId, DRILL, 2, 140, { targetScore: 140 });
  checkoutTurn(dg.gameId, DRILL, 3, 121, { targetScore: 121 });

  const xg = x01Game(X01);
  checkoutTurn(xg.gameId, X01, 1, 170); // real Big Fish
  checkoutTurn(xg.gameId, X01, 2, 121);
  checkoutTurn(xg.gameId, X01, 3, 100);

  test('getSummary(): Ton+ and Big Fish count only the X01 checkouts', () => {
    const s = db.getSummary();
    assert.equal(s.tonPlus, 3, 'X01 170/121/100 count; the three drill checkouts do not');
    assert.equal(s.bigFish, 1, 'only the X01 170 is a Big Fish; the drill 170 is not');
  });

  test('getBigFishStats(): the drill 170 never reaches the Big Fish leaderboard', () => {
    const { leaderboard } = db.getBigFishStats();
    assert.deepEqual(leaderboard.map(r => r.name).sort(), [X01], 'only ISO_X01 appears');
    assert.ok(!leaderboard.some(r => r.name === DRILL), 'ISO_DRILL must not appear');
  });

  test('getTopFinishesAll(): drill finishes are excluded (no 140, no ISO_DRILL rows)', () => {
    const rows = db.getTopFinishesAll(10);
    assert.ok(rows.every(r => r.name === X01), 'every row belongs to the X01 player');
    assert.ok(!rows.some(r => Number(r.score) === 140), 'the drill-only 140 is absent');
  });

  test('getTopFinishes(DRILL): a drill-only player has no X01 top finishes', () => {
    assert.deepEqual(db.getTopFinishes(DRILL), [], 'no X01 checkouts → empty list');
  });

  test('getHomeExtra(): highest checkout and the Ton+ leaderboard exclude the drill player', () => {
    const h = db.getHomeExtra();
    assert.equal(h.highestCheckout.overall.name, X01, 'the household record is the X01 170, not the drill 170');
    const drillInTonPlus = h.tonPlusRows.practice.some(r => r.name === DRILL)
      || h.tonPlusRows.h2h.some(r => r.name === DRILL);
    assert.ok(!drillInTonPlus, 'a player with only drill checkouts never appears on the Ton+ Finish Rate board');
  });

  test('getMetricHistory(bigfish): the X01 170 charts, the drill 170 does not', () => {
    const x01Hist = db.getMetricHistory(X01, 'bigfish', 'week');
    assert.equal(x01Hist.reduce((n, b) => n + b.value, 0), 1, 'the X01 170 is charted');
    const drillHist = db.getMetricHistory(DRILL, 'bigfish', 'week');
    assert.equal(drillHist.reduce((n, b) => n + b.value, 0), 0, 'the drill 170 is not charted');
  });

  test('getSessionRecap(): today\'s Ton+ counts and moments exclude drill checkouts', () => {
    const today = new Date().toISOString().slice(0, 10);
    const recap = db.getSessionRecap(today);
    const x01Row = recap.perPlayer.find(p => p.name === X01);
    const drillRow = recap.perPlayer.find(p => p.name === DRILL);
    assert.equal(x01Row.tonPlusCheckouts, 3, 'X01 170/121/100 count tonight');
    assert.equal(drillRow.tonPlusCheckouts, 0, 'the drill checkouts do not count tonight');
    assert.ok(!recap.moments.some(m => m.player === DRILL && (m.type === 'bigfish' || m.type === 'tonplus')),
      'no drill checkout appears in the moments timeline');
  });

  test('getOnThisDay(): a drill 170 on this date in a past year is not a flashback', () => {
    // Backdate one X01 170 and one drill 170 to today's month/day in a past year.
    const now = new Date();
    const MM = String(now.getUTCMonth() + 1).padStart(2, '0');
    const DD = String(now.getUTCDate()).padStart(2, '0');
    const setDate = (turnId, year) => db._db.prepare('UPDATE turns SET created_at = ? WHERE id = ?')
      .run(`${year}-${MM}-${DD} 12:00:00`, turnId);

    const pdX = x01Game('OTD_X01');
    db.addPlayer('OTD_X01');
    checkoutTurn(pdX.gameId, 'OTD_X01', 1, 170);
    setDate(db._db.prepare('SELECT MAX(id) AS id FROM turns').get().id, now.getUTCFullYear() - 2);

    const pdD = ladderGame('OTD_DRILL');
    db.addPlayer('OTD_DRILL');
    checkoutTurn(pdD.gameId, 'OTD_DRILL', 1, 170, { targetScore: 170 });
    setDate(db._db.prepare('SELECT MAX(id) AS id FROM turns').get().id, now.getUTCFullYear() - 2);

    const xFlash = db.getOnThisDay('OTD_X01', 0);
    assert.ok(xFlash && xFlash.type === 'bigfish', 'the X01 170 surfaces as a Big Fish flashback');
    assert.equal(db.getOnThisDay('OTD_DRILL', 0), null, 'the drill 170 produces no flashback');
  });

  test('avgDartsPerLeg / getMetricHistory("avgdartsperleg"): a Checkout Ladder leg does not dilute the X01-only average', () => {
    const name = 'AVGLEG_X01_ISO';
    db.addPlayer(name);
    // A real X01 leg finished in 3 darts (checkoutTurn's fixed shape).
    const xg = x01Game(name);
    checkoutTurn(xg.gameId, name, 1, 121);
    // A Checkout Ladder "leg" that took 5 darts across two visits to check out —
    // same player, so any missing X01_ONLY guard would blend this into the
    // average (making it > 3).
    const dg = ladderGame(name);
    db.addTurn(dg.gameId, {
      player: name, set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
      darts: [1, 2, 3].map(dartNo => ({ dartNo, sector: 1, multiplier: 1 })),
    });
    db.addTurn(dg.gameId, {
      player: name, set: 1, leg: 1, scored: 121, bust: false, checkout: true, checkoutPoints: 121, targetScore: 121,
      darts: [1, 2].map(dartNo => ({ dartNo, sector: 1, multiplier: 1 })),
    });

    const bubble = db.getPlayerStatBubbles(name, 'practice').avgDartsPerLeg;
    assert.equal(bubble, 3, 'the bubble already excludes the 5-dart drill leg (X01_ONLY)');

    const history = db.getMetricHistory(name, 'avgdartsperleg', 'all', { mode: 'practice' });
    assert.equal(history.length, 1, 'both legs land in the same (current) month bucket');
    assert.equal(history[0].value, bubble, 'the Darts/Leg chart must reproduce the exact same X01-only average as the bubble, not blend in the 5-dart drill leg');
  });
});
