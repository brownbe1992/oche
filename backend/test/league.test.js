'use strict';
// Committed tests for backend/db.js's league mode (docs/league-mode-roadmap.md, X01 or
// Cricket). Covers: creation/validation, enrollment (including multi-league
// enrollment), the onGameCreated auto-tag hook (0/1/>1 eligible-league cases, explicit
// valid/invalid leagueId, and every non-eligible game shape), live standings
// computation (points formula, decided-vs-abandoned games, zero-played roster rows,
// sort order), season status transitions, the wipeAllData/resetStats standing-rule
// interactions (docs/bug-roadmap.md BUG-7's own precedent, applied to leagues), and
// Cricket league support (gameType validation, category-per-gameType, and X01/Cricket
// cross-game-type isolation in both directions).
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

let counter = 0;
function uniqueName(prefix) { return `${prefix}_${++counter}`; }
function makePlayers(prefix, n) {
  const names = Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(65 + i)}`);
  names.forEach(n2 => db.addPlayer(n2, 'double', {}));
  return names;
}
function expect400(fn) {
  assert.throws(fn, (err) => err.status === 400);
}
function playX01Game(category, players, winner) {
  const { gameId } = db.createGame({ category, legsPerSet: 1, setsPerGame: 1, practice: 0,
    players: players.map(name => ({ name })) });
  db.completeGame(gameId, winner);
  return gameId;
}
const CRICKET_CLASSIC_NUMBERS = [15, 16, 17, 18, 19, 20, 25];
function createCricketGame(category, players, opts) {
  return db.createGame({ category, legsPerSet: 1, setsPerGame: 1, practice: 0,
    gameType: 'cricket', config: { numbers: CRICKET_CLASSIC_NUMBERS },
    players: players.map(name => ({ name })), ...opts });
}
function playCricketGame(category, players, winner) {
  const { gameId } = createCricketGame(category, players);
  db.completeGame(gameId, winner);
  return gameId;
}

describe('createLeague — validation', () => {
  test('rejects an empty or over-length name', () => {
    const [A, B] = makePlayers(uniqueName('CLV_'), 2);
    expect400(() => db.createLeague({ name: '', category: '501', players: [A, B] }));
    expect400(() => db.createLeague({ name: 'x'.repeat(65), category: '501', players: [A, B] }));
  });

  test('rejects an unknown category', () => {
    const [A, B] = makePlayers(uniqueName('CLV_'), 2);
    expect400(() => db.createLeague({ name: 'Cup', category: '999', players: [A, B] }));
    expect400(() => db.createLeague({ name: 'Cup', category: 'cricket', players: [A, B] }));
  });

  test('rejects malformed startsAt/endsAt and endsAt before startsAt', () => {
    const [A, B] = makePlayers(uniqueName('CLV_'), 2);
    expect400(() => db.createLeague({ name: 'Cup', category: '501', startsAt: '2026-7-1', players: [A, B] }));
    expect400(() => db.createLeague({ name: 'Cup', category: '501', endsAt: 'garbage', players: [A, B] }));
    expect400(() => db.createLeague({ name: 'Cup', category: '501', startsAt: '2026-06-10', endsAt: '2026-06-01', players: [A, B] }));
  });

  test('rejects duplicate player names', () => {
    const [A] = makePlayers(uniqueName('CLV_'), 1);
    expect400(() => db.createLeague({ name: 'Cup', category: '501', players: [A, A] }));
  });

  test('rejects out-of-range or non-integer pointsWin/pointsLoss', () => {
    const [A, B] = makePlayers(uniqueName('CLV_'), 2);
    expect400(() => db.createLeague({ name: 'Cup', category: '501', pointsWin: 2.5, players: [A, B] }));
    expect400(() => db.createLeague({ name: 'Cup', category: '501', pointsWin: 1000, players: [A, B] }));
    expect400(() => db.createLeague({ name: 'Cup', category: '501', pointsLoss: -1000, players: [A, B] }));
  });

  test('accepts a minimal valid league, defaulting startsAt to today, pointsWin/Loss to 1/0, and allows zero players at creation', () => {
    const r = db.createLeague({ name: uniqueName('Minimal Cup'), category: '501' });
    assert.ok(r.leagueId);
    const league = db.getLeague(r.leagueId);
    assert.equal(league.pointsWin, 1);
    assert.equal(league.pointsLoss, 0);
    assert.equal(league.status, 'active');
    assert.deepEqual(league.standings, []);
  });

  test('a fully-specified league round-trips its fields correctly', () => {
    const [A, B] = makePlayers(uniqueName('CLV_'), 2);
    const r = db.createLeague({ name: 'Full Cup', category: '301', startsAt: '2026-01-01', endsAt: '2026-12-31', pointsWin: 3, pointsLoss: 1, players: [A, B] });
    const league = db.getLeague(r.leagueId);
    assert.equal(league.name, 'Full Cup');
    assert.equal(league.category, '301');
    assert.equal(league.startsAt, '2026-01-01');
    assert.equal(league.endsAt, '2026-12-31');
    assert.equal(league.pointsWin, 3);
    assert.equal(league.pointsLoss, 1);
    assert.equal(league.standings.length, 2);
  });
});

describe('enrollment', () => {
  test('enrollLeaguePlayer adds a player and is idempotent on re-enrollment', () => {
    const [A] = makePlayers(uniqueName('ENR_'), 1);
    const { leagueId } = db.createLeague({ name: 'Enroll Cup', category: '501' });
    db.enrollLeaguePlayer(leagueId, A);
    db.enrollLeaguePlayer(leagueId, A); // re-enroll: no-op, not an error
    const league = db.getLeague(leagueId);
    assert.equal(league.standings.length, 1);
  });

  test('a player can be enrolled in multiple concurrent leagues', () => {
    const [A] = makePlayers(uniqueName('ENR_'), 1);
    const l1 = db.createLeague({ name: 'Multi Cup 1', category: '501', players: [A] });
    const l2 = db.createLeague({ name: 'Multi Cup 2', category: '301', players: [A] });
    const summary = db.getPlayerLeagueSummary(A);
    const ids = summary.map(s => s.leagueId).sort();
    assert.deepEqual(ids, [l1.leagueId, l2.leagueId].sort());
  });

  test('enrolling into an unknown league returns 404', () => {
    const [A] = makePlayers(uniqueName('ENR_'), 1);
    assert.throws(() => db.enrollLeaguePlayer(999999, A), (e) => e.status === 404);
  });
});

describe('games.league_id auto-tagging', () => {
  test('exactly one eligible league auto-tags silently, with no explicit leagueId', () => {
    const [A, B] = makePlayers(uniqueName('TAG1_'), 2);
    const { leagueId } = db.createLeague({ name: 'Tag Cup', category: '501', players: [A, B] });
    const { gameId } = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, leagueId);
  });

  test('zero eligible leagues leaves the game untagged', () => {
    const [A, B] = makePlayers(uniqueName('TAG0_'), 2);
    const { gameId } = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, null);
  });

  test('more than one eligible league (same category, both enrolled) leaves the game untagged when no leagueId is supplied — creation itself still succeeds', () => {
    const [A, B] = makePlayers(uniqueName('TAG2_'), 2);
    db.createLeague({ name: 'Ambig Cup 1', category: '501', players: [A, B] });
    db.createLeague({ name: 'Ambig Cup 2', category: '501', players: [A, B] });
    let gameId;
    assert.doesNotThrow(() => {
      gameId = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
        players: [{ name: A }, { name: B }] }).gameId;
    });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, null);
  });

  test('an explicit valid leagueId (from the New Game ambiguity picker) is used', () => {
    const [A, B] = makePlayers(uniqueName('TAG3_'), 2);
    db.createLeague({ name: 'Pick Cup 1', category: '501', players: [A, B] });
    const l2 = db.createLeague({ name: 'Pick Cup 2', category: '501', players: [A, B] });
    const { gameId } = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: A }, { name: B }], leagueId: l2.leagueId });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, l2.leagueId);
  });

  test('an explicit stale/invalid leagueId falls through silently instead of failing game creation', () => {
    const [A, B] = makePlayers(uniqueName('TAG4_'), 2);
    const { leagueId } = db.createLeague({ name: 'Fallback Cup', category: '501', players: [A, B] });
    let gameId;
    assert.doesNotThrow(() => {
      // a leagueId that doesn't exist at all
      gameId = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
        players: [{ name: A }, { name: B }], leagueId: 999999 }).gameId;
    });
    // falls through to auto-detect: exactly one REAL eligible league (Fallback Cup) still gets used
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, leagueId);
  });

  test('practice games are never tagged', () => {
    const [A, B] = makePlayers(uniqueName('TAG5_'), 2);
    db.createLeague({ name: 'Practice-Exempt Cup', category: '501', players: [A, B] });
    const { gameId } = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, null);
  });

  test('non-2-player games are never tagged', () => {
    const [A, B, C] = makePlayers(uniqueName('TAG6_'), 3);
    db.createLeague({ name: 'Solo-Exempt Cup', category: '501', players: [A] });
    const solo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: A }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(solo.gameId).league_id, null);
    db.createLeague({ name: 'Three-Exempt Cup', category: '301', players: [A, B, C] });
    const triple = db.createGame({ category: '301', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: A }, { name: B }, { name: C }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(triple.gameId).league_id, null);
  });

  test('a category mismatch is never tagged (a 301 game does not tag into a 501 league even with both players enrolled)', () => {
    const [A, B] = makePlayers(uniqueName('TAG7_'), 2);
    db.createLeague({ name: 'Category Cup', category: '501', players: [A, B] });
    const { gameId } = db.createGame({ category: '301', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, null);
  });
});

describe('GET /api/leagues/eligible — getEligibleLeagues', () => {
  test('resolves real, currently-enrolled matching-category leagues and fails soft otherwise', () => {
    const [A, B] = makePlayers(uniqueName('ELIG_'), 2);
    const { leagueId } = db.createLeague({ name: 'Eligible Cup', category: '501', players: [A, B] });
    assert.deepEqual(db.getEligibleLeagues(A, B, '501').map(l => l.id), [leagueId]);
    assert.deepEqual(db.getEligibleLeagues(A, B, '301'), []);
    assert.deepEqual(db.getEligibleLeagues(A, 'NoSuchPlayer_xyz', '501'), []);
    assert.deepEqual(db.getEligibleLeagues(A, B, 'not-a-category'), []);
  });
});

describe('getLeagueStandings — points formula, decided-vs-abandoned games, sort order', () => {
  test('only games with a decided winner_id count as played; an abandoned completion (null winner) does not', () => {
    const [A, B] = makePlayers(uniqueName('STAND1_'), 2);
    const { leagueId } = db.createLeague({ name: 'Standings Cup', category: '501', players: [A, B], pointsWin: 3, pointsLoss: 1 });
    const g1 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: A }, { name: B }] });
    db.completeGame(g1.gameId, null); // abandoned — no winner recorded
    const standings = db.getLeagueStandings(leagueId);
    assert.equal(standings.length, 2, 'both enrolled players still appear');
    for (const r of standings) assert.deepEqual([r.played, r.won, r.lost, r.points], [0, 0, 0, 0]);
  });

  test('points/played/won/lost compute correctly per the league\'s own pointsWin/pointsLoss, across several games', () => {
    const [A, B] = makePlayers(uniqueName('STAND2_'), 2);
    const { leagueId } = db.createLeague({ name: 'Formula Cup', category: '501', players: [A, B], pointsWin: 3, pointsLoss: 1 });
    playX01Game('501', [A, B], A);
    playX01Game('501', [A, B], A);
    playX01Game('501', [A, B], B);
    const standings = db.getLeagueStandings(leagueId);
    const a = standings.find(r => r.name === A), b = standings.find(r => r.name === B);
    assert.deepEqual([a.played, a.won, a.lost, a.points], [3, 2, 1, 2 * 3 + 1 * 1]);
    assert.deepEqual([b.played, b.won, b.lost, b.points], [3, 1, 2, 1 * 3 + 2 * 1]);
    // A has more points, so A ranks first
    assert.equal(standings[0].name, A);
  });

  test('an enrolled player with zero games played still appears, sorted last among equal points, with a null winPct', () => {
    const [A, B, C] = makePlayers(uniqueName('STAND3_'), 3);
    const { leagueId } = db.createLeague({ name: 'Zero-Played Cup', category: '501', players: [A, B, C] });
    playX01Game('501', [A, B], A); // C never plays
    const standings = db.getLeagueStandings(leagueId);
    const c = standings.find(r => r.name === C);
    assert.equal(c.played, 0);
    assert.equal(c.points, 0);
    assert.equal(c.winPct, null);
    // B also has 0 points (lost, pointsLoss default 0) but HAS played — B must sort
    // ahead of C despite equal points, since winPct breaks the tie.
    const bIdx = standings.findIndex(r => r.name === B);
    const cIdx = standings.findIndex(r => r.name === C);
    assert.ok(bIdx < cIdx, 'a player who has played (even 0 points) ranks above one who has not, at equal points');
  });

  test('getLeagueStandings on an unknown league throws 404', () => {
    assert.throws(() => db.getLeagueStandings(999999), (e) => e.status === 404);
  });
});

describe('setLeagueStatus — season lifecycle', () => {
  test('ending a league stops new auto-tags but does not un-tag already-tagged games', () => {
    const [A, B] = makePlayers(uniqueName('LIFE1_'), 2);
    const { leagueId } = db.createLeague({ name: 'Lifecycle Cup', category: '501', players: [A, B] });
    const g1 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(g1.gameId).league_id, leagueId);

    db.setLeagueStatus(leagueId, 'ended');
    assert.equal(db.getLeague(leagueId).status, 'ended');
    // the already-tagged game keeps its tag
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(g1.gameId).league_id, leagueId);

    const g2 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(g2.gameId).league_id, null,
      'a new game must not auto-tag into an ended league');
  });

  test('reopening a league (ended -> active) restores auto-tag eligibility', () => {
    const [A, B] = makePlayers(uniqueName('LIFE2_'), 2);
    const { leagueId } = db.createLeague({ name: 'Reopen Cup', category: '501', players: [A, B] });
    db.setLeagueStatus(leagueId, 'ended');
    db.setLeagueStatus(leagueId, 'active');
    assert.equal(db.getLeague(leagueId).status, 'active');
    assert.equal(db.getLeague(leagueId).endedAt, null);
    const { gameId } = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, leagueId);
  });

  test('an invalid status value is rejected', () => {
    const { leagueId } = db.createLeague({ name: 'Invalid Status Cup', category: '501' });
    assert.throws(() => db.setLeagueStatus(leagueId, 'bogus'), (e) => e.status === 400);
  });
});

describe('wipeAllData / resetStats — standing-rule interactions', () => {
  test('wipeAllData clears leagues and league_players (BUG-7-style: no orphaned shell survives a total wipe)', () => {
    const [A, B] = makePlayers(uniqueName('WIPE_'), 2);
    db.createLeague({ name: 'Wipe Cup', category: '501', players: [A, B] });
    assert.ok(db.listLeagues().length >= 1);
    db.wipeAllData();
    assert.equal(db.listLeagues().length, 0);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM league_players').get().n, 0);
  });

  test('resetStats leaves leagues/league_players intact — standings simply recompute to all-zero, not stranded', () => {
    const [A, B] = makePlayers(uniqueName('RESET_'), 2);
    const { leagueId } = db.createLeague({ name: 'Reset Cup', category: '501', players: [A, B] });
    playX01Game('501', [A, B], A);
    assert.equal(db.getLeagueStandings(leagueId).find(r => r.name === A).played, 1);

    db.resetStats();

    assert.equal(db.listLeagues().length >= 1, true, 'the league itself survives resetStats');
    const standings = db.getLeagueStandings(leagueId);
    assert.equal(standings.length, 2, 'the roster survives resetStats');
    for (const r of standings) assert.equal(r.played, 0, 'every game is gone, so every player is back to 0 played');
  });
});

describe('Cricket league support (docs/league-mode-roadmap.md "Game-type scope")', () => {
  test('gameType omitted defaults to x01, matching pre-Cricket behavior', () => {
    const [A, B] = makePlayers(uniqueName('GTDEF_'), 2);
    const { leagueId } = db.createLeague({ name: 'Default Cup', category: '501', players: [A, B] });
    assert.equal(db.getLeague(leagueId).gameType, 'x01');
  });

  test('rejects an unknown gameType', () => {
    const [A, B] = makePlayers(uniqueName('GTUNK_'), 2);
    expect400(() => db.createLeague({ name: 'Cup', gameType: 'doubles_practice', category: '501', players: [A, B] }));
  });

  test('a Cricket league accepts the classic and custom category labels, but not an X01 score', () => {
    const [A, B] = makePlayers(uniqueName('GTCAT_'), 2);
    const r1 = db.createLeague({ name: 'Classic Cup', gameType: 'cricket', category: 'Cricket (15-20, Bull)', players: [A, B] });
    assert.equal(db.getLeague(r1.leagueId).category, 'Cricket (15-20, Bull)');
    const r2 = db.createLeague({ name: 'Custom Cup', gameType: 'cricket', category: 'Custom Cricket', players: [A, B] });
    assert.equal(db.getLeague(r2.leagueId).category, 'Custom Cricket');
    expect400(() => db.createLeague({ name: 'Bad Cup', gameType: 'cricket', category: '501', players: [A, B] }));
  });

  test('a Cricket game auto-tags into a Cricket league of the matching category', () => {
    const [A, B] = makePlayers(uniqueName('GTTAG1_'), 2);
    const { leagueId } = db.createLeague({ name: 'Cricket Tag Cup', gameType: 'cricket', category: 'Cricket (15-20, Bull)', players: [A, B] });
    const { gameId } = createCricketGame('Cricket (15-20, Bull)', [A, B]);
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, leagueId);
  });

  test('an X01 game never tags into a Cricket league, even one enrolling the same two players', () => {
    const [A, B] = makePlayers(uniqueName('GTISO1_'), 2);
    db.createLeague({ name: 'Cricket-Only Cup', gameType: 'cricket', category: 'Cricket (15-20, Bull)', players: [A, B] });
    const { gameId } = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: A }, { name: B }] });
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, null);
  });

  test('a Cricket game never tags into an unrelated X01 league, even one enrolling the same two players', () => {
    const [A, B] = makePlayers(uniqueName('GTISO2_'), 2);
    db.createLeague({ name: 'X01-Only Cup', category: '501', players: [A, B] });
    const { gameId } = createCricketGame('Cricket (15-20, Bull)', [A, B]);
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id, null);
  });

  test('X01 and Cricket leagues with the same two players and no category collision both auto-tag independently', () => {
    const [A, B] = makePlayers(uniqueName('GTBOTH_'), 2);
    const x01League = db.createLeague({ name: 'Both-X01 Cup', category: '501', players: [A, B] });
    const cricketLeague = db.createLeague({ name: 'Both-Cricket Cup', gameType: 'cricket', category: 'Cricket (15-20, Bull)', players: [A, B] });
    const x01Game = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: A }, { name: B }] });
    const cricketGame = createCricketGame('Cricket (15-20, Bull)', [A, B]);
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(x01Game.gameId).league_id, x01League.leagueId);
    assert.equal(db._db.prepare('SELECT league_id FROM games WHERE id = ?').get(cricketGame.gameId).league_id, cricketLeague.leagueId);
  });

  test('getEligibleLeagues respects gameType, defaulting to x01 when omitted', () => {
    const [A, B] = makePlayers(uniqueName('GTELIG_'), 2);
    const { leagueId } = db.createLeague({ name: 'Eligible Cricket Cup', gameType: 'cricket', category: 'Cricket (15-20, Bull)', players: [A, B] });
    assert.deepEqual(db.getEligibleLeagues(A, B, 'Cricket (15-20, Bull)', 'cricket').map(l => l.id), [leagueId]);
    // Omitting gameType defaults to x01, so the same category string finds nothing under a Cricket-only league
    assert.deepEqual(db.getEligibleLeagues(A, B, 'Cricket (15-20, Bull)'), []);
  });

  test('standings compute correctly for a Cricket league using the same points formula as X01', () => {
    const [A, B] = makePlayers(uniqueName('GTSTAND_'), 2);
    const { leagueId } = db.createLeague({ name: 'Cricket Standings Cup', gameType: 'cricket', category: 'Cricket (15-20, Bull)', players: [A, B], pointsWin: 2, pointsLoss: 0 });
    playCricketGame('Cricket (15-20, Bull)', [A, B], A);
    playCricketGame('Cricket (15-20, Bull)', [A, B], A);
    playCricketGame('Cricket (15-20, Bull)', [A, B], B);
    const standings = db.getLeagueStandings(leagueId);
    const a = standings.find(r => r.name === A), b = standings.find(r => r.name === B);
    assert.deepEqual([a.played, a.won, a.lost, a.points], [3, 2, 1, 4]);
    assert.deepEqual([b.played, b.won, b.lost, b.points], [3, 1, 2, 2]);
  });
});
