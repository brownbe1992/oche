'use strict';
/* Smoke checks across game types with structurally different scoring screens.
 *
 * These are shallow on purpose. They exist because the scoring screen's markup
 * is rebuilt per game type by renderGameShell(), and a layout change made for
 * X01 has repeatedly turned out to affect Cricket's chalkboard scorecard or the
 * per-dart drills, which hide the slots row and relabel the undo buttons. The
 * point is "does each shape still render and accept darts", not to re-derive
 * any scoring rules — that maths belongs in backend/test/ (see SKILL.md).
 */
const L = require('../lib');

async function stagedVisitMode(rep, gameType, viewport, label, expectSlotText) {
  await L.withPage(viewport, async (page, pageErrors) => {
    const names = [L.uniqueName(`${label}A`), L.uniqueName(`${label}B`)];
    await page.evaluate(async (opts) => {
      for (const n of opts.names) await DB.addPlayer(n);
      roster.push(...opts.names);
      setMode('h2h');
      setup.gameType = opts.gameType;
      setup.slots = opts.names;
      await startGame();
    }, { names, gameType });
    await page.waitForTimeout(500);

    const rendered = await page.evaluate(() => ({
      boardPresent: !!document.getElementById('dart-board-wrap'),
      scoreboardHasContent: document.getElementById('scoreboard').textContent.trim().length > 0,
    }));
    rep.ok(`${label}: scoring screen renders`, rendered.boardPresent && rendered.scoreboardHasContent);

    await page.evaluate(() => {
      setMult(3); throwDart(20);
      setMult(1); throwDart(19);
      setMult(1); throwDart(18);
    });
    await page.waitForTimeout(300);

    const slots = await page.evaluate(() => document.getElementById('slots').innerText);
    rep.ok(`${label}: three darts land in the visit slots`, expectSlotText.test(slots),
      JSON.stringify(slots.replace(/\n/g, ' ')));

    await page.evaluate(() => enterTurn());
    await page.waitForTimeout(300);
    rep.ok(`${label}: entering the turn doesn't error`, pageErrors.length === 0, pageErrors.join('; '));
  });
}

// Per-dart drills commit every dart immediately: no staged visit, so no slots
// row, no "Enter turn", and Undo is per-dart. Checkout Trainer looks similar but
// is genuinely a staged visit, so it keeps them — a distinction that has been
// got wrong before when the shell template changed.
async function soloMode(rep, gameType, label, expect) {
  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    const name = L.uniqueName(label);
    await page.evaluate(async (opts) => {
      await DB.addPlayer(opts.name);
      roster.push(opts.name);
      setMode('practice');
      setup.gameType = opts.gameType;
      setup.slots = [opts.name];
      await startGame();
    }, { name, gameType });
    await page.waitForTimeout(500);

    const shell = await page.evaluate(() => {
      const slots = document.getElementById('slots');
      const undoTurn = document.getElementById('undo-turn-btn');
      const enter = document.getElementById('enter-btn');
      return {
        slotsHidden: slots ? getComputedStyle(slots).display === 'none' : true,
        undoLabel: undoTurn ? undoTurn.textContent.trim() : null,
        enterHidden: enter ? enter.hidden : true,
        boardPresent: !!document.getElementById('dart-board-wrap'),
      };
    });
    rep.ok(`${label}: renders a scoring screen`, shell.boardPresent);
    rep.ok(`${label}: slots row ${expect.slotsHidden ? 'hidden' : 'shown'}`,
      shell.slotsHidden === expect.slotsHidden);
    rep.ok(`${label}: undo labelled "${expect.undoLabel}"`, shell.undoLabel === expect.undoLabel,
      `got "${shell.undoLabel}"`);
    rep.ok(`${label}: enter-turn ${expect.enterHidden ? 'hidden' : 'shown'}`,
      shell.enterHidden === expect.enterHidden);
    rep.ok(`${label}: no uncaught page errors`, pageErrors.length === 0, pageErrors.join('; '));
  });
}

module.exports = async function run() {
  const rep = L.makeReporter('scoring-modes');
  await stagedVisitMode(rep, 'x01', L.PORTRAIT, 'x01-portrait', /T20[\s\S]*60 pts/);
  await stagedVisitMode(rep, 'x01', L.LANDSCAPE, 'x01-landscape', /T20[\s\S]*60 pts/);
  await stagedVisitMode(rep, 'cricket', L.LANDSCAPE, 'cricket-landscape', /T20[\s\S]*3 marks/);
  await soloMode(rep, 'around_the_clock', 'around-the-clock',
    { slotsHidden: true, undoLabel: 'Undo Dart', enterHidden: true });
  await soloMode(rep, 'checkout_trainer', 'checkout-trainer',
    { slotsHidden: false, undoLabel: 'Undo Turn', enterHidden: false });
  return rep.finish();
};
