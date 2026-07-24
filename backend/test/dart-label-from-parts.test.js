'use strict';
// Committed regression test for dartLabelFromParts() (frontend/index.html) —
// the shared formatter behind every checkout-route breakdown (Home page's Top
// Checkouts leaderboard, Player Profile's own Top Finishes list) and Dart
// Analytics' most-hit-sectors/checkout-routes lists. A zone-less single used
// to render with an explicit " (zone unknown)" suffix; removed 2026-07 per a
// live user report — on an aggregate view like these, which inner/outer half
// was hit was never the point, so the caveat just read as clutter. This test
// pins the current (bare) behavior so it can't silently regress back.
//
// index.html has no build step and isn't require()-able as a module, so this
// extracts dartLabelFromParts() directly out of the real file's source via a
// targeted regex and evaluates it in a fresh vm context alongside the real
// dartLabel() (scoring.js, its one dependency) — same approach
// backend/test/dart-heatmap.test.js already established for buildDartHeatmap().
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const SCORING_JS_PATH = path.join(__dirname, '..', '..', 'frontend', 'scoring.js');

function loadDartLabelFromParts() {
  const indexSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const scoringSrc = fs.readFileSync(SCORING_JS_PATH, 'utf8');
  const dartLabelMatch = scoringSrc.match(/^function dartLabel\([^\n]*\n(?:.*\n)*?^\}/m);
  const fnMatch = indexSrc.match(/function dartLabelFromParts\(sector, mult, zone\)\{[\s\S]*?\n\}/);
  assert.ok(dartLabelMatch, 'dartLabel() not found in scoring.js — has it moved/renamed?');
  assert.ok(fnMatch, 'dartLabelFromParts() not found in index.html — has it moved/renamed?');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${dartLabelMatch[0]}\n${fnMatch[0]}\nthis.dartLabelFromParts = dartLabelFromParts;`, context);
  return context.dartLabelFromParts;
}

describe('dartLabelFromParts() — zone-less single renders bare, no "(zone unknown)" suffix', () => {
  test('a zone-less single (Pad mode, old data, or a game type that never captures zone) renders bare', () => {
    const dartLabelFromParts = loadDartLabelFromParts();
    assert.equal(dartLabelFromParts(16, 1, null), '16');
    assert.equal(dartLabelFromParts(16, 1, undefined), '16');
    assert.equal(dartLabelFromParts(16, 1, ''), '16');
    assert.doesNotMatch(dartLabelFromParts(16, 1, null), /zone unknown/);
  });

  test('a genuinely zoned single still shows its (inner)/(outer) suffix', () => {
    const dartLabelFromParts = loadDartLabelFromParts();
    assert.equal(dartLabelFromParts(20, 1, 'inner'), '20 (inner)');
    assert.equal(dartLabelFromParts(20, 1, 'outer'), '20 (outer)');
  });

  test('a double/treble/bull never had a zone concept — bare with no suffix either way', () => {
    const dartLabelFromParts = loadDartLabelFromParts();
    assert.equal(dartLabelFromParts(20, 2, null), 'D20');
    assert.equal(dartLabelFromParts(20, 3, null), 'T20');
    assert.equal(dartLabelFromParts(25, 2, null), 'Bull');
    assert.equal(dartLabelFromParts(25, 1, null), '25');
  });

  test('a miss (sector 0) renders "Miss", unaffected by zone', () => {
    const dartLabelFromParts = loadDartLabelFromParts();
    assert.equal(dartLabelFromParts(0, 1, null), 'Miss');
  });

  test('a null sector (no dart at all, e.g. a 2-dart checkout route\'s empty 3rd slot) returns null', () => {
    const dartLabelFromParts = loadDartLabelFromParts();
    assert.equal(dartLabelFromParts(null, null, null), null);
  });
});
