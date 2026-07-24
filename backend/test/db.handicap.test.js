'use strict';
// Committed tests for backend/db.js's X01 Handicapping
// (docs/archive/rating-and-handicap-roadmap.md Part B, REFERENCE.md's Handicapping
// section) — against a scratch SQLite database. Covers createGame()'s
// server-side startScore validation and the NOT_HANDICAPPED exclusion from
// nine-darter detection and fewestDartsCheckout (Elo's own exclusion is
// covered separately in db.elo.test.js).
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

function turn(gameId, player, set, leg, { scored, darts = 3, bust = false, checkout = false, checkoutPoints = null, sector = 1, mult = 1 }) {
  const dartRows = Array.from({ length: darts }, () => ({ sector, multiplier: mult }));
  db.addTurn(gameId, { player, set, leg, scored, bust, checkout, checkoutPoints, darts: dartRows });
}

describe('createGame — startScore validation', () => {
  test('rejects a startScore on a non-X01 game type', () => {
    const name = 'Handicap_NonX01';
    db.addPlayer(name); db.addPlayer(name + '_opp');
    assert.throws(() => db.createGame({
      category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 0, gameType: 'cricket',
      config: { numbers: [15, 16, 17, 18, 19, 20, 25] },
      players: [{ name, startScore: 401 }, { name: name + '_opp' }],
    }), /startScore is only valid for X01/);
  });

  test('rejects a startScore >= the game\'s own category', () => {
    const name = 'Handicap_TooHigh';
    db.addPlayer(name); db.addPlayer(name + '_opp');
    assert.throws(() => db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name, startScore: 501 }, { name: name + '_opp' }],
    }), /startScore must be an integer between 101 and 500/);
  });

  test('rejects a startScore below 101', () => {
    const name = 'Handicap_TooLow';
    db.addPlayer(name); db.addPlayer(name + '_opp');
    assert.throws(() => db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name, startScore: 100 }, { name: name + '_opp' }],
    }), /startScore must be an integer between 101 and 500/);
  });

  test('rejects a non-integer startScore', () => {
    const name = 'Handicap_NonInteger';
    db.addPlayer(name); db.addPlayer(name + '_opp');
    assert.throws(() => db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name, startScore: 401.5 }, { name: name + '_opp' }],
    }), /startScore must be an integer/);
  });

  test('accepts a valid startScore and leaves an unhandicapped opponent unaffected', () => {
    const name = 'Handicap_Valid', opp = 'Handicap_Valid_Opp';
    db.addPlayer(name); db.addPlayer(opp);
    const g = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name, startScore: 401 }, { name: opp }],
    });
    assert.ok(g.gameId);
  });

  test('NULL startScore (the default — no handicap) is unaffected by validation', () => {
    const name = 'Handicap_Null';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.ok(g.gameId);
  });
});

describe('Nine-darter detection excludes a handicapped player\'s shortened start', () => {
  test('a handicapped player finishing their shortened leg in 9 darts is NOT a nine-darter', () => {
    const name = 'Handicap_ND_A', opp = 'Handicap_ND_B';
    db.addPlayer(name); db.addPlayer(opp);
    const g = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name, startScore: 401 }, { name: opp }],
    });
    // name (handicapped to 401) "checks out" in exactly 9 darts across 3 turns —
    // the same shape db.x01-stats.test.js's own nine-darter fixture uses, just
    // attributed to a handicapped player this time.
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 41, darts: 3, checkout: true, checkoutPoints: 41 });

    const bubbles = db.getPlayerStatBubbles(name, 'h2h');
    assert.equal(bubbles.nineDarters, 0, 'a handicapped 401-start finish must not count as a 501 nine-darter');

    const stats = db.getNineDarterStats('h2h');
    assert.ok(!stats.leaderboard.some(r => r.name === name), 'must not appear on the nine-darter leaderboard');
  });

  test('the SAME game\'s unhandicapped opponent still gets full nine-darter credit', () => {
    const name = 'Handicap_ND_C', opp = 'Handicap_ND_D';
    db.addPlayer(name); db.addPlayer(opp);
    const g = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name, startScore: 401 }, { name: opp }],
    });
    // opp is NOT handicapped (still a real 501 start) and finishes in 9 darts.
    turn(g.gameId, opp, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, opp, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, opp, 1, 1, { scored: 141, darts: 3, checkout: true, checkoutPoints: 141 });

    const bubbles = db.getPlayerStatBubbles(opp, 'h2h');
    assert.equal(bubbles.nineDarters, 1, 'the unhandicapped opponent in the same game keeps their own real nine-darter credit');
  });

  test('getSummary\'s global nine-darter total also excludes the handicapped finish', () => {
    const name = 'Handicap_ND_Global';
    db.addPlayer(name);
    const before = db.getSummary().nineDarters;
    const g = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name, startScore: 401 }],
    });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 41, darts: 3, checkout: true, checkoutPoints: 41 });
    assert.equal(db.getSummary().nineDarters, before, 'the global total must not increment for a handicapped finish');
  });
});

describe('getPersonalBests — fewestDartsCheckout excludes a handicapped leg', () => {
  test('a handicapped 3-dart finish never sets fewestDartsCheckout', () => {
    const name = 'Handicap_PB_A';
    db.addPlayer(name);
    const g = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name, startScore: 401 }],
    });
    turn(g.gameId, name, 1, 1, { scored: 100, darts: 3, checkout: true, checkoutPoints: 100 });
    const pb = db.getPersonalBests(name, 'practice');
    assert.equal(pb.fewestDartsCheckout, null, 'the only recorded leg is handicapped, so there is no legitimate fewest-darts record yet');
  });

  test('a genuinely unhandicapped leg still sets fewestDartsCheckout normally', () => {
    const name = 'Handicap_PB_B';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 180, darts: 3 });
    turn(g.gameId, name, 1, 1, { scored: 141, darts: 3, checkout: true, checkoutPoints: 141 });
    const pb = db.getPersonalBests(name, 'practice');
    assert.equal(pb.fewestDartsCheckout, 9);
  });
});
