'use strict';
// Committed tests for Ghost Opponent's backend queries (docs/archive/ghost-opponent-roadmap.md):
// getGhostCandidateLegs() (the browsable "past legs you won" list) and
// getGhostLegScript() (one specific leg's ordered turn/dart replay script), plus
// getPersonalBests().bestLeg's null case (the non-null case is covered alongside
// bestLegAvg in db.x01-stats.test.js, since they're the same computation).
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

describe('getGhostCandidateLegs', () => {
  test('lists only legs this player actually won (checkout=1), most recent first', () => {
    const name = 'Ghost_Candidates';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 3, practice: 1, players: [{ name }] });
    // Leg 1: won, 3 darts, scored 170 -> avg 170
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 170, checkout: true, checkoutPoints: 170,
      darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 25, multiplier: 2 }] });
    // Leg 2: NOT won (no checkout) -> must not appear
    db.addTurn(g.gameId, { player: name, set: 1, leg: 2, scored: 60,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    // Leg 3: won, 3 darts, scored 60 -> avg 60, more recent than leg 1 (higher rowid/created_at)
    db.addTurn(g.gameId, { player: name, set: 1, leg: 3, scored: 60, checkout: true, checkoutPoints: 60,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });

    const legs = db.getGhostCandidateLegs(name);
    assert.equal(legs.length, 2, 'leg 2 (never checked out) is excluded');
    assert.deepEqual(legs.map(l => l.legNo), [3, 1], 'most recent won leg first');
    assert.equal(legs[1].avg, 170);
    assert.equal(legs[1].darts, 3);
  });

  test('Cricket legs (leg_won=1, no checkout) are excluded — X01-only for v1', () => {
    const name = 'Ghost_CricketExcluded';
    db.addPlayer(name);
    const g = db.createGame({ category: 'Cricket', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType: 'cricket',
      config: { numbers: [20, 19, 18, 17, 16, 15, 25] }, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, legWon: true,
      darts: [{ sector: 20, multiplier: 3 }] });
    assert.deepEqual(db.getGhostCandidateLegs(name), []);
  });

  test('an unknown player returns an empty list', () => {
    assert.deepEqual(db.getGhostCandidateLegs('Ghost_Nobody'), []);
  });

  test('limit param caps the result count', () => {
    const name = 'Ghost_Limit';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 5, practice: 1, players: [{ name }] });
    for (let leg = 1; leg <= 5; leg++) {
      db.addTurn(g.gameId, { player: name, set: 1, leg, scored: 100, checkout: true, checkoutPoints: 100,
        darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    }
    assert.equal(db.getGhostCandidateLegs(name).length, 5, 'default limit (20) covers all 5');
    assert.equal(db.getGhostCandidateLegs(name, 2).length, 2, 'explicit limit is respected');
  });

  // docs/security-audit-roadmap.md SEC-23: this is a public, unauthenticated route
  // (GET /api/players/ghost-legs) — an absurdly large explicit limit must be clamped
  // rather than forcing an unbounded full-history scan/response.
  test('an absurdly large explicit limit is clamped, not honored as-is', () => {
    const name = 'Ghost_LimitClamp';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 150, practice: 1, players: [{ name }] });
    for (let leg = 1; leg <= 150; leg++) {
      db.addTurn(g.gameId, { player: name, set: 1, leg, scored: 100, checkout: true, checkoutPoints: 100,
        darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    }
    assert.equal(db.getGhostCandidateLegs(name, 999999999).length, 100, 'clamped to the 100-row ceiling');
    assert.equal(db.getGhostCandidateLegs(name, 50).length, 50, 'a legitimate smaller explicit limit is unaffected');
  });

  test('sort:"best"/"worst" order by leg average instead of recency; an unknown sort falls back to recent', () => {
    const name = 'Ghost_Sort';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 3, practice: 1, players: [{ name }] });
    // Leg 1: avg 60 (oldest); Leg 2: avg 170 (highest avg); Leg 3: avg 100 (most recent)
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60, checkout: true, checkoutPoints: 60,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 2, scored: 170, checkout: true, checkoutPoints: 170,
      darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 25, multiplier: 2 }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 3, scored: 100, checkout: true, checkoutPoints: 100,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });

    assert.deepEqual(db.getGhostCandidateLegs(name, 20, { sort: 'best' }).map(l => l.legNo), [2, 3, 1],
      'best-average first');
    assert.deepEqual(db.getGhostCandidateLegs(name, 20, { sort: 'worst' }).map(l => l.legNo), [1, 3, 2],
      'worst-average first');
    assert.deepEqual(db.getGhostCandidateLegs(name, 20, { sort: 'bogus' }).map(l => l.legNo), [3, 2, 1],
      'an unrecognized sort value silently falls back to recency, not a SQL error');
  });

  test('category filters to one X01 starting score; an unrecognized category means "every mode"', () => {
    const name = 'Ghost_Category';
    db.addPlayer(name);
    const g501 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 2, practice: 1, players: [{ name }] });
    db.addTurn(g501.gameId, { player: name, set: 1, leg: 1, scored: 100, checkout: true, checkoutPoints: 100,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    const g301 = db.createGame({ category: '301', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(g301.gameId, { player: name, set: 1, leg: 1, scored: 100, checkout: true, checkoutPoints: 100,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });

    const only501 = db.getGhostCandidateLegs(name, 20, { category: '501' });
    assert.equal(only501.length, 1);
    assert.equal(only501[0].category, '501');

    const only301 = db.getGhostCandidateLegs(name, 20, { category: '301' });
    assert.equal(only301.length, 1);
    assert.equal(only301[0].category, '301');

    assert.equal(db.getGhostCandidateLegs(name, 20, { category: 'bogus' }).length, 2,
      'an unrecognized category value is treated as no filter, not zero results');
    assert.equal(db.getGhostCandidateLegs(name).length, 2, 'no category param at all still returns every mode');

    assert.equal(db.getGhostCandidateLegsCount(name, '501'), 1);
    assert.equal(db.getGhostCandidateLegsCount(name, '301'), 1);
    assert.equal(db.getGhostCandidateLegsCount(name), 2);
  });

  test('offset pages through the result set, in step with whatever sort is active', () => {
    const name = 'Ghost_Offset';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 5, practice: 1, players: [{ name }] });
    for (let leg = 1; leg <= 5; leg++) {
      db.addTurn(g.gameId, { player: name, set: 1, leg, scored: 100, checkout: true, checkoutPoints: 100,
        darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    }
    const page1 = db.getGhostCandidateLegs(name, 2, { offset: 0 });
    const page2 = db.getGhostCandidateLegs(name, 2, { offset: 2 });
    assert.deepEqual(page1.map(l => l.legNo), [5, 4]);
    assert.deepEqual(page2.map(l => l.legNo), [3, 2], 'offset 2 continues where offset 0 left off, not overlapping');
  });
});

describe('getGhostCandidateLegsCount', () => {
  test('counts every ghost-race-able leg regardless of limit/offset, for pagination controls', () => {
    const name = 'Ghost_Count';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 3, practice: 1, players: [{ name }] });
    for (let leg = 1; leg <= 3; leg++) {
      db.addTurn(g.gameId, { player: name, set: 1, leg, scored: 100, checkout: true, checkoutPoints: 100,
        darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });
    }
    // A 4th leg with no checkout doesn't count, matching getGhostCandidateLegs' own exclusion.
    db.addTurn(g.gameId, { player: name, set: 1, leg: 4, scored: 60,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });

    assert.equal(db.getGhostCandidateLegsCount(name), 3);
    assert.equal(db.getGhostCandidateLegs(name, 1).length, 1, 'a small limit truncates the list...');
    assert.equal(db.getGhostCandidateLegsCount(name), 3, '...but never affects the count');
  });

  test('an unknown player counts as zero', () => {
    assert.equal(db.getGhostCandidateLegsCount('Ghost_Count_Nobody'), 0);
  });
});

describe('getGhostLegScript', () => {
  test('returns the ordered turn/dart script for a leg this player won', () => {
    const name = 'Ghost_Script';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 19, multiplier: 3 }, { sector: 1, multiplier: 1 }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 141, checkout: true, checkoutPoints: 141,
      darts: [{ sector: 20, multiplier: 3 }, { sector: 19, multiplier: 3 }, { sector: 12, multiplier: 2 }] });

    const script = db.getGhostLegScript(g.gameId, 1, 1, name);
    assert.equal(script.category, '501');
    assert.equal(script.outMode, 'double', 'defaults to double-out, matching this game\'s recorded out_mode');
    assert.equal(script.turns.length, 2, 'both turns of the leg are included');
    assert.equal(script.turns[0].scored, 60, 'turns are ordered oldest-first (script playback order)');
    assert.equal(script.turns[1].scored, 141);
    assert.equal(script.turns[1].checkout, true);
    assert.equal(script.turns[1].checkoutPoints, 141);
    assert.deepEqual(script.turns[0].darts, [
      { sector: 20, multiplier: 1 }, { sector: 19, multiplier: 3 }, { sector: 1, multiplier: 1 },
    ], 'darts within a turn keep their thrown order (dart_no)');
  });

  test('refuses to build a script for a leg this player did not win', () => {
    const name = 'Ghost_NotWon';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60,
      darts: [{ sector: 20, multiplier: 1 }] });
    assert.equal(db.getGhostLegScript(g.gameId, 1, 1, name), null);
  });

  test('refuses to build a script for another player\'s leg', () => {
    const owner = 'Ghost_Owner', other = 'Ghost_Other';
    db.addPlayer(owner); db.addPlayer(other);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: owner }] });
    db.addTurn(g.gameId, { player: owner, set: 1, leg: 1, scored: 100, checkout: true, checkoutPoints: 100,
      darts: [{ sector: 20, multiplier: 1 }] });
    assert.equal(db.getGhostLegScript(g.gameId, 1, 1, other), null);
  });

  test('returns null for a nonexistent game or a Cricket game', () => {
    assert.equal(db.getGhostLegScript(999999, 1, 1, 'Ghost_Owner'), null);
    const name = 'Ghost_CricketScript';
    db.addPlayer(name);
    const g = db.createGame({ category: 'Cricket', legsPerSet: 1, setsPerGame: 1, practice: 1, gameType: 'cricket',
      config: { numbers: [20, 19, 18, 17, 16, 15, 25] }, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, legWon: true, darts: [{ sector: 20, multiplier: 3 }] });
    assert.equal(db.getGhostLegScript(g.gameId, 1, 1, name), null);
  });
});

describe('getPersonalBests().bestLeg', () => {
  test('is null when the player has no won legs', () => {
    const name = 'Ghost_PB_NoLegs';
    db.addPlayer(name);
    assert.equal(db.getPersonalBests(name, 'practice').bestLeg, null);
  });
});
