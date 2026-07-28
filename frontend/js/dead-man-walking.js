'use strict';
/* Dead Man Walking (docs/archive/dead-man-walking-roadmap.md) — fifteen personalised checkouts on a per-round dart budget.
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
// Dead Man Walking's Home page leaderboard (docs/archive/dead-man-walking-roadmap.md
// "Home leaderboard") — best (highest) Walked Out count, one row per player,
// their peak run. Same "single best-ever run, no minimum floor" shape as
// Checkout Ladder/The Gauntlet's own boards above.
function renderHomeTabBodyDeadManWalking(){
  renderSimpleHomeLeaderboardTab('deadManWalking', 'leaderboard', '💀 Dead Man Walking — Most Walked Out', {
    score:r=>`${r.bestWalkedOut}/15`, meta:r=>fmtDate(r.achievedAt),
    emptyMsg:'None recorded yet — complete a Dead Man Walking run to claim the top spot.',
  });
}

function afterDartDeadManWalking(){
  // docs/archive/dead-man-walking-roadmap.md "Execution — per-dart evaluation, not
  // per-visit": nothing about the physical input widget changes (darts still
  // accumulate into game.darts up to 3, same as X01) — only the LIVE
  // evaluation is per-dart, generalizing the default block's own bust/win
  // check below with a third stop condition (outOfDarts). game.busted is
  // reused for BOTH a real bust and an out-of-darts stop (both block further
  // entry identically); the write-time commit (enterTurnDeadManWalking())
  // independently re-derives which one actually happened from the darts
  // themselves, never trusting this flag.
  const p = game.players[0];
  const ev = evaluateVisitDeadManWalking(p, game.darts, game);
  const status=document.getElementById('status');
  if(ev.bust){
    game.busted=true;
    status.className='status bust'; status.textContent='EXECUTED — bust. Press Enter turn.';
    announce('Bust.');
  } else if(ev.win){
    game.won=true;
    status.className='status win'; status.textContent='WALKED OUT! Press Enter turn to record it.';
    announce('Walked out!');
  } else if(ev.outOfDarts){
    game.busted=true;
    status.className='status bust'; status.textContent='EXECUTED — out of darts. Press Enter turn.';
    announce('Out of darts.');
  } else {
    const dartsLeft = game.dmwBudget - (game.dmwDartsUsedThisRound||0) - game.darts.length;
    status.className='status';
    status.textContent = `Leaves ${ev.newScore}. ${dartsLeft} dart${dartsLeft===1?'':'s'} left this round.`;
    if(dartsLeft <= 1) announce(`${dartsLeft} dart left this round.`);
  }
  renderSlots(); renderPad(); updateCheckout(true); pushLive();
}

// --- Dead Man Walking ---
// game.dmwRoundResults is the per-round log resolveDeadManWalkingRound() keeps;
// nothing else on the game object records which rounds were survived, only how
// many (game.dmwWalkedOutCount).
function deadManWalkingPanelSpec(game){
  const p = game.players[0];
  const results = game.dmwRoundResults || [];
  const walkedOut = game.dmwWalkedOutCount || 0;
  const cleared = results.filter(r => r.walkedOut);
  return {
    heroes: [
      { title: p.name, sub: `Walked out of 15 · ${deadManWalkingResultTier(walkedOut)}`, value: `${walkedOut}/15` },
      { title: 'Best streak', sub: `${dmwDifficultyLabel()} difficulty`, value: game.dmwBestStreak||0 },
    ],
    shelf: {
      title: 'The fifteen rounds', long: true,
      cells: Array.from({length:15}, (_,i) => {
        const r = results[i];
        return panelResultCell(r ? r.target : '·', !!r, !!(r && r.walkedOut),
          !r ? 'not reached' : r.walkedOut ? `out in ${r.darts}` : 'executed');
      }),
    },
    tallies: [
      { emoji:'🕊️', value:walkedOut, label:'walked out' },
      { emoji:'⚰️', value:results.length - walkedOut, label:'executed' },
      { emoji:'🎯', value:cleared.length ? Math.max(...cleared.map(r=>r.target)) : 0, label:'highest cleared' },
    ],
  };
}

function newMatchPlayerDeadManWalking(name){
  const p = { name, score:0, doubleOut:true, legDarts:0, setDarts:0, gameDarts:0,
    lifetimeRunsBase:0, lifetimeWalkedOutBase:0,
    // Per-visit achievement tracking, the same fields newMatchPlayer() carries.
    // Needed since enterTurnDeadManWalking() started calling the shared
    // awardVisitAchievements() (2026-07) — a Dead Man Walking visit is an
    // ordinary "throw at a remaining score" visit, so Big Fish, Hat Trick,
    // Madhouse, the first-100-checkout milestone and Around the Clock/World
    // progress all apply here. Without them the very first committed visit threw
    // on `p.legVisitScores.push`, which is exactly how this was caught.
    legVisits:0, legVisitScores:[], metronomeFired:false, pendingIceInTheVeins:false,
    singlesHit: new Set(), atwHitSet: new Set(), atwBaselineHitSet: new Set(),
    sessionOneEighties:0, lifetimeOneEightiesBase:0 };
  // Fetched once at game start, the same Gauntlet/Chuckin precedent (a run
  // takes several minutes, so there's no meaningful race with the one lifetime
  // check that happens at the very end, in onDeadManWalkingComplete()).
  // score/doubleOut are placeholders here — startGame() overwrites them with
  // round 1's own frozen target the moment game.config.rounds is actually
  // known (only true after DB.beginGame()'s POST resolves; see that
  // function's own dead_man_walking branch).
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=dead_man_walking&mode=practice`).then(stats=>{
    if(!stats) return;
    p.lifetimeRunsBase = stats.runsCompleted || 0;
    p.lifetimeWalkedOutBase = stats.totalWalkedOut || 0;
  }).catch(logErr);
  return p;
}

// Never actually called — resolveDeadManWalkingRound() below handles the real
// per-round reset inline (it needs the NEXT round's own frozen target/par,
// which this generic per-game-type hook has no way to receive), the same
// structurally-unreachable-but-registry-shape-consistent stub Gauntlet's own
// resetPlayerForNextLegGauntlet() already established.
function resetPlayerForNextLegDeadManWalking(p, game, newSet){}

function playerSnapshotDeadManWalking(p){
  return { name:p.name, score:p.score, out:'double', legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0 };
}

// The live, per-visit-shaped wrapper around resolveDeadManDart() (scoring.js)
// used by BOTH throwDart()'s live preview and enterTurnDeadManWalking()'s
// actual commit — one function, two call sites, so they can never disagree.
// Unlike evaluateVisit(), this checks EACH dart in `darts` in order and stops
// the instant one of them settles the round (bust/win/out-of-darts) — any
// remaining, not-yet-reached darts in that same batch are simply never
// evaluated (matches how a dart that ends the round makes a hypothetical
// next dart in the same tap sequence moot; throwDart()'s own live gate
// already stops further taps once the round settles, so in practice `darts`
// is never actually longer than dartsConsumed by more than a stale race).
function evaluateVisitDeadManWalking(player, darts, game){
  const budget = game.dmwBudget;
  const dartsUsedBefore = game.dmwDartsUsedThisRound || 0;
  let remaining = player.score;
  let bust = false, win = false, outOfDarts = false, dartsConsumed = 0;
  for(const dart of darts){
    const r = resolveDeadManDart(remaining, dart, true, dartsUsedBefore + dartsConsumed, budget);
    dartsConsumed += 1;
    remaining = r.newRemaining;
    if(r.bust){ bust = true; break; }
    if(r.win){ win = true; break; }
    if(r.outOfDarts){ outOfDarts = true; break; }
  }
  const pointsThisVisit = bust ? 0 : (player.score - remaining);
  const consumedDarts = darts.slice(0, dartsConsumed);
  return {
    pointsThisVisit, scored: bust ? 0 : pointsThisVisit,
    newScore: bust ? player.score : remaining,
    bust, win, outOfDarts, dartsConsumed,
    trebleLess: consumedDarts.length>0 && consumedDarts.every(d=>!d.isTreble),
  };
}

/* ----- Dead Man Walking turn commit (dispatched from enterTurn()) ----- */
function enterTurnDeadManWalking(){
  if(noDartsThrown()) return;
  const p = game.players[0];
  const ev = evaluateVisitDeadManWalking(p, game.darts, game);

  if(ev.win) announce(`Walked out with ${ev.pointsThisVisit}! Round ${game.legNo} of 15 cleared.`);
  else if(ev.bust) announce(`Executed — bust. Round ${game.legNo} of 15 over.`);
  else if(ev.outOfDarts) announce(`Executed — out of darts. Round ${game.legNo} of 15 over.`);
  else announce(`Scores ${ev.scored}, ${ev.newScore} remaining.`);

  // snapshot state before mutations so undoLastTurnDeadManWalking() can
  // restore it — only reachable while this ROUND is still live (a settled
  // round clears it via resolveDeadManWalkingRound(), the same "can't undo
  // past a leg boundary" rule every other game type follows).
  const _snap = { score:p.score, legDarts:p.legDarts, setDarts:p.setDarts, gameDarts:p.gameDarts,
    dartsUsedThisRound: game.dmwDartsUsedThisRound,
    ltLen:game.currentLegTurns.length, stLen:game.sessionTurns.length,
    // Same reason as Checkout Ladder: this mode calls awardVisitAchievements(),
    // so an undone visit must not leave its tracking state behind.
    ...snapshotVisitAchievementState(p),
    badgeReverts:[], voided:false };
  pushTurnSnapshot(_snap);

  // Only the darts actually reached before the round settled are ever
  // recorded — evaluateVisitDeadManWalking()'s own dartsConsumed, not simply
  // game.darts.length (see that function's own header comment for why these
  // are practically always the same number, and this guards the rare stale-
  // input edge case explicitly rather than trusting it).
  const dartsThrown = ev.dartsConsumed;
  const recordedDarts = game.darts.slice(0, dartsThrown);
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;
  if(!ev.bust) p.score = ev.newScore;
  game.dmwDartsUsedThisRound = (game.dmwDartsUsedThisRound||0) + dartsThrown;

  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.scored, bust: ev.bust, checkout: ev.win, checkoutPoints: ev.win ? ev.pointsThisVisit : null,
    targetScore: game.dmwTarget,
    darts: mapDartsForRecord(recordedDarts) });

  // Same as Checkout Ladder above: both fields feed the live board's own aggregate.
  const turnRecord = { player:p.name, scored:ev.scored, bust:ev.bust, checkout:ev.win,
    trebleLess:!!ev.trebleLess, checkoutPoints: ev.win ? ev.pointsThisVisit : null,
    darts:recordedDarts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  // Every per-visit achievement, same as X01 — a Dead Man Walking visit IS an
  // ordinary "throw at a remaining score, maybe check out" visit, so Big Fish on
  // a 170 round, Hat Trick, Madhouse, Bullseye Finish, the first-100-checkout
  // milestone and Around the World progress all apply. Before this call the mode
  // awarded only the time-of-day pair (which awardVisitAchievements() now makes
  // for it), so in practice no achievement ever fired here at all.
  awardVisitAchievements(p, ev, _snap);

  const roundOver = ev.win || ev.bust || ev.outOfDarts;
  if(roundOver){
    resolveDeadManWalkingRound(ev.win);
  } else {
    game.darts=[]; game.busted=false; game.won=false;
    game.turnSeq += 1;
    const dartsLeft = game.dmwBudget - game.dmwDartsUsedThisRound;
    document.getElementById('status').className='status';
    document.getElementById('status').textContent = `Round ${game.legNo} of 15 — ${p.score} remaining, ${dartsLeft} dart${dartsLeft===1?'':'s'} left.`;
    renderGameDeadManWalking();
  }
}

function undoLastTurnDeadManWalking(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[0];
  p.score = snap.score;
  p.legDarts = snap.legDarts; p.setDarts = snap.setDarts; p.gameDarts = snap.gameDarts;
  restoreVisitAchievementState(p, snap);
  game.dmwDartsUsedThisRound = snap.dartsUsedThisRound;
  game.currentLegTurns.length = snap.ltLen;
  game.sessionTurns.length = snap.stLen;

  _finishUndo(snap, renderGameDeadManWalking, { resetDarts: true });
}

// Resolves the round just settled (Walked Out, or Executed by bust/out-of-
// darts) — tallies it, advances game.legNo, and either seeds the NEXT
// round's own frozen target/par (rounds 1-14 settling) or ends the whole
// 15-round session (round 15 settling). Deliberately its OWN dedicated
// progression function rather than a carve-out on the generic X01
// onLegWon() — see this section's own header comment for why: a bust or an
// out-of-darts round is never an X01 "leg win" event, so there's no
// existing hook to carve into for 2 of this mode's 3 outcomes.
function resolveDeadManWalkingRound(walkedOut){
  const p = game.players[0];
  // Logged before the target advances — game.dmwTarget is still THIS round's.
  // No undo can reach back past this point (clearTurnSnapshots() below is the
  // same leg-boundary rule every other game type follows), so a plain push is
  // enough; there is no snapshot to restore it from.
  (game.dmwRoundResults = game.dmwRoundResults || []).push({
    target: game.dmwTarget, walkedOut: !!walkedOut, darts: game.dmwDartsUsedThisRound || 0 });
  if(walkedOut){
    game.dmwWalkedOutCount += 1;
    game.dmwCurrentStreak += 1;
    game.dmwBestStreak = Math.max(game.dmwBestStreak, game.dmwCurrentStreak);
  } else {
    game.dmwCurrentStreak = 0;
  }

  sendHaWebhook('legend', p.name, game.category, { setNo: game.setNo, legNo: game.legNo });
  DB.recordEvent('leg_end', game.setNo, game.legNo);

  if(game.legNo >= 15){
    onDeadManWalkingComplete();
    return;
  }

  // config.rounds[] is 0-indexed; game.legNo (1-based) is the round that JUST
  // settled, so config.rounds[game.legNo] is the NEXT round's own frozen entry.
  const nextRound = game.config.rounds[game.legNo];
  game.legNo += 1;
  game.dmwTarget = nextRound.target;
  game.dmwBudget = nextRound.par - 1;
  game.dmwDartsUsedThisRound = 0;
  p.score = nextRound.target;
  p.doubleOut = true;
  p.legDarts = 0;
  resetLegAchievementState(p);   // a round is a leg — see that function's comment
  game.legSummary = null;
  game.currentLegTurns = [];
  game.legVisitLogs = [];
  clearTurnSnapshots();
  game.darts=[]; game.busted=false; game.won=false;
  game.turnSeq += 1;
  game.legStart = { ts: Date.now(), starter: p.name };
  mult=1;
  DB.recordEvent('leg_start', game.setNo, game.legNo);
  sendHaWebhook('legstart', '', game.category, { setNo: game.setNo, legNo: game.legNo });
  renderGameShell(); updateMultUI(); renderGame();
}

// Ends the whole 15-round session — the one point in this game type's
// lifecycle that reaches finishUnit('game', ...), the same "a run IS the
// game" shape onGauntletComplete()/onLegWonBobs27() already established for
// this app's other fixed-length solo drills.
function onDeadManWalkingComplete(){
  const p = game.players[0];
  const walkedOut = game.dmwWalkedOutCount;
  const tier = deadManWalkingResultTier(walkedOut);

  checkChuckinMilestoneTier(DMW_RUNS_MILESTONE_LADDERS[0], p.name, (p.lifetimeRunsBase||0) + 1);
  checkChuckinMilestoneTier(DMW_WALKED_OUT_MILESTONE_LADDERS[0], p.name, (p.lifetimeWalkedOutBase||0) + walkedOut);

  // One-off badges, framed with the mode's own dark, self-aware humor
  // (docs/archive/dead-man-walking-roadmap.md "Achievements") — 💀 Last Request is
  // deliberately "you showed up," not purely celebratory, matching that tone.
  if(walkedOut === 15){
    queueBadge('dmwfullreprieve', p.name);
    awardRecurringBadge(p.name, 'dmwfullreprieve', 'dmwfullreprieve',
      { icon:'🕊️', headline:'FULL REPRIEVE!', player:p.name, statLine:'15 of 15 rounds Walked Out' });
  }
  if(walkedOut >= 13){
    queueBadge('dmwpardoned', p.name);
    awardRecurringBadge(p.name, 'dmwpardoned', 'dmwpardoned',
      { icon:'⚰️', headline:'PARDONED', player:p.name, statLine:`${walkedOut} of 15 rounds Walked Out` });
  }
  if(walkedOut === 0){
    queueBadge('dmwlastrequest', p.name);
    awardRecurringBadge(p.name, 'dmwlastrequest', 'dmwlastrequest',
      { icon:'💀', headline:'LAST REQUEST', player:p.name, statLine:'0 of 15 rounds Walked Out — you showed up' });
  }

  // Lifetime longest Walked-Out streak (docs/archive/dead-man-walking-roadmap.md
  // "within or across runs") is server-computed (getDeadManWalkingLongestStreak(),
  // backend/db.js) since it can span multiple runs — fetched fresh right after
  // this run's own final turn has landed, the same "post-match fetch resolves"
  // pattern Household Elo's own delta banner uses.
  DB._queue(()=>Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(p.name)}&gameType=dead_man_walking&mode=practice`)).then(stats=>{
    if(stats && stats.longestWalkedOutStreak != null){
      checkChuckinMilestoneTier(DMW_STREAK_MILESTONE_LADDERS[0], p.name, stats.longestWalkedOutStreak);
    }
  }).catch(logErr);

  sendHaWebhook('setend', p.name, game.category, { setNo: game.setNo });
  sendHaWebhook('gameend', p.name, game.category);
  DB.recordEvent('set_end', game.setNo, null);
  DB.recordEvent('game_end', null, null);
  DB.completeGame(p.name);
  game.matchResult = { ts:Date.now(), kind:'game', legNo:game.legNo, setNo:game.setNo, winner:p.name, bigFish:false };
  fireMomentCard('matchwin', { icon: walkedOut===15 ? '🕊️' : walkedOut===0 ? '💀' : '⚰️', headline: tier.toUpperCase(),
    player:p.name, statLine: `${walkedOut} of 15 rounds Walked Out` });
  finishUnit('game', p.name);
}

function renderGameDeadManWalking(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  renderSlots();
  const p = game.players[0];
  const dartsLeft = game.dmwBudget - (game.dmwDartsUsedThisRound||0);
  const row = document.createElement('div');
  row.className = 'pscore active';
  row.innerHTML = `
    <div>
      <div class="nm">${escapeHtml(p.name)} <span class="nm-out">💀 Dead Man Walking · double out</span></div>
      <div class="turnflag">▸ Round ${game.legNo} of 15</div>
    </div>
    <div class="meta">
      <div class="avgs" aria-live="polite">${dartsLeft} dart${dartsLeft===1?'':'s'} left this round</div>
      <div class="standing">Walked Out: ${game.dmwWalkedOutCount} / ${game.legNo - 1} · ${escapeHtml(dmwDifficultyLabel())}</div>
    </div>
    <div class="rem-wrap">
      <div class="rem">${p.score}</div>
    </div>`;
  if(sb) sb.appendChild(row);
  renderPad();
  pushLive();
}
