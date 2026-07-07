'use strict';
// Committed tests for backend/db.js's getCoachingInsights() (docs/coaching-insights-
// roadmap.md): weak-number detection, checkout-route inefficiency, bust-parity bias,
// and form-trend callouts, plus each insight's sample-size gate ("Strict" thresholds
// — see the roadmap doc's resolved open question). A wrong coaching insight actively
// misleads a player about their own game, so every branch gets both a positive case
// and a below-threshold negative case, per CLAUDE.md's testing convention.
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

function plainTurn(gameId, player, set, leg, sector, multiplier, count, scored) {
  const darts = Array.from({ length: count }, () => ({ sector, multiplier }));
  db.addTurn(gameId, { player, set, leg, scored, darts });
}
function checkoutTurn(gameId, player, set, leg, checkoutPoints, darts) {
  db.addTurn(gameId, { player, set, leg, scored: checkoutPoints, bust: false, checkout: true, checkoutPoints, darts });
}

describe('getCoachingInsights — weak number', () => {
  test('flags a number whose treble rate sits well below the player\'s own baseline, given enough darts', () => {
    const name = 'Coach_WeakNum';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] }).gameId;
    // 42 darts at sector 5, all singles (0% treble)
    for (let i = 0; i < 14; i++) plainTurn(g, name, 1, 1, 5, 1, 3, 15);
    // 42 darts at sector 6, all trebles (100% treble) — pulls the baseline well above sector 5
    for (let i = 0; i < 14; i++) plainTurn(g, name, 1, 1, 6, 3, 3, 54);

    const insights = db.getCoachingInsights(name, undefined);
    const weak = insights.find(i => i.type === 'weak_number');
    assert.ok(weak, 'expected a weak_number insight');
    assert.match(weak.text, /treble-5/);
  });

  test('does not flag a number below the 40-dart sample threshold', () => {
    const name = 'Coach_WeakNum_TooFew';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] }).gameId;
    // Only 30 darts at sector 5 (below COACHING_MIN_NUMBER_DARTS) — same 0%-vs-100% shape as above
    for (let i = 0; i < 10; i++) plainTurn(g, name, 1, 1, 5, 1, 3, 15);
    for (let i = 0; i < 10; i++) plainTurn(g, name, 1, 1, 6, 3, 3, 54);

    const insights = db.getCoachingInsights(name, undefined);
    assert.ok(!insights.some(i => i.type === 'weak_number'), 'sample too small to flag');
  });
});

describe('getCoachingInsights — checkout route', () => {
  test('flags a route that takes more darts than checkoutHint\'s optimal, given 10+ uses', () => {
    const name = 'Coach_Route';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] }).gameId;
    // 10 checkouts of 40 via S5, S5, D15 (3 darts) — D20 (1 dart) is the optimal route
    for (let i = 1; i <= 10; i++) {
      checkoutTurn(g, name, 1, i, 40, [{ sector: 5, multiplier: 1 }, { sector: 5, multiplier: 1 }, { sector: 15, multiplier: 2 }]);
    }

    const insights = db.getCoachingInsights(name, undefined);
    const route = insights.find(i => i.type === 'checkout_route');
    assert.ok(route, 'expected a checkout_route insight');
    assert.match(route.text, /D20 finishes it in 1/);
  });

  test('does not flag a route already at the optimal dart count', () => {
    const name = 'Coach_Route_Optimal';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] }).gameId;
    // 10 checkouts of 40 via D20 directly — already optimal (1 dart)
    for (let i = 1; i <= 10; i++) {
      checkoutTurn(g, name, 1, i, 40, [{ sector: 20, multiplier: 2 }]);
    }

    const insights = db.getCoachingInsights(name, undefined);
    assert.ok(!insights.some(i => i.type === 'checkout_route'), 'already optimal, nothing to flag');
  });

  test('does not flag a route below the 10-use sample threshold', () => {
    const name = 'Coach_Route_TooFew';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] }).gameId;
    for (let i = 1; i <= 9; i++) {
      checkoutTurn(g, name, 1, i, 40, [{ sector: 5, multiplier: 1 }, { sector: 5, multiplier: 1 }, { sector: 15, multiplier: 2 }]);
    }

    const insights = db.getCoachingInsights(name, undefined);
    assert.ok(!insights.some(i => i.type === 'checkout_route'), 'sample too small to flag');
  });
});

describe('getCoachingInsights — bust parity', () => {
  // Each leg descends from a real X01 starting score (501) via 3 filler turns
  // engineered so every intermediate "remaining" checkpoint stays OUTSIDE the
  // 2-170 checkout range, so exactly one observation (the 4th, "attempt" turn)
  // lands in range per leg — keeps the fixture unambiguous to hand-verify.
  function parityLeg(gameId, legNo, targetRemaining, bust) {
    const fillerSum = 501 - targetRemaining;
    plainTurn(gameId, 'Coach_Parity', 1, legNo, 20, 1, 3, 150);       // remaining before: 501 (out of range)
    plainTurn(gameId, 'Coach_Parity', 1, legNo, 20, 1, 3, 150);       // remaining before: 351 (out of range)
    plainTurn(gameId, 'Coach_Parity', 1, legNo, 20, 1, 3, fillerSum - 300); // remaining before: 201 (out of range)
    db.addTurn(gameId, {
      player: 'Coach_Parity', set: 1, leg: legNo,
      scored: bust ? 0 : 10, bust: !!bust,
      darts: [{ sector: 1, multiplier: 1 }],
    });
  }

  test('flags a meaningfully higher bust rate on one parity, given 20+ attempts per side', () => {
    db.addPlayer('Coach_Parity', 'double');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name: 'Coach_Parity', out: 'double' }] }).gameId;
    // 25 odd-remaining (51) attempts, 20 of them busts (80%)
    for (let i = 1; i <= 25; i++) parityLeg(g, i, 51, i <= 20);
    // 25 even-remaining (50) attempts, 2 of them busts (8%)
    for (let i = 26; i <= 50; i++) parityLeg(g, i, 50, i <= 27);

    const insights = db.getCoachingInsights('Coach_Parity', undefined);
    const parity = insights.find(i => i.type === 'bust_parity');
    assert.ok(parity, 'expected a bust_parity insight');
    assert.match(parity.text, /odd number/);
  });

  test('does not flag a parity bias below the 20-attempts-per-side threshold', () => {
    const name = 'Coach_Parity_TooFew';
    db.addPlayer(name, 'double');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name, out: 'double' }] }).gameId;
    function leg(legNo, targetRemaining, bust) {
      const fillerSum = 501 - targetRemaining;
      plainTurn(g, name, 1, legNo, 20, 1, 3, 150);
      plainTurn(g, name, 1, legNo, 20, 1, 3, 150);
      plainTurn(g, name, 1, legNo, 20, 1, 3, fillerSum - 300);
      db.addTurn(g, { player: name, set: 1, leg: legNo, scored: bust ? 0 : 10, bust: !!bust, darts: [{ sector: 1, multiplier: 1 }] });
    }
    // Only 10 attempts per side — same 80%-vs-8% shape, but under COACHING_MIN_PARITY_ATTEMPTS
    for (let i = 1; i <= 10; i++) leg(i, 51, i <= 8);
    for (let i = 11; i <= 20; i++) leg(i, 50, i <= 11);

    const insights = db.getCoachingInsights(name, undefined);
    assert.ok(!insights.some(i => i.type === 'bust_parity'), 'sample too small to flag');
  });

  test('never flags a single-out player (no double-out parity bias to have)', () => {
    const name = 'Coach_Parity_SingleOut';
    db.addPlayer(name, 'single');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name, out: 'single' }] }).gameId;
    function leg(legNo, targetRemaining, bust) {
      const fillerSum = 501 - targetRemaining;
      plainTurn(g, name, 1, legNo, 20, 1, 3, 150);
      plainTurn(g, name, 1, legNo, 20, 1, 3, 150);
      plainTurn(g, name, 1, legNo, 20, 1, 3, fillerSum - 300);
      db.addTurn(g, { player: name, set: 1, leg: legNo, scored: bust ? 0 : 10, bust: !!bust, darts: [{ sector: 1, multiplier: 1 }] });
    }
    for (let i = 1; i <= 25; i++) leg(i, 51, i <= 20);
    for (let i = 26; i <= 50; i++) leg(i, 50, i <= 27);

    const insights = db.getCoachingInsights(name, undefined);
    assert.ok(!insights.some(i => i.type === 'bust_parity'), 'single-out has no bust/double concept');
  });
});

describe('getCoachingInsights — form trend', () => {
  test('flags a large recent-vs-lifetime delta, given enough lifetime legs', () => {
    const name = 'Coach_Form';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] }).gameId;
    // 20 older legs at a 60 leg-average (scored=20, 1 dart -> la = 20*3 = 60)
    for (let i = 1; i <= 20; i++) checkoutTurn(g, name, 1, i, 20, [{ sector: 20, multiplier: 2 }]);
    // 10 recent legs at a 120 leg-average (scored=40 -> la = 120) — well above lifetime
    for (let i = 21; i <= 30; i++) checkoutTurn(g, name, 1, i, 40, [{ sector: 20, multiplier: 2 }]);

    const insights = db.getCoachingInsights(name, undefined);
    const form = insights.find(i => i.type === 'form_trend');
    assert.ok(form, 'expected a form_trend insight');
    assert.equal(form.tone, 'strength');
  });

  test('does not flag a trend below the 20-lifetime-legs threshold', () => {
    const name = 'Coach_Form_TooFew';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] }).gameId;
    // Same shape as above but only 15 legs total (below COACHING_MIN_LEGS_FOR_FORM)
    for (let i = 1; i <= 10; i++) checkoutTurn(g, name, 1, i, 20, [{ sector: 20, multiplier: 2 }]);
    for (let i = 11; i <= 15; i++) checkoutTurn(g, name, 1, i, 40, [{ sector: 20, multiplier: 2 }]);

    const insights = db.getCoachingInsights(name, undefined);
    assert.ok(!insights.some(i => i.type === 'form_trend'), 'not enough lifetime legs to trust the delta');
  });
});

describe('getCoachingInsights — edge cases', () => {
  test('an unknown player returns an empty list, not an error', () => {
    assert.deepEqual(db.getCoachingInsights('Coach_Nobody', undefined), []);
  });
});
