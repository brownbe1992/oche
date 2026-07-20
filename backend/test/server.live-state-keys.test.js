'use strict';
// Committed regression test for backend/server.js's live-scoreboard allowlist
// (docs/bug-roadmap.md BUG-28). sanitizeLiveState() keeps only the top-level keys
// named in ALLOWED_LIVE_KEYS before broadcasting the payload to the /display second
// screen. Shanghai, Halve-It, and The Pressure Chamber each ship per-game-type fields
// (shanghaiRound/shanghaiMaxRounds, halveItRound/halveItTargets,
// pressureChamberRound/pressureChamberDeadline/pressureChamberCards) that the client
// (frontend/index.html's buildLiveState) sends but the allowlist originally omitted, so
// the server stripped them and the second-screen scorecards rendered broken. This test
// POSTs a payload carrying all of them (plus an unknown key as a control) to /api/live,
// GETs it back, and asserts the game-type fields survive while the unknown key is dropped.
//
// server.js isn't require()-able (it .listen()s at load and exports nothing), so this
// spawns it as a real child process against a scratch DB and hits it over HTTP — the
// same shape as server.input-hardening.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-livekeys-'));
  const dbPath = path.join(scratchDir, 'test.db');
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

test('sanitizeLiveState preserves the Shanghai/Halve-It/Pressure Chamber /display fields (BUG-28)', async () => {
  // Fixed port in the same 84xx block the other server-spawn tests reserve, so parallel
  // `node --test` runs never collide (next free slot after 8496 in db.turn-consistency-guard).
  const port = 8497;
  await withServer(port, async () => {
    const payload = {
      active: true,
      gameType: 'pressure_chamber',
      players: [{ name: 'Ann', totalCp: 40 }],
      currentIndex: 0,
      // Shanghai
      shanghaiRound: 4,
      shanghaiMaxRounds: 5,
      // Halve-It
      halveItRound: 3,
      halveItTargets: [{ sector: 20 }, { sector: 7, ring: 'double' }, { sector: 25 }],
      // The Pressure Chamber
      pressureChamberRound: 6,
      pressureChamberDeadline: 1234567890,
      pressureChamberCards: [
        { target: { type: 'sector', sector: 20, ring: 'treble', label: 'Treble 20' },
          modifier: { key: 'sudden_death', label: 'Sudden Death', icon: '💀', flavor: 'x' } },
      ],
      // Killer — the lives threshold the /display "lives target N" header reads
      // (a repeat of BUG-28: sent by liveSnapshot(), stripped by the allowlist,
      // display silently fell back to the default 3).
      killerLives: 5,
      // The 121 Checkout Ladder — target/visit counter for the /display header
      // (same BUG-28 repeat: stripped keys silently fell back to 121 / visit 1).
      checkoutLadderTarget: 137,
      checkoutLadderVisits: 2,
      // Dead Man Walking — round budget/progress for the /display card.
      dmwBudget: 9,
      dmwDartsUsed: 4,
      dmwWalkedOut: 3,
      // Control: an unknown key that must be stripped.
      totallyBogusKey: 'should not survive',
    };

    const postRes = await fetch(`http://localhost:${port}/api/live`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(postRes.status, 200);

    const state = await (await fetch(`http://localhost:${port}/api/live`)).json();

    // Every per-game-type field the /display renderers read must round-trip intact.
    assert.equal(state.shanghaiRound, 4);
    assert.equal(state.shanghaiMaxRounds, 5);
    assert.equal(state.halveItRound, 3);
    assert.deepEqual(state.halveItTargets, payload.halveItTargets);
    assert.equal(state.pressureChamberRound, 6);
    assert.equal(state.pressureChamberDeadline, 1234567890);
    assert.deepEqual(state.pressureChamberCards, payload.pressureChamberCards);
    assert.equal(state.killerLives, 5);
    assert.equal(state.checkoutLadderTarget, 137);
    assert.equal(state.checkoutLadderVisits, 2);
    assert.equal(state.dmwBudget, 9);
    assert.equal(state.dmwDartsUsed, 4);
    assert.equal(state.dmwWalkedOut, 3);

    // The allowlist still drops unknown keys.
    assert.equal(state.totallyBogusKey, undefined);
  });
});
