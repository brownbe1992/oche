'use strict';
// Committed regression test for docs/security-audit-roadmap.md SEC-18: the live
// Chuckin heatmap tooltip in frontend/display.html interpolated a broadcast payload
// value (c.hits, from /api/live's unrestricted-shape per-player array) into SVG
// <title> markup without coercion or escaping, which is assigned to the DOM via
// innerHTML in renderState() — a crafted /api/live payload could inject a script
// executing on every connected /display screen.
//
// display.html has no build step and isn't require()-able as a module, so this
// extracts buildChuckinLiveHeatmap() (and its one dependency, DB_SECTORS) directly
// out of the real file's source via a targeted regex and evaluates it in a fresh
// vm context — the same "test the function's actual current source, not a
// hand-copied duplicate that can drift" approach a build-step-free single-file app
// needs. If the function is ever renamed/restructured, this test fails loudly
// (the regex won't match) rather than silently testing stale code.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DISPLAY_HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'display.html');

function loadBuildChuckinLiveHeatmap() {
  const src = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
  const dbSectorsMatch = src.match(/^const DB_SECTORS = \[[^\]]*\];/m);
  // BOARD_GEOM: the shared CX/CY/R/xy/annulus geometry kernel buildChuckinLiveHeatmap()
  // destructures from, extracted the same "real source, not a hand-copied duplicate"
  // way as everything else here — added once buildClockBoard() (Around the Clock's
  // live board) became a second consumer and the geometry was pulled out of
  // buildChuckinLiveHeatmap()'s own body into this shared constant.
  const boardGeomMatch = src.match(/^const BOARD_GEOM = \(\(\) => \{[\s\S]*?\n\}\)\(\);/m);
  const fnMatch = src.match(/function buildChuckinLiveHeatmap\(cells\)\{[\s\S]*?\n\}/);
  assert.ok(dbSectorsMatch, 'DB_SECTORS declaration not found in display.html — has it moved/renamed?');
  assert.ok(boardGeomMatch, 'BOARD_GEOM declaration not found in display.html — has it moved/renamed?');
  assert.ok(fnMatch, 'buildChuckinLiveHeatmap() not found in display.html — has it moved/renamed?');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${dbSectorsMatch[0]}\n${boardGeomMatch[0]}\n${fnMatch[0]}\nthis.buildChuckinLiveHeatmap = buildChuckinLiveHeatmap;`, context);
  return context.buildChuckinLiveHeatmap;
}

describe('SEC-18 — buildChuckinLiveHeatmap() coerces payload values instead of trusting them', () => {
  test('a non-numeric (crafted) hits value cannot inject markup into the output', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const payload = '</title><image href=x onerror=alert(1)>';
    const svg = buildChuckinLiveHeatmap([{ sector: 20, multiplier: 1, hits: payload }]);
    assert.ok(!svg.includes(payload), 'the raw payload string must never appear verbatim in the output');
    assert.ok(!svg.includes('onerror='), 'no injected event-handler attribute may reach the output');
  });

  test('a non-numeric sector/multiplier cannot corrupt the lookup or the output', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([{ sector: '<script>evil</script>', multiplier: '"><img src=x onerror=1>', hits: 5 }]);
    assert.ok(!svg.includes('<script>evil'), 'a crafted sector value must not appear verbatim in the output');
    assert.ok(!svg.includes('onerror=1'), 'a crafted multiplier value must not inject an event-handler attribute');
    // The document's own single, legitimate closing tag (written unconditionally by
    // the function itself, not from any payload value) must still be exactly one
    // occurrence, at the very end — proving nothing from the crafted input closed
    // the SVG early or appended extra markup after it.
    const closeCount = (svg.match(/<\/svg>/g) || []).length;
    assert.equal(closeCount, 1, 'exactly one </svg> — the function\'s own, not an injected one');
    assert.match(svg, /<\/svg>$/, 'the document must end with that one legitimate closing </svg>');
  });

  test('legitimate numeric hit counts still render correctly', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    // BUG-20: a single is now zone-keyed, so the fixture carries a zone; the tooltip
    // reads "20 (inner): 7 hits" rather than the old zone-blind "20: 7 single hits".
    const svg = buildChuckinLiveHeatmap([{ sector: 20, multiplier: 1, zone: 'inner', hits: 7 }]);
    assert.match(svg, /20 \(inner\): 7 hits/);
  });

  test('an empty/missing cells array renders without throwing', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    assert.doesNotThrow(() => buildChuckinLiveHeatmap(null));
    assert.doesNotThrow(() => buildChuckinLiveHeatmap([]));
  });
});

// docs/bug-roadmap.md BUG-20: the live Chuckin heatmap shaded BOTH single regions of a
// number from one zone-blind count, so an inner-only or outer-only single lit up both
// halves of the wedge on /display. The fix keys singles by zone and renders the inner
// and outer regions independently, mirroring the lifetime buildDartHeatmap().
describe('BUG-20 — buildChuckinLiveHeatmap() shades inner and outer singles independently', () => {
  test('an inner-only single lights the inner region and leaves the outer at 0', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([{ sector: 20, multiplier: 1, zone: 'inner', hits: 3 }]);
    assert.match(svg, /20 \(inner\): 3 hits/, 'the inner region reflects the 3 inner hits');
    assert.match(svg, /20 \(outer\): 0 hits/, 'the outer region must stay at 0 — the bug lit it up too');
  });

  test('an outer-only single lights the outer region and leaves the inner at 0', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([{ sector: 20, multiplier: 1, zone: 'outer', hits: 5 }]);
    assert.match(svg, /20 \(outer\): 5 hits/, 'the outer region reflects the 5 outer hits');
    assert.match(svg, /20 \(inner\): 0 hits/, 'the inner region must stay at 0');
  });

  test('inner and outer counts for the same number are tracked separately', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([
      { sector: 20, multiplier: 1, zone: 'inner', hits: 2 },
      { sector: 20, multiplier: 1, zone: 'outer', hits: 6 },
    ]);
    assert.match(svg, /20 \(inner\): 2 hits/);
    assert.match(svg, /20 \(outer\): 6 hits/);
  });

  test('a zone-unspecified single (Pad mode) is plotted on neither region, not both', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([{ sector: 20, multiplier: 1, hits: 9 }]);
    assert.match(svg, /20 \(inner\): 0 hits/, 'inner stays 0 for a zone-less single');
    assert.match(svg, /20 \(outer\): 0 hits/, 'outer stays 0 for a zone-less single — never both-lit');
  });

  test('trebles, doubles, and bull (which have no zone) still render from their zone-less counts', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([
      { sector: 20, multiplier: 3, hits: 4 },
      { sector: 20, multiplier: 2, hits: 1 },
      { sector: 25, multiplier: 1, hits: 2 },
      { sector: 25, multiplier: 2, hits: 1 },
    ]);
    assert.match(svg, /T20: 4 treble hits/);
    assert.match(svg, /D20: 1 double hit/);
    assert.match(svg, /Bull: 2 hits/);
    assert.match(svg, /Double Bull: 1 hit/);
  });
});

// The live Chuckin heatmap was ported before the miss ring existed on the lifetime
// board, so it never rendered the outer near/far miss bands. This brings it to parity:
// a positioned miss (sector 0 + wedge + near/far depth) is plotted on its own band and
// its own heat scale, mirroring buildDartHeatmap().
describe('live Chuckin heatmap — miss ring (near/far bands per wedge)', () => {
  test('a positioned near miss renders on the near band of its wedge', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([{ sector: 0, multiplier: 1, missZone: 5, missDepth: 'near', hits: 3 }]);
    assert.match(svg, /Miss \(near\), wedge 5: 3 misses/);
    assert.match(svg, /Miss \(far\), wedge 5: 0 misses/, 'the far band of the same wedge stays at 0');
  });

  test('near and far misses on the same wedge are tracked separately', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([
      { sector: 0, multiplier: 1, missZone: 5, missDepth: 'near', hits: 2 },
      { sector: 0, multiplier: 1, missZone: 5, missDepth: 'far', hits: 1 },
    ]);
    assert.match(svg, /Miss \(near\), wedge 5: 2 misses/);
    assert.match(svg, /Miss \(far\), wedge 5: 1 miss\b/); // singular "miss" for a count of 1
  });

  test('an unpositioned miss (Pad mode: no wedge/depth) is not plotted on any band', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([{ sector: 0, multiplier: 1, hits: 9 }]);
    // Every wedge's miss bands stay at 0 — there's nowhere to attribute a positionless miss.
    assert.match(svg, /Miss \(near\), wedge 20: 0 misses/);
    assert.doesNotMatch(svg, /wedge \d+: 9 miss/, 'a positionless miss must never inflate any wedge band');
  });

  test('a crafted/out-of-range missZone or missDepth is ignored, not plotted', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    const svg = buildChuckinLiveHeatmap([
      { sector: 0, multiplier: 1, missZone: 99, missDepth: 'near', hits: 4 },   // wedge out of 1-20 range
      { sector: 0, multiplier: 1, missZone: 5, missDepth: 'sideways', hits: 4 }, // depth not near/far
    ]);
    assert.doesNotMatch(svg, /: 4 miss/, 'neither invalid miss cell may reach any band');
    assert.match(svg, /Miss \(near\), wedge 5: 0 misses/);
  });
});
