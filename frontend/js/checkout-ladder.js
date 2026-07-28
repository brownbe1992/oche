'use strict';
/* The 121 Checkout Ladder (docs/archive/practice-ladders-roadmap.md Part B) — a climbing checkout target.
 *
 * One of the per-game-type files (docs/frontend-module-split-roadmap.md step 3):
 * every function here is one this mode's GAME_TYPES entry names. The registry entry
 * itself stays in index.html, so there is still one place to see every mode at once.
 *
 * A CLASSIC SCRIPT sharing one global scope with index.html and every sibling file —
 * navigability, not encapsulation — and it must contain only function declarations,
 * because these load BEFORE the inline script. frontend/js/bobs-27.js carries the
 * full explanation of both points; it is not repeated in all sixteen files.
 */
// The 121 Checkout Ladder's Home page leaderboard (docs/archive/practice-ladders-roadmap.md
// Part B) — same "peak single-run value, no minimum floor" shape as Bob's 27's.
function renderHomeTabBodyCheckoutLadder(){
  renderSimpleHomeLeaderboardTab('checkoutLadder', 'leaderboard', '🪜 Checkout Ladder — Highest Target Reached', {
    score:r=>r.bestTarget, meta:r=>fmtDate(r.achievedAt),
    emptyMsg:'None recorded yet — climb the checkout ladder to claim the top spot.',
  });
}

function resetLegStateCheckoutLadder(game){ game.checkoutLadderVisits = 0; }

function newMatchPlayerCheckoutLadder(name){
  return { name, score:121, doubleOut:true, legDarts:0, setDarts:0, gameDarts:0,
    // Per-visit achievement tracking, the same fields newMatchPlayer() carries —
    // needed since enterTurnCheckoutLadder() started calling the shared
    // awardVisitAchievements() (docs/bug-roadmap.md BUG-37). Without them the
    // first committed visit throws on `p.legVisitScores.push`, the same way Dead
    // Man Walking's own factory did (BUG-34).
    legVisits:0, legVisitScores:[], metronomeFired:false, pendingIceInTheVeins:false,
    singlesHit: new Set(), atwHitSet: new Set(), atwBaselineHitSet: new Set(),
    sessionOneEighties:0, lifetimeOneEightiesBase:0 };
}

function resetPlayerForNextLegCheckoutLadder(p, game, newSet){
  p.score = game.checkoutLadderTarget;
  p.legDarts = 0;
  if(newSet) p.setDarts = 0;
  resetLegAchievementState(p);   // a rung is a leg — see that function's comment
}

function playerSnapshotCheckoutLadder(p){
  return { name:p.name, score:p.score, out:'double', legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0 };
}

function enterTurnCheckoutLadder(){
  if(noDartsThrown()) return;
  const p = game.players[0];
  const ev = evaluateVisit(p, game.darts, game);

  if(ev.win) announce(`Checks out with ${ev.pointsThisVisit}! Target ${game.checkoutLadderTarget} cleared.`);
  else if(ev.bust) announce(`Bust, stays on ${p.score}.`);
  else announce(`Scores ${ev.scored}, ${ev.newScore} remaining.`);

  // snapshot state before mutations so undoLastTurnCheckoutLadder() can restore
  // it — only reachable while this attempt is still live (a resolving visit
  // clears it via startNextLeg(), same "can't undo past a leg boundary" rule
  // every other game type follows).
  const _snap = { score:p.score, legDarts:p.legDarts, setDarts:p.setDarts, gameDarts:p.gameDarts,
    visits:game.checkoutLadderVisits,
    ltLen:game.currentLegTurns.length, stLen:game.sessionTurns.length,
    // This mode calls awardVisitAchievements() (BUG-37), so it owes the same
    // tracking-state restore X01 does — without it an undone visit left its
    // Around the Clock/World progress and Metronome streak behind.
    ...snapshotVisitAchievementState(p),
    badgeReverts:[], voided:false };
  pushTurnSnapshot(_snap);

  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;
  if(!ev.bust) p.score = ev.newScore;

  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.scored, bust:ev.bust, checkout:ev.win, checkoutPoints: ev.win ? ev.pointsThisVisit : null,
    targetScore: game.checkoutLadderTarget,
    darts: mapDartsForRecord(game.darts) });

  // trebleLess/checkoutPoints feed liveLaneStats() -> pracAggregate(); without
  // them the live board reported 0% trebleless (i.e. "every visit had a treble")
  // and an empty checkout list for a mode that records real finishes.
  const turnRecord = { player:p.name, scored:ev.scored, bust:ev.bust, checkout:ev.win,
    trebleLess:!!ev.trebleLess, checkoutPoints: ev.win ? ev.pointsThisVisit : null,
    darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  // Every per-visit achievement, same as X01 — this mode's visits come from
  // evaluateVisit(), X01's own evaluator, so the `ev` shape is identical and
  // every check applies. Big Fish is genuinely reachable (the ladder's top rung
  // IS 170), as are Hat Trick, Madhouse, Bullseye Finish, No Cigar and the
  // first-100-checkout milestone. Before this the mode awarded only the
  // time-of-day pair (which awardVisitAchievements() now makes for it), so in
  // practice no achievement ever fired — docs/bug-roadmap.md BUG-37.
  awardVisitAchievements(p, ev, _snap);

  const visitsUsed = game.checkoutLadderVisits + 1;
  if(ev.win){
    resolveCheckoutLadderAttempt(true);
  } else if(visitsUsed >= 3){
    resolveCheckoutLadderAttempt(false);
  } else {
    game.checkoutLadderVisits = visitsUsed;
    game.darts=[]; game.busted=false; game.won=false;
    game.turnSeq += 1;
    document.getElementById('status').className='status';
    document.getElementById('status').textContent = `Target ${game.checkoutLadderTarget} — ${p.score} remaining, visit ${visitsUsed+1} of 3.`;
    renderGameCheckoutLadder();
  }
}

function undoLastTurnCheckoutLadder(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[0];
  p.score = snap.score;
  p.legDarts = snap.legDarts; p.setDarts = snap.setDarts; p.gameDarts = snap.gameDarts;
  restoreVisitAchievementState(p, snap);
  game.checkoutLadderVisits = snap.visits;
  game.currentLegTurns.length = snap.ltLen;
  game.sessionTurns.length = snap.stLen;

  _finishUndo(snap, renderGameCheckoutLadder, { resetDarts: true });
}

// Resolves the current attempt (win, or 3 visits used without one) — climbs the
// target one rung on a win, drops it one rung (floored at 61, docs/practice-
// ladders-roadmap.md Part B) on a fail, then hands off to startNextLeg(false),
// the same generic leg-transition X01 itself uses (legNo++, resetForNextLeg()
// per player, currentLegTurns/legVisitLogs/lastTurnSnapshot cleared, re-render)
// — nothing ladder-specific to duplicate there beyond the target-visits reset
// startNextLeg() already handles inline (its own "if gameType==='checkout_ladder'"
// line, mirroring baseballInning's).
function resolveCheckoutLadderAttempt(won){
  const p = game.players[0];
  const clearedTarget = game.checkoutLadderTarget;
  if(won){
    checkChuckinMilestoneTier(CHECKOUT_LADDER_MILESTONE_LADDERS[0], p.name, clearedTarget + 1);
    // 🧗 Peak Bagged: the ladder-rung ladder above already covers "reached
    // position 170"; this is the separate, harder feat of actually checking
    // OUT 170 itself (T20 T20 Bull, the same double-out maximum Big Fish
    // celebrates in a real match) — recurring, since climbing back up to
    // (and clearing) 170 again in a later run/session is a real repeatable feat.
    if(clearedTarget === 170){
      queueBadge('checkoutladderpeakbagged', p.name);
      awardRecurringBadge(p.name, 'checkoutladderpeakbagged', 'checkoutladderpeakbagged',
        { icon:'🧗', headline:'PEAK BAGGED!', player:p.name, statLine:'Checked out 170 on the ladder' });
    }
  }
  // Capped at 170 — same reasoning as the write-time guard in db.js's addTurn():
  // turns.target_score is a shared column whose valid range tops out at 170,
  // the highest possible double-out finish. Clearing 170 again and again just
  // keeps the run parked at the summit rather than requesting an out-of-range target.
  game.checkoutLadderTarget = won ? Math.min(170, clearedTarget + 1) : Math.max(61, clearedTarget - 1);
  announce(won ? `Ladder up — ${game.checkoutLadderTarget}.` : `Ladder down — ${game.checkoutLadderTarget}.`);
  startNextLeg(false);
}

function renderGameCheckoutLadder(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  renderSlots();
  const p = game.players[0];
  const row = document.createElement('div');
  row.className = 'pscore active';
  row.innerHTML = `
    <div>
      <div class="nm">${escapeHtml(p.name)} <span class="nm-out">🧗 Checkout Ladder · double out</span></div>
      <div class="turnflag">▸ target ${game.checkoutLadderTarget}</div>
    </div>
    <div class="meta">
      <div class="avgs">Visit ${game.checkoutLadderVisits+1} of 3</div>
      <div class="standing">Attempt ${game.legNo}</div>
    </div>
    <div class="rem-wrap">
      <div class="rem">${p.score}</div>
    </div>`;
  if(sb) sb.appendChild(row);
  renderPad();
  pushLive();
}
