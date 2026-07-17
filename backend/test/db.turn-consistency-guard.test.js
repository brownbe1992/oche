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

describe('addTurn — Shanghai scored must match the visit\'s points, when opted in (docs/archive/shanghai-roadmap.md, same SEC-25 shape as Baseball)', () => {
  // Shanghai's turns.scored IS a points-like total the leaderboards trust, and
  // IS derivable from the visit's own darts + the round number, exactly the
  // way Baseball's own guard above works — see that block's own comment.
  // Ceiling note: the roadmap doc's own draft text says "max legit visit = 6x
  // the round number" — that undersells it; three trebles of the round's own
  // number is a real, legal, NON-Shanghai 9x-the-round-number visit, so the
  // real ceiling this guard enforces (naturally, via the darts themselves) is
  // 9x, not 6x — a correctness fix over the doc's literal wording, not a
  // deviation from its actual intent.
  function shanghaiGame(players, rounds) {
    return db.createGame({
      category: 'Shanghai', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'shanghai', config: { rounds: rounds || 7 }, players: players.map(name => ({ name })),
    });
  }

  test('accepts a legitimate mid-game Shanghai visit (target hit + a wrong-number 0-point dart)', async () => {
    await db.addPlayer('SEC25_SH_A'); await db.addPlayer('SEC25_SH_B');
    const { gameId } = shanghaiGame(['SEC25_SH_A', 'SEC25_SH_B']);
    // Round 1 (no prior turns for this player), target = 1. A single-1 (1 point) + a
    // dart on the wrong number (scores 0) + a treble-1 (3 points) => 4 points total.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_SH_A', set: 1, leg: 1, scored: 4, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }, { dartNo: 2, sector: 7, multiplier: 3 }, { dartNo: 3, sector: 1, multiplier: 3 }],
    }, STRICT));
  });

  test('accepts a genuine Shanghai visit (single+double+treble of the round\'s number = 6x)', async () => {
    await db.addPlayer('SEC25_SH_Shanghai1'); await db.addPlayer('SEC25_SH_Shanghai2');
    const { gameId } = shanghaiGame(['SEC25_SH_Shanghai1', 'SEC25_SH_Shanghai2']);
    // Round 1, target 1: single(1) + double(2) + treble(3) = 6 points -- a real Shanghai.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_SH_Shanghai1', set: 1, leg: 1, scored: 6, bust: false, checkout: false, checkoutPoints: null, legWon: true,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }, { dartNo: 2, sector: 1, multiplier: 2 }, { dartNo: 3, sector: 1, multiplier: 3 }],
    }, STRICT));
  });

  test('accepts three trebles of the round\'s number (9x) -- a real, legal, non-Shanghai visit', async () => {
    await db.addPlayer('SEC25_SH_NineX_A'); await db.addPlayer('SEC25_SH_NineX_B');
    const { gameId } = shanghaiGame(['SEC25_SH_NineX_A', 'SEC25_SH_NineX_B']);
    // Round 1, target 1: three trebles = 9 points -- MORE than a Shanghai's 6, and legal.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_SH_NineX_A', set: 1, leg: 1, scored: 9, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 3 }, { dartNo: 2, sector: 1, multiplier: 3 }, { dartNo: 3, sector: 1, multiplier: 3 }],
    }, STRICT));
  });

  test('rejects a Shanghai turn claiming scored=180 (real per-visit max on round 1 is 9)', async () => {
    const { gameId } = shanghaiGame(['SEC25_SH_C', 'SEC25_SH_D']);
    await db.addPlayer('SEC25_SH_C'); await db.addPlayer('SEC25_SH_D');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_SH_C', set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 3 }, { dartNo: 2, sector: 1, multiplier: 3 }, { dartNo: 3, sector: 1, multiplier: 3 }], // real points: 9
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects a Shanghai turn whose scored mismatches its darts', async () => {
    const { gameId } = shanghaiGame(['SEC25_SH_E', 'SEC25_SH_F']);
    await db.addPlayer('SEC25_SH_E'); await db.addPlayer('SEC25_SH_F');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_SH_E', set: 1, leg: 1, scored: 3, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }], // round 1, target 1: real points 1, not 3
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects bust=true or checkout=true on a Shanghai turn (the game has neither concept)', async () => {
    const { gameId } = shanghaiGame(['SEC25_SH_G', 'SEC25_SH_H']);
    await db.addPlayer('SEC25_SH_G'); await db.addPlayer('SEC25_SH_H');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_SH_G', set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_SH_G', set: 1, leg: 1, scored: 1, bust: false, checkout: true, checkoutPoints: 1,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('the target advances with the round: a second visit is scored against number 2', async () => {
    const { gameId } = shanghaiGame(['SEC25_SH_I', 'SEC25_SH_J']);
    await db.addPlayer('SEC25_SH_I'); await db.addPlayer('SEC25_SH_J');
    // First turn (round 1, target 1): 1 point on a single-1.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_SH_I', set: 1, leg: 1, scored: 1, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT));
    // Second turn for the same player (now round 2, target 2): darts on number 1 score
    // 0 now; a double-2 scores 4. A stale "still target 1" assumption would reject this.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_SH_I', set: 1, leg: 1, scored: 4, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 3 }, { dartNo: 2, sector: 2, multiplier: 2 }],
    }, STRICT));
  });

  test('extra rounds (a tie after the final round) keep targeting the last round\'s number', async () => {
    const { gameId } = shanghaiGame(['SEC25_SH_K', 'SEC25_SH_L'], 7);
    await db.addPlayer('SEC25_SH_K'); await db.addPlayer('SEC25_SH_L');
    // Record 7 prior turns (rounds 1-7) for this player, then an extra-round 8th.
    for (let round = 1; round <= 7; round++) {
      db.addTurn(gameId, {
        player: 'SEC25_SH_K', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
        darts: [{ dartNo: 1, sector: 12, multiplier: 1 }], // wrong number for every round -> 0 points
      }, STRICT);
    }
    // 8th turn: extra rounds, target stays 7. A treble-7 = 21 points.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_SH_K', set: 1, leg: 1, scored: 21, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 7, multiplier: 3 }],
    }, STRICT));
    // Same 8th-round shape but claiming those darts scored against number 8 (which
    // doesn't exist as a round target) -- 0 points, so a non-zero scored is rejected.
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_SH_K', set: 1, leg: 1, scored: 21, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 8, multiplier: 3 }],
    }, STRICT), (err) => err.status === 400);
  });
});

describe('addTurn — Halve-It scored/bust must match the visit\'s points on the round\'s target, when opted in (docs/halve-it-roadmap.md)', () => {
  // Halve-It's turns.scored IS the visit's GAIN (0 on a halved visit), derivable
  // from the visit's own darts + the round's target (sector, optionally
  // ring-restricted) -- same SEC-25 shape as Baseball/Shanghai above. UNLIKE
  // those two, `bust` is legitimately repurposed here as "this visit halved
  // the running total" (docs/halve-it-roadmap.md's own column-repurposing
  // precedent), so the guard checks it for CONSISTENCY (bust iff gained===0)
  // rather than rejecting it outright.
  function halveItGame(players, targets) {
    return db.createGame({
      category: 'Halve-It', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'halve_it', config: { targets: targets || [{ sector: 20 }, { sector: 7, ring: 'double' }] },
      players: players.map(name => ({ name })),
    });
  }

  test('accepts a legitimate mid-game Halve-It visit on an unrestricted target', async () => {
    await db.addPlayer('SEC25_HI_A'); await db.addPlayer('SEC25_HI_B');
    const { gameId } = halveItGame(['SEC25_HI_A', 'SEC25_HI_B']);
    // Round 1 (no prior turns), target = plain 20. Single 20 + a wrong-number
    // dart (0) + treble 20 => 20 + 0 + 60 = 80 points, bust must be false.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_HI_A', set: 1, leg: 1, scored: 80, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 7, multiplier: 1 }, { dartNo: 3, sector: 20, multiplier: 3 }],
    }, STRICT));
  });

  test('accepts a fully-missed visit with bust=true (the halving flag) and scored=0', async () => {
    const { gameId } = halveItGame(['SEC25_HI_C', 'SEC25_HI_D']);
    await db.addPlayer('SEC25_HI_C'); await db.addPlayer('SEC25_HI_D');
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_HI_C', set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }, { dartNo: 2, sector: 2, multiplier: 1 }, { dartNo: 3, sector: 3, multiplier: 1 }], // none hit round 1's target (20)
    }, STRICT));
  });

  test('rejects bust=false on a visit that actually gained 0 (the halving flag must reflect reality)', async () => {
    const { gameId } = halveItGame(['SEC25_HI_E', 'SEC25_HI_F']);
    await db.addPlayer('SEC25_HI_E'); await db.addPlayer('SEC25_HI_F');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_HI_E', set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects bust=true on a visit that actually hit the target (the halving flag must reflect reality)', async () => {
    const { gameId } = halveItGame(['SEC25_HI_G', 'SEC25_HI_H']);
    await db.addPlayer('SEC25_HI_G'); await db.addPlayer('SEC25_HI_H');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_HI_G', set: 1, leg: 1, scored: 20, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects a Halve-It turn whose scored mismatches its darts', async () => {
    const { gameId } = halveItGame(['SEC25_HI_I', 'SEC25_HI_J']);
    await db.addPlayer('SEC25_HI_I'); await db.addPlayer('SEC25_HI_J');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_HI_I', set: 1, leg: 1, scored: 99, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }], // real gain: 20, not 99
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects checkout=true on a Halve-It turn (the game has no checkout concept)', async () => {
    const { gameId } = halveItGame(['SEC25_HI_K', 'SEC25_HI_L']);
    await db.addPlayer('SEC25_HI_K'); await db.addPlayer('SEC25_HI_L');
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_HI_K', set: 1, leg: 1, scored: 20, bust: false, checkout: true, checkoutPoints: 20,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('a ring-restricted target (double 7) only credits the exact ring, and the target advances with the round', async () => {
    const { gameId } = halveItGame(['SEC25_HI_M', 'SEC25_HI_N'], [{ sector: 20 }, { sector: 7, ring: 'double' }]);
    await db.addPlayer('SEC25_HI_M'); await db.addPlayer('SEC25_HI_N');
    // First turn (round 1, plain 20): 20 points on a single-20.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_HI_M', set: 1, leg: 1, scored: 20, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }],
    }, STRICT));
    // Second turn (now round 2, double 7 only): a single-7 and a treble-7 both
    // score 0 here; only the double-7 counts, for 14.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_HI_M', set: 1, leg: 1, scored: 14, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 7, multiplier: 1 }, { dartNo: 2, sector: 7, multiplier: 3 }, { dartNo: 3, sector: 7, multiplier: 2 }],
    }, STRICT));
    // Claiming the single/treble sevens also counted (scored=14+7+21=42) is rejected.
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC25_HI_M', set: 1, leg: 1, scored: 42, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 7, multiplier: 1 }, { dartNo: 2, sector: 7, multiplier: 3 }, { dartNo: 3, sector: 7, multiplier: 2 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('extra rounds (a tie after the final round) keep targeting the last round\'s own target', async () => {
    const { gameId } = halveItGame(['SEC25_HI_O', 'SEC25_HI_P'], [{ sector: 20 }]);
    await db.addPlayer('SEC25_HI_O'); await db.addPlayer('SEC25_HI_P');
    // First turn uses up the only configured round (round 1, target 20).
    db.addTurn(gameId, {
      player: 'SEC25_HI_O', set: 1, leg: 1, scored: 20, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }],
    }, STRICT);
    // Second turn: extra round, target stays 20 (the only/final target). A
    // treble-20 = 60 points.
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC25_HI_O', set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    }, STRICT));
  });
});

describe('addTurn — The Pressure Chamber scored/bust/checkout/legWon must match the derived round outcome, when opted in (docs/pressure-chamber-roadmap.md)', () => {
  // The Pressure Chamber's card (target+modifier) is a pure function of
  // (gameId, roundIndex) -- generatePressureCard() -- so it's re-derived here
  // with the REAL gameId createGame() assigns, exactly like the guard itself
  // does, rather than hand-picking fixed darts against an assumed card. A
  // guaranteed-miss dart (sector 0) is a 'miss' outcome against ANY card
  // (sector or finish target, any modifier), which makes it a cheap, fully
  // general way to "burn through" rounds this test doesn't care about to
  // reach a specific round it does.
  const { generatePressureCard, computePressureRoundResult, PRESSURE_RING_MULT, PRESSURE_ROUNDS: MAX_ROUNDS } =
    require(path.join('..', '..', 'frontend', 'scoring.js'));
  const missDarts = [{ dartNo: 1, sector: 0, multiplier: 1 }];

  function pcGame(players) {
    return db.createGame({
      category: 'Pressure Chamber', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'pressure_chamber', config: { rounds: MAX_ROUNDS },
      players: players.map(name => ({ name })),
    });
  }
  // Burns through rounds 1..(round-1) for `player` with a guaranteed miss,
  // landing the NEXT addTurn() call for that player squarely on `round`.
  function burnTo(gameId, player, round) {
    for (let r = 1; r < round; r++) {
      db.addTurn(gameId, { player, set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null, legWon: false, darts: missDarts }, STRICT);
    }
  }
  function findRound(gameId, type) {
    for (let r = 1; r <= MAX_ROUNDS; r++) {
      if (generatePressureCard(gameId, r).target.type === type) return r;
    }
    return null;
  }

  test('accepts a genuine full hit (a real dart matching the round\'s own sector+ring)', async () => {
    await db.addPlayer('SEC_PC_A'); await db.addPlayer('SEC_PC_B');
    const { gameId } = pcGame(['SEC_PC_A', 'SEC_PC_B']);
    const round = findRound(gameId, 'sector');
    assert.ok(round, 'the curated pool has plenty of sector targets within 15 rounds');
    burnTo(gameId, 'SEC_PC_A', round);
    const card = generatePressureCard(gameId, round);
    const hitDart = { dartNo: 1, sector: card.target.sector, multiplier: PRESSURE_RING_MULT[card.target.ring] };
    const expected = computePressureRoundResult(card, [{ sector: hitDart.sector, mult: hitDart.multiplier, value: 0, isDouble: hitDart.multiplier === 2 }]);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC_PC_A', set: 1, leg: 1, scored: expected.gained, bust: false, checkout: true, legWon: true, checkoutPoints: null,
      darts: [hitDart],
    }, STRICT));
  });

  test('rejects a claimed full hit whose darts don\'t actually match the round\'s target', async () => {
    await db.addPlayer('SEC_PC_C'); await db.addPlayer('SEC_PC_D');
    const { gameId } = pcGame(['SEC_PC_C', 'SEC_PC_D']);
    const round = findRound(gameId, 'sector');
    burnTo(gameId, 'SEC_PC_C', round);
    const card = generatePressureCard(gameId, round);
    // Deliberately throw at a sector that is NOT this round's target (wrap
    // around 1-20 to guarantee a mismatch).
    const wrongSector = card.target.sector === 20 ? 19 : card.target.sector + 1;
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC_PC_C', set: 1, leg: 1, scored: 999, bust: false, checkout: true, legWon: true, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: wrongSector, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('accepts a genuine miss (bust=1, scored=0, checkout=0, legWon=0)', async () => {
    await db.addPlayer('SEC_PC_E'); await db.addPlayer('SEC_PC_F');
    const { gameId } = pcGame(['SEC_PC_E', 'SEC_PC_F']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC_PC_E', set: 1, leg: 1, scored: 0, bust: true, checkout: false, legWon: false, checkoutPoints: null,
      darts: missDarts,
    }, STRICT));
  });

  test('rejects legWon=1 on a genuine miss (the 3-way outcome must be internally consistent)', async () => {
    await db.addPlayer('SEC_PC_G'); await db.addPlayer('SEC_PC_H');
    const { gameId } = pcGame(['SEC_PC_G', 'SEC_PC_H']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC_PC_G', set: 1, leg: 1, scored: 0, bust: true, checkout: false, legWon: true, checkoutPoints: null,
      darts: missDarts,
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects a 16th round -- a Pressure Chamber run is fixed at exactly 15 rounds, no extension', async () => {
    await db.addPlayer('SEC_PC_I'); await db.addPlayer('SEC_PC_J');
    const { gameId } = pcGame(['SEC_PC_I', 'SEC_PC_J']);
    burnTo(gameId, 'SEC_PC_I', MAX_ROUNDS + 1); // burns through all 15 real rounds
    assert.throws(() => db.addTurn(gameId, {
      player: 'SEC_PC_I', set: 1, leg: 1, scored: 0, bust: true, checkout: false, legWon: false, checkoutPoints: null,
      darts: missDarts,
    }, STRICT), (err) => err.status === 400);
  });

  test('a finish target is graded via a legal double-out checkout, not sector/ring matching', async () => {
    await db.addPlayer('SEC_PC_K'); await db.addPlayer('SEC_PC_L');
    const { gameId } = pcGame(['SEC_PC_K', 'SEC_PC_L']);
    const round = findRound(gameId, 'finish');
    if (round == null) return; // the curated pool always has >=1, but don't hard-fail a future pool edit
    burnTo(gameId, 'SEC_PC_K', round);
    const card = generatePressureCard(gameId, round);
    // Finish 40 in the curated pool -> D20 checks it out in 1 dart, always legal double-out.
    const d20 = { sector: 20, mult: 2, value: 40, isDouble: true };
    const expected = computePressureRoundResult(card, card.target.score === 40 ? [d20] : []);
    if (card.target.score !== 40) return; // only assert the concrete case this pool actually contains
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'SEC_PC_K', set: 1, leg: 1, scored: expected.gained, bust: false, checkout: true, legWon: true, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 2 }],
    }, STRICT));
  });
});

describe("addTurn — Bob's 27 scored/bust must match the round's double hits, when opted in (docs/archive/practice-ladders-roadmap.md Part A)", () => {
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

describe('addTurn — 121 Checkout Ladder scored/targetScore/visit-cap must match, when opted in (docs/archive/practice-ladders-roadmap.md Part B)', () => {
  // A genuine X01 visit (identical dart-sum/bust/checkout arithmetic to the
  // 'x01' branch) capped at 3 visits per attempt, with the attempt's own
  // target derived from every strictly-prior leg's own recorded outcome
  // (never trusted from the client) — same shape SEC-22/SEC-25 already
  // establish for X01/Baseball, applied to this game type's own new rules.
  function checkoutLadderGame(players) {
    return db.createGame({
      category: '121 Checkout Ladder', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'checkout_ladder', players: players.map(name => ({ name })),
    });
  }

  test('accepts a legitimate non-finishing first visit at the mandatory target 121', async () => {
    await db.addPlayer('CL_A');
    const { gameId } = checkoutLadderGame(['CL_A']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'CL_A', set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null, targetScore: 121,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    }, STRICT));
  });

  test('rejects a scored value that does not match the sum of the darts thrown', async () => {
    await db.addPlayer('CL_B');
    const { gameId } = checkoutLadderGame(['CL_B']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_B', set: 1, leg: 1, scored: 100, bust: false, checkout: false, checkoutPoints: null, targetScore: 121,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }], // real sum: 60, not 100
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects a bust turn claiming a nonzero scored', async () => {
    await db.addPlayer('CL_C');
    const { gameId } = checkoutLadderGame(['CL_C']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_C', set: 1, leg: 1, scored: 60, bust: true, checkout: false, checkoutPoints: null, targetScore: 121,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('accepts a legitimate checkout (121 = T19 + T20 + D2, double-out)', async () => {
    await db.addPlayer('CL_D');
    const { gameId } = checkoutLadderGame(['CL_D']);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'CL_D', set: 1, leg: 1, scored: 121, bust: false, checkout: true, checkoutPoints: 121, targetScore: 121,
      darts: [{ dartNo: 1, sector: 19, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 2, multiplier: 2 }],
    }, STRICT));
  });

  test('rejects checkoutPoints that does not match scored on a checkout turn', async () => {
    await db.addPlayer('CL_E');
    const { gameId } = checkoutLadderGame(['CL_E']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_E', set: 1, leg: 1, scored: 121, bust: false, checkout: true, checkoutPoints: 100, targetScore: 121,
      darts: [{ dartNo: 1, sector: 19, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 2, multiplier: 2 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects a targetScore other than 121 for a player\'s very first attempt', async () => {
    await db.addPlayer('CL_F');
    const { gameId } = checkoutLadderGame(['CL_F']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_F', set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null, targetScore: 130,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects a 4th visit within the same attempt (capped at 3)', async () => {
    await db.addPlayer('CL_G');
    const { gameId } = checkoutLadderGame(['CL_G']);
    for (let visit = 1; visit <= 3; visit++) {
      db.addTurn(gameId, {
        player: 'CL_G', set: 1, leg: 1, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 121,
        darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
      }, STRICT);
    }
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_G', set: 1, leg: 1, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 121,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400, 'a checkout ladder attempt is capped at 3 visits');
  });

  test('after a win, the next attempt must target one rung higher (122)', async () => {
    await db.addPlayer('CL_H');
    const { gameId } = checkoutLadderGame(['CL_H']);
    db.addTurn(gameId, {
      player: 'CL_H', set: 1, leg: 1, scored: 121, bust: false, checkout: true, checkoutPoints: 121, targetScore: 121,
      darts: [{ dartNo: 1, sector: 19, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 2, multiplier: 2 }],
    }, STRICT);
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_H', set: 1, leg: 2, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 121,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400, 'stale target -- leg 1 was won, attempt 2 must target 122');
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'CL_H', set: 1, leg: 2, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 122,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT));
  });

  test('after a fail (3 visits, no checkout), the next attempt must target one rung lower (120)', async () => {
    await db.addPlayer('CL_I');
    const { gameId } = checkoutLadderGame(['CL_I']);
    for (let visit = 1; visit <= 3; visit++) {
      db.addTurn(gameId, {
        player: 'CL_I', set: 1, leg: 1, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 121,
        darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
      }, STRICT);
    }
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_I', set: 1, leg: 2, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 121,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400, 'stale target -- leg 1 was lost, attempt 2 must target 120');
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'CL_I', set: 1, leg: 2, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 120,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT));
  });

  test('the target floors at 61 and never goes lower, however many attempts fail in a row', async () => {
    await db.addPlayer('CL_J');
    const { gameId } = checkoutLadderGame(['CL_J']);
    let target = 121;
    // Fail enough attempts (61 of them) to reach the floor: 121 - 61 = 60 < 61.
    for (let leg = 1; leg <= 61; leg++) {
      for (let visit = 1; visit <= 3; visit++) {
        db.addTurn(gameId, {
          player: 'CL_J', set: 1, leg, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: target,
          darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
        }, STRICT);
      }
      target = Math.max(61, target - 1);
    }
    assert.equal(target, 61, 'sanity check on the test\'s own math');
    // The next attempt (leg 62) must target 61 again, not 60 -- the floor held.
    assert.throws(() => db.addTurn(gameId, {
      player: 'CL_J', set: 1, leg: 62, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 60,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
    assert.doesNotThrow(() => db.addTurn(gameId, {
      player: 'CL_J', set: 1, leg: 62, scored: 1, bust: false, checkout: false, checkoutPoints: null, targetScore: 61,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT));
  });
});

describe('addTurn — The Gauntlet sequence/repeat-count/scored-range must match, when opted in (docs/archive/gauntlet-roadmap.md)', () => {
  function gauntletGame(players) {
    return db.createGame({
      category: 'The Gauntlet', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'gauntlet', players: players.map(name => ({ name })),
    });
  }
  const STATIONS = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5];
  function gt(gameId, player, station, scored) {
    return db.addTurn(gameId, {
      player, set: 1, leg: 1, scored, bust: false, checkout: false, checkoutPoints: null, targetScore: station,
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT);
  }

  test('accepts a legitimate first attempt at the mandatory first station (20)', () => {
    db.addPlayer('GA_A');
    const { gameId } = gauntletGame(['GA_A']);
    assert.doesNotThrow(() => gt(gameId, 'GA_A', STATIONS[0], 0));
  });

  test('rejects a targetScore that skips ahead of the first station', () => {
    db.addPlayer('GA_B');
    const { gameId } = gauntletGame(['GA_B']);
    assert.throws(() => gt(gameId, 'GA_B', STATIONS[1], 0), (err) => err.status === 400);
  });

  test('rejects a scored (miss count) outside 0-3', () => {
    db.addPlayer('GA_C');
    const { gameId } = gauntletGame(['GA_C']);
    assert.throws(() => gt(gameId, 'GA_C', STATIONS[0], 4), (err) => err.status === 400);
    assert.throws(() => gt(gameId, 'GA_C', STATIONS[0], -1), (err) => err.status === 400);
  });

  test('rejects checkout=true and bust=true (Gauntlet has neither concept)', () => {
    db.addPlayer('GA_D');
    const { gameId } = gauntletGame(['GA_D']);
    assert.throws(() => db.addTurn(gameId, {
      player: 'GA_D', set: 1, leg: 1, scored: 0, bust: false, checkout: true, checkoutPoints: 0, targetScore: STATIONS[0],
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
    assert.throws(() => db.addTurn(gameId, {
      player: 'GA_D', set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null, targetScore: STATIONS[0],
      darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('a clean pass (0 misses) settles immediately -- the next attempt must target the 2nd station, not the 1st again', () => {
    db.addPlayer('GA_E');
    const { gameId } = gauntletGame(['GA_E']);
    gt(gameId, 'GA_E', STATIONS[0], 0);
    assert.throws(() => gt(gameId, 'GA_E', STATIONS[0], 0), (err) => err.status === 400, 'station 1 already settled');
    assert.doesNotThrow(() => gt(gameId, 'GA_E', STATIONS[1], 1));
  });

  test('a first attempt scoring 2 misses is NOT settled -- the very next turn must repeat the SAME station', () => {
    db.addPlayer('GA_F');
    const { gameId } = gauntletGame(['GA_F']);
    gt(gameId, 'GA_F', STATIONS[0], 2);
    assert.throws(() => gt(gameId, 'GA_F', STATIONS[1], 0), (err) => err.status === 400, 'station 1 is awaiting its one repeat, not settled');
    assert.doesNotThrow(() => gt(gameId, 'GA_F', STATIONS[0], 1), 'the repeat, at the same station');
  });

  test('after the repeat resolves, a 3rd attempt at that station is rejected -- only ever one repeat', () => {
    db.addPlayer('GA_G');
    const { gameId } = gauntletGame(['GA_G']);
    gt(gameId, 'GA_G', STATIONS[0], 2);
    gt(gameId, 'GA_G', STATIONS[0], 3); // the one allowed repeat, came back worse -- still final
    assert.throws(() => gt(gameId, 'GA_G', STATIONS[0], 0), (err) => err.status === 400, 'station 1 already settled by its repeat');
    assert.doesNotThrow(() => gt(gameId, 'GA_G', STATIONS[1], 0), 'now correctly expects station 2');
  });

  test('a 3-miss (Deep Scar) first attempt settles immediately, no repeat offered', () => {
    db.addPlayer('GA_H');
    const { gameId } = gauntletGame(['GA_H']);
    gt(gameId, 'GA_H', STATIONS[0], 3);
    assert.throws(() => gt(gameId, 'GA_H', STATIONS[0], 0), (err) => err.status === 400, 'no repeat for a Deep Scar');
    assert.doesNotThrow(() => gt(gameId, 'GA_H', STATIONS[1], 0));
  });

  test('once all 20 stations are settled, no further turn is accepted', () => {
    db.addPlayer('GA_I');
    const { gameId } = gauntletGame(['GA_I']);
    STATIONS.forEach(station => gt(gameId, 'GA_I', station, 0));
    assert.throws(() => gt(gameId, 'GA_I', STATIONS[0], 0), (err) => err.status === 400, 'the run is already complete');
  });
});

describe('createGame — Killer number assignment/validation (docs/archive/game-modes-roadmap.md "Killer")', () => {
  test('rejects fewer than 2 players', () => {
    db.addPlayer('K_Solo');
    assert.throws(() => db.createGame({
      category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', players: [{ name: 'K_Solo' }],
    }), (err) => err.status === 400);
  });

  test('rejects an out-of-range or non-integer lives threshold', () => {
    db.addPlayer('K_LivesA'); db.addPlayer('K_LivesB');
    const mk = (lives) => () => db.createGame({
      category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', config: { lives }, players: [{ name: 'K_LivesA' }, { name: 'K_LivesB' }],
    });
    assert.throws(mk(0), (err) => err.status === 400);
    assert.throws(mk(21), (err) => err.status === 400);
    assert.throws(mk(2.5), (err) => err.status === 400);
  });

  test('defaults lives to 3 when omitted, and assigns every player a distinct number 1-20 -- never trusting a client-submitted numbers map', () => {
    db.addPlayer('K_AssignA'); db.addPlayer('K_AssignB'); db.addPlayer('K_AssignC');
    const { config } = db.createGame({
      category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer',
      config: { numbers: { K_AssignA: 1, K_AssignB: 1, K_AssignC: 1 } }, // hostile/bogus -- must be ignored entirely
      players: [{ name: 'K_AssignA' }, { name: 'K_AssignB' }, { name: 'K_AssignC' }],
    });
    assert.equal(config.lives, 3);
    const values = ['K_AssignA','K_AssignB','K_AssignC'].map(n => config.numbers[n]);
    assert.equal(new Set(values).size, 3, 'every player got a distinct number -- the bogus duplicate submission was ignored');
    values.forEach(v => assert.ok(v >= 1 && v <= 20));
  });

  test('a valid custom lives threshold is honored', () => {
    db.addPlayer('K_CustomA'); db.addPlayer('K_CustomB');
    const { config } = db.createGame({
      category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', config: { lives: 5 }, players: [{ name: 'K_CustomA' }, { name: 'K_CustomB' }],
    });
    assert.equal(config.lives, 5);
  });
});

describe('addTurn — Killer scored/affectedPlayer must match the derived life-change, when opted in (docs/archive/game-modes-roadmap.md "Killer")', () => {
  function killerGame(names, lives) {
    return db.createGame({
      category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', config: lives ? { lives } : {}, players: names.map(name => ({ name })),
    });
  }
  function kt(gameId, player, sector, mult, { scored, affectedPlayer = null } = {}) {
    return db.addTurn(gameId, {
      player, set: 1, leg: 1, scored, bust: false, checkout: false, checkoutPoints: null, affectedPlayer,
      darts: [{ dartNo: 1, sector, multiplier: mult }],
    }, STRICT);
  }

  test('accepts a legitimate own-number gain (single = 1 life)', () => {
    db.addPlayer('K_A'); db.addPlayer('K_B');
    const { gameId, config } = killerGame(['K_A', 'K_B']);
    const a = config.numbers.K_A;
    assert.doesNotThrow(() => kt(gameId, 'K_A', a, 1, { scored: 1, affectedPlayer: 'K_A' }));
  });

  test('rejects a scored magnitude that does not match the dart\'s own ring', () => {
    db.addPlayer('K_C'); db.addPlayer('K_D');
    const { gameId, config } = killerGame(['K_C', 'K_D']);
    const c = config.numbers.K_C;
    assert.throws(() => kt(gameId, 'K_C', c, 3, { scored: 1, affectedPlayer: 'K_C' }), (err) => err.status === 400);
  });

  test('rejects checkout=true and bust=true (Killer has neither concept)', () => {
    db.addPlayer('K_E'); db.addPlayer('K_F');
    const { gameId, config } = killerGame(['K_E', 'K_F']);
    const e = config.numbers.K_E;
    assert.throws(() => db.addTurn(gameId, {
      player: 'K_E', set: 1, leg: 1, scored: 1, bust: false, checkout: true, checkoutPoints: 1, affectedPlayer: 'K_E',
      darts: [{ dartNo: 1, sector: e, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
    assert.throws(() => db.addTurn(gameId, {
      player: 'K_E', set: 1, leg: 1, scored: 1, bust: true, checkout: false, checkoutPoints: null, affectedPlayer: 'K_E',
      darts: [{ dartNo: 1, sector: e, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects more than 1 dart in a single turn (per-dart evaluation only)', () => {
    db.addPlayer('K_G'); db.addPlayer('K_H');
    const { gameId, config } = killerGame(['K_G', 'K_H']);
    const g = config.numbers.K_G;
    assert.throws(() => db.addTurn(gameId, {
      player: 'K_G', set: 1, leg: 1, scored: 1, bust: false, checkout: false, checkoutPoints: null, affectedPlayer: 'K_G',
      darts: [{ dartNo: 1, sector: g, multiplier: 1 }, { dartNo: 2, sector: g, multiplier: 1 }],
    }, STRICT), (err) => err.status === 400);
  });

  test('rejects attacking an opponent before becoming a killer', () => {
    db.addPlayer('K_I'); db.addPlayer('K_J');
    const { gameId, config } = killerGame(['K_I', 'K_J']);
    const j = config.numbers.K_J;
    assert.throws(() => kt(gameId, 'K_I', j, 1, { scored: 1, affectedPlayer: 'K_J' }), (err) => err.status === 400);
  });

  test('accepts a legitimate attack once a killer, at the correct scaled magnitude, against the correct opponent', () => {
    db.addPlayer('K_K'); db.addPlayer('K_L');
    const { gameId, config } = killerGame(['K_K', 'K_L']);
    const k = config.numbers.K_K, l = config.numbers.K_L;
    kt(gameId, 'K_K', k, 3, { scored: 3, affectedPlayer: 'K_K' }); // K_K becomes a killer (3 lives)
    assert.doesNotThrow(() => kt(gameId, 'K_K', l, 2, { scored: 2, affectedPlayer: 'K_L' })); // attacks K_L for 2
  });

  test('rejects an attack claiming the wrong affected player', () => {
    db.addPlayer('K_M'); db.addPlayer('K_N'); db.addPlayer('K_O');
    const { gameId, config } = killerGame(['K_M', 'K_N', 'K_O']);
    const m = config.numbers.K_M, n = config.numbers.K_N;
    kt(gameId, 'K_M', m, 3, { scored: 3, affectedPlayer: 'K_M' }); // K_M becomes a killer
    assert.throws(() => kt(gameId, 'K_M', n, 1, { scored: 1, affectedPlayer: 'K_O' }), (err) => err.status === 400, 'the dart actually hit K_N\'s number, not K_O\'s');
  });

  test('accepts a legitimate self-kill (own double after becoming a killer, flat 1 life)', () => {
    db.addPlayer('K_P'); db.addPlayer('K_Q');
    const { gameId, config } = killerGame(['K_P', 'K_Q']);
    const p = config.numbers.K_P;
    kt(gameId, 'K_P', p, 3, { scored: 3, affectedPlayer: 'K_P' }); // killer, 3 lives
    assert.doesNotThrow(() => kt(gameId, 'K_P', p, 2, { scored: 1, affectedPlayer: 'K_P' })); // self-kill: flat 1, not 2
  });

  test('rejects claiming a self-kill\'s scored as the multiplier instead of the flat 1', () => {
    db.addPlayer('K_R'); db.addPlayer('K_S');
    const { gameId, config } = killerGame(['K_R', 'K_S']);
    const r = config.numbers.K_R;
    kt(gameId, 'K_R', r, 3, { scored: 3, affectedPlayer: 'K_R' }); // killer, 3 lives
    assert.throws(() => kt(gameId, 'K_R', r, 2, { scored: 2, affectedPlayer: 'K_R' }), (err) => err.status === 400);
  });

  test('a single/treble on your own number again post-killer is a no-op -- rejects a nonzero claim', () => {
    db.addPlayer('K_T'); db.addPlayer('K_U');
    const { gameId, config } = killerGame(['K_T', 'K_U']);
    const t = config.numbers.K_T;
    kt(gameId, 'K_T', t, 3, { scored: 3, affectedPlayer: 'K_T' }); // killer
    assert.throws(() => kt(gameId, 'K_T', t, 1, { scored: 1, affectedPlayer: 'K_T' }), (err) => err.status === 400);
    assert.doesNotThrow(() => kt(gameId, 'K_T', t, 1, { scored: 0, affectedPlayer: null }));
  });

  test('rejects any turn from an already-eliminated player', () => {
    db.addPlayer('K_V'); db.addPlayer('K_W');
    const { gameId, config } = killerGame(['K_V', 'K_W']);
    const v = config.numbers.K_V, w = config.numbers.K_W;
    kt(gameId, 'K_V', v, 3, { scored: 3, affectedPlayer: 'K_V' }); // K_V killer
    kt(gameId, 'K_W', w, 1, { scored: 1, affectedPlayer: 'K_W' }); // K_W builds 1 life
    kt(gameId, 'K_V', w, 1, { scored: 1, affectedPlayer: 'K_W' }); // K_V attacks K_W's last life -> eliminated, K_V wins
    assert.throws(() => kt(gameId, 'K_W', w, 1, { scored: 0, affectedPlayer: null }), (err) => err.status === 400, 'K_W is eliminated and the leg is already won');
  });

  test('rejects any turn once the leg has already been won', () => {
    db.addPlayer('K_X'); db.addPlayer('K_Y');
    const { gameId, config } = killerGame(['K_X', 'K_Y']);
    const x = config.numbers.K_X, y = config.numbers.K_Y;
    kt(gameId, 'K_X', x, 3, { scored: 3, affectedPlayer: 'K_X' });
    kt(gameId, 'K_Y', y, 1, { scored: 1, affectedPlayer: 'K_Y' });
    kt(gameId, 'K_X', y, 1, { scored: 1, affectedPlayer: 'K_Y' }); // eliminates K_Y, K_X wins
    assert.throws(() => kt(gameId, 'K_X', x, 1, { scored: 0, affectedPlayer: null }), (err) => err.status === 400);
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
