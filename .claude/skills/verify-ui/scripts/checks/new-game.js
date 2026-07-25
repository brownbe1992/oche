'use strict';
/* New Game wizard — Step 1's "can I actually get out of here" properties.
 *
 * Two real regressions live behind these assertions:
 *  1. The Continue button is rendered INSIDE the selected game's row, so
 *     collapsing that row's category left Step 1 with no way to advance at all
 *     while a game was still selected.
 *  2. The first fix for (1) added a Continue but not the options anchor the
 *     real per-game controls mount into — so you could advance, but starting
 *     score / legs / sets were silently unreachable and the game began on stale
 *     defaults. "There is a Continue button" was true in both the broken and
 *     fixed states, which is why these assert reachability of the OPTIONS too.
 */
const L = require('../lib');

async function step1Escape(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    await page.evaluate(() => show('setup'));
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      const row = document.querySelector('.setup-ledger-row');
      if (row) row.click();
    });
    await page.waitForTimeout(500);

    const selected = await page.evaluate(() => {
      const pool = document.getElementById('setup-inline-options-pool');
      return {
        key: currentSetupOptionKey(),
        hasContinue: !!document.getElementById('setup-step1-continue'),
        hasAnchor: !!document.getElementById('setup-inline-options-anchor'),
        optionsVisible: pool ? pool.offsetParent !== null : false,
      };
    });
    rep.ok('step 1: selecting a game shows Continue', selected.hasContinue);
    rep.ok('step 1: selecting a game shows its options', selected.hasAnchor && selected.optionsVisible);

    // Collapse the category holding the selection — the state that used to strand you.
    await page.evaluate(() => {
      const head = document.querySelector('.setup-cat-head.open');
      if (head) head.click();
    });
    await page.waitForTimeout(500);

    const collapsed = await page.evaluate(() => {
      const pool = document.getElementById('setup-inline-options-pool');
      const btn = document.getElementById('setup-step1-continue');
      return {
        stillSelected: currentSetupOptionKey(),
        hasContinue: !!btn,
        label: btn ? btn.textContent.trim() : null,
        hasAnchor: !!document.getElementById('setup-inline-options-anchor'),
        optionsVisible: pool ? pool.offsetParent !== null : false,
      };
    });
    rep.ok('step 1: a game is still selected after collapsing its category',
      !!collapsed.stillSelected, `key=${collapsed.stillSelected}`);
    rep.ok('step 1: Continue survives the collapse', collapsed.hasContinue, collapsed.label || '');
    rep.ok('step 1: per-game options stay reachable after the collapse',
      collapsed.hasAnchor && collapsed.optionsVisible);

    // ...and it has to actually work, not just exist.
    await page.evaluate(() => {
      const b = document.getElementById('setup-step1-continue');
      if (b) b.click();
    });
    await page.waitForTimeout(700);
    const advanced = await page.evaluate(() => !document.getElementById('setup-step-2').hidden);
    rep.ok('step 1: the surviving Continue advances to step 2', advanced);

    rep.ok('new-game: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
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
  });
}

module.exports = async function run() {
  const rep = L.makeReporter('new-game');
  await step1Escape(rep);
  await keyboardActivation(rep);
  return rep.finish();
};
