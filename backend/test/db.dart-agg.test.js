'use strict';
// The shared per-turn dart aggregate — docs/open-roadmap-items.md item 44.
//
// Twelve query sites used to each inline `(SELECT turn_id, COUNT(*), SUM(is_treble)
// FROM darts GROUP BY turn_id)` — a full scan of the darts table apiece, five of them
// inside computeStats() alone. They now join one TEMP table built once per call.
//
// A performance change is only correct if it is invisible, and the risk here is
// specific: the aggregate is a CACHE with a lifetime. The ways it can go wrong are
// (a) it is stale — built before a turn was written and read after, (b) it is missing
// — a query runs outside withDartAgg() and sees an empty or absent table, or (c) the
// reentrancy is wrong and an inner call drops the table an outer call is still using.
// None of those produce an error; they produce quietly wrong statistics. These cases
// are about the lifetime, not the arithmetic.
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

const dart = (dartNo, sector, multiplier) => ({ dartNo, sector, multiplier });

function x01Game(name) {
  return db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'x01', config: { startingScore: 501 }, players: [{ name }] });
}
// A full 3-dart visit of trebles: 180.
function visit180(gameId, name, leg) {
  db.addTurn(gameId, { player: name, set: 1, leg, scored: 180, bust: false, checkout: false,
    checkoutPoints: null, darts: [dart(1, 20, 3), dart(2, 20, 3), dart(3, 20, 3)] });
}

describe('the shared dart aggregate is never stale', () => {
  test('a turn written after one call is visible to the next', () => {
    // The failure this rules out: the temp table is built once and never refreshed,
    // so every statistic freezes at whatever the first request saw.
    const name = 'AGG_Fresh';
    db.addPlayer(name);
    const g = x01Game(name);
    visit180(g.gameId, name, 1);

    const first = db.computeStats()[name];
    assert.equal(first.dartsThrown, 3);

    visit180(g.gameId, name, 1);
    const second = db.computeStats()[name];
    assert.equal(second.dartsThrown, 6, 'the second call must see the turn written between them');
    assert.equal(second.turns, 2);
  });

  test('every wrapped entry point builds it for itself', () => {
    // Each of these reaches the aggregate through a different path; calling them in
    // isolation (as a real request does) must work without a prior computeStats().
    const name = 'AGG_Entry';
    db.addPlayer(name);
    const g = x01Game(name);
    visit180(g.gameId, name, 1);

    assert.doesNotThrow(() => db.getPlayerStatBubbles(name, 'practice'));
    assert.doesNotThrow(() => db.getPersonalBests(name, 'practice'));
    assert.doesNotThrow(() => db.getHomeExtra());
    assert.doesNotThrow(() => db.getSessionRecap(new Date().toISOString().slice(0, 10)));
    assert.doesNotThrow(() => db.getMetricHistory(name, 'avg', 'all'));
    assert.doesNotThrow(() => db.getGhostCandidateLegs(name, 5));

    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.ok(bubbles.dartsThrown >= 3, `saw ${bubbles.dartsThrown} darts`);
  });

  test('a nested call does not pull the table out from under its caller', () => {
    // computeStats() is itself wrapped and calls other wrapped helpers. If the inner
    // call rebuilt or dropped the table, the outer one would finish against a table
    // that had been emptied mid-flight.
    const name = 'AGG_Nested';
    db.addPlayer(name);
    const g = x01Game(name);
    visit180(g.gameId, name, 1);
    visit180(g.gameId, name, 1);

    const stats = db.computeStats()[name];
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(stats.dartsThrown, 6);
    assert.ok(bubbles.dartsThrown >= 6);
    // And the outer figure is still right when a nested call happens first.
    assert.equal(db.computeStats()[name].dartsThrown, 6);
  });

  test('a turn with no darts is absent from the aggregate, as the old inline join was', () => {
    // Checkout Trainer declarations are the real case: the one turn shape allowed to
    // carry zero dart rows. The inline subquery was an INNER join to darts, so those
    // turns never appeared; the replacement must match, not suddenly count them.
    const name = 'AGG_NoDarts';
    db.addPlayer(name);
    const ct = db.createGame({ category: 'Checkout Trainer', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'checkout_trainer',
      config: { mode: 'freeform', trickQuestions: true }, players: [{ name }] });
    db.addTurn(ct.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: false, checkout: true,
      checkoutPoints: null, legWon: true, targetScore: 169, declaredUnsolvable: 1, darts: [] });

    db.computeStats();   // builds the aggregate
    const row = db._db.prepare(`
      SELECT (SELECT COUNT(*) FROM _dart_agg a WHERE a.turn_id = t.id) AS inAgg
        FROM turns t WHERE t.player_id = (SELECT id FROM players WHERE name = ?)
    `).get(name);
    assert.equal(row.inAgg, 0,
      'a zero-dart turn has no aggregate row — matching the INNER join the inline subquery was');
    // (The roster's own turn/dart counters exclude Checkout Trainer entirely
    // via NOT_CHECKOUT_TRAINER — a typed-in route was never a physical throw —
    // so they are not what this case is about.)
    assert.equal(db.computeStats()[name].dartsThrown, 0);
  });

  test('the aggregate agrees with a direct count, per turn', () => {
    // The arithmetic itself, against the table it summarises.
    const name = 'AGG_Arith';
    db.addPlayer(name);
    const g = x01Game(name);
    visit180(g.gameId, name, 1);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 25, bust: false, checkout: false,
      checkoutPoints: null, darts: [dart(1, 25, 1), dart(2, 0, 1)] });

    db.computeStats();   // builds the aggregate
    const rows = db._db.prepare(`
      SELECT t.id,
             (SELECT COUNT(*) FROM darts d WHERE d.turn_id = t.id) AS realCnt,
             (SELECT COALESCE(SUM(is_treble),0) FROM darts d WHERE d.turn_id = t.id) AS realTrebles,
             a.cnt, a.trebles
        FROM turns t JOIN _dart_agg a ON a.turn_id = t.id
       WHERE t.player_id = (SELECT id FROM players WHERE name = ?)
    `).all(name);
    assert.ok(rows.length >= 2);
    for (const r of rows) {
      assert.equal(r.cnt, r.realCnt, `turn ${r.id}: dart count`);
      assert.equal(r.trebles, r.realTrebles, `turn ${r.id}: treble count`);
    }
  });
});
