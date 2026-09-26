'use strict';
// Grand Tour's backend: the per-visit consistency guard in addTurn(), the Player
// Profile stat bubbles and personal bests, the Home leaderboard, and the
// saved-game position summary.
//
// Every expected number below is worked out by hand from the scripted tour, not
// recomputed with the scoring functions under test — a test that asks the code
// what the answer is can only ever agree with it.
//
// THE SCRIPTED TOUR (one player, every visit three darts):
//   Singles  S1-S20  [single, single, TREBLE]  2 hits, 2 pts a visit  → 40 hits, 40 pts
//            (the treble of the target is deliberately in there: in the singles stage
//             it must score nothing and count as a miss)
//   Trebles  T1-T20  [treble, miss, miss]      1 hit,  3 pts a visit  → 20 hits, 60 pts
//   Doubles  D1-D20  [double, double, single]  2 hits, 4 pts a visit  → 40 hits, 80 pts
//   Bull     5 × [inner, outer, miss]          2 hits, 6 pts a visit  → 10 hits, 30 pts
//                                                                   ----------------
//                                                    110 hits of 195 darts, 210 pts
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

const STRICT = { enforceConsistency: true };
const dart = (sector, multiplier = 1) => ({ sector, multiplier });
const MISS = dart(0);

// The scripted visit for tour round 1-65, and what it is worth.
function scriptedVisit(round) {
  if (round <= 20) { const n = round;      return { darts: [dart(n), dart(n), dart(n, 3)], scored: 2 }; }
  if (round <= 40) { const n = round - 20; return { darts: [dart(n, 3), MISS, MISS],       scored: 3 }; }
  if (round <= 60) { const n = round - 40; return { darts: [dart(n, 2), dart(n, 2), dart(n)], scored: 4 }; }
  return { darts: [dart(25, 2), dart(25, 1), MISS], scored: 6 };
}

function newTour(names, { practice = names.length === 1 } = {}) {
  return db.createGame({
    category: 'Grand Tour', legsPerSet: 1, setsPerGame: 1, practice: practice ? 1 : 0,
    gameType: 'grand_tour', players: names.map(name => ({ name })),
  });
}

// Throws `rounds` rounds for every player in turn, through the strict guard.
// `visitFor(round, playerIndex)` may override the scripted visit.
function play(gameId, names, rounds, visitFor = r => scriptedVisit(r)) {
  for (let r = 1; r <= rounds; r++) {
    names.forEach((name, i) => {
      const v = visitFor(r, i);
      db.addTurn(gameId, { player: name, set: 1, leg: 1, scored: v.scored,
        bust: false, checkout: false, checkoutPoints: null,
        darts: v.darts.map((d, k) => ({ dartNo: k + 1, ...d })) }, STRICT);
    });
  }
}

const turn = (name, scored, darts) => ({ player: name, set: 1, leg: 1, scored,
  bust: false, checkout: false, checkoutPoints: null,
  darts: darts.map((d, k) => ({ dartNo: k + 1, ...d })) });

describe('Grand Tour — registry', () => {
  test('it is a known, savable game type', () => {
    assert.ok(db.KNOWN_GAME_TYPES.includes('grand_tour'));
    assert.ok(db.SAVABLE_GAME_TYPES.includes('grand_tour'));
  });
});

describe('Grand Tour — the per-visit guard (the server re-scores every visit)', () => {
  test('a whole scripted tour is accepted, visit by visit', async () => {
    await db.addPlayer('GT_Guard');
    const { gameId } = newTour(['GT_Guard']);
    assert.doesNotThrow(() => play(gameId, ['GT_Guard'], 65));
  });

  test('a treble in the singles stage cannot be claimed as points', async () => {
    await db.addPlayer('GT_Inflate');
    const { gameId } = newTour(['GT_Inflate']);
    assert.throws(() => db.addTurn(gameId, turn('GT_Inflate', 3, [dart(1, 3), MISS, MISS]), STRICT),
      err => err.status === 400 && /Single 1/.test(err.message));
    // ...and the honest claim of 0 for the same darts is accepted.
    assert.doesNotThrow(() => db.addTurn(gameId, turn('GT_Inflate', 0, [dart(1, 3), MISS, MISS]), STRICT));
  });

  test('bust, checkout and legWon are all refused — a points tour has none of them', async () => {
    await db.addPlayer('GT_Flags');
    const { gameId } = newTour(['GT_Flags']);
    for (const flag of ['bust', 'checkout', 'legWon']) {
      assert.throws(() => db.addTurn(gameId, { ...turn('GT_Flags', 0, [MISS]), [flag]: true }, STRICT),
        err => err.status === 400, `${flag}:true must be refused`);
    }
  });

  test('a 66th visit is refused', async () => {
    await db.addPlayer('GT_Extra');
    const { gameId } = newTour(['GT_Extra']);
    play(gameId, ['GT_Extra'], 65);
    assert.throws(() => db.addTurn(gameId, turn('GT_Extra', 0, [MISS]), STRICT),
      err => err.status === 400 && /65 visits/.test(err.message));
  });

  test('two players: each player\'s round is their OWN visit count, not the game\'s', async () => {
    await db.addPlayer('GT_P1'); await db.addPlayer('GT_P2');
    const { gameId } = newTour(['GT_P1', 'GT_P2']);
    db.addTurn(gameId, turn('GT_P1', 1, [dart(1), MISS, MISS]), STRICT);
    // GT_P2's first visit is still round 1 (Single 1), even though the game has
    // already recorded a turn — so a single 1 scores and a single 2 does not.
    assert.throws(() => db.addTurn(gameId, turn('GT_P2', 1, [dart(2), MISS, MISS]), STRICT),
      err => err.status === 400);
    assert.doesNotThrow(() => db.addTurn(gameId, turn('GT_P2', 1, [dart(1), MISS, MISS]), STRICT));
  });
});

describe('Grand Tour — stat bubbles', () => {
  const NAME = 'GT_Stats';
  let practiceBubbles;

  test('a finished practice tour: every figure from the scripted card', async () => {
    await db.addPlayer(NAME);
    const { gameId } = newTour([NAME]);
    play(gameId, [NAME], 65);
    db.completeGame(gameId, NAME);
    practiceBubbles = db.getGrandTourStatBubbles(NAME, 'practice');
    const b = practiceBubbles;
    assert.equal(b.tours, 1);
    assert.equal(b.avgScore, 210);
    assert.equal(b.dartsThrown, 195);
    assert.equal(b.accuracy.toFixed(2), (110 / 195 * 100).toFixed(2));
    assert.equal(b.singlesAccuracy.toFixed(2), (40 / 60 * 100).toFixed(2));
    assert.equal(b.treblesAccuracy.toFixed(2), (20 / 60 * 100).toFixed(2));
    assert.equal(b.doublesAccuracy.toFixed(2), (40 / 60 * 100).toFixed(2));
    assert.equal(b.bullAccuracy.toFixed(2), (10 / 15 * 100).toFixed(2));
  });

  test('a solo tour is never a "win" — the practice win rate is empty, not 100%', () => {
    assert.equal(practiceBubbles.winPct, null);
  });

  test('an unfinished tour adds its darts to accuracy but not to the tour count or average', async () => {
    const { gameId } = newTour([NAME]);
    // Two visits at S1/S2, every dart a miss: 6 more singles darts, 0 hits.
    play(gameId, [NAME], 2, () => ({ darts: [MISS, MISS, MISS], scored: 0 }));
    const b = db.getGrandTourStatBubbles(NAME, 'practice');
    assert.equal(b.tours, 1, 'still one finished tour');
    assert.equal(b.avgScore, 210, 'the partial tour does not drag the average down');
    assert.equal(b.dartsThrown, 201);
    assert.equal(b.singlesAccuracy.toFixed(2), (40 / 66 * 100).toFixed(2));
  });

  test('a player with no tours gets empties, not zeros', async () => {
    await db.addPlayer('GT_Nobody');
    const b = db.getGrandTourStatBubbles('GT_Nobody', 'practice');
    assert.equal(b.tours, 0);
    assert.equal(b.avgScore, null);
    assert.equal(b.accuracy, null);
    assert.equal(b.treblesAccuracy, null);
  });
});

describe('Grand Tour — head-to-head', () => {
  const A = 'GT_H2H_A', B = 'GT_H2H_B';

  test('a two-player tour: the win rate follows the recorded winner, and stays out of practice', async () => {
    await db.addPlayer(A); await db.addPlayer(B);
    const { gameId } = newTour([A, B], { practice: false });
    // A throws the scripted card; B misses every dart.
    play(gameId, [A, B], 65, (r, i) => i === 0 ? scriptedVisit(r) : { darts: [MISS, MISS, MISS], scored: 0 });
    db.completeGame(gameId, A);
    assert.equal(db.getGrandTourStatBubbles(A, 'h2h').winPct, 100);
    assert.equal(db.getGrandTourStatBubbles(B, 'h2h').winPct, 0);
    assert.equal(db.getGrandTourStatBubbles(B, 'h2h').accuracy, 0);
    assert.equal(db.getGrandTourStatBubbles(A, 'practice').tours, 0, 'a head-to-head tour is not a practice tour');
  });
});

describe('Grand Tour — personal bests and the Home leaderboard', () => {
  test('personal bests come from finished tours only', async () => {
    const pb = db.getGrandTourPersonalBests('GT_Stats', 'practice');
    assert.equal(pb.bestScore, 210);
    assert.equal(pb.bestAccuracy.toFixed(2), (110 / 195 * 100).toFixed(2));
    assert.equal(pb.mostTrebles, 20);
    assert.deepEqual(db.getGrandTourPersonalBests('GT_Nobody', 'practice'),
      { bestScore: null, bestAccuracy: null, mostTrebles: null });
  });

  test('the board is split by mode, finished tours only, best first', () => {
    const practice = db.getGrandTourLeaderboard('practice');
    const h2h = db.getGrandTourLeaderboard('h2h');
    const names = rows => rows.map(r => r.name);
    assert.ok(names(practice).includes('GT_Stats'));
    assert.ok(!names(practice).includes('GT_H2H_A'), 'a head-to-head tour is not on the practice board');
    assert.deepEqual(names(h2h).slice(0, 2), ['GT_H2H_A', 'GT_H2H_B']);
    assert.equal(h2h[0].bestScore, 210);
    assert.equal(h2h[1].bestScore, 0);
    for (const board of [practice, h2h]) {
      for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].bestScore >= board[i].bestScore);
    }
    // GT_Guard and GT_Extra finished all 65 visits but their games were never
    // completed, so neither tour is a result.
    assert.ok(!names(practice).includes('GT_Guard'));
  });
});

describe('Grand Tour — saved games', () => {
  test('a paused two-player tour summarises its round and each player\'s total', async () => {
    await db.addPlayer('GT_Save_A'); await db.addPlayer('GT_Save_B');
    const { gameId } = newTour(['GT_Save_A', 'GT_Save_B'], { practice: false });
    play(gameId, ['GT_Save_A', 'GT_Save_B'], 3);
    db.saveGame(gameId);
    const sg = db.getSavedGames().find(s => s.gameId === gameId);
    assert.ok(sg, 'the saved tour is listed');
    assert.equal(sg.position.round, 4, 'three rounds thrown by both, so round 4 is next');
    assert.deepEqual(sg.position.players, [
      { name: 'GT_Save_A', totalPoints: 6 }, { name: 'GT_Save_B', totalPoints: 6 },
    ]);
  });
});
