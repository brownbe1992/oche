'use strict';
/* =============================================================================
   Shared harness for the verify-ui browser checks.

   Everything in here exists because it was learned the hard way against this
   specific app + container. If a check is behaving strangely, the cause is
   usually one of the constraints encoded below rather than the check itself.
   ============================================================================= */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Deliberately NOT 8046 (the usual dev port) and NOT the repo's default DB.
// The checks create players and drive dozens of throwaway legs; pointing them
// at a scratch database on a separate port keeps that out of whatever you were
// actually working with, and lets the suite run while a dev server is already up.
const PORT = Number(process.env.VERIFY_UI_PORT || 8146);
const BASE = `http://localhost:${PORT}`;
const DB_PATH = process.env.VERIFY_UI_DB
  || path.join(os.tmpdir(), `oche-verify-ui-${process.pid}.db`);

const CHROMIUM = process.env.VERIFY_UI_CHROMIUM || '/opt/pw-browsers/chromium';

function repoRoot() {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
}

/* ---------------------------------------------------------------------------
   Server lifecycle
   --------------------------------------------------------------------------- */

// A plain `node server.js &` gets killed when the invoking shell goes away,
// which shows up much later as a confusing ERR_CONNECTION_REFUSED mid-suite.
// setsid + detached + ignored stdio survives that.
function startServer() {
  const root = repoRoot();
  const child = spawn('node', ['server.js'], {
    cwd: path.join(root, 'backend'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DARTS_DB: DB_PATH,
      // Writes need an admin session otherwise, and these checks drive the app
      // through its own write paths. Safe here precisely because this is a
      // throwaway DB on a throwaway port — do NOT copy this into anything that
      // touches a real database (every compose file keeps auth ON by default).
      OCHE_REQUIRE_AUTH: 'false',
      // The single biggest source of spurious failures in this suite. server.js
      // allows 300 requests/60s/IP; driving a dozen full games blows through that,
      // and once tripped the server 429s EVERYTHING — the next check's page load
      // included, which then fails in a way that looks nothing like rate limiting.
      // waitForServer() below only ever proved the window had rolled, never that
      // there was budget left in it, so a check could still exhaust it mid-run —
      // which is exactly what produced the "one random check fails per full run,
      // every check passes alone" pattern. Raised only for this throwaway server;
      // the limiter isn't what this suite tests, and the default is untouched
      // everywhere else.
      OCHE_RATE_LIMIT_GLOBAL: '100000',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// A database this file invented is ours to delete; one the caller named via
// VERIFY_UI_DB is theirs. Deleting the latter would silently destroy a seeded
// fixture (backend/seed-dev-db.js) that took a command to build, on a run that
// otherwise succeeded.
const OWNS_DB = !process.env.VERIFY_UI_DB;

function stopServer(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  if (!OWNS_DB) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* fine */ }
  }
}

// Blocks until the server answers a real 200.
//
// This used to be the suite's rate-limit defence, and it was never sufficient: a
// single 200 proves the fixed window has rolled, NOT that there is budget left in
// it, so a check could still exhaust the remaining allowance partway through. That
// is what produced the long-running "exactly one check fails per full run, a
// different one each time, every check passes in isolation" pattern. The cause is
// now removed at the source — startServer() raises OCHE_RATE_LIMIT_GLOBAL for its
// own throwaway server — so this is back to being what its name says: a readiness
// check for a server that is still booting.
//
// It is still called between checks. If the suite is ever pointed at a server it
// did not start (the runner reuses one already listening on the port), that server
// keeps the normal 300/60s limit and this is the only cushion there is.
async function waitForServer({ timeoutMs = 180000 } = {}) {
  const started = Date.now();
  let lastStatus = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      lastStatus = res.status;
      if (res.ok) return;
    } catch { lastStatus = 0; }
    await sleep(2000);
  }
  throw new Error(`server not ready at ${BASE} within ${timeoutMs}ms (last status ${lastStatus})`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
   Browser lifecycle
   --------------------------------------------------------------------------- */

function chromium() {
  // Playwright is installed globally in this image, not in the repo (which has
  // no node_modules at all by design). NODE_PATH is exported by
  // .claude/hooks/session-start.sh; this fallback keeps the suite runnable if
  // the hook hasn't run.
  try {
    return require('playwright').chromium;
  } catch {
    const fallback = '/opt/node22/lib/node_modules';
    if (fs.existsSync(fallback)) {
      module.paths.push(fallback);
      return require('playwright').chromium;
    }
    throw new Error("can't load playwright — try NODE_PATH=/opt/node22/lib/node_modules");
  }
}

// Runs `fn(page)` against a fresh context at the given viewport.
//
// Two non-obvious choices:
//  - waitUntil:'domcontentloaded', not 'load'. A resource in this environment
//    intermittently resets, and 'load' then hangs until timeout even though the
//    app is perfectly usable.
//  - waitForFunction on a real app global rather than a DOM selector, because
//    the markup exists before the inline <script> has finished defining the
//    functions the checks drive.
async function withPage(viewport, fn) {
  const browser = await chromium().launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  try {
    await waitForServer();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof startGame === 'function' && typeof show === 'function' && typeof DB !== 'undefined',
      { timeout: 30000 });
    await page.waitForTimeout(300);
    await dismissFirstRunWizard(page);
    return await fn(page, pageErrors);
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// A scratch database has no admin account, so the app opens its first-run
// "Welcome to Oche / create an admin account" wizard over everything. It never
// appears against a real database, so leaving it up would make every check run
// against a screen no user sees — clicks can land on the overlay, and every
// failure screenshot comes back obscured by it. Dismissing it is closing a
// setup step the checks aren't about, not suppressing app behaviour.
// It is opened by showWizard(), which fires only once an async admin-existence
// check resolves — so dismissing it once at load races it and usually loses.
// Neutering showWizard() instead is deterministic, and safe to do here because
// nothing in this suite is about first-run account setup: it only appears at
// all because the checks deliberately run against an empty scratch database.
async function dismissFirstRunWizard(page) {
  try {
    await page.evaluate(() => {
      if (typeof showWizard === 'function') window.showWizard = () => {};
      if (typeof closeWizard === 'function') closeWizard();
      const wiz = document.getElementById('wizard');
      if (wiz) wiz.hidden = true;
    });
    await page.waitForTimeout(150);
  } catch { /* no wizard on this build — nothing to do */ }
}

const PORTRAIT = { width: 820, height: 1180 };
const LANDSCAPE = { width: 1180, height: 820 };
// Short viewports are what expose "content overflows with nothing to scroll",
// which is invisible at a comfortable window size.
const PORTRAIT_SHORT = { width: 390, height: 520 };
const LANDSCAPE_SHORT = { width: 1024, height: 380 };

/* ---------------------------------------------------------------------------
   Driving the app
   --------------------------------------------------------------------------- */

// Games are driven through the app's own globals rather than by clicking the
// dartboard. Clicking tests the SVG hit-testing (a different concern, and slow
// and brittle); these checks are about what the screen does in response to
// scoring, so going straight at setMult/throwDart/enterTurn is both faster and
// far less flaky.
async function startX01(page, { names, mode = 'h2h', startScore, legs, sets } = {}) {
  await page.evaluate(async (opts) => {
    for (const n of opts.names) await DB.addPlayer(n);
    roster.push(...opts.names);
    setMode(opts.mode);
    setup.gameType = 'x01';
    setup.slots = opts.names;
    if (opts.startScore != null) setup.startScore = opts.startScore;
    if (opts.legs != null) setup.legs = opts.legs;
    if (opts.sets != null) setup.sets = opts.sets;
    await startGame();
  }, { names, mode, startScore, legs, sets });
  await page.waitForTimeout(400);
}

// Drives the CURRENT player's score to zero and checks out. Kept inside one
// page.evaluate because these functions are synchronous — round-tripping per
// dart is both slower and introduces races with the app's own re-renders.
//
// `big:false` avoids scoring 180s, which fire a full-screen moment card that
// covers the screen for several seconds and confuses anything that screenshots
// or measures layout straight afterwards.
async function winLeg(page, { big = false, guard = 900 } = {}) {
  await page.evaluate(({ big, guard }) => {
    let n = 0;
    while (!game.won && n < guard) {
      const r = game.players[game.current].score;
      if (r > (big ? 170 : 60)) { setMult(big ? 3 : 1); throwDart(20); }
      else if (r > 40 || r % 2 !== 0) { setMult(1); throwDart(1); }
      else { setMult(2); throwDart(r / 2); }
      if (game.won || game.darts.length === 3 || game.busted) enterTurn();
      n++;
    }
  }, { big, guard });
  await page.waitForTimeout(1200);
}

const uniqueName = prefix => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

/* ---------------------------------------------------------------------------
   Result reporting
   --------------------------------------------------------------------------- */

// Failure artifacts land here. A failing layout assertion is very hard to
// reason about from a boolean alone — "board hidden: false" doesn't tell you
// whether the board is on top of the card, beside it, or the whole screen is
// blank. A screenshot answers that instantly, and capturing it at the moment of
// failure avoids the reconstruct-the-scenario-by-hand step entirely.
const ARTIFACTS = process.env.VERIFY_UI_ARTIFACTS
  || path.join(os.tmpdir(), 'oche-verify-ui-artifacts');

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function makeReporter(checkName) {
  const results = [];
  const artifacts = [];
  return {
    ok(label, passed, detail) {
      results.push({ label, passed: !!passed, detail: detail == null ? '' : String(detail) });
      const mark = passed ? 'PASS' : 'FAIL';
      console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
    },
    failedSoFar() {
      return results.filter(r => !r.passed).length;
    },
    // Call before leaving a withPage() block. Screenshots only when something in
    // that block failed, so a green run leaves no clutter behind.
    async captureIfFailed(page, label) {
      if (!results.some(r => !r.passed)) return null;
      if (artifacts.some(a => a.label === label)) return null;   // one per block
      try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        const file = path.join(ARTIFACTS, `${slug(checkName)}--${slug(label)}.png`);
        // Hide the achievement overlay for the shot only. It is genuine app
        // behaviour (Night Owl fires on any dart between midnight and 5am, so
        // whether it appears depends on the wall clock), but it covers the
        // middle of the screen — precisely where the thing being diagnosed
        // usually is. Assertions read the DOM and are unaffected either way.
        await page.evaluate(() => {
          const ach = document.getElementById('ach-overlay');
          if (ach) ach.style.visibility = 'hidden';
        }).catch(() => {});
        await page.screenshot({ path: file, fullPage: false });
        await page.evaluate(() => {
          const ach = document.getElementById('ach-overlay');
          if (ach) ach.style.visibility = '';
        }).catch(() => {});
        artifacts.push({ label, file });
        console.log(`  [shot] ${file}`);
        return file;
      } catch (err) {
        console.log(`  [shot] could not capture (${err.message})`);
        return null;
      }
    },
    finish(pageErrors = []) {
      for (const e of pageErrors) {
        results.push({ label: 'no uncaught page errors', passed: false, detail: e });
        console.log(`  [FAIL] uncaught page error — ${e}`);
      }
      const failed = results.filter(r => !r.passed);
      console.log(`${checkName}: ${results.length - failed.length}/${results.length} passed`);
      return { check: checkName, results, artifacts, passed: failed.length === 0 };
    },
  };
}

module.exports = {
  BASE, PORT, DB_PATH,
  startServer, stopServer, waitForServer, sleep,
  withPage, chromium,
  PORTRAIT, LANDSCAPE, PORTRAIT_SHORT, LANDSCAPE_SHORT,
  startX01, winLeg, uniqueName,
  makeReporter, repoRoot,
};
