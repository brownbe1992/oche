#!/usr/bin/env node
'use strict';
/* Runner for the verify-ui checks.
 *
 *   node .claude/skills/verify-ui/scripts/run.js              # everything
 *   node .claude/skills/verify-ui/scripts/run.js ghost-picker # one check
 *   node .claude/skills/verify-ui/scripts/run.js --list
 *
 * Checks run in SERIES, deliberately. They all drive one server that rate-limits
 * 300 requests per 60s per IP; running them concurrently makes them starve each
 * other and produces failures that look like application bugs. The suite is
 * slower this way and much more trustworthy.
 */
const path = require('path');
const L = require('./lib');

/* Each check, and HOW MANY ASSERTIONS IT MUST RUN.
 *
 * The count is not bookkeeping — it is the check on the checks. A suite that only
 * reports what it happened to run cannot tell "everything passed" from "most of it
 * never executed", and both print as green.
 *
 * That is not hypothetical: when two checks threw on a CI runner (a browser path that
 * existed locally and not there), the suite reported **385/387 assertions passed** and
 * a tidy list with two FAIL lines. It looked 99% healthy. In fact 72 assertions had not
 * run at all, and the total had silently shrunk from 457 to 387 to match — the
 * denominator moved with the numerator, so nothing looked wrong.
 *
 * A count that is too LOW is therefore a failure in its own right, whatever the
 * assertions that did run said. It catches a check that throws, one that returns early
 * past half its body, and one whose setup silently produced no rows to assert on.
 *
 * Raising a number here is a deliberate act, done in the same commit that adds the
 * assertions. If this file disagrees with reality the suite tells you which way and by
 * how much.
 */
const CHECKS = {
  'results-takeover':      { path: './checks/results-takeover',      assertions: 29 },
  'new-game':              { path: './checks/new-game',              assertions: 47 },
  'ghost-picker':          { path: './checks/ghost-picker',          assertions: 11 },
  'scoring-modes':         { path: './checks/scoring-modes',         assertions: 32 },
  'all-game-types':        { path: './checks/all-game-types',        assertions: 82 },
  'turn-loop':             { path: './checks/turn-loop',             assertions: 47 },
  'save-resume':           { path: './checks/save-resume',           assertions: 6 },
  'leg-reset':             { path: './checks/leg-reset',             assertions: 12 },
  'resume-fidelity':       { path: './checks/resume-fidelity',       assertions: 18 },
  'pad-reuse':             { path: './checks/pad-reuse',             assertions: 19 },
  'profile-a11y':          { path: './checks/profile-a11y',          assertions: 10 },
  'route-recall':          { path: './checks/route-recall',          assertions: 16 },
  'mode-state-hygiene':    { path: './checks/mode-state-hygiene',    assertions: 16 },
  'challenge-scoreboards': { path: './checks/challenge-scoreboards', assertions: 52 },
  'keyboard':              { path: './checks/keyboard',              assertions: 14 },
  'live-scoreboard':       { path: './checks/live-scoreboard',       assertions: 11 },
  'live-shell':            { path: './checks/live-shell',            assertions: 66 },
  'home-settings':         { path: './checks/home-settings',         assertions: 16 },
  'home-leaderboards':     { path: './checks/home-leaderboards',     assertions: 6 },
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    console.log(Object.keys(CHECKS).join('\n'));
    return 0;
  }

  const requested = args.filter(a => !a.startsWith('-'));
  const unknown = requested.filter(n => !CHECKS[n]);
  if (unknown.length) {
    console.error(`unknown check(s): ${unknown.join(', ')}`);
    console.error(`available: ${Object.keys(CHECKS).join(', ')}`);
    return 2;
  }
  const names = requested.length ? requested : Object.keys(CHECKS);

  // Reuse an already-running server on this port if there is one; otherwise
  // start a private one against a scratch DB so the checks' throwaway players
  // and legs never land in a database anyone cares about.
  let server = null;
  let reusedExisting = false;
  try {
    const res = await fetch(`${L.BASE}/api/health`);
    reusedExisting = res.ok;
  } catch { /* nothing listening */ }

  if (reusedExisting) {
    console.log(`Using the server already listening on ${L.BASE}.\n`);
  } else {
    console.log(`Starting a server on ${L.BASE} (scratch DB: ${L.DB_PATH}).\n`);
    server = L.startServer();
    await L.waitForServer();
  }

  const summaries = [];
  try {
    for (const name of names) {
      console.log(`\n=== ${name} ===`);
      const run = require(path.join(__dirname, CHECKS[name].path));
      try {
        summaries.push(await run());
      } catch (err) {
        console.log(`  [FAIL] ${name} threw — ${err.message}`);
        summaries.push({ check: name, passed: false, results: [{ label: `${name} threw`, passed: false, detail: err.message }] });
      }
      // Let the rate-limit window drain between checks. Cheaper than having the
      // next check fail on a 429 and needing a rerun to tell that apart from a
      // genuine regression.
      await L.waitForServer();
    }
  } finally {
    if (server) L.stopServer(server);
  }

  const total = summaries.reduce((n, s) => n + s.results.length, 0);
  const failed = summaries.flatMap(s => s.results.filter(r => !r.passed));
  const shots = summaries.flatMap(s => s.artifacts || []);

  // Expected only for the checks this run was actually asked for, so running one
  // check doesn't report the other seventeen as missing.
  const expectedTotal = names.reduce((n, name) => n + CHECKS[name].assertions, 0);
  const shortfalls = summaries
    .map(s => ({ check: s.check, ran: s.results.length, want: CHECKS[s.check].assertions }))
    .filter(s => s.ran < s.want);

  console.log('\n' + '='.repeat(60));
  for (const s of summaries) {
    const bad = s.results.filter(r => !r.passed).length;
    const want = CHECKS[s.check].assertions;
    const missing = want - s.results.length;
    console.log(`${bad ? 'FAIL' : 'ok  '}  ${s.check}  (${s.results.length - bad}/${s.results.length})` +
      (missing > 0 ? `   [expected ${want} — ${missing} never ran]` : ''));
  }
  console.log('='.repeat(60));
  console.log(`${total - failed.length}/${total} assertions passed` +
    (total < expectedTotal ? `  —  but ${expectedTotal} were expected` : ''));

  if (shortfalls.length) {
    // Deliberately louder than a failed assertion. A failing assertion tells you
    // something is broken; this tells you the suite does not know whether it is.
    console.log('\nCOVERAGE LOSS — these checks ran fewer assertions than they should have:');
    for (const s of shortfalls) console.log(`  - ${s.check}: ran ${s.ran}, expected ${s.want}`);
    console.log('\nEither the check stopped early (look for a throw above) or it legitimately');
    console.log('changed — if the new count is right, update it in CHECKS in this file, in the');
    console.log('same commit that changed the assertions.');
  }

  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
    if (shots.length) {
      // Worth looking at before theorising: a layout failure is usually obvious
      // on sight and ambiguous from the numbers alone.
      console.log('\nScreenshots at the point of failure:');
      for (const a of shots) console.log(`  - ${a.file}`);
    }
    return 1;
  }
  // A shortfall fails the run on its own. A check that quietly ran three of its
  // twenty assertions and passed all three is not a green suite, and the whole
  // point of counting is that nobody has to notice the number by eye.
  if (shortfalls.length) return 1;
  console.log('All checks green.');
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('runner crashed:', err);
  process.exit(2);
});
