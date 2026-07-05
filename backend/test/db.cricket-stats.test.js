'use strict';
// Committed tests for backend/db.js's Cricket stat formulas (REFERENCE.md §3
// "Cricket stats") and the X01/Cricket isolation this session's audit fixed —
// against a scratch SQLite database. Not exhaustive; see db.x01-stats.test.js's
// header comment for the same "focused, not 100% coverage" framing.
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

const CLASSIC = [15, 16, 17, 18, 19, 20, 25];

function cricketGame(players) {
  return db.createGame({
    category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 0,
    gameType: 'cricket', config: { numbers: CLASSIC },
    players: players.map(name => ({ name })),
  });
}
// darts: array of {sector, mult}. legWon marks this turn as the one that won its leg
// (turns.leg_won — Cricket's "this turn won the leg" signal, since it has no checkout).
function cricketTurn(gameId, player, set, leg, darts, { scored = 0, legWon = false } = {}) {
  db.addTurn(gameId, {
    player, set, leg, scored, bust: false, checkout: false, checkoutPoints: null, legWon,
    darts: darts.map((dd, i) => ({ dartNo: i + 1, sector: dd[0], multiplier: dd[1] })),
  });
}

describe('getCricketStatBubbles', () => {
  test('mpr, nineMarks, dartsThrown, avgDartsPerLeg', () => {
    const a = 'Cricket_Bubbles_A', b = 'Cricket_Bubbles_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = cricketGame([a, b]);
    // Turn 1: 3 darts, all T20 -> 9 marks in one visit (the "9 Marks" achievement
    // shape). Opponent b's 20 is open throughout, so this scores 60+60=120 (dart 1
    // exactly closes at 3 marks -> 0 pts; darts 2 and 3 each push 3 marks further
    // beyond the close, at 20 pts/mark -> 60 each).
    cricketTurn(g.gameId, a, 1, 1, [[20,3],[20,3],[20,3]], { scored: 120 });
    // Turn 2 (leg 2): closes 15 in exactly 3 darts, marked as the leg-winning turn.
    cricketTurn(g.gameId, a, 1, 2, [[15,1],[15,1],[15,1]], { scored: 0, legWon: true });
    db.completeGame(g.gameId, a);

    const bubbles = db.getCricketStatBubbles(a, 'h2h');
    assert.equal(bubbles.mpr, (9 + 3) / 2, 'MPR = total marks / total rounds (turns)');
    assert.equal(bubbles.nineMarks, 1, 'only turn 1 has exactly 3 darts summing to 9 marks');
    assert.equal(bubbles.dartsThrown, 6, 'cricket-scoped dart count');
    assert.equal(bubbles.avgDartsPerLeg, 3, 'only leg 2 has a leg_won=1 turn, using 3 darts');
    assert.equal(bubbles.gamesPlayed, 1);
    assert.equal(bubbles.winPct, 100);
  });

  test('a miss-only turn still counts as a round with 0 marks (MPR definition)', () => {
    const name = 'Cricket_MissRound';
    db.addPlayer(name);
    const g = cricketGame([name, 'Cricket_MissRound_Opp']);
    db.addPlayer('Cricket_MissRound_Opp');
    cricketTurn(g.gameId, name, 1, 1, [[0,1],[0,1],[0,1]], { scored: 0 }); // 3 misses
    const bubbles = db.getCricketStatBubbles(name, 'h2h');
    assert.equal(bubbles.mpr, 0, '0 marks / 1 round');
  });
});

describe('getCricketPersonalBests', () => {
  test('bestLegMpr / fewestDartsToClose / lifetimeMpr keyed on leg_won, not checkout', () => {
    const name = 'Cricket_PB_Player';
    db.addPlayer(name);
    const g = cricketGame([name, 'Cricket_PB_Opp']);
    db.addPlayer('Cricket_PB_Opp');
    // Leg 1: won in 3 darts, all trebles on 15 -> 9 marks / 3 darts = mpr 3, and this
    // leg's own "rounds" count (COUNT(DISTINCT t.id)) is 1.
    cricketTurn(g.gameId, name, 1, 1, [[15,3],[15,3],[15,3]], { scored: 0, legWon: true });
    // Leg 2: two turns before winning — total marks across the leg vs total rounds.
    cricketTurn(g.gameId, name, 1, 2, [[16,1],[16,1],[16,1]], { scored: 0 }); // 3 marks, closes 16
    cricketTurn(g.gameId, name, 1, 2, [[17,1],[17,1]], { scored: 0, legWon: true }); // 2 darts, 2 marks
    const pb = db.getCricketPersonalBests(name, 'h2h');
    // Leg 1: marks=9, rounds=1 -> mpr=9. Leg 2: marks=3+2=5, rounds=2 -> mpr=2.5.
    assert.equal(pb.bestLegMpr, 9, 'leg 1\'s 9-mark single-turn leg is the best MPR');
    // Leg 1 used 3 darts total; leg 2 used 3+2=5 darts total.
    assert.equal(pb.fewestDartsToClose, 3, 'leg 1 closed in fewer total darts');
    const legMprs = [9, 2.5];
    assert.equal(pb.lifetimeMpr, legMprs.reduce((s, v) => s + v, 0) / legMprs.length);
  });
});

describe('getCricketNineMarksStats', () => {
  test('leaderboard counts turns with exactly 3 darts summing to 9 marks', () => {
    const a = 'Cricket_9M_A', b = 'Cricket_9M_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = cricketGame([a, b]);
    cricketTurn(g.gameId, a, 1, 1, [[20,3],[20,3],[20,3]], { scored: 120 }); // qualifies
    cricketTurn(g.gameId, a, 1, 1, [[19,3],[19,3],[18,3]], { scored: 60 });  // 9 marks (3+3+3), still qualifies
    cricketTurn(g.gameId, b, 1, 1, [[20,3],[20,3],[20,1]], { scored: 0 });   // 7 marks, does not qualify
    const stats = db.getCricketNineMarksStats('h2h');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[a], 2);
    assert.equal(byName[b], undefined, 'b never hit 9 marks in a single visit');
  });
});

describe('getCricketMprLeaderboard', () => {
  test('requires at least 5 rounds (mirrors the trebleless-leaderboard floor convention)', () => {
    const under = 'Cricket_MPR_Under5', over = 'Cricket_MPR_Over5';
    db.addPlayer(under); db.addPlayer(over);
    const g = cricketGame([under, over]);
    for (let i = 0; i < 4; i++) cricketTurn(g.gameId, under, 1, 1, [[20,1]], { scored: 0 }); // 4 rounds -> excluded
    for (let i = 0; i < 5; i++) cricketTurn(g.gameId, over, 1, 1, [[20,1]], { scored: 0 });  // 5 rounds -> included, mpr=1
    const rows = db.getCricketMprLeaderboard('h2h');
    const names = rows.map(r => r.name);
    assert.ok(!names.includes(under), 'under the 5-round floor is excluded entirely');
    const overRow = rows.find(r => r.name === over);
    assert.equal(overRow.mpr, 1, '1 mark per round (a single 20 each turn)');
  });
});

describe('getCricketWinLeaderboard', () => {
  test('rate = won/played*100, H2H only, no mode param', () => {
    const p1 = 'Cricket_Win_P1', p2 = 'Cricket_Win_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g1 = cricketGame([p1, p2]); db.completeGame(g1.gameId, p1);
    const g2 = cricketGame([p1, p2]); db.completeGame(g2.gameId, p2);
    const rows = db.getCricketWinLeaderboard();
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[p1].played, 2);
    assert.equal(byName[p1].won, 1);
    assert.equal(byName[p1].rate, 50);
  });
});

describe('getCricketPerfectLegStats', () => {
  test('a won leg whose total darts equal the match\'s theoretical minimum', () => {
    const name = 'Cricket_Perfect_Player';
    db.addPlayer(name);
    const g = cricketGame([name, 'Cricket_Perfect_Opp']);
    db.addPlayer('Cricket_Perfect_Opp');
    // Classic 7 numbers [15..20, Bull]: 6 non-Bull numbers close in 1 dart each (a
    // treble = 3 marks), Bull needs a 2-dart minimum (no treble bull, so two double
    // bulls = 4 marks, clearing the 3-mark close). Theoretical minimum = 6+2 = 8 darts.
    cricketTurn(g.gameId, name, 1, 1, [[15,3],[16,3],[17,3]], { scored: 0 });
    cricketTurn(g.gameId, name, 1, 1, [[18,3],[19,3],[20,3]], { scored: 0 });
    cricketTurn(g.gameId, name, 1, 1, [[25,2],[25,2]], { scored: 0, legWon: true }); // 8th total dart closes Bull, wins
    const stats = db.getCricketPerfectLegStats('h2h');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[name], 1);
  });

  test('the same shape but ONE extra dart does not qualify', () => {
    const name = 'Cricket_Imperfect_Player';
    db.addPlayer(name);
    const g = cricketGame([name, 'Cricket_Imperfect_Opp']);
    db.addPlayer('Cricket_Imperfect_Opp');
    cricketTurn(g.gameId, name, 1, 1, [[15,3],[16,3],[17,3]], { scored: 0 });
    cricketTurn(g.gameId, name, 1, 1, [[18,3],[19,3],[20,3]], { scored: 0 });
    cricketTurn(g.gameId, name, 1, 1, [[25,1],[25,1],[25,2]], { scored: 0, legWon: true }); // 9 total darts, not 8
    const stats = db.getCricketPerfectLegStats('h2h');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[name], undefined);
  });
});

describe('computeStats — Cricket legs/sets won via leg_won (this session\'s audit fix)', () => {
  test('a cricket leg/set win is counted via leg_won, not checkout (which cricket never sets)', () => {
    const name = 'Cricket_Compute_Player';
    db.addPlayer(name);
    const g = cricketGame([name, 'Cricket_Compute_Opp']);
    db.addPlayer('Cricket_Compute_Opp');
    cricketTurn(g.gameId, name, 1, 1, [[15,1],[15,1],[15,1]], { scored: 0, legWon: true });
    db.completeGame(g.gameId, name);
    const stats = db.computeStats()[name];
    const cat = 'Cricket (15-20, Bull)';
    assert.equal(stats.h2hLegsWonByCat[cat], 1);
    assert.equal(stats.h2hSetsWonByCat[cat], 1, 'legsPerSet=1, so the single leg win also completes the set');
    assert.equal(stats.h2hGamesWonByCat[cat], 1);
  });

  test('turns/dartsThrown (all-time) include cricket visits; h2hStats stays X01-scoped', () => {
    const name = 'Cricket_AllTime_Player';
    db.addPlayer(name);
    const g = cricketGame([name, 'Cricket_AllTime_Opp']);
    db.addPlayer('Cricket_AllTime_Opp');
    cricketTurn(g.gameId, name, 1, 1, [[20,3],[20,3],[20,3]], { scored: 120 });
    const stats = db.computeStats()[name];
    assert.equal(stats.turns, 1, 'the cricket visit counts toward the all-time turns total');
    assert.equal(stats.dartsThrown, 3, 'and toward all-time darts thrown');
    assert.equal(stats.h2hStats.turns, 0, 'h2hStats (which feeds the X01 3-dart average) stays cricket-free');
  });
});

describe('X01/Cricket isolation regression (turns.scored means a different quantity per game type)', () => {
  test('a 9-mark cricket visit worth 120 cricket points never counts as an X01 180', () => {
    const name = 'Isolation_180_Player';
    db.addPlayer(name);
    const g = cricketGame([name, 'Isolation_180_Opp']);
    db.addPlayer('Isolation_180_Opp');
    cricketTurn(g.gameId, name, 1, 1, [[20,3],[20,3],[20,3]], { scored: 120 });
    assert.equal(db.getSummary().oneEighties, 0, 'cricket points never satisfy the X01 scored=180 check');
    const bubbles = db.getPlayerStatBubbles(name, 'h2h');
    assert.equal(bubbles.one80s, 0);
  });
});
