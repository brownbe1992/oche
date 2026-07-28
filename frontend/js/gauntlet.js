'use strict';
/* The Gauntlet (docs/archive/gauntlet-roadmap.md) — fixed stations, scars for each one missed.
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
// The Gauntlet's Home page leaderboard (docs/archive/gauntlet-roadmap.md) — the one
// leaderboard in this app sorted ASCENDING (lowest total Scars first).
function renderHomeTabBodyGauntlet(){
  renderSimpleHomeLeaderboardTab('gauntlet', 'leaderboard', '🥋 The Gauntlet — Lowest Total Scars', {
    score:r=>r.bestTotalScars, meta:r=>fmtDate(r.achievedAt),
    emptyMsg:'None recorded yet — complete a Gauntlet run to claim the top spot.',
  });
}

// The Gauntlet's Scar Map (docs/archive/gauntlet-roadmap.md "The Scar Map — the actual
// point of the game") — the direct structural sibling of the dartboard heatmap
// above, just shaded by average Scar severity (across every COMPLETED run)
// instead of hit frequency. GAUNTLET_STATION_ORDER is itself the standard
// clockwise dartboard walk, so rendering stations in that array order already
// reads as "around the board," with no separate layout math needed. A plain
// text table sits alongside the colored grid (docs/archive/gauntlet-roadmap.md
// Accessibility: "needs a text-table fallback/equivalent alongside the colored
// board graphic").
function loadGauntletScarMap(){
  const container=document.getElementById('player-gauntlet-scarmap');
  if(!container) return;
  cachedProfileLoad('gauntletScarMap',
    () => Backend.get(`/api/players/gauntlet-scar-map?name=${encodeURIComponent(currentPlayer)}`),
    data=>renderGauntletScarMap(data),
    ()=>{ container.innerHTML=`<p class="pp-meta" style="padding:4px 0">Could not load the Scar Map.</p>`; });
}

function renderGauntletScarMap(data){
  const container=document.getElementById('player-gauntlet-scarmap');
  if(!container) return;
  if(!data || !data.stations || !data.stations.some(s=>s.runs>0)){
    container.innerHTML=`<p class="pp-meta" style="padding:4px 0">No completed Gauntlet runs recorded yet.</p>`;
    return;
  }
  const maxAvg = Math.max(1, ...data.stations.map(s=>s.avgScars||0));
  const cells = data.stations.map(s=>{
    const has = s.runs>0;
    const sev = has ? (s.avgScars||0)/maxAvg : 0;
    const bg = has ? `rgba(196,60,44,${(0.15+0.65*sev).toFixed(2)})` : 'var(--surface-2)';
    const label = has ? s.avgScars.toFixed(1) : '—';
    return `<div title="Station ${s.station}: avg ${has?s.avgScars.toFixed(2):'—'} Scars across ${s.runs} run${s.runs===1?'':'s'}"
      role="img" aria-label="Station ${s.station}, average ${has?s.avgScars.toFixed(1)+' Scars':'no data'}"
      style="width:52px;height:52px;border-radius:.6vmin;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:${bg};color:${has?'#fff':'var(--muted)'}">
      <span>${s.station}</span><span style="font-size:9px;font-weight:500">${label}</span>
    </div>`;
  }).join('');
  const rows = data.stations.map(s=>
    `<tr><td>${s.station}</td><td>${s.runs>0?s.avgScars.toFixed(2):'—'}</td><td>${s.runs}</td></tr>`
  ).join('');
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(52px,1fr));gap:6px;max-width:440px">${cells}</div>
    <details style="margin-top:10px">
      <summary class="pp-meta" style="cursor:pointer">Text table (screen-reader friendly)</summary>
      <table style="width:100%;margin-top:6px;font-size:12px;border-collapse:collapse">
        <thead><tr><th style="text-align:left">Station</th><th style="text-align:left">Avg Scars</th><th style="text-align:left">Runs</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

function afterDartGauntlet(){
  // renderGameGauntlet() itself rebuilds the "next task" label from
  // game.darts.length, so a single call covers slots+pad+status together —
  // no pushLive() (docs/archive/gauntlet-roadmap.md "No live-scoreboard sync needed").
  renderGameGauntlet();
}

// --- The Gauntlet ---
function gauntletPanelSpec(game){
  const p = game.players[0];
  const misses = game.gauntletFinalMisses || [];
  const totalScars = gauntletTotalScars(misses);
  const clean = misses.filter(m => m === 0).length;
  return {
    heroes: [
      { title: p.name, sub: `Total Scars · ${gauntletResultTier(totalScars)}`, value: totalScars },
      { title: 'Clean stations', sub: `Best clean streak · ${game.gauntletBestCleanStreak||0}`,
        value: `${clean}/${misses.length}` },
    ],
    shelf: {
      title: 'The twenty stations', long: true,
      cells: GAUNTLET_STATION_ORDER.map((station, i) => {
        const m = misses[i];
        return panelResultCell(station, m != null, m === 0,
          m == null ? 'not reached' : m === 0 ? 'clean' : `${m} scar${m===1?'':'s'}`);
      }),
    },
    tallies: [
      { emoji:'💎', value:clean, label:'clean stations' },
      { emoji:'🩹', value:totalScars, label:'scars' },
      { emoji:'🔗', value:game.gauntletBestCleanStreak||0, label:'best streak' },
    ],
  };
}

function newMatchPlayerGauntlet(name){
  const p = { name, legDarts:0, setDarts:0, gameDarts:0, lifetimeRunsBase:0, lifetimeCleanStationsBase:0 };
  // Fetched once at game start — onGauntletComplete() only ever checks its
  // lifetime ladders ONCE, at the very end of a ~15-minute run, so (unlike
  // Chuckin's own per-dart lifetime-base fetch) there's no race to correct
  // for: this fetch will always have long since resolved by then.
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=gauntlet&mode=practice`).then(stats=>{
    if(!stats) return;
    p.lifetimeRunsBase = stats.runsCompleted || 0;
    p.lifetimeCleanStationsBase = stats.cleanStations || 0;
  }).catch(logErr);
  return p;
}

// Never actually called — legsPerSet/setsPerGame are forced to 1 (a run IS the
// game) and onGauntletComplete() always reaches the "game complete" branch
// directly, the same structurally-unreachable-but-contract-satisfying shape
// Bob's 27's own resetPlayerForNextLegBobs27() documents.
function resetPlayerForNextLegGauntlet(p, game, newSet){}

function playerSnapshotGauntlet(p){
  return { name:p.name, legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0 };
}

function enterTurnGauntlet(){
  if(game.darts.length < 3){
    document.getElementById('status').textContent = 'Throw all 3 darts for this station first — single, then treble, then double.';
    return;
  }
  const p = game.players[0];
  const station = GAUNTLET_STATION_ORDER[game.gauntletStationIndex];
  const ev = evaluateGauntletStation(station, game.darts);
  const wasRepeat = game.gauntletAwaitingRepeat;

  const taskNames = ['single','treble','double'];
  const missed = ev.hits.map((h,i)=>h?null:taskNames[i]).filter(Boolean);
  if(ev.misses===0) announce(`Clean pass at station ${station}.`);
  else announce(`${ev.misses} miss${ev.misses===1?'':'es'} at station ${station} — missed the ${missed.join(' and ')}.`);

  // snapshot state before mutations so undoLastTurnGauntlet() can restore it —
  // only reachable while this attempt is still the live one (a settled attempt
  // that advances the station index is a leg-boundary-style event, same "can't
  // undo past it" rule every other game type follows).
  const _snap = { legDarts:p.legDarts, setDarts:p.setDarts, gameDarts:p.gameDarts,
    stationIndex:game.gauntletStationIndex, awaitingRepeat:game.gauntletAwaitingRepeat,
    finalMissesLen:game.gauntletFinalMisses.length,
    cleanStreak:game.gauntletCleanStreak, bestCleanStreak:game.gauntletBestCleanStreak,
    ltLen:game.currentLegTurns.length, stLen:game.sessionTurns.length,
    badgeReverts:[], voided:false };
  pushTurnSnapshot(_snap);

  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;

  DB.recordTurn({ player:p.name, set:1, leg:1,
    scored: ev.misses, bust:false, checkout:false, checkoutPoints:null, targetScore: station,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.misses, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  awardTimeOfDayBadges(p);

  if(!wasRepeat && ev.misses === 2){
    // 2 misses on the ORIGINAL attempt: not settled yet — one repeat allowed,
    // same station, no station advance.
    game.gauntletAwaitingRepeat = true;
    game.darts=[]; game.busted=false; game.won=false;
    game.turnSeq += 1;
    document.getElementById('status').className='status';
    document.getElementById('status').textContent = `2 misses at station ${station} — one repeat attempt allowed. Throw again.`;
    renderGameGauntlet();
    return;
  }

  // Settled: either the original attempt wasn't a 2, or this WAS the repeat —
  // the repeat's own result is final regardless of what it comes back as.
  const finalMisses = ev.misses;
  game.gauntletFinalMisses.push(finalMisses);
  game.gauntletAwaitingRepeat = false;

  // 🩹 Second Wind: passed the repeat clean after failing the original with 2.
  if(wasRepeat && finalMisses === 0){
    queueBadge('gauntletsecondwind', p.name);
    awardRecurringBadge(p.name, 'gauntletsecondwind', 'gauntletsecondwind',
      { icon:'🩹', headline:'SECOND WIND!', player:p.name, statLine:`Station ${station} — clean on the repeat` });
  }

  // This run's own longest consecutive-clean-station streak (checked against
  // the lifetime GAUNTLET_STREAK_MILESTONE_LADDERS threshold once the run ends).
  if(finalMisses === 0){
    game.gauntletCleanStreak += 1;
    game.gauntletBestCleanStreak = Math.max(game.gauntletBestCleanStreak, game.gauntletCleanStreak);
  } else {
    game.gauntletCleanStreak = 0;
  }

  game.gauntletStationIndex += 1;
  if(game.gauntletStationIndex >= GAUNTLET_STATION_ORDER.length){
    onGauntletComplete();
    return;
  }
  game.darts=[]; game.busted=false; game.won=false;
  game.turnSeq += 1;
  document.getElementById('status').className='status';
  document.getElementById('status').textContent = `Station ${GAUNTLET_STATION_ORDER[game.gauntletStationIndex]} — dart 1: single.`;
  renderGameGauntlet();
}

function undoLastTurnGauntlet(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[0];
  p.legDarts = snap.legDarts; p.setDarts = snap.setDarts; p.gameDarts = snap.gameDarts;
  game.gauntletStationIndex = snap.stationIndex;
  game.gauntletAwaitingRepeat = snap.awaitingRepeat;
  game.gauntletFinalMisses.length = snap.finalMissesLen;
  game.gauntletCleanStreak = snap.cleanStreak;
  game.gauntletBestCleanStreak = snap.bestCleanStreak;
  game.currentLegTurns.length = snap.ltLen;
  game.sessionTurns.length = snap.stLen;

  _finishUndo(snap, renderGameGauntlet, { resetDarts: true, msg: 'Last attempt undone.' });
}

// Ends the run (all 20 stations settled) — the one point in this game type's
// whole lifecycle that reaches finishUnit('game', ...), same "a run IS the
// game" shape onLegWonBobs27()'s own "game complete" branch documents.
function onGauntletComplete(){
  const p = game.players[0];
  const totalScars = gauntletTotalScars(game.gauntletFinalMisses);
  const tier = gauntletResultTier(totalScars);
  const flawless = game.gauntletFinalMisses.every(m => m === 0);

  checkChuckinMilestoneTier(GAUNTLET_RUNS_MILESTONE_LADDERS[0], p.name, (p.lifetimeRunsBase||0) + 1);
  const cleanThisRun = game.gauntletFinalMisses.filter(m => m === 0).length;
  checkChuckinMilestoneTier(GAUNTLET_CLEAN_STATIONS_MILESTONE_LADDERS[0], p.name, (p.lifetimeCleanStationsBase||0) + cleanThisRun);
  // Per-run streak ladder (Bob's 27 final-score pattern) — checked against
  // THIS run's own peak value, not a lifetime accumulator.
  checkChuckinMilestoneTier(GAUNTLET_STREAK_MILESTONE_LADDERS[0], p.name, game.gauntletBestCleanStreak);

  if(flawless){
    queueBadge('gauntletflawless', p.name);
    awardRecurringBadge(p.name, 'gauntletflawless', 'gauntletflawless',
      { icon:'💎', headline:'FLAWLESS GAUNTLET!', player:p.name, statLine:'All 20 stations, zero Scars' });
  }
  if(tier === 'Unmarked'){
    queueBadge('gauntletunmarked', p.name);
    awardRecurringBadge(p.name, 'gauntletunmarked', 'gauntletunmarked',
      { icon:'🥋', headline:'UNMARKED', player:p.name, statLine:`${totalScars} total Scars` });
  }

  sendHaWebhook('legend', p.name, game.category, { setNo: game.setNo, legNo: game.legNo });
  sendHaWebhook('setend', p.name, game.category, { setNo: game.setNo });
  sendHaWebhook('gameend', p.name, game.category);
  DB.recordEvent('leg_end', game.setNo, game.legNo);
  DB.recordEvent('set_end', game.setNo, null);
  DB.recordEvent('game_end', null, null);
  DB.completeGame(p.name);
  game.matchResult = { ts:Date.now(), kind:'game', legNo:game.legNo, setNo:game.setNo, winner:p.name, bigFish:false };
  fireMomentCard('matchwin', { icon: flawless ? '💎' : '🥋', headline: flawless ? 'FLAWLESS GAUNTLET!' : 'GAUNTLET COMPLETE!',
    player:p.name, statLine: `${totalScars} total Scars — ${tier}` });
  finishUnit('game', p.name);
}

function renderGameGauntlet(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  renderSlots();
  const p = game.players[0];
  const stationIndex = game.gauntletStationIndex;
  const station = GAUNTLET_STATION_ORDER[stationIndex];
  const taskNames = ['SINGLE','TREBLE','DOUBLE'];
  const nextTaskLabel = game.darts.length >= 3
    ? 'All 3 darts thrown — press Enter turn'
    : `Next: dart ${game.darts.length+1} — ${taskNames[game.darts.length]} ${station}`;
  const totalScarsSoFar = gauntletTotalScars(game.gauntletFinalMisses);
  const row = document.createElement('div');
  row.className = 'pscore active';
  row.innerHTML = `
    <div>
      <div class="nm">${escapeHtml(p.name)} <span class="nm-out">🥋 The Gauntlet${game.gauntletAwaitingRepeat ? ' · REPEAT' : ''}</span></div>
      <div class="turnflag">▸ Station ${stationIndex+1} of 20 — target ${station}</div>
    </div>
    <div class="meta">
      <div class="avgs">${escapeHtml(nextTaskLabel)}</div>
      <div class="standing">Total Scars: ${totalScarsSoFar}</div>
    </div>
    <div class="rem-wrap">
      <div class="rem">${station}</div>
    </div>`;
  if(sb) sb.appendChild(row);
  renderPad();
}
