'use strict';
// Committed tests for backend/db.js's Shanghai stat formulas (REFERENCE.md
// "Shanghai stats", docs/archive/shanghai-roadmap.md) — against a scratch SQLite
// database. Not exhaustive; see db.x01-stats.test.js's header comment for the
// same "focused, not 100% coverage" framing.
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

function shanghaiGame(players, rounds) {
  return db.createGame({
    category: 'Shanghai', legsPerSet: 1, setsPerGame: 1, practice: 0,
    gameType: 'shanghai', config: { rounds: rounds || 7 },
    players: players.map(name => ({ name })),
  });
}
// darts: array of [sector, mult]. scored is that visit's points (what
// enterTurnShanghai() computes and writes). legWon is set ONLY for a genuine
// instant Shanghai (see getShanghaiWonLegs()'s own comment) — never for a
// final-round win decided by point totals.
function shanghaiTurn(gameId, player, set, leg, darts, { scored = 0, legWon = false } = {}) {
  db.addTurn(gameId, {
    player, set, leg, scored, bust: false, checkout: false, checkoutPoints: null, legWon,
    darts: darts.map((dd, i) => ({ dartNo: i + 1, sector: dd[0], multiplier: dd[1] })),
  });
}

describe('getShanghaiStatBubbles', () => {
  test('ppr, shanghaisThrown, bestRound, dartsThrown, gamesPlayed, winPct', () => {
    const a = 'Shanghai_Bubbles_A', b = 'Shanghai_Bubbles_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = shanghaiGame([a, b]);
    // Round 1: single+double+treble of 1 -> a Shanghai (6 points) -- also the leg winner.
    shanghaiTurn(g.gameId, a, 1, 1, [[1,1],[1,2],[1,3]], { scored: 6, legWon: true });
    db.completeGame(g.gameId, a);

    const bubbles = db.getShanghaiStatBubbles(a, 'h2h');
    assert.equal(bubbles.ppr, 6, 'ppr = total points / rounds played (1 round)');
    assert.equal(bubbles.shanghaisThrown, 1);
    assert.equal(bubbles.bestRound, 6);
    assert.equal(bubbles.dartsThrown, 3);
    assert.equal(bubbles.gamesPlayed, 1);
    assert.equal(bubbles.winPct, 100);
  });

  test('a scoreless round still counts as a round with 0 points (PPR definition)', () => {
    const name = 'Shanghai_MissRound';
    db.addPlayer(name);
    const g = shanghaiGame([name, 'Shanghai_MissRound_Opp']);
    db.addPlayer('Shanghai_MissRound_Opp');
    shanghaiTurn(g.gameId, name, 1, 1, [[5,1],[5,1],[5,1]], { scored: 0 }); // round 1 targets 1, these all miss it
    const bubbles = db.getShanghaiStatBubbles(name, 'h2h');
    assert.equal(bubbles.ppr, 0, '0 points / 1 round');
  });
});

describe('getShanghaiWonLegs / getShanghaiPersonalBests', () => {
  test('an instant Shanghai win (leg_won=1) is read directly, not derived from totals', () => {
    const a = 'Shanghai_Instant_A', b = 'Shanghai_Instant_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = shanghaiGame([a, b]);
    // b has a big lead after round 1...
    shanghaiTurn(g.gameId, b, 1, 1, [[1,3],[1,3],[1,3]], { scored: 9 });
    shanghaiTurn(g.gameId, a, 1, 1, [[1,1],[1,1]], { scored: 2 });
    // ...but a throws a Shanghai on round 2 (single+double+treble of 2 = 2+4+6=12) and
    // wins INSTANTLY regardless of the point totals so far.
    shanghaiTurn(g.gameId, a, 1, 1, [[2,1],[2,2],[2,3]], { scored: 12, legWon: true });
    db.completeGame(g.gameId, a);

    const pbA = db.getShanghaiPersonalBests(a, 'h2h');
    assert.equal(pbA.bestLegPoints, 14, "a's own total points in the leg a won (2+12), despite trailing on points");
    assert.equal(pbA.fewestDartsToWin, 5, "a's total darts across both of a's turns this leg");

    const pbB = db.getShanghaiPersonalBests(b, 'h2h');
    assert.equal(pbB.bestLegPoints, null, "b never won a leg (a's Shanghai overrode b's higher point total)");
  });

  test('a final-round win with no Shanghai thrown is derived from point totals, same as Baseball', () => {
    const a = 'Shanghai_FinalRound_A', b = 'Shanghai_FinalRound_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = shanghaiGame([a, b], 1); // 1-round game so both finish after round 1
    shanghaiTurn(g.gameId, a, 1, 1, [[1,1],[1,1],[1,1]], { scored: 3 }); // 3 points, no Shanghai
    shanghaiTurn(g.gameId, b, 1, 1, [[1,1],[1,1]], { scored: 2 });       // b's own turn ends the round, but b scored less
    db.completeGame(g.gameId, a);

    const pbA = db.getShanghaiPersonalBests(a, 'h2h');
    assert.equal(pbA.bestLegPoints, 3, "a's own total points in the leg a won on points");
    const pbB = db.getShanghaiPersonalBests(b, 'h2h');
    assert.equal(pbB.bestLegPoints, null, "b never won a leg, despite b's own turn ending the round");
  });

  test('an abandoned (never-completed) game contributes no legs at all, even to the player who was ahead', () => {
    const a = 'Shanghai_Abandoned_A', b = 'Shanghai_Abandoned_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = shanghaiGame([a, b]);
    shanghaiTurn(g.gameId, a, 1, 1, [[1,1],[1,1],[1,1]], { scored: 3 });
    shanghaiTurn(g.gameId, b, 1, 1, [[1,1]], { scored: 1 });
    // g is never completed -- simulates an abandoned game.
    const pb = db.getShanghaiPersonalBests(a, 'h2h');
    assert.equal(pb.bestLegPoints, null, "an incomplete game's partial lead is never mistaken for a real win");
  });
});

describe('getShanghaiPprLeaderboard', () => {
  test('requires at least 5 rounds (mirrors the RPI/MPR floor convention)', () => {
    const under = 'Shanghai_PPR_Under5', over = 'Shanghai_PPR_Over5';
    db.addPlayer(under); db.addPlayer(over);
    const g = shanghaiGame([under, over], 20);
    for (let i = 0; i < 4; i++) shanghaiTurn(g.gameId, under, 1, 1, [[1,1]], { scored: 1 }); // 4 rounds -> excluded
    for (let i = 0; i < 5; i++) shanghaiTurn(g.gameId, over, 1, 1, [[1,1]], { scored: 1 });  // 5 rounds -> included, ppr=1
    const rows = db.getShanghaiPprLeaderboard('h2h');
    const names = rows.map(r => r.name);
    assert.ok(!names.includes(under), 'under the 5-round floor is excluded entirely');
    const overRow = rows.find(r => r.name === over);
    assert.equal(overRow.ppr, 1, '1 point per round');
  });
});

describe('getShanghaiWinLeaderboard', () => {
  test('rate = won/played*100, H2H only, no mode param', () => {
    const p1 = 'Shanghai_Win_P1', p2 = 'Shanghai_Win_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g1 = shanghaiGame([p1, p2]); db.completeGame(g1.gameId, p1);
    const g2 = shanghaiGame([p1, p2]); db.completeGame(g2.gameId, p2);
    const rows = db.getShanghaiWinLeaderboard();
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[p1].played, 2);
    assert.equal(byName[p1].won, 1);
    assert.equal(byName[p1].rate, 50);
  });
});

describe('getShanghaiShanghaisStats', () => {
  test('leaderboard counts turns flagged leg_won=1 (a genuine instant Shanghai)', () => {
    const a = 'Shanghai_Count_A', b = 'Shanghai_Count_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = shanghaiGame([a, b]);
    shanghaiTurn(g.gameId, a, 1, 1, [[1,1],[1,2],[1,3]], { scored: 6, legWon: true }); // qualifies
    shanghaiTurn(g.gameId, b, 1, 1, [[1,1],[1,1],[1,1]], { scored: 3 }); // does not qualify
    const stats = db.getShanghaiShanghaisStats('h2h');
    const byName = Object.fromEntries(stats.leaderboard.map(r => [r.name, r.count]));
    assert.equal(byName[a], 1);
    assert.equal(byName[b], undefined, 'b never threw a Shanghai');
  });
});

describe('X01/Cricket/Baseball/Shanghai isolation regression (turns.scored means a different quantity per game type)', () => {
  test('a 6-point Shanghai round never counts as an X01 180 or feeds Cricket/Baseball\'s stats', () => {
    const name = 'Isolation_Shanghai_Player';
    db.addPlayer(name);
    const g = shanghaiGame([name, 'Isolation_Shanghai_Opp']);
    db.addPlayer('Isolation_Shanghai_Opp');
    shanghaiTurn(g.gameId, name, 1, 1, [[1,1],[1,2],[1,3]], { scored: 6, legWon: true });
    assert.equal(db.getSummary().oneEighties, 0, 'a 6-point shanghai round never satisfies the X01 scored=180 check');
    const x01Bubbles = db.getPlayerStatBubbles(name, 'h2h');
    assert.equal(x01Bubbles.one80s, 0);
    const cricketBubbles = db.getCricketStatBubbles(name, 'h2h');
    assert.equal(cricketBubbles.mpr, null, 'no cricket rounds recorded for this player at all');
    const baseballBubbles = db.getBaseballStatBubbles(name, 'h2h');
    assert.equal(baseballBubbles.rpi, null, 'no baseball rounds recorded for this player at all');
  });
});
