'use strict';
// The server end of Settings -> Board colours.
//
// board-colors.test.js covers the pure derivation. This covers the two things
// only a real server can show: that the public read route exists and answers a
// fully-resolved scheme without a session (the board is drawn on a shared
// household tablet long before anyone logs in as admin), and that the write path
// refuses anything that isn't an exact #rrggbb.
//
// The write path matters because the value's destination is an SVG
// `fill="..."` attribute. A stored `#c8102e" onload="alert(1)` would break out of
// that attribute on every device that renders the board — a stored XSS reachable
// from one admin PUT. There are three independent guards (server on write, db on
// read, the sink itself); this asserts the first, and board-colors.test.js
// asserts the other two.
//
// server.js isn't require()-able (it .listen()s at load and exports nothing), so
// this spawns it as a real child process, the same shape as
// server.batch-bounds.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../../frontend/scoring.js');
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 8157;
const base = `http://localhost:${PORT}`;

function waitForHealth(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`${base}/api/health`).then(r => (r.ok ? resolve() : retry())).catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error('server did not start in time')); return; }
      setTimeout(tryOnce, 100);
    };
    tryOnce();
  });
}

// PUT /api/settings goes through requireAdmin(), which needs a real session no
// matter what OCHE_REQUIRE_AUTH says — that flag governs ordinary game WRITES,
// not the admin surface. So each run creates the first admin on its own scratch
// database and logs in, and every write below carries that session cookie. That
// is also the honest shape of the threat being tested: the hostile value has to
// come from something already holding admin, and must still be refused.
let session = '';
async function withServer(fn) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-boardcolors-'));
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT), DARTS_DB: path.join(scratchDir, 'test.db'),
           OCHE_REQUIRE_AUTH: 'false' },
    stdio: 'ignore',
  });
  try {
    await waitForHealth(PORT);
    const creds = { username: 'boardadmin', password: 'boardadmin-pw' };
    await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    assert.equal(login.status, 200, 'admin login should succeed on a fresh scratch database');
    session = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(session, 'expected a session cookie');
    await fn();
  } finally {
    session = '';
    child.kill('SIGTERM');
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {}
  }
}

const getColors = () => fetch(`${base}/api/settings/board-colors`).then(r => {
  assert.equal(r.status, 200, `expected the public read to succeed, got HTTP ${r.status}`);
  return r.json();
});
const putSettings = body => fetch(`${base}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'Cookie': session },
  body: JSON.stringify(body),
});

describe('GET /api/settings/board-colors is public and always fully resolved', () => {
  test('a fresh install answers the classic board', async () => {
    await withServer(async () => {
      assert.deepEqual(await getColors(), S.BOARD_COLOR_DEFAULTS);
    });
  });

  test('the read needs no session — a household tablet has none', async () => {
    await withServer(async () => {
      const r = await fetch(`${base}/api/settings/board-colors`);   // no Cookie header
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(await r.json()).sort(), ['ringA','ringB','singleA','singleB']);
    });
  });

  test('setting sector 20 moves the derived pair with it', async () => {
    await withServer(async () => {
      // '' for the B fields is what the client sends for a colour it has NOT
      // overridden — the server must store that as "keep following 20", not as
      // a literal empty colour.
      const r = await putSettings({ board_single_a: '#3060a0', board_ring_a: '#8a2be2',
                                    board_single_b: '', board_ring_b: '' });
      assert.equal(r.status, 200);
      const c = await getColors();
      assert.equal(c.singleA, '#3060a0');
      assert.equal(c.ringA, '#8a2be2');
      assert.equal(c.singleB, S.deriveAltSingle('#3060a0'));
      assert.equal(c.ringB, S.deriveAltRing('#8a2be2'));
    });
  });

  test('an explicit override is kept, and only for the field overridden', async () => {
    await withServer(async () => {
      await putSettings({ board_single_a: '#3060a0', board_single_b: '#ffcc00', board_ring_b: '' });
      const c = await getColors();
      assert.equal(c.singleB, '#ffcc00');
      assert.equal(c.ringB, S.BOARD_COLOR_DEFAULTS.ringB, 'ringA is untouched, so its partner stays classic');
    });
  });

  test('clearing an override hands the field back to the derivation', async () => {
    await withServer(async () => {
      await putSettings({ board_single_a: '#3060a0', board_single_b: '#ffcc00' });
      assert.equal((await getColors()).singleB, '#ffcc00');
      await putSettings({ board_single_a: '#3060a0', board_single_b: '' });
      assert.equal((await getColors()).singleB, S.deriveAltSingle('#3060a0'));
    });
  });

  test('an uppercase colour is normalised on the way in', async () => {
    await withServer(async () => {
      await putSettings({ board_ring_a: '#AABBCC' });
      assert.equal((await getColors()).ringA, '#aabbcc');
    });
  });
});

describe('the write path refuses anything that is not an exact #rrggbb', () => {
  const hostile = [
    ['attribute break-out', '#c8102e" onload="alert(1)'],
    ['tag break-out', '#c8102e"/><script>alert(1)</script>'],
    ['a CSS colour name', 'red'],
    ['a url() reference', 'url(#x)'],
    ['shorthand hex', '#c81'],
    ['trailing space', '#c8102e '],
    ['not hex at all', '#gggggg'],
  ];

  for (const [label, value] of hostile) {
    test(`${label} is rejected with 400, and nothing is stored`, async () => {
      await withServer(async () => {
        const r = await putSettings({ board_ring_a: value });
        assert.equal(r.status, 400, `${label} should be refused`);
        const body = await r.json();
        assert.match(body.error || '', /board_ring_a must be a #rrggbb colour/);
        // The rejection must be atomic: a refused request must not have written
        // the other fields in the same payload either.
        assert.deepEqual(await getColors(), S.BOARD_COLOR_DEFAULTS);
      });
    });
  }

  test('a rejected colour does not partially apply the rest of the payload', async () => {
    await withServer(async () => {
      const r = await putSettings({ board_single_a: '#3060a0', board_ring_a: 'red' });
      assert.equal(r.status, 400);
      assert.equal((await getColors()).singleA, S.BOARD_COLOR_DEFAULTS.singleA,
        'the valid field in a rejected payload must not have been written');
    });
  });

  test('the server validates with the same function the client does', async () => {
    // Two independent copies of "what is a valid colour" is how the two ends
    // drift until one accepts something the other renders wrong.
    const src = fs.readFileSync(SERVER_PATH, 'utf8');
    assert.match(src, /const \{ normaliseBoardColor \} = require\('\.\.\/frontend\/scoring\.js'\)/);
    assert.match(src, /const BOARD_COLOR_KEYS = \['board_single_a','board_ring_a','board_single_b','board_ring_b'\]/);
    assert.match(src, /\.\.\.BOARD_COLOR_KEYS/,
      'the keys must be in the PUT allowlist, or saving silently does nothing');
  });
});
