'use strict';
/* Shanghai (docs/archive/shanghai-roadmap.md) — Baseball’s shape with a parameterised round count and an instant-win visit.
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
function setShanghaiRounds(n){
  setup.shanghaiRounds = n;
  setPressed({7:'shanghai-rounds-7', 20:'shanghai-rounds-20'}, n);
}

function renderGameShanghai(){
  const sb = document.getElementById('scoreboard'); sb.innerHTML='';
  const maxRounds = (game.config && game.config.rounds) || 7;
  const lastRound = Math.max(maxRounds, game.shanghaiRound); // extend into extra rounds once reached

  const rows = [];
  for(let round=1; round<=lastRound; round++){
    const isCurrentRound = round === game.shanghaiRound;
    const target = shanghaiRoundTarget(round, maxRounds);
    const cells = game.players.map((p,i)=>{
      const r = p.roundPoints[round];
      const active = i===game.current && isCurrentRound;
      return `<div class="cs-cell${active?' active':''}">${r!=null ? `<span class="cs-points">${r}</span>` : ''}</div>`;
    }).join('');
    rows.push(`<div class="cs-row"><div class="cs-label">${target}</div>${cells}</div>`);
  }
  const bodyRowsHtml = rows.join('');

  const totalCells = game.players.map((p,i)=>{
    const active = i===game.current;
    return `<div class="cs-cell${active?' active':''}"><span class="cs-points">${p.totalPoints||0}</span></div>`;
  }).join('');

  csTableInto(sb, csHeadCellsHtml(), bodyRowsHtml, 'Points', totalCells);
  roundBannerInto(sb, `Round ${Math.min(game.shanghaiRound,maxRounds)} of ${maxRounds} — target ${shanghaiRoundTarget(game.shanghaiRound, maxRounds)}${game.shanghaiRound>maxRounds?' (extra rounds)':''}`);

  renderSlots();
  renderPad();
  pushLive();
}

function renderPadShanghai(full){
  const maxRounds = (game.config && game.config.rounds) || 7;
  const target = shanghaiRoundTarget(game.shanghaiRound, maxRounds);
  renderSingleTargetPad(full, target, target, `Number ${target} — this round's target`);
}

function enterTurnShanghai(){
  if(noDartsThrown()) return;
  const p = game.players[game.current];
  const ev = GAME_TYPES.shanghai.evaluateVisit(p, game.darts, game);
  const maxRounds = (game.config && game.config.rounds) || 7;

  announceTurn(ev.shanghai ? `${p.name} throws a SHANGHAI on ${ev.target}!`
    : `${p.name} scores ${ev.scored} point${ev.scored===1?'':'s'} in round ${Math.min(game.shanghaiRound, maxRounds)}.`);

  // snapshot state before mutations so undoLastTurn() can restore it — same
  // convention as enterTurnBaseball()'s own lastTurnSnapshot.
  pushVisitSnapshot(p,
    ['totalPoints', 'roundPoints', 'legDarts', 'setDarts', 'gameDarts'],
    ['shanghaiRound']);

  p.totalPoints = ev.totalPoints; p.roundPoints = ev.roundPoints;
  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;

  // legWon (docs/archive/shanghai-roadmap.md's data-model section, refined per this
  // build's own getShanghaiWonLegs()): set ONLY on a genuine instant Shanghai —
  // that visit really is self-referential to the winning player, the same
  // signal Cricket/Killer use turns.leg_won for. A final-round win decided by
  // point totals is NOT self-referential (the round-ending visit and the actual
  // leader aren't always the same player, exactly Baseball's own situation) —
  // never flagged here, so db.js's leg-winner derivation falls back to comparing
  // totals for those legs instead, exactly like getBaseballWonLegs().
  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.scored, bust:false, checkout:false, checkoutPoints:null, legWon:!!ev.shanghai,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.scored, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  // Novelty time-of-day badges — shared with every other game type.
  awardTimeOfDayBadges(p);

  // 🀄 Shanghai! (docs/archive/shanghai-roadmap.md) — single, double, AND treble of the
  // round's own number in one visit, wins the WHOLE match instantly.
  if(ev.shanghai){
    queueBadge('shanghai', p.name);
    awardRecurringBadge(p.name, 'shanghai', 'shanghai',
      { icon:'🀄', headline:'SHANGHAI!', player:p.name, statLine:`Single, double, and treble of ${ev.target} — instant win` });
  }

  if(ev.matchComplete){
    onLegWonShanghai(ev.winnerIndex);
    return;
  }

  if(ev.roundComplete) game.shanghaiRound += 1;
  game.darts=[]; game.busted=false; game.won=false;
  advanceToNextActivePlayer(game);
  game.turnSeq += 1;
  document.getElementById('status').className='status';
  document.getElementById('status').textContent = `Round ${Math.min(game.shanghaiRound,maxRounds)} of ${maxRounds} — target ${shanghaiRoundTarget(game.shanghaiRound, maxRounds)}.`;
  renderGameShanghai();
}

function undoLastTurnShanghai(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  restoreVisitSnapshot(snap);
  _finishUndo(snap, renderGameShanghai, { restoreCurrent: true, resetDarts: true });
}

function onLegWonShanghai(wi){
  const w = game.players[wi];
  w.legsWon += 1;

  // Captured before the legs-reset below zeroes everyone out.
  const legsAtWin = new Map(game.players.map(p => [p, p.legsWon]));

  advanceLegSetGame(w, { legsAtWin, opp: game.players.length===2 ? game.players.find(p=>p!==w) : null });
}

function resetLegStateShanghai(game){ game.shanghaiRound = 1; }

function shanghaiPanelSpec(game, winner, kind){
  const lead = panelLeadPlayer(winner);
  const maxRounds = (game.config && game.config.rounds) || 7;
  const pts = Array.from({length:maxRounds}, (_,i) => lead.roundPoints[i+1]);
  const scored = pts.filter(v => v != null);
  return {
    heroes: panelHeroesByPlayer(winner, p => p.totalPoints||0,
      p => `Points · ${p.legDarts||0} dart${(p.legDarts||0)===1?'':'s'}`),
    shelf: {
      title: `${lead.name}'s rounds`,
      cells: pts.map((v,i) => panelResultCell(i+1, v != null, (v||0) > 0,
        v == null ? 'not played' : `${v} pt${v===1?'':'s'}`)),
    },
    tallies: [
      { emoji:'🥇', value:scored.length ? Math.max(...scored) : 0, label:'best round' },
      { emoji:'🚫', value:scored.filter(v => v===0).length, label:'blank rounds' },
    ],
    columns: h2hPanelColumns(winner, kind==='game' ? 'game' : 'leg'),
  };
}

function newMatchPlayerShanghai(name){
  return { name, totalPoints:0, roundPoints:{}, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0 };
}

function resetPlayerForNextLegShanghai(p, game, newSet){
  p.totalPoints = 0; p.roundPoints = {}; p.legDarts = 0;
  if(newSet) p.setDarts = 0;
}

function playerSnapshotShanghai(p){
  return {
    name:p.name, totalPoints:p.totalPoints||0, roundPoints:Object.assign({}, p.roundPoints),
    legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0
  };
}
