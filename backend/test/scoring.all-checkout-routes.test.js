'use strict';
// allCheckoutRoutes() — docs/archive/checkout-trainer-route-recall-roadmap.md build-order step 1.
//
// That doc's own testing note is the reason this file is as heavy as it is: a wrong
// enumeration "would silently corrupt every 'already found?'/'is this complete?' check
// downstream." A missing route tells a player a legal answer they typed is wrong, and a
// duplicated one makes a target that can never be completed. Neither shows up as a crash.
//
// So the central test here is an INDEPENDENT ORACLE: a brute-force triple loop over every
// ordered dart sequence, canonicalized separately, compared as a set against the real
// function for every target and both out-modes. It is O(62^3) per target and far too slow
// to ship as the implementation, which is exactly what makes it a good oracle — it shares
// no structure with the code under test beyond the segment table.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

const SEG = S.CO_SEGMENTS;
const isDouble = l => l === 'Bull' || /^D\d+$/.test(l);
const valueOf = l => SEG.find(s => s.label === l).v;
const rank = new Map(SEG.map((x, i) => [x.label, i]));
const canon = (labels) => labels.slice(0, -1).sort((a, b) => rank.get(a) - rank.get(b)).join(' ')
  + '|' + labels[labels.length - 1];

// The oracle. Every ordered sequence of 1..maxDarts segments that sums to `rem` and ends
// on a legal finisher, collapsed to canonical keys.
function bruteForce(rem, doubleOut, maxDarts) {
  const keys = new Set();
  const ok = last => doubleOut ? isDouble(last) : true;
  for (const a of SEG) {
    if (a.v === rem && ok(a.label)) keys.add(canon([a.label]));
    if (maxDarts < 2 || a.v >= rem) continue;
    for (const b of SEG) {
      if (a.v + b.v === rem && ok(b.label)) keys.add(canon([a.label, b.label]));
      if (maxDarts < 3 || a.v + b.v >= rem) continue;
      for (const c of SEG) {
        if (a.v + b.v + c.v === rem && ok(c.label)) keys.add(canon([a.label, b.label, c.label]));
      }
    }
  }
  return keys;
}

describe('allCheckoutRoutes() — the complete route set for a target', () => {
  test('the segment alphabet is the whole board, doubles included', () => {
    // The roadmap proposed reusing CO_FIRSTS. This is why that would have been wrong:
    // CO_FIRSTS has no doubles at all, so any route using one as a SETUP dart —
    // a real thing a player can name — would have been missing from the answer.
    assert.equal(SEG.length, 62, 'S1-20, D1-20, T1-20, 25, Bull');
    assert.equal(SEG.filter(s => /^D\d+$/.test(s.label)).length, 20);
    assert.ok(!S.CO_FIRSTS.some(f => /^D\d+$/.test(f.label)),
      'CO_FIRSTS still has no doubles — if this ever changes, revisit why the two tables are separate');
    const r110 = S.allCheckoutRoutes(110, true, 3).map(r => r.darts.join(' '));
    assert.ok(r110.includes('T20 D15 D10') || r110.some(r => /D\d+ .*D\d+/.test(r)),
      'a route using a double as a setup dart must be enumerated');
  });

  test('matches an independent brute-force oracle for every target, both out-modes, every ceiling', () => {
    let compared = 0;
    for (const doubleOut of [true, false]) {
      for (let maxDarts = 1; maxDarts <= 3; maxDarts++) {
        for (let rem = 1; rem <= 180; rem++) {
          const got = new Set(S.allCheckoutRoutes(rem, doubleOut, maxDarts).map(r => r.key));
          const want = bruteForce(rem, doubleOut, maxDarts);
          assert.deepEqual([...got].sort(), [...want].sort(),
            `rem=${rem} doubleOut=${doubleOut} maxDarts=${maxDarts}`);
          compared++;
        }
      }
    }
    assert.equal(compared, 2 * 3 * 180);
  });

  test('every returned route is actually legal', () => {
    for (const doubleOut of [true, false]) {
      for (let rem = 2; rem <= 170; rem++) {
        for (const r of S.allCheckoutRoutes(rem, doubleOut, 3)) {
          assert.equal(r.darts.reduce((s, l) => s + valueOf(l), 0), rem,
            `${r.darts.join(' ')} does not sum to ${rem}`);
          assert.ok(r.darts.length >= 1 && r.darts.length <= 3);
          assert.equal(r.finish, r.darts[r.darts.length - 1]);
          if (doubleOut) assert.ok(isDouble(r.finish), `${r.darts.join(' ')} does not finish on a double`);
        }
      }
    }
  });

  test('no route is listed twice, in any target', () => {
    for (const doubleOut of [true, false]) {
      for (let rem = 2; rem <= 170; rem++) {
        const routes = S.allCheckoutRoutes(rem, doubleOut, 3);
        assert.equal(new Set(routes.map(r => r.key)).size, routes.length, `rem=${rem}`);
      }
    }
  });

  test("the shortest route agrees with checkoutHint()'s dart count", () => {
    // The doc's own suggested sanity check. Deliberately compares LENGTH, not the route
    // itself: checkoutHint() returns *a* shortest route (the one its preference order
    // reaches first), and several targets have many equally short ones.
    for (const doubleOut of [true, false]) {
      for (let rem = 1; rem <= 170; rem++) {
        const routes = S.allCheckoutRoutes(rem, doubleOut, 3);
        const hint = S.checkoutHint(rem, doubleOut, 3);
        if (!hint) { assert.equal(routes.length, 0, `checkoutHint says ${rem} is unfinishable`); continue; }
        assert.ok(routes.length > 0, `checkoutHint finishes ${rem} but the enumeration found nothing`);
        assert.equal(routes[0].darts.length, hint.split(' ').length,
          `rem=${rem} doubleOut=${doubleOut}: shortest enumerated route disagrees with the hint's dart count`);
      }
    }
  });

  test('bogey numbers have no routes at all', () => {
    // The scores that cannot be finished in three darts on a double-out.
    for (const bogey of [159, 162, 163, 165, 166, 168, 169]) {
      assert.deepEqual(S.allCheckoutRoutes(bogey, true, 3), [], `${bogey} is a bogey number`);
    }
    assert.deepEqual(S.allCheckoutRoutes(1, true, 3), [], 'you cannot finish on 1 with a double');
    assert.deepEqual(S.allCheckoutRoutes(171, true, 3), [], '170 is the double-out ceiling');
    // Straight-out reaches higher — 171 = T20 T20 T17 — so the function must not carry
    // checkoutHint()'s X01-flavoured `rem > 170` cutoff.
    assert.ok(S.allCheckoutRoutes(171, false, 3).length > 0, '171 IS finishable straight-out');
    assert.ok(S.allCheckoutRoutes(180, false, 3).length > 0, 'T20 T20 T20');
    assert.deepEqual(S.allCheckoutRoutes(181, false, 3), []);
  });

  test('a bigger ceiling only ever adds routes', () => {
    for (const doubleOut of [true, false]) {
      for (let rem = 2; rem <= 170; rem++) {
        const one = new Set(S.allCheckoutRoutes(rem, doubleOut, 1).map(r => r.key));
        const two = new Set(S.allCheckoutRoutes(rem, doubleOut, 2).map(r => r.key));
        const three = new Set(S.allCheckoutRoutes(rem, doubleOut, 3).map(r => r.key));
        for (const k of one) assert.ok(two.has(k), `rem=${rem}: the 2-dart ceiling lost a 1-dart route`);
        for (const k of two) assert.ok(three.has(k), `rem=${rem}: the 3-dart ceiling lost a 2-dart route`);
      }
    }
  });

  test('bad input returns an empty list rather than throwing', () => {
    for (const bad of [0, -5, 1.5, NaN, null, undefined, '100']) {
      assert.deepEqual(S.allCheckoutRoutes(bad, true, 3), []);
    }
    assert.deepEqual(S.allCheckoutRoutes(100, true, 0), []);
    assert.deepEqual(S.allCheckoutRoutes(100, true, 4), []);
    assert.ok(S.allCheckoutRoutes(100, true).length > 0, 'maxDarts defaults to 3');
  });

  test('the two out-modes really do differ', () => {
    // 3 is finishable straight-out and not at all on a double. Note there are TWO
    // one-dart answers, not one: a single 3 and a treble 1 are the same number and
    // different beds, so they are different routes to name.
    assert.deepEqual(S.allCheckoutRoutes(3, true, 1), []);
    assert.deepEqual(S.allCheckoutRoutes(3, false, 1).map(r => r.darts.join(' ')).sort(), ['3', 'T1']);
    // Every double-out route is also a straight-out route; the reverse is far from true.
    for (let rem = 2; rem <= 170; rem++) {
      const straight = new Set(S.allCheckoutRoutes(rem, false, 3).map(r => r.key));
      for (const r of S.allCheckoutRoutes(rem, true, 3)) {
        assert.ok(straight.has(r.key), `rem=${rem}: ${r.darts.join(' ')} is legal on a double-out but not straight-out?`);
      }
    }
  });
});

describe('routeKey() — "have I already found this one?"', () => {
  test('setup darts are order-independent; the final dart is not', () => {
    assert.equal(S.routeKey(['T20', 'T19', 'D12']), S.routeKey(['T19', 'T20', 'D12']),
      'T20 then T19 is not a different route from T19 then T20');
    assert.notEqual(S.routeKey(['D20', 'D10']), S.routeKey(['D10', 'D20']),
      'aiming D20 first and aiming D10 first ARE different routes');
  });

  test('every enumerated route round-trips through routeKey(), in any order', () => {
    for (const doubleOut of [true, false]) {
      for (let rem = 2; rem <= 170; rem += 7) {
        for (const r of S.allCheckoutRoutes(rem, doubleOut, 3)) {
          assert.equal(S.routeKey(r.darts), r.key);
          // Same darts, setup portion reversed — must land on the same key.
          const shuffled = [...r.setup].reverse().concat(r.finish);
          assert.equal(S.routeKey(shuffled), r.key, `${r.darts.join(' ')} did not canonicalize`);
        }
      }
    }
  });

  test('nonsense input is null, not a key that silently matches nothing', () => {
    assert.equal(S.routeKey([]), null);
    assert.equal(S.routeKey(['D21']), null);
    assert.equal(S.routeKey(['T20', 'MISS']), null);
    assert.equal(S.routeKey('T20'), null);
    assert.equal(S.routeKey(null), null);
  });
});
