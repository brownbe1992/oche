'use strict';
/* The one-time boot migration that moved Checkout Trainer off `turns`/`darts` and
   into checkout_trainer_rounds (backend/db.js, migrateCheckoutTrainerRoundsOffTurns).

   This is the highest-risk part of that move and the only part that runs exactly
   once, on somebody's real database, unattended. Everything else about the rewrite
   fails loudly in development; this fails silently in production, months later, as
   "why is my optimal % 0?". So it is tested the only way that means anything: build
   a database in the OLD shape, boot the module against it, and check that the stats
   read the same numbers afterwards as the old queries did before.

   Building the old shape means writing turns for a checkout_trainer game, which the
   current addTurn() refuses outright — so the fixture inserts rows directly. That is
   the point: this is what a database from before the rewrite actually contains. */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-ct-migration-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

/* Plants a pre-rewrite Checkout Trainer session: real turns and real darts, with
   the grade encoded the old way (bust / checkout / leg_won). Returns the game id.

   `rounds` entries are [targetScore, outcome, labels] where outcome is one of
   'optimal' | 'legal' | 'illegal' | 'declaration-right' | 'declaration-wrong'. */
function plantOldStyleSession(playerName, config, rounds) {
  const raw = db._db;
  const pid = raw.prepare('SELECT id FROM players WHERE name = ?').get(playerName).id;
  const g = raw.prepare(`INSERT INTO games (category, legs_per_set, sets_per_game, practice, game_type, config, player_count)
                         VALUES (?, 1, 1, 1, 'checkout_trainer', ?, 1)`)
    .run('Checkout Trainer (legacy)', JSON.stringify(config));
  const gameId = Number(g.lastInsertRowid);
  raw.prepare(`INSERT INTO game_players (game_id, player_id, out_mode) VALUES (?, ?, 'double')`).run(gameId, pid);

  const insTurn = raw.prepare(`INSERT INTO turns
    (game_id, player_id, set_no, leg_no, scored, bust, checkout, leg_won, target_score, declared_unsolvable)
    VALUES (?,?,?,?,0,?,?,?,?,?)`);
  const insDart = raw.prepare(`INSERT INTO darts (turn_id, dart_no, sector, multiplier) VALUES (?,?,?,?)`);
  rounds.forEach(([target, outcome, darts, huntNo], i) => {
    const declared = outcome.startsWith('declaration') ? 1 : 0;
    const legal = (outcome === 'optimal' || outcome === 'legal' || outcome === 'declaration-right') ? 1 : 0;
    const optimal = (outcome === 'optimal' || outcome === 'declaration-right') ? 1 : 0;
    const info = insTurn.run(gameId, pid, huntNo || 1, i + 1, legal ? 0 : 1, legal, optimal, target, declared);
    (darts || []).forEach((d, n) => insDart.run(Number(info.lastInsertRowid), n + 1, d[0], d[1]));
  });
  return gameId;
}

// Re-runs the boot sequence against the same file the module already has open. The
// migration is a plain function of the database's contents, so calling it directly
// is exactly what a restart does — with the advantage that its return can be
// observed rather than inferred from a log line.
function runMigration() { return db._runCheckoutTrainerMigrationForTests(); }

describe('Checkout Trainer migration off turns/darts', () => {
  test('a legacy session becomes rounds, its stats unchanged, and its turns/darts gone', () => {
    const name = 'MIG_Freeform';
    db.addPlayer(name);
    const gameId = plantOldStyleSession(name, { mode: 'freeform', trickQuestions: true }, [
      [40,  'optimal',            [[20, 2]]],                        // D20 — the one-dart optimum
      [100, 'legal',              [[20, 1], [20, 1], [20, 2]]],      // legal, 3 darts, optimum is 2
      [77,  'illegal',            [[19, 3], [10, 2]]],               // overshoots
      [169, 'declaration-right',  []],                               // a bogey, correctly called
    ]);

    // Before: the old rows are really there, which is what makes the assertions
    // after the migration mean something.
    const raw = db._db;
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(gameId).n, 4);
    assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id
                              WHERE t.game_id = ?`).get(gameId).n, 6);

    runMigration();

    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(gameId).n, 0,
      'the whole point: the turns are gone');
    assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id
                              WHERE t.game_id = ?`).get(gameId).n, 0, 'and their darts with them');

    const bubbles = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(bubbles.totalAttempts, 4, 'every round came across');
    assert.equal(bubbles.legalCount, 3, '1 optimal + 1 legal + 1 correct declaration');
    assert.equal(bubbles.optimalCount, 2, 'the optimal solve and the correct bogey call');

    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.toughestCheckout, 40,
      'the correctly-called 169 bogey must still not read as a checkout that was solved');
  });

  test('the route is rebuilt from the dart rows, and optimal_darts is re-derived', () => {
    // Neither existed as a column before. The route comes back from the dart rows in
    // throw order; optimal_darts is recomputed with checkoutHint(), the same function
    // that graded the round when it was played.
    const name = 'MIG_Route';
    db.addPlayer(name);
    const gameId = plantOldStyleSession(name, { mode: 'freeform' }, [
      [100, 'legal', [[20, 1], [20, 1], [20, 2]]],
    ]);
    runMigration();

    const row = db._db.prepare(`SELECT route, route_key AS key, used_darts AS usedDarts,
                                       optimal_darts AS optimalDarts, legal, optimal
                                  FROM checkout_trainer_rounds WHERE game_id = ?`).get(gameId);
    assert.equal(row.route, '20 20 D20', 'dart rows back to labels, in throw order');
    assert.ok(row.key, 'and a canonical key, so a migrated Route Recall find still de-duplicates');
    assert.equal(row.usedDarts, 3);
    assert.equal(row.optimalDarts, 2, '100 finishes in 2 (T20 D20) — re-derived, never stored before');
    assert.equal(row.legal, 1);
    assert.equal(row.optimal, 0, 'three darts for a two-dart finish is legal, not optimal');
  });

  test('a Route Recall hunt keeps its grouping — set_no becomes hunt_no', () => {
    const name = 'MIG_RouteRecall';
    db.addPlayer(name);
    const gameId = plantOldStyleSession(name, { mode: 'route_recall', routeCeiling: 2 }, [
      [40, 'optimal', [[20, 2]], 1],              // hunt 1: D20  (old checkout=1 = "new route")
      [40, 'optimal', [[20, 1], [10, 2]], 1],     // hunt 1: 20 D10
      [40, 'illegal', [[20, 3]], 1],              // hunt 1: T20 overshoots
      [32, 'optimal', [[16, 2]], 2],              // hunt 2, a different target
    ]);
    runMigration();

    const s = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(s.huntsPlayed, 2, 'two hunts, not four and not one');
    assert.equal(s.routesNamed, 3);
    assert.equal(s.totalAttempts, 0, 'and none of it leaked into the Freeform bubbles');

    // Route Recall never has an `optimal` round: its question has no best answer.
    const optimals = db._db.prepare(`SELECT COUNT(*) AS n FROM checkout_trainer_rounds
                                     WHERE game_id = ? AND optimal = 1`).get(gameId).n;
    assert.equal(optimals, 0, "the old leg_won meant nothing here and must not migrate to `optimal`");
  });

  test('running it twice is a no-op, not a double import', () => {
    // It runs on every boot. A second pass that re-inserted would double every
    // player's lifetime totals on the next restart — a corruption that looks like a
    // stats bug, months after anyone connects it to a migration.
    const name = 'MIG_Idempotent';
    db.addPlayer(name);
    plantOldStyleSession(name, { mode: 'freeform' }, [[40, 'optimal', [[20, 2]]]]);
    runMigration();
    const after1 = db.getCheckoutTrainerStatBubbles(name, 'practice');
    runMigration();
    runMigration();
    assert.deepEqual(db.getCheckoutTrainerStatBubbles(name, 'practice'), after1,
      'a second and third boot change nothing');
  });

  test('it leaves every other game type completely alone', () => {
    const name = 'MIG_Bystander';
    db.addPlayer(name);
    const x01 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 }, players: [{ name }] });
    db.addTurn(x01.gameId, { player: name, set: 1, leg: 1, scored: 140, bust: false, checkout: false,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 },
              { dartNo: 3, sector: 20, multiplier: 1 }] });
    const before = JSON.stringify(db.getPlayerStatBubbles(name, 'practice'));

    plantOldStyleSession(name, { mode: 'freeform' }, [[40, 'optimal', [[20, 2]]]]);
    runMigration();

    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(x01.gameId).n, 1,
      'the X01 turn is untouched');
    assert.equal(JSON.stringify(db.getPlayerStatBubbles(name, 'practice')), before,
      'and every X01 statistic reads exactly what it read before');
  });
});
