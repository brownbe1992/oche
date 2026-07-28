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

// Polls a DOM predicate rather than body text, and returns the first non-null
// result. Text polling cannot express "the result card exists" — only "some
// string appeared somewhere" — which is what let the end-of-leg assertion below
// pass on a state that was about to be replaced.
async function waitForDisplayState(display, fn, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const got = await display.evaluate(fn);
    if (got) return got;
    await display.waitForTimeout(400);
  }
  return null;
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
    // The controller/display contract that has broken before: legSummary rows in,
    // a card with real numbers out.
    //
    // WHY THIS ASSERTS THE CARD AND NOT ITS HEADING. It used to wait for the text
    // /LEG COMPLETE|wins the leg|Darts Thrown/, and that assertion had its pass and
    // fail conditions backwards. A leg is announced in TWO pushes: the first carries
    // the controller's own wording ("X wins the leg") as s.message, and every later
    // push carries message:'' — at which point display.html's verdictText() falls
    // through to "X takes the leg" (the "LEG COMPLETE" branch needs no winner, so a
    // real H2H leg never reaches it). So the old regex matched only the FIRST,
    // transient state. Sample a moment later — as CI's slower machine did — and none
    // of the three alternatives could ever match again, and it polled for 15s and
    // failed on a display that was rendering the card perfectly.
    //
    // Both wordings are legitimate, so a check that pins either one is pinning a
    // race. What is actually worth asserting is the payload: the winner's darts and
    // average come straight from the legSummary winner row, so a broken contract
    // shows up here as a blank cost line or a missing lane — the exact failure this
    // check exists for, and stable in both push phases.
    await L.winLeg(controller);
    const card = await waitForDisplayState(display, () => {
      const v = document.getElementById('verdict');
      if (!v || v.classList.contains('hidden')) return null;
      const grid = document.getElementById('grid');
      return {
        verdict: (v.querySelector('.v') || {}).textContent || '',
        cost: (v.querySelector('.cost') || {}).textContent || '',
        lanes: [...(grid ? grid.querySelectorAll('.lane-name') : [])].map(el => el.textContent),
      };
    });
    rep.ok('x01: display renders an end-of-leg card', !!card,
      card ? '' : 'the #verdict element never left .hidden');
    if (card) {
      rep.ok('x01: the card names the result', /\S/.test(card.verdict), JSON.stringify(card.verdict));
      // Both players get a lane, and the winner is marked — rows.length > 1 is what
      // makes it a head-to-head card rather than a solo one.
      rep.ok('x01: both players appear on the result card', card.lanes.length === 2,
        JSON.stringify(card.lanes));
      rep.ok('x01: the winner is marked', card.lanes.some(n => n.includes('🏆')),
        JSON.stringify(card.lanes));
      // The contract payload. "28 darts · 53.7 average" — both read from the
      // legSummary winner row, which is the field mapping that has silently broken.
      rep.ok('x01: the card shows what the leg cost', /\d+\s*darts/i.test(card.cost),
        JSON.stringify(card.cost));
      rep.ok('x01: the card shows the winning average', /[\d.]+\s*average/i.test(card.cost),
        JSON.stringify(card.cost));
    }
    if (!card) await rep.captureIfFailed(display, 'x01-leg-summary');

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
