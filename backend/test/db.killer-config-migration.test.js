'use strict';
// Committed test for migrateKillerConfigsToIdKeys() (item 43, docs/code-quality-
// roadmap.md) — the one-time boot migration that converts a killer game's
// config.numbers from the old name-keyed scheme to the current id-keyed one,
// healing any pre-existing rename-orphaned key along the way (the same
// unambiguous one-orphan/one-unclaimed heuristic the old boot reconciler used).
// The function itself isn't exported (it's only ever invoked once, unconditionally,
// at module load — see db.js's own call site) — this test forces a fresh module
// load after seeding legacy data via a raw config overwrite, the only way to
// re-trigger it deterministically.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const dbModulePath = require.resolve('../db.js');
let db = require(dbModulePath);

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

function reload() {
  delete require.cache[dbModulePath];
  db = require(dbModulePath);
}

describe('migrateKillerConfigsToIdKeys (boot migration)', () => {
  test('a legacy name-keyed config is migrated to id-keyed on the next boot', () => {
    db.addPlayer('mig_a'); db.addPlayer('mig_b');
    const { gameId } = db.createGame({ category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', players: [{ name: 'mig_a' }, { name: 'mig_b' }] });
    const aId = db._db.prepare('SELECT id FROM players WHERE name = ?').get('mig_a').id;
    const bId = db._db.prepare('SELECT id FROM players WHERE name = ?').get('mig_b').id;
    // Overwrite with a legacy NAME-keyed config, simulating a pre-migration row.
    db._db.prepare('UPDATE games SET config = ? WHERE id = ?')
      .run(JSON.stringify({ lives: 3, numbers: { mig_a: 7, mig_b: 14 } }), gameId);

    reload();

    const cfg = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id = ?').get(gameId).config);
    assert.equal(cfg.numbers[aId], 7, "mig_a's number now lives under their id");
    assert.equal(cfg.numbers[bId], 14, "mig_b's number now lives under their id");
    assert.ok(!('mig_a' in cfg.numbers) && !('mig_b' in cfg.numbers), 'the old name keys are gone');
  });

  test('an orphaned key from a pre-fix rename is healed (unambiguous one-orphan/one-unclaimed case), then converted to an id-key', () => {
    db.addPlayer('mig_orph_a'); db.addPlayer('mig_orph_b');
    const { gameId } = db.createGame({ category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', players: [{ name: 'mig_orph_a' }, { name: 'mig_orph_b' }] });
    const bId = db._db.prepare('SELECT id FROM players WHERE name = ?').get('mig_orph_b').id;
    db.renamePlayer('mig_orph_a', 'mig_orph_a2');
    const aId = db._db.prepare('SELECT id FROM players WHERE name = ?').get('mig_orph_a2').id;
    // Simulate a config orphaned by a rename performed before any compensating
    // rewrite ever existed: the stored key still says the OLD name, matching
    // no current participant.
    db._db.prepare('UPDATE games SET config = ? WHERE id = ?')
      .run(JSON.stringify({ lives: 3, numbers: { mig_orph_a: 7, mig_orph_b: 14 } }), gameId);

    reload();

    const cfg = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id = ?').get(gameId).config);
    assert.equal(cfg.numbers[aId], 7, 'the orphaned key is healed onto the renamed player, then converted to their id');
    assert.equal(cfg.numbers[bId], 14);
  });

  test('an already id-keyed config is left byte-for-byte untouched (idempotent)', () => {
    db.addPlayer('mig_idem_a'); db.addPlayer('mig_idem_b');
    const { gameId } = db.createGame({ category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', players: [{ name: 'mig_idem_a' }, { name: 'mig_idem_b' }] });
    const before = db._db.prepare('SELECT config FROM games WHERE id = ?').get(gameId).config;

    reload();

    const after = db._db.prepare('SELECT config FROM games WHERE id = ?').get(gameId).config;
    assert.equal(after, before, 'a config already keyed by id is unchanged on a later boot');
  });
});
