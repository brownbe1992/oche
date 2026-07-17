'use strict';
// Committed tests for backend/db.js's Dead Man Walking calculations
// (docs/archive/dead-man-walking-roadmap.md, REFERENCE.md's Dead Man Walking section)
// against a scratch SQLite database. Not exhaustive; see db.x01-stats.test.js's
// header comment for the same "focused, not 100% coverage" framing.
//
// Turns here are inserted directly via db.addTurn() WITHOUT
// {enforceConsistency:true} (the established fixture convention across this
// whole test suite — see db.turn-consistency-guard.test.js's own header
// comment) so scored/bust/checkout/target_score can be hand-picked per test
// rather than derived through a legitimate multi-round session.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');
const { checkoutHint } = require(path.join('..', '..', 'frontend', 'scoring.js'));

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

function x01Game(player, startingScore) {
  return db.createGame({
    category: String(startingScore), legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'x01', config: { startingScore }, players: [{ name: player }],
  });
}
function x01Turn(gameId, player, leg, { scored, bust = false, checkout = false, checkoutPoints = null }) {
  db.addTurn(gameId, {
    player, set: 1, leg, scored, bust, checkout, checkoutPoints,
    darts: [{ dartNo: 1, sector: 1, multiplier: 1 }], // placeholder — this query only reads t.scored/t.bust/t.checkout
  });
}
// Builds a leg (in its own dedicated game, one per call — see below) whose
// FINAL turn (the one actually under test) enters with a known `remaining`
// value: an optional setup turn scores exactly (startingScore - remaining) —
// a single real X01 visit can only ever score 0-180, so the smallest valid
// X01 category (101/170/301/501) that keeps that gap within 180 is picked
// automatically — leaving `remaining` for the turn under test. Real X01 leg
// shape, without needing genuine dart arithmetic (this test only exercises
// the reconstruction/aggregation query, not the write-time consistency
// guard, which has its own dedicated test file). A fresh game per call
// (rather than one game with many legs) keeps every leg's own reconstruction
// independent of every other.
//
// The setup turn is itself a real "encounter" the same getWeakestCheckouts()
// query reconstructs too (its own remaining, before any prior turn, is
// exactly `startingScore`) — harmless here: every test below only asserts
// presence/absence/ordering of its OWN deliberately-engineered target
// values, and a setup turn's own remaining is always a DIFFERENT number from
// any of them (the category itself, e.g. 101 or 170 — never 40/45/61, and
// distinguishable from 169/170 by which test uses which category).
// `openingCategory` (default 101) is the caller's EXPLICIT choice of which
// valid X01 category opens this leg — deliberately not auto-selected: this
// query reconstructs and counts THAT opening turn's own remaining (=
// openingCategory itself) as a real "encounter" too, and callers that
// exercise several different target values in the SAME test (e.g. the
// ranking test below, which also asserts a specific value stays UNDER the
// sample floor) need to control exactly which category accumulates that
// incidental pollution, not have it picked for them.
function legAtRemaining(player, remaining, turn2, openingCategory) {
  const startingScore = openingCategory || 101;
  const g = x01Game(player, startingScore);
  if (startingScore > remaining) x01Turn(g.gameId, player, 1, { scored: startingScore - remaining });
  x01Turn(g.gameId, player, 1, turn2);
}

function deadManWalkingGame(player) {
  return db.createGame({
    category: 'Dead Man Walking', legsPerSet: 15, setsPerGame: 1, practice: 1,
    gameType: 'dead_man_walking', players: [{ name: player }],
  });
}
function dmwTurn(gameId, player, leg, targetScore, { darts, scored, bust = false, checkout = false, checkoutPoints = null }) {
  db.addTurn(gameId, {
    player, set: 1, leg, scored, bust, checkout, checkoutPoints, targetScore,
    darts: darts.map(([sector, multiplier], i) => ({ dartNo: i + 1, sector, multiplier })),
  });
}
function routeToDarts(route) {
  return route.split(' ').map(label => {
    if (label === 'Bull') return [25, 2];
    if (label === '25') return [25, 1];
    if (label[0] === 'T') return [Number(label.slice(1)), 3];
    if (label[0] === 'D') return [Number(label.slice(1)), 2];
    return [Number(label), 1];
  });
}
// Plays a full 15-round Dead Man Walking game to completion, walking out
// exactly `walkedOutLegs` (a Set of 1-based round numbers) and Executing
// (via a real bust) every other round. Returns the gameId.
function playFullRun(player, walkedOutLegs) {
  const { gameId, config } = deadManWalkingGame(player);
  config.rounds.forEach((round, i) => {
    const leg = i + 1;
    if (walkedOutLegs.has(leg)) {
      const darts = routeToDarts(checkoutHint(round.target, true, 3));
      dmwTurn(gameId, player, leg, round.target, { darts, scored: round.target, checkout: true, checkoutPoints: round.target });
    } else {
      // A genuine bust: throw enough to overshoot (T20 T20 T20 = 180, always
      // more than any finishable target <= 170).
      dmwTurn(gameId, player, leg, round.target, { darts: [[20, 3], [20, 3], [20, 3]], scored: 0, bust: true });
    }
  });
  db.completeGame(gameId, player);
  return gameId;
}

describe('getWeakestCheckouts', () => {
  test('ranks a genuinely weak number (high bust/non-completion rate) above a strong one, and requires the sample floor', () => {
    const a = 'DMWWeak_A';
    db.addPlayer(a);
    // Target 40 and 61 both open from category 101 EXCLUSIVELY (never 170) —
    // so their own "opening remaining" pollution (16 samples at remaining=101,
    // harmless/unasserted here) never touches remaining=170, which this test
    // separately needs to stay at EXACTLY 3 samples.
    // Target 40: 8 encounters — 4 busts, 3 non-completing continues, 1 completion.
    for (let i = 0; i < 4; i++) legAtRemaining(a, 40, { scored: 0, bust: true }, 101);
    for (let i = 0; i < 3; i++) legAtRemaining(a, 40, { scored: 20 }, 101); // continues, doesn't finish
    legAtRemaining(a, 40, { scored: 40, checkout: true, checkoutPoints: 40 }, 101);
    // Target 61: 8 encounters — 7 completions, 1 continue, 0 busts (a strong number).
    for (let i = 0; i < 7; i++) legAtRemaining(a, 61, { scored: 61, checkout: true, checkoutPoints: 61 }, 101);
    legAtRemaining(a, 61, { scored: 20 }, 101);
    // Target 170: only 3 encounters, all busts — below the sample floor, must
    // be excluded regardless of how bad it looks. Opens from category 170
    // itself (gap=0 -- no separate setup turn at all), so there's no
    // incidental pollution here either.
    for (let i = 0; i < 3; i++) legAtRemaining(a, 170, { scored: 0, bust: true }, 170);

    const pool = db.getWeakestCheckouts(a, 15);
    const targets = pool.map(c => c.target);
    assert.ok(targets.includes(40), '40 has 8 samples with real bust/non-completion signal, should qualify');
    assert.ok(targets.includes(61), '61 has 8 samples too (just a strong number), should still qualify');
    assert.ok(!targets.includes(170), '170 has only 3 samples — below the sample floor, must be excluded');
    assert.ok(pool.findIndex(c => c.target === 40) < pool.findIndex(c => c.target === 61),
      '40 (weaker) must rank above 61 (stronger) — worst-first ordering');
  });

  test('excludes bogey numbers even with plenty of bad-looking samples', () => {
    const a = 'DMWWeak_Bogey';
    db.addPlayer(a);
    assert.equal(checkoutHint(169, true, 3), '', 'sanity: 169 is a genuine double-out bogey number');
    for (let i = 0; i < 10; i++) legAtRemaining(a, 169, { scored: 0, bust: true }, 170);
    const pool = db.getWeakestCheckouts(a, 15);
    assert.ok(!pool.some(c => c.target === 169), '169 can never be served as a round deficit, however weak it looks');
  });

  test('single-out legs never contribute (this drill is always double-out sourced)', () => {
    const a = 'DMWWeak_Single';
    db.addPlayer(a);
    for (let i = 0; i < 10; i++) {
      const g = db.createGame({ category: '101', legsPerSet: 1, setsPerGame: 1, practice: 1,
        gameType: 'x01', config: { startingScore: 101 }, players: [{ name: a, out: 'single' }] });
      x01Turn(g.gameId, a, 1, { scored: 101 - 45 });
      x01Turn(g.gameId, a, 1, { scored: 0, bust: true });
    }
    const pool = db.getWeakestCheckouts(a, 15);
    assert.ok(!pool.some(c => c.target === 45), 'single-out turns must not feed the double-out weakness ranking');
  });

  test('other game types (e.g. this player\'s own Checkout Ladder or Dead Man Walking history) never leak in', () => {
    const a = 'DMWWeak_Other';
    db.addPlayer(a);
    const g = db.createGame({ category: '121 Checkout Ladder', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'checkout_ladder', players: [{ name: a }] });
    for (let leg = 1; leg <= 10; leg++) {
      db.addTurn(g.gameId, { player: a, set: 1, leg, scored: 0, bust: true, checkout: false, checkoutPoints: null,
        targetScore: 55, darts: [{ dartNo: 1, sector: 1, multiplier: 1 }] });
    }
    const pool = db.getWeakestCheckouts(a, 15);
    assert.ok(!pool.some(c => c.target === 55), 'a non-x01 game_type must be scoped out entirely (json_extract startingScore never even matches)');
  });

  test('an unknown player returns an empty pool, not a crash', () => {
    assert.deepEqual(db.getWeakestCheckouts('NoSuchPlayerDMW', 15), []);
  });
});

describe('createGame — Dead Man Walking par calculation (docs/archive/dead-man-walking-roadmap.md "Par")', () => {
  test('uses this player\'s own historical average darts-to-finish for the band, when it clears the objective floor', () => {
    const a = 'DMWPar_A';
    db.addPlayer(a);
    // Weakness signal at target 40 (Low band 32-60) so it's the only entry in
    // the candidate pool — every one of the 15 draws will be exactly 40,
    // making the resulting par fully deterministic to assert on.
    // Split the opening category 4/4 between 101 and 170 -- neither one's own
    // incidental "opening remaining" pollution reaches the 8-sample floor on
    // its own, so 40 stays the ONLY qualifying pool entry.
    for (let i = 0; i < 8; i++) legAtRemaining(a, 40, { scored: 0, bust: true }, i < 4 ? 101 : 170);
    // Separately, 3 WON legs whose checkout value (40) falls in the same Low
    // band, each taking exactly 3 real darts to finish (single20+single10+D5)
    // — average darts-to-finish = 3, comfortably above the objective floor
    // (checkoutHint(40,true,3) is 1 dart optimal, so floor = 1+1 = 2). The
    // par calculation reads `checkout_points` directly (stored explicitly on
    // the checkout turn itself), not the reconstructed remaining the
    // weakness-ranking query above uses — so these can be simple 1-turn legs
    // regardless of what a fresh leg's own "opening remaining" would be.
    for (let i = 0; i < 3; i++) {
      const g = x01Game(a, 101);
      db.addTurn(g.gameId, { player: a, set: 1, leg: 1, scored: 40, bust: false, checkout: true, checkoutPoints: 40,
        darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 10, multiplier: 1 }, { dartNo: 3, sector: 5, multiplier: 2 }] });
    }

    const { config } = db.createGame({
      category: 'Dead Man Walking', legsPerSet: 15, setsPerGame: 1, practice: 1,
      gameType: 'dead_man_walking', players: [{ name: a }],
    });
    assert.ok(config.rounds.every(r => r.target === 40), 'the only qualifying pool entry is 40 -- every round draws it');
    assert.ok(config.rounds.every(r => r.par === 3), `par should be this player's own historical average (3 darts), not the floor (2) or the cold-start default; got ${config.rounds[0].par}`);
  });

  test('falls back to objective-optimal + 2 when there is no history in the band yet', () => {
    const a = 'DMWPar_Cold';
    db.addPlayer(a);
    // No X01 history at all -- cold start, drawing from CHALLENGE_CHECKOUTS.
    const { config } = db.createGame({
      category: 'Dead Man Walking', legsPerSet: 15, setsPerGame: 1, practice: 1,
      gameType: 'dead_man_walking', players: [{ name: a }],
    });
    config.rounds.forEach(r => {
      const optimal = checkoutHint(r.target, true, 3).split(' ').length;
      assert.equal(r.par, optimal + 2, `target ${r.target}: no history -> par should be objective optimal (${optimal}) + 2`);
    });
  });
});

describe('getDeadManWalkingStatBubbles', () => {
  test('runsCompleted/totalWalkedOut/avgWalkedOutPerRun/bustRate/ranOutOfDartsRate/avgMarginOnWalkedOut all reflect a real completed run', () => {
    const a = 'DMWStats_A';
    db.addPlayer(a);
    const { gameId, config } = deadManWalkingGame(a);
    // Round 1: Walked Out with margin (budget - dartsUsed).
    const r1 = config.rounds[0];
    const darts1 = routeToDarts(checkoutHint(r1.target, true, 3));
    dmwTurn(gameId, a, 1, r1.target, { darts: darts1, scored: r1.target, checkout: true, checkoutPoints: r1.target });
    // Round 2: Executed by a genuine bust.
    const r2 = config.rounds[1];
    dmwTurn(gameId, a, 2, r2.target, { darts: [[20, 3], [20, 3], [20, 3]], scored: 0, bust: true });
    // Round 3: Executed by running out of darts (no bust, no checkout) --
    // burn the ENTIRE budget on harmless single-1s that never reach 0.
    const r3 = config.rounds[2];
    const budget3 = r3.par - 1;
    for (let i = 0; i < budget3; i++) {
      dmwTurn(gameId, a, 3, r3.target, { darts: [[1, 1]], scored: 1 });
    }
    // Rounds 4-15: Walked Out (so the game actually completes at round 15).
    for (let i = 3; i < 15; i++) {
      const r = config.rounds[i];
      const darts = routeToDarts(checkoutHint(r.target, true, 3));
      dmwTurn(gameId, a, i + 1, r.target, { darts, scored: r.target, checkout: true, checkoutPoints: r.target });
    }
    db.completeGame(gameId, a);

    const bubbles = db.getDeadManWalkingStatBubbles(a, 'practice');
    assert.equal(bubbles.runsCompleted, 1);
    assert.equal(bubbles.totalWalkedOut, 13, '1 (round 1) + 12 (rounds 4-15) = 13; rounds 2 and 3 both Executed');
    assert.equal(bubbles.avgWalkedOutPerRun, 13);
    assert.ok(Math.abs(bubbles.bustRate - (1 / 15) * 100) < 1e-9, 'exactly 1 of 15 rounds ended in a real bust');
    assert.ok(Math.abs(bubbles.ranOutOfDartsRate - (1 / 15) * 100) < 1e-9, 'exactly 1 of 15 rounds ran out of darts without busting');
    assert.ok(bubbles.avgMarginOnWalkedOut != null && bubbles.avgMarginOnWalkedOut >= 0);
  });

  test('an unknown player returns null', () => {
    assert.equal(db.getDeadManWalkingStatBubbles('NoSuchDMW', 'practice'), null);
  });

  test('a player with no runs gets a zeroed/null bubble set, not a crash', () => {
    const a = 'DMWStats_None';
    db.addPlayer(a);
    const bubbles = db.getDeadManWalkingStatBubbles(a, 'practice');
    assert.equal(bubbles.runsCompleted, 0);
    assert.equal(bubbles.totalWalkedOut, 0);
    assert.equal(bubbles.avgWalkedOutPerRun, null);
    assert.equal(bubbles.bustRate, null);
    assert.equal(bubbles.longestWalkedOutStreak, 0);
  });
});

describe('getDeadManWalkingPersonalBests (mostWalkedOut, a higher-is-better peak)', () => {
  test('takes the best (highest) Walked Out count across multiple completed runs', () => {
    const a = 'DMWPB_A';
    db.addPlayer(a);
    playFullRun(a, new Set([1, 2, 3, 4, 5])); // 5 walked out
    playFullRun(a, new Set(Array.from({ length: 12 }, (_, i) => i + 1))); // 12 walked out -- the peak
    playFullRun(a, new Set([1])); // 1 walked out -- worse, must not overwrite the peak

    const pb = db.getDeadManWalkingPersonalBests(a, 'practice');
    assert.equal(pb.mostWalkedOut, 12);
  });

  test('a player with no completed runs gets a null Personal Best', () => {
    const a = 'DMWPB_None';
    db.addPlayer(a);
    const pb = db.getDeadManWalkingPersonalBests(a, 'practice');
    assert.equal(pb.mostWalkedOut, null);
  });
});

describe('getDeadManWalkingLeaderboard', () => {
  test('one row per player, sorted descending by best-ever Walked Out count, each player\'s own peak run', () => {
    const a = 'DMWBoard_A', b = 'DMWBoard_B';
    db.addPlayer(a); db.addPlayer(b);
    playFullRun(a, new Set([1, 2, 3])); // 3
    playFullRun(b, new Set(Array.from({ length: 10 }, (_, i) => i + 1))); // 10

    const board = db.getDeadManWalkingLeaderboard();
    const rowA = board.find(r => r.name === a);
    const rowB = board.find(r => r.name === b);
    assert.equal(rowA.bestWalkedOut, 3);
    assert.equal(rowB.bestWalkedOut, 10);
    assert.ok(board.indexOf(rowB) < board.indexOf(rowA), 'the higher best-Walked-Out row ranks first');
  });
});

describe('getDeadManWalkingLongestStreak (lifetime, within OR across runs)', () => {
  test('a streak spanning the tail of one run into the head of the next is counted as one continuous streak', () => {
    const a = 'DMWStreak_A';
    db.addPlayer(a);
    // Run 1: Walked Out on rounds 13, 14, 15 (a 3-long streak at the tail).
    playFullRun(a, new Set([13, 14, 15]));
    // Run 2 (created after run 1, so it's later chronologically): Walked Out
    // on rounds 1 and 2 (continuing the streak to 5) before Executing on 3.
    playFullRun(a, new Set([1, 2]));

    const streak = db.getDeadManWalkingLongestStreak(a);
    assert.equal(streak, 5, 'rounds 13,14,15 of run 1 plus rounds 1,2 of run 2 -- 5 consecutive Walked Out rounds, spanning two runs');
  });

  test('a single run\'s own internal streak is found correctly when no cross-run continuation exists', () => {
    const a = 'DMWStreak_B';
    db.addPlayer(a);
    // Walked Out 1,2 (streak 2), Executed 3, Walked Out 4,5,6,7 (streak 4 -- the longest), Executed 8, Walked Out 9.
    playFullRun(a, new Set([1, 2, 4, 5, 6, 7, 9]));
    assert.equal(db.getDeadManWalkingLongestStreak(a), 4);
  });

  test('an unknown player has a streak of 0', () => {
    assert.equal(db.getDeadManWalkingLongestStreak('NoSuchStreakDMW'), 0);
  });
});

describe('Isolation — Dead Man Walking turns never leak into or get corrupted by X01/other game types\' own stats, and vice versa', () => {
  test('a completed Dead Man Walking run does not affect this player\'s X01-ARITHMETIC-scoped stat bubbles/personal bests', () => {
    // Not every X01 Player Profile field is X01-scoped by design — REFERENCE.md
    // documents dartsThrown/avgDartsPerDay/bigFish/fewestDartsCheckout as
    // deliberately "fully global" (any physical dart, or any 170 checkout,
    // counts regardless of game type — see getPlayerStatBubbles()'s own
    // `bigFish`/`JD` comments in backend/db.js). Those are EXPECTED to move
    // when a Dead Man Walking run throws real darts and clears real 170
    // checkouts — that's correct, documented cross-game-type behavior, not a
    // leak. The genuinely X01-ARITHMETIC fields (X01_ONLY/OPENING_CATS/
    // game_type='x01'-scoped) are the real isolation boundary this test proves.
    const a = 'DMWIso_A';
    db.addPlayer(a);
    // Real X01 history first, so there's a baseline to prove is UNCHANGED.
    const gx = x01Game(a, 501);
    x01Turn(gx.gameId, a, 1, { scored: 140 });
    x01Turn(gx.gameId, a, 2, { scored: 100, bust: false });
    // avgDartsPerLeg is deliberately excluded here too — REFERENCE.md groups
    // "Darts/Leg" in the same global "raw darts" bucket as dartsThrown/
    // fewestDartsCheckout (its own JD-based query has no X01_ONLY filter).
    const X01_SCOPED_BUBBLE_FIELDS = ['avg', 'one80s', 'nineDarters',
      'first3avg', 'first9avg', 'avg100plus', 'avg90minus', 'score140pct', 'treblelessPct', 'one80sPerLeg'];
    const X01_SCOPED_PB_FIELDS = ['bestLegAvg', 'bestLeg', 'bestFirst9', 'winStreak', 'recentFormAvg', 'lifetimeAvg'];
    const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));
    const beforeBubbles = pick(db.getPlayerStatBubbles(a, 'practice'), X01_SCOPED_BUBBLE_FIELDS);
    const beforePB = pick(db.getPersonalBests(a, 'practice'), X01_SCOPED_PB_FIELDS);

    playFullRun(a, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])); // a perfect Dead Man Walking run

    const afterBubbles = pick(db.getPlayerStatBubbles(a, 'practice'), X01_SCOPED_BUBBLE_FIELDS);
    const afterPB = pick(db.getPersonalBests(a, 'practice'), X01_SCOPED_PB_FIELDS);
    assert.deepEqual(afterBubbles, beforeBubbles, "a Dead Man Walking run must not change this player's X01-arithmetic stat bubbles");
    assert.deepEqual(afterPB, beforePB, "a Dead Man Walking run must not change this player's X01-arithmetic Personal Bests");
  });

  test('Dead Man Walking\'s own stats never count a player\'s ordinary X01/Checkout Ladder history', () => {
    const a = 'DMWIso_B';
    db.addPlayer(a);
    const gx = x01Game(a, 501);
    x01Turn(gx.gameId, a, 1, { scored: 100, checkout: true, checkoutPoints: 100 });
    const gcl = db.createGame({ category: '121 Checkout Ladder', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'checkout_ladder', players: [{ name: a }] });
    db.addTurn(gcl.gameId, { player: a, set: 1, leg: 1, scored: 121, bust: false, checkout: true, checkoutPoints: 121,
      targetScore: 121, darts: [{ dartNo: 1, sector: 19, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 2, multiplier: 2 }] });

    const bubbles = db.getDeadManWalkingStatBubbles(a, 'practice');
    assert.equal(bubbles.runsCompleted, 0, 'no Dead Man Walking games played yet -- X01/Checkout Ladder history must not count');
    assert.equal(db.getDeadManWalkingLongestStreak(a), 0);
  });
});
