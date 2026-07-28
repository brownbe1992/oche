#!/usr/bin/env node
// @ts-check
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
 * covers syntax; this covers the nine things `node --check` cannot see.
 *
 * THE CHECKS. (Named once in CHECK_NAMES below, which report() validates against —
 * this list is prose, that one is the source of truth.)
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
 *   5. A `<script src>` pointing at a file that isn't there — a whole section of
 *      the app silently not loading, which the browser reports only in its console.
 *   6. A `<link rel=stylesheet>` pointing at a file that isn't there. Worse than a
 *      missing script: server.js's static handler falls back to index.html for any
 *      unknown non-API path, so the browser gets a whole HTML page where it asked for
 *      CSS, discards it, and renders every screen unstyled with a clean console.
 *   7. A top-level initialiser in a split `frontend/js/` file that reads a name the
 *      main script declares. Split files load FIRST, so such a line throws
 *      ReferenceError and aborts the entire file, taking every function in it with
 *      it. One such line killed all 15 league functions at once.
 *   8. A leaf module (backend/tournaments.js and friends, cut out of db.js) naming
 *      a db.js constant or scoring.js export it neither injects nor requires. Those
 *      files used to have every name in scope for free; now a missed one is a
 *      ReferenceError, but only when that function is CALLED — the module loads
 *      fine, `node --check` parses it, the typechecker passes it. Extracting four
 *      leaves hit this five times.
 *   9. scoring.js's hand-maintained CommonJS export list against what it
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

// Every check's name, listed once. This exists because the "clean" line below used to
// hardcode how many checks had run, and two checks were added without anyone noticing
// the number — so the tool that exists to catch drift was quietly reporting the wrong
// thing about itself. report() now refuses a name that isn't here, which means adding a
// check without registering it fails immediately instead of silently.
const CHECK_NAMES = [
  'duplicate-function', 'unused-function', 'missing-handler', 'missing-id',
  'missing-script', 'missing-stylesheet', 'load-order', 'scoring-exports', 'ts-check-placement',
  'leaf-missing-dep', 'orphan-script',
];

const findings = [];
const report = (check, file, msg) => {
  if (!CHECK_NAMES.includes(check)) throw new Error(`check.js: unregistered check '${check}' — add it to CHECK_NAMES`);
  findings.push({ check, file, msg });
};
const note = (s) => { if (!QUIET) console.log(s); };

const scriptsOf = (html) =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

// The <script src="..."> files a page loads, in load order, resolved to repo paths.
// Split-out sections (docs/frontend-module-split-roadmap.md) are CLASSIC scripts sharing
// one global scope with the page's inline script, so for every check in this file they
// are part of the SAME scope — a function moved into frontend/js/ is still the same
// function to an inline on*= handler. Reading them separately is what would be wrong:
// the first extraction immediately produced a `missing-handler` report for a perfectly
// live function, which is how this got written.
// Deduped by resolved path, which is load-bearing rather than tidiness: the pattern
// `<script src="...">` also appears inside a COMMENT in index.html's own JavaScript
// (explaining how scoring.js is loaded), and matching that pulled scoring.js in twice —
// making every one of its 121 functions look like a duplicate declaration. Distinguishing
// a real tag from one quoted in a comment needs a parser; deduping does not.
function loadedScripts(html, dir) {
  const seen = new Set();
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    if (/^https?:/.test(m[1])) continue;
    seen.add(path.join(ROOT, dir, m[1]));
  }
  return [...seen];
}
// Every .js file the typecheck config covers — backend/ and frontend/, recursively.
function tsCheckCandidates() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  walk('backend'); walk('frontend');
  return out;
}

function scopeOf(html, dir) {
  const files = loadedScripts(html, dir);
  const missing = files.filter(f => !fs.existsSync(f));
  const src = files.filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8'));
  return { js: [scriptsOf(html), ...src].join('\n'), text: [html, ...src].join('\n'), files, missing };
}

const INDEX_HTML = rd('frontend/index.html');
const DISPLAY_HTML = rd('frontend/display.html');
const SCORING = rd('frontend/scoring.js');
const INDEX_SCOPE = scopeOf(INDEX_HTML, 'frontend');
const DISPLAY_SCOPE = scopeOf(DISPLAY_HTML, 'frontend');
const INDEX_JS = INDEX_SCOPE.js;
const DISPLAY_JS = DISPLAY_SCOPE.js;

// A <script src> naming a file that isn't there is a whole section of the app silently
// not loading — the exact failure mode a staged split can introduce, and one the browser
// reports only in its console.
/** @type {Array<[string, typeof INDEX_SCOPE]>} — the page's repo path, paired with its scope */
const PAGES = [['frontend/index.html', INDEX_SCOPE], ['frontend/display.html', DISPLAY_SCOPE]];
for (const [file, scope] of PAGES) {
  for (const m of scope.missing) {
    report('missing-script', file, `<script src> points at ${path.relative(ROOT, m)}, which does not exist`);
  }
}

// The same failure for a stylesheet, which is WORSE, because server.js's static
// handler falls back to index.html for any unknown non-API path: a typo'd href
// doesn't 404, it returns the whole HTML page with a text/css request. The browser
// discards it silently and renders every screen unstyled, with a clean console.
// Added when the 1,464-line inline <style> block moved out to frontend/app.css.
const STYLESHEETS = [['frontend/index.html', INDEX_HTML], ['frontend/display.html', DISPLAY_HTML]];
for (const [file, html] of STYLESHEETS) {
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/g)) {
    const href = (m[0].match(/\bhref=["']([^"']+)["']/) || [])[1];
    if (!href || /^(https?:)?\/\//.test(href)) continue;   // a CDN/font host isn't ours to check
    const abs = path.join(ROOT, 'frontend', href);
    if (!fs.existsSync(abs)) {
      report('missing-stylesheet', file, `<link rel=stylesheet> points at ${href}, which does not exist`);
    }
  }
}

// `// @ts-check` only works in a file's LEADING comment block. Put it after
// `'use strict';` — the obvious-looking place — and TypeScript ignores it completely:
// no warning, no error, the file simply is not checked. That is the worst possible
// failure for an opt-in tool, because `npm run typecheck` still reports success and
// the file looks adopted. It happened on the first five files adopted, and was only
// caught by deliberately breaking one and noticing that nothing complained.
//
// Exact, so it cannot false-positive: everything above the marker must be blank, a
// shebang, or a comment.
/* A leaf module (backend/tournaments.js and friends) naming something it never got.
 *
 * Those files were cut out of db.js, where every name in the file was in scope for
 * free. A reference the factory neither injects nor requires is now a ReferenceError
 * — but only when that function is actually CALLED. `node --check` parses it happily,
 * the typechecker passes it, and the module loads fine. It surfaces as a 500 the
 * first time someone opens the screen that uses it.
 *
 * Extracting the four leaves hit this five times (CHECKOUT_POINTS, X01_ONLY,
 * computeFatigueSplit, checkoutHint, dartLabel), each caught only because a test
 * happened to cover that path. This is the same class as `missing-handler`: a name
 * resolved at call time, invisible to every other tool here.
 *
 * Two surfaces are checked, both extractable exactly, per this file's no-false-
 * positives rule: db.js's top-level SCREAMING_CASE constants, and scoring.js's own
 * export list. A leaf referencing anything else — a lowercase db.js helper it forgot
 * to inject — is NOT caught, because deciding that needs a real parser. Comments and
 * template-literal SQL are stripped first, so prose naming a constant is not a hit.
 */
/* Blanks comments and string literals, but KEEPS `${...}` interpolations, which are
 * code. That is not a detail: every one of these SQL-fragment constants is used as
 * `SELECT ${X01_ONLY} ...` inside a template literal, so a stripper that blanked the
 * whole literal would miss the exact case this check exists for. The first version
 * did, and caught two of the three real bugs it was written against. */
function stripCommentsAndStrings(text) {
  const out = text.split('');
  const stack = [];                 // nesting of template literals we are inside
  let mode = null, braceDepth = 0;  // braceDepth: { } seen inside the current ${ }
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (mode === null) {
      if (c === '/' && next === '/') { mode = '//'; out[i] = out[i + 1] = ' '; i++; }
      else if (c === '/' && next === '*') { mode = '/*'; out[i] = out[i + 1] = ' '; i++; }
      else if (c === '"' || c === "'" || c === '`') { mode = c; out[i] = ' '; }
      else if (c === '}' && stack.length && braceDepth === 0) {
        // Closing a ${ } — back into the template literal that opened it.
        out[i] = ' '; mode = stack.pop(); braceDepth = 0;
      } else if (stack.length) {
        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth--;
      }
    } else if (mode === '//') {
      if (c === '\n') mode = null; else out[i] = ' ';
    } else if (mode === '/*') {
      if (c === '*' && next === '/') { out[i] = out[i + 1] = ' '; mode = null; i++; }
      else if (c !== '\n') out[i] = ' ';
    } else {
      if (c === '\\') { out[i] = out[i + 1] = ' '; i++; continue; }
      if (mode === '`' && c === '$' && next === '{') {
        out[i] = out[i + 1] = ' '; stack.push('`'); mode = null; braceDepth = 0; i++; continue;
      }
      if (c === mode) mode = null;
      out[i] = ' ';
    }
  }
  return out.join('');
}

const DB_JS = rd('backend/db.js');
const DB_CONSTS = new Set([...DB_JS.matchAll(/^const ([A-Z][A-Z0-9_]+)\s*=/gm)].map(m => m[1]));
const SCORING_EXPORT_NAMES = new Set(
  [...SCORING.slice(SCORING.indexOf('module.exports = {')).matchAll(/([A-Za-z_$][\w$]*)\s*[,:}]/g)]
    .map(m => m[1]));

for (const rel of tsCheckCandidates()) {
  if (!/^backend\/[^/]+\.js$/.test(rel)) continue;
  const raw = rd(rel);
  if (!/module\.exports = function init/.test(raw)) continue;   // leaf factories only
  const code = stripCommentsAndStrings(raw);
  const declared = new Set();
  for (const m of code.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (name) declared.add(name);
    }
  }
  for (const name of [...DB_CONSTS, ...SCORING_EXPORT_NAMES]) {
    if (declared.has(name)) continue;
    if (new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)) {
      report('leaf-missing-dep', rel, `uses '${name}' but neither injects nor requires it — ` +
        `a ReferenceError the first time that code path runs`);
    }
  }
}

for (const rel of tsCheckCandidates()) {
  const lines = rd(rel).split('\n');
  const at = lines.findIndex(l => /^\s*\/\/\s*@ts-check\s*$/.test(l));
  if (at === -1) continue;
  let inBlock = false;
  for (let i = 0; i < at; i++) {
    const t = lines[i].trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (!t || t.startsWith('#!') || t.startsWith('//')) continue;
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    report('ts-check-placement', rel,
      `// @ts-check is on line ${at + 1}, below code (line ${i + 1}: ${t.slice(0, 40)}) — ` +
      'TypeScript ignores it there and the file is silently unchecked. Move it above.');
    break;
  }
}

const testDir = path.join(ROOT, 'backend/test');
const TESTS = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter(f => f.endsWith('.js')).map(f => rd('backend/test/' + f)).join('\n') : '';
const BACKEND_FILES = ['backend/db.js', 'backend/server.js', 'backend/auth.js', 'backend/seed-dev-db.js']
  .filter(p => fs.existsSync(path.join(ROOT, p)));

const SPLIT_FILES = INDEX_SCOPE.files.filter(f => fs.existsSync(f) && /[\\/]js[\\/]/.test(f));
const SOURCES = [
  ['frontend/index.html', INDEX_JS],
  ['frontend/display.html', DISPLAY_JS],
  ['frontend/scoring.js', SCORING],
  ...SPLIT_FILES.map(f => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]),
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
const HAYSTACK = [INDEX_HTML, DISPLAY_HTML, SCORING, TESTS, ...BACKEND_FILES.map(rd),
  ...SPLIT_FILES.map(f => fs.readFileSync(f, 'utf8'))].join('\n');
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

// `html` here is the page's markup PLUS every classic script it loads. Splitting a
// section out moved its markup-emitting template literals into a .js file, and scanning
// only the .html silently dropped 58 handlers and 23 id lookups from these two checks —
// coverage lost with no failure to notice it by. The scope is what matters, not the
// file extension.
for (const [file, html, js] of [
  ['frontend/index.html', INDEX_SCOPE.text, INDEX_JS],
  ['frontend/display.html', DISPLAY_SCOPE.text, DISPLAY_JS],
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
for (const [file, html] of [['frontend/index.html', INDEX_SCOPE.text], ['frontend/display.html', DISPLAY_SCOPE.text]]) {
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
// 6 — a split file reading, at LOAD time, a name declared in a later script
//
// The one hazard the staged split actually hit. Classic scripts share a global scope,
// but they still RUN in order: a top-level `const A = B` in a split file executes the
// moment that file loads, and if B is declared in a script that loads later, it throws
// ReferenceError — which aborts the whole file, taking every function in it with it.
// One such line (`const LEAGUE_X01_CATEGORIES = X01_CATEGORIES`) silently killed all 15
// league functions and produced 20 failing checks whose messages all said the same
// thing. Reading the same name from INSIDE a function is fine, because by then
// everything has loaded — so this only looks at top-level initialisers.
//
// Only bare identifiers and simple member/call expressions are examined; anything more
// involved is left alone rather than guessed at, per this file's no-false-positives rule.
// ---------------------------------------------------------------------------
{
  const declaredBefore = new Set(declaredFunctions(SCORING).keys());
  for (const m of SCORING.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) declaredBefore.add(m[1]);
  const inlineNames = new Set(declaredFunctions(scriptsOf(INDEX_HTML)).keys());
  for (const m of scriptsOf(INDEX_HTML).matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) inlineNames.add(m[1]);

  for (const f of SPLIT_FILES) {
    const rel = path.relative(ROOT, f);
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      const d = /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(.+)$/.exec(line);
      if (!d) return;
      const rhs = d[1].trim();
      const id = /^([A-Za-z_$][\w$]*)\s*(?:[.;([]|$)/.exec(rhs);
      if (!id) return;
      const name = id[1];
      if (declaredBefore.has(name)) return;              // scoring.js loads first
      if (!inlineNames.has(name)) return;                // not a main-script name
      report('load-order', rel,
        `line ${i + 1}: top-level initialiser reads ${name}, which the MAIN script declares — ` +
        `this file loads first, so it throws ReferenceError and aborts, losing every function in it`);
    });
    // A split file's own earlier declarations are fine for the ones after it.
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) declaredBefore.add(m[1]);
    for (const k of declaredFunctions(src).keys()) declaredBefore.add(k);
  }
  note(`  split files: ${SPLIT_FILES.length} checked for load-order hazards`);
}

/* A file in frontend/js/ that no page actually loads.
 *
 * The mirror image of `missing-script`, and the one the per-game-type split needed:
 * that rule catches a <script src> naming a file that isn't there, this catches a file
 * that is there and is named by nothing. Extracting Bob's 27 into an unwired file left
 * ten functions — the whole mode's turn loop, panel and leaderboard — orphaned, and
 * every existing check passed. `missing-handler` could not see it because these are
 * called from the GAME_TYPES registry by identifier, not from an on*= attribute; the
 * browser suite would have caught it, minutes later, as a pile of confusing failures.
 *
 * Exactly extractable, so no false positives: the set of .js files on disk under
 * frontend/js/ minus the set every page's <script src> resolves to.
 */
{
  const loaded = new Set([...INDEX_SCOPE.files, ...DISPLAY_SCOPE.files]);
  const dir = path.join(ROOT, 'frontend', 'js');
  const onDisk = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(n => n.endsWith('.js')).map(n => path.join(dir, n))
    : [];
  for (const f of onDisk) {
    if (loaded.has(f)) continue;
    report('orphan-script', path.relative(ROOT, f),
      'exists but no page has a <script src> for it — every function in it is dead code');
  }
  note(`  frontend/js: ${onDisk.length} files, all reachable from a page`);
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
  console.log(`check: clean (${SOURCES.length} sources, ${CHECK_NAMES.length} checks).`);
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
