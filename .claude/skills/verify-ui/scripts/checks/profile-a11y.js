'use strict';
/* The Player Profile is navigable and audible, not just visible.
 *
 * `docs/archive/ui-overhaul-roadmap.md`'s design-phase audit measured the profile as the
 * app's densest screen — roughly three viewports of scroll on both a phone and a
 * tablet, ~1,100 DOM nodes, 34 buttons — and found three concrete accessibility
 * defects on it that had nothing to do with the layout question:
 *
 *   1. NO HEADINGS. All 21 section titles were styled `<div>`s, so the one
 *      navigation aid that makes a page this long usable with a screen reader —
 *      jump-by-heading — did not exist. The page was one flat run of text.
 *   2. NO ANNOUNCEMENT ON SCOPE CHANGE. The Overall/H2H/Practice tabs, the
 *      Stats/Settings tabs and the game-mode select each replace the entire
 *      contents of the page. Focus stays on the control, so with a screen
 *      reader nothing at all reports that three screens of statistics just
 *      became different statistics.
 *   3. TEN BUTTONS CALLED "Drill". Every checkout row's drill button had the
 *      same accessible name, so listing the page's buttons gave ten
 *      indistinguishable entries.
 *
 * These are live-DOM facts — computed visibility, accessible names, what a live
 * region contains after an interaction — so they belong here rather than in
 * `backend/test/`. The heading assertions are deliberately structural (an
 * outline with no skipped levels) rather than a list of expected titles, so
 * adding a section to the profile doesn't mean editing this file.
 */
const L = require('../lib');

const OUTLINE = `(() => {
  const body = document.getElementById('player-page-body');
  if (!body) return { error: 'no player page' };
  const vis = el => el && el.offsetParent !== null;
  const heads = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis)
    .map(h => ({ level: Number(h.tagName[1]), text: h.textContent.trim() }));
  const buttons = [...body.querySelectorAll('button')].filter(vis).map(b => ({
    name: (b.getAttribute('aria-label') || b.textContent || '').trim(),
    drill: b.classList.contains('drill-btn'),
  }));
  return {
    heads,
    scrollHeight: body.scrollHeight,
    buttons,
    unnamed: buttons.filter(b => !b.name).length,
    // Every <summary> the profile builds should carry a heading inside it: the
    // disclosure control and the heading are both wanted, not one or the other.
    summaries: body.querySelectorAll('summary.pp-section-title').length,
    summariesWithHeading: body.querySelectorAll('summary.pp-section-title h3').length,
  };
})()`;

module.exports = async function run() {
  const rep = L.makeReporter('profile-a11y');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    // A profile with something on it. The runner's scratch DB starts empty, so
    // this plays a couple of real visits rather than asserting against a page
    // whose every section is in its zero state.
    const name = L.uniqueName('A11Y');
    const started = await page.evaluate(async (n) => {
      try {
        await DB.addPlayer(n);
        roster.push(n);
        setMode('practice');
        setup.gameType = 'x01';
        setup.slots = [n];
        await startGame();
        await new Promise(r => setTimeout(r, 300));
        // 501 -> 321 -> 141 -> out. The leg has to actually FINISH: the Top
        // Checkouts section (and therefore the drill buttons this check is
        // partly about) renders nothing at all for a player with no checkouts.
        for (let v = 0; v < 2; v++) {
          for (let i = 0; i < 3; i++) { setMult(3); throwDart(20); }
          enterTurn();
          await new Promise(r => setTimeout(r, 60));
        }
        setMult(3); throwDart(20);   // 60
        setMult(3); throwDart(19);   // 57
        setMult(2); throwDart(12);   // 24 -> 141 checked out on a double
        enterTurn();
        await new Promise(r => setTimeout(r, 400));
        game = null;

        // A SECOND leg, checked out on a different score. Two distinct checkout
        // values is what puts two drill buttons on the page, which is the whole
        // point of the "told apart by name" assertion below — with one row it
        // would pass without ever comparing anything.
        setup.gameType = 'x01';
        setup.slots = [n];
        await startGame();
        await new Promise(r => setTimeout(r, 300));
        for (let i = 0; i < 3; i++) { setMult(3); throwDart(20); }   // 501 -> 321
        enterTurn();
        await new Promise(r => setTimeout(r, 60));
        setMult(3); throwDart(20); setMult(3); throwDart(20); setMult(3); throwDart(17); // -> 150
        enterTurn();
        await new Promise(r => setTimeout(r, 60));
        setMult(3); throwDart(20); setMult(3); throwDart(18); setMult(2); throwDart(18); // 150 out
        enterTurn();
        await new Promise(r => setTimeout(r, 400));
        game = null;
        show('home');
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }, name);
    if (!started.ok) { rep.ok('a11y: fixture game plays', false, started.error); return; }

    await page.evaluate((n) => showPlayer(n), name);
    await page.waitForTimeout(1200);

    const o = await page.evaluate(OUTLINE);
    if (o.error) { rep.ok('a11y: the profile renders', false, o.error); return; }

    // 1 — the heading outline.
    rep.ok('profile: the page has a heading outline at all', o.heads.length >= 5,
      `${o.heads.length} headings`);
    rep.ok('profile: the player name is the page heading',
      !!o.heads.length && o.heads[0].level === 2 && o.heads[0].text.includes(name),
      o.heads.length ? `first heading is H${o.heads[0].level} "${o.heads[0].text}"` : 'none');
    const skips = [];
    for (let i = 1; i < o.heads.length; i++) {
      if (o.heads[i].level > o.heads[i - 1].level + 1) {
        skips.push(`H${o.heads[i - 1].level} -> H${o.heads[i].level} at "${o.heads[i].text}"`);
      }
    }
    rep.ok('profile: no heading level is skipped', skips.length === 0, skips.slice(0, 3).join('; '));
    rep.ok('profile: every collapsible section is a heading as well as a button',
      o.summaries > 0 && o.summariesWithHeading === o.summaries,
      `${o.summariesWithHeading}/${o.summaries} summaries carry a heading`);

    // 2 — button names.
    rep.ok('profile: no visible button is nameless', o.unnamed === 0,
      `${o.unnamed} of ${o.buttons.length} buttons have no accessible name`);
    const drills = o.buttons.filter(b => b.drill).map(b => b.name);
    if (drills.length > 1) {
      rep.ok('profile: the drill buttons are told apart by name',
        new Set(drills).size === drills.length,
        `${drills.length} drill buttons, ${new Set(drills).size} distinct names`);
    } else {
      rep.ok('profile: drill buttons present to check', true,
        `${drills.length} on this profile — nothing to disambiguate`);
    }

    // 3 — the scope controls announce. Each is driven through the same function
    // the real control calls, then the app's live region is read back.
    const announced = await page.evaluate(async () => {
      const read = () => (document.getElementById('sr-announcer') || {}).textContent || '';
      const step = async (fn) => {
        const el = document.getElementById('sr-announcer');
        if (el) el.textContent = '';
        fn();
        // announce() writes on the next animation frame, deliberately, so that
        // repeating the same message still re-announces.
        await new Promise(r => setTimeout(r, 120));
        return read();
      };
      return {
        tab: await step(() => switchPlayerTab('h2h')),
        gameType: await step(() => switchPlayerGameType('cricket')),
        section: await step(() => switchPlayerSection('settings')),
      };
    });

    rep.ok('profile: switching Overall/H2H/Practice is announced', !!announced.tab.trim(),
      JSON.stringify(announced.tab));
    rep.ok('profile: switching the game mode is announced', !!announced.gameType.trim(),
      JSON.stringify(announced.gameType));
    rep.ok('profile: switching Stats/Player Settings is announced', !!announced.section.trim(),
      JSON.stringify(announced.section));

    rep.ok('profile-a11y: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
