'use strict';
// The server end of Settings -> Board colours.
//
// board-colors.test.js covers the pure model. This covers the two things only a
// real server can show: that the public read route exists and answers a fully
// resolved scheme WITHOUT a session (the board is drawn on a shared household
// tablet long before anyone logs in as admin), and that the write path stores the
// choice and refuses an unknown one.
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
  test('a fresh install answers an unrotated board — 20 on black with red rings', async () => {
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
      assert.deepEqual(Object.keys(await r.json()).sort(), ['even','odd','sector20']);
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

  test('switching back restores the original board', async () => {
    await withServer(async () => {
      const before = await getColors();
      await putSettings({ board_sector20_scheme: 'green_white' });
      await putSettings({ board_sector20_scheme: 'red_black' });
      assert.deepEqual(await getColors(), before);
    });
  });
});

describe('the write path takes a known scheme id and nothing else', () => {
  test('an unknown scheme id is rejected rather than silently defaulted', async () => {
    await withServer(async () => {
      const r = await putSettings({ board_sector20_scheme: 'purple_gold' });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error || '', /board_sector20_scheme must be one of/);
      assert.equal((await getColors()).sector20, 'red_black');
    });
  });

  test('a rejected id does not partially apply the rest of the payload', async () => {
    await withServer(async () => {
      const r = await putSettings({ card_tagline: 'changed', board_sector20_scheme: 'nope' });
      assert.equal(r.status, 400);
      const tagline = await fetch(`${base}/api/settings/card-tagline`).then(x => x.json());
      assert.notEqual(tagline.tagline, 'changed',
        'the valid field in a rejected payload must not have been written');
    });
  });

  test('colours are not settable at all', async () => {
    await withServer(async () => {
      // The keys simply are not in the PUT allowlist any more. The request
      // succeeds (unknown keys are filtered, as for every other unrecognised
      // field) and the board is unchanged — which is the property that matters:
      // there is no path from stored data to an SVG fill attribute.
      const r = await putSettings({
        board_red_black_single: '#ff0000',
        board_red_black_ring: '#c8102e" onload="alert(1)',
        board_single_a: '#123456',
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await getColors(), S.resolveBoardColors({}));
    });
  });

  test('the server validates with the same function the client does', async () => {
    // Two independent copies of "what is a valid scheme" is how the two ends
    // drift until one accepts something the other renders wrong.
    const src = fs.readFileSync(SERVER_PATH, 'utf8');
    assert.match(src, /const \{ normaliseSchemeId, BOARD_SCHEME_IDS \} = require\('\.\.\/frontend\/scoring\.js'\)/);
    assert.match(src, /const BOARD_SCHEME_KEY = 'board_sector20_scheme'/);
    assert.match(src, /BOARD_SCHEME_KEY, \.\.\.boolKeys\]/,
      'the key must be in the PUT allowlist, or saving silently does nothing');
    // And no colour key sneaked back in.
    assert.doesNotMatch(src, /board_red_black_single|board_single_a|normaliseBoardColor/,
      'the board colours are constants; no colour key belongs in the settings surface');
  });
});
