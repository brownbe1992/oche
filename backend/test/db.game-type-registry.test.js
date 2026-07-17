'use strict';
// Committed test for backend/db.js's GAME_TYPE_REGISTRY consolidation (Architecture
// Roadmap P1-c). One registry now drives KNOWN_GAME_TYPES, SAVABLE_GAME_TYPES, and the
// per-type stat dispatch (getStatBubblesFor/getPersonalBestsFor) that used to be two
// ~18-arm ternary chains in server.js. This locks in the derived sets and asserts every
// registered type dispatches to its own stat function (with an X01 fallback for unknown
// types and the Marathon routing key), so a future edit that drops a type from the
// registry, or mis-wires a dispatch, fails loudly here.
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

describe('GAME_TYPE_REGISTRY — derived lists', () => {
  test('KNOWN_GAME_TYPES is exactly the real game types (marathon excluded)', () => {
    assert.deepEqual([...db.KNOWN_GAME_TYPES].sort(), [
      'around_the_clock', 'around_the_world', 'baseball', 'bobs_27', 'checkout_ladder',
      'checkout_trainer', 'chuckin', 'cricket', 'dead_man_walking', 'doubles_practice',
      'gauntlet', 'halve_it', 'killer', 'pressure_chamber', 'shanghai', 'x01',
    ]);
    assert.ok(!db.KNOWN_GAME_TYPES.includes('marathon'), 'marathon is a dispatch-only routing key, not a real game type');
  });

  test('SAVABLE_GAME_TYPES excludes the non-resumable drill/match types', () => {
    assert.deepEqual([...db.SAVABLE_GAME_TYPES].sort(), [
      'around_the_clock', 'around_the_world', 'baseball', 'bobs_27', 'checkout_ladder',
      'cricket', 'dead_man_walking', 'gauntlet', 'halve_it', 'pressure_chamber', 'shanghai', 'x01',
    ]);
    for (const notSavable of ['doubles_practice', 'chuckin', 'checkout_trainer', 'killer']) {
      assert.ok(!db.SAVABLE_GAME_TYPES.includes(notSavable), `${notSavable} is not savable`);
    }
    // Every savable type is a known type.
    for (const s of db.SAVABLE_GAME_TYPES) assert.ok(db.KNOWN_GAME_TYPES.includes(s));
  });
});

describe('GAME_TYPE_REGISTRY — stat dispatch', () => {
  const P = 'REG_P';
  db.addPlayer(P);

  test('every known type + marathon dispatches to its own stat function, matching the direct call', () => {
    // Map each dispatch key to its direct db function (the pre-refactor ternary targets).
    const directBubbles = {
      x01: db.getPlayerStatBubbles, cricket: db.getCricketStatBubbles, baseball: db.getBaseballStatBubbles,
      shanghai: db.getShanghaiStatBubbles, halve_it: db.getHalveItStatBubbles, pressure_chamber: db.getPressureChamberStatBubbles,
      doubles_practice: db.getDoublesPracticeStatBubbles, chuckin: db.getChuckinStatBubbles,
      checkout_trainer: db.getCheckoutTrainerStatBubbles, around_the_clock: db.getAroundTheClockStatBubbles,
      around_the_world: db.getAroundTheWorldDrillStatBubbles, bobs_27: db.getBobs27StatBubbles,
      checkout_ladder: db.getCheckoutLadderStatBubbles, gauntlet: db.getGauntletStatBubbles,
      dead_man_walking: db.getDeadManWalkingStatBubbles, killer: db.getKillerStatBubbles, marathon: db.getMarathonStatBubbles,
    };
    for (const [gt, fn] of Object.entries(directBubbles)) {
      assert.deepEqual(db.getStatBubblesFor(gt, P, 'practice'), fn(P, 'practice'), `stat bubbles dispatch for ${gt}`);
    }
    // Personal-bests dispatch: representative real types plus marathon.
    assert.deepEqual(db.getPersonalBestsFor('cricket', P, 'practice'), db.getCricketPersonalBests(P, 'practice'));
    assert.deepEqual(db.getPersonalBestsFor('pressure_chamber', P, 'practice'), db.getPressureChamberPersonalBests(P, 'practice'));
    assert.deepEqual(db.getPersonalBestsFor('marathon', P, 'practice'), db.getMarathonPersonalBests(P, 'practice'));
  });

  test('Checkout Trainer personal-bests merges the trainer and Blitz records', () => {
    const merged = db.getPersonalBestsFor('checkout_trainer', P, 'practice');
    const expected = Object.assign({}, db.getCheckoutTrainerPersonalBests(P, 'practice'), db.getCheckoutBlitzPersonalStats(P));
    assert.deepEqual(merged, expected);
  });

  test('an unknown/absent game type falls back to the X01 default', () => {
    assert.deepEqual(db.getStatBubblesFor('bogus', P, 'practice'), db.getPlayerStatBubbles(P, 'practice'));
    assert.deepEqual(db.getStatBubblesFor(null, P, 'practice'), db.getPlayerStatBubbles(P, 'practice'));
    assert.deepEqual(db.getPersonalBestsFor('bogus', P, 'practice'), db.getPersonalBests(P, 'practice'));
    assert.deepEqual(db.getPersonalBestsFor(undefined, P, 'practice'), db.getPersonalBests(P, 'practice'));
  });
});
