'use strict';
// Committed tests for backend/db.js's Killer stat formulas
// (docs/archive/game-modes-roadmap.md "Killer", REFERENCE.md's Killer section) —
// against a scratch SQLite database. Not exhaustive; see db.x01-stats.test.js's
// header comment for the same "focused, not 100% coverage" framing.
//
// Turns here are inserted directly via db.addTurn() WITHOUT
// {enforceConsistency:true} (the established fixture convention across this
// whole test suite — see db.turn-consistency-guard.test.js's own header
// comment), so a full leg can be constructed directly against a KNOWN number
// assignment (createGame()'s own random assignment is read back and used).
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

function killerGame(names, opts = {}) {
  return db.createGame({
    category: 'Killer', legsPerSet: opts.legsPerSet || 1, setsPerGame: opts.setsPerGame || 1,
    practice: opts.practice != null ? opts.practice : 0,
    gameType: 'killer', config: opts.lives ? { lives: opts.lives } : {},
    players: names.map(name => ({ name })),
  });
}
function kt(gameId, player, set, leg, sector, mult, scored, affectedPlayer) {
  db.addTurn(gameId, {
    player, set, leg, scored, bust: false, checkout: false, checkoutPoints: null, affectedPlayer: affectedPlayer || null,
    darts: [{ dartNo: 1, sector, multiplier: mult }],
  });
}

describe('getKillerStatBubbles', () => {
  test('gamesPlayed/winRate come from games.winner_id; kills/livesLost/survivedWithoutKiller come from leg replay', () => {
    const a = 'Killer_Bubbles_A', b = 'Killer_Bubbles_B';
    db.addPlayer(a); db.addPlayer(b);
    const { gameId, config } = killerGame([a, b]);
    const na = config.numbers[a], nb = config.numbers[b];
    kt(gameId, a, 1, 1, na, 3, 3, a);   // a: treble own -> 3 lives, killer
    kt(gameId, b, 1, 1, nb, 1, 1, b);   // b: single own -> 1 life
    kt(gameId, a, 1, 1, nb, 1, 1, b);   // a attacks b for 1 -> b eliminated, a wins the leg
    db.completeGame(gameId, a);

    const bubbles = db.getKillerStatBubbles(a, 'h2h');
    assert.equal(bubbles.gamesPlayed, 1);
    assert.equal(bubbles.winRate, 100);
    assert.equal(bubbles.avgKillsPerLeg, 1, 'a landed exactly 1 kill, across 1 leg');
    assert.equal(bubbles.avgLivesLostPerLeg, 0, 'a never lost any lives this leg');

    const bubblesB = db.getKillerStatBubbles(b, 'h2h');
    assert.equal(bubblesB.gamesPlayed, 1);
    assert.equal(bubblesB.winRate, 0);
    assert.equal(bubblesB.avgKillsPerLeg, 0);
    assert.equal(bubblesB.avgLivesLostPerLeg, 1);
    assert.equal(bubblesB.survivedWithoutKillerRate, 0, 'b was eliminated -- did not survive the leg');
  });

  test('survivedWithoutKillerRate credits a player who rode out the whole leg without becoming a killer', () => {
    const a = 'Killer_Survive_A', b = 'Killer_Survive_B', c = 'Killer_Survive_C';
    db.addPlayer(a); db.addPlayer(b); db.addPlayer(c);
    const { gameId, config } = killerGame([a, b, c]);
    const na = config.numbers[a], nb = config.numbers[b], nc = config.numbers[c];
    kt(gameId, a, 1, 1, na, 3, 3, a);   // a killer
    kt(gameId, b, 1, 1, nb, 3, 3, b);   // b killer
    // c never throws at their own number at all this leg -- never becomes a killer.
    kt(gameId, a, 1, 1, nb, 3, 3, b);   // a eliminates b (3 lives -> 0) -- only a and c remain, no winner yet (2 alive)
    db.completeGame(gameId, a);

    const bubblesC = db.getKillerStatBubbles(c, 'h2h');
    assert.equal(bubblesC.survivedWithoutKillerRate, 100, 'c never became a killer but also was never eliminated');
  });

  test('a player with no Killer history gets a zeroed/null bubble set, not a crash', () => {
    const a = 'Killer_Bubbles_None';
    db.addPlayer(a);
    const bubbles = db.getKillerStatBubbles(a, 'h2h');
    assert.equal(bubbles.gamesPlayed, 0);
    assert.equal(bubbles.winRate, null);
    assert.equal(bubbles.avgKillsPerLeg, null);
    assert.equal(bubbles.avgLivesLostPerLeg, null);
    assert.equal(bubbles.survivedWithoutKillerRate, null);
  });

  test('an unknown player name returns null', () => {
    assert.equal(db.getKillerStatBubbles('NoSuchKillerPlayer', 'h2h'), null);
  });
});

describe('getKillerPersonalBests', () => {
  test('mostKillsInALeg is the MAX across every leg played', () => {
    const a = 'Killer_PB_A', b = 'Killer_PB_B', c = 'Killer_PB_C';
    db.addPlayer(a); db.addPlayer(b); db.addPlayer(c);
    const { gameId, config } = killerGame([a, b, c]);
    const na = config.numbers[a], nb = config.numbers[b], nc = config.numbers[c];
    kt(gameId, a, 1, 1, na, 3, 3, a);  // a killer
    kt(gameId, b, 1, 1, nb, 1, 1, b);  // b builds 1 life
    kt(gameId, c, 1, 1, nc, 1, 1, c);  // c builds 1 life
    kt(gameId, a, 1, 1, nb, 1, 1, b);  // a kills b (1 kill)
    kt(gameId, a, 1, 1, nc, 1, 1, c);  // a kills c (2nd kill) -- a wins the leg
    db.completeGame(gameId, a);

    const pb = db.getKillerPersonalBests(a, 'h2h');
    assert.equal(pb.mostKillsInALeg, 2);
  });

  test('a player with no Killer history gets a null field, not a crash', () => {
    const a = 'Killer_PB_None';
    db.addPlayer(a);
    const pb = db.getKillerPersonalBests(a, 'h2h');
    assert.equal(pb.mostKillsInALeg, null);
  });
});

describe('getKillerWinLeaderboard', () => {
  test('one row per player, win/played/rate derived from games.winner_id, H2H only', () => {
    const a = 'Killer_Board_A', b = 'Killer_Board_B';
    db.addPlayer(a); db.addPlayer(b);
    const { gameId: g1 } = killerGame([a, b]);
    db.completeGame(g1, a);
    const { gameId: g2 } = killerGame([a, b]);
    db.completeGame(g2, b);
    const { gameId: g3 } = killerGame([a, b]);
    db.completeGame(g3, a);

    const board = db.getKillerWinLeaderboard();
    const rowA = board.find(r => r.name === a);
    const rowB = board.find(r => r.name === b);
    assert.equal(rowA.played, 3);
    assert.equal(rowA.won, 2);
    assert.equal(rowA.rate, +((2 / 3) * 100).toFixed(1));
    assert.equal(rowB.played, 3);
    assert.equal(rowB.won, 1);
  });
});
