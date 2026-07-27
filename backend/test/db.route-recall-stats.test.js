'use strict';
// Route Recall's stats and its isolation from the two sub-modes it shares a
// game_type with — docs/archive/checkout-trainer-route-recall-roadmap.md.
//
// Two separable risks, and this file covers both because they fail differently:
//
//   1. THE COVERAGE MATHS. Best Coverage % is a fraction of a denominator only
//      allCheckoutRoutes() can supply, and it depends on the hunt's own ceiling
//      and the player's own out-mode. Get the denominator wrong and the number is
//      plausible and wrong — the exact shape of bug CLAUDE.md's "every new
//      calculation gets a committed test" rule exists for.
//   2. THE ISOLATION. Route Recall writes checkout=1 to mean "a route you had not
//      named yet", while Freeform/Blitz write it to mean "a legal answer to this
//      round". Same column, same game_type, different meanings — so a Route Recall
//      hunt must move a player's Route Recall numbers and leave their Freeform
//      accuracy exactly where it was. Nothing about that is visible on screen.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');
const S = require('../../frontend/scoring.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

const dart = (dartNo, sector, multiplier) => ({ dartNo, sector, multiplier });

function routeRecallGame(name, ceiling) {
  return db.createGame({ category: `Route Recall (${ceiling}-dart)`, legsPerSet: 1, setsPerGame: 1,
    practice: 1, gameType: 'checkout_trainer',
    config: { mode: 'route_recall', routeCeiling: ceiling, difficulty: 'full', trickQuestions: false },
    players: [{ name }] });
}
function freeformGame(name) {
  return db.createGame({ category: 'Checkout Trainer (Freeform)', legsPerSet: 1, setsPerGame: 1,
    practice: 1, gameType: 'checkout_trainer',
    config: { mode: 'freeform', difficulty: 'full', trickQuestions: false },
    players: [{ name }] });
}
// One submission, recorded exactly as submitRouteRecall() records it.
function route(gameId, name, huntNo, submissionNo, target, darts, isNew) {
  db.addTurn(gameId, { player: name, set: huntNo, leg: submissionNo,
    scored: 0, bust: !isNew, checkout: isNew, checkoutPoints: null, legWon: false,
    targetScore: target, darts });
}

describe('Route Recall stats', () => {
  test('coverage is measured against the target\'s real route count at that ceiling', () => {
    const name = 'RR_Coverage';
    db.addPlayer(name);
    const g = routeRecallGame(name, 2);
    // 40, two darts: D20, and 20 then D10. Both real, both distinct.
    route(g.gameId, name, 1, 1, 40, [dart(1, 20, 2)], true);
    route(g.gameId, name, 1, 2, 40, [dart(1, 20, 1), dart(2, 10, 2)], true);

    const total = S.allCheckoutRoutes(40, true, 2).length;
    assert.equal(total, 36, 'the fixture is written against a known denominator');

    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.routesNamed, 2);
    assert.equal(s.huntsPlayed, 1);
    assert.equal(s.bestCoveragePct, +((2 / total) * 100).toFixed(1));
  });

  test('the ceiling changes the denominator, so it changes the coverage', () => {
    // The same two routes against the same target score very differently at a
    // 3-dart ceiling, because far more routes exist to have missed.
    const name = 'RR_Ceiling';
    db.addPlayer(name);
    const g = routeRecallGame(name, 3);
    route(g.gameId, name, 1, 1, 40, [dart(1, 20, 2)], true);
    route(g.gameId, name, 1, 2, 40, [dart(1, 20, 1), dart(2, 10, 2)], true);

    const total2 = S.allCheckoutRoutes(40, true, 2).length;
    const total3 = S.allCheckoutRoutes(40, true, 3).length;
    assert.ok(total3 > total2, 'a 3-dart ceiling must have strictly more routes');

    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.bestCoveragePct, +((2 / total3) * 100).toFixed(1));
  });

  test('a hunt that finds every route reads 100%, and becomes the toughest full clear', () => {
    const name = 'RR_Clear';
    db.addPlayer(name);
    // 2 at a 1-dart ceiling has exactly one route: D1. Finding it is a full clear.
    const g = routeRecallGame(name, 1);
    assert.equal(S.allCheckoutRoutes(2, true, 1).length, 1);
    route(g.gameId, name, 1, 1, 2, [dart(1, 1, 2)], true);

    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.bestCoveragePct, 100);
    assert.deepEqual(s.toughestFullClear, { target: 2, routes: 1, ceiling: 1 });
  });

  test('"toughest" full clear means the most routes, not the biggest target', () => {
    const name = 'RR_Toughest';
    db.addPlayer(name);
    const g = routeRecallGame(name, 1);
    // Two full clears at a 1-dart ceiling, both exactly one route: 2 (D1) and
    // 40 (D20). Neither is "tougher" by route count, so the higher target wins
    // the tie — and the record must not silently prefer whichever came first.
    route(g.gameId, name, 1, 1, 2, [dart(1, 1, 2)], true);
    route(g.gameId, name, 2, 1, 40, [dart(1, 20, 2)], true);

    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.toughestFullClear.target, 40, 'the tie breaks to the higher target');
    assert.equal(s.huntsPlayed, 2);
    assert.equal(s.routesNamed, 2);
  });

  test('an illegal submission counts as neither a route nor coverage', () => {
    const name = 'RR_Illegal';
    db.addPlayer(name);
    const g = routeRecallGame(name, 2);
    route(g.gameId, name, 1, 1, 40, [dart(1, 20, 2)], true);
    route(g.gameId, name, 1, 2, 40, [dart(1, 20, 3)], false);   // T20 overshoots 40

    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.routesNamed, 1, 'only the legal, new route counts');
  });

  test('a player who has never played it reports zeroes, not nulls that break the panel', () => {
    const name = 'RR_Never';
    db.addPlayer(name);
    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.routesNamed, 0);
    assert.equal(s.huntsPlayed, 0);
    assert.equal(s.bestCoveragePct, null);
    assert.equal(s.toughestFullClear, null);
  });
});

describe('Route Recall does not disturb Freeform/Blitz', () => {
  test("a Route Recall hunt leaves the player's Freeform accuracy exactly where it was", () => {
    const name = 'RR_Isolation';
    db.addPlayer(name);

    // Freeform: two rounds, one optimal, one illegal -> 50% legal, 50% optimal.
    const f = freeformGame(name);
    db.addTurn(f.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: false, checkout: true,
      checkoutPoints: null, legWon: true, targetScore: 40, darts: [dart(1, 20, 2)] });
    db.addTurn(f.gameId, { player: name, set: 1, leg: 2, scored: 0, bust: true, checkout: false,
      checkoutPoints: null, legWon: false, targetScore: 60, darts: [dart(1, 20, 3)] });

    const before = db.getCheckoutTrainerStatBubbles(name, 'practice');
    const pbBefore = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(before.totalAttempts, 2);
    assert.equal(before.accuracyPct, 50);
    assert.equal(before.optimalPct, 50);

    // Now a Route Recall hunt with several finds — many more turns than the
    // Freeform session has, so a leak would be unmistakable.
    const g = routeRecallGame(name, 2);
    route(g.gameId, name, 1, 1, 40, [dart(1, 20, 2)], true);
    route(g.gameId, name, 1, 2, 40, [dart(1, 20, 1), dart(2, 10, 2)], true);
    route(g.gameId, name, 1, 3, 40, [dart(1, 10, 1), dart(2, 15, 2)], true);
    route(g.gameId, name, 1, 4, 40, [dart(1, 20, 3)], false);

    const after = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(after.totalAttempts, before.totalAttempts, 'Freeform attempts must not move');
    assert.equal(after.legalCount, before.legalCount);
    assert.equal(after.optimalCount, before.optimalCount);
    assert.equal(after.accuracyPct, 50, 'accuracy must be unchanged');
    assert.equal(after.optimalPct, 50);
    assert.equal(after.routesNamed, 3, 'while the Route Recall figures DO move');

    const pbAfter = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pbAfter.toughestCheckout, pbBefore.toughestCheckout,
      'a Route Recall find is not a "toughest checkout solved"');
    assert.equal(pbAfter.bestStreak, pbBefore.bestStreak,
      'Route Recall writes leg_won=0 always and must not appear in the optimal streak');
    assert.equal(pbAfter.routeRecallRoutesNamed, 3);
  });

  test('rows written before this sub-mode existed still count as Freeform', () => {
    // The exclusion uses `IS NOT 'route_recall'` rather than `!=` precisely
    // because config.mode is absent on older rows, and `!= NULL` is NULL — which
    // would have silently erased every pre-existing Checkout Trainer stat.
    const name = 'RR_Legacy';
    db.addPlayer(name);
    const g = db.createGame({ category: 'Checkout Trainer (Freeform)', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'checkout_trainer', players: [{ name }] });
    db._db.prepare('UPDATE games SET config = NULL WHERE id = ?').run(g.gameId);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: false, checkout: true,
      checkoutPoints: null, legWon: true, targetScore: 40, darts: [dart(1, 20, 2)] });

    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.totalAttempts, 1, 'a config-less row is Freeform history, not Route Recall');
    assert.equal(s.legalCount, 1);
    assert.equal(s.routesNamed, 0);
  });
});
