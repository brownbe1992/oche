'use strict';
/* New Game wizard — Step 1's selection and disclosure rules.
 *
 * Step 1 opens with NOTHING selected and every category collapsed, and a game's
 * settings panel is shown only where the game itself is visible: inside its own
 * row, in an expanded category. Three real regressions sit behind these
 * assertions, and the third is why the first two now read the way they do:
 *
 *  1. The Continue button is rendered INSIDE the selected game's row, so
 *     collapsing that row's category left Step 1 with no way to advance at all
 *     while a game was still selected.
 *  2. The first fix for (1) added a Continue but not the options anchor the
 *     real per-game controls mount into — so you could advance, but starting
 *     score / legs / sets were silently unreachable and the game began on stale
 *     defaults. "There is a Continue button" was true in both the broken and
 *     fixed states, which is why these still assert reachability of the OPTIONS.
 *  3. The fix for (2) was a full copy of the settings panel rendered below the
 *     whole ledger — which is what the player actually saw: X01 pre-selected on
 *     arrival, and a bare "starting score / format / Continue" block stranded at
 *     the bottom of the page beneath five collapsed category headers, with
 *     nothing on screen naming the game it configured. Both halves of that are
 *     now the bug: the default selection AND the out-of-row panel.
 *
 * So the property has flipped, deliberately. Collapsing a category is now
 * expected to take Continue off screen with it, and re-expanding is expected to
 * bring it back with the selection intact. Nothing is stranded because nothing
 * renders outside the row.
 */
const L = require('../lib');

async function step1DefaultState(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    await page.evaluate(() => show('setup'));
    await page.waitForTimeout(600);

    const fresh = await page.evaluate(() => {
      const pool = document.getElementById('setup-inline-options-pool');
      return {
        key: currentSetupOptionKey(),
        openCategories: document.querySelectorAll('.setup-cat-head.open').length,
        rows: document.querySelectorAll('.setup-ledger-row').length,
        selectedRows: document.querySelectorAll('.setup-ledger-row.sel').length,
        panels: document.querySelectorAll('.setup-ledger-options').length,
        hasContinue: !!document.getElementById('setup-step1-continue'),
        optionsVisible: pool ? pool.offsetParent !== null : false,
        categories: document.querySelectorAll('.setup-cat-head').length,
        firstCategory: (document.querySelector('.setup-cat-head .setup-cat-title') || {}).textContent || null,
      };
    });
    rep.ok('step 1: opens with no game selected', fresh.key === '', `key=${JSON.stringify(fresh.key)}`);
    rep.ok('step 1: opens with every category collapsed', fresh.openCategories === 0,
      `${fresh.openCategories} expanded`);
    rep.ok('step 1: a collapsed ledger renders no rows', fresh.rows === 0, `${fresh.rows} rows`);
    rep.ok('step 1: nothing is marked selected', fresh.selectedRows === 0);
    rep.ok('step 1: no settings panel on arrival', fresh.panels === 0, `${fresh.panels} panels`);
    rep.ok('step 1: no Continue button on arrival', !fresh.hasContinue);
    rep.ok('step 1: per-game options are not visible on arrival', !fresh.optionsVisible);
    // The category headers themselves must still be there — "nothing selected"
    // must not read as "empty screen".
    rep.ok('step 1: every category header is still offered', fresh.categories >= 5,
      `${fresh.categories} headers`);
    // Ordering is a deliberate placement (owner request), and it is only ever
    // visible here — on a collapsed screen the header order IS the screen.
    rep.ok('step 1: Minigames leads the category list', fresh.firstCategory === 'Minigames',
      `first header=${JSON.stringify(fresh.firstCategory)}`);

    rep.ok('new-game: no uncaught page errors (default state)', pageErrors.length === 0,
      pageErrors.join('; '));
    await rep.captureIfFailed(page, 'step1-default');
  });
}

/* Expanding a category, picking a game, and the collapse/re-expand round trip.
 * Driven through real clicks, because the whole point is where things RENDER. */
async function step1SelectionVisibility(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    await page.evaluate(() => show('setup'));
    await page.waitForTimeout(600);

    // Expand the first category, then pick its first game.
    await page.evaluate(() => document.querySelector('.setup-cat-head').click());
    await page.waitForTimeout(400);
    const expanded = await page.evaluate(() => ({
      rows: document.querySelectorAll('.setup-ledger-row').length,
      hasContinue: !!document.getElementById('setup-step1-continue'),
      key: currentSetupOptionKey(),
    }));
    rep.ok('step 1: expanding a category reveals its games', expanded.rows > 0, `${expanded.rows} rows`);
    // Opening a category is browsing, not choosing — a Continue here would mean
    // the ledger had quietly selected the category's first game for the player.
    rep.ok('step 1: expanding alone still selects nothing', !expanded.hasContinue,
      `key=${JSON.stringify(expanded.key)}`);

    await page.evaluate(() => document.querySelector('.setup-ledger-row').click());
    await page.waitForTimeout(500);

    const selected = await page.evaluate(() => {
      const pool = document.getElementById('setup-inline-options-pool');
      const panel = document.querySelector('.setup-ledger-options');
      return {
        key: currentSetupOptionKey(),
        hasContinue: !!document.getElementById('setup-step1-continue'),
        hasAnchor: !!document.getElementById('setup-inline-options-anchor'),
        optionsVisible: pool ? pool.offsetParent !== null : false,
        // The panel must sit INSIDE the open category, not after the whole list.
        panelInsideCategory: !!(panel && panel.closest('.setup-cat')),
      };
    });
    rep.ok('step 1: selecting a game selects it', selected.key !== '', `key=${selected.key}`);
    rep.ok('step 1: selecting a game shows Continue', selected.hasContinue);
    rep.ok('step 1: selecting a game shows its options', selected.hasAnchor && selected.optionsVisible);
    // The assertion that the stranded panel is really gone: a panel outside every
    // .setup-cat is one rendered below the whole ledger.
    rep.ok('step 1: the settings panel renders inside its own category',
      selected.panelInsideCategory);

    // Collapse the category holding the selection. The panel must go with it.
    await page.evaluate(() => document.querySelector('.setup-cat-head.open').click());
    await page.waitForTimeout(500);

    const collapsed = await page.evaluate(() => {
      const pool = document.getElementById('setup-inline-options-pool');
      return {
        stillSelected: currentSetupOptionKey(),
        hasContinue: !!document.getElementById('setup-step1-continue'),
        panels: document.querySelectorAll('.setup-ledger-options').length,
        optionsVisible: pool ? pool.offsetParent !== null : false,
      };
    });
    rep.ok('step 1: the selection survives collapsing its category',
      !!collapsed.stillSelected, `key=${collapsed.stillSelected}`);
    rep.ok('step 1: collapsing hides the settings panel', collapsed.panels === 0,
      `${collapsed.panels} panels`);
    rep.ok('step 1: collapsing hides Continue with it', !collapsed.hasContinue);
    rep.ok('step 1: collapsing hides the per-game options', !collapsed.optionsVisible);

    // Re-expanding must bring back the same selection, its options and Continue.
    await page.evaluate(() => document.querySelector('.setup-cat-head').click());
    await page.waitForTimeout(500);
    const reopened = await page.evaluate(() => {
      const pool = document.getElementById('setup-inline-options-pool');
      const b = document.getElementById('setup-step1-continue');
      return {
        selectedRows: document.querySelectorAll('.setup-ledger-row.sel').length,
        hasContinue: !!b,
        hasAnchor: !!document.getElementById('setup-inline-options-anchor'),
        optionsVisible: pool ? pool.offsetParent !== null : false,
      };
    });
    rep.ok('step 1: re-expanding restores the selected row', reopened.selectedRows === 1,
      `${reopened.selectedRows} rows marked selected`);
    rep.ok('step 1: re-expanding restores Continue', reopened.hasContinue);
    rep.ok('step 1: re-expanding restores the per-game options',
      reopened.hasAnchor && reopened.optionsVisible);

    // ...and it has to actually work, not just exist.
    await page.evaluate(() => document.getElementById('setup-step1-continue').click());
    await page.waitForTimeout(700);
    const advanced = await page.evaluate(() => !document.getElementById('setup-step-2').hidden);
    rep.ok('step 1: the restored Continue advances to step 2', advanced);

    rep.ok('new-game: no uncaught page errors (selection)', pageErrors.length === 0,
      pageErrors.join('; '));
    await rep.captureIfFailed(page, 'step1-selection');
  });
}

/* Requirement: the same rules in every category, not just the first one.
 * Walks every category, picks its first game, and asserts the panel lands inside
 * that category and nowhere else. The original report was written about X01 under
 * Traditional; the fix is meant to hold everywhere. */
async function step1AllCategories(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    await page.evaluate(() => show('setup'));
    await page.waitForTimeout(600);

    const total = await page.evaluate(() => document.querySelectorAll('.setup-cat-head').length);
    let checked = 0;
    for (let i = 0; i < total; i++) {
      const res = await page.evaluate(async (idx) => {
        // Fresh each time so a previous category's selection can't mask a bug.
        show('setup');
        await new Promise(r => setTimeout(r, 250));
        document.querySelectorAll('.setup-cat-head')[idx].click();
        await new Promise(r => setTimeout(r, 200));
        const row = document.querySelectorAll('.setup-ledger-row')[0];
        if (!row) return { skipped: true };
        row.click();
        await new Promise(r => setTimeout(r, 250));
        const cat = document.querySelectorAll('.setup-cat')[idx];
        const panels = [...document.querySelectorAll('.setup-ledger-options')];
        return {
          key: currentSetupOptionKey(),
          panels: panels.length,
          // Every panel on screen must be inside THIS category.
          allInsideThisCategory: panels.every(p => cat && cat.contains(p)),
          hasContinue: !!document.getElementById('setup-step1-continue'),
          continueInsideCategory: !!(cat && cat.contains(document.getElementById('setup-step1-continue'))),
        };
      }, i);
      if (res.skipped) continue;
      checked++;
      rep.ok(`step 1: category ${i} — exactly one settings panel`, res.panels === 1, `${res.panels}`);
      rep.ok(`step 1: category ${i} — panel is inside that category`, res.allInsideThisCategory);
      rep.ok(`step 1: category ${i} — Continue is inside that category`,
        res.hasContinue && res.continueInsideCategory);
    }
    rep.ok('step 1: every category was exercised', checked >= 5, `${checked} of ${total}`);

    rep.ok('new-game: no uncaught page errors (all categories)', pageErrors.length === 0,
      pageErrors.join('; '));
    await rep.captureIfFailed(page, 'step1-all-categories');
  });
}

/* Keyboard activation of controls nested inside a role="button" container.
 *
 * The Daily Challenge card is itself an activatable container, and its
 * Enter/Space handler used to preventDefault() unconditionally. Because keydown
 * bubbles, that also suppressed the browser turning Enter into a click on the
 * Continue button nested inside it — leaving those buttons perfectly usable by
 * mouse and completely dead by keyboard. Mouse-only testing cannot see this. */
async function keyboardActivation(rep) {
  await L.withPage(L.PORTRAIT, async (page) => {
    await page.evaluate(() => show('setup'));
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const card = document.querySelector('.setup-dc');
      if (card) card.click();
    });
    await page.waitForTimeout(600);

    const nested = await page.evaluate(() => ({
      continueInsideCard: !!document.querySelector('.setup-dc #setup-step1-continue'),
      step2Hidden: document.getElementById('setup-step-2').hidden,
    }));
    if (!nested.continueInsideCard) {
      rep.ok('keyboard: Daily Challenge card exposes a nested Continue', false,
        'not found — card layout changed, update this check');
      return;
    }

    await page.evaluate(() => document.getElementById('setup-step1-continue').focus());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const afterEnter = await page.evaluate(() => !document.getElementById('setup-step-2').hidden);
    rep.ok('keyboard: Enter on a nested Continue activates it', afterEnter,
      afterEnter ? '' : 'ancestor handler is swallowing the key');

    // The container's own keyboard activation must still work — the fix is to
    // ignore keys that came from a nested control, not to drop the handler.
    await page.evaluate(() => show('setup'));
    await page.waitForTimeout(600);
    const cardActivates = await page.evaluate(() => {
      const card = document.querySelector('.setup-dc');
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return currentSetupOptionKey();
    });
    rep.ok('keyboard: the card itself is still keyboard-activatable',
      cardActivates === 'challenge', `key=${cardActivates}`);
    await rep.captureIfFailed(page, 'keyboard');
  });
}

module.exports = async function run() {
  const rep = L.makeReporter('new-game');
  await step1DefaultState(rep);
  await step1SelectionVisibility(rep);
  await step1AllCategories(rep);
  await keyboardActivation(rep);
  return rep.finish();
};
