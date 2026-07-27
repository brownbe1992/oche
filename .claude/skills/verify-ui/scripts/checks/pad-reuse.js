'use strict';
/* The dart pads are built once and toggled, not rebuilt on every throw.
 *
 * docs/code-quality-roadmap.md item 57b established the pattern for the default
 * 1-20+Bull pad; item 67 extends it to the three that still tore themselves down
 * per dart — Cricket's seven-target grid, the shared single-target pad
 * (Baseball/Shanghai/Halve-It/Bob's 27) and The Pressure Chamber's full grid.
 *
 * The reason this needs a browser check rather than a unit test is that both
 * halves of the property are live-DOM facts, and they pull against each other:
 *
 *   - REUSE. The buttons must be the same nodes after a dart as before it. A
 *     `pad.innerHTML = ''` at the top of the renderer is invisible to any test
 *     that only reads the rendered result, because the rebuilt pad looks
 *     identical — that is exactly why the per-dart rebuild survived this long.
 *   - FRESHNESS. Everything that legitimately changes per dart must still
 *     change. Cricket's marks glyph and closed state are the whole risk here:
 *     the naive way to stop rebuilding is to skip the render, which freezes the
 *     scoreboard on the pad while the real marks move underneath.
 *
 * A check that asserted only reuse would pass on a pad that never updates. A
 * check that asserted only freshness is what the suite already had. Both, per
 * mode, is the contract.
 */
const L = require('../lib');

// Stamp every button with an identity marker, then look for the same markers
// later. Node identity cannot cross the page/driver boundary; a stamped
// attribute survives exactly as long as the node does.
const STAMP = `(() => {
  const pad = document.getElementById('pad');
  if (!pad) return { n: 0 };
  const btns = [...pad.querySelectorAll('button')];
  btns.forEach((b, i) => { b.dataset.padStamp = 'S' + i; });
  return { n: btns.length, key: pad.dataset.padKey || '' };
})()`;

const READ = `(() => {
  const pad = document.getElementById('pad');
  if (!pad) return { n: 0, stamped: 0 };
  const btns = [...pad.querySelectorAll('button')];
  return {
    n: btns.length,
    stamped: btns.filter(b => b.dataset.padStamp).length,
    key: pad.dataset.padKey || '',
    disabled: btns.filter(b => b.disabled).length,
    marks: [...pad.querySelectorAll('.ct-marks')].map(e => e.textContent).join('|'),
  };
})()`;

module.exports = async function run() {
  const rep = L.makeReporter('pad-reuse');

  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    // Every mode with a dedicated pad renderer, plus X01 for the default pad
    // item 57b already fixed — read from the app rather than listed here, so a
    // mode that gains its own pad renderer is covered without an edit.
    const types = await page.evaluate(() =>
      [...new Set(['x01', ...Object.keys(MODE_PAD_RENDERERS)])]
        .filter(k => GAME_TYPES[k] && !GAME_TYPES[k].dispatchOnly)
        .map(k => ({ key: k, contexts: contextsForMode(k) })));

    rep.ok('registry: pad-owning game types discovered', types.length >= 6, `${types.length} types`);

    for (const { key, contexts } of types) {
      const mode = contexts.includes('practice') ? 'practice' : 'h2h';
      const seats = mode === 'h2h' ? 2 : 1;
      const names = Array.from({ length: seats }, (_, i) => L.uniqueName(`PR_${key}_${i}`));

      const started = await page.evaluate(async (o) => {
        try {
          for (const n of o.names) await DB.addPlayer(n);
          roster.push(...o.names);
          setMode(o.mode);
          setup.gameType = o.key;
          setup.slots = o.names;
          await startGame();
          return { ok: true };
        } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
      }, { key, mode, names });

      if (!started.ok) { rep.ok(`${key}: starts`, false, started.error); continue; }
      await page.waitForTimeout(300);

      // The Pressure Chamber opens on its declare screen, not a dart pad — make
      // the call first so the rest of this runs against the same grid every
      // other mode presents. Detected, not hardcoded: any mode that grows a
      // pre-throw gate is handled the same way.
      const gated = await page.evaluate(() => {
        const pad = document.getElementById('pad');
        const declare = pad && pad.dataset.padKey === 'pc-declare';
        if (declare) { declarePressureHit(true); return true; }
        return false;
      });
      if (gated) await page.waitForTimeout(150);

      const before = await page.evaluate(STAMP);
      if (!before.n) {
        // X01 (and any other mode) defaults to the dartboard SVG rather than a
        // button pad when board input is on — a different surface, already built
        // once by item 57b's own `if(!board.querySelector('svg'))` guard.
        const board = await page.evaluate(() => !!document.querySelector('#dart-board-wrap svg'));
        rep.ok(`${key}: presents a build-once input surface`, board,
          board ? 'dartboard SVG, built once' : 'neither a button pad nor a dartboard');
        continue;
      }

      // One real dart. Sector 20 is on every mode's board, and whether it scores
      // or misses is irrelevant here — the render runs either way.
      await page.evaluate(() => { setMult(1); throwDart(20); });
      await page.waitForTimeout(150);
      const after = await page.evaluate(READ);

      rep.ok(`${key}: a dart does not rebuild the pad`,
        after.stamped === after.n && after.n === before.n,
        after.stamped === after.n
          ? `${after.n} buttons vs ${before.n} before`
          : `${after.n - after.stamped} of ${after.n} buttons were replaced — the renderer is still tearing the pad down per dart`);

      rep.ok(`${key}: the pad's build key survives the dart`, after.key === before.key,
        `${before.key} -> ${after.key}`);
    }

    // The freshness half, on the one mode whose pad content genuinely moves per
    // dart. Cricket's marks glyph is what a "stop re-rendering" fix breaks, and
    // nothing else in the suite reads it off the pad.
    const cricket = await page.evaluate(async () => {
      try {
        const names = ['PR_Cricket_' + Math.floor(performance.now())];
        for (const n of names) await DB.addPlayer(n);
        roster.push(...names);
        setMode('practice');
        setup.gameType = 'cricket';
        setup.slots = names;
        await startGame();
        await new Promise(r => setTimeout(r, 300));
        const read = () => {
          const pad = document.getElementById('pad');
          return {
            marks: [...pad.querySelectorAll('.ct-marks')].map(e => e.textContent).join('|'),
            closed: pad.querySelectorAll('.cricket-target.closed').length,
            aria: [...pad.querySelectorAll('.cricket-target')].map(e => e.getAttribute('aria-label')).join('|'),
          };
        };
        const start = read();
        // Three trebles on 20 closes it outright: marks 0 -> 3, and the button
        // picks up its closed state. Both are per-render writes onto a reused node.
        // Cricket scores per VISIT, not per dart, so the marks only move once the
        // visit is committed — the staged-darts state is read first, since that is
        // where the pad must be locked.
        for (let i = 0; i < 3; i++) { setMult(3); throwDart(20); await new Promise(r => setTimeout(r, 60)); }
        const pad = document.getElementById('pad');
        const btns = [...pad.querySelectorAll('button')];
        const filled = { disabled: btns.filter(b => b.disabled).length, total: btns.length };
        enterTurn();
        await new Promise(r => setTimeout(r, 200));
        return { ok: true, start, filled, mid: read() };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });

    if (!cricket.ok) {
      rep.ok('cricket: marks stay live on a reused pad', false, cricket.error);
    } else {
      rep.ok('cricket: the marks glyph moves as marks are scored',
        cricket.mid.marks !== cricket.start.marks,
        cricket.mid.marks === cricket.start.marks
          ? `frozen at ${cricket.start.marks} — the pad is being reused but never updated`
          : `${cricket.start.marks} -> ${cricket.mid.marks}`);
      rep.ok('cricket: a closed number picks up its closed state',
        cricket.mid.closed > cricket.start.closed,
        `${cricket.start.closed} -> ${cricket.mid.closed} closed`);
      rep.ok("cricket: the buttons' screen-reader labels track the marks too",
        cricket.mid.aria !== cricket.start.aria,
        'aria-label is written per render, not only at build time');
    }

      // The disabled sweep: a full visit must still lock the pad, on a pad whose
      // buttons were built three darts ago rather than this frame.
      const f = cricket.filled;
      rep.ok('cricket: a filled visit disables every button on the reused pad',
        f.total > 0 && f.disabled === f.total, `${f.disabled}/${f.total} disabled`);

    await page.evaluate(() => { try { game = null; } catch {} show('home'); });

    rep.ok('pad-reuse: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
