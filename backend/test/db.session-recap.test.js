'use strict';
// Committed tests for backend/db.js's getSessionRecap() (docs/session-recap-
// roadmap.md, REFERENCE.md's Session Recap section) — a fixture night with two
// players, mixed game types, a badge earned, and both a fresh and a
// pre-existing personal best (the pre-tonight comparison the roadmap doc
// itself flags as "the easiest formula to get subtly wrong"); empty-date and
// solo-only-night shapes; date-boundary scoping (a turn just before midnight
// vs just after).
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

function lastTurnId() { return db._db.prepare('SELECT MAX(id) AS id FROM turns').get().id; }
function setTurnDate(turnId, dateTime) { db._db.prepare('UPDATE turns SET created_at = ? WHERE id = ?').run(dateTime, turnId); }
function setGameCompletedDate(gameId, dateTime) { db._db.prepare('UPDATE games SET completed_at = ? WHERE id = ?').run(dateTime, gameId); }
function setBadgeDate(playerName, badgeId, dateTime) {
  const p = db._db.prepare('SELECT id FROM players WHERE name = ?').get(playerName);
  db._db.prepare('UPDATE player_badges SET earned_at = ? WHERE player_id = ? AND badge_id = ?').run(dateTime, p.id, badgeId);
}

function x01Game(names, opts = {}) {
  return db.createGame({
    category: '501', legsPerSet: opts.legsPerSet || 1, setsPerGame: opts.setsPerGame || 1,
    practice: opts.practice != null ? opts.practice : 0, gameType: 'x01', config: { startingScore: 501 },
    players: names.map(name => ({ name })),
  });
}
function turn(gameId, player, scored, opts = {}) {
  db.addTurn(gameId, { player, set: 1, leg: 1, scored, bust: false, checkout: false, checkoutPoints: null,
    darts: [{ dartNo: 1, sector: 20, multiplier: 1 }], ...opts });
}

describe('getSessionRecap', () => {
  test('an invalid date throws 400', () => {
    assert.throws(() => db.getSessionRecap('not-a-date'), /YYYY-MM-DD/);
    assert.throws(() => db.getSessionRecap(undefined), /YYYY-MM-DD/);
  });

  test('a date with zero activity returns an empty-shaped recap, not a crash', () => {
    const r = db.getSessionRecap('2019-01-01');
    assert.equal(r.totalGames, 0);
    assert.deepEqual(r.h2hGames, []);
    assert.deepEqual(r.h2hResultsByMatchup, []);
    assert.deepEqual(r.perPlayer, []);
    assert.deepEqual(r.soloActivity, []);
    assert.deepEqual(r.badgesEarnedTonight, []);
    assert.deepEqual(r.personalBestsSetTonight, []);
    assert.deepEqual(r.moments, []);
  });

  test('h2hGames/h2hResultsByMatchup/perPlayer reflect a completed 2-player match on that date', () => {
    const a = 'Recap_A', b = 'Recap_B';
    db.addPlayer(a); db.addPlayer(b);
    const { gameId } = x01Game([a, b]);
    turn(gameId, a, 180, { darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 3 }] });
    turn(gameId, b, 60, { darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 20, multiplier: 1 }, { dartNo: 3, sector: 20, multiplier: 1 }] });
    turn(gameId, a, 170, { checkout: true, checkoutPoints: 170,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 25, multiplier: 2 }] });
    db.completeGame(gameId, a);
    const today = new Date().toISOString().slice(0, 10);
    setGameCompletedDate(gameId, `${today} 20:00:00`);
    // addTurn() stamps created_at itself (datetime('now')) which already falls on
    // today by construction -- only the game's own completed_at needed backdating
    // to a fixed time for determinism.

    const r = db.getSessionRecap(today);
    assert.equal(r.totalGames, 1);
    assert.equal(r.h2hGames[0].winnerName, a);
    assert.deepEqual(r.h2hGames[0].players.sort(), [a, b].sort());

    assert.equal(r.h2hResultsByMatchup.length, 1);
    assert.equal(r.h2hResultsByMatchup[0].record[a], 1);

    const pa = r.perPlayer.find(p => p.name === a);
    const pb = r.perPlayer.find(p => p.name === b);
    assert.equal(pa.gamesWon, 1); assert.equal(pa.gamesLost, 0);
    assert.equal(pb.gamesWon, 0); assert.equal(pb.gamesLost, 1);
    assert.equal(pa.oneEighties, 1);
    assert.equal(pa.tonPlusCheckouts, 1);
    assert.equal(pa.bestVisit, 180);
    assert.equal(pa.bestLegAvg, 175, 'A\'s only won leg: (180+170)/6 darts * 3 = 175');
    assert.equal(pb.bestLegAvg, null, 'B never won a leg, so has no leg average here');

    assert.ok(r.moments.some(m => m.type === '180' && m.player === a));
    assert.ok(r.moments.some(m => m.type === 'bigfish' && m.player === a));
    assert.ok(r.moments.some(m => m.type === 'matchwin' && m.player === a));
  });

  test('personalBestsSetTonight only fires for a value that actually beats the pre-tonight baseline', () => {
    const p = 'Recap_PB';
    db.addPlayer(p);
    const today = new Date().toISOString().slice(0, 10);

    // Yesterday: a modest leg (avg 60) -- establishes a pre-tonight baseline.
    const { gameId: g1 } = x01Game([p], { practice: 1 });
    turn(g1, p, 60, { checkout: true, checkoutPoints: 60,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 20, multiplier: 1 }, { dartNo: 3, sector: 20, multiplier: 1 }] });
    setTurnDate(lastTurnId(), `${daysAgo(1)} 12:00:00`);

    // Tonight: a much better leg (avg 100) -- must be flagged as a new PB.
    const { gameId: g2 } = x01Game([p], { practice: 1 });
    turn(g2, p, 100, { checkout: true, checkoutPoints: 100,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 2 }] });

    const r = db.getSessionRecap(today);
    const pbLegAvg = r.personalBestsSetTonight.find(x => x.player === p && x.metric === 'legAvg');
    assert.ok(pbLegAvg, 'a genuinely better leg average tonight must be flagged');
    assert.equal(pbLegAvg.value, 100);
    assert.equal(pbLegAvg.previousBest, 60);

    // A second, worse leg tonight (avg 40) must NOT also be flagged as beating
    // the (already-recorded, still-standing) baseline of 60.
    const { gameId: g3 } = x01Game([p], { practice: 1 });
    turn(g3, p, 40, { checkout: true, checkoutPoints: 40,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 20, multiplier: 1 }] });
    const r2 = db.getSessionRecap(today);
    // Still exactly one legAvg PB entry for this player tonight (the 100, not a
    // second one for the 40) -- personalBestsSetTonight reports the single best
    // value achieved tonight compared once against the pre-tonight baseline, not
    // once per leg played.
    assert.equal(r2.personalBestsSetTonight.filter(x => x.player === p && x.metric === 'legAvg').length, 1);
    assert.equal(r2.personalBestsSetTonight.find(x => x.player === p && x.metric === 'legAvg').value, 100);
  });

  function daysAgo(n) {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  test('badgesEarnedTonight is scoped to earned_at on that exact date', () => {
    const p = 'Recap_Badge';
    db.addPlayer(p);
    db._db.prepare("INSERT INTO player_badges (player_id, badge_id, count, earned_at) VALUES ((SELECT id FROM players WHERE name=?), 'oneeighty', 1, datetime('now'))").run(p);
    setBadgeDate(p, 'oneeighty', `${daysAgo(2)} 12:00:00`);
    db._db.prepare("INSERT INTO player_badges (player_id, badge_id, count, earned_at) VALUES ((SELECT id FROM players WHERE name=?), 'nightowl', 1, datetime('now'))").run(p);

    const today = new Date().toISOString().slice(0, 10);
    const r = db.getSessionRecap(today);
    assert.ok(r.badgesEarnedTonight.some(b => b.player === p && b.badgeId === 'nightowl'));
    assert.ok(!r.badgesEarnedTonight.some(b => b.badgeId === 'oneeighty'), 'a badge earned 2 days ago must not appear in tonight\'s recap');
  });

  test('soloActivity groups non-H2H activity by player+gameType, separate from the H2H spine', () => {
    const p = 'Recap_Solo';
    db.addPlayer(p);
    const { gameId: g } = x01Game([p], { practice: 1 });
    turn(g, p, 60);
    turn(g, p, 60);

    const today = new Date().toISOString().slice(0, 10);
    const r = db.getSessionRecap(today);
    assert.ok(!r.h2hGames.some(g => g.players.includes(p)), 'a solo practice game is not part of the H2H spine');
    const row = r.soloActivity.find(x => x.name === p && x.gameType === 'x01');
    assert.ok(row);
    assert.equal(row.darts, 2, 'two 1-dart turn() calls above -- 2 real darts thrown');
    assert.equal(row.legs, 1, 'both turns land in the same leg (set 1, leg 1)');
  });

  test('date-boundary scoping: a turn just before midnight and one just after land on different recaps', () => {
    const p = 'Recap_Boundary';
    db.addPlayer(p);
    const { gameId: g } = x01Game([p], { practice: 1 });
    turn(g, p, 60);
    const tid = lastTurnId();
    setTurnDate(tid, '2024-06-14 23:59:59');

    const { gameId: g2 } = x01Game([p], { practice: 1 });
    turn(g2, p, 60);
    setTurnDate(lastTurnId(), '2024-06-15 00:00:01');

    const before = db.getSessionRecap('2024-06-14');
    const after = db.getSessionRecap('2024-06-15');
    assert.ok(before.soloActivity.some(x => x.name === p));
    assert.ok(after.soloActivity.some(x => x.name === p));
    // Each date sees exactly its own darts, not both.
    assert.equal(before.soloActivity.find(x => x.name === p).darts, 1);
    assert.equal(after.soloActivity.find(x => x.name === p).darts, 1);
  });
});

// Timestamps are stored UTC while the client asks for its LOCAL calendar date —
// getSessionRecap(date, tz) shifts every date() bucket by the client's UTC
// offset via the shared _tzModifier() convention (minutes EAST of UTC, i.e.
// the client sends `-new Date().getTimezoneOffset()`, same as avg-history and
// on-this-day). Without the shift, a user at UTC-5 had every game after ~7pm
// local land in TOMORROW's recap. tz absent/invalid falls back to 0 (raw UTC
// dates, old behavior).
describe('getSessionRecap tz offset', () => {
  test('a late-UTC-evening turn lands on the local date the player experienced', () => {
    const p = 'Recap_TZ_A';
    db.addPlayer(p);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: p }] });
    db.addTurn(g.gameId, { player: p, set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 } ] });
    const turnId = db._db.prepare('SELECT id FROM turns WHERE game_id = ?').get(g.gameId).id;
    // 01:30 UTC on Mar 2 = 20:30 Mar 1 in UTC-5 (tz = -300 minutes east).
    setTurnDate(turnId, '2026-03-02 01:30:00');

    const utcView = db.getSessionRecap('2026-03-02');
    assert.ok(utcView.perPlayer.some(r => r.name === p), 'tz omitted: raw UTC date buckets (old behavior)');

    const westView = db.getSessionRecap('2026-03-01', -300);
    assert.ok(westView.perPlayer.some(r => r.name === p), "UTC-5 player's Mar 1 evening includes the turn");
    const westWrongDay = db.getSessionRecap('2026-03-02', -300);
    assert.ok(!westWrongDay.perPlayer.some(r => r.name === p), 'and it no longer leaks into their Mar 2');
  });
});
