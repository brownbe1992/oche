'use strict';
// Committed tests for backend/db.js's Halve-It stat formulas (REFERENCE.md
// "Halve-It stats", docs/archive/halve-it-roadmap.md) — against a scratch
// SQLite database. Not exhaustive; see db.x01-stats.test.js's header comment
// for the same "focused, not 100% coverage" framing.
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

const TARGETS_1ROUND = [{ sector: 20 }];

function halveItGame(players, targets) {
  return db.createGame({
    category: 'Halve-It', legsPerSet: 1, setsPerGame: 1, practice: 0,
    gameType: 'halve_it', config: { targets: targets || TARGETS_1ROUND },
    players: players.map(name => ({ name })),
  });
}
// darts: array of [sector, mult]. scored is that visit's GAIN (0 on a halved
// visit); bust marks the halved visit itself (docs/archive/halve-it-roadmap.md's
// own column-repurposing precedent — see enterTurnHalveIt()'s own comment).
function halveItTurn(gameId, player, set, leg, darts, { scored = 0, bust = false } = {}) {
  db.addTurn(gameId, {
    player, set, leg, scored, bust, checkout: false, checkoutPoints: null,
    darts: darts.map((dd, i) => ({ dartNo: i + 1, sector: dd[0], multiplier: dd[1] })),
  });
}

describe('getHalveItStatBubbles', () => {
  test('avgFinalTotal, timesHalved, bestRound, dartsThrown, gamesPlayed, winPct', () => {
    const a = 'HalveIt_Bubbles_A', b = 'HalveIt_Bubbles_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = halveItGame([a, b], TARGETS_1ROUND);
    // Round 1 (only round): a hits a treble 20 (60 points) and wins outright.
    halveItTurn(g.gameId, a, 1, 1, [[20,3]], { scored: 60 });
    db.completeGame(g.gameId, a);

    const bubbles = db.getHalveItStatBubbles(a, 'h2h');
    assert.equal(bubbles.avgFinalTotal, 60, 'a single completed leg, final total 60');
    assert.equal(bubbles.timesHalved, 0);
    assert.equal(bubbles.bestRound, 60);
    assert.equal(bubbles.dartsThrown, 1);
    assert.equal(bubbles.gamesPlayed, 1);
    assert.equal(bubbles.winPct, 100);
  });

  test('a halved visit counts toward timesHalved and never toward bestRound', () => {
    const name = 'HalveIt_Halved';
    db.addPlayer(name);
    const g = halveItGame([name, 'HalveIt_Halved_Opp'], TARGETS_1ROUND);
    db.addPlayer('HalveIt_Halved_Opp');
    halveItTurn(g.gameId, name, 1, 1, [[1,1],[2,1],[3,1]], { scored: 0, bust: true }); // misses the round-1 target (20)
    const bubbles = db.getHalveItStatBubbles(name, 'h2h');
    assert.equal(bubbles.timesHalved, 1);
    assert.equal(bubbles.bestRound, 0, 'the only turn recorded gained 0');
  });
});

describe('getHalveItWonLegs / getHalveItPersonalBests', () => {
  test('a leg\'s winner is ALWAYS derived from final totals -- never a leg_won=1 turn', () => {
    const a = 'HalveIt_Win_A', b = 'HalveIt_Win_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = halveItGame([a, b], TARGETS_1ROUND);
    // b's own turn is LAST in the leg (ends the round), but a still has the
    // higher final total -- a must be recorded as the winner, not b.
    halveItTurn(g.gameId, a, 1, 1, [[20,3]], { scored: 60 });
    halveItTurn(g.gameId, b, 1, 1, [[20,1]], { scored: 20 });
    db.completeGame(g.gameId, a);

    const pbA = db.getHalveItPersonalBests(a, 'h2h');
    assert.equal(pbA.bestFinalTotal, 60);
    assert.equal(pbA.fewestDartsToWin, 1);

    const pbB = db.getHalveItPersonalBests(b, 'h2h');
    assert.equal(pbB.bestFinalTotal, null, 'b never won a leg, despite b\'s own turn ending the round');
  });

  test('the halving-aware replay is order-dependent, not a plain SUM(scored)', () => {
    const a = 'HalveIt_Replay_A', b = 'HalveIt_Replay_B';
    db.addPlayer(a); db.addPlayer(b);
    const targets = [{ sector: 20 }, { sector: 16 }, { sector: 19 }];
    const g = halveItGame([a, b], targets);
    // a: round 1 hits 20 (single, +20 -> total 20); round 2 misses entirely
    // (halved: ceil(20/2)=10); round 3 hits 19 (single, +19 -> total 29).
    // A naive SUM(scored) would read 20+0+19=39, NOT the real halving-aware 29.
    halveItTurn(g.gameId, a, 1, 1, [[20,1]], { scored: 20 });
    halveItTurn(g.gameId, a, 1, 1, [[1,1],[2,1],[3,1]], { scored: 0, bust: true });
    halveItTurn(g.gameId, a, 1, 1, [[19,1]], { scored: 19 });
    // b stays low the whole leg so a wins.
    halveItTurn(g.gameId, b, 1, 1, [[1,1]], { scored: 0, bust: true });
    halveItTurn(g.gameId, b, 1, 1, [[1,1]], { scored: 0, bust: true });
    halveItTurn(g.gameId, b, 1, 1, [[1,1]], { scored: 0, bust: true });
    db.completeGame(g.gameId, a);

    const pbA = db.getHalveItPersonalBests(a, 'h2h');
    assert.equal(pbA.bestFinalTotal, 29, 'ceil(20/2)=10, then +19 = 29 -- the real halving-aware total');
  });

  test('an abandoned (never-completed) game contributes no legs at all, even to the player who was ahead', () => {
    const a = 'HalveIt_Abandoned_A', b = 'HalveIt_Abandoned_B';
    db.addPlayer(a); db.addPlayer(b);
    const g = halveItGame([a, b], TARGETS_1ROUND);
    halveItTurn(g.gameId, a, 1, 1, [[20,3]], { scored: 60 });
    halveItTurn(g.gameId, b, 1, 1, [[20,1]], { scored: 20 });
    // g is never completed -- simulates an abandoned game.
    const pb = db.getHalveItPersonalBests(a, 'h2h');
    assert.equal(pb.bestFinalTotal, null, "an incomplete game's partial lead is never mistaken for a real win");
  });
});

describe('getHalveItBestTotalLeaderboard', () => {
  test('one row per player, their peak final total across both won and lost legs', () => {
    const a = 'HalveIt_Peak_A', b = 'HalveIt_Peak_B';
    db.addPlayer(a); db.addPlayer(b);
    const g1 = halveItGame([a, b], TARGETS_1ROUND);
    halveItTurn(g1.gameId, a, 1, 1, [[20,3]], { scored: 60 }); // a: 60, wins
    halveItTurn(g1.gameId, b, 1, 1, [[20,2]], { scored: 40 }); // b: 40, loses
    db.completeGame(g1.gameId, a);

    const rows = db.getHalveItBestTotalLeaderboard('h2h');
    const byName = Object.fromEntries(rows.map(r => [r.name, r.total]));
    assert.equal(byName[a], 60);
    assert.equal(byName[b], 40, 'a peak total is tracked even for a leg that was ultimately lost');
  });
});

describe('getHalveItWinLeaderboard', () => {
  test('rate = won/played*100, H2H only, no mode param', () => {
    const p1 = 'HalveIt_WinBoard_P1', p2 = 'HalveIt_WinBoard_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g1 = halveItGame([p1, p2], TARGETS_1ROUND); db.completeGame(g1.gameId, p1);
    const g2 = halveItGame([p1, p2], TARGETS_1ROUND); db.completeGame(g2.gameId, p2);
    const rows = db.getHalveItWinLeaderboard();
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[p1].played, 2);
    assert.equal(byName[p1].won, 1);
    assert.equal(byName[p1].rate, 50);
  });
});

describe('X01/Cricket/Baseball/Shanghai/Halve-It isolation regression (turns.scored means a different quantity per game type)', () => {
  test('a 60-point Halve-It round never counts as an X01 180 or feeds Cricket/Baseball/Shanghai\'s stats', () => {
    const name = 'Isolation_HalveIt_Player';
    db.addPlayer(name);
    const g = halveItGame([name, 'Isolation_HalveIt_Opp'], TARGETS_1ROUND);
    db.addPlayer('Isolation_HalveIt_Opp');
    halveItTurn(g.gameId, name, 1, 1, [[20,3]], { scored: 60 });
    assert.equal(db.getSummary().oneEighties, 0, 'a 60-point halve-it round never satisfies the X01 scored=180 check');
    const x01Bubbles = db.getPlayerStatBubbles(name, 'h2h');
    assert.equal(x01Bubbles.one80s, 0);
    const cricketBubbles = db.getCricketStatBubbles(name, 'h2h');
    assert.equal(cricketBubbles.mpr, null, 'no cricket rounds recorded for this player at all');
    const shanghaiBubbles = db.getShanghaiStatBubbles(name, 'h2h');
    assert.equal(shanghaiBubbles.ppr, null, 'no shanghai rounds recorded for this player at all');
  });
});

// Custom target editor (docs/archive/halve-it-roadmap.md "Custom target editor",
// docs/open-roadmap-items.md item 19): config.targets rides in from the untrusted client,
// so createGame() validates it — a malformed target array must be rejected before it can
// reach the write-time consistency guard / saved-game replay that both derive each round's
// expected points from it. A well-formed custom set (including single/double/treble rings
// and the Bull) is accepted and normalized to the {sector[, ring]} shape.
describe('createGame — Halve-It custom target validation (item 19)', () => {
  const P = [{ name: 'HITargA' }, { name: 'HITargB' }];
  const make = (targets) => db.createGame({
    category: 'Custom Halve-It', legsPerSet: 1, setsPerGame: 1, practice: 0,
    gameType: 'halve_it', config: { targets }, players: P,
  });

  test('accepts a well-formed custom target sequence and stores the normalized shape', () => {
    const g = make([{ sector: 20 }, { sector: 7, ring: 'double' }, { sector: 5, ring: 'treble' }, { sector: 19, ring: 'single' }, { sector: 25 }, { sector: 25, ring: 'double' }]);
    const stored = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id=?').get(g.gameId).config);
    assert.deepEqual(stored.targets, [
      { sector: 20 }, { sector: 7, ring: 'double' }, { sector: 5, ring: 'treble' },
      { sector: 19, ring: 'single' }, { sector: 25 }, { sector: 25, ring: 'double' },
    ], 'normalized to exactly {sector[, ring]}, no extra fields');
  });

  test('strips any extra client-supplied field on a target entry', () => {
    const g = make([{ sector: 20, ring: 'double', evil: '<script>', bonus: 999 }]);
    const stored = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id=?').get(g.gameId).config);
    assert.deepEqual(stored.targets, [{ sector: 20, ring: 'double' }]);
  });

  test('rejects malformed target arrays', () => {
    assert.throws(() => make([]), /1 to 20 rounds/);
    assert.throws(() => make(new Array(21).fill({ sector: 20 })), /1 to 20 rounds/);
    assert.throws(() => make('nope'), /1 to 20 rounds/);
    assert.throws(() => make([{ sector: 21 }]), /sector must be an integer 1-20 or 25/);
    assert.throws(() => make([{ sector: 0 }]), /sector must be an integer 1-20 or 25/);
    assert.throws(() => make([{ sector: 20, ring: 'quad' }]), /ring must be/);
    assert.throws(() => make([{ sector: 25, ring: 'treble' }]), /Bull has no treble ring/);
    assert.throws(() => make([null]), /each target must be an object/);
  });

  test('omitted config.targets is allowed (keeps the classic default)', () => {
    assert.doesNotThrow(() => db.createGame({
      category: 'Halve-It', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'halve_it', config: {}, players: P,
    }));
  });
});
