'use strict';
// Committed tests for backend/backup-lib.js (docs/backups-roadmap.md), the
// shared backup/restore mechanics used by both the standalone cron script
// (backend/backup.js) and the admin-gated Settings routes (backend/server.js).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-bklib-test-'));
process.env.DARTS_DB = path.join(scratchDir, 'darts.db');
process.env.BACKUP_DIR = path.join(scratchDir, 'backups');

const db = require('../db.js');
const lib = require('../backup-lib.js');

after(() => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {}
});

describe('isValidBackupName', () => {
  test('accepts names matching the exact pattern createBackup() produces', () => {
    assert.equal(lib.isValidBackupName('darts-2026-07-06T18-01-50-014Z.db'), true);
  });
  test('rejects anything else, including path-traversal attempts', () => {
    assert.equal(lib.isValidBackupName('../../etc/passwd'), false);
    assert.equal(lib.isValidBackupName('darts-2026.db/../../evil'), false);
    assert.equal(lib.isValidBackupName('not-a-backup.db'), false);
    assert.equal(lib.isValidBackupName(''), false);
    assert.equal(lib.isValidBackupName(null), false);
    assert.equal(lib.isValidBackupName(123), false);
  });
});

describe('createBackup / listBackups / pruneOldBackups / deleteBackup', () => {
  test('createBackup writes a real, consistent snapshot that validates and lists', async () => {
    db.addPlayer('backup_lib_player');
    const result = await lib.createBackup();
    assert.match(result.name, /^darts-.+\.db$/);
    assert.ok(fs.existsSync(result.path));
    assert.doesNotThrow(() => lib.validateSqliteFile(result.path));

    const listed = lib.listBackups();
    assert.ok(listed.some(b => b.name === result.name));
    const entry = listed.find(b => b.name === result.name);
    assert.ok(entry.size > 0);
  });

  test('backupPath rejects an invalid name and a nonexistent (but validly-shaped) one', () => {
    assert.throws(() => lib.backupPath('../../etc/passwd'), /Invalid backup filename/);
    assert.throws(() => lib.backupPath('darts-1999-01-01T00-00-00-000Z.db'), /Backup not found/);
  });

  test('deleteBackup removes the file; a second delete throws "not found"', async () => {
    const result = await lib.createBackup();
    assert.ok(fs.existsSync(result.path));
    lib.deleteBackup(result.name);
    assert.ok(!fs.existsSync(result.path));
    assert.throws(() => lib.deleteBackup(result.name), /Backup not found/);
  });

  test('pruneOldBackups deletes only backups older than the retention window', async () => {
    const result = await lib.createBackup();
    // Backdate its mtime so it looks 10 days old.
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(result.path, tenDaysAgo / 1000, tenDaysAgo / 1000);

    const fresh = await lib.createBackup(); // this call also prunes with the default 7-day window
    // The backdated one should be gone; the fresh one (just created) should remain.
    const names = lib.listBackups().map(b => b.name);
    assert.ok(!names.includes(result.name), 'the 10-day-old backup was pruned');
    assert.ok(names.includes(fresh.name), 'the just-created backup survives');
  });
});

describe('validateSqliteFile', () => {
  test('accepts a genuine, intact SQLite database', async () => {
    const result = await lib.createBackup();
    assert.doesNotThrow(() => lib.validateSqliteFile(result.path));
  });

  test('rejects a file with the wrong header entirely', () => {
    const junk = path.join(scratchDir, 'junk.db');
    fs.writeFileSync(junk, 'this is not a sqlite file at all, just plain text');
    assert.throws(() => lib.validateSqliteFile(junk), /Not a valid SQLite database file/);
    fs.unlinkSync(junk);
  });

  test('rejects a file with the right header but corrupted body', () => {
    const corrupt = path.join(scratchDir, 'corrupt.db');
    // Correct 16-byte magic header, followed by garbage instead of real page data.
    const buf = Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(4096, 0xff)]);
    fs.writeFileSync(corrupt, buf);
    assert.throws(() => lib.validateSqliteFile(corrupt), /Database failed integrity check/);
    fs.unlinkSync(corrupt);
  });
});

describe('stageRestore', () => {
  test('copies the source file over DB_PATH and clears stale -wal/-shm files', async () => {
    // Simulate stale WAL/SHM files sitting next to the live db, as WAL mode
    // would leave them.
    fs.writeFileSync(lib.DB_PATH + '-wal', 'stale wal data');
    fs.writeFileSync(lib.DB_PATH + '-shm', 'stale shm data');

    const result = await lib.createBackup();
    const beforeSize = fs.statSync(lib.DB_PATH).size;
    lib.stageRestore(result.path);

    assert.ok(!fs.existsSync(lib.DB_PATH + '-wal'), 'stale -wal file removed');
    assert.ok(!fs.existsSync(lib.DB_PATH + '-shm'), 'stale -shm file removed');
    const afterContent = fs.readFileSync(lib.DB_PATH);
    const backupContent = fs.readFileSync(result.path);
    assert.deepEqual(afterContent, backupContent, 'DB_PATH now has the backup\'s exact bytes');
  });
});
