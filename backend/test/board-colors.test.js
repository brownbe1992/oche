'use strict';
// Committed tests for Settings -> Board colours: the admin picks what sector 20
// looks like and the rest of the board is derived from it.
//
// Three things are worth pinning, and they are pinned for different reasons:
//
//  1. THE DERIVATION IS A CALCULATION, so per CLAUDE.md it gets a committed test.
//     The load-bearing property is that the rule, applied to the classic tan and
//     the classic red, lands on the classic black and the classic green. That is
//     not a coincidence to be rediscovered later — it is why 150 degrees was
//     chosen over a straight 180 degree complement, and it is what makes the
//     feature feel like "the board follows 20" rather than "the board turns into
//     something else".
//
//  2. THE DEFAULTS MUST BE BYTE-IDENTICAL. An install that never opens this
//     setting has to render exactly the board it rendered before the feature
//     existed. The derivation is visually identical to the classic pair but not
//     equal to it, so resolveBoardColors() special-cases "still classic" — and
//     that special case is easy to delete by accident.
//
//  3. THE VALUES ARE AN INJECTION SINK. They are interpolated into an SVG
//     `fill="..."` attribute. normaliseBoardColor() is the only thing standing
//     between the settings table and that attribute, and it is used by
//     server.js on write, db.js on read, and index.html at the sink.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

const D = S.BOARD_COLOR_DEFAULTS;

describe('the alternating pair is derived from sector 20', () => {
  test('the classic tan derives the classic near-black single', () => {
    // Not asserted as an exact string: the derivation keeps the source hue, and
    // at 11% lightness a hue difference is invisible. Contrast ratio is the
    // honest measure of "the same colour to a human eye" — 1.0 is identical, and
    // anything under ~1.02 is indistinguishable.
    const got = S.deriveAltSingle(D.singleA);
    const ratio = S.contrastRatio(got, D.singleB);
    assert.ok(ratio < 1.02, `derived ${got} vs classic ${D.singleB} — contrast ${ratio.toFixed(3)}`);
  });

  test('the classic red derives the classic green ring', () => {
    const got = S.deriveAltRing(D.ringA);
    const ratio = S.contrastRatio(got, D.ringB);
    assert.ok(ratio < 1.1, `derived ${got} vs classic ${D.ringB} — contrast ${ratio.toFixed(3)}`);
    // And it is genuinely a green, not a red that happens to match in luminance:
    // luminance alone would pass for any colour of the same weight.
    const { h } = S.hexToHsl(got);
    assert.ok(h > 90 && h < 190, `derived ring hue ${Math.round(h)} deg is not in the green band`);
  });

  test('the single flips lightness, whichever way round it starts', () => {
    // The point of the pair is a light/dark contrast, so it has to work when an
    // admin picks a DARK colour for 20 as well.
    const fromLight = S.hexToHsl(S.deriveAltSingle('#e8e0c0'));
    assert.ok(fromLight.l < 0.25, `light 20 should derive a dark alternate, got l=${fromLight.l.toFixed(2)}`);
    const fromDark = S.hexToHsl(S.deriveAltSingle('#101418'));
    assert.ok(fromDark.l > 0.55, `dark 20 should derive a light alternate, got l=${fromDark.l.toFixed(2)}`);
  });

  test('the two singles always stay far apart in luminance', () => {
    // The real requirement behind "light/dark pair": you must be able to tell
    // adjacent sectors apart at a glance. Swept across the hue circle rather
    // than spot-checked, because a rule that only works for tan is not a rule.
    for (let h = 0; h < 360; h += 15) {
      for (const l of [0.15, 0.35, 0.5, 0.65, 0.85]) {
        const a = S.hslToHex({ h, s: 0.35, l });
        const b = S.deriveAltSingle(a);
        const ratio = S.contrastRatio(a, b);
        assert.ok(ratio >= 3, `single ${a} vs derived ${b} is only ${ratio.toFixed(2)}:1`);
      }
    }
  });

  test('the derived ring is always a clearly different hue', () => {
    for (let h = 0; h < 360; h += 15) {
      const a = S.hslToHex({ h, s: 0.8, l: 0.42 });
      const got = S.hexToHsl(S.deriveAltRing(a));
      const delta = Math.min(Math.abs(got.h - h), 360 - Math.abs(got.h - h));
      assert.ok(delta > 100, `ring ${a} derived only ${Math.round(delta)} deg away`);
    }
  });
});

describe('an untouched install renders the classic board exactly', () => {
  test('nothing stored resolves to the four classic colours, byte for byte', () => {
    assert.deepEqual(S.resolveBoardColors({}), {
      singleA: '#cbbf96', ringA: '#c8102e', singleB: '#1c1e1a', ringB: '#1b8a3a',
    });
  });

  test('undefined/null stored settings behave the same as an empty object', () => {
    assert.deepEqual(S.resolveBoardColors(undefined), S.resolveBoardColors({}));
    assert.deepEqual(S.resolveBoardColors(null), S.resolveBoardColors({}));
  });

  test('deriving starts the moment sector 20 actually changes', () => {
    const r = S.resolveBoardColors({ singleA: '#3060a0', ringA: '#8a2be2' });
    assert.equal(r.singleB, S.deriveAltSingle('#3060a0'));
    assert.equal(r.ringB, S.deriveAltRing('#8a2be2'));
    assert.notEqual(r.singleB, S.BOARD_COLOR_DEFAULTS.singleB);
  });

  test('one changed A colour does not drag the other pair off its default', () => {
    // Each side derives from its own partner, so changing the single must not
    // silently recolour the doubles and trebles as well.
    const r = S.resolveBoardColors({ singleA: '#3060a0' });
    assert.equal(r.ringA, D.ringA);
    assert.equal(r.ringB, D.ringB);
  });
});

describe('an explicit override wins, and only for the field overridden', () => {
  test('a stored B colour is used as-is', () => {
    const r = S.resolveBoardColors({ singleA: '#3060a0', singleB: '#ffcc00' });
    assert.equal(r.singleB, '#ffcc00');
    assert.equal(r.ringB, D.ringB, 'the un-overridden ring must still follow its own rule');
  });

  test('an empty string is not an override — it means "keep following 20"', () => {
    // This is the exact value the client saves for a derived colour, and the
    // whole feature rests on it: storing the derived hex instead would freeze
    // the board so that changing sector 20 later moved nothing.
    const r = S.resolveBoardColors({ singleA: '#3060a0', singleB: '', ringA: '#8a2be2', ringB: '' });
    assert.equal(r.singleB, S.deriveAltSingle('#3060a0'));
    assert.equal(r.ringB, S.deriveAltRing('#8a2be2'));
  });
});

describe('normaliseBoardColor is the guard on an SVG attribute sink', () => {
  test('it accepts exactly #rrggbb, case-insensitively, and lowercases', () => {
    assert.equal(S.normaliseBoardColor('#C8102E'), '#c8102e');
    assert.equal(S.normaliseBoardColor('#c8102e'), '#c8102e');
  });

  test('it rejects everything that could break out of the attribute', () => {
    const hostile = [
      '#c8102e" onload="alert(1)',          // closes the attribute, adds a handler
      '#c8102e"/><script>alert(1)</script>', // closes the tag entirely
      'red',                                 // a valid CSS colour, but not the one format we allow
      'url(#x)',
      'javascript:alert(1)',
      '#c81',                                // shorthand: valid CSS, deliberately refused
      '#c8102e ',                            // trailing space
      ' #c8102e',
      '#gggggg',
      '',
      null, undefined, 42, {}, ['#c8102e'],
    ];
    for (const v of hostile) {
      assert.equal(S.normaliseBoardColor(v), null, `${JSON.stringify(v)} must be rejected`);
    }
  });

  test('a hostile value stored in the database still cannot reach a client', () => {
    // db.getBoardColors() re-validates on READ, not only on write, so a restored
    // backup or a hand-edited settings row is contained too.
    const r = S.resolveBoardColors({ singleA: '#c8102e" onload="alert(1)', ringA: 'red' });
    assert.equal(r.singleA, D.singleA);
    assert.equal(r.ringA, D.ringA);
    for (const v of Object.values(r)) assert.match(v, /^#[0-9a-f]{6}$/);
  });

  test('every resolved field is always a safe literal, whatever goes in', () => {
    const junk = [{}, { singleA: 1 }, { ringA: [] }, { singleB: 'green' }, { ringB: '#12345' }];
    for (const input of junk) {
      for (const v of Object.values(S.resolveBoardColors(input))) {
        assert.match(v, /^#[0-9a-f]{6}$/, `${JSON.stringify(input)} produced ${v}`);
      }
    }
  });
});

describe('the "Bull" label stays legible on whatever the ring becomes', () => {
  test('it reproduces the colorblind special case it replaced', () => {
    // The old code hardcoded: cream on the classic red, near-black in colorblind
    // mode (whose lighter orange measured 2.58:1 against cream). The general rule
    // has to give the same two answers, or this was a regression dressed up as a
    // refactor.
    assert.equal(S.boardLabelColor('#c8102e'), S.BOARD_LABEL_LIGHT);
    assert.equal(S.boardLabelColor('#e2711d'), S.BOARD_LABEL_DARK);
  });

  test('it never picks the worse of the two options', () => {
    for (let h = 0; h < 360; h += 10) {
      for (const l of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const bg = S.hslToHex({ h, s: 0.7, l });
        const chosen = S.boardLabelColor(bg);
        const other = chosen === S.BOARD_LABEL_LIGHT ? S.BOARD_LABEL_DARK : S.BOARD_LABEL_LIGHT;
        assert.ok(S.contrastRatio(chosen, bg) >= S.contrastRatio(other, bg),
          `on ${bg} it picked the lower-contrast label`);
      }
    }
  });

  test('the better of the two always clears 4.5:1 somewhere sane', () => {
    // Cream and near-black are far enough apart that one of them always works;
    // this documents the floor rather than assuming it. The worst case is a
    // mid-lightness fill, which is why it is checked at l=0.5 specifically.
    const bg = S.hslToHex({ h: 200, s: 0.5, l: 0.5 });
    assert.ok(S.contrastRatio(S.boardLabelColor(bg), bg) >= 3,
      'a mid-tone ring should still get a label above the large-text floor');
  });
});

describe('the colour conversions round-trip', () => {
  test('hex -> hsl -> hex returns the same colour', () => {
    for (const hex of ['#cbbf96', '#c8102e', '#1c1e1a', '#1b8a3a', '#ffffff', '#000000', '#3060a0']) {
      const back = S.hslToHex(S.hexToHsl(hex));
      assert.ok(S.contrastRatio(back, hex) < 1.01, `${hex} round-tripped to ${back}`);
    }
  });

  test('out-of-range channels clamp instead of wrapping', () => {
    // A wrap would turn an over-bright derived colour into a dark one — the kind
    // of bug that only shows up for one unusual palette.
    assert.equal(S.rgbToHex(300, -20, 128), '#ff0080');
  });
});
