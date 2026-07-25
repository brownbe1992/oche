'use strict';
/* Results takeover — what happens to the screen when a leg/game/session ends.
 *
 * This is the check that would have caught the worst regression found so far:
 * a redesign moved #scoreboard inside the container the takeover replaced
 * wholesale, so finishUnit()'s "X wins the leg" banner was built and destroyed
 * in the same tick and the match state vanished from the summary screen. The
 * bug was invisible to anything that only asked "did the results card appear?"
 * — it did. What broke was everything that was supposed to survive alongside it.
 */
const L = require('../lib');

async function inOrientation(rep, viewport, label) {
  await L.withPage(viewport, async (page, pageErrors) => {
    const names = [L.uniqueName(`${label}A`), L.uniqueName(`${label}B`)];
    await L.startX01(page, { names });

    const inPlay = await page.evaluate(() => ({
      scoreboardRows: document.querySelectorAll('#scoreboard .pscore').length,
      railPlayShown: getComputedStyle(document.getElementById('rail-play')).display !== 'none',
      ocheShown: getComputedStyle(document.querySelector('.oche')).display !== 'none',
      resultHidden: document.getElementById('game-result').hidden,
    }));
    rep.ok(`${label}: in play — both players on the scoreboard`, inPlay.scoreboardRows === 2, `rows=${inPlay.scoreboardRows}`);
    rep.ok(`${label}: in play — play controls and board visible`, inPlay.railPlayShown && inPlay.ocheShown);
    rep.ok(`${label}: in play — results host hidden`, inPlay.resultHidden === true);

    await L.winLeg(page);

    // Computed style, not the `hidden` attribute. An author `display` rule
    // outranks the UA stylesheet's [hidden]{display:none}, so an element can
    // carry hidden and still be fully on screen — exactly how a "hidden"
    // dartboard stayed visible behind a results card once.
    const done = await page.evaluate(() => {
      const sb = document.getElementById('scoreboard');
      const rp = document.getElementById('rail-play');
      const oche = document.querySelector('.oche');
      const res = document.getElementById('game-result');
      return {
        scoreboardExists: !!sb,
        scoreboardRows: sb ? sb.querySelectorAll('.pscore').length : 0,
        bannerVisible: !!(sb && /wins the/.test(sb.textContent)),
        railPlayDisplay: rp ? getComputedStyle(rp).display : 'missing',
        ocheDisplay: oche ? getComputedStyle(oche).display : 'missing',
        resultShown: res ? !res.hidden : false,
        resultHasCard: !!(res && /LEG COMPLETE|GAME OVER|wins the/i.test(res.textContent)),
      };
    });
    rep.ok(`${label}: scoreboard survives the takeover`, done.scoreboardExists && done.scoreboardRows >= 2,
      `rows=${done.scoreboardRows}`);
    rep.ok(`${label}: winner banner is actually rendered`, done.bannerVisible);
    rep.ok(`${label}: play controls hidden (computed)`, done.railPlayDisplay === 'none', `display=${done.railPlayDisplay}`);
    rep.ok(`${label}: board hidden (computed)`, done.ocheDisplay === 'none', `display=${done.ocheDisplay}`);
    rep.ok(`${label}: results card shown`, done.resultShown && done.resultHasCard);

    // The takeover has to be reversible — a leg-over screen that doesn't fully
    // reset leaks into the next leg.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /next leg/i.test(x.textContent));
      if (b) b.click();
    });
    await page.waitForTimeout(900);

    const next = await page.evaluate(() => {
      const rp = document.getElementById('rail-play');
      const res = document.getElementById('game-result');
      return {
        railPlayShown: rp ? getComputedStyle(rp).display !== 'none' : false,
        ocheShown: getComputedStyle(document.querySelector('.oche')).display !== 'none',
        resultHidden: res ? res.hidden : false,
        resultEmpty: res ? res.innerHTML.trim() === '' : false,
        bannerGone: !/wins the/.test(document.getElementById('scoreboard').textContent),
        enterUsable: !!(document.getElementById('enter-btn') && document.getElementById('enter-btn').offsetParent !== null),
      };
    });
    rep.ok(`${label}: next leg restores play controls`, next.railPlayShown && next.ocheShown && next.enterUsable);
    rep.ok(`${label}: next leg clears the results host`, next.resultHidden && next.resultEmpty);
    rep.ok(`${label}: next leg clears the winner banner`, next.bannerGone);

    rep.ok(`${label}: no uncaught page errors`, pageErrors.length === 0, pageErrors.join('; '));
  });
}

// A results card taller than the space left for it must be scrollable. The
// screen sets overflow:hidden while a game is active, so anything that overflows
// is not merely clipped — it is unreachable. This bit ordinarily only in
// combination: the card is fine at a normal window size, and only a short
// viewport reveals that no scroll container ever formed.
async function scrollContainer(rep, viewport, label) {
  await L.withPage(viewport, async (page) => {
    const names = [L.uniqueName(`${label}A`), L.uniqueName(`${label}B`)];
    await L.startX01(page, { names });
    await L.winLeg(page);
    await page.waitForTimeout(1500);

    const m = await page.evaluate(() => {
      const res = document.getElementById('game-result');
      // Walk up looking for an ancestor that can actually scroll the overflow.
      let el = res, scrollable = null;
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) {
          scrollable = el.id || el.className || el.tagName; break;
        }
        el = el.parentElement;
      }
      const card = res.firstElementChild;
      return {
        overflows: card ? card.getBoundingClientRect().bottom > window.innerHeight : false,
        scrollable,
      };
    });
    // If it doesn't overflow at this size there is nothing to prove; only assert
    // the reachability property when the content genuinely exceeds the viewport.
    if (!m.overflows) {
      rep.ok(`${label}: results card fits without overflowing`, true);
    } else {
      rep.ok(`${label}: overflowing results card is scrollable`, !!m.scrollable,
        m.scrollable ? `scrolls in ${m.scrollable}` : 'NO scrollable ancestor — content unreachable');
    }
  });
}

// A whole-session summary should not leave the last (possibly unfinished) leg's
// live scoreboard sitting above it — unlike a per-leg finish, where keeping the
// scoreboard is the point.
async function wholeSessionClearsScoreboard(rep) {
  await L.withPage(L.PORTRAIT, async (page) => {
    await L.startX01(page, { names: [L.uniqueName('MarSB')], mode: 'practice' });
    await page.evaluate(() => { setMult(1); throwDart(20); enterTurn(); });
    await page.waitForTimeout(500);

    const before = await page.evaluate(() =>
      document.querySelectorAll('#scoreboard .pscore').length);

    const after = await page.evaluate(() => {
      renderMarathonAnalysisScreen({
        legs: [
          { legOrder: 1, dartCount: 21, completedAt: '2026-01-01T10:00:00Z' },
          { legOrder: 2, dartCount: 24, completedAt: '2026-01-01T10:08:00Z' },
        ],
        durationMinutes: 45,
      }, false);
      const res = document.getElementById('game-result');
      return {
        scoreboardRows: document.querySelectorAll('#scoreboard .pscore').length,
        hasSummary: !!(res && /MARATHON COMPLETE/i.test(res.textContent)),
      };
    });
    rep.ok('marathon summary: had a live scoreboard beforehand', before > 0, `rows=${before}`);
    rep.ok('marathon summary: clears the stale scoreboard', after.scoreboardRows === 0, `rows=${after.scoreboardRows}`);
    rep.ok('marathon summary: shows the session card', after.hasSummary);
  });
}

module.exports = async function run() {
  const rep = L.makeReporter('results-takeover');
  await inOrientation(rep, L.PORTRAIT, 'portrait');
  await inOrientation(rep, L.LANDSCAPE, 'landscape');
  await scrollContainer(rep, L.PORTRAIT_SHORT, 'portrait-short');
  await scrollContainer(rep, L.LANDSCAPE_SHORT, 'landscape-short');
  await wholeSessionClearsScoreboard(rep);
  return rep.finish();
};
