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

/* ---------- Cricket ----------
   Standard cricket only (v1 scope decision) — highest score wins, cut-throat
   deferred. A match's in-play numbers are locked to exactly 7 (classic:
   15,16,17,18,19,20,Bull, or a custom 7-of-21 selection made at New Game time),
   stored as game.config.numbers. */
const CRICKET_STANDARD_NUMBERS = [15,16,17,18,19,20,25];

// Pure per-dart scoring function, validated standalone against 12 hand-checked
// scenarios (mark accumulation within a visit, closing-vs-scoring marks, opponent-
// closed gating, multi-opponent win checks) before being wired in here.
//
// Marks accumulate dart-by-dart *within* a visit — a number can go from open to
// closed mid-visit, with the remaining darts in that same visit scoring points.
// A mark counts toward points only once the shooter has closed the number (3+
// marks, counting the closing marks themselves as 0 points) AND at least one
// opponent hasn't closed it yet (checked against opponents' state as of the start
// of this visit — only the shooter's own marks change during their own visit).
//
// Known open edge case (matches the roadmap doc's own framing, not silently
// resolved): an exact points TIE at the moment the last number closes is not a
// win by this rule — the leg just continues with no tie-break implemented.
function evaluateVisitCricket(player, darts, game){
  const numbers = game.config.numbers || CRICKET_STANDARD_NUMBERS;
  const opponents = game.players.filter(pl=>pl!==player);
  const marks = Object.assign({}, player.marks);
  let pointsThisVisit = 0;
  darts.forEach(d=>{
    if(!numbers.includes(d.sector)) return; // miss or out-of-play number: no-op
    const before = marks[d.sector] || 0;
    const after = before + d.mult;
    marks[d.sector] = after;
    const beyondBefore = Math.max(0, before - 3);
    const beyondAfter = Math.max(0, after - 3);
    const newBeyond = beyondAfter - beyondBefore;
    if(newBeyond > 0){
      const opponentOpen = opponents.some(o=>(o.marks[d.sector]||0) < 3);
      if(opponentOpen) pointsThisVisit += newBeyond * d.sector;
    }
  });
  const points = player.points + pointsThisVisit;
  const allClosed = numbers.every(n=>(marks[n]||0) >= 3);
  const win = allClosed && opponents.every(o=>points > (o.points||0));
  return { marks, points, pointsThisVisit, scored:pointsThisVisit, win };
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

/* ---------- Checkout Trainer (docs/checkout-trainer-roadmap.md) ----------
   A pure mental-recall drill built entirely on top of the two functions above:
   evaluateVisit() grades whether a proposed route legally reaches zero, and
   checkoutHint() supplies the objective minimum dart count to compare against.
   Nothing game-type-specific needed inventing here. */

// Difficulty tiers for target selection (docs/checkout-trainer-roadmap.md
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
function pickCheckoutTarget(doubleOut, rng, difficulty){
  const roll = rng || Math.random;
  const tier = CHECKOUT_TRAINER_DIFFICULTY_TIERS[difficulty] || CHECKOUT_TRAINER_DIFFICULTY_TIERS.full;
  const low = Math.max(doubleOut ? 2 : 1, tier.low);   // double-out can never finish on 1; straight-out can
  const high = tier.high;
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

// Checkout Blitz's wall-clock deadline check (docs/checkout-trainer-roadmap.md
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
// 📸 Photo Finish (docs/checkout-trainer-roadmap.md "Achievements") — a legal
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

// Only executes under Node (require()'d from a test file) — undefined in a
// browser, so this is a no-op there and every name above stays a plain global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dartValue, dartLabel, makeDartCore,
    evaluateVisit, evaluateVisitCricket, CRICKET_STANDARD_NUMBERS,
    evaluateDartDoublesPractice, isStaircaseFinish,
    CO_DOUBLES, CO_FAV_D, CO_FIRSTS, coTreble, coSingle, coSetup, coFinish2, coFinish3, checkoutHint,
    pickCheckoutTarget, CHECKOUT_TRAINER_DIFFICULTY_TIERS, gradeCheckoutAttempt, blitzDeadlinePassed, isPhotoFinishSubmission,
    CHALLENGE_STREAK_WEEK, CHALLENGE_STREAK_MONTH, challengeBadgeSignals,
    chuckinTiersReached,
    isCricketWhitewash, CRICKET_COMEBACK_THRESHOLD, cricketComebackAchieved,
  };
}
