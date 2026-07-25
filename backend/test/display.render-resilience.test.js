'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-30.
//
// /display's render() writes to the DOM incrementally — format bar, then the player
// grid, then banners — so an exception part-way through leaves the earlier writes
// applied and the later ones not: a TORN frame mixing the new game's header with the
// previous game's scores. Every call site wrapped render() in a bare `catch(e){}`, so
// that happened in complete silence: nothing in the console, nothing server-side, and
// the screen stuck that way for as long as the controller kept pushing the shape that
// threw.
//
// It was reachable without an attacker. `modeState` is forwarded by the server as an
// opaque object (code-quality item 42 — deliberately, since consolidating the per-mode
// allowlist entries is what removed the third sync point behind BUG-28), so the shape
// of everything inside it is guaranteed only by the frontend producer agreeing with
// display.html's reader. A Pressure Chamber card missing its `target` made
// renderers.pressure_chamber.scorecard() throw
// "TypeError: Cannot read properties of undefined (reading 'label')" — reproduced live,
// with the header updating to the new game while the card below still showed the
// previous one.
//
// Two independent fixes, both asserted here: the renderer now checks the nested shape
// before building its banner, and renderSafe() logs any render failure and repaints the
// last cleanly-rendered snapshot so a failure degrades to a consistent stale frame
// instead of an incoherent one.
//
// display.html has no build step and isn't require()-able, so the renderer is extracted
// into a vm context — the same approach as display.pressure-chamber-hardening.test.js.
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

function loadRenderers() {
  const src = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
  const pieces = [
    extract(src, /function dartClass\(label\)\{[\s\S]*?\n\}/, 'dartClass()'),
    extract(src, /function buildDartSlots\(darts\)\{[\s\S]*?\n\}/, 'buildDartSlots()'),
    extract(src, /function buildScorecardHeadCells\(players, active\)\{[\s\S]*?\n\}/, 'buildScorecardHeadCells()'),
    extract(src, /function buildScorecardFootCells\(players, active, valueFn\)\{[\s\S]*?\n\}/, 'buildScorecardFootCells()'),
    extract(src, /function buildScorecardThrowRow\(labelHtml, darts\)\{[\s\S]*?\n\}/, 'buildScorecardThrowRow()'),
    extract(src, /function roundOverrunInfo\(current, max, noun\)\{[\s\S]*?\n\}/, 'roundOverrunInfo()'),
    extract(src, /^function escapeHtml\(s\)\{.*\}$/m, 'escapeHtml()'),
    extract(src, /function esc\(v\)\{[^}]*\}/, 'esc()'),
    extract(src, /function num\(v\)\{[^}]*\}/, 'num()'),
    extract(src, /const renderers = \{[\s\S]*\n\};\n\/\/ Traditional chalkboard marks:/, 'renderers')
      .replace(/\n\/\/ Traditional chalkboard marks:$/, ''),
  ];
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${pieces.join('\n')}\nthis.renderers = renderers;`, context);
  return context.renderers;
}

const snapshotWith = modeState => ({
  players: [{ name: 'Ann', totalCp: 40, roundResults: {} }],
  currentIndex: 0,
  darts: [],
  modeState,
});

describe('BUG-30 — a structurally incomplete modeState must not throw out of a renderer', () => {
  const cases = [
    ['a card with no target and no modifier', [{}]],
    ['a card with a modifier but no target', [{ modifier: { key: 'x', icon: 'i', label: 'l', flavor: 'f' } }]],
    ['a card with a target but no modifier', [{ target: { label: 'T20' } }]],
    ['a null card', [null]],
  ];

  for (const [label, cards] of cases) {
    test(`pressure_chamber scorecard survives ${label}`, () => {
      const renderers = loadRenderers();
      const s = snapshotWith({ pressureChamberRound: 1, pressureChamberDeadline: null, pressureChamberCards: cards });
      let html;
      assert.doesNotThrow(() => { html = renderers.pressure_chamber.scorecard(s, { showTag: true }); },
        'the renderer must degrade rather than throw — throwing is what tore the screen');
      assert.equal(typeof html, 'string');
      // It still renders the scorecard itself; only the banner it can't build is dropped.
      assert.match(html, /cs-table/, 'the table should still render without the banner');
      assert.doesNotMatch(html, /pc-banner/, 'an unbuildable banner should be omitted, not half-built');
    });
  }

  test('a well-formed card still renders its banner', () => {
    // Guards against "fixed" by never showing the banner at all.
    const renderers = loadRenderers();
    const s = snapshotWith({
      pressureChamberRound: 1,
      pressureChamberDeadline: null,
      pressureChamberCards: [{ target: { label: 'T20' }, modifier: { key: 'heat', icon: '@', label: 'Heat', flavor: 'go' } }],
    });
    const html = renderers.pressure_chamber.scorecard(s, { showTag: true });
    assert.match(html, /pc-banner/);
    assert.match(html, /T20/);
    assert.match(html, /Heat/);
  });
});

describe('BUG-30 — render failures are surfaced and never leave a torn frame', () => {
  const src = () => fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');

  test('no call site swallows a render() exception silently', () => {
    // The root cause: `try { render(...) } catch(e){}` on the only redraw path meant a
    // broken screen left no trace anywhere. Any empty catch around a render call is the
    // bug returning.
    const offenders = [];
    src().split('\n').forEach((line, i) => {
      // Skip comments — the code that explains this rule quotes the very pattern it
      // forbids, and a scanner that can't tell prose from a call site is one that gets
      // silenced rather than fixed.
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (/\brender\s*\(/.test(line) && /catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
        offenders.push(`${i + 1}: ${t}`);
      }
    });
    assert.deepEqual(offenders, [], 'a render() call is wrapped in an empty catch — see BUG-30');
  });

  test('renderSafe() exists, records a last-good snapshot, and repaints it on failure', () => {
    const s = src();
    const fn = s.match(/function renderSafe\(s\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'renderSafe() not found — every render call site should go through it');
    assert.match(fn[0], /console\.error/, 'a failed render must be logged, not swallowed');
    assert.match(fn[0], /lastGoodSnapshot\s*=\s*s/, 'a clean render must record the last good snapshot');
    assert.match(fn[0], /render\(lastGoodSnapshot\)/, 'a failed render must repaint the last good frame');
    assert.match(fn[0], /restoring/, 'the restore path needs a recursion guard in case it throws too');
  });

  test('the live-stream and polling paths both go through renderSafe()', () => {
    const s = src();
    assert.match(s, /es\.onmessage[\s\S]{0,400}renderSafe\(/, 'the SSE handler should call renderSafe()');
    assert.match(s, /\/api\/live'[\s\S]{0,200}renderSafe\(/, 'the polling fallback should call renderSafe()');
  });
});
