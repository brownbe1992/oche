'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-26: frontend/display.html
// keeps its own hand-copied ACH_LABELS/ACH_DURATION/ACH_DESC maps (no shared module
// with frontend/index.html — see this file's own "mirror-copied" comment), and
// TWO separate classes of entry had drifted out of sync with index.html's:
//
// 1. Nine STATIC badge ids added over several features (guided_clock/guided_world,
//    triplebull, bullseyefinish, the Baseball culture badges, Doubles Practice's
//    Ring Master) were never added here at all.
// 2. FOUR WHOLE MILESTONE LADDERS (the lifetime-180s, Baseball-runs, and Doubles
//    Practice-hits ladders, plus initially Bob's 27's own new one) were never
//    mirrored here either — only Just Chuckin' It's own ladder ever got the
//    mirror-loop treatment, so 13 more badge ids were affected.
//
// `achText.textContent = ACH_LABELS[type] || ''` silently falls back to an empty
// string for any of these, so the live overlay's headline rendered BLANK on the
// /display second screen even though every one of them awarded and persisted
// correctly server-side — the exact same gap class as Ring Master's own missing
// ACH_LABELS entry in index.html itself (docs/archive/culture-badges-roadmap.md
// Part B), just in the other file. Found (and fixed, alongside all of the above)
// while adding cricketstonecold (docs/archive/cutthroat-cricket-roadmap.md) and
// Bob's 27 (docs/archive/practice-ladders-roadmap.md Part A) and checking
// display.html stayed in sync both times.
//
// Neither file is require()-able as a module (no build step, no shared module) —
// this extracts each file's static `const ACH_LABELS = {...}` / `const ACH_DURATION
// = {...}` object literals directly via a targeted regex and compares their KEY SETS
// (not evaluating either as real JS — a Set().has() key check needs nothing more,
// and avoids needing a vm context for two files with mutually-referencing globals).
// Ladder-generated ids are checked separately, by extracting each named ladder
// constant's own idPrefix+threshold pairs from BOTH files and comparing the
// resulting id sets directly — this catches both "the whole ladder was never
// mirrored" (assert.ok on the declaration match fails) and "a threshold/prefix
// was changed in one file but not the other" (the id sets stop matching).
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

// Extracts the full set of badge ids a named `const LADDER_NAME = [ {idPrefix,
// tiers:[{threshold,...}]}, ... ]` array produces, by regex over each ladder
// entry's idPrefix + every tiers[].threshold — mirrors the exact `idPrefix +
// tier.threshold` id-building formula both files' own forEach loops use, without
// needing to execute either loop.
function extractLadderIds(src, constName) {
  const declMatch = src.match(new RegExp(`const ${constName}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
  assert.ok(declMatch, `const ${constName} declaration not found in this file — has the ladder never been mirrored here, or moved/renamed?`);
  const body = declMatch[1];
  const ids = [];
  for (const entry of body.matchAll(/idPrefix:\s*'([^']+)'[\s\S]*?tiers:\s*\[([\s\S]*?)\]\s*\}/g)) {
    const prefix = entry[1];
    for (const tier of entry[2].matchAll(/threshold:\s*(\d+)/g)) {
      ids.push(prefix + tier[1]);
    }
  }
  return ids.sort();
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

  test('the cutthroat cricket and Bob\'s 27 one-off badges are present in all three maps', () => {
    const dspSrc = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
    const idxSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    for (const id of ['cricketstonecold', 'bobs27fullhouse', 'bobs27fullanderson', 'topofthehouse', 'upset',
      'pcice', 'pcnervesofsteel', 'pcnowarmup', 'pcdeadcalm']) {
      for (const constName of ['ACH_LABELS', 'ACH_DURATION', 'ACH_DESC']) {
        assert.ok(extractKeys(dspSrc, constName).has(id), `display.html's ${constName} must include ${id}`);
      }
      for (const constName of ['ACH_LABELS', 'ACH_DURATION']) {
        assert.ok(extractKeys(idxSrc, constName).has(id), `index.html's ${constName} must include ${id}`);
      }
    }
  });

  test('every milestone ladder mirrored to display.html produces the exact same badge ids as index.html\'s own copy', () => {
    const idxSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const dspSrc = fs.readFileSync(DISPLAY_HTML_PATH, 'utf8');
    // Every ladder currently in use, by its shared const name — a ladder added to
    // index.html without a same-named mirror in display.html fails loudly here
    // (extractLadderIds' own assert.ok) instead of silently blanking every one of
    // its tiers' overlay headlines, the exact BUG-26 gap this ladder-mirroring
    // check exists to catch (found affecting 3 of these 5 the first time this
    // check was written).
    for (const ladderName of [
      'CHUCKIN_MILESTONE_LADDERS',
      'ONE_EIGHTY_MILESTONE_LADDERS',
      'BASEBALL_RUNS_MILESTONE_LADDERS',
      'DOUBLES_HIT_MILESTONE_LADDERS',
      'BOBS27_SCORE_MILESTONE_LADDERS',
      'PRESSURE_RUNS_MILESTONE_LADDERS',
      'PRESSURE_CP_MILESTONE_LADDERS',
      'PRESSURE_STREAK_MILESTONE_LADDERS',
    ]) {
      const idxIds = extractLadderIds(idxSrc, ladderName);
      const dspIds = extractLadderIds(dspSrc, ladderName);
      assert.ok(idxIds.length > 0, `${ladderName} in index.html should have at least one tier`);
      assert.deepEqual(dspIds, idxIds, `${ladderName}'s badge ids differ between index.html and display.html`);
    }
  });
});
