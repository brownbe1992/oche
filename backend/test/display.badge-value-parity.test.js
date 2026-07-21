'use strict';
// Committed guard for the badge-text VALUE drift class (Architecture Roadmap P1-a scan).
// display.ach-labels-parity.test.js compares KEY SETS between index.html and display.html
// but cannot compare VALUES — six real value drifts (two overlay labels, four descriptions,
// plus a leaked doc path) hid behind that gap until the P1-a scan caught them by evaluating
// the live runtime maps. This test closes the gap without a browser: it isolates each flat
// map's `{...}` literal by BRACE MATCHING (robust to any close style — a plain regex
// over-captures because ACH_LABELS doesn't end with a bare "\n};", which is exactly why the
// key-only check couldn't compare values) and asserts every SHARED key has identical text.
//
// Only STATIC entries can drift in value: the ladder-generated ids in both files are built
// by the identical `${tier.label} ${tier.icon}` formula from ladder definitions whose ids
// are already parity-checked (display.ach-labels-parity.test.js), so a matching ladder
// definition guarantees a matching generated value. This test therefore compares the static
// literals — ACH_LABELS and ACH_DURATION on both sides, and index's BADGE_INFO.desc against
// display's ACH_DESC — which is where all six real drifts lived.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
const DISPLAY_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'display.html'), 'utf8');

// Returns the source text between the braces of `const NAME = { ... }`, matched by
// tracking brace depth while skipping string/template literals and `//` line
// comments — reliable no matter how the object closes (bare `};`, indented, or
// trailing a line), and not thrown off by an apostrophe in a comment elsewhere
// in the file (a `'` inside a `//` comment previously toggled the same inStr
// state a real string literal does, so the depth count could silently drift
// across thousands of unrelated lines before landing on some other `}` by
// coincidence — this treats `//` through end-of-line as never containing a
// meaningful quote or brace, matching how a JS parser actually reads it).
function objectBody(src, name) {
  const decl = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*\\{'));
  assert.ok(decl, `const ${name} not found — has it moved/renamed?`);
  let depth = 1, inStr = null, esc = false;
  const start = decl.index + decl[0].length;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i);
  }
  assert.fail(`unbalanced braces while extracting ${name}`);
}

// Parses `key: 'str' | "str" | number` entries from a FLAT object body into a Map.
function parseFlat(body) {
  const out = new Map();
  const re = /(?:^|[{,]|\n)\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\d+))\s*(?=[,}\n])/g;
  let m;
  while ((m = re.exec(body))) out.set(m[1], m[2] ?? m[3] ?? m[4]);
  return out;
}

// Parses `key: { ...flat props... }` entries and pulls each entry's `desc` string.
function parseDescs(body) {
  const out = new Map();
  for (const m of body.matchAll(/(?:^|[{,]|\n)\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*:\s*\{([^{}]*)\}/g)) {
    const d = m[2].match(/desc\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
    if (d) out.set(m[1], d[1] ?? d[2]);
  }
  return out;
}

// index.html also adds many one-off badges via bracket assignment, OUTSIDE the literal —
// `ACH_LABELS['x'] = '...'`, `BADGE_INFO['x'] = { ... }` — including two of the label
// drifts the scan found. Parse those too so the comparison covers every one-off badge, not
// just the ones inside the `const = {}` literal. (display.html uses only literals.)
function parseBracketFlat(src, name) {
  const out = new Map();
  const re = new RegExp(name + "\\['([A-Za-z_][A-Za-z0-9_]*)'\\]\\s*=\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|\"((?:[^\"\\\\]|\\\\.)*)\"|(\\d+))\\s*;", 'g');
  let m;
  while ((m = re.exec(src))) out.set(m[1], m[2] ?? m[3] ?? m[4]);
  return out;
}
function parseBracketDescs(src) {
  const out = new Map();
  // BADGE_INFO['x'] = { ...flat, possibly multi-line... };  (entries have no nested braces)
  for (const m of src.matchAll(/BADGE_INFO\['([A-Za-z_][A-Za-z0-9_]*)'\]\s*=\s*\{([^{}]*)\}/g)) {
    const d = m[2].match(/desc\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
    if (d) out.set(m[1], d[1] ?? d[2]);
  }
  return out;
}
const mergeMaps = (...maps) => { const out = new Map(); for (const m of maps) for (const [k, v] of m) out.set(k, v); return out; };

function sharedDrift(a, b) {
  return [...b.keys()].filter(k => a.has(k) && a.get(k) !== b.get(k));
}

describe('P1-a — index.html and display.html agree on shared badge text (value parity)', () => {
  test('shared ACH_LABELS entries have identical overlay text', () => {
    const idx = mergeMaps(parseFlat(objectBody(INDEX_HTML, 'ACH_LABELS')), parseBracketFlat(INDEX_HTML, 'ACH_LABELS'));
    const dsp = parseFlat(objectBody(DISPLAY_HTML, 'ACH_LABELS'));
    assert.ok(idx.size > 30 && dsp.size > 30, 'both files should have dozens of static ACH_LABELS entries');
    const drift = sharedDrift(idx, dsp);
    assert.deepEqual(drift, [], drift.map(k => `${k}: index="${idx.get(k)}" vs display="${dsp.get(k)}"`).join(' | '));
  });

  test('shared ACH_DURATION entries have identical duration', () => {
    const idx = mergeMaps(parseFlat(objectBody(INDEX_HTML, 'ACH_DURATION')), parseBracketFlat(INDEX_HTML, 'ACH_DURATION'));
    const dsp = parseFlat(objectBody(DISPLAY_HTML, 'ACH_DURATION'));
    const drift = sharedDrift(idx, dsp);
    assert.deepEqual(drift, [], drift.map(k => `${k}: index=${idx.get(k)} vs display=${dsp.get(k)}`).join(' | '));
  });

  test("index's BADGE_INFO.desc matches display's ACH_DESC for shared badges (no leaked doc paths)", () => {
    const idxDescs = mergeMaps(parseDescs(objectBody(INDEX_HTML, 'BADGE_INFO')), parseBracketDescs(INDEX_HTML));
    const dspDescs = parseFlat(objectBody(DISPLAY_HTML, 'ACH_DESC'));
    assert.ok(idxDescs.size > 30 && dspDescs.size > 30, 'both files should have dozens of static descriptions');
    const drift = sharedDrift(idxDescs, dspDescs);
    assert.deepEqual(drift, [], drift.map(k => `${k}: index="${idxDescs.get(k)}" vs display="${dspDescs.get(k)}"`).join(' | '));
    // Guard against an internal doc path leaking into any user-facing description.
    const leaks = [...idxDescs.entries()].filter(([, v]) => /docs\/|roadmap\.md/.test(v)).map(([k]) => k);
    assert.deepEqual(leaks, [], `BADGE_INFO descriptions with a leaked internal doc path: ${leaks.join(', ')}`);
  });
});
