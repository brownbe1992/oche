'use strict';
// Committed tests for backend/db.js's Bob's 27 stat formulas
// (docs/archive/practice-ladders-roadmap.md Part A, REFERENCE.md's Bob's 27
// section) — against a scratch SQLite database. Not exhaustive; see
// db.x01-stats.test.js's header comment for the same "focused, not 100%
// coverage" framing.
//
// Turns here are inserted directly via db.addTurn() WITHOUT
// {enforceConsistency:true} (the established fixture convention across this
// whole test suite — see db.turn-consistency-guard.test.js's own header
// comment) so `scored`/`bust` are supplied as fixed values matching what a
// real run would have produced, computed by hand per test.
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

function bobs27Game(player) {
  return db.createGame({
    category: "Bob's 27", legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'bobs_27', players: [{ name: player }],
  });
}
// darts: array of [sector, mult]. scored is that round's gain (0 for a miss);
// bust marks the fatal round.
function bobs27Turn(gameId, player, set, leg, darts, { scored = 0, bust = false } = {}) {
  db.addTurn(gameId, {
    player, set, leg, scored, bust, checkout: false, checkoutPoints: null,
    darts: darts.map((dd, i) => ({ dartNo: i + 1, sector: dd[0], multiplier: dd[1] })),
  });
}

describe('getBobs27StatBubbles', () => {
  test('runs, survivalRate, avgFinalScore, dartsThrown, doublesHitRate — one survived run, one died run', () => {
    const a = 'Bobs27_Bubbles_A';
    db.addPlayer(a);

    // Run 1: round 1 hits D1 (gain 2, running 29), round 2 misses D2 entirely
    // (running 29-4=25) — 2 rounds played, 4 darts thrown, 1 real double hit.
    const g1 = bobs27Game(a);
    bobs27Turn(g1.gameId, a, 1, 1, [[1, 2]], { scored: 2 });
    bobs27Turn(g1.gameId, a, 1, 1, [[2, 1], [2, 3], [0, 1]], { scored: 0 });
    db.completeGame(g1.gameId, a);

    // Run 2: round 1 misses (running 27-2=25, 1 dart, 0 hits). This is the
    // only round recorded for this run (died or paused — doesn't matter for
    // the stat formula, which only reads recorded turns).
    const g2 = bobs27Game(a);
    bobs27Turn(g2.gameId, a, 1, 1, [[1, 1]], { scored: 0 });
    db.completeGame(g2.gameId, a);

    const bubbles = db.getBobs27StatBubbles(a, 'practice');
    assert.equal(bubbles.runs, 2);
    assert.equal(bubbles.dartsThrown, 5, '4 darts in run 1 + 1 dart in run 2');
    // Run 1 final score: 27 + 2 (round1) - 4 (round2 miss) = 25.
    // Run 2 final score: 27 - 2 (round1 miss) = 25.
    assert.equal(bubbles.avgFinalScore, 25);
    // Doubles hit rate: 1 real double hit (round 1 of run 1) out of 5 darts thrown.
    assert.equal(bubbles.doublesHitRate, (1 / 5) * 100);
  });

  test('survivalRate reflects the bust flag, not the final score sign', () => {
    const a = 'Bobs27_Survival_A';
    db.addPlayer(a);

    // A run that ends in death (bust=1 on its last turn).
    const gDied = bobs27Game(a);
    bobs27Turn(gDied.gameId, a, 1, 1, [[1, 1]], { scored: 0, bust: false }); // 27-2=25
    bobs27Turn(gDied.gameId, a, 1, 1, [[2, 1]], { scored: 0, bust: true }); // pretend fatal for this test
    db.completeGame(gDied.gameId, a);

    // A run with no bust at all (survived, or still in progress).
    const gAlive = bobs27Game(a);
    bobs27Turn(gAlive.gameId, a, 1, 1, [[1, 2]], { scored: 2, bust: false });
    db.completeGame(gAlive.gameId, a);

    const bubbles = db.getBobs27StatBubbles(a, 'practice');
    assert.equal(bubbles.runs, 2);
    assert.equal(bubbles.survivalRate, 50, 'exactly one of the two runs has a bust turn');
  });

  test('returns null bubbles for a player with no runs', () => {
    const a = 'Bobs27_Empty_A';
    db.addPlayer(a);
    const bubbles = db.getBobs27StatBubbles(a, 'practice');
    assert.equal(bubbles.runs, 0);
    assert.equal(bubbles.survivalRate, null);
    assert.equal(bubbles.avgFinalScore, null);
    assert.equal(bubbles.doublesHitRate, null);
  });

  test('unknown player returns null', () => {
    assert.equal(db.getBobs27StatBubbles('Bobs27_Nobody', 'practice'), null);
  });
});

describe('getBobs27PersonalBests', () => {
  test('bestFinalScore is the peak across every run, including a died run scoring higher than a survived one', () => {
    const a = 'Bobs27_PB_A';
    db.addPlayer(a);

    // Run 1: two hits, final score 27+2+4=33, no death.
    const g1 = bobs27Game(a);
    bobs27Turn(g1.gameId, a, 1, 1, [[1, 2]], { scored: 2 });
    bobs27Turn(g1.gameId, a, 1, 1, [[2, 2]], { scored: 4 });
    db.completeGame(g1.gameId, a);

    // Run 2: one big hit then dies — still ends higher than run 1's total
    // isn't the point here, just confirms MAX(), not "last run" or "first run".
    const g2 = bobs27Game(a);
    bobs27Turn(g2.gameId, a, 1, 1, [[1, 2]], { scored: 2 }); // 27+2=29
    bobs27Turn(g2.gameId, a, 1, 1, [[2, 2]], { scored: 4 }); // 29+4=33
    bobs27Turn(g2.gameId, a, 1, 1, [[3, 2]], { scored: 6 }); // 33+6=39
    db.completeGame(g2.gameId, a);

    const pb = db.getBobs27PersonalBests(a, 'practice');
    assert.equal(pb.bestFinalScore, 39);
  });

  test('deepestDoubleOnFail only considers runs that actually have a bust turn', () => {
    const a = 'Bobs27_PB_Fail_A';
    db.addPlayer(a);

    // Run 1: dies on round 3 (3 rounds recorded, last one bust=1).
    const g1 = bobs27Game(a);
    bobs27Turn(g1.gameId, a, 1, 1, [[1, 1]], { scored: 0 });
    bobs27Turn(g1.gameId, a, 1, 1, [[2, 1]], { scored: 0 });
    bobs27Turn(g1.gameId, a, 1, 1, [[3, 1]], { scored: 0, bust: true });
    db.completeGame(g1.gameId, a);

    // Run 2: survives further before dying, on round 6.
    const g2 = bobs27Game(a);
    for (let round = 1; round <= 5; round++) {
      bobs27Turn(g2.gameId, a, 1, 1, [[round, 1]], { scored: 0 });
    }
    bobs27Turn(g2.gameId, a, 1, 1, [[6, 1]], { scored: 0, bust: true });
    db.completeGame(g2.gameId, a);

    // Run 3: no death at all (still positive, no bust) — must not count toward "deepest on a fail".
    const g3 = bobs27Game(a);
    bobs27Turn(g3.gameId, a, 1, 1, [[1, 2]], { scored: 2 });
    db.completeGame(g3.gameId, a);

    const pb = db.getBobs27PersonalBests(a, 'practice');
    assert.equal(pb.deepestDoubleOnFail, 6, 'the deeper of the two failed runs (round 6), run 3 excluded entirely');
  });

  test('returns nulls for a player with no runs', () => {
    const a = 'Bobs27_PB_Empty_A';
    db.addPlayer(a);
    const pb = db.getBobs27PersonalBests(a, 'practice');
    assert.equal(pb.bestFinalScore, null);
    assert.equal(pb.deepestDoubleOnFail, null);
  });
});

describe('getBobs27Leaderboard', () => {
  test('ranks players by their own single best-ever run, descending, no minimum-runs floor', () => {
    const a = 'Bobs27_LB_A', b = 'Bobs27_LB_B';
    db.addPlayer(a); db.addPlayer(b);

    // A: one run, final score 27+2=29.
    const gA = bobs27Game(a);
    bobs27Turn(gA.gameId, a, 1, 1, [[1, 2]], { scored: 2 });
    db.completeGame(gA.gameId, a);

    // B: two runs — a low one (25) and a high one (27+2+4+6=39) — leaderboard
    // must take B's PEAK, not their average or most recent.
    const gB1 = bobs27Game(b);
    bobs27Turn(gB1.gameId, b, 1, 1, [[1, 1]], { scored: 0 }); // 27-2=25
    db.completeGame(gB1.gameId, b);
    const gB2 = bobs27Game(b);
    bobs27Turn(gB2.gameId, b, 1, 1, [[1, 2]], { scored: 2 });
    bobs27Turn(gB2.gameId, b, 1, 1, [[2, 2]], { scored: 4 });
    bobs27Turn(gB2.gameId, b, 1, 1, [[3, 2]], { scored: 6 });
    db.completeGame(gB2.gameId, b);

    const board = db.getBobs27Leaderboard();
    const rowA = board.find(r => r.name === a);
    const rowB = board.find(r => r.name === b);
    assert.equal(rowA.bestScore, 29);
    assert.equal(rowB.bestScore, 39);
    // Descending order: B (39) ranks above A (29).
    assert.ok(board.indexOf(rowB) < board.indexOf(rowA));
  });
});

// Run-level aggregates require g.completed_at IS NOT NULL: a paused/abandoned/
// in-progress run has no bust row simply because it hasn't died YET, and
// counting it as a survived run with its partial total made survival rate
// gameable (abandon bad runs early) and let mid-run totals top the high-score
// table. Only the dart-level Doubles Hit % keeps counting every dart thrown.
describe('incomplete runs are excluded from run-level aggregates', () => {
  test('an uncompleted run counts toward dartsThrown but not runs/survival/avg/best/leaderboard', () => {
    const a = 'Bobs27_Incomplete_A';
    db.addPlayer(a);

    // A completed, survived run: D1 hit (+2), completed.
    const gDone = bobs27Game(a);
    bobs27Turn(gDone.gameId, a, 1, 1, [[1, 2]], { scored: 2 });
    db.completeGame(gDone.gameId, a);

    // An in-progress/abandoned run with a huge partial total — never completed.
    const gOpen = bobs27Game(a);
    bobs27Turn(gOpen.gameId, a, 1, 1, [[1, 2], [1, 2], [1, 2]], { scored: 6 });
    // (no completeGame — the player quit here)

    const bubbles = db.getBobs27StatBubbles(a, 'practice');
    assert.equal(bubbles.runs, 1, 'only the completed run counts');
    assert.equal(bubbles.survivalRate, 100, 'the abandoned run neither survives nor dies');
    assert.equal(bubbles.avgFinalScore, 29, "the completed run's 27+2, not dragged by the partial 33");
    assert.equal(bubbles.dartsThrown, 4, 'darts thrown still counts every real dart (1 + 3)');

    const pbs = db.getBobs27PersonalBests(a, 'practice');
    assert.equal(pbs.bestFinalScore, 29, "the abandoned run's partial 33 can't be a best");

    const board = db.getBobs27Leaderboard();
    const row = board.find(r => r.name === a);
    assert.equal(row.bestScore, 29, 'the high-score table ignores the incomplete run');
  });
});
