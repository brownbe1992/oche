'use strict';
/* Every mode's score-entry screen is REACHABLE ON A PHONE, and responds to a
 * real tap.
 *
 * The gap this fills, in one sentence: everything else in this suite drives the
 * app by calling `throwDart()` from `page.evaluate()`, which works perfectly
 * against a button that is zero pixels tall.
 *
 * That is not a theoretical distinction. Four modes shipped unplayable on a
 * phone and every check here stayed green through it. `#scoreboard` was
 * `flex:none` — sized to its own content, never allowed to shrink — which is
 * fine for X01's one 66px card per player and completely wrong for a mode whose
 * scoreboard is a long ladder. Measured at 390x844:
 *
 *   Bob's 27            619px of scoreboard  ->  pad   0px tall
 *   The Pressure Chamber 641px               ->  pad   0px tall
 *   Around the Clock     875px               ->  board 0px tall
 *   Around the World     901px               ->  board 0px tall
 *
 * `.oche` is `flex:1; min-height:0`, so it absorbed the entire shortfall and the
 * input surface collapsed to nothing; `body.game-active{overflow:hidden}` meant
 * there was nothing to scroll to either. The owner reported it as "Bob's 27 does
 * not currently allow me to enter any shots", which is exactly what it was.
 * `all-game-types` asserted "exactly one input surface is live" and passed — it
 * ran in landscape, where there was room, and asked whether the element was
 * DISPLAYED rather than whether it had any size.
 *
 * So the rules here are: measure at phone sizes, insist on real pixels, and
 * interact only by clicking what is actually rendered.
 *
 * The second half of the check is the follow-up defect the first half's fix
 * creates if you stop too early. Once a long ladder scrolls, the round you are
 * throwing at scrolls away with it — Bob's 27 at round 18 was still showing D1
 * to D8 — and so does the banner underneath naming the target. Bob's 27 and The
 * Pressure Chamber are played to a late round here and asked for all three at
 * once: the current row visible, the banner visible, the pad still tappable.
 */
const L = require('../lib');

// Deliberately the two smallest realistic screens. Every other check that
// touches a game screen uses LANDSCAPE or the roomy PORTRAIT, and that is
// precisely where these four modes looked fine.
const VIEWPORTS = [
  ['390x844', { width: 390, height: 844 }],
  ['360x640', { width: 360, height: 640 }],
];

// Measured inside the page: which surface is live, how big it really is, and
// whether anything the player must press has left the screen.
function probeLayout() {
  const vh = window.innerHeight, vw = window.innerWidth;
  const shown = el => !!el && getComputedStyle(el).display !== 'none'
    && getComputedStyle(el).visibility !== 'hidden';
  const pad = document.getElementById('pad');
  const board = document.getElementById('dart-board-wrap');
  const surface = shown(pad) ? pad : shown(board) ? board : null;
  const box = surface ? surface.getBoundingClientRect() : null;
  const controls = ['enter-btn', 'undo-turn-btn', 'bounce-out-btn'].map(id => {
    const el = document.getElementById(id);
    if (!el) return { id, offscreen: false };
    const r = el.getBoundingClientRect();
    // A control with no box at all is hidden on purpose for this mode; only a
    // control that is rendered AND out of reach is a failure.
    return { id, offscreen: r.height > 0 && (r.bottom > vh + 1 || r.top < 0 || r.right > vw + 1 || r.left < 0) };
  });
  const sb = document.getElementById('scoreboard');
  return {
    surfaceName: shown(pad) ? 'pad' : shown(board) ? 'board' : 'none',
    height: box ? Math.round(box.height) : 0,
    inViewport: !!box && box.top >= -1 && box.bottom <= vh + 1,
    offscreenControls: controls.filter(c => c.offscreen).map(c => c.id),
    // Two different sideways overflows, both of which have been real here: the
    // whole page wider than the window, and the scoreboard card wider than the
    // scoreboard (an X01 card measured 481px inside a 390px screen, putting the
    // score itself past the right-hand edge).
    pageOverflowsX: document.documentElement.scrollWidth > vw + 1,
    scoreboardOverflowsX: sb.scrollWidth > sb.clientWidth + 1,
  };
}

// One JSON string describing everything a dart could change. Some modes stage
// darts into `game.darts`; the per-dart modes (Doubles Practice, Chuckin,
// Around the Clock/World, Killer) commit immediately and leave it empty, so a
// check that watched only `game.darts` would call four working modes broken.
// Comparing the whole visible position covers both without a per-mode list.
function positionFingerprint() {
  const gt = GAME_TYPES[game.gameType];
  return JSON.stringify({
    darts: game.darts || [],
    turns: (game.currentLegTurns || []).length,
    players: gt.playerSnapshot ? game.players.map(p => gt.playerSnapshot(p)) : game.players,
    status: document.getElementById('status').textContent,
  });
}

// The largest tappable thing on whichever surface is live, as page coordinates.
// Returns null when there is nothing with a real box — which is the failure this
// whole check exists for, so it is reported rather than thrown.
function findTapTarget() {
  const pad = document.getElementById('pad');
  const board = document.getElementById('dart-board-wrap');
  const usePad = getComputedStyle(pad).display !== 'none';
  const candidates = usePad
    // Two exclusions, both about picking a button that actually SCORES.
    // Not Miss: a valid tap everywhere, but "Miss" changing nothing visible is
    // a plausible outcome in some modes and would read as a failure here.
    // Not a disclosure: Cricket's "Hit a different number ▾" is the widest
    // button on its pad and only opens a picker. `aria-expanded` names that
    // shape generically, rather than singling Cricket out by class.
    ? [...pad.querySelectorAll('button')].filter(b => !b.disabled
        && !/miss/i.test(b.className) && !b.hasAttribute('aria-expanded'))
    : [...board.querySelectorAll('[data-sector], path, circle')];
  let best = null, bestArea = 0;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (r.width > 2 && r.height > 2 && area > bestArea) { best = el; bestArea = area; }
  }
  if (!best) return null;
  const r = best.getBoundingClientRect();
  return {
    x: r.left + r.width / 2, y: r.top + r.height / 2,
    label: (best.textContent || best.getAttribute('aria-label') || best.tagName).trim().slice(0, 24),
  };
}

async function startMode(page, key, mode, names) {
  return page.evaluate(async (opts) => {
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
}

module.exports = async function run() {
  const rep = L.makeReporter('score-entry-reachable');

  for (const [label, viewport] of VIEWPORTS) {
    await L.withPage(viewport, async (page, pageErrors) => {
      // From the app's own registry, so a new mode is covered the day it lands.
      // Dartless modes (the Maths Trainer) have no input surface by design and
      // are asserted for that shape by all-game-types instead.
      const types = await page.evaluate(() => Object.keys(GAME_TYPES)
        .filter(k => !GAME_TYPES[k].dispatchOnly && !GAME_TYPES[k].noDartInput)
        .map(k => ({ key: k, contexts: contextsForMode(k) })));

      rep.ok(`${label}: game types discovered`, types.length >= 10, `${types.length} types`);

      for (const { key, contexts } of types) {
        const mode = contexts.includes('practice') ? 'practice' : 'h2h';
        const names = Array.from({ length: mode === 'h2h' ? 2 : 1 },
          (_, i) => L.uniqueName(`SER_${key}_${i}`));

        const started = await startMode(page, key, mode, names);
        if (!started.ok) {
          // Five assertions are owed per mode whatever happens, or the count
          // check in run.js could not tell a broken start from a skipped one.
          for (const what of ['input surface has real height', 'input surface fits the screen',
            'turn controls stay on screen', 'nothing overflows sideways', 'a real tap records a dart']) {
            rep.ok(`${label} ${key}: ${what}`, false, `did not start: ${started.error}`);
          }
          continue;
        }
        await page.waitForTimeout(320);

        // The Pressure Chamber hides its pad behind a before-the-throw
        // self-declaration. Making the call is part of playing the mode, not a
        // workaround — without it there is deliberately nothing to tap.
        await page.evaluate(() => {
          if (game.gameType === 'pressure_chamber' && typeof declarePressureHit === 'function'
            && game.pressureDeclared == null) declarePressureHit(true);
        });
        await page.waitForTimeout(150);

        const layout = await page.evaluate(probeLayout);
        // 40px is roughly the smallest thing a finger hits reliably; the bug
        // this guards produced 0, so the exact threshold is not load-bearing.
        rep.ok(`${label} ${key}: input surface has real height`, layout.height > 40,
          `${layout.surfaceName} h=${layout.height}`);
        rep.ok(`${label} ${key}: input surface fits the screen`, layout.inViewport);
        rep.ok(`${label} ${key}: turn controls stay on screen`,
          layout.offscreenControls.length === 0, layout.offscreenControls.join(', '));
        rep.ok(`${label} ${key}: nothing overflows sideways`,
          !layout.pageOverflowsX && !layout.scoreboardOverflowsX,
          `page=${layout.pageOverflowsX} scoreboard=${layout.scoreboardOverflowsX}`);

        // The one assertion that could not be made from page.evaluate(): a real
        // pointer event at real coordinates, which lands on whatever is actually
        // on top at that point.
        const target = await page.evaluate(findTapTarget);
        if (!target) {
          rep.ok(`${label} ${key}: a real tap records a dart`, false, 'nothing tappable on the input surface');
        } else {
          const before = await page.evaluate(positionFingerprint);
          await page.mouse.click(target.x, target.y);
          await page.waitForTimeout(260);
          const after = await page.evaluate(positionFingerprint);
          rep.ok(`${label} ${key}: a real tap records a dart`, after !== before, `tapped ${target.label}`);
        }

        await rep.captureIfFailed(page, `${label}-${key}`);
        await page.evaluate(() => { try { game = null; } catch {} show('home'); });
        await page.waitForTimeout(150);
      }

      rep.ok(`${label}: no uncaught page errors`, pageErrors.length === 0, pageErrors.join('; '));
    });
  }

  /* The scrolled ladder still shows you the round you are on.
     Both modes are played to a late round through the app's own turn loop, then
     asked for the three things that have to be true at once. Read from the
     table's sticky head/foot inward, not from its outer box: a row flush with
     the top edge is a row underneath the header and just as unreadable. */
  await L.withPage({ width: 390, height: 844 }, async (page, pageErrors) => {
    const ladders = [
      { key: 'bobs_27', round: 18, roundField: 'bobs27Round' },
      { key: 'pressure_chamber', round: 13, roundField: 'pressureChamberRound' },
    ];

    for (const lad of ladders) {
      const names = [L.uniqueName(`LAD_${lad.key}`)];
      const started = await startMode(page, lad.key, 'practice', names);
      if (!started.ok) {
        for (const what of ['reaches a late round', 'current round stays in view',
          'round banner stays in view', 'input surface still tappable']) {
          rep.ok(`${lad.key}: ${what}`, false, `did not start: ${started.error}`);
        }
        continue;
      }
      await page.waitForTimeout(320);
      /* Played through the app's own turn loop. The per-mode visit is written
         out here rather than passed in as source text: a `new Function(...)`
         body runs in GLOBAL scope, and this app's `game`, `setMult` and
         `throwDart` are top-level `let`/`function` declarations that never
         reach `window` — so the clever version silently threw on every visit
         and the mode sat on round 1 (see SKILL.md, "Top-level `let` is not on
         `window`"). Bob's 27 hits its double every time so the run survives to
         a late round; The Pressure Chamber's score does not gate the round
         counter, so plain 20s are enough to advance it. */
      await page.evaluate(({ key, round, roundField }) => {
        let guard = 0;
        while (game && game[roundField] < round && guard++ < 200) {
          if (key === 'bobs_27') {
            for (let d = 0; d < 3; d++) { setMult(2); throwDart(game.bobs27Round); }
          } else {
            if (game.pressureDeclared == null) declarePressureHit(true);
            for (let d = 0; d < 3 && game.darts.length < 3; d++) { setMult(1); throwDart(20); }
          }
          enterTurn();
        }
      }, lad);
      await page.waitForTimeout(400);

      /* Read the round counter by NAME. `game.bobs27Round || game.pressureChamberRound`
         reads naturally and is wrong: startGame() initialises bobs27Round to 1
         on EVERY game object whatever the mode, so that expression reports
         round 1 for a Pressure Chamber game sitting on round 13. */
      const seen = await page.evaluate((roundField) => {
        const sb = document.getElementById('scoreboard');
        const table = sb.querySelector('.cs-table');
        if (!table) return null;
        const cell = table.querySelector('.cs-row:not(.cs-head):not(.cs-foot) .cs-cell.active');
        const row = cell && cell.closest('.cs-row');
        const t = table.getBoundingClientRect();
        const headH = table.querySelector('.cs-head').getBoundingClientRect().height;
        const footH = table.querySelector('.cs-foot').getBoundingClientRect().height;
        // The banner is whatever the mode appends after the table — a <p> for
        // Bob's 27, a role=status card for The Pressure Chamber.
        const banner = sb.querySelector('[role=status]') || [...sb.children].find(c => c.tagName === 'P');
        const s = sb.getBoundingClientRect();
        const b = banner && banner.getBoundingClientRect();
        const pad = document.getElementById('pad').getBoundingClientRect();
        const r = row && row.getBoundingClientRect();
        return {
          reached: game[roundField],
          rowVisible: !!r && r.top >= t.top + headH - 1 && r.bottom <= t.bottom - footH + 1,
          bannerVisible: !!b && b.top >= s.top - 1 && b.bottom <= s.bottom + 1 && b.bottom <= window.innerHeight + 1,
          padUsable: pad.height > 40 && pad.bottom <= window.innerHeight + 1,
        };
      }, lad.roundField);

      rep.ok(`${lad.key}: reaches a late round`, !!seen && seen.reached >= lad.round,
        seen ? `round ${seen.reached}` : 'no chalkboard rendered');
      rep.ok(`${lad.key}: current round stays in view`, !!seen && seen.rowVisible);
      rep.ok(`${lad.key}: round banner stays in view`, !!seen && seen.bannerVisible);
      rep.ok(`${lad.key}: input surface still tappable`, !!seen && seen.padUsable);

      await rep.captureIfFailed(page, `ladder-${lad.key}`);
      await page.evaluate(() => { try { game = null; } catch {} show('home'); });
      await page.waitForTimeout(150);
    }

    rep.ok('ladders: no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
  });

  return rep.finish();
};
