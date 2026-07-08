'use strict';
// Committed tests for backend/db.js's addTurn() input validation — ported from a
// throwaway scratch script used during this session's audit (which added the
// treble-bull/multiplied-miss rejection) so this validation has a permanent
// regression test per CLAUDE.md's testing convention, instead of only ever
// having been checked once by hand.
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

function expect400(fn) {
  assert.throws(fn, (err) => err.status === 400);
}

describe('addTurn — darts array shape', () => {
  test('accepts 1, 2, or 3 darts', () => {
    const name = 'Turns_DartCount';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 1, darts: [{ sector: 1, multiplier: 1 }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 2, darts: [{ sector: 1, multiplier: 1 }, { sector: 1, multiplier: 1 }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 3, darts: [{ sector: 1, multiplier: 1 }, { sector: 1, multiplier: 1 }, { sector: 1, multiplier: 1 }] }));
  });

  test('rejects 0 or more than 3 darts', () => {
    const name = 'Turns_DartCountBad';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 1, multiplier: 1 }, { sector: 1, multiplier: 1 }, { sector: 1, multiplier: 1 }, { sector: 1, multiplier: 1 }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: 'not-an-array' }));
  });
});

describe('addTurn — sector/multiplier validity', () => {
  test('valid sectors: 0 (miss), 1-20 (numbers), 25 (bull)', () => {
    const name = 'Turns_ValidSectors';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    for (const sector of [0, 1, 20, 25]) {
      assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 1, darts: [{ sector, multiplier: 1 }] }));
    }
  });

  test('rejects out-of-range or non-integer sectors', () => {
    const name = 'Turns_BadSectors';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    for (const sector of [-1, 21, 24, 26, 1.5, 'x']) {
      expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector, multiplier: 1 }] }));
    }
  });

  test('rejects out-of-range or non-integer multipliers', () => {
    const name = 'Turns_BadMultipliers';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    for (const multiplier of [0, 4, -1, 1.5]) {
      expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 20, multiplier }] }));
    }
  });

  test('rejects a treble bull (25,3) — no treble bull exists on a real board', () => {
    const name = 'Turns_TrebleBull';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 25, multiplier: 3 }] }));
  });

  test('rejects a multiplied miss (0,2) or (0,3) — a miss is always multiplier 1', () => {
    const name = 'Turns_MultipliedMiss';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 2 }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 3 }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1 }] }));
  });

  test('accepts a double bull (25,2) — the one real bull multiplier besides single', () => {
    const name = 'Turns_DoubleBull';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 50, darts: [{ sector: 25, multiplier: 2 }] }));
  });
});

// docs/archive/dartboard-zone-tracking-roadmap.md: zone/missZone/missDepth/bounced are all
// purely additive Dartboard-mode-only positional metadata — each only meaningful on
// the specific dart shape it describes (a hit can't have a miss wedge, a miss can't
// have an inner/outer zone), validated the same "reject garbage, don't silently
// coerce" way as sector/multiplier above.
describe('addTurn — zone/missZone/missDepth/bounced validation', () => {
  test('zone is only valid on a single hit (sector 1-20, multiplier 1)', () => {
    const name = 'Turns_Zone';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 20, darts: [{ sector: 20, multiplier: 1, zone: 'inner' }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 20, darts: [{ sector: 20, multiplier: 1, zone: 'outer' }] }));
    // No zone at all (Pad mode / pre-feature) is still perfectly valid.
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 20, darts: [{ sector: 20, multiplier: 1 }] }));
  });

  test('rejects a garbage zone value', () => {
    const name = 'Turns_ZoneGarbage';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 20, darts: [{ sector: 20, multiplier: 1, zone: 'middle' }] }));
  });

  test('rejects zone on a double, treble, bull, or miss — only a single hit has an inner/outer distinction', () => {
    const name = 'Turns_ZoneWrongShape';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 40, darts: [{ sector: 20, multiplier: 2, zone: 'inner' }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60, darts: [{ sector: 20, multiplier: 3, zone: 'outer' }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 25, darts: [{ sector: 25, multiplier: 1, zone: 'inner' }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, zone: 'inner' }] }));
  });

  test('missZone/missDepth are only valid together, only on a miss (sector 0), and missZone is 1-20', () => {
    const name = 'Turns_MissZone';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, missZone: 20, missDepth: 'near' }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, missZone: 1, missDepth: 'far' }] }));
    // Missing depth or wedge alone is rejected — they're always set or unset together.
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, missZone: 5 }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, missDepth: 'near' }] }));
    // Wrong depth string, and an out-of-range wedge.
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, missZone: 5, missDepth: 'medium' }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, missZone: 21, missDepth: 'near' }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, missZone: 0, missDepth: 'near' }] }));
    // Only valid on an actual miss.
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 20, darts: [{ sector: 20, multiplier: 1, missZone: 5, missDepth: 'near' }] }));
  });

  test('bounced is only valid on a miss (sector 0)', () => {
    const name = 'Turns_Bounced';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, bounced: true }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 20, darts: [{ sector: 20, multiplier: 1, bounced: true }] }));
  });

  test('a bounce-out dart is stored identically to a plain miss apart from the bounced flag', () => {
    const name = 'Turns_BouncedStorage';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1, bounced: true }] });
    const row = db._db.prepare(`
      SELECT d.sector, d.multiplier, d.scored, d.bounced FROM darts d
      JOIN turns t ON t.id = d.turn_id WHERE t.game_id = ?
    `).get(g.gameId);
    assert.deepEqual({ ...row }, { sector: 0, multiplier: 1, scored: 0, bounced: 1 });
  });
});

describe('addTurn — scored/set/leg/checkoutPoints ranges', () => {
  test('scored must be between 0 and 180', () => {
    const name = 'Turns_ScoredRange';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: -1, darts: [{ sector: 1, multiplier: 1 }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 181, darts: [{ sector: 1, multiplier: 1 }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 180, darts: [{ sector: 20, multiplier: 3 }] }));
  });

  test('a non-numeric scored value is rejected, not silently coerced to 0 (Number(garbage)||0 quirk)', () => {
    const name = 'Turns_ScoredGarbage';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 'garbage', darts: [{ sector: 1, multiplier: 1 }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ sector: 0, multiplier: 1 }] }), 'an explicit 0 (a real bust) is still valid');
  });

  test('set and leg must be positive integers — explicit 0 is rejected, not silently defaulted to 1', () => {
    const name = 'Turns_SetLeg';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 0, leg: 1, scored: 0, darts: [{ sector: 1, multiplier: 1 }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 0, scored: 0, darts: [{ sector: 1, multiplier: 1 }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: -1, leg: 1, scored: 0, darts: [{ sector: 1, multiplier: 1 }] }));
  });

  test('omitted set/leg default to 1', () => {
    const name = 'Turns_SetLegDefault';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, scored: 0, darts: [{ sector: 1, multiplier: 1 }] }));
  });

  test('checkoutPoints must be between 0 and 170 when checkout is true', () => {
    const name = 'Turns_CheckoutPoints';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 171, checkout: true, checkoutPoints: 171, darts: [{ sector: 20, multiplier: 3 }] }));
    expect400(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 171, checkout: true, checkoutPoints: -1, darts: [{ sector: 20, multiplier: 3 }] }));
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 170, checkout: true, checkoutPoints: 170, darts: [{ sector: 20, multiplier: 3 }] }));
  });
});

// docs/security-audit-roadmap.md SEC-14 / docs/bug-roadmap.md BUG-2: createGame()
// previously accepted any gameType string, an unbounded category, and an unbounded
// config object — a bad gameType then counted toward every UNSCOPED aggregate while
// being silently excluded from every TYPED stat query.
describe('createGame — gameType/category/config validation', () => {
  test('accepts every known gameType', () => {
    for (const gameType of ['x01', 'cricket', 'doubles_practice', 'chuckin']) {
      assert.doesNotThrow(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType, players: [] }));
    }
  });

  test('defaults to x01 when gameType is omitted', () => {
    assert.doesNotThrow(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [] }));
  });

  test('rejects an unknown gameType', () => {
    expect400(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType: 'evil', players: [] }));
  });

  test('rejects an oversized category', () => {
    expect400(() => db.createGame({ category: 'x'.repeat(65), legsPerSet: 1, setsPerGame: 1, practice: 1, players: [] }));
    assert.doesNotThrow(() => db.createGame({ category: 'x'.repeat(64), legsPerSet: 1, setsPerGame: 1, practice: 1, players: [] }));
  });

  test('rejects an oversized config object', () => {
    expect400(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, config: { junk: 'x'.repeat(5000) }, players: [] }));
    assert.doesNotThrow(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, config: { startingScore: 501 }, players: [] }));
  });

  // docs/bug-roadmap.md BUG-5: legsPerSet/setsPerGame are clamped to a whole number
  // in [1, 99] at the write boundary (lenient — garbage floors to 1, no 400).
  test('clamps legsPerSet/setsPerGame to a whole number in [1, 99]', () => {
    const read = (gid) => db._db.prepare('SELECT legs_per_set AS legs, sets_per_game AS sets FROM games WHERE id = ?').get(gid);
    const huge = read(db.createGame({ category: '501', legsPerSet: 1e9, setsPerGame: 500, practice: 1, players: [] }).gameId);
    assert.equal(huge.legs, 99); assert.equal(huge.sets, 99);
    const frac = read(db.createGame({ category: '501', legsPerSet: 2.9, setsPerGame: 1, practice: 1, players: [] }).gameId);
    assert.equal(frac.legs, 2, 'a float floors to a whole number');
    const junk = read(db.createGame({ category: '501', legsPerSet: 0, setsPerGame: -5, practice: 1, players: [] }).gameId);
    assert.equal(junk.legs, 1); assert.equal(junk.sets, 1);
  });
});

// docs/security-audit-roadmap.md SEC-14: recordEvent() previously accepted any
// eventType string.
describe('recordEvent — eventType validation', () => {
  test('accepts every known event type', () => {
    const name = 'Events_KnownTypes';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    for (const eventType of ['game_start', 'game_end', 'set_start', 'set_end', 'leg_start', 'leg_end']) {
      assert.doesNotThrow(() => db.recordEvent(g.gameId, eventType, 1, 1));
    }
  });

  test('rejects an unknown event type', () => {
    const name = 'Events_UnknownType';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    expect400(() => db.recordEvent(g.gameId, 'made_up_event', 1, 1));
  });
});
