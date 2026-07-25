'use strict';
// Committed regression test for docs/security-audit-roadmap.md SEC-28, and the standing
// invariant SEC-12 established and SEC-15 re-asserted.
//
// The frontend builds HTML as template strings, so a value that lands in an inline
// event handler sits in TWO nested contexts at once: a JavaScript string, inside an
// HTML attribute. Escaping only the first is not enough. escapeJs() handles ' and \;
// escapeHtml() handles & < > and — critically — the " that terminates the attribute.
// jsArg() is the composition of both, and is what every inline handler must use.
//
// SEC-28: renderHandicapOptions() used a bare escapeJs(), so a player named
//   Bex" onmouseover="window.__xss=1;//
// (player names permit any non-control character) ended the onchange attribute early
// and the remainder was parsed as a further attribute — a real, compiled event handler
// running attacker JavaScript in the app's origin, confirmed in a browser. The CSP does
// not help: script-src includes 'unsafe-inline' (SEC-10), which permits inline handlers
// by definition.
//
// This has now been checked by hand three times and regressed twice, which is precisely
// what a committed test is for. The invariant is mechanical, so the test is too.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const FILES = ['index.html', 'display.html'];

describe('SEC-28 / SEC-12 / SEC-15 — no value reaches an inline handler through escapeJs alone', () => {
  test('every escapeJs() use is wrapped in escapeHtml() (i.e. goes through jsArg)', () => {
    const offenders = [];
    for (const file of FILES) {
      const src = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
      src.split('\n').forEach((line, i) => {
        // A bare `${escapeJs(...)}` interpolation. The legitimate forms are jsArg(x),
        // esc(escapeJs(x)) and escapeHtml(escapeJs(x)) — none of which match this,
        // because in those the interpolation opens with the OUTER call.
        if (/\$\{\s*escapeJs\s*\(/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [],
      'bare escapeJs() in an interpolation — use jsArg() (= escapeHtml(escapeJs(...))) so a ' +
      'value containing a double quote cannot break out of the surrounding HTML attribute');
  });

  test('jsArg() is still the escapeHtml(escapeJs(...)) composition it claims to be', () => {
    // The invariant above is worth nothing if jsArg itself stops doing both jobs.
    const src = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    const m = src.match(/function jsArg\(s\)\{[^}]*\}/);
    assert.ok(m, 'jsArg() not found in index.html — has it moved or been renamed?');
    assert.match(m[0], /escapeHtml\(\s*escapeJs\(/,
      'jsArg() must apply escapeJs first and escapeHtml outermost');

    // And that escapeHtml actually neutralises the character that caused SEC-28.
    const eh = src.match(/^function escapeHtml\(s\)\{.*\}$/m);
    assert.ok(eh, 'escapeHtml() not found in index.html');
    assert.match(eh[0], /"/, 'escapeHtml() must escape the double quote — it is what ends an attribute');
  });

  test('the handicap dropdown carries no inline handler at all', () => {
    // SEC-28's specific site. The durable fix was to drop the inline attribute and
    // attach a real listener in the loop that was already re-querying these elements,
    // which removes the escaping question rather than answering it. If an inline
    // onchange ever comes back here, so does the class of bug.
    const src = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    const fn = src.match(/function renderHandicapOptions\(\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'renderHandicapOptions() not found in index.html');
    assert.doesNotMatch(fn[0], /on[a-z]+\s*=\s*"[^"]*\$\{/,
      'renderHandicapOptions() builds an inline event handler containing an interpolated ' +
      'value — attach a listener to the element instead (see SEC-28)');
    assert.match(fn[0], /addEventListener\('change'/,
      'the change handler should be attached as a real listener');
  });
});
