'use strict';
/* Every game type still starts and renders a usable scoring screen.
 *
 * `renderGameShell()` builds the scoring screen for all 16 game types from one
 * template, so a change made while looking at X01 lands on all of them. The
 * hand-written checks in scoring-modes.js go deeper on four representative
 * shapes; this one goes shallow across everything, and — importantly — reads
 * the list from the app's own GAME_TYPES registry rather than a list kept here.
 * A new game type therefore arrives with coverage already in place, which is
 * the same registry-driven discipline the app uses internally instead of
 * hand-maintained parallel lists.
 *
 * Shallow on purpose: "does it start, render controls, and accept a dart
 * without throwing". Anything about a mode's actual rules is arithmetic and
 * belongs in backend/test/ (see SKILL.md).
 */
const L = require('../lib');

module.exports = async function run() {
  const rep = L.makeReporter('all-game-types');

  // One page for the whole sweep. A fresh browser context per game type would
  // be cleaner in isolation but costs 16 page loads against a server that
  // rate-limits 300 req/60s — the sweep would trip it and start reporting
  // phantom failures.
  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    const types = await page.evaluate(() =>
      Object.keys(GAME_TYPES)
        .filter(k => !GAME_TYPES[k].dispatchOnly)
        .map(k => ({ key: k, contexts: contextsForMode(k) })));

    rep.ok('registry: game types discovered', types.length >= 10, `${types.length} types`);

    for (const { key, contexts } of types) {
      const mode = contexts.includes('practice') ? 'practice' : 'h2h';
      // h2h-only modes (Killer) need a real opponent; solo modes take one seat.
      const seats = mode === 'h2h' ? 2 : 1;
      const names = Array.from({ length: seats }, (_, i) => L.uniqueName(`AGT_${key}_${i}`));

      const started = await page.evaluate(async (opts) => {
        try {
          for (const n of opts.names) await DB.addPlayer(n);
          roster.push(...opts.names);
          setMode(opts.mode);
          setup.gameType = opts.key;
          setup.slots = opts.names;
          await startGame();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err && err.message || err) };
        }
      }, { key, mode, names });

      if (!started.ok) {
        rep.ok(`${key}: starts`, false, started.error);
        continue;
      }
      await page.waitForTimeout(350);

      const shell = await page.evaluate(() => {
        const oche = document.querySelector('.oche');
        const pad = document.getElementById('pad');
        const board = document.getElementById('dart-board-wrap');
        const vis = el => !!el && getComputedStyle(el).display !== 'none';
        return {
          onGameScreen: !document.getElementById('screen-game').classList.contains('hidden')
            || document.getElementById('screen-game').offsetParent !== null,
          ocheVisible: vis(oche),
          // Exactly one input surface should be live: the number pad OR the
          // dartboard, never both and never neither.
          inputSurfaces: [vis(pad), vis(board)].filter(Boolean).length,
          scoreboardHasContent: document.getElementById('scoreboard').textContent.trim().length > 0,
        };
      });

      rep.ok(`${key}: reaches the game screen`, shell.onGameScreen && shell.ocheVisible);
      rep.ok(`${key}: exactly one input surface is live`, shell.inputSurfaces === 1,
        `pad+board visible = ${shell.inputSurfaces}`);
      rep.ok(`${key}: scoreboard renders something`, shell.scoreboardHasContent);

      // A single dart through whichever input the mode uses. Some modes commit
      // per dart and some stage a visit; either way this must not throw.
      const errsBefore = pageErrors.length;
      await page.evaluate(() => { try { setMult(1); throwDart(20); } catch (e) { /* surfaced via pageerror */ } });
      await page.waitForTimeout(250);
      rep.ok(`${key}: accepts a dart without erroring`, pageErrors.length === errsBefore,
        pageErrors.slice(errsBefore).join('; '));

      // Leave the game so the next iteration starts from a clean screen.
      await page.evaluate(() => { try { game = null; } catch {} show('home'); });
      await page.waitForTimeout(200);
    }

    await rep.captureIfFailed(page, 'sweep');
    rep.ok('all-game-types: no uncaught page errors', pageErrors.length === 0,
      pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
