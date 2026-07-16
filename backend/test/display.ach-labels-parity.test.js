'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-26: frontend/display.html
// keeps its own hand-copied ACH_LABELS/ACH_DURATION/ACH_DESC maps (no shared module
// with frontend/index.html — see this file's own "mirror-copied" comment), and nine
// static badge ids added to index.html over several features (guided_clock/
// guided_world, triplebull, bullseyefinish, the Baseball culture badges, Doubles
// Practice's Ring Master) were never added here. `achText.textContent = ACH_LABELS[type]
// || ''` silently falls back to an empty string, so the live overlay's headline
// rendered BLANK on the /display second screen for every one of those badges even
// though they awarded and persisted correctly server-side — the exact same gap class
// as Ring Master's own missing ACH_LABELS entry in index.html itself
// (docs/archive/culture-badges-roadmap.md Part B), just in the other file. Found
// (and fixed, alongside all nine) while adding cricketstonecold
// (docs/cutthroat-cricket-roadmap.md) and checking display.html stayed in sync.
//
// Neither file is require()-able as a module (no build step, no shared module) —
// this extracts each file's static `const ACH_LABELS = {...}` / `const ACH_DURATION
// = {...}` object literals directly via a targeted regex and compares their KEY SETS
// (not evaluating either as real JS — a Set().has() key check needs nothing more,
// and avoids needing a vm context for two files with mutually-referencing globals).
// Ladder-generated ids (CHUCKIN_MILESTONE_LADDERS and friends) are deliberately out
// of scope: those are added via a separate, already-mirrored forEach loop in both
// files, a different mechanism from the one that actually drifted here.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INDEX_HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const DISPLAY_HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'display.html');

// Extracts the top-level keys of `const <name> = { ... };` from raw source, without
// evaluating it as JS (both files' object literals reference file-local template
// expressions like ${CRICKET_COMEBACK_THRESHOLD} that aren't valid outside their own
// file). Good enough for a flat string/number-valued literal: matches `identifier:`
// or `'quoted-identifier':` at the start of an entry, ignoring anything after a `//`
// comment marker on the same line.
function extractKeys(src, constName) {
  const declMatch = src.match(new RegExp(`const ${constName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  assert.ok(declMatch, `const ${constName} declaration not found — has it moved/renamed?`);
  const body = declMatch[1];
  const keys = new Set();
  // A key only ever starts a line or immediately follows a `{`/`,` (with any
  // whitespace/newlines in between) — deliberately NOT plain `\s`, which would
  // also match "word:" patterns sitting inside a string VALUE (e.g. the label
  // text "Challenge Streak: Week! 🔥" contains "Streak:", preceded by a space,
  // not a structural character).
  for (const m of body.matchAll(/(?:^|[{,])\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*:/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

describe('BUG-26 — display.html\'s ACH_LABELS/ACH_DURATION/ACH_DESC stay in sync with index.html\'s static badge ids', () => {
  test('every static ACH_LABELS key in index.html has a matching entry in display.html', () => {
    const idxSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const dspSrc = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
    const idxKeys = extractKeys(idxSrc, 'ACH_LABELS');
    const dspKeys = extractKeys(dspSrc, 'ACH_LABELS');
    assert.ok(idxKeys.size > 30, 'index.html ACH_LABELS should have dozens of static entries');
    const missing = [...idxKeys].filter(k => !dspKeys.has(k));
    assert.deepEqual(missing, [], `display.html's ACH_LABELS is missing: ${missing.join(', ')} — the live overlay headline renders blank for these on the /display screen`);
  });

  test('every static ACH_DURATION key in index.html has a matching entry in display.html', () => {
    const idxSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const dspSrc = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
    const idxKeys = extractKeys(idxSrc, 'ACH_DURATION');
    const dspKeys = extractKeys(dspSrc, 'ACH_DURATION');
    const missing = [...idxKeys].filter(k => !dspKeys.has(k));
    assert.deepEqual(missing, [], `display.html's ACH_DURATION is missing: ${missing.join(', ')}`);
  });

  test('every static ACH_LABELS key in index.html has a matching (non-empty-shaped) entry in display.html\'s ACH_DESC', () => {
    const idxSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const dspSrc = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
    const idxKeys = extractKeys(idxSrc, 'ACH_LABELS');
    const dspDescKeys = extractKeys(dspSrc, 'ACH_DESC');
    const missing = [...idxKeys].filter(k => !dspDescKeys.has(k));
    assert.deepEqual(missing, [], `display.html's ACH_DESC is missing: ${missing.join(', ')}`);
  });

  test('the new cricketstonecold badge (docs/cutthroat-cricket-roadmap.md) is present in all three maps', () => {
    const dspSrc = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
    for (const constName of ['ACH_LABELS', 'ACH_DURATION', 'ACH_DESC']) {
      assert.ok(extractKeys(dspSrc, constName).has('cricketstonecold'), `display.html's ${constName} must include cricketstonecold`);
    }
    const idxSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    for (const constName of ['ACH_LABELS', 'ACH_DURATION']) {
      assert.ok(extractKeys(idxSrc, constName).has('cricketstonecold'), `index.html's ${constName} must include cricketstonecold`);
    }
  });
});
