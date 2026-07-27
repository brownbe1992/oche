'use strict';
// Ten defects found by the 2026-07 all-game-modes code review, pinned so they
// cannot come back. Grouped by what each one actually broke, because the failure
// modes are quite different and the reasoning is worth keeping next to the case.
//
// Every one of these produced a plausible-looking wrong answer rather than an
// error, which is why none of them showed up in 1,625 passing tests.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');
const S = require('../../frontend/scoring.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

const dart = (dartNo, sector, multiplier) => ({ dartNo, sector, multiplier });
let seq = 0;
const uniq = (p) => `${p}_${++seq}`;

describe('Killer: a player must have a life before they can lose one', () => {
  // docs/game-modes-roadmap.md's primer: "a player REDUCED TO 0 lives is
  // eliminated", and "every player starts at 0 lives". Checking `lives === 0`
  // alone conflates those, so the first player to reach killer status could
  // eliminate an opponent who had not yet thrown — ending a two-player leg on
  // dart 2 of the match.
  const turn = (throwerName, sector, mult) => ({ throwerName, sector, mult });

  test('a killer cannot eliminate an opponent still on their starting 0', () => {
    const participants = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const numbers = { 1: 20, 2: 19 };
    // A trebles their own 20 -> 3 lives, becomes a killer. Then hits B's 19.
    const r = S.rebuildKillerState({ participants, numbers, threshold: 3, turns: [
      turn('A', 20, 3),
      turn('A', 19, 1),
    ] });
    const b = r.players.find(p => p.name === 'B');
    assert.equal(b.lives, 0);
    assert.equal(b.eliminated, false, 'B never had a life to be reduced from');
    assert.ok(!r.winner, 'and the leg is certainly not over');
  });

  test('a player who earned lives and lost them all IS eliminated', () => {
    const participants = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const numbers = { 1: 20, 2: 19 };
    const r = S.rebuildKillerState({ participants, numbers, threshold: 3, turns: [
      turn('B', 19, 1),      // B: 1 life
      turn('A', 20, 3),      // A: 3 lives, killer
      turn('A', 19, 1),      // A attacks B: 1 -> 0
    ] });
    const b = r.players.find(p => p.name === 'B');
    assert.equal(b.lives, 0);
    assert.equal(b.eliminated, true, 'B was reduced to 0 from 1');
    assert.equal(r.winner, 'A');
  });

  test('an overkill still eliminates — the clamp is not the bug', () => {
    const participants = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const numbers = { 1: 20, 2: 19 };
    const r = S.rebuildKillerState({ participants, numbers, threshold: 3, turns: [
      turn('B', 19, 1),      // B: 1 life
      turn('A', 20, 3),      // A: killer
      turn('A', 19, 3),      // treble attack: 1 - 3 clamps to 0
    ] });
    assert.equal(r.players.find(p => p.name === 'B').eliminated, true);
  });

  test('a self-kill on your own double still eliminates a killer on 1 life', () => {
    const participants = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const numbers = { 1: 20, 2: 19 };
    const r = S.rebuildKillerState({ participants, numbers, threshold: 3, turns: [
      turn('B', 19, 1),
      turn('A', 20, 3),      // A: 3, killer
      turn('A', 20, 2),      // own double: -1 -> 2
      turn('A', 20, 2),      // -> 1
      turn('A', 20, 2),      // -> 0, eliminated by their own hand
    ] });
    assert.equal(r.players.find(p => p.name === 'A').eliminated, true);
  });
});

describe('Around the World: a miss has no ring', () => {
  // The 63 outcomes are keyed `sector:mult`, and exactly one of them is a miss.
  // An armed Double/Treble surviving onto a miss minted `0:2`/`0:3` — a 64th and
  // 65th key that counted toward the 63 and toward the lifetime badge.
  test('a miss normalises to a single, whatever multiplier was armed', () => {
    for (const m of [1, 2, 3]) {
      const d = S.makeDartCore(0, m);
      assert.equal(d.sector, 0);
      assert.equal(d.mult, 1, `Miss with multiplier ${m} armed must still be one miss`);
    }
  });

  test('so the outcome set cannot exceed the 63 real outcomes', () => {
    const keys = new Set();
    for (let sector = 1; sector <= 20; sector++) {
      for (const m of [1, 2, 3]) { const d = S.makeDartCore(sector, m); keys.add(`${d.sector}:${d.mult}`); }
    }
    for (const m of [1, 2, 3]) { const d = S.makeDartCore(25, m); keys.add(`${d.sector}:${d.mult}`); }
    for (const m of [1, 2, 3]) { const d = S.makeDartCore(0, m); keys.add(`${d.sector}:${d.mult}`); }
    assert.equal(keys.size, 63, '20 numbers x 3 rings, both bulls, and exactly one miss');
  });

  test('the treble-bull guard it sits beside is untouched', () => {
    assert.equal(S.makeDartCore(25, 3).mult, 1, 'there is no treble bull');
    assert.equal(S.makeDartCore(25, 2).mult, 2, 'but the bull itself is a double');
  });
});

describe('Halve-It: a new leg starts with a clean round card', () => {
  // rebuildHalveItState()'s resetLeg cleared every per-leg field except
  // roundHalved, so a resumed multi-leg game showed the PREVIOUS leg's halving
  // marks against this leg's totals. resetPlayerForNextLegHalveIt() clears it live.
  const visit = (playerIndex, legNo, darts) => ({ playerIndex, setNo: 1, legNo, darts });

  test('halving marks do not survive into the next leg', () => {
    // Leg 1 round 1: target is 20 by default; miss it entirely -> halved.
    // Then leg 2, where nothing has been halved yet.
    const r = S.rebuildHalveItState({ names: ['A'], legsPerSet: 3, targets: null, turns: [
      visit(0, 1, [{ sector: 1, mult: 1 }, { sector: 1, mult: 1 }, { sector: 1, mult: 1 }]),
      visit(0, 2, [{ sector: 20, mult: 1 }, { sector: 20, mult: 1 }, { sector: 20, mult: 1 }]),
    ] });
    const p = r.players[0];
    assert.deepEqual(p.roundHalved, { 1: false },
      "leg 2's card must show only leg 2 — a stale `true` from leg 1 is the bug");
    assert.equal(p.everHalved, false, 'and its sibling per-leg flag agrees');
  });

  test('within one leg the marks are still kept', () => {
    const r = S.rebuildHalveItState({ names: ['A'], legsPerSet: 3, targets: null, turns: [
      visit(0, 1, [{ sector: 1, mult: 1 }, { sector: 1, mult: 1 }, { sector: 1, mult: 1 }]),
    ] });
    assert.equal(r.players[0].roundHalved[1], true, 'the round WAS halved');
    assert.equal(r.players[0].everHalved, true);
  });
});

describe('createGame validates the config it is handed', () => {
  test('Cricket must be given exactly the classic number of targets', () => {
    db.addPlayer('CFG_A'); db.addPlayer('CFG_B');
    const players = [{ name: 'CFG_A' }, { name: 'CFG_B' }];
    const make = (numbers) => db.createGame({ category: 'Cricket', legsPerSet: 1, setsPerGame: 1,
      practice: 0, gameType: 'cricket', config: { numbers }, players });

    // All 21 numbers made every dart a mark: one T3/T11/T5 visit scored MPR 9
    // and a 9-mark round, permanently topping both Cricket leaderboards.
    assert.throws(() => make([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,25]),
      /exactly 7 targets/);
    // A single target dropped getCricketPerfectLegStats()'s theoretical minimum
    // to one dart, making a lone T20 a Perfect Leg.
    assert.throws(() => make([20]), /exactly 7 targets/);
    assert.throws(() => make([15,16,17,18,19,20,21]), /1-20 or 25/);
    assert.throws(() => make([15,15,16,17,18,19,20]), /distinct/);
    assert.ok(make([15,16,17,18,19,20,25]).gameId, 'the classic set is still fine');
    assert.ok(make([1,2,3,4,5,6,25]).gameId, 'and so is a legitimate custom set');
  });

  test('Shanghai rounds must be playable', () => {
    db.addPlayer('CFG_S');
    const make = (rounds) => db.createGame({ category: 'Shanghai', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'shanghai', config: { rounds }, players: [{ name: 'CFG_S' }] });
    // rounds: 9999 produced targets above 20 that no dart can match — every visit
    // forced to 0 points, an unwinnable game, and a PPR dragged down by it.
    assert.throws(() => make(9999), /between 1 and 20/);
    assert.throws(() => make(0), /between 1 and 20/);
    assert.throws(() => make(7.5), /between 1 and 20/);
    assert.ok(make(7).gameId);
    assert.ok(make(20).gameId);
  });
});

describe("Shanghai's write-time guard checks legWon, not just scored", () => {
  test('a claimed Shanghai that is not one is rejected', () => {
    const name = uniq('SH');
    db.addPlayer(name);
    const g = db.createGame({ category: 'Shanghai', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'shanghai', config: { rounds: 7 }, players: [{ name }] });
    // Round 1's number is 1. Three darts on 19 score nothing and are no Shanghai;
    // leg_won drives the Shanghai! leaderboard, the badge and the won-legs query.
    assert.throws(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0,
      bust: false, checkout: false, checkoutPoints: null, legWon: true,
      darts: [dart(1, 19, 1), dart(2, 19, 1), dart(3, 19, 1)] }, { enforceConsistency: true }),
      /legWon must match/);
  });

  test('a real Shanghai is accepted, and omitting the flag on one is rejected', () => {
    const name = uniq('SH');
    db.addPlayer(name);
    const g = db.createGame({ category: 'Shanghai', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'shanghai', config: { rounds: 7 }, players: [{ name }] });
    // Round 1, number 1: single + double + treble of 1 = a genuine Shanghai, 6 points.
    const realShanghai = [dart(1, 1, 1), dart(2, 1, 2), dart(3, 1, 3)];
    assert.throws(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 6,
      bust: false, checkout: false, checkoutPoints: null, legWon: false, darts: realShanghai },
      { enforceConsistency: true }), /legWon must match/, 'the check runs in both directions');
    assert.ok(db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 6,
      bust: false, checkout: false, checkoutPoints: null, legWon: true, darts: realShanghai },
      { enforceConsistency: true }));
  });

  test('an ordinary scoring visit still passes with legWon false', () => {
    const name = uniq('SH');
    db.addPlayer(name);
    const g = db.createGame({ category: 'Shanghai', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'shanghai', config: { rounds: 7 }, players: [{ name }] });
    assert.ok(db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 4,
      bust: false, checkout: false, checkoutPoints: null, legWon: false,
      darts: [dart(1, 1, 1), dart(2, 1, 3), dart(3, 5, 1)] }, { enforceConsistency: true }));
  });
});

describe('leaderboards report the run that set the record', () => {
  test('the Checkout Ladder board dates the peak rung to the run that reached it', () => {
    const name = uniq('LDR');
    db.addPlayer(name);
    const mk = () => db.createGame({ category: '121 Checkout Ladder', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'checkout_ladder', players: [{ name }] });
    const peak = mk();
    db.addTurn(peak.gameId, { player: name, set: 1, leg: 1, scored: 150, bust: false,
      checkout: true, checkoutPoints: 150, targetScore: 150,
      darts: [dart(1, 20, 3), dart(2, 18, 3), dart(3, 18, 2)] });
    db._db.prepare("UPDATE turns SET created_at='2026-01-05 12:00:00' WHERE game_id=?").run(peak.gameId);

    const later = mk();
    db.addTurn(later.gameId, { player: name, set: 1, leg: 1, scored: 121, bust: false,
      checkout: true, checkoutPoints: 121, targetScore: 121,
      darts: [dart(1, 19, 3), dart(2, 20, 3), dart(3, 2, 2)] });
    db._db.prepare("UPDATE turns SET created_at='2026-07-27 12:00:00' WHERE game_id=?").run(later.gameId);

    const row = db.getCheckoutLadderLeaderboard().find(r => r.name === name);
    assert.equal(row.bestTarget, 150);
    assert.ok(row.achievedAt.startsWith('2026-01-05'),
      `achievedAt was ${row.achievedAt} — it must be the run that reached 150, not the latest ladder turn`);
  });
});

describe('Shanghai won legs apply one rule to a whole match', () => {
  test('an abandoned match does not count its instant Shanghai', () => {
    const name = uniq('SHW');
    db.addPlayer(name);
    const opp = uniq('SHW_OPP');
    db.addPlayer(opp);
    const g = db.createGame({ category: 'Shanghai', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'shanghai', config: { rounds: 7 }, players: [{ name }, { name: opp }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 6, bust: false, checkout: false,
      checkoutPoints: null, legWon: true, darts: [dart(1, 1, 1), dart(2, 1, 2), dart(3, 1, 3)] });
    db.abandonGame(g.gameId);

    // getShanghaiWonLegs() is internal, so this asserts through the surface it
    // feeds: Personal Bests are derived from the same won-leg rows.
    const pb = db.getShanghaiPersonalBests(name, 'h2h');
    assert.ok(!pb || !pb.bestLegPoints,
      `an abandoned match must not set a record — got ${JSON.stringify(pb)}. The finalRoundWins `
      + 'CTE already required completed_at; the instant-win branch must too');
  });
});
