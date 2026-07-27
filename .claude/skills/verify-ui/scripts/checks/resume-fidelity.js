'use strict';
/* Save a game, resume it, and get the same game back — for every savable type.
 *
 * Resume is "replay, not snapshot": nothing about the position is stored, and
 * the whole thing is reconstructed by replaying the recorded turns through
 * `scoring.js`'s rebuild*State functions. That makes those six functions the
 * quietest high-stakes code in the app — a wrong one produces a game that looks
 * completely normal and is simply not the game the player paused.
 *
 * docs/code-quality-roadmap.md item 65 folded five of them onto one shared
 * replay loop, and deferred that work for years behind "needs the same
 * full-matrix live save/resume verification item 37 did." This is that matrix.
 * It then found a second, older gap in four rebuilds it did not touch — the
 * solo-run modes' dart counters — and drove that fix too (item 75).
 * The pure functions are separately verified by direct equivalence against the
 * pre-refactor implementations over randomised turn streams; what THIS adds is
 * the rest of the path — the real save endpoint, the real resume payload, the
 * real `resumeGame()` reconstruction — which no unit test reaches.
 *
 * Registry-driven: the savable list comes from the app's own
 * SAVABLE_GAME_TYPES, so a new savable type is covered the day it ships.
 */
const L = require('../lib');

// What a resumed game must reproduce: every player's own scoring state, plus
// the game-level position. Excludes what a resume legitimately does not restore
// (undo history is explicitly dropped, and one-shot voice/announcement fields
// are transient by design).
const FINGERPRINT = `(() => {
  // Deliberately NOT replayed by resume, and correctly so:
  //   - lifetime baselines are re-fetched at resume, so what was "this
  //     session's new outcomes" becomes part of the baseline (atwHitSet /
  //     atwBaselineHitSet trade places, and their union is unchanged);
  //   - achievement/challenge TRACKING state is leg-scoped and rebuilt from
  //     nothing — a resumed leg does not re-award what it already awarded;
  //   - session-scope counters live outside the leg being replayed.
  // Everything left is the game POSITION, which resume does claim to restore.
  const SKIP_PLAYER = new Set([
    'roundStartedAt', 'sessionRounds', 'ghostTurnIndex',
    'lifetimeDartsBase', 'lifetimeTreblesBase', 'lifetimeOneEightiesBase',
    'lifetimeRunsBase', 'lifetimeWalkedOutBase', 'lifetimeCleanStationsBase',
    'atwHitSet', 'atwBaselineHitSet', 'baselineHitSet',
    'singlesHit', 'legVisitScores', 'metronomeFired', 'pendingIceInTheVeins',
    'legWorstDeficit', 'sessionRuns', 'sessionOneEighties',
    '_heatmapCache', '_heatmapCacheVersion', 'heatmapVersion']);
  const norm = v => {
    if (v instanceof Set) return { __set: [...v].map(String).sort() };
    if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [String(k), norm(x)]).sort() };
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  const players = game.players.map(p => {
    const out = {};
    for (const k of Object.keys(p).sort()) if (!SKIP_PLAYER.has(k)) out[k] = norm(p[k]);
    return out;
  });
  return JSON.stringify({
    players, gameType: game.gameType,
    current: game.current, starter: game.starter,
    setNo: game.setNo, legNo: game.legNo,
    baseballInning: game.baseballInning, shanghaiRound: game.shanghaiRound,
    halveItRound: game.halveItRound, pressureChamberRound: game.pressureChamberRound,
    bobs27Round: game.bobs27Round, checkoutLadderTarget: game.checkoutLadderTarget,
  });
})()`;

// There is no known gap any more. The four solo-run modes that used to come back
// from a save with their dart counters at zero (Bob's 27, 121 Checkout Ladder, the
// Gauntlet and Dead Man Walking) were fixed in item 75, and this check is how that
// was driven: it asserted the gap PRECISELY rather than excluding it, so the moment
// each rebuild started replaying its counters the check said so and told whoever
// fixed it to move the mode into the main sweep. Which is this. Every savable type
// now goes through one assertion.

module.exports = async function run() {
  const rep = L.makeReporter('resume-fidelity');

  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    const types = await page.evaluate(() =>
      SAVABLE_GAME_TYPES.map(k => ({ key: k, contexts: contextsForMode(k) })));

    rep.ok('registry: savable game types discovered', types.length >= 8, `${types.length} types`);

    for (const { key, contexts } of types) {
      const mode = contexts.includes('practice') ? 'practice' : 'h2h';
      const seats = mode === 'h2h' ? 2 : 1;
      const names = Array.from({ length: seats }, (_, i) => L.uniqueName(`RF_${key}_${i}`));

      const out = await page.evaluate(async (o) => {
        try {
          for (const n of o.names) await DB.addPlayer(n);
          roster.push(...o.names);
          setMode(o.mode);
          setup.gameType = o.key;
          setup.slots = o.names;
          await startGame();
          await new Promise(r => setTimeout(r, 350));

          // Several real visits, mixing sectors and multipliers so the replay
          // has something with structure to reproduce rather than a flat run of
          // identical turns that many wrong rebuilds would still get right.
          const script = [[3, 20], [1, 5], [2, 18], [1, 20], [3, 19], [1, 1],
                          [2, 20], [1, 17], [1, 3]];
          for (let v = 0; v < 3; v++) {
            for (let d = 0; d < 3; d++) {
              const [m, s] = script[(v * 3 + d) % script.length];
              setMult(m); throwDart(s);
            }
            try { enterTurn(); } catch {}
            await new Promise(r => setTimeout(r, 60));
          }
          await new Promise(r => setTimeout(r, 250));

          const gameId = DB.gameId;
          const done = !!game.done;
          const saved = await DB.saveGame(gameId).catch(e => ({ error: String(e && e.message || e) }));
          return { ok: true, gameId, done, saved };
        } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
      }, { key, mode, names });

      if (!out.ok) { rep.ok(`${key}: plays and saves`, false, out.error); continue; }
      // A mode whose run finished inside three visits has nothing left to
      // resume; that is a legitimate outcome, not a failure to save.
      if (out.done) { rep.ok(`${key}: run completed before a save was possible`, true, 'skipped'); continue; }
      if (out.saved && out.saved.error) { rep.ok(`${key}: saves`, false, out.saved.error); continue; }

      const before = await page.evaluate(FINGERPRINT);

      const resumed = await page.evaluate(async (gameId) => {
        try {
          game = null;
          await resumeGame(gameId);
          await new Promise(r => setTimeout(r, 250));
          return { ok: true };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      }, out.gameId);

      if (!resumed.ok) { rep.ok(`${key}: resumes without throwing`, false, resumed.error); continue; }
      const after = await page.evaluate(FINGERPRINT);

      rep.ok(`${key}: the resumed game is the game that was paused`, after === before,
        after === before ? '' : firstDiff(before, after));

      await page.evaluate(() => { try { game = null; } catch {} show('home'); });
      await page.waitForTimeout(120);
    }

    rep.ok('resume-fidelity: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};

function firstDiff(a, b) {
  let A, B;
  try { A = JSON.parse(a); B = JSON.parse(b); } catch { return 'unparseable fingerprint'; }
  for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) {
      const x = JSON.stringify(A[k]), y = JSON.stringify(B[k]);
      return `${k}:\n      paused  = ${x && x.slice(0, 300)}\n      resumed = ${y && y.slice(0, 300)}`;
    }
  }
  return 'differs';
}
