'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-32.
//
// Checkout Trainer proposes a route from memory — no dart is ever physically thrown,
// which is the whole point of a mode playable with no board in the room. The Pad
// already reflects that by hiding "Miss" and "Bounce Out" for this game type
// (REFERENCE.md §19). The dartboard input did not: it carries two full miss rings
// (near/far, one per wedge) sitting immediately outside the double ring — exactly
// where a thumb lands when it is aiming for the number printed at the board's edge.
//
// A mistap there records a genuine Miss, and a Miss turns a correct route into an
// illegal one. On target 50, [Miss, D16] grades "Not a legal finish for 50. Best
// route: Bull" — indistinguishable, from the player's side, from the app mis-grading
// a route they entered correctly. That is what a user reported.
//
// The grader itself was verified correct first (7,810 one- and two-dart routes across
// every target and both out modes, zero mismatches against ground truth), so the fix
// is to remove the input that cannot mean anything in this mode rather than to touch
// the maths. Both halves are asserted here: the arithmetic distinction that made the
// report look like a grading fault, and the structural change that prevents it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const S = require('../../frontend/scoring.js');
const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const src = () => fs.readFileSync(INDEX, 'utf8');

const dart = (sector, mult) => S.makeDartCore(sector, mult);

describe('BUG-32 — the grader is correct; a stray Miss is what made it look wrong', () => {
  test('the reported route grades legal but not optimal', () => {
    const g = S.gradeCheckoutAttempt(50, true, [dart(18, 1), dart(16, 2)]);
    assert.equal(g.legal, true, 'S18 + D16 reaches exactly 50 and finishes on a double');
    assert.equal(g.optimal, false, 'Bull does it in one, so two darts is not optimal');
    assert.equal(g.usedDarts, 2);
    assert.equal(g.optimalDarts, 1);
    assert.equal(g.hint, 'Bull');
  });

  test('the same route with a leading Miss is genuinely illegal — the message the user saw', () => {
    const g = S.gradeCheckoutAttempt(50, true, [dart(0, 1), dart(16, 2)]);
    assert.equal(g.legal, false, 'Miss + D16 only reaches 32, so it cannot finish 50');
    assert.equal(g.hint, 'Bull');
  });

  // Guards the whole grader, not just this one route — a scope regression anywhere
  // in evaluateVisit()/checkoutHint() would surface here rather than as another
  // "it told me my checkout was wrong" report.
  test('every 1- and 2-dart route matches ground truth for both out modes', () => {
    const beds = [];
    for (let n = 1; n <= 20; n++) for (const m of [1, 2, 3]) beds.push([n, m]);
    beds.push([25, 1], [25, 2]);
    const value = (s, m) => (s === 25 ? (m === 2 ? 50 : 25) : s * m);

    let checked = 0;
    for (const doubleOut of [true, false]) {
      for (let target = 2; target <= 170; target++) {
        for (const a of beds) {
          if (value(...a) === target) {
            const want = !doubleOut || a[1] === 2;
            assert.equal(S.gradeCheckoutAttempt(target, doubleOut, [dart(...a)]).legal, want,
              `1-dart ${JSON.stringify(a)} on ${target} (doubleOut=${doubleOut})`);
            checked++;
          }
          for (const b of beds) {
            if (value(...a) + value(...b) !== target) continue;
            const want = !doubleOut || b[1] === 2;
            assert.equal(S.gradeCheckoutAttempt(target, doubleOut, [dart(...a), dart(...b)]).legal, want,
              `2-dart ${JSON.stringify(a)}+${JSON.stringify(b)} on ${target} (doubleOut=${doubleOut})`);
            checked++;
          }
        }
      }
    }
    assert.ok(checked > 7000, `expected thousands of routes, checked ${checked}`);
  });
});

describe('BUG-32 — Checkout Trainer always scores on the Pad', () => {
  test('the registry marks it pad-only', () => {
    const s = src();
    const entry = s.match(/  checkout_trainer: \{[\s\S]*?\n  \},/);
    assert.ok(entry, 'GAME_TYPES.checkout_trainer not found in index.html');
    assert.match(entry[0], /padOnly: true/,
      'checkout_trainer must declare padOnly so the dartboard input is never offered');
  });

  test('the input mode is derived, and the household preference is not overwritten', () => {
    const s = src();
    const fn = s.match(/function boardInputActive\(\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'boardInputActive() not found');
    assert.match(fn[0], /dartboardMode && !padOnlyGame\(\)/,
      'the effective mode must be derived from the preference, not by mutating it');

    // The earlier draft did `if(padOnlyGame()) dartboardMode = false;` inside
    // applyDartMode(). It worked for the trainer and silently reset a board-preferring
    // household to the pad for every game afterwards. Nothing may assign dartboardMode
    // except setDartMode() and the boot-time settings fetch.
    const assignments = s.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(^|[^.\w])dartboardMode\s*=[^=]/.test(line))
      .filter(({ line }) => !line.startsWith('//'));
    const allowed = /function setDartMode|Backend\.get\('\/api\/settings\/default-input'\)|^let dartboardMode/;
    const unexpected = assignments.filter(({ line }) => !allowed.test(line));
    assert.deepEqual(unexpected.map(a => `${a.n}: ${a.line}`), [],
      'dartboardMode should only be assigned by setDartMode() or the boot-time settings fetch');
  });

  test('the toggle is hidden by a rule that actually beats the base display', () => {
    // `.imt-row{display:flex}` is an author declaration, and an author `display`
    // outranks the UA stylesheet's `[hidden]{display:none}` however weak its
    // selector — so without an explicit rule, setting `.hidden = true` on the row
    // does nothing at all and the toggle stays on screen. Same trap the scoring
    // screen's own .rail-play/.oche/.slots hit.
    assert.match(src(), /#game-header-controls \.imt-row\[hidden\]\{display:none\}/,
      'a scoped [hidden] rule is required for hiding the Pad/Dartboard toggle to work');
  });

  test('no render path still branches on the raw preference', () => {
    const s = src();
    // These three decide what is drawn; each must consult boardInputActive().
    assert.match(s, /setPressed\(\{pad:'imt-pad', board:'imt-board'\}, boardOn \? 'board' : 'pad'\)/);
    assert.match(s, /if\(boardInputActive\(\)\)\{\n\s*const board = document\.getElementById\('dart-board-wrap'\)/);
    assert.doesNotMatch(s, /\$\{dartboardMode \? 'Tap the board to score'/,
      'the instruction line must not tell a pad-only mode to tap a board it never shows');
  });
});
