'use strict';
// Committed regression test for docs/security-audit-roadmap.md SEC-22: addTurn()
// validated each dart and the visit-level `scored` independently, but never checked
// that the two agreed — a request could store an X01 turn whose `scored` doesn't
// match the value of the darts it's paired with, silently corrupting every
// points/average stat built on turns.scored.
//
// The check is opt-in via `opts.enforceConsistency`, passed ONLY by server.js's
// POST /api/games/:id/turns route (the one production call site untrusted input
// actually reaches) — NOT the default for addTurn() itself, because the rest of the
// backend/test/db.*.test.js suite calls addTurn() directly with placeholder `scored`
// values unrelated to what those tests actually verify (dart-shape validation,
// unrelated stat aggregation, etc.), an established fixture convention across ~14
// files that predates this check and never crosses the real trust boundary. See
// addTurn()'s own comment in db.js for the full reasoning.
//
// Scoped to X01 only: Cricket's turns.scored is a fundamentally different quantity
// (mark-closing points, not a sum of dart face values) computed by
// evaluateVisitCricket() — applying this check to Cricket would reject entirely
// legitimate turns.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
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

function x01Game(players) {
  return db.createGame({
    category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
    players: players.map(name => ({ name })),
  }); // gameType omitted -> defaults to 'x01', per createGame()'s own contract
}

const STRICT = { enforceConsistency: true };

describe('addTurn — scored must match the darts thrown, when opted in (SEC-22, X01 only)', () => {
  test('rejects an X01 turn whose scored does not match the sum of its dart values', async () => {
    await db.addPlayer('SEC22_Alice'); await db.addPlayer('SEC22_Bob');
    const { gameId } = x01Game(['SEC22_Alice', 'SEC22_Bob']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 5, multiplier: 1 }, { dartNo: 3, sector: 1, multiplier: 1 }], // real value: 26
    }, STRICT), (err) => err.status === 400);
  });

  test('accepts a legitimate X01 turn whose scored matches its darts', async () => {
    const { gameId } = x01Game(['SEC22_Alice', 'SEC22_Bob']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 0, multiplier: 1 }, { dartNo: 3, sector: 0, multiplier: 1 }],
    }, STRICT));
  });

  test('a bust turn must have scored=0, even if the darts thrown had real value', async () => {
    const { gameId } = x01Game(['SEC22_Alice', 'SEC22_Bob']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 60, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    }, STRICT), (err) => err.status === 400);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    }, STRICT));
  });

  test('a checkout turn must have checkoutPoints equal to scored', async () => {
    const { gameId } = x01Game(['SEC22_Alice', 'SEC22_Bob']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 40, bust: false, checkout: true, checkoutPoints: 170,
      darts: [{ dartNo: 1, sector: 20, multiplier: 2 }],
    }, STRICT), (err) => err.status === 400);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 40, bust: false, checkout: true, checkoutPoints: 40,
      darts: [{ dartNo: 1, sector: 20, multiplier: 2 }],
    }, STRICT));
  });

  test('bull values (25 / double-bull 50) are checked correctly, not just numbers 1-20', async () => {
    const { gameId } = x01Game(['SEC22_Alice', 'SEC22_Bob']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 75, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 25, multiplier: 1 }, { dartNo: 2, sector: 25, multiplier: 2 }],
    }, STRICT));
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 75, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 25, multiplier: 1 }, { dartNo: 2, sector: 25, multiplier: 1 }], // real value: 50, not 75
    }, STRICT), (err) => err.status === 400);
  });

  test('Cricket turns are unaffected even with enforceConsistency set — scored legitimately differs from the sum of dart values', async () => {
    await db.addPlayer('SEC22_CricketA'); await db.addPlayer('SEC22_CricketB');
    const { gameId } = db.createGame({
      category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'cricket', config: { numbers: [15, 16, 17, 18, 19, 20, 25] },
      players: [{ name: 'SEC22_CricketA' }, { name: 'SEC22_CricketB' }],
    });
    // 3xT20 with the opponent's 20 open throughout: this closes 20 on the first dart
    // (0 pts) and pushes 2 more marks beyond the close (60 pts each) -> 120 total,
    // NOT the raw 180 a naive sum-of-dart-values check would demand.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC22_CricketA', set: 1, leg: 1, scored: 120, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 3 }],
    }, STRICT));
  });

  test('without opting in, an inconsistent X01 turn is accepted unchanged (internal-caller/test-fixture convention)', () => {
    const { gameId } = x01Game(['SEC22_Alice', 'SEC22_Bob']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC22_Alice', set: 1, leg: 1, scored: 1, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }], // real value 60, scored says 1 — accepted, no opts passed
    }));
  });
});

describe('SEC-22 — the real HTTP trust boundary enforces this even though addTurn() itself defaults off', () => {
  const SERVER_PATH = path.join(__dirname, '..', 'server.js');

  function waitForHealth(port, timeoutMs = 5000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tryOnce = () => {
        fetch(`http://localhost:${port}/api/health`).then(r => { if (r.ok) resolve(); else retry(); }).catch(retry);
      };
      const retry = () => {
        if (Date.now() - start > timeoutMs) { reject(new Error('server did not start in time')); return; }
        setTimeout(tryOnce, 100);
      };
      tryOnce();
    });
  }

  async function withServer(port, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-turntest-'));
    const dbPath = path.join(dir, 'test.db');
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, PORT: String(port), DARTS_DB: dbPath, OCHE_REQUIRE_AUTH: 'false' },
      stdio: 'ignore',
    });
    try {
      await waitForHealth(port);
      await fn(port);
    } finally {
      child.kill();
      await new Promise(r => setTimeout(r, 150));
    }
  }

  test('POST /api/games/:id/turns rejects an inconsistent X01 turn over the real API', async () => {
    await withServer(8496, async (port) => {
      const base = `http://localhost:${port}`;
      await fetch(`${base}/api/players`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'HttpTurnPlayer' }) });
      const { gameId } = await (await fetch(`${base}/api/games`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: 'HttpTurnPlayer' }] }),
      })).json();

      const res = await fetch(`${base}/api/games/${gameId}/turns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player: 'HttpTurnPlayer', set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
          darts: [{ dartNo: 1, sector: 20, multiplier: 1 }], // real value 20, scored claims 180
        }),
      });
      assert.equal(res.status, 400);
    });
  });
});
