'use strict';
/* The turn loop, across every game type: throw → commit → undo → back where
 * you started.
 *
 * This exists because of a specific, named risk. `throwDart()`, `enterTurn()`,
 * `undoLastTurn()` and `renderGame()` each dispatched on `game.gameType`
 * through their own hand-maintained fifteen-branch chain, and
 * docs/code-quality-roadmap.md item 64 unifies all four onto the GAME_TYPES
 * registry. That refactor's failure mode is unlike the live-scoreboard one it
 * follows: a renderer wired to the wrong branch shows a wrong PICTURE, which
 * somebody notices, while a turn-loop branch wired to the wrong function
 * produces a wrong SCORE, which looks entirely normal on screen. The roadmap
 * entry's own instruction was to add the assertions before the refactor rather
 * than after. This is them.
 *
 * The assertion that does the work is the round trip: snapshot the mode's whole
 * committed state, throw a real visit, commit it, undo it, and require the
 * state to be byte-identical to the snapshot. It exercises all four dispatch
 * points at once and needs no per-mode expected numbers — which matters,
 * because a check that hard-coded "Cricket scores 60 here" would be a second
 * copy of the rules, and the rules already have committed unit tests in
 * backend/test/. What is NOT covered anywhere else is that the right FUNCTION
 * ran at all, and a state that came back changed after a full undo is exactly
 * what "the wrong function ran" looks like.
 *
 * Registry-driven, like all-game-types.js: a new game type gets this coverage
 * without anyone remembering to add it here.
 */
const L = require('../lib');

// Everything about a game that a committed visit can legitimately move. Sets
// and Maps are flattened so JSON.stringify actually compares their contents
// rather than rendering every one of them as {}.
const FINGERPRINT = `(() => {
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
  // Deliberately excluded — wall-clock stamps and render caches, neither of
  // which is game state. roundStartedAt moves on every leg reset and says
  // nothing about scoring;
  // Chuckin's heatmapVersion is a cache-invalidation counter that only ever
  // moves forward, and an undo has no reason to wind it back.
  const SKIP = new Set(['roundStartedAt', 'legStart', 'blitzDeadline',
    'pressureChamberDeadline', 'lastTurnSnapshot', 'turnSnapshots',
    'heatmapVersion', '_heatmapCache', '_heatmapCacheVersion']);
  const players = game.players.map(p => {
    const out = {};
    for (const k of Object.keys(p).sort()) if (!SKIP.has(k)) out[k] = norm(p[k]);
    return out;
  });
  return JSON.stringify({
    players,
    current: game.current, starter: game.starter,
    setNo: game.setNo, legNo: game.legNo,
    legTurns: (game.currentLegTurns || []).length,
    sessionTurns: (game.sessionTurns || []).length,
    won: !!game.won, busted: !!game.busted, roundOver: !!game.roundOver,
    oneEighties: game.gameOneEighties, bigFish: game.gameBigFish, busts: game.gameBusts,
  });
})()`;

module.exports = async function run() {
  const rep = L.makeReporter('turn-loop');

  await L.withPage(L.LANDSCAPE, async (page, pageErrors) => {
    const types = await page.evaluate(() =>
      Object.keys(GAME_TYPES)
        .filter(k => !GAME_TYPES[k].dispatchOnly)
        .map(k => ({
          key: k,
          contexts: contextsForMode(k),
          // Checkout Trainer has no dartboard at all — it is a recall drill
          // whose "throw" is a tapped-out route, so the shared turn loop this
          // check is about does not apply to it.
          padOnly: k === 'checkout_trainer',
        })));

    rep.ok('registry: turn-loop game types discovered', types.length >= 10, `${types.length} types`);

    for (const { key, contexts, padOnly } of types) {
      if (padOnly) continue;
      const mode = contexts.includes('practice') ? 'practice' : 'h2h';
      const seats = mode === 'h2h' ? 2 : 1;
      const names = Array.from({ length: seats }, (_, i) => L.uniqueName(`TL_${key}_${i}`));

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
      await page.waitForTimeout(350);

      const before = await page.evaluate(FINGERPRINT);
      const pre = await page.evaluate(() => ({ legNo: game.legNo, setNo: game.setNo }));

      // THREE real visits, three darts each at 20 as singles, so nothing depends
      // on a mode-specific target being live. Three rather than one so the
      // snapshot STACK is exercised: undo reaches back through every visit
      // committed this leg, and a capture or restore that only works for the
      // most recent one passes a single-visit round trip trivially.
      // Some modes commit per dart and have no Enter turn at all — calling it
      // there is harmless, since every enterTurn* opens with its own
      // no-darts-thrown guard.
      /* A DARTLESS mode (GAME_TYPES.<type>.noDartInput — today the Maths Trainer)
         has no turn loop to exercise: nothing is thrown, so throwDart/enterTurn/
         undoLastTurn are deliberately absent from its registry entry and its rounds
         go to their own table rather than `turns`. Detected from the registry rather
         than named here, and its OWN loop is exercised instead so the type is not
         silently uncovered — an answered round must move the fingerprint exactly as
         a thrown visit does for every other mode. */
      const dartless = await page.evaluate(() =>
        !!(GAME_TYPES[game.gameType] && GAME_TYPES[game.gameType].noDartInput));
      if (dartless) {
        const advanced = await page.evaluate(async () => {
          const errs = [];
          try {
            for (let i = 0; i < 3; i++) {
              answerMaths(game.q.answer);
              await new Promise(r => setTimeout(r, 60));
              nextMathsQuestion();
              await new Promise(r => setTimeout(r, 40));
            }
          } catch (e) { errs.push(String(e && e.message || e)); }
          return { errs, rounds: game.players[0].rounds };
        }).catch(e => ({ errs: [String(e && e.message || e)], rounds: 0 }));
        rep.ok(`${key}: its own round loop runs without throwing`,
          advanced.errs.length === 0, advanced.errs.join('; '));
        rep.ok(`${key}: an answered round moves the game's state`, advanced.rounds === 3,
          `${advanced.rounds} rounds recorded`);
        rep.ok(`${key}: declares no dart-loop members — nothing to throw`,
          await page.evaluate(() => ['throwDart', 'enterTurn', 'undoLastTurn']
            .every(m => typeof GAME_TYPES[game.gameType][m] !== 'function')));
        continue;
      }

      const thrown = await page.evaluate(async () => {
        const err = [];
        for (let v = 0; v < 3; v++) {
          try {
            for (let i = 0; i < 3; i++) { setMult(1); throwDart(20); }
          } catch (e) { err.push('throw: ' + String(e && e.message || e)); }
          try { enterTurn(); } catch (e) { err.push('enter: ' + String(e && e.message || e)); }
          await new Promise(r => setTimeout(r, 40));
        }
        return { err };
      }).catch(e => ({ err: [String(e && e.message || e)] }));

      const after = await page.evaluate(FINGERPRINT);

      rep.ok(`${key}: a thrown visit changes the game's state`, after !== before,
        after === before ? 'nothing moved — did the dispatch reach this mode at all?' : '');
      if (thrown && thrown.err && thrown.err.length) {
        rep.ok(`${key}: the turn loop runs without throwing`, false, thrown.err.join('; '));
      } else {
        rep.ok(`${key}: the turn loop runs without throwing`, true);
      }

      // Two states in which the round trip below genuinely cannot apply, both
      // detected rather than listed by name so a mode that adopts either rule
      // is handled without an edit here — and both REPORTED rather than skipped
      // silently, so a mode that loses its snapshot by accident still shows up.
      //
      //  1. The snapshot stack is empty. Killer clears it the moment a visit
      //     ends ("can't undo across a visit boundary", advanceKillerTurn()).
      //  2. A leg or round boundary was crossed during the three visits, which
      //     clears the stack for the same documented reason. Dead Man Walking
      //     reaches this unpredictably: its targets are drawn from the player's
      //     own history, so how many visits a round takes varies per run.
      const post = await page.evaluate(() =>
        ({ snap: !!(game && game.lastTurnSnapshot), legNo: game.legNo, setNo: game.setNo }));
      const crossedBoundary = post.legNo !== pre.legNo || post.setNo !== pre.setNo;
      const undoable = post.snap && !crossedBoundary;

      // The round trip. Undo as many times as it takes to walk every committed
      // visit back: per-dart modes snapshot per dart, visit modes per visit,
      // and this check deliberately does not need to know which a mode is.
      // The page's CSP forbids eval, so the fingerprint is taken by a separate
      // page.evaluate() (Playwright compiles the string as a function body,
      // which CSP allows) rather than called from inside this loop.
      const undone = await page.evaluate(async () => {
        // Deep enough to walk all three visits back (and per-dart modes' nine
        // individual darts), stopping the moment there is nothing left to undo.
        for (let i = 0; i < 12; i++) {
          if (!game || !game.lastTurnSnapshot) break;
          try { undoLastTurn(); } catch (e) { return { error: String(e && e.message || e) }; }
          await new Promise(r => setTimeout(r, 30));
        }
        return {};
      });
      const restored = await page.evaluate(FINGERPRINT);

      if (!undoable) {
        rep.ok(`${key}: undo is deliberately unavailable past the boundary crossed`, true,
          crossedBoundary ? 'a leg/round resolved during the run, clearing the stack'
                          : 'snapshot stack cleared when the visit ended');
      } else if (undone.error) {
        rep.ok(`${key}: undo runs without throwing`, false, undone.error);
      } else {
        rep.ok(`${key}: undoing the visit restores the exact state it started from`,
          restored === before,
          restored === before ? '' : firstDiff(before, restored));
      }

      await page.evaluate(() => { try { game = null; } catch {} show('home'); });
      await page.waitForTimeout(150);
    }

    rep.ok('turn-loop: no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};

// A readable "these two JSON blobs differ here" so a failure names the field
// rather than dumping two walls of state.
function firstDiff(a, b) {
  let A, B;
  try { A = JSON.parse(a); B = JSON.parse(b); } catch { return 'unparseable fingerprint'; }
  const walk = (x, y, path) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return null;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const hit = walk(x[k], y[k], path ? `${path}.${k}` : k);
        if (hit) return hit;
      }
    }
    return `${path || '(root)'}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`;
  };
  return walk(A, B, '') || 'differs';
}
