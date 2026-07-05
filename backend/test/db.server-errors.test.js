'use strict';
// docs/testing-and-observability-roadmap.md Part B seed: the first committed,
// re-runnable test in the repo, covering the server_errors observability feature
// (Part A) per CLAUDE.md's "every new calculation gets a permanent test" convention.
// Uses only node:test/node:assert (no new dependency) against a scratch SQLite file —
// never the real data/ database.
const { test, after } = require('node:test');
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

test('logServerError + getServerErrors: basic insert and retrieval, newest first', () => {
  db.logServerError({ method: 'GET', path: '/api/stats', status: 500, message: 'boom 1' });
  db.logServerError({ method: 'POST', path: '/api/games', status: 500, message: 'boom 2' });
  const rows = db.getServerErrors(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message, 'boom 2');
  assert.equal(rows[1].message, 'boom 1');
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].path, '/api/games');
  assert.equal(rows[0].status, 500);
});

test('getServerErrors: limit is respected and capped at 500', () => {
  for (let i = 0; i < 20; i++) db.logServerError({ method: 'GET', path: '/x', status: 500, message: 'e' + i });
  assert.equal(db.getServerErrors(5).length, 5);
  assert.ok(db.getServerErrors(9999).length <= 500);
});

test('logServerError: prunes to the most recent 500 rows', () => {
  for (let i = 0; i < 520; i++) db.logServerError({ method: 'GET', path: '/y', status: 500, message: 'p' + i });
  const count = db._db.prepare('SELECT COUNT(*) AS n FROM server_errors').get().n;
  assert.equal(count, 500);
  assert.equal(db.getServerErrors(1)[0].message, 'p519');
});

test('logServerError: missing fields are stored as null, not throwing', () => {
  db.logServerError({});
  const row = db.getServerErrors(1)[0];
  assert.equal(row.method, null);
  assert.equal(row.path, null);
  assert.equal(row.status, null);
  assert.equal(row.message, null);
});
