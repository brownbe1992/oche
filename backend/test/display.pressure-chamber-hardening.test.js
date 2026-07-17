'use strict';
// Committed regression test for docs/security-audit-roadmap.md SEC-26:
// renderers.pressure_chamber.scorecard() in frontend/display.html built its
// target/modifier banner by inserting liveCard.modifier.icon into innerHTML WITHOUT
// escapeHtml, while every sibling field (target.label, modifier.label, modifier.flavor)
// was escaped. The card sequence rides in the /api/live payload (s.pressureChamberCards),
// which sanitizeLiveState() passes through without recursively escaping nested values,
// so once BUG-28 allowlisted that key a hostile POST /api/live could inject markup via
// modifier.icon and have it execute in every /display viewer's browser. The fix escapes
// the icon at the sink; this test proves a crafted icon renders as inert escaped text.
//
// display.html has no build step and isn't require()-able, so this extracts the real
// source for every function scorecard() depends on into one vm context and calls it
// directly — the same approach as display.chuckin-card-hardening.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DISPLAY_HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'display.html');

function extract(src, re, label) {
  const m = src.match(re);
  assert.ok(m, `${label} not found in display.html — has it moved/renamed?`);
  return m[0];
}

function loadPressureChamberScorecard() {
  const src = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
  const pieces = [
    extract(src, /function dartClass\(label\)\{[\s\S]*?\n\}/, 'dartClass()'),
    extract(src, /^function escapeHtml\(s\)\{.*\}$/m, 'escapeHtml()'),
    extract(src, /function esc\(v\)\{[^}]*\}/, 'esc()'),
    extract(src, /function num\(v\)\{[^}]*\}/, 'num()'),
    extract(src, /const renderers = \{[\s\S]*\n\};\n\/\/ Traditional chalkboard marks:/, 'renderers').replace(/\n\/\/ Traditional chalkboard marks:$/, ''),
  ];
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${pieces.join('\n')}\nthis.renderers = renderers;`, context);
  return context.renderers.pressure_chamber.scorecard;
}

describe('SEC-26 — renderers.pressure_chamber.scorecard() escapes a hostile modifier.icon', () => {
  test('a crafted modifier.icon renders escaped, not as live markup', () => {
    const scorecard = loadPressureChamberScorecard();
    const XSS = '<img src=x onerror=window.__xss=1>';
    const s = {
      players: [{ name: 'Ann', totalCp: 40, roundResults: {} }],
      currentIndex: 0,
      pressureChamberRound: 1,
      pressureChamberDeadline: null,
      darts: [],
      pressureChamberCards: [
        { target: { type: 'sector', sector: 20, ring: 'treble', label: 'Treble 20' },
          modifier: { key: 'dead_calm', label: 'Dead Calm', icon: XSS, flavor: 'baseline' } },
      ],
    };
    let html;
    assert.doesNotThrow(() => { html = scorecard(s, {}); });
    // The raw payload markup must NOT appear verbatim in the output — no live <img> tag
    // (escapeHtml turns the angle brackets into entities, so the dangerous tag can't form).
    assert.ok(!html.includes(XSS), 'the crafted icon must not reach the output unescaped');
    assert.ok(!html.includes('<img'), 'no live <img> tag may form from the payload');
    // ...it must appear only in its escaped form, as inert text.
    assert.match(html, /&lt;img src=x onerror=window\.__xss=1&gt;/, 'the icon renders as escaped text');
  });
});
