'use strict';
/* The main page's source as the BROWSER assembles it — markup plus stylesheet.
 *
 * Several tests assert on CSS: that a media query wraps an override, that a colour
 * meets a contrast ratio, that a portrait rule survived a landscape change. Those
 * assertions used to read `frontend/index.html` directly, because the styles were
 * inline in it. When the 1,464-line <style> block moved out to `frontend/app.css`
 * (2026-07) every one of them started matching nothing — and a regex that finds
 * nothing reads exactly like a rule that was deleted, so 23 tests failed at once
 * claiming rules were "gone" that were sitting untouched in the new file.
 *
 * Concatenating the two is what keeps those assertions meaningful: a rule and the
 * markup it styles are one page to the browser, and a test asserting they agree
 * should not have to know which file each half lives in. It also means the next
 * extraction out of index.html only has to be added here, once.
 *
 * Deliberately NOT named *.test.js — the runner globs that pattern, and a helper
 * with no tests in it would be reported as an empty suite.
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const PARTS = ['index.html', 'app.css'];

/** The page's markup and styles, concatenated. Read fresh on every call, so a test
 *  that edits a file mid-run sees its own change (the previous `src()` closures did
 *  the same, and at least one test relies on it). */
function pageSource() {
  return PARTS.map(f => fs.readFileSync(path.join(FRONTEND, f), 'utf8')).join('\n');
}

module.exports = { pageSource, FRONTEND, PARTS };
