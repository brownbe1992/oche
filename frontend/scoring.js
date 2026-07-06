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
  if(dart.sector !== 0 && targets.includes(dart.sector)){
    return { hit:false, ended:true, reason:'so-close' };
  }
  return { hit:false, ended:false, reason:null };
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

// Daily Challenge badge trigger thresholds (REFERENCE.md's Achievements section,
// docs/achievements-badges-roadmap.md) — a day-count streak, not a visit/leg count,
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

// Only executes under Node (require()'d from a test file) — undefined in a
// browser, so this is a no-op there and every name above stays a plain global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dartValue, dartLabel, makeDartCore,
    evaluateVisit, evaluateVisitCricket, CRICKET_STANDARD_NUMBERS,
    evaluateDartDoublesPractice,
    CO_DOUBLES, CO_FAV_D, CO_FIRSTS, coTreble, coSingle, coSetup, coFinish2, coFinish3, checkoutHint,
    CHALLENGE_STREAK_WEEK, CHALLENGE_STREAK_MONTH, challengeBadgeSignals,
  };
}
