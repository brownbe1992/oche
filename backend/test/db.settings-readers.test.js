'use strict';
// The seven exported functions no test file named, found by a coverage sweep during
// the 2026-07 maintenance pass. Six are here; the seventh (fireHaWebhook) makes a real
// outbound request and is covered by its own egress-guard tests instead.
//
// They are all small, and that is precisely why they went uncovered — but each one is
// a PUBLIC, no-auth read whose value drives what a device renders, and five of them
// share a shape worth pinning: read one settings row, and fall back to a documented
// default when it is absent OR holds something unexpected. The fallback is the part
// that matters. An unrecognised stored value must resolve to the default rather than
// reaching a renderer that has no case for it — these are read by `/display` and by
// every scoring device, none of which validate what the server hands them.
//
// Settings can hold an unexpected value for ordinary reasons, not just an attack: a
// hand-edited database, a restored backup from an older version whose allowed list has
// since changed, or a key written before a value was renamed.
const { test, describe, after, beforeEach } = require('node:test');
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

// Writes straight to the table rather than through updateSettings(), deliberately:
// the route's allowlist is what stops a bad value being STORED, and these tests are
// about what happens when one already is.
const put = (k, v) => db._db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
const clear = (k) => db._db.prepare('DELETE FROM settings WHERE key = ?').run(k);

describe('settings readers fall back to their documented default', () => {
  const cases = [
    { name: 'getHeatmapStyle', key: 'heatmap_style', read: () => db.getHeatmapStyle().style,
      dflt: 'classic', valid: ['classic', 'scorched'] },
    { name: 'getHeatmapNumberStyle', key: 'heatmap_number_style', read: () => db.getHeatmapNumberStyle().style,
      dflt: 'original', valid: ['original', 'molten_seam', 'chalk_ledger'] },
  ];

  for (const c of cases) {
    test(`${c.name} — absent, empty and unrecognised all give "${c.dflt}"`, () => {
      clear(c.key);
      assert.equal(c.read(), c.dflt, 'absent');
      for (const bad of ['', 'not_a_real_style', 'CLASSIC', '../../etc/passwd', '<script>']) {
        put(c.key, bad);
        assert.equal(c.read(), c.dflt, `stored ${JSON.stringify(bad)} must resolve to the default`);
      }
    });

    test(`${c.name} — every value it claims to accept round-trips`, () => {
      // The mirror of the test above, and the reason it is separate: a reader that
      // returned the default unconditionally would pass the fallback test perfectly.
      for (const good of c.valid) {
        put(c.key, good);
        assert.equal(c.read(), good);
      }
    });
  }

  test('getBoardColors — an unrecognised scheme resolves to the default board', () => {
    clear('board_sector20_scheme');
    const dflt = db.getBoardColors();
    assert.ok(dflt.sector20, 'a scheme id is always returned');
    assert.match(dflt.even.single, /^#[0-9a-f]{6}$/i, 'colours are hex literals, never stored input');
    for (const bad of ['', 'purple_haze', 'red_black; DROP TABLE players']) {
      put('board_sector20_scheme', bad);
      assert.deepEqual(db.getBoardColors(), dflt, `stored ${JSON.stringify(bad)} must give the default board`);
    }
    // And the non-default scheme is genuinely reachable — otherwise the assertions
    // above would hold for a function that ignored the setting entirely.
    put('board_sector20_scheme', 'green_white');
    assert.notDeepEqual(db.getBoardColors(), dflt);
  });
});

describe('getHaWebhookStatus reports configuration without leaking it', () => {
  beforeEach(() => {
    for (const k of ['ha_url', 'ha_webhook_oneeighty', 'ha_webhook_bigfish']) clear(k);
  });

  test('no HA URL means disabled, and every event false', () => {
    const s = db.getHaWebhookStatus();
    assert.equal(s.enabled, false);
    assert.equal(Object.values(s.events).every(v => v === false), true);
  });

  test('an event is only enabled when BOTH the URL and its own webhook id are set', () => {
    put('ha_webhook_oneeighty', 'abc123');
    assert.equal(db.getHaWebhookStatus().events.oneeighty, false, 'a webhook id alone is not enough');
    put('ha_url', 'http://ha.example:8123');
    const s = db.getHaWebhookStatus();
    assert.equal(s.enabled, true);
    assert.equal(s.events.oneeighty, true);
    assert.equal(s.events.bigfish, false, 'an unconfigured event stays off');
  });

  test('the webhook IDS themselves are never in the response', () => {
    // This is the reason the endpoint exists in this shape at all: it is public and
    // no-auth (every scoring device needs it), while the ids are admin-only secrets
    // reachable through getSettings(). A boolean is the whole contract.
    put('ha_url', 'http://ha.example:8123');
    put('ha_webhook_oneeighty', 'super-secret-webhook-id');
    const json = JSON.stringify(db.getHaWebhookStatus());
    assert.ok(!json.includes('super-secret-webhook-id'), 'the webhook id must not be exposed');
    assert.ok(!json.includes('ha.example'), 'nor the HA host');
  });
});

describe('the two per-player readers', () => {
  test('getDoublesPracticeHitSectors — unknown player gives the empty shape, not a throw', () => {
    const r = db.getDoublesPracticeHitSectors('NoSuchPlayer_' + Date.now());
    assert.deepEqual(r, { hit: [], count: 0, total: 21 });
  });

  test('getDoublesPracticeHitSectors — DISTINCT sectors, and only ones the round was aiming at', () => {
    // Two properties, and the second is the one worth having. A "hit" is not merely
    // "a double landed": DOUBLES_HIT_CASE requires the sector to be in that game's own
    // config.doubles. Hitting D5 while the round is set to practise D20 is a stray
    // dart, not progress — it must not count toward Ring Master's 21-sector total.
    // (Written the other way round first, expecting D5 to count; the code was right
    // and the test was wrong, which is how this ended up asserting the real rule.)
    const n = 'DPHS_' + Date.now();
    db.addPlayer(n);
    const g = db.createGame({ category: 'Doubles Practice', legsPerSet: 1, setsPerGame: 1,
      practice: 1, gameType: 'doubles_practice', config: { doubles: [20, 10] }, players: [{ name: n }] });
    // D20 twice (one distinct sector), D10 once, and D5 — which is not a target.
    for (const s of [20, 20, 10, 5]) {
      db.addTurn(g.gameId, { player: n, set: 1, leg: 1, scored: s * 2, bust: false, checkout: false,
        darts: [{ dartNo: 1, sector: s, multiplier: 2 }] });
    }
    const r = db.getDoublesPracticeHitSectors(n);
    assert.deepEqual(r.hit.slice().sort((a, b) => a - b), [10, 20],
      'D20 counts once despite two darts; D5 does not count at all');
    assert.equal(r.count, 2);
    assert.equal(r.total, 21, 'D1-D20 plus the bull');
  });

  test('getAroundTheClockWinLeaderboard — returns an array, and an empty one is not an error', () => {
    const board = db.getAroundTheClockWinLeaderboard();
    assert.ok(Array.isArray(board));
  });
});
