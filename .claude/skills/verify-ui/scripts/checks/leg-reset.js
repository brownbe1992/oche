'use strict';
/* A new leg starts from a new leg's state, for every game type.
 *
 * startNextLeg() used to carry its own hardcoded `if(game.gameType === …)`
 * chain of round-counter resets, sitting directly beside the registry call that
 * was already supposed to own leg resets (docs/code-quality-roadmap.md item
 * 69). Two mechanisms for one job, and the chain grew a mode at a time — the
 * sixth arrived with Around the Clock's race variant. It is now a single
 * `resetLegState` member per type.
 *
 * The failure this guards is silent and specific: a leg that begins on
 * Baseball's fifth inning, or Halve-It's fourth round, or with the Pressure
 * Chamber's shot clock still armed from last leg. Nothing errors, nothing looks
 * broken, and the score is simply wrong from the first dart.
 *
 * Method: fingerprint `game`'s own scalar state at the start of leg 1, throw a
 * visit to dirty it, call startNextLeg(false), and require the fingerprint to
 * come back. Deliberately generic rather than a per-mode list of field names —
 * a mode that adds a new game-level counter and forgets to reset it is caught
 * without anyone remembering to extend this file, which is the same failure the
 * hardcoded chain kept having.
 */
const L = require('../lib');

// `game`'s own state, excluding what a new leg is SUPPOSED to change and
// anything that is per-player (resetForNextLeg's job, covered elsewhere).
const FINGERPRINT = `(() => {
  const CHANGES_BY_DESIGN = new Set([
    'legNo', 'setNo', 'turnSeq', 'legStart', 'starter', 'current',
    'currentLegTurns', 'sessionTurns', 'legVisitLogs', 'legSummary',
    'lastTurnSnapshot', 'turnSnapshots', 'lastTurnEvent', 'matchResult',
    'players', 'darts', 'config',
  ]);
  const out = {};
  for (const k of Object.keys(game).sort()) {
    if (CHANGES_BY_DESIGN.has(k)) continue;
    const v = game[k];
    // A key that does not exist yet and a key set to null are the same state;
    // normalising them together stops "created lazily on the first dart" from
    // reading as a reset failure.
    if (v == null) out[k] = null;
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.length;
    else out[k] = '(object)';
  }
  return JSON.stringify(out);
})()`;

module.exports = async function run() {
  const rep = L.makeReporter('leg-reset');

  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    // Only the types that actually reach a next leg. The rest are "a run IS the
    // game" drills (Bob's 27, the Gauntlet, Dead Man Walking) or have no leg
    // boundary at all (Doubles Practice, Chuckin, Around the World, Checkout
    // Trainer) — they never call startNextLeg(), so asserting on it would be
    // asserting on a path a player cannot take, and would report their
    // per-dart state as a reset failure it is not.
    //
    // Hand-listed because no registry flag distinguishes them today, but NOT
    // free to rot: the assertion below requires every type declaring a real
    // resetLegState to appear here, so a mode with leg-reset work to do can
    // never be silently missing from this sweep.
    const TRANSITIONS_LEGS = ['x01', 'cricket', 'baseball', 'shanghai', 'halve_it',
      'pressure_chamber', 'killer', 'around_the_clock', 'checkout_ladder'];

    const declared = await page.evaluate(() =>
      Object.keys(GAME_TYPES)
        .filter(k => !GAME_TYPES[k].dispatchOnly && typeof GAME_TYPES[k].resetLegState === 'function')
        .filter(k => GAME_TYPES[k].resetLegState.name !== 'resetLegStateNone'));
    const unswept = declared.filter(k => !TRANSITIONS_LEGS.includes(k));
    rep.ok('every type with real leg-reset work is in this sweep', unswept.length === 0,
      unswept.length ? `${unswept.join(', ')} declares a resetLegState but is never exercised here` : '');

    const types = await page.evaluate((keys) =>
      keys.map(k => ({ key: k, contexts: contextsForMode(k) })), TRANSITIONS_LEGS);

    rep.ok('registry: leg-reset game types discovered', types.length >= 8, `${types.length} types`);

    for (const { key, contexts } of types) {
      const mode = contexts.includes('practice') ? 'practice' : 'h2h';
      const seats = mode === 'h2h' ? 2 : 1;
      const names = Array.from({ length: seats }, (_, i) => L.uniqueName(`LR_${key}_${i}`));

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

      const fresh = await page.evaluate(FINGERPRINT);

      // Dirty the state the way real play does, then cross a leg boundary
      // directly. Calling startNextLeg() rather than playing a leg out is
      // deliberate: it is the function item 69 changed, and reaching a natural
      // leg win takes a different number of visits in every mode.
      const crossed = await page.evaluate(async () => {
        try {
          for (let i = 0; i < 3; i++) { setMult(1); throwDart(20); }
          try { enterTurn(); } catch {}
          await new Promise(r => setTimeout(r, 150));
          startNextLeg(false);
          await new Promise(r => setTimeout(r, 150));
          return { ok: true };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      });

      if (!crossed.ok) {
        rep.ok(`${key}: crossing a leg boundary runs without throwing`, false, crossed.error);
        continue;
      }
      const after = await page.evaluate(FINGERPRINT);

      rep.ok(`${key}: leg 2 starts from leg 1's game state`, sameState(fresh, after),
        sameState(fresh, after) ? '' : firstDiff(fresh, after));

      await page.evaluate(() => { try { game = null; } catch {} show('home'); });
      await page.waitForTimeout(120);
    }

    rep.ok('leg-reset: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};

// Compared over the UNION of both key sets, with a missing key read as null.
// A field that does not exist on a fresh game and is null on the next leg (X01's
// lastWinCheckoutPoints, set only once a leg has actually been won) is the same
// state described two ways, not a reset that failed.
function sameState(a, b) { return firstDiff(a, b) === null; }

function firstDiff(a, b) {
  let A, B;
  try { A = JSON.parse(a); B = JSON.parse(b); } catch { return 'unparseable fingerprint'; }
  const val = (o, k) => (k in o ? o[k] : null);
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  for (const k of keys) {
    if (JSON.stringify(val(A, k)) !== JSON.stringify(val(B, k))) {
      return `${k}: ${JSON.stringify(val(A, k))} at leg 1 -> ${JSON.stringify(val(B, k))} at leg 2`;
    }
  }
  return null;
}
