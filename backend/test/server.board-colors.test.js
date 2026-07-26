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
  test('a fresh install answers a real board — 20 is a black bed with red rings', async () => {
    await withServer(async () => {
      const c = await getColors();
      assert.equal(c.sector20, 'red_black');
      assert.deepEqual(c.even, { single: '#1c1e1a', ring: '#c8102e' });
      assert.deepEqual(c.odd,  { single: '#cbbf96', ring: '#17752f' });
    });
  });

  test('the read needs no session — a household tablet has none', async () => {
    await withServer(async () => {
      const r = await fetch(`${base}/api/settings/board-colors`);   // no Cookie header
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(await r.json()).sort(), ['even','odd','schemes','sector20']);
    });
  });

  test('switching sector 20 to the other scheme swaps both halves', async () => {
    await withServer(async () => {
      const r = await putSettings({ board_sector20_scheme: 'green_white' });
      assert.equal(r.status, 200);
      const c = await getColors();
      assert.deepEqual(c.even, { single: '#cbbf96', ring: '#17752f' });
      assert.deepEqual(c.odd,  { single: '#1c1e1a', ring: '#c8102e' });
    });
  });

  test('a recoloured scheme stays a pair, on whichever side it lands', async () => {
    await withServer(async () => {
      await putSettings({ board_red_black_single: '#101820', board_red_black_ring: '#f2c14e' });
      assert.deepEqual((await getColors()).even, { single: '#101820', ring: '#f2c14e' });

      await putSettings({ board_sector20_scheme: 'green_white' });
      assert.deepEqual((await getColors()).odd, { single: '#101820', ring: '#f2c14e' },
        'the same pair, now on the alternate sectors — still together');
    });
  });

  test('an uppercase colour is normalised on the way in', async () => {
    await withServer(async () => {
      await putSettings({ board_red_black_ring: '#AABBCC' });
      assert.equal((await getColors()).schemes.red_black.ring, '#aabbcc');
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
    ['an empty string', ''],
  ];

  for (const [label, value] of hostile) {
    test(`${label} is rejected with 400, and nothing is stored`, async () => {
      await withServer(async () => {
        const r = await putSettings({ board_red_black_ring: value });
        assert.equal(r.status, 400, `${label} should be refused`);
        const body = await r.json();
        assert.match(body.error || '', /board_red_black_ring must be a #rrggbb colour/);
        // The rejection must be atomic: a refused request must not have written
        // the other fields in the same payload either.
        assert.equal((await getColors()).schemes.red_black.ring, '#c8102e');
      });
    });
  }

  test('an unknown scheme id is rejected rather than silently defaulted', async () => {
    await withServer(async () => {
      const r = await putSettings({ board_sector20_scheme: 'purple_gold' });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error || '', /board_sector20_scheme must be one of/);
      assert.equal((await getColors()).sector20, 'red_black');
    });
  });

  test('a rejected colour does not partially apply the rest of the payload', async () => {
    await withServer(async () => {
      const r = await putSettings({ board_sector20_scheme: 'green_white', board_red_black_ring: 'red' });
      assert.equal(r.status, 400);
      assert.equal((await getColors()).sector20, 'red_black',
        'the valid field in a rejected payload must not have been written');
    });
  });

  test('the server validates with the same functions the client does', async () => {
    // Two independent copies of "what is a valid colour"/"what is a valid
    // scheme" is how the two ends drift until one accepts something the other
    // renders wrong.
    const src = fs.readFileSync(SERVER_PATH, 'utf8');
    assert.match(src, /const \{ normaliseBoardColor, normaliseSchemeId, BOARD_SCHEME_IDS \} = require\('\.\.\/frontend\/scoring\.js'\)/);
    // The key list is DERIVED from the scheme registry, not hand-written — so a
    // third scheme can't be added with its keys silently missing from the
    // allowlist, which would make saving it look like it worked and do nothing.
    assert.match(src, /const BOARD_COLOR_KEYS = BOARD_SCHEME_IDS\.flatMap/);
    assert.match(src, /\.\.\.BOARD_COLOR_KEYS, BOARD_SCHEME_KEY/,
      'the keys must be in the PUT allowlist, or saving silently does nothing');
  });
});
