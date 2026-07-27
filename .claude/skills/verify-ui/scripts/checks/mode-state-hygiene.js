'use strict';
/* Per-leg and per-undo state that no backend query can see.
 *
 * A second-pass audit of all 16 game modes found four defects that live entirely
 * in the client's own game object, so `backend/test/` has no surface to assert
 * against — every one of them is invisible in the recorded turns and only shows
 * up in which badge fires (or fails to fire) next. Hence this file.
 *
 * The four:
 *
 *   1. PER-LEG BADGE STATE THAT NEVER RESET. Metronome, Cruise Control and Ice in
 *      the Veins are scoped to one leg, via `legVisitScores` / `metronomeFired` /
 *      `pendingIceInTheVeins`. X01 cleared them at its leg boundary; 121 Checkout
 *      Ladder and Dead Man Walking both started calling awardVisitAchievements()
 *      later and never did — but a ladder rung and a Dead Man Walking round each
 *      ARE a leg (both advance game.legNo). So the three badges were judged
 *      against the whole run: Metronome could fire on five visits spanning three
 *      rungs, Cruise Control was unreachable after one sub-40 visit anywhere, and
 *      a bust ending one round armed Ice in the Veins for the next one's first
 *      visit.
 *   2/3. SESSION MILESTONE COUNTERS THAT SURVIVED UNDO. Baseball's `sessionRuns`
 *      and Doubles Practice's `sessionHits` both feed a lifetime milestone ladder
 *      as base + session, and neither was in its mode's undo snapshot — so an
 *      undone visit's runs stayed counted and a lifetime tier could fire early.
 *   4. KILLER'S FIRST BLOOD LATCH. `game.killerFirstBloodAwarded` is a
 *      match-lifetime latch, and undo did not restore it: undoing the dart that
 *      drew first blood left the latch stuck, so whoever actually drew it next
 *      could never earn the badge.
 *
 * Every case drives the real dispatchers (startGame/throwDart/enterTurn/
 * undoLastTurn) and reads the live `game` back, rather than calling the internal
 * helper directly — the bug in each case was a MISSING call, which a test that
 * calls the helper itself would never catch.
 */
const L = require('../lib');

module.exports = async function run() {
  const rep = L.makeReporter('mode-state-hygiene');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {

    // --- 1a. 121 Checkout Ladder: a rung boundary clears the per-leg state.
    const ladder = await page.evaluate(async () => {
      try {
        const n = 'MSH_CL_' + Date.now();
        await DB.addPlayer(n); roster.push(n);
        setMode('practice'); setup.gameType = 'checkout_ladder'; setup.slots = [n];
        await startGame(); await new Promise(r => setTimeout(r, 400));
        const p = game.players[0];
        // A deliberately tiny visit first: it is the marker. If it is still in
        // legVisitScores after the rung is cleared, the state carried over —
        // and Cruise Control would be dead for the rest of the session.
        setMult(1); throwDart(1); setMult(1); throwDart(1); setMult(1); throwDart(1);
        enterTurn(); await new Promise(r => setTimeout(r, 120));
        const marker = p.legVisitScores.slice();
        const rung1 = game.legNo;
        let guard = 0;
        while (game.legNo === rung1 && guard++ < 12) {
          const before = p.score;
          setMult(before > 60 ? 3 : 1); throwDart(20);
          setMult(1); throwDart(20);
          if (p.score > 40) { setMult(1); throwDart(20); }
          enterTurn(); await new Promise(r => setTimeout(r, 130));
          if (p.score === before && game.legNo === rung1) break;
        }
        await new Promise(r => setTimeout(r, 500));
        return { ok: true, marker, rung1, rungNow: game.legNo,
          carried: p.legVisitScores.slice(), metronomeFired: p.metronomeFired };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
    if (!ladder.ok || ladder.rungNow === ladder.rung1) {
      rep.ok('ladder: the fixture reached a second rung', false,
        ladder.error || `still on rung ${ladder.rung1}`);
    } else {
      rep.ok('ladder: a rung boundary clears the per-leg badge state',
        !ladder.carried.some(v => v === ladder.marker[0]) && ladder.carried.length < 3,
        `rung ${ladder.rungNow}, carried ${JSON.stringify(ladder.carried)} (marker ${JSON.stringify(ladder.marker)})`);
      rep.ok('ladder: metronomeFired does not carry across a rung', !ladder.metronomeFired,
        String(ladder.metronomeFired));
    }
    await page.evaluate(() => { game = null; show('home'); });

    // --- 1b. Dead Man Walking: a round boundary clears the same state.
    const dmw = await page.evaluate(async () => {
      try {
        const n = 'MSH_DMW_' + Date.now();
        await DB.addPlayer(n); roster.push(n);
        setMode('practice'); setup.gameType = 'dead_man_walking'; setup.slots = [n];
        await startGame(); await new Promise(r => setTimeout(r, 800));
        const p = game.players[0];
        const round1 = game.legNo;
        // Miss everything: the round ends on darts, which is a bust-shaped end —
        // so this also arms pendingIceInTheVeins, the field most likely to leak.
        let guard = 0;
        while (game.legNo === round1 && guard++ < 8) {
          setMult(1); throwDart(0); setMult(1); throwDart(0); setMult(1); throwDart(0);
          enterTurn(); await new Promise(r => setTimeout(r, 200));
        }
        await new Promise(r => setTimeout(r, 500));
        return { ok: true, round1, roundNow: game.legNo,
          carried: p.legVisitScores.length, pendingIce: p.pendingIceInTheVeins,
          metronomeFired: p.metronomeFired };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
    if (!dmw.ok || dmw.roundNow === dmw.round1) {
      rep.ok('dead man walking: the fixture reached a second round', false,
        dmw.error || `still on round ${dmw.round1}`);
    } else {
      rep.ok('dead man walking: a round boundary clears the per-leg badge state',
        dmw.carried === 0 && !dmw.metronomeFired,
        `${dmw.carried} visits carried into round ${dmw.roundNow}`);
      rep.ok('dead man walking: a round that ended on a bust does not arm Ice in the Veins for the next round',
        dmw.pendingIce === false, String(dmw.pendingIce));
    }
    await page.evaluate(() => { game = null; show('home'); });

    // --- 2. Baseball: undo restores sessionRuns.
    const bb = await page.evaluate(async () => {
      try {
        const n = 'MSH_BB_' + Date.now();
        await DB.addPlayer(n); roster.push(n);
        setMode('practice'); setup.gameType = 'baseball'; setup.slots = [n];
        await startGame(); await new Promise(r => setTimeout(r, 400));
        const p = game.players[0];
        const before = p.sessionRuns || 0;
        setMult(3); throwDart(1); setMult(3); throwDart(1); setMult(3); throwDart(1);
        enterTurn(); await new Promise(r => setTimeout(r, 180));
        const after = p.sessionRuns;
        undoLastTurn(); await new Promise(r => setTimeout(r, 250));
        return { ok: true, before, after, undone: p.sessionRuns };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
    rep.ok('baseball: the visit actually scored runs to undo', bb.ok && bb.after > bb.before,
      bb.error || `${bb.before} -> ${bb.after}`);
    rep.ok('baseball: undo restores the session runs counter that feeds the lifetime ladder',
      bb.ok && bb.undone === bb.before, `${bb.after} -> ${bb.undone}, expected ${bb.before}`);
    await page.evaluate(() => { game = null; show('home'); });

    // --- 3. Doubles Practice: undo restores sessionHits.
    const dp = await page.evaluate(async () => {
      try {
        const n = 'MSH_DP_' + Date.now();
        await DB.addPlayer(n); roster.push(n);
        setMode('practice'); setup.gameType = 'doubles_practice';
        setup.doublesTargets = [20]; setup.slots = [n];
        await startGame(); await new Promise(r => setTimeout(r, 400));
        const p = game.players[0];
        const before = p.sessionHits || 0;
        setMult(2); throwDart(20);
        await new Promise(r => setTimeout(r, 220));
        const after = p.sessionHits;
        undoLastTurn(); await new Promise(r => setTimeout(r, 280));
        return { ok: true, before, after, undone: p.sessionHits };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
    rep.ok('doubles practice: the dart actually hit its target', dp.ok && dp.after > dp.before,
      dp.error || `${dp.before} -> ${dp.after}`);
    rep.ok('doubles practice: undo restores the session hits counter that feeds the lifetime ladder',
      dp.ok && dp.undone === dp.before, `${dp.after} -> ${dp.undone}, expected ${dp.before}`);
    await page.evaluate(() => { game = null; show('home'); });

    // --- 4. Killer: undo restores the First Blood latch.
    const kl = await page.evaluate(async () => {
      try {
        // THREE players, not two. With two, an elimination immediately wins the
        // leg, which clears the turn snapshots — undo is only reachable at all
        // when a third player is still standing, so a 2-player fixture would
        // "pass" without ever exercising the restore.
        const ns = ['MSH_KA_', 'MSH_KB_', 'MSH_KC_'].map(x => x + Date.now());
        for (const n of ns) { await DB.addPlayer(n); roster.push(n); }
        setMode('h2h'); setup.gameType = 'killer'; setup.slots = ns;
        await startGame(); await new Promise(r => setTimeout(r, 600));
        for (const pl of game.players) pl.isKiller = true;
        game.current = 0;
        const target = game.players[1];
        target.lives = 1;                     // one double from elimination
        renderGameKiller();
        setMult(2); throwDart(target.number);
        await new Promise(r => setTimeout(r, 280));
        const after = { firstBlood: game.killerFirstBloodAwarded, eliminated: target.eliminated,
          undoable: !!game.lastTurnSnapshot };
        undoLastTurn(); await new Promise(r => setTimeout(r, 320));
        return { ok: true, after, undone: { firstBlood: game.killerFirstBloodAwarded,
          eliminated: target.eliminated, lives: target.lives } };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
    rep.ok('killer: the fixture really drew first blood, with the turn still undoable',
      kl.ok && kl.after.firstBlood && kl.after.eliminated && kl.after.undoable,
      kl.error || JSON.stringify(kl.after));
    rep.ok('killer: undo releases the match-lifetime First Blood latch',
      kl.ok && kl.undone.firstBlood === false, JSON.stringify(kl.undone));
    rep.ok('killer: undo also puts the eliminated player back',
      kl.ok && kl.undone.eliminated === false && kl.undone.lives === 1, JSON.stringify(kl.undone));
    await page.evaluate(() => { game = null; show('home'); });

    // --- 5. "⏸ Save for later" is hidden for the two modes that run as plain x01
    // but are not savable. The server refuses both as well; this is the half that
    // stops the button from being offered in the first place.
    const save = await page.evaluate(async () => {
      try {
        const allHidden = () => [...document.querySelectorAll('.save-game-btn')].every(b => b.hidden);
        const n = 'MSH_SV_' + Date.now();
        await DB.addPlayer(n); roster.push(n);
        setMode('practice'); setup.gameType = 'x01'; setup.slots = [n];
        await startGame(); await new Promise(r => setTimeout(r, 400));
        const plain = allHidden();
        game.hasGhost = true; updateSaveButtonVisibility();
        const ghost = allHidden();
        game.hasGhost = false; activeChallenge = { player: n, date: '2026-01-01' };
        updateSaveButtonVisibility();
        const challenge = allHidden();
        activeChallenge = null; updateSaveButtonVisibility();
        return { ok: true, plain, ghost, challenge, restored: allHidden() };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
    rep.ok('save button: an ordinary practice X01 game still offers it',
      save.ok && save.plain === false, save.error || `hidden=${save.plain}`);
    rep.ok('save button: a Ghost race does not offer it', save.ok && save.ghost === true,
      `hidden=${save.ghost}`);
    rep.ok('save button: a Daily Challenge attempt does not offer it',
      save.ok && save.challenge === true, `hidden=${save.challenge}`);
    rep.ok('save button: it comes back once neither applies', save.ok && save.restored === false,
      `hidden=${save.restored}`);

    rep.ok('mode-state-hygiene: no uncaught page errors', pageErrors.length === 0,
      pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
