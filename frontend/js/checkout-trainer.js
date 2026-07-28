'use strict';
/* Checkout Trainer (docs/archive/checkout-trainer-roadmap.md) — graded checkout attempts, difficulty tiers and trick targets.
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
function renderHomeTabBodyCheckoutTrainer(){
  renderSimpleHomeLeaderboardTab('checkoutTrainer', 'blitzLeaderboard', '⏱️ Checkout Blitz — Best Score', {
    score:r=>r.bestScore, meta:r=>fmtDate(r.achievedAt),
    emptyMsg:'None recorded yet — play a Checkout Blitz run to claim the top spot.',
  });
}

// docs/archive/checkout-drill-link-roadmap.md "Setup screen": renders/hides the "Drilling:
// N ✕" chip and disables the two options a pin makes meaningless — Checkout
// Blitz (grinding one known number against a clock isn't a speed test) and trick
// questions (there's nothing to spot-the-bogey on a target guaranteed solvable).
// Freeform and trick-questions-off stay enabled since they're exactly the state a
// pin already forces — only the incompatible sibling options need disabling.
function renderCheckoutTrainerPinChip(){
  const chip = document.getElementById('checkout-trainer-pin-chip');
  const text = document.getElementById('checkout-trainer-pin-text');
  if(!chip || !text) return;
  const pin = setup.checkoutTrainerPin;
  chip.hidden = !pin;
  // The chip needs `display:flex` (not the default block) when shown, but
  // setting that inline in HTML would out-specificity the `hidden` attribute's
  // own `display:none` and leave it visibly stuck open — set it here instead,
  // explicitly clearing back to '' (not 'flex') whenever hidden so `hidden`
  // regains control of visibility.
  chip.style.display = pin ? 'flex' : '';
  if(pin) text.textContent = `🎯 Drilling: ${pin}`;
  const blitzBtn = document.getElementById('checkout-trainer-mode-blitz');
  const tricksOnBtn = document.getElementById('checkout-trainer-tricks-on');
  if(blitzBtn) blitzBtn.disabled = !!pin;
  if(tricksOnBtn) tricksOnBtn.disabled = !!pin;
}

function clearCheckoutTrainerPin(){
  setup.checkoutTrainerPin = null;
  renderCheckoutTrainerPinChip();
  announce('Drill target cleared.');
}

// Checkout Trainer's Freeform/Blitz sub-toggle (docs/archive/checkout-trainer-roadmap.md
// "UI integration") — same sibling-toggle pattern as practice-type-*, just nested
// one level deeper since both sub-modes share the single 'checkout_trainer' mode
// button rather than being their own top-level modes.
function setCheckoutTrainerMode(sub){
  setup.checkoutTrainerMode = sub;
  setPressed({freeform:'checkout-trainer-mode-freeform', blitz:'checkout-trainer-mode-blitz',
    route_recall:'checkout-trainer-mode-route_recall'}, sub);
  document.getElementById('checkout-trainer-mode-desc').textContent = sub==='blitz'
    ? "A 60-second sprint: answer as many targets as you can. Optimal answers score 2 points, legal-but-not-optimal score 1, illegal score 0 — speed alone won't win, accuracy matters more."
    : sub==='route_recall'
    ? 'One target at a time, and you keep naming DIFFERENT ways to check it out until you run dry or move on. Not "what is the best route" — "how many do you actually know".'
    : 'Untimed — work through targets at your own pace, with the answer revealed after every attempt. Runs until you end the session.';
  // The dart ceiling is Route Recall's own difficulty axis and means nothing to
  // the other two sub-modes, which are always 3-dart.
  const row = document.getElementById('checkout-trainer-ceiling-row');
  const desc = document.getElementById('checkout-trainer-ceiling-desc');
  if(row) row.hidden = sub !== 'route_recall';
  if(desc) desc.hidden = sub !== 'route_recall';
  if(sub === 'route_recall') setRouteRecallCeiling(setup.routeRecallCeiling || 2);
  const startBtn = document.getElementById('setup-step2-continue');
  if(startBtn && setup.mode === 'checkout_trainer'){
    startBtn.textContent = sub==='blitz' ? 'Start Blitz' : sub==='route_recall' ? 'Start recalling' : 'Start training';
  }
}

// Checkout Trainer's difficulty-tier toggle (docs/archive/checkout-trainer-roadmap.md
// "Target selection") — same sibling-toggle pattern as setCheckoutTrainerMode()
// above. Tier bounds themselves live in CHECKOUT_TRAINER_DIFFICULTY_TIERS
// (frontend/scoring.js); this just records the chosen key onto setup, which
// startGame() bakes into game.config.difficulty for the duration of the session.
function setCheckoutTrainerDifficulty(tier){
  setup.checkoutTrainerDifficulty = tier;
  setPressed({under40:'checkout-trainer-difficulty-under40', under100:'checkout-trainer-difficulty-under100',
    over100:'checkout-trainer-difficulty-over100', full:'checkout-trainer-difficulty-full'}, tier);
}

// Checkout Trainer's trick-question toggle (docs/archive/checkout-trainer-roadmap.md
// "Trick-question difficulty variant") — same sibling-toggle pattern as the two
// above; startGame() bakes the choice into game.config.trickQuestions for the
// session. Off by default: a bogey trap is a deliberately-opted-into hard mode,
// not something to spring on someone doing straightforward recall practice.
function setCheckoutTrainerTricks(on){
  setup.checkoutTrainerTricks = !!on;
  setPressed({false:'checkout-trainer-tricks-off', true:'checkout-trainer-tricks-on'}, !!on);
  document.getElementById('checkout-trainer-tricks-desc').textContent = on
    ? 'About 1 target in 8 will be a bogey number with no possible 3-dart checkout — spot it and press "No possible checkout" instead of answering. Bogey numbers only exist above 100, so the Under 40/Under 100 ranges are unaffected.'
    : 'Every target has a real checkout. Turn trick questions on to occasionally face a bogey number where the right answer is calling it impossible.';
}

// Called after every attempt from submitCheckoutAttempt() (both Freeform and
// Checkout Blitz — a round is a round, per the roadmap doc's explicit ruling
// that Lifetime Attempts/Optimal/Streak count both modes). Session Endurance
// stays Freeform-only "by construction" (doc's own framing) — a 60-second
// Blitz run could never realistically reach its 50+ threshold, so no special
// gating code is needed to keep it from firing there. Lifetime ladders read
// from p.lifetimeAttemptsBase/lifetimeOptimalBase (fetched once at game start
// by newMatchPlayerCheckoutTrainer(), same "avoid a network round-trip per
// dart" reasoning checkChuckinMilestones() already documents) plus this
// session's running counters.
function checkCheckoutTrainerMilestones(p){
  const attemptsLadder = CHECKOUT_TRAINER_MILESTONE_LADDERS.find(l=>l.metric==='attempts');
  const optimalLadder = CHECKOUT_TRAINER_MILESTONE_LADDERS.find(l=>l.metric==='optimal');
  const sessionLadder = CHECKOUT_TRAINER_MILESTONE_LADDERS.find(l=>l.metric==='session');
  const streakLadder = CHECKOUT_TRAINER_MILESTONE_LADDERS.find(l=>l.metric==='streak');
  checkChuckinMilestoneTier(attemptsLadder, p.name, (p.lifetimeAttemptsBase||0) + p.attempts);
  checkChuckinMilestoneTier(optimalLadder, p.name, (p.lifetimeOptimalBase||0) + p.optimalCount);
  checkChuckinMilestoneTier(sessionLadder, p.name, p.attempts);
  checkChuckinMilestoneTier(streakLadder, p.name, p.currentStreak);
}

function newMatchPlayerCheckoutTrainer(name, config){
  const doubleOut = playerOut(name)==='double';
  const p = { name, score: pickCheckoutTarget(doubleOut, undefined, config && config.difficulty, (config && config.trickQuestions) ? CHECKOUT_TRAINER_TRICK_CHANCE : 0, config && config.pinnedTarget), doubleOut,
    attempts:0, legalCount:0, optimalCount:0, currentStreak:0,
    lifetimeAttemptsBase:0, lifetimeOptimalBase:0,
    sessionRounds:[],
    // Route Recall only (docs/archive/checkout-trainer-route-recall-roadmap.md). foundKeys
    // is THIS hunt's finds, cleared whenever a new target is served; hunts is the
    // whole session's record, which is what the completion screen and the coverage
    // stats read. routesFound is a session-wide running total across hunts.
    foundKeys:new Set(), hunts:[], routesFound:0, lifetimeRoutesBase:0 };
  // Fetched once at game start (not re-queried per attempt), same "avoid a
  // network round-trip per dart" reasoning newMatchPlayerChuckin() documents —
  // checkCheckoutTrainerMilestones() computes lifetime attempts/optimal-answers
  // entirely from local state (base + this session's counters) from then on.
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=checkout_trainer`).then(stats=>{
    if(!stats) return;
    p.lifetimeAttemptsBase = (stats.totalAttempts || 0) - p.attempts;
    p.lifetimeOptimalBase = (stats.optimalCount || 0) - p.optimalCount;
  }).catch(logErr);
  return p;
}

// Not called by startNextLeg() (this mode never advances a leg the X01 way —
// each round just serves a new target via submitCheckoutAttempt() below);
// provided only to satisfy the GAME_TYPES contract, matching Doubles Practice/
// Chuckin's own precedent.
function resetPlayerForNextLegCheckoutTrainer(p){
  p.currentStreak = 0;
}

function playerSnapshotCheckoutTrainer(p){
  return { name:p.name, target:p.score, attempts:p.attempts||0, legalCount:p.legalCount||0,
    optimalCount:p.optimalCount||0, currentStreak:p.currentStreak||0 };
}

function throwDartCheckoutTrainer(sector, zone, missZone, missDepth, bounced){
  // Route Recall's dart ceiling is the hunt's own rule, so it caps entry here as
  // well as being enforced at grading — a 2-dart hunt should not let a third dart
  // be staged at all, only to reject it on Submit.
  const cap = (game.config.mode === 'route_recall') ? routeRecallCeiling() : 3;
  if(game.darts.length>=cap || game.busted || game.won || game.blitzEnded) return;
  // Checkout Blitz: a hard deadline — the instant the wall clock passes it, no
  // further dart can be entered, whether this would start a fresh round or
  // continue one already mid-entry (docs/archive/checkout-trainer-roadmap.md "Core loop
  // delta", revised — a previous version exempted an in-progress round so the
  // timer would never "cut a player off mid-dart-entry"; in practice that grace
  // period let a player who paused mid-round resume and submit a checkout a full
  // minute after time ran out, still counted and badged, which is exactly what a
  // buzzer-beater achievement isn't supposed to be able to do). This check is one
  // of three equally-authoritative deadline checks (mirrored in
  // submitCheckoutAttempt() and _checkoutBlitzTimer's own idle-run backstop
  // tick) — any of the three ends the run the moment it notices the deadline
  // has passed.
  if(game.config.mode === 'blitz' && blitzDeadlinePassed(game.blitzDeadline, Date.now())){
    return endBlitzRun();
  }
  pushThrownDarts(game.darts, sector, mult, zone, missZone, missDepth, bounced);
  mult=1; updateMultUI();

  const p = game.players[0];
  const ev = evaluateVisit(p, game.darts, game);
  const status=document.getElementById('status');
  if(ev.bust){
    game.busted=true;
    status.className='status bust'; status.textContent='That overshoots the target — press Submit to see the answer.';
  } else if(ev.win){
    game.won=true;
    status.className='status win'; status.textContent="That's a finish! Press Submit to grade it.";
  } else if(game.darts.length>=cap){
    status.className='status'; status.textContent=`${cap} dart${cap===1?'':'s'} entered — press Submit.`;
  } else {
    status.className='status'; status.textContent=`Leaves ${ev.newScore}. Tap another dart, or press Submit now.`;
  }
  renderSlots(); renderPad();
}

// Mirrors undoLastTurnDoublesPractice()/undoLastTurnChuckin()'s snapshot-restore
// shape. Only available until the next attempt is submitted (same "one level of
// undo, gone once you move on" rule every other game type follows).
function undoLastTurnCheckoutTrainer(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[0];
  p.score = snap.target;
  p.attempts = snap.attempts;
  p.legalCount = snap.legalCount;
  p.optimalCount = snap.optimalCount;
  p.currentStreak = snap.currentStreak;
  p.sessionRounds.length = snap.sessionRoundsLen;
  game.legNo = snap.legNo;
  game.lastResult = null;

  _finishUndo(snap, renderGameCheckoutTrainer, { resetDarts: true, msg: 'Last attempt undone.' });
}

function renderGameCheckoutTrainer(){
  if(game.config.mode === 'route_recall') return renderGameRouteRecall();
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  renderSlots();   // game.darts was just cleared/changed by the caller — a stale route
                   // left on display would contradict the fresh target (and a
                   // declaration explicitly discards any half-staged darts)
  const p = game.players[0];
  const isBlitz = game.config.mode === 'blitz';
  const accPct = p.attempts ? Math.round(p.legalCount/p.attempts*100) : 0;
  const optPct = p.attempts ? Math.round(p.optimalCount/p.attempts*100) : 0;
  const modeLabel = isBlitz ? '⏱️ Checkout Blitz' : 'Checkout Trainer';
  const timeLabel = (isBlitz && game.blitzDeadline != null && !game.blitzEnded)
    ? `${Math.max(0, Math.ceil((game.blitzDeadline - Date.now())/1000))}s left`
    : `Round ${game.legNo}`;
  const row = document.createElement('div');
  row.className = 'pscore active';
  row.innerHTML = `
    <div>
      <div class="nm">${escapeHtml(p.name)} <span class="nm-out">${modeLabel} · ${p.doubleOut?'double out':'single out'}</span></div>
      <div class="turnflag">▸ target ${p.score}</div>
    </div>
    <div class="meta">
      <div class="avgs">${optPct}% optimal &nbsp;·&nbsp; ${accPct}% legal &nbsp;·&nbsp; ${p.attempts} attempt${p.attempts===1?'':'s'}</div>
      <div class="standing" id="checkout-trainer-timer">${escapeHtml(timeLabel)}</div>
    </div>
    <div class="rem-wrap">
      <div class="rem">${p.score}</div>
    </div>`;
  if(sb) sb.appendChild(row);

  const status = document.getElementById('status');
  if(status){
    const r = game.lastResult;
    if(r){
      if(r.declared && r.correct){
        status.className = 'status win';
        status.textContent = `💣 Correct — ${r.target} is a bogey number; no 3-dart checkout exists.`;
      } else if(r.declared){
        status.className = 'status bust';
        status.textContent = `❌ ${r.target} IS finishable (${r.optimalDarts} dart${r.optimalDarts===1?'':'s'}). Best route: ${r.hint}.`;
      } else if(r.optimal){
        status.className = 'status win';
        status.textContent = `✅ Optimal — ${r.usedDarts} dart${r.usedDarts===1?'':'s'}, that's the best possible.`;
      } else if(r.legal){
        status.className = 'status';
        status.textContent = `⚠️ Legal finish, but not optimal (you used ${r.usedDarts} — ${r.optimalDarts} possible). Best route: ${r.hint}.`;
      } else if(!r.hint){
        // A route was submitted against a trick question — no checkout exists at all.
        status.className = 'status bust';
        status.textContent = `💣 Trick question — ${r.target} is a bogey number with no possible checkout. "No possible checkout" was the answer.`;
      } else {
        status.className = 'status bust';
        status.textContent = `❌ Not a legal finish for ${r.target}. Best route: ${r.hint}.`;
      }
    } else {
      status.className = 'status';
      status.textContent = game.config.trickQuestions
        ? 'Tap out your proposed checkout and press Submit — or call "No possible checkout" if it\'s a bogey.'
        : 'Tap out your proposed checkout, then press Submit.';
    }
  }
  renderPad();
}
