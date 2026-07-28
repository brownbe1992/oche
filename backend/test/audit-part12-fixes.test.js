'use strict';
// Regression cover for the tenth-pass audit's three findings
// (docs/security-audit-roadmap.md Part 12: SEC-29, SEC-30; docs/bug-roadmap.md BUG-58).
//
// All three share one root shape, which is what the pass was looking for: a rule
// enforced on one write path and absent from a second path reaching the same table.
// So every case below asserts BOTH sides — the value the front door refuses AND the
// same value now refused by the back door — because a test that only checks the back
// door would still pass if the two later drifted apart again.
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

let seq = 0;
const uniq = (p) => `${p}_${++seq}`;
const dart = (n, s, m) => ({ dartNo: n, sector: s, multiplier: m });

function x01Game(names, extra) {
  return db.createGame(Object.assign({
    category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType: 'x01',
    config: { startingScore: 501 }, players: names.map(name => ({ name })),
  }, extra || {}));
}

// A minimal but complete import payload, with one hook for the field under test.
function payload(mutate) {
  const p = {
    schemaVersion: 1,
    player: { id: 1, uuid: 'uuid-' + uniq('imp'), name: uniq('Imported'), outMode: 'double' },
    opponents: [],
    games: [{ id: 1, category: '501', legs_per_set: 1, sets_per_game: 1,
      created_at: '2026-01-01 00:00:00', completed_at: '2026-01-01 00:10:00',
      winner_id: 1, practice: 1, game_type: 'x01', config: null, player_count: 1 }],
    gamePlayers: [{ game_id: 1, player_id: 1, out_mode: 'double' }],
    turns: [{ id: 1, game_id: 1, player_id: 1, set_no: 1, leg_no: 1, scored: 60,
      bust: 0, checkout: 0, created_at: '2026-01-01 00:05:00', leg_won: 0, target_score: null }],
    darts: [{ turn_id: 1, dart_no: 1, sector: 20, multiplier: 3,
      thrown_at: '2026-01-01 00:05:00', zone: null, miss_zone: null, miss_depth: null, bounced: null }],
    playerBadges: [],
  };
  mutate(p);
  return p;
}

describe('SEC-29 — the import path validates what createGame()/addTurn() validate', () => {
  test('the control: an otherwise-valid payload still imports', () => {
    const r = db.importPlayerExport(payload(() => {}));
    assert.equal(r.gamesImported, 1);
    assert.equal(r.turnsImported, 1);
    assert.equal(r.dartsImported, 1);
  });

  test('an unknown game_type is refused — by both write paths', () => {
    const n = uniq('P12_GT');
    db.addPlayer(n);
    assert.throws(() => db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'totally_made_up', players: [{ name: n }] }), /Unknown gameType/);
    assert.throws(() => db.importPlayerExport(payload(p => { p.games[0].game_type = 'totally_made_up'; })),
      /unknown game_type/);
  });

  test('legs/sets are clamped, not stored verbatim', () => {
    // Lenient like createGame()'s own clampMatchFormat (BUG-5): garbage is bounded
    // rather than rejected, so an old export carrying a since-tightened value still
    // imports — it just can't produce "first to 1000000000 legs" or a fractional set.
    const r = db.importPlayerExport(payload(p => {
      p.games[0].legs_per_set = 1e9;
      p.games[0].sets_per_game = 2.5;
    }));
    assert.equal(r.gamesImported, 1);
    const row = db._db.prepare('SELECT legs_per_set, sets_per_game FROM games ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.legs_per_set, 99, 'clamped to the same MAX_LEGS_OR_SETS createGame uses');
    assert.equal(row.sets_per_game, 2, 'floored to a whole number');
  });

  test('an impossible dart is refused — by both write paths, via the same validator', () => {
    const n = uniq('P12_Dart');
    db.addPlayer(n);
    const g = x01Game([n]);
    assert.throws(() => db.addTurn(g.gameId, { player: n, set: 1, leg: 1, scored: 60,
      bust: false, checkout: false, darts: [dart(1, 999, 47)] }), /Invalid dart sector or multiplier/);
    assert.throws(() => db.importPlayerExport(payload(p => {
      p.darts[0].sector = 999; p.darts[0].multiplier = 47;
    })), /Invalid dart sector or multiplier/);
  });

  test('the shared validator carries ALL of its rules across, not just sector/multiplier', () => {
    // The reason validateDart() was extracted rather than partially re-implemented:
    // SEC-25 happened because a guard written for one path was never re-run against
    // another. Each of these is a distinct rule, and all three must travel together.
    for (const [label, mutate, re] of [
      ['a treble bull', p => { p.darts[0].sector = 25; p.darts[0].multiplier = 3; }, /No treble bull exists/],
      ['a ringed miss', p => { p.darts[0].sector = 0; p.darts[0].multiplier = 2; }, /A miss must have multiplier 1/],
      ['a miss wedge on a hit', p => { p.darts[0].miss_zone = 5; p.darts[0].miss_depth = 'near'; },
        /only valid on a miss/],
    ]) {
      assert.throws(() => db.importPlayerExport(payload(mutate)), re, label);
    }
  });

  test('a turn with an out-of-range scored, or a non-positive set/leg, is refused', () => {
    assert.throws(() => db.importPlayerExport(payload(p => { p.turns[0].scored = 99999; })),
      /must be between 0 and 180/);
    assert.throws(() => db.importPlayerExport(payload(p => { p.turns[0].scored = -1; })),
      /must be between 0 and 180/);
    assert.throws(() => db.importPlayerExport(payload(p => { p.turns[0].leg_no = 0; })),
      /non-positive set\/leg/);
  });

  test('a rejected file writes nothing at all — it aborts, it does not half-import', () => {
    const before = db._db.prepare('SELECT COUNT(*) n FROM games').get().n;
    assert.throws(() => db.importPlayerExport(payload(p => { p.darts[0].sector = 999; })));
    // The dart is the LAST thing inserted, so if the failure left the game and turn
    // behind, this is where that shows up.
    const after = db._db.prepare('SELECT COUNT(*) n FROM games').get().n;
    assert.equal(after, before, 'a failed import must leave no game row behind');
  });
});

describe('SEC-30 — a finished game is closed to writes', () => {
  function finishedGame() {
    const a = uniq('P12_FinA'), b = uniq('P12_FinB');
    db.addPlayer(a); db.addPlayer(b);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'x01', config: { startingScore: 501 }, players: [{ name: a }, { name: b }] });
    db.recordTurn(g.gameId, { player: a, set: 1, leg: 1, scored: 100, bust: false,
      checkout: true, checkoutPoints: 100, legWon: true,
      darts: [dart(1, 20, 3), dart(2, 20, 1), dart(3, 10, 2)] });
    db.completeGame(g.gameId, a);
    return { gameId: g.gameId, a, b };
  }

  test('all six write paths now agree that a completed game is closed', () => {
    // Four of these were already guarded; two were not. Asserted together so a
    // seventh write path added without the guard stands out against the pattern.
    const g = finishedGame();
    const refusals = {};
    for (const [label, fn] of [
      ['completeGame', () => db.completeGame(g.gameId, g.b)],
      ['abandonGame', () => db.abandonGame(g.gameId)],
      ['forfeitPlayer', () => db.forfeitPlayer(g.gameId, g.b)],
      ['saveGame', () => db.saveGame(g.gameId)],
      ['recordTurn', () => db.recordTurn(g.gameId, { player: g.b, set: 1, leg: 1, scored: 180,
        bust: false, checkout: false, darts: [dart(1, 20, 3), dart(2, 20, 3), dart(3, 20, 3)] })],
      ['deleteLastTurn', () => db.deleteLastTurn(g.gameId)],
    ]) {
      try { fn(); refusals[label] = 'ACCEPTED'; } catch (e) { refusals[label] = e.status; }
    }
    assert.deepEqual(refusals, { completeGame: 409, abandonGame: 409, forfeitPlayer: 409,
      saveGame: 409, recordTurn: 409, deleteLastTurn: 409 });
  });

  test("the winning checkout survives, which is what the old behaviour destroyed", () => {
    const g = finishedGame();
    try { db.deleteLastTurn(g.gameId); } catch (e) {}
    try { db.deleteLastTurn(g.gameId); } catch (e) {}
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM turns WHERE game_id = ?').get(g.gameId).n, 1);
    assert.deepEqual(db.getTopFinishes(g.a, 'all').map(f => f.score), [100],
      'the 100 that won the match must still be on record');
  });

  test('a still-live game is unaffected — the guard closes finished games, not all of them', () => {
    const n = uniq('P12_Live');
    db.addPlayer(n);
    const g = x01Game([n]);
    db.recordTurn(g.gameId, { player: n, set: 1, leg: 1, scored: 60, bust: false,
      checkout: false, darts: [dart(1, 20, 3)] });
    assert.doesNotThrow(() => db.deleteLastTurn(g.gameId));
    assert.doesNotThrow(() => db.recordTurn(g.gameId, { player: n, set: 1, leg: 1, scored: 60,
      bust: false, checkout: false, darts: [dart(1, 20, 3)] }));
  });

  test('an abandoned game is closed too, not just a completed one', () => {
    const n = uniq('P12_Dnf');
    db.addPlayer(n);
    const g = x01Game([n]);
    db.abandonGame(g.gameId);
    assert.throws(() => db.recordTurn(g.gameId, { player: n, set: 1, leg: 1, scored: 60,
      bust: false, checkout: false, darts: [dart(1, 20, 3)] }), /already ended/);
  });

  test('addTurn keeps an explicit opt-out, so test/seeder fixtures can plant history', () => {
    // The guard lives in addTurn() rather than only recordTurn() so the trust boundary
    // does not depend on a future route remembering to call the wrapper — the same
    // reasoning recordTurn()'s own comment gives. That makes an opt-out necessary for
    // any fixture that needs to write into an already-closed game.
    const n = uniq('P12_Opt');
    db.addPlayer(n);
    const g = x01Game([n]);
    db.completeGame(g.gameId, n);
    assert.throws(() => db.addTurn(g.gameId, { player: n, set: 1, leg: 1, scored: 60,
      bust: false, checkout: false, darts: [dart(1, 20, 3)] }), /already ended/);
    assert.doesNotThrow(() => db.addTurn(g.gameId, { player: n, set: 1, leg: 1, scored: 60,
      bust: false, checkout: false, darts: [dart(1, 20, 3)] }, { allowFinished: true }));
  });
});

describe('BUG-58 — playerBadges is shape-checked like its five sibling fields', () => {
  test('a wrong-shape playerBadges is a 400, not an unhandled TypeError', () => {
    for (const bad of [{ not: 'an array' }, 'a string', 42, true]) {
      let err;
      try { db.importPlayerExport(payload(p => { p.playerBadges = bad; })); }
      catch (e) { err = e; }
      assert.ok(err, `playerBadges=${JSON.stringify(bad)} should have been rejected`);
      // The status is the whole point: untagged meant 500 + a row in server_errors.
      assert.equal(err.status, 400, `playerBadges=${JSON.stringify(bad)} must be a 400`);
      assert.match(err.message, /playerBadges must be an array/);
      assert.ok(!/is not iterable/.test(err.message), 'must not be the raw TypeError');
    }
  });

  test('absent or null still imports — old exports predate the field', () => {
    assert.doesNotThrow(() => db.importPlayerExport(payload(p => { delete p.playerBadges; })));
    assert.doesNotThrow(() => db.importPlayerExport(payload(p => { p.playerBadges = null; })));
  });
});
