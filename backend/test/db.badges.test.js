'use strict';
// Committed tests for backend/db.js's badge award/revoke semantics (REFERENCE.md §4
// "Award modes") — the two award modes (recurring vs. once) and undo's revoke path.
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

describe('awardBadge — recurring mode (once=false)', () => {
  test('count increments on every genuine occurrence', () => {
    const name = 'Badge_Recurring';
    db.addPlayer(name);
    const first = db.awardBadge(name, 'hattrick', false);
    assert.equal(first.newlyEarned, true);
    assert.equal(first.count, 1);
    const second = db.awardBadge(name, 'hattrick', false);
    assert.equal(second.newlyEarned, false, 'not newly earned the second time');
    assert.equal(second.count, 2);
    const third = db.awardBadge(name, 'hattrick', false);
    assert.equal(third.count, 3);
  });
});

describe('awardBadge — once mode (once=true)', () => {
  test('re-checking an already-true condition does not inflate the count past 1', () => {
    const name = 'Badge_Once';
    db.addPlayer(name);
    const first = db.awardBadge(name, 'around_the_clock', true);
    assert.equal(first.newlyEarned, true);
    assert.equal(first.count, 1);
    const second = db.awardBadge(name, 'around_the_clock', true);
    assert.equal(second.newlyEarned, false, 'INSERT OR IGNORE — the condition is already satisfied');
    assert.equal(second.count, 1, 'count never exceeds 1 for a once-badge');
  });
});

describe('revokeBadge (undo support)', () => {
  test('decrements count by 1, deleting the row once it reaches 0', () => {
    const name = 'Badge_Revoke';
    db.addPlayer(name);
    db.awardBadge(name, 'metronome', false);
    db.awardBadge(name, 'metronome', false); // count now 2
    const afterFirstRevoke = db.revokeBadge(name, 'metronome');
    assert.equal(afterFirstRevoke.count, 1);
    assert.ok(db.getPlayerBadges(name).some(b => b.badge_id === 'metronome'), 'still present at count 1');

    const afterSecondRevoke = db.revokeBadge(name, 'metronome');
    assert.equal(afterSecondRevoke.count, 0);
    assert.ok(!db.getPlayerBadges(name).some(b => b.badge_id === 'metronome'), 'row deleted once count reaches 0');
  });

  test('a once-badge (count always 1) is fully removed by a single revoke', () => {
    const name = 'Badge_RevokeOnce';
    db.addPlayer(name);
    db.awardBadge(name, 'grudge_match', true);
    const result = db.revokeBadge(name, 'grudge_match');
    assert.equal(result.count, 0);
    assert.ok(!db.getPlayerBadges(name).some(b => b.badge_id === 'grudge_match'));
  });

  test('revoking a badge that was never earned is a harmless no-op', () => {
    const name = 'Badge_RevokeNever';
    db.addPlayer(name);
    const result = db.revokeBadge(name, 'hattrick');
    assert.equal(result.count, 0);
  });
});

// docs/security-audit-roadmap.md SEC-14: badgeId previously accepted any string
// with no bound (both awardBadge/revokeBadge are requireWrite routes, public by
// default) — a made-up or oversized id could pollute the Badge Case. Every real
// badge id is lowercase snake_case, so a shape bound (not a duplicated exact
// enumeration — see the comment on validateBadgeId() in db.js) closes the gap.
describe('validateBadgeId (SEC-14: badgeId shape bound)', () => {
  test('rejects an empty badgeId', () => {
    const name = 'Badge_EmptyId';
    db.addPlayer(name);
    assert.throws(() => db.awardBadge(name, '', false), (err) => err.status === 400);
  });

  test('rejects uppercase or non-alphanumeric characters', () => {
    const name = 'Badge_BadShape';
    db.addPlayer(name);
    assert.throws(() => db.awardBadge(name, 'HatTrick', false), (err) => err.status === 400);
    assert.throws(() => db.awardBadge(name, 'hat-trick', false), (err) => err.status === 400);
    assert.throws(() => db.awardBadge(name, "hattrick'); DROP TABLE players;--", false), (err) => err.status === 400);
  });

  test('rejects an id over 64 characters', () => {
    const name = 'Badge_TooLong';
    db.addPlayer(name);
    assert.throws(() => db.awardBadge(name, 'x'.repeat(65), false), (err) => err.status === 400);
  });

  test('accepts a real badge id at exactly 64 characters', () => {
    const name = 'Badge_ExactLen';
    db.addPlayer(name);
    const id = 'chuckin_darts_' + '1'.repeat(50); // pads to exactly 64
    assert.equal(id.length, 64);
    assert.doesNotThrow(() => db.awardBadge(name, id, false));
  });

  test('revokeBadge applies the same bound', () => {
    const name = 'Badge_RevokeBadShape';
    db.addPlayer(name);
    assert.throws(() => db.revokeBadge(name, 'Not Valid!'), (err) => err.status === 400);
  });
});

describe('getPlayerBadges', () => {
  test('lists every distinct badge a player has earned, with its running count', () => {
    const name = 'Badge_List';
    db.addPlayer(name);
    db.awardBadge(name, 'hattrick', false);
    db.awardBadge(name, 'hattrick', false);
    db.awardBadge(name, 'bullseyegauntlet', false);
    const badges = db.getPlayerBadges(name);
    const byId = Object.fromEntries(badges.map(b => [b.badge_id, b.count]));
    assert.equal(byId.hattrick, 2);
    assert.equal(byId.bullseyegauntlet, 1);
  });

  test('a player with no badges gets an empty list, not an error', () => {
    const name = 'Badge_Empty';
    db.addPlayer(name);
    assert.deepEqual(db.getPlayerBadges(name), []);
  });
});
