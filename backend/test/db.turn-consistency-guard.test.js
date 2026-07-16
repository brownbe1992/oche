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

describe('addTurn — Baseball scored must match the visit\'s runs, when opted in (SEC-25)', () => {
  // Baseball's turns.scored IS a points-like total (runs) the leaderboards trust, and
  // IS derivable from the visit's own darts + the inning number — so unlike Cricket it
  // gets the same consistency guard X01 does, extended to Baseball's own arithmetic.
  function baseballGame(players) {
    return db.createGame({
      category: 'Baseball', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'baseball', players: players.map(name => ({ name })),
    });
  }

  test('accepts a legitimate mid-game Baseball visit (target hit + a wrong-number 0-run dart)', async () => {
    await db.addPlayer('SEC25_A'); await db.addPlayer('SEC25_B');
    const { gameId } = baseballGame(['SEC25_A', 'SEC25_B']);
    // Inning 1 (no prior turns for this player), target = 1. One single-1 (1 run) + a
    // dart on the wrong number (scores 0) + a treble-1 (3 runs) => 4 runs total.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_A', set: 1, leg: 1, scored: 4, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }, { dartNo: 2, sector: 7, multiplier: 3 }, { dartNo: 3, sector: 1, multiplier: 3 }],
    }, STRICT));
  });

  test('rejects a Baseball turn claiming scored=180 (real per-visit max is 9)', async () => {
    const { gameId } = baseballGame(['SEC25_C', 'SEC25_D']);
    await db.addPlayer('SEC25_C'); await db.addPlayer('SEC25_D');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_C', set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 3 }, { dartNo: 2, sector: 1, multiplier: 3 }, { dartNo: 3, sector: 1, multiplier: 3 }], // real runs: 9
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects a Baseball turn whose scored mismatches its darts', async () => {
    const { gameId } = baseballGame(['SEC25_E', 'SEC25_F']);
    await db.addPlayer('SEC25_E'); await db.addPlayer('SEC25_F');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_E', set: 1, leg: 1, scored: 3, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }], // inning 1, target 1: real runs 1, not 3
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects bust=true or checkout=true on a Baseball turn (the game has neither concept)', async () => {
    const { gameId } = baseballGame(['SEC25_G', 'SEC25_H']);
    await db.addPlayer('SEC25_G'); await db.addPlayer('SEC25_H');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_G', set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_G', set: 1, leg: 1, scored: 1, bust: false, checkout: true, checkoutPoints: 1,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('the target advances with the inning: a second visit is scored against number 2', async () => {
    const { gameId } = baseballGame(['SEC25_I', 'SEC25_J']);
    await db.addPlayer('SEC25_I'); await db.addPlayer('SEC25_J');
    // First turn (inning 1, target 1): 1 run on a single-1.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_I', set: 1, leg: 1, scored: 1, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT));
    // Second turn for the same player (now inning 2, target 2): darts on number 1 score
    // 0 now; a double-2 scores 2. A stale "still target 1" assumption would reject this.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_I', set: 1, leg: 1, scored: 2, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 3 }, { dartNo: 2, sector: 2, multiplier: 2 }],
    }, STRICT));
  });

  test('extra innings keep targeting number 9', async () => {
    const { gameId } = baseballGame(['SEC25_K', 'SEC25_L']);
    await db.addPlayer('SEC25_K'); await db.addPlayer('SEC25_L');
    // Record 9 prior turns (innings 1-9) for this player, then an extra-innings 10th.
    for (let inning = 1; inning <= 9; inning++) {
      db.addTurn(gameId, {
        player: 'SEC25_K', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
        darts: [{ dartNo: 1, sector: 12, multiplier: 1 }], // wrong number for every inning -> 0 runs
      }, STRICT);
    }
    // 10th turn: extra innings, target stays 9. A treble-9 = 3 runs.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_K', set: 1, leg: 1, scored: 3, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 9, multiplier: 3 }],
    }, STRICT));
    // Same 10th-inning shape but claiming those darts scored against number 10 (which
    // doesn't exist) — 0 runs, so a non-zero scored is rejected.
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_K', set: 1, leg: 1, scored: 3, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 10, multiplier: 3 }],
    }, STRICT), (err) => err.status === 400);
  });
});

describe("addTurn — Bob's 27 scored/bust must match the round's double hits, when opted in (docs/practice-ladders-roadmap.md Part A)", () => {
  // Bob's 27's turns.scored is this round's GAIN (0 when the round's double was
  // missed entirely — the penalty is derived at read time, never stored
  // negative), arithmetically derivable from the visit's own darts + the round
  // number the same way Baseball's SEC-25 guard derives runs from the inning
  // number. Unlike Baseball, Bob's 27 DOES have a bust concept (the fatal
  // round), so the guard also re-derives the running score entering this round
  // from every prior turn to check bust reflects whether THIS round's outcome
  // actually drops it to 0 or below.
  function bobs27Game(players) {
    return db.createGame({
      category: "Bob's 27", legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'bobs_27', players: players.map(name => ({ name })),
    });
  }

  test('accepts a legitimate D1 hit (round 1, one double-1)', async () => {
    await db.addPlayer('B27_A');
    const { gameId } = bobs27Game(['B27_A']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'B27_A', set: 1, leg: 1, scored: 2, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 2 }],
    }, STRICT));
  });

  test('accepts a legitimate miss-all round (scored=0, no bust while running stays positive)', async () => {
    await db.addPlayer('B27_B');
    const { gameId } = bobs27Game(['B27_B']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'B27_B', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }, { dartNo: 2, sector: 1, multiplier: 3 }, { dartNo: 3, sector: 0, multiplier: 1 }],
    }, STRICT));
  });

  test('rejects a scored value that doesn\'t match the round\'s actual double hits', async () => {
    await db.addPlayer('B27_C');
    const { gameId } = bobs27Game(['B27_C']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'B27_C', set: 1, leg: 1, scored: 100, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 2 }], // real gain: 2, not 100
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects checkout=true (Bob\'s 27 has no checkout concept)', async () => {
    await db.addPlayer('B27_D');
    const { gameId } = bobs27Game(['B27_D']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'B27_D', set: 1, leg: 1, scored: 2, bust: false, checkout: true, checkoutPoints: 2,
      darts: [{ dartNo: 1, sector: 1, multiplier: 2 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects bust=false on a round that stays positive', async () => {
    await db.addPlayer('B27_E');
    const { gameId } = bobs27Game(['B27_E']);
    // Round 1: miss D1 -> 27 - 2 = 25, not fatal.
    db.addTurn(gameId, {
      player: 'B27_E', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 0, multiplier: 1 }],
    }, STRICT);
    // Round 2: miss D2 -> 25 - 4 = 21, still not fatal. Claiming bust=true here is wrong.
    assert.throws(() => db.addTurn(gameId, {
      player: 'B27_E', set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 0, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400, 'running is still 21 after this round, not <= 0');
  });

  test('rejects bust=true claimed on a round that actually GAINED (a hit round can never be fatal)', async () => {
    await db.addPlayer('B27_F');
    const { gameId } = bobs27Game(['B27_F']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'B27_F', set: 1, leg: 1, scored: 2, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 2 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('accepts a legitimate death: 5 straight misses (27→25→21→15→7→−3) requires bust=true on the 5th', async () => {
    await db.addPlayer('B27_G');
    const { gameId } = bobs27Game(['B27_G']);
    // Rounds 1-4: miss every one (27-2=25, 25-4=21, 21-6=15, 15-8=7) — none fatal yet.
    for (let round = 1; round <= 4; round++) {
      db.addTurn(gameId, {
        player: 'B27_G', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
        darts: [{ dartNo: 1, sector: 0, multiplier: 1 }],
      }, STRICT);
    }
    // Round 5: bust=false would be wrong — 7 - 2*5 = -3, which IS fatal.
    assert.throws(() => db.addTurn(gameId, {
      player: 'B27_G', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 0, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400, 'running drops to -3 this round, which must be flagged bust=true');
    // The correct bust=true is accepted.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'B27_G', set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 0, multiplier: 1 }],
    }, STRICT));
  });

  test('the round number advances with prior turn count: round 2 checks doubles against sector 2, not sector 1', async () => {
    await db.addPlayer('B27_H');
    const { gameId } = bobs27Game(['B27_H']);
    // Round 1: hit D1.
    db.addTurn(gameId, {
      player: 'B27_H', set: 1, leg: 1, scored: 2, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 2 }],
    }, STRICT);
    // Round 2: a double-1 (stale target) now scores nothing; only double-2 counts.
    assert.throws(() => db.addTurn(gameId, {
      player: 'B27_H', set: 1, leg: 1, scored: 2, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 2 }],
    }, STRICT), (err) => err.status === 400, 'D1 is stale in round 2 -- real gain is 0');
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'B27_H', set: 1, leg: 1, scored: 4, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 2, multiplier: 2 }],
    }, STRICT));
  });

  test('rejects a 21st round (Bob\'s 27 only has 20)', async () => {
    await db.addPlayer('B27_I');
    const { gameId } = bobs27Game(['B27_I']);
    for (let round = 1; round <= 20; round++) {
      db.addTurn(gameId, {
        player: 'B27_I', set: 1, leg: 1, scored: round * 2, bust: false, checkout: false, checkoutPoints: null,
        darts: [{ dartNo: 1, sector: round, multiplier: 2 }],
      }, STRICT);
    }
    assert.throws(() => db.addTurn(gameId, {
      player: 'B27_I', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 2 }],
    }, STRICT), (err) => err.status === 400);
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
