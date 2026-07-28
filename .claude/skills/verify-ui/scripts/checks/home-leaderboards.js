'use strict';
/* Every Home leaderboard renders, for every game type and both tabs.
 *
 * WHY THIS EXISTS. A 2026-07 coverage measurement of the page — Chromium's own JS
 * coverage, over a sweep that started all 16 game types, threw darts, committed and
 * undid — found that the fourteen `renderHomeTabBody<Type>()` functions had **never
 * executed**, in this suite or any other. No check switched the Home tabs or the
 * game-type toggle, and no backend test referenced them. Fourteen leaderboard
 * renderers, on the app's landing screen, with nothing exercising them at all.
 *
 * That is the exact shape of the bug CLAUDE.md names as the reason committed tests
 * exist here: a leaderboard sorted the wrong way round, or reading the wrong field,
 * looks completely normal — a list of names and numbers — and stays wrong until
 * somebody notices the worst player is top.
 *
 * WHAT IT ASSERTS, AND WHAT IT CANNOT. It asserts that each registered renderer is
 * actually CALLED and returns without throwing. It does NOT assert the numbers, or the
 * sort order: which player should lead a Cricket MPR board depends on history this
 * suite does not create, and pinning it would mean seeding a fixture database here.
 *
 * The first version of this check claimed more than that and was wrong, which is worth
 * recording because the mistake is easy to repeat. It asserted "the panel rendered some
 * markup and is not stuck on Loading…", and a deliberately broken renderer — reading
 * `data.mpr.rows` where `data.mpr` is an array — sailed straight through it. The reason
 * is that `undefined` reaches the shared leaderboard helper, which absorbs it into its
 * empty state, and against a suite with no seeded history the empty state is what a
 * HEALTHY board looks like too. An assertion that cannot tell "empty because there is
 * no data" from "empty because the field name is wrong" is not an assertion.
 *
 * Spying on the renderer is the part that can be checked honestly here: it closes the
 * actual gap that was found (fourteen functions that had never executed at all) without
 * pretending to verify arithmetic it has no data for. Asserting the CONTENT of these
 * boards needs a seeded database — `backend/seed-dev-db.js` exists for exactly that
 * reason — and is worth doing as its own piece of work.
 *
 * The types come from the app's own registry, filtered by the same
 * homeGameTypeVisible() predicate the toggle uses, so a new game type is covered the
 * day it is added rather than when someone remembers to extend this file.
 */
const L = require('../lib');

module.exports = async function run() {
  const rep = L.makeReporter('home-leaderboards');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    // A little real history, so the boards have something to render rather than only
    // ever exercising their empty state.
    await page.evaluate(async () => {
      const names = ['HLB_A_' + Date.now(), 'HLB_B_' + Date.now()];
      for (const n of names) await DB.addPlayer(n);
      roster.push(...names);
      setMode('h2h'); setup.gameType = 'x01'; setup.slots = names;
      await startGame();
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => { try { game = null; show('home'); } catch {} });
    await page.waitForTimeout(900);

    // Which (tab, type) pairs the app itself offers.
    const combos = await page.evaluate(() => {
      const out = [];
      for (const tab of ['h2h', 'practice']) {
        for (const id of Object.keys(GAME_TYPES)) {
          const g = GAME_TYPES[id];
          // homeGameTypeVisible() ALONE, which is the predicate the real toggle uses.
          // An earlier version also skipped `dispatchOnly`, and that was wrong: Marathon
          // Mode is dispatchOnly (it is never a real games.gameType — every leg stays
          // 'x01') yet it deliberately appears in this toggle, which is the entire reason
          // its registry entry exists. Filtering it here meant the check quietly never
          // exercised its renderer while claiming to cover them all. Caught by the
          // "every custom renderer actually ran" assertion below, which is what that
          // assertion is for.
          if (typeof homeGameTypeVisible === 'function' && !homeGameTypeVisible(g, tab)) continue;
          out.push({ tab, id });
        }
      }
      return out;
    });
    rep.ok('home: the registry offers leaderboard combinations to check', combos.length >= 16,
      `${combos.length} (tab, type) pairs`);

    // Wrap every registered renderer so "was it called, and did it throw" is a fact
    // rather than an inference from what the panel happens to look like afterwards.
    await page.evaluate(() => {
      window.__hlb = { called: {}, threw: {} };
      for (const id of Object.keys(GAME_TYPES)) {
        const fn = GAME_TYPES[id].homeTabRenderer;
        if (typeof fn !== 'function') continue;
        GAME_TYPES[id].homeTabRenderer = function (...a) {
          window.__hlb.called[id] = (window.__hlb.called[id] || 0) + 1;
          try { return fn.apply(this, a); }
          catch (e) { window.__hlb.threw[id] = String(e && e.message || e); throw e; }
        };
      }
    });

    const bad = [];
    for (const { tab, id } of combos) {
      const seen = await page.evaluate(async (c) => {
        const errs = [];
        const onErr = (e) => errs.push(String(e && e.message || e));
        window.addEventListener('error', onErr);
        try {
          switchHomeTab(c.tab);
          switchHomeGameType(c.id);
        } catch (e) { errs.push('threw: ' + String(e && e.message || e)); }
        await new Promise(r => setTimeout(r, 260));
        window.removeEventListener('error', onErr);
        const el = document.getElementById('home-tab-body');
        const text = el ? (el.innerText || '') : '';
        return { errors: errs, html: el ? el.innerHTML.length : 0,
                 // GAME_TYPES is a top-level `const` in a classic script, so it is NOT
                 // a property of window — only `var` and function declarations are.
                 // Bare reference works because evaluate() runs in the page's own scope.
                 hasCustom: !!(GAME_TYPES[c.id] || {}).homeTabRenderer,
                 called: window.__hlb.called[c.id] || 0,
                 threw: window.__hlb.threw[c.id] || null,
                 loading: /^\s*Loading…\s*$/.test(text) };
      }, { tab, id });

      if (seen.errors.length) bad.push(`${id}/${tab}: ${seen.errors[0]}`);
      else if (seen.threw) bad.push(`${id}/${tab}: renderer threw — ${seen.threw}`);
      else if (seen.hasCustom && !seen.called) bad.push(`${id}/${tab}: its renderer was never called`);
      else if (!seen.html) bad.push(`${id}/${tab}: rendered nothing`);
      else if (seen.loading) bad.push(`${id}/${tab}: stuck on Loading…`);
    }

    rep.ok('home: every game type renders its leaderboard on both tabs', bad.length === 0,
      bad.slice(0, 4).join(' | '));

    // The fourteen custom renderers each ran at least once. This is the assertion that
    // closes the measured gap — they had collectively never executed.
    const ran = await page.evaluate(() => {
      const custom = Object.keys(GAME_TYPES).filter(id => typeof GAME_TYPES[id].homeTabRenderer === 'function');
      return { custom, missed: custom.filter(id => !window.__hlb.called[id]) };
    });
    rep.ok('home: every mode with its own leaderboard renderer actually ran it',
      ran.missed.length === 0, `${ran.custom.length} custom renderers, never called: ${ran.missed.join(', ') || 'none'}`);

    // The toggle's own rule, which is easy to break from either side: a solo-only mode
    // must not be offered under H2H, and an h2h-only one must not be offered under
    // Practice. switchHomeTab() bounces the selection back to X01 when that happens,
    // and a renderer running under the wrong heading is precisely what that prevents.
    const bounce = await page.evaluate(async () => {
      switchHomeTab('practice');
      switchHomeGameType('doubles_practice');       // solo-only, legal here
      const solo = homeGameType;
      switchHomeTab('h2h');                          // ...and illegal here
      await new Promise(r => setTimeout(r, 200));
      return { solo, afterH2h: homeGameType };
    });
    rep.ok('home: a solo-only type can be selected under Practice',
      bounce.solo === 'doubles_practice', bounce.solo);
    rep.ok('home: switching to H2H drops a solo-only selection rather than rendering it there',
      bounce.afterH2h === 'x01', bounce.afterH2h);

    rep.ok('home-leaderboards: no uncaught page errors', pageErrors.length === 0,
      pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
