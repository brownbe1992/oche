'use strict';
// Committed tests for backend/db.js's X01 stat formulas (REFERENCE.md §3), against
// a scratch SQLite database — the same technique used manually throughout this
// project's sessions, now permanent per CLAUDE.md's testing convention. Not
// exhaustive (matches docs/testing-and-observability-roadmap.md's stated goal: a
// safety net around the highest-risk shared logic, not 100% coverage) — focused on
// the formulas/conventions this session's audits actually found bugs in, or that
// REFERENCE.md calls out as easy to get wrong (the denominator-conventions table).
//
// Each test builds its own small, self-contained fixture with a uniquely-named
// player, rather than one large shared fixture — every expected value below is
// meant to be checkable by inspection, not derived from a big interacting dataset.
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

// Inserts a turn with an explicit dart count, independent of `scored` — addTurn()
// only validates ranges, not that darts physically reconcile to scored, which is
// exactly what lets these fixtures pick clean, hand-verifiable numbers instead of
// simulating a full realistic leg.
function turn(gameId, player, set, leg, { scored, darts = 3, bust = false, checkout = false, checkoutPoints = null, sector = 1, mult = 1 }) {
  const dartRows = Array.from({ length: darts }, () => ({ sector, multiplier: mult }));
  db.addTurn(gameId, { player, set, leg, scored, bust, checkout, checkoutPoints, darts: dartRows });
}

describe('getPlayerStatBubbles — 3-dart average (bust-as-3-darts denominator convention)', () => {
  test('a bust counts as a full 3-dart visit in the denominator regardless of darts actually thrown', () => {
    const name = 'X01_Avg_Bust';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 60, darts: 3, bust: false });
    turn(g.gameId, name, 1, 1, { scored: 0, darts: 1, bust: true }); // 1 physical dart, but counts as 3 in the denominator
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    // total points = 60 + 0 = 60; avgDarts denominator = 3 (real) + 3 (bust rule) = 6
    assert.equal(bubbles.avg, 60 / 6 * 3, 'avg = totalPts / avgDarts * 3');
    assert.equal(bubbles.dartsThrown, 4, 'dartsThrown is the RAW count (3+1), unaffected by the bust convention');
  });
});

describe('getPlayerStatBubbles — 180s and Big Fish', () => {
  test('scored=180 counts as a 180; checkout=170 counts as a Big Fish', () => {
    const name = 'X01_180_BigFish';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 2, 1, { scored: 170, darts: 3, checkout: true, checkoutPoints: 170 });
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(bubbles.one80s, 1);
    assert.equal(bubbles.bigFish, 1);
  });
});

describe('getPlayerStatBubbles — trebleless % (per-leg, REFERENCE.md denominator-conventions table)', () => {
  test('a leg counts as trebleless only if NO dart in it was a treble', () => {
    const name = 'X01_Trebleless';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 60, darts: 3, sector: 20, mult: 1 }); // leg 1: all singles -> trebleless
    turn(g.gameId, name, 1, 2, { scored: 180, darts: 3, sector: 20, mult: 3 }); // leg 2: trebles -> not trebleless
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(bubbles.treblelessPct, 50, '1 of 2 legs was trebleless');
  });
});

describe('getPlayerStatBubbles — OPENING_CATS scoping (exactly 501/301/170/101, 2026-07 decision)', () => {
  test('first3avg/score140pct count 501, 170, and 101 opening visits alike', () => {
    const name = 'X01_OpeningCats';
    db.addPlayer(name);
    const g501 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g501.gameId, name, 1, 1, { scored: 140, darts: 3 }); // a real 501 opening visit, scores 140
    const g170 = db.createGame({ category: '170', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g170.gameId, name, 1, 1, { scored: 170, darts: 3, checkout: true, checkoutPoints: 170 }); // 170's opening (only) visit — now counts, was previously excluded
    const g101 = db.createGame({ category: '101', legsPerSet: 1, setsPerGame: 1, practice: 1, config: { startingScore: 101 }, players: [{ name }] });
    turn(g101.gameId, name, 1, 1, { scored: 101, darts: 3, checkout: true, checkoutPoints: 101 }); // 101's opening (only) visit — new starting score, also counts
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(bubbles.first3avg, (140 + 170 + 101) / 3, 'all 3 opening visits (501/170/101) count');
    assert.ok(Math.abs(bubbles.score140pct - (2 / 3) * 100) < 1e-9, '2 of 3 (140 and 170) scored >=140, 101 did not');
    assert.equal(bubbles.bigFish, 1, 'the 170 checkout still counts toward Big Fish (not opening-scoped)');
  });

  test('first3avg/score140pct ignore a non-standard X01 starting score and any non-X01 game type', () => {
    const name = 'X01_OpeningCats_Excluded';
    db.addPlayer(name);
    const g501 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g501.gameId, name, 1, 1, { scored: 140, darts: 3 });
    // A custom/non-standard X01 starting score (e.g. 701) is not one of the 4
    // decided values — excluded even though game_type='x01'.
    const g701 = db.createGame({ category: '701', legsPerSet: 1, setsPerGame: 1, practice: 1, config: { startingScore: 701 }, players: [{ name }] });
    turn(g701.gameId, name, 1, 1, { scored: 180, darts: 3 });
    // A Cricket opening "visit" must never count either, even though nothing about
    // its category string would collide with '501'/'301'/'170'/'101'.
    const gCricket = db.createGame({ category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType: 'cricket', config: { numbers: [20, 19, 18, 17, 16, 15, 25] }, players: [{ name }] });
    db.addTurn(gCricket.gameId, { player: name, set: 1, leg: 1, scored: 0, legWon: true, darts: [{ sector: 20, multiplier: 3 }] });
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(bubbles.first3avg, 140, 'only the 501 opening visit counts — not 701 (non-standard) or Cricket');
    assert.equal(bubbles.score140pct, 100, 'the 701 leg\'s 180 opening visit is excluded from this stat entirely');
  });
});

describe('getPlayerStatBubbles — nine-darter detection', () => {
  test('exactly 3 turns, 9 total darts, a checkout, in a 501 leg: counts as a nine-darter', () => {
    const name = 'X01_NineDarter';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 141, darts: 3, checkout: true, checkoutPoints: 141 });
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(bubbles.nineDarters, 1);
  });

  test('the same shape but 8 darts total does NOT count', () => {
    const name = 'X01_EightDarter';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 141, darts: 2, checkout: true, checkoutPoints: 141 }); // finished in 2 darts this visit
    const bubbles = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(bubbles.nineDarters, 0);
  });
});

describe('getHomeExtra — leaderboards', () => {
  test('trebleless leaderboard ranks ascending: fewest trebleless visits is rank #1', () => {
    const p1 = 'X01_Home_TL_Most', p2 = 'X01_Home_TL_Fewest';
    db.addPlayer(p1); db.addPlayer(p2);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: p1 }, { name: p2 }] });
    for (let i = 0; i < 10; i++) {
      turn(g.gameId, p1, 1, 1, { scored: 20, darts: 1, sector: 20, mult: 1 }); // never a treble -> 100% trebleless
      turn(g.gameId, p2, 1, 1, { scored: 60, darts: 1, sector: 20, mult: 3 }); // always a treble -> 0% trebleless
    }
    const extra = db.getHomeExtra();
    const rows = extra.trebleLessRows.h2h;
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[p2].rate, 0);
    assert.equal(byName[p1].rate, 100);
    assert.ok(rows.findIndex(r => r.name === p2) < rows.findIndex(r => r.name === p1),
      'the lower trebleless rate (fewer trebleless visits) ranks first');
  });

  test('win leaderboard: rate = won/played*100, H2H only', () => {
    const p1 = 'X01_Home_Win_P1', p2 = 'X01_Home_Win_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    const g1 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: p1 }, { name: p2 }] });
    db.completeGame(g1.gameId, p1);
    const g2 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: p1 }, { name: p2 }] });
    db.completeGame(g2.gameId, p2);
    const g3 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: p1 }, { name: p2 }] });
    db.completeGame(g3.gameId, p1);
    const rows = db.getHomeExtra().winLeaderboard;
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName[p1].played, 3);
    assert.equal(byName[p1].won, 2);
    assert.equal(byName[p1].rate, +((2 / 3) * 100).toFixed(1));
  });
});

describe('getPersonalBests', () => {
  test('bestLegAvg / fewestDartsCheckout / lifetimeAvg / recentFormAvg (won legs only)', () => {
    const name = 'X01_PB_Player';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    // Leg 1: won in a single 3-dart visit scoring the max possible checkout (170) -> leg avg = 170/3*3 = 170
    turn(g.gameId, name, 1, 1, { scored: 170, darts: 3, checkout: true, checkoutPoints: 170 });
    // Leg 2: two visits, 60 then a 9-dart-total finish (3 darts) scoring 141 -> total 201 pts / 6 darts *3 = 100.5
    turn(g.gameId, name, 1, 2, { scored: 60, darts: 3 });
    turn(g.gameId, name, 1, 2, { scored: 141, darts: 3, checkout: true, checkoutPoints: 141 });
    // Leg 3: a lower-average won leg finished in fewer total darts than leg 1 isn't
    // possible (leg 1 already used the true minimum, 3) — instead test the metric
    // independently: a leg won in exactly 2 darts (a plausible double-double finish).
    turn(g.gameId, name, 1, 3, { scored: 100, darts: 2, checkout: true, checkoutPoints: 100 });

    const pb = db.getPersonalBests(name, 'practice');
    assert.equal(pb.bestLegAvg, 170, 'leg 1\'s single 3-dart 170 visit is the best leg average');
    assert.deepEqual(pb.bestLeg, { gameId: g.gameId, setNo: 1, legNo: 1 }, 'bestLeg identifies which leg produced bestLegAvg (Ghost Opponent\'s "Race this leg" entry point)');
    assert.equal(pb.fewestDartsCheckout, 2, 'leg 3 finished in the fewest total darts (2)');
    const legAvgs = [170, (60 + 141) / 6 * 3, 100 / 2 * 3];
    const expectedLifetime = legAvgs.reduce((s, v) => s + v, 0) / legAvgs.length;
    assert.equal(pb.lifetimeAvg, expectedLifetime);
    assert.equal(pb.recentFormAvg, expectedLifetime, 'fewer than 10 legs exist, so recent form = lifetime here');
  });

  test('winStreak walks the last completed H2H games newest-first, stopping at the first loss', () => {
    const p1 = 'X01_Streak_P1', p2 = 'X01_Streak_P2';
    db.addPlayer(p1); db.addPlayer(p2);
    // completeGame() stamps completed_at via SQLite's datetime('now'), which only has
    // second-level resolution — four games completed back-to-back in the same test
    // can tie, making ORDER BY completed_at DESC's tie order unspecified. Force
    // strictly increasing timestamps directly so the test is deterministic.
    let ts = 0;
    const mkGame = (winner) => {
      const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: p1 }, { name: p2 }] });
      db.completeGame(g.gameId, winner);
      ts += 1;
      db._db.prepare("UPDATE games SET completed_at = datetime('now', ? || ' seconds') WHERE id = ?").run(String(ts), g.gameId);
    };
    mkGame(p2); // oldest: a loss (should not be reached — streak stops before it)
    mkGame(p1); // win
    mkGame(p1); // win
    mkGame(p1); // most recent: win
    const pb = db.getPersonalBests(p1, 'h2h');
    assert.equal(pb.winStreak, 3, 'walks back 3 consecutive wins, stops at the older loss');
  });

  test('winStreak is always 0 in practice mode', () => {
    const name = 'X01_PracticeStreak';
    db.addPlayer(name);
    assert.equal(db.getPersonalBests(name, 'practice').winStreak, 0);
  });
});

describe('computeStats — player_count freeze survives participant deletion', () => {
  test('deleting one H2H participant does not reclassify the game for the remaining player', () => {
    const survivor = 'X01_Freeze_Survivor', deleted = 'X01_Freeze_Deleted';
    db.addPlayer(survivor); db.addPlayer(deleted);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: survivor }, { name: deleted }] });
    turn(g.gameId, survivor, 1, 1, { scored: 100, darts: 3 });
    const before = db.computeStats()[survivor];
    assert.equal(before.h2hStats.turns, 1, 'sanity check before deletion');

    db.deletePlayer(deleted);

    const after = db.computeStats()[survivor];
    assert.equal(after.h2hStats.turns, 1, 'still classified as H2H after the opponent is deleted (player_count was frozen at creation)');
    assert.equal(after.practiceStats.turns, 0, 'did not get reclassified into practice');
  });
});

describe('getMetricHistory matches getPlayerStatBubbles for the same metric (documented invariant)', () => {
  test('"avg" is byte-for-byte identical between the two functions', () => {
    const name = 'X01_History_Parity';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 100, darts: 3 });
    turn(g.gameId, name, 1, 2, { scored: 60, darts: 3 });
    const bubble = db.getPlayerStatBubbles(name, 'practice').avg;
    const history = db.getMetricHistory(name, 'avg', 'all', { mode: 'practice' });
    const historyTotal = history.reduce((s, r) => s + r.value * r.count, 0) / history.reduce((s, r) => s + r.count, 0);
    assert.equal(historyTotal, bubble, 'aggregating every history bucket reproduces the single bubble value');
  });

  test('"first3avg" applies the same 501/301/170/101 scoping as getPlayerStatBubbles', () => {
    const name = 'X01_History_OpeningCats';
    db.addPlayer(name);
    const g501 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g501.gameId, name, 1, 1, { scored: 140, darts: 3 });
    const g170 = db.createGame({ category: '170', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g170.gameId, name, 1, 1, { scored: 170, darts: 3, checkout: true, checkoutPoints: 170 });
    const g701 = db.createGame({ category: '701', legsPerSet: 1, setsPerGame: 1, practice: 1, config: { startingScore: 701 }, players: [{ name }] });
    turn(g701.gameId, name, 1, 1, { scored: 100, darts: 3 }); // non-standard starting score — excluded from both
    const bubble = db.getPlayerStatBubbles(name, 'practice').first3avg;
    const history = db.getMetricHistory(name, 'first3avg', 'all', { mode: 'practice' });
    assert.equal(history.length, 1, 'both eligible legs land in the same (current) month bucket');
    assert.equal(history[0].value, bubble, 'getMetricHistory reproduces the exact same scoped average as the bubble');
    assert.equal(bubble, (140 + 170) / 2, '701 (non-standard) is excluded from both');
  });
});
