'use strict';
// Tests for the pure scoring logic extracted to frontend/scoring.js
// (docs/testing-and-observability-roadmap.md Part B) — evaluateVisit() (X01
// bust/win rules), evaluateVisitCricket() (mark accumulation/opponent gating/win
// condition), and the checkout route calculator. This is REFERENCE.md §2's exact
// spec, hand-verified here rather than relying on manual/Playwright spot-checks.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const scoring = require(path.join('..', '..', 'frontend', 'scoring.js'));
const { evaluateVisit, evaluateVisitCricket, makeDartCore, checkoutHint, CRICKET_STANDARD_NUMBERS } = scoring;

// Builds a real dart object the same way the app does (makeDart minus the
// thrownAt timestamp), rather than hand-rolling a fake {value,isDouble,...} shape.
const d = (sector, mult) => makeDartCore(sector, mult);

describe('evaluateVisit (X01 bust/win rules, REFERENCE.md §2)', () => {
  test('ordinary scoring visit: no bust, no win', () => {
    const ev = evaluateVisit({ score: 501, doubleOut: true }, [d(20,1), d(20,1), d(20,1)], {});
    assert.equal(ev.bust, false);
    assert.equal(ev.win, false);
    assert.equal(ev.pointsThisVisit, 60);
    assert.equal(ev.scored, 60);
    assert.equal(ev.newScore, 441);
  });

  test('rule 1 — overshoot busts', () => {
    const ev = evaluateVisit({ score: 40, doubleOut: true }, [d(20,3)], {}); // 60 > 40
    assert.equal(ev.bust, true);
    assert.equal(ev.win, false);
    assert.equal(ev.scored, 0);
    assert.equal(ev.newScore, 40, 'score unchanged on bust');
    assert.equal(ev.pointsThisVisit, 60, 'attempted points still reported even though scored=0');
  });

  test('rule 2 — leaves exactly 1 in double-out busts', () => {
    const ev = evaluateVisit({ score: 41, doubleOut: true }, [d(20,1), d(20,1)], {}); // 41-40=1
    assert.equal(ev.bust, true);
    assert.equal(ev.win, false);
    assert.equal(ev.newScore, 41);
  });

  test('leaving 1 in single-out mode is NOT a bust (finishable next visit)', () => {
    const ev = evaluateVisit({ score: 21, doubleOut: false }, [d(20,1)], {}); // 21-20=1
    assert.equal(ev.bust, false);
    assert.equal(ev.win, false);
    assert.equal(ev.newScore, 1);
  });

  test('rule 3 — hits exactly 0 but last dart is not a double: busts in double-out (Busted Maximum)', () => {
    const ev = evaluateVisit({ score: 180, doubleOut: true }, [d(20,3), d(20,3), d(20,3)], {});
    assert.equal(ev.bust, true, 'a genuine 180 attempt at exactly the remaining score still busts without a double finish');
    assert.equal(ev.win, false);
    assert.equal(ev.scored, 0);
    assert.equal(ev.newScore, 180);
  });

  test('hits exactly 0 on a double, double-out mode: wins', () => {
    const ev = evaluateVisit({ score: 40, doubleOut: true }, [d(20,2)], {});
    assert.equal(ev.win, true);
    assert.equal(ev.bust, false);
    assert.equal(ev.scored, 40);
    assert.equal(ev.newScore, 0);
  });

  test('hits exactly 0 on a non-double, single-out mode: wins (no double required)', () => {
    const ev = evaluateVisit({ score: 60, doubleOut: false }, [d(20,1), d(20,1), d(20,1)], {});
    assert.equal(ev.win, true);
    assert.equal(ev.bust, false);
    assert.equal(ev.scored, 60);
    assert.equal(ev.newScore, 0);
  });

  test('trebleLess: true only when every dart in the visit is a non-treble', () => {
    assert.equal(evaluateVisit({ score: 501, doubleOut: true }, [d(20,1), d(20,2)], {}).trebleLess, true);
    assert.equal(evaluateVisit({ score: 501, doubleOut: true }, [d(20,1), d(20,3)], {}).trebleLess, false);
    assert.equal(evaluateVisit({ score: 501, doubleOut: true }, [], {}).trebleLess, false, 'zero darts is not trebleless');
  });
});

describe('evaluateVisitCricket (mark accumulation + opponent gating + win condition, REFERENCE.md §2)', () => {
  const numbers = CRICKET_STANDARD_NUMBERS; // [15,16,17,18,19,20,25]
  const freshMarks = () => Object.fromEntries(numbers.map(n => [n, 0]));
  const player = (marks, points) => ({ marks, points });
  const game = (players) => ({ config: { numbers }, players });

  test('marks accumulate dart-by-dart; a dart that only closes the number (exactly 3) scores 0', () => {
    const shooter = player(freshMarks(), 0);
    const opp = player(freshMarks(), 0);
    const ev = evaluateVisitCricket(shooter, [d(20,3)], game([shooter, opp])); // one treble = 3 marks, exactly closes
    assert.equal(ev.marks[20], 3);
    assert.equal(ev.pointsThisVisit, 0, 'closing marks themselves are worth 0 points');
    assert.equal(ev.win, false);
  });

  test('marks beyond closing score points, only while an opponent is still open on that number', () => {
    const shooter = player(freshMarks(), 0);
    const opp = player(freshMarks(), 0); // opponent's 20 is open
    const ev = evaluateVisitCricket(shooter, [d(20,3), d(20,3)], game([shooter, opp]));
    // dart1: 0->3 (closes, 0 pts). dart2: 3->6, 3 marks beyond, opponent open -> 3*20=60.
    assert.equal(ev.marks[20], 6);
    assert.equal(ev.pointsThisVisit, 60);
  });

  test('marks beyond closing score NOTHING once every opponent has also closed that number', () => {
    const shooter = player(freshMarks(), 0);
    const opp = player({ ...freshMarks(), 20: 3 }, 0); // opponent already closed 20
    const ev = evaluateVisitCricket(shooter, [d(20,3), d(20,3)], game([shooter, opp]));
    assert.equal(ev.marks[20], 6);
    assert.equal(ev.pointsThisVisit, 0, 'no opponent left open on 20, so the beyond-marks score nothing');
  });

  test('a number already closed entering the visit: every mark this visit scores fully while an opponent is open', () => {
    const shooter = player({ ...freshMarks(), 20: 3 }, 0);
    const opp = player(freshMarks(), 0);
    const ev = evaluateVisitCricket(shooter, [d(20,3)], game([shooter, opp])); // 3->6, all 3 marks are "beyond"
    assert.equal(ev.pointsThisVisit, 60);
  });

  test('a dart on an out-of-play sector (miss, or a number not in this match) is a no-op', () => {
    const shooter = player(freshMarks(), 0);
    const opp = player(freshMarks(), 0);
    const ev = evaluateVisitCricket(shooter, [d(1,1), d(0,1)], game([shooter, opp])); // 1 isn't in the classic set; 0 is a miss
    assert.deepEqual(ev.marks, freshMarks());
    assert.equal(ev.pointsThisVisit, 0);
  });

  test('bull (sector 25) accumulates and scores the same way, worth 25 per beyond-mark', () => {
    const shooter = player(freshMarks(), 0);
    const opp = player(freshMarks(), 0);
    // double bull, single bull (closes at exactly 3), then a double bull (2 beyond)
    const ev = evaluateVisitCricket(shooter, [d(25,2), d(25,1), d(25,2)], game([shooter, opp]));
    assert.equal(ev.marks[25], 5);
    assert.equal(ev.pointsThisVisit, 2 * 25, 'only the 2 marks past the closing 3 score, at 25 each');
  });

  test('win requires every in-play number closed AND strictly more points than every opponent', () => {
    // Build a shooter who has closed everything with 10 points, opponent open on nothing special but only 5 points.
    const closedMarks = Object.fromEntries(numbers.map(n => [n, 3]));
    const shooter = player(closedMarks, 10);
    const opp = player(freshMarks(), 5);
    // A meaningless single miss dart, just to exercise the function; win is evaluated on state, not this dart.
    const ev = evaluateVisitCricket(shooter, [d(0,1)], game([shooter, opp]));
    assert.equal(ev.win, true);
  });

  test('closed everything but tied or behind on points: not a win (known open edge case, not a bug)', () => {
    const closedMarks = Object.fromEntries(numbers.map(n => [n, 3]));
    const tiedShooter = player(closedMarks, 10);
    const tiedOpp = player(freshMarks(), 10);
    assert.equal(evaluateVisitCricket(tiedShooter, [d(0,1)], game([tiedShooter, tiedOpp])).win, false, 'exact tie is not a win');

    const behindShooter = player(closedMarks, 10);
    const aheadOpp = player(freshMarks(), 15);
    assert.equal(evaluateVisitCricket(behindShooter, [d(0,1)], game([behindShooter, aheadOpp])).win, false);
  });

  test('has the most points but has not closed every number: not a win', () => {
    const almostClosed = { ...Object.fromEntries(numbers.map(n => [n, 3])), 25: 0 }; // Bull still open
    const shooter = player(almostClosed, 100);
    const opp = player(freshMarks(), 0);
    assert.equal(evaluateVisitCricket(shooter, [d(0,1)], game([shooter, opp])).win, false);
  });

  test('3+ players: win requires strictly more points than EVERY opponent, not just one', () => {
    const closedMarks = Object.fromEntries(numbers.map(n => [n, 3]));
    const shooter = player(closedMarks, 20);
    const opponentA = player(freshMarks(), 5);   // shooter beats this one
    const opponentB = player(freshMarks(), 25);  // shooter is behind this one
    const g = game([shooter, opponentA, opponentB]);
    assert.equal(evaluateVisitCricket(shooter, [d(0,1)], g).win, false, 'still trails opponentB');

    opponentB.points = 10; // now shooter leads both
    assert.equal(evaluateVisitCricket(shooter, [d(0,1)], g).win, true);
  });
});

// Parses a checkoutHint() route string ("T20 T20 Bull") back into a total point
// value and whether the final dart is a double/bull — lets tests verify a route
// is mathematically valid and rule-compliant instead of hardcoding an exact
// string for combinations the algorithm's search order isn't obviously fixed for.
function labelValue(label) {
  if (label === 'Bull') return 50;
  if (label === '25') return 25;
  if (label[0] === 'T') return 3 * Number(label.slice(1));
  if (label[0] === 'D') return 2 * Number(label.slice(1));
  return Number(label);
}
function labelIsDouble(label) { return label === 'Bull' || label[0] === 'D'; }
function routeSum(hint) { return hint.split(' ').reduce((s, l) => s + labelValue(l), 0); }
function routeDartCount(hint) { return hint.split(' ').length; }

describe('checkoutHint (checkout route calculator, REFERENCE.md §2)', () => {
  test('170 double-out: the maximum possible checkout (Big Fish route)', () => {
    assert.equal(checkoutHint(170, true, 3), 'T20 T20 Bull');
  });

  test('40 double-out: the single most common checkout, one dart', () => {
    assert.equal(checkoutHint(40, true, 3), 'D20');
  });

  test('32 double-out: a direct double, one dart', () => {
    assert.equal(checkoutHint(32, true, 3), 'D16');
  });

  test('a known bogey number (169) is unfinishable in double-out', () => {
    assert.equal(checkoutHint(169, true, 3), '');
  });

  test('leaves exactly 1 in double-out: unfinishable (matches evaluateVisit\'s bust rule)', () => {
    assert.equal(checkoutHint(1, true, 3), '');
  });

  test('leaves exactly 1 in single-out: trivially finishable with any single 1', () => {
    assert.equal(checkoutHint(1, false, 3), '1');
  });

  test('out of range (0, negative, >170) or maxDarts<1: always empty', () => {
    assert.equal(checkoutHint(0, true, 3), '');
    assert.equal(checkoutHint(171, true, 3), '');
    assert.equal(checkoutHint(50, true, 0), '');
  });

  test('maxDarts limits the search: 170 needs all 3 darts, unreachable with only 1 or 2', () => {
    assert.equal(checkoutHint(170, true, 1), '');
    assert.equal(checkoutHint(170, true, 2), '');
    assert.notEqual(checkoutHint(170, true, 3), '');
  });

  test('every returned double-out route sums to the target and finishes on a double/bull', () => {
    for (const rem of [170, 121, 96, 100, 141, 40, 32, 50, 60, 80, 110, 130, 2, 170]) {
      const hint = checkoutHint(rem, true, 3);
      if (!hint) continue; // some of these may legitimately be unfinishable; only check the ones that returned a route
      const labels = hint.split(' ');
      assert.equal(routeSum(hint), rem, `route "${hint}" for ${rem} should sum to ${rem}`);
      assert.ok(routeDartCount(hint) <= 3, `route "${hint}" should use at most 3 darts`);
      assert.ok(labelIsDouble(labels[labels.length - 1]), `route "${hint}" for ${rem} must finish on a double/bull in double-out mode`);
    }
  });

  test('single-out routes sum to the target with no double-finish requirement', () => {
    for (const rem of [170, 121, 100, 45, 13]) {
      const hint = checkoutHint(rem, false, 3);
      if (!hint) continue;
      assert.equal(routeSum(hint), rem, `single-out route "${hint}" for ${rem} should sum to ${rem}`);
    }
  });
});
