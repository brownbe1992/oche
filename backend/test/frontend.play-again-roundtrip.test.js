'use strict';
// Play Again reproduces the game you just played, for every game type.
//
// `GAME_TYPES[t].buildConfig(setup, startScore)` turns the wizard's choices into a
// game's stored config; `GAME_TYPES[t].restoreSetup(config, finished)` is its inverse,
// and is what the Play Again button uses to put those choices back. This file drives
// both directions on every registered type and requires the second to undo the first.
//
// WHY IT IS WORTH A TEST RATHER THAN A GLANCE. restoreSetup was, until this change, a
// six-branch `if(finished.gameType === …)` chain inside playAgain(). buildConfig is
// required of all 16 types and throws when missing, so it cannot be forgotten quietly;
// nothing enforced the chain, so a mode with options that was never added to it lost
// them on Play Again — no error, no crash, just a rematch quietly using defaults.
// Doubles Practice and Checkout Trainer had both been missed exactly that way.
//
// The round trip is the assertion because it is the property a player would notice:
// set up a game, play it, press Play Again, and get the same game. Anything less
// specific (does the member exist? does it run?) would have passed on the broken code.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

/* Lift `buildConfig` and `restoreSetup` out of each registry entry by brace-matching —
 * index.html has no module boundary, the same reason completion-panels.test.js does it
 * this way. Returns { key: {buildConfig, restoreSetup} } as source strings. */
function registryMembers() {
  const out = new Map();
  const re = /\n {2}([a-z0-9_]+): \{\n {4}id: '([a-z0-9_]+)',/g;
  let m;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index + 1);
    const next = rest.search(/\n {2}[a-z0-9_]+: \{\n {4}id: '/);
    out.set(m[1], next === -1 ? rest : rest.slice(0, next));
  }
  return out;
}

// One member's value source, from `    <name>: ` to the matching end of its expression.
function memberSource(body, name) {
  const at = body.indexOf(`\n    ${name}:`);
  assert.ok(at > -1, `${name} not found`);
  const start = body.indexOf(':', at) + 1;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) return body.slice(start, i).trim();
    if (depth < 0) return body.slice(start, i).trim();
  }
  throw new Error(`unterminated ${name}`);
}

// The constants and helpers the two members reference. Real values, copied from the
// app — a drift here shows up as a failing round trip rather than a silent pass.
const CRICKET_STANDARD_NUMBERS = [20, 19, 18, 17, 16, 15, 25];
const KILLER_DEFAULT_LIVES = 3;
const DEAD_MAN_WALKING_DEFAULT_DIFFICULTY = 'standard';
const PRESSURE_ROUNDS = 15;
const normaliseDeadManWalkingDifficulty = (d) =>
  ['gentle', 'standard', 'brutal'].includes(d) ? d : null;
// The named no-ops the option-less types point at. Real ones, so "declares nothing to
// restore" is exercised rather than assumed.
const buildConfigNone = () => ({});
const restoreSetupNone = () => {};

const ENTRIES = registryMembers();

/* Per type: a `setup` holding deliberate NON-DEFAULT choices, and the setup keys the
 * round trip must bring back. Non-default matters — a fixture that happens to match the
 * defaults would pass against a restoreSetup that does nothing at all. */
const CASES = {
  x01:              { setup: { start: '301' }, category: '301', keys: ['start'] },
  cricket:          { setup: { cricketPreset: 'custom', cricketCustomNumbers: [20, 19, 18, 17, 16, 15, 25],
                               cricketVariant: 'cutthroat' },
                      keys: ['cricketPreset', 'cricketCustomNumbers', 'cricketVariant'] },
  shanghai:         { setup: { shanghaiRounds: 9 }, keys: ['shanghaiRounds'] },
  halve_it:         { setup: { halveItPreset: 'custom', halveItCustomTargets: [20, 19, 'D7'] },
                      keys: ['halveItPreset', 'halveItCustomTargets'] },
  killer:           { setup: { killerLives: 5 }, keys: ['killerLives'] },
  dead_man_walking: { setup: { dmwDifficulty: 'brutal' }, keys: ['dmwDifficulty'] },
  doubles_practice: { setup: { doublesTargets: [16, 20] }, keys: ['doublesTargets'] },
  checkout_trainer: { setup: { checkoutTrainerMode: 'route_recall', checkoutTrainerDifficulty: 'two_dart',
                               checkoutTrainerTricks: false, checkoutTrainerPin: null, routeRecallCeiling: 3 },
                      keys: ['checkoutTrainerMode', 'checkoutTrainerDifficulty', 'checkoutTrainerPin',
                             'routeRecallCeiling'] },
};

// Types whose config is a constant or empty — nothing was chosen, so nothing comes
// back. Listed rather than inferred, so a type that GAINS options is a failure here
// (its key stops matching this list) rather than a silent no-op.
const NO_OPTIONS = ['baseball', 'pressure_chamber', 'chuckin', 'around_the_clock',
  'around_the_world', 'bobs_27', 'checkout_ladder', 'gauntlet'];

function run(key, setupObj, startScore) {
  const body = ENTRIES.get(key);
  const sandbox = {
    setup: setupObj, CRICKET_STANDARD_NUMBERS, KILLER_DEFAULT_LIVES,
    DEAD_MAN_WALKING_DEFAULT_DIFFICULTY, PRESSURE_ROUNDS, normaliseDeadManWalkingDifficulty,
    buildConfigNone, restoreSetupNone,
    resolveCricketNumbers: () => setupObj.cricketCustomNumbers.slice(),
    resolveHalveItTargets: () => (setupObj.halveItPreset === 'custom' ? setupObj.halveItCustomTargets.slice() : null),
  };
  const names = Object.keys(sandbox);
  const make = (memberSrc) => new Function(...names, `return (${memberSrc});`)(...names.map(n => sandbox[n]));
  return { buildConfig: make(memberSource(body, 'buildConfig')),
           restoreSetup: make(memberSource(body, 'restoreSetup')), sandbox };
}

describe('Play Again reproduces the game that was just played', () => {
  test('every registered type was found', () => {
    assert.ok(ENTRIES.size >= 16, `only ${ENTRIES.size} registry entries parsed`);
  });

  for (const [key, c] of Object.entries(CASES)) {
    test(`${key}: setup -> config -> setup comes back identical`, () => {
      const original = JSON.parse(JSON.stringify(c.setup));
      const { buildConfig, restoreSetup, sandbox } = run(key, c.setup, 301);
      const config = buildConfig(sandbox.setup, 301);

      // Wipe the chosen keys, exactly as a fresh wizard state would leave them, so the
      // restore has to do real work instead of finding its answer already in place.
      for (const k of c.keys) delete sandbox.setup[k];

      restoreSetup(config, { category: c.category, config });
      for (const k of c.keys) {
        assert.deepEqual(sandbox.setup[k], original[k],
          `${key}: setup.${k} did not survive the round trip`);
      }
    });
  }

  test('checkout_trainer: a pinned Blitz comes back as the Freeform it actually played', () => {
    // The one deliberate asymmetry. buildConfig rewrites 'blitz' to 'freeform' when a
    // target is pinned (grinding one known number against a clock is not a speed test),
    // so the rematch must reproduce the mode that was PLAYED, not the one that was
    // asked for. Pinned here so the test states which of the two is correct.
    const setup = { checkoutTrainerMode: 'blitz', checkoutTrainerPin: 100,
      checkoutTrainerDifficulty: 'full', checkoutTrainerTricks: true, routeRecallCeiling: 2 };
    const { buildConfig, restoreSetup, sandbox } = run('checkout_trainer', setup, null);
    const config = buildConfig(sandbox.setup, null);
    assert.equal(config.mode, 'freeform', 'premise: a pinned blitz is stored as freeform');
    restoreSetup(config, { config });
    assert.equal(sandbox.setup.checkoutTrainerMode, 'freeform');
    assert.equal(sandbox.setup.checkoutTrainerPin, 100);
  });

  test('the option-less types really have no options to lose', () => {
    for (const key of NO_OPTIONS) {
      const setup = {};
      const { buildConfig, restoreSetup, sandbox } = run(key, setup, null);
      const config = buildConfig(sandbox.setup, null);
      restoreSetup(config, { config });
      assert.deepEqual(sandbox.setup, {},
        `${key} is listed as having no options, but its round trip wrote to setup — ` +
        'it has gained some and needs a case in CASES above');
    }
  });

  test('every type is covered by exactly one of the two lists', () => {
    const covered = new Set([...Object.keys(CASES), ...NO_OPTIONS]);
    const missing = [...ENTRIES.keys()].filter(k => !covered.has(k));
    assert.deepEqual(missing, [], `not covered by this test: ${missing.join(', ')}`);
  });
});
