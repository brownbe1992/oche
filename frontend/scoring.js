'use strict';
/* =============================================================================
   Pure scoring logic, extracted from index.html's inline <script> so it's
   reachable from an automated test (docs/testing-and-observability-roadmap.md
   Part B) without a build step or a new dependency.

   Loaded two ways, unchanged behavior either way:
   - In the browser: via <script src="scoring.js"> before index.html's main
     inline <script> — every function/const below becomes a plain global, exactly
     as if it were still defined inline (this file adds nothing to the runtime
     that wasn't already there, it's the same code moved).
   - In a node:test file: via require('../../frontend/scoring.js') — the
     CommonJS export block at the bottom only runs when `module` exists (i.e.
     under Node), so it's a no-op in the browser.

   Nothing here reads or writes any outer app state (game, DOM, Settings) —
   that's exactly what makes it extractable at all.
   ============================================================================= */

function dartValue(sector, mult){
  if(sector === 0) return 0;
  if(sector === 25) return mult === 2 ? 50 : 25;   // bull: 25 or double-bull 50, no treble
  return sector * mult;
}
function dartLabel(sector, mult){
  if(sector === 0) return 'Miss';
  if(sector === 25) return mult === 2 ? 'Bull' : '25';
  return (mult === 3 ? 'T' : mult === 2 ? 'D' : '') + sector;
}
// Pure core of index.html's makeDart() — everything except thrownAt (a live
// timestamp gated by the admin-configurable dartTimingEnabled setting, which is
// outer app state and deliberately NOT part of this pure module). index.html's
// makeDart() wraps this and adds thrownAt itself.
function makeDartCore(sector, mult){
  const m = (sector === 25 && mult === 3) ? 1 : mult;  // guard: no treble bull
  return {
    sector, mult:m,
    value: dartValue(sector, m),
    isTreble: m === 3 && sector !== 25 && sector !== 0,
    isDouble: (m === 2 && sector !== 0),
    label: dartLabel(sector, m),
  };
}

/* ---------- X01 bust/win rules ----------
   Signature is (player, darts, game) for every game type — X01 only needs
   player.score/player.doubleOut, but the shared shape lets Cricket's evaluateVisit
   see the rest of game.players (to check opponents' closed-number status) without
   a different call convention per type. See GAME_TYPES in index.html. */
function evaluateVisit(player, darts, game){
  const startScore = player.score, doubleOut = player.doubleOut;
  const points = darts.reduce((s,d)=>s+d.value,0);
  const remaining = startScore - points;
  const last = darts[darts.length-1];
  let bust=false, win=false;
  if(remaining < 0) bust=true;
  else if(doubleOut && remaining === 1) bust=true;
  else if(remaining === 0){
    if(doubleOut && !(last && last.isDouble)) bust=true;
    else win=true;
  }
  return {
    pointsThisVisit: points,
    scored: bust ? 0 : points,
    newScore: bust ? startScore : remaining,
    bust, win,
    trebleLess: darts.length>0 && darts.every(d=>!d.isTreble)
  };
}

/* ---------- Doubles Practice ----------
   docs/game-modes-roadmap.md's "Doubles Practice" drill mode. Genuinely
   different shape from every other game type: evaluated PER DART, not per
   3-dart visit — a session-ending event can fire on dart 1, 2, or 3 of what
   would otherwise be a visit, so this can't wait for a batched evaluateVisit()
   call the way X01/Cricket do. game.config.doubles is the target set (an array
   of sectors, 1-20 plus 25 for bull — a "double" of 25 means double-bull/50,
   the same encoding makeDartCore() already uses).

   "All simultaneously live" (2026-07 decision, docs/game-modes-roadmap.md):
   every selected double is live at once — no rotation, no random pick. The
   player throws at whichever target they choose each dart:
   - a double on a target number is a hit (session continues)
   - a double on a number NOT in the target set is "wrong double" (session ends)
   - a single OR treble on a target number is "so close" — landed on the right
     number, just not through the double ring (session ends). The roadmap doc's
     own text only calls out "a single" explicitly, but a treble on the target
     number is the identical miss (wrong ring, right number), so it's treated
     the same way for a complete, unambiguous rule — not a new failure mode.
   - anything else (a miss on an unrelated number, or a genuine total miss) is
     a no-op: doesn't end the session, doesn't count as a hit. */
function evaluateDartDoublesPractice(dart, targets){
  if(dart.isDouble){
    if(targets.includes(dart.sector)) return { hit:true, ended:false, reason:null };
    return { hit:false, ended:true, reason:'wrong-double' };
  }
  if(dart.sector === 0) return { hit:false, ended:true, reason:'miss' };
  if(targets.includes(dart.sector)) return { hit:false, ended:true, reason:'so-close' };
  return { hit:false, ended:true, reason:'wrong-number' };
}

/* ---------- Guided Around the Clock (docs/game-modes-roadmap.md "Guided Around
   the Clock / Around the World") ----------
   Pure per-dart rule, mirroring evaluateDartDoublesPractice()'s shape: a "hit" is
   a single (mult 1) on a number 1-20 not already in this round's hitSet — matches
   the existing passive around_the_clock badge's exact formula (singlesHit.size
   >= 20), not the roadmap doc's "+bull" prose (a treble/double on a number, or
   any dart on bull, is a real dart thrown but never advances completion — the
   "so close, not a hit" precedent Doubles Practice already established, just
   with no round-ending failure mode here since this mode never "loses"). */
function evaluateDartAroundTheClock(dart, hitSet){
  const isSingleTarget = dart.sector >= 1 && dart.sector <= 20 && dart.mult === 1;
  const isNewHit = isSingleTarget && !hitSet.has(dart.sector);
  const completed = isNewHit && (hitSet.size + 1) === 20;
  return { isNewHit, completed };
}

/* ---------- Cricket ----------
   A match's in-play numbers are locked to exactly 7 (classic: 15,16,17,18,19,20,
   Bull, or a custom 7-of-21 selection made at New Game time), stored as
   game.config.numbers. Two variants share this one engine (docs/cutthroat-
   cricket-roadmap.md) — game.config.variant: 'standard' | 'cutthroat' (missing/
   unrecognized treated as 'standard', the pre-cutthroat default):
   - standard: closing a number the shooter has but an opponent hasn't yet lets
     FURTHER hits on it score points onto the SHOOTER's own total. Highest score
     (once every number is closed) wins.
   - cutthroat: the same marks/closing rules, but those points land on EVERY
     OPPONENT who still has the number open instead (each gets the full amount,
     not a split) — the shooter's own total never moves from their own hits.
     Lowest score (once every number is closed) wins. */
const CRICKET_STANDARD_NUMBERS = [15,16,17,18,19,20,25];
// The full pool a custom Cricket config picks its 7 targets from — every number
// 1-20 plus bull (25) — same set renderCricketNumberGrid() already builds one
// button per, and the pool BUG-23's "hit a different number" picker subtracts
// game.config.numbers from to find which numbers AREN'T in play this match.
const CRICKET_ALL_NUMBERS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,25];

// Pure per-dart scoring function, validated standalone against hand-checked
// scenarios (mark accumulation within a visit, closing-vs-scoring marks, opponent-
// closed gating, multi-opponent win checks, both variants) before being wired in.
//
// Marks accumulate dart-by-dart *within* a visit — a number can go from open to
// closed mid-visit, with the remaining darts in that same visit scoring points.
// A mark counts toward points only once the shooter has closed the number (3+
// marks, counting the closing marks themselves as 0 points) AND at least one
// opponent hasn't closed it yet (checked against opponents' state as of the start
// of this visit — only the shooter's own marks change during their own visit).
// `pointsThisVisit`/`scored` is always the total value this visit GENERATED
// (matches turns.scored's meaning either way — see the roadmap doc's "Data
// model" section), regardless of which player(s) it actually lands on.
// `opponentGains` (cutthroat only; always present, zero-filled in standard) is
// `[{name, gained}]` for every opponent, letting the caller (enterTurnCricket())
// apply those totals onto the right player objects — a single visit can score
// onto several players at once, which is why this can't just be a delta on
// `player.points` the way standard's own return already is.
//
// Known open edge case (matches the roadmap doc's own framing, not silently
// resolved): an exact points TIE at the moment the last number closes is not a
// win by this rule — the leg just continues with no tie-break implemented. This
// applies the same way in both variants (the tie check just flips direction).
function evaluateVisitCricket(player, darts, game){
  const numbers = game.config.numbers || CRICKET_STANDARD_NUMBERS;
  const cutthroat = game.config.variant === 'cutthroat';
  const opponents = game.players.filter(pl=>pl!==player);
  const marks = Object.assign({}, player.marks);
  let pointsThisVisit = 0;
  const gains = new Map(opponents.map(o=>[o, 0])); // opponent object -> points gained this visit
  darts.forEach(d=>{
    if(!numbers.includes(d.sector)) return; // miss or out-of-play number: no-op
    const before = marks[d.sector] || 0;
    const after = before + d.mult;
    marks[d.sector] = after;
    const beyondBefore = Math.max(0, before - 3);
    const beyondAfter = Math.max(0, after - 3);
    const newBeyond = beyondAfter - beyondBefore;
    if(newBeyond > 0){
      const openOpponents = opponents.filter(o=>(o.marks[d.sector]||0) < 3);
      if(openOpponents.length){
        const value = newBeyond * d.sector;
        pointsThisVisit += value;
        if(cutthroat) openOpponents.forEach(o=>gains.set(o, gains.get(o) + value));
      }
    }
  });
  const opponentGains = opponents.map(o=>({ name:o.name, gained:gains.get(o) }));
  // Standard: the shooter's own total absorbs this visit's points. Cutthroat: the
  // shooter's own total is untouched by their own hits — only opponentGains move.
  const points = cutthroat ? player.points : player.points + pointsThisVisit;
  const allClosed = numbers.every(n=>(marks[n]||0) >= 3);
  const win = cutthroat
    ? allClosed && opponents.every(o=>points < ((o.points||0) + gains.get(o)))
    : allClosed && opponents.every(o=>points > (o.points||0));
  return { marks, points, pointsThisVisit, scored:pointsThisVisit, win, opponentGains };
}

// 🔪 Stone Cold (docs/cutthroat-cricket-roadmap.md): won a 3+ player cut-throat
// GAME (the whole match, every leg, not just the winning one) having received
// zero points the entire time — the cutthroat analog of a shutout. Takes the
// running "points ever received this game" total directly (accumulated in
// enterTurnCricket(), a game-scoped field that survives leg resets the same way
// gameDarts already does) rather than re-deriving it, the same "test the actual
// threshold decision, not the accumulation" shape isCricketWhitewash()/
// cricketComebackAchieved() already use above.
function cricketStoneColdAchieved(gamePointsReceived, playerCount){
  return playerCount >= 3 && (gamePointsReceived || 0) === 0;
}

/* ---------- Baseball ----------
   docs/game-modes-roadmap.md "Baseball (rules primer)". 9 innings, one per
   number 1-9, played in lockstep by every player (the whole match shares one
   current inning, not a per-player independent state like Cricket's marks).
   Each visit's 3 darts only score against THIS inning's number: single=1 run,
   double=2, treble=3; anything else (wrong number, miss) scores 0. After
   inning 9, highest total runs wins; a tie among the leaders continues into
   extra innings. Extra-innings target number is a judgment call, not sourced
   from the roadmap doc (which left it unspecified): repeats number 9 rather
   than cycling back to 1, on the reasoning that the match stays anchored to
   the last number actually reached rather than re-opening the whole 1-9
   sequence from scratch.
   Visit-based (3 darts per turn), same as X01/Cricket — not per-dart like
   Doubles Practice — so it reuses the batched-visit evaluate/undo shape. */
function baseballInningTarget(inning){
  return inning <= 9 ? inning : 9;
}
function evaluateVisitBaseball(player, darts, game){
  const inning = game.baseballInning;
  const target = baseballInningTarget(inning);
  let runsThisVisit = 0;
  darts.forEach(d=>{ if(d.sector === target) runsThisVisit += d.mult; });
  const totalRuns = (player.totalRuns || 0) + runsThisVisit;
  const inningRuns = Object.assign({}, player.inningRuns, { [inning]: runsThisVisit });
  // The round (inning) only completes once the LAST player in the rotation has
  // thrown — game.current still holds the throwing player's own index here,
  // the same "not yet advanced" timing every other evaluateVisit*() relies on.
  const roundComplete = game.current === game.players.length - 1;
  let matchComplete = false, winnerIndex = null;
  if(roundComplete && inning >= 9){
    const totals = game.players.map((pl, i) => i === game.current ? totalRuns : (pl.totalRuns || 0));
    const maxTotal = Math.max(...totals);
    const leaders = totals.reduce((acc, t, i) => { if(t === maxTotal) acc.push(i); return acc; }, []);
    if(leaders.length === 1){ matchComplete = true; winnerIndex = leaders[0]; }
  }
  return { inningRuns, totalRuns, runsThisVisit, scored:runsThisVisit, target, roundComplete, matchComplete, winnerIndex };
}

// 🔄 The Cycle (docs/archive/culture-badges-roadmap.md Part B): a visit containing a
// single, double, AND treble of the CURRENT inning's target number — exactly 6
// runs the scenic way. Baseball's own cousin of isShanghaiVisit() above, same
// pure-predicate shape, just parameterized by the inning's fixed target instead
// of "any number 1-20", since a Baseball visit only ever scores against the one
// number evaluateVisitBaseball() already computes as `target`.
function isBaseballCycle(darts, target){
  if(!darts || darts.length !== 3) return false;
  if(!darts.every(d => d.sector === target)) return false;
  const mults = darts.map(d => d.mult).sort();
  return mults[0]===1 && mults[1]===2 && mults[2]===3;
}

/* ---------- Shanghai ----------
   docs/archive/shanghai-roadmap.md. Baseball is the direct structural template: a
   fixed round sequence (1..config.rounds, default 1-7), the whole match
   sharing one current round (not per-player), each visit's 3 darts only
   scoring against THAT round's own number. Unlike Baseball, the SCORE isn't
   1 run per dart — it's multiplier × the round number (single=1x, double=2x,
   treble=3x), and a Shanghai (single, double, AND treble of the round's
   number in one visit, any order) wins the WHOLE match instantly, mid-round,
   regardless of anyone's running total. */
function shanghaiRoundTarget(round, maxRounds){
  return round <= maxRounds ? round : maxRounds;
}
// isShanghaiWin() is Baseball's isBaseballCycle() with the win-condition
// meaning attached — same pure-predicate shape (all 3 darts on target,
// multipliers a permutation of {1,2,3}), just named for what it means in
// THIS game: a Shanghai visit isn't a bonus feat here, it's the whole game.
function isShanghaiWin(darts, target){
  if(!darts || darts.length !== 3) return false;
  if(!darts.every(d => d.sector === target)) return false;
  const mults = darts.map(d => d.mult).sort();
  return mults[0]===1 && mults[1]===2 && mults[2]===3;
}
function evaluateVisitShanghai(player, darts, game){
  const round = game.shanghaiRound;
  const maxRounds = (game.config && game.config.rounds) || 7;
  const target = shanghaiRoundTarget(round, maxRounds);
  let pointsThisVisit = 0;
  darts.forEach(d => { if(d.sector === target) pointsThisVisit += d.mult * target; });
  const totalPoints = (player.totalPoints || 0) + pointsThisVisit;
  const roundPoints = Object.assign({}, player.roundPoints, { [round]: pointsThisVisit });
  const shanghai = isShanghaiWin(darts, target);
  // Same "not yet advanced" timing every other evaluateVisit*() relies on —
  // game.current still holds the throwing player's own index here.
  const roundComplete = game.current === game.players.length - 1;
  let matchComplete = false, winnerIndex = null;
  if(shanghai){
    matchComplete = true; winnerIndex = game.current;
  } else if(roundComplete && round >= maxRounds){
    const totals = game.players.map((pl, i) => i === game.current ? totalPoints : (pl.totalPoints || 0));
    const maxTotal = Math.max(...totals);
    const leaders = totals.reduce((acc, t, i) => { if(t === maxTotal) acc.push(i); return acc; }, []);
    // A tie among the leaders continues into an extra round repeating the
    // final round's own number (matching Baseball's extra-innings precedent,
    // per this doc's own "Open questions" lean) rather than a shared loss.
    if(leaders.length === 1){ matchComplete = true; winnerIndex = leaders[0]; }
  }
  return { roundPoints, totalPoints, pointsThisVisit, scored:pointsThisVisit, target, shanghai, roundComplete, matchComplete, winnerIndex };
}

/* ---------- Bob's 27 ----------
   docs/archive/practice-ladders-roadmap.md Part A. Bob Anderson's famous doubles
   routine: start with 27, throw 3 darts at D1, then D2, ... through D20 (one
   round per double, `game.bobs27Round` — game-level state, the same "current
   target lives on game, not per-player" shape Baseball's `baseballInning`
   uses, since this is always solo anyway). Every dart that HITS the round's
   double (sector matches AND it's actually a double, not a single/treble of
   that number) adds its value (D1 hit = +2, D20 hit = +40); if all three
   darts miss the double, the double's value is SUBTRACTED instead. Drop to 0
   or below and the run is over (a fail); survive past D20 and the final
   running total is the run's result (perfect = 1287).

   Visit-based (3 darts per round), same batched-evaluate/undo shape as X01/
   Cricket/Baseball — not per-dart like Doubles Practice, even though only one
   specific dart (a double of the round's number) ever does anything, because
   the "did ALL THREE miss" fail condition can only be judged once the whole
   visit is in. */
function evaluateVisitBobs27(player, darts, game){
  const round = game.bobs27Round;
  const doubleValue = round * 2;
  const hits = darts.filter(d => d.sector === round && d.isDouble).length;
  const gain = hits * doubleValue;
  // A miss-all round (gain === 0) subtracts the double's value instead of
  // storing a negative "scored" — turns.scored can't go negative, so the
  // penalty is DERIVED at replay time from scored===0 (docs/archive/halve-it-roadmap.md's
  // "store the gain, derive the penalty" shape), not stored directly. Any
  // hit is always a positive gain (a double is worth 2x its number, always
  // >0), so scored===0 unambiguously means "missed" — no separate flag needed
  // to tell "scored 0 because missed" apart from any other zero-gain case,
  // because there isn't another one.
  const running = gain > 0 ? player.running + gain : player.running - doubleValue;
  const dead = running <= 0;
  const matchComplete = dead || round >= 20;
  return { running, gain, scored:gain, hits, dead, matchComplete, round };
}

// 🎯 Full House (docs/archive/practice-ladders-roadmap.md Part A): all three darts
// of a visit hit the round's double — the maximum possible gain for that
// round (Bob's 27's own "180" for a single round).
function isBobs27FullHouse(hits){
  return hits === 3;
}

// 🏔️ The Full Anderson (docs/archive/practice-ladders-roadmap.md Part A): a perfect
// run — every one of the 20 rounds hit with all three darts, so the running
// total is exactly 27 + 3*(2+4+...+40) = 1287. A running total can only ever
// reach exactly 1287 by hitting every single round with all three darts (any
// miss subtracts, any partial hit under-gains relative to the maximum), so
// this is a sufficient check on its own — no separate "never missed" flag to
// track alongside it.
function isBobs27FullAnderson(running){
  return running === 1287;
}

/* ---------- server timestamp parsing ----------
   SQLite's `datetime('now')` (backend/db.js's default for every *_at column)
   produces "YYYY-MM-DD HH:MM:SS" -- space-separated, always UTC, no 'Z' or
   offset suffix. That's outside the one format new Date(string) is required
   to parse consistently (ISO 8601, "...THH:MM:SSZ") -- V8 happens to accept
   the space-separated form leniently, but engines that don't (this bug was
   reported from a browser where it produced "Invalid Date" for every entry
   in the Ghost mode leg picker) return Invalid Date instead. Centralized here
   since the same gap had already needed three separate inline fixes elsewhere
   in frontend/index.html before Ghost mode's two call sites turned up with
   the identical bug, unfixed. */
function parseSqliteTimestamp(dt){
  if(!dt) return null;
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(dt);
  return new Date(String(dt).replace(' ', 'T') + (hasTz ? '' : 'Z'));
}

/* ---------- checkout calculator ----------
   Computes a real, valid finishing route for ANY reachable score, instead of
   relying on a hardcoded list. Exhaustively verified for every finishable
   score 2..170. Returns '' when the score can't be finished (e.g. bogey
   numbers like 169, or anything that would leave 1 on a double-out). */
const CO_DOUBLES = {};                       // value -> finishing-dart label
for(let _n=1;_n<=20;_n++) CO_DOUBLES[2*_n]='D'+_n;
CO_DOUBLES[50]='Bull';
const CO_FAV_D = [40,32,16,24,8,20,12,4,36,28,50,2,38,34,30,26,22,18,14,10,6];
const CO_FIRSTS = (()=>{ const a=[]; for(let n=20;n>=1;n--) a.push({v:3*n,label:'T'+n});
  a.push({v:50,label:'Bull'}); a.push({v:25,label:'25'});
  for(let n=20;n>=1;n--) a.push({v:n,label:''+n}); return a; })();

function coTreble(v){ if(v%3===0){const n=v/3; if(n>=1&&n<=20) return 'T'+n;} return null; }
function coSingle(v){ if(v>=1&&v<=20) return ''+v; if(v===25) return '25'; return null; }
function coSetup(need){ if(need<=0) return null; return coTreble(need)||coSingle(need)||(CO_DOUBLES[need]||null); }
function coFinish2(R){
  for(const d of CO_FAV_D){ const need=R-d; if(need<=0) continue;
    const f=coSetup(need); if(f) return [f, CO_DOUBLES[d]]; }
  return null;
}
function coFinish3(R){
  for(const f of CO_FIRSTS){ const rest=R-f.v; if(rest<2) continue;
    const two=coFinish2(rest); if(two) return [f.label, ...two]; }
  return null;
}
function checkoutHint(rem, doubleOut, maxDarts){
  if(maxDarts == null) maxDarts = 3;
  if(rem<1 || rem>170 || maxDarts<1) return '';
  if(doubleOut){
    if(rem<2) return '';
    let r = CO_DOUBLES[rem] ? [CO_DOUBLES[rem]] : null;           // 1 dart
    if(!r && maxDarts>=2) r = coFinish2(rem);                     // 2 darts
    if(!r && maxDarts>=3) r = coFinish3(rem);                     // 3 darts
    return r ? r.join(' ') : '';
  }
  // straight out: last dart can be anything
  const one = coSingle(rem) || CO_DOUBLES[rem] || coTreble(rem);
  if(one) return one;                                            // 1 dart
  if(maxDarts>=2) for(const f of CO_FIRSTS){ const need=rem-f.v;
    const s=coSingle(need)||CO_DOUBLES[need]||coTreble(need);
    if(need>0 && s) return f.label+' '+s; }
  if(maxDarts>=3) for(const f of CO_FIRSTS){ const rest=rem-f.v; if(rest<1) continue;
    for(const g of CO_FIRSTS){ const need=rest-g.v;
      const s=coSingle(need)||CO_DOUBLES[need]||coTreble(need);
      if(need>0 && s) return f.label+' '+g.label+' '+s; } }
  return '';
}

/* ---------- Checkout Trainer (docs/archive/checkout-trainer-roadmap.md) ----------
   A pure mental-recall drill built entirely on top of the two functions above:
   evaluateVisit() grades whether a proposed route legally reaches zero, and
   checkoutHint() supplies the objective minimum dart count to compare against.
   Nothing game-type-specific needed inventing here. */

// Difficulty tiers for target selection (docs/archive/checkout-trainer-roadmap.md
// "Target selection"). Each tier is a [low,high] bound on the target score;
// `pickCheckoutTarget()` intersects it with the out-mode's own floor (2 under
// double-out, 1 under straight-out) so a tier never needs to know about
// bogey/double-out rules itself. 'full' (2-170) is the default and matches
// the app's original, tier-less behavior.
const CHECKOUT_TRAINER_DIFFICULTY_TIERS = {
  under40:  { low: 1, high: 39  },
  under100: { low: 1, high: 99  },
  over100:  { low: 100, high: 170 },
  full:     { low: 1, high: 170 }
};

// Picks a random target score that's actually finishable under the given
// out-mode, reusing checkoutHint()'s own '' unfinishable signal instead of a
// separate hardcoded bogey-number list (169/168/166/165/163/162/159, and 1
// under double-out) — asking for an impossible checkout would be a bad-faith
// question, not a harder one (see the roadmap doc's "Target selection").
// `rng` defaults to Math.random but is injectable for a deterministic test.
// `difficulty` selects a CHECKOUT_TRAINER_DIFFICULTY_TIERS key; an unknown or
// omitted value falls back to 'full', so existing callers/tests keep working
// unchanged. The random-roll loop is bounded only as a defensive guard
// against a pathological rng — every tier has finishable values within a few
// rolls in practice, so this never meaningfully runs to the fallback scan.
// Trick-question variant (docs/archive/checkout-trainer-roadmap.md "Trick-question
// difficulty variant", shipped 2026-07): when enabled for the session
// (games.config.trickQuestions), roughly 1 round in 8 serves an actual bogey
// number — a target with NO possible 3-dart checkout — and the correct answer
// is to press the "No possible checkout" button instead of tapping out darts
// (gradeCheckoutDeclaration() below is that button's grading branch). 1-in-8
// keeps trick rounds a genuine surprise rather than a coin flip the player
// starts second-guessing every round over.
const CHECKOUT_TRAINER_TRICK_CHANCE = 0.125;

// Every unsolvable target within a difficulty tier for the given out-mode,
// derived from checkoutHint()'s own '' signal rather than a hardcoded list —
// the same source of truth pickCheckoutTarget() already trusts for the
// opposite question. Under double-out this is the classic bogey set
// (159/162/163/165/166/168/169) intersected with the tier's range; straight
// out has its own, different unreachable-in-3-darts scores near the top of
// the range. A tier can legitimately come back empty (e.g. Under 40, where
// every score is finishable) — pickCheckoutTarget() falls through to a
// normal solvable target in that case rather than failing the roll.
function listUnsolvableTargets(doubleOut, difficulty){
  const tier = CHECKOUT_TRAINER_DIFFICULTY_TIERS[difficulty] || CHECKOUT_TRAINER_DIFFICULTY_TIERS.full;
  const low = Math.max(doubleOut ? 2 : 1, tier.low);
  const out = [];
  for(let c=low;c<=tier.high;c++){
    if(checkoutHint(c, doubleOut, 3) === '') out.push(c);
  }
  return out;
}

// `trickChance` (0..1, default 0 so every existing caller/test keeps its exact
// pre-trick behavior): probability that this round serves a deliberately
// unsolvable bogey number from the tier instead of a finishable target. The
// trick roll consumes one rng draw and the bogey pick a second, so a
// deterministic test can steer both.
// `pinnedTarget` (docs/checkout-drill-link-roadmap.md "Drill this checkout" deep
// link): when set, short-circuits every difficulty/trick roll below and always
// serves that same number — repetition is the point. Ignored (falls through to
// the normal roll) if the pin isn't actually finishable under this out-mode, so
// a stale/bad pin can never wedge the trainer on an impossible target.
function pickCheckoutTarget(doubleOut, rng, difficulty, trickChance, pinnedTarget){
  if(pinnedTarget != null && checkoutHint(pinnedTarget, doubleOut, 3) !== '') return pinnedTarget;
  const roll = rng || Math.random;
  const tier = CHECKOUT_TRAINER_DIFFICULTY_TIERS[difficulty] || CHECKOUT_TRAINER_DIFFICULTY_TIERS.full;
  const low = Math.max(doubleOut ? 2 : 1, tier.low);   // double-out can never finish on 1; straight-out can
  const high = tier.high;
  if(trickChance > 0 && roll() < trickChance){
    const bogeys = listUnsolvableTargets(doubleOut, difficulty);
    if(bogeys.length) return bogeys[Math.floor(roll() * bogeys.length)];
    // tier has no unsolvable values (e.g. Under 40) — serve a normal target instead
  }
  for(let i=0;i<200;i++){
    const candidate = low + Math.floor(roll() * (high - low + 1));
    if(checkoutHint(candidate, doubleOut, 3) !== '') return candidate;
  }
  for(let c=low;c<=high;c++){   // unreachable in practice — deterministic scan of the tier itself
    if(checkoutHint(c, doubleOut, 3) !== '') return c;
  }
  return doubleOut ? 40 : 1;  // unreachable in practice — every tier has at least one finishable value
}

// Grades one proposed checkout attempt against a target score. `legal` mirrors
// evaluateVisit()'s win flag (reached exactly zero, valid last dart under
// double-out) — a partial or over-shooting attempt is simply not legal, same
// as any other X01 visit. `optimal` additionally requires matching checkoutHint()'s
// minimum dart count: grading is by dart COUNT, not exact route match, since
// checkoutHint() only ever returns *a* valid optimal route and real finishes
// commonly have multiple equally-optimal paths (see the roadmap doc's
// "Optimal?" section). `hint` is returned alongside so the UI can reveal the
// route on anything other than an optimal answer without a second call.
function gradeCheckoutAttempt(target, doubleOut, darts){
  const ev = evaluateVisit({ score: target, doubleOut }, darts, null);
  const hint = checkoutHint(target, doubleOut, 3);
  const optimalDarts = hint ? hint.split(' ').length : null;
  const legal = !!ev.win;
  const usedDarts = darts.length;
  const optimal = legal && optimalDarts != null && usedDarts === optimalDarts;
  return { legal, usedDarts, optimalDarts, optimal, hint };
}

// Grades a "no possible checkout" declaration — the trick-question variant's
// second answer path, alongside gradeCheckoutAttempt() above. Correct exactly
// when checkoutHint() has no route for the target (a genuine bogey number);
// declaring a finishable target unsolvable is wrong, and `hint` carries the
// route that proves it for the reveal. The return shape deliberately mirrors
// gradeCheckoutAttempt()'s `legal`/`optimal` flags — a correct declaration IS
// this round's best possible answer, so it maps onto the same three-way
// bust/checkout/leg_won outcome every stat, ladder, and Blitz's 2/1/0 scoring
// already read (correct -> optimal, 2 points; wrong -> illegal, 0 points; a
// declaration is never "legal but not optimal"). `declared:true` is what lets
// the UI and the one-off badge checks tell the two answer paths apart — a
// declaration must never count as a 1-dart solve (One-Darter) or a mastered
// checkout (toughest-checkout Personal Best).
function gradeCheckoutDeclaration(target, doubleOut){
  const hint = checkoutHint(target, doubleOut, 3);
  const correct = hint === '';
  return { declared: true, correct, legal: correct, optimal: correct,
    usedDarts: 0, optimalDarts: correct ? null : hint.split(' ').length, hint };
}

// Checkout Blitz's wall-clock deadline check (docs/archive/checkout-trainer-roadmap.md
// "Core loop delta", revised 2026-07) — a single pure predicate shared by all
// three of index.html's timeout enforcement points (throwDartCheckoutTrainer(),
// submitCheckoutAttempt(), tickCheckoutBlitzTimer()) so they can never disagree
// on the exact boundary. `deadline`/`now` are both epoch milliseconds (`now`
// injectable for tests; index.html always passes `Date.now()`). A `null`
// deadline (Freeform mode, or a Blitz run that hasn't started its clock yet)
// never counts as passed.
function blitzDeadlinePassed(deadline, now){
  return deadline != null && now >= deadline;
}
// 📸 Photo Finish (docs/archive/checkout-trainer-roadmap.md "Achievements") — a legal
// Checkout Blitz round submitted with under 1 second **genuinely remaining**,
// never a submission that arrived after the deadline. Fixed 2026-07: the
// previous version only checked `remainingMs < 1000`, which is also true for
// any negative value — a round finished and submitted a full minute after the
// buzzer (remainingMs === -60000) satisfied `< 1000` and wrongly earned this
// "beat the buzzer" badge. `remainingMs` is `deadline - now` captured at the
// moment of submission.
function isPhotoFinishSubmission(remainingMs){
  return remainingMs != null && remainingMs >= 0 && remainingMs < 1000;
}

// Staircase Finish (REFERENCE.md's Achievements section, docs/achievements-badges-
// roadmap.md) — checked out a leg by aiming at a double, missing to the single,
// and repeating that all the way down: single at half the visit's starting
// remaining score, single at a quarter, double at an eighth. E.g. left on 32
// (the double-out target is double 16): single 16 (16 left), single 8 (8 left),
// double 4 (checkout) — or 40: single 20, single 10, double 5 — or 8: single 4,
// single 2, double 1. Requires exactly 3 darts and an exact match on each dart's
// sector/multiplier; startScore must be a multiple of 8 with startScore/2 a valid
// single (<=20) and startScore/8 a valid dart number (>=1) — the only qualifying
// starting scores are 8, 16, 24, 32, and 40.
function isStaircaseFinish(startScore, darts){
  if(!darts || darts.length !== 3) return false;
  if(startScore % 8 !== 0) return false;
  const n = startScore/2, half = startScore/4, quarter = startScore/8;
  if(quarter < 1 || n > 20) return false;
  const [d1, d2, d3] = darts;
  return d1.sector===n && d1.mult===1 &&
    d2.sector===half && d2.mult===1 &&
    d3.sector===quarter && d3.mult===2;
}

// Darts-culture one-off badges (docs/archive/culture-badges-roadmap.md Part A) — real
// moments players already shout about at the board, each a pure predicate over
// a visit's darts (or the visit's outcome), following isStaircaseFinish()'s own
// precedent immediately above: checked where checkout darts are already
// inspected, unit-tested here rather than only covered by a one-off manual check.

// 🍳 Bed & Breakfast: the classic "26" splash around the 20 — S20, S5, S1, in
// any order. An exact sector/multiplier match on all three darts, not merely
// `scored===26` — the joke is specifically that splash, not just any route to
// 26 (which for a legal 3-single visit happens to be the only route anyway, but
// matching on darts directly keeps the predicate self-contained and correct
// even if a future 1-2-dart short visit could otherwise coincidentally net 26).
function isBedAndBreakfast(darts){
  if(!darts || darts.length !== 3) return false;
  const need = [[20,1], [5,1], [1,1]];
  const remaining = need.slice();
  for(const dart of darts){
    const i = remaining.findIndex(([s,m]) => s===dart.sector && m===dart.mult);
    if(i < 0) return false;
    remaining.splice(i, 1);
  }
  return true;
}

// 🏚️ Madhouse: won the leg by checking out on double 1 — the finish nobody
// wants to be left on. Same "last dart" shape the Bullseye Finish chain check
// already uses inline in index.html, pulled into its own pure predicate here
// per the roadmap's explicit direction to follow the Staircase Finish precedent.
function isMadhouseFinish(win, darts){
  if(!win || !darts || !darts.length) return false;
  const last = darts[darts.length-1];
  return last.sector===1 && last.mult===2;
}

// 🀄 Shanghai visit: a single, double, AND treble of the SAME number in one
// visit, any order, any number 1-20 — the feat landing inside a normal X01 leg,
// deliberately independent of the Shanghai game mode's own instant-win badge
// (docs/archive/shanghai-roadmap.md), which is its own separate thing entirely (see
// that doc and this one for the cross-reference). The bull is never eligible —
// there's no treble-bull ring (makeDartCore() already downgrades an attempted
// "treble bull" tap to a single), so a same-number single+double+treble set is
// structurally impossible there — which the sector<=20 range check below
// already rules out with no special case needed.
function isShanghaiVisit(darts){
  if(!darts || darts.length !== 3) return false;
  const sector = darts[0].sector;
  if(sector < 1 || sector > 20) return false;
  if(!darts.every(dart => dart.sector === sector)) return false;
  const mults = darts.map(dart => dart.mult).sort();
  return mults[0]===1 && mults[1]===2 && mults[2]===3;
}

// Daily Challenge badge trigger thresholds (REFERENCE.md's Achievements section,
// docs/archive/achievements-badges-roadmap.md) — a day-count streak, not a visit/leg count,
// so "recurring" here means "can fire again after a later streak reaches the same
// exact length again", not "fires every day the streak stays >= threshold" (an
// index.html caller checking currentStreak===7/===30, one-shot per crossing, is
// what keeps this from re-firing every single day of a long streak).
const CHALLENGE_STREAK_WEEK = 7;
const CHALLENGE_STREAK_MONTH = 30;
// Pure trigger-condition check for the three Daily Challenge badges, given the
// `{currentStreak, bestByFormat}` shape returned by backend/db.js's
// getChallengeHistory() and the list of all challenge format keys (CHALLENGE_FORMATS
// in index.html). `allFormats` is true once every format has at least one
// *completed* attempt ever (bestByFormat only ever contains completed attempts —
// see getChallengeHistory()'s own query — so this is already "at least once", not
// merely "attempted").
function challengeBadgeSignals(history, formats){
  const bestByFormat = (history && history.bestByFormat) || {};
  const currentStreak = (history && history.currentStreak) || 0;
  return {
    week: currentStreak === CHALLENGE_STREAK_WEEK,
    month: currentStreak === CHALLENGE_STREAK_MONTH,
    allFormats: formats.length > 0 && formats.every(f => bestByFormat[f] != null),
  };
}

// Just Chuckin' It milestone-ladder trigger condition (game-modes-roadmap.md
// "Just Chuckin' It", REFERENCE.md's Achievements section) — each of the 18
// tiers across 3 metrics (lifetime darts, lifetime trebles, single-session
// darts) is just a >= threshold check on a cumulative count, but per
// challengeBadgeSignals()'s precedent above, the actual comparison lives here
// (not reimplemented inline in index.html's checkChuckinMilestoneTier()) so
// it's covered by a committed test rather than only a one-off manual check.
// `tiers` is one ladder's `tiers` array (each `{threshold, ...}`); returns the
// thresholds `value` has reached, in the same order they were given.
function chuckinTiersReached(tiers, value){
  return tiers.filter(t => value >= t.threshold).map(t => t.threshold);
}

// Cricket-native badge trigger conditions (docs/game-modes-roadmap.md "New
// Cricket-native badges") — 2-player only, same restriction as X01's own
// social/margin-of-victory badges (Comeback Kid, Giant Slayer, etc.), since
// both need a single well-defined opponent to compare against.

// Whitewash: true when the opponent closed zero numbers by the time the leg
// ended — `opponentMarks` is that player's `marks` object (number -> mark
// count, 3+ meaning closed), the same shape `newMatchPlayerCricket()` builds.
function isCricketWhitewash(opponentMarks){
  return Object.values(opponentMarks || {}).every(m => (m || 0) < 3);
}

// Comeback Kid (Cricket): mirrors X01 Comeback Kid's shape (won after trailing
// by a meaningful margin at some point) but tracks Cricket's own points
// instead of X01's remaining-score deficit — higher points is better in
// Cricket, so "trailing" means the opponent was ahead, not behind. The
// running "worst deficit this leg" value itself is accumulated the same way
// X01's `legWorstDeficit` is (a per-visit Math.max in enterTurnCricket()/
// enterTurn()) — not reimplemented here — this only tests the actual
// threshold decision, chosen against real play rather than guessed (see the
// roadmap doc): a 20-point swing is meaningful on Cricket's much smaller and
// more variable points scale than X01's fixed 501 countdown.
const CRICKET_COMEBACK_THRESHOLD = 20;
function cricketComebackAchieved(worstPointsDeficit){
  return (worstPointsDeficit || 0) >= CRICKET_COMEBACK_THRESHOLD;
}

/* =============================================================================
   Saved games / pause & resume — pure replay rebuild (docs/archive/saved-games-roadmap.md)

   Rebuilds a game's live-play state (scores/marks/runs, legs/sets won, whose
   turn, game-type extras) by feeding every recorded turn back through the SAME
   evaluateVisit()/evaluateVisitCricket()/evaluateVisitBaseball()/
   evaluateDartAroundTheClock() functions that scored it live — "replay, not
   snapshot," so a resumed game can never disagree with what actually happened.
   Deliberately NOT the live enterTurn()/onLegWon()/startNextLeg() functions
   (frontend/index.html) — those carry real side effects (DB writes, badge
   awards, HA webhooks, rendering) that must never re-fire for turns the server
   already recorded once. These functions are pure — same inputs, same outputs,
   no network/DOM/global-state access — so they're reachable from the browser
   (a real resume), from backend/db.js (require()'d, computing the Saved Games
   list's one-line position summary without a second parallel implementation),
   and from node:test directly.

   Only what's actually resumable is rebuilt (the roadmap doc's own "Resume"
   list): remaining scores/marks+points/innings+runs, legs/sets won, current
   set/leg, whose turn — NOT per-leg badge-trigger trackers (Metronome streaks,
   Comeback Kid deficits, Around the Clock's singlesHit, etc.), which are
   cosmetic/session bookkeeping already accepted as lost on a page refresh, same
   as the doc's own "what resume deliberately does NOT rebuild" section.

   `turns` is always the FULL ordered turn history for the game (original
   insertion order), each `{ playerIndex, setNo, legNo, darts:[{sector,mult}] }`. */

// Shared leg/set-win bookkeeping X01 and Cricket both apply identically once a
// visit's evaluate*() call reports a leg win: legsWon increments for the
// winner; a set completes (setsWon++, everyone's legsWon resets to 0) once
// legsPerSet is reached — but only when setsGateOpen (each game type's own
// "does practice mode even track sets" rule: X01 onLegWon() gates on
// `!practice` — ghost races are never resumable, so that half of its real
// condition doesn't apply here; Cricket's onLegWonCricket() also gates on
// `!practice`; see frontend/index.html for both). A genuinely complete MATCH
// can never appear here — only an incomplete game can be saved, so the leg
// just won is never the game's final one — so there's no "match complete"
// branch to replicate. Returns true when a set completed (so the caller knows
// whether the FOLLOWING leg, if replayed, is also a new set).
function _applyLegWin(players, winnerIndex, legsPerSet, setsGateOpen){
  const w = players[winnerIndex];
  w.legsWon += 1;
  if(setsGateOpen && w.legsWon >= legsPerSet){
    w.setsWon += 1;
    players.forEach(p => { p.legsWon = 0; });
    return true;
  }
  return false;
}

// X01 (docs/archive/saved-games-roadmap.md build-order step 2 — "X01 has the most
// derived state... and proves the pattern"). Mirrors enterTurn()'s score/leg/
// game bookkeeping and resetPlayerForNextLegX01()'s leg reset, minus every
// side effect (DB writes, badges, webhooks, rendering) — see this section's
// own header comment for why those are deliberately not replayed.
function rebuildX01State({ names, outModes, startScore, practice, legsPerSet, turns }){
  const players = names.map((name, i) => ({
    name, score: startScore, doubleOut: (outModes[i] !== 'single'),
    legPoints:0, legVisits:0, legDarts:0, legAvgDarts:0,
    setDarts:0, gameDarts:0, gamePoints:0, gameVisits:0, gameAvgDarts:0,
    legsWon:0, setsWon:0,
  }));
  const setsGateOpen = !practice;
  let current = 0, starter = 0, setNo = 1, legNo = 1, seenFirst = false;
  let pendingNewLeg = false, pendingNewSet = false;
  for(const t of turns){
    // A new (set,leg) pair began — apply the same starter-rotation + leg reset
    // startNextLeg() applies live, whether it's this iteration's own turn
    // starting a fresh leg (the common case) or, via pendingNewLeg below, a
    // trailing leg win with no next-leg turn recorded yet (saved mid-transition,
    // on the "leg won — Next leg?" screen, before that button was ever tapped).
    if(seenFirst && (t.setNo !== setNo || t.legNo !== legNo)){
      starter = (starter + 1) % players.length;
      current = starter;
      const newSet = t.setNo !== setNo;
      players.forEach(p => { p.score = startScore; p.legPoints=0; p.legVisits=0; p.legDarts=0; p.legAvgDarts=0; if(newSet) p.setDarts=0; });
      setNo = t.setNo; legNo = t.legNo;
    }
    seenFirst = true;
    pendingNewLeg = false; pendingNewSet = false;
    const p = players[t.playerIndex];
    const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
    const ev = evaluateVisit(p, dartsCore, { players });
    const adj = ev.bust ? 3 : dartsCore.length;
    p.legPoints += ev.scored; p.legVisits += 1;
    p.legDarts += dartsCore.length; p.legAvgDarts += adj;
    p.setDarts += dartsCore.length; p.gameDarts += dartsCore.length; p.gameAvgDarts += adj;
    p.gamePoints += ev.scored; p.gameVisits += 1;
    if(!ev.bust) p.score = ev.newScore;
    if(ev.win){
      pendingNewSet = _applyLegWin(players, t.playerIndex, legsPerSet, setsGateOpen);
      pendingNewLeg = true;
      current = t.playerIndex; // provisional — overwritten above if a further turn follows
    } else {
      current = (t.playerIndex + 1) % players.length;
    }
  }
  // Trailing leg win, no next-leg turn recorded yet — land exactly where
  // "Next leg"/"Next set" would have (see the comment above): rotate the
  // starter and reset every player's leg-scoped fields, one leg/set ahead of
  // the last one actually recorded.
  if(pendingNewLeg){
    starter = (starter + 1) % players.length;
    current = starter;
    players.forEach(p => { p.score = startScore; p.legPoints=0; p.legVisits=0; p.legDarts=0; p.legAvgDarts=0; if(pendingNewSet) p.setDarts=0; });
    if(pendingNewSet){ setNo += 1; legNo = 1; } else { legNo += 1; }
  }
  return { players, current, starter, setNo, legNo };
}

// Cricket — same replay shape as X01 above, adapted to marks+points instead of
// a countdown score. evaluateVisitCricket() needs game.players (to check
// opponents' closed-number status) and game.config.{numbers,variant}, both
// satisfied by the { players, config } stub passed in below (mirrors the live
// game object's own shape closely enough for this pure function's needs).
// Cutthroat's opponentGains are applied the same way enterTurnCricket() applies
// them live — this is what keeps a resumed cutthroat game's points (and
// therefore its win checks, since those compare points) correct; see
// evaluateVisitCricket()'s own header comment for why a single visit can't just
// be a delta on the shooter's own `points`. Per-leg badge-trigger trackers
// (Comeback Kid's deficit, Stone Cold's gamePointsReceived) are deliberately
// NOT rebuilt here — same "cosmetic/session bookkeeping already accepted as
// lost on resume" precedent as every other game type's own trackers (see this
// section's own header comment above).
function rebuildCricketState({ names, config, practice, legsPerSet, turns }){
  const numbers = (config && config.numbers) || CRICKET_STANDARD_NUMBERS;
  const variant = (config && config.variant) === 'cutthroat' ? 'cutthroat' : 'standard';
  const players = names.map(name => {
    const marks = {}; numbers.forEach(n => { marks[n] = 0; });
    return { name, marks, points:0, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0 };
  });
  const setsGateOpen = !practice;
  let current = 0, starter = 0, setNo = 1, legNo = 1, seenFirst = false;
  let pendingNewLeg = false, pendingNewSet = false;
  const resetLegMarks = (p, newSet) => {
    const marks = {}; numbers.forEach(n => { marks[n] = 0; });
    p.marks = marks; p.points = 0; p.legDarts = 0;
    if(newSet) p.setDarts = 0;
  };
  for(const t of turns){
    if(seenFirst && (t.setNo !== setNo || t.legNo !== legNo)){
      starter = (starter + 1) % players.length;
      current = starter;
      const newSet = t.setNo !== setNo;
      players.forEach(p => resetLegMarks(p, newSet));
      setNo = t.setNo; legNo = t.legNo;
    }
    seenFirst = true;
    pendingNewLeg = false; pendingNewSet = false;
    const p = players[t.playerIndex];
    const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
    const ev = evaluateVisitCricket(p, dartsCore, { players, config: { numbers, variant } });
    p.marks = ev.marks; p.points = ev.points;
    if(variant === 'cutthroat'){
      ev.opponentGains.forEach(g => {
        if(g.gained > 0){
          const opp = players.find(pl => pl.name === g.name);
          if(opp) opp.points += g.gained;
        }
      });
    }
    p.legDarts += dartsCore.length; p.setDarts += dartsCore.length; p.gameDarts += dartsCore.length;
    if(ev.win){
      pendingNewSet = _applyLegWin(players, t.playerIndex, legsPerSet, setsGateOpen);
      pendingNewLeg = true;
      current = t.playerIndex;
    } else {
      current = (t.playerIndex + 1) % players.length;
    }
  }
  if(pendingNewLeg){
    starter = (starter + 1) % players.length;
    current = starter;
    players.forEach(p => resetLegMarks(p, pendingNewSet));
    if(pendingNewSet){ setNo += 1; legNo = 1; } else { legNo += 1; }
  }
  return { players, current, starter, setNo, legNo };
}

// Baseball — structurally different from X01/Cricket: every player shares one
// game-level "current inning" (game.baseballInning, not per-player state), the
// round only completes once the LAST player in rotation has thrown, and the
// player whose visit just ran isn't necessarily the winner (evaluateVisitBaseball()
// decides that from total runs once the round completes) — see enterTurnBaseball()/
// onLegWonBaseball() in frontend/index.html for the live equivalents this mirrors.
// No practice gate on the set-completion check (matches onLegWonBaseball()'s own
// unconditional `if(w.legsWon >= game.legsPerSet)` — docs/bug-roadmap.md BUG-22:
// practice Baseball is forced to exactly 1 leg/1 set at creation, so the gate
// would be a no-op here even if applied).
function rebuildBaseballState({ names, legsPerSet, turns }){
  const players = names.map(name => ({ name, totalRuns:0, inningRuns:{}, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0 }));
  let current = 0, starter = 0, setNo = 1, legNo = 1, baseballInning = 1, seenFirst = false;
  let pendingNewLeg = false, pendingNewSet = false;
  const resetLeg = (p, newSet) => { p.totalRuns = 0; p.inningRuns = {}; p.legDarts = 0; if(newSet) p.setDarts = 0; };
  for(const t of turns){
    if(seenFirst && (t.setNo !== setNo || t.legNo !== legNo)){
      starter = (starter + 1) % players.length;
      current = starter;
      const newSet = t.setNo !== setNo;
      players.forEach(p => resetLeg(p, newSet));
      setNo = t.setNo; legNo = t.legNo; baseballInning = 1;
    }
    seenFirst = true;
    pendingNewLeg = false; pendingNewSet = false;
    current = t.playerIndex;
    const p = players[t.playerIndex];
    const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
    const ev = evaluateVisitBaseball(p, dartsCore, { players, current, baseballInning });
    p.totalRuns = ev.totalRuns; p.inningRuns = ev.inningRuns;
    p.legDarts += dartsCore.length; p.setDarts += dartsCore.length; p.gameDarts += dartsCore.length;
    if(ev.matchComplete){
      const w = players[ev.winnerIndex];
      w.legsWon += 1;
      if(w.legsWon >= legsPerSet){
        w.setsWon += 1;
        players.forEach(pp => { pp.legsWon = 0; });
        pendingNewSet = true;
      }
      pendingNewLeg = true;
      current = ev.winnerIndex;
    } else {
      if(ev.roundComplete) baseballInning += 1;
      current = (t.playerIndex + 1) % players.length;
    }
  }
  if(pendingNewLeg){
    starter = (starter + 1) % players.length;
    current = starter;
    players.forEach(p => resetLeg(p, pendingNewSet));
    if(pendingNewSet){ setNo += 1; legNo = 1; } else { legNo += 1; }
    baseballInning = 1;
  }
  return { players, current, starter, setNo, legNo, baseballInning };
}

// Shanghai (docs/archive/shanghai-roadmap.md) — Baseball's rebuildBaseballState()
// with the round target parameterized by maxRounds (config.rounds) instead
// of a hardcoded 9, and a Shanghai ending the match instantly instead of
// needing the final round to complete.
function rebuildShanghaiState({ names, legsPerSet, maxRounds, turns }){
  const players = names.map(name => ({ name, totalPoints:0, roundPoints:{}, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0 }));
  let current = 0, starter = 0, setNo = 1, legNo = 1, shanghaiRound = 1, seenFirst = false;
  let pendingNewLeg = false, pendingNewSet = false;
  const resetLeg = (p, newSet) => { p.totalPoints = 0; p.roundPoints = {}; p.legDarts = 0; if(newSet) p.setDarts = 0; };
  for(const t of turns){
    if(seenFirst && (t.setNo !== setNo || t.legNo !== legNo)){
      starter = (starter + 1) % players.length;
      current = starter;
      const newSet = t.setNo !== setNo;
      players.forEach(p => resetLeg(p, newSet));
      setNo = t.setNo; legNo = t.legNo; shanghaiRound = 1;
    }
    seenFirst = true;
    pendingNewLeg = false; pendingNewSet = false;
    current = t.playerIndex;
    const p = players[t.playerIndex];
    const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
    const ev = evaluateVisitShanghai(p, dartsCore, { players, current, shanghaiRound, config:{ rounds:maxRounds } });
    p.totalPoints = ev.totalPoints; p.roundPoints = ev.roundPoints;
    p.legDarts += dartsCore.length; p.setDarts += dartsCore.length; p.gameDarts += dartsCore.length;
    if(ev.matchComplete){
      const w = players[ev.winnerIndex];
      w.legsWon += 1;
      if(w.legsWon >= legsPerSet){
        w.setsWon += 1;
        players.forEach(pp => { pp.legsWon = 0; });
        pendingNewSet = true;
      }
      pendingNewLeg = true;
      current = ev.winnerIndex;
    } else {
      if(ev.roundComplete) shanghaiRound += 1;
      current = (t.playerIndex + 1) % players.length;
    }
  }
  if(pendingNewLeg){
    starter = (starter + 1) % players.length;
    current = starter;
    players.forEach(p => resetLeg(p, pendingNewSet));
    if(pendingNewSet){ setNo += 1; legNo = 1; } else { legNo += 1; }
    shanghaiRound = 1;
  }
  return { players, current, starter, setNo, legNo, shanghaiRound };
}

// Halve-It (docs/archive/halve-it-roadmap.md). Structurally another Baseball/
// Shanghai sibling (fixed round sequence, all players in lockstep on one
// shared live round), with two differences: the round's own "target" is a
// {sector, ring?} pair rather than a single number (ring omitted = any ring
// of that sector counts at face value; ring present = only that exact ring
// counts), and there is no instant-win condition at all — the match only
// ever completes once the final round settles, same as Baseball's own shape
// (never Shanghai's early-exit case).
const HALVE_IT_RING_MULT = { single: 1, double: 2, treble: 3 };
// The classic pub set this game defaults to when no custom config.targets is
// supplied (docs/archive/halve-it-roadmap.md's own "common set"): 20, 16,
// double 7, 14, treble 10, 17, Bull.
const HALVE_IT_DEFAULT_TARGETS = [
  { sector: 20 },
  { sector: 16 },
  { sector: 7, ring: 'double' },
  { sector: 14 },
  { sector: 10, ring: 'treble' },
  { sector: 17 },
  { sector: 25 },
];
function halveItRoundTarget(round, targets){
  const list = (targets && targets.length) ? targets : HALVE_IT_DEFAULT_TARGETS;
  const idx = Math.min(round, list.length) - 1;
  return list[idx];
}
// A single dart's value against a given round target — 0 if it doesn't
// satisfy the target's sector (and ring, when restricted); mult*sector
// otherwise. Doubles as bull scoring for free: makeDartCore() already
// downgrades an attempted "treble bull" tap to a single (no treble-bull ring
// physically exists), so sector 25 never sees mult=3, and mult*sector already
// yields 25/50 for single/double bull without any bull-specific branch.
function halveItDartValue(d, target){
  if(!target || d.sector !== target.sector) return 0;
  if(target.ring && d.mult !== HALVE_IT_RING_MULT[target.ring]) return 0;
  return d.mult * d.sector;
}
// Halving rounds UP (docs/archive/halve-it-roadmap.md's own recommendation,
// since round-down can spiral a score to a permanent 0 — 1 -> 0 -> 0 forever
// — while round-up's floor is 1 -> 1, never lower).
function evaluateVisitHalveIt(player, darts, game){
  const round = game.halveItRound;
  const targets = (game.config && game.config.targets) || HALVE_IT_DEFAULT_TARGETS;
  const maxRounds = targets.length;
  const target = halveItRoundTarget(round, targets);
  let gained = 0;
  darts.forEach(d => { gained += halveItDartValue(d, target); });
  const halved = gained === 0;
  const priorTotal = player.total || 0;
  const total = halved ? Math.ceil(priorTotal / 2) : priorTotal + gained;
  const roundTotals = Object.assign({}, player.roundTotals, { [round]: total });
  const roundComplete = game.current === game.players.length - 1;
  let matchComplete = false, winnerIndex = null;
  if(roundComplete && round >= maxRounds){
    const totals = game.players.map((pl, i) => i === game.current ? total : (pl.total || 0));
    const maxTotal = Math.max(...totals);
    const leaders = totals.reduce((acc, t, i) => { if(t === maxTotal) acc.push(i); return acc; }, []);
    if(leaders.length === 1){ matchComplete = true; winnerIndex = leaders[0]; }
  }
  return { scored: gained, gained, halved, total, roundTotals, target, roundComplete, matchComplete, winnerIndex };
}

// rebuildBaseballState()/rebuildShanghaiState() with the round target keyed
// off config.targets instead of a hardcoded/parameterized number, and no
// instant-win branch to special-case (Halve-It never ends early).
function rebuildHalveItState({ names, legsPerSet, targets, turns }){
  // everHalved/lastVisitHalved: per-leg tracking the live UI reads to award
  // 🛡️ No Half Measures / 🪓 Halved at the Death — reconstructed here too so a
  // resumed leg's badge check still sees the leg's FULL halving history, not
  // just turns recorded after the resume.
  const players = names.map(name => ({ name, total:0, roundTotals:{}, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0,
    everHalved:false, lastVisitHalved:false }));
  let current = 0, starter = 0, setNo = 1, legNo = 1, halveItRound = 1, seenFirst = false;
  let pendingNewLeg = false, pendingNewSet = false;
  const resetLeg = (p, newSet) => { p.total = 0; p.roundTotals = {}; p.everHalved = false; p.lastVisitHalved = false; p.legDarts = 0; if(newSet) p.setDarts = 0; };
  for(const t of turns){
    if(seenFirst && (t.setNo !== setNo || t.legNo !== legNo)){
      starter = (starter + 1) % players.length;
      current = starter;
      const newSet = t.setNo !== setNo;
      players.forEach(p => resetLeg(p, newSet));
      setNo = t.setNo; legNo = t.legNo; halveItRound = 1;
    }
    seenFirst = true;
    pendingNewLeg = false; pendingNewSet = false;
    current = t.playerIndex;
    const p = players[t.playerIndex];
    const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
    const ev = evaluateVisitHalveIt(p, dartsCore, { players, current, halveItRound, config:{ targets } });
    p.total = ev.total; p.roundTotals = ev.roundTotals;
    p.lastVisitHalved = ev.halved;
    if(ev.halved) p.everHalved = true;
    p.legDarts += dartsCore.length; p.setDarts += dartsCore.length; p.gameDarts += dartsCore.length;
    if(ev.matchComplete){
      const w = players[ev.winnerIndex];
      w.legsWon += 1;
      if(w.legsWon >= legsPerSet){
        w.setsWon += 1;
        players.forEach(pp => { pp.legsWon = 0; });
        pendingNewSet = true;
      }
      pendingNewLeg = true;
      current = ev.winnerIndex;
    } else {
      if(ev.roundComplete) halveItRound += 1;
      current = (t.playerIndex + 1) % players.length;
    }
  }
  if(pendingNewLeg){
    starter = (starter + 1) % players.length;
    current = starter;
    players.forEach(p => resetLeg(p, pendingNewSet));
    if(pendingNewSet){ setNo += 1; legNo = 1; } else { legNo += 1; }
    halveItRound = 1;
  }
  return { players, current, starter, setNo, legNo, halveItRound };
}

/* ---------- The Pressure Chamber (docs/pressure-chamber-roadmap.md) ----------
   The single load-bearing design decision: a round's "Pressure Card" (target +
   modifier) is a PURE function of (gameId, roundIndex) — never stored, so
   there's no target_sector/modifier_id column to add. generatePressureCard()
   below is that function, reachable identically from the live client, the
   backend/db.js SEC-25-style write-time guard, and the read-time derived-CP
   queries — all three must agree on the exact same card for a given
   (gameId, roundIndex) or H2H's "identical sequence" and saved-games resume
   both break. */

// scoring.js's own copy of index.html's _seededIndex() (frontend/index.html,
// used by Daily Challenge) — duplicated rather than imported/exported because
// this file has no reach into index.html's globals and index.html's own copy
// isn't reachable from backend/db.js either; both need a deterministic
// string-hash-to-index function, so scoring.js carries its own. Identical
// hash formula, so a card generated by either side always agrees.
function _pcSeededIndex(s, mod){
  let h = 0;
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h) % mod;
}

// Curated target pool (docs/pressure-chamber-roadmap.md "Targets" — curated,
// not purely algorithmic, so a random roll can never land on something
// trivial like Single 5 or a genuinely unfinishable checkout). Two shapes:
// sector/ring targets (graded by gradePressureSectorRound() below) and finish
// targets (graded by reusing evaluateVisit() unmodified, per the roadmap doc).
// `difficulty` feeds the CP base value (PRESSURE_BASE_CP below); finish
// targets scale their own base off checkoutHint()'s optimal dart count
// instead (pressureFinishBaseCp()). Pool size (14) is a judgment call flagged
// as an open question in the roadmap doc itself ("curated pool size and
// rotation") — large enough that a 15-round run rarely repeats a target
// twice, small enough to stay hand-curated.
const PRESSURE_TARGET_POOL = [
  { type:'sector', sector:20, ring:'single', label:'Single 20',  difficulty:'single' },
  { type:'sector', sector:19, ring:'single', label:'Single 19',  difficulty:'single' },
  { type:'sector', sector:8,  ring:'single', label:'Single 8',   difficulty:'single' },
  { type:'sector', sector:20, ring:'double', label:'Double 20',  difficulty:'double' },
  { type:'sector', sector:16, ring:'double', label:'Double 16',  difficulty:'double' },
  { type:'sector', sector:10, ring:'double', label:'Double 10',  difficulty:'double' },
  { type:'sector', sector:1,  ring:'double', label:'Double 1',   difficulty:'double' },
  { type:'sector', sector:20, ring:'treble', label:'Treble 20',  difficulty:'treble' },
  { type:'sector', sector:19, ring:'treble', label:'Treble 19',  difficulty:'treble' },
  { type:'sector', sector:14, ring:'treble', label:'Treble 14',  difficulty:'treble' },
  { type:'sector', sector:25, ring:'double', label:'Bullseye',   difficulty:'bull' },
  { type:'finish', score:40,  label:'Finish 40',  difficulty:'finish' },
  { type:'finish', score:81,  label:'Finish 81',  difficulty:'finish' },
  { type:'finish', score:121, label:'Finish 121', difficulty:'finish' },
];
// Sector-target ring name -> the dart multiplier that satisfies it.
const PRESSURE_RING_MULT = { single:1, double:2, treble:3 };

// The 8 Pressure Modifiers (docs/pressure-chamber-roadmap.md "The 8 Pressure
// Modifiers"). `cpMultiplier` is the "modifier multiplier applied on top of
// the base" the roadmap doc calls for (Dead Calm 1.0 up through Sudden
// Death/Comeback's own ~1.5, per the doc's own explicit example — "Sudden
// Death Double 16 beats a no-modifier Triple 20"); `missMultiplier` doubles
// the miss penalty for Double Down/Comeback specifically (the doc's own
// wording); `comebackBonus` adds a flat bonus on top of a full hit's normal
// reward; `matchDart`/`suddenDeath`/`noWarmup` are engine flags consumed by
// the grading/timer logic below, not flavor text. Every exact numeric value
// here is a first-pass playtesting default per the roadmap doc's own framing
// ("not final") — the FORMULA'S SHAPE is what's tested, not these constants.
const PRESSURE_MODIFIERS = [
  { key:'dead_calm',    label:'Dead Calm',    icon:'🃏', cpMultiplier:1.0,
    flavor:'No modifier at all — the baseline stakes, unmodified. Sometimes the scariest of all.' },
  { key:'double_down',  label:'Double Down',  icon:'⚠️', cpMultiplier:1.0, missMultiplier:2,
    flavor:"This round's miss penalty is doubled." },
  { key:'comeback',     label:'Comeback',     icon:'🔁', cpMultiplier:1.4, missMultiplier:2, comebackBonus:true,
    flavor:'Recovering from a 20-point deficit — a hit earns a bonus, a miss doubles the penalty.' },
  { key:'audience',     label:'Audience',     icon:'👀', cpMultiplier:1.15,
    flavor:'Someone counts down from 10 out loud. (Unenforceable — honor system.)' },
  { key:'ghost_leg',    label:'Ghost Leg',    icon:'🦵', cpMultiplier:1.15,
    flavor:'Throw standing on one leg. (Unenforceable — honor system.)' },
  { key:'sudden_death', label:'Sudden Death', icon:'💀', cpMultiplier:1.5, suddenDeath:true,
    flavor:'The round stops the instant a dart misses the target entirely.' },
  { key:'match_dart',   label:'Match Dart',   icon:'🎯', cpMultiplier:1.3, matchDart:true,
    flavor:"Only this round's 3rd dart counts." },
  { key:'no_warmup',    label:'No Warmup',    icon:'⏱️', cpMultiplier:1.25, noWarmup:true,
    flavor:'5 seconds from card reveal to dart 1 — or the round is scored as a miss.' },
];
const PRESSURE_ROUNDS = 15;
const PRESSURE_NO_WARMUP_MS = 5000;

// The single load-bearing function: a round's card as a pure function of
// (gameId, roundIndex) — reachable identically from the live client,
// backend/db.js's write-time guard, and every read-time derived-CP query.
function generatePressureCard(gameId, roundIndex){
  const targetIdx = _pcSeededIndex(`${gameId}|${roundIndex}|target`, PRESSURE_TARGET_POOL.length);
  const modifierIdx = _pcSeededIndex(`${gameId}|${roundIndex}|modifier`, PRESSURE_MODIFIERS.length);
  return { round: roundIndex, target: PRESSURE_TARGET_POOL[targetIdx], modifier: PRESSURE_MODIFIERS[modifierIdx] };
}

// Sector/ring grading — "best of the round's darts" (docs/pressure-chamber-roadmap.md
// "Targets"): an exact ring+sector match on ANY dart = full hit; the sector
// hit but the wrong ring = partial; neither = miss. Under Match Dart
// (`matchDartOnly`), darts 1-2 are ignored entirely — only a genuine 3rd dart
// is ever consulted (an empty/short dart list under Match Dart, e.g. a
// Sudden Death round that never reached dart 3, is always a miss).
function gradePressureSectorRound(target, darts, matchDartOnly){
  const relevant = matchDartOnly ? (darts.length >= 3 ? [darts[2]] : []) : darts;
  let sawSector = false;
  for(const d of relevant){
    if(d.sector === target.sector){
      if(d.mult === PRESSURE_RING_MULT[target.ring]) return 'full';
      sawSector = true;
    }
  }
  return sawSector ? 'partial' : 'miss';
}

// Sudden Death's per-dart early-stop (docs/pressure-chamber-roadmap.md
// "Sudden Death" — "the round stops the instant a dart doesn't hit the
// target at all, not even a partial/wrong-ring hit"), mirroring
// evaluateDartDoublesPractice()'s {hit,ended,reason} shape exactly so the
// live UI can reuse the same per-dart-stop rendering pattern. Scoped to
// sector/ring targets only — a finish target's "hit" isn't a single binary
// per-dart event the way a sector target's is (see computePressureRoundResult()'s
// own comment on this judgment call).
function evaluateDartPressureSector(dart, target){
  const full = dart.sector === target.sector && dart.mult === PRESSURE_RING_MULT[target.ring];
  if(full) return { hit:true, ended:false, reason:null };
  return { hit:false, ended:true, reason: dart.sector === target.sector ? 'wrong-ring' : 'miss' };
}

// Base Composure Points by target difficulty (docs/pressure-chamber-roadmap.md
// "Composure Points formula" — "scaled by how hard it is to hit at all: single
// < double < treble < bullseye"). First-pass playtesting constants, per the
// roadmap doc's own framing — not final.
const PRESSURE_BASE_CP = { single:5, double:10, treble:15, bull:20 };
// Miss-penalty base, scaled the same way (smaller than the base CP, per the
// doc's "a separate, smaller miss-penalty value").
const PRESSURE_MISS_PENALTY_BASE = { single:2, double:4, treble:6, bull:8, finish:10 };

// A finish target's base CP scales with checkoutHint()'s own optimal dart
// count (docs/pressure-chamber-roadmap.md: "itself scaled by the dart count
// checkoutHint() says the optimal route needs — a 2-dart finish is worth less
// than a 3-dart one"). Always double-out (the standard "real" finish
// convention) — the roadmap doc doesn't pin this down explicitly, a judgment
// call documented here and in REFERENCE.md.
function pressureFinishBaseCp(score){
  const hint = checkoutHint(score, true, 3);
  const optimalDarts = hint ? hint.split(' ').length : 3;
  return 10 + optimalDarts * 5; // 1-dart:15, 2-dart:20, 3-dart:25
}
function pressureBaseCp(target){
  return target.type === 'finish' ? pressureFinishBaseCp(target.score) : (PRESSURE_BASE_CP[target.difficulty] || 5);
}
function pressureMissPenaltyBase(target){
  return target.type === 'finish' ? PRESSURE_MISS_PENALTY_BASE.finish : (PRESSURE_MISS_PENALTY_BASE[target.difficulty] || 2);
}
// The miss penalty a round's card alone determines — pure function of the
// card, no darts needed (docs/pressure-chamber-roadmap.md: "for every bust=1
// turn, re-run generatePressureCard(...) to recover that round's miss-penalty
// value"), which is exactly what lets a run's total be derived at read time
// without storing the penalty anywhere.
function pressureMissPenaltyForCard(card){
  const missBase = pressureMissPenaltyBase(card.target);
  const cpMult = card.modifier.cpMultiplier || 1;
  const missMult = card.modifier.missMultiplier || 1;
  return Math.round(missBase * cpMult * missMult);
}

// Grades one round's outcome ('full'|'partial'|'miss') against its card.
// Finish targets: reuses evaluateVisit() unmodified (a finish attempt is a
// normal X01 visit starting from remaining=target.score, always double-out —
// see pressureFinishBaseCp()'s own comment); no partial tier (a finish is
// legal or it isn't). Match Dart additionally requires the finish to land
// specifically on the 3rd dart (darts.length===3) — a checkout reached on
// dart 1 or 2 does NOT count, per the roadmap doc's explicit callout that
// this is the one place Match Dart changes finish-target semantics rather
// than just filtering which darts are read. Sudden Death has no special
// finish-target handling (a documented judgment call — see
// evaluateDartPressureSector()'s own comment): a finish target under Sudden
// Death grades exactly as it would under Dead Calm.
function pressureRoundOutcome(card, darts){
  const { target, modifier } = card;
  const isMatchDart = modifier.key === 'match_dart';
  if(target.type === 'finish'){
    const ev = evaluateVisit({ score: target.score, doubleOut:true }, darts, null);
    const landedOnDart3 = darts.length === 3;
    return (ev.win && (!isMatchDart || landedOnDart3)) ? 'full' : 'miss';
  }
  return gradePressureSectorRound(target, darts, isMatchDart);
}

// The Composure Points formula (docs/pressure-chamber-roadmap.md "Composure
// Points formula"): full hit = base x modifier multiplier; partial hit = half
// that; miss = lose the (separately scaled) miss penalty, doubled again under
// Double Down/Comeback (missMultiplier). Comeback additionally adds a flat
// bonus (half the base CP) on top of a full hit's normal reward. `gained` is
// always >=0 (satisfies turns.scored's existing non-negative validation
// unchanged, the same "store the gain, derive the rest" shape Halve-It's
// halving rule already uses); `missPenalty` is never stored directly — a
// run's total is SUM(scored) minus the derived sum of every missed round's
// own pressureMissPenaltyForCard(), recomputed at read time.
// `darts` must be full dart-core objects (makeDartCore()'s own {sector, mult,
// value, isDouble, ...} shape) whenever the card's target could be a finish
// target — pressureRoundOutcome()'s finish path calls evaluateVisit(), which
// needs `.value`/`.isDouble`, not just `.sector`/`.mult` (every caller in this
// codebase — backend/db.js's write-time guard, frontend/index.html's live
// commit — already deals exclusively in dart-core objects, so this is the
// same contract every other evaluateVisit*() function already assumes).
function computePressureRoundResult(card, darts){
  const outcome = pressureRoundOutcome(card, darts);
  const baseCp = pressureBaseCp(card.target);
  const cpMult = card.modifier.cpMultiplier || 1;
  let gained = 0, missPenalty = 0;
  if(outcome === 'full'){
    gained = Math.round(baseCp * cpMult);
    if(card.modifier.comebackBonus) gained += Math.round(baseCp * 0.5);
  } else if(outcome === 'partial'){
    gained = Math.round((baseCp * cpMult) / 2);
  } else {
    missPenalty = pressureMissPenaltyForCard(card);
  }
  return { outcome, gained, missPenalty };
}

// Composure Rating (docs/pressure-chamber-roadmap.md "Composure Rating"),
// derived at read time from a run's total CP, never stored. Since the
// thresholds are monotonic in totalCp, "the best rating ever reached" is
// always simply the rating of the single highest totalCp ever recorded — no
// separate tracking needed (see getPressureChamberPersonalBests(), backend/db.js).
function pressureComposureRating(totalCp){
  if(totalCp >= 120) return 'Ice';
  if(totalCp >= 90) return 'Steel';
  if(totalCp >= 60) return 'Copper';
  if(totalCp >= 30) return 'Tin';
  return 'Rattled';
}

// One-off flavor badge trigger conditions (docs/pressure-chamber-roadmap.md
// "Achievements") — each a pure predicate over a just-graded round, unit-
// tested per CLAUDE.md's "every new calculation gets a committed test" rule
// rather than only checked inline.
function isPressureIceRun(totalCp){ return pressureComposureRating(totalCp) === 'Ice'; }
function isPressureModifierFullHit(card, outcome, modifierKey){ return outcome === 'full' && card.modifier.key === modifierKey; }

// Solo-vs-H2H tie-breaking (docs/pressure-chamber-roadmap.md's own last "Open
// question" — left undecided there). Chosen convention, documented rather
// than left unhandled: highest total CP wins; a tie breaks on fewest total
// misses (the more composed run); a further tie breaks on fewest darts
// thrown (efficiency); a genuine, total coincidence beyond that resolves to
// whichever player is earlier in turn order. This always returns a definite
// winner rather than introducing a distinct "draw" result/UI class no other
// game type in this app has — real numeric CP totals make an exact 3-way tie
// vanishingly unlikely in practice. `totals` is one entry per player, in
// player-index order: {totalCp, misses, darts}.
function pressureChamberDecideWinnerIndex(totals){
  let bestIdx = 0;
  for(let i=1;i<totals.length;i++){
    const a = totals[bestIdx], b = totals[i];
    if(b.totalCp > a.totalCp) bestIdx = i;
    else if(b.totalCp === a.totalCp){
      if(b.misses < a.misses) bestIdx = i;
      else if(b.misses === a.misses && b.darts < a.darts) bestIdx = i;
    }
  }
  return bestIdx;
}

// Per-visit evaluator (docs/pressure-chamber-roadmap.md "Data model") — same
// shape as evaluateVisitHalveIt()/evaluateVisitShanghai(): all players in
// lockstep on one shared live round (game.pressureChamberRound), the round
// completing once the LAST player in rotation has thrown. `game.gameId` is
// the real games.id — the seed generatePressureCard() needs — set once at
// game creation/resume (frontend/index.html), never re-derived. Fixed at
// exactly config.rounds (15) with no extra-rounds extension (unlike
// Baseball/Shanghai/Halve-It's tie-breaking-by-more-rounds) — a tie at the
// final round resolves immediately via pressureChamberDecideWinnerIndex()
// above, so matchComplete/winnerIndex are always both set together once the
// final round's last player throws.
function evaluateVisitPressureChamber(player, darts, game){
  const round = game.pressureChamberRound;
  const card = generatePressureCard(game.gameId, round);
  const result = computePressureRoundResult(card, darts);
  const totalCp = (player.totalCp || 0) + result.gained;
  const misses = (player.misses || 0) + (result.outcome === 'miss' ? 1 : 0);
  const fullHits = (player.fullHits || 0) + (result.outcome === 'full' ? 1 : 0);
  const currentFullHitStreak = result.outcome === 'full' ? (player.currentFullHitStreak || 0) + 1 : 0;
  const bestFullHitStreak = Math.max(player.bestFullHitStreak || 0, currentFullHitStreak);
  const roundResults = Object.assign({}, player.roundResults, { [round]: result.outcome });
  const roundComplete = game.current === game.players.length - 1;
  const maxRounds = (game.config && game.config.rounds) || PRESSURE_ROUNDS;
  let matchComplete = false, winnerIndex = null;
  if(roundComplete && round >= maxRounds){
    const totals = game.players.map((pl, i) => i === game.current
      ? { totalCp, misses, darts: (pl.legDarts || 0) + darts.length }
      : { totalCp: pl.totalCp || 0, misses: pl.misses || 0, darts: pl.legDarts || 0 });
    matchComplete = true;
    winnerIndex = pressureChamberDecideWinnerIndex(totals);
  }
  return { scored: result.gained, gained: result.gained, missPenalty: result.missPenalty, outcome: result.outcome,
    card, target: card.target, modifier: card.modifier,
    totalCp, misses, fullHits, currentFullHitStreak, bestFullHitStreak, roundResults,
    roundComplete, matchComplete, winnerIndex };
}

// rebuildBaseballState()/rebuildShanghaiState()/rebuildHalveItState() with the
// round target parameterized by maxRounds (config.rounds) and gameId (the
// generatePressureCard() seed) instead of a hardcoded/parameterized number.
function rebuildPressureChamberState({ gameId, names, legsPerSet, maxRounds, turns }){
  const players = names.map(name => ({ name, totalCp:0, misses:0, fullHits:0,
    currentFullHitStreak:0, bestFullHitStreak:0, roundResults:{},
    legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0 }));
  let current = 0, starter = 0, setNo = 1, legNo = 1, pressureChamberRound = 1, seenFirst = false;
  let pendingNewLeg = false, pendingNewSet = false;
  const resetLeg = (p, newSet) => { p.totalCp=0; p.misses=0; p.fullHits=0; p.currentFullHitStreak=0; p.bestFullHitStreak=0; p.roundResults={}; p.legDarts=0; if(newSet) p.setDarts=0; };
  for(const t of turns){
    if(seenFirst && (t.setNo !== setNo || t.legNo !== legNo)){
      starter = (starter + 1) % players.length;
      current = starter;
      const newSet = t.setNo !== setNo;
      players.forEach(p => resetLeg(p, newSet));
      setNo = t.setNo; legNo = t.legNo; pressureChamberRound = 1;
    }
    seenFirst = true;
    pendingNewLeg = false; pendingNewSet = false;
    current = t.playerIndex;
    const p = players[t.playerIndex];
    const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
    const ev = evaluateVisitPressureChamber(p, dartsCore, { gameId, players, current, pressureChamberRound, config:{ rounds:maxRounds } });
    p.totalCp = ev.totalCp; p.misses = ev.misses; p.fullHits = ev.fullHits;
    p.currentFullHitStreak = ev.currentFullHitStreak; p.bestFullHitStreak = ev.bestFullHitStreak;
    p.roundResults = ev.roundResults;
    p.legDarts += dartsCore.length; p.setDarts += dartsCore.length; p.gameDarts += dartsCore.length;
    if(ev.matchComplete){
      const w = players[ev.winnerIndex];
      w.legsWon += 1;
      if(w.legsWon >= legsPerSet){
        w.setsWon += 1;
        players.forEach(pp => { pp.legsWon = 0; });
        pendingNewSet = true;
      }
      pendingNewLeg = true;
      current = ev.winnerIndex;
    } else {
      if(ev.roundComplete) pressureChamberRound += 1;
      current = (t.playerIndex + 1) % players.length;
    }
  }
  if(pendingNewLeg){
    starter = (starter + 1) % players.length;
    current = starter;
    players.forEach(p => resetLeg(p, pendingNewSet));
    if(pendingNewSet){ setNo += 1; legNo = 1; } else { legNo += 1; }
    pressureChamberRound = 1;
  }
  return { players, current, starter, setNo, legNo, pressureChamberRound };
}

// Around the Clock (solo, guided drill) — a "round" is one leg, ended by
// evaluateDartAroundTheClock()'s own `completed` flag rather than a leg-win
// visit; no starter rotation (always the one player). Each recorded turn is a
// single dart (this mode's own per-dart-turn shape, mirroring Doubles
// Practice/Chuckin — see throwDartAroundTheClock()).
function rebuildAroundTheClockState({ turns }){
  let hitSet = new Set(), roundDarts = 0, legNo = 1, roundOver = false, seenFirst = false;
  for(const t of turns){
    if(seenFirst && t.legNo !== legNo){ hitSet = new Set(); roundDarts = 0; roundOver = false; legNo = t.legNo; }
    seenFirst = true;
    const dart = makeDartCore(t.darts[0].sector, t.darts[0].mult);
    const ev = evaluateDartAroundTheClock(dart, hitSet);
    roundDarts += 1;
    if(ev.isNewHit) hitSet.add(dart.sector);
    roundOver = ev.completed;
  }
  return { hitSet, roundDarts, legNo, roundOver };
}

// Bob's 27 (solo — docs/archive/practice-ladders-roadmap.md Part A) — one
// visit per round, round derived purely from replay position (the 1st turn is
// round 1/D1, the 2nd is round 2/D2, ...), no starter rotation (always the one
// player) and no leg/set concept at all: a run IS the whole game, so a SAVED
// bobs_27 game's turns can never include the fatal or 20th-round-completing
// visit (either one finishes the game immediately, at which point it's no
// longer savable) — every turn here is guaranteed mid-run, `running` always
// positive, `round` always landing 1-20 for the resumed player's next visit.
function rebuildBobs27State({ turns }){
  let running = 27, round = 1;
  for(const t of turns){
    const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
    const ev = evaluateVisitBobs27({ running }, dartsCore, { bobs27Round: round });
    running = ev.running;
    round += 1;
  }
  return { running, round };
}

// The 121 Checkout Ladder (docs/archive/practice-ladders-roadmap.md Part B) — solo
// only, so no starter rotation/leg-set structure to replay: every leg_no is
// simply this player's own next attempt in sequence. Each attempt reuses
// evaluateVisit() UNMODIFIED (this game type's whole design is "an ordinary
// X01 visit, just starting from a target that isn't 501/301/etc") — replayed
// with player.score seeded from that attempt's own target and doubleOut
// forced true (the ladder is always double-out, the classic rule). The
// target itself is re-derived leg by leg (121, +1 per win, -1 per fail,
// floor 61) — never trusted from any stored value, same "replay, not
// snapshot" contract every other rebuild*State() function follows.
function rebuildCheckoutLadderState({ turns }){
  const byLeg = new Map();
  turns.forEach(t => { if(!byLeg.has(t.legNo)) byLeg.set(t.legNo, []); byLeg.get(t.legNo).push(t); });
  const legNos = Array.from(byLeg.keys()).sort((a,b)=>a-b);
  let target = 121, currentLeg = 1, remaining = target, visitsThisLeg = 0;
  for(const ln of legNos){
    const legTurns = byLeg.get(ln);
    const player = { score: target, doubleOut: true };
    let won = false, lastRemaining = target;
    for(const t of legTurns){
      const dartsCore = t.darts.map(d => makeDartCore(d.sector, d.mult));
      const ev = evaluateVisit(player, dartsCore, {});
      if(!ev.bust) player.score = ev.newScore;
      lastRemaining = player.score;
      if(ev.win){ won = true; break; }
    }
    const resolved = won || legTurns.length >= 3;
    if(resolved){
      // Capped at 170 (same reasoning as the write-time guard in db.js's
      // addTurn(): turns.target_score is a shared column whose valid range
      // tops out at 170, the highest possible double-out finish).
      target = won ? Math.min(170, target + 1) : Math.max(61, target - 1);
      currentLeg = ln + 1;
      remaining = target;
      visitsThisLeg = 0;
    } else {
      currentLeg = ln;
      remaining = lastRemaining;
      visitsThisLeg = legTurns.length;
    }
  }
  return { target, legNo: currentLeg, remaining, visitsThisLeg };
}

/* ---------- The Gauntlet (docs/archive/gauntlet-roadmap.md) ----------
   A solo endurance drill: 20 stations, one per board number, in a FIXED
   clock-adjacency order — identical on every run, forever, so unlike
   Pressure Chamber's per-game seeded card sequence there is no generation
   step here at all. */
const GAUNTLET_STATION_ORDER = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5];

// Strictly positional grading, no re-matching across positions (docs/gauntlet-
// roadmap.md "At each station" — an inference flagged as such in that doc's
// own Open Questions, adopted here per its stated default): dart 1 must be
// the station's single, dart 2 its treble, dart 3 its double, each judged
// only against its own slot regardless of what the OTHER darts this attempt
// happened to hit. Always exactly 3 darts (no early-completion condition the
// way X01 has bust/win) — darts[i] undefined counts as a miss for that slot.
function evaluateGauntletStation(stationNumber, darts){
  const wantSingle = d => !!d && d.sector === stationNumber && d.mult === 1;
  const wantTreble = d => !!d && d.sector === stationNumber && d.isTreble;
  const wantDouble = d => !!d && d.sector === stationNumber && d.isDouble;
  const checks = [wantSingle, wantTreble, wantDouble];
  const hits = [0,1,2].map(i => checks[i](darts[i]));
  const misses = hits.filter(h => !h).length;
  return { hits, misses };
}

// Total Scars across every station: the final (post-any-repeat) miss count
// summed, DOUBLED for any station whose final result is 3 misses (a Deep
// Scar) — derived here, never stored pre-multiplied, same "store the raw
// number, derive the special-case scaling" shape Halve-It's halving rule
// uses. `finalMisses` is one integer (0-3) per station, in any order.
function gauntletTotalScars(finalMisses){
  return finalMisses.reduce((sum, m) => sum + (m === 3 ? 6 : m), 0);
}
const GAUNTLET_RESULT_TIERS = [
  { max:5,  label:'Unmarked' },
  { max:12, label:'Scarred but Standing' },
  { max:20, label:'Bloodied' },
  { max:30, label:'Broken Down' },
  { max:Infinity, label:'The Gauntlet Wins' },
];
function gauntletResultTier(totalScars){
  return GAUNTLET_RESULT_TIERS.find(t => totalScars <= t.max).label;
}

// Pure replay for resume (docs/archive/saved-games-roadmap.md) and for the
// write-time sequence/repeat-count guards (backend/db.js) — both need the
// exact same "which stations are settled, and is one awaiting its one
// allowed repeat" derivation, so it lives here once. `turns`: ordered
// (insertion order) {targetScore (station number), scored (this attempt's
// miss count)} rows for one game. A station settles the moment either its
// first attempt scores something other than 2, or a second attempt (the
// repeat) exists for it at all — the repeat's own result is authoritative
// regardless of what it comes back as.
function rebuildGauntletState({ turns }){
  const byStation = new Map(); // station -> array of {scored} in submission order
  turns.forEach(t => {
    if(!byStation.has(t.targetScore)) byStation.set(t.targetScore, []);
    byStation.get(t.targetScore).push(t.scored);
  });
  const finalMisses = [];
  let pendingRepeatStation = null;
  for(const station of GAUNTLET_STATION_ORDER){
    const attempts = byStation.get(station);
    if(!attempts || attempts.length === 0) break; // this and every later station: not yet reached
    if(attempts.length === 1 && attempts[0] === 2){ pendingRepeatStation = station; break; }
    finalMisses.push(attempts[attempts.length - 1]); // settled — last attempt (only one, or the repeat) is authoritative
  }
  const settledCount = finalMisses.length;
  const currentStation = pendingRepeatStation != null ? pendingRepeatStation : GAUNTLET_STATION_ORDER[settledCount];
  const awaitingRepeat = pendingRepeatStation != null;
  return {
    finalMisses, settledCount, currentStation, awaitingRepeat,
    totalScars: gauntletTotalScars(finalMisses),
    done: settledCount === GAUNTLET_STATION_ORDER.length,
  };
}

/* ---------- Killer (docs/archive/game-modes-roadmap.md "Killer") ----------
   Elimination-format H2H: each player is randomly assigned their own number
   once per MATCH (not re-rolled per leg — the same assignment carries across
   every leg, only a genuine new match/rematch re-rolls). Hitting your own
   number builds lives toward becoming a "killer" — scaled by ring like every
   other score in this app (single=1, double=2, treble=3). Once a killer,
   hitting an OPPONENT's number removes lives from THEIR total at the same
   scaled rate; hitting your own double again after becoming a killer costs a
   flat 1 life (self-kill) — the one place the multiplier doesn't matter, and
   a single/treble on your own number post-killer is a documented no-op.
   Per-dart evaluation (the Doubles Practice precedent): a player can cross
   the killer threshold on dart 1 of a visit and use darts 2-3 of that SAME
   visit to attack, so turn-passing still happens per 3-dart visit (or
   earlier, if a self-kill eliminates the thrower mid-visit) but each dart's
   CONSEQUENCE is evaluated immediately, never batched like X01/Cricket. */
const KILLER_DEFAULT_LIVES = 3;

// Fisher-Yates over an injectable RNG (defaults to Math.random in production;
// tests pass a deterministic one) so the shuffle itself stays unit-testable
// without mocking the global Math object.
function shuffleKillerNumbers(pool, rng){
  const r = rng || Math.random;
  const arr = pool.slice();
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(r() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}
// Randomly assigns each player a distinct number 1-20 (docs/archive/game-modes-
// roadmap.md: "assigning numbers randomly at Start is the pragmatic digital
// equivalent" of the physical non-dominant-hand throw). Returns { [name]: number }.
function assignKillerNumbers(names, rng){
  const pool = shuffleKillerNumbers([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20], rng);
  const out = {};
  names.forEach((name, i) => { out[name] = pool[i]; });
  return out;
}

// Pure per-dart evaluation. `players` is every player in this leg (eliminated
// ones included — their number stays theirs even after death, so an
// already-eliminated player's number is still recognized, just a no-op to
// hit) as {name, number, lives, isKiller, eliminated}. Returns null for a
// dart that changes nothing at all (a miss, an unclaimed number, hitting an
// already-eliminated player's number, or a post-killer non-double re-hit of
// your own number) — the caller applies a non-null result's delta to
// `affectedName`'s own lives (gain: add; loss: subtract, floored at 0).
function evaluateDartKiller(dart, throwerName, players){
  const thrower = players.find(p => p.name === throwerName);
  const hitPlayer = players.find(p => p.number === dart.sector);
  if(!hitPlayer || hitPlayer.eliminated) return null;

  if(hitPlayer.name === throwerName){
    if(!thrower.isKiller){
      return { affectedName: throwerName, delta: dart.mult, isGain: true, selfKill: false };
    }
    // Already a killer: only your own DOUBLE costs a life (flat 1, never
    // scaled by multiplier) — a single/treble here is a documented no-op.
    if(dart.isDouble) return { affectedName: throwerName, delta: 1, isGain: false, selfKill: true };
    return null;
  }

  // Someone else's number — only a killer can attack.
  if(!thrower.isKiller) return null;
  return { affectedName: hitPlayer.name, delta: dart.mult, isGain: false, selfKill: false };
}

// Pure replay for the write-time consistency guard (backend/db.js): given
// every prior dart thrown this leg (in order), reconstructs each player's
// lives/killer/eliminated state and whether the leg has already been won.
// Does NOT track "whose turn is next" — matching every other existing
// consistency guard's scope (SEC-22/SEC-25 verify the ARITHMETIC of a
// submitted turn, never enforce turn order server-side; the client is
// trusted for sequencing the same way it already is everywhere else).
// `turns`: ordered {throwerName, sector, mult} rows for one leg.
// `numbers`: this match's own {name: number} assignment (leg-invariant).
// `kills` (opponents THIS player personally eliminated via attack, never via
// someone else's self-kill) and `livesLost` (total magnitude of losses this
// player absorbed, attacks + self-kills combined) ride alongside each
// player's own lives/killer/eliminated state — both needed for stats
// (kills-per-game, avg lives lost per leg) as well as live display, derived
// here once rather than recomputed by a second replay pass.
function rebuildKillerState({ names, numbers, turns, threshold }){
  const liveThreshold = threshold || KILLER_DEFAULT_LIVES;
  const players = names.map(name => ({ name, number: numbers[name], lives: 0, isKiller: false, eliminated: false, kills: 0, livesLost: 0 }));
  const byName = new Map(players.map(p => [p.name, p]));
  let winner = null;
  turns.forEach(t => {
    if(winner) return; // defensive: no legitimate turn should exist after the leg's already won
    const thrower = byName.get(t.throwerName);
    if(!thrower || thrower.eliminated) return; // an eliminated player's turn can't affect anything
    const dart = { sector: t.sector, mult: t.mult, isDouble: t.mult === 2 && t.sector !== 0 };
    const ev = evaluateDartKiller(dart, t.throwerName, players);
    if(ev){
      const affected = byName.get(ev.affectedName);
      if(ev.isGain){
        affected.lives += ev.delta;
        if(!affected.isKiller && affected.lives >= liveThreshold) affected.isKiller = true;
      } else {
        affected.lives = Math.max(0, affected.lives - ev.delta);
        affected.livesLost += ev.delta;
        if(affected.lives === 0 && !affected.eliminated){
          affected.eliminated = true;
          if(ev.affectedName !== t.throwerName) thrower.kills += 1;
        }
      }
    }
    const alive = players.filter(p => !p.eliminated);
    if(alive.length === 1 && players.length > 1) winner = alive[0].name;
  });
  return { players, winner };
}

// Around the World (solo, guided drill) — no round/leg concept at all (one
// continuous stream, set_no=leg_no=1 for the whole session, same as Just
// Chuckin' It). Its real lifetime progress is refetched fresh at resume time
// the same way newMatchPlayerAroundTheWorld() always does at any game start —
// this only needs to restore the session dart COUNT, a cosmetic display
// figure; which specific outcomes were "this session" vs. baseline is exactly
// the kind of session-scoped bookkeeping the roadmap doc's own "what resume
// deliberately does NOT rebuild" section accepts losing (the combined lifetime
// progress total stays fully correct either way, since that's server-derived,
// not built from this count).
function rebuildAroundTheWorldState({ turns }){
  return { sessionDarts: turns.length };
}

// Marathon Mode (docs/archive/marathon-mode-roadmap.md) — the two genuinely new
// calculations this feature needs; every leg itself is an ordinary,
// unmodified X01 practice leg. Both take a plain array of dart counts, one
// per leg, in play order.
const MARATHON_FATIGUE_TIERS = [
  { max: 2,        tier: 'Iron' },
  { max: 5,        tier: 'Tested' },
  { max: 9,        tier: 'Fading' },
  { max: Infinity, tier: 'Running on Empty' },
];
// First half vs. second half average dart count (floor the split on an odd
// leg count, per the roadmap doc: the smaller half is first). Clamped at
// zero — a player who got FASTER in the second half isn't a fatigue problem
// to score against them, so that reads identically to zero fatigue (Iron),
// not a negative/bonus value. A 0- or 1-leg session has no second half to
// compare against and reads as a flat 0 (no evidence of fatigue either way).
function computeFatigueSplit(dartCountsPerLeg){
  const n = dartCountsPerLeg.length;
  const half = Math.floor(n / 2);
  const first = dartCountsPerLeg.slice(0, half);
  const second = dartCountsPerLeg.slice(half);
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const firstAvg = avg(first), secondAvg = avg(second);
  const split = (firstAvg == null || secondAvg == null) ? 0 : Math.max(0, secondAvg - firstAvg);
  const tier = MARATHON_FATIGUE_TIERS.find(t => split <= t.max).tier;
  return { split: Math.round(split * 100) / 100, tier };
}
const MARATHON_TREND_MIN_LEGS = 6;   // first-pass floor, matching this doc's own
                                      // "don't compute a trend on too small a
                                      // sample" call — not confirmed against real
                                      // sessions yet, tunable.
const MARATHON_TREND_TOLERANCE = 2;  // dart-count band width for "roughly equal";
                                      // also a first-pass number, per the roadmap
                                      // doc's own flagged open question.
// Splits the session into three roughly-equal segments (floor-sized early/middle,
// remainder in late — same "smaller segments first" shape computeFatigueSplit()
// uses) and reads the shape of the trend across them. Fewer than
// MARATHON_TREND_MIN_LEGS legs, or a shape that doesn't cleanly match one of the
// three named patterns (e.g. a steady gradual climb, or fatigue then partial
// recovery), returns 'Inconclusive' rather than forcing a label onto ambiguous
// data.
function classifyMarathonTrend(dartCountsPerLeg){
  const n = dartCountsPerLeg.length;
  if(n < MARATHON_TREND_MIN_LEGS) return 'Inconclusive';
  const third = Math.floor(n / 3);
  const early = dartCountsPerLeg.slice(0, third);
  const middle = dartCountsPerLeg.slice(third, third * 2);
  const late = dartCountsPerLeg.slice(third * 2);
  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const earlyAvg = avg(early), middleAvg = avg(middle), lateAvg = avg(late);
  const within = (a, b) => Math.abs(a - b) <= MARATHON_TREND_TOLERANCE;

  if(within(earlyAvg, middleAvg) && within(middleAvg, lateAvg) && within(earlyAvg, lateAvg)) return 'Flat Line';
  if(within(earlyAvg, middleAvg) && (lateAvg - middleAvg) > MARATHON_TREND_TOLERANCE) return 'The Cliff';
  if((earlyAvg - middleAvg) > MARATHON_TREND_TOLERANCE && within(middleAvg, lateAvg)) return 'The Warm Machine';
  return 'Inconclusive';
}

/* ---------- Dead Man Walking (docs/archive/dead-man-walking-roadmap.md) ----------
   A 15-round solo drill: each round drops the player onto a real X01 checkout
   deficit pulled from their OWN weakest historical finishes, with a
   personalized "par minus one" dart budget. Close it -> Walked Out. Bust, or
   run out of darts -> Executed. Structurally the closest existing precedent is
   the 121 Checkout Ladder (real X01-shaped visits from a non-501 deficit), but
   two things are genuinely different here, both handled below:
   (1) the starting number and the dart budget are PERSONALIZED and computed
   ONCE, server-side, at game creation (backend/db.js's getWeakestCheckouts()
   + the par calculation), frozen into games.config.rounds — a client never
   supplies or influences them;
   (2) a bust or a run-out-of-budget must end the ROUND (leg) IMMEDIATELY,
   unlike the Checkout Ladder's forgiving up-to-3-visits-per-attempt shape —
   there's no second visit to try again within the same round. That's what
   makes evaluateDeadManDart() a genuinely new PER-DART evaluator (the
   Doubles Practice precedent for live per-dart evaluation) rather than a
   reuse of evaluateVisit()'s own per-VISIT bust logic. */

// Difficulty bands for the par calculation (docs/archive/dead-man-walking-roadmap.md
// "Par" — "bands: roughly Low 32-60 / Mid 61-100 / High 101-170, continuous
// banding is a fine alternative, not load-bearing"). Three bands is this
// build's chosen granularity — a first pass, not confirmed against real play,
// per the roadmap doc's own "Band granularity" open question.
const DEAD_MAN_WALKING_BANDS = [
  { low: 32,  high: 60,  name: 'low'  },
  { low: 61,  high: 100, name: 'mid'  },
  { low: 101, high: 170, name: 'high' },
];
function deadManWalkingBandFor(target){
  return DEAD_MAN_WALKING_BANDS.find(b => target >= b.low && target <= b.high) || DEAD_MAN_WALKING_BANDS[DEAD_MAN_WALKING_BANDS.length - 1];
}

// Par = the player's own historical average total darts-to-finish for
// checkouts in the same band (historicalAverage, null if no history in that
// band — the caller, backend/db.js, computes it from real X01 legs), floored
// at the objective-optimal dart count (checkoutHint()) plus 1 so `par - 1`
// (the round's actual dart budget) can never drop below the theoretical
// minimum — the one concrete correctness fix this doc's own design makes over
// the original pitch's literal "par minus one" wording (see the roadmap doc's
// "Par" section: using the objective optimal AS par directly would make every
// round mathematically impossible). With no history yet in this band, par
// defaults to objectiveOptimal + 2 — a generous grace amount so the mode is
// playable session one without inventing a fake historical average.
// `target` must be a genuinely finishable double-out score (checkoutHint()
// returns a non-empty route) — every real caller (getWeakestCheckouts()'s
// pool, the CHALLENGE_CHECKOUTS cold-start fallback) already guarantees this.
function deadManWalkingParForTarget(target, historicalAverage){
  const hint = checkoutHint(target, true, 3);
  const objectiveOptimal = hint ? hint.split(' ').length : 1;
  const floor = objectiveOptimal + 1;
  if(historicalAverage != null) return Math.max(historicalAverage, floor);
  return objectiveOptimal + 2;
}

// Draws `n` targets from `pool` WITH REPLACEMENT (docs/dead-man-walking-
// roadmap.md "15 are drawn from it, with repeats allowed if a player's
// genuinely-weak pool is smaller than 15") — uniform random, same injectable-
// rng shape as shuffleKillerNumbers() so a test can steer it deterministically.
// Never called with an empty pool (the caller always falls back to
// CHALLENGE_CHECKOUTS first).
function pickDeadManWalkingTargets(pool, n, rng){
  const r = rng || Math.random;
  const out = [];
  for(let i = 0; i < n; i++) out.push(pool[Math.floor(r() * pool.length)]);
  return out;
}

// The pure per-dart evaluator (docs/archive/dead-man-walking-roadmap.md "Execution —
// per-dart evaluation, not per-visit") — generalizes evaluateVisit()'s own
// bust/win logic from "the sum of a whole visit" to "one dart against a
// running remaining," since a bust or a finish here must end the round the
// instant it happens, not wait for a 3-dart batch boundary. Budget/"out of
// darts" is NOT this function's concern (it takes only remaining/dart/
// doubleOut, no budget) — that's a separate, composable check layered on top
// by resolveDeadManDart() below, which both frontend/index.html's live UI and
// backend/db.js's write-time guard share so they can never disagree.
function evaluateDeadManDart(remaining, dart, doubleOut){
  const newRemaining = remaining - dart.value;
  let bust = false, win = false;
  if(newRemaining < 0) bust = true;
  else if(doubleOut && newRemaining === 1) bust = true;
  else if(newRemaining === 0){
    if(doubleOut && !dart.isDouble) bust = true;
    else win = true;
  }
  return { newRemaining: bust ? remaining : newRemaining, bust, win };
}

// Composes evaluateDeadManDart() with the round's own dart budget:
// `dartsUsedThisRound` is how many darts this round has ALREADY consumed
// (across any earlier visits this same round), `budget` is the round's total
// dart allowance (par - 1). A dart that neither busts nor wins but exhausts
// the budget still ends the round — "Executed, out of darts" — a real, valid,
// non-bust visit that simply ran out of room (scored keeps its real point
// value; see backend/db.js's write-time guard for why this is NOT stored as
// bust=1 the way a genuine bust is). `roundOver` is true for all three
// terminal outcomes (win/bust/outOfDarts); only one continue path remains.
function resolveDeadManDart(remaining, dart, doubleOut, dartsUsedThisRound, budget){
  const ev = evaluateDeadManDart(remaining, dart, doubleOut);
  const dartsUsedAfter = dartsUsedThisRound + 1;
  const outOfDarts = !ev.bust && !ev.win && dartsUsedAfter >= budget;
  return { newRemaining: ev.newRemaining, bust: ev.bust, win: ev.win, outOfDarts,
    roundOver: ev.bust || ev.win || outOfDarts };
}

// Result tiers (docs/archive/dead-man-walking-roadmap.md "Result tiers") — derived at
// read time from the count of Walked Out rounds out of 15, never stored.
// Exact thresholds are a first pass for playtesting, same "not final" caveat
// every other tiered result in this doc set carries.
const DEAD_MAN_WALKING_RESULT_TIERS = [
  { min: 13, max: 15, label: 'Pardoned'    },
  { min: 10, max: 12, label: 'Reprieve'    },
  { min: 7,  max: 9,  label: 'Last Rites'  },
  { min: 4,  max: 6,  label: 'The Walk'    },
  { min: 0,  max: 3,  label: 'Executed'    },
];
function deadManWalkingResultTier(walkedOutCount){
  const t = DEAD_MAN_WALKING_RESULT_TIERS.find(t => walkedOutCount >= t.min && walkedOutCount <= t.max);
  return t ? t.label : 'Executed';
}

// Pure replay for the write-time guard, saved-game resume, and stats — the
// same "replay, not snapshot" contract every rebuild*State() function above
// follows. Unlike every other rebuild function, this one needs the game's own
// FROZEN config (`rounds`, an array of 15 {target, par} pairs computed once
// server-side at creation — see backend/db.js's createGame()) since a round's
// target/budget isn't derivable from the turns alone the way Checkout
// Ladder's climbing target is. `turns`: ordered (insertion order) per-leg
// groups of {legNo, darts:[{sector,mult}]} — a leg can span more than one
// (1-3-dart) turn/visit, replayed dart-by-dart via resolveDeadManDart() until
// that round settles or the recorded turns run out (a live/resumed game).
// Always double-out (matches the source data getWeakestCheckouts() draws
// from, and Checkout Ladder's own "always double-out regardless of this
// player's own X01 preference" precedent).
function rebuildDeadManWalkingState({ rounds, turns }){
  const byLeg = new Map();
  turns.forEach(t => { if(!byLeg.has(t.legNo)) byLeg.set(t.legNo, []); byLeg.get(t.legNo).push(t); });
  const legNos = Array.from(byLeg.keys()).sort((a, b) => a - b);
  const totalRounds = rounds.length;
  let walkedOutCount = 0, roundIndex = 0, dartsUsedThisRound = 0;
  let remaining = totalRounds ? rounds[0].target : 0;
  // One boolean per SETTLED round, in order — the frontend's own resume-time
  // streak re-derivation (undoing a badge-trigger tracker's loss on refresh,
  // the same "recompute from the settled history" shape every other resumed
  // game type's own streak/deficit trackers use) reads this directly instead
  // of re-scanning raw turns for a `checkout` field the resume payload
  // doesn't even carry.
  const walkedOutRounds = [];
  for(const ln of legNos){
    const idx = ln - 1;
    const round = rounds[idx];
    if(!round) break; // defensive: a leg beyond the frozen 15 rounds shouldn't exist
    const budget = round.par - 1;
    let rem = round.target, used = 0, settled = false, walked = false;
    outer:
    for(const t of byLeg.get(ln)){
      for(const d of t.darts){
        const r = resolveDeadManDart(rem, makeDartCore(d.sector, d.mult), true, used, budget);
        used += 1;
        rem = r.newRemaining;
        if(r.roundOver){ settled = true; walked = r.win; break outer; }
      }
    }
    if(settled){
      walkedOutRounds.push(walked);
      if(walked) walkedOutCount += 1;
      roundIndex = idx + 1;
      dartsUsedThisRound = 0;
      remaining = rounds[roundIndex] ? rounds[roundIndex].target : 0;
    } else {
      roundIndex = idx;
      dartsUsedThisRound = used;
      remaining = rem;
    }
  }
  return {
    walkedOutCount, roundIndex, remaining, dartsUsedThisRound, walkedOutRounds,
    done: roundIndex >= totalRounds,
    budget: rounds[roundIndex] ? rounds[roundIndex].par - 1 : 0,
  };
}

// Daily Challenge's curated checkout-target pool (docs/daily-challenge-roadmap.md)
// — Dead Man Walking's own cold-start fallback for a player with too little
// double-out X01 history for a confident weakness ranking reuses this exact
// array (docs/archive/dead-man-walking-roadmap.md "Cold start": "reuse existing
// curated content... rather than inventing a second curated list"), which is
// why it lives here instead of only in frontend/index.html — backend/db.js's
// createGame() needs it server-side too.
const CHALLENGE_CHECKOUTS = [121, 96, 100, 141, 170, 40, 32, 50, 60, 80, 110, 130];

// Only executes under Node (require()'d from a test file) — undefined in a
// browser, so this is a no-op there and every name above stays a plain global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dartValue, dartLabel, makeDartCore,
    evaluateVisit, evaluateVisitCricket, CRICKET_STANDARD_NUMBERS, CRICKET_ALL_NUMBERS,
    evaluateVisitBaseball, baseballInningTarget, isBaseballCycle, parseSqliteTimestamp,
    evaluateDartDoublesPractice, evaluateDartAroundTheClock, isStaircaseFinish,
    isBedAndBreakfast, isMadhouseFinish, isShanghaiVisit,
    CO_DOUBLES, CO_FAV_D, CO_FIRSTS, coTreble, coSingle, coSetup, coFinish2, coFinish3, checkoutHint,
    pickCheckoutTarget, CHECKOUT_TRAINER_DIFFICULTY_TIERS, gradeCheckoutAttempt, blitzDeadlinePassed, isPhotoFinishSubmission,
    CHECKOUT_TRAINER_TRICK_CHANCE, listUnsolvableTargets, gradeCheckoutDeclaration,
    CHALLENGE_STREAK_WEEK, CHALLENGE_STREAK_MONTH, challengeBadgeSignals,
    chuckinTiersReached,
    isCricketWhitewash, CRICKET_COMEBACK_THRESHOLD, cricketComebackAchieved, cricketStoneColdAchieved,
    evaluateVisitBobs27, isBobs27FullHouse, isBobs27FullAnderson,
    rebuildX01State, rebuildCricketState, rebuildBaseballState,
    rebuildAroundTheClockState, rebuildAroundTheWorldState, rebuildBobs27State,
    rebuildCheckoutLadderState,
    GAUNTLET_STATION_ORDER, evaluateGauntletStation, gauntletTotalScars, gauntletResultTier,
    rebuildGauntletState,
    KILLER_DEFAULT_LIVES, shuffleKillerNumbers, assignKillerNumbers, evaluateDartKiller, rebuildKillerState,
    MARATHON_FATIGUE_TIERS, computeFatigueSplit, MARATHON_TREND_MIN_LEGS, MARATHON_TREND_TOLERANCE, classifyMarathonTrend,
    shanghaiRoundTarget, isShanghaiWin, evaluateVisitShanghai, rebuildShanghaiState,
    HALVE_IT_DEFAULT_TARGETS, halveItRoundTarget, halveItDartValue, evaluateVisitHalveIt, rebuildHalveItState,
    DEAD_MAN_WALKING_BANDS, deadManWalkingBandFor, deadManWalkingParForTarget, pickDeadManWalkingTargets,
    evaluateDeadManDart, resolveDeadManDart, DEAD_MAN_WALKING_RESULT_TIERS, deadManWalkingResultTier,
    rebuildDeadManWalkingState, CHALLENGE_CHECKOUTS,
    _pcSeededIndex, PRESSURE_TARGET_POOL, PRESSURE_MODIFIERS, PRESSURE_RING_MULT, PRESSURE_ROUNDS, PRESSURE_NO_WARMUP_MS,
    generatePressureCard, gradePressureSectorRound, evaluateDartPressureSector,
    PRESSURE_BASE_CP, PRESSURE_MISS_PENALTY_BASE, pressureFinishBaseCp, pressureBaseCp, pressureMissPenaltyBase,
    pressureMissPenaltyForCard, pressureRoundOutcome, computePressureRoundResult, pressureComposureRating,
    isPressureIceRun, isPressureModifierFullHit, pressureChamberDecideWinnerIndex,
    evaluateVisitPressureChamber, rebuildPressureChamberState,
  };
}
