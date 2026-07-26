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
    await rep.captureIfFailed(page, label);
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
    await rep.captureIfFailed(page, label);
  });
}

// The landscape/tablet board-entry pass (2026-07). The board is the score-ENTRY
// surface on a tablet, so its drawn size is a functional property, not a cosmetic
// one — and it is decided entirely by its container (the SVG is
// preserveAspectRatio "meet", so it fits the SHORTER of the column's two
// dimensions). Before this pass a 760px cap on `.wrap` left the board at 400px of
// an 1180px screen with ~165px of dead space above and below it. Only a real
// browser can catch that regressing: the CSS would still parse, the test suite
// would still pass, and the board would just quietly be small again.
async function landscapeBoardEntry(rep) {
  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    const names = [L.uniqueName('LandA'), L.uniqueName('LandB')];
    await L.startX01(page, { names, startScore: 501 });
    await page.evaluate(() => { dartboardMode = true; applyDartMode(); });
    await page.waitForTimeout(300);

    const board = await page.evaluate(() => {
      const r = document.getElementById('dart-board-wrap').getBoundingClientRect();
      // "meet" draws a square fitted to the shorter side.
      return { drawn: Math.round(Math.min(r.width, r.height)), vh: window.innerHeight };
    });
    // 0.85 of the viewport height is comfortably above the old 400px (0.49) and
    // comfortably below anything achievable, so it fails loudly if the cap comes
    // back without being brittle about a few pixels of chrome.
    rep.ok('landscape: the board fills the panel height (>=85% of the viewport)',
      board.drawn >= board.vh * 0.85, `board drew at ${board.drawn}px in a ${board.vh}px-tall viewport`);

    await page.evaluate(() => { throwDartBoard(20, 3, 'treble'); throwDartBoard(5, 1, 'outer'); });
    await page.waitForTimeout(200);

    const flash = await page.evaluate(() => {
      const el = document.getElementById('dart-flash');
      const b = el.getBoundingClientRect();
      const board = document.getElementById('dart-board-wrap').getBoundingClientRect();
      return { text: el.textContent, on: el.classList.contains('on'),
        display: getComputedStyle(el).display,
        clearOfBoard: b.right <= board.left + 1 };
    });
    rep.ok('landscape: a board tap flashes the score it registered', flash.on && flash.text === '5',
      `flash showed "${flash.text}" (on=${flash.on}, display=${flash.display})`);
    rep.ok('landscape: the flash sits clear of the board, never over it', flash.clearOfBoard);

    const row = await page.evaluate(() => {
      const slots = [...document.querySelectorAll('#slots .slot')];
      return { tags: slots.map(s => s.tagName), latest: slots.findIndex(s => s.classList.contains('latest')),
        text: slots.map(s => s.querySelector('.lab') ? s.querySelector('.lab').textContent : null) };
    });
    rep.ok('landscape: the current-turn row reads T20 then 5',
      row.text[0] === 'T20' && row.text[1] === '5', JSON.stringify(row.text));
    rep.ok('landscape: the most recent dart is the one marked', row.latest === 1, `marked index ${row.latest}`);
    rep.ok('landscape: filled darts are buttons, empty ones are not',
      row.tags.join() === 'BUTTON,BUTTON,DIV', row.tags.join());

    // Tap dart 1 — the whole turn should go, in one gesture.
    await page.click('#slots .slot:nth-child(1)');
    await page.waitForTimeout(250);
    const undone = await page.evaluate(() => ({
      darts: game.darts.length,
      flashOn: document.getElementById('dart-flash').classList.contains('on'),
    }));
    rep.ok('landscape: tapping dart 1 walks the whole turn back', undone.darts === 0, `${undone.darts} darts left`);
    rep.ok('landscape: the undo clears the flash too', undone.flashOn === false);

    rep.ok('landscape-board: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'landscape-board-entry');
  });
}

// The portrait stack must be untouched by any of the above. The flash is inserted
// into the markup unconditionally, so `display:none` at base is the only thing
// keeping it out of the portrait column — and the dart row must stay 3-across.
async function portraitUnchanged(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const names = [L.uniqueName('PortA'), L.uniqueName('PortB')];
    await L.startX01(page, { names, startScore: 501 });
    await page.evaluate(() => { dartboardMode = true; applyDartMode(); throwDartBoard(20, 3, 'treble'); });
    await page.waitForTimeout(300);
    const p = await page.evaluate(() => ({
      flashDisplay: getComputedStyle(document.getElementById('dart-flash')).display,
      cols: getComputedStyle(document.getElementById('slots')).gridTemplateColumns.split(' ').length,
      wrapCapped: Math.round(document.querySelector('.wrap').getBoundingClientRect().width) <= 760,
    }));
    rep.ok('portrait: the board-tap flash is not rendered', p.flashDisplay === 'none', p.flashDisplay);
    rep.ok('portrait: the dart row is still 3 across', p.cols === 3, `${p.cols} columns`);
    rep.ok('portrait: the 760px game-screen cap still applies', p.wrapCapped);
    rep.ok('portrait-unchanged: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'portrait-unchanged');
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
  await landscapeBoardEntry(rep);
  await portraitUnchanged(rep);
  return rep.finish();
};
