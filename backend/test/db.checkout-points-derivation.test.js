'use strict';
// turns.checkout_points is derived, not stored — docs/database-normalization-roadmap.md
// §3.1, docs/open-roadmap-items.md item 62.
//
// The column held a copy of `scored`: every mode that records a checkout writes
// `scored: ev.scored` and `checkoutPoints: ev.win ? ev.pointsThisVisit : null` out of the
// same evaluation, and every one of those evaluators returns `scored: bust ? 0 :
// pointsThisVisit` — so on a winning visit (never a bust) the two are the same number by
// construction. addTurn() has enforced that equality at write time for a while
// ("checkoutPoints must match scored on a checkout turn"); this file is what keeps the
// READ side honest now that the column those writes fed is gone.
//
// The part that is NOT mechanical, and that this file exists for, is that `checkout` is an
// overloaded flag. For X01, 121 Checkout Ladder and Dead Man Walking it means "checked out,
// for this many points." For The Pressure Chamber and Checkout Trainer it means "this visit
// was a legal attempt rather than a miss" — a completely different fact, whose `scored` is a
// CP gain or a flat 0, not a finish. The old column carried that distinction implicitly, by
// those two modes writing nothing into it; `checkoutIsAttempt` on their registry entries
// carries it out loud instead.
//
// Worth being precise about what that marking buys today: every current read site is ALSO
// scoped to X01 (docs/bug-roadmap.md BUG-27 put X01_ONLY on all of them, for exactly this
// family of reason), so removing the marking changes no shipped number right now. It is
// asserted anyway, and asserted against the expression itself rather than through a caller,
// because the expression has to be right on its own terms — BUG-27 is the standing evidence
// that "checkout=1 means an X01 finish" is an assumption this codebase has already made
// wrongly once, in a query that had no game-type guard.
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

// The derived value for every turn this player threw, straight out of the expression
// under test — deliberately NOT through a stats function, since every one of those
// carries its own X01 filter that would mask a wrong derivation.
function derivedFor(name) {
  return db._db.prepare(`
    SELECT g.game_type, t.scored, ${db.CHECKOUT_POINTS} AS points
    FROM turns t JOIN games g ON g.id = t.game_id
    JOIN players p ON p.id = t.player_id
    WHERE p.name = ? ORDER BY g.game_type, t.id
  `).all(name).map(r => ({ game_type: r.game_type, scored: r.scored, points: r.points }));
}

function x01Game(name) {
  return db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'x01', config: { startingScore: 501 }, players: [{ name }] });
}

describe('turns.checkout_points is derived, not stored (item 62)', () => {
  test('the column is gone from the schema, and the columns it was derived from are not', () => {
    const cols = db._db.prepare('PRAGMA table_info(turns)').all().map(c => c.name);
    assert.ok(!cols.includes('checkout_points'),
      'checkout_points should have been dropped — the ALTER TABLE ... DROP COLUMN migration did not run');
    for (const needed of ['scored', 'checkout', 'game_id']) {
      assert.ok(cols.includes(needed), `turns.${needed} is what the derivation reads — it must still exist`);
    }
  });

  test('the registry marks exactly the modes whose checkout flag is not a score', () => {
    const scoring = db.CHECKOUT_SCORING_TYPES;
    for (const t of ['x01', 'checkout_ladder', 'dead_man_walking']) {
      assert.ok(scoring.includes(t), `${t} records real checkouts and must count as one`);
    }
    for (const t of ['pressure_chamber', 'checkout_trainer']) {
      assert.ok(!scoring.includes(t),
        `${t} reuses checkout=1 to mean "a legal attempt" — counting its scored as checkout points invents finishes`);
    }
  });

  test('an X01 checkout still reports its own points', () => {
    const name = 'CPD_X01';
    db.addPlayer(name);
    const g = x01Game(name);
    // 501 -> 401 -> ... the exact remaining does not matter to the fixture; what
    // matters is a checkout turn worth 100, recorded the way live play records one.
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 100, bust: false,
      checkout: true, checkoutPoints: 100, legWon: true,
      darts: [dart(1, 20, 3), dart(2, 20, 1), dart(3, 10, 2)] });

    const finishes = db.getTopFinishes(name, 'practice');
    assert.deepEqual(finishes.map(f => f.score), [100]);
    assert.equal(finishes[0].times, 1);
  });

  test('Big Fish is still exactly 170, not merely a large scored value', () => {
    const name = 'CPD_BigFish';
    db.addPlayer(name);
    const big = x01Game(name);
    db.addTurn(big.gameId, { player: name, set: 1, leg: 1, scored: 170, bust: false,
      checkout: true, checkoutPoints: 170, legWon: true,
      darts: [dart(1, 20, 3), dart(2, 20, 3), dart(3, 25, 2)] });
    // A 180 is a bigger `scored` than a Big Fish and is not a checkout at all —
    // the derivation must not turn it into one.
    const other = x01Game(name);
    db.addTurn(other.gameId, { player: name, set: 1, leg: 1, scored: 180, bust: false,
      checkout: false, checkoutPoints: null,
      darts: [dart(1, 20, 3), dart(2, 20, 3), dart(3, 20, 3)] });

    assert.equal(db.getPlayerStatBubbles(name, 'practice').bigFish, 1,
      'the 170 checkout is the Big Fish; the 180 is not');
    assert.deepEqual(db.getTopFinishes(name, 'practice').map(f => f.score), [170]);
  });

  test("The Pressure Chamber's checkout flag is an attempt, and never becomes a checkout record", () => {
    const name = 'CPD_Pressure';
    db.addPlayer(name);
    // A real X01 checkout first, so the assertions below distinguish "the drill was
    // ignored" from "nothing was recorded at all".
    const x = x01Game(name);
    db.addTurn(x.gameId, { player: name, set: 1, leg: 1, scored: 60, bust: false,
      checkout: true, checkoutPoints: 60, legWon: true,
      darts: [dart(1, 20, 1), dart(2, 20, 1), dart(3, 10, 2)] });

    const pc = db.createGame({ category: 'The Pressure Chamber', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'pressure_chamber', players: [{ name }] });
    // checkout=1 means "not a miss" here, and `scored` is the round's CP gain. A naive
    // "checkout points = scored" derivation reads this as a 150 checkout.
    db.addTurn(pc.gameId, { player: name, set: 1, leg: 1, scored: 150, bust: false,
      checkout: true, checkoutPoints: null, legWon: true,
      darts: [dart(1, 20, 3), dart(2, 20, 3), dart(3, 20, 1)] });

    // The expression itself, unscoped — no caller's X01 filter standing in for it.
    assert.deepEqual(derivedFor(name), [{ game_type: 'pressure_chamber', scored: 150, points: null },
                                        { game_type: 'x01', scored: 60, points: 60 }],
      'the Pressure Chamber round scored 150 CP and checked nothing out');
    // And through the read paths, which agree for their own additional reasons.
    assert.deepEqual(db.getTopFinishes(name, 'practice').map(f => f.score), [60]);
    assert.ok(!db.getTopFinishesAll(10, 'practice').some(f => f.score === 150));
  });

  test('a Checkout Trainer round is not a checkout either', () => {
    const name = 'CPD_Trainer';
    db.addPlayer(name);
    const x = x01Game(name);
    db.addTurn(x.gameId, { player: name, set: 1, leg: 1, scored: 40, bust: false,
      checkout: true, checkoutPoints: 40, legWon: true,
      darts: [dart(1, 20, 2)] });

    const ct = db.createGame({ category: 'Checkout Trainer', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'checkout_trainer', config: { mode: 'freeform' }, players: [{ name }] });
    db.addTurn(ct.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: false,
      checkout: true, checkoutPoints: null, legWon: true, targetScore: 121,
      darts: [dart(1, 20, 3), dart(2, 20, 3), dart(3, 20, 2)] });

    assert.deepEqual(derivedFor(name), [{ game_type: 'checkout_trainer', scored: 0, points: null },
                                        { game_type: 'x01', scored: 40, points: 40 }],
      'a Checkout Trainer round is an attempt, not a 0-point finish');
    assert.deepEqual(db.getTopFinishes(name, 'practice').map(f => f.score), [40]);
  });

  test('a 121 Checkout Ladder finish IS a real checkout for the derivation', () => {
    // The mirror of the two tests above: excluding the attempt-modes must not
    // quietly exclude the drills that do record genuine finishes. (Whether an
    // X01-scoped household record counts them is a separate question, and
    // db.checkout-stat-x01-isolation.test.js owns it.)
    const name = 'CPD_Ladder';
    db.addPlayer(name);
    const g = db.createGame({ category: '121 Checkout Ladder', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'checkout_ladder', players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 121, bust: false,
      checkout: true, checkoutPoints: 121, legWon: true, targetScore: 121,
      darts: [dart(1, 19, 3), dart(2, 20, 3), dart(3, 2, 2)] });

    const row = db._db.prepare(`
      SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.game_type = 'checkout_ladder' AND t.checkout = 1 AND t.scored = 121
    `).get();
    assert.equal(row.n, 1, 'the ladder finish must still be on record as a checkout worth 121');
  });

  test('the write-time guarantee the derivation rests on is still enforced', () => {
    const name = 'CPD_Guard';
    db.addPlayer(name);
    const g = x01Game(name);
    assert.throws(() => db.addTurn(g.gameId, {
      player: name, set: 1, leg: 1, scored: 60, bust: false,
      checkout: true, checkoutPoints: 100,
      darts: [dart(1, 20, 1), dart(2, 20, 1), dart(3, 10, 2)],
    }, { enforceConsistency: true }), /checkoutPoints must match scored/,
    'if a checkout could carry points that differ from its scored, deriving one from the other would lose data');
  });

  test('the CSV export still carries a checkout_points column, with the same value', () => {
    const name = 'CPD_Csv';
    db.addPlayer(name);
    const g = x01Game(name);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 81, bust: false,
      checkout: true, checkoutPoints: 81, legWon: true,
      darts: [dart(1, 19, 3), dart(2, 12, 2)] });

    const csv = db.getPlayerCsvExport(name, 'turns');
    const [header, ...rows] = csv.trim().split('\r\n');
    const cols = header.split(',');
    const idx = cols.indexOf('checkout_points');
    assert.ok(idx >= 0, 'dropping the column must not change the shape of an already-published export');
    const cells = rows[0].split(',');
    assert.equal(cells[idx], '81');
    assert.equal(cells[cols.indexOf('scored')], '81');
  });
});
