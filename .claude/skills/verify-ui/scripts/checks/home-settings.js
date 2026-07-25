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

module.exports = async function run() {
  const rep = L.makeReporter('home-settings');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
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

  return rep.finish();
};
