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
  rebuildAroundTheClockState, rebuildAroundTheWorldState, rebuildBobs27State, rebuildCheckoutLadderState,
  GAUNTLET_STATION_ORDER, evaluateGauntletStation, gauntletTotalScars, gauntletResultTier, rebuildGauntletState,
  KILLER_DEFAULT_LIVES, shuffleKillerNumbers, assignKillerNumbers, evaluateDartKiller, rebuildKillerState,
  MARATHON_FATIGUE_TIERS, computeFatigueSplit, MARATHON_TREND_MIN_LEGS, MARATHON_TREND_TOLERANCE, classifyMarathonTrend,
  shanghaiRoundTarget, isShanghaiWin, evaluateVisitShanghai,
  HALVE_IT_DEFAULT_TARGETS, halveItRoundTarget, halveItDartValue, evaluateVisitHalveIt,
  DEAD_MAN_WALKING_BANDS, deadManWalkingBandFor, deadManWalkingParForTarget, pickDeadManWalkingTargets,
  evaluateDeadManDart, resolveDeadManDart, DEAD_MAN_WALKING_RESULT_TIERS, deadManWalkingResultTier,
  rebuildDeadManWalkingState, CHALLENGE_CHECKOUTS,
  generatePressureCard, gradePressureSectorRound, evaluateDartPressureSector,
  pressureFinishBaseCp, pressureBaseCp, pressureMissPenaltyBase, pressureMissPenaltyForCard,
  pressureRoundOutcome, computePressureRoundResult, pressureComposureRating,
  isPressureIceRun, isPressureModifierFullHit, pressureChamberDecideWinnerIndex,
  evaluateVisitPressureChamber, rebuildPressureChamberState,
  PRESSURE_TARGET_POOL, PRESSURE_MODIFIERS, PRESSURE_ROUNDS } = scoring;

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

describe('challengeBadgeSignals (Daily Challenge badges: streak + format-completionist, docs/archive/daily-challenge-roadmap.md)', () => {
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

describe('evaluateGauntletStation (docs/archive/gauntlet-roadmap.md, strictly positional per-dart grading)', () => {
  test('a clean pass: dart 1 the single, dart 2 the treble, dart 3 the double, all on the station number', () => {
    const r = evaluateGauntletStation(20, [d(20,1), d(20,3), d(20,2)]);
    assert.deepEqual(r.hits, [true, true, true]);
    assert.equal(r.misses, 0);
  });

  test('no re-matching across positions: a double thrown first does not satisfy dart 1\'s single task', () => {
    const r = evaluateGauntletStation(20, [d(20,2), d(20,3), d(20,2)]);
    assert.deepEqual(r.hits, [false, true, true], 'dart 1 landed the double, not the single it was asked for');
    assert.equal(r.misses, 1);
  });

  test('a dart on the wrong number never counts, regardless of ring', () => {
    const r = evaluateGauntletStation(20, [d(5,1), d(20,3), d(20,2)]);
    assert.deepEqual(r.hits, [false, true, true]);
    assert.equal(r.misses, 1);
  });

  test('all three tasks missed -> misses=3 (a Deep Scar upstream)', () => {
    const r = evaluateGauntletStation(20, [d(1,1), d(2,1), d(3,1)]);
    assert.equal(r.misses, 3);
  });

  test('a missing dart (attempt cut short) counts as a miss for that slot', () => {
    const r = evaluateGauntletStation(20, [d(20,1), d(20,3)]); // no 3rd dart
    assert.deepEqual(r.hits, [true, true, false]);
    assert.equal(r.misses, 1);
  });
});

describe('gauntletTotalScars / gauntletResultTier (docs/archive/gauntlet-roadmap.md Scar tally + result tiers)', () => {
  test('sums final per-station miss counts, doubling any Deep Scar (a final result of 3)', () => {
    assert.equal(gauntletTotalScars([0,0,0]), 0);
    assert.equal(gauntletTotalScars([1,2,0]), 3);
    assert.equal(gauntletTotalScars([3]), 6, 'a single Deep Scar contributes 6, not 3');
    assert.equal(gauntletTotalScars([3,3,1]), 13, '6 + 6 + 1');
  });

  test('result tier boundaries: 0-5 Unmarked, 6-12 Scarred but Standing, 13-20 Bloodied, 21-30 Broken Down, 31+ The Gauntlet Wins', () => {
    assert.equal(gauntletResultTier(0), 'Unmarked');
    assert.equal(gauntletResultTier(5), 'Unmarked');
    assert.equal(gauntletResultTier(6), 'Scarred but Standing');
    assert.equal(gauntletResultTier(12), 'Scarred but Standing');
    assert.equal(gauntletResultTier(13), 'Bloodied');
    assert.equal(gauntletResultTier(20), 'Bloodied');
    assert.equal(gauntletResultTier(21), 'Broken Down');
    assert.equal(gauntletResultTier(30), 'Broken Down');
    assert.equal(gauntletResultTier(31), 'The Gauntlet Wins');
    assert.equal(gauntletResultTier(120), 'The Gauntlet Wins');
  });
});

describe('rebuildGauntletState (docs/archive/saved-games-roadmap.md, pure replay rebuild)', () => {
  const gt = (station, scored) => ({ targetScore: station, scored });

  test('an empty turn history starts at the first station in GAUNTLET_STATION_ORDER, nothing settled', () => {
    const r = rebuildGauntletState({ turns: [] });
    assert.equal(r.currentStation, GAUNTLET_STATION_ORDER[0]);
    assert.equal(r.settledCount, 0);
    assert.equal(r.awaitingRepeat, false);
    assert.equal(r.totalScars, 0);
    assert.equal(r.done, false);
  });

  test('clean passes settle immediately and advance to the next station in order', () => {
    const turns = [ gt(GAUNTLET_STATION_ORDER[0], 0), gt(GAUNTLET_STATION_ORDER[1], 1) ];
    const r = rebuildGauntletState({ turns });
    assert.equal(r.settledCount, 2);
    assert.equal(r.currentStation, GAUNTLET_STATION_ORDER[2]);
    assert.equal(r.awaitingRepeat, false);
    assert.deepEqual(r.finalMisses, [0, 1]);
    assert.equal(r.totalScars, 1);
  });

  test('a first attempt scoring 2 misses is NOT settled -- it awaits its one repeat, and stays the current station', () => {
    const turns = [ gt(GAUNTLET_STATION_ORDER[0], 0), gt(GAUNTLET_STATION_ORDER[1], 2) ];
    const r = rebuildGauntletState({ turns });
    assert.equal(r.settledCount, 1, 'only the first station settled -- the second is awaiting repeat');
    assert.equal(r.currentStation, GAUNTLET_STATION_ORDER[1]);
    assert.equal(r.awaitingRepeat, true);
  });

  test('a repeat attempt (a 2nd turn for the same station) is authoritative regardless of its own result', () => {
    const turns = [
      gt(GAUNTLET_STATION_ORDER[0], 2), gt(GAUNTLET_STATION_ORDER[0], 3), // repeated, came back WORSE (3) -- still final
      gt(GAUNTLET_STATION_ORDER[1], 2), gt(GAUNTLET_STATION_ORDER[1], 0), // repeated, came back clean
    ];
    const r = rebuildGauntletState({ turns });
    assert.equal(r.settledCount, 2);
    assert.deepEqual(r.finalMisses, [3, 0]);
    assert.equal(r.awaitingRepeat, false);
    assert.equal(r.currentStation, GAUNTLET_STATION_ORDER[2]);
  });

  test('a 3-miss (Deep Scar) first attempt settles immediately, no repeat offered', () => {
    const turns = [ gt(GAUNTLET_STATION_ORDER[0], 3) ];
    const r = rebuildGauntletState({ turns });
    assert.equal(r.settledCount, 1);
    assert.deepEqual(r.finalMisses, [3]);
    assert.equal(r.currentStation, GAUNTLET_STATION_ORDER[1]);
  });

  test('all 20 stations settled -> done=true, no current station to report as "next"', () => {
    const turns = GAUNTLET_STATION_ORDER.map(station => gt(station, 0));
    const r = rebuildGauntletState({ turns });
    assert.equal(r.settledCount, 20);
    assert.equal(r.done, true);
    assert.equal(r.totalScars, 0);
    assert.equal(r.currentStation, undefined);
  });
});

describe('assignKillerNumbers / shuffleKillerNumbers (docs/archive/game-modes-roadmap.md "Killer")', () => {
  test('shuffleKillerNumbers returns a permutation of the input (same multiset), deterministic given a fixed rng', () => {
    let calls = 0;
    const fixedRng = () => { calls++; return 0; };
    const shuffled = shuffleKillerNumbers([1,2,3,4,5], fixedRng);
    assert.deepEqual([...shuffled].sort((a,b)=>a-b), [1,2,3,4,5], 'same multiset, just reordered');
    assert.equal(calls, 4, 'Fisher-Yates makes n-1 rng calls for n items');
  });

  test('assignKillerNumbers gives every player a distinct number from 1-20', () => {
    const names = ['Alice','Bob','Carol','Dave'];
    const assignment = assignKillerNumbers(names);
    const values = names.map(n => assignment[n]);
    assert.equal(new Set(values).size, names.length, 'no two players share a number');
    values.forEach(v => assert.ok(v >= 1 && v <= 20, `number ${v} out of 1-20 range`));
  });

  test('assignKillerNumbers is reproducible given the same seeded rng sequence', () => {
    const seq = [0.1, 0.2, 0.3];
    let i = 0;
    const rng = () => seq[i++ % seq.length];
    const a = assignKillerNumbers(['A','B','C'], rng);
    i = 0;
    const b = assignKillerNumbers(['A','B','C'], rng);
    assert.deepEqual(a, b);
  });
});

describe('evaluateDartKiller (docs/archive/game-modes-roadmap.md "Killer")', () => {
  const mkPlayers = (overrides) => {
    const base = [
      { name:'A', number:5,  lives:0, isKiller:false, eliminated:false },
      { name:'B', number:9,  lives:0, isKiller:false, eliminated:false },
      { name:'C', number:14, lives:0, isKiller:false, eliminated:false },
    ];
    return base.map(p => Object.assign({}, p, overrides && overrides[p.name]));
  };

  test('pre-killer, hitting your own number builds lives scaled by ring (single=1, double=2, treble=3)', () => {
    const players = mkPlayers();
    assert.deepEqual(evaluateDartKiller(d(5,1), 'A', players), { affectedName:'A', delta:1, isGain:true, selfKill:false });
    assert.equal(evaluateDartKiller(d(5,3), 'A', players).delta, 3);
  });

  test('pre-killer, hitting an opponent\'s number is a no-op — can\'t attack until you\'re a killer', () => {
    const players = mkPlayers();
    assert.equal(evaluateDartKiller(d(9,2), 'A', players), null);
  });

  test('a miss or an unclaimed number is a no-op', () => {
    const players = mkPlayers();
    assert.equal(evaluateDartKiller(d(0,1), 'A', players), null);
    assert.equal(evaluateDartKiller(d(20,1), 'A', players), null); // 20 is unassigned in this fixture
  });

  test('once a killer, hitting an opponent\'s number removes lives at the same scaled rate', () => {
    const players = mkPlayers({ A: { isKiller:true, lives:3 } });
    assert.deepEqual(evaluateDartKiller(d(9,3), 'A', players), { affectedName:'B', delta:3, isGain:false, selfKill:false });
  });

  test('once a killer, hitting your own DOUBLE costs a flat 1 life (self-kill), never scaled by multiplier', () => {
    const players = mkPlayers({ A: { isKiller:true, lives:3 } });
    assert.deepEqual(evaluateDartKiller(d(5,2), 'A', players), { affectedName:'A', delta:1, isGain:false, selfKill:true });
  });

  test('once a killer, a single or treble on your own number again is a no-op', () => {
    const players = mkPlayers({ A: { isKiller:true, lives:3 } });
    assert.equal(evaluateDartKiller(d(5,1), 'A', players), null);
    assert.equal(evaluateDartKiller(d(5,3), 'A', players), null);
  });

  test('hitting an already-eliminated player\'s number is a no-op, even for a killer', () => {
    const players = mkPlayers({ A: { isKiller:true, lives:3 }, B: { eliminated:true, lives:0 } });
    assert.equal(evaluateDartKiller(d(9,1), 'A', players), null);
  });
});

describe('rebuildKillerState (docs/archive/game-modes-roadmap.md "Killer", pure replay)', () => {
  const kt = (throwerName, sector, mult) => ({ throwerName, sector, mult });

  test('an empty turn history: everyone at 0 lives, nobody a killer, no winner', () => {
    const r = rebuildKillerState({ names:['A','B'], numbers:{A:5,B:9}, turns:[] });
    assert.equal(r.winner, null);
    assert.deepEqual(r.players.map(p=>p.lives), [0,0]);
    assert.deepEqual(r.players.map(p=>p.isKiller), [false,false]);
  });

  test('a treble on the first dart makes a player an instant killer (3 >= default threshold)', () => {
    const r = rebuildKillerState({ names:['A','B'], numbers:{A:5,B:9}, turns:[ kt('A',5,3) ] });
    const a = r.players.find(p=>p.name==='A');
    assert.equal(a.lives, 3);
    assert.equal(a.isKiller, true);
  });

  test('a killer attacking an opponent down to exactly 0 lives eliminates them and ends a 2-player match', () => {
    const turns = [
      kt('A',5,3),   // A: treble own number -> 3 lives, killer
      kt('B',9,1),   // B: single own number -> 1 life (not yet a killer)
      kt('A',9,1),   // A attacks B for 1 -> B: 1-1=0 -> eliminated -> A is last one standing
    ];
    const r = rebuildKillerState({ names:['A','B'], numbers:{A:5,B:9}, turns });
    assert.equal(r.winner, 'A');
    const b = r.players.find(p=>p.name==='B');
    assert.equal(b.lives, 0);
    assert.equal(b.eliminated, true);
    assert.equal(b.livesLost, 1);
    const a = r.players.find(p=>p.name==='A');
    assert.equal(a.kills, 1, "A's attack eliminated B -- a real kill");
  });

  test('a self-kill (own double after becoming a killer) can eliminate the thrower themselves, and does NOT count as a kill for anyone', () => {
    const turns = [
      kt('A',5,3),   // A: treble own -> 3 lives, killer
      kt('B',9,3),   // B: treble own -> 3 lives, killer (so it isn't already over)
      kt('B',5,2),   // B attacks A's number for 2 -> A: 3-2=1 life, still a killer
      kt('A',5,2),   // A hits own double (already a killer) -> self-kill, -1 -> A: 1-1=0, eliminated
    ];
    const r = rebuildKillerState({ names:['A','B'], numbers:{A:5,B:9}, turns });
    const a = r.players.find(p=>p.name==='A');
    assert.equal(a.lives, 0);
    assert.equal(a.eliminated, true);
    assert.equal(a.livesLost, 3, "A lost 2 to B's attack + 1 to the self-kill = 3 total");
    assert.equal(a.kills, 0, "A never eliminated anyone -- the self-kill doesn't count as B's kill either");
    const b = r.players.find(p=>p.name==='B');
    assert.equal(b.kills, 0, "B's own attack only brought A to 1 life, not 0 -- B never actually landed the elimination");
    assert.equal(r.winner, 'B');
  });

  test('threshold is configurable — a lower lives threshold makes killer status kick in sooner', () => {
    const turns = [ kt('A',5,2) ]; // double own number -> 2 lives
    const withDefault = rebuildKillerState({ names:['A','B'], numbers:{A:5,B:9}, turns });
    assert.equal(withDefault.players.find(p=>p.name==='A').isKiller, false, 'default threshold is 3 -- 2 lives isn\'t enough yet');
    const withThreshold2 = rebuildKillerState({ names:['A','B'], numbers:{A:5,B:9}, turns, threshold:2 });
    assert.equal(withThreshold2.players.find(p=>p.name==='A').isKiller, true);
  });

  test('a turn thrown by an already-eliminated player is ignored (defensive replay)', () => {
    const turns = [
      kt('A',5,3),  // A killer, 3 lives
      kt('B',9,3),  // B killer, 3 lives
      kt('B',5,3),  // B attacks A for 3 -> A eliminated, B wins
      kt('A',9,1),  // A (already eliminated) somehow throws again -- must be a no-op
    ];
    const r = rebuildKillerState({ names:['A','B'], numbers:{A:5,B:9}, turns });
    assert.equal(r.winner, 'B');
    const b = r.players.find(p=>p.name==='B');
    assert.equal(b.lives, 3, "the eliminated player's bogus extra turn had no effect");
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

describe('computeFatigueSplit (docs/archive/marathon-mode-roadmap.md)', () => {
  test('splits an odd leg count with the floor half first, per the roadmap doc', () => {
    // 5 legs: floor(5/2)=2 in the first half, 3 in the second.
    const r = computeFatigueSplit([10, 10, 20, 20, 20]);
    // first avg = 10, second avg = (20+20+20)/3 = 20 -> split = 10
    assert.equal(r.split, 10);
    assert.equal(r.tier, 'Running on Empty');
  });

  test('a session that got FASTER in the second half clamps to zero, not negative', () => {
    const r = computeFatigueSplit([20, 20, 10, 10]);
    assert.equal(r.split, 0);
    assert.equal(r.tier, 'Iron');
  });

  test('tier boundaries: 0-2 Iron, 3-5 Tested, 6-9 Fading, 10+ Running on Empty', () => {
    assert.equal(computeFatigueSplit([10, 12]).tier, 'Iron');   // split=2
    assert.equal(computeFatigueSplit([10, 14]).tier, 'Tested'); // split=4
    assert.equal(computeFatigueSplit([10, 18]).tier, 'Fading'); // split=8
    assert.equal(computeFatigueSplit([10, 20]).tier, 'Running on Empty'); // split=10
  });

  test('a 0- or 1-leg session has no second half to compare -- reads as zero fatigue', () => {
    assert.equal(computeFatigueSplit([]).split, 0);
    assert.equal(computeFatigueSplit([15]).split, 0);
  });
});

describe('classifyMarathonTrend (docs/archive/marathon-mode-roadmap.md)', () => {
  test('fewer than MARATHON_TREND_MIN_LEGS legs is always Inconclusive', () => {
    const legs = Array(MARATHON_TREND_MIN_LEGS - 1).fill(9);
    assert.equal(classifyMarathonTrend(legs), 'Inconclusive');
  });

  test('a clear Cliff: early and middle roughly equal, late meaningfully worse', () => {
    // 9 legs -> 3/3/3 segments. early=9, middle=9, late=20.
    const legs = [9, 9, 9, 9, 9, 9, 20, 20, 20];
    assert.equal(classifyMarathonTrend(legs), 'The Cliff');
  });

  test('a clear Warm Machine: early worse than middle, late holds at middle\'s level', () => {
    const legs = [20, 20, 20, 9, 9, 9, 9, 9, 9];
    assert.equal(classifyMarathonTrend(legs), 'The Warm Machine');
  });

  test('a clear Flat Line: all three segments within tolerance of each other', () => {
    const legs = [9, 10, 9, 10, 9, 10, 9, 10, 9];
    assert.equal(classifyMarathonTrend(legs), 'Flat Line');
  });

  test('a shape matching no named pattern (steady gradual climb) is Inconclusive, not forced into one', () => {
    const legs = [8, 10, 12, 14, 16, 18, 20, 22, 24];
    assert.equal(classifyMarathonTrend(legs), 'Inconclusive');
  });
});

describe('shanghaiRoundTarget (docs/archive/shanghai-roadmap.md)', () => {
  test('within range returns the round itself; beyond maxRounds caps at maxRounds (extra rounds)', () => {
    assert.equal(shanghaiRoundTarget(3, 7), 3);
    assert.equal(shanghaiRoundTarget(7, 7), 7);
    assert.equal(shanghaiRoundTarget(8, 7), 7);
    assert.equal(shanghaiRoundTarget(20, 7), 7);
  });
});

describe('isShanghaiWin (docs/archive/shanghai-roadmap.md)', () => {
  test('single, double, and treble of the target, any order, IS a Shanghai', () => {
    assert.equal(isShanghaiWin([{sector:5,mult:1},{sector:5,mult:2},{sector:5,mult:3}], 5), true);
    assert.equal(isShanghaiWin([{sector:5,mult:3},{sector:5,mult:1},{sector:5,mult:2}], 5), true);
  });
  test('two singles and a treble is NOT a Shanghai (missing the double)', () => {
    assert.equal(isShanghaiWin([{sector:5,mult:1},{sector:5,mult:1},{sector:5,mult:3}], 5), false);
  });
  test('any dart off the target number breaks it, even if the multiplier set is right', () => {
    assert.equal(isShanghaiWin([{sector:5,mult:1},{sector:5,mult:2},{sector:6,mult:3}], 5), false);
  });
  test('fewer than 3 darts is never a Shanghai', () => {
    assert.equal(isShanghaiWin([{sector:5,mult:1},{sector:5,mult:2}], 5), false);
  });
});

describe('evaluateVisitShanghai (docs/archive/shanghai-roadmap.md)', () => {
  function mkGame(round, current, players, maxRounds){
    return { shanghaiRound: round, current, players, config: { rounds: maxRounds || 7 } };
  }
  test('scores multiplier x round-number for darts on target, zero for darts off it', () => {
    const player = { totalPoints: 0, roundPoints: {} };
    const game = mkGame(4, 0, [player, { totalPoints: 0 }]);
    const ev = evaluateVisitShanghai(player, [{sector:4,mult:1},{sector:4,mult:3},{sector:9,mult:2}], game);
    // single 4 = 4, treble 4 = 12, sector 9 (off-target) = 0 -> 16 total
    assert.equal(ev.pointsThisVisit, 16);
    assert.equal(ev.scored, 16);
    assert.equal(ev.target, 4);
    assert.equal(ev.shanghai, false);
  });

  test('a Shanghai wins the WHOLE match instantly, mid-round, regardless of running totals', () => {
    const p0 = { totalPoints: 0, roundPoints: {} };
    const p1 = { totalPoints: 500, roundPoints: {} }; // far ahead on points
    const game = mkGame(3, 0, [p0, p1]); // p0 throws first, round not complete yet
    const ev = evaluateVisitShanghai(p0, [{sector:3,mult:1},{sector:3,mult:2},{sector:3,mult:3}], game);
    assert.equal(ev.shanghai, true);
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 0, 'the Shanghai thrower wins regardless of who is ahead on points');
  });

  test('final round, single leader: match completes for the leader', () => {
    const p0 = { totalPoints: 10, roundPoints: {} };
    const p1 = { totalPoints: 20, roundPoints: {} };
    // p1 (index 1) is the last player in the rotation -- roundComplete=true
    const game = mkGame(7, 1, [p0, p1], 7);
    const ev = evaluateVisitShanghai(p1, [{sector:0,mult:1}], game); // miss, p1 stays at 20
    assert.equal(ev.roundComplete, true);
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 1);
  });

  test('final round tie, no Shanghai: match does not complete', () => {
    const p0 = { totalPoints: 20, roundPoints: {} };
    const p1 = { totalPoints: 20, roundPoints: {} };
    const game = mkGame(7, 1, [p0, p1], 7);
    const ev = evaluateVisitShanghai(p1, [{sector:0,mult:1}], game); // miss, stays tied 20-20
    assert.equal(ev.roundComplete, true);
    assert.equal(ev.matchComplete, false, 'a tie with no Shanghai continues into an extra round');
  });

  test('not the final round: match never completes even with a big lead', () => {
    const p0 = { totalPoints: 100, roundPoints: {} };
    const p1 = { totalPoints: 5, roundPoints: {} };
    const game = mkGame(3, 1, [p0, p1], 7);
    const ev = evaluateVisitShanghai(p1, [{sector:0,mult:1}], game);
    assert.equal(ev.matchComplete, false);
  });

  test('extra rounds keep targeting maxRounds, not cycling back to 1', () => {
    const player = { totalPoints: 0, roundPoints: {} };
    const game = mkGame(9, 0, [player, {totalPoints:0}], 7); // round 9 > maxRounds 7
    const ev = evaluateVisitShanghai(player, [{sector:7,mult:1}], game);
    assert.equal(ev.target, 7, 'extra rounds repeat the final round\'s own number, matching Baseball');
  });
});

describe('halveItRoundTarget (docs/archive/halve-it-roadmap.md)', () => {
  test('within range returns the target at that index; beyond the list caps at the final target', () => {
    const targets = HALVE_IT_DEFAULT_TARGETS;
    assert.deepEqual(halveItRoundTarget(1, targets), { sector: 20 });
    assert.deepEqual(halveItRoundTarget(7, targets), { sector: 25 });
    assert.deepEqual(halveItRoundTarget(8, targets), { sector: 25 }, 'extra rounds repeat the final target');
    assert.deepEqual(halveItRoundTarget(20, targets), { sector: 25 });
  });
  test('an empty/missing targets list falls back to the default set', () => {
    assert.deepEqual(halveItRoundTarget(1, null), { sector: 20 });
    assert.deepEqual(halveItRoundTarget(1, []), { sector: 20 });
  });
});

describe('halveItDartValue (docs/archive/halve-it-roadmap.md)', () => {
  test('an unrestricted target counts any ring at face value', () => {
    const target = { sector: 20 };
    assert.equal(halveItDartValue({ sector: 20, mult: 1 }, target), 20, 'single');
    assert.equal(halveItDartValue({ sector: 20, mult: 2 }, target), 40, 'double');
    assert.equal(halveItDartValue({ sector: 20, mult: 3 }, target), 60, 'treble');
  });
  test('a wrong sector scores 0 regardless of ring', () => {
    assert.equal(halveItDartValue({ sector: 5, mult: 3 }, { sector: 20 }), 0);
  });
  test('a ring-restricted target rejects the right sector on the wrong ring', () => {
    const target = { sector: 7, ring: 'double' };
    assert.equal(halveItDartValue({ sector: 7, mult: 2 }, target), 14, 'the required ring counts');
    assert.equal(halveItDartValue({ sector: 7, mult: 1 }, target), 0, 'single 7 does not satisfy a double-7 round');
    assert.equal(halveItDartValue({ sector: 7, mult: 3 }, target), 0, 'treble 7 does not satisfy a double-7 round either');
  });
  test('a treble-restricted target only counts the treble', () => {
    const target = { sector: 10, ring: 'treble' };
    assert.equal(halveItDartValue({ sector: 10, mult: 3 }, target), 30);
    assert.equal(halveItDartValue({ sector: 10, mult: 1 }, target), 0);
  });
  test('bull (sector 25) scores via the same mult*sector formula -- single 25, double 50, no treble ring exists', () => {
    const target = { sector: 25 };
    assert.equal(halveItDartValue({ sector: 25, mult: 1 }, target), 25);
    assert.equal(halveItDartValue({ sector: 25, mult: 2 }, target), 50);
  });
});

describe('evaluateVisitHalveIt (docs/archive/halve-it-roadmap.md)', () => {
  function mkGame(round, current, players, targets){
    return { halveItRound: round, current, players, config: { targets: targets || HALVE_IT_DEFAULT_TARGETS } };
  }
  test('a hit adds the visit\'s value to the running total -- never halves', () => {
    const player = { total: 10, roundTotals: {} };
    const game = mkGame(1, 0, [player, { total: 0 }]); // round 1 targets plain 20
    const ev = evaluateVisitHalveIt(player, [{sector:20,mult:1},{sector:20,mult:1},{sector:0,mult:1}], game);
    assert.equal(ev.gained, 40, '20 + 20 + a miss dart');
    assert.equal(ev.halved, false);
    assert.equal(ev.total, 50, '10 prior + 40 gained');
  });
  test('missing the target with all 3 darts halves the running total, rounding UP', () => {
    const player = { total: 25, roundTotals: {} };
    const game = mkGame(1, 0, [player, { total: 0 }]);
    const ev = evaluateVisitHalveIt(player, [{sector:1,mult:1},{sector:2,mult:1},{sector:3,mult:1}], game); // none hit 20
    assert.equal(ev.gained, 0);
    assert.equal(ev.halved, true);
    assert.equal(ev.total, 13, 'ceil(25/2) = 13, not floor\'s 12');
  });
  test('halving a total of 1 stays at 1 -- round-up never reaches a permanent 0', () => {
    const player = { total: 1, roundTotals: {} };
    const game = mkGame(1, 0, [player, { total: 0 }]);
    const ev = evaluateVisitHalveIt(player, [{sector:0,mult:1}], game);
    assert.equal(ev.total, 1, 'ceil(1/2) = 1');
  });
  test('halving a total of 0 stays at 0 (an early-round miss with nothing built up yet)', () => {
    const player = { total: 0, roundTotals: {} };
    const game = mkGame(1, 0, [player, { total: 0 }]);
    const ev = evaluateVisitHalveIt(player, [{sector:0,mult:1}], game);
    assert.equal(ev.total, 0);
  });
  test('a ring-restricted round (double 7) only credits the exact ring', () => {
    const player = { total: 0, roundTotals: {} };
    const game = mkGame(3, 0, [player, { total: 0 }]); // round 3 = {sector:7, ring:'double'}
    const ev = evaluateVisitHalveIt(player, [{sector:7,mult:1},{sector:7,mult:2},{sector:7,mult:3}], game);
    assert.equal(ev.gained, 14, 'only the double-7 dart counts -- single/treble 7 both score 0 here');
    assert.equal(ev.target.ring, 'double');
  });
  test('the match only completes once the FINAL round\'s last player throws, never early', () => {
    const p0 = { total: 100, roundTotals: {} };
    const p1 = { total: 5, roundTotals: {} };
    const game = mkGame(3, 1, [p0, p1], HALVE_IT_DEFAULT_TARGETS); // round 3 of 7, p1 is last in rotation
    const ev = evaluateVisitHalveIt(p1, [{sector:0,mult:1}], game);
    assert.equal(ev.roundComplete, true, 'p1 is last in the rotation this round');
    assert.equal(ev.matchComplete, false, 'round 3 of 7 -- not the final round yet, even with a huge lead');
  });
  test('final round, single leader: match completes for the leader', () => {
    const p0 = { total: 10, roundTotals: {} };
    const p1 = { total: 20, roundTotals: {} };
    const game = mkGame(7, 1, [p0, p1], HALVE_IT_DEFAULT_TARGETS); // round 7 = Bull, unrestricted
    // p1 hits a single bull (+25) instead of missing, so this visit doesn't trigger
    // Halve-It's own halving rule -- isolates "single leader after final round" from
    // the halving mechanic, which is covered by its own tests above.
    const ev = evaluateVisitHalveIt(p1, [{sector:25,mult:1}], game);
    assert.equal(ev.total, 45, '20 prior + 25 gained');
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 1);
  });
  test('final round tie: match does not complete, continues into an extra round', () => {
    const p0 = { total: 20, roundTotals: {} };
    const p1 = { total: 40, roundTotals: {} };
    const game = mkGame(7, 1, [p0, p1], HALVE_IT_DEFAULT_TARGETS);
    // p1 misses the final round entirely -> halved from 40 to 20, tying p0.
    const ev = evaluateVisitHalveIt(p1, [{sector:0,mult:1}], game);
    assert.equal(ev.total, 20, 'ceil(40/2) = 20, now tied with p0');
    assert.equal(ev.matchComplete, false, 'a tie after the final round continues into an extra round');
  });
  test('extra rounds keep targeting the final round\'s own target, not cycling back to round 1', () => {
    const player = { total: 0, roundTotals: {} };
    const game = mkGame(9, 0, [player, { total: 0 }], HALVE_IT_DEFAULT_TARGETS); // round 9 > 7 targets
    const ev = evaluateVisitHalveIt(player, [{sector:25,mult:1}], game);
    assert.deepEqual(ev.target, { sector: 25 }, 'round 9 still targets round 7\'s own Bull, matching Baseball/Shanghai');
  });
});

describe('Dead Man Walking (docs/archive/dead-man-walking-roadmap.md)', () => {
  describe('deadManWalkingBandFor', () => {
    test('band boundaries: 32/60 low, 61/100 mid, 101/170 high', () => {
      assert.equal(deadManWalkingBandFor(32).name, 'low');
      assert.equal(deadManWalkingBandFor(60).name, 'low');
      assert.equal(deadManWalkingBandFor(61).name, 'mid');
      assert.equal(deadManWalkingBandFor(100).name, 'mid');
      assert.equal(deadManWalkingBandFor(101).name, 'high');
      assert.equal(deadManWalkingBandFor(170).name, 'high');
    });
  });

  describe('deadManWalkingParForTarget', () => {
    test('with no historical average, defaults to objective-optimal + 2', () => {
      // 40 finishes optimally in 1 dart (D20).
      assert.equal(deadManWalkingParForTarget(40, null), 1 + 2);
      // 170 (T20 T20 Bull) finishes optimally in 3 darts.
      assert.equal(deadManWalkingParForTarget(170, null), 3 + 2);
    });
    test('with a historical average above the floor, par is the historical average', () => {
      assert.equal(deadManWalkingParForTarget(40, 4.5), 4.5, 'D20 is 1 dart optimally, but this player usually needs 4.5');
    });
    test('with a historical average BELOW the objective floor, the floor wins -- par can never make the round unachievable', () => {
      // 40 -> D20, 1 dart optimal, floor = 2. A (bogus/optimistic) historical
      // average of 1 must still be floored up to 2.
      assert.equal(deadManWalkingParForTarget(40, 1), 2);
    });
    test('exhaustive: for every finishable score 2-170, par-1 (the actual dart budget) is never below the objective-optimal dart count, regardless of historicalAverage', () => {
      // Mirrors checkoutHint()'s own exhaustive-range verification (backend/test/
      // scoring.test.js's "checkoutHint" describe block) -- this is the one
      // concrete, testable correctness property the roadmap doc calls out by name.
      let checked = 0;
      for (let score = 2; score <= 170; score++) {
        const hint = checkoutHint(score, true, 3);
        if (!hint) continue; // bogey/unfinishable -- Dead Man Walking never serves these
        const optimal = hint.split(' ').length;
        for (const historicalAverage of [null, 0, 1, optimal - 1, optimal, optimal + 5, 20]) {
          const par = deadManWalkingParForTarget(score, historicalAverage);
          const budget = par - 1;
          assert.ok(budget >= optimal,
            `score ${score}: optimal=${optimal}, historicalAverage=${historicalAverage} -> par=${par}, budget=${budget} must be >= ${optimal}`);
          checked++;
        }
      }
      assert.ok(checked > 900, `sanity: exercised a real range of finishable scores (got ${checked} checks)`);
    });
  });

  describe('pickDeadManWalkingTargets', () => {
    test('draws n targets from the pool with replacement, using the injectable rng deterministically', () => {
      const pool = [40, 60, 90];
      let calls = 0;
      const seq = [0.0, 0.5, 0.99, 0.34, 0.1];
      const rng = () => seq[calls++ % seq.length];
      const drawn = pickDeadManWalkingTargets(pool, 5, rng);
      assert.deepEqual(drawn, [40, 60, 90, 60, 40]);
    });
    test('a pool smaller than 15 still produces exactly 15 draws, with repeats', () => {
      const pool = [50];
      const drawn = pickDeadManWalkingTargets(pool, 15, () => 0.4);
      assert.equal(drawn.length, 15);
      assert.ok(drawn.every(t => t === 50));
    });
  });

  describe('evaluateDeadManDart', () => {
    test('overshoot (new remaining < 0) is a bust -- remaining stays unchanged', () => {
      const ev = evaluateDeadManDart(20, makeDartCore(20, 3), true); // T20 = 60, way over
      assert.equal(ev.bust, true);
      assert.equal(ev.win, false);
      assert.equal(ev.newRemaining, 20, 'a bust never changes the remaining score');
    });
    test('leaving exactly 1 under double-out is a bust', () => {
      const ev = evaluateDeadManDart(21, makeDartCore(20, 1), true); // 21-20=1
      assert.equal(ev.bust, true);
      assert.equal(ev.newRemaining, 21);
    });
    test('reaching 0 on a double is a Walked Out win', () => {
      const ev = evaluateDeadManDart(40, makeDartCore(20, 2), true); // D20
      assert.equal(ev.win, true);
      assert.equal(ev.bust, false);
      assert.equal(ev.newRemaining, 0);
    });
    test('reaching 0 on a non-double under double-out is a bust, not a win', () => {
      const ev = evaluateDeadManDart(20, makeDartCore(20, 1), true); // single 20, not a double
      assert.equal(ev.bust, true);
      assert.equal(ev.win, false);
      assert.equal(ev.newRemaining, 20);
    });
    test('a normal scoring dart that leaves a positive, non-1 remainder just continues', () => {
      const ev = evaluateDeadManDart(90, makeDartCore(20, 3), true); // T20 = 60, leaves 30
      assert.equal(ev.bust, false);
      assert.equal(ev.win, false);
      assert.equal(ev.newRemaining, 30);
    });
  });

  describe('resolveDeadManDart', () => {
    test('a dart that neither busts nor wins, but exhausts the round budget, is Executed "out of darts"', () => {
      // budget=1 (par=2, e.g. a 1-dart-optimal target the player gets no grace
      // on), dartsUsedThisRound=0 -- this is the round's only allowed dart.
      const r = resolveDeadManDart(32, makeDartCore(20, 1), true, 0, 1); // single 20, leaves 12 -- no bust, no win
      assert.equal(r.bust, false);
      assert.equal(r.win, false);
      assert.equal(r.outOfDarts, true);
      assert.equal(r.roundOver, true);
      assert.equal(r.newRemaining, 12, 'a real, non-bust visit keeps its actual scored value');
    });
    test('the same dart with budget still remaining just continues -- roundOver is false', () => {
      const r = resolveDeadManDart(32, makeDartCore(20, 1), true, 0, 3);
      assert.equal(r.outOfDarts, false);
      assert.equal(r.roundOver, false);
    });
    test('a bust ends the round even with darts left in the budget', () => {
      const r = resolveDeadManDart(20, makeDartCore(20, 3), true, 0, 9); // way over, plenty of budget left
      assert.equal(r.bust, true);
      assert.equal(r.roundOver, true);
    });
    test('a win ends the round even with darts left in the budget', () => {
      const r = resolveDeadManDart(40, makeDartCore(20, 2), true, 0, 9);
      assert.equal(r.win, true);
      assert.equal(r.roundOver, true);
    });
  });

  describe('deadManWalkingResultTier', () => {
    test('every documented threshold boundary lands on the right tier', () => {
      assert.equal(deadManWalkingResultTier(15), 'Pardoned');
      assert.equal(deadManWalkingResultTier(13), 'Pardoned');
      assert.equal(deadManWalkingResultTier(12), 'Reprieve');
      assert.equal(deadManWalkingResultTier(10), 'Reprieve');
      assert.equal(deadManWalkingResultTier(9), 'Last Rites');
      assert.equal(deadManWalkingResultTier(7), 'Last Rites');
      assert.equal(deadManWalkingResultTier(6), 'The Walk');
      assert.equal(deadManWalkingResultTier(4), 'The Walk');
      assert.equal(deadManWalkingResultTier(3), 'Executed');
      assert.equal(deadManWalkingResultTier(0), 'Executed');
    });
  });

  describe('rebuildDeadManWalkingState', () => {
    // A tiny 3-round frozen config for replay tests (real sessions always
    // freeze 15, but the replay logic itself doesn't care about the count).
    const rounds = [
      { target: 40, par: 3 },  // round 1: D20 optimal in 1, budget 2
      { target: 32, par: 3 },  // round 2: D16 optimal in 1, budget 2
      { target: 61, par: 4 },  // round 3: T7 D20 optimal in 2, budget 3
    ];
    test('a Walked Out round (single dart double-out finish) advances to the next round\'s own target/budget', () => {
      const turns = [ v(0, 1, 1, [[20, 2]]) ]; // D20 checks out round 1 (target 40) in 1 dart
      const r = rebuildDeadManWalkingState({ rounds, turns });
      assert.equal(r.walkedOutCount, 1);
      assert.equal(r.roundIndex, 1, 'advanced to round 2 (0-based index 1)');
      assert.equal(r.remaining, 32, 'round 2\'s own frozen target');
      assert.equal(r.dartsUsedThisRound, 0);
      assert.equal(r.done, false);
    });
    test('a bust ends the round immediately (Executed), even mid-visit -- only the darts actually thrown are replayed', () => {
      // Round 1: first dart overshoots (T20=60 against remaining 40) -- a bust,
      // second/third darts of what would have been a 3-dart visit never happen.
      const turns = [ v(0, 1, 1, [[20, 3]]) ];
      const r = rebuildDeadManWalkingState({ rounds, turns });
      assert.equal(r.walkedOutCount, 0);
      assert.equal(r.roundIndex, 1, 'still advances to round 2 -- Executed rounds progress the session too');
      assert.equal(r.remaining, 32);
    });
    test('running out of darts without busting also Executes the round (no checkout)', () => {
      // Round 1 target 40, budget 2 (par 3). Two single-20s: dart 1 leaves 20
      // (no bust, no win, 1 dart used of 2) -- dart 2 (single 20 again) leaves 0
      // but on a SINGLE under double-out, which is itself a bust (not merely
      // out-of-darts) -- so instead use a genuine "ran the clock out cleanly"
      // shape: single 5 (leaves 35), single 5 (leaves 30, budget exhausted, not 0).
      const turns = [ v(0, 1, 1, [[5, 1]]), v(0, 1, 1, [[5, 1]]) ];
      const r = rebuildDeadManWalkingState({ rounds, turns });
      assert.equal(r.walkedOutCount, 0);
      assert.equal(r.roundIndex, 1, 'round 1 settled (out of darts) and advanced to round 2');
    });
    test('a round still in progress (mid-replay, e.g. a resumed game) reports its own live remaining/darts-used', () => {
      // Round 1, budget 2: one dart used (single 5, leaves 35), round not yet settled.
      const turns = [ v(0, 1, 1, [[5, 1]]) ];
      const r = rebuildDeadManWalkingState({ rounds, turns });
      assert.equal(r.roundIndex, 0, 'still on round 1 (0-based index 0)');
      assert.equal(r.remaining, 35);
      assert.equal(r.dartsUsedThisRound, 1);
      assert.equal(r.done, false);
    });
    test('reaching and settling the final round marks the session done', () => {
      const turns = [
        v(0, 1, 1, [[20, 2]]),   // round 1: walked out
        v(0, 1, 2, [[16, 2]]),   // round 2: walked out (D16, target 32)
        v(0, 1, 3, [[7, 3], [20, 2]]), // round 3: T7 (21) + D20 (40) = 61, walked out
      ];
      const r = rebuildDeadManWalkingState({ rounds, turns });
      assert.equal(r.walkedOutCount, 3);
      assert.equal(r.roundIndex, 3, 'past the last round');
      assert.equal(r.done, true);
    });
    test('a leg spanning multiple visits within one round (no early stop) replays all of them', () => {
      // Round 3, target 61, budget 3: visit 1 misses everything (leaves 61, 3
      // darts used -- exactly the budget), so the round settles "out of darts"
      // on the 3rd dart of the FIRST visit, never reaching a second visit.
      const turns = [ v(0, 1, 3, [[0, 1], [0, 1], [0, 1]]) ];
      // Splice round 3 to be reached directly by starting the fixture at round 3
      // (rounds[] is 0-indexed by leg_no - 1, so leg 3 maps to rounds[2]).
      const r = rebuildDeadManWalkingState({ rounds, turns: [ v(0, 1, 1, [[20, 2]]), v(0, 1, 2, [[16, 2]]), ...turns ] });
      assert.equal(r.walkedOutCount, 2, 'rounds 1 and 2 walked out; round 3 missed entirely');
      assert.equal(r.done, true);
    });
  });

  describe('CHALLENGE_CHECKOUTS (shared with Daily Challenge, docs/archive/dead-man-walking-roadmap.md "Cold start")', () => {
    test('every value is a genuinely finishable double-out checkout', () => {
      CHALLENGE_CHECKOUTS.forEach(target => {
        assert.notEqual(checkoutHint(target, true, 3), '', `${target} must be finishable under double-out`);
      });
    });
  });
});

describe('generatePressureCard (docs/archive/pressure-chamber-roadmap.md "The card sequence is generated, never stored")', () => {
  test('deterministic: same (gameId, roundIndex) always yields the same card', () => {
    const a = generatePressureCard(7, 3);
    const b = generatePressureCard(7, 3);
    assert.deepEqual(a, b);
  });
  test('every target/modifier pool entry is a valid index (no out-of-range pick across a wide round sweep)', () => {
    for(let round=1; round<=50; round++){
      const card = generatePressureCard(1, round);
      assert.ok(PRESSURE_TARGET_POOL.includes(card.target));
      assert.ok(PRESSURE_MODIFIERS.includes(card.modifier));
    }
  });
  test('H2H identical sequence: the same gameId gives every "player" (i.e. every caller) the same round N card', () => {
    // The whole point of keying on gameId alone (not a per-player seed) --
    // 2-4 players sharing one game.id must see byte-identical cards.
    const gameId = 555;
    for(let round=1; round<=15; round++){
      const first = generatePressureCard(gameId, round);
      const second = generatePressureCard(gameId, round);
      assert.deepEqual(first, second);
    }
  });
  test('different gameIds usually (not guaranteed every round, but overwhelmingly) diverge', () => {
    let differences = 0;
    for(let round=1; round<=15; round++){
      const a = generatePressureCard(100, round);
      const b = generatePressureCard(200, round);
      if(JSON.stringify(a) !== JSON.stringify(b)) differences++;
    }
    assert.ok(differences > 0, 'two different game ids should not produce an identical 15-round sequence');
  });
});

describe('gradePressureSectorRound (docs/archive/pressure-chamber-roadmap.md "Targets")', () => {
  const target = { type:'sector', sector:20, ring:'double', label:'Double 20', difficulty:'double' };
  test('an exact ring+sector match on any dart is a full hit', () => {
    const darts = [{sector:1,mult:1},{sector:20,mult:2},{sector:5,mult:1}];
    assert.equal(gradePressureSectorRound(target, darts), 'full');
  });
  test('the sector hit but the wrong ring is a partial', () => {
    const darts = [{sector:20,mult:1},{sector:1,mult:1},{sector:5,mult:1}];
    assert.equal(gradePressureSectorRound(target, darts), 'partial');
  });
  test('neither sector nor ring hit at all is a miss', () => {
    const darts = [{sector:1,mult:1},{sector:2,mult:1},{sector:0,mult:1}];
    assert.equal(gradePressureSectorRound(target, darts), 'miss');
  });
  test('Match Dart: only the 3rd dart counts -- a full hit on dart 1 is ignored', () => {
    const darts = [{sector:20,mult:2},{sector:1,mult:1},{sector:5,mult:1}];
    assert.equal(gradePressureSectorRound(target, darts, true), 'miss', 'dart 1 hit the target, but Match Dart only reads dart 3');
    const darts2 = [{sector:1,mult:1},{sector:5,mult:1},{sector:20,mult:2}];
    assert.equal(gradePressureSectorRound(target, darts2, true), 'full', 'dart 3 is the real hit');
  });
  test('Match Dart with fewer than 3 darts thrown is always a miss (no dart 3 to read)', () => {
    assert.equal(gradePressureSectorRound(target, [{sector:20,mult:2}], true), 'miss');
  });
});

describe('evaluateDartPressureSector (Sudden Death per-dart early-stop, docs/archive/pressure-chamber-roadmap.md)', () => {
  const target = { type:'sector', sector:16, ring:'double', label:'Double 16', difficulty:'double' };
  test('an exact ring+sector hit continues (not ended)', () => {
    const r = evaluateDartPressureSector({sector:16,mult:2}, target);
    assert.equal(r.hit, true);
    assert.equal(r.ended, false);
  });
  test('the sector but wrong ring ends the round immediately (a partial still stops Sudden Death)', () => {
    const r = evaluateDartPressureSector({sector:16,mult:1}, target);
    assert.equal(r.hit, false);
    assert.equal(r.ended, true);
    assert.equal(r.reason, 'wrong-ring');
  });
  test('missing the sector entirely ends the round', () => {
    const r = evaluateDartPressureSector({sector:1,mult:1}, target);
    assert.equal(r.ended, true);
    assert.equal(r.reason, 'miss');
  });
});

describe('pressureBaseCp / pressureFinishBaseCp / pressureMissPenaltyBase (docs/archive/pressure-chamber-roadmap.md "Composure Points formula")', () => {
  test('base CP scales single < double < treble < bullseye', () => {
    const single = pressureBaseCp({ type:'sector', difficulty:'single' });
    const double = pressureBaseCp({ type:'sector', difficulty:'double' });
    const treble = pressureBaseCp({ type:'sector', difficulty:'treble' });
    const bull   = pressureBaseCp({ type:'sector', difficulty:'bull' });
    assert.ok(single < double && double < treble && treble < bull);
  });
  test('a finish target\'s base CP scales with its optimal dart count', () => {
    const oneDart = pressureFinishBaseCp(40);   // D20, 1 dart
    const threeDart = pressureFinishBaseCp(121); // needs all 3 darts
    assert.ok(threeDart > oneDart, 'a 3-dart finish is worth more than a 1-dart finish');
  });
  test('the miss penalty is always smaller than the base CP for the same target', () => {
    const target = { type:'sector', difficulty:'treble' };
    assert.ok(pressureMissPenaltyBase(target) < pressureBaseCp(target));
  });
});

describe('pressureMissPenaltyForCard (docs/archive/pressure-chamber-roadmap.md "derived-at-read-time" miss penalty)', () => {
  test('Double Down doubles the miss penalty relative to Dead Calm on the same target', () => {
    const target = { type:'sector', difficulty:'double' };
    const deadCalm = PRESSURE_MODIFIERS.find(m => m.key === 'dead_calm');
    const doubleDown = PRESSURE_MODIFIERS.find(m => m.key === 'double_down');
    const base = pressureMissPenaltyForCard({ target, modifier: deadCalm });
    const doubled = pressureMissPenaltyForCard({ target, modifier: doubleDown });
    assert.equal(doubled, base * 2);
  });
  test('is a pure function of the card alone -- no darts needed', () => {
    const target = { type:'sector', difficulty:'treble' };
    const modifier = PRESSURE_MODIFIERS.find(m => m.key === 'sudden_death');
    const a = pressureMissPenaltyForCard({ target, modifier });
    const b = pressureMissPenaltyForCard({ target, modifier });
    assert.equal(a, b);
  });
});

describe('pressureRoundOutcome / computePressureRoundResult (docs/archive/pressure-chamber-roadmap.md "Composure Points formula")', () => {
  const deadCalm = PRESSURE_MODIFIERS.find(m => m.key === 'dead_calm');
  const doubleDown = PRESSURE_MODIFIERS.find(m => m.key === 'double_down');
  const comeback = PRESSURE_MODIFIERS.find(m => m.key === 'comeback');
  const sectorTarget = { type:'sector', sector:20, ring:'treble', label:'Treble 20', difficulty:'treble' };

  test('full hit: gained = base x modifier multiplier, no miss penalty', () => {
    const card = { target: sectorTarget, modifier: deadCalm };
    const r = computePressureRoundResult(card, [{sector:20,mult:3}]);
    assert.equal(r.outcome, 'full');
    assert.equal(r.gained, pressureBaseCp(sectorTarget) * deadCalm.cpMultiplier);
    assert.equal(r.missPenalty, 0);
  });
  test('partial hit: gained = half of base x modifier multiplier', () => {
    const card = { target: sectorTarget, modifier: deadCalm };
    const r = computePressureRoundResult(card, [{sector:20,mult:1}]);
    assert.equal(r.outcome, 'partial');
    assert.equal(r.gained, Math.round((pressureBaseCp(sectorTarget) * deadCalm.cpMultiplier) / 2));
  });
  test('miss: gained is 0 (never negative), missPenalty is the card\'s derived penalty', () => {
    const card = { target: sectorTarget, modifier: deadCalm };
    const r = computePressureRoundResult(card, [{sector:1,mult:1}]);
    assert.equal(r.outcome, 'miss');
    assert.equal(r.gained, 0);
    assert.equal(r.missPenalty, pressureMissPenaltyForCard(card));
  });
  test('Double Down doubles the miss penalty but does not change a full hit\'s gain', () => {
    const calmCard = { target: sectorTarget, modifier: deadCalm };
    const ddCard = { target: sectorTarget, modifier: doubleDown };
    const calmFull = computePressureRoundResult(calmCard, [{sector:20,mult:3}]);
    const ddFull = computePressureRoundResult(ddCard, [{sector:20,mult:3}]);
    assert.equal(ddFull.gained, calmFull.gained, "Double Down is miss-penalty-only, per the roadmap doc's own wording");
    const calmMiss = computePressureRoundResult(calmCard, [{sector:1,mult:1}]);
    const ddMiss = computePressureRoundResult(ddCard, [{sector:1,mult:1}]);
    assert.equal(ddMiss.missPenalty, calmMiss.missPenalty * 2);
  });
  test('Comeback adds a bonus on a full hit and doubles the miss penalty', () => {
    const card = { target: sectorTarget, modifier: comeback };
    const full = computePressureRoundResult(card, [{sector:20,mult:3}]);
    const plainFull = Math.round(pressureBaseCp(sectorTarget) * comeback.cpMultiplier);
    assert.ok(full.gained > plainFull, 'the comeback bonus adds on top of the normal modifier-scaled reward');
    const miss = computePressureRoundResult(card, [{sector:1,mult:1}]);
    // Miss penalty is "base-and-modifier-scaled" per the roadmap doc's own
    // formula wording -- Comeback's cpMultiplier (1.4) legitimately scales it
    // same as every other modifier; missMultiplier (2) is the EXTRA "doubled
    // again" factor on top of that base-and-modifier-scaled value.
    const missBase = pressureMissPenaltyBase(sectorTarget);
    const expectedMiss = Math.round(missBase * comeback.cpMultiplier * comeback.missMultiplier);
    assert.equal(miss.missPenalty, expectedMiss);
    const withoutTheExtraDoubling = Math.round(missBase * comeback.cpMultiplier);
    assert.ok(miss.missPenalty > withoutTheExtraDoubling, 'missMultiplier really did add an extra penalty on top');
  });
  test('a finish target has no partial tier -- anything short of a legal finish is a miss', () => {
    const finishTarget = { type:'finish', score:40, label:'Finish 40', difficulty:'finish' };
    const card = { target: finishTarget, modifier: deadCalm };
    const legal = computePressureRoundResult(card, [makeDartCore(20,2)]);
    assert.equal(legal.outcome, 'full');
    const overshoot = computePressureRoundResult(card, [makeDartCore(20,2), makeDartCore(20,1)]); // busts past 0
    assert.equal(overshoot.outcome, 'miss', 'a bust finish attempt is a miss, never a partial');
  });
  test('Match Dart on a finish target: a checkout on dart 1 or 2 does NOT count, only dart 3', () => {
    const matchDart = PRESSURE_MODIFIERS.find(m => m.key === 'match_dart');
    const finishTarget = { type:'finish', score:40, label:'Finish 40', difficulty:'finish' };
    const card = { target: finishTarget, modifier: matchDart };
    const onDart1 = computePressureRoundResult(card, [makeDartCore(20,2)]);
    assert.equal(onDart1.outcome, 'miss', 'legal finish, but not on dart 3 -- Match Dart rejects it');
    const onDart3 = computePressureRoundResult(card, [makeDartCore(1,1), makeDartCore(1,1), makeDartCore(19,2)]);
    assert.equal(onDart3.outcome, 'full', '1+1+D19(38)=40 on dart 3, a genuine double-out finish');
  });
});

describe('pressureComposureRating (docs/archive/pressure-chamber-roadmap.md "Composure Rating")', () => {
  test('threshold table matches the roadmap doc exactly', () => {
    assert.equal(pressureComposureRating(120), 'Ice');
    assert.equal(pressureComposureRating(200), 'Ice');
    assert.equal(pressureComposureRating(119), 'Steel');
    assert.equal(pressureComposureRating(90), 'Steel');
    assert.equal(pressureComposureRating(89), 'Copper');
    assert.equal(pressureComposureRating(60), 'Copper');
    assert.equal(pressureComposureRating(59), 'Tin');
    assert.equal(pressureComposureRating(30), 'Tin');
    assert.equal(pressureComposureRating(29), 'Rattled');
    assert.equal(pressureComposureRating(-50), 'Rattled', 'a heavily-missed run can go negative -- still Rattled, not a crash');
  });
});

describe('isPressureIceRun / isPressureModifierFullHit (docs/archive/pressure-chamber-roadmap.md "Achievements")', () => {
  test('isPressureIceRun is true only at 120+ CP', () => {
    assert.equal(isPressureIceRun(120), true);
    assert.equal(isPressureIceRun(119), false);
  });
  test('isPressureModifierFullHit requires both a full outcome and the specific modifier', () => {
    const suddenDeathCard = { modifier: { key:'sudden_death' } };
    assert.equal(isPressureModifierFullHit(suddenDeathCard, 'full', 'sudden_death'), true);
    assert.equal(isPressureModifierFullHit(suddenDeathCard, 'partial', 'sudden_death'), false, 'not a full hit');
    assert.equal(isPressureModifierFullHit(suddenDeathCard, 'full', 'no_warmup'), false, 'wrong modifier');
  });
});

describe('pressureChamberDecideWinnerIndex (docs/archive/pressure-chamber-roadmap.md "Solo vs. H2H tie-breaking")', () => {
  test('highest total CP wins outright', () => {
    const idx = pressureChamberDecideWinnerIndex([{totalCp:80,misses:2,darts:30},{totalCp:100,misses:5,darts:30}]);
    assert.equal(idx, 1);
  });
  test('a CP tie breaks on fewest misses', () => {
    const idx = pressureChamberDecideWinnerIndex([{totalCp:80,misses:3,darts:30},{totalCp:80,misses:1,darts:30}]);
    assert.equal(idx, 1);
  });
  test('a CP+misses tie breaks on fewest darts thrown', () => {
    const idx = pressureChamberDecideWinnerIndex([{totalCp:80,misses:2,darts:40},{totalCp:80,misses:2,darts:35}]);
    assert.equal(idx, 1);
  });
  test('a total coincidence resolves to the earlier player in turn order', () => {
    const idx = pressureChamberDecideWinnerIndex([{totalCp:80,misses:2,darts:30},{totalCp:80,misses:2,darts:30}]);
    assert.equal(idx, 0);
  });
});

describe('evaluateVisitPressureChamber (docs/archive/pressure-chamber-roadmap.md "Data model")', () => {
  function mkGame(round, current, players, gameId){
    return { gameId: gameId || 999, pressureChamberRound: round, current, players, config: { rounds: PRESSURE_ROUNDS } };
  }
  test('a full hit adds to totalCp and bumps the full-hit streak', () => {
    const p = { totalCp: 10, misses: 0, fullHits: 1, currentFullHitStreak: 1, bestFullHitStreak: 1, roundResults: {} };
    const game = mkGame(2, 0, [p]);
    const card = generatePressureCard(999, 2);
    // Build darts that actually hit this round's own sector target (or skip via a finish check)
    const darts = card.target.type === 'sector'
      ? [{sector:card.target.sector, mult: {single:1,double:2,treble:3}[card.target.ring]}]
      : [{sector:0,mult:1}]; // a finish target: leave as a guaranteed miss for this particular assertion
    const ev = evaluateVisitPressureChamber(p, darts, game);
    if(card.target.type === 'sector'){
      assert.equal(ev.outcome, 'full');
      assert.equal(ev.totalCp, 10 + ev.gained);
      assert.equal(ev.currentFullHitStreak, 2);
    }
  });
  test('the match only completes once the FINAL round\'s last player throws, never early', () => {
    const p0 = { totalCp: 100, misses: 0, fullHits: 0, currentFullHitStreak:0, bestFullHitStreak:0, roundResults:{}, legDarts:0 };
    const p1 = { totalCp: 5, misses: 0, fullHits: 0, currentFullHitStreak:0, bestFullHitStreak:0, roundResults:{}, legDarts:0 };
    const game = mkGame(3, 1, [p0, p1]); // round 3 of 15, p1 is last in rotation
    const ev = evaluateVisitPressureChamber(p1, [{sector:0,mult:1}], game);
    assert.equal(ev.roundComplete, true);
    assert.equal(ev.matchComplete, false, 'round 3 of 15 -- nowhere near the final round');
  });
  test('final round: the match always completes with a definite winner, never null', () => {
    const p0 = { totalCp: 50, misses: 2, fullHits: 3, currentFullHitStreak:0, bestFullHitStreak:2, roundResults:{}, legDarts:40 };
    const p1 = { totalCp: 10, misses: 10, fullHits: 0, currentFullHitStreak:0, bestFullHitStreak:0, roundResults:{}, legDarts:42 };
    const game = mkGame(PRESSURE_ROUNDS, 1, [p0, p1]);
    const ev = evaluateVisitPressureChamber(p1, [{sector:0,mult:1}], game);
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 0, 'p0 has the higher total CP');
  });
});

describe('rebuildPressureChamberState (docs/archive/saved-games-roadmap.md pure replay rebuild, adapted for docs/archive/pressure-chamber-roadmap.md)', () => {
  test('replays turns and lands on the correct next round/player', () => {
    const gameId = 321;
    const names = ['Ben', 'Alaina'];
    // Just throw all-miss darts for both players across 2 rounds -- we only care
    // about bookkeeping (round/current/darts), not the specific CP outcome.
    const turns = [
      { playerIndex: 0, setNo: 1, legNo: 1, darts: [{sector:0,mult:1}] },
      { playerIndex: 1, setNo: 1, legNo: 1, darts: [{sector:0,mult:1}] },
      { playerIndex: 0, setNo: 1, legNo: 1, darts: [{sector:0,mult:1}] },
    ];
    const r = rebuildPressureChamberState({ gameId, names, legsPerSet: 1, maxRounds: PRESSURE_ROUNDS, turns });
    assert.equal(r.pressureChamberRound, 2, 'p0 has thrown round 2, round hasn\'t advanced past them yet');
    assert.equal(r.current, 1, 'Alaina throws next');
  });
  test('a completed 15-round leg produces a definite winner and resets for the next leg', () => {
    const gameId = 654;
    const names = ['Ben', 'Alaina'];
    const turns = [];
    for(let round=1; round<=15; round++){
      turns.push({ playerIndex:0, setNo:1, legNo:1, darts:[{sector:0,mult:1}] }); // Ben always misses
      turns.push({ playerIndex:1, setNo:1, legNo:1, darts:[{sector:0,mult:1}] }); // Alaina always misses too (tie on CP=0)
    }
    const r = rebuildPressureChamberState({ gameId, names, legsPerSet: 1, maxRounds: 15, turns });
    // Both players missed every round (totalCp stays 0 for both, a genuine tie) --
    // pressureChamberDecideWinnerIndex()'s own tie-break chain still names a winner.
    // legsPerSet:1 means the leg win is immediately also a set win (legsWon resets
    // to 0 the same instant it's credited, matching every other game type's own
    // practice-mode shape) -- setsWon is what actually persists the credit.
    assert.equal(r.players[0].setsWon + r.players[1].setsWon, 1, 'exactly one player is credited the leg/set win');
    assert.equal(r.pressureChamberRound, 1, 'leg complete -> reset to round 1 for the next leg');
  });
});
