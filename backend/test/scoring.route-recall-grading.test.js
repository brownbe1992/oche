'use strict';
// gradeRouteSubmission() / routeHuntProgress() — docs/archive/checkout-trainer-route-recall-roadmap.md.
//
// The grader's three-way answer is what makes this sub-mode a different drill from
// Freeform, and the third outcome is the one worth testing hardest: a legal route
// the player has already named is explicitly NOT a failure. If "duplicate" ever
// collapses into "illegal", the mode starts punishing people for repeating
// themselves, which is the opposite of what a recall drill should do.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

// Darts as the app stages them — makeDartCore() is what index.html builds, so the
// grader is tested against the real shape rather than a convenient one.
const d = (sector, mult) => S.makeDartCore(sector, mult);
const grade = (o) => S.gradeRouteSubmission(o);

describe('gradeRouteSubmission()', () => {
  test('a legal, unnamed route is new', () => {
    const g = grade({ target: 40, doubleOut: true, ceiling: 2, darts: [d(20, 2)], foundKeys: new Set() });
    assert.equal(g.status, 'new');
    assert.deepEqual(g.labels, ['D20']);
    assert.equal(g.key, S.routeKey(['D20']));
  });

  test('the same route again is a duplicate, not a failure', () => {
    const found = new Set([S.routeKey(['D20'])]);
    const g = grade({ target: 40, doubleOut: true, ceiling: 2, darts: [d(20, 2)], foundKeys: found });
    assert.equal(g.status, 'duplicate');
    assert.equal(g.reason, null, 'a duplicate has no fault to report');
  });

  test('a duplicate is recognised however the player orders the setup darts', () => {
    // T20 T19 D12 and T19 T20 D12 are the same route thrown in a different order,
    // and re-entering one after the other must not read as a new find.
    const first = grade({ target: 141, doubleOut: true, ceiling: 3,
      darts: [d(20, 3), d(19, 3), d(12, 2)], foundKeys: new Set() });
    assert.equal(first.status, 'new');
    const second = grade({ target: 141, doubleOut: true, ceiling: 3,
      darts: [d(19, 3), d(20, 3), d(12, 2)], foundKeys: new Set([first.key]) });
    assert.equal(second.status, 'duplicate');
  });

  test('but a different FINISHING dart is a different route', () => {
    // 60 = D20 then D10, or D10 then D20. Same two beds, different plan, and the
    // player is genuinely naming a second way to do it.
    const a = grade({ target: 60, doubleOut: true, ceiling: 2, darts: [d(20, 2), d(10, 2)], foundKeys: new Set() });
    const b = grade({ target: 60, doubleOut: true, ceiling: 2, darts: [d(10, 2), d(20, 2)], foundKeys: new Set([a.key]) });
    assert.equal(a.status, 'new');
    assert.equal(b.status, 'new');
    assert.notEqual(a.key, b.key);
  });

  test('the hunt ceiling is enforced, even on a route that is otherwise legal', () => {
    // 40 as 10+10+D10 is a perfectly good 3-dart finish and still not an answer
    // to "name me a 2-dart route".
    const g = grade({ target: 40, doubleOut: true, ceiling: 2,
      darts: [d(10, 1), d(10, 1), d(10, 2)], foundKeys: new Set() });
    assert.equal(g.status, 'illegal');
    assert.equal(g.reason, 'too-many-darts');
    // The same darts at a 3-dart ceiling are fine.
    assert.equal(grade({ target: 40, doubleOut: true, ceiling: 3,
      darts: [d(10, 1), d(10, 1), d(10, 2)], foundKeys: new Set() }).status, 'new');
  });

  test('overshooting, falling short, and finishing off a double are each rejected with a reason', () => {
    assert.equal(grade({ target: 40, doubleOut: true, ceiling: 2, darts: [d(20, 3)], foundKeys: new Set() }).reason,
      'overshoots');
    assert.equal(grade({ target: 40, doubleOut: true, ceiling: 2, darts: [d(5, 1)], foundKeys: new Set() }).reason,
      'short');
    // The distinction that matters to the player: the arithmetic was right and
    // the finish was not. Reporting this as "goes past zero" would be a lie.
    assert.equal(grade({ target: 40, doubleOut: true, ceiling: 2, darts: [d(20, 1), d(20, 1)], foundKeys: new Set() }).reason,
      'bad-finish', 'lands on zero but not on a double');
  });

  test('a miss is rejected as a miss, not silently scored as a zero', () => {
    // Without its own guard this reaches evaluateVisit() as a legitimate 0-value
    // dart, so [Miss, D20] on 40 would grade as a legal 2-dart route — a route
    // with a miss in it, which is not a route.
    const g = grade({ target: 40, doubleOut: true, ceiling: 2, darts: [d(0, 1), d(20, 2)], foundKeys: new Set() });
    assert.equal(g.status, 'illegal');
    assert.equal(g.reason, 'miss');
  });

  test('an empty submission is rejected rather than throwing', () => {
    assert.equal(grade({ target: 40, doubleOut: true, ceiling: 2, darts: [], foundKeys: new Set() }).reason, 'empty');
    assert.equal(grade({ target: 40, doubleOut: true, ceiling: 2, darts: null, foundKeys: new Set() }).reason, 'empty');
  });

  test('straight-out accepts a finish a double-out hunt rejects', () => {
    const darts = [d(20, 1), d(20, 1)];   // 40, finishing on a single
    assert.equal(grade({ target: 40, doubleOut: true, ceiling: 2, darts, foundKeys: new Set() }).status, 'illegal');
    assert.equal(grade({ target: 40, doubleOut: false, ceiling: 2, darts, foundKeys: new Set() }).status, 'new');
  });

  test('every route the enumerator lists grades as new against an empty found set', () => {
    // The end-to-end contract between the two halves of this mode: if the
    // enumerator says a route exists, submitting it must be accepted — otherwise
    // a hunt can display a total it is impossible to reach.
    for (const target of [40, 60, 81, 100, 121, 170]) {
      for (const ceiling of [1, 2, 3]) {
        for (const r of S.allCheckoutRoutes(target, true, ceiling)) {
          const darts = r.darts.map(l => {
            if (l === 'Bull') return d(25, 2);
            if (l === '25') return d(25, 1);
            if (l[0] === 'T') return d(Number(l.slice(1)), 3);
            if (l[0] === 'D') return d(Number(l.slice(1)), 2);
            return d(Number(l), 1);
          });
          const g = grade({ target, doubleOut: true, ceiling, darts, foundKeys: new Set() });
          assert.equal(g.status, 'new', `${target}/${ceiling}: ${r.darts.join(' ')} was rejected (${g.reason})`);
          assert.equal(g.key, r.key, `${target}/${ceiling}: ${r.darts.join(' ')} canonicalised differently`);
        }
      }
    }
  });
});

describe('routeHuntProgress()', () => {
  test('reports found, total and coverage against the real route set', () => {
    const total = S.allCheckoutRoutes(40, true, 2).length;
    const p = S.routeHuntProgress(40, true, 2, 3);
    assert.equal(p.total, total);
    assert.equal(p.found, 3);
    assert.equal(p.coverage, +((3 / total) * 100).toFixed(1));
    assert.equal(p.complete, false);
  });

  test('complete once every route is found', () => {
    const p = S.routeHuntProgress(2, true, 1, 1);   // 2 at one dart: only D1
    assert.deepEqual([p.total, p.found, p.coverage, p.complete], [1, 1, 100, true]);
  });

  test('a found count above the total is clamped rather than exceeding 100%', () => {
    const p = S.routeHuntProgress(2, true, 1, 5);
    assert.equal(p.found, 1);
    assert.equal(p.coverage, 100);
  });

  test('an unfinishable target is not vacuously complete', () => {
    // 169 is a bogey number: there is nothing to find, which is a different
    // state from having found everything, and a "🎉 all routes found!" moment
    // there would be nonsense.
    const p = S.routeHuntProgress(169, true, 3, 0);
    assert.equal(p.total, 0);
    assert.equal(p.complete, false);
    assert.equal(p.coverage, 0);
  });
});
