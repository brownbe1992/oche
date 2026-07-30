'use strict';
/* Maths Trainer (docs/minigames-roadmap.md Part A, REFERENCE.md §21).
 *
 * The mode's maths is covered by node:test (scoring.maths-trainer + db.maths-trainer,
 * 57 cases). What only a browser can see is everything below, and three of these
 * assertions exist because the first build got them wrong:
 *
 *  - The play surface vanished the instant a game started. #maths-quiz was added to
 *    the static markup only, and renderGameShell() replaces .game-play-area's
 *    innerHTML wholesale — so the container had to be in that template too, exactly
 *    as #game-result already is. Nothing in node:test can see an element that is
 *    present at load and gone at play.
 *  - The revealed correct answer was invisible: .chosen sets cream text, .truth
 *    repainted the background pale, and the specificity meant cream-on-pale. A
 *    contrast bug in a state that only exists after a click.
 *  - The Pad/Dartboard toggle showed for a mode that takes neither input.
 *
 * Plus the Sprint hard stop, which is a wall-clock rule with three enforcement
 * points and no unit-testable surface.
 */
const L = require('../lib');

async function startMaths(page, name, cfg) {
  await page.evaluate(async (o) => {
    show('setup');
    await new Promise(r => setTimeout(r, 350));
    selectSetupGame('maths_trainer');
    await new Promise(r => setTimeout(r, 250));
    Object.assign(setup, o.cfg);
    setup.slots = [o.n];
    await startGame();
  }, { n: name, cfg });
  await page.waitForTimeout(800);
}

async function segmentLoop(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const name = L.uniqueName('MathsSeg');
    await page.evaluate(async (n) => { await DB.addPlayer(n); roster.push(n); }, name);
    await startMaths(page, name, { mathsQuestionType: 'segment', mathsMode: 'freeform' });

    const fresh = await page.evaluate(() => {
      const q = document.getElementById('maths-quiz');
      const toggle = document.querySelector('#game-header-controls .imt-row');
      return {
        // The regression that cost the most time: present at load, gone at play.
        quizPresent: !!q,
        quizVisible: !!q && q.offsetParent !== null,
        railHidden: document.getElementById('rail-play').hidden,
        ocheHidden: document.querySelector('.oche').hidden,
        paper: document.body.classList.contains('paper-mode'),
        toggleHidden: !toggle || toggle.hidden || getComputedStyle(toggle).display === 'none',
        opts: document.querySelectorAll('#maths-quiz .mq-opt').length,
        rule: !!document.querySelector('#maths-quiz .mq-band'),
        keys: [...document.querySelectorAll('#maths-quiz .mq-k')].map(e => e.textContent).join(''),
        prompt: game.q.prompt,
        options: game.qOptions.slice(),
      };
    });
    rep.ok('maths: the play surface survives renderGameShell', fresh.quizPresent && fresh.quizVisible);
    rep.ok('maths: the dart rail and oche are hidden', fresh.railHidden && fresh.ocheHidden);
    rep.ok('maths: paper mode is on', fresh.paper);
    rep.ok('maths: the input toggle is hidden — this mode takes neither pad nor board',
      fresh.toggleHidden);
    rep.ok('maths: four options are offered', fresh.opts === 4, `${fresh.opts}`);
    rep.ok('maths: the timing rule marks the threshold', fresh.rule);
    rep.ok('maths: each option shows its keyboard shortcut', fresh.keys === '1234', fresh.keys);
    // The arithmetic-shortcut rule, checked against what a real session actually
    // offered rather than against a generated fixture.
    const shapeOk = /^T/.test(fresh.prompt) ? fresh.options.every(v => v % 3 === 0)
      : /^D/.test(fresh.prompt) ? fresh.options.every(v => v % 2 === 0) : true;
    rep.ok('maths: a live option set carries no arithmetic shortcut', shapeOk,
      `${fresh.prompt} -> ${fresh.options.join(',')}`);

    // A correct, fast answer.
    await page.evaluate(() => answerMaths(game.q.answer));
    await page.waitForTimeout(500);
    const good = await page.evaluate(() => {
      const t = document.querySelector('#maths-quiz .mq-opt.truth');
      const cs = t ? getComputedStyle(t) : null;
      return {
        verdict: (document.querySelector('#maths-quiz .mq-verdict') || {}).textContent || '',
        cls: (document.querySelector('#maths-quiz .mq-verdict') || {}).className || '',
        landed: !!document.querySelector('#maths-quiz .mq-landed'),
        working: (document.querySelector('#maths-quiz .mq-working') || {}).textContent || '',
        truthColor: cs ? cs.color : null,
        truthBg: cs ? cs.backgroundColor : null,
        locked: [...document.querySelectorAll('#maths-quiz .mq-opt')].every(b => b.disabled),
      };
    });
    rep.ok('maths: a fast correct answer reads as known', /Knew it/.test(good.verdict), good.verdict);
    rep.ok('maths: the verdict is styled as good', /good/.test(good.cls));
    rep.ok('maths: a tick lands on the timing rule where the answer fell', good.landed);
    rep.ok('maths: the working is spelled out', /=/.test(good.working), good.working);
    // The contrast bug: chosen+correct must not be cream on pale.
    rep.ok('maths: the revealed answer is readable, not cream on pale',
      good.truthColor !== good.truthBg && !/239,\s*231,\s*210/.test(good.truthColor || ''),
      `${good.truthColor} on ${good.truthBg}`);
    rep.ok('maths: options lock once answered', good.locked);

    // A slow correct answer is the state the whole mode exists for.
    await page.evaluate(() => { nextMathsQuestion(); game.qShownAt = Date.now() - 9000; });
    await page.evaluate(() => answerMaths(game.q.answer));
    await page.waitForTimeout(400);
    const slow = await page.evaluate(() => ({
      verdict: (document.querySelector('#maths-quiz .mq-verdict') || {}).textContent || '',
      cls: (document.querySelector('#maths-quiz .mq-verdict') || {}).className || '',
    }));
    rep.ok('maths: a SLOW correct answer says you worked it out',
      /worked that one out/.test(slow.verdict), slow.verdict);
    rep.ok('maths: and is not styled as good', !/good/.test(slow.cls), slow.cls);

    rep.ok('maths: no uncaught page errors (segment loop)', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'maths-segment');
  });
}

async function boardPrompt(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const name = L.uniqueName('MathsBoard');
    await page.evaluate(async (n) => { await DB.addPlayer(n); roster.push(n); }, name);
    await startMaths(page, name, { mathsQuestionType: 'counting', mathsPromptStyle: 'board', mathsDifficulty: 'hard' });
    const s = await page.evaluate(() => ({
      svg: !!document.querySelector('#maths-quiz .mq-board svg'),
      numbers: document.querySelectorAll('#maths-quiz .mq-board svg text').length,
      dots: document.querySelectorAll('#maths-quiz .mq-board svg circle[fill="#14160f"]').length,
      dartCount: game.q.segments.length,
      answer: game.q.answer,
      options: game.qOptions.slice(),
      label: (document.querySelector('#maths-quiz .mq-board svg') || {}).getAttribute
        ? document.querySelector('#maths-quiz .mq-board svg').getAttribute('aria-label') : null,
    }));
    rep.ok('maths: the board prompt renders a board', s.svg);
    rep.ok('maths: all twenty numbers are on it', s.numbers === 20, `${s.numbers}`);
    rep.ok('maths: one dart marker per dart', s.dots === s.dartCount, `${s.dots} of ${s.dartCount}`);
    rep.ok('maths: the board carries a text alternative', /darts? in it/.test(s.label || ''), s.label || '');
    rep.ok("maths: a visit's options all match the total's parity",
      s.options.every(v => v % 2 === s.answer % 2), `${s.answer} <- ${s.options.join(',')}`);
    rep.ok('maths: no uncaught page errors (board prompt)', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'maths-board');
  });
}

async function sprintAndCrib(rep) {
  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const name = L.uniqueName('MathsSprint');
    await page.evaluate(async (n) => { await DB.addPlayer(n); roster.push(n); }, name);
    await startMaths(page, name, { mathsQuestionType: 'segment', mathsMode: 'sprint' });

    const armed = await page.evaluate(() => ({
      clock: (document.getElementById('maths-clock') || {}).textContent || '',
      bar: !!document.getElementById('maths-timebar-fill'),
      wallClock: game.sprintDeadline != null,
    }));
    rep.ok('maths: the sprint clock reads m:ss', /^[01]:[0-5]\d$/.test(armed.clock), armed.clock);
    rep.ok('maths: a wall-clock deadline is armed, not a counter', armed.wallClock);
    rep.ok('maths: the time bar is drawn', armed.bar);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => answerMaths(game.q.answer));
      await page.waitForTimeout(1000);
    }
    const mid = await page.evaluate(() => ({
      score: game.players[0].correctCount,
      pips: [...document.querySelectorAll('#maths-quiz .mq-pips i')].map(e => e.textContent).join(''),
    }));
    rep.ok('maths: the sprint score counts correct answers', mid.score === 3, `${mid.score}`);
    // Not colour-only: each round carries a glyph.
    rep.ok('maths: the round strip marks outcomes with glyphs, not colour alone',
      /[✓◐●]/.test(mid.pips), mid.pips);

    // THE HARD STOP. Wind the deadline into the past and try to answer.
    const stop = await page.evaluate(async () => {
      game.sprintDeadline = Date.now() - 1;
      const before = game.players[0].rounds;
      answerMaths(game.q ? game.q.answer : 0);
      await new Promise(r => setTimeout(r, 400));
      return { unchanged: game.players[0].rounds === before, ended: !!game.sprintEnded };
    });
    rep.ok('maths: an answer past the buzzer is refused, not scored', stop.unchanged);
    rep.ok('maths: the run ends instead', stop.ended);

    await page.waitForTimeout(1000);
    const crib = await page.evaluate(() => ({
      summary: !!document.querySelector('.game-result .mq-summary'),
      rows: document.querySelectorAll('.game-result .mq-row').length,
      count: (document.getElementById('maths-crib-count') || {}).textContent || '',
      values: [...document.querySelectorAll('.game-result .mq-val')].slice(0, 4).map(e => e.textContent),
      marks: [...document.querySelectorAll('.game-result .mq-st')].slice(0, 4).map(e => e.textContent).join(''),
    }));
    rep.ok('maths: the session ends on the crib sheet', crib.summary);
    rep.ok('maths: the crib sheet lists the whole pool', crib.rows >= 20, `${crib.rows} rows`);
    // The value column is what makes it a crib sheet rather than a bar chart.
    rep.ok('maths: every crib row shows the segment VALUE',
      crib.values.length > 0 && crib.values.every(v => /^\d+$/.test(v)), crib.values.join(','));
    rep.ok('maths: the known-cold headline renders', /\d+\/\d+/.test(crib.count.replace(/\s/g, '')), crib.count);
    rep.ok('maths: crib states are marked with glyphs too', /[✓◐●]/.test(crib.marks), crib.marks);

    rep.ok('maths: no uncaught page errors (sprint)', pageErrors.length === 0, pageErrors.join('; '));
    await rep.captureIfFailed(page, 'maths-sprint');
  });
}

module.exports = async function run() {
  const rep = L.makeReporter('maths-trainer');
  await segmentLoop(rep);
  await boardPrompt(rep);
  await sprintAndCrib(rep);
  return rep.finish();
};
