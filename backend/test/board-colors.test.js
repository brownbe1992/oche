'use strict';
// Committed tests for Settings -> Board colours.
//
// The model these enforce: a dartboard has exactly TWO zone schemes, and each is
// a PAIR — the single bed and its double/treble ring always go together.
//
//     "Red & black"    black bed  (#1c1e1a) + red rings   (#c8102e)
//     "Green & white"  white bed  (#cbbf96) + green rings (#17752f)
//
// Sectors strictly alternate between the two, so the only structural choice is
// which scheme sector 20 gets.
//
// The bug this replaced is worth stating, because it is the thing these tests
// exist to prevent coming back: buildDartboard() used to pick the bed and the
// ring from two INDEPENDENT alternating lists (`i%2 ? tan : black` for the bed,
// `i%2 ? red : green` for the ring), which paired the TAN bed with the RED ring.
// No real dartboard has that combination — a red ring always sits on a black
// bed. Modelling a scheme as a pair makes the mismatch unrepresentable rather
// than merely corrected, and the "pairs never split" test below is what keeps it
// that way.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

describe('the two schemes are pairs, and a real board is the default', () => {
  test('sector 20 defaults to a black bed with red rings', () => {
    // This is what a real dartboard looks like, and it is a deliberate change
    // from what Oche drew before: 20 used to get the TAN bed with red rings.
    const c = S.resolveBoardColors({});
    assert.equal(c.sector20, 'red_black');
    assert.deepEqual(c.even, { single: '#1c1e1a', ring: '#c8102e' });
    assert.deepEqual(c.odd,  { single: '#cbbf96', ring: '#17752f' });
  });

  test('both schemes are always present with their stock colours', () => {
    const { schemes } = S.resolveBoardColors({});
    assert.deepEqual(Object.keys(schemes).sort(), ['green_white', 'red_black']);
    assert.equal(schemes.red_black.single, '#1c1e1a');
    assert.equal(schemes.red_black.ring, '#c8102e');
    assert.equal(schemes.green_white.single, '#cbbf96');
    assert.equal(schemes.green_white.ring, '#17752f');
  });

  test('choosing the other scheme for 20 swaps BOTH halves together', () => {
    // The whole point: you pick a scheme, not a bed and a ring separately.
    const c = S.resolveBoardColors({ sector20: 'green_white' });
    assert.deepEqual(c.even, { single: '#cbbf96', ring: '#17752f' });
    assert.deepEqual(c.odd,  { single: '#1c1e1a', ring: '#c8102e' });
  });

  test('a bed is never separated from its own ring', () => {
    // The regression guard for the original bug. Whatever is stored, and
    // whichever scheme sector 20 has, the pair that lands on the even sectors
    // must be one of the two DEFINED schemes — never a bed from one and a ring
    // from the other.
    const inputs = [
      {}, { sector20: 'green_white' }, { sector20: 'red_black' },
      { sector20: 'nonsense' }, { red_black_single: '#3060a0' },
      { green_white_ring: '#ffcc00', sector20: 'green_white' },
      { red_black_single: 'not-a-colour', green_white_ring: 42 },
    ];
    for (const input of inputs) {
      const c = S.resolveBoardColors(input);
      for (const side of ['even', 'odd']) {
        const match = Object.values(c.schemes).find(
          sch => sch.single === c[side].single && sch.ring === c[side].ring);
        assert.ok(match, `${JSON.stringify(input)} produced a split pair on ${side}: ${JSON.stringify(c[side])}`);
      }
      assert.notEqual(c.even.single, c.odd.single, 'the two sides must not be the same scheme');
    }
  });

  test('the two sides are always the two different schemes', () => {
    for (const sector20 of S.BOARD_SCHEME_IDS) {
      const c = S.resolveBoardColors({ sector20 });
      assert.deepEqual(c.even, { single: c.schemes[sector20].single, ring: c.schemes[sector20].ring });
      const other = S.BOARD_SCHEME_IDS.find(id => id !== sector20);
      assert.deepEqual(c.odd, { single: c.schemes[other].single, ring: c.schemes[other].ring });
    }
  });
});

describe('the schemes stay recolourable, but only as pairs', () => {
  test('a recoloured scheme travels with whichever side it is on', () => {
    const custom = { red_black_single: '#101820', red_black_ring: '#f2c14e' };
    const on20 = S.resolveBoardColors({ ...custom, sector20: 'red_black' });
    assert.deepEqual(on20.even, { single: '#101820', ring: '#f2c14e' });

    const off20 = S.resolveBoardColors({ ...custom, sector20: 'green_white' });
    assert.deepEqual(off20.odd, { single: '#101820', ring: '#f2c14e' },
      'the same pair, now on the alternate sectors — still together');
  });

  test('recolouring one scheme leaves the other alone', () => {
    const c = S.resolveBoardColors({ green_white_ring: '#00a0ff' });
    assert.equal(c.schemes.green_white.ring, '#00a0ff');
    assert.equal(c.schemes.green_white.single, '#cbbf96', 'its own bed is untouched');
    assert.deepEqual(c.schemes.red_black, S.resolveBoardColors({}).schemes.red_black);
  });

  test('one invalid colour falls back on its own', () => {
    const c = S.resolveBoardColors({ red_black_single: 'chartreuse', red_black_ring: '#f2c14e' });
    assert.equal(c.schemes.red_black.single, '#1c1e1a', 'the bad value falls back');
    assert.equal(c.schemes.red_black.ring, '#f2c14e', 'the good value in the same pair survives');
  });
});

describe('normalisation guards an SVG attribute sink', () => {
  test('normaliseBoardColor accepts exactly #rrggbb and lowercases', () => {
    assert.equal(S.normaliseBoardColor('#C8102E'), '#c8102e');
    assert.equal(S.normaliseBoardColor('#c8102e'), '#c8102e');
  });

  test('it rejects everything that could break out of the attribute', () => {
    const hostile = [
      '#c8102e" onload="alert(1)',           // closes the attribute, adds a handler
      '#c8102e"/><script>alert(1)</script>',  // closes the tag entirely
      'red',                                  // valid CSS, not the one format allowed
      'url(#x)',
      'javascript:alert(1)',
      '#c81',                                 // shorthand: valid CSS, deliberately refused
      '#c8102e ', ' #c8102e', '#gggggg', '',
      null, undefined, 42, {}, ['#c8102e'],
    ];
    for (const v of hostile) {
      assert.equal(S.normaliseBoardColor(v), null, `${JSON.stringify(v)} must be rejected`);
    }
  });

  test('normaliseSchemeId accepts only a known scheme', () => {
    assert.equal(S.normaliseSchemeId('red_black'), 'red_black');
    assert.equal(S.normaliseSchemeId('green_white'), 'green_white');
    for (const v of ['', 'RED_BLACK', 'blue', null, undefined, 0, {}]) {
      assert.equal(S.normaliseSchemeId(v), null, `${JSON.stringify(v)} must be rejected`);
    }
  });

  test('a hostile value stored in the database still cannot reach a client', () => {
    // db.getBoardColors() re-validates on READ, not only on write, so a restored
    // backup or a hand-edited settings row is contained too.
    const c = S.resolveBoardColors({
      red_black_single: '#c8102e" onload="alert(1)',
      green_white_ring: 'url(#x)',
      sector20: '"><script>alert(1)</script>',
    });
    assert.equal(c.sector20, 'red_black', 'an unknown scheme id falls back to the default');
    for (const side of ['even', 'odd']) {
      for (const v of Object.values(c[side])) assert.match(v, /^#[0-9a-f]{6}$/);
    }
    for (const sch of Object.values(c.schemes)) {
      assert.match(sch.single, /^#[0-9a-f]{6}$/);
      assert.match(sch.ring, /^#[0-9a-f]{6}$/);
    }
  });

  test('every resolved colour is a safe literal, whatever goes in', () => {
    const junk = [{}, undefined, null, { red_black_single: 1 }, { green_white_ring: [] },
                  { sector20: 12 }, { green_white_single: '#12345' }];
    for (const input of junk) {
      const c = S.resolveBoardColors(input);
      for (const side of ['even', 'odd']) {
        for (const v of Object.values(c[side])) {
          assert.match(v, /^#[0-9a-f]{6}$/, `${JSON.stringify(input)} produced ${v}`);
        }
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
    // Swept rather than spot-checked: an admin can put any colour under this
    // label, so "works for red" is not the property worth asserting.
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 51) {
          const bg = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
          const chosen = S.boardLabelColor(bg);
          const other = chosen === S.BOARD_LABEL_LIGHT ? S.BOARD_LABEL_DARK : S.BOARD_LABEL_LIGHT;
          assert.ok(S.contrastRatio(chosen, bg) >= S.contrastRatio(other, bg),
            `on ${bg} it picked the lower-contrast label`);
        }
      }
    }
  });

  test('both stock ring colours get a label above 4.5:1', () => {
    for (const id of S.BOARD_SCHEME_IDS) {
      const ring = S.BOARD_SCHEMES[id].ring;
      const ratio = S.contrastRatio(S.boardLabelColor(ring), ring);
      assert.ok(ratio >= 4.5, `${id} ring ${ring} only reaches ${ratio.toFixed(2)}:1`);
    }
  });
});

describe('the stock schemes are themselves distinguishable', () => {
  test('the two beds are far apart in luminance', () => {
    // The beds are the big areas, and they are what lets you read the
    // alternation at a glance, so they carry the burden here — WCAG's floor for
    // non-text UI components is 3:1 and the stock pair clears it nine times over.
    const a = S.BOARD_SCHEMES.red_black, b = S.BOARD_SCHEMES.green_white;
    assert.ok(S.contrastRatio(a.single, b.single) >= 3,
      `beds ${a.single}/${b.single} only ${S.contrastRatio(a.single, b.single).toFixed(2)}:1`);
  });

  test('the two rings are distinct colours (separated by hue, not luminance)', () => {
    // Deliberately NOT a contrast-ratio assertion. Red and green are ~1.3:1 apart
    // in luminance by nature, and darkening one to force a ratio would just make
    // a worse-looking board without helping the people it appears to help —
    // red/green confusion is a HUE problem, which is exactly what colorblind mode
    // exists to solve (it substitutes orange/blue for these two). Asserting a
    // luminance floor here would be a number that looks like accessibility work
    // while doing none.
    const a = S.BOARD_SCHEMES.red_black, b = S.BOARD_SCHEMES.green_white;
    assert.notEqual(a.ring, b.ring);
    const [ar, ag] = S.hexToRgb(a.ring), [br, bg] = S.hexToRgb(b.ring);
    assert.ok(ar > ag, `${a.ring} should read as the warm ring`);
    assert.ok(bg > br, `${b.ring} should read as the cool ring`);
  });

  test('within a scheme, the ring stands off its own bed', () => {
    for (const id of S.BOARD_SCHEME_IDS) {
      const { single, ring } = S.BOARD_SCHEMES[id];
      assert.ok(S.contrastRatio(single, ring) >= 1.9,
        `${id}: ring ${ring} on bed ${single} is only ${S.contrastRatio(single, ring).toFixed(2)}:1`);
    }
  });
});
