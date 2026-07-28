#!/usr/bin/env node
'use strict';
/* Oche's static checker — the project's linter, with no dependency to install.
 *
 * WHY THIS EXISTS. `backend/package.json` declares no dependencies and no
 * devDependencies on purpose, and the decision was to keep it that way rather
 * than take ESLint as dev tooling. That changes what this file should try to be:
 * ESLint's value is breadth across any JS codebase; a hand-rolled checker's
 * value is encoding THIS codebase's own invariants exactly. Everything below is
 * aimed at that.
 *
 * THE ONE RULE IT HOLDS TO: no false positives. A checker that cries wolf gets
 * ignored, and an ignored checker is worse than no checker because it looks like
 * coverage. So every check runs over a surface that can be extracted exactly —
 * a declaration line, an HTML attribute, a quoted id — and wherever a judgement
 * call would be needed, the check stays SILENT rather than guessing. Each one
 * below documents what it therefore misses.
 *
 * It does not parse JavaScript. Writing a parser to find every undeclared
 * variable would be a large, subtly-wrong program whose false positives would
 * defeat the rule above. `node --check` (already in the SessionStart hook)
 * covers syntax; this covers the five things `node --check` cannot see.
 *
 * THE CHECKS.
 *   1. Duplicate top-level function declarations. In `frontend/index.html`'s
 *      single ~18,600-line script scope, 657 functions share one namespace and a
 *      redeclaration is silently legal — the later one wins and the earlier
 *      definition vanishes with no error anywhere.
 *   2. Top-level functions nothing references.
 *   3. Inline `on*=` handlers naming a function that does not exist. These
 *      resolve against the global scope AT CLICK TIME, so a broken one throws
 *      nothing until a user taps it — invisible to `node --check`, to the
 *      backend suite, and to any test that doesn't happen to click that control.
 *      This is the safety net for moving the script into ES modules, where
 *      module scope is not global scope and all ~335 handlers would silently
 *      stop resolving at once.
 *   4. `getElementById('x')` for an id that appears nowhere else in the file.
 *   5. scoring.js's hand-maintained CommonJS export list against what it
 *      actually defines. The file is dual browser/CommonJS: the browser gets
 *      every top-level name free via <script src>, Node gets only what the
 *      literal names — so a drifted name is missing in exactly one environment.
 *
 * Exit code 1 if anything is reported, so it can gate a hook or a commit.
 * `--quiet` prints findings only.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const QUIET = process.argv.includes('--quiet');

const findings = [];
const report = (check, file, msg) => findings.push({ check, file, msg });
const note = (s) => { if (!QUIET) console.log(s); };

const scriptsOf = (html) =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

const INDEX_HTML = rd('frontend/index.html');
const DISPLAY_HTML = rd('frontend/display.html');
const SCORING = rd('frontend/scoring.js');
const INDEX_JS = scriptsOf(INDEX_HTML);
const DISPLAY_JS = scriptsOf(DISPLAY_HTML);

const testDir = path.join(ROOT, 'backend/test');
const TESTS = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter(f => f.endsWith('.js')).map(f => rd('backend/test/' + f)).join('\n') : '';
const BACKEND_FILES = ['backend/db.js', 'backend/server.js', 'backend/auth.js', 'backend/seed-dev-db.js']
  .filter(p => fs.existsSync(path.join(ROOT, p)));

const SOURCES = [
  ['frontend/index.html', INDEX_JS],
  ['frontend/display.html', DISPLAY_JS],
  ['frontend/scoring.js', SCORING],
  ...BACKEND_FILES.map(p => [p, rd(p)]),
];

// `async function f()` is a declaration exactly like `function f()`. Missing the
// async form is not a cosmetic gap: index.html has 22 of them, and leaving them
// out made check 3 report seven perfectly good handlers as broken — which is how
// this regex got written twice.
const DECL_RE = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

function declaredFunctions(js) {
  const seen = new Map();
  js.split('\n').forEach((line, i) => {
    const m = DECL_RE.exec(line);
    if (!m) return;
    if (!seen.has(m[1])) seen.set(m[1], []);
    seen.get(m[1]).push(i + 1);
  });
  return seen;
}

// ---------------------------------------------------------------------------
// 1 — duplicate top-level function declarations
// ---------------------------------------------------------------------------
for (const [file, js] of SOURCES) {
  const decls = declaredFunctions(js);
  for (const [name, lines] of decls) {
    if (lines.length > 1) {
      report('duplicate-function', file,
        `${name}() declared ${lines.length}x (script lines ${lines.join(', ')}) — the last one silently wins`);
    }
  }
  note(`  ${file}: ${decls.size} top-level functions`);
}

// ---------------------------------------------------------------------------
// 2 — top-level functions nothing references
//
// Counted over every surface a call could come from: all frontend scripts, the
// backend, the whole test suite, and the RAW HTML (an inline handler is markup,
// so it is invisible in the extracted script text).
//
// Counted against raw text, with comments and string literals left in. That
// deliberately trades recall for the no-false-positives rule: a function
// mentioned only in a comment reads as used and goes unreported, which is a miss
// — but stripping comments and strings first needs a tokenizer, and the first
// draft of this file had one whose failure mode was silent desync on a regex
// literal containing a quote. It swallowed the rest of db.js and reported six
// live functions as dead. Over-counting can only ever hide a finding; the
// tokenizer could invent them.
// ---------------------------------------------------------------------------
const HAYSTACK = [INDEX_HTML, DISPLAY_HTML, SCORING, TESTS, ...BACKEND_FILES.map(rd)].join('\n');
const refCount = (name) =>
  (HAYSTACK.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length;

for (const [file, js] of SOURCES) {
  for (const [name, lines] of declaredFunctions(js)) {
    if (refCount(name) <= 1) {   // 1 hit == the declaration itself
      report('unused-function', file, `${name}() (script line ${lines[0]}) is never referenced anywhere`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3 — inline on*= handlers naming a function that does not exist
// ---------------------------------------------------------------------------
const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return',
  'typeof', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'await', 'yield']);
const BROWSER_GLOBALS = new Set(['event', 'window', 'document', 'console', 'Math', 'JSON', 'Object',
  'Array', 'String', 'Number', 'Boolean', 'Date', 'Set', 'Map', 'Promise', 'RegExp', 'Error',
  'parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'alert', 'confirm', 'prompt', 'encodeURIComponent', 'decodeURIComponent', 'Number']);

for (const [file, html, js] of [
  ['frontend/index.html', INDEX_HTML, INDEX_JS],
  ['frontend/display.html', DISPLAY_HTML, DISPLAY_JS],
]) {
  const defined = new Set(declaredFunctions(js).keys());
  // scoring.js loads via <script src> into the same global scope.
  for (const k of declaredFunctions(SCORING).keys()) defined.add(k);
  // A top-level `const f = ...` is just as callable as a declaration.
  for (const m of js.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) defined.add(m[1]);
  for (const m of SCORING.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) defined.add(m[1]);

  const missing = new Map();
  let handlerCount = 0;
  for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/g)) {
    handlerCount++;
    // `${...}` is build-time JavaScript evaluated while the markup is being
    // assembled — by the time the attribute exists in the DOM it has already
    // been replaced by its result, so names inside it are NOT resolved at click
    // time and belong to the surrounding function's scope, not the global one.
    const body = m[1].replace(/\$\{[^}]*\}/g, '_');
    // Names the handler declares for itself. Several handlers are IIFEs holding
    // a local `var f = window.__modalSubmit`, and `f()` is theirs, not a global.
    const local = new Set([...body.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)].map(x => x[1]));
    for (const c of body.matchAll(/(\.?)\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const [, dot, name] = c;
      if (dot) continue;                       // a method call on some object
      if (JS_KEYWORDS.has(name)) continue;     // `if (`, `function (`, ...
      if (BROWSER_GLOBALS.has(name)) continue;
      if (local.has(name) || defined.has(name)) continue;
      missing.set(name, (missing.get(name) || 0) + 1);
    }
  }
  for (const [name, count] of missing) {
    report('missing-handler', file,
      `inline on*= handler calls ${name}(), which is not defined in this file's scope (${count} site${count === 1 ? '' : 's'})`);
  }
  note(`  ${file}: ${handlerCount} inline handlers, ${defined.size} callable names in scope`);
}

// ---------------------------------------------------------------------------
// 4 — getElementById() for an id that appears nowhere else in the file
//
// The test is "the id appears nowhere else in the file", not "the id is not in
// the static markup". Ids are created four other ways here — interpolated into a
// template (`id="db-slot-${type}"`), concatenated at the lookup (`'db-slot-'+type`),
// assigned as a property (`el.id = 'marathon-banner'`), and passed as an argument
// to a helper that builds the markup (`iconPickerHtml('ce-grip', ...)`) — and no
// pattern match tells those apart from a typo. Any second occurrence proves the
// file knows the id; a lone occurrence proves nothing else can create it.
//
// The two CONSTRUCTED forms need their own escape hatch, because a constructed id
// genuinely appears only once as a whole literal: `db-slot-barrel` is built from
// the prefix `db-slot-` and never written out. So prefixes are collected from both
// forms and any lookup starting with one is skipped. Reported before this was
// added: three live element ids, which is exactly the kind of noise that gets a
// checker switched off.
// ---------------------------------------------------------------------------
for (const [file, html] of [['frontend/index.html', INDEX_HTML], ['frontend/display.html', DISPLAY_HTML]]) {
  const prefixes = [
    ...[...html.matchAll(/\bid="([A-Za-z0-9_-]*?)\$\{/g)].map(m => m[1]),        // id="row-${i}"
    ...[...html.matchAll(/['"]([A-Za-z0-9_-]+-)['"]\s*\+/g)].map(m => m[1]),     // 'db-slot-' + type
  ].filter(Boolean);

  const looked = new Map();
  for (const m of html.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) {
    looked.set(m[1], (looked.get(m[1]) || 0) + 1);
  }
  for (const [id, calls] of looked) {
    if (prefixes.some(p => p && id.startsWith(p))) continue;
    const total = (html.match(new RegExp(id.replace(/-/g, '\\-'), 'g')) || []).length;
    if (total <= calls) {
      report('missing-id', file,
        `getElementById('${id}') — that id appears nowhere else in the file, so nothing can create it (${calls} call site${calls === 1 ? '' : 's'})`);
    }
  }
  note(`  ${file}: ${looked.size} distinct getElementById ids, ${new Set(prefixes).size} constructed-id prefixes`);
}

// ---------------------------------------------------------------------------
// 5 — scoring.js's hand-maintained CommonJS export list
// ---------------------------------------------------------------------------
{
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(SCORING);
  if (!m) {
    report('scoring-exports', 'frontend/scoring.js', 'the module.exports literal could not be found — this check needs updating');
  } else {
    const exported = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|$)/gm)].map(x => x[1]);
    const defined = new Set(declaredFunctions(SCORING).keys());
    for (const d of SCORING.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) defined.add(d[1]);
    for (const name of exported) {
      if (!defined.has(name)) {
        report('scoring-exports', 'frontend/scoring.js',
          `module.exports names ${name}, which is not defined at top level — require() would hand back undefined`);
      }
    }
    note(`  frontend/scoring.js: ${exported.length} exported names`);
  }
}

// ---------------------------------------------------------------------------
if (!findings.length) {
  console.log(`check: clean (${SOURCES.length} sources, 5 checks).`);
  process.exit(0);
}
const byCheck = {};
for (const f of findings) (byCheck[f.check] ||= []).push(f);
console.error(`\ncheck: ${findings.length} finding${findings.length === 1 ? '' : 's'}\n`);
for (const [check, list] of Object.entries(byCheck)) {
  console.error(`  ${check} (${list.length}):`);
  for (const f of list) console.error(`    ${f.file}: ${f.msg}`);
  console.error('');
}
process.exit(1);
