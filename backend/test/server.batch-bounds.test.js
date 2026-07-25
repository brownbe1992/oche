'use strict';
// Committed regression test for docs/security-audit-roadmap.md SEC-27.
//
// GET /api/players/personal-bests-batch ran one full personal-bests computation per
// entry in the caller's `names` list, with no cap and no dedupe. Object.fromEntries
// collapsed duplicate keys in the RESULT, which hid it — the response stayed tiny while
// the cost was paid once per repeat. On a public, unauthenticated read served by a
// single-threaded process that is a pure amplification primitive: one 15KB anonymous
// GET repeating a real player's name ~3,800 times was measured freezing the entire
// server for 59.4 seconds (a concurrent /api/health stalled 58.9s), and the 300 req/min
// budget made that sustainable indefinitely.
//
// The fix is two independent bounds, and this asserts both, because either alone leaves
// a hole: the route caps the list length (but 128 DISTINCT real players would still be
// expensive), and getPersonalBestsBatch() dedupes before doing the work (which is what
// actually defeats the attack, since it depends on repetition). The cap is deliberately
// >= db.js's TOURNAMENT_MAX_PLAYERS so a large bracket's average-seeding — the only real
// caller — is never silently truncated.
//
// server.js isn't require()-able (it .listen()s at load and exports nothing), so this
// spawns it as a real child process and hits it over HTTP, the same shape as
// server.live-state-keys.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 8153;

function waitForHealth(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://localhost:${port}/api/health`).then(r => (r.ok ? resolve() : retry())).catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error('server did not start in time')); return; }
      setTimeout(tryOnce, 100);
    };
    tryOnce();
  });
}

// An EMPTY database makes this whole test meaningless: one personal-bests lookup on it
// costs almost nothing, so even the un-deduped 128 the route cap allows finish instantly
// and the timing assertions below pass no matter what. (Verified: deleting the dedupe
// left an empty-DB version of this test green.) Seeding real history is what gives a
// single lookup enough cost — ~17-50ms — for "1 lookup" and "128 lookups" to be
// distinguishable, which is the difference this test exists to detect.
function seedRealHistory(dbPath) {
  const seeder = path.join(__dirname, '..', 'seed-dev-db.js');
  const r = require('child_process').spawnSync(
    process.execPath, [seeder, '--db', dbPath, '--games', '60', '--seed', '4', '--force'],
    { stdio: 'ignore' });
  assert.equal(r.status, 0, 'seed-dev-db.js should populate the scratch database');
}

async function withServer(fn) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-batchbounds-'));
  const dbPath = path.join(scratchDir, 'test.db');
  seedRealHistory(dbPath);
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT), DARTS_DB: dbPath, OCHE_REQUIRE_AUTH: 'false' },
    stdio: 'ignore',
  });
  try {
    await waitForHealth(PORT);
    await fn();
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {}
  }
}

const base = `http://localhost:${PORT}`;
const addPlayer = name => fetch(`${base}/api/players`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
});
// Raw commas, not encodeURIComponent(names.join(',')) — percent-encoding every
// separator triples the query string, and a 3,800-name list then exceeds Node's default
// 16KB max header size and is rejected with an empty-bodied 431 before it reaches the
// route at all. That would make this test pass for the wrong reason (and did, on the
// first run). The names used here are plain identifiers, which is also what the real
// attack sends.
const batch = names => fetch(`${base}/api/players/personal-bests-batch?names=${names.join(',')}`)
  .then(async r => {
    assert.equal(r.status, 200, `expected the request to actually reach the route, got HTTP ${r.status}`);
    return r.json();
  });

describe('SEC-27 — personal-bests-batch bounds the work one request can demand', () => {
  test('a huge repeated list is answered promptly and does not block the server', async () => {
    await withServer(async () => {
      // 'Ada' is the seeded roster's strongest player, so this is a real name with
      // real history behind it — the lookup an attacker would pick.
      // The attack shape: one real name, repeated far past any legitimate use.
      const names = Array(3800).fill('Ada');

      // Time a concurrent health check across the batch request. This is the assertion
      // that actually encodes the bug: the pre-fix failure wasn't a slow response, it
      // was the whole (single-threaded) process being unavailable while it ran.
      const started = Date.now();
      const healthProbe = (async () => {
        await new Promise(r => setTimeout(r, 50));
        const t = Date.now();
        await fetch(`${base}/api/health`);
        return Date.now() - t;
      })();
      const [body, healthMs] = await Promise.all([batch(names), healthProbe]);
      const totalMs = Date.now() - started;

      assert.ok(body && typeof body === 'object', 'should still return a result object');
      assert.deepEqual(Object.keys(body), ['Ada'], 'the one distinct name should be answered');
      // Timing assertions are deliberately loose. They document the symptom (the pre-fix
      // request took 59.4s and stalled everything else for 58.9s) but they are NOT what
      // proves the fix — on a small database even the un-deduped work is fast, so a tight
      // threshold here would be measuring the fixture, not the behaviour. The
      // deterministic proof is the dedupe-before-cap test below.
      assert.ok(totalMs < 10000, `batch request took ${totalMs}ms`);
      assert.ok(healthMs < 5000, `a concurrent health check was stalled ${healthMs}ms — the event loop is being blocked`);
    });
  });

  test('the names list is capped, and the cap clears a full tournament bracket', async () => {
    await withServer(async () => {
      // 130 distinct real players: above the 128 cap, and above TOURNAMENT_MAX_PLAYERS.
      const names = [];
      for (let i = 0; i < 130; i++) { const n = `P${i}`; names.push(n); await addPlayer(n); }

      const body = await batch(names);
      const returned = Object.keys(body).length;
      assert.ok(returned <= 128, `expected at most the 128 cap, got ${returned}`);
      assert.ok(returned >= 128, `cap must clear TOURNAMENT_MAX_PLAYERS (128) so bracket seeding isn't truncated, got ${returned}`);
      // Truncation takes the FIRST N, so a normal-sized caller is unaffected.
      assert.ok(body.P0 !== undefined, 'the first names must survive the cap');
    });
  });

  // The load-bearing test, and deterministic — no timing involved.
  //
  // Deduping must happen BEFORE the cap. If it happens after (or not at all), the cap
  // counts repeats instead of real lookups, so the 3,000 leading duplicates consume the
  // whole budget and the genuine trailing name is silently dropped. Both symptoms — the
  // wasted work and the missing answer — are visible in this one assertion, and neither
  // depends on how fast the machine is or how much history the fixture has.
  test('duplicates collapse before the cap is applied, so real names are never crowded out', async () => {
    await withServer(async () => {
      const names = [...Array(3000).fill('Ada'), 'Bex'];
      const body = await batch(names);
      assert.deepEqual(Object.keys(body).sort(), ['Ada', 'Bex'],
        'a real name after a long run of duplicates must still be answered');
    });
  });

  test('a normal-sized request is unchanged', async () => {
    await withServer(async () => {
      const body = await batch(['Ada', 'Bex', 'Cal']);   // all three are seeded players
      assert.deepEqual(Object.keys(body).sort(), ['Ada', 'Bex', 'Cal']);
    });
  });
});
