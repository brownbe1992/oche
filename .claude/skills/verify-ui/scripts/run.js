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

const CHECKS = {
  'results-takeover': './checks/results-takeover',
  'new-game': './checks/new-game',
  'ghost-picker': './checks/ghost-picker',
  'scoring-modes': './checks/scoring-modes',
  'all-game-types': './checks/all-game-types',
  'live-scoreboard': './checks/live-scoreboard',
  'home-settings': './checks/home-settings',
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
      const run = require(path.join(__dirname, CHECKS[name]));
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

  console.log('\n' + '='.repeat(60));
  for (const s of summaries) {
    const bad = s.results.filter(r => !r.passed).length;
    console.log(`${bad ? 'FAIL' : 'ok  '}  ${s.check}  (${s.results.length - bad}/${s.results.length})`);
  }
  console.log('='.repeat(60));
  console.log(`${total - failed.length}/${total} assertions passed`);

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
  console.log('All checks green.');
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('runner crashed:', err);
  process.exit(2);
});
