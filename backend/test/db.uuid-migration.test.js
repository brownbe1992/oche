'use strict';
// Committed regression test for the players.uuid migration (docs/data-export-roadmap.md).
// CREATE TABLE IF NOT EXISTS only takes effect on a genuinely fresh database -- an
// EXISTING installation's players table already exists (without the uuid column) and
// needs its own explicit ALTER TABLE to get one at all. Every other test in this repo
// points DARTS_DB at a brand-new scratch file, so db.js's own CREATE TABLE always runs
// as a true fresh install there -- that masked a real bug where the ALTER TABLE for
// uuid was missing entirely, which crashed db.js on require() (`no such column: uuid`)
// against any database created before this column existed. This test seeds a raw,
// pre-migration-shaped players table (via node:sqlite directly, not db.js) in a
// separate process, then requires db.js against it and confirms it starts cleanly and
// backfills a real, distinct uuid for every pre-existing row.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-uuidmigration-'));
const dbPath = path.join(scratchDir, 'pre-existing.db');

after(() => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {}
});

describe('players.uuid migration against a pre-existing database', () => {
  test('an old-schema players table (no uuid column) loads db.js without error and backfills a distinct uuid per row', () => {
    // Seed a raw players table shaped exactly like the one that existed before the
    // uuid column was ever introduced -- deliberately NOT going through db.js, since
    // requiring it would already apply the migration we're trying to test against.
    execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec(\`CREATE TABLE players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        out_mode TEXT NOT NULL DEFAULT 'double',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )\`);
      db.prepare('INSERT INTO players (name) VALUES (?)').run('MigrationTestPlayerA');
      db.prepare('INSERT INTO players (name) VALUES (?)').run('MigrationTestPlayerB');
    `], { cwd: __dirname });

    // Now require db.js (a fresh process, so its top-level migration code actually
    // runs against this file) and report back what it did.
    const out = execFileSync(process.execPath, ['-e', `
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
      const rows = db._db.prepare('SELECT id, name, uuid FROM players ORDER BY id').all();
      process.stdout.write(JSON.stringify(rows));
    `], { cwd: __dirname, env: { ...process.env, DARTS_DB: dbPath } }).toString('utf8');

    const rows = JSON.parse(out);
    assert.equal(rows.length, 2);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const r of rows) assert.match(r.uuid, uuidRe, `${r.name} should have a well-formed backfilled uuid`);
    assert.notEqual(rows[0].uuid, rows[1].uuid, 'each pre-existing row gets its own distinct uuid, not a shared/copied one');
  });
});
