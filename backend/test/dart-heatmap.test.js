'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-24: buildDartHeatmap()
// (frontend/index.html — the Player Profile's lifetime dartboard heatmap, shared
// across X01/Cricket/Baseball/Doubles Practice/Chuckin) silently excluded every
// "zone-unspecified single" from the board, on the assumption that meant a player
// chose Pad mode over an available Dartboard mode. That assumption is true for
// X01/Chuckin/Doubles Practice, but Cricket and Baseball have NO Dartboard-mode
// input at all — renderPadCricket()/renderPadBaseball() are always used — so
// every single they ever record is permanently zone-unspecified, and the same
// exclusion rule silently hid the most common outcome (a plain single) from
// their own heatmap entirely, including on genuine Cricket target numbers.
//
// index.html has no build step and isn't require()-able as a module, so this
// extracts buildDartHeatmap() (and its one dependency, DB_SECTORS) directly out
// of the real file's source via a targeted regex and evaluates it in a fresh vm
// context — the same approach backend/test/display.heatmap-hardening.test.js
// already established for display.html's sibling function. buildDartHeatmap()
// is pure string-building (no DOM/Canvas), so unlike buildMomentCard() this is
// fully testable without a real browser.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'index.html');

function loadBuildDartHeatmap() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const dbSectorsMatch = src.match(/^const DB_SECTORS = \[[^\]]*\];/m);
  const fnMatch = src.match(/function buildDartHeatmap\(cells, opts\)\{[\s\S]*?\n\}/);
  assert.ok(dbSectorsMatch, 'DB_SECTORS declaration not found in index.html — has it moved/renamed?');
  assert.ok(fnMatch, 'buildDartHeatmap() not found in index.html — has it moved/renamed?');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${dbSectorsMatch[0]}\n${fnMatch[0]}\nthis.buildDartHeatmap = buildDartHeatmap;`, context);
  return context.buildDartHeatmap;
}

describe('BUG-24 — buildDartHeatmap() no longer hides singles for Cricket/Baseball (noZoneTracking)', () => {
  test('without noZoneTracking (X01/Chuckin/Doubles Practice): a zone-unspecified single is still excluded — unchanged behavior', () => {
    const buildDartHeatmap = loadBuildDartHeatmap();
    const svg = buildDartHeatmap([{ sector: 15, multiplier: 1, zone: null, hits: 3 }]);
    assert.match(svg, /15 \(inner\): 0 hits/);
    assert.match(svg, /15 \(outer\): 0 hits/);
  });

  test('with noZoneTracking (Cricket/Baseball): a zone-unspecified single now renders on BOTH single sub-regions with the real count', () => {
    const buildDartHeatmap = loadBuildDartHeatmap();
    const svg = buildDartHeatmap([{ sector: 15, multiplier: 1, zone: null, hits: 3 }], { noZoneTracking: true });
    assert.match(svg, /15: 3 hits/);
    // Tooltip must not falsely claim inner/outer precision for a mode that can never capture it.
    assert.doesNotMatch(svg, /15 \(inner\)/);
    assert.doesNotMatch(svg, /15 \(outer\)/);
    // Both sub-regions get the SAME merged count — confirm it appears exactly twice
    // (once per <path> element for that single, inner ring + outer ring).
    const occurrences = (svg.match(/15: 3 hits/g) || []).length;
    assert.equal(occurrences, 2, 'both the inner and outer single sub-regions must show the merged total');
  });

  test('with noZoneTracking, trebles/doubles/bull are completely unaffected (multiplier !== 1 was never excluded)', () => {
    const buildDartHeatmap = loadBuildDartHeatmap();
    const svg = buildDartHeatmap([
      { sector: 20, multiplier: 3, zone: null, hits: 2 },
      { sector: 19, multiplier: 2, zone: null, hits: 1 },
      { sector: 25, multiplier: 1, zone: null, hits: 4 },
      { sector: 25, multiplier: 2, zone: null, hits: 1 },
    ], { noZoneTracking: true });
    assert.match(svg, /T20: 2 treble hits/);
    assert.match(svg, /D19: 1 double hit/);
    assert.match(svg, /Bull: 4 hits/);
    assert.match(svg, /Double Bull: 1 hit/);
  });

  test('an unpositioned miss (no missZone/missDepth) still has nothing to plot, regardless of noZoneTracking', () => {
    const buildDartHeatmap = loadBuildDartHeatmap();
    const svg = buildDartHeatmap([{ sector: 0, multiplier: 1, hits: 5 }], { noZoneTracking: true });
    assert.match(svg, /Miss \(near\), wedge 20: 0 misses/);
  });

  test('legitimate lifetime X01 data (mixed zoned singles, trebles, doubles) still renders correctly with no opts', () => {
    const buildDartHeatmap = loadBuildDartHeatmap();
    const svg = buildDartHeatmap([
      { sector: 20, multiplier: 1, zone: 'inner', hits: 5 },
      { sector: 20, multiplier: 1, zone: 'outer', hits: 2 },
      { sector: 20, multiplier: 3, hits: 1 },
    ]);
    assert.match(svg, /20 \(inner\): 5 hits/);
    assert.match(svg, /20 \(outer\): 2 hits/);
    assert.match(svg, /T20: 1 treble hit/);
  });

  test('an empty/missing cells array renders without throwing, with or without noZoneTracking', () => {
    const buildDartHeatmap = loadBuildDartHeatmap();
    assert.doesNotThrow(() => buildDartHeatmap(null));
    assert.doesNotThrow(() => buildDartHeatmap([]));
    assert.doesNotThrow(() => buildDartHeatmap([], { noZoneTracking: true }));
  });
});
