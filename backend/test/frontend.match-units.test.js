'use strict';
// How many legs and sets a match actually is, per game type (docs/bug-roadmap.md BUG-22).
//
// For X01 and Cricket a leg is an open-ended countdown, so "best of 5" means what it
// says. For a mode whose leg is a COMPLETE, self-contained game — Baseball's 9 innings,
// Shanghai's and Halve-It's fixed round sequences, the Pressure Chamber's 15 cards — a
// solo "best of 5" would mean playing five whole games and calling the result one match.
// Those are forced to 1 leg / 1 set in practice and keep a real Bo3/Bo5 head-to-head.
// Dead Man Walking is the exception to the exception: 15 legs / 1 set, because each of
// its rounds IS a leg inside one session.
//
// WHY THIS FILE EXISTS. That rule used to be stated five separate times inside
// startGame(), in four near-identical `isPracticeX` flags whose own comments read "Same
// BUG-22 reasoning as isPracticeBaseball above", then "Same BUG-22 reasoning again",
// twice more — plus Dead Man Walking's different one. A sixth mode of that shape needed
// a sixth copy, and the cost of forgetting is SILENT: a solo drill quietly structured as
// a best-of-3, recorded that way in the database, with nothing visibly wrong on screen.
// The rule now lives on the registry as `practiceUnit`.
//
// The refactor is checked by EQUIVALENCE, not by hand-written expectations. The original
// five-flag expression is kept verbatim below as a reference implementation, and the two
// are compared across every reachable combination of game type, mode and chosen
// legs/sets. Hand-written expectations would only prove the new code matches what I
// believed the old code did; this proves it matches what the old code actually did.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

// --- the new implementation, lifted from index.html -------------------------
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name}() not found in index.html`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

// Each entry's practiceUnit, read straight out of the registry so the test cannot
// disagree with the app about what a mode declares.
function registryPracticeUnits() {
  const out = new Map();
  const re = /\n {2}([a-z0-9_]+): \{\n {4}id: '([a-z0-9_]+)',/g;
  let m;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index + 1);
    const next = rest.search(/\n {2}[a-z0-9_]+: \{\n {4}id: '/);
    const body = next === -1 ? rest : rest.slice(0, next);
    const pu = body.match(/\n {4}practiceUnit: (null|\{ legsPerSet: (\d+), setsPerGame: (\d+) \})/);
    assert.ok(pu, `${m[1]} declares no practiceUnit`);
    out.set(m[1], pu[1] === 'null' ? null
      : { legsPerSet: Number(pu[2]), setsPerGame: Number(pu[3]) });
  }
  return out;
}

const UNITS = registryPracticeUnits();
const GAME_TYPES = Object.fromEntries([...UNITS].map(([k, v]) => [k, { practiceUnit: v }]));
const SINGLE_UNIT_MODES = ['challenge', 'ghost'];
const resolveMatchUnits = new Function('GAME_TYPES', 'SINGLE_UNIT_MODES',
  `${extract('resolveMatchUnits')}; return resolveMatchUnits;`)(GAME_TYPES, SINGLE_UNIT_MODES);

// --- the ORIGINAL expression, verbatim --------------------------------------
// Copied unchanged from startGame() as it stood before this refactor. Do not tidy it:
// its value is being exactly what shipped, so any difference the sweep finds is a real
// behaviour change rather than a transcription of it.
function referenceMatchUnits(setup, gameType) {
  // Frozen snapshot of the pre-registry logic. maths_trainer postdates it and is
  // listed here for the same reason every other entry is: it is a solo drill whose
  // wizard `mode` IS its game type, so one round is one leg and one set.
  const drillModes = ['challenge', 'ghost', 'doubles_practice', 'chuckin', 'checkout_trainer',
    'around_the_world', 'bobs_27', 'checkout_ladder', 'gauntlet', 'maths_trainer'];
  const isPracticeBaseball = setup.gameType === 'baseball' && setup.mode !== 'h2h';
  const isPracticeShanghai = setup.gameType === 'shanghai' && setup.mode !== 'h2h';
  const isPracticeHalveIt = setup.gameType === 'halve_it' && setup.mode !== 'h2h';
  const isDeadManWalking = gameType === 'dead_man_walking';
  const isPracticePressureChamber = setup.gameType === 'pressure_chamber' && setup.mode !== 'h2h';
  const legsPerSet = isDeadManWalking ? 15
    : (drillModes.includes(setup.mode) || isPracticeBaseball || isPracticeShanghai || isPracticeHalveIt || isPracticePressureChamber) ? 1 : setup.legsPerSet;
  const setsPerGame = isDeadManWalking ? 1
    : (drillModes.includes(setup.mode) || isPracticeBaseball || isPracticeShanghai || isPracticeHalveIt || isPracticePressureChamber) ? 1 : setup.setsPerGame;
  return { legsPerSet, setsPerGame };
}

function entryBody(key) {
  const re = new RegExp(`\\n {2}${key}: \\{[\\s\\S]*?\\n {2}\\}`);
  return (src.match(re) || [''])[0];
}
const isSoloOnly = (key) => /\n {4}soloOnly: true/.test(entryBody(key));

/* The wizard states a type can actually be in.
 *
 * NOT simply contextsForMode()'s answer. For a solo-only drill the wizard's `mode` IS
 * the game type — selectSetupGame() sets them together — and the pair (mode:'practice',
 * gameType:'doubles_practice') is unreachable by construction, because selecting any
 * non-drill mode resets setup.gameType back to 'x01'. That matters here: the sweep found
 * a genuine difference between the old and new implementations on exactly that pair, and
 * it is a difference between two answers to a question that is never asked. Sweeping it
 * would be asserting behaviour for an impossible state; the invariant that makes it
 * impossible is asserted separately below, so this assumption cannot rot quietly. */
function reachableModes(key) {
  const body = entryBody(key);
  if (/\n {4}h2hOnly: true/.test(body)) return ['h2h'];
  if (isSoloOnly(key)) return [key];
  return ['practice', 'h2h'];
}

describe('match units (legs/sets) per game type', () => {
  test('every registered type declares practiceUnit', () => {
    assert.ok(UNITS.size >= 16, `only ${UNITS.size} entries parsed`);
  });

  test('the registry agrees with the pre-refactor logic on every reachable case', () => {
    const chosen = [{ legsPerSet: 3, setsPerGame: 1 }, { legsPerSet: 5, setsPerGame: 3 },
                    { legsPerSet: 1, setsPerGame: 1 }];
    let checked = 0;
    for (const key of UNITS.keys()) {
      const modes = reachableModes(key);
      for (const mode of modes) {
        for (const pick of chosen) {
          const setup = { gameType: key, mode, ...pick };
          const got = resolveMatchUnits(setup, key);
          const want = referenceMatchUnits(setup, key);
          assert.deepEqual(got, want,
            `${key} / mode=${mode} / picked ${pick.legsPerSet}x${pick.setsPerGame}: ` +
            `registry says ${JSON.stringify(got)}, the old code said ${JSON.stringify(want)}`);
          checked++;
        }
      }
    }
    assert.ok(checked >= 48, `only ${checked} combinations swept`);
  });

  test('a solo-only drill can never be paired with mode "practice" — the sweep leans on this', () => {
    // selectSetupGame(): `if(!isDrill(mode) && isDrill(setup.gameType)) setup.gameType = 'x01'`.
    // That line is what makes (mode:'practice', gameType:<a drill>) unreachable, and it is
    // the reason reachableModes() does not sweep that pair. If it is ever removed, this
    // fails and says so, rather than the sweep quietly covering less than it claims.
    assert.match(src, /if\(!isDrill\(mode\) && isDrill\(setup\.gameType\)\) setup\.gameType = 'x01';/,
      'the guard that resets a drill gameType when leaving drill mode is gone — ' +
      'the unreachable-state assumption in reachableModes() no longer holds');
    assert.match(src, /if\(isDrill\(mode\)\) setup\.gameType = mode;/,
      'selecting a drill no longer sets gameType to match the mode');
  });

  test('Daily Challenge and Ghost stay 1/1 whatever the underlying type', () => {
    // Both are plain X01 underneath, so the answer cannot live on x01's entry — an
    // ordinary practice X01 must keep the legs the player chose. This is the assertion
    // that keeps those two axes from being fused back together.
    for (const mode of ['challenge', 'ghost']) {
      const got = resolveMatchUnits({ gameType: 'x01', mode, legsPerSet: 5, setsPerGame: 3 }, 'x01');
      assert.deepEqual(got, { legsPerSet: 1, setsPerGame: 1 }, `${mode} was not forced to 1/1`);
    }
    const normal = resolveMatchUnits({ gameType: 'x01', mode: 'practice', legsPerSet: 5, setsPerGame: 3 }, 'x01');
    assert.deepEqual(normal, { legsPerSet: 5, setsPerGame: 3 },
      'an ordinary practice X01 must keep the legs the player chose');
  });

  test('head-to-head keeps a real match for the four BUG-22 modes', () => {
    // The half of the rule that is easy to lose in a refactor: these are forced to 1/1
    // in practice ONLY. H2H Baseball as best-of-5 is exactly what people want.
    for (const key of ['baseball', 'shanghai', 'halve_it', 'pressure_chamber']) {
      const got = resolveMatchUnits({ gameType: key, mode: 'h2h', legsPerSet: 5, setsPerGame: 3 }, key);
      assert.deepEqual(got, { legsPerSet: 5, setsPerGame: 3 }, `${key} lost its H2H match structure`);
    }
  });

  test('Dead Man Walking is 15 legs, and is the only mode that is not 1/1 or free', () => {
    assert.deepEqual(UNITS.get('dead_man_walking'), { legsPerSet: 15, setsPerGame: 1 });
    const odd = [...UNITS].filter(([k, v]) => v && !(v.legsPerSet === 1 && v.setsPerGame === 1));
    assert.deepEqual(odd.map(([k]) => k), ['dead_man_walking'],
      'a second mode now forces something other than 1/1 — intended, or a typo?');
  });
});
