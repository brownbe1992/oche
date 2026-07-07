'use strict';
// Committed tests for backend/db.js's Dart Builder / loadout customization
// (docs/dart-builder-roadmap.md): component CRUD + validation, loadout CRUD,
// default-loadout selection, and duplication.
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
  const name = `dartbuilder_${++counter}`;
  db.addPlayer(name, 'double', {});
  return name;
}

describe('dart_components CRUD + validation', () => {
  test('creates a barrel with all fields and reads it back', () => {
    const name = uniquePlayer();
    const c = db.createComponent(name, 'barrel', {
      name: 'Red Dragon Barrel', lengthMm: 'medium', weightG: 24,
      material: 'tungsten_95', shape: 'torpedo', grip: 'knurled', notes: 'stock set',
    });
    assert.equal(c.type, 'barrel');
    assert.equal(c.weightG, 24);
    assert.equal(c.material, 'tungsten_95');
    assert.equal(c.grip, 'knurled');
    const listed = db.listComponents(name, 'barrel');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, c.id);
  });

  test('rejects a barrel weight outside the 10-40g range', () => {
    const name = uniquePlayer();
    assert.throws(() => db.createComponent(name, 'barrel', { name: 'Bad', weightG: 5 }), /grams/);
    assert.throws(() => db.createComponent(name, 'barrel', { name: 'Bad', weightG: 41 }), /grams/);
  });

  test('rejects weight_g on a shaft or flight', () => {
    const name = uniquePlayer();
    assert.throws(() => db.createComponent(name, 'shaft', { name: 'Bad', weightG: 20 }), /weight only applies to a barrel/);
    assert.throws(() => db.createComponent(name, 'flight', { name: 'Bad', weightG: 20 }), /weight only applies to a barrel/);
  });

  test('rejects grip on a shaft or flight', () => {
    const name = uniquePlayer();
    assert.throws(() => db.createComponent(name, 'shaft', { name: 'Bad', grip: 'knurled' }), /grip only applies to a barrel/);
  });

  test('shaft "type" (fixed/spinning) is validated against the shaft enum, not barrel shapes', () => {
    const name = uniquePlayer();
    const c = db.createComponent(name, 'shaft', { name: 'Spinny', shape: 'spinning' });
    assert.equal(c.shape, 'spinning');
    assert.throws(() => db.createComponent(name, 'shaft', { name: 'Bad', shape: 'torpedo' }), /shape must be one of/);
  });

  test('rejects an unknown material/shape/length-range value', () => {
    const name = uniquePlayer();
    assert.throws(() => db.createComponent(name, 'barrel', { name: 'Bad', material: 'unobtainium' }), /material must be one of/);
    assert.throws(() => db.createComponent(name, 'barrel', { name: 'Bad', shape: 'hexagonal' }), /shape must be one of/);
    assert.throws(() => db.createComponent(name, 'barrel', { name: 'Bad', lengthMm: 'gigantic' }), /length must be one of/);
  });

  test('rejects an unknown component type', () => {
    const name = uniquePlayer();
    assert.throws(() => db.createComponent(name, 'tip', { name: 'Bad' }), /type must be one of/);
  });

  test('updateComponent overwrites fields; deleteComponent removes it', () => {
    const name = uniquePlayer();
    const c = db.createComponent(name, 'flight', { name: 'Std Flight', shape: 'standard' });
    const updated = db.updateComponent(name, c.id, { name: 'Slim Flight', shape: 'slim' });
    assert.equal(updated.name, 'Slim Flight');
    assert.equal(updated.shape, 'slim');
    db.deleteComponent(name, c.id);
    assert.equal(db.listComponents(name, 'flight').length, 0);
  });

  test('a component belonging to another player cannot be read/updated/deleted', () => {
    const owner = uniquePlayer();
    const other = uniquePlayer();
    const c = db.createComponent(owner, 'barrel', { name: 'Mine' });
    assert.throws(() => db.updateComponent(other, c.id, { name: 'Stolen' }), /Component not found/);
    assert.throws(() => db.deleteComponent(other, c.id), /Component not found/);
  });
});

describe('loadouts CRUD + default selection', () => {
  function buildFullSet(name) {
    const barrel = db.createComponent(name, 'barrel', { name: 'B', weightG: 22, material: 'brass', shape: 'straight', grip: 'smooth' });
    const shaft  = db.createComponent(name, 'shaft', { name: 'S', material: 'nylon', shape: 'fixed' });
    const flight = db.createComponent(name, 'flight', { name: 'F', material: 'standard_poly', shape: 'standard' });
    return { barrel, shaft, flight };
  }

  test('creates a loadout with all three slots + tip texture', () => {
    const name = uniquePlayer();
    const { barrel, shaft, flight } = buildFullSet(name);
    const lo = db.createLoadout(name, {
      name: 'Main Set', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id, tipTexture: 'grooved',
    });
    assert.equal(lo.barrel.id, barrel.id);
    assert.equal(lo.shaft.id, shaft.id);
    assert.equal(lo.flight.id, flight.id);
    assert.equal(lo.tipTexture, 'grooved');
    assert.equal(lo.dartCount, 3);
    assert.equal(lo.isDefault, false);
  });

  test('a loadout can be saved with slots left empty ("in progress")', () => {
    const name = uniquePlayer();
    const lo = db.createLoadout(name, { name: 'Half-built' });
    assert.equal(lo.barrel, null);
    assert.equal(lo.shaft, null);
    assert.equal(lo.flight, null);
  });

  test('rejects a slot filled with the wrong component type', () => {
    const name = uniquePlayer();
    const { barrel, shaft } = buildFullSet(name);
    assert.throws(() => db.createLoadout(name, { name: 'Bad', barrelId: shaft.id }), /not a barrel/);
    assert.throws(() => db.createLoadout(name, { name: 'Bad', shaftId: barrel.id }), /not a shaft/);
  });

  test('rejects a slot referencing another player\'s component', () => {
    const owner = uniquePlayer();
    const other = uniquePlayer();
    const { barrel } = buildFullSet(owner);
    assert.throws(() => db.createLoadout(other, { name: 'Bad', barrelId: barrel.id }), /barrel component not found/);
  });

  test('setDefaultLoadout clears any previous default for that player', () => {
    const name = uniquePlayer();
    const a = db.createLoadout(name, { name: 'A' });
    const b = db.createLoadout(name, { name: 'B' });
    db.setDefaultLoadout(name, a.id);
    assert.equal(db.getDefaultLoadout(name).id, a.id);
    db.setDefaultLoadout(name, b.id);
    const loadouts = db.listLoadouts(name);
    assert.equal(loadouts.find(l => l.id === a.id).isDefault, false);
    assert.equal(loadouts.find(l => l.id === b.id).isDefault, true);
    assert.equal(db.getDefaultLoadout(name).id, b.id);
  });

  test('setDefaultLoadout(null) clears the default entirely', () => {
    const name = uniquePlayer();
    const a = db.createLoadout(name, { name: 'A' });
    db.setDefaultLoadout(name, a.id);
    db.setDefaultLoadout(name, null);
    assert.equal(db.getDefaultLoadout(name), null);
  });

  test('duplicateLoadout copies every slot into a new row named "(copy)"', () => {
    const name = uniquePlayer();
    const { barrel, shaft, flight } = buildFullSet(name);
    const lo = db.createLoadout(name, { name: 'Original', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id, tipTexture: 'smooth' });
    const dup = db.duplicateLoadout(name, lo.id);
    assert.notEqual(dup.id, lo.id);
    assert.equal(dup.name, 'Original (copy)');
    assert.equal(dup.barrel.id, barrel.id);
    assert.equal(dup.tipTexture, 'smooth');
  });

  test('deleting a component nulls it out of any loadout slot referencing it, without deleting the loadout', () => {
    const name = uniquePlayer();
    const { barrel, shaft, flight } = buildFullSet(name);
    const lo = db.createLoadout(name, { name: 'Set', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id });
    db.deleteComponent(name, barrel.id);
    const reloaded = db.getLoadout(name, lo.id);
    assert.equal(reloaded.barrel, null);
    assert.equal(reloaded.shaft.id, shaft.id);
  });

  test('deleteLoadout removes it; a loadout belonging to another player cannot be touched', () => {
    const owner = uniquePlayer();
    const other = uniquePlayer();
    const lo = db.createLoadout(owner, { name: 'Mine' });
    assert.throws(() => db.getLoadout(other, lo.id), /Loadout not found/);
    assert.throws(() => db.updateLoadout(other, lo.id, { name: 'Stolen' }), /Loadout not found/);
    assert.throws(() => db.deleteLoadout(other, lo.id), /Loadout not found/);
    db.deleteLoadout(owner, lo.id);
    assert.equal(db.listLoadouts(owner).length, 0);
  });

  test('getDartComponentOptions returns the full enum set used by validation', () => {
    const opts = db.getDartComponentOptions();
    assert.deepEqual(opts.barrel.shapes, ['straight', 'torpedo', 'ton']);
    assert.deepEqual(opts.barrel.grips, ['smooth', 'knurled', 'ringed']);
    assert.equal(opts.barrel.weights.length, 31);
    assert.deepEqual(opts.shaft.types, ['fixed', 'spinning']);
    assert.deepEqual(opts.flight.shapes, ['standard', 'slim', 'kite', 'pear']);
    assert.deepEqual(opts.tipTextures, ['smooth', 'grooved']);
  });
});

describe('getLoadoutStats — scoping (docs/dart-builder-roadmap.md)', () => {
  function buildFullSet(name, barrelWeight) {
    const barrel = db.createComponent(name, 'barrel', { name: 'B', weightG: barrelWeight, material: 'brass', shape: 'straight' });
    const shaft  = db.createComponent(name, 'shaft', { name: 'S', material: 'nylon', shape: 'fixed' });
    const flight = db.createComponent(name, 'flight', { name: 'F', material: 'standard_poly', shape: 'standard' });
    return { barrel, shaft, flight };
  }

  // The exact test CLAUDE.md's "every new calculation gets a committed test"
  // convention calls for here: a game played under loadout A must be correctly
  // included in A's stats and excluded from B's, and vice versa.
  test('a game played under loadout A is included in A\'s stats and excluded from B\'s', () => {
    const name = uniquePlayer();
    const setA = buildFullSet(name, 22);
    const setB = buildFullSet(name, 26);
    const loA = db.createLoadout(name, { name: 'Loadout A', barrelId: setA.barrel.id, shaftId: setA.shaft.id, flightId: setA.flight.id });
    const loB = db.createLoadout(name, { name: 'Loadout B', barrelId: setB.barrel.id, shaftId: setB.shaft.id, flightId: setB.flight.id });

    const gA = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name, loadoutId: loA.id }] });
    db.addTurn(gA.gameId, { player: name, set: 1, leg: 1, scored: 180, darts: [
      { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 },
    ] });

    const statsA = db.getLoadoutStats(name, loA.id);
    const statsB = db.getLoadoutStats(name, loB.id);
    assert.equal(statsA.gamesPlayed, 1);
    assert.equal(statsA.one80s, 1);
    assert.equal(statsA.dartsThrown, 3);
    assert.equal(statsB.gamesPlayed, 0);
    assert.equal(statsB.one80s, 0);
    assert.equal(statsB.dartsThrown, 0);
  });

  test('rejects a loadout not owned by the given player', () => {
    const owner = uniquePlayer();
    const other = uniquePlayer();
    const lo = db.createLoadout(owner, { name: 'Owner Loadout' });
    assert.throws(() => db.getLoadoutStats(other, lo.id), /Loadout not found/);
  });

  // Regression: gamesPlayed/wins were originally joined through turns, so a game
  // with zero turns recorded (just started, or abandoned immediately) silently
  // didn't count as "played" under its loadout.
  test('a game with no turns recorded yet still counts toward gamesPlayed', () => {
    const name = uniquePlayer();
    const { barrel, shaft, flight } = buildFullSet(name, 24);
    const lo = db.createLoadout(name, { name: 'Fresh', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id });
    db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name, loadoutId: lo.id }] });
    const stats = db.getLoadoutStats(name, lo.id);
    assert.equal(stats.gamesPlayed, 1);
    assert.equal(stats.dartsThrown, 0);
  });
});

describe('createGame() loadout integration (docs/dart-builder-roadmap.md)', () => {
  function buildFullSet(name, barrelWeight) {
    const barrel = db.createComponent(name, 'barrel', { name: 'B', weightG: barrelWeight, material: 'brass', shape: 'straight' });
    const shaft  = db.createComponent(name, 'shaft', { name: 'S', material: 'nylon', shape: 'fixed' });
    const flight = db.createComponent(name, 'flight', { name: 'F', material: 'standard_poly', shape: 'standard' });
    return { barrel, shaft, flight };
  }

  test('a selected loadout snapshots its barrel weight into game_players.dart_weight and loadout_id', () => {
    const name = uniquePlayer();
    const { barrel, shaft, flight } = buildFullSet(name, 26);
    const lo = db.createLoadout(name, { name: 'Match Set', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id });
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name, loadoutId: lo.id }] });
    const row = db._db.prepare('SELECT dart_weight, loadout_id FROM game_players WHERE game_id = ? AND player_id = (SELECT id FROM players WHERE name = ?)')
      .get(g.gameId, name);
    assert.equal(row.dart_weight, 26);
    assert.equal(row.loadout_id, lo.id);
  });

  test('no loadout selected leaves dart_weight NULL, even if the player has a legacy dart_weight set', () => {
    const name = uniquePlayer();
    db.setDartWeight(name, 24);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name }] });
    const row = db._db.prepare('SELECT dart_weight, loadout_id FROM game_players WHERE game_id = ? AND player_id = (SELECT id FROM players WHERE name = ?)')
      .get(g.gameId, name);
    assert.equal(row.dart_weight, null);
    assert.equal(row.loadout_id, null);
  });

  test('rejects a loadout that is missing a barrel/shaft/flight slot', () => {
    const name = uniquePlayer();
    const lo = db.createLoadout(name, { name: 'Half-built' });
    assert.throws(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name, loadoutId: lo.id }] }),
      /missing a barrel, shaft, or flight/);
  });

  test('rejects a loadout belonging to a different player', () => {
    const owner = uniquePlayer();
    const other = uniquePlayer();
    const { barrel, shaft, flight } = buildFullSet(owner, 20);
    const lo = db.createLoadout(owner, { name: 'Owner Set', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id });
    assert.throws(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, players: [{ name: other, loadoutId: lo.id }] }),
      /Loadout not found/);
  });

  test('resetStats() leaves components/loadouts intact; wipeAllData() clears them via player cascade', () => {
    const name = uniquePlayer();
    const { barrel, shaft, flight } = buildFullSet(name, 22);
    const lo = db.createLoadout(name, { name: 'Survives Reset', barrelId: barrel.id, shaftId: shaft.id, flightId: flight.id });
    db.resetStats();
    assert.equal(db.listLoadouts(name).length, 1);
    assert.equal(db.getLoadout(name, lo.id).id, lo.id);
    db.wipeAllData();
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM loadouts').get().n, 0);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM dart_components').get().n, 0);
  });
});
