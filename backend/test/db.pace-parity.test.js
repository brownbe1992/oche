'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-31.
//
// "Average Pace" (darts/minute, from the gap between consecutive thrown_at stamps) is
// computed in three places: the Player Profile bubble (getPlayerStatBubbles), the Home
// page's Pulse (getHomeExtra's _pace), and the profile's history chart
// (getMetricHistory's 'pace' case). REFERENCE.md §3 requires the bubble and the history
// to be identical for the same metric, and §22 names divergence between them as a bug
// signal.
//
// They had drifted: the bubble and the Pulse excluded game types via
// NOT_CONTINUOUS_STREAM ('chuckin','checkout_trainer','around_the_world') while the
// history case used the narrower NOT_HYPOTHETICAL_DARTS, which omits 'around_the_world'.
// So a guided Around the World drill's rapid-fire per-dart rhythm counted toward the
// chart but not the bubble sitting directly above it — measured at 41 darts/min against
// the bubble's 3 for the same player, same mode, same screen, with nothing indicating
// which was right. Both sites carried a comment asserting parity with the other.
//
// This asserts the three AGREE rather than checking a hand-picked number, which is what
// keeps them in step through future edits (the same "derive the expectation from the
// real engine" shape db.pressure-chamber-stats.test.js uses). A value test would have
// to be rewritten every time the fixture changes; a parity test would not.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let db, scratchDir;

// Per-dart timing is what pace reads; it's off by default, but these rows are written
// directly through the real addTurn()/recordTurn() path with explicit thrownAt stamps,
// which is exactly what the app records when the setting is on.
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
const T0 = Date.parse('2026-07-01T10:00:00Z');

function seed() {
  db.addPlayer('Pacer');

  // A real X01 leg thrown at a match-like pace: 20 seconds between darts => 3/min.
  const g = db.createGame({
    category: '501', legsPerSet: 1, setsPerGame: 1,
    players: [{ name: 'Pacer', out: 'double' }], practice: 1,
    gameType: 'x01', config: { startScore: 501 },
  });
  const gid = g.gameId != null ? g.gameId : g.id;
  db.recordTurn(gid, {
    player: 'Pacer', set: 1, leg: 1, scored: 60,
    darts: [
      { sector: 20, multiplier: 1, thrownAt: stamp(T0) },
      { sector: 20, multiplier: 1, thrownAt: stamp(T0 + 20000) },
      { sector: 20, multiplier: 1, thrownAt: stamp(T0 + 40000) },
    ],
  });

  // A guided Around the World run at 1 second between darts. This is the drill whose
  // rhythm must NOT count: it is the difference between the two constants, and enough
  // of it to swamp the X01 leg above if it leaks in.
  const g2 = db.createGame({
    category: 'Around the World', legsPerSet: 1, setsPerGame: 1,
    players: [{ name: 'Pacer', out: 'double' }], practice: 1,
    gameType: 'around_the_world', config: {},
  });
  const gid2 = g2.gameId != null ? g2.gameId : g2.id;
  for (let i = 0; i < 40; i++) {
    const b = T0 + 3600000 + i * 5000;
    db.addTurn(gid2, {
      player: 'Pacer', set: 1, leg: 1, scored: 0,
      darts: [
        { sector: 20, multiplier: 1, thrownAt: stamp(b) },
        { sector: 20, multiplier: 1, thrownAt: stamp(b + 1000) },
        { sector: 20, multiplier: 1, thrownAt: stamp(b + 2000) },
      ],
    });
  }
}

before(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-pace-'));
  process.env.DARTS_DB = path.join(scratchDir, 'test.db');
  db = require('../db.js');
  seed();
});

after(() => { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {} });

describe('BUG-31 — Average Pace agrees across the bubble, the Pulse and the history chart', () => {
  test('the history chart matches the stat bubble', () => {
    const bubble = db.getPlayerStatBubbles('Pacer', 'practice').pace;
    const history = db.getMetricHistory('Pacer', 'pace', 'all', { mode: 'practice' });

    assert.ok(bubble > 0, `expected a real bubble pace, got ${bubble}`);
    assert.equal(history.length, 1, 'fixture should land in exactly one bucket');
    assert.ok(
      Math.abs(history[0].value - bubble) < 0.01,
      `history chart (${history[0].value}) must match the bubble (${bubble}) — ` +
      'REFERENCE.md §3 requires these to be identical for the same metric');
  });

  test('the Home Pulse pace matches too', () => {
    const bubble = db.getPlayerStatBubbles('Pacer', 'practice').pace;
    const pulse = db.getHomeExtra().pace.practice;
    assert.ok(Math.abs(pulse - bubble) < 0.01, `Pulse (${pulse}) must match the bubble (${bubble})`);
  });

  test('guided Around the World darts are excluded, not merely diluted', () => {
    // The load-bearing assertion. The fixture's only match-paced throwing is 20s
    // between darts (3/min); the drill is 1s between darts. If the drill leaked in,
    // this reads an order of magnitude high — pre-fix it measured ~41. Asserting the
    // real value (not just bubble/history equality) is what stops a future change
    // that breaks BOTH sites the same way from passing the parity tests above.
    const history = db.getMetricHistory('Pacer', 'pace', 'all', { mode: 'practice' });
    assert.ok(
      Math.abs(history[0].value - 3) < 0.01,
      `expected ~3 darts/min from the 20s-apart X01 darts alone, got ${history[0].value} ` +
      '— a much higher value means the rapid-fire drill is being counted');
  });
});
