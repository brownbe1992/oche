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

// Settings -> Board colours. The whole feature rests on one behaviour that no
// unit test can see: changing sector 20 has to move the rest of the board, in
// the form, immediately. The derivation itself is covered by
// backend/test/board-colors.test.js; this covers the wiring around it — the
// pickers exist, the derived swatches follow, editing one promotes it to an
// override that then STOPS following, and the saved scheme actually reaches the
// SVG the player taps.
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
      const v = id => (document.getElementById(id) || {}).value;
      return { singleA: v('board-single-a'), ringA: v('board-ring-a'),
               singleB: v('board-single-b'), ringB: v('board-ring-b'),
               tile: (document.getElementById('tile-state-board-colors') || {}).textContent };
    });
    rep.ok('board colours: a fresh household shows the classic four',
      start.singleA === '#cbbf96' && start.ringA === '#c8102e'
      && start.singleB === '#1c1e1a' && start.ringB === '#1b8a3a', JSON.stringify(start));
    rep.ok('board colours: the tile reads Classic before anything is changed',
      (start.tile || '').trim() === 'Classic', start.tile);

    // Change sector 20 -> both derived swatches must move.
    const derived = await page.evaluate(() => {
      document.getElementById('board-single-a').value = '#3060a0';
      document.getElementById('board-ring-a').value = '#f2c14e';
      onBoardColorInput('a');
      const v = id => document.getElementById(id).value;
      return { singleB: v('board-single-b'), ringB: v('board-ring-b'),
               tile: document.getElementById('tile-state-board-colors').textContent.trim(),
               previewFills: [...new Set([...document.querySelectorAll('#board-color-preview path')]
                 .map(p => p.getAttribute('fill')))].sort() };
    });
    rep.ok('board colours: changing sector 20 moves the derived pair',
      derived.singleB !== start.singleB && derived.ringB !== start.ringB, JSON.stringify(derived));
    rep.ok('board colours: the tile flips to Custom', derived.tile === 'Custom', derived.tile);
    rep.ok('board colours: the preview repaints with exactly the four colours',
      derived.previewFills.length === 4
      && derived.previewFills.includes('#3060a0') && derived.previewFills.includes('#f2c14e'),
      JSON.stringify(derived.previewFills));

    // Editing a derived swatch promotes it to an override, which then stops following.
    const overridden = await page.evaluate(() => {
      document.getElementById('board-single-b').value = '#ffcc00';
      onBoardColorInput('b');
      document.getElementById('board-single-a').value = '#802020';
      onBoardColorInput('a');
      return { singleB: document.getElementById('board-single-b').value,
               note: document.getElementById('board-derived-note').textContent };
    });
    rep.ok('board colours: an overridden swatch stops following sector 20',
      overridden.singleB === '#ffcc00', overridden.singleB);
    rep.ok('board colours: the label says the pair is now set by hand',
      /set by you/.test(overridden.note), overridden.note);

    // Re-derive hands it back.
    const rederived = await page.evaluate(() => {
      reDeriveBoardColors();
      return document.getElementById('board-single-b').value;
    });
    rep.ok('board colours: "Re-derive" hands the swatch back to sector 20',
      rederived !== '#ffcc00', rederived);

    // Save, then confirm the colours reach the real board's SVG.
    await page.evaluate(() => { resetBoardColors();
      document.getElementById('board-single-a').value = '#3060a0';
      document.getElementById('board-ring-a').value = '#f2c14e';
      onBoardColorInput('a'); saveSettings(); });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const m = document.querySelector('.modal-backdrop'); if (m) m.remove(); });

    await L.startX01(page, { names: [L.uniqueName('BcA'), L.uniqueName('BcB')], startScore: 501 });
    await page.evaluate(() => { dartboardMode = true; applyDartMode(); });
    await page.waitForTimeout(400);
    const board = await page.evaluate(() => {
      const fills = [...document.querySelectorAll('#dart-board-wrap path')].map(p => p.getAttribute('fill'));
      const texts = [...document.querySelectorAll('#dart-board-wrap text')];
      return { has: fills.includes('#3060a0') && fills.includes('#f2c14e'),
               // Every fill must be a plain hex literal — the values are
               // interpolated into an SVG attribute, so anything else means the
               // guard chain leaked.
               allSafe: fills.every(f => /^#[0-9a-f]{6}$/i.test(f)),
               bullLabel: (texts[texts.length - 1] || {}).getAttribute
                 ? texts[texts.length - 1].getAttribute('fill') : null };
    });
    rep.ok('board colours: the saved scheme reaches the board you actually tap', board.has);
    rep.ok('board colours: every fill on the board is a plain hex literal', board.allSafe);
    // #f2c14e is a light ring, so the "Bull" label must have flipped to the dark
    // option — the old hardcoded cream would be 1.9:1 on it.
    rep.ok('board colours: the Bull label flips to stay legible on a light ring',
      board.bullLabel === '#151613', String(board.bullLabel));

    rep.ok('board-colours: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'board-colors');
  });
}

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

  await boardColors(rep);
  return rep.finish();
};
