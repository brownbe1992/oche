'use strict';
// Committed tests for backend/db.js's Marathon Mode functions
// (docs/archive/marathon-mode-roadmap.md, REFERENCE.md's Marathon Mode section) —
// session/leg creation and linkage guards, per-leg dart-count/checkout/bust
// derivation, and the stats/PB/leaderboard functions built on top of
// computeFatigueSplit()/classifyMarathonTrend() (already unit-tested in
// scoring.test.js; these tests focus on the db.js wiring around them).
const { test, describe, after } = require('node:test');
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

// Wins a leg with an exact total dart count across as many 3-dart-max turns
// as it takes (a real turn is 1-3 darts, so a big total needs multiple
// filler turns before the final checkout turn) — dart count is the only
// thing these tests need to control precisely; the actual scores are
// placeholders (enforceConsistency is never set here, matching every other
// test file's own fixture convention).
function winLeg(gameId, player, checkoutPoints, totalDarts) {
  let remaining = totalDarts;
  while (remaining > 3) {
    const n = Math.min(3, remaining - 1); // leave at least 1 dart for the final checkout turn
    db.addTurn(gameId, { player, set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null,
      darts: Array.from({ length: n }, (_, i) => ({ dartNo: i + 1, sector: 20, multiplier: 1 })) });
    remaining -= n;
  }
  const darts = Array.from({ length: remaining }, (_, i) => ({ dartNo: i + 1, sector: 20, multiplier: i === remaining - 1 ? 2 : 1 }));
  db.addTurn(gameId, { player, set: 1, leg: 1, scored: checkoutPoints, bust: false, checkout: true, checkoutPoints, darts });
  db.completeGame(gameId, player);
}

describe('startMarathonSession / startNextMarathonLeg / endMarathonSession', () => {
  test('startMarathonSession creates a real, ordinary solo practice 501 X01 game for leg 1', () => {
    const name = 'Marathon_Start';
    db.addPlayer(name);
    const r = db.startMarathonSession(name, 45);
    assert.equal(r.legOrder, 1);
    assert.equal(r.durationMinutes, 45);
    const row = db._db.prepare('SELECT category, game_type, practice, player_count FROM games WHERE id = ?').get(r.gameId);
    assert.equal(row.category, '501');
    assert.equal(row.game_type, 'x01');
    assert.equal(row.practice, 1);
    assert.equal(row.player_count, 1);
  });

  test('durationMinutes defaults to 45 and is validated to a sane range', () => {
    const name = 'Marathon_Duration';
    db.addPlayer(name);
    assert.equal(db.startMarathonSession(name, null).durationMinutes, 45);
    assert.throws(() => db.startMarathonSession(name, 0), /durationMinutes/);
    assert.throws(() => db.startMarathonSession(name, 1000), /durationMinutes/);
  });

  test('an unknown player is rejected', () => {
    assert.throws(() => db.startMarathonSession('NoSuchMarathonPlayer', 45), /Player not found/);
  });

  test('startNextMarathonLeg increments leg_order and creates another real game', () => {
    const name = 'Marathon_NextLeg';
    db.addPlayer(name);
    const s = db.startMarathonSession(name, 45);
    const l2 = db.startNextMarathonLeg(s.sessionId, name);
    assert.equal(l2.legOrder, 2);
    assert.notEqual(l2.gameId, s.gameId);
    const l3 = db.startNextMarathonLeg(s.sessionId, name);
    assert.equal(l3.legOrder, 3);
  });

  test('startNextMarathonLeg rejects once the session has ended', () => {
    const name = 'Marathon_RejectEnded';
    db.addPlayer(name);
    const s = db.startMarathonSession(name, 45);
    db.endMarathonSession(s.sessionId);
    assert.throws(() => db.startNextMarathonLeg(s.sessionId, name), /already ended/);
  });

  test('startNextMarathonLeg rejects a player who does not own this session', () => {
    const a = 'Marathon_Owner', b = 'Marathon_Intruder';
    db.addPlayer(a); db.addPlayer(b);
    const s = db.startMarathonSession(a, 45);
    assert.throws(() => db.startNextMarathonLeg(s.sessionId, b), /does not match/);
  });

  test('endMarathonSession is idempotent -- ending twice does not error or move the timestamp', () => {
    const name = 'Marathon_Idempotent';
    db.addPlayer(name);
    const s = db.startMarathonSession(name, 45);
    const first = db.endMarathonSession(s.sessionId);
    const second = db.endMarathonSession(s.sessionId);
    assert.equal(first.endedAt, second.endedAt);
  });

  test('a nonexistent session id throws 404', () => {
    assert.throws(() => db.getMarathonSessionDetail(999999), /not found/);
  });
});

describe('getMarathonSessionDetail', () => {
  test('per-leg dartCount/checkoutPoints/busts are derived correctly, and an in-progress leg is excluded from the analysis series', () => {
    const name = 'Marathon_Detail';
    db.addPlayer(name);
    const s = db.startMarathonSession(name, 45);
    winLeg(s.gameId, name, 60, 6);   // leg 1: 6 total darts
    const l2 = db.startNextMarathonLeg(s.sessionId, name);
    winLeg(l2.gameId, name, 40, 4);  // leg 2: 4 total darts
    const l3 = db.startNextMarathonLeg(s.sessionId, name);
    // leg 3 left in progress -- one turn, no checkout, no completed_at yet.
    db.addTurn(l3.gameId, { player: name, set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 20, multiplier: 1 }, { dartNo: 3, sector: 20, multiplier: 1 }] });

    const d = db.getMarathonSessionDetail(s.sessionId);
    assert.equal(d.legs.length, 3);
    assert.equal(d.legsCompleted, 2, 'leg 3 is still in progress -- not counted as completed');
    assert.equal(d.legs[0].dartCount, 6);
    assert.equal(d.legs[0].checkoutPoints, 60);
    assert.equal(d.legs[0].busts, 0);
    assert.equal(d.legs[1].dartCount, 4);
    assert.equal(d.legs[2].completedAt, null);
    // fatigueSplit/trend are computed only from the 2 COMPLETED legs' dart
    // counts [6, 4] -- leg 3's in-progress 3 darts-so-far must not leak in.
    assert.equal(d.fatigueSplit, 0, 'leg 2 (4 darts) was FASTER than leg 1 (6 darts) -- clamped to zero, not negative');
  });

  test('a bust is counted toward that leg\'s busts field', () => {
    const name = 'Marathon_Bust';
    db.addPlayer(name);
    const s = db.startMarathonSession(name, 45);
    db.addTurn(s.gameId, { player: name, set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 3 }] });
    const d = db.getMarathonSessionDetail(s.sessionId);
    assert.equal(d.legs[0].busts, 1);
  });
});

describe('getMarathonStatBubbles / getMarathonPersonalBests / getMarathonLeaderboard', () => {
  test('a player with no Marathon history gets a zeroed/null shape, not a crash', () => {
    const name = 'Marathon_None';
    db.addPlayer(name);
    const bubbles = db.getMarathonStatBubbles(name, 'practice');
    assert.equal(bubbles.sessionsCompleted, 0);
    assert.equal(bubbles.avgFatigueSplit, null);
    const pb = db.getMarathonPersonalBests(name, 'practice');
    assert.equal(pb.lowestFatigueSplit, null);
    assert.equal(pb.mostLegsInASession, null);
  });

  test("mode='h2h' always reads as zero sessions -- Marathon Mode is inherently solo", () => {
    const name = 'Marathon_H2H';
    db.addPlayer(name);
    const s = db.startMarathonSession(name, 45);
    winLeg(s.gameId, name, 60, 3);
    db.endMarathonSession(s.sessionId);
    assert.equal(db.getMarathonStatBubbles(name, 'h2h').sessionsCompleted, 0);
    assert.equal(db.getMarathonPersonalBests(name, 'h2h').lowestFatigueSplit, null);
  });

  test('an in-progress (not-yet-ended) session does not count toward sessionsCompleted', () => {
    const name = 'Marathon_InProgress';
    db.addPlayer(name);
    db.startMarathonSession(name, 45); // never ended
    assert.equal(db.getMarathonStatBubbles(name, 'practice').sessionsCompleted, 0);
  });

  test('Personal Bests track the lowest fatigue split and most legs across every ended session', () => {
    const name = 'Marathon_PB';
    db.addPlayer(name);
    const s1 = db.startMarathonSession(name, 45);
    winLeg(s1.gameId, name, 60, 6);       // 6 darts
    const s1l2 = db.startNextMarathonLeg(s1.sessionId, name);
    winLeg(s1l2.gameId, name, 40, 8);     // 8 darts -- split = 2 (Iron)
    db.endMarathonSession(s1.sessionId);

    const s2 = db.startMarathonSession(name, 45);
    winLeg(s2.gameId, name, 60, 6);       // 6 darts
    const s2l2 = db.startNextMarathonLeg(s2.sessionId, name);
    winLeg(s2l2.gameId, name, 40, 11);    // 11 darts -- split = 5 (Tested), worse than session 1
    db.endMarathonSession(s2.sessionId);

    const pb = db.getMarathonPersonalBests(name, 'practice');
    assert.equal(pb.lowestFatigueSplit, 2, 'session 1\'s split (2) is lower/better than session 2\'s (5)');
    assert.equal(pb.mostLegsInASession, 2);

    const board = db.getMarathonLeaderboard();
    const row = board.find(r => r.name === name);
    assert.equal(row.lowestFatigueSplit, 2);
  });
});

// computeFatigueSplit() returns a sentinel 0 (with the best 'Iron' tier) for a
// 0-1-leg session — "no second half to compare", not "measured perfectly flat".
// The consumers must not treat that sentinel as a score: without the
// legsCompleted >= 2 floor, ending a session after one leg recorded the
// mathematically unbeatable minimum, pinning lowestFatigueSplit (and the
// ascending-sorted fatigue leaderboard) at 0 forever and dragging
// avgFatigueSplit toward a flawless 0.
describe('1-leg sessions never score a fatigue split', () => {
  test('PB/avg ignore the sentinel; a real 2-leg session still scores', () => {
    const name = 'Marathon_Sentinel';
    db.addPlayer(name);

    // Session 1: exactly one completed leg, then ended.
    const s1 = db.startMarathonSession(name, 45);
    winLeg(s1.gameId, name, 40, 15);
    db.endMarathonSession(s1.sessionId);

    let pbs = db.getMarathonPersonalBests(name, 'practice');
    assert.equal(pbs.lowestFatigueSplit, null, 'a 1-leg session records no fatigue split');
    assert.equal(pbs.mostLegsInASession, 1, 'but still counts for most-legs');
    let bubbles = db.getMarathonStatBubbles(name, 'practice');
    assert.equal(bubbles.avgFatigueSplit, null, 'no measurable session yet');

    // Session 2: two completed legs, second slower by 9 darts -> split 9.
    const s2 = db.startMarathonSession(name, 45);
    winLeg(s2.gameId, name, 40, 15);
    const leg2 = db.startNextMarathonLeg(s2.sessionId, name);
    winLeg(leg2.gameId, name, 40, 24);
    db.endMarathonSession(s2.sessionId);

    pbs = db.getMarathonPersonalBests(name, 'practice');
    assert.equal(pbs.lowestFatigueSplit, 9, "the real session's split, not the sentinel 0");
    bubbles = db.getMarathonStatBubbles(name, 'practice');
    assert.equal(bubbles.avgFatigueSplit, 9, 'averaged over measurable sessions only');
  });
});
