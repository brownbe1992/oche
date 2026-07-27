'use strict';
// The four solo-run rebuilds replay their dart counters — docs/open-roadmap-items.md
// item 75.
//
// Bob's 27, 121 Checkout Ladder, the Gauntlet and Dead Man Walking used to come back
// from a save with legDarts/setDarts/gameDarts at 0 (and Bob's 27 with an empty round
// card), because their rebuilds replayed the POSITION and nothing else. Persisted
// stats were never wrong — those come from the turns/darts tables server-side — but
// the in-session display and the completion panel's dart figure both read these.
//
// The interesting part, and the reason this is a unit test rather than only a browser
// check, is that `legDarts` means something different in each of the four, and where
// the reset lives is not where you would look for it:
//
//   Bob's 27        one continuous 20-round run, no leg boundary at all
//   Gauntlet        resetPlayerForNextLegGauntlet() is a no-op and nothing else resets
//   Checkout Ladder resets in the ordinary resetPlayerForNextLeg hook, per attempt
//   Dead Man Walking never reaches startNextLeg(); resolveDeadManWalkingRound()
//                   zeroes it, so legDarts is the CURRENT round's darts
//
// That last one was wrong in the first cut of the fix — "no-op leg reset" was read as
// "no per-leg counter" — and the browser check caught it. These cases pin all four.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

// A recorded turn as the resume payload delivers it.
const turn = (darts, extra) => Object.assign({ darts }, extra || {});
const d = (sector, mult) => ({ sector, mult });
const visit = (...ds) => turn(ds);

describe("Bob's 27 replays its darts and its round card", () => {
  test('every dart of the run is counted, all three ways', () => {
    const r = S.rebuildBobs27State({ turns: [visit(d(1, 2), d(1, 2), d(1, 1)),
                                             visit(d(2, 2), d(2, 1), d(2, 1))] });
    assert.equal(r.gameDarts, 6);
    assert.equal(r.setDarts, 6, 'a Bob\'s 27 game is one run — nothing resets');
    assert.equal(r.legDarts, 6);
  });

  test('the round card comes back, which is what the completion panel draws', () => {
    // D1 hit twice = 2 x 2 = 4; D2 missed entirely = the round's penalty path.
    const r = S.rebuildBobs27State({ turns: [visit(d(1, 2), d(1, 2), d(1, 1)),
                                             visit(d(5, 1), d(5, 1), d(5, 1))] });
    assert.deepEqual(Object.keys(r.roundResults), ['1', '2'],
      'one entry per round played — a blank card is what the bug looked like');
    assert.equal(r.roundResults[1], 4, 'two D1 hits');
    assert.equal(r.roundResults[2], 0, 'no D2 hit');
  });

  test('an empty run is zero, not undefined', () => {
    const r = S.rebuildBobs27State({ turns: [] });
    assert.deepEqual([r.legDarts, r.setDarts, r.gameDarts], [0, 0, 0]);
    assert.deepEqual(r.roundResults, {});
  });
});

describe('the Gauntlet counts the whole run', () => {
  test('nothing resets, so all three are the run total', () => {
    const t = (station, scored) => ({ targetScore: station, scored, darts: [d(20, 1), d(20, 3), d(20, 2)] });
    const r = S.rebuildGauntletState({ turns: [t(20, 3), t(19, 3)] });
    assert.equal(r.gameDarts, 6);
    assert.equal(r.setDarts, 6);
    assert.equal(r.legDarts, 6, 'resetPlayerForNextLegGauntlet() is genuinely a no-op');
  });
});

describe('the 121 Checkout Ladder counts the current ATTEMPT separately', () => {
  test('an unresolved attempt reports only its own darts as legDarts', () => {
    // Leg 1: one visit that neither wins nor exhausts the 3-visit cap.
    const r = S.rebuildCheckoutLadderState({ turns: [
      Object.assign(visit(d(20, 1), d(20, 1)), { legNo: 1 }),
    ] });
    assert.equal(r.gameDarts, 2);
    assert.equal(r.legDarts, 2, 'the attempt is still in progress');
  });

  test('a resolved attempt leaves the next one starting from zero', () => {
    // Leg 1 checked out (121 = T20 T11 D14 -> 60+33+28); leg 2 not started.
    const r = S.rebuildCheckoutLadderState({ turns: [
      Object.assign(visit(d(20, 3), d(11, 3), d(14, 2)), { legNo: 1 }),
    ] });
    assert.equal(r.gameDarts, 3, 'the game total keeps every dart');
    assert.equal(r.legDarts, 0, 'but the new attempt has thrown none');
    assert.equal(r.legNo, 2);
  });

  test('the game total spans attempts while legDarts does not', () => {
    const r = S.rebuildCheckoutLadderState({ turns: [
      Object.assign(visit(d(20, 3), d(11, 3), d(14, 2)), { legNo: 1 }),   // resolved
      Object.assign(visit(d(20, 1)), { legNo: 2 }),                        // in progress
    ] });
    assert.equal(r.gameDarts, 4);
    assert.equal(r.setDarts, 4);
    assert.equal(r.legDarts, 1);
  });
});

describe('Dead Man Walking counts the current ROUND', () => {
  const rounds = [{ target: 40, par: 3 }, { target: 60, par: 4 }, { target: 80, par: 4 }];

  test("legDarts tracks the round in progress, not the whole run", () => {
    // Round 1 walked out on D20; round 2 then has one dart thrown at it.
    const r = S.rebuildDeadManWalkingState({ rounds, turns: [
      visit(d(20, 2)),
      visit(d(20, 1)),
    ] });
    assert.equal(r.gameDarts, 2, 'every dart of the run');
    assert.equal(r.setDarts, 2);
    assert.equal(r.legDarts, r.dartsUsedThisRound,
      'legDarts is the current round — resolveDeadManWalkingRound() zeroes it, not resetForNextLeg');
  });

  test('a run with nothing thrown yet is zero everywhere', () => {
    const r = S.rebuildDeadManWalkingState({ rounds, turns: [] });
    assert.deepEqual([r.legDarts, r.setDarts, r.gameDarts], [0, 0, 0]);
  });
});

describe('countTurnDarts()', () => {
  test('a turn with no darts contributes nothing rather than throwing', () => {
    // A Checkout Trainer declaration is the real case: the one turn shape in the
    // schema allowed to carry zero dart rows.
    const r = S.rebuildBobs27State({ turns: [visit(d(1, 2)), turn([]), visit(d(2, 2))] });
    assert.equal(r.gameDarts, 2);
  });
});
