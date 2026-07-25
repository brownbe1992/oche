'use strict';
/* Ghost Opponent leg picker — deep links, stale state, and fetch count.
 *
 * The Player Profile's 👻 button deep-links to a player's BEST leg, while the
 * picker's own default page is their most RECENT wins. When the requested leg
 * wasn't in the fetched page the code fell through to legs[0], so you silently
 * raced a different leg than the one you clicked — with nothing on screen
 * indicating anything was wrong. That silence is what makes it worth a check:
 * the feature "works" in the sense that a race starts.
 */
const L = require('../lib');

// Small on purpose. Each leg is real gameplay driven through the app, and the
// server rate-limits 300 req/60s — a big fixture trips it and the failures that
// follow look like anything but rate limiting.
const FIXTURE_LEGS = 3;

async function buildFixture(page, pname) {
  await page.evaluate(async ({ pname, count }) => {
    await DB.addPlayer(pname);
    roster.push(pname);
    for (let i = 0; i < count; i++) {
      setMode('practice');
      setup.gameType = 'x01';
      setup.slots = [pname];
      setup.startScore = 101;
      setup.legs = 1;
      setup.sets = 1;
      await startGame();
      let n = 0;
      while (!game.won && n < 400) {
        const r = game.players[0].score;
        if (r > 40) { setMult(1); throwDart(20); }
        else if (r % 2 !== 0) { setMult(1); throwDart(1); }
        else { setMult(2); throwDart(r / 2); }
        if (game.won || game.darts.length === 3 || game.busted) enterTurn();
        n++;
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }, { pname, count: FIXTURE_LEGS });
  await page.waitForTimeout(2500);

  return page.evaluate(async ({ pname }) =>
    await Backend.get(`/api/players/ghost-legs?name=${encodeURIComponent(pname)}&limit=100&offset=0&sort=recent&category=`),
    { pname });
}

module.exports = async function run() {
  const rep = L.makeReporter('ghost-picker');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const requests = [];
    page.on('request', r => {
      if (r.url().includes('/api/players/ghost-legs')) requests.push(r.url());
    });

    const pname = L.uniqueName('GhostF');
    const legs = await buildFixture(page, pname);
    rep.ok('fixture: won legs exist to pick from', legs.total >= 2, `total=${legs.total}`);
    if (legs.total < 2) return;

    // --- deep link to a leg that is NOT the first row -----------------------
    // Also set a category filter that would exclude it, since a pending target
    // has to override the picker's own filtering to find anything at all.
    await page.evaluate(() => { ghostLegCategory = '301'; ghostLegPageSize = 10; });
    requests.length = 0;
    const wanted = legs.legs[1];
    const found = await page.evaluate(async ({ pname, leg }) => {
      raceLeg(pname, leg.gameId, leg.setNo, leg.legNo);
      await new Promise(r => setTimeout(r, 2200));
      const g = setup.ghostLeg;
      return {
        armed: g ? { gameId: g.gameId, setNo: g.setNo, legNo: g.legNo } : null,
        targetCleared: _ghostLegTarget === null,
      };
    }, { pname, leg: wanted });

    const matched = found.armed
      && found.armed.gameId === wanted.gameId
      && found.armed.setNo === wanted.setNo
      && found.armed.legNo === wanted.legNo;
    rep.ok('deep link: arms the exact leg requested, not merely the first row', matched,
      `armed=${JSON.stringify(found.armed)} wanted=${JSON.stringify({ gameId: wanted.gameId, setNo: wanted.setNo, legNo: wanted.legNo })}`);
    rep.ok('deep link: one-shot target is consumed', found.targetCleared);

    const lastUrl = requests[requests.length - 1] || '';
    rep.ok('deep link: widens the lookup and drops the category filter',
      /limit=100/.test(lastUrl) && /category=(&|$)/.test(lastUrl),
      lastUrl.replace(/^.*ghost-legs/, 'ghost-legs'));

    // A pending target used to survive until the response landed, so each of the
    // several renders a raceLeg() entry triggers started its own duplicate
    // 100-row fetch that the staleness guard then discarded.
    rep.ok('deep link: costs exactly one fetch', requests.length === 1, `fetches=${requests.length}`);

    // --- a deep link that cannot be satisfied -------------------------------
    const missing = await page.evaluate(async ({ pname }) => {
      raceLeg(pname, 99999999, 9, 9);
      await new Promise(r => setTimeout(r, 2200));
      return {
        armed: !!setup.ghostLeg,
        targetCleared: _ghostLegTarget === null,
        toldTheUser: /couldn't find that exact leg/i.test(
          document.getElementById('ghost-leg-picker-body').textContent),
      };
    }, { pname });
    rep.ok('unfound deep link: arms nothing rather than the wrong leg', missing.armed === false);
    rep.ok('unfound deep link: says so instead of failing silently', missing.toldTheUser);
    rep.ok('unfound deep link: target still consumed', missing.targetCleared);

    // A selection must not outlive the list it came from, or the picker can read
    // "no won legs in 301" while a 501 leg is still staged for Play Now.
    const emptied = await page.evaluate(async ({ pname, leg }) => {
      raceLeg(pname, leg.gameId, leg.setNo, leg.legNo);
      await new Promise(r => setTimeout(r, 2000));
      const armedBefore = !!setup.ghostLeg;
      setGhostLegCategory('301');   // the fixture is all 101 legs
      await new Promise(r => setTimeout(r, 2000));
      return { armedBefore, armedAfter: !!setup.ghostLeg };
    }, { pname, leg: legs.legs[0] });
    rep.ok('empty filter: had a selection to lose', emptied.armedBefore);
    rep.ok('empty filter: clears the stale selection', emptied.armedAfter === false);

    rep.ok('ghost-picker: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
  });

  return rep.finish();
};
