'use strict';
// Second-pass game-mode audit — the server-side half of five defects found by
// re-reviewing all 16 modes after the first pass's ten fixes landed.
//
// Only the backend-enforceable findings are here. Four of the pass-2 fixes are
// pure client state (Checkout Ladder / Dead Man Walking clearing per-leg
// achievement trackers, Baseball's sessionRuns and Doubles Practice's sessionHits
// surviving an undo, Killer's First Blood latch, awardOnceBadge() not celebrating
// a badge undo already revoked) and have no server surface to assert against —
// they are covered by the verify-ui suite instead.
//
// What every case below has in common: the rule already existed somewhere, and a
// second path bypassed it. Savability was enforced by game_type, and two modes
// slipped through by not having one. League eligibility was enforced by
// _findEligibleLeagues(), and the fixture path wrote games.league_id without
// consulting it. A fixture's status was derived from completed_at, and an
// abandoned game only ever sets dnf_at. So each test here pins the SECOND path,
// not the rule.
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

let seq = 0;
const uniq = (p) => `${p}_${++seq}`;

function x01Game(names, extra) {
  return db.createGame(Object.assign({
    category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType: 'x01',
    config: { startingScore: 501 }, players: names.map(name => ({ name })),
  }, extra || {}));
}

describe('saveGame() refuses the two savable-game_type modes that are not savable', () => {
  test('an ordinary practice X01 game is still savable — the control', () => {
    const n = uniq('P2_Plain');
    db.addPlayer(n);
    const g = x01Game([n]);
    assert.deepEqual(db.saveGame(g.gameId), { ok: true, alreadySaved: false });
  });

  test('a Daily Challenge attempt cannot be saved for later', () => {
    // The attempt is registered at game START (that is the whole point of the
    // one-per-calendar-day rule), so by the time anyone could press pause the
    // daily_challenge_attempts row already exists — which is exactly what makes
    // it recognisable here, and exactly what makes saving it destructive: the
    // day's single attempt is already spent on a game the resume path would
    // bring back as ordinary practice.
    const n = uniq('P2_Chal');
    db.addPlayer(n);
    const g = x01Game([n]);
    db.startChallengeAttempt(n, g.gameId, '2026-07-27', 'speed_to_zero', 501);
    assert.throws(() => db.saveGame(g.gameId), /Daily Challenge attempt can't be saved/);
  });

  test('a Ghost race cannot be saved for later, while it is still being played', () => {
    // config.ghost exists for precisely this moment. ghost_races is not written
    // until recordGhostRace() runs at the END of the race, so a check against
    // that table would pass every mid-race save — the case that matters.
    const n = uniq('P2_Ghost');
    db.addPlayer(n);
    const g = x01Game([n], { config: { startingScore: 501, ghost: true } });
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM ghost_races WHERE game_id = ?').get(g.gameId).n, 0,
      'the fixture must be a race in progress — if ghost_races already had a row, this would prove nothing');
    assert.throws(() => db.saveGame(g.gameId), /Ghost race can't be saved/);
  });

  test('config.ghost is validated as a boolean like any other client-supplied config field', () => {
    const n = uniq('P2_GhostBad');
    db.addPlayer(n);
    assert.throws(() => x01Game([n], { config: { startingScore: 501, ghost: 'yes' } }),
      /config.ghost must be a boolean/);
  });
});

describe('league fixtures and abandonment', () => {
  // A two-player league with one fixture, ready to play.
  function league() {
    const a = uniq('P2_LgA'), b = uniq('P2_LgB');
    db.addPlayer(a); db.addPlayer(b);
    const { leagueId } = db.createLeague({ name: uniq('P2 League'), gameType: 'x01', category: '501',
      startsAt: '2020-01-01', endsAt: null, pointsWin: 3, pointsLoss: 0, players: [a, b] });
    const fixtures = db.getLeagueFixtures(leagueId);
    assert.equal(fixtures.length, 1, 'a 2-player round robin is exactly one fixture');
    return { a, b, leagueId, fixtureId: fixtures[0].id };
  }
  const fixtureGame = (L) => db.createGame({
    category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, gameType: 'x01',
    config: { startingScore: 501 }, players: [{ name: L.a }, { name: L.b }],
    leagueFixtureId: L.fixtureId,
  });

  test('abandoning a fixture game returns the fixture to pending, so the pair can replay it', () => {
    const L = league();
    const g = fixtureGame(L);
    assert.equal(db.getLeagueFixtures(L.leagueId)[0].status, 'in_progress');
    // Before the fix this was terminal: dnf_at is not completed_at, so the status
    // could never become 'fulfilled', and game_id was set, so the New Game screen
    // would never offer the fixture again.
    db.abandonGame(g.gameId);
    const after = db.getLeagueFixtures(L.leagueId)[0];
    assert.equal(after.status, 'pending');
    assert.equal(after.gameId, null);
    assert.ok(db.getPendingFixturesForPlayers(L.a, L.b).some(f => f.fixtureId === L.fixtureId),
      'the fixture must be offerable again — that is the whole point of releasing it');
    // And it really is replayable, not merely displayed as pending.
    assert.ok(fixtureGame(L).gameId, 'a fresh game can be linked to the released fixture');
  });

  test('an abandoned fixture game still counts for nobody in the standings', () => {
    const L = league();
    db.abandonGame(fixtureGame(L).gameId);
    const table = db.getLeagueStandings(L.leagueId);
    assert.deepEqual(table.map(r => [r.name, r.played, r.won]).sort(),
      [[L.a, 0, 0], [L.b, 0, 0]].sort(),
      'an abandonment is not a result — releasing the fixture must not have turned it into one');
  });

  test('a completed fixture game is left alone — the hook keys on dnf_at, not on a null winner', () => {
    const L = league();
    const g = fixtureGame(L);
    db.completeGame(g.gameId, L.a);
    const after = db.getLeagueFixtures(L.leagueId)[0];
    assert.equal(after.status, 'fulfilled');
    assert.equal(after.gameId, g.gameId, 'a real result must keep its link');
  });

  test('a practice game cannot be logged to a league fixture', () => {
    // The auto-tag path has always refused practice (_findEligibleLeagues()); the
    // fixture path wrote games.league_id directly and never asked.
    const L = league();
    assert.throws(() => db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType: 'x01',
      config: { startingScore: 501 }, players: [{ name: L.a }, { name: L.b }],
      leagueFixtureId: L.fixtureId,
    }), /practice game can't be logged to a league fixture/);
  });

  test("a fixture in a league that has already ended can't be played", () => {
    const a = uniq('P2_OldA'), b = uniq('P2_OldB');
    db.addPlayer(a); db.addPlayer(b);
    const { leagueId } = db.createLeague({ name: uniq('P2 Ended'), gameType: 'x01', category: '501',
      startsAt: '2020-01-01', endsAt: '2020-02-01', pointsWin: 3, pointsLoss: 0, players: [a, b] });
    const fx = db.getLeagueFixtures(leagueId)[0];
    assert.throws(() => db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, gameType: 'x01',
      config: { startingScore: 501 }, players: [{ name: a }, { name: b }],
      leagueFixtureId: fx.id,
    }), /league is not currently running/);
  });
});
