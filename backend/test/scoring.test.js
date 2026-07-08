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
  challengeBadgeSignals, CHALLENGE_STREAK_WEEK, CHALLENGE_STREAK_MONTH,
  evaluateDartDoublesPractice, chuckinTiersReached, isStaircaseFinish,
  isCricketWhitewash, CRICKET_COMEBACK_THRESHOLD, cricketComebackAchieved } = scoring;

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

  test('rule 3 restated as "No Cigar" (docs/archive/achievements-badges-roadmap.md): busts hitting exactly the remaining score, just not on a double', () => {
    const ev = evaluateVisit({ score: 32, doubleOut: true }, [d(16,1), d(16,1)], {});
    assert.equal(ev.bust, true);
    assert.equal(ev.pointsThisVisit, 32, 'attempted points equal the exact remaining score — the condition awardRecurringBadge checks (ev.pointsThisVisit === p.score) for the No Cigar badge');
    assert.equal(ev.win, false);
  });

  test('the No Cigar bust sub-case is distinguishable from an overshoot bust and a left-on-1 bust by pointsThisVisit vs. the pre-visit score', () => {
    const startScore = 40;
    const overshoot = evaluateVisit({ score: startScore, doubleOut: true }, [d(20,3)], {});
    const leftOn1 = evaluateVisit({ score: 41, doubleOut: true }, [d(20,1), d(20,1)], {});
    const exactNotDouble = evaluateVisit({ score: startScore, doubleOut: true }, [d(20,1), d(20,1)], {});
    assert.ok(overshoot.pointsThisVisit > startScore, 'overshoot always scores more than the pre-visit remaining');
    assert.equal(leftOn1.pointsThisVisit, 40, 'left-on-1 scores exactly one less than the pre-visit remaining (41-1=40)');
    assert.notEqual(leftOn1.pointsThisVisit, 41, 'left-on-1 never equals the pre-visit score itself');
    assert.equal(exactNotDouble.pointsThisVisit, startScore, 'only this sub-case scores exactly the pre-visit remaining');
    assert.equal(exactNotDouble.bust, true);
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

// Ghost Opponent (docs/archive/ghost-opponent-roadmap.md): "replaying a stored leg's dart
// sequence is pure, deterministic logic" per the roadmap doc's own testing note.
// index.html's playGhostTurn() is exactly this: it takes a getGhostLegScript()-shaped
// turn (raw {sector,multiplier} darts), converts each via makeDartCore(), and
// re-evaluates it through this same evaluateVisit() against a running score — so
// the replay's correctness reduces entirely to "does replaying known dart sequences
// through evaluateVisit reproduce the recorded bust/win outcome," which this suite
// already establishes above. This test exercises that exact sequence end to end
// (a small multi-turn leg script), rather than one visit in isolation.
describe('Ghost Opponent replay (docs/archive/ghost-opponent-roadmap.md)', () => {
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

describe('evaluateDartDoublesPractice (per-dart drill mode, docs/game-modes-roadmap.md "Doubles Practice")', () => {
  const targets = [16, 8, 4, 25]; // D16, D8, D4, double-bull

  test('a double on a target number is a hit, session continues', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(16, 2), targets), { hit: true, ended: false, reason: null });
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(4, 2), targets), { hit: true, ended: false, reason: null });
  });

  test('double-bull (sector 25, mult 2) counts as a hit when bull is a target', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(25, 2), targets), { hit: true, ended: false, reason: null });
  });

  test('a double on a number NOT in the target set is "wrong double" and ends the session', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(20, 2), targets), { hit: false, ended: true, reason: 'wrong-double' });
  });

  test('a single on a target number is "so close" and ends the session', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(16, 1), targets), { hit: false, ended: true, reason: 'so-close' });
  });

  test('a treble on a target number is also "so close" (right number, wrong ring) — not a separate failure mode', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(8, 3), targets), { hit: false, ended: true, reason: 'so-close' });
  });

  test('single bull (sector 25, mult 1) on a target set including bull is "so close", not a hit', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(25, 1), targets), { hit: false, ended: true, reason: 'so-close' });
  });

  test('a single/treble on an unrelated (non-target) number is a genuine miss: no hit, session does not end', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(20, 1), targets), { hit: false, ended: false, reason: null });
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(11, 3), targets), { hit: false, ended: false, reason: null });
  });

  test('a genuine total miss (sector 0) never ends the session or counts as a hit', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(0, 1), targets), { hit: false, ended: false, reason: null });
  });

  test('an attempted treble-bull downgrades to a single bull (makeDartCore\'s existing guard) and is scored as "so close" when bull is targeted', () => {
    const d = makeDartCore(25, 3);
    assert.equal(d.mult, 1, 'treble bull is not a real outcome — makeDartCore downgrades it to a single');
    assert.deepEqual(evaluateDartDoublesPractice(d, targets), { hit: false, ended: true, reason: 'so-close' });
  });

  test('a single target ([16]) still distinguishes hit vs so-close vs wrong-double correctly', () => {
    const single = [16];
    assert.equal(evaluateDartDoublesPractice(makeDartCore(16, 2), single).hit, true);
    assert.equal(evaluateDartDoublesPractice(makeDartCore(16, 1), single).reason, 'so-close');
    assert.equal(evaluateDartDoublesPractice(makeDartCore(8, 2), single).reason, 'wrong-double');
  });
});

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

describe('chuckinTiersReached (Just Chuckin\' It milestone ladders, game-modes-roadmap.md "Just Chuckin\' It")', () => {
  // Mirrors index.html's CHUCKIN_MILESTONE_LADDERS trebles ladder thresholds
  // exactly, so a regression here would also catch a real ladder-data typo.
  const treblesTiers = [
    { threshold: 10 }, { threshold: 50 }, { threshold: 100 }, { threshold: 500 }, { threshold: 1000 },
  ];

  test('a value below the lowest tier reaches nothing', () => {
    assert.deepEqual(chuckinTiersReached(treblesTiers, 9), []);
  });

  test('a value is reached at exactly its threshold, not just above it', () => {
    assert.deepEqual(chuckinTiersReached(treblesTiers, 10), [10]);
    assert.deepEqual(chuckinTiersReached(treblesTiers, 11), [10]);
  });

  test('a value between two tiers reaches every tier at or below it, not just the nearest one', () => {
    assert.deepEqual(chuckinTiersReached(treblesTiers, 75), [10, 50]);
  });

  test('a value at or above the top tier reaches every tier', () => {
    assert.deepEqual(chuckinTiersReached(treblesTiers, 1000), [10, 50, 100, 500, 1000]);
    assert.deepEqual(chuckinTiersReached(treblesTiers, 50000), [10, 50, 100, 500, 1000]);
  });

  test('an empty ladder reaches nothing, and a zero value reaches nothing', () => {
    assert.deepEqual(chuckinTiersReached([], 100), []);
    assert.deepEqual(chuckinTiersReached(treblesTiers, 0), []);
  });
});

describe('isStaircaseFinish (Staircase Finish achievement, REFERENCE.md\'s Achievements section)', () => {
  test('the user\'s own worked example: left on 32, single 16 / single 8 / double 4', () => {
    assert.equal(isStaircaseFinish(32, [d(16,1), d(8,1), d(4,2)]), true);
  });

  test('left on 40, single 20 / single 10 / double 5', () => {
    assert.equal(isStaircaseFinish(40, [d(20,1), d(10,1), d(5,2)]), true);
  });

  test('left on 8, single 4 / single 2 / double 1 — the smallest qualifying start', () => {
    assert.equal(isStaircaseFinish(8, [d(4,1), d(2,1), d(1,2)]), true);
  });

  test('every qualifying starting score (8, 16, 24, 32, 40) matches its own halving triple', () => {
    assert.equal(isStaircaseFinish(16, [d(8,1), d(4,1), d(2,2)]), true);
    assert.equal(isStaircaseFinish(24, [d(12,1), d(6,1), d(3,2)]), true);
  });

  test('the classic double-out route (no misses to the single) does not qualify', () => {
    // Same 32 left, finished the "normal" way — straight to double 16, one dart.
    assert.equal(isStaircaseFinish(32, [d(16,2)]), false);
  });

  test('a starting score not a multiple of 8 never qualifies', () => {
    assert.equal(isStaircaseFinish(30, [d(15,1), d(7,1), d(4,2)]), false);
  });

  test('a starting score above 40 fails because the first dart would exceed a single (max 20)', () => {
    assert.equal(isStaircaseFinish(48, [d(24,1), d(12,1), d(6,2)]), false);
  });

  test('right shape but a wrong multiplier on any of the three darts fails', () => {
    assert.equal(isStaircaseFinish(32, [d(16,2), d(8,1), d(4,2)]), false);  // first dart a double, not single
    assert.equal(isStaircaseFinish(32, [d(16,1), d(8,2), d(4,2)]), false);  // second dart a double, not single
    assert.equal(isStaircaseFinish(32, [d(16,1), d(8,1), d(4,1)]), false); // last dart a single, not double
  });

  test('right shape but a wrong sector on any dart fails', () => {
    assert.equal(isStaircaseFinish(32, [d(15,1), d(8,1), d(4,2)]), false);
    assert.equal(isStaircaseFinish(32, [d(16,1), d(9,1), d(4,2)]), false);
    assert.equal(isStaircaseFinish(32, [d(16,1), d(8,1), d(5,2)]), false);
  });

  test('fewer or more than exactly 3 darts never qualifies', () => {
    assert.equal(isStaircaseFinish(32, [d(16,1), d(8,1)]), false);
    assert.equal(isStaircaseFinish(32, [d(16,1), d(8,1), d(4,2), d(1,1)]), false);
  });
});

describe('isCricketWhitewash (Cricket-native badge, docs/game-modes-roadmap.md "New Cricket-native badges")', () => {
  test('true when every number is still open (0 marks each)', () => {
    assert.equal(isCricketWhitewash({ 15:0, 16:0, 17:0, 18:0, 19:0, 20:0, 25:0 }), true);
  });

  test('true when every number has marks but none reached 3 (closed)', () => {
    assert.equal(isCricketWhitewash({ 15:2, 16:1, 17:0, 18:2, 19:0, 20:1, 25:2 }), true);
  });

  test('false as soon as a single number is closed (3+ marks), regardless of the rest', () => {
    assert.equal(isCricketWhitewash({ 15:0, 16:0, 17:0, 18:0, 19:0, 20:3, 25:0 }), false);
    assert.equal(isCricketWhitewash({ 15:0, 16:0, 17:0, 18:0, 19:0, 20:5, 25:0 }), false, 'beyond 3 (over-closed) still counts as closed');
  });

  test('an empty or missing marks object counts as a whitewash (nothing closed)', () => {
    assert.equal(isCricketWhitewash({}), true);
    assert.equal(isCricketWhitewash(undefined), true);
    assert.equal(isCricketWhitewash(null), true);
  });
});

describe('cricketComebackAchieved (Cricket-native Comeback Kid, docs/game-modes-roadmap.md)', () => {
  test(`fires at exactly the ${CRICKET_COMEBACK_THRESHOLD}-point threshold and above`, () => {
    assert.equal(cricketComebackAchieved(CRICKET_COMEBACK_THRESHOLD), true);
    assert.equal(cricketComebackAchieved(CRICKET_COMEBACK_THRESHOLD + 1), true);
    assert.equal(cricketComebackAchieved(CRICKET_COMEBACK_THRESHOLD * 3), true);
  });

  test('does not fire just below the threshold', () => {
    assert.equal(cricketComebackAchieved(CRICKET_COMEBACK_THRESHOLD - 1), false);
  });

  test('a zero or negative deficit (never trailed, or led the whole leg) never fires', () => {
    assert.equal(cricketComebackAchieved(0), false);
    assert.equal(cricketComebackAchieved(-5), false);
  });

  test('a missing/undefined deficit is treated as zero, not a crash', () => {
    assert.equal(cricketComebackAchieved(undefined), false);
    assert.equal(cricketComebackAchieved(null), false);
  });
});
