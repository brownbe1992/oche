'use strict';
/* Pausing a game must not lose the visits you just threw.
 *
 * Resume is "replay, not snapshot": the server stores only "this game is
 * paused", and the whole position is rebuilt from the recorded turns. That
 * makes the save's timing load-bearing in a way it does not look. Turn writes
 * are serialized through DB._chain; DB.saveGame() deliberately bypasses that
 * queue, because its caller needs the real response. Before item 60 it also
 * bypassed the WAIT — so a save could resolve while turn writes were still in
 * flight, and a player who pressed Pause and then Resume got back a game the
 * server had only partly heard about. Reproduced deterministically at three
 * visits thrown, one recorded: a 501 leg returning on 321 instead of 141.
 *
 * This lives in verify-ui rather than backend/test because the defect is
 * entirely in the browser's request ordering — the backend was correct
 * throughout, and no amount of node:test coverage over db.js could have seen
 * it. It drives the real buttons' code path (DB.saveGame, the real resume
 * endpoint) with zero artificial delay, which is what a double-tap, or a laggy
 * connection reordering two requests, actually looks like.
 */
const L = require('../lib');

module.exports = async function run() {
  const rep = L.makeReporter('save-resume');

  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    const out = await page.evaluate(async () => {
      const name = 'SaveRace_' + Date.now() + '_' + Math.floor(Math.random() * 1e4);
      await DB.addPlayer(name);
      roster.push(name);
      setMode('practice');
      setup.gameType = 'x01';
      setup.slots = [name];
      await startGame();
      await new Promise(r => setTimeout(r, 400));

      // Three visits of three treble-20s: 501 -> 321 -> 141, and the third
      // BUSTS (141 - 180 < 0), which is deliberate — a bust is still a real
      // recorded turn, so the count and the points total move independently
      // and a dropped write can't hide behind the other figure. Each visit is
      // its own queued write, so a save that jumps the queue drops a visibly
      // wrong number of them rather than shaving a single dart.
      for (let v = 0; v < 3; v++) {
        for (let d = 0; d < 3; d++) { setMult(3); throwDart(20); }
        enterTurn();
      }
      const scoreBefore = game.players[0].score;
      const gameId = DB.gameId;

      // Zero delay on both hops — save, then immediately ask for the payload a
      // resume would replay. This IS the failing sequence.
      let saved, resume;
      try { saved = await DB.saveGame(gameId); } catch (e) { saved = { error: String(e && e.message || e) }; }
      try { resume = await Backend.get(`/api/games/${gameId}/resume-state`); }
      catch (e) { resume = { error: String(e && e.message || e) }; }

      const turns = (resume && Array.isArray(resume.turns)) ? resume.turns : null;
      return {
        scoreBefore, gameId, savedOk: !!(saved && saved.ok),
        savedErr: saved && saved.error,
        turnCount: turns ? turns.length : null,
        scoredTotal: turns ? turns.reduce((s, t) => s + (t.scored || 0), 0) : null,
        resumeErr: resume && resume.error,
      };
    });

    rep.ok('three 180s leave the leg on 141', out.scoreBefore === 141, `score was ${out.scoreBefore}`);
    rep.ok('the save succeeds', out.savedOk, out.savedErr || '');
    rep.ok('the resume payload is readable', !out.resumeErr, out.resumeErr || '');

    // The assertion this file exists for.
    rep.ok('every visit thrown before the save is in the resume payload',
      out.turnCount === 3,
      `${out.turnCount} of 3 turns recorded — a save that resolves before its ` +
      'turn writes land loses the visits the player actually threw');
    rep.ok('the recorded turns rebuild the score the player was on',
      out.scoredTotal === 360,
      `turns total ${out.scoredTotal}, expected 360 — two scoring 180s plus a busted ` +
      'third visit, which is what leaves the leg on 141');

    rep.ok('save-resume: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
