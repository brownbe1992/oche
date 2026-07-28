'use strict';
/* The /display second screen actually reflects the game being played.
 *
 * display.html is a separate file with its own per-game-type renderers, fed by
 * the controller POSTing to /api/live and the display listening on
 * /api/live/stream. Nothing else in either test suite loads it, and the seam
 * between the two files has a history: the controller's legSummary shape is an
 * unstated contract with the display's summary() card, and mismatches there
 * have silently produced blank or wrong end-of-leg cards before — the kind of
 * thing nobody notices until a real match is on the TV.
 *
 * These checks drive the controller in one page and read the display in
 * another, which is the only way to exercise that contract end to end.
 */
const L = require('../lib');

async function withBothScreens(fn) {
  // L.launchBrowser(), never chromium().launch() directly — see the note in lib.js.
  const browser = await L.launchBrowser();
  const ctx = await browser.newContext({ viewport: L.LANDSCAPE });
  const errors = [];
  try {
    await L.waitForServer();

    const display = await ctx.newPage();
    display.on('pageerror', e => errors.push(`display: ${e.message}`));
    await display.goto(`${L.BASE}/display`, { waitUntil: 'domcontentloaded' });
    await display.waitForTimeout(1200);   // let the SSE subscription establish

    const controller = await ctx.newPage();
    controller.on('pageerror', e => errors.push(`controller: ${e.message}`));
    await controller.goto(`${L.BASE}/`, { waitUntil: 'domcontentloaded' });
    await controller.waitForFunction(
      () => typeof startGame === 'function' && typeof DB !== 'undefined', { timeout: 30000 });
    await controller.waitForTimeout(300);

    return await fn({ controller, display, errors });
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// The display updates over SSE, so it lags the controller by a network hop —
// poll for the expected text rather than sleeping a fixed amount, which is both
// faster when it arrives quickly and more reliable when it doesn't.
async function waitForDisplayText(display, re, timeoutMs = 15000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = await display.evaluate(() => document.body.innerText);
    if (re.test(last)) return { matched: true, text: last };
    await display.waitForTimeout(400);
  }
  return { matched: false, text: last };
}

module.exports = async function run() {
  const rep = L.makeReporter('live-scoreboard');

  await withBothScreens(async ({ controller, display, errors }) => {
    const names = [L.uniqueName('LiveA'), L.uniqueName('LiveB')];

    // --- X01 -------------------------------------------------------------
    await L.startX01(controller, { names });
    const showsPlayers = await waitForDisplayText(display, new RegExp(names[0].slice(0, 12), 'i'));
    rep.ok('x01: display picks up the players from the controller', showsPlayers.matched,
      showsPlayers.matched ? '' : `display text: ${JSON.stringify(showsPlayers.text.slice(0, 160))}`);

    const shows501 = await waitForDisplayText(display, /\b501\b/);
    rep.ok('x01: display shows the starting score', shows501.matched);

    // A scored visit must move the number on the second screen, not just the
    // controller — this is the push path working end to end.
    await controller.evaluate(() => {
      setMult(3); throwDart(20); setMult(3); throwDart(20); setMult(1); throwDart(20);
      enterTurn();
    });
    const scored = await waitForDisplayText(display, /\b361\b/);   // 501 - 140
    rep.ok('x01: display updates after a scored visit', scored.matched,
      scored.matched ? '501 -> 361' : `no 361 in: ${JSON.stringify(scored.text.slice(0, 160))}`);

    // --- end-of-leg summary card -----------------------------------------
    // The controller/display contract that has broken before.
    await L.winLeg(controller);
    const summary = await waitForDisplayText(display, /LEG COMPLETE|wins the leg|Darts Thrown/i);
    rep.ok('x01: display renders an end-of-leg card', summary.matched,
      summary.matched ? '' : `display text: ${JSON.stringify(summary.text.slice(0, 200))}`);
    if (!summary.matched) await rep.captureIfFailed(display, 'x01-leg-summary');

    // --- Cricket ----------------------------------------------------------
    // A different renderer entirely (marks/closed grid rather than a countdown),
    // so it exercises the per-type dispatch rather than just the transport.
    const cnames = [L.uniqueName('LiveC'), L.uniqueName('LiveD')];
    await controller.evaluate(async (opts) => {
      for (const n of opts.names) await DB.addPlayer(n);
      roster.push(...opts.names);
      setMode('h2h');
      setup.gameType = 'cricket';
      setup.slots = opts.names;
      await startGame();
    }, { names: cnames });
    await controller.waitForTimeout(400);
    await controller.evaluate(() => { setMult(3); throwDart(20); enterTurn(); });

    const cricket = await waitForDisplayText(display, /\b20\b/);
    rep.ok('cricket: display switches to the cricket card', cricket.matched,
      cricket.matched ? '' : `display text: ${JSON.stringify(cricket.text.slice(0, 160))}`);
    if (!cricket.matched) await rep.captureIfFailed(display, 'cricket-card');

    rep.ok('live-scoreboard: no uncaught page errors on either screen',
      errors.length === 0, errors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
