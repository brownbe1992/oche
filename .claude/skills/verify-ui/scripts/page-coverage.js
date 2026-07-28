/* Which of index.html's functions never execute, across a realistic sweep of the app.
 *
 *   node .claude/skills/verify-ui/scripts/page-coverage.js     # needs a server on 8146
 *
 * A REPORTING TOOL, not a check — it is not in run.js and nothing fails on its output.
 * `backend/check.js` answers "is this function referenced anywhere", which is a static
 * question and always says yes here; this answers "does it ever RUN", which is the one
 * that finds untested surface. It uses Chromium's own JS coverage.
 *
 * WHY IT EXISTS. The backend has a coverage number (99% line, from node --test) and
 * scoring.js has one too. index.html's ~580 functions had neither, so nobody could say
 * what fraction of the app's largest file any suite touched. The first run answered
 * that — and found the fourteen `renderHomeTabBody<Type>()` leaderboard renderers had
 * never executed in any check or test, which is what the `home-leaderboards` check now
 * covers.
 *
 * READ THE NUMBER CAREFULLY. It reports coverage of THIS script's sweep, which is
 * deliberately shallow — start each mode, throw three darts, commit, undo, visit each
 * screen. It never wins a leg, so `onLegWon*` and the completion panels show as
 * unexecuted here while being thoroughly covered by the real suite and by
 * backend/test/. Treat a name in the output as "worth checking whether anything covers
 * this", not as "this is dead".
 *
 * The first version of this file reported a confident "0 never executed" because it
 * asked whether each function's offset fell inside ANY covered range — and V8's
 * outermost range is the whole script, with a non-zero count. See the note by
 * `ranByStart` below. */
const path = require('path');
const L = require(path.join(process.cwd(), '.claude/skills/verify-ui/scripts/lib.js'));

function declaredFunctions(src) {
  // Top-level and nested `function name(` with their byte offset in the inline script.
  const out = [];
  const re = /(?:^|\n)(\s*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) out.push({ name: m[2], at: m.index + m[0].indexOf('function'), indent: m[1].length });
  return out;
}

(async () => {
  await L.waitForServer();
  const browser = await L.launchBrowser();
  const ctx = await browser.newContext({ viewport: L.PORTRAIT });
  const page = await ctx.newPage();
  await page.coverage.startJSCoverage();
  await page.goto(`${L.BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof startGame === 'function' && typeof DB !== 'undefined', { timeout: 30000 });
  await page.waitForTimeout(600);

  // Drive every registered game type through a real short session.
  const types = await page.evaluate(() => Object.keys(GAME_TYPES).filter(k => !GAME_TYPES[k].dispatchOnly));
  for (const key of types) {
    await page.evaluate(async (k) => {
      try {
        const ctxs = contextsForMode(k);
        const mode = ctxs.includes('practice') ? 'practice' : ctxs[0];
        const seats = ctxs.includes('practice') ? 1 : 2;
        const names = Array.from({ length: seats }, (_, i) => `COV_${k}_${i}_${Date.now()}`);
        for (const n of names) await DB.addPlayer(n);
        roster.push(...names);
        setMode(mode); setup.gameType = k; setup.slots = names;
        await startGame();
      } catch (e) { /* a mode that refuses is itself information; keep sweeping */ }
    }, key);
    await page.waitForTimeout(320);
    // A few real darts, a commit, an undo.
    await page.evaluate(() => {
      try { setMult(1); throwDart(20); setMult(1); throwDart(19); setMult(1); throwDart(18); } catch {}
      try { enterTurn(); } catch {}
    });
    await page.waitForTimeout(260);
    await page.evaluate(() => { try { undoLastTurn(); } catch {} });
    await page.waitForTimeout(200);
    await page.evaluate(() => { try { game = null; show('home'); } catch {} });
    await page.waitForTimeout(120);
  }

  // Visit every screen the nav can reach.
  for (const screen of ['home', 'setup', 'players', 'settings', 'stats', 'history']) {
    await page.evaluate((s) => { try { show(s); } catch {} }, screen);
    await page.waitForTimeout(260);
  }

  const cov = await page.coverage.stopJSCoverage();
  await ctx.close(); await browser.close();

  const entry = cov.find(c => c.url.endsWith('/') || c.url.includes('index.html'));
  if (!entry) { console.error('no coverage entry for the page'); process.exit(2); }
  const src = entry.source;

  /* V8 reports one entry per function, whose ranges[0] IS that function's own range and
   * carries its own execution count. The outermost entry covers the whole script with a
   * non-zero count, so asking "is this offset inside any covered range" answers "yes"
   * for everything — which is exactly the wrong answer, and the first version of this
   * probe reported a confident "0 never executed" because of it. */
  const ranByStart = new Map();
  for (const f of entry.functions) {
    const own = f.ranges[0];
    if (!own) continue;
    ranByStart.set(own.startOffset, (ranByStart.get(own.startOffset) || 0) + own.count);
  }

  const fns = declaredFunctions(src);
  const never = fns.filter(f => (ranByStart.get(f.at) || 0) === 0);
  const unknown = fns.filter(f => !ranByStart.has(f.at));
  console.log(`page functions declared: ${fns.length}`);
  console.log(`matched to a V8 range:   ${fns.length - unknown.length}`);
  console.log(`never executed:          ${never.length - unknown.length}`);
  console.log('---');
  for (const f of never) if (ranByStart.has(f.at)) console.log(f.name);
})().catch(e => { console.error(e); process.exit(1); });
