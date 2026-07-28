'use strict';
/* The app is operable, and visible, from a keyboard.
 *
 * `docs/accessibility-roadmap.md` closed its five original gaps without ever auditing
 * keyboard/focus order as its own pass, even though CLAUDE.md names it a standing
 * concern. A 2026-07 audit drove the real app with real Tab presses and measured four
 * defects. Three are fixed and asserted here; the fourth is a documented limitation
 * whose escape hatch is asserted instead.
 *
 *   1. NO VISIBLE FOCUS RING. Tabbing through a live game landed on `.btn` controls
 *      whose ring was the browser default — computed `outline: auto 1px rgb(16,16,16)`,
 *      near-black on a #0e0f0d board. Drawn, and invisible. Individual `:focus` rules
 *      existed for text inputs and a few scoped areas, so the gap was every button.
 *   2. MODALS HAD NONE OF THE DIALOG CONTRACT. Focus never moved into the modal, Tab
 *      walked straight out into the page behind it, and Escape did nothing. A confirm
 *      dialog you cannot reach, stay inside, or dismiss is an invisible question the
 *      page is silently waiting on.
 *   3. FOCUS WAS NOT RESTORED on close, so the next Tab restarted from the top of the
 *      document — 222 stops away on the profile.
 *   4. THE DEFAULT SCORING INPUT IS NOT KEYBOARD-OPERABLE. `getDefaultScoringInput()`
 *      returns 'board' when unset, and the dartboard is 120 SVG segments with zero
 *      focusable elements — so in a default install, scoring cannot be done from a
 *      keyboard at all. Making the board itself keyboard-driven is a feature (roving
 *      focus over 120 segments with a sensible order), not a fix, so what is asserted
 *      here is that the ESCAPE HATCH genuinely works: the Pad toggle is reachable by
 *      keyboard, and some input mode really is fully operable. If that ever stops being
 *      true, the app has no keyboard scoring path at all and this check fails.
 *
 *      Note that the assertion names no MODE. Today the pad is the keyboard path and the
 *      board is not, but that is the current state of a known gap, not a rule — pinning
 *      it would mean this check fails on the day someone closes the gap.
 *
 * Every assertion drives real `page.keyboard.press()` — `:focus-visible` deliberately
 * does not match a programmatic `.focus()` call, so a check that used `el.focus()`
 * would report a passing focus ring that no keyboard user ever sees. That mistake was
 * made while writing the audit and is the reason this note exists.
 */
const L = require('../lib');

const DESC = `(el)=>{ if(!el||el===document.body) return 'BODY';
  const id=el.id?'#'+el.id:'';
  const c=el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/)[0]:'';
  return el.tagName.toLowerCase()+id+c; }`;

module.exports = async function run() {
  const rep = L.makeReporter('keyboard');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const name = L.uniqueName('KBD');
    const ok = await page.evaluate(async (n) => {
      try {
        await DB.addPlayer(n); roster.push(n);
        setMode('practice'); setup.gameType = 'x01'; setup.slots = [n];
        await startGame();
        return true;
      } catch (e) { return String(e && e.message || e); }
    }, name);
    if (ok !== true) { rep.ok('keyboard: fixture game starts', false, ok); return; }
    await page.waitForTimeout(700);

    // --- 1. A real Tab produces a ring that is actually visible.
    await page.evaluate(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); });
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(`(() => {
      const el = document.activeElement, cs = getComputedStyle(el);
      // Parse the outline colour so "is it visible against the background" is a real
      // question, not a string comparison. A near-black ring on a near-black board is
      // exactly what this check exists to catch.
      const rgb = (cs.outlineColor.match(/\\d+/g) || []).map(Number);
      const lum = rgb.length >= 3 ? (0.2126*rgb[0] + 0.7152*rgb[1] + 0.0722*rgb[2]) / 255 : null;
      return { on: (${DESC})(el), style: cs.outlineStyle, width: cs.outlineWidth,
               color: cs.outlineColor, luminance: lum };
    })()`);
    rep.ok('keyboard: tabbing lands on a real control', ring.on !== 'BODY', ring.on);
    rep.ok('keyboard: the focused control draws an outline',
      ring.style !== 'none' && parseFloat(ring.width) >= 2, `${ring.style} ${ring.width}`);
    rep.ok('keyboard: the focus ring is light enough to see on the dark board',
      ring.luminance != null && ring.luminance > 0.35,
      `${ring.color} (relative luminance ${ring.luminance == null ? '?' : ring.luminance.toFixed(2)})`);

    // --- 4. Pad mode is the keyboard-operable scoring path, and it is reachable.
    const modes = {};
    for (const m of ['board', 'pad']) {
      await page.evaluate((mm) => { dartboardMode = (mm === 'board'); applyDartMode(); }, m);
      await page.waitForTimeout(350);
      modes[m] = await page.evaluate(`(() => {
        const vis = el => el.offsetParent !== null;
        const inter = [...document.querySelectorAll('button,[tabindex]:not([tabindex="-1"])')].filter(vis);
        const scoring = inter.filter(e => /^(\\d+|Bull|Miss|Double|Treble)/i.test((e.textContent||'').trim()));
        return { interactive: inter.length, scoring: scoring.length };
      })()`);
    }
    // ONE assertion, and it is mode-agnostic on purpose: *somewhere* in the app, a
    // player can score a dart from a keyboard.
    //
    // The first version of this asserted two separate things — that Pad mode exposes the
    // buttons, and that board mode exposes none. The second of those pins a LIMITATION
    // rather than a behaviour, which makes it the one assertion in this suite that goes
    // red when the app gets BETTER: make the dartboard keyboard-operable (defect 4 in the
    // header, a genuine feature) and it fails with "20 scoring buttons in board mode",
    // which is indistinguishable from a regression. The instinctive response to a
    // regression is to undo whatever caused it.
    //
    // Softening the failure message was the first attempt and it was the wrong fix: it
    // left the trap in place and papered a warning over it. Asserting the invariant
    // instead removes the trap — this passes whether the keyboard path is the pad, the
    // board, or both, and fails only if the app has no keyboard scoring path at all,
    // which is the thing actually worth guarding.
    const bestPath = Math.max(modes.pad.scoring, modes.board.scoring);
    rep.ok('keyboard: some input mode offers a full keyboard-operable scoring path',
      bestPath >= 20, `pad=${modes.pad.scoring} board=${modes.board.scoring} scoring controls`);
    const toggle = await page.evaluate(`(() => {
      const p = document.getElementById('imt-pad'), b = document.getElementById('imt-board');
      return { padReachable: !!p && p.offsetParent !== null && p.tabIndex >= 0,
               padLabelled: !!(p && p.getAttribute('aria-label')),
               boardLabelled: !!(b && b.getAttribute('aria-label')),
               wrapLabelled: !!(document.getElementById('dart-board-wrap') || {}).getAttribute?.('aria-label') };
    })()`);
    rep.ok('keyboard: the Pad toggle is itself reachable by keyboard — the escape hatch',
      toggle.padReachable, JSON.stringify(toggle));
    rep.ok('keyboard: both input toggles say what they are', toggle.padLabelled && toggle.boardLabelled,
      JSON.stringify(toggle));
    rep.ok('keyboard: the dartboard tells a screen reader it needs a pointer', toggle.wrapLabelled,
      String(toggle.wrapLabelled));

    // --- 2/3. The dialog contract, driven by real keys.
    await page.evaluate(() => { dartboardMode = false; applyDartMode(); });
    await page.waitForTimeout(200);
    // Focus a known control first, so "restored to where it came from" is checkable.
    await page.evaluate(() => { const b = document.getElementById('enter-btn'); if (b) b.focus(); });
    const opener = await page.evaluate(`(${DESC})(document.activeElement)`);
    await page.evaluate(() => uiConfirm('Keyboard check — focus contract', () => {}));
    await page.waitForTimeout(150);

    const entered = await page.evaluate(`(() => {
      const m = document.getElementById('modal');
      return { open: !!m && !m.hidden, inside: m ? m.contains(document.activeElement) : null,
               role: m ? m.getAttribute('role') : null, ariaModal: m ? m.getAttribute('aria-modal') : null,
               where: (${DESC})(document.activeElement) };
    })()`);
    rep.ok('modal: opening one moves focus into it', entered.open && entered.inside === true, JSON.stringify(entered));
    rep.ok('modal: it identifies itself as a dialog',
      entered.role === 'dialog' && entered.ariaModal === 'true', `role=${entered.role} aria-modal=${entered.ariaModal}`);

    // Tab all the way round — focus must never leave the dialog.
    let escaped = null;
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(`(() => { const m = document.getElementById('modal');
        return m && !m.hidden ? m.contains(document.activeElement) : null; })()`);
      if (inside === false) { escaped = i + 1; break; }
    }
    rep.ok('modal: Tab is trapped inside it', escaped === null,
      escaped === null ? 'stayed inside for 6 presses' : `focus escaped on press ${escaped}`);

    // Shift+Tab wraps the other way too.
    await page.keyboard.press('Shift+Tab');
    const back = await page.evaluate(`(() => { const m = document.getElementById('modal');
      return m && !m.hidden ? m.contains(document.activeElement) : null; })()`);
    rep.ok('modal: Shift+Tab is trapped too', back === true, String(back));

    // Escape closes, and focus goes back where it started.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const closed = await page.evaluate(`(() => {
      const m = document.getElementById('modal');
      return { hidden: !m || m.hidden, focus: (${DESC})(document.activeElement) };
    })()`);
    rep.ok('modal: Escape closes it', closed.hidden, String(closed.hidden));
    rep.ok('modal: focus returns to whatever opened it', closed.focus === opener,
      `opened from ${opener}, returned to ${closed.focus}`);

    rep.ok('keyboard: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
