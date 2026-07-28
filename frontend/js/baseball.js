'use strict';
/* Baseball (docs/game-modes-roadmap.md build-order step 5) — nine innings, one shared inning counter.
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
function renderGameBaseball(){
  const sb = document.getElementById('scoreboard'); sb.innerHTML='';
  const lastInning = Math.max(9, game.baseballInning); // extend the table into extra innings once reached

  const rows = [];
  for(let inning=1; inning<=lastInning; inning++){
    const isCurrentInning = inning === game.baseballInning;
    const cells = game.players.map((p,i)=>{
      const r = p.inningRuns[inning];
      const active = i===game.current && isCurrentInning;
      return `<div class="cs-cell${active?' active':''}">${r!=null ? `<span class="cs-points">${r}</span>` : ''}</div>`;
    }).join('');
    rows.push(`<div class="cs-row"><div class="cs-label">${inning}</div>${cells}</div>`);
  }
  const bodyRowsHtml = rows.join('');

  const totalCells = game.players.map((p,i)=>{
    const active = i===game.current;
    return `<div class="cs-cell${active?' active':''}"><span class="cs-points">${p.totalRuns||0}</span></div>`;
  }).join('');

  csTableInto(sb, csHeadCellsHtml(), bodyRowsHtml, 'Runs', totalCells);
  roundBannerInto(sb, `Inning ${Math.min(game.baseballInning,9)} of 9 — target ${baseballInningTarget(game.baseballInning)}${game.baseballInning>9?' (extra innings)':''}`);

  renderSlots();
  renderPad();
  pushLive();
}

function renderPadBaseball(full){
  const target = baseballInningTarget(game.baseballInning);
  renderSingleTargetPad(full, target, target, `Number ${target} — this inning's target`);
}

function enterTurnBaseball(){
  if(noDartsThrown()) return;
  const p = game.players[game.current];
  const ev = GAME_TYPES.baseball.evaluateVisit(p, game.darts, game);

  announceTurn(`${p.name} scores ${ev.scored} run${ev.scored===1?'':'s'} in inning ${Math.min(game.baseballInning,9)}.`);

  // snapshot state before mutations so undoLastTurn() can restore it — same
  // convention as X01/enterTurnCricket's own lastTurnSnapshot.
  // sessionRuns is in this list even though it is session-scoped rather than
  // leg-scoped: it feeds BASEBALL_RUNS_MILESTONE_LADDERS below as
  // lifetimeRunsBase + sessionRuns, so leaving it out of the snapshot meant an
  // undone visit's runs stayed counted and a lifetime tier could fire early.
  pushVisitSnapshot(p,
    ['totalRuns', 'inningRuns', 'legDarts', 'setDarts', 'gameDarts', 'sessionRuns'],
    ['baseballInning']);

  p.totalRuns = ev.totalRuns; p.inningRuns = ev.inningRuns;
  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;
  // Lifetime runs ladder (docs/archive/culture-badges-roadmap.md Part B) — accumulates
  // across the whole client session, not reset per leg like p.totalRuns.
  p.sessionRuns = (p.sessionRuns||0) + ev.runsThisVisit;

  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.scored, bust:false, checkout:false, checkoutPoints:null,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.scored, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  // Novelty time-of-day badges — shared with every other game type, see
  // awardTimeOfDayBadges() (docs/game-modes-roadmap.md "Cricket badge parity").
  awardTimeOfDayBadges(p);

  // Perfect Inning: 3 darts, all treble on this inning's target number — the
  // maximum possible runs (9) in a single visit, Baseball's 180 analog. Checked
  // the same "per-visit" way Cricket's 9 Marks is (inside the turn-commit
  // function, not onLegWon), since it doesn't depend on knowing the leg's outcome.
  if(dartsThrown===3 && ev.runsThisVisit===9){
    queueBadge('baseballperfectinning', p.name);
    awardRecurringBadge(p.name, 'baseballperfectinning', 'baseballperfectinning',
      { icon:'🔥', headline:'PERFECT INNING!', player:p.name, statLine:'9 runs — three trebles, one visit' });
  }

  // 🔄 The Cycle (docs/archive/culture-badges-roadmap.md Part B): a single, double, AND
  // treble of this inning's number in one visit — 6 runs the scenic way.
  // Mutually exclusive with Perfect Inning above (that's three trebles; this is
  // one of each), so no suppression pairing is needed. isBaseballCycle() lives
  // in scoring.js so it's covered by a committed test.
  if(dartsThrown===3 && isBaseballCycle(game.darts, ev.target)){
    queueBadge('baseballcycle', p.name);
    awardRecurringBadge(p.name, 'baseballcycle', 'baseballcycle',
      { icon:'🔄', headline:'THE CYCLE!', player:p.name, statLine:"Single, double, and treble of the inning's number" });
  }

  // Lifetime runs ladder (docs/archive/culture-badges-roadmap.md Part B) — permanent
  // milestone tiers, same "ladder tiers are permanent" convention every other
  // ladder in this app follows.
  checkChuckinMilestoneTier(BASEBALL_RUNS_MILESTONE_LADDERS[0], p.name, (p.lifetimeRunsBase||0) + p.sessionRuns);

  if(ev.matchComplete){
    onLegWonBaseball(ev.winnerIndex);
    return;
  }

  if(ev.roundComplete) game.baseballInning += 1;
  game.darts=[]; game.busted=false; game.won=false;
  advanceToNextActivePlayer(game);
  game.turnSeq += 1;
  document.getElementById('status').className='status';
  document.getElementById('status').textContent = `Inning ${Math.min(game.baseballInning,9)} of 9 — target ${baseballInningTarget(game.baseballInning)}.`;
  renderGameBaseball();
}

function undoLastTurnBaseball(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  restoreVisitSnapshot(snap);
  _finishUndo(snap, renderGameBaseball, { restoreCurrent: true, resetDarts: true });
}

function onLegWonBaseball(wi){
  const w = game.players[wi];
  w.legsWon += 1;

  // ⚾ Walk-Off (docs/archive/culture-badges-roadmap.md Part B): the leg was decided in
  // extra innings. game.baseballInning still holds the deciding visit's own
  // inning number here — enterTurnBaseball() only increments it AFTER checking
  // ev.matchComplete and dispatching here, so this read is the same "not yet
  // advanced" timing evaluateVisitBaseball()'s own roundComplete check relies on.
  if(game.baseballInning > 9){
    queueBadge('baseballwalkoff', w.name);
    awardRecurringBadge(w.name, 'baseballwalkoff', 'baseballwalkoff',
      { icon:'⚾', headline:'WALK-OFF!', player:w.name, statLine:`Won in extra innings — inning ${game.baseballInning}` });
  }

  // Perfect Game: won this leg with a perfect 9 runs in every one of the 9
  // innings (81 total) — Baseball's Nine-Darter/Perfect Leg analog. Checked
  // here (a leg-outcome badge), not per-visit, since it can only be confirmed
  // once the leg's winner and their full inningRuns are known — the same split
  // Cricket uses for Whitewash/Comeback Kid vs. its own per-visit 9 Marks.
  const isPerfectGame = [1,2,3,4,5,6,7,8,9].every(i => w.inningRuns[i] === 9);
  if(isPerfectGame){
    queueBadge('baseballperfectgame', w.name);
    awardRecurringBadge(w.name, 'baseballperfectgame', 'baseballperfectgame',
      { icon:'🏆', headline:'PERFECT GAME!', player:w.name, statLine:'81 runs — a perfect 9 in every inning' });
  }

  // Captured before the legs-reset below zeroes everyone out — same "stable
  // snapshot for the match-win stat line" precedent onLegWon() (X01) uses.
  const legsAtWin = new Map(game.players.map(p => [p, p.legsWon]));

  // docs/bug-roadmap.md BUG-22: unlike onLegWon() (X01/Cricket), this gate is NOT
  // `!game.practice && ...` — a practice Baseball leg is deliberately forced to
  // legsPerSet=1/setsPerGame=1 above in startGame() (isPracticeBaseball), so
  // `w.legsWon >= game.legsPerSet` alone already correctly distinguishes "this
  // single practice leg just finished" (completes immediately, legsPerSet=1) from
  // "this leg finished but the H2H match isn't decided yet" (legsPerSet=setup's Bo3/
  // Bo5/etc, unchanged for H2H). Keeping `!game.practice` here — copied wholesale
  // from X01/Cricket's OWN open-ended-practice-session template — was the actual
  // bug: it blocked DB.completeGame() from EVER firing for a practice Baseball
  // game, no matter how many legs were played, because unlike X01/Cricket (whose
  // leg-level personal bests read turns.leg_won, independent of games.completed_at),
  // every one of Baseball's own stat functions (getBaseballWonLegs(), gamesPlayed,
  // winPct) requires games.completed_at IS NOT NULL — so practice Baseball could
  // never show a single stat, ever, regardless of how many games were played.
  // checkEloOnMatchWin() itself already guards on !game.practice — this
  // function's own gate (unlike X01/Cricket's) deliberately isn't
  // !game.practice && ... (see BUG-22 above), so opp is derived fresh
  // here rather than assumed from an outer H2H-only condition.
  advanceLegSetGame(w, { legsAtWin, opp: game.players.length===2 ? game.players.find(p=>p!==w) : null });
}

function resetLegStateBaseball(game){ game.baseballInning = 1; }

// --- Baseball / Shanghai / Halve-It / The Pressure Chamber ---
// Four round-based H2H modes with the same panel shape: the mode's running
// total as the hero, and the winner's own scorecard as the shelf, one cell per
// round. Their per-player columns come straight from their existing h2hRows.
function baseballPanelSpec(game, winner, kind){
  const lead = panelLeadPlayer(winner);
  const innings = Math.max(9, (game.baseballInning||1) - 1);
  const runs = Array.from({length:innings}, (_,i) => lead.inningRuns[i+1]);
  const scored = runs.filter(r => r != null);
  return {
    heroes: panelHeroesByPlayer(winner, p => p.totalRuns||0,
      p => `Runs · ${p.legDarts||0} dart${(p.legDarts||0)===1?'':'s'}`),
    shelf: {
      title: `${lead.name}'s innings`,
      cells: runs.map((r,i) => panelResultCell(i+1, r != null, (r||0) > 0,
        r == null ? 'not played' : `${r} run${r===1?'':'s'}`)),
    },
    tallies: [
      { emoji:'🔥', value:scored.filter(r => r===9).length, label:'perfect innings' },
      { emoji:'🥇', value:scored.length ? Math.max(...scored) : 0, label:'best inning' },
      { emoji:'🚫', value:scored.filter(r => r===0).length, label:'scoreless innings' },
    ],
    columns: h2hPanelColumns(winner, kind==='game' ? 'game' : 'leg'),
  };
}

function newMatchPlayerBaseball(name){
  const p = { name, totalRuns:0, inningRuns:{}, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0,
    sessionRuns:0, lifetimeRunsBase:0 }; // Lifetime runs ladder (docs/archive/culture-badges-roadmap.md Part B)
  // Fetched once at game start, not re-queried per visit — same "avoid a network
  // round-trip per turn" reasoning newMatchPlayer()'s own 180s-ladder fetch
  // documents. No mode param -> genuinely unscoped lifetime (H2H + practice
  // combined). If this hasn't resolved by the time a run is scored, the
  // milestone check just uses 0 as the base and catches up once it lands.
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=baseball`).then(stats=>{
    if(!stats) return;
    p.lifetimeRunsBase = (stats.totalRuns || 0) - p.sessionRuns;
  }).catch(logErr);
  return p;
}

function resetPlayerForNextLegBaseball(p, game, newSet){
  p.totalRuns = 0; p.inningRuns = {}; p.legDarts = 0;
  if(newSet) p.setDarts = 0;
}

function playerSnapshotBaseball(p){
  return {
    name:p.name, totalRuns:p.totalRuns||0, inningRuns:Object.assign({}, p.inningRuns),
    legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0
  };
}
