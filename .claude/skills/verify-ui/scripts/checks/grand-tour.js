'use strict';
/* Grand Tour, end to end: the New Game rules, a whole tour on the scoring screen,
 * a two-player tour's turn order, and the live scoreboard driven by a real game.
 *
 * The rule is pinned by node:test (backend/test/scoring.grand-tour.test.js,
 * db.grand-tour.test.js). What only a browser can see, and what this check is for:
 *
 *  - That the wizard OFFERS what the owner chose: Grand Tour is solo or two
 *    players, never three, and always one tour — so the head-to-head Format picker
 *    ("first to 3 legs") must not appear for it. Its default of 3 legs would
 *    otherwise have made a two-player Grand Tour up to five 195-dart tours.
 *  - That a whole tour, played through the app's own turn loop, visits all 65
 *    beds in the owner's order (singles, TREBLES, doubles, bull) and lands on the
 *    total worked out by hand for the scripted darts.
 *  - That the TV board lights exactly the bed being aimed at — BOTH single areas
 *    of 7 for "Single 7", only the ring for a treble or double, the bull for the
 *    bull — which is the one thing the owner asked the board to do.
 *  - That the throw strip scores a visit by the RULE, not by face value. The live
 *    snapshot's generic visitScored is face value (a T16 is 48); on the doubles
 *    stage that dart is worth 0, and a strip showing 48 would be a lie on screen.
 *
 * The TV half runs the real controller in one page and the real /display in
 * another, over the live feed — the same seam live-scoreboard.js exercises.
 */
const L = require('../lib');

// Drives visits through the app's own turn loop until `untilRound`. The pattern
// (by round + seat) mixes hits and misses so no percentage is a flat 0 or 100.
async function playTo(page, untilRound, extraDarts = []) {
  await page.evaluate(({ untilRound, extraDarts }) => {
    let guard = 0;
    while (game && !game.done && game.grandTourRound < untilRound && guard++ < 400) {
      const t = grandTourRoundTarget(game.grandTourRound);
      const r = game.grandTourRound + game.current;
      const hit = () => { if (t.stage === 'bull') { setMult(r % 2 ? 2 : 1); throwDart(25); } else { setMult(t.mult); throwDart(t.sector); } };
      const miss = () => { setMult(1); throwDart(t.sector === 20 ? 1 : 20); };
      (r % 3 === 0 ? [hit, miss, miss] : r % 3 === 1 ? [hit, hit, miss] : [miss, miss, hit]).forEach(f => f());
      enterTurn();
    }
    extraDarts.forEach(([sector, m]) => { setMult(m); throwDart(sector); });
  }, { untilRound, extraDarts });
}

async function addPlayers(page, names) {
  await page.evaluate(async (names) => {
    for (const n of names) { try { await DB.addPlayer(n); } catch { /* exists */ } if (!roster.includes(n)) roster.push(n); }
  }, names);
}

module.exports = async function run() {
  const rep = L.makeReporter('grand-tour');

  /* ---- the wizard, and the scoring screen ---------------------------------- */
  await L.withPage({ width: 390, height: 844 }, async (page, pageErrors) => {
    await page.evaluate(() => show('setup'));
    await page.waitForTimeout(300);
    const wiz = await page.evaluate(() => {
      selectSetupGame('grand_tour');
      const format = document.getElementById('h2h-options');
      const solo = { mode: setup.mode, max: maxPlayersForSetup() };
      setup.slots = ['A', 'B']; resyncSetupModeForPlayerCount();
      const pair = { mode: setup.mode, gameType: setup.gameType };
      setup.slots = ['']; resyncSetupModeForPlayerCount();
      return { listed: !!document.querySelector('.setup-ledger-row.sel'),
        formatHidden: !format || getComputedStyle(format).display === 'none' || format.hidden,
        solo, pair };
    });
    rep.ok('wizard: Grand Tour is offered and selectable', wiz.listed);
    rep.ok('wizard: no Format picker — a tour is one tour, solo or head to head', wiz.formatHidden);
    rep.ok('wizard: at most two players', wiz.solo.max === 2, `max=${wiz.solo.max}`);
    rep.ok('wizard: one player is practice, two is head to head',
      wiz.solo.mode === 'practice' && wiz.pair.mode === 'h2h' && wiz.pair.gameType === 'grand_tour',
      JSON.stringify(wiz));

    // A whole solo tour. Scripted: singles [S,S,T] · trebles [T,miss,miss] ·
    // doubles [D,D,S] · bull [inner,outer,miss] — 210 points from 110 of 195 darts,
    // worked out by hand in backend/test/db.grand-tour.test.js.
    const solo = [L.uniqueName('GTsolo')];
    await addPlayers(page, solo);
    await page.evaluate(async (names) => {
      setMode('practice'); setGameType('grand_tour'); setup.slots = names; await startGame();
    }, solo);
    await page.waitForTimeout(400);
    const tour = await page.evaluate(() => {
      const order = [];
      const t0 = { legs: game.legsPerSet, sets: game.setsPerGame };
      for (let v = 0; v < 70 && !game.done; v++) {
        const t = grandTourRoundTarget(game.grandTourRound);
        order.push(t.short);
        const at = (sec, m) => { setMult(m); throwDart(sec); };
        if (t.stage === 'single') { at(t.sector, 1); at(t.sector, 1); at(t.sector, 3); }
        else if (t.stage === 'treble') { at(t.sector, 3); at(0, 1); at(0, 1); }
        else if (t.stage === 'double') { at(t.sector, 2); at(t.sector, 2); at(t.sector, 1); }
        else { at(25, 2); at(25, 1); at(0, 1); }
        enterTurn();
      }
      const p = game.players[0], a = grandTourAccuracy(p.tally);
      return { order, t0, visits: order.length, points: p.totalPoints, hits: a.hits, darts: a.darts, done: !!game.done };
    });
    const n20 = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const expectOrder = [...n20, ...n20.map(n => 'T' + n), ...n20.map(n => 'D' + n), 'Bull', 'Bull', 'Bull', 'Bull', 'Bull'];
    rep.ok('solo tour: one leg, one set', tour.t0.legs === 1 && tour.t0.sets === 1, JSON.stringify(tour.t0));
    rep.ok('solo tour: all 65 beds, singles → trebles → doubles → bull',
      JSON.stringify(tour.order) === JSON.stringify(expectOrder), `${tour.visits} visits`);
    rep.ok('solo tour: the scripted darts score 210 from 110 of 195',
      tour.points === 210 && tour.hits === 110 && tour.darts === 195, `${tour.points} pts, ${tour.hits}/${tour.darts}`);
    rep.ok('solo tour: it ends after the 65th visit', tour.done);
    await page.waitForTimeout(1200);
    const panel = await page.evaluate(() => (document.getElementById('game-result') || {}).innerText || '');
    rep.ok('solo tour: the finish screen shows the total and all four stages',
      /210/.test(panel) && ['Singles', 'Trebles', 'Doubles', 'Bull'].every(w => panel.includes(w)),
      panel.replace(/\s+/g, ' ').slice(0, 120));
    await rep.captureIfFailed(page, 'solo-tour');

    // Two players: turn order, the shared target, undo.
    await page.evaluate(() => { try { game = null; } catch {} show('home'); });
    const pair = [L.uniqueName('GTa'), L.uniqueName('GTb')];
    await addPlayers(page, pair);
    await page.evaluate(async (names) => {
      setup.slots = names; setMode('h2h'); setGameType('grand_tour'); await startGame();
    }, pair);
    await page.waitForTimeout(400);
    const two = await page.evaluate(() => {
      const seen = [];
      const note = () => seen.push(`${game.current}@${grandTourRoundTarget(game.grandTourRound).short}`);
      note();
      setMult(1); throwDart(1); enterTurn(); note();
      setMult(1); throwDart(1); enterTurn(); note();
      const before = JSON.stringify(game.players.map(p => [p.totalPoints, p.tally]));
      setMult(1); throwDart(2); enterTurn();
      undoLastTurn();
      const after = JSON.stringify(game.players.map(p => [p.totalPoints, p.tally]));
      return { seen: seen.join(' → '), practice: game.practice, legs: game.legsPerSet, sets: game.setsPerGame,
        undone: before === after && game.current === 0 && game.grandTourRound === 2 };
    });
    rep.ok('two players: they alternate, and the target moves only once both have thrown',
      two.seen === '0@1 → 1@1 → 0@2', two.seen);
    rep.ok('two players: head to head, and still exactly one tour',
      two.practice === false && two.legs === 1 && two.sets === 1, JSON.stringify(two));
    rep.ok('two players: undo restores the points, the tally and whose turn it is', two.undone);
    await rep.captureIfFailed(page, 'two-players');

    rep.ok('scoring screen: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
  });

  /* ---- the live scoreboard, driven by a real game -------------------------- */
  const browser = await L.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  try {
    await L.waitForServer();
    const display = await ctx.newPage();
    display.on('pageerror', e => errors.push(`display: ${e.message}`));
    await display.goto(`${L.BASE}/display`, { waitUntil: 'domcontentloaded' });
    await display.waitForTimeout(1200);
    const controller = await ctx.newPage();
    controller.on('pageerror', e => errors.push(`controller: ${e.message}`));
    await controller.goto(`${L.BASE}/`, { waitUntil: 'domcontentloaded' });
    await controller.waitForFunction(() => typeof startGame === 'function' && typeof DB !== 'undefined', { timeout: 30000 });
    await controller.evaluate(() => {
      if (typeof showWizard === 'function') window.showWizard = () => {};
      const w = document.getElementById('wizard'); if (w) w.hidden = true;
    });

    // Waits out the SSE hop until the display shows the caption we expect.
    const settle = async (re) => {
      for (let i = 0; i < 40; i++) {
        const cap = await display.evaluate(() => (document.querySelector('.stage-cap.aim') || {}).innerText || '');
        if (re.test(cap)) return;
        await display.waitForTimeout(250);
      }
    };
    const read = () => display.evaluate(() => ({
      cap: (document.querySelector('.stage-cap.aim') || {}).innerText || '',
      fmt: document.getElementById('fmt').innerText,
      lit: document.querySelectorAll('#grid .stage-board svg path[filter]').length,
      bullLit: !!document.querySelector('#grid .stage-board svg circle[filter]'),
      counters: getComputedStyle(document.getElementById('game-stats')).display,
      tiles: document.querySelectorAll('#grid .acc').length,
      sides: document.querySelectorAll('#grid .stage-side').length,
      visit: document.getElementById('strip-visit').innerText.replace(/\s+/g, ' '),
      need: document.getElementById('strip-need').innerText.replace(/\s+/g, ' '),
      eyebrows: [...document.querySelectorAll('#grid .stage-side .stage-sub')].map(e => e.innerText),
    }));

    const solo = [L.uniqueName('GTtv')];
    await addPlayers(controller, solo);
    await controller.evaluate(async (names) => {
      setMode('practice'); setGameType('grand_tour'); setup.slots = names; await startGame();
    }, solo);

    await playTo(controller, 7, [[7, 1]]);
    await settle(/SINGLE 7 · DART 2/i);
    const a = await read();
    rep.ok('TV singles: the caption names the bed and the dart', /SINGLE 7 · DART 2 OF 3/i.test(a.cap), a.cap);
    rep.ok('TV singles: BOTH single areas of 7 are lit, nothing else', a.lit === 2 && !a.bullLit, `${a.lit} lit`);
    rep.ok('TV: the top bar gives the stage, not "Leg 1"', /Stage 1 of 4 · Singles · 7 of 20/.test(a.fmt), a.fmt);
    rep.ok('TV: the 180 / Big Fish / Bust counters are hidden', a.counters === 'none', a.counters);
    rep.ok('TV: five accuracy tiles', a.tiles === 5, String(a.tiles));
    rep.ok('TV: the strip names the target', /Single 7/.test(a.need), a.need);

    await controller.evaluate(() => { game.darts = []; renderSlots(); });
    await playTo(controller, 56, [[16, 3]]);
    await settle(/DOUBLE 16 · DART 2/i);
    const b = await read();
    rep.ok('TV doubles: only the double ring of 16 is lit', b.lit === 1 && /DOUBLE 16/i.test(b.cap), `${b.lit} lit · ${b.cap}`);
    rep.ok('TV strip: a T16 on the doubles stage is worth 0, not its face value 48', /THIS VISIT 0\b/i.test(b.visit), b.visit);

    await controller.evaluate(() => { game.darts = []; renderSlots(); });
    await playTo(controller, 64);
    await settle(/BULLSEYE/i);
    const c = await read();
    rep.ok('TV bull: the bull is lit and no wedge is', c.bullLit && c.lit === 0, `bull=${c.bullLit} wedges=${c.lit}`);
    rep.ok('TV bull: the caption counts bull darts out of 15', /DART 10 OF 15/i.test(c.cap), c.cap);
    await rep.captureIfFailed(display, 'tv-solo');

    // Two players on the trebles stage.
    await controller.evaluate(() => { try { game = null; } catch {} show('home'); });
    const pair = [L.uniqueName('GTtvA'), L.uniqueName('GTtvB')];
    await addPlayers(controller, pair);
    await controller.evaluate(async (names) => {
      setup.slots = names; setMode('h2h'); setGameType('grand_tour'); await startGame();
    }, pair);
    await playTo(controller, 29, [[9, 3]]);
    await settle(/TREBLE 9 · DART 2/i);
    const d = await read();
    rep.ok('TV two players: one side each with five tiles, one shared board', d.sides === 2 && d.tiles === 10 && d.lit === 1,
      `sides=${d.sides} tiles=${d.tiles} lit=${d.lit}`);
    rep.ok('TV two players: who is throwing and who is next',
      /AT THE OCHE/i.test(d.eyebrows[0] || '') && /WAITING/i.test(d.eyebrows[1] || ''), d.eyebrows.join(' | '));
    rep.ok('TV two players: the top bar says head to head', /Head to head · Stage 2 of 4 · Trebles/.test(d.fmt.replace(/\s+/g, ' ')), d.fmt);
    await rep.captureIfFailed(display, 'tv-two');

    rep.ok('TV: no uncaught page errors on either screen', errors.length === 0, errors.join('; '));
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return rep.finish();
};
