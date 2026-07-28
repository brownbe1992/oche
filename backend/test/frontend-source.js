'use strict';
/* The main page's source as the BROWSER assembles it — markup, styles, and every
 * script it loads, concatenated.
 *
 * USE THIS whenever a test looks for JavaScript or CSS. Reading `index.html` directly
 * is only correct for markup, and only until the next extraction moves the thing you
 * were looking for.
 *
 * Two extractions have now broken tests that read index.html directly, the same way
 * both times. The 1,464-line <style> block moved to `frontend/app.css` and 23 tests
 * failed claiming CSS rules were "gone" that were sitting untouched in the new file.
 * Then Bob's 27's ten functions moved to `frontend/js/bobs-27.js` and 34 dynamically
 * generated cases simply STOPPED EXISTING — worse than a failure, because a suite that
 * silently shrinks still prints green. A regex that finds nothing is indistinguishable
 * from a rule that was deleted; a loop over functions that finds none just does less.
 *
 * The script list is read out of index.html's own `<script src>` tags rather than
 * hand-maintained here, so the next per-game-type extraction needs no edit to this
 * file at all — which is the whole point, given the previous version's comment
 * promised exactly that and then had to be edited anyway.
 *
 * Deliberately NOT named *.test.js — the runner globs that pattern, and a helper with
 * no tests in it would be reported as an empty suite.
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const INDEX = path.join(FRONTEND, 'index.html');

/** Local `<script src>` files index.html loads, in load order. */
function loadedScripts(html) {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*>/g)]
    .map(m => m[1])
    .filter(src => !/^https?:/.test(src))
    .filter((src, i, all) => all.indexOf(src) === i)   // the pattern also appears in a comment
    .map(src => path.join(FRONTEND, src));
}

/** Markup, styles and every loaded script. Read fresh on every call, so a test that
 *  edits a file mid-run sees its own change (the previous `src()` closures did the
 *  same, and at least one test relies on it). */
function pageSource() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const parts = [html, fs.readFileSync(path.join(FRONTEND, 'app.css'), 'utf8')];
  for (const f of loadedScripts(html)) parts.push(fs.readFileSync(f, 'utf8'));
  return parts.join('\n');
}

module.exports = { pageSource, FRONTEND, INDEX };
