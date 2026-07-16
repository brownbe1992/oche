'use strict';
// Committed tests for backend/db.js's Household Elo rating
// (docs/archive/rating-and-handicap-roadmap.md Part A, REFERENCE.md's Household Elo
// section) — against a scratch SQLite database. Hand-verified K=32 arithmetic
// for the two exact-value cases (a single win, then a rematch), plus
// derivation-only checks (not re-verifying the same formula a third time)
// for the min-games floor, rank/qualifies, and the handicapped-game
// exclusion.
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

// A completed, non-practice, 2-player game — Elo only reads games/game_players/
// winner_id, never turns, so no turns are recorded (matching db.export-csv.test.js's
// established "turns are irrelevant to this test" fixture convention where it holds).
function h2hGame(p1, p2, winner, opts = {}) {
  const g = db.createGame({
    category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
    players: [{ name: p1, startScore: opts.p1StartScore }, { name: p2, startScore: opts.p2StartScore }],
  });
  db.completeGame(g.gameId, winner);
  return g;
}

describe('getEloRatings', () => {
  test('a single win: both start 1000, K=32, expected=0.5 -> +/-16', () => {
    const a = 'Elo_Single_A', b = 'Elo_Single_B';
    db.addPlayer(a); db.addPlayer(b);
    h2hGame(a, b, a);

    const { ratings } = db.getEloRatings();
    const ra = ratings.find(r => r.name === a);
    const rb = ratings.find(r => r.name === b);
    assert.equal(ra.rating, 1016);
    assert.equal(rb.rating, 984);
    assert.equal(ra.wins, 1); assert.equal(ra.losses, 0); assert.equal(ra.played, 1);
    assert.equal(rb.wins, 0); assert.equal(rb.losses, 1); assert.equal(rb.played, 1);
    assert.equal(ra.history.length, 1);
    assert.equal(ra.history[0].rating, 1016);
  });

  test('a rematch: B beats A back — hand-computed expected(B)=0.45408, delta=round(32*0.54592)=17', () => {
    const a = 'Elo_Rematch_A', b = 'Elo_Rematch_B';
    db.addPlayer(a); db.addPlayer(b);
    h2hGame(a, b, a); // A: 1000->1016, B: 1000->984
    h2hGame(a, b, b); // B (984) beats A (1016): expected(B) ~= 0.45408, delta = round(32*0.54592) = 17

    const { ratings } = db.getEloRatings();
    const ra = ratings.find(r => r.name === a);
    const rb = ratings.find(r => r.name === b);
    assert.equal(ra.rating, 999);  // 1016 - 17
    assert.equal(rb.rating, 1001); // 984 + 17
    assert.equal(ra.wins, 1); assert.equal(ra.losses, 1); assert.equal(ra.played, 2);
    assert.equal(rb.wins, 1); assert.equal(rb.losses, 1); assert.equal(rb.played, 2);
    // Zero-sum: the winner's gain and the loser's loss are always exactly equal
    // (delta applied to both sides from the same rounded value), never drifting
    // apart through two independently-rounded formulas.
    assert.equal((ra.rating - 1000) + (rb.rating - 1000), 0);
  });

  test('an unrated player (never in a qualifying game) has no ratings-list entry at all', () => {
    const nobody = 'Elo_Nobody';
    db.addPlayer(nobody);
    const { ratings } = db.getEloRatings();
    assert.equal(ratings.find(r => r.name === nobody), undefined);
  });

  test('Upset: a big enough pre-game rating gap flips isUpset true for the lower-rated winner', () => {
    const x = 'Elo_Upset_X', y = 'Elo_Upset_Y';
    db.addPlayer(x); db.addPlayer(y);
    // X keeps beating Y until the gap reaches >=150 (K=32 near 1000 grows a gap by
    // roughly 10-16 points/game, so this always terminates well within 20 games —
    // the exact K=32 arithmetic producing each of these deltas is already
    // hand-verified above; this loop only proves the >=150 threshold comparison,
    // not re-litigating the formula a third time).
    let gap = 0;
    for (let i = 0; i < 20 && gap < 150; i++) {
      h2hGame(x, y, x);
      const { ratings } = db.getEloRatings();
      gap = ratings.find(r => r.name === x).rating - ratings.find(r => r.name === y).rating;
    }
    assert.ok(gap >= 150, `expected the gap to reach 150+, got ${gap}`);

    h2hGame(x, y, y); // the underdog wins
    const { lastGame } = db.getEloRatings();
    assert.equal(lastGame.winnerName, y);
    assert.equal(lastGame.isUpset, true);
  });

  test('a game where the favorite wins as expected is never flagged as an upset', () => {
    const a = 'Elo_NoUpset_A', b = 'Elo_NoUpset_B';
    db.addPlayer(a); db.addPlayer(b);
    h2hGame(a, b, a);
    const { lastGame } = db.getEloRatings();
    assert.equal(lastGame.isUpset, false);
  });

  test('practice games and 3+ player games never enter the walk', () => {
    const a = 'Elo_Scope_A', b = 'Elo_Scope_B', c = 'Elo_Scope_C';
    db.addPlayer(a); db.addPlayer(b); db.addPlayer(c);

    const solo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: a }] });
    db.completeGame(solo.gameId, a);
    const practiceH2h = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: a }, { name: b }] });
    db.completeGame(practiceH2h.gameId, a);
    const threePlayer = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: a }, { name: b }, { name: c }] });
    db.completeGame(threePlayer.gameId, a);

    const { ratings } = db.getEloRatings();
    assert.equal(ratings.find(r => r.name === a), undefined);
    assert.equal(ratings.find(r => r.name === b), undefined);
    assert.equal(ratings.find(r => r.name === c), undefined);
  });

  test('a handicapped game (either participant has a start_score override) is excluded from the walk', () => {
    const a = 'Elo_Handicap_A', b = 'Elo_Handicap_B';
    db.addPlayer(a); db.addPlayer(b);
    h2hGame(a, b, a, { p1StartScore: 401 }); // A started from a handicapped 401, not the game's real 501

    const { ratings } = db.getEloRatings();
    assert.equal(ratings.find(r => r.name === a), undefined);
    assert.equal(ratings.find(r => r.name === b), undefined);
  });
});

describe('getEloLeaderboard', () => {
  test('excludes players below the 5-rated-games floor', () => {
    const under = 'Elo_LB_Under', over = 'Elo_LB_Over', opp = 'Elo_LB_Opp';
    db.addPlayer(under); db.addPlayer(over); db.addPlayer(opp);
    for (let i = 0; i < 2; i++) h2hGame(under, opp, under);
    for (let i = 0; i < 5; i++) h2hGame(over, opp, over);

    const board = db.getEloLeaderboard();
    assert.equal(board.find(r => r.name === under), undefined);
    const overRow = board.find(r => r.name === over);
    assert.ok(overRow);
    assert.equal(overRow.played, 5);
  });

  test('sorted descending by rating', () => {
    const board = db.getEloLeaderboard();
    for (let i = 1; i < board.length; i++) {
      assert.ok(board[i - 1].rating >= board[i].rating);
    }
  });
});

describe('getPlayerElo', () => {
  test('a below-floor player: qualifies=false, rank=null, but rating/played still reported', () => {
    const p = 'Elo_Player_Under', opp = 'Elo_Player_UnderOpp';
    db.addPlayer(p); db.addPlayer(opp);
    h2hGame(p, opp, p);
    h2hGame(p, opp, opp);

    const info = db.getPlayerElo(p);
    assert.equal(info.played, 2);
    assert.equal(info.qualifies, false);
    assert.equal(info.rank, null);
  });

  test('an at-floor-or-above player gets a real 1-indexed rank among qualifying players', () => {
    const strong = 'Elo_Player_Strong', weak = 'Elo_Player_Weak', filler = 'Elo_Player_Filler';
    db.addPlayer(strong); db.addPlayer(weak); db.addPlayer(filler);
    for (let i = 0; i < 5; i++) h2hGame(strong, filler, strong); // strong: 5-0, well above 1000
    for (let i = 0; i < 5; i++) h2hGame(weak, filler, filler);   // weak: 0-5, well below 1000

    const strongInfo = db.getPlayerElo(strong);
    const weakInfo = db.getPlayerElo(weak);
    assert.equal(strongInfo.qualifies, true);
    assert.equal(weakInfo.qualifies, true);
    assert.ok(strongInfo.rank < weakInfo.rank, 'the higher-rated player must rank numerically lower (better)');
  });

  test('unknown player returns null', () => {
    assert.equal(db.getPlayerElo('Elo_Player_Nobody'), null);
  });

  test('a player with zero games: rating defaults to 1000, not qualified', () => {
    const p = 'Elo_Player_Fresh';
    db.addPlayer(p);
    const info = db.getPlayerElo(p);
    assert.equal(info.rating, 1000);
    assert.equal(info.played, 0);
    assert.equal(info.qualifies, false);
    assert.equal(info.rank, null);
    assert.deepEqual(info.history, []);
  });
});
