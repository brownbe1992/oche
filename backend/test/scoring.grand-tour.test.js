'use strict';
// Grand Tour's pure core (frontend/scoring.js): the target sequence, the one
// dart-scoring rule, the per-stage accuracy tally, the two-player tie-break,
// and the replay that resuming a saved tour depends on.
//
// Every figure the scoreboard shows is derived from these functions — the live
// screen, the server's per-visit consistency check and the Player Profile stats
// all call grandTourDartPoints() rather than restating the rule — so this file
// is where the rule itself is pinned. The owner's spec, in full:
//
//   Singles 1-20 (1 pt a single), then TREBLES 1-20 (3 pts), then DOUBLES 1-20
//   (2 pts), then 15 darts at the bull (outer 2, inner 4). 195 darts, max 420.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

const D = (sector, mult = 1) => S.makeDartCore(sector, mult);

// A lockstep game-state stub for evaluateVisitGrandTour(): `players` and the
// round are all it reads.
function gameAt(round, players, current = 0) {
  return { grandTourRound: round, players, current, starter: 0 };
}
const freshPlayer = name => ({ name, totalPoints: 0, tally: S.newGrandTourTally() });

describe('Grand Tour — the target sequence', () => {
  test('65 visits in four stages, in the owner\'s order: singles, trebles, doubles, bull', () => {
    assert.equal(S.GRAND_TOUR_ROUNDS, 65);
    assert.deepEqual(S.GRAND_TOUR_STAGES.map(s => s.key), ['single', 'treble', 'double', 'bull']);
    assert.deepEqual(S.GRAND_TOUR_STAGES.map(s => s.rounds), [20, 20, 20, 5]);
    // 5 bull visits of 3 darts is the owner's "fifteen throws at bullseye".
    assert.equal(S.GRAND_TOUR_STAGES[3].rounds * 3, S.GRAND_TOUR_BULL_DARTS);
  });

  test('every round names the right bed', () => {
    const seen = [];
    for (let r = 1; r <= 65; r++) seen.push(S.grandTourRoundTarget(r).short);
    const oneTo20 = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.deepEqual(seen, [
      ...oneTo20.map(n => String(n)),
      ...oneTo20.map(n => `T${n}`),
      ...oneTo20.map(n => `D${n}`),
      'Bull', 'Bull', 'Bull', 'Bull', 'Bull',
    ]);
  });

  test('stage boundaries carry the stage round, not the tour round', () => {
    const at = r => { const t = S.grandTourRoundTarget(r); return [t.stage, t.stageRound, t.sector]; };
    assert.deepEqual(at(20), ['single', 20, 20]);
    assert.deepEqual(at(21), ['treble', 1, 1]);
    assert.deepEqual(at(40), ['treble', 20, 20]);
    assert.deepEqual(at(41), ['double', 1, 1]);
    assert.deepEqual(at(60), ['double', 20, 20]);
    assert.deepEqual(at(61), ['bull', 1, 25]);
    assert.deepEqual(at(65), ['bull', 5, 25]);
  });

  test('asking past the last round clamps rather than crashing (the server guard asks, then rejects)', () => {
    const t = S.grandTourRoundTarget(66);
    assert.equal(t.stage, 'bull');
    assert.equal(t.round, 66, 'the round asked for is reported back unchanged');
  });

  test('labels read the way the scoreboard says them', () => {
    assert.equal(S.grandTourRoundTarget(7).label, 'Single 7');
    assert.equal(S.grandTourRoundTarget(29).label, 'Treble 9');
    assert.equal(S.grandTourRoundTarget(56).label, 'Double 16');
    assert.equal(S.grandTourRoundTarget(63).label, 'Bullseye');
    assert.equal(S.grandTourRoundTarget(7).pointsNote, '1 point a hit');
    assert.equal(S.grandTourRoundTarget(29).pointsNote, '3 points a hit');
  });
});

describe('Grand Tour — only the exact bed scores', () => {
  const single7 = S.grandTourRoundTarget(7);
  const treble9 = S.grandTourRoundTarget(29);
  const double16 = S.grandTourRoundTarget(56);
  const bull = S.grandTourRoundTarget(61);

  test('singles stage: the single of the number scores 1, its treble and double score nothing', () => {
    assert.equal(S.grandTourDartPoints(D(7, 1), single7), 1);
    assert.equal(S.grandTourDartPoints(D(7, 3), single7), 0);
    assert.equal(S.grandTourDartPoints(D(7, 2), single7), 0);
  });

  test('either single area counts — the zone is not part of the rule', () => {
    // makeDartCore() does not carry the inner/outer zone at all; this pins that
    // the rule never starts depending on it.
    const inner = Object.assign(D(7, 1), { zone: 'inner' });
    const outer = Object.assign(D(7, 1), { zone: 'outer' });
    assert.equal(S.grandTourDartPoints(inner, single7), 1);
    assert.equal(S.grandTourDartPoints(outer, single7), 1);
  });

  test('treble stage: 3 for the treble, nothing for its single or double', () => {
    assert.equal(S.grandTourDartPoints(D(9, 3), treble9), 3);
    assert.equal(S.grandTourDartPoints(D(9, 1), treble9), 0);
    assert.equal(S.grandTourDartPoints(D(9, 2), treble9), 0);
  });

  test('doubles stage: 2 for the double, nothing for its single or treble', () => {
    assert.equal(S.grandTourDartPoints(D(16, 2), double16), 2);
    assert.equal(S.grandTourDartPoints(D(16, 1), double16), 0);
    assert.equal(S.grandTourDartPoints(D(16, 3), double16), 0);
  });

  test('bull stage: outer bull 2, inner bull 4', () => {
    assert.equal(S.grandTourDartPoints(D(25, 1), bull), 2);
    assert.equal(S.grandTourDartPoints(D(25, 2), bull), 4);
  });

  test('the wrong number, a miss and a bull outside the bull stage are all worth nothing', () => {
    assert.equal(S.grandTourDartPoints(D(8, 1), single7), 0);
    assert.equal(S.grandTourDartPoints(D(0, 1), single7), 0);
    assert.equal(S.grandTourDartPoints(D(25, 2), single7), 0);
    assert.equal(S.grandTourDartPoints(D(20, 3), bull), 0);
  });

  test('a perfect tour is exactly 420', () => {
    let total = 0;
    for (let r = 1; r <= 65; r++) {
      const t = S.grandTourRoundTarget(r);
      const best = t.stage === 'bull' ? D(25, 2) : D(t.sector, t.mult);
      total += 3 * S.grandTourDartPoints(best, t);
    }
    assert.equal(total, S.GRAND_TOUR_MAX_POINTS);
    assert.equal(total, 420);
  });
});

describe('Grand Tour — a visit', () => {
  test('points, hits and the stage tally all move together', () => {
    const p = freshPlayer('Ben');
    const ev = S.evaluateVisitGrandTour(p, [D(7, 1), D(7, 3), D(7, 1)], gameAt(7, [p]));
    assert.equal(ev.scored, 2);
    assert.equal(ev.hits, 2);
    assert.equal(ev.totalPoints, 2);
    assert.deepEqual(ev.tally.single, { hits: 2, darts: 3, points: 2 });
    assert.deepEqual(ev.tally.treble, { hits: 0, darts: 0, points: 0 });
  });

  test('evaluating a visit never mutates the player it was handed (undo depends on it)', () => {
    const p = freshPlayer('Ben');
    const before = JSON.stringify(p);
    S.evaluateVisitGrandTour(p, [D(7, 1), D(7, 1), D(7, 1)], gameAt(7, [p]));
    assert.equal(JSON.stringify(p), before);
  });

  test('a visit of fewer than three darts counts only the darts thrown', () => {
    const p = freshPlayer('Ben');
    const ev = S.evaluateVisitGrandTour(p, [D(25, 2)], gameAt(61, [p]));
    assert.deepEqual(ev.tally.bull, { hits: 1, darts: 1, points: 4 });
  });

  test('a solo tour ends on the 65th visit, and not before', () => {
    const p = freshPlayer('Ben');
    assert.equal(S.evaluateVisitGrandTour(p, [D(25, 1)], gameAt(64, [p])).matchComplete, false);
    const last = S.evaluateVisitGrandTour(p, [D(25, 1)], gameAt(65, [p]));
    assert.equal(last.matchComplete, true);
    assert.equal(last.winnerIndex, 0);
  });

  test('two players: the round only closes once the second player has thrown', () => {
    const a = freshPlayer('Ben'), b = freshPlayer('Sam');
    assert.equal(S.evaluateVisitGrandTour(a, [D(1)], gameAt(1, [a, b], 0)).roundComplete, false);
    assert.equal(S.evaluateVisitGrandTour(b, [D(1)], gameAt(1, [a, b], 1)).roundComplete, true);
    // ...and on round 65 it is the SECOND player's visit that ends the tour.
    assert.equal(S.evaluateVisitGrandTour(a, [D(25)], gameAt(65, [a, b], 0)).matchComplete, false);
    assert.equal(S.evaluateVisitGrandTour(b, [D(25)], gameAt(65, [a, b], 1)).matchComplete, true);
  });
});

describe('Grand Tour — accuracy', () => {
  test('per stage and overall, as hits over darts', () => {
    const tally = S.newGrandTourTally();
    Object.assign(tally.single, { hits: 38, darts: 60 });
    Object.assign(tally.treble, { hits: 11, darts: 60 });
    Object.assign(tally.double, { hits: 14, darts: 60 });
    Object.assign(tally.bull, { hits: 4, darts: 9 });
    assert.equal(Math.round(S.grandTourAccuracy(tally, 'single').pct), 63);
    assert.equal(Math.round(S.grandTourAccuracy(tally, 'bull').pct), 44);
    const all = S.grandTourAccuracy(tally);
    assert.deepEqual([all.hits, all.darts], [67, 189]);
    assert.equal(Math.round(all.pct), 35);
  });

  test('a stage not yet reached is null, not 0% — "not reached" and "missed everything" must differ', () => {
    const tally = S.newGrandTourTally();
    assert.equal(S.grandTourAccuracy(tally, 'treble').pct, null);
    Object.assign(tally.treble, { hits: 0, darts: 3 });
    assert.equal(S.grandTourAccuracy(tally, 'treble').pct, 0);
  });

  test('both bulls count as a hit for accuracy, whatever they score', () => {
    const p = freshPlayer('Ben');
    const ev = S.evaluateVisitGrandTour(p, [D(25, 1), D(25, 2), D(0)], gameAt(61, [p]));
    assert.equal(ev.hits, 2);
    assert.equal(ev.scored, 6);
  });
});

describe('Grand Tour — the two-player result', () => {
  test('most points wins', () => {
    assert.equal(S.grandTourDecideWinnerIndex([{ points: 200, hits: 90 }, { points: 210, hits: 60 }]), 1);
  });
  test('a tie on points goes to the player with more hits', () => {
    // 3 singles and 1 treble are both 3 points — the steadier tour wins.
    assert.equal(S.grandTourDecideWinnerIndex([{ points: 200, hits: 80 }, { points: 200, hits: 81 }]), 1);
  });
  test('a tie on points AND hits goes to whoever threw first — always a winner, never a draw', () => {
    assert.equal(S.grandTourDecideWinnerIndex([{ points: 200, hits: 80 }, { points: 200, hits: 80 }]), 0);
  });
  test('the final visit decides it with the thrower\'s own updated figures', () => {
    // Sam is 2 behind going into the last dart and hits an inner bull (+4).
    const a = Object.assign(freshPlayer('Ben'), { totalPoints: 100 });
    const b = Object.assign(freshPlayer('Sam'), { totalPoints: 98 });
    const ev = S.evaluateVisitGrandTour(b, [D(25, 2)], gameAt(65, [a, b], 1));
    assert.equal(ev.matchComplete, true);
    assert.equal(ev.winnerIndex, 1);
  });
});

describe('Grand Tour — rebuild (what resuming a saved tour replays)', () => {
  // One visit per round, in the order they were thrown.
  function turnsFor(playerIndexes, roundsPlayed, dartsFor) {
    const out = [];
    for (let r = 1; r <= roundsPlayed; r++) {
      for (const pi of playerIndexes) {
        out.push({ playerIndex: pi, setNo: 1, legNo: 1, darts: dartsFor(r, pi) });
      }
    }
    return out;
  }
  // Every dart aims at the round's own bed; the second player misses every third round.
  const bestDarts = (r, pi) => {
    const t = S.grandTourRoundTarget(r);
    const hit = t.stage === 'bull' ? { sector: 25, mult: 1 } : { sector: t.sector, mult: t.mult };
    const miss = { sector: 0, mult: 1 };
    return pi === 1 && r % 3 === 0 ? [miss, miss, miss] : [hit, miss, hit];
  };

  test('a solo tour replays to the same totals the live visits would have produced', () => {
    const turns = turnsFor([0], 30, bestDarts);
    const r = S.rebuildGrandTourState({ names: ['Ben'], turns });
    // 20 single rounds × 2 hits × 1 pt + 10 treble rounds × 2 hits × 3 pts
    assert.equal(r.players[0].totalPoints, 40 + 60);
    assert.deepEqual(r.players[0].tally.single, { hits: 40, darts: 60, points: 40 });
    assert.deepEqual(r.players[0].tally.treble, { hits: 20, darts: 30, points: 60 });
    assert.equal(r.grandTourRound, 31, 'resumes on the next unthrown round');
    assert.equal(r.players[0].gameDarts, 90);
  });

  test('two players mid-round: the next thrower is the one still owed a visit', () => {
    const turns = turnsFor([0, 1], 12, bestDarts);
    turns.push({ playerIndex: 0, setNo: 1, legNo: 1, darts: bestDarts(13, 0) });
    const r = S.rebuildGrandTourState({ names: ['Ben', 'Sam'], turns });
    assert.equal(r.grandTourRound, 13, 'round 13 is still open — Sam has not thrown at it');
    assert.equal(r.current, 1);
    assert.ok(r.players[0].totalPoints > r.players[1].totalPoints);
  });

  test('a finished two-player tour replays to a winner', () => {
    const turns = turnsFor([0, 1], 65, bestDarts);
    const r = S.rebuildGrandTourState({ names: ['Ben', 'Sam'], turns });
    // A tour is one leg of one set, so winning it also completes the set — and the
    // shared leg-win bookkeeping then moves the win into setsWon and zeroes legsWon,
    // exactly as advanceLegSetGame() does live. setsWon is where the result lives.
    assert.equal(r.players[0].setsWon, 1, 'Ben never skipped a round, so Ben wins');
    assert.equal(r.players[1].setsWon, 0);
  });
});
