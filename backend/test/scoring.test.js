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
const { evaluateVisit, evaluateVisitCricket, makeDartCore, checkoutHint, CRICKET_STANDARD_NUMBERS,
  challengeBadgeSignals, CHALLENGE_STREAK_WEEK, CHALLENGE_STREAK_MONTH } = scoring;

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

// Ghost Opponent (docs/ghost-opponent-roadmap.md): "replaying a stored leg's dart
// sequence is pure, deterministic logic" per the roadmap doc's own testing note.
// index.html's playGhostTurn() is exactly this: it takes a getGhostLegScript()-shaped
// turn (raw {sector,multiplier} darts), converts each via makeDartCore(), and
// re-evaluates it through this same evaluateVisit() against a running score — so
// the replay's correctness reduces entirely to "does replaying known dart sequences
// through evaluateVisit reproduce the recorded bust/win outcome," which this suite
// already establishes above. This test exercises that exact sequence end to end
// (a small multi-turn leg script), rather than one visit in isolation.
describe('Ghost Opponent replay (docs/ghost-opponent-roadmap.md)', () => {
  test('replaying a recorded leg\'s turn-by-turn script through evaluateVisit reproduces the same outcome at each step', () => {
    // Mirrors the shape backend/db.js's getGhostLegScript() returns: darts as
    // plain {sector, multiplier} pairs, one entry per turn, in playback order.
    const script = [
      { darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }] }, // 180, remaining 321
      { darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }] }, // 180, remaining 141
      { darts: [{ sector: 20, multiplier: 3 }, { sector: 19, multiplier: 3 }, { sector: 12, multiplier: 2 }] }, // 141 checkout, remaining 0 (the classic 9-dart finish)
    ];
    const ghost = { score: 501, doubleOut: true };
    const results = script.map(turn => {
      const madeDarts = turn.darts.map(d => makeDartCore(d.sector, d.multiplier));
      const ev = evaluateVisit(ghost, madeDarts, {});
      if (!ev.bust) ghost.score = ev.newScore;
      return ev;
    });
    assert.deepEqual(results.map(r => r.scored), [180, 180, 141]);
    assert.deepEqual(results.map(r => r.newScore), [321, 141, 0]);
    assert.equal(results[2].win, true, 'the final scripted visit reproduces the recorded checkout');
    assert.equal(ghost.score, 0);
  });

  test('a recorded leg re-evaluated against the wrong out mode reproduces a different outcome — why the replay must reuse the leg\'s own out_mode', () => {
    // T20 + T13 + single-2 = 101, finishing on a single (not a double).
    const darts = [makeDartCore(20, 3), makeDartCore(13, 3), makeDartCore(2, 1)];
    const singleOut = evaluateVisit({ score: 101, doubleOut: false }, darts, {});
    assert.equal(singleOut.win, true, 'legal finish under the leg\'s actual (single-out) rule');
    const doubleOut = evaluateVisit({ score: 101, doubleOut: true }, darts, {});
    assert.equal(doubleOut.win, false);
    assert.equal(doubleOut.bust, true, 'the identical darts bust under double-out — getGhostLegScript()\'s outMode field exists exactly to prevent this mismatch');
  });
});

// Mirrors index.html's CHALLENGE_FORMATS constant (the 6 Daily Challenge formats).
const CHALLENGE_FORMATS = ['checkout_sprint', 'speed_to_zero', 'bullseye_gauntlet', 'steady_hand', 'treble_run', 'long_game'];

describe('challengeBadgeSignals (Daily Challenge badges: streak + format-completionist, docs/daily-challenge-roadmap.md)', () => {
  test('week badge fires only at exactly a 7-day streak, not before or after', () => {
    assert.equal(challengeBadgeSignals({ currentStreak: 6, bestByFormat: {} }, CHALLENGE_FORMATS).week, false);
    assert.equal(challengeBadgeSignals({ currentStreak: CHALLENGE_STREAK_WEEK, bestByFormat: {} }, CHALLENGE_FORMATS).week, true);
    assert.equal(challengeBadgeSignals({ currentStreak: 8, bestByFormat: {} }, CHALLENGE_FORMATS).week, false, 'an exact-crossing check, not >=, so a long streak does not refire this badge every day');
  });

  test('month badge fires only at exactly a 30-day streak, and is independent of the week badge', () => {
    const at30 = challengeBadgeSignals({ currentStreak: CHALLENGE_STREAK_MONTH, bestByFormat: {} }, CHALLENGE_FORMATS);
    assert.equal(at30.month, true);
    assert.equal(at30.week, false, 'a 30-day streak does not also re-trigger the 7-day badge the same day');
    assert.equal(challengeBadgeSignals({ currentStreak: 29, bestByFormat: {} }, CHALLENGE_FORMATS).month, false);
    assert.equal(challengeBadgeSignals({ currentStreak: 31, bestByFormat: {} }, CHALLENGE_FORMATS).month, false);
  });

  test('allFormats fires only once every one of the 6 formats has a completed attempt', () => {
    const fiveOfSix = { checkout_sprint: 12, speed_to_zero: 8, bullseye_gauntlet: 3, steady_hand: 20, treble_run: 5 };
    assert.equal(challengeBadgeSignals({ currentStreak: 0, bestByFormat: fiveOfSix }, CHALLENGE_FORMATS).allFormats, false, 'missing long_game entirely');
    const sixOfSix = { ...fiveOfSix, long_game: 40 };
    assert.equal(challengeBadgeSignals({ currentStreak: 0, bestByFormat: sixOfSix }, CHALLENGE_FORMATS).allFormats, true);
  });

  test('a format present but never completed (getChallengeHistory only ever populates completed attempts) does not satisfy allFormats', () => {
    // bestByFormat can never actually contain a null/undefined entry in practice
    // (getChallengeHistory's query filters to completed=1), but this guards the
    // pure function's own contract in case a caller passes an incomplete map.
    const withGap = { checkout_sprint: 12, speed_to_zero: 8, bullseye_gauntlet: 3, steady_hand: 20, treble_run: 5, long_game: null };
    assert.equal(challengeBadgeSignals({ currentStreak: 0, bestByFormat: withGap }, CHALLENGE_FORMATS).allFormats, false);
  });

  test('missing/zero history is handled without throwing', () => {
    assert.deepEqual(challengeBadgeSignals({}, CHALLENGE_FORMATS), { week: false, month: false, allFormats: false });
    assert.deepEqual(challengeBadgeSignals(null, CHALLENGE_FORMATS), { week: false, month: false, allFormats: false });
  });
});
