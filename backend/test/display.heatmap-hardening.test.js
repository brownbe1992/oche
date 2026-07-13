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
  const fnMatch = src.match(/function buildChuckinLiveHeatmap\(cells\)\{[\s\S]*?\n\}/);
  assert.ok(dbSectorsMatch, 'DB_SECTORS declaration not found in display.html — has it moved/renamed?');
  assert.ok(fnMatch, 'buildChuckinLiveHeatmap() not found in display.html — has it moved/renamed?');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${dbSectorsMatch[0]}\n${fnMatch[0]}\nthis.buildChuckinLiveHeatmap = buildChuckinLiveHeatmap;`, context);
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
    const svg = buildChuckinLiveHeatmap([{ sector: 20, multiplier: 1, hits: 7 }]);
    assert.match(svg, /20: 7 single hits/);
  });

  test('an empty/missing cells array renders without throwing', () => {
    const buildChuckinLiveHeatmap = loadBuildChuckinLiveHeatmap();
    assert.doesNotThrow(() => buildChuckinLiveHeatmap(null));
    assert.doesNotThrow(() => buildChuckinLiveHeatmap([]));
  });
});
