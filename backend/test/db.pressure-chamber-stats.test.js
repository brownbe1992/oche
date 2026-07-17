'use strict';
// Committed tests for backend/db.js's Pressure Chamber stat formulas
// (REFERENCE.md "Pressure Chamber stats", docs/archive/pressure-chamber-roadmap.md)
// against a scratch SQLite database. Not exhaustive; see
// db.x01-stats.test.js's header comment for the same "focused, not 100%
// coverage" framing.
//
// A run's total CP is NOT a plain SUM(scored) -- it's SUM(scored) MINUS a
// derived total miss penalty (every bust=1 turn's own card, re-rolled via
// generatePressureCard(), never stored) -- so these tests always derive the
// EXPECTED scored/missPenalty from the real gameId's own card sequence via
// computePressureRoundResult(), never hand-picked placeholder numbers, to
// keep the fixtures honest about what the engine would actually produce.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');
const { generatePressureCard, computePressureRoundResult, pressureComposureRating, makeDartCore,
  PRESSURE_RING_MULT, PRESSURE_ROUNDS: MAX_ROUNDS } = require(path.join('..', '..', 'frontend', 'scoring.js'));

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

function pcGame(players) {
  return db.createGame({
    category: 'Pressure Chamber', legsPerSet: 1, setsPerGame: 1, practice: 0,
    gameType: 'pressure_chamber', config: { rounds: MAX_ROUNDS },
    players: players.map(name => ({ name })),
  });
}
// Records round `round` for `player` as a genuine full hit on that round's
// own card (sector target: the exact ring; finish target: the shortest legal
// double-out route this file knows how to construct for the curated pool's
// own finish scores -- 40/81/121, all reachable, so a full hit is always
// constructible for every pool entry).
function fullHitDarts(target) {
  if (target.type === 'sector') {
    return [{ dartNo: 1, sector: target.sector, multiplier: PRESSURE_RING_MULT[target.ring] }];
  }
  // Finish targets in PRESSURE_TARGET_POOL: 40 (D20), 81 (T15+D18, i.e.
  // 45+36), 121 (T20+T11+D14, i.e. 60+33+28). Hand-picked legal double-out
  // routes -- not the objectively optimal route in every case, just A legal
  // one, since gradePressureRoundResult only cares whether it's a legal finish.
  if (target.score === 40) return [{ dartNo: 1, sector: 20, multiplier: 2 }];
  if (target.score === 81) return [{ dartNo: 1, sector: 15, multiplier: 3 }, { dartNo: 2, sector: 18, multiplier: 2 }];
  if (target.score === 121) return [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 11, multiplier: 3 }, { dartNo: 3, sector: 14, multiplier: 2 }];
  throw new Error(`fullHitDarts: no known route for finish score ${target.score}`);
}
const missDarts = [{ dartNo: 1, sector: 0, multiplier: 1 }];

// Records round `round` (1-indexed, must be the player's own next round) as
// either a full hit or a genuine miss, deriving scored/bust/checkout/legWon
// from the SAME engine functions the real write path uses -- never hand-typed.
function pcRound(gameId, player, round, outcome) {
  const card = generatePressureCard(gameId, round);
  const darts = outcome === 'full' ? fullHitDarts(card.target) : missDarts;
  const dartsCore = darts.map(d => makeDartCore(d.sector, d.multiplier));
  const result = computePressureRoundResult(card, dartsCore);
  db.addTurn(gameId, {
    player, set: 1, leg: 1, scored: result.gained,
    bust: result.outcome === 'miss', checkout: result.outcome !== 'miss', legWon: result.outcome === 'full',
    checkoutPoints: null, darts,
  });
  return { card, result };
}

describe('getPressureChamberStatBubbles', () => {
  test('dartsThrown, fullHitRate, partialHitRate, gamesPlayed, winPct, runsCompleted, avgCp', () => {
    const a = 'PC_Bubbles_A', b = 'PC_Bubbles_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    // a: round 1 full hit, round 2 miss, opponent b just misses every round too.
    const r1 = pcRound(g.gameId, a, 1, 'full');
    const r2 = pcRound(g.gameId, a, 2, 'miss');
    pcRound(g.gameId, b, 1, 'miss');
    pcRound(g.gameId, b, 2, 'miss');
    db.completeGame(g.gameId, a);

    const bubbles = db.getPressureChamberStatBubbles(a, 'h2h');
    assert.equal(bubbles.dartsThrown, fullHitDarts(r1.card.target).length + missDarts.length);
    assert.equal(bubbles.fullHitRate, 50, '1 of 2 rounds was a full hit');
    assert.equal(bubbles.partialHitRate, 0);
    assert.equal(bubbles.gamesPlayed, 1);
    assert.equal(bubbles.winPct, 100);
    assert.equal(bubbles.runsCompleted, 1);
    const expectedTotal = r1.result.gained - r2.result.missPenalty;
    assert.equal(bubbles.avgCp, expectedTotal);
  });

  test('a partial hit (sector right, ring wrong) counts toward partialHitRate, not fullHitRate', () => {
    const a = 'PC_Partial_A', b = 'PC_Partial_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    // Manually construct a genuine partial: hit the target sector but the
    // wrong ring, deriving the expected result via the real engine.
    const card = generatePressureCard(g.gameId, 1);
    // Force a sector target by scanning forward if round 1 happens to be a
    // finish target -- burn miss rounds until a sector round is found.
    let round = 1, c = card;
    while (c.target.type !== 'sector' && round <= MAX_ROUNDS) {
      pcRound(g.gameId, a, round, 'miss');
      round += 1;
      c = generatePressureCard(g.gameId, round);
    }
    const wrongRingMult = PRESSURE_RING_MULT[c.target.ring] === 1 ? 2 : 1;
    const partialDarts = [{ dartNo: 1, sector: c.target.sector, multiplier: wrongRingMult }];
    const dartsCore = partialDarts.map(d => makeDartCore(d.sector, d.multiplier));
    const result = computePressureRoundResult(c, dartsCore);
    assert.equal(result.outcome, 'partial', 'sanity: this really is a partial per the engine');
    db.addTurn(g.gameId, { player: a, set: 1, leg: 1, scored: result.gained, bust: false, checkout: true, legWon: false, checkoutPoints: null, darts: partialDarts });
    pcRound(g.gameId, b, 1, 'miss');
    db.completeGame(g.gameId, a);

    const bubbles = db.getPressureChamberStatBubbles(a, 'h2h');
    assert.equal(bubbles.partialHitRate, 100 / (round), `1 partial out of ${round} total rounds played`);
    assert.equal(bubbles.fullHitRate, 0);
  });
});

describe('getPressureChamberPersonalBests', () => {
  test('bestRunCp is a peak (no minimum floor), bestRating derives from it, longestFullHitStreak from the run\'s own peak streak', () => {
    const a = 'PC_PB_A', b = 'PC_PB_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    // Three full hits in a row for a, then a miss -- streak should be 3, not 4.
    const r1 = pcRound(g.gameId, a, 1, 'full');
    const r2 = pcRound(g.gameId, a, 2, 'full');
    const r3 = pcRound(g.gameId, a, 3, 'full');
    const r4 = pcRound(g.gameId, a, 4, 'miss');
    pcRound(g.gameId, b, 1, 'miss'); pcRound(g.gameId, b, 2, 'miss');
    pcRound(g.gameId, b, 3, 'miss'); pcRound(g.gameId, b, 4, 'miss');
    db.completeGame(g.gameId, a);

    const pb = db.getPressureChamberPersonalBests(a, 'h2h');
    const expectedTotal = r1.result.gained + r2.result.gained + r3.result.gained - r4.result.missPenalty;
    assert.equal(pb.bestRunCp, expectedTotal);
    assert.equal(pb.bestRating, pressureComposureRating(expectedTotal));
    assert.equal(pb.longestFullHitStreak, 3);
  });

  test('an abandoned (never-completed) run contributes nothing, even a huge lead', () => {
    const a = 'PC_Abandoned_A', b = 'PC_Abandoned_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    pcRound(g.gameId, a, 1, 'full');
    pcRound(g.gameId, b, 1, 'miss');
    // never completed
    const pb = db.getPressureChamberPersonalBests(a, 'h2h');
    assert.equal(pb.bestRunCp, null);
    assert.equal(pb.bestRating, null);
    assert.equal(pb.longestFullHitStreak, null);
  });
});

describe('getPressureChamberBestCpLeaderboard', () => {
  test('one row per player, their peak run total across both won and lost runs, with the matching rating', () => {
    const a = 'PC_Peak_A', b = 'PC_Peak_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    const ra = pcRound(g.gameId, a, 1, 'full');
    const rb = pcRound(g.gameId, b, 1, 'miss');
    db.completeGame(g.gameId, a);

    const rows = db.getPressureChamberBestCpLeaderboard('h2h');
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[a].total, ra.result.gained);
    assert.equal(byName[a].rating, pressureComposureRating(ra.result.gained));
    assert.equal(byName[b].total, -rb.result.missPenalty, 'a peak total is tracked even for a run that was ultimately lost, including a negative one');
  });
});

describe('getPressureChamberWinLeaderboard', () => {
  test('rate = won/played*100, H2H only, no mode param', () => {
    const p1 = 'PC_WinBoard_P1', p2 = 'PC_WinBoard_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g1 = pcGame([p1, p2]); db.completeGame(g1.gameId, p1);
    const g2 = pcGame([p1, p2]); db.completeGame(g2.gameId, p2);
    const rows = db.getPressureChamberWinLeaderboard();
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[p1].played, 2);
    assert.equal(byName[p1].won, 1);
    assert.equal(byName[p1].rate, 50);
  });
});

// Honesty% (docs/archive/pressure-chamber-roadmap.md build-order step 10): of every round
// where the player made a before-the-throw self-declaration, what % matched the
// round's real hit/miss outcome. A declared hit is honest iff the round checked out
// (full OR partial); a declared miss is honest iff the round busted. Informational
// only, never a scoring input — verified here against hand-known declarations.
describe('getPressureChamberStatBubbles — Honesty% (item 32)', () => {
  // Records a round the same engine-derived way pcRound does, but with an explicit
  // self-declaration attached (declaredHit: 1 = called a hit, 0 = called a miss).
  function pcRoundDeclared(gameId, player, round, outcome, declaredHit) {
    const card = generatePressureCard(gameId, round);
    const darts = outcome === 'full' ? fullHitDarts(card.target) : missDarts;
    const result = computePressureRoundResult(card, darts.map(d => makeDartCore(d.sector, d.multiplier)));
    db.addTurn(gameId, {
      player, set: 1, leg: 1, scored: result.gained,
      bust: result.outcome === 'miss', checkout: result.outcome !== 'miss', legWon: result.outcome === 'full',
      checkoutPoints: null, declaredHit, darts,
    });
    return result;
  }

  test('honestyPct is null until a declaration has been made, and ignores un-declared rounds', () => {
    const a = 'PC_Honesty_None_A', b = 'PC_Honesty_None_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    // a plays rounds with NO declaration at all — honestyPct must stay null.
    pcRound(g.gameId, a, 1, 'full');
    pcRound(g.gameId, a, 2, 'miss');
    pcRound(g.gameId, b, 1, 'miss'); pcRound(g.gameId, b, 2, 'miss');
    db.completeGame(g.gameId, a);
    const bubbles = db.getPressureChamberStatBubbles(a, 'h2h');
    assert.equal(bubbles.declaredRounds, 0);
    assert.equal(bubbles.honestyPct, null);
  });

  test('honest declarations (hit→checkout, miss→bust) score 100%', () => {
    const a = 'PC_Honesty_Perfect_A', b = 'PC_Honesty_Perfect_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    pcRoundDeclared(g.gameId, a, 1, 'full', 1);  // called hit, hit
    pcRoundDeclared(g.gameId, a, 2, 'miss', 0);  // called miss, missed
    pcRound(g.gameId, b, 1, 'miss'); pcRound(g.gameId, b, 2, 'miss');
    db.completeGame(g.gameId, a);
    const bubbles = db.getPressureChamberStatBubbles(a, 'h2h');
    assert.equal(bubbles.declaredRounds, 2);
    assert.equal(bubbles.honestyPct, 100);
  });

  test('a call that contradicts the outcome (declared hit but missed, declared miss but hit) is counted dishonest', () => {
    const a = 'PC_Honesty_Mixed_A', b = 'PC_Honesty_Mixed_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = pcGame([a, b]);
    pcRoundDeclared(g.gameId, a, 1, 'full', 1);  // honest: called hit, hit
    pcRoundDeclared(g.gameId, a, 2, 'miss', 1);  // dishonest: called hit, missed
    pcRoundDeclared(g.gameId, a, 3, 'full', 0);  // dishonest: called miss, hit
    pcRoundDeclared(g.gameId, a, 4, 'miss', 0);  // honest: called miss, missed
    for (let r = 1; r <= 4; r++) pcRound(g.gameId, b, r, 'miss');
    db.completeGame(g.gameId, a);
    const bubbles = db.getPressureChamberStatBubbles(a, 'h2h');
    assert.equal(bubbles.declaredRounds, 4);
    assert.equal(bubbles.honestyPct, 50, '2 of 4 declarations matched the real outcome');
  });

  test('declaredHit is rejected on a non-Pressure-Chamber game and only accepts 0/1', () => {
    const name = 'PC_Honesty_Guard';
    db.addPlayer(name); db.addPlayer('PC_Honesty_Guard_Opp');
    const x01 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name }, { name: 'PC_Honesty_Guard_Opp' }] });
    assert.throws(() => db.addTurn(x01.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: true,
      checkout: false, checkoutPoints: null, declaredHit: 1,
      darts: [{ dartNo: 1, sector: 0, multiplier: 1 }] }), /only valid in a Pressure Chamber/);
    const g = pcGame([name, 'PC_Honesty_Guard_Opp']);
    // raw addTurn (no enforceConsistency) skips the card-outcome check, so only
    // the declaredHit shape guard is under test here — 2 is neither 0 nor 1.
    assert.throws(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: true,
      checkout: false, checkoutPoints: null, declaredHit: 2,
      darts: [{ dartNo: 1, sector: 0, multiplier: 1 }] }), /declaredHit must be 0 .* or 1/);
  });
});

describe('X01/Cricket/Baseball/Shanghai/Halve-It/Pressure Chamber isolation regression (turns.scored means a different quantity per game type)', () => {
  test('a Pressure Chamber full-hit round never counts as an X01 180 or feeds Cricket/Baseball/Shanghai/Halve-It\'s stats', () => {
    const name = 'Isolation_PC_Player';
    db.addPlayer(name);
    db.addPlayer('Isolation_PC_Opp');
    const g = pcGame([name, 'Isolation_PC_Opp']);
    pcRound(g.gameId, name, 1, 'full');
    assert.equal(db.getSummary().oneEighties, 0, 'a pressure chamber full hit never satisfies the X01 scored=180 check');
    const x01Bubbles = db.getPlayerStatBubbles(name, 'h2h');
    assert.equal(x01Bubbles.one80s, 0);
    const cricketBubbles = db.getCricketStatBubbles(name, 'h2h');
    assert.equal(cricketBubbles.mpr, null, 'no cricket rounds recorded for this player at all');
    const shanghaiBubbles = db.getShanghaiStatBubbles(name, 'h2h');
    assert.equal(shanghaiBubbles.ppr, null, 'no shanghai rounds recorded for this player at all');
    const halveItBubbles = db.getHalveItStatBubbles(name, 'h2h');
    assert.equal(halveItBubbles.avgFinalTotal, null, 'no halve-it legs recorded for this player at all');
  });

  test('an existing X01 180 is unaffected by a Pressure Chamber run sharing the same player', () => {
    const name = 'Isolation_PC_X01_Player';
    db.addPlayer(name);
    db.addPlayer('Isolation_PC_X01_Opp');
    const x01 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name }, { name: 'Isolation_PC_X01_Opp' }] });
    db.addTurn(x01.gameId, { player: name, set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 3 }] });
    const g = pcGame([name, 'Isolation_PC_X01_Opp']);
    pcRound(g.gameId, name, 1, 'full');
    assert.equal(db.getSummary().oneEighties, 1, 'the real X01 180 still counts exactly once');
  });
});
