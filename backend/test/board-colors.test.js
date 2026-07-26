'use strict';
// Committed tests for Settings -> Board colours.
//
// What the setting is FOR: a physical dartboard gets rotated periodically to
// spread the wear (20 and its treble take the most punishment) and the number
// ring is moved to match. Rotate by an ODD number of sectors and the 20 now sits
// on a white bed with green rings; rotate by an even number and it is back on
// black and red. This setting keeps the on-screen board looking like the one on
// the wall. It is one choice with two options — the colours themselves are fixed
// constants, because they are what a dartboard is rather than a preference.
//
// The model: a dartboard has exactly TWO zone schemes, and each is a PAIR — the
// single bed and its double/treble ring always go together.
//
//     "Red & black"    black bed (#1c1e1a) + red rings   (#c8102e)
//     "Green & white"  white bed (#cbbf96) + green rings (#17752f)
//
// The bug this model replaced is worth stating, because preventing its return is
// most of what these tests do: buildDartboard() used to pick the bed and the ring
// from two INDEPENDENT alternating lists (`i%2 ? tan : black` for the bed,
// `i%2 ? red : green` for the ring), which paired the TAN bed with the RED ring.
// No real dartboard has that combination — a red ring always sits on a black bed.
// Treating a scheme as an indivisible pair makes the mismatch unrepresentable
// rather than merely corrected, and the "pairs never split" test is what keeps it
// that way.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

describe('an unrotated board: 20 on a black bed with red rings', () => {
  test('that is the default', () => {
    // A deliberate change from what Oche drew before, where 20 got the TAN bed
    // with red rings — a pairing no real board has.
    const c = S.resolveBoardColors({});
    assert.equal(c.sector20, 'red_black');
    assert.deepEqual(c.even, { single: '#1c1e1a', ring: '#c8102e' });
    assert.deepEqual(c.odd,  { single: '#cbbf96', ring: '#17752f' });
  });

  test('a missing, null or undefined setting all mean the same thing', () => {
    for (const stored of [undefined, null, {}, { sector20: null }, { sector20: '' }]) {
      assert.deepEqual(S.resolveBoardColors(stored), S.resolveBoardColors({}),
        `${JSON.stringify(stored)} should resolve to the default board`);
    }
  });
});

describe('rotating the board flips which scheme sector 20 sits on', () => {
  test('choosing the other scheme swaps BOTH halves together', () => {
    // The point of the pair: you pick a scheme, never a bed and a ring
    // separately, so the swap moves the ring with its own bed.
    const c = S.resolveBoardColors({ sector20: 'green_white' });
    assert.deepEqual(c.even, { single: '#cbbf96', ring: '#17752f' });
    assert.deepEqual(c.odd,  { single: '#1c1e1a', ring: '#c8102e' });
  });

  test('flipping twice returns the original board', () => {
    // An even number of sector rotations puts 20 back where it started, which is
    // exactly the physical behaviour this models.
    const start = S.resolveBoardColors({ sector20: 'red_black' });
    const flipped = S.resolveBoardColors({ sector20: 'green_white' });
    const back = S.resolveBoardColors({ sector20: 'red_black' });
    assert.notDeepEqual(flipped.even, start.even);
    assert.deepEqual(back, start);
  });

  test('the two sides are always the two different schemes', () => {
    for (const sector20 of S.BOARD_SCHEME_IDS) {
      const c = S.resolveBoardColors({ sector20 });
      const other = S.BOARD_SCHEME_IDS.find(id => id !== sector20);
      assert.deepEqual(c.even, { single: S.BOARD_SCHEMES[sector20].single, ring: S.BOARD_SCHEMES[sector20].ring });
      assert.deepEqual(c.odd,  { single: S.BOARD_SCHEMES[other].single,    ring: S.BOARD_SCHEMES[other].ring });
    }
  });
});

describe('a bed is never separated from its own ring', () => {
  test('every input produces two intact, distinct schemes', () => {
    // The regression guard for the original bug. Whatever is stored — valid,
    // invalid or hostile — each side of the board must be one of the two DEFINED
    // schemes, never a bed from one and a ring from the other.
    const inputs = [
      undefined, null, {},
      { sector20: 'red_black' }, { sector20: 'green_white' },
      { sector20: 'nonsense' }, { sector20: '' }, { sector20: 12 }, { sector20: {} },
      { sector20: '"><script>alert(1)</script>' },
      // Colours are no longer configurable at all, so stray colour-ish keys must
      // be ignored outright rather than half-honoured.
      { sector20: 'red_black', red_black_single: '#ff0000' },
      { single: 'red', ring: 'green' },
    ];
    for (const input of inputs) {
      const c = S.resolveBoardColors(input);
      for (const side of ['even', 'odd']) {
        const match = Object.values(S.BOARD_SCHEMES).find(
          sch => sch.single === c[side].single && sch.ring === c[side].ring);
        assert.ok(match, `${JSON.stringify(input)} produced a split pair on ${side}: ${JSON.stringify(c[side])}`);
      }
      assert.notEqual(c.even.single, c.odd.single, 'the two sides must be different schemes');
      assert.notEqual(c.even.ring, c.odd.ring);
    }
  });

  test('stored colour values are ignored — the colours are not configurable', () => {
    // This is the property that removes the injection surface entirely: there is
    // no path from anything an admin can store to an SVG fill attribute.
    const c = S.resolveBoardColors({
      sector20: 'red_black',
      red_black_single: '#c8102e" onload="alert(1)',
      single: 'url(#x)', ring: 'javascript:alert(1)',
    });
    assert.deepEqual(c, S.resolveBoardColors({ sector20: 'red_black' }));
  });

  test('every resolved colour is a plain hex literal', () => {
    for (const input of [undefined, {}, { sector20: 'green_white' }, { sector20: 'junk' }]) {
      const c = S.resolveBoardColors(input);
      for (const side of ['even', 'odd']) {
        for (const v of Object.values(c[side])) {
          assert.match(v, /^#[0-9a-f]{6}$/, `${JSON.stringify(input)} produced ${v}`);
        }
      }
    }
  });
});

describe('normaliseSchemeId is the only validation the setting needs', () => {
  test('it accepts exactly the two known ids', () => {
    assert.equal(S.normaliseSchemeId('red_black'), 'red_black');
    assert.equal(S.normaliseSchemeId('green_white'), 'green_white');
  });

  test('it rejects everything else rather than guessing', () => {
    for (const v of ['', 'RED_BLACK', 'red', 'blue', '__proto__', 'toString',
                     null, undefined, 0, 1, {}, [], ['red_black']]) {
      assert.equal(S.normaliseSchemeId(v), null, `${JSON.stringify(v)} must be rejected`);
    }
  });
});

describe('the "Bull" label stays legible on whichever ring is under it', () => {
  // The inner bull takes SECTOR 20's ring colour, so this label is red on an
  // unrotated board and green on a rotated one. A fixed cream would have been
  // wrong for one of the two.
  test('both schemes get a label above 4.5:1', () => {
    for (const id of S.BOARD_SCHEME_IDS) {
      const ring = S.BOARD_SCHEMES[id].ring;
      const ratio = S.contrastRatio(S.boardLabelColor(ring), ring);
      assert.ok(ratio >= 4.5, `${id} ring ${ring} only reaches ${ratio.toFixed(2)}:1`);
    }
  });

  test('it reproduces the colorblind special case it replaced', () => {
    // The old code hardcoded cream on the classic red and near-black in
    // colorblind mode (whose lighter orange measured 2.58:1 against cream). The
    // general rule has to give the same two answers, or this was a regression
    // dressed up as a refactor.
    assert.equal(S.boardLabelColor('#c8102e'), S.BOARD_LABEL_LIGHT);
    assert.equal(S.boardLabelColor('#e2711d'), S.BOARD_LABEL_DARK);
  });

  test('it never picks the worse of the two options', () => {
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
});

describe('the two schemes are themselves distinguishable', () => {
  test('the beds are far apart in luminance', () => {
    // The beds are the big areas and are what lets you read the alternation at a
    // glance, so they carry the burden. WCAG's floor for non-text UI components
    // is 3:1; the stock pair clears it nine times over.
    const a = S.BOARD_SCHEMES.red_black, b = S.BOARD_SCHEMES.green_white;
    assert.ok(S.contrastRatio(a.single, b.single) >= 3,
      `beds ${a.single}/${b.single} only ${S.contrastRatio(a.single, b.single).toFixed(2)}:1`);
  });

  test('each ring stands off its own bed', () => {
    for (const id of S.BOARD_SCHEME_IDS) {
      const { single, ring } = S.BOARD_SCHEMES[id];
      assert.ok(S.contrastRatio(single, ring) >= 1.9,
        `${id}: ring ${ring} on bed ${single} is only ${S.contrastRatio(single, ring).toFixed(2)}:1`);
    }
  });

  test('the rings are separated by hue, not luminance — deliberately', () => {
    // NOT a contrast-ratio assertion. Red and green are ~1.3:1 apart in
    // luminance by nature, and darkening one to force a ratio would make a worse
    // board without helping the people it appears to help — red/green confusion
    // is a HUE problem, which is exactly what colorblind mode exists to solve
    // (it substitutes orange/blue for these two). A luminance floor here would be
    // a number that looks like accessibility work while doing none.
    const a = S.BOARD_SCHEMES.red_black, b = S.BOARD_SCHEMES.green_white;
    const [ar, ag] = S.hexToRgb(a.ring), [br, bg] = S.hexToRgb(b.ring);
    assert.ok(ar > ag, `${a.ring} should read as the warm ring`);
    assert.ok(bg > br, `${b.ring} should read as the cool ring`);
  });
});
