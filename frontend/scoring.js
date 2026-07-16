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
  // penalty is DERIVED at replay time from scored===0 (docs/halve-it-roadmap.md's
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
// (docs/shanghai-roadmap.md), which is its own separate thing entirely (see
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
  };
}
