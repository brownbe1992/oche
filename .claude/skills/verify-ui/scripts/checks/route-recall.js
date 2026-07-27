'use strict';
/* Route Recall, played through the real screen.
 *
 * docs/archive/checkout-trainer-route-recall-roadmap.md. The pure logic — the enumerator,
 * the grader, the coverage maths — has committed unit tests in `backend/test/`, so
 * what is left for a browser is everything those cannot see:
 *
 *   - that a hunt HOLDS its target across submissions. This is the one structural
 *     difference from every other mode in the app, which serve a fresh target or a
 *     fresh visit each time. If the target moved on after a submission the mode
 *     would silently become Freeform, and every unit test would still pass.
 *   - that the found list is on screen. "Have I already said T20 T20 D20?" is the
 *     question this drill exists to train, so leaving the player to remember what
 *     they have already named turns it into a memory test about a memory test.
 *   - that a duplicate does not read like a mistake — it must not take the bust
 *     styling every other wrong answer in this app uses.
 *   - that the 1/2-dart tiers reveal the total and the 3-dart tier does not. That
 *     split IS the owner's resolution of the doc's "reveal the total?" question,
 *     taken because 81 of 162 targets have 200+ routes at three darts, and it only
 *     exists as rendered copy.
 */
const L = require('../lib');

const READ = `(() => {
  const sb = document.getElementById('scoreboard');
  const status = document.getElementById('status');
  return {
    target: game.players[0].score,
    found: game.players[0].foundKeys.size,
    routesFound: game.players[0].routesFound,
    huntNo: game.setNo,
    big: (sb.querySelector('.rem') || {}).textContent || '',
    standing: (sb.querySelector('.standing') || {}).textContent || '',
    chips: [...sb.querySelectorAll('.ct-found')].map(e => e.textContent),
    heading: (sb.querySelector('.pp-section-title') || {}).textContent || '',
    statusText: status.textContent,
    statusClass: status.className,
    nextBtnVisible: !!(document.getElementById('route-recall-next-btn') || {}).offsetParent,
    submitLabel: (document.getElementById('enter-btn') || {}).textContent || '',
  };
})()`;

// Start a hunt on a chosen target and ceiling. The pin is how the roadmap always
// intended a specific number to be drilled, and it makes the check deterministic.
async function startHunt(page, name, ceiling, pin) {
  return page.evaluate(async (o) => {
    try {
      setMode('checkout_trainer');
      setCheckoutTrainerMode('route_recall');
      setRouteRecallCeiling(o.ceiling);
      setup.slots = [o.name];
      setup.checkoutTrainerPin = o.pin;
      await startGame();
      await new Promise(r => setTimeout(r, 300));
      return { ok: true, config: game.config };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }, { name, ceiling, pin });
}

const submit = (page, darts) => page.evaluate(async (ds) => {
  for (const [m, s] of ds) { setMult(m); throwDart(s); }
  enterTurn();
  await new Promise(r => setTimeout(r, 90));
}, darts);

module.exports = async function run() {
  const rep = L.makeReporter('route-recall');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const name = L.uniqueName('RR');
    await page.evaluate(async (n) => { await DB.addPlayer(n); roster.push(n); }, name);

    // ---- A 2-dart hunt on 40: the revealed tier, 36 routes ----
    const started = await startHunt(page, name, 2, 40);
    if (!started.ok) { rep.ok('route-recall: starts', false, started.error); return; }
    rep.ok('route-recall: the config carries the sub-mode and its ceiling',
      started.config.mode === 'route_recall' && started.config.routeCeiling === 2,
      JSON.stringify({ mode: started.config.mode, ceiling: started.config.routeCeiling }));

    const open = await page.evaluate(READ);
    rep.ok('route-recall: the screen is its own, not Freeform\'s',
      open.submitLabel.includes('route') && open.nextBtnVisible,
      `submit="${open.submitLabel}" nextTarget=${open.nextBtnVisible}`);
    rep.ok('route-recall: a revealed tier states the total up front',
      /\b36\b/.test(open.statusText) || /\/36/.test(open.big),
      `status="${open.statusText}" big="${open.big}"`);

    await submit(page, [[2, 20]]);                 // D20 — new
    const one = await page.evaluate(READ);
    rep.ok('route-recall: a new route is counted and listed',
      one.found === 1 && one.chips.includes('D20'),
      `found=${one.found} chips=${JSON.stringify(one.chips)}`);
    rep.ok('route-recall: the tally shows found out of total',
      one.big.includes('1') && one.big.includes('36'), `"${one.big}"`);

    await submit(page, [[2, 20]]);                 // D20 again — duplicate
    const dup = await page.evaluate(READ);
    rep.ok('route-recall: the target does NOT move on after a submission',
      dup.target === 40, `target=${dup.target} — a hunt holds one target, unlike Freeform`);
    rep.ok('route-recall: a duplicate costs nothing',
      dup.found === 1 && dup.routesFound === 1,
      `found=${dup.found} routesFound=${dup.routesFound}`);
    rep.ok('route-recall: a duplicate is not styled as a mistake',
      !/\bbust\b/.test(dup.statusClass) && /already/i.test(dup.statusText),
      `class="${dup.statusClass}" text="${dup.statusText}"`);

    await submit(page, [[1, 20], [2, 10]]);        // 20 D10 — new
    await submit(page, [[3, 20]]);                 // T20 — overshoots
    const after = await page.evaluate(READ);
    rep.ok('route-recall: an illegal route is rejected and says why',
      after.found === 2 && /bust/.test(after.statusClass) && /zero/i.test(after.statusText),
      `found=${after.found} text="${after.statusText}"`);
    rep.ok('route-recall: the found list keeps every route named so far',
      after.chips.length === 2 && after.chips.includes('D20'),
      JSON.stringify(after.chips));

    // ---- Moving on banks the hunt and serves a fresh one ----
    const moved = await page.evaluate(async () => {
      nextRouteRecallTarget();
      await new Promise(r => setTimeout(r, 120));
      const p = game.players[0];
      return { hunts: p.hunts, found: p.foundKeys.size, huntNo: game.setNo, routesFound: p.routesFound };
    });
    rep.ok('route-recall: moving on banks the hunt, incomplete and all',
      moved.hunts.length === 1 && moved.hunts[0].found === 2 && moved.hunts[0].total === 36,
      JSON.stringify(moved.hunts));
    rep.ok('route-recall: the new hunt starts empty but keeps the session total',
      moved.found === 0 && moved.huntNo === 2 && moved.routesFound === 2,
      `found=${moved.found} hunt=${moved.huntNo} session=${moved.routesFound}`);

    // ---- Completing a hunt: 2 at a 1-dart ceiling has exactly one route ----
    await page.evaluate(() => { game = null; show('home'); });
    const solo = await startHunt(page, name, 1, 2);
    if (!solo.ok) { rep.ok('route-recall: 1-dart hunt starts', false, solo.error); }
    else {
      await submit(page, [[2, 1]]);                // D1 — the only route for 2
      const done = await page.evaluate(READ);
      rep.ok('route-recall: finding every route completes the hunt',
        /every route found/i.test(done.statusText) && !/bust/.test(done.statusClass),
        `"${done.statusText}"`);
    }

    // ---- The open-ended tier reveals no total ----
    await page.evaluate(() => { game = null; show('home'); });
    const open3 = await startHunt(page, name, 3, 58);   // 730 routes — the worst case
    if (!open3.ok) { rep.ok('route-recall: 3-dart hunt starts', false, open3.error); }
    else {
      const o = await page.evaluate(READ);
      rep.ok('route-recall: the open-ended tier shows no total and no denominator',
        !o.big.includes('/') && !/\b730\b/.test(o.statusText) && !/\bof\b/.test(o.standing),
        `big="${o.big}" standing="${o.standing}" status="${o.statusText}"`);
      await submit(page, [[1, 18], [2, 20]]);           // 18 + D20 = 58
      const o2 = await page.evaluate(READ);
      rep.ok('route-recall: the open-ended tier counts finds without a denominator',
        o2.found === 1 && o2.chips.includes('18 D20') && !o2.big.includes('/'),
        `found=${o2.found} chips=${JSON.stringify(o2.chips)} big="${o2.big}"`);
    }

    await page.evaluate(() => { try { game = null; } catch {} show('home'); });
    rep.ok('route-recall: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
