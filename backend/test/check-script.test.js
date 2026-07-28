'use strict';
// backend/check.js is the project's linter, and a linter that has quietly stopped
// detecting anything looks exactly like a clean codebase. So this file does two
// things the checker cannot do for itself.
//
// 1. IT MUST PASS ON THE REAL TREE. If check.js ever reports a finding against the
//    committed source, that is a failing test — the same bar the backend suite and
//    verify-ui hold. The SessionStart hook only warns.
//
// 2. EVERY CHECK MUST STILL CATCH ITS OWN BUG. Each case below copies the real
//    source into a scratch tree, injects one instance of exactly one defect class,
//    and asserts the checker reports it. This is the same revert-the-fix discipline
//    used for the rest of the suite, applied to the tool instead of the code: a
//    regex that stops matching (the `async function` gap that made an early draft
//    report seven live handlers as broken) fails here rather than going unnoticed
//    while the checker prints "clean".
//
// The injections are deliberately placed at column 0 and on their own lines,
// because that is what the checker's declaration regex looks for — a fixture that
// happens to land at an indent proves nothing and silently passes.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
let scratch;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-check-'));
  for (const dir of ['backend', 'frontend', 'backend/test']) {
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO, 'backend/check.js'), path.join(scratch, 'backend/check.js'));
  for (const f of ['frontend/index.html', 'frontend/display.html', 'frontend/scoring.js']) {
    fs.copyFileSync(path.join(REPO, f), path.join(scratch, f));
  }
  for (const f of ['backend/db.js', 'backend/server.js', 'backend/auth.js']) {
    if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), path.join(scratch, f));
  }
});

after(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {} });

// Runs the checker against whichever tree it is given. Exit code 1 means findings,
// so a non-zero status is expected output here rather than a failure to run.
function runCheck(root) {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'backend/check.js')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// Copies the pristine file, applies one mutation, runs, then restores — so each
// case tests exactly one defect class with no interference from the last.
function withInjection(relFile, mutate, assertion) {
  const target = path.join(scratch, relFile);
  const pristine = fs.readFileSync(path.join(REPO, relFile), 'utf8');
  const mutated = mutate(pristine);
  assert.notEqual(mutated, pristine, `the injection for ${relFile} did not change anything — the fixture is stale`);
  fs.writeFileSync(target, mutated);
  try { assertion(runCheck(scratch)); }
  finally { fs.writeFileSync(target, pristine); }
}

describe('backend/check.js', () => {
  test('reports nothing against the committed source', () => {
    const r = runCheck(REPO);
    assert.equal(r.code, 0, `check.js found problems in the real tree:\n${r.out}`);
    assert.match(r.out, /check: clean/);
  });

  test('catches a duplicate top-level function declaration', () => {
    // Legal JavaScript, no error anywhere, and the earlier definition is simply
    // gone. In a single 18k-line scope holding 657 functions this is a real way
    // to lose a function while every test still passes.
    withInjection('frontend/index.html',
      s => s.replace('\nfunction renderSlots(){', '\nfunction renderSlots(){\n}\nfunction renderSlots(){', 1),
      r => {
        assert.equal(r.code, 1);
        assert.match(r.out, /duplicate-function/);
        assert.match(r.out, /renderSlots\(\) declared 2x/);
      });
  });

  test('catches an inline handler naming a function that does not exist', () => {
    // The check the ES-module split depends on: an on*= handler resolves its
    // names against the global object at CLICK time, so a broken one throws
    // nothing at load and no existing test sees it.
    withInjection('frontend/index.html',
      s => s.replace('onclick="show(\'home\')"', 'onclick="noSuchFunctionExists()"', 1),
      r => {
        assert.equal(r.code, 1);
        assert.match(r.out, /missing-handler/);
        assert.match(r.out, /noSuchFunctionExists\(\)/);
      });
  });

  test('does NOT flag an async function called from a handler', () => {
    // The regression that motivated this file. `async function f()` is a
    // declaration exactly like `function f()`; an early draft matched only the
    // second form and reported seven live handlers (submitWizard, resumeGame,
    // beginTournamentMatch, …) as broken. A checker that reports working code is
    // worse than none, because it gets switched off.
    const r = runCheck(REPO);
    assert.equal(r.code, 0);
    for (const name of ['submitWizard', 'resumeGame', 'beginTournamentMatch', 'shareEarnedBadge']) {
      assert.ok(!r.out.includes(name), `${name} is an async function reached from a handler and must not be reported`);
    }
  });

  test('catches a getElementById for an id nothing creates', () => {
    withInjection('frontend/index.html',
      s => s.replace("getElementById('scoreboard')", "getElementById('scoreboard-typo-xyz')", 1),
      r => {
        assert.equal(r.code, 1);
        assert.match(r.out, /missing-id/);
        assert.match(r.out, /scoreboard-typo-xyz/);
      });
  });

  test('does NOT flag an id built by interpolation or concatenation', () => {
    // `id="db-slot-${type}"` and `getElementById('db-slot-'+type)` between them
    // mean the literal `db-slot-barrel` never appears in the file, though the
    // element is real. Three of these were reported before the constructed-id
    // prefixes were taken into account.
    const r = runCheck(REPO);
    assert.equal(r.code, 0);
    for (const id of ['db-slot-barrel', 'db-slot-shaft', 'db-slot-flight']) {
      assert.ok(!r.out.includes(id), `${id} is a constructed id and must not be reported`);
    }
  });

  test("catches a name in scoring.js's CommonJS export list that is not defined", () => {
    // The browser gets every top-level name free via <script src>; Node gets only
    // what the literal names. So a drifted name is undefined in exactly one
    // environment — the tests.
    withInjection('frontend/scoring.js',
      s => s.replace('module.exports = {', 'module.exports = {\n    aNameThatIsNotDefined,', 1),
      r => {
        assert.equal(r.code, 1);
        assert.match(r.out, /scoring-exports/);
        assert.match(r.out, /aNameThatIsNotDefined/);
      });
  });

  test('catches a top-level function nothing references', () => {
    withInjection('frontend/scoring.js',
      s => 'function aFunctionNobodyCallsEver(){ return 1; }\n' + s,
      r => {
        assert.equal(r.code, 1);
        assert.match(r.out, /unused-function/);
        assert.match(r.out, /aFunctionNobodyCallsEver/);
      });
  });
});
