'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-12: renderers.chuckin.card()
// in frontend/display.html called p.sessionAvg.toFixed(1) directly on a value taken
// straight from the /api/live broadcast payload (whose per-player array shape
// ALLOWED_LIVE_KEYS deliberately leaves unrestricted). A non-numeric value threw
// inside renderState()'s render loop with no surrounding try/catch, freezing the
// entire scoreboard on every subsequent live event until a page reload. Also covers
// the related hardening found during the same sweep: buildChuckinLiveHeatmap()'s
// `cells||[]` guard let a non-array-but-truthy payload value (e.g. a string) through
// unchanged, crashing on .forEach — now Array.isArray()-guarded like every other
// live-payload array field in the file.
//
// display.html has no build step and isn't require()-able, so this extracts the
// real source for every function renderers.chuckin.card() actually depends on
// (dartClass, DB_SECTORS, buildChuckinLiveHeatmap, esc/escapeHtml, num, and the
// renderers object itself) via targeted regexes into one vm context, then calls the
// function directly — exercising the actual shipped code, not a hand-copied
// duplicate that could drift out of sync with it.
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

function loadChuckinCard() {
  const src = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
  const pieces = [
    extract(src, /function dartClass\(label\)\{[\s\S]*?\n\}/, 'dartClass()'),
    extract(src, /^const DB_SECTORS = \[[^\]]*\];/m, 'DB_SECTORS'),
    // BOARD_GEOM: buildChuckinLiveHeatmap()'s shared geometry kernel (see the
    // comment in display.heatmap-hardening.test.js for the full "why").
    extract(src, /^const BOARD_GEOM = \(\(\) => \{[\s\S]*?\n\}\)\(\);/m, 'BOARD_GEOM'),
    // heatmapStyle/heatmapNumberStyle: see the comment in
    // display.heatmap-hardening.test.js for the full "why" — the admin-toggled
    // globals buildChuckinLiveHeatmap() now reads for its heat-scale/number-band style.
    extract(src, /^let heatmapStyle = '\w+';/m, 'heatmapStyle'),
    extract(src, /^let heatmapNumberStyle = '\w+';/m, 'heatmapNumberStyle'),
    extract(src, /function buildChuckinLiveHeatmap\(cells\)\{[\s\S]*?\n\}/, 'buildChuckinLiveHeatmap()'),
    extract(src, /^function escapeHtml\(s\)\{.*\}$/m, 'escapeHtml()'),
    extract(src, /function esc\(v\)\{[^}]*\}/, 'esc()'),
    extract(src, /function num\(v\)\{[^}]*\}/, 'num()'),
    extract(src, /const renderers = \{[\s\S]*\n\};\n\/\/ Traditional chalkboard marks:/, 'renderers').replace(/\n\/\/ Traditional chalkboard marks:$/, ''),
  ];
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${pieces.join('\n')}\nthis.renderers = renderers;`, context);
  return context.renderers.chuckin.card;
}

const L = { showMeta: true }; // minimal layout-options object card() reads

describe('BUG-12 — renderers.chuckin.card() tolerates a non-numeric sessionAvg', () => {
  test('a non-numeric sessionAvg renders "—" instead of throwing', () => {
    const card = loadChuckinCard();
    const p = { name: 'Attacker', sessionDarts: 10, sessionTrebles: 2, sessionAvg: '</div><script>alert(1)</script>', heatmap: [] };
    const s = { currentIndex: 0, chuckinLastDart: null };
    let html;
    assert.doesNotThrow(() => { html = card(p, 0, s, L); });
    assert.match(html, /class="dart-count-val">—<\/span>/, 'falls back to the em-dash placeholder');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'the crafted value must not reach the output unescaped');
  });

  test('a legitimate numeric sessionAvg still renders correctly', () => {
    const card = loadChuckinCard();
    const p = { name: 'Normal', sessionDarts: 30, sessionTrebles: 5, sessionAvg: 45.678, heatmap: [] };
    const s = { currentIndex: 0, chuckinLastDart: null };
    const html = card(p, 0, s, L);
    assert.match(html, /class="dart-count-val">45\.7<\/span>/);
  });

  test('a non-array (crafted) heatmap value does not crash the card', () => {
    const card = loadChuckinCard();
    const p = { name: 'Attacker2', sessionDarts: 1, sessionTrebles: 0, sessionAvg: 10, heatmap: 'not-an-array' };
    const s = { currentIndex: 0, chuckinLastDart: null };
    assert.doesNotThrow(() => card(p, 0, s, L));
  });

  test('a missing/null sessionAvg (normal early-session state) still renders "—"', () => {
    const card = loadChuckinCard();
    const p = { name: 'JustStarted', sessionDarts: 0, sessionTrebles: 0, sessionAvg: null, heatmap: [] };
    const s = { currentIndex: 0, chuckinLastDart: null };
    const html = card(p, 0, s, L);
    assert.match(html, /class="dart-count-val">—<\/span>/);
  });
});
