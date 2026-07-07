'use strict';
// Committed tests for Ghost Opponent win/loss tracking (docs/ghost-opponent-roadmap.md):
// recordGhostRace()'s validation (result enum, source-leg ownership re-check, the
// race game actually belonging to that player) and getGhostRaceRecord()'s win/loss
// counting.
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

let counter = 0;
function uniquePlayer() {
  const name = `ghostrace_${++counter}`;
  db.addPlayer(name);
  return name;
}
// Builds one won X01 leg for `name` in a fresh practice game, returning
// {gameId, setNo, legNo} suitable as a recordGhostRace() sourceGameId/etc.
function buildWonLeg(name) {
  const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
  db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 100, checkout: true, checkoutPoints: 100,
    darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 2 }] });
  return { gameId: g.gameId, setNo: 1, legNo: 1 };
}
function buildRaceGame(name) {
  return db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] }).gameId;
}

describe('recordGhostRace validation', () => {
  test('records a win and a loss, both readable via getGhostRaceRecord', () => {
    const name = uniquePlayer();
    const leg = buildWonLeg(name);
    const race1 = buildRaceGame(name);
    const race2 = buildRaceGame(name);
    db.recordGhostRace(name, { gameId: race1, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'win', humanDarts: 9, ghostDarts: 12 });
    db.recordGhostRace(name, { gameId: race2, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'loss' });
    assert.deepEqual(db.getGhostRaceRecord(name), { wins: 1, losses: 1, totalRaces: 2 });
  });

  test('rejects a result other than "win"/"loss"', () => {
    const name = uniquePlayer();
    const leg = buildWonLeg(name);
    const race = buildRaceGame(name);
    assert.throws(() => db.recordGhostRace(name, { gameId: race, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'tie' }),
      /result must be/);
  });

  test('rejects a race game the player never played in', () => {
    const owner = uniquePlayer();
    const other = uniquePlayer();
    const leg = buildWonLeg(owner);
    const race = buildRaceGame(owner);
    assert.throws(() => db.recordGhostRace(other, { gameId: race, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'win' }),
      /did not play in that game/);
  });

  test('rejects a source leg the player never actually won (re-validated server-side, not trusted from the client)', () => {
    const name = uniquePlayer();
    const race = buildRaceGame(name);
    // A game with no checkout at all — never won
    const unwon = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(unwon.gameId, { player: name, set: 1, leg: 1, scored: 60,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    assert.throws(() => db.recordGhostRace(name, { gameId: race, sourceGameId: unwon.gameId, sourceSetNo: 1, sourceLegNo: 1, result: 'win' }),
      /Source leg not found/);
  });

  test('rejects a source leg belonging to a different player entirely — can\'t fabricate a fake win history', () => {
    const owner = uniquePlayer();
    const impostor = uniquePlayer();
    const leg = buildWonLeg(owner);
    const race = buildRaceGame(impostor);
    assert.throws(() => db.recordGhostRace(impostor, { gameId: race, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'win' }),
      /Source leg not found/);
  });

  test('rejects a nonexistent race game', () => {
    const name = uniquePlayer();
    const leg = buildWonLeg(name);
    assert.throws(() => db.recordGhostRace(name, { gameId: 999999, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'win' }),
      /Game not found/);
  });

  test('an unknown player is rejected', () => {
    assert.throws(() => db.recordGhostRace('Ghostrace_Nobody', { gameId: 1, sourceGameId: 1, sourceSetNo: 1, sourceLegNo: 1, result: 'win' }),
      /Player not found/);
  });
});

describe('getGhostRaceRecord', () => {
  test('an unknown player returns a zeroed record rather than throwing', () => {
    assert.deepEqual(db.getGhostRaceRecord('Ghostrace_NobodyElse'), { wins: 0, losses: 0, totalRaces: 0 });
  });

  test('a player with no races yet returns a zeroed record', () => {
    const name = uniquePlayer();
    assert.deepEqual(db.getGhostRaceRecord(name), { wins: 0, losses: 0, totalRaces: 0 });
  });
});

describe('ghost_races cascade + export behavior', () => {
  test('included in getFullDatabaseExport()', () => {
    const name = uniquePlayer();
    const leg = buildWonLeg(name);
    const race = buildRaceGame(name);
    db.recordGhostRace(name, { gameId: race, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'win' });
    const dump = db.getFullDatabaseExport();
    assert.ok(Array.isArray(dump.ghostRaces));
    assert.ok(dump.ghostRaces.some(r => r.game_id === race));
  });

  test('resetStats() clears ghost_races via the games cascade', () => {
    const name = uniquePlayer();
    const leg = buildWonLeg(name);
    const race = buildRaceGame(name);
    db.recordGhostRace(name, { gameId: race, sourceGameId: leg.gameId, sourceSetNo: leg.setNo, sourceLegNo: leg.legNo, result: 'win' });
    assert.equal(db.getGhostRaceRecord(name).totalRaces, 1);
    db.resetStats();
    assert.equal(db.getGhostRaceRecord(name).totalRaces, 0);
  });
});
