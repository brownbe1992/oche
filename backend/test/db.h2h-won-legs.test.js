'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-29: computeStats()'s per-category
// H2H legs/sets record used a raw `(checkout=1 OR leg_won=1)` turn-count heuristic that
// assumed exactly one such signal per won leg. The Pressure Chamber (H2H-capable) writes
// checkout=1 on every hit round, so a single 15-round run was counted as up to 15 "won
// legs" for BOTH players; Halve-It writes neither signal, so its H2H legs counted 0. The
// fix derives each leg's real winner per game type (_h2hWonLegs()). This test plays a real
// Pressure Chamber H2H leg and a Halve-It H2H leg and asserts the winner is credited with
// exactly one leg and the loser with none.
//
// Turns are inserted via db.addTurn() WITHOUT {enforceConsistency:true} (the established
// fixture convention) so per-round scored/checkout/legWon can be hand-picked.
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

function pcTurn(gameId, player, round, scored) {
  // A full-hit Pressure Chamber round: checkout=1, leg_won=1, one dart. No bust, so the
  // leg's CP total is just SUM(scored) (no miss penalty to re-derive).
  db.addTurn(gameId, {
    player, set: 1, leg: 1, scored, bust: false, checkout: true, legWon: true, checkoutPoints: null,
    darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
  });
}
function hiTurn(gameId, player, scored) {
  // A Halve-It round: no checkout/leg_won signal at all (winner is derived from totals).
  db.addTurn(gameId, {
    player, set: 1, leg: 1, scored, bust: false, checkout: false, legWon: false, checkoutPoints: null,
    darts: [{ dartNo: 1, sector: 20, multiplier: 1 }],
  });
}

describe('BUG-29 — H2H per-category legs/sets credit the real per-leg winner', () => {
  test('Pressure Chamber H2H: the higher-CP player wins exactly one leg, not one per hit round', () => {
    const A = 'PC_A', B = 'PC_B';
    db.addPlayer(A); db.addPlayer(B);
    const g = db.createGame({
      category: 'The Pressure Chamber', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'pressure_chamber', players: [{ name: A }, { name: B }],
    });
    // Both players hit all 15 rounds; A scores more CP per round, so A wins the leg.
    for (let r = 1; r <= 15; r++) { pcTurn(g.gameId, A, r, 10); pcTurn(g.gameId, B, r, 5); }
    db.completeGame(g.gameId, A);

    const stats = db.computeStats();
    assert.equal(stats[A].h2hLegsWonByCat['The Pressure Chamber'], 1,
      'the winner is credited with ONE leg, not 15 (one per hit round)');
    assert.equal(stats[B].h2hLegsWonByCat['The Pressure Chamber'], undefined,
      'the loser is credited with no legs (was previously 15)');
    assert.equal(stats[A].h2hSetsWonByCat['The Pressure Chamber'], 1, 'the winner took the (1-leg) set');
    assert.equal(stats[B].h2hSetsWonByCat['The Pressure Chamber'], undefined, 'the loser took no set');
  });

  test('Halve-It H2H: the higher-total player wins the leg (previously counted as zero)', () => {
    const C = 'HI_C', D = 'HI_D';
    db.addPlayer(C); db.addPlayer(D);
    const g = db.createGame({
      category: 'Halve-It', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'halve_it', players: [{ name: C }, { name: D }],
    });
    // C finishes on a higher total than D → C wins the leg (no checkout/leg_won signal).
    for (let r = 0; r < 3; r++) { hiTurn(g.gameId, C, 20); hiTurn(g.gameId, D, 10); }
    db.completeGame(g.gameId, C);

    const stats = db.computeStats();
    assert.equal(stats[C].h2hLegsWonByCat['Halve-It'], 1, 'the higher-total player wins one leg');
    assert.equal(stats[D].h2hLegsWonByCat['Halve-It'], undefined, 'the loser wins none');
  });

  test('X01 H2H remains correct: one checkout = one won leg', () => {
    const E = 'X_E', F = 'X_F';
    db.addPlayer(E); db.addPlayer(F);
    const g = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: E }, { name: F }],
    });
    db.addTurn(g.gameId, { player: E, set: 1, leg: 1, scored: 40, bust: false, checkout: true, checkoutPoints: 40,
      darts: [{ dartNo: 1, sector: 20, multiplier: 2 }] });
    db.addTurn(g.gameId, { player: F, set: 1, leg: 1, scored: 20, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }] });
    db.completeGame(g.gameId, E);

    const stats = db.computeStats();
    assert.equal(stats[E].h2hLegsWonByCat['501'], 1, 'the checkout player wins the leg');
    assert.equal(stats[F].h2hLegsWonByCat['501'], undefined, 'the non-checkout player wins none');
  });

  test('Shanghai H2H decided on points (no instant Shanghai) credits the higher-total player', () => {
    const G = 'SH_G', H = 'SH_H';
    db.addPlayer(G); db.addPlayer(H);
    const g = db.createGame({
      category: 'Shanghai', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'shanghai', players: [{ name: G }, { name: H }],
    });
    // No leg_won=1 anywhere (no instant Shanghai) — the leg is decided purely by final
    // totals, the exact under-count case the old checkout=1/leg_won=1 heuristic scored 0.
    const shTurn = (player, round, scored) => db.addTurn(g.gameId, {
      player, set: 1, leg: 1, scored, bust: false, checkout: false, legWon: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: round, multiplier: 1 }],
    });
    for (let r = 1; r <= 3; r++) { shTurn(G, r, 20); shTurn(H, r, 5); }
    db.completeGame(g.gameId, G);

    const stats = db.computeStats();
    assert.equal(stats[G].h2hLegsWonByCat['Shanghai'], 1, 'the higher-total player wins the points-decided leg');
    assert.equal(stats[H].h2hLegsWonByCat['Shanghai'], undefined, 'the loser wins none');
  });

  test('a set is won only once ≥ legs_per_set of its legs are taken (legs_per_set > 1)', () => {
    const I = 'SET_I', J = 'SET_J';
    db.addPlayer(I); db.addPlayer(J);
    const g = db.createGame({
      category: '501', legsPerSet: 2, setsPerGame: 1, practice: 0, players: [{ name: I }, { name: J }],
    });
    // I wins both legs of set 1 (two checkouts) → 2 legs, which meets legs_per_set=2 → 1 set.
    for (const leg of [1, 2]) {
      db.addTurn(g.gameId, { player: I, set: 1, leg, scored: 40, bust: false, checkout: true, checkoutPoints: 40,
        darts: [{ dartNo: 1, sector: 20, multiplier: 2 }] });
      db.addTurn(g.gameId, { player: J, set: 1, leg, scored: 20, bust: false, checkout: false, checkoutPoints: null,
        darts: [{ dartNo: 1, sector: 20, multiplier: 1 }] });
    }
    db.completeGame(g.gameId, I);

    const stats = db.computeStats();
    assert.equal(stats[I].h2hLegsWonByCat['501'], 2, 'both legs credited');
    assert.equal(stats[I].h2hSetsWonByCat['501'], 1, 'two won legs meet legs_per_set=2 → exactly one set');
    assert.equal(stats[J].h2hSetsWonByCat['501'], undefined, 'the loser took no set');
  });
});
