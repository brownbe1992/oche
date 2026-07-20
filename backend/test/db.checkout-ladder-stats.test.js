'use strict';
// Committed tests for backend/db.js's 121 Checkout Ladder stat formulas
// (docs/archive/practice-ladders-roadmap.md Part B, REFERENCE.md's Checkout Ladder
// section) — against a scratch SQLite database. Not exhaustive; see
// db.x01-stats.test.js's header comment for the same "focused, not 100%
// coverage" framing.
//
// Turns here are inserted directly via db.addTurn() WITHOUT
// {enforceConsistency:true} (the established fixture convention across this
// whole test suite — see db.turn-consistency-guard.test.js's own header
// comment) so target_score/checkout/darts can be hand-picked per test rather
// than derived through a legitimate multi-attempt ladder climb.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

function checkoutLadderGame(player) {
  return db.createGame({
    category: '121 Checkout Ladder', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'checkout_ladder', players: [{ name: player }],
  });
}
// darts: array of [sector, mult]. Every field defaults to a plain non-finishing
// visit unless overridden — callers only need to spell out what matters for
// the case at hand.
function checkoutLadderTurn(gameId, player, leg, darts, { scored, bust = false, checkout = false, checkoutPoints = null, targetScore } = {}) {
  db.addTurn(gameId, {
    player, set: 1, leg, scored, bust, checkout, checkoutPoints, targetScore,
    darts: darts.map((dd, i) => ({ dartNo: i + 1, sector: dd[0], multiplier: dd[1] })),
  });
}

describe('getCheckoutLadderStatBubbles', () => {
  test('attempts, successRate, dartsThrown across two games; currentPosition reflects only the latest game', () => {
    const a = 'CLStats_A';
    db.addPlayer(a);

    // Game 1: leg 1 wins at 121 (T19 T20 D2, 3 darts); leg 2 fails at 122
    // (3 visits of 1 dart each, no checkout).
    const g1 = checkoutLadderGame(a);
    checkoutLadderTurn(g1.gameId, a, 1, [[19, 3], [20, 3], [2, 2]], { scored: 121, checkout: true, checkoutPoints: 121, targetScore: 121 });
    checkoutLadderTurn(g1.gameId, a, 2, [[1, 1]], { scored: 1, targetScore: 122 });
    checkoutLadderTurn(g1.gameId, a, 2, [[1, 1]], { scored: 1, targetScore: 122 });
    checkoutLadderTurn(g1.gameId, a, 2, [[1, 1]], { scored: 1, targetScore: 122 });

    // Game 2 (temporally later, higher game_id): leg 1 wins at 121 again (3 darts).
    const g2 = checkoutLadderGame(a);
    checkoutLadderTurn(g2.gameId, a, 1, [[19, 3], [20, 3], [2, 2]], { scored: 121, checkout: true, checkoutPoints: 121, targetScore: 121 });

    const bubbles = db.getCheckoutLadderStatBubbles(a, 'practice');
    assert.equal(bubbles.attempts, 3, '2 attempts in game 1 + 1 in game 2');
    assert.equal(bubbles.successRate, (2 / 3) * 100, '2 wins out of 3 attempts');
    assert.equal(bubbles.dartsThrown, 9, '3 + 3 + 3');
    assert.equal(bubbles.currentPosition, 122, "only game 2's own history counts — a single win climbs 121 to 122");
  });

  test('a player with no checkout ladder history gets a zeroed/null bubble set, not a crash', () => {
    const a = 'CLStats_None';
    db.addPlayer(a);
    const bubbles = db.getCheckoutLadderStatBubbles(a, 'practice');
    assert.equal(bubbles.attempts, 0);
    assert.equal(bubbles.successRate, null);
    assert.equal(bubbles.currentPosition, null);
    assert.equal(bubbles.dartsThrown, 0);
  });

  test('an unknown player name returns null', () => {
    assert.equal(db.getCheckoutLadderStatBubbles('NoSuchPlayerCL', 'practice'), null);
  });
});

describe('getCheckoutLadderPersonalBests', () => {
  test('highestTargetReached counts a failed peak attempt; fewestDartsOnHighestCheckout only looks at the highest WON target', () => {
    const a = 'CLPB_A';
    db.addPlayer(a);
    const g = checkoutLadderGame(a);
    // leg 1: win at 121 (3 darts).
    checkoutLadderTurn(g.gameId, a, 1, [[19, 3], [20, 3], [2, 2]], { scored: 121, checkout: true, checkoutPoints: 121, targetScore: 121 });
    // leg 2: FAIL at 122 — the highest target ever reached, but never checked out.
    checkoutLadderTurn(g.gameId, a, 2, [[1, 1]], { scored: 1, targetScore: 122 });
    checkoutLadderTurn(g.gameId, a, 2, [[1, 1]], { scored: 1, targetScore: 122 });
    checkoutLadderTurn(g.gameId, a, 2, [[1, 1]], { scored: 1, targetScore: 122 });
    // leg 3: win at 121 again (a different 3-dart route).
    checkoutLadderTurn(g.gameId, a, 3, [[15, 3], [16, 3], [2, 2]], { scored: 121, checkout: true, checkoutPoints: 121, targetScore: 121 });

    const pb = db.getCheckoutLadderPersonalBests(a, 'practice');
    assert.equal(pb.highestTargetReached, 122, 'the failed 122 attempt still counts as reached');
    assert.equal(pb.fewestDartsOnHighestCheckout, 3, 'both wins at the highest WON target (121) took 3 darts');
  });

  test('fewestDartsOnHighestCheckout picks the minimum dart count among multiple wins at the same peak target', () => {
    const a = 'CLPB_B';
    db.addPlayer(a);
    const g = checkoutLadderGame(a);
    checkoutLadderTurn(g.gameId, a, 1, [[7, 3], [20, 2]], { scored: 61, checkout: true, checkoutPoints: 61, targetScore: 61 }); // T7+D20, 2 darts
    checkoutLadderTurn(g.gameId, a, 2, [[5, 1], [16, 1], [20, 2]], { scored: 61, checkout: true, checkoutPoints: 61, targetScore: 61 }); // 5+16+D20, 3 darts

    const pb = db.getCheckoutLadderPersonalBests(a, 'practice');
    assert.equal(pb.highestTargetReached, 61);
    assert.equal(pb.fewestDartsOnHighestCheckout, 2, 'the 2-dart finish beats the 3-dart finish at the same target');
  });

  test('a player with no checkout ladder history gets null fields, not a crash', () => {
    const a = 'CLPB_None';
    db.addPlayer(a);
    const pb = db.getCheckoutLadderPersonalBests(a, 'practice');
    assert.equal(pb.highestTargetReached, null);
    assert.equal(pb.fewestDartsOnHighestCheckout, null);
  });
});

describe('getCheckoutLadderLeaderboard', () => {
  test('one row per player, sorted descending by best target ever reached', () => {
    const a = 'CLBoard_A', b = 'CLBoard_B';
    db.addPlayer(a); db.addPlayer(b);
    const ga = checkoutLadderGame(a);
    checkoutLadderTurn(ga.gameId, a, 1, [[1, 1]], { scored: 1, targetScore: 130 });
    const gb = checkoutLadderGame(b);
    checkoutLadderTurn(gb.gameId, b, 1, [[1, 1]], { scored: 1, targetScore: 150 });

    const board = db.getCheckoutLadderLeaderboard();
    const rowA = board.find(r => r.name === a);
    const rowB = board.find(r => r.name === b);
    assert.equal(rowA.bestTarget, 130);
    assert.equal(rowB.bestTarget, 150);
    assert.ok(board.indexOf(rowB) < board.indexOf(rowA), 'the higher best-target row ranks first');
  });
});

// An attempt only counts once it's RESOLVED — won, or all 3 visits used
// (`a.won || a.visits >= 3`, the same check rebuildCheckoutLadderState()
// applies). A still-in-progress attempt (1-2 visits, no checkout — permanently
// so for a paused/abandoned game) previously counted as a completed failure:
// currentPosition dropped a rung early and attempts/successRate inflated.
describe('unresolved attempts are excluded until they resolve', () => {
  test('a 1-visit attempt with no checkout does not count or move the ladder', () => {
    const a = 'CLStats_Unresolved_A';
    db.addPlayer(a);

    const g = checkoutLadderGame(a);
    // Leg 1: resolved win at 121 -> position climbs to 122.
    checkoutLadderTurn(g.gameId, a, 1, [[19, 3], [20, 3], [2, 2]], { scored: 121, checkout: true, checkoutPoints: 121, targetScore: 121 });
    // Leg 2: ONE visit at 122, no checkout — unresolved (2 visits still available).
    checkoutLadderTurn(g.gameId, a, 2, [[1, 1]], { scored: 1, targetScore: 122 });

    const bubbles = db.getCheckoutLadderStatBubbles(a, 'practice');
    assert.equal(bubbles.attempts, 1, 'the unresolved attempt is not yet an attempt');
    assert.equal(bubbles.successRate, 100, 'not yet a failure either');
    assert.equal(bubbles.currentPosition, 122,
      'the ladder stays at the rung the unresolved attempt is being thrown at (not dropped to 121)');
  });
});
