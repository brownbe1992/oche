'use strict';
// The turn loop's registry contract (docs/code-quality-roadmap.md item 64).
//
// render(), throwDart(), undoLastTurn() and enterTurn() used to open with four
// separately hand-maintained fifteen-branch `if(game.gameType === …)` chains —
// the same list of types written out four times, which is four chances for a
// new game type to be added to three of them. They now dispatch through
// GAME_TYPES, and this file is what makes that a contract rather than a
// convention: a type missing a member no longer falls through to X01's
// behaviour, it throws on the first frame, and this test says so before anyone
// has to discover it live.
//
// Source-level rather than behavioural on purpose. The behaviour is covered by
// the verify-ui `turn-loop` check, which drives every registered mode through
// throw → commit → undo and requires the state to come back identical; what
// that check cannot see is a type whose member is simply absent, because such a
// type fails at start-up and never reaches the assertions.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

// Each registry entry opens `  <key>: {\n    id: '<key>',` — the id line is
// what distinguishes a real entry from any other object literal in the file.
function registryEntries() {
  const out = new Map();
  const re = /\n {2}([a-z0-9_]+): \{\n {4}id: '([a-z0-9_]+)',/g;
  let m;
  while ((m = re.exec(src))) {
    assert.equal(m[1], m[2], `GAME_TYPES key "${m[1]}" and its id "${m[2]}" disagree`);
    // The entry body runs to the next entry's opening, or to the end of the
    // registry; a slice to the next `\n  <key>: {` is enough for member checks.
    const rest = src.slice(m.index + 1);
    const next = rest.search(/\n {2}[a-z0-9_]+: \{\n {4}id: '/);
    out.set(m[1], next === -1 ? rest.slice(0, 8000) : rest.slice(0, next));
  }
  return out;
}

const ENTRIES = registryEntries();
const member = (body, name) => {
  const m = body.match(new RegExp(`\\n {4}${name}: ([A-Za-z0-9_]+),`));
  return m ? m[1] : null;
};

describe('the GAME_TYPES turn-loop contract', () => {
  test('the registry was found and holds every game type', () => {
    assert.ok(ENTRIES.size >= 16, `only found ${ENTRIES.size} entries — did the registry's shape change?`);
    for (const key of ['x01', 'cricket', 'killer', 'around_the_clock', 'checkout_trainer']) {
      assert.ok(ENTRIES.has(key), `${key} missing from the parsed registry`);
    }
  });

  for (const name of ['render', 'throwDart', 'undoLastTurn', 'enterTurn']) {
    test(`every type declares ${name}() — there is no implicit X01 default any more`, () => {
      const missing = [...ENTRIES].filter(([, body]) => !member(body, name)).map(([k]) => k);
      assert.deepEqual(missing, [], `${name} missing on: ${missing.join(', ')}`);
    });
  }

  test('afterDart is declared by exactly the types that share throwDartVisit', () => {
    // The split is the point: seven types replace dart input wholesale, the
    // rest share one guard-and-push body and differ only in what follows. An
    // afterDart on a type with its own throwDart would never run — dead code
    // that reads as configuration — and a shared thrower with no afterDart
    // throws on the first dart.
    for (const [key, body] of ENTRIES) {
      const shared = member(body, 'throwDart') === 'throwDartVisit';
      const after = member(body, 'afterDart');
      if (shared) assert.ok(after, `${key} shares throwDartVisit but declares no afterDart`);
      else assert.equal(after, null, `${key} has its own throwDart, so its afterDart would never run`);
    }
  });

  test('every declared member names a function that actually exists', () => {
    // The failure this catches is a typo or a rename: the registry would still
    // parse, and the type would still start, and the very first dart would
    // throw "undefined is not a function" in front of a player mid-leg.
    for (const [key, body] of ENTRIES) {
      for (const name of ['render', 'throwDart', 'afterDart', 'undoLastTurn', 'enterTurn']) {
        const fn = member(body, name);
        if (!fn) continue;
        assert.ok(new RegExp(`function ${fn}\\s*\\(`).test(src),
          `${key}.${name} points at ${fn}(), which is not defined in index.html`);
      }
    }
  });

  test('the four old dispatch chains are gone, not merely bypassed', () => {
    // A leftover chain would keep working, and would keep being the thing
    // people edit — leaving the registry members as decoration that drifts.
    for (const fn of ['function renderGame(){', 'function undoLastTurn(){',
                      'function enterTurn(){', 'function throwDart(sector']) {
      const i = src.indexOf(fn);
      assert.ok(i > -1, `${fn} not found`);
      const head = src.slice(i, i + 900);
      assert.ok(!/if\(game\.gameType === '/.test(head),
        `${fn} still opens with a hand-maintained gameType chain`);
    }
  });
});
