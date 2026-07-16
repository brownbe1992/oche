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
const { evaluateVisit, evaluateVisitCricket, makeDartCore, checkoutHint, CRICKET_STANDARD_NUMBERS, CRICKET_ALL_NUMBERS,
  evaluateVisitBaseball, baseballInningTarget, isBaseballCycle, parseSqliteTimestamp,
  challengeBadgeSignals, CHALLENGE_STREAK_WEEK, CHALLENGE_STREAK_MONTH,
  evaluateDartDoublesPractice, evaluateDartAroundTheClock, chuckinTiersReached, isStaircaseFinish,
  isBedAndBreakfast, isMadhouseFinish, isShanghaiVisit,
  isCricketWhitewash, CRICKET_COMEBACK_THRESHOLD, cricketComebackAchieved, cricketStoneColdAchieved,
  evaluateVisitBobs27, isBobs27FullHouse, isBobs27FullAnderson,
  pickCheckoutTarget, CHECKOUT_TRAINER_DIFFICULTY_TIERS, gradeCheckoutAttempt, blitzDeadlinePassed, isPhotoFinishSubmission,
  CHECKOUT_TRAINER_TRICK_CHANCE, listUnsolvableTargets, gradeCheckoutDeclaration,
  rebuildX01State, rebuildCricketState, rebuildBaseballState,
  rebuildAroundTheClockState, rebuildAroundTheWorldState, rebuildBobs27State, rebuildCheckoutLadderState } = scoring;

// Shorthand for building a rebuild-function turn record: v(playerIndex, setNo,
// legNo, [[sector,mult], ...]) — mirrors the {playerIndex,setNo,legNo,darts}
// shape getResumeState() (backend/db.js) sends the client.
const v = (playerIndex, setNo, legNo, darts) => ({ playerIndex, setNo, legNo, darts: darts.map(([sector, mult]) => ({ sector, mult })) });

// Builds a real dart object the same way the app does (makeDart minus the
// thrownAt timestamp), rather than hand-rolling a fake {value,isDouble,...} shape.
const d = (sector, mult) => makeDartCore(sector, mult);

describe('parseSqliteTimestamp (Ghost mode "Invalid Date" bug fix, docs/bug-roadmap.md BUG-17)', () => {
  test('parses SQLite\'s datetime(\'now\') shape ("YYYY-MM-DD HH:MM:SS", no T, no tz) as UTC', () => {
    const parsed = parseSqliteTimestamp('2024-01-15 10:30:00');
    assert.equal(isNaN(parsed), false, 'must not be an Invalid Date');
    assert.equal(parsed.toISOString(), '2024-01-15T10:30:00.000Z');
  });

  test('does not double-append Z to a string that already ends in Z', () => {
    const parsed = parseSqliteTimestamp('2024-01-15T10:30:00Z');
    assert.equal(isNaN(parsed), false);
    assert.equal(parsed.toISOString(), '2024-01-15T10:30:00.000Z');
  });

  test('does not append Z to a string that already carries an explicit +/-HH:MM offset', () => {
    const parsed = parseSqliteTimestamp('2024-01-15T10:30:00+02:00');
    assert.equal(isNaN(parsed), false);
    assert.equal(parsed.toISOString(), '2024-01-15T08:30:00.000Z');
  });

  test('null/undefined/empty input returns null rather than an Invalid Date object', () => {
    assert.equal(parseSqliteTimestamp(null), null);
    assert.equal(parseSqliteTimestamp(undefined), null);
    assert.equal(parseSqliteTimestamp(''), null);
  });

  test('toLocaleDateString() on the parsed result is never the literal string "Invalid Date" — the exact symptom the bug report described', () => {
    const parsed = parseSqliteTimestamp('2024-01-15 10:30:00');
    const rendered = parsed.toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
    assert.notEqual(rendered, 'Invalid Date');
    assert.match(rendered, /\d{4}/, 'renders a real 4-digit year, not garbage');
  });
});

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

  // docs/archive/dartboard-zone-tracking-roadmap.md: zone/missZone/missDepth/bounced are all
  // purely additive metadata the frontend stamps onto a dart object after makeDart()
  // returns it (see throwDart() in index.html) — evaluateVisit() never reads any of
  // them, only d.value, so a visit's scored/bust/win outcome must be byte-identical
  // whether or not they're present. Also proves a bounce-out dart (sector:0,
  // multiplier:1, bounced:true) is scored exactly like a plain miss.
  test('zone/missZone/missDepth/bounced on a dart object never change evaluateVisit()\'s outcome', () => {
    const plain = [d(20,1), d(20,1), d(0,1)];
    const withMeta = [
      Object.assign(d(20,1), { zone: 'inner' }),
      Object.assign(d(20,1), { zone: 'outer' }),
      Object.assign(d(0,1), { missZone: 5, missDepth: 'near', bounced: true }),
    ];
    const evPlain = evaluateVisit({ score: 501, doubleOut: true }, plain, {});
    const evMeta = evaluateVisit({ score: 501, doubleOut: true }, withMeta, {});
    assert.deepEqual(evMeta, evPlain);
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

describe('evaluateVisitCricket — cutthroat variant (docs/cutthroat-cricket-roadmap.md)', () => {
  const numbers = CRICKET_STANDARD_NUMBERS;
  const freshMarks = () => Object.fromEntries(numbers.map(n => [n, 0]));
  const player = (name, marks, points) => ({ name, marks, points });
  const cutthroatGame = (players) => ({ config: { numbers, variant: 'cutthroat' }, players });

  test('closing marks (exactly 3) still score 0 onto anyone, same as standard', () => {
    const shooter = player('A', freshMarks(), 0);
    const opp = player('B', freshMarks(), 0);
    const ev = evaluateVisitCricket(shooter, [d(20,3)], cutthroatGame([shooter, opp]));
    assert.equal(ev.pointsThisVisit, 0);
    assert.equal(ev.points, 0, "shooter's own total never moves in cutthroat");
    assert.deepEqual(ev.opponentGains, [{ name:'B', gained:0 }]);
  });

  test('marks beyond closing land on the OPPONENT, not the shooter, while the opponent is still open', () => {
    const shooter = player('A', freshMarks(), 0);
    const opp = player('B', freshMarks(), 0);
    const ev = evaluateVisitCricket(shooter, [d(20,3), d(20,3)], cutthroatGame([shooter, opp]));
    // dart1: 0->3 (closes, 0 pts). dart2: 3->6, 3 marks beyond * 20 = 60 -> onto B, not A.
    assert.equal(ev.pointsThisVisit, 60, 'the visit still generated 60 points of value');
    assert.equal(ev.points, 0, "shooter's own points are untouched by their own hits");
    assert.deepEqual(ev.opponentGains, [{ name:'B', gained:60 }]);
  });

  test('with 2+ opponents still open on the number, EVERY open opponent gets the FULL amount (not a split)', () => {
    const shooter = player('A', { ...freshMarks(), 20: 3 }, 0); // already closed 20
    const oppB = player('B', freshMarks(), 0); // 20 open
    const oppC = player('C', freshMarks(), 0); // 20 open
    const ev = evaluateVisitCricket(shooter, [d(20,3)], cutthroatGame([shooter, oppB, oppC])); // 3->6, 3 beyond * 20 = 60
    assert.equal(ev.pointsThisVisit, 60);
    assert.deepEqual(ev.opponentGains, [{ name:'B', gained:60 }, { name:'C', gained:60 }], 'each open opponent gets the full 60, not 30 each');
  });

  test('an opponent who has already closed the number receives nothing, even while another opponent is still open', () => {
    const shooter = player('A', { ...freshMarks(), 20: 3 }, 0);
    const closedOpp = player('B', { ...freshMarks(), 20: 3 }, 0); // B already closed 20
    const openOpp = player('C', freshMarks(), 0); // C still open
    const ev = evaluateVisitCricket(shooter, [d(20,3)], cutthroatGame([shooter, closedOpp, openOpp]));
    assert.deepEqual(ev.opponentGains, [{ name:'B', gained:0 }, { name:'C', gained:60 }]);
  });

  test('once every opponent has closed the number, further marks score nothing onto anyone (same gating rule as standard)', () => {
    const shooter = player('A', { ...freshMarks(), 20: 3 }, 0);
    const opp = player('B', { ...freshMarks(), 20: 3 }, 0); // opponent already closed 20 too
    const ev = evaluateVisitCricket(shooter, [d(20,3), d(20,3)], cutthroatGame([shooter, opp]));
    assert.equal(ev.pointsThisVisit, 0);
    assert.deepEqual(ev.opponentGains, [{ name:'B', gained:0 }]);
  });

  test('win requires every number closed AND strictly FEWER points than every opponent (lowest wins, inverted from standard)', () => {
    const closedMarks = Object.fromEntries(numbers.map(n => [n, 3]));
    const shooter = player('A', closedMarks, 5);
    const opp = player('B', freshMarks(), 10); // opponent has more (worse) points
    const ev = evaluateVisitCricket(shooter, [d(0,1)], cutthroatGame([shooter, opp]));
    assert.equal(ev.win, true);
  });

  test('closed everything but has MORE points than an opponent: not a win', () => {
    const closedMarks = Object.fromEntries(numbers.map(n => [n, 3]));
    const shooter = player('A', closedMarks, 15);
    const opp = player('B', freshMarks(), 10);
    assert.equal(evaluateVisitCricket(shooter, [d(0,1)], cutthroatGame([shooter, opp])).win, false);
  });

  test('exact tie on points at the moment of closing is not a win (same known edge case as standard, direction-independent)', () => {
    const closedMarks = Object.fromEntries(numbers.map(n => [n, 3]));
    const shooter = player('A', closedMarks, 10);
    const opp = player('B', freshMarks(), 10);
    assert.equal(evaluateVisitCricket(shooter, [d(0,1)], cutthroatGame([shooter, opp])).win, false);
  });

  test('a winning visit\'s OWN points-onto-opponents count toward the win check (opponent totals are compared as of AFTER this visit)', () => {
    // Shooter closes their last number (Bull) while opponent still has it open —
    // this same visit both closes the shooter out AND pushes points onto the
    // opponent. The win check must use the opponent's POST-visit total (100+50),
    // not their pre-visit total (100), since the shooter's own hit is what
    // pushed the opponent further behind in the same visit.
    const almostClosed = { ...Object.fromEntries(numbers.map(n => [n, 3])), 25: 0 }; // Bull still open
    const shooter = player('A', almostClosed, 90);
    const opp = player('B', freshMarks(), 100); // opponent already worse than shooter even before this visit
    const ev = evaluateVisitCricket(shooter, [d(25,2), d(25,1)], cutthroatGame([shooter, opp])); // closes bull (0->3), no beyond marks
    assert.equal(ev.win, true, 'shooter (90) beats opponent (100) even with no bonus marks this visit');
  });

  test('3+ players: win requires strictly fewer points than EVERY opponent, not just one', () => {
    const closedMarks = Object.fromEntries(numbers.map(n => [n, 3]));
    const shooter = player('A', closedMarks, 5);
    const opponentB = player('B', freshMarks(), 10); // shooter beats this one
    const opponentC = player('C', freshMarks(), 3);  // shooter is behind (worse than) this one
    const g = cutthroatGame([shooter, opponentB, opponentC]);
    assert.equal(evaluateVisitCricket(shooter, [d(0,1)], g).win, false, 'still worse than opponentC');

    opponentC.points = 8; // now shooter leads (has fewer points than) both
    assert.equal(evaluateVisitCricket(shooter, [d(0,1)], g).win, true);
  });
});

describe('cricketStoneColdAchieved (docs/cutthroat-cricket-roadmap.md 🔪 Stone Cold)', () => {
  test('requires 3+ players', () => {
    assert.equal(cricketStoneColdAchieved(0, 2), false, '2-player cutthroat never qualifies, even at 0 points received');
    assert.equal(cricketStoneColdAchieved(0, 3), true);
    assert.equal(cricketStoneColdAchieved(0, 4), true);
  });

  test('requires exactly zero points ever received', () => {
    assert.equal(cricketStoneColdAchieved(1, 3), false);
    assert.equal(cricketStoneColdAchieved(60, 4), false);
  });

  test('null/undefined gamePointsReceived treated as zero', () => {
    assert.equal(cricketStoneColdAchieved(null, 3), true);
    assert.equal(cricketStoneColdAchieved(undefined, 3), true);
  });
});

// docs/bug-roadmap.md BUG-23: CRICKET_ALL_NUMBERS is the pool frontend/index.html's
// "hit a different number" picker (renderPadCricket()) subtracts game.config.numbers
// from, to find which numbers aren't in play this match — the actual DOM/canvas
// picker itself isn't node:test-able (same class of gap as BUG-8/BUG-18/BUG-22, a
// live Playwright check covers it), but this constant and the subtraction it enables
// are a genuine, pure, regression-worthy calculation.
describe('CRICKET_ALL_NUMBERS (the "hit a different number" picker\'s full pool, docs/bug-roadmap.md BUG-23)', () => {
  test('is exactly 1-20 plus bull (25) — 21 numbers, no duplicates', () => {
    assert.equal(CRICKET_ALL_NUMBERS.length, 21);
    assert.equal(new Set(CRICKET_ALL_NUMBERS).size, 21, 'no duplicate numbers');
    for (let n = 1; n <= 20; n++) assert.ok(CRICKET_ALL_NUMBERS.includes(n), `missing ${n}`);
    assert.ok(CRICKET_ALL_NUMBERS.includes(25), 'missing bull (25)');
  });

  test('subtracting classic cricket\'s 7 targets leaves exactly 1-14 as "off-target"', () => {
    const offTarget = CRICKET_ALL_NUMBERS.filter(n => !CRICKET_STANDARD_NUMBERS.includes(n));
    assert.deepEqual(offTarget, [1,2,3,4,5,6,7,8,9,10,11,12,13,14]);
  });

  test('subtracting any valid custom 7-number selection always leaves exactly 14 off-target numbers', () => {
    const customNumbers = [1, 5, 9, 13, 17, 20, 25]; // an arbitrary valid 7-of-21 custom pick
    const offTarget = CRICKET_ALL_NUMBERS.filter(n => !customNumbers.includes(n));
    assert.equal(offTarget.length, 14);
    assert.ok(!offTarget.some(n => customNumbers.includes(n)), 'no overlap between targets and off-target numbers');
  });
});

describe('evaluateVisitBaseball (inning target scoring + round/match completion, docs/game-modes-roadmap.md "Baseball")', () => {
  const player = (totalRuns) => ({ totalRuns, inningRuns: {} });
  // `current` is the index of the player whose visit is being evaluated —
  // evaluateVisit*() always reads it before it's advanced to the next player,
  // the same timing every other game type's evaluateVisit() relies on.
  const game = (players, current, inning) => ({ baseballInning: inning, current, players });

  test('a single on the inning target scores 1 run', () => {
    const p = player(0);
    const ev = evaluateVisitBaseball(p, [d(3,1)], game([p], 0, 3));
    assert.equal(ev.runsThisVisit, 1);
    assert.equal(ev.scored, 1);
    assert.equal(ev.totalRuns, 1);
    assert.equal(ev.target, 3);
  });

  test('a double on the inning target scores 2 runs, a treble scores 3', () => {
    const p = player(0);
    assert.equal(evaluateVisitBaseball(p, [d(5,2)], game([p], 0, 5)).runsThisVisit, 2);
    assert.equal(evaluateVisitBaseball(p, [d(5,3)], game([p], 0, 5)).runsThisVisit, 3);
  });

  test('a dart on any number other than this inning\'s target scores 0, even a treble', () => {
    const p = player(0);
    const ev = evaluateVisitBaseball(p, [d(7,3)], game([p], 0, 4)); // inning 4, hit 7 instead
    assert.equal(ev.runsThisVisit, 0);
  });

  test('a miss (sector 0) scores 0', () => {
    const p = player(0);
    assert.equal(evaluateVisitBaseball(p, [d(0,1)], game([p], 0, 6)).runsThisVisit, 0);
  });

  test('a full 3-dart visit sums only the on-target darts', () => {
    const p = player(0);
    const ev = evaluateVisitBaseball(p, [d(2,1), d(2,3), d(0,1)], game([p], 0, 2)); // 1 + 3 + 0 (miss)
    assert.equal(ev.runsThisVisit, 4);
    assert.equal(ev.totalRuns, 4);
  });

  test('totalRuns accumulates on top of runs already scored in earlier innings', () => {
    const p = player(11);
    const ev = evaluateVisitBaseball(p, [d(9,2)], game([p], 0, 9));
    assert.equal(ev.totalRuns, 13);
  });

  test('inningRuns records this inning\'s runs alongside whatever earlier innings already held', () => {
    const p = { totalRuns: 5, inningRuns: { 1: 2, 2: 3 } };
    const ev = evaluateVisitBaseball(p, [d(3,1)], game([p], 0, 3));
    assert.deepEqual(ev.inningRuns, { 1: 2, 2: 3, 3: 1 });
  });

  test('roundComplete is only true for the LAST player in the rotation this visit', () => {
    const p1 = player(0), p2 = player(0);
    assert.equal(evaluateVisitBaseball(p1, [d(1,1)], game([p1, p2], 0, 1)).roundComplete, false, 'player 0 of 2 — not last');
    assert.equal(evaluateVisitBaseball(p2, [d(1,1)], game([p1, p2], 1, 1)).roundComplete, true, 'player 1 of 2 — last');
  });

  test('a solo (practice) game is always roundComplete — every visit is the last in a 1-player rotation', () => {
    const p = player(0);
    assert.equal(evaluateVisitBaseball(p, [d(1,1)], game([p], 0, 1)).roundComplete, true);
  });

  test('matchComplete never fires before inning 9, even on the last player\'s visit', () => {
    const p1 = player(20), p2 = player(5);
    const ev = evaluateVisitBaseball(p2, [d(0,1)], game([p1, p2], 1, 8));
    assert.equal(ev.matchComplete, false);
  });

  test('matchComplete never fires mid-round (round not yet complete), even at inning 9', () => {
    const p1 = player(20), p2 = player(5);
    const ev = evaluateVisitBaseball(p1, [d(0,1)], game([p1, p2], 0, 9)); // player 0 of 2 — not last
    assert.equal(ev.matchComplete, false);
  });

  test('inning 9, round complete, a unique leader: matchComplete fires with the correct winnerIndex', () => {
    const p1 = player(20), p2 = player(5);
    const ev = evaluateVisitBaseball(p2, [d(0,1)], game([p1, p2], 1, 9)); // p2's visit scores 0, still trails
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 0, 'p1 (20) beats p2 (5+0)');
  });

  test('inning 9, round complete, but the visit itself closes the gap into a unique lead', () => {
    const p1 = player(20), p2 = player(15);
    const ev = evaluateVisitBaseball(p2, [d(9,1)], game([p1, p2], 1, 9)); // p2 scores 1 -> 16, still behind
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 0);
  });

  test('inning 9, round complete, exact tie among the leaders: matchComplete is false — extra innings', () => {
    const p1 = player(20), p2 = player(17);
    const ev = evaluateVisitBaseball(p2, [d(9,3)], game([p1, p2], 1, 9)); // p2 scores a treble (3) -> 20, exact tie with p1
    assert.equal(ev.totalRuns, 20);
    assert.equal(ev.matchComplete, false, 'an exact tie continues into extra innings, no winner yet');
    assert.equal(ev.winnerIndex, null);
  });

  test('inning 9, round complete, exact tie among 2 leaders (3-player game): matchComplete is false', () => {
    const p1 = player(10), p2 = player(10), p3 = player(3);
    const ev = evaluateVisitBaseball(p3, [d(0,1)], game([p1, p2, p3], 2, 9)); // p3's visit changes nothing; p1/p2 tied at 10
    assert.equal(ev.matchComplete, false, 'p1 and p2 are tied for the lead');
    assert.equal(ev.winnerIndex, null);
  });

  test('extra innings (past 9) keep targeting number 9, not cycling back to 1', () => {
    assert.equal(baseballInningTarget(9), 9);
    assert.equal(baseballInningTarget(10), 9);
    assert.equal(baseballInningTarget(15), 9);
    assert.equal(baseballInningTarget(1), 1);
    assert.equal(baseballInningTarget(8), 8);
  });

  test('an extra inning (10+) still checks for match completion the same way as inning 9', () => {
    const p1 = player(20), p2 = player(20); // tied entering inning 10
    const ev = evaluateVisitBaseball(p2, [d(9,1)], game([p1, p2], 1, 10)); // p2 breaks the tie: 20+1=21
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 1);
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

describe('pickCheckoutTarget (Checkout Trainer target selection, docs/archive/checkout-trainer-roadmap.md)', () => {
  test('double-out: never returns a known bogey number, always finishable', () => {
    // Sweep the rng across the full [0,1) range so every candidate in [2,170]
    // gets picked at least once, then assert none of the known double-out bogey
    // numbers (169, 168, 166, 165, 163, 162, 159, 1) ever survive the re-roll.
    const bogeys = new Set([169, 168, 166, 165, 163, 162, 159, 1]);
    for (let i = 0; i < 500; i++) {
      const roll = i / 500;
      const target = pickCheckoutTarget(true, () => roll);
      assert.ok(!bogeys.has(target), `picked bogey number ${target} under double-out`);
      assert.notEqual(checkoutHint(target, true, 3), '', `picked unfinishable target ${target} under double-out`);
    }
  });

  test('double-out: never returns below 2 (1 is unfinishable in double-out)', () => {
    const target = pickCheckoutTarget(true, () => 0); // lowest possible roll
    assert.ok(target >= 2);
  });

  test('single-out: 1 is a legal target (trivially finishable)', () => {
    const target = pickCheckoutTarget(false, () => 0); // lowest possible roll
    assert.equal(target, 1);
  });

  test('every picked target is within [1,170]', () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      const doubleTarget = pickCheckoutTarget(true, () => roll);
      const singleTarget = pickCheckoutTarget(false, () => roll);
      assert.ok(doubleTarget >= 2 && doubleTarget <= 170);
      assert.ok(singleTarget >= 1 && singleTarget <= 170);
    }
  });
});

describe('pickCheckoutTarget difficulty tiers (docs/archive/checkout-trainer-roadmap.md "Target selection")', () => {
  const tiers = ['under40', 'under100', 'over100', 'full'];

  test('every tier stays within its own [low,high] bound, under both out-modes', () => {
    for (const tierName of tiers) {
      const { low: tierLow, high: tierHigh } = CHECKOUT_TRAINER_DIFFICULTY_TIERS[tierName];
      for (const roll of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
        for (const doubleOut of [true, false]) {
          const target = pickCheckoutTarget(doubleOut, () => roll, tierName);
          const low = Math.max(doubleOut ? 2 : 1, tierLow);
          assert.ok(target >= low && target <= tierHigh,
            `${tierName} (doubleOut=${doubleOut}, roll=${roll}) picked ${target}, expected [${low},${tierHigh}]`);
          assert.notEqual(checkoutHint(target, doubleOut, 3), '',
            `${tierName} picked unfinishable target ${target}`);
        }
      }
    }
  });

  test('under40: never returns 40 or above', () => {
    for (const roll of [0, 0.5, 0.999]) {
      const target = pickCheckoutTarget(true, () => roll, 'under40');
      assert.ok(target < 40);
    }
  });

  test('over100: never returns below 100', () => {
    for (const roll of [0, 0.5, 0.999]) {
      const target = pickCheckoutTarget(true, () => roll, 'over100');
      assert.ok(target >= 100);
    }
  });

  test('an unknown or omitted difficulty falls back to the full [1,170]/[2,170] range unchanged', () => {
    for (const roll of [0, 0.5, 0.999]) {
      assert.equal(pickCheckoutTarget(true, () => roll, 'bogus-tier'), pickCheckoutTarget(true, () => roll, 'full'));
      assert.equal(pickCheckoutTarget(false, () => roll), pickCheckoutTarget(false, () => roll, 'full'));
    }
  });
});

describe('pickCheckoutTarget pinnedTarget (docs/checkout-drill-link-roadmap.md "Drill this checkout")', () => {
  test('a finishable pin is always served, regardless of the rng roll', () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      assert.equal(pickCheckoutTarget(true, () => roll, 'full', 0, 121), 121);
      assert.equal(pickCheckoutTarget(false, () => roll, 'full', 0, 121), 121);
    }
  });

  test('a pin overrides difficulty tier bounds entirely — 121 is outside under40 but still served', () => {
    assert.equal(pickCheckoutTarget(true, () => 0.5, 'under40', 0, 121), 121);
  });

  test('a pin overrides an active trick roll — never redirected to a bogey number', () => {
    const rolls = [0.01, 0]; // would normally trigger the trick roll + pick bogey 159
    assert.equal(pickCheckoutTarget(true, () => rolls.shift() ?? 0.5, 'full', CHECKOUT_TRAINER_TRICK_CHANCE, 121), 121);
  });

  test('an unfinishable pin under the out-mode (a bogey number) is ignored, falling through to a normal roll', () => {
    // 169 is a classic double-out bogey — pinning it must never wedge the trainer
    // on an impossible target.
    const target = pickCheckoutTarget(true, () => 0, 'full', 0, 169);
    assert.notEqual(target, 169);
    assert.notEqual(checkoutHint(target, true, 3), '', 'falls through to a genuinely finishable target');
  });

  test('a pin of 1 under double-out (never finishable) is ignored, falling through to a normal roll', () => {
    const target = pickCheckoutTarget(true, () => 0, 'full', 0, 1);
    assert.notEqual(target, 1);
  });

  test('null/undefined pinnedTarget behaves exactly like the pre-drill-link signature', () => {
    for (const roll of [0, 0.5, 0.999]) {
      assert.equal(pickCheckoutTarget(true, () => roll, 'full', 0, null), pickCheckoutTarget(true, () => roll, 'full', 0));
      assert.equal(pickCheckoutTarget(true, () => roll, 'full'), pickCheckoutTarget(true, () => roll, 'full', 0, undefined));
    }
  });
});

describe('gradeCheckoutAttempt (Checkout Trainer grading, docs/archive/checkout-trainer-roadmap.md)', () => {
  test('optimal: legal finish in the objective minimum dart count', () => {
    const g = gradeCheckoutAttempt(40, true, [d(20, 2)]); // D20, 1 dart — the minimum for 40
    assert.equal(g.legal, true);
    assert.equal(g.optimal, true);
    assert.equal(g.usedDarts, 1);
    assert.equal(g.optimalDarts, 1);
  });

  test('legal but not optimal: reaches zero validly, but in more darts than necessary', () => {
    const g = gradeCheckoutAttempt(40, true, [d(20, 1), d(10, 1), d(5, 2)]); // 20+10+D5, 3 darts for a 1-dart finish
    assert.equal(g.legal, true);
    assert.equal(g.optimal, false);
    assert.equal(g.usedDarts, 3);
    assert.equal(g.optimalDarts, 1);
  });

  test('illegal: overshoots the target (busts)', () => {
    const g = gradeCheckoutAttempt(40, true, [d(20, 3)]); // 60 > 40
    assert.equal(g.legal, false);
    assert.equal(g.optimal, false);
  });

  test('illegal: reaches zero but last dart is not a double in double-out', () => {
    const g = gradeCheckoutAttempt(40, true, [d(20, 1), d(20, 1)]); // 20+20=40, no double
    assert.equal(g.legal, false);
    assert.equal(g.optimal, false);
  });

  test('illegal: an early submit that leaves a nonzero remainder', () => {
    const g = gradeCheckoutAttempt(100, true, [d(20, 1)]); // 20 of 100, nowhere near a finish
    assert.equal(g.legal, false);
    assert.equal(g.optimal, false);
  });

  test('a different (equally-optimal) route to the same minimum dart count still grades optimal', () => {
    // 32 finishes optimally on D16 (1 dart) via checkoutHint's own route, but any
    // other 1-dart double finish that lands on exactly 32 must grade optimal too —
    // grading is by dart COUNT, not exact route match (per the roadmap doc).
    const g = gradeCheckoutAttempt(32, true, [d(16, 2)]);
    assert.equal(g.legal, true);
    assert.equal(g.optimal, true);
  });

  test('hint is returned alongside the grade, for revealing the optimal route on anything but optimal', () => {
    const g = gradeCheckoutAttempt(170, true, [d(20, 3)]); // a bust attempt at 170
    assert.equal(g.hint, 'T20 T20 Bull');
  });

  test('a route submitted against a bogey number grades illegal with an empty hint (nothing to reveal)', () => {
    const g = gradeCheckoutAttempt(169, true, [d(20, 3), d(20, 3), d(20, 3)]);
    assert.equal(g.legal, false);
    assert.equal(g.optimal, false);
    assert.equal(g.hint, '', 'no route exists for a bogey number');
    assert.equal(g.optimalDarts, null);
  });
});

describe('trick questions (docs/archive/checkout-trainer-roadmap.md "Trick-question difficulty variant")', () => {
  test('listUnsolvableTargets under double-out is exactly the classic bogey set for the full tier', () => {
    // The known double-out bogey numbers (1 is excluded by the tier floor of 2).
    assert.deepEqual(listUnsolvableTargets(true, 'full'), [159, 162, 163, 165, 166, 168, 169]);
  });

  test('every listed unsolvable target really has no checkoutHint route, and everything else in the tier does', () => {
    for (const doubleOut of [true, false]) {
      const bogeys = new Set(listUnsolvableTargets(doubleOut, 'full'));
      const low = doubleOut ? 2 : 1;
      for (let c = low; c <= 170; c++) {
        assert.equal(bogeys.has(c), checkoutHint(c, doubleOut, 3) === '',
          `target ${c} (${doubleOut ? 'double' : 'single'}-out) must be listed iff it has no route`);
      }
    }
  });

  test('tiers below the bogey range come back empty — every low target is finishable', () => {
    assert.deepEqual(listUnsolvableTargets(true, 'under40'), []);
    assert.deepEqual(listUnsolvableTargets(true, 'under100'), []);
  });

  test('the trick roll serves a bogey number from the tier when it hits', () => {
    // First rng draw is the trick roll (below the chance), second picks the bogey.
    const rolls = [0.01, 0]; // trick roll hits, then pick index 0
    const target = pickCheckoutTarget(true, () => rolls.shift(), 'full', CHECKOUT_TRAINER_TRICK_CHANCE);
    assert.equal(target, 159, 'lowest bogey — index 0 of the double-out bogey set');
    assert.equal(checkoutHint(target, true, 3), '', 'served target really is unsolvable');
  });

  test('a trick roll that misses serves a normal finishable target', () => {
    const rolls = [0.9, 0.5]; // trick roll misses, then the normal pick
    const target = pickCheckoutTarget(true, () => rolls.shift() ?? 0.5, 'full', CHECKOUT_TRAINER_TRICK_CHANCE);
    assert.notEqual(checkoutHint(target, true, 3), '', 'must be finishable');
  });

  test('trick mode in a tier with no bogeys falls through to a normal finishable target', () => {
    const rolls = [0.01, 0.5]; // trick roll hits, but under40 has no bogeys
    const target = pickCheckoutTarget(true, () => rolls.shift() ?? 0.5, 'under40', CHECKOUT_TRAINER_TRICK_CHANCE);
    assert.ok(target >= 2 && target <= 39, 'still within the tier');
    assert.notEqual(checkoutHint(target, true, 3), '');
  });

  test('trickChance omitted or 0 never consumes a trick roll — existing behavior byte-for-byte', () => {
    for (const roll of [0, 0.01, 0.5, 0.999]) {
      assert.equal(pickCheckoutTarget(true, () => roll, 'full'), pickCheckoutTarget(true, () => roll, 'full', 0));
    }
  });

  test('gradeCheckoutDeclaration: calling a real bogey number is correct, legal, and optimal', () => {
    const g = gradeCheckoutDeclaration(169, true);
    assert.equal(g.declared, true);
    assert.equal(g.correct, true);
    assert.equal(g.legal, true, 'a correct declaration maps onto checkout=1');
    assert.equal(g.optimal, true, 'a correct declaration maps onto leg_won=1 (2 Blitz points)');
    assert.equal(g.usedDarts, 0);
    assert.equal(g.hint, '');
  });

  test('gradeCheckoutDeclaration: calling a finishable target unsolvable is wrong, with the route revealed', () => {
    const g = gradeCheckoutDeclaration(170, true);
    assert.equal(g.correct, false);
    assert.equal(g.legal, false, 'a wrong declaration maps onto bust=1 (0 Blitz points)');
    assert.equal(g.optimal, false);
    assert.equal(g.hint, 'T20 T20 Bull');
    assert.equal(g.optimalDarts, 3);
  });

  test('gradeCheckoutDeclaration respects the out-mode — the same number can be a bogey in one and not the other', () => {
    // 159 is a classic double-out bogey but IS finishable straight-out (e.g. T20 T20 T13).
    assert.equal(gradeCheckoutDeclaration(159, true).correct, true);
    assert.equal(gradeCheckoutDeclaration(159, false).correct, false);
  });
});

// Regression coverage for the Checkout Blitz timeout bug reported live: a player
// paused mid-round after the buzzer, waited roughly a minute, then finished
// entering and submitted a checkout — it was graded, recorded, and even earned
// the 📸 Photo Finish "beat the buzzer" badge, because the previous design let
// any round already in progress finish past the deadline with no bound at all
// on how late. blitzDeadlinePassed()/isPhotoFinishSubmission() are the two pure
// predicates index.html's throwDartCheckoutTrainer()/submitCheckoutAttempt()/
// tickCheckoutBlitzTimer() now all share for this decision.
describe('blitzDeadlinePassed (Checkout Blitz hard-stop, docs/archive/checkout-trainer-roadmap.md "Core loop delta")', () => {
  test('false while now is strictly before the deadline', () => {
    assert.equal(blitzDeadlinePassed(10000, 9999), false);
  });
  test('true the instant now reaches the deadline (inclusive boundary)', () => {
    assert.equal(blitzDeadlinePassed(10000, 10000), true);
  });
  test('true arbitrarily far past the deadline — a minute-late resume is still "passed", not "expired and forgotten"', () => {
    assert.equal(blitzDeadlinePassed(10000, 10000 + 60000), true);
  });
  test('a null deadline (Freeform mode, or a run whose clock has not started) never counts as passed', () => {
    assert.equal(blitzDeadlinePassed(null, Date.now()), false);
  });
});

describe('isPhotoFinishSubmission (📸 Photo Finish trigger, docs/archive/checkout-trainer-roadmap.md "Achievements")', () => {
  test('fires with genuinely under 1 second remaining', () => {
    assert.equal(isPhotoFinishSubmission(999), true);
    assert.equal(isPhotoFinishSubmission(1), true);
    assert.equal(isPhotoFinishSubmission(0), true, 'exactly the buzzer itself still counts as under 1 second left');
  });
  test('does not fire with 1 second or more still remaining', () => {
    assert.equal(isPhotoFinishSubmission(1000), false);
    assert.equal(isPhotoFinishSubmission(5000), false);
  });
  test('does NOT fire for a submission that arrived after the deadline (the exact bug reported live) — negative remaining time is not "under 1 second left"', () => {
    assert.equal(isPhotoFinishSubmission(-1), false);
    assert.equal(isPhotoFinishSubmission(-60000), false, 'a full minute late must not read as a buzzer-beater');
  });
  test('a null remaining value (Freeform mode, no deadline) never fires', () => {
    assert.equal(isPhotoFinishSubmission(null), false);
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

  test('a single/treble on an unrelated (non-target) number is "wrong number" and ends the session — only a target double keeps a round alive', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(20, 1), targets), { hit: false, ended: true, reason: 'wrong-number' });
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(11, 3), targets), { hit: false, ended: true, reason: 'wrong-number' });
  });

  test('a genuine total miss (sector 0) also ends the session', () => {
    assert.deepEqual(evaluateDartDoublesPractice(makeDartCore(0, 1), targets), { hit: false, ended: true, reason: 'miss' });
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

describe('evaluateDartAroundTheClock (guided drill mode, docs/game-modes-roadmap.md "Guided Around the Clock / Around the World")', () => {
  test('a single on a new number 1-20 is a new hit, not yet completed', () => {
    const hitSet = new Set();
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(5, 1), hitSet), { isNewHit: true, completed: false });
  });

  test('a single on a number already in hitSet is not a new hit', () => {
    const hitSet = new Set([5]);
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(5, 1), hitSet), { isNewHit: false, completed: false });
  });

  test('a treble or double on a target number is a real dart but never a hit ("so close", same precedent as Doubles Practice)', () => {
    const hitSet = new Set();
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(5, 2), hitSet), { isNewHit: false, completed: false });
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(5, 3), hitSet), { isNewHit: false, completed: false });
  });

  test('bull (sector 25) never counts as a hit, matching the existing passive around_the_clock badge (no "+bull")', () => {
    const hitSet = new Set();
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(25, 1), hitSet), { isNewHit: false, completed: false });
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(25, 2), hitSet), { isNewHit: false, completed: false });
  });

  test('a genuine miss (sector 0) is never a hit', () => {
    const hitSet = new Set();
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(0, 1), hitSet), { isNewHit: false, completed: false });
  });

  test('completed fires exactly when the 20th distinct single lands, not before', () => {
    const hitSet = new Set(Array.from({ length: 19 }, (_, i) => i + 1)); // 1..19 already hit
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(20, 1), hitSet), { isNewHit: true, completed: true });
  });

  test('completed does not fire on a repeat hit even if hitSet already has 19 entries', () => {
    const hitSet = new Set(Array.from({ length: 19 }, (_, i) => i + 1)); // 1..19 already hit
    assert.deepEqual(evaluateDartAroundTheClock(makeDartCore(5, 1), hitSet), { isNewHit: false, completed: false });
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

describe('isBedAndBreakfast (docs/archive/culture-badges-roadmap.md Part A)', () => {
  test('S20, S5, S1 in the canonical order', () => {
    assert.equal(isBedAndBreakfast([d(20,1), d(5,1), d(1,1)]), true);
  });

  test('any order still qualifies — the joke is the three numbers, not the sequence', () => {
    assert.equal(isBedAndBreakfast([d(1,1), d(20,1), d(5,1)]), true);
    assert.equal(isBedAndBreakfast([d(5,1), d(1,1), d(20,1)]), true);
  });

  test('scoring 26 a different way (not S20/S5/S1) does not qualify', () => {
    // 16+9+1 also totals 26, but it isn't the specific "hotel breakfast" splash —
    // the predicate matches on the exact dart set, not just the total.
    assert.equal(isBedAndBreakfast([d(16,1), d(9,1), d(1,1)]), false);
  });

  test('right numbers, wrong multiplier on any dart fails', () => {
    assert.equal(isBedAndBreakfast([d(20,2), d(5,1), d(1,1)]), false); // double 20, not single
    assert.equal(isBedAndBreakfast([d(20,1), d(5,3), d(1,1)]), false); // treble 5, not single
  });

  test('fewer or more than exactly 3 darts never qualifies', () => {
    assert.equal(isBedAndBreakfast([d(20,1), d(5,1)]), false);
    assert.equal(isBedAndBreakfast([d(20,1), d(5,1), d(1,1), d(1,1)]), false);
  });

  test('a missing/empty darts array never qualifies', () => {
    assert.equal(isBedAndBreakfast(null), false);
    assert.equal(isBedAndBreakfast([]), false);
  });
});

describe('isMadhouseFinish (docs/archive/culture-badges-roadmap.md Part A)', () => {
  test('won the leg and the last dart is double 1', () => {
    assert.equal(isMadhouseFinish(true, [d(20,3), d(20,1), d(1,2)]), true);
  });

  test('a single-dart double-1 checkout still qualifies — only the last dart matters', () => {
    assert.equal(isMadhouseFinish(true, [d(1,2)]), true);
  });

  test('did not win the leg — never qualifies even with a trailing double 1', () => {
    assert.equal(isMadhouseFinish(false, [d(20,3), d(20,1), d(1,2)]), false);
  });

  test('won, but the last dart is a different double', () => {
    assert.equal(isMadhouseFinish(true, [d(20,3), d(20,1), d(2,2)]), false);
  });

  test('won, but the last dart on sector 1 is not a double', () => {
    assert.equal(isMadhouseFinish(true, [d(1,1)]), false); // single 1
    assert.equal(isMadhouseFinish(true, [d(1,3)]), false); // treble 1
  });

  test('no darts recorded never qualifies', () => {
    assert.equal(isMadhouseFinish(true, []), false);
    assert.equal(isMadhouseFinish(true, null), false);
  });
});

describe('isShanghaiVisit (docs/archive/culture-badges-roadmap.md Part A)', () => {
  test('single, double, and treble of the same number, in order', () => {
    assert.equal(isShanghaiVisit([d(20,1), d(20,2), d(20,3)]), true);
  });

  test('any order still qualifies', () => {
    assert.equal(isShanghaiVisit([d(7,3), d(7,1), d(7,2)]), true);
  });

  test('every number 1-20 can Shanghai, not just 20', () => {
    assert.equal(isShanghaiVisit([d(1,1), d(1,2), d(1,3)]), true);
  });

  test('two singles and a treble (not a genuine Shanghai) fails', () => {
    assert.equal(isShanghaiVisit([d(20,1), d(20,1), d(20,3)]), false);
  });

  test('a double and two trebles (missing the single) fails', () => {
    assert.equal(isShanghaiVisit([d(20,2), d(20,3), d(20,3)]), false);
  });

  test('S/D/T of DIFFERENT numbers does not qualify — must be the same number', () => {
    assert.equal(isShanghaiVisit([d(20,1), d(19,2), d(18,3)]), false);
  });

  test('the bull can never Shanghai — no treble-bull ring exists', () => {
    assert.equal(isShanghaiVisit([d(25,1), d(25,2), d(25,2)]), false);
  });

  test('a miss anywhere in the visit fails', () => {
    assert.equal(isShanghaiVisit([d(20,1), d(20,2), d(0,0)]), false);
  });

  test('fewer or more than exactly 3 darts never qualifies', () => {
    assert.equal(isShanghaiVisit([d(20,1), d(20,2)]), false);
    assert.equal(isShanghaiVisit([d(20,1), d(20,2), d(20,3), d(20,1)]), false);
  });
});

describe('isBaseballCycle (docs/archive/culture-badges-roadmap.md Part B)', () => {
  test('single, double, and treble of the inning target, in order', () => {
    assert.equal(isBaseballCycle([d(4,1), d(4,2), d(4,3)], 4), true);
  });

  test('any order still qualifies', () => {
    assert.equal(isBaseballCycle([d(7,3), d(7,1), d(7,2)], 7), true);
  });

  test('two singles and a treble (not a genuine Cycle) fails', () => {
    assert.equal(isBaseballCycle([d(4,1), d(4,1), d(4,3)], 4), false);
  });

  test('S/D/T of a DIFFERENT number than the inning target does not qualify', () => {
    assert.equal(isBaseballCycle([d(3,1), d(3,2), d(3,3)], 4), false);
  });

  test('a miss anywhere in the visit fails', () => {
    assert.equal(isBaseballCycle([d(4,1), d(4,2), d(0,0)], 4), false);
  });

  test('fewer or more than exactly 3 darts never qualifies', () => {
    assert.equal(isBaseballCycle([d(4,1), d(4,2)], 4), false);
    assert.equal(isBaseballCycle([d(4,1), d(4,2), d(4,3), d(4,1)], 4), false);
  });
});

describe('evaluateVisitBobs27 (docs/archive/practice-ladders-roadmap.md Part A)', () => {
  const player = (running) => ({ running });
  const game = (round) => ({ bobs27Round: round });

  test('a single dart on the round\'s double adds exactly 2x the round number', () => {
    const ev = evaluateVisitBobs27(player(27), [d(1,2)], game(1));
    assert.equal(ev.hits, 1);
    assert.equal(ev.gain, 2);
    assert.equal(ev.running, 29);
    assert.equal(ev.scored, 2);
    assert.equal(ev.dead, false);
  });

  test('multiple darts on the double each add their own 2x — D20 hit twice adds 80', () => {
    const ev = evaluateVisitBobs27(player(100), [d(20,2), d(20,2)], game(20));
    assert.equal(ev.hits, 2);
    assert.equal(ev.gain, 80);
    assert.equal(ev.running, 180);
  });

  test('all three darts hitting the double add the maximum possible gain (Full House shape)', () => {
    const ev = evaluateVisitBobs27(player(27), [d(5,2), d(5,2), d(5,2)], game(5));
    assert.equal(ev.hits, 3);
    assert.equal(ev.gain, 30, '3 darts * 2*5');
    assert.equal(ev.running, 57);
  });

  test('all three darts missing the double SUBTRACTS the double\'s value instead of storing negative scored', () => {
    const ev = evaluateVisitBobs27(player(27), [d(3,1), d(3,3), d(0,1)], game(3));
    assert.equal(ev.hits, 0);
    assert.equal(ev.gain, 0, 'scored/gain is 0, never negative -- the penalty is derived, not stored');
    assert.equal(ev.scored, 0);
    assert.equal(ev.running, 21, '27 - 2*3');
  });

  test('a single or treble of the round\'s OWN number does not count as a hit (only a double does)', () => {
    const ev = evaluateVisitBobs27(player(27), [d(7,1), d(7,3), d(7,1)], game(7));
    assert.equal(ev.hits, 0);
    assert.equal(ev.running, 13, '27 - 2*7');
  });

  test('a double of a DIFFERENT number than the round\'s own does not count as a hit', () => {
    const ev = evaluateVisitBobs27(player(27), [d(8,2), d(8,2), d(8,2)], game(9));
    assert.equal(ev.hits, 0, 'D8 hits are irrelevant when the live round is D9');
    assert.equal(ev.running, 9, '27 - 2*9');
  });

  test('dead flips true the moment running reaches exactly 0', () => {
    const ev = evaluateVisitBobs27(player(4), [d(0,1)], game(2)); // miss D2: 4 - 2*2 = 0
    assert.equal(ev.running, 0);
    assert.equal(ev.dead, true, 'exactly 0 counts as dead ("drop to 0 or below")');
  });

  test('dead stays false while the running score is still positive after a miss', () => {
    const ev = evaluateVisitBobs27(player(27), [d(0,1)], game(3)); // miss D3: 27 - 6 = 21
    assert.equal(ev.running, 21);
    assert.equal(ev.dead, false);
  });

  test('matchComplete is true once dead, even before round 20', () => {
    const ev = evaluateVisitBobs27(player(4), [d(0,1)], game(2));
    assert.equal(ev.matchComplete, true);
  });

  test('matchComplete is true at round 20 even without dying (a full survival)', () => {
    const ev = evaluateVisitBobs27(player(1200), [d(20,2)], game(20));
    assert.equal(ev.dead, false);
    assert.equal(ev.matchComplete, true);
  });

  test('matchComplete is false for an ordinary surviving round before D20', () => {
    const ev = evaluateVisitBobs27(player(27), [d(5,2)], game(5));
    assert.equal(ev.matchComplete, false);
  });

  test('a perfect run through every round reaches exactly 1287 (27 + 3*(2+4+...+40))', () => {
    let running = 27;
    for (let round = 1; round <= 20; round++) {
      const ev = evaluateVisitBobs27({ running }, [d(round,2), d(round,2), d(round,2)], { bobs27Round: round });
      running = ev.running;
    }
    assert.equal(running, 1287);
  });
});

describe('isBobs27FullHouse / isBobs27FullAnderson (docs/archive/practice-ladders-roadmap.md Part A)', () => {
  test('Full House requires exactly 3 hits this visit', () => {
    assert.equal(isBobs27FullHouse(3), true);
    assert.equal(isBobs27FullHouse(2), false);
    assert.equal(isBobs27FullHouse(0), false);
  });

  test('The Full Anderson requires the exact perfect-run total, 1287', () => {
    assert.equal(isBobs27FullAnderson(1287), true);
    assert.equal(isBobs27FullAnderson(1286), false);
    assert.equal(isBobs27FullAnderson(0), false);
  });
});

describe('rebuildBobs27State (docs/archive/saved-games-roadmap.md, pure replay rebuild)', () => {
  test('replays a mixed hit/miss run and lands on the correct running score and next round', () => {
    const turns = [
      v(0,1,1,[[1,2]]),               // D1 hit: 27+2=29
      v(0,1,1,[[2,1],[2,3],[0,1]]),   // D2 miss (single+treble+miss, no double): 29-4=25
      v(0,1,1,[[3,2],[3,2]]),         // D3 two hits: 25+12=37
    ];
    const r = rebuildBobs27State({ turns });
    assert.equal(r.running, 37);
    assert.equal(r.round, 4, 'next round to play is D4');
  });

  test('an empty turn history starts fresh at 27, round 1', () => {
    const r = rebuildBobs27State({ turns: [] });
    assert.equal(r.running, 27);
    assert.equal(r.round, 1);
  });
});

describe('rebuildCheckoutLadderState (docs/archive/practice-ladders-roadmap.md Part B, pure replay rebuild)', () => {
  test('an empty turn history starts fresh at target 121, attempt 1', () => {
    const r = rebuildCheckoutLadderState({ turns: [] });
    assert.equal(r.target, 121);
    assert.equal(r.legNo, 1);
    assert.equal(r.remaining, 121);
    assert.equal(r.visitsThisLeg, 0);
  });

  test('a checkout in a single visit climbs the target one rung and starts a fresh attempt', () => {
    // 121 = T19(57) + T20(60) + D2(4), a legal double-out finish.
    const turns = [ v(0,1,1,[[19,3],[20,3],[2,2]]) ];
    const r = rebuildCheckoutLadderState({ turns });
    assert.equal(r.target, 122, 'climbed one rung after clearing 121');
    assert.equal(r.legNo, 2, 'moved on to attempt 2');
    assert.equal(r.remaining, 122, 'attempt 2 starts fresh from the new target');
    assert.equal(r.visitsThisLeg, 0);
  });

  test('3 visits used without a checkout fails the attempt and drops the target one rung', () => {
    const turns = [
      v(0,1,1,[[20,3],[20,3],[1,1]]),  // 60+60+1=121 leaves exactly 0, but the last dart isn't a double -> bust, stays on 121
      v(0,1,1,[[5,1]]),                // second visit: single 5, doesn't finish
      v(0,1,1,[[7,1]]),                // third (decisive) visit: single 7, still doesn't finish -> attempt fails
    ];
    const r = rebuildCheckoutLadderState({ turns });
    assert.equal(r.target, 120, 'dropped one rung after failing target 121');
    assert.equal(r.legNo, 2);
    assert.equal(r.remaining, 120);
    assert.equal(r.visitsThisLeg, 0);
  });

  test('the target never drops below the 61 floor', () => {
    // Simulate 65 consecutive failed attempts (leg_no 1..65), each burning all
    // 3 visits on a single 1 (never finishes, never busts) — enough to walk
    // the target from 121 all the way down past 61 if the floor didn't hold.
    const turns = [];
    for(let leg = 1; leg <= 65; leg++){
      turns.push(v(0,1,leg,[[1,1]]));
      turns.push(v(0,1,leg,[[1,1]]));
      turns.push(v(0,1,leg,[[1,1]]));
    }
    const r = rebuildCheckoutLadderState({ turns });
    assert.equal(r.target, 61, 'floored at 61, never lower');
  });

  test('a still-live attempt (fewer than 3 visits, no checkout yet) reports the in-progress remaining score and visit count', () => {
    const turns = [
      v(0,1,1,[[20,3]]),   // 60 scored, 61 remaining — visit 1 of 3, not resolved
    ];
    const r = rebuildCheckoutLadderState({ turns });
    assert.equal(r.target, 121, 'attempt still live on the original target');
    assert.equal(r.legNo, 1, 'still attempt 1 — not yet resolved');
    assert.equal(r.remaining, 61);
    assert.equal(r.visitsThisLeg, 1);
  });

  test('a bust burns the visit without ending the attempt early', () => {
    const turns = [
      v(0,1,1,[[20,3],[20,3],[20,3]]), // 180 scored against a 121 target -> bust, stays on 121
    ];
    const r = rebuildCheckoutLadderState({ turns });
    assert.equal(r.remaining, 121, 'a bust leaves the player exactly where they started this visit');
    assert.equal(r.visitsThisLeg, 1, 'the bust visit still counts toward the 3-visit cap');
    assert.equal(r.legNo, 1, 'attempt not yet resolved — 2 visits remain');
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

describe('rebuildX01State (docs/archive/saved-games-roadmap.md, pure replay rebuild)', () => {
  test('mid-game across a leg boundary: scores, legsWon/setsWon, rotation, and current thrower all match hand-derived state', () => {
    const turns = [
      v(0,1,1,[[20,3],[20,3],[20,3]]),   // Ben: 180 -> 321
      v(1,1,1,[[20,3],[20,3],[20,3]]),   // Alaina: 180 -> 321
      v(0,1,1,[[20,3],[20,3],[20,3]]),   // Ben: 180 -> 141
      v(1,1,1,[[20,3],[20,3],[20,3]]),   // Alaina: 180 -> 141
      v(0,1,1,[[20,3],[19,3],[12,2]]),   // Ben: 60+57+24=141 -> 0, double-out WIN (leg1=set1, legsPerSet 1)
      v(1,2,1,[[20,1]]),                 // Alaina (new set, starter rotates to her): 501-20=481
      v(0,2,1,[[5,1]]),                  // Ben: 501-5=496 (mid-leg -- this is the "saved" point)
    ];
    const r = rebuildX01State({ names:['Ben','Alaina'], outModes:['double','double'], startScore:501, practice:false, legsPerSet:1, turns });
    assert.equal(r.setNo, 2);
    assert.equal(r.legNo, 1);
    assert.equal(r.starter, 1, 'starter rotates by exactly one leg transition, like startNextLeg()');
    assert.equal(r.current, 1, "Alaina's turn next -- Ben's last visit didn't win");
    const [ben, alaina] = r.players;
    assert.equal(ben.score, 496);
    assert.equal(ben.legsWon, 0, 'reset when the new set began');
    assert.equal(ben.setsWon, 1);
    assert.equal(ben.legDarts, 1, 'only this new leg\'s own turn counts');
    assert.equal(ben.gameDarts, 10, '3+3+3+1 across the whole match');
    assert.equal(ben.gamePoints, 506, '180+180+141+5');
    assert.equal(ben.gameVisits, 4);
    assert.equal(alaina.score, 481);
    assert.equal(alaina.legsWon, 0);
    assert.equal(alaina.setsWon, 0);
    assert.equal(alaina.legDarts, 1);
    assert.equal(alaina.gameDarts, 7, '3+3+1');
    assert.equal(alaina.gamePoints, 380, '180+180+20');
  });

  test("a trailing leg win with no next-leg turn recorded yet lands on the next leg's first throw, not the leg-complete screen", () => {
    // Saved on the "leg won -- Next leg?" screen, before that button was ever
    // tapped -- the same turn history as the previous test's first 5 turns,
    // stopping right at the win instead of continuing into leg 2.
    const turns = [
      v(0,1,1,[[20,3],[20,3],[20,3]]),   // Ben: 180 -> 321
      v(1,1,1,[[20,3],[20,3],[20,3]]),   // Alaina: 180 -> 321
      v(0,1,1,[[20,3],[20,3],[20,3]]),   // Ben: 180 -> 141
      v(1,1,1,[[20,3],[20,3],[20,3]]),   // Alaina: 180 -> 141
      v(0,1,1,[[20,3],[19,3],[12,2]]),   // Ben: 141 -> 0, double-out WIN (leg1=set1, legsPerSet 1)
    ];
    const r = rebuildX01State({ names:['Ben','Alaina'], outModes:['double','double'], startScore:501, practice:false, legsPerSet:1, turns });
    assert.equal(r.setNo, 2, 'auto-advanced one set past the win, same as tapping Next Set would have');
    assert.equal(r.legNo, 1);
    assert.equal(r.starter, 1);
    assert.equal(r.current, 1);
    const [ben, alaina] = r.players;
    assert.equal(ben.score, 501, 'fresh leg -- back to the starting score');
    assert.equal(ben.legsWon, 0);
    assert.equal(ben.setsWon, 1);
    assert.equal(ben.legDarts, 0, 'no turns recorded in the not-yet-started leg 2');
    assert.equal(ben.setDarts, 0, 'a new SET too -- setDarts resets, not just legDarts');
    assert.equal(ben.gameDarts, 9, '3+3+3 from the leg actually played');
    assert.equal(ben.gamePoints, 501, '180+180+141');
    assert.equal(alaina.score, 501);
    assert.equal(alaina.legsWon, 0);
    assert.equal(alaina.setsWon, 0);
    assert.equal(alaina.gameDarts, 6);
    assert.equal(alaina.gamePoints, 360, '180+180');
  });

  test('a practice game never advances legsWon into a set win (matches onLegWon()\'s !practice gate)', () => {
    const turns = [
      v(0,1,1,[[20,3],[20,3],[20,3]]),   // Ben: 180 -> 321
      v(1,1,1,[[1,1]]),                  // Alaina: a filler visit, 501-1=500
      v(0,1,1,[[20,3],[20,3],[20,3]]),   // Ben: 180 -> 141
      v(1,1,1,[[1,1]]),
      v(0,1,1,[[20,3],[19,3],[12,2]]),   // Ben wins the leg
    ];
    const r = rebuildX01State({ names:['Ben','Alaina'], outModes:['double','double'], startScore:501, practice:true, legsPerSet:1, turns });
    // practice=true -> setsGateOpen=false -> legsWon increments but never
    // triggers a set win, so there's no "new set" transition to auto-advance
    // into -- the trailing-win branch still fires (pendingNewLeg), just
    // without a set boundary.
    assert.equal(r.setNo, 1, 'practice never completes a set');
    assert.equal(r.legNo, 2, 'still auto-advances to the next leg, just not a new set');
    assert.equal(r.players[0].legsWon, 1, 'never reset -- no set win occurred to zero it');
    assert.equal(r.players[0].setsWon, 0);
  });
});

describe('rebuildCricketState (docs/archive/saved-games-roadmap.md, pure replay rebuild)', () => {
  test('mid-game across a leg boundary: marks/points, legsWon/setsWon, rotation all match hand-derived state', () => {
    const turns = [
      v(0,1,1,[[20,3],[19,3],[18,3]]),   // Cat closes 20,19,18 exactly (0 points -- no bonus marks)
      v(1,1,1,[[20,3],[19,3],[18,3]]),   // Dog closes the same 3
      v(0,1,1,[[17,3],[16,3],[15,3]]),   // Cat closes 17,16,15 too (6 of 7 -- everything but bull)
      v(1,1,1,[[17,3],[16,3],[15,3]]),   // Dog closes the same 6
      v(0,1,1,[[25,2],[25,2],[25,1]]),   // Cat: double-bull, double-bull, single-bull -- 2 bonus marks on bull once closed, Dog's bull still open -> 2*25=50 points, closes bull -> allClosed -> Cat WINS (50 > 0)
      v(1,2,1,[[20,1]]),                 // Dog (new set, starter rotates to him): single 20 -> 1 mark, 0 points
      v(0,2,1,[[19,1]]),                 // Cat: single 19 -> 1 mark, 0 points (mid-leg -- the "saved" point)
    ];
    const r = rebuildCricketState({ names:['Cat','Dog'], config:{ numbers:CRICKET_STANDARD_NUMBERS }, practice:false, legsPerSet:1, turns });
    assert.equal(r.setNo, 2);
    assert.equal(r.legNo, 1);
    assert.equal(r.starter, 1);
    assert.equal(r.current, 1);
    const [cat, dog] = r.players;
    assert.equal(cat.points, 0, 'reset for the new leg');
    assert.equal(cat.marks[19], 1);
    assert.equal(cat.marks[20], 0, 'reset for the new leg');
    assert.equal(cat.legsWon, 0);
    assert.equal(cat.setsWon, 1);
    assert.equal(cat.legDarts, 1, "only this new leg's own turn");
    assert.equal(cat.gameDarts, 10, '3+3+3+1 across the whole match');
    assert.equal(dog.points, 0);
    assert.equal(dog.marks[20], 1);
    assert.equal(dog.legsWon, 0);
    assert.equal(dog.setsWon, 0);
    assert.equal(dog.gameDarts, 7, '3+3+1');
  });

  test('cutthroat variant (docs/cutthroat-cricket-roadmap.md): opponentGains apply to EVERY opponent across the replay, not just the first', () => {
    const turns = [
      // A: closes 20 (0->3, 0 pts), then 3->6 (3 beyond * 20 = 60) -- both B and
      // C have 20 open, so cutthroat puts the full 60 on EACH of them, not a split.
      v(0,1,1,[[20,3],[20,3]]),
      v(1,1,1,[[0,1]]), // B: a no-op miss, just to advance the turn
    ];
    const r = rebuildCricketState({ names:['A','B','C'], config:{ numbers:CRICKET_STANDARD_NUMBERS, variant:'cutthroat' }, practice:false, legsPerSet:1, turns });
    const [a, b, c] = r.players;
    assert.equal(a.points, 0, "the shooter's own points never move in cutthroat, even across a multi-turn replay");
    assert.equal(a.marks[20], 6);
    assert.equal(b.points, 60, 'B received the full 60, not a split');
    assert.equal(c.points, 60, 'C ALSO received the full 60 -- the same visit hit every open opponent');
    assert.equal(r.current, 2, "C's turn next");
  });
});

describe('rebuildBaseballState (docs/archive/saved-games-roadmap.md, pure replay rebuild)', () => {
  test('a full leg win (9 real innings) plus a trailing partial next-leg turn matches hand-derived state', () => {
    const turns = [];
    for(let inning=1; inning<=8; inning++){
      turns.push(v(0,1,1,[[0,1],[0,1],[0,1]])); // Ann misses all 3
      turns.push(v(1,1,1,[[0,1],[0,1],[0,1]])); // Bob misses all 3
    }
    turns.push(v(0,1,1,[[9,1],[9,1],[9,1]]));   // inning 9: Ann scores 3 (target=9)
    turns.push(v(1,1,1,[[0,1],[0,1],[0,1]]));   // inning 9: Bob scores 0 -> Ann wins the leg (3 > 0)
    // Leg 2, inning 1: Ann throws (the test only cares about the rebuild's own
    // leg/set-transition bookkeeping here -- starter/current tracking is
    // exercised directly by the assertions below, independent of which
    // player's own turn record happens to follow).
    turns.push(v(0,2,1,[[1,1]]));
    const r = rebuildBaseballState({ names:['Ann','Bob'], legsPerSet:1, turns });
    assert.equal(r.setNo, 2);
    assert.equal(r.legNo, 1);
    assert.equal(r.starter, 1, 'rotated from 0');
    assert.equal(r.baseballInning, 1, 'fresh leg -- back to inning 1');
    const [ann, bob] = r.players;
    assert.equal(ann.totalRuns, 1, "this leg's own single run so far");
    assert.equal(ann.legsWon, 0, 'reset -- the set completed');
    assert.equal(ann.setsWon, 1);
    assert.equal(ann.gameDarts, 28, '8 misses-innings*3 + inning9(3) + leg2(1) = 24+3+1');
    assert.equal(bob.totalRuns, 0);
    assert.equal(bob.legsWon, 0);
    assert.equal(bob.setsWon, 0);
    assert.equal(bob.gameDarts, 27, '24+3, no leg2 turn yet');
    // current: Ann's leg2 single-dart visit didn't complete the round (Bob,
    // index 1, hasn't thrown leg2's inning 1 yet), so it's his turn next.
    assert.equal(r.current, 1);
  });
});

describe('rebuildAroundTheClockState (docs/archive/saved-games-roadmap.md, pure replay rebuild)', () => {
  test('rebuilds the CURRENT round\'s hitSet only, not earlier completed rounds', () => {
    const turns = [
      v(0,1,1,[[1,1]]),   // round 1: hit 1
      v(0,1,1,[[2,1]]),   // round 1: hit 2 (round then abandoned/completed some other way in this fixture)
      v(0,1,2,[[5,1]]),   // round 2 (new leg): hit 5
      v(0,1,2,[[5,1]]),   // round 2: repeat hit on 5 -- a real dart, but not a NEW hit
    ];
    const r = rebuildAroundTheClockState({ turns });
    assert.equal(r.legNo, 2);
    assert.equal(r.roundDarts, 2, 'only round 2\'s own 2 darts, not round 1\'s');
    assert.equal(r.hitSet.size, 1);
    assert.ok(r.hitSet.has(5));
    assert.ok(!r.hitSet.has(1), "round 1's hits don't carry over");
    assert.equal(r.roundOver, false);
  });

  test('roundOver is true once all 20 numbers are hit', () => {
    const turns = [];
    for(let n=1;n<=20;n++) turns.push(v(0,1,1,[[n,1]]));
    const r = rebuildAroundTheClockState({ turns });
    assert.equal(r.hitSet.size, 20);
    assert.equal(r.roundOver, true);
  });
});

describe('rebuildAroundTheWorldState (docs/archive/saved-games-roadmap.md, pure replay rebuild)', () => {
  test('restores the session dart count -- the one cosmetic figure worth resuming for a lifetime-cumulative mode', () => {
    const turns = [v(0,1,1,[[1,1]]), v(0,1,1,[[2,2]]), v(0,1,1,[[3,3]])];
    const r = rebuildAroundTheWorldState({ turns });
    assert.equal(r.sessionDarts, 3);
  });
});
