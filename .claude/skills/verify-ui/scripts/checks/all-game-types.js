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
          // Read from the registry, not a hand-kept list here, so the next dartless
          // mode arrives covered.
          dartless: !!(GAME_TYPES[game.gameType] && GAME_TYPES[game.gameType].noDartInput),
          ownSurfaceVisible: (() => { const q = document.getElementById('maths-quiz'); return !!q && q.offsetParent !== null; })(),
          /* Every dart-entry control, measured by whether it actually RENDERS —
             getBoundingClientRect(), NOT the element's own `hidden`/display. That
             distinction is the whole assertion: these live inside .turn-actions,
             which is inside #rail-play, and #rail-play is what the mode hides. An
             element whose ancestor is hidden still reports its own display as
             `block`, so a check written against the element's own style reports all
             four as visible and is simply measuring the wrong thing — which is
             precisely the mistake that made this look like a live bug. */
          entryControls: ['bounce-out-btn', 'undo-turn-btn', 'undo-btn', 'enter-btn']
            .filter(id => { const e = document.getElementById(id); if (!e) return false;
                            const r = e.getBoundingClientRect(); return r.width > 0 || r.height > 0; }),
          /* The two turn-loop members a dartless mode does not declare. Every control
             above is wired to one of them, so a visible control is not a cosmetic
             wart — pressing it throws. */
          hasTurnLoopMembers: !!((GAME_TYPES[game.gameType] || {}).undoLastTurn)
            || !!((GAME_TYPES[game.gameType] || {}).enterTurn),
        };
      });

      /* A DARTLESS mode (GAME_TYPES.<type>.noDartInput — today the Maths Trainer)
         breaks three of this sweep's assumptions on purpose: nothing is thrown, so
         it hides .oche and both dart inputs, and it clears #scoreboard because its
         whole surface is its own container. Rather than skip it — which would
         quietly shrink this sweep's coverage for a whole game type — assert the
         equivalent facts FOR that shape, so the count is unchanged and a dartless
         mode that failed to render at all would still fail here. */
      if (shell.dartless) {
        rep.ok(`${key}: reaches the game screen with its own surface`,
          shell.onGameScreen && shell.ownSurfaceVisible);
        rep.ok(`${key}: hides both dart inputs — it takes neither`, !shell.ocheVisible,
          `oche visible = ${shell.ocheVisible}`);
        rep.ok(`${key}: leaves the scoreboard empty deliberately`, !shell.scoreboardHasContent);
        /* No dart-entry control renders at all — Bounce Out, Undo Dart, Undo Turn,
           Enter turn. This is currently true because renderGameMathsTrainer() hides
           #rail-play wholesale, not because any of the four is individually hidden,
           which is exactly why it is asserted as a PROPERTY here: it must stay true
           however the mode chooses to render itself, and a future dartless minigame
           that builds its surface differently inherits the same requirement.

           It matters more than a cosmetic wart would. Every one of those controls
           dispatches through a turn-loop registry member (undoLastTurn, enterTurn)
           that a dartless mode does not declare, so a control that DID render would
           throw a TypeError on being pressed rather than merely looking wrong. */
        rep.ok(`${key}: no dart-entry control renders — it takes neither input`,
          shell.entryControls.length === 0, `visible: ${shell.entryControls.join(', ') || 'none'}`);
        rep.ok(`${key}: and declares no turn-loop members for one to have called`,
          !shell.hasTurnLoopMembers);
      } else {
        rep.ok(`${key}: reaches the game screen`, shell.onGameScreen && shell.ocheVisible);
        rep.ok(`${key}: exactly one input surface is live`, shell.inputSurfaces === 1,
          `pad+board visible = ${shell.inputSurfaces}`);
        rep.ok(`${key}: scoreboard renders something`, shell.scoreboardHasContent);
      }

      // A single dart through whichever input the mode uses. Some modes commit
      // per dart and some stage a visit; either way this must not throw.
      const errsBefore = pageErrors.length;
      await page.evaluate(() => { try { setMult(1); throwDart(20); } catch (e) { /* surfaced via pageerror */ } });
      await page.waitForTimeout(250);
      rep.ok(`${key}: accepts a dart without erroring`, pageErrors.length === errsBefore,
        pageErrors.slice(errsBefore).join('; '));

      // The mode's leg/game-complete panel, rendered against the REAL player
      // objects this mode just built. Source-level tests can't catch a spec that
      // reads a field the live factory never creates — that is exactly how Dead
      // Man Walking's own achievement fields shipped missing (BUG-34), and a
      // completion panel is the worst place to discover it, since it only paints
      // once the game is already over and unrepeatable.
      const panel = await page.evaluate(() => {
        try {
          const gt = GAME_TYPES[game.gameType];
          if (!gt.completionPanel) return { skipped: true, declared: !!gt.noCompletionStats };
          const html = gameCompletionPanelHtml(game.players[0].name, 'game');
          return { skipped: false, length: html.length, hasHero: html.includes('lc-head') };
        } catch (err) {
          return { error: String(err && err.message || err) };
        }
      });
      if (panel.error) {
        rep.ok(`${key}: completion panel renders`, false, panel.error);
      } else if (panel.skipped) {
        rep.ok(`${key}: no completion panel, and says so`, panel.declared,
          panel.declared ? 'noCompletionStats' : 'declares NEITHER — its completion screen would be blank');
      } else {
        rep.ok(`${key}: completion panel renders`, panel.length > 0 && panel.hasHero,
          `${panel.length} chars, hero=${panel.hasHero}`);
      }

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
