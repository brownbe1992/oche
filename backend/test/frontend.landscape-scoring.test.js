'use strict';
// Committed tests for the 2026-07 landscape/tablet scoring-screen work.
//
// Three separate things are guarded here, and only the third is cosmetic:
//
//  1. The BOARD GEOMETRY IS UNCHANGED. The whole point of the layout change was
//     that the accuracy improvement comes from drawing the board bigger, NOT from
//     enlarging any hit area beyond the shape drawn under it. That is a promise
//     about behaviour, and it is exactly the kind of thing a future "let's make
//     the doubles easier to hit" patch would quietly break, so the radii are
//     pinned here with the reason attached.
//
//  2. The PORTRAIT LAYOUT IS UNCHANGED. The one rule that actually unlocked the
//     bigger board — releasing `.wrap`'s 760px cap — is a rule portrait shares and
//     genuinely wants. It must only ever be overridden inside the landscape media
//     query. (Portrait geometry was also diffed live at 390x844 against the
//     pre-change build and came back byte-identical; this is the cheap, permanent
//     version of that check.)
//
//  3. The pad/board HINT COPY comes from one helper. Four per-dart modes each
//     re-rendered their own status line with the PAD wording hardcoded, so a
//     household playing on the dartboard was told to "select a multiplier" —
//     controls that are not on screen — from the first dart onward.
//
// These are source-level assertions because index.html is a single inline-JS file
// with no module boundary to import; the live behaviour is covered by the
// verify-ui browser suite.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Markup + stylesheet, since the assertions below span both — see
// frontend-source.js for why they are read together.
const { pageSource: src } = require('./frontend-source.js');

// The landscape block, isolated. Everything scoped to tablets must live INSIDE
// this; anything that leaks out of it lands on portrait too.
function landscapeBlock(s) {
  const start = s.indexOf('@media (orientation:landscape) and (min-width:700px){');
  assert.ok(start > -1, 'the landscape media query has been renamed or removed');
  // Brace-match to the end of the at-rule.
  let depth = 0, i = s.indexOf('{', start);
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return s.slice(start, j + 1);
  }
  throw new Error('unbalanced braces in the landscape media query');
}

describe('the bigger board is scale only — no hit area is enlarged', () => {
  test('BOARD_GEOM radii are unchanged', () => {
    // buildDartboard() draws every sector, ring and miss band from these, and the
    // SVG scales as a whole (viewBox + preserveAspectRatio), so a double at 3x
    // size still covers exactly the same fraction of the board it always did.
    // If a future change wants to widen the double ring, that is a real gameplay
    // decision and this test is where it gets argued — it must not ride in as a
    // side effect of a layout tweak.
    const m = src().match(/const R = \{ bullIn:(\d+), bullOut:(\d+), trebleIn:(\d+), trebleOut:(\d+), doubleIn:(\d+), doubleOut:(\d+), numAt:(\d+), bg:(\d+), missNear:(\d+), missFar:(\d+) \}/);
    assert.ok(m, "BOARD_GEOM's radius table not found in its expected shape");
    assert.deepEqual(m.slice(1).map(Number),
      [20, 38, 118, 140, 190, 212, 231, 248, 270, 310]);
  });

  test('the board SVG still fills its container rather than a fixed pixel box', () => {
    // The board was 400px on an 1180px tablet not because of a max-width on the
    // SVG (there never was one — the 360px cap belongs to the stats-page heatmap,
    // a different builder) but because its COLUMN was 422px wide. "meet" fits the
    // square to the shorter of the container's two dimensions, so the container
    // is the only thing that decides the size. Pin that, so a well-meaning
    // `max-width` added here can't silently undo the whole change.
    const s = src();
    const svg = s.match(/let s = `<svg viewBox="0 0 660 660"[\s\S]{0,400}?preserveAspectRatio="xMidYMid meet">/);
    assert.ok(svg, "buildDartboard()'s <svg> opening tag not found");
    assert.match(svg[0], /width:100%;height:100%/);
    assert.doesNotMatch(svg[0], /max-width|max-height/,
      'the input board must size from its container, never a fixed pixel cap');
  });
});

describe('portrait is not touched by the landscape work', () => {
  const shared = [
    // [what it is, the rule that must stay portrait's, the override that must be landscape-only]
    // `[^}]*` rather than a character budget: the portrait rule opens with a long
    // explanatory comment, but neither it nor the declarations contain a brace,
    // so this stays anchored to that one rule and can't drift into the next.
    ['the 760px game-screen cap', /body\.game-active \.wrap\{[^}]*max-width:760px/, /body\.game-active \.wrap\{max-width:none\}/],
  ];

  for (const [name, portraitRule, landscapeOverride] of shared) {
    test(`${name} survives, and its override is inside the media query`, () => {
      const s = src();
      assert.match(s, portraitRule, `${name}: the portrait rule is gone`);
      assert.match(landscapeBlock(s), landscapeOverride,
        `${name}: the override must live inside the landscape media query`);
      // And nowhere else — an identical rule at top level would hit portrait too.
      const all = s.match(new RegExp(landscapeOverride.source, 'g')) || [];
      assert.equal(all.length, 1, `${name}: the override appears ${all.length} times; it must appear exactly once, inside the media query`);
    });
  }

  test('the board-tap flash is landscape-only', () => {
    // It is inserted into the markup unconditionally (both the static skeleton
    // and renderGame()'s rebuilt one), so `display:none` at base is the only
    // thing keeping it out of the portrait stack, where it would otherwise flow
    // in between the status line and the board.
    const s = src();
    assert.match(s, /\.dart-flash\{display:none\}/,
      'the flash must be display:none at base so portrait never renders it');
    assert.match(landscapeBlock(s), /body\.game-active \.dart-flash\{[\s\S]{0,400}?display:flex/,
      'and must only be turned on inside the landscape media query');
  });

  test('the three-across dart row is still what portrait gets', () => {
    assert.match(src(), /\.slots\{display:grid;grid-template-columns:repeat\(3,1fr\)/);
  });
});

describe('every dart in the current turn is individually undoable', () => {
  test('undoDart() is expressed through undoToDart(), not a second implementation', () => {
    // Two copies of "pop, clear bust/won, re-render, push" is how the button and
    // the row would drift into disagreeing about what an undo does.
    const s = src();
    assert.match(s, /function undoDart\(\)\{ undoToDart\(game\.darts\.length - 1\); \}/);
    const fn = s.match(/function undoToDart\(keep\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'undoToDart() not found');
    assert.match(fn[0], /game\.darts\.length = keep/);
    assert.match(fn[0], /game\.busted=false; game\.won=false/,
      'walking a turn back must clear a bust the removed darts caused');
    assert.match(fn[0], /renderSlots\(\); renderPad\(\); updateCheckout\(false\); pushLive\(\)/,
      'the live scoreboard must see the undo too');
  });

  test('a filled slot is a real button; an empty one is not focusable', () => {
    const s = src();
    const fn = s.match(/function renderSlots\(\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'renderSlots() not found');
    assert.match(fn[0], /createElement\(d \? 'button' : 'div'\)/);
    assert.match(fn[0], /div\.onclick=\(\)=>undoToDart\(i\)/);
    assert.match(fn[0], /aria-label[\s\S]{0,80}?Undo back to this dart/,
      'the control needs a name that says what it does, not just the dart label');
    assert.match(fn[0], /i===game\.darts\.length-1 \? ' latest'/,
      'the most recent dart must be marked');
  });

  test('the recency marker is not carried by colour alone', () => {
    // .slot.t / .slot.d already spend the red/green channel on treble/double,
    // and body.colorblind remaps exactly those two — a third colour here would
    // be both crowded and unreadable for the setting this app already honours.
    assert.match(src(), /\.slot\.latest\{box-shadow:0 0 0 2px var\(--gold\) inset\}/);
  });
});

describe('the input hint matches the input that is actually on screen', () => {
  test('padOrBoardHint() derives the wording from boardInputActive()', () => {
    const fn = src().match(/function padOrBoardHint\(suffix\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'padOrBoardHint() not found');
    assert.match(fn[0], /boardInputActive\(\) \? 'Tap the board to score' : 'Select a multiplier, then tap a number'/);
  });

  test('no render path hardcodes the pad wording any more', () => {
    // This is the actual regression. renderGame() built the hint correctly, then
    // renderGameChuckin()/DoublesPractice()/AroundTheClock()/AroundTheWorld()
    // overwrote it with the pad copy on their next render — which, in a per-dart
    // mode, is after every single dart.
    const s = src();
    const stray = [...s.matchAll(/status\.textContent = '(Select a multiplier[^']*)'/g)];
    assert.deepEqual(stray.map(m => m[1]), [],
      'a status line still hardcodes the pad wording; call padOrBoardHint() instead');
  });

  test('all five hint sites go through the helper', () => {
    const s = src();
    const calls = s.match(/padOrBoardHint\(/g) || [];
    // 1 declaration + 5 renderGame() arms + 4 per-dart re-render paths.
    assert.ok(calls.length >= 10,
      `expected the helper at every hint site, found ${calls.length} references`);
  });
});

describe('the board-tap flash', () => {
  test('it fires from the board entry point only, and holds ~1.5s', () => {
    // A PAD tap needs no confirmation — the button has the score written on it.
    // A BOARD tap does, which is the whole reason this lives in throwDartBoard()
    // rather than throwDart().
    const s = src();
    const fn = s.match(/function throwDartBoard\([^)]*\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'throwDartBoard() not found');
    assert.match(fn[0], /flashDartScore\(dartLabel\(sector, m\)\)/,
      'the flash must show the same label scoring.js gives the dart');
    assert.match(s, /dartFlashTimer = setTimeout\(\(\)=>\{ el\.classList\.remove\('on'\); \}, 1500\)/);
    assert.match(s, /clearTimeout\(dartFlashTimer\)/,
      'a second tap must cancel the first tap fade, not race it');
  });

  test('it is cleared by both kinds of undo', () => {
    // A score left glowing over a turn that no longer contains it reads as a dart
    // that just registered.
    const s = src();
    assert.match(s.match(/function undoToDart\(keep\)\{[\s\S]*?\n\}/)[0], /clearDartFlash\(\)/);
    assert.match(s.match(/function _finishUndo\([^)]*\)\{[\s\S]*?\n\}/)[0], /clearDartFlash\(\)/);
  });

  test('it is aria-hidden in both places the markup is built', () => {
    // It repeats what the slots and status line already say. A live region here
    // would make a screen reader announce every dart twice.
    const s = src();
    const nodes = s.match(/<div class="dart-flash" id="dart-flash" aria-hidden="true"><\/div>/g) || [];
    assert.equal(nodes.length, 2,
      'both the static #screen-game skeleton and renderGame()\'s rebuilt play area need it');
  });
});
