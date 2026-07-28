'use strict';
// Committed tests for the Pocket Card and Paper Mode (/frontend-design direction A,
// 2026-07) — Checkout Trainer surfaced on Home as the checkout card it actually is,
// and its play area restyled to match.
//
// These are structural//contrast assertions rather than behavioural ones: the card's
// grading is not its own code (that would be the bug worth guarding), it delegates to
// the same scoring.js functions the real mode uses. What CAN silently regress is the
// delegation itself, the "not recorded" promise the card makes to the household, the
// one CSS trap this layout has already sprung twice, and the contrast of a palette
// that is the only light surface in a dark app.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../../frontend/scoring.js');
// Markup + stylesheet, since the assertions below span both — see
// frontend-source.js for why they are read together.
const { pageSource: src } = require('./frontend-source.js');

// Relative luminance / WCAG contrast, so the paper palette is checked rather than
// eyeballed — docs/accessibility-roadmap.md holds this app to 4.5:1 for text.
const rgb = h => [1, 3, 5].map(i => parseInt(h.replace('#', '').slice(i - 1, i + 1), 16));
const lum = h => {
  const [r, g, b] = rgb(h).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const PAPER = '#efe7d2';

describe('Pocket Card — grading is delegated, never reimplemented', () => {
  test('it calls scoring.js for both the target and the verdict', () => {
    const s = src();
    const fn = s.match(/function pocketNewTarget\(\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'pocketNewTarget() not found');
    assert.match(fn[0], /pickCheckoutTarget\(/, 'the target must come from the shared picker');

    const check = s.match(/function pocketCheck\(\)\{[\s\S]*?\n\}/);
    assert.ok(check, 'pocketCheck() not found');
    assert.match(check[0], /gradeCheckoutAttempt\(/,
      'the verdict must come from the shared grader, so the card can never disagree with the real mode');
  });

  test('the card records nothing', () => {
    // The promise printed on the card ("Warm-ups here aren't recorded") is the reason
    // it needs no player, and the reason a passer-by tapping it cannot corrupt
    // somebody's Accuracy/Optimal%/streak. If a write ever appears in these
    // functions, that promise is silently broken.
    const s = src();
    const names = ['pocketNewTarget', 'pocketSetMult', 'pocketThrow', 'pocketUndo',
      'pocketCheck', 'pocketNext', 'renderPocketCard'];
    for (const n of names) {
      const fn = s.match(new RegExp(`function ${n}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
      assert.ok(fn, `${n}() not found`);
      assert.doesNotMatch(fn[0], /DB\.(recordTurn|addTurn|createGame|awardBadge)/,
        `${n}() must not write anything — the card is explicitly unrecorded`);
    }
    assert.match(s, /Warm-ups here aren't recorded/,
      'the card must say so, not just behave so');
  });

  test('the double-out assumption is stated where it is made', () => {
    // The card has no player, so it cannot honour a per-player single-out rule; it
    // grades double-out and says "Double out" on its face. Those two must agree.
    const s = src();
    assert.match(s.match(/function pocketCheck\(\)\{[\s\S]*?\n\}/)[0], /gradeCheckoutAttempt\(pocketDrill\.target, true,/);
    assert.match(s, /Double out · fewest darts/);
  });
});

describe('Paper Mode — the surface, and the trap it has to avoid', () => {
  test('the registry drives it and leaving the screen clears it', () => {
    const s = src();
    assert.match(s, /paperTheme: true/, 'checkout_trainer must declare paperTheme');
    assert.match(s, /classList\.toggle\('paper-mode',\s*\n?\s*name==='game'/,
      'paper-mode must be toggled by show(), so any exit from the game screen clears it');
  });

  test('the sheet is painted on an element that actually has a box', () => {
    // .game-play-area is `display:contents` — it generates no box, so a background
    // set on it silently does nothing and leaves ink-coloured text on the black
    // board. That is exactly how the first attempt looked.
    const s = src();
    assert.match(s, /\.game-play-area\{display:contents\}/,
      'assumption check: .game-play-area is still display:contents');
    assert.doesNotMatch(s, /body\.paper-mode \.game-play-area\{[^}]*background:/,
      'paper must not be painted on a display:contents wrapper');
    assert.match(s, /body\.paper-mode #screen-game\.on\{[\s\S]{0,200}background:linear-gradient/,
      'paper should be painted on #screen-game, which is a real box');
  });

  test('the dark input panel is cleared, or it is a black well in the sheet', () => {
    assert.match(src(), /body\.paper-mode \.oche\{background:transparent/);
  });
});

describe('Paper palette meets the contrast standard', () => {
  // These CAPTURE the colour out of the stylesheet and check that, rather than
  // checking a list copied here — an earlier draft asserted a hand-written list and
  // happily passed when the CSS was reverted to a failing colour, because the value
  // it was testing still existed somewhere else in the file. docs/accessibility-roadmap.md
  // holds this app to 4.5:1 for text; two colours (#8a6a1f at 4.09:1, #aa9f80 at
  // 2.13:1) were caught failing by this check while the theme was being built.
  const onPaper = [
    ['empty slot placeholder', /body\.paper-mode \.slot \.ph\{color:(#[0-9a-f]{6})\}/],
    ['target/round accent', /body\.paper-mode \.pscore \.co-inline\{color:(#[0-9a-f]{6})\}/],
    ['status handwriting', /body\.paper-mode \.status\{[\s\S]{0,120}?color:(#[0-9a-f]{6})/],
    ['status bust', /body\.paper-mode \.status\.bust\{color:(#[0-9a-f]{6})\}/],
    ['status win', /body\.paper-mode \.status\.win\{color:(#[0-9a-f]{6})\}/],
    ['pocket eyebrow/soft', /\.pocket \.pk-sub\{[\s\S]{0,80}?color:var\(--paper-soft\)/],
    ['pocket question', /\.pocket \.pk-q\{[\s\S]{0,140}?color:(#[0-9a-f]{6})\}/],
    ['pocket slot placeholder', /\.pocket \.pk-slot\{[\s\S]{0,200}?color:(#[0-9a-f]{6})/],
    ['pocket ghost button', /\.pocket \.pk-btn\{[\s\S]{0,220}?color:(#[0-9a-f]{6})\}/],
    ['pocket accent link', /\.pocket \.pk-foot a\{color:(#[0-9a-f]{6})/],
  ];

  for (const [name, re] of onPaper) {
    test(`${name} reaches 4.5:1 on paper`, () => {
      const m = src().match(re);
      assert.ok(m, `${name}: rule not found — has the selector changed?`);
      if (!m[1]) return;   // resolved via a var() checked separately below
      const r = contrast(m[1], PAPER);
      assert.ok(r >= 4.5, `${name} is ${m[1]}, ${r.toFixed(2)}:1 on ${PAPER}`);
    });
  }

  test('the --paper-soft token itself passes', () => {
    const m = src().match(/--paper-rule:#[0-9a-f]{6}; *--paper-soft:(#[0-9a-f]{6})/);
    assert.ok(m, '--paper-soft not found in the .pocket token block');
    const r = contrast(m[1], PAPER);
    assert.ok(r >= 4.5, `--paper-soft ${m[1]} is ${r.toFixed(2)}:1`);
  });

  test('ink-filled slots and keys are legible in reverse', () => {
    assert.ok(contrast(PAPER, '#14160f') >= 4.5);
    assert.ok(contrast('#cdc4a8', '#14160f') >= 4.5, 'the points sub-label inside a filled slot');
  });
});

describe('Colorblind mode reaches the paper surfaces too', () => {
  // body.colorblind remaps --red to orange and --green to blue, because red/green is
  // the pairing this app leans on. The paper rules hardcode their own red/green (the
  // dark-board tokens are far too light on cream — #e2711d and #2f8fd9 measure
  // 2.58:1 and 2.81:1 there), so without explicit overrides this one screen silently
  // ignores a setting the rest of the app honours.
  const overrides = [
    ['scoring status bust', /body\.colorblind\.paper-mode \.status\.bust,\s*\n\s*body\.colorblind\.paper-mode \.pad button\.bull\{color:(#[0-9a-f]{6})\}/],
    ['scoring status win', /body\.colorblind\.paper-mode \.status\.win\{color:(#[0-9a-f]{6})\}/],
    ['pocket verdict bad', /body\.colorblind \.pocket \.pk-verdict\.bad,\s*\n\s*body\.colorblind \.pocket \.pk-nums button\.bull\{color:(#[0-9a-f]{6})\}/],
    ['pocket verdict good', /body\.colorblind \.pocket \.pk-verdict\.good\{color:(#[0-9a-f]{6})\}/],
  ];

  for (const [name, re] of overrides) {
    test(`${name} has a colorblind override that passes on paper`, () => {
      const m = src().match(re);
      assert.ok(m, `${name}: no colorblind override found for the paper surface`);
      const r = contrast(m[1], PAPER);
      assert.ok(r >= 4.5, `${name} override ${m[1]} is ${r.toFixed(2)}:1 on paper`);
    });
  }

  test('the overrides are orange/blue, not another red/green pair', () => {
    // The whole point is escaping red vs green. Check the two hues actually differ
    // on the red-green axis the setting exists to avoid: the "bad" colour must be
    // warmer (more red than blue) and the "good" colour cooler (more blue than red).
    const bad = src().match(new RegExp(String.raw`body\.colorblind\.paper-mode \.status\.bust,[\s\S]*?button\.bull\{color:(#[0-9a-f]{6})\}`))[1];
    const good = src().match(/body\.colorblind\.paper-mode \.status\.win\{color:(#[0-9a-f]{6})\}/)[1];
    const [br, , bb] = rgb(bad), [gr, , gb] = rgb(good);
    assert.ok(br > bb, `bust colour ${bad} should read warm (r>b)`);
    assert.ok(gb > gr, `win colour ${good} should read cool (b>r)`);
  });
});

describe('the shared grader still backs the card', () => {
  test('a 3-dart optimal route on 167 is the one the card would praise', () => {
    const g = S.gradeCheckoutAttempt(167, true, [S.makeDartCore(20, 3), S.makeDartCore(19, 3), S.makeDartCore(25, 2)]);
    assert.equal(g.legal, true);
    assert.equal(g.optimal, true);
    assert.equal(g.hint, 'T20 T19 Bull');
  });
});
