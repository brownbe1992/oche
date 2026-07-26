'use strict';
// Committed tests for the solo-practice leg-complete panel's aggregates
// (/frontend-design direction D, "Trophy Cabinet", 2026-07).
//
// The panel reports two scopes of the same measurements — the leg just thrown
// and the whole session — so both go through ONE function, pracAggregate().
// That is the property most worth protecting: a leg figure and its session
// counterpart computed by two different code paths is exactly how a panel ends
// up quietly contradicting itself.
//
// Also pinned here: checkouts sort DESCENDING. They used to render in
// chronological order while Best Visits sat directly beside them sorted, so one
// panel presented two lists of numbers under two different rules — the specific
// thing the owner asked to have fixed.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { pracAggregate, pracFirst9Average } = require('../../frontend/scoring.js');

// The practice turn record enterTurn() pushes.
const turn = (scored, opts = {}) => ({
  scored,
  darts: opts.darts != null ? opts.darts : 3,
  bust: !!opts.bust,
  trebleLess: !!opts.trebleLess,
  checkout: !!opts.checkout,
  checkoutPoints: opts.checkout ? scored : null,
});

describe('pracAggregate — one implementation for both scopes', () => {
  test('an empty scope reports zeroes, not NaN or a crash', () => {
    // Leg 1 visit 1: the panel can render before a single turn is committed.
    for (const input of [[], null, undefined]) {
      const a = pracAggregate(input);
      assert.deepEqual(
        { visits: a.visits, darts: a.darts, busts: a.busts, bestVisit: a.bestVisit,
          tonPlus: a.tonPlus, oneEighties: a.oneEighties, bigFish: a.bigFish },
        { visits: 0, darts: 0, busts: 0, bestVisit: 0, tonPlus: 0, oneEighties: 0, bigFish: 0 });
      assert.deepEqual(a.checkouts, []);
      assert.deepEqual(a.topVisits, []);
      assert.equal(a.treblelessPct, null, 'no visits means no percentage, not 0%');
    }
  });

  test('darts count the darts actually thrown, including a busted visit', () => {
    // A bust still used darts. Undercounting them would inflate the 3-dart
    // average that sits at the top of this very panel.
    const a = pracAggregate([turn(60), turn(0, { bust: true }), turn(40, { checkout: true, darts: 2 })]);
    assert.equal(a.darts, 8);
    assert.equal(a.visits, 3);
    assert.equal(a.busts, 1);
  });
});

describe('checkouts are sorted descending — the reported bug', () => {
  test('a chronological run of finishes comes back highest-first', () => {
    // The owner's own session, in the order they were thrown.
    const thrown = [2, 34, 20, 4, 12, 4, 34, 20, 40, 32, 12, 52, 38, 4, 20, 30, 4];
    const a = pracAggregate(thrown.map(v => turn(v, { checkout: true })));
    assert.deepEqual(a.checkouts,
      [52, 40, 38, 34, 34, 32, 30, 20, 20, 20, 12, 12, 4, 4, 4, 4, 2]);
    assert.equal(a.checkouts.length, thrown.length, 'no finish may be dropped by the sort');
  });

  test('it sorts numerically, not as strings', () => {
    // A lexicographic sort would put 4 above 38 above 170 — plausible-looking
    // and completely wrong.
    const a = pracAggregate([4, 38, 170, 12, 100].map(v => turn(v, { checkout: true })));
    assert.deepEqual(a.checkouts, [170, 100, 38, 12, 4]);
  });

  test('a turn flagged checkout with no points is not a finish', () => {
    const a = pracAggregate([turn(0, { checkout: true }), turn(40, { checkout: true })]);
    assert.deepEqual(a.checkouts, [40]);
  });

  test('best visits are sorted the same way and capped at five', () => {
    const a = pracAggregate([26, 140, 60, 100, 45, 180, 41].map(v => turn(v)));
    assert.deepEqual(a.topVisits, [180, 140, 100, 60, 45]);
  });
});

describe('a busted visit never counts as a score', () => {
  test('it is excluded from best visit, top visits, ton+ and 180s', () => {
    // A busted 180 is a real and celebrated thing in this app (the Busted
    // Maximum badge), but it scored nothing — it must not appear as the best
    // visit of the session.
    const a = pracAggregate([turn(180, { bust: true }), turn(60), turn(140, { bust: true })]);
    assert.equal(a.bestVisit, 60);
    assert.deepEqual(a.topVisits, [60]);
    assert.equal(a.tonPlus, 0);
    assert.equal(a.oneEighties, 0);
    assert.equal(a.busts, 2);
  });
});

describe('the tallies count what their labels say', () => {
  test('ton+ is 100 or more, so 99 is out and exactly 100 is in', () => {
    const a = pracAggregate([turn(99), turn(100), turn(101), turn(180)]);
    assert.equal(a.tonPlus, 3);
  });

  test('180s are exactly 180', () => {
    const a = pracAggregate([turn(180), turn(180), turn(177), turn(174)]);
    assert.equal(a.oneEighties, 2);
  });

  test('big fish is a 170 CHECKOUT, not merely a 170-scoring visit', () => {
    // 170 cannot be scored as a non-finishing visit in X01 anyway, but the
    // distinction is what the badge means and what the label promises.
    const a = pracAggregate([turn(170, { checkout: true }), turn(170)]);
    assert.equal(a.bigFish, 1);
  });

  test('trebleless percentage is over ALL visits, busts included', () => {
    // A busted visit was still a visit you threw; excluding it would flatter
    // the number.
    const a = pracAggregate([
      turn(26, { trebleLess: true }), turn(0, { bust: true, trebleLess: true }),
      turn(60), turn(45, { trebleLess: true }),
    ]);
    assert.equal(a.treblelessPct, 75);
  });
});

describe('pracFirst9Average — leg scope only, by design', () => {
  test('it averages the opening three visits', () => {
    const a = pracFirst9Average([turn(60), turn(100), turn(41), turn(180)]);
    assert.equal(a.toFixed(1), '67.0', '201 points over 9 darts');
  });

  test('a busted opening visit scores zero over the darts it used', () => {
    // Which is exactly how a real first-9 average treats it — not "skip the
    // visit", which would silently turn a bad start into a good one.
    const a = pracFirst9Average([turn(60), turn(0, { bust: true }), turn(60)]);
    assert.equal(a.toFixed(1), '40.0', '120 points over 9 darts');
  });

  test('a short leg uses only the darts actually thrown', () => {
    // A 9-darter's first 9 IS the whole leg; a 2-visit leg has no 9 darts to
    // average over and must not be divided by a assumed 9.
    assert.equal(pracFirst9Average([turn(180), turn(180)]).toFixed(1), '180.0');
  });

  test('a leg with no darts yet returns null rather than 0.0 or NaN', () => {
    // The panel renders "—" for this; a 0.0 would read as "you averaged zero".
    for (const input of [[], null, undefined]) assert.equal(pracFirst9Average(input), null);
    assert.equal(pracFirst9Average([turn(0, { darts: 0 })]), null);
  });

  test('it ignores everything after the third visit', () => {
    const opening = [turn(60), turn(60), turn(60)];
    assert.equal(pracFirst9Average(opening),
                 pracFirst9Average([...opening, turn(180), turn(180), turn(180)]));
  });
});

describe('the leg and the session agree because they share one function', () => {
  test('a session of exactly one leg reports identical figures for both scopes', () => {
    // The clearest statement of the shared-implementation property: on leg 1,
    // "this leg" and "this session" are the same turns, so every number on the
    // two sides of the panel must match exactly.
    const legTurns = [turn(140), turn(0, { bust: true }), turn(100), turn(41),
                      turn(180), turn(40, { checkout: true, darts: 2 })];
    assert.deepEqual(pracAggregate(legTurns), pracAggregate(legTurns.slice()));
  });

  test('a session accumulates its legs without re-sorting them wrongly', () => {
    const leg1 = [turn(100), turn(32, { checkout: true })];
    const leg2 = [turn(140), turn(80, { checkout: true })];
    const ses = pracAggregate([...leg1, ...leg2]);
    assert.deepEqual(ses.checkouts, [80, 32]);
    assert.equal(ses.bestVisit, 140);
    assert.equal(ses.visits, 4);
    assert.equal(ses.darts, 12);
  });
});
