'use strict';
/* Home ticker and Settings tile summaries — small render-state properties.
 *
 * Both regressions here were of the same species: a branch that looks correct
 * reading the source but never actually runs. The ticker's "hide when there's
 * nothing to show" path was unreachable because an always-present item was
 * pushed before the emptiness test; the Settings tile summary went stale
 * because the value was changed from script, and script-set properties fire no
 * change event for the delegated listener that refreshes those summaries.
 */
const L = require('../lib');

// Settings -> Board colours. One setting: which of the two zone schemes sector 20
// sits on, so the on-screen board can be matched to a physical board that has
// been rotated to spread its wear. The model is unit-tested in
// backend/test/board-colors.test.js; this covers the wiring — the two options
// exist, picking one repaints the preview with the WHOLE pair, and the saved
// choice reaches the SVG the player actually taps.
async function boardColors(rep) {
  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    await page.evaluate(async () => {
      // Settings needs an admin session; this is a throwaway scratch database.
      await fetch('/api/setup', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ username:'bcadmin', password:'bcadmin-pw' }) });
      await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ username:'bcadmin', password:'bcadmin-pw' }) });
      show('settings');
    });
    await page.evaluate(() => renderSettings());
    await page.waitForTimeout(900);
    await page.evaluate(() => { const b = document.getElementById('board-colors-body'); if (b) b.hidden = false; });
    await page.waitForTimeout(200);

    const start = await page.evaluate(() => {
      const checked = document.querySelector('#board-scheme-choice input:checked');
      return { options: [...document.querySelectorAll('#board-scheme-choice input')].map(i => i.value),
               chosen: checked && checked.value,
               tile: (document.getElementById('tile-state-board-colors') || {}).textContent,
               // There must be no colour inputs anywhere in this tile — the
               // colours are constants, not a preference.
               colourInputs: document.querySelectorAll('#board-colors-body input[type="color"]').length };
    });
    rep.ok('board colours: exactly the two schemes are offered',
      start.options.join() === 'red_black,green_white', start.options.join());
    rep.ok('board colours: an unrotated board is the default',
      start.chosen === 'red_black', String(start.chosen));
    rep.ok('board colours: the tile names the scheme sector 20 sits on',
      /Red & black/.test(start.tile || ''), start.tile);
    rep.ok('board colours: no individual colour pickers are exposed',
      start.colourInputs === 0, `${start.colourInputs} colour inputs found`);

    // Switching must repaint the preview, moving the whole pair.
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('#board-color-preview path')].slice(0, 4).map(p => p.getAttribute('fill')));
    // Click the LABEL, not the input: the radio is visually hidden (kept
    // focusable rather than display:none, so the group stays keyboard-operable),
    // and the swatch chip sits over it. Clicking the label is what a person
    // actually does, so this is the more faithful check anyway.
    await page.click('#board-scheme-choice label:has(input[value="green_white"])');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('#board-color-preview path')].slice(0, 4).map(p => p.getAttribute('fill')));
    rep.ok('board colours: switching the scheme repaints the preview',
      before.join() !== after.join(), `${before.join()} -> ${after.join()}`);
    // Sector 20 is the first sector drawn, so its first two paths are the bed and
    // the treble ring of whatever scheme it now has.
    rep.ok('board colours: sector 20 takes the whole pair, bed and ring together',
      after[0] === '#cbbf96' && after[1] === '#17752f', after.slice(0, 2).join());

    await page.evaluate(() => saveSettings());
    await page.waitForTimeout(1200);
    const stored = await page.evaluate(() => fetch('/api/settings/board-colors').then(r => r.json()));
    rep.ok('board colours: the choice persists', stored.sector20 === 'green_white', stored.sector20);

    await page.evaluate(() => { const m = document.querySelector('.modal-backdrop'); if (m) m.remove(); });
    await L.startX01(page, { names: [L.uniqueName('BcA'), L.uniqueName('BcB')], startScore: 501 });
    await page.evaluate(() => { dartboardMode = true; applyDartMode(); });
    await page.waitForTimeout(400);
    const board = await page.evaluate(() => {
      const fills = [...document.querySelectorAll('#dart-board-wrap path')].map(p => p.getAttribute('fill'));
      const texts = [...document.querySelectorAll('#dart-board-wrap text')];
      return { fills: fills.slice(0, 4),
               allSafe: fills.every(f => /^#[0-9a-f]{6}$/i.test(f)),
               bullLabel: texts.length ? texts[texts.length - 1].getAttribute('fill') : null };
    });
    rep.ok('board colours: the saved choice reaches the board you actually tap',
      board.fills[0] === '#cbbf96' && board.fills[1] === '#17752f', board.fills.join());
    rep.ok('board colours: every fill on the board is a plain hex literal', board.allSafe);
    // Sector 20 now carries the green ring, so the inner bull is green and the
    // "Bull" label must be the cream option (4.70:1) rather than the near-black
    // one it uses on red.
    rep.ok('board colours: the Bull label follows sector 20\'s ring colour',
      board.bullLabel === '#efe7d2', String(board.bullLabel));

    rep.ok('board-colours: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'board-colors');

    // Put the scheme back. This check asserts that red_black is the DEFAULT and
    // then persists green_white over it, so without this it only passes against a
    // never-touched database — run it twice against the same one (which happens
    // whenever the runner reuses an already-listening server, its documented
    // behaviour) and three assertions fail with "green_white", looking exactly
    // like a real regression in code that was never touched. Deliberately no
    // assertion here: this is cleanup, and adding one would change the check's
    // assertion count in run.js for something that isn't a property of the app.
    // The admin session logged in at the top of this check is still valid, which
    // is what makes the admin-only PUT below work.
    await page.evaluate(async () => {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board_sector20_scheme: 'red_black' }),
      });
    });
  });
}

module.exports = async function run() {
  const rep = L.makeReporter('home-settings');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    /* The stylesheet actually loaded and applied.
     *
     * `frontend/app.css` was inline in index.html's <head> until 2026-07. Once it
     * became a separate file it acquired a silent failure mode: server.js's static
     * handler falls back to index.html for any unknown non-API path, so a typo'd
     * href returns a whole HTML page in answer to a CSS request. The browser
     * discards it without a console error and renders every screen unstyled — and
     * every behavioural assertion in this suite still passes, because the DOM and
     * the handlers are all exactly where they should be. `check.js`'s
     * missing-stylesheet rule catches the typo statically; this catches the case
     * where the file exists and is served but isn't reaching the page.
     *
     * Two independent signals, because either alone is weaker than it looks:
     * `--board` proves the file parsed, and body padding proves a rule actually
     * matched and applied. An unstyled body has padding 0. Deliberately NOT
     * body backgroundColor — the page background is a `fixed` radial-gradient, so
     * backgroundColor is legitimately transparent even when fully styled. */
    const styled = await page.evaluate(() => ({
      pad: getComputedStyle(document.body).padding,
      board: getComputedStyle(document.documentElement).getPropertyValue('--board').trim(),
    }));
    rep.ok('app.css is loaded and applied', styled.pad === '18px' && styled.board === '#0e0f0d',
      `body padding "${styled.pad}", --board "${styled.board}"`);

    // NOTE for anyone extending this: `homeData` is a top-level `let`, which in
    // a classic script is NOT a property of window. Assigning window.homeData
    // creates an unrelated property and the function under test keeps reading
    // its own unchanged binding — a bare assignment inside page.evaluate is
    // what actually reaches it. This cost a false "FAIL" once.
    const ticker = await page.evaluate(() => {
      const saved = homeData;
      homeData = { s: { oneEighties: 0 }, extra: {} };
      renderHomeTicker();
      const hiddenWhenNothingToSay = document.getElementById('home-ticker').hidden;

      homeData = { s: { oneEighties: 12 }, extra: {} };
      renderHomeTicker();
      const shownWithRealActivity = !document.getElementById('home-ticker').hidden;

      homeData = saved;
      return { hiddenWhenNothingToSay, shownWithRealActivity };
    });
    rep.ok('ticker: hidden on a household with no activity yet', ticker.hiddenWhenNothingToSay);
    rep.ok('ticker: shown once there is real activity', ticker.shownWithRealActivity);

    const tile = await page.evaluate(() => {
      const cb = document.getElementById('require-admin-auth');
      const label = document.getElementById('tile-state-require-auth');
      if (!cb || !label) return { skipped: true };
      cb.checked = true; refreshSettingsTileStates();
      const before = label.textContent.trim();
      cb.checked = false; refreshSettingsTileStates();
      return { before, after: label.textContent.trim() };
    });
    if (tile.skipped) {
      rep.ok('settings tile: control present', false, 'require-admin-auth tile not found — layout changed');
    } else {
      rep.ok('settings tile: summary tracks a script-driven change',
        tile.before !== tile.after && /off/i.test(tile.after),
        `"${tile.before}" -> "${tile.after}"`);
    }

    rep.ok('home-settings: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'home-settings');
  });

  await boardColors(rep);
  return rep.finish();
};
