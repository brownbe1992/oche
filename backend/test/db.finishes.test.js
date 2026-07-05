'use strict';
// Committed tests for backend/db.js's checkout-history and dart-analytics
// functions (REFERENCE.md §3 "Top Finishes / Checkout Routes"): getTopFinishes/
// getTopFinishesAll (leaderboard shapes), getCheckoutRoutes (one-score route
// drilldown), and getDartAnalytics (topSectors/trebleRates/checkoutRoutes, with
// busted turns excluded from all three).
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

function checkoutTurn(gameId, player, set, leg, checkoutPoints, darts) {
  db.addTurn(gameId, {
    player, set, leg, scored: checkoutPoints, bust: false, checkout: true, checkoutPoints,
    darts: darts.map((dd, i) => ({ dartNo: i + 1, sector: dd[0], multiplier: dd[1] })),
  });
}

describe('getTopFinishesAll / getTopFinishes', () => {
  test('groups by (player, checkout score, out mode) with a times count, ranked score desc', () => {
    const p1 = 'Finishes_P1', p2 = 'Finishes_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: p1 }, { name: p2 }] });
    checkoutTurn(g.gameId, p1, 1, 1, 170, [[20, 3], [20, 3], [25, 2]]);
    checkoutTurn(g.gameId, p1, 1, 2, 170, [[20, 3], [20, 3], [25, 2]]); // same score again -> times=2
    checkoutTurn(g.gameId, p1, 1, 3, 40, [[20, 2]]);
    checkoutTurn(g.gameId, p2, 1, 1, 100, [[20, 1], [20, 1], [20, 2]]);

    const all = db.getTopFinishesAll(10);
    const p1_170 = all.find(r => r.name === p1 && r.score === 170);
    assert.equal(p1_170.times, 2);
    assert.equal(all[0].score, 170, 'highest score ranks first');

    const p1Only = db.getTopFinishes(p1, undefined);
    const scores = p1Only.map(r => r.score);
    assert.deepEqual(scores, [170, 40], 'per-player list, score descending, no other player mixed in');
    assert.ok(!('name' in p1Only[0]), 'per-player shape has no name field');
  });

  test('an unknown player returns an empty list, not an error', () => {
    assert.deepEqual(db.getTopFinishes('Finishes_Nobody', undefined), []);
  });
});

describe('getCheckoutRoutes', () => {
  test('groups exact 3-dart sequences for one specific score, ranked by times desc', () => {
    const name = 'Finishes_Routes';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    checkoutTurn(g.gameId, name, 1, 1, 40, [[20, 2]]);           // route A: D20 (1 dart)
    checkoutTurn(g.gameId, name, 1, 2, 40, [[20, 2]]);           // route A again
    checkoutTurn(g.gameId, name, 1, 3, 40, [[20, 1], [10, 2]]);  // route B: S20, D10

    const routes = db.getCheckoutRoutes(name, 40, undefined);
    assert.equal(routes.length, 2);
    assert.equal(routes[0].times, 2, 'the more common route ranks first');
    assert.equal(routes[0].s1, 20); assert.equal(routes[0].m1, 2); assert.equal(routes[0].s2, null);
    assert.equal(routes[1].times, 1);
  });
});

describe('getDartAnalytics', () => {
  test('topSectors / trebleRates / checkoutRoutes all exclude busted turns', () => {
    const name = 'Analytics_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    // Turn A (not bust): T20, T20, S5
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 125, bust: false, checkout: false,
      darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 5, multiplier: 1 }] });
    // Turn B (BUST): a treble 20 that should not count toward any of the three analytics
    db.addTurn(g.gameId, { player: name, set: 1, leg: 2, scored: 0, bust: true,
      darts: [{ sector: 20, multiplier: 3 }] });
    // Turn C (a checkout on D20)
    checkoutTurn(g.gameId, name, 1, 3, 40, [[20, 2]]);

    const analytics = db.getDartAnalytics(name, undefined);

    const sectorHits = Object.fromEntries(analytics.topSectors.map(r => [`${r.sector}:${r.multiplier}`, r.hits]));
    assert.equal(sectorHits['20:3'], 2, 'only turn A\'s two trebles count — the bust turn\'s treble is excluded');
    assert.equal(sectorHits['5:1'], 1);
    assert.equal(sectorHits['20:2'], 1);

    const sector20Rate = analytics.trebleRates.find(r => r.sector === 20);
    // 3 non-busted throws at sector 20 total (2 trebles from turn A + 1 double from turn C); 2 were trebles.
    assert.equal(sector20Rate.total, 3);
    assert.equal(sector20Rate.trebles, 2);
    assert.equal(sector20Rate.treble_pct, Math.round((2 / 3) * 1000) / 10);

    assert.equal(analytics.checkoutRoutes.length, 1, 'only the one real checkout, across any score');
    assert.equal(analytics.checkoutRoutes[0].times, 1);
  });

  test('an unknown player returns null, not an error', () => {
    assert.equal(db.getDartAnalytics('Analytics_Nobody', undefined), null);
  });
});
