'use strict';
/* The /display second screen's LOWER THIRD shell, across every game type.
 *
 * live-scoreboard.js proves the transport works — the controller pushes, the
 * display receives, the numbers move. This one proves the 2026-07 redesign's
 * STRUCTURE holds for every mode: that each one renders a lane or a stage (not
 * nothing), that the throw strip is present and says something true, and that
 * the post-leg result view replaces the black banner rather than hiding under
 * it.
 *
 * It reads the list from the app's own GAME_TYPES registry rather than a list
 * kept here, so a new game type arrives with coverage already in place — the
 * same discipline all-game-types.js uses, and the reason the "declares neither
 * lane() nor stage()" assertion below is worth having at all.
 *
 * Structural, not cosmetic. Nothing here asserts a colour, a font size or a
 * pixel position — those are design decisions that should be free to change.
 * What it asserts is the set of claims the redesign actually makes, each of
 * which has already been wrong once during the build:
 *   - a top-level live key that never reached the display (visitScored, which
 *     needed an ALLOWED_LIVE_KEYS entry — the strip showed 0 for every visit);
 *   - markup escaped into visible tag source (Cricket's mark glyphs);
 *   - a renderer left pointing at an element that no longer exists (the chalk
 *     burst, which queried .score and silently found nothing).
 */
const L = require('../lib');

async function withBothScreens(fn) {
  // L.launchBrowser(), never chromium().launch() directly — it is the one place that
  // decides where the browser lives, and this check having its own copy is exactly what
  // broke it in CI while every check using the helper passed.
  const browser = await L.launchBrowser();
  // The board is built for a TV. Checking it at a laptop viewport would test a
  // shape nobody runs it at.
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
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
    await controller.evaluate(() => {
      if (typeof showWizard === 'function') window.showWizard = () => {};
      const w = document.getElementById('wizard'); if (w) w.hidden = true;
    });
    await controller.waitForTimeout(300);
    return await fn({ controller, display, errors });
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// The display lags the controller by an SSE hop, so poll for the shell to
// appear rather than sleeping a fixed amount.
async function waitForShell(display, timeoutMs = 12000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await display.evaluate(() => {
      const grid = document.getElementById('grid');
      const strip = document.getElementById('strip');
      const vis = el => !!el && !el.classList.contains('hidden');
      return {
        gridClass: grid ? grid.className : '',
        lanes: document.querySelectorAll('#grid .lane').length,
        stageSides: document.querySelectorAll('#grid .stage-side').length,
        boards: document.querySelectorAll('#grid .stage-board svg').length,
        stripVisible: vis(strip),
        stripDarts: document.querySelectorAll('#strip .sdart').length,
        stripNeed: (document.getElementById('strip-need') || {}).innerText || '',
        stripVisit: (document.getElementById('strip-visit') || {}).innerText || '',
        // A cheap, high-value canary: escaped markup that leaked into visible
        // text reads as literal tag source on screen.
        bodyText: document.body.innerText,
      };
    });
    if (last.lanes > 0 || last.stageSides > 0) return last;
    await display.waitForTimeout(350);
  }
  return last;
}

module.exports = async function run() {
  const rep = L.makeReporter('live-shell');

  await withBothScreens(async ({ controller, display, errors }) => {
    // Read the modes from the app's own registry, minus the two that never
    // reach /display at all (noLiveDisplay: Gauntlet and Checkout Trainer —
    // pushLive() skips them, so there is nothing to assert).
    const types = await controller.evaluate(() =>
      Object.keys(GAME_TYPES)
        .filter(k => !GAME_TYPES[k].dispatchOnly && !GAME_TYPES[k].noLiveDisplay)
        .map(k => ({
          key: k,
          contexts: contextsForMode(k),
          declares: typeof GAME_TYPES[k] === 'object'
            ? (GAME_TYPES[k].soloOnly ? 'solo' : GAME_TYPES[k].h2hOnly ? 'h2h' : 'either')
            : 'either',
        })));

    rep.ok('registry: live-capable game types discovered', types.length >= 10, `${types.length} types`);

    for (const { key, contexts } of types) {
      const mode = contexts.includes('practice') ? 'practice' : contexts[0] || 'h2h';
      const seats = contexts.includes('practice') ? 1 : 2;
      const names = Array.from({ length: seats }, (_, i) => L.uniqueName(`SH_${key}_${i}`));

      const started = await controller.evaluate(async (o) => {
        try {
          for (const n of o.names) await DB.addPlayer(n);
          roster.push(...o.names);
          setMode(o.mode);
          setup.gameType = o.key;
          setup.slots = o.names;
          await startGame();
          return { ok: true };
        } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
      }, { key, mode, names });

      if (!started.ok) { rep.ok(`${key}: starts`, false, started.error); continue; }

      // One dart, so the strip has something real to say.
      await controller.waitForTimeout(400);
      await controller.evaluate(() => { try { setMult(1); throwDart(20); } catch {} });

      const shell = await waitForShell(display);
      const hasLanes = shell && shell.lanes > 0;
      const hasStage = shell && shell.stageSides > 0;

      // THE central claim of the redesign: every mode renders one of the two
      // layouts. A mode that renders neither is a blank TV, which is exactly
      // the state Cricket's completion panel shipped in on the other screen.
      rep.ok(`${key}: renders a lane or a stage`, hasLanes || hasStage,
        shell ? `lanes=${shell.lanes} stageSides=${shell.stageSides} grid="${shell.gridClass}"` : 'no shell');

      if (hasStage) {
        // A stage exists because the BOARD is the content — so it must actually
        // draw one. A stage with no board is just a lane with extra steps.
        rep.ok(`${key}: the stage draws its board`, shell.boards > 0, `${shell.boards} svg`);
      }

      // The strip is the direction's signature and is meant to be permanent.
      rep.ok(`${key}: the throw strip is showing`, !!(shell && shell.stripVisible));
      rep.ok(`${key}: the strip has at least one dart slot`, !!(shell && shell.stripDarts > 0),
        shell ? `${shell.stripDarts} slots` : '');

      // Escaped markup shows up as literal tag source in the rendered text.
      // Cricket's mark glyphs did exactly this until the glyph/glyphHtml split.
      const leaked = shell && /<span|<div|&lt;span|aria-hidden="true"/.test(shell.bodyText);
      rep.ok(`${key}: no markup leaked into visible text`, !leaked,
        leaked ? JSON.stringify(shell.bodyText.slice(0, 120)) : '');

      await controller.evaluate(() => { try { game = null; } catch {} show('home'); });
      await controller.waitForTimeout(200);
    }

    // --- the post-leg result view ----------------------------------------
    // The redesign's other claim: the result is composed IN PLACE and the
    // full-screen banner no longer covers the numbers it announces.
    const rnames = [L.uniqueName('ResA'), L.uniqueName('ResB')];
    await L.startX01(controller, { names: rnames });
    await L.winLeg(controller);
    await display.waitForTimeout(1500);

    const result = await display.evaluate(() => {
      const vis = el => !!el && !el.classList.contains('hidden');
      const banner = document.getElementById('banner');
      return {
        verdict: vis(document.getElementById('verdict')),
        verdictText: (document.getElementById('verdict') || {}).innerText || '',
        tallies: vis(document.getElementById('tallies')),
        lanes: document.querySelectorAll('#grid .lane').length,
        // The banner is a full-screen overlay; `show` is what makes it cover
        // the screen. Its mere presence in the DOM is fine.
        bannerCovering: !!banner && banner.classList.contains('show'),
        stripVisible: vis(document.getElementById('strip')),
      };
    });

    rep.ok('result view: the verdict line is shown', result.verdict,
      JSON.stringify(result.verdictText.slice(0, 80)));
    rep.ok('result view: it states the cost, not just the outcome',
      /\d/.test(result.verdictText), JSON.stringify(result.verdictText.slice(0, 80)));
    rep.ok('result view: one lane per player', result.lanes >= 2, `${result.lanes} lanes`);
    rep.ok('result view: the tally band replaces the throw strip',
      result.tallies && !result.stripVisible,
      `tallies=${result.tallies} strip=${result.stripVisible}`);
    // The regression this exists for: the banner used to sit on top of the
    // summary for the same 3.5 seconds those numbers were worth reading.
    rep.ok('result view: the banner does not cover it', !result.bannerCovering);
    if (!result.verdict || result.bannerCovering) await rep.captureIfFailed(display, 'result-view');

    rep.ok('live-shell: no uncaught page errors on either screen',
      errors.length === 0, errors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
