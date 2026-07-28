'use strict';
/* The Pressure Chamber (docs/archive/pressure-chamber-roadmap.md) — server-seeded cards, composure points, and the No Warmup countdown.
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
function renderGamePressureChamber(){
  const sb = document.getElementById('scoreboard'); sb.innerHTML='';
  const maxRounds = (game.config && game.config.rounds) || PRESSURE_ROUNDS;
  const lastRound = Math.max(maxRounds, game.pressureChamberRound);

  const OUTCOME_ICON = { full:'✅', partial:'➗', miss:'❌' };
  const OUTCOME_LABEL = { full:'full hit', partial:'partial hit', miss:'miss' };
  const rows = [];
  for(let round=1; round<=lastRound; round++){
    const isCurrentRound = round === game.pressureChamberRound;
    const rCard = generatePressureCard(game.gameId, Math.min(round, maxRounds));
    const cells = game.players.map((p,i)=>{
      const r = p.roundResults[round];
      const active = i===game.current && isCurrentRound;
      const cellText = r ? `<span class="cs-points" title="${escapeHtml(OUTCOME_LABEL[r])}" aria-label="${escapeHtml(OUTCOME_LABEL[r])}">${OUTCOME_ICON[r]}</span>` : '';
      return `<div class="cs-cell${active?' active':''}">${cellText}</div>`;
    }).join('');
    rows.push(`<div class="cs-row"><div class="cs-label" title="${escapeHtml(rCard.target.label)} · ${escapeHtml(rCard.modifier.label)}">${round}</div>${cells}</div>`);
  }
  const bodyRowsHtml = rows.join('');

  const totalCells = game.players.map((p,i)=>{
    const active = i===game.current;
    return `<div class="cs-cell${active?' active':''}"><span class="cs-points">${p.totalCp||0}</span></div>`;
  }).join('');

  csTableInto(sb, csHeadCellsHtml(), bodyRowsHtml, 'CP', totalCells);

  const card = generatePressureCard(game.gameId, Math.min(game.pressureChamberRound, maxRounds));
  const baseCp = pressureBaseCp(card.target);
  const missP = pressureMissPenaltyForCard(card);
  const noWarmup = card.modifier.key === 'no_warmup';
  const banner = document.createElement('div');
  banner.setAttribute('role','status');
  banner.style.cssText = 'margin-top:12px;padding:14px;border:2px solid var(--gold,#c9a227);border-radius:10px;text-align:center;background:rgba(201,162,39,0.08)';
  banner.innerHTML = `
    <div style="font-size:22px;font-weight:800">${escapeHtml(card.target.label)}</div>
    <div style="font-size:16px;font-weight:700;margin-top:4px">${card.modifier.icon} ${escapeHtml(card.modifier.label)}</div>
    <div class="pp-meta" style="font-style:italic;margin-top:2px">${escapeHtml(card.modifier.flavor)}</div>
    <div style="margin-top:6px;font-weight:600">Full hit: +${Math.round(baseCp*card.modifier.cpMultiplier)}${card.modifier.comebackBonus?' (+bonus)':''} CP · Miss: −${missP} CP</div>
    ${noWarmup?`<div style="margin-top:6px;font-size:20px;font-weight:800" id="pressure-chamber-no-warmup-timer" aria-live="polite">5s</div>`:''}
  `;
  sb.appendChild(banner);

  roundBannerInto(sb, `Round ${Math.min(game.pressureChamberRound,maxRounds)} of ${maxRounds}`);

  // No Warmup's wall-clock deadline (docs/archive/pressure-chamber-roadmap.md): armed
  // once per round, the moment the dart pad is first revealed — which, since the
  // self-declare step now sits ahead of the pad, means the moment the player
  // COMMITS their call (game.pressureDeclared != null), not when the card first
  // shows. A re-render within the SAME round (undo, a live-scoreboard refresh)
  // must never reset an already-ticking clock, hence the _pcTimerRound guard.
  if(game.darts.length === 0 && game.pressureDeclared != null && noWarmup && game._pcTimerRound !== game.pressureChamberRound){
    game._pcTimerRound = game.pressureChamberRound;
    game.pressureChamberDeadline = Date.now() + PRESSURE_NO_WARMUP_MS;
    startPressureChamberNoWarmupTimer();
  } else if(!noWarmup){
    game.pressureChamberDeadline = null;
    stopPressureChamberNoWarmupTimer();
  }

  renderSlots();
  renderPad();
  pushLive();
}

function renderPadPressureChamber(full){
  const board = document.getElementById('dart-board-wrap');
  if(board) board.classList.add('hidden');
  const bounceBtn = document.getElementById('bounce-out-btn');
  const multi = document.getElementById('multi-row');
  const pad = document.getElementById('pad');
  if(!pad) return;
  pad.classList.remove('hidden');

  // docs/archive/pressure-chamber-roadmap.md build-order step 10: the self-declare hit/miss
  // step is its own screen state AHEAD of the normal dart-input widget. Until the
  // player has committed a call for this round (game.pressureDeclared == null), the
  // number pad and the S/D/T multi-row are hidden and replaced by the two declare
  // buttons; only once a call is made does the real dart pad appear (No Warmup's
  // clock doesn't start until then either — see renderGamePressureChamber()).
  //
  // Item 67: this pad has exactly two shapes — the declare prompt and the full
  // 1-20+Bull grid — and the contents of each are fixed. `padKey` is which of the
  // two is currently built, so a round's worth of darts reuses one grid instead of
  // rebuilding twenty-two buttons and their closures per throw.
  if(game.pressureDeclared == null && !full && game.darts.length === 0){
    if(bounceBtn) bounceBtn.disabled = true;
    if(multi) multi.classList.add('hidden');
    pad.classList.add('cricket-pad');
    if(pad.dataset.padKey !== 'pc-declare'){
      pad.innerHTML = '';
      const prompt = document.createElement('div');
      prompt.className = 'pp-meta';
      prompt.style.cssText = 'grid-column:1/-1;text-align:center;margin-bottom:8px;font-weight:700';
      prompt.textContent = 'Call it before you throw — will you HIT this target, or MISS?';
      pad.appendChild(prompt);
      const hitBtn = document.createElement('button');
      hitBtn.className = 'cricket-target';
      hitBtn.innerHTML = '<span class="ct-num">🎯 I\'ll hit it</span>';
      hitBtn.setAttribute('aria-label', "Declare: I'll hit this round's target");
      hitBtn.onclick = () => declarePressureHit(true);
      pad.appendChild(hitBtn);
      const missBtn = document.createElement('button');
      missBtn.className = 'miss';
      missBtn.innerHTML = '<span class="ct-num">❌ I\'ll miss</span>';
      missBtn.setAttribute('aria-label', "Declare: I'll miss this round's target");
      missBtn.onclick = () => declarePressureHit(false);
      pad.appendChild(missBtn);
      pad.dataset.padKey = 'pc-declare';
    }
    // The declare buttons are never disabled — reaching this branch at all means
    // no call has been made and no dart has been thrown.
    for(const b of pad.querySelectorAll('button')) b.disabled = false;
    return;
  }

  pad.classList.remove('cricket-pad');
  if(bounceBtn) bounceBtn.disabled = full;
  if(multi) multi.classList.remove('hidden');
  if(pad.dataset.padKey !== 'pc-grid'){
    pad.innerHTML = '';
    for(let n=1;n<=20;n++){
      const b=document.createElement('button');
      b.textContent=n;
      b.onclick=()=>throwDart(n);
      pad.appendChild(b);
    }
    const bull=document.createElement('button');
    bull.className='bull'; bull.textContent='Bull';
    bull.onclick=()=>throwDart(25); pad.appendChild(bull);
    const miss=document.createElement('button');
    miss.className='miss'; miss.textContent='Miss';
    miss.onclick=()=>throwDart(0); pad.appendChild(miss);
    pad.dataset.padKey = 'pc-grid';
  }
  for(const b of pad.querySelectorAll('button')) b.disabled = full;
}

function enterTurnPressureChamber(){
  if(noDartsThrown()) return;
  const p = game.players[game.current];
  const card = generatePressureCard(game.gameId, game.pressureChamberRound);
  const ev = GAME_TYPES.pressure_chamber.evaluateVisit(p, game.darts, game);

  announceTurn(ev.outcome === 'miss'
    ? `${p.name} misses ${card.target.label} entirely under ${card.modifier.label} — loses ${ev.missPenalty} Composure Points.`
    : ev.outcome === 'full'
    ? `${p.name} lands a FULL HIT on ${card.target.label} — plus ${ev.gained} Composure Points, now on ${ev.totalCp}.`
    : `${p.name} lands a partial hit on ${card.target.label} — plus ${ev.gained} Composure Points, now on ${ev.totalCp}.`);

  // snapshot state before mutations so undoLastTurn() can restore it.
  // pressureDeclared is the call this round was made under — restored with the
  // rest so an undone visit re-opens on the same declaration, not a blank one.
  pushVisitSnapshot(p,
    ['totalCp', 'misses', 'fullHits', 'currentFullHitStreak', 'bestFullHitStreak',
     'roundResults', 'legDarts', 'setDarts', 'gameDarts'],
    ['pressureChamberRound', 'pressureChamberDeadline', '_pcTimerRound', 'pressureDeclared']);

  p.totalCp = ev.totalCp; p.misses = ev.misses; p.fullHits = ev.fullHits;
  p.currentFullHitStreak = ev.currentFullHitStreak; p.bestFullHitStreak = ev.bestFullHitStreak;
  p.roundResults = ev.roundResults;
  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;

  // One-off flavor badges (docs/archive/pressure-chamber-roadmap.md "Achievements") —
  // checked the moment a round is graded, same "checked where the outcome is
  // already known" precedent onLegWonHalveIt()'s own two badges use.
  if(isPressureModifierFullHit(card, ev.outcome, 'sudden_death')){
    queueBadge('pcnervesofsteel', p.name);
    awardRecurringBadge(p.name, 'pcnervesofsteel', 'pcnervesofsteel',
      { icon:'🎯', headline:'NERVES OF STEEL!', player:p.name, statLine:`Full hit on ${card.target.label} under Sudden Death` });
  }
  if(isPressureModifierFullHit(card, ev.outcome, 'no_warmup')){
    queueBadge('pcnowarmup', p.name);
    awardRecurringBadge(p.name, 'pcnowarmup', 'pcnowarmup',
      { icon:'⏱️', headline:'NO WARMUP NEEDED!', player:p.name, statLine:`Full hit on ${card.target.label} with no time to prepare` });
  }
  if(isPressureModifierFullHit(card, ev.outcome, 'dead_calm')){
    queueBadge('pcdeadcalm', p.name);
    awardRecurringBadge(p.name, 'pcdeadcalm', 'pcdeadcalm',
      { icon:'🃏', headline:'DEAD CALM, STEADY HANDS!', player:p.name, statLine:`Full hit on ${card.target.label} — no modifier, no excuses` });
  }

  // docs/archive/pressure-chamber-roadmap.md's own "store the gain, derive the rest"
  // data model — turns.scored is the CP GAINED this round (never negative),
  // reusing Checkout Trainer's exact bust/checkout/leg_won 3-way outcome.
  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.gained, bust:ev.outcome==='miss', checkout:ev.outcome!=='miss', legWon:ev.outcome==='full', checkoutPoints:null,
    // docs/archive/pressure-chamber-roadmap.md build-order step 10: the player's own
    // before-the-throw hit/miss call, stored alongside the real outcome for the
    // informational Honesty% stat. Never a scoring input.
    declaredHit: game.pressureDeclared,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.gained, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  awardTimeOfDayBadges(p);

  if(ev.matchComplete){
    onLegWonPressureChamber(ev.winnerIndex);
    return;
  }

  if(ev.roundComplete) game.pressureChamberRound += 1;
  game.darts=[]; game.busted=false; game.won=false;
  game.pressureDeclared = null;  // the next player/round makes its own call
  advanceToNextActivePlayer(game);
  game.turnSeq += 1;
  document.getElementById('status').className='status';
  document.getElementById('status').textContent = `Round ${Math.min(game.pressureChamberRound,PRESSURE_ROUNDS)} of ${PRESSURE_ROUNDS}.`;
  renderGamePressureChamber();
}

function undoLastTurnPressureChamber(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  restoreVisitSnapshot(snap);
  _finishUndo(snap, renderGamePressureChamber, { restoreCurrent: true, resetDarts: true });
}

function onLegWonPressureChamber(wi){
  const w = game.players[wi];

  game.players.forEach(p=>{
    if(isPressureIceRun(p.totalCp)){
      queueBadge('pcice', p.name);
      awardRecurringBadge(p.name, 'pcice', 'pcice',
        { icon:'🥶', headline:'ICE!', player:p.name, statLine:`Finished the Chamber on ${p.totalCp} CP — Ice rating` });
    }
    p.sessionRunsCompleted = (p.sessionRunsCompleted||0) + 1;
    p.sessionCpEarned = (p.sessionCpEarned||0) + Math.max(0, p.totalCp);
    checkChuckinMilestoneTier(PRESSURE_RUNS_MILESTONE_LADDERS[0], p.name, (p.lifetimeRunsBase||0) + p.sessionRunsCompleted);
    checkChuckinMilestoneTier(PRESSURE_CP_MILESTONE_LADDERS[0], p.name, (p.lifetimeCpBase||0) + p.sessionCpEarned);
    checkChuckinMilestoneTier(PRESSURE_STREAK_MILESTONE_LADDERS[0], p.name, p.bestFullHitStreak||0);
  });

  w.legsWon += 1;

  const legsAtWin = new Map(game.players.map(p => [p, p.legsWon]));

  advanceLegSetGame(w, { legsAtWin, opp: game.players.length===2 ? game.players.find(p=>p!==w) : null });
}

function resetLegStatePressureChamber(game){
  game.pressureChamberRound = 1;
  game.pressureChamberDeadline = null;
  game._pcTimerRound = null;
  game.pressureDeclared = null;
  stopPressureChamberNoWarmupTimer();
}

function pressureChamberPanelSpec(game, winner, kind){
  const lead = panelLeadPlayer(winner);
  const maxRounds = (game.config && game.config.rounds) || PRESSURE_ROUNDS;
  const results = Array.from({length:maxRounds}, (_,i) => lead.roundResults[i+1]);
  const count = kindOf => results.filter(r => r === kindOf).length;
  return {
    heroes: panelHeroesByPlayer(winner, p => p.totalCp||0,
      p => `Composure points · ${pressureComposureRating(p.totalCp||0)}`),
    shelf: {
      title: `${lead.name}'s card`,
      cells: results.map((r,i) => panelResultCell(i+1, !!r, r === 'full',
        r == null ? 'not played' : r === 'full' ? 'full hit' : r === 'partial' ? 'partial' : 'miss')),
    },
    tallies: [
      { emoji:'✅', value:count('full'),    label:'full hits' },
      { emoji:'❌', value:count('miss'),    label:'misses' },
      { emoji:'🔗', value:lead.bestFullHitStreak||0, label:'best streak' },
    ],
    columns: h2hPanelColumns(winner, kind==='game' ? 'game' : 'leg'),
  };
}

function newMatchPlayerPressureChamber(name){
  const p = { name, totalCp:0, misses:0, fullHits:0, currentFullHitStreak:0, bestFullHitStreak:0,
    roundResults:{}, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0,
    // Lifetime achievement-ladder bases (docs/archive/pressure-chamber-roadmap.md
    // "Achievements") — fetched once at game start, same "avoid a network
    // round-trip per turn" reasoning newMatchPlayerBaseball()'s own
    // lifetimeRunsBase fetch documents. No mode param -> genuinely unscoped
    // lifetime (H2H + practice combined).
    sessionRunsCompleted:0, lifetimeRunsBase:0, sessionCpEarned:0, lifetimeCpBase:0 };
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=pressure_chamber`).then(stats=>{
    p.lifetimeRunsBase = (stats.runsCompleted || 0) - p.sessionRunsCompleted;
    p.lifetimeCpBase = (stats.totalCpEarned || 0) - p.sessionCpEarned;
  }).catch(logErr);
  return p;
}

function resetPlayerForNextLegPressureChamber(p, game, newSet){
  p.totalCp = 0; p.misses = 0; p.fullHits = 0;
  p.currentFullHitStreak = 0; p.bestFullHitStreak = 0; p.roundResults = {}; p.legDarts = 0;
  if(newSet) p.setDarts = 0;
}

function playerSnapshotPressureChamber(p){
  return {
    name:p.name, totalCp:p.totalCp||0, roundResults:Object.assign({}, p.roundResults),
    misses:p.misses||0, fullHits:p.fullHits||0, bestFullHitStreak:p.bestFullHitStreak||0,
    legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0
  };
}

function throwDartPressureChamber(sector, zone, missZone, missDepth, bounced){
  if(game.darts.length>=3 || game.busted || game.won) return;
  pushThrownDarts(game.darts, sector, mult, zone, missZone, missDepth, bounced);
  mult=1; updateMultUI();

  const maxRounds = (game.config && game.config.rounds) || PRESSURE_ROUNDS;
  const card = generatePressureCard(game.gameId, Math.min(game.pressureChamberRound, maxRounds));
  const status = document.getElementById('status');

  if(card.modifier.key === 'sudden_death' && card.target.type === 'sector'){
    const lastDart = game.darts[game.darts.length-1];
    const r = evaluateDartPressureSector(lastDart, card.target);
    if(r.ended){
      // Reused purely as "stop asking for more darts, Enter Turn to commit"
      // — NOT X01's own bust meaning (enterTurnPressureChamber() re-grades
      // from game.darts itself, so this flag never leaks into scored/bust).
      game.busted = true;
      status.className = 'status bust';
      status.textContent = r.reason === 'wrong-ring' ? 'SUDDEN DEATH — wrong ring, round over. Press Enter turn.' : 'SUDDEN DEATH — missed, round over. Press Enter turn.';
      announce('Sudden Death ends the round.');
      renderSlots(); renderPad(); pushLive();
      return;
    }
  }
  if(game.darts.length>=3){
    status.className='status'; status.textContent='Three darts thrown — press Enter turn.';
  } else {
    status.className='status'; status.textContent=`Dart ${game.darts.length} of 3 recorded.`;
  }
  renderSlots(); renderPad(); pushLive();
}

function startPressureChamberNoWarmupTimer(){ _pressureChamberNoWarmupTimer.start(); }

function stopPressureChamberNoWarmupTimer(){ _pressureChamberNoWarmupTimer.stop(); }
