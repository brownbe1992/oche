'use strict';
// Committed tests for backend/db.js's Baseball stat formulas (REFERENCE.md §3
// "Baseball stats") — against a scratch SQLite database. Not exhaustive; see
// db.x01-stats.test.js's header comment for the same "focused, not 100%
// coverage" framing.
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

function baseballGame(players) {
  return db.createGame({
    category: 'Baseball', legsPerSet: 1, setsPerGame: 1, practice: 0,
    gameType: 'baseball', config: { innings: 9 },
    players: players.map(name => ({ name })),
  });
}
// darts: array of [sector, mult]. scored is that visit's runs (what
// enterTurnBaseball() computes and writes) — unlike Cricket, there's no
// legWon param, since Baseball never sets turns.leg_won (see
// getBaseballWonLegs()'s own comment for why: the winner isn't always the
// player whose visit ended the round, so no single turn can self-report it).
function baseballTurn(gameId, player, set, leg, darts, { scored = 0 } = {}) {
  db.addTurn(gameId, {
    player, set, leg, scored, bust: false, checkout: false, checkoutPoints: null,
    darts: darts.map((dd, i) => ({ dartNo: i + 1, sector: dd[0], multiplier: dd[1] })),
  });
}

describe('getBaseballStatBubbles', () => {
  test('rpi, perfectInnings, bestInning, dartsThrown, gamesPlayed, winPct', () => {
    const a = 'Baseball_Bubbles_A', b = 'Baseball_Bubbles_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = baseballGame([a, b]);
    // Inning 1: 3 darts, all trebles on target -> 9 runs (a "perfect inning").
    baseballTurn(g.gameId, a, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 });
    // Inning 2: 1 dart, single on target -> 1 run.
    baseballTurn(g.gameId, a, 1, 1, [[2,1]], { scored: 1 });
    db.completeGame(g.gameId, a);

    const bubbles = db.getBaseballStatBubbles(a, 'h2h');
    assert.equal(bubbles.rpi, (9 + 1) / 2, 'RPI = total runs / total rounds (turns)');
    assert.equal(bubbles.perfectInnings, 1, 'only the first turn scored the max 9');
    assert.equal(bubbles.bestInning, 9);
    assert.equal(bubbles.dartsThrown, 4, 'baseball-scoped dart count');
    assert.equal(bubbles.gamesPlayed, 1);
    assert.equal(bubbles.winPct, 100);
  });

  test('a scoreless turn still counts as a round with 0 runs (RPI definition)', () => {
    const name = 'Baseball_MissRound';
    db.addPlayer(name);
    const g = baseballGame([name, 'Baseball_MissRound_Opp']);
    db.addPlayer('Baseball_MissRound_Opp');
    baseballTurn(g.gameId, name, 1, 1, [[0,1],[0,1],[0,1]], { scored: 0 }); // 3 misses
    const bubbles = db.getBaseballStatBubbles(name, 'h2h');
    assert.equal(bubbles.rpi, 0, '0 runs / 1 round');
  });
});

describe('getBaseballPersonalBests', () => {
  test('bestLegRuns/fewestDartsToWin/lifetimeRuns are derived from total runs per leg, not a stored leg_won flag', () => {
    const a = 'Baseball_PB_A', b = 'Baseball_PB_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = baseballGame([a, b]);
    // Leg 1: a scores 20 total across 2 turns (5 darts); b scores 15. a wins this
    // leg by total runs, even though nothing on any individual turn says so.
    baseballTurn(g.gameId, a, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 });
    baseballTurn(g.gameId, b, 1, 1, [[1,1],[1,1],[1,1]], { scored: 3 });
    baseballTurn(g.gameId, a, 1, 1, [[2,3],[2,3],[2,3]], { scored: 9 });
    baseballTurn(g.gameId, b, 1, 1, [[2,3],[2,3]], { scored: 6 }); // b's LAST turn -- but still loses on total
    baseballTurn(g.gameId, a, 1, 1, [[9,1],[9,1]], { scored: 2 }); // a: 9+9+2=20 total, 8 darts
    db.completeGame(g.gameId, a);

    const pbA = db.getBaseballPersonalBests(a, 'h2h');
    assert.equal(pbA.bestLegRuns, 20, 'a\'s own total runs in the leg a won');
    assert.equal(pbA.fewestDartsToWin, 8, 'a\'s total darts across all 3 of a\'s turns this leg');
    assert.equal(pbA.lifetimeRuns, 20);

    const pbB = db.getBaseballPersonalBests(b, 'h2h');
    assert.equal(pbB.bestLegRuns, null, 'b never won a leg (b scored fewer total runs), despite b\'s own last turn ending the round');
    assert.equal(pbB.fewestDartsToWin, null);
  });

  test('an abandoned (never-completed) game contributes no legs at all, even to the player who was ahead', () => {
    const a = 'Baseball_Abandoned_A', b = 'Baseball_Abandoned_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = baseballGame([a, b]);
    baseballTurn(g.gameId, a, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 });
    baseballTurn(g.gameId, b, 1, 1, [[1,1]], { scored: 1 });
    // g is never completed (no db.completeGame call) -- simulates an abandoned game.
    const pb = db.getBaseballPersonalBests(a, 'h2h');
    assert.equal(pb.bestLegRuns, null, 'an incomplete game\'s partial lead is never mistaken for a real win');
  });
});

describe('getBaseballPerfectInningsStats', () => {
  test('leaderboard counts turns scoring exactly 9 runs (three trebles)', () => {
    const a = 'Baseball_PI_A', b = 'Baseball_PI_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = baseballGame([a, b]);
    baseballTurn(g.gameId, a, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 }); // qualifies
    baseballTurn(g.gameId, a, 1, 1, [[2,3],[2,3],[2,1]], { scored: 7 }); // does not qualify
    baseballTurn(g.gameId, b, 1, 1, [[1,1],[1,1],[1,1]], { scored: 3 }); // does not qualify
    const stats = db.getBaseballPerfectInningsStats('h2h');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[a], 1);
    assert.equal(byName[b], undefined, 'b never scored a perfect inning');
  });
});

describe('getBaseballRpiLeaderboard', () => {
  test('requires at least 5 rounds (mirrors the MPR floor convention)', () => {
    const under = 'Baseball_RPI_Under5', over = 'Baseball_RPI_Over5';
    db.addPlayer(under); db.addPlayer(over);
    const g = baseballGame([under, over]);
    for (let i = 0; i < 4; i++) baseballTurn(g.gameId, under, 1, 1, [[1,1]], { scored: 1 }); // 4 rounds -> excluded
    for (let i = 0; i < 5; i++) baseballTurn(g.gameId, over, 1, 1, [[1,1]], { scored: 1 });  // 5 rounds -> included, rpi=1
    const rows = db.getBaseballRpiLeaderboard('h2h');
    const names = rows.map(r => r.name);
    assert.ok(!names.includes(under), 'under the 5-round floor is excluded entirely');
    const overRow = rows.find(r => r.name === over);
    assert.equal(overRow.rpi, 1, '1 run per round');
  });
});

describe('getBaseballWinLeaderboard', () => {
  test('rate = won/played*100, H2H only, no mode param', () => {
    const p1 = 'Baseball_Win_P1', p2 = 'Baseball_Win_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g1 = baseballGame([p1, p2]); db.completeGame(g1.gameId, p1);
    const g2 = baseballGame([p1, p2]); db.completeGame(g2.gameId, p2);
    const rows = db.getBaseballWinLeaderboard();
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[p1].played, 2);
    assert.equal(byName[p1].won, 1);
    assert.equal(byName[p1].rate, 50);
  });
});

describe('getBaseballPerfectGameStats', () => {
  test('a leg won with 9 runs in every one of the 9 innings (81 total)', () => {
    const name = 'Baseball_Perfect_Player';
    db.addPlayer(name);
    const g = baseballGame([name, 'Baseball_Perfect_Opp']);
    db.addPlayer('Baseball_Perfect_Opp');
    for (let i = 1; i <= 9; i++) {
      baseballTurn(g.gameId, name, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 });
    }
    db.completeGame(g.gameId, name);
    const stats = db.getBaseballPerfectGameStats('h2h');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[name], 1);
  });

  test('the same shape but ONE inning short of 9 runs does not qualify', () => {
    const name = 'Baseball_Imperfect_Player';
    db.addPlayer(name);
    const g = baseballGame([name, 'Baseball_Imperfect_Opp']);
    db.addPlayer('Baseball_Imperfect_Opp');
    for (let i = 1; i <= 8; i++) {
      baseballTurn(g.gameId, name, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 });
    }
    baseballTurn(g.gameId, name, 1, 1, [[1,3],[1,3],[1,1]], { scored: 7 }); // 9th inning falls short
    db.completeGame(g.gameId, name);
    const stats = db.getBaseballPerfectGameStats('h2h');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[name], undefined);
  });
});

describe('X01/Cricket/Baseball isolation regression (turns.scored means a different quantity per game type)', () => {
  test('a 9-run baseball inning never counts as an X01 180 or feeds Cricket\'s stats', () => {
    const name = 'Isolation_Baseball_Player';
    db.addPlayer(name);
    const g = baseballGame([name, 'Isolation_Baseball_Opp']);
    db.addPlayer('Isolation_Baseball_Opp');
    baseballTurn(g.gameId, name, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 });
    assert.equal(db.getSummary().oneEighties, 0, 'a 9-run baseball inning never satisfies the X01 scored=180 check');
    const x01Bubbles = db.getPlayerStatBubbles(name, 'h2h');
    assert.equal(x01Bubbles.one80s, 0);
    const cricketBubbles = db.getCricketStatBubbles(name, 'h2h');
    assert.equal(cricketBubbles.mpr, null, 'no cricket rounds recorded for this player at all');
  });
});
