'use strict';
// Committed regression test for "achievements aren't firing during Dead Man
// Walking" (reported from real play, 2026-07).
//
// The cause was structural rather than a wrong condition: every per-visit
// achievement, counter and Home Assistant webhook — the 180 counter, Big Fish,
// nine-darter, the whole CHAIN_CHECKS list (Hat Trick, Bullseye Gauntlet, Double
// Trouble, Madhouse, Staircase Finish, Triple Bull, Bullseye Finish, Bed &
// Breakfast, Shanghai visit, No Cigar, Busted Maximum, …), Metronome, Cruise
// Control, Ice in the Veins, Around the Clock/World progress and the
// first-100-checkout milestone — had grown up INLINE inside enterTurn(), X01's
// own commit path. Dead Man Walking has its own commit path
// (enterTurnDeadManWalking()), whose visits are exactly the same shape — throw at
// a remaining score, maybe check out — so all of it was simply unreachable
// there. The only badge it ever awarded was the time-of-day pair, which it
// called itself.
//
// The fix extracts that block into awardVisitAchievements(p, ev, snap) and calls
// it from both. These are source-level assertions because index.html is a single
// inline-JS file with no module boundary to import; the live behaviour is
// covered by the verify-ui browser suite.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const src = () => fs.readFileSync(INDEX, 'utf8');

// The body of awardVisitAchievements(), brace-matched from its declaration.
function sharedFn(s) {
  const start = s.indexOf('function awardVisitAchievements(p, ev, snap){');
  assert.ok(start > -1, 'awardVisitAchievements() not found — has it been renamed or re-inlined?');
  let depth = 0;
  for (let i = s.indexOf('{', start); i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in awardVisitAchievements()');
}

describe('the per-visit achievement block is shared, not X01-only', () => {
  // Asserted by CALLER, not by a call count — a count has to be edited every
  // time another mode is wired up, which turns a meaningful test into a chore
  // and tells you nothing about which mode regressed.
  //
  // These three are exactly the modes whose visits come from evaluateVisit()
  // (X01's own per-visit evaluator), so the `ev` shape is identical and every
  // check applies. Modes with their own evaluators — Gauntlet's per-station
  // evaluateGauntletStation(), Bob's 27, The Pressure Chamber, Cricket,
  // Baseball, Shanghai, Halve-It — are deliberately NOT in this list: they have
  // no remaining score to check out from, so most of the block is meaningless
  // there and they keep the time-of-day pair only.
  const CALLERS = ['enterTurn', 'enterTurnDeadManWalking', 'enterTurnCheckoutLadder'];

  for (const fnName of CALLERS) {
    test(`${fnName}() awards per-visit achievements`, () => {
      const body = src().match(new RegExp(`\nfunction ${fnName}\\(\\)\\{[\\s\\S]*?\n\\}`));
      assert.ok(body, `${fnName}() not found`);
      assert.match(body[0], /awardVisitAchievements\(p, ev, _snap\)/,
        `${fnName}() must award per-visit achievements like every other mode`);
    });
  }

  test('every mode that calls it has the tracking fields its player needs', () => {
    // p.legVisitScores.push is the first thing the shared block touches, so a
    // player factory missing these throws on the very first committed visit.
    // Both Dead Man Walking (BUG-34) and Checkout Ladder (BUG-37) had this gap.
    const s = src();
    const FIELDS = ['legVisitScores', 'metronomeFired', 'pendingIceInTheVeins',
      'singlesHit', 'atwHitSet', 'atwBaselineHitSet', 'sessionOneEighties', 'lifetimeOneEightiesBase'];
    for (const factory of ['newMatchPlayer', 'newMatchPlayerDeadManWalking', 'newMatchPlayerCheckoutLadder']) {
      const body = s.match(new RegExp(`function ${factory}\\([^)]*\\)\\{[\\s\\S]*?\n\\}`));
      assert.ok(body, `${factory}() not found`);
      for (const f of FIELDS) {
        assert.ok(body[0].includes(f), `${factory}() is missing ${f} — the first committed visit will throw`);
      }
    }
  });

  test('it is no longer duplicated inline in enterTurn()', () => {
    // Two copies is how the two paths would drift into awarding different sets.
    const s = src();
    const enter = s.match(/\nfunction enterTurn\(\)\{[\s\S]*?\n\}/);
    assert.ok(enter, 'enterTurn() not found');
    assert.doesNotMatch(enter[0], /const CHAIN_CHECKS = \[/,
      'the chain checks belong in awardVisitAchievements(), not inline in enterTurn()');
  });

  test('the achievements that matter in a checkout drill are all in the shared block', () => {
    // Dead Man Walking rounds start on a real checkout target (32-170), so these
    // are genuinely reachable there — Big Fish especially, since 170 is in the
    // pool. Named individually so deleting one from the shared block fails here
    // rather than silently going quiet in one mode.
    const fn = sharedFn(src());
    for (const marker of [
      "queueBadge('bigfish', p.name)",
      "id:'hattrick'", "id:'madhouse'", "id:'bullseyefinish'", "id:'triplebull'",
      "id:'staircasefinish'", "id:'nocigar'", "id:'bedandbreakfast'", "id:'shanghaivisit'",
      "id:'doubletrouble'", "id:'bullseyegauntlet'",
      "'first_100_checkout'", "'around_the_world'", "'around_the_clock'",
      'awardTimeOfDayBadges(p)',
    ]) {
      assert.ok(fn.includes(marker), `${marker} must live in the shared block`);
    }
  });

  test('it awards only — turn recording and progression stay with each caller', () => {
    // X01 and Dead Man Walking record their turns differently (DMW records only
    // the darts actually reached before the round settled, via ev.dartsConsumed).
    // If recording leaked into the shared block, one of them would double-record.
    const fn = sharedFn(src());
    assert.doesNotMatch(fn, /DB\.recordTurn\(/, 'the shared block must not record turns');
    assert.doesNotMatch(fn, /onLegWon\(|resolveDeadManWalkingRound\(/, 'nor drive progression');
  });

  test('Dead Man Walking still records its own turn exactly once', () => {
    const dmw = src().match(/function enterTurnDeadManWalking\(\)\{[\s\S]*?\n\}/)[0];
    assert.equal((dmw.match(/DB\.recordTurn\(/g) || []).length, 1);
    assert.match(dmw, /dartsThrown = ev\.dartsConsumed/,
      'only the darts actually reached before the round settled are recorded');
  });

  test('the shared block runs before the visit darts are cleared', () => {
    // It reads game.darts for the visit's dart pattern (Hat Trick, Bed &
    // Breakfast, …). Clearing first would make every pattern check see an empty
    // visit and silently never fire — the same class of failure as the original
    // bug, but harder to spot.
    const dmw = src().match(/function enterTurnDeadManWalking\(\)\{[\s\S]*?\n\}/)[0];
    const award = dmw.indexOf('awardVisitAchievements(');
    const clear = dmw.indexOf('game.darts=[]');
    assert.ok(award > -1 && clear > -1, 'expected both an award call and a darts reset');
    assert.ok(award < clear, 'achievements must be awarded before game.darts is reset');
  });
});
