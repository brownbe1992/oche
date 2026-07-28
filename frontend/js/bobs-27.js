'use strict';
/* Bob's 27 (docs/archive/practice-ladders-roadmap.md Part A) — the solo doubles ladder.
 *
 * The first per-game-type file, and the shape the other fifteen follow
 * (docs/frontend-module-split-roadmap.md step 3). Every function here is one this
 * mode's GAME_TYPES entry names: the turn-loop members (render/renderPad/enterTurn/
 * undoLastTurn), the leg-win handler, the completion-panel spec, the three
 * player-lifecycle hooks, and the Home leaderboard renderer. The registry entry itself
 * stays in index.html, so there is still exactly one place to see every mode at once.
 *
 * A CLASSIC SCRIPT, NOT A MODULE, and the distinction matters more than it looks.
 * This file shares ONE global scope with index.html's inline script and every other
 * file in this directory — nothing here is encapsulated, and nothing stops any other
 * file reaching in. The split buys navigability ("where does Bob's 27 live?" has one
 * answer), reviewable diffs and per-file `node --check`. It does not buy boundaries.
 * See the roadmap doc's "Reassessment after the db.js split" for why that is the
 * honest framing rather than a disclaimer.
 *
 * THE ONE REAL HAZARD: these files load BEFORE index.html's inline script, so a
 * top-level initialiser reading a name the main script declares throws ReferenceError
 * and takes the WHOLE FILE with it — every function in it gone at once. That is why
 * this file contains only function declarations, whose bodies resolve at call time.
 * `backend/check.js`'s `load-order` rule enforces it; one such line once killed all 15
 * league functions in a single stroke.
 */
// Bob's 27's Home page leaderboard — same peak-single-run shape as Checkout
// Blitz's above (docs/archive/practice-ladders-roadmap.md Part A: "the Checkout
// Blitz precedent"), no H2H/Practice split (always solo).
function renderHomeTabBodyBobs27(){
  renderSimpleHomeLeaderboardTab('bobs27', 'leaderboard', "🎯 Bob's 27 — Best Final Score", {
    score:r=>r.bestScore, meta:r=>fmtDate(r.achievedAt),
    emptyMsg:"None recorded yet — play a Bob's 27 run to claim the top spot.",
  });
}

function renderGameBobs27(){
  const sb = document.getElementById('scoreboard'); sb.innerHTML='';
  const p = game.players[0];

  const rows = [];
  for(let round=1; round<=20; round++){
    const isCurrentRound = round === game.bobs27Round;
    const result = p.roundResults[round];
    const cellText = result==null ? '' : `<span class="cs-points">${result>0?'+'+result:'−'+(round*2)}</span>`;
    rows.push(`<div class="cs-row"><div class="cs-label">D${round}</div><div class="cs-cell${isCurrentRound?' active':''}">${cellText}</div></div>`);
  }
  const bodyRowsHtml = rows.join('');

  const table = document.createElement('div');
  table.className = 'cs-table';
  table.style.setProperty('--cs-cols', 1);
  table.innerHTML = `
    <div class="cs-row cs-head" role="row"><div class="cs-label"></div><div class="cs-col-head active"><span>${escapeHtml(p.name)}</span><span class="cs-throw-chip">▸ throwing</span></div></div>
    ${bodyRowsHtml}
    <div class="cs-row cs-foot"><div class="cs-label">Score</div><div class="cs-cell"><span class="cs-points">${p.running}</span></div></div>`;
  sb.appendChild(table);

  const roundBanner = document.createElement('p');
  roundBanner.className = 'pp-meta';
  roundBanner.style.cssText = 'text-align:center;margin:8px 0 0';
  roundBanner.textContent = `D${game.bobs27Round} — running score: ${p.running}`;
  sb.appendChild(roundBanner);

  renderSlots();
  renderPad();
  pushLive();
}

function renderPadBobs27(full){
  const target = game.bobs27Round;
  renderSingleTargetPad(full, target, `D${target}`, `Double ${target} — this round's target`);
}

function enterTurnBobs27(){
  if(noDartsThrown()) return;
  const p = game.players[game.current];
  const ev = GAME_TYPES.bobs_27.evaluateVisit(p, game.darts, game);

  if(ev.gain>0) announce(`${p.name} hits D${ev.round} ${ev.hits===1?'once':ev.hits+' times'} — plus ${ev.gain}, now on ${ev.running}.`);
  else announce(`${p.name} misses D${ev.round} completely — minus ${ev.round*2}, now on ${ev.running}.`);

  // snapshot state before mutations so undoLastTurn() can restore it — same
  // convention as X01/enterTurnCricket()/enterTurnBaseball()'s own lastTurnSnapshot.
  pushVisitSnapshot(p,
    ['running', 'roundResults', 'legDarts', 'setDarts', 'gameDarts'],
    ['bobs27Round']);

  p.running = ev.running;
  p.roundResults = Object.assign({}, p.roundResults, { [ev.round]: ev.gain });
  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;

  // bust (docs/archive/practice-ladders-roadmap.md Part A): reused, X01-style, to
  // mark the fatal round — the SEC-25-style write-time guard in addTurn()
  // (backend/db.js) independently re-derives and checks this exact value,
  // never trusting the client's own ev.dead.
  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.scored, bust:ev.dead, checkout:false, checkoutPoints:null,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.scored, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  awardTimeOfDayBadges(p);

  // 🎯 Full House: all three darts hit the round's double — the maximum
  // possible gain for that round, Bob's 27's own "180" for a single visit.
  if(dartsThrown===3 && isBobs27FullHouse(ev.hits)){
    queueBadge('bobs27fullhouse', p.name);
    awardRecurringBadge(p.name, 'bobs27fullhouse', 'bobs27fullhouse',
      { icon:'🎯', headline:'FULL HOUSE!', player:p.name, statLine:`All three darts on D${ev.round}` });
  }

  if(ev.matchComplete){
    onLegWonBobs27(game.current);
    return;
  }

  game.bobs27Round += 1;
  game.darts=[]; game.busted=false; game.won=false;
  game.turnSeq += 1;
  document.getElementById('status').className='status';
  document.getElementById('status').textContent = `D${game.bobs27Round} — three darts. Running score: ${p.running}.`;
  renderGameBobs27();
  pushLive();
}

function undoLastTurnBobs27(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  restoreVisitSnapshot(snap);
  // push:true is redundant (renderGameBobs27() pushes too) but is left exactly
  // as it was — this item is a refactor, and a second live POST is not the
  // thing to change while proving the restore behaves identically.
  _finishUndo(snap, renderGameBobs27, { resetDarts: true, push: true });
}

function onLegWonBobs27(wi){
  const w = game.players[wi];
  w.legsWon += 1;

  // Survival/score ladder + 🏔️ The Full Anderson — checked once, here,
  // against THIS RUN's own final score, not a lifetime accumulator (see
  // BOBS27_SCORE_MILESTONE_LADDERS' own comment on why that's still the same
  // generic engine, just a different kind of "value").
  checkChuckinMilestoneTier(BOBS27_SCORE_MILESTONE_LADDERS[0], w.name, w.running);
  if(isBobs27FullAnderson(w.running)){
    queueBadge('bobs27fullanderson', w.name);
    awardRecurringBadge(w.name, 'bobs27fullanderson', 'bobs27fullanderson',
      { icon:'🏔️', headline:'THE FULL ANDERSON!', player:w.name, statLine:'Every double, all three darts — 1287' });
  }

  // Bob's 27's own moment card — a run always completes (never re-plays as
  // a leg/set) so this is the only outcome to celebrate, "MATCH WON!"
  // reads wrong for a died-early run so this uses a survived-vs-died
  // headline instead, same "the generic matchWinStatLine() doesn't know
  // about `running`" reasoning that gives every solo drill its own card copy.
  advanceLegSetGame(w, {
    checkElo: false,
    momentCard: () => {
      const survived = w.running > 0;
      return { icon: survived ? '🎯' : '💀', headline: survived ? 'RUN COMPLETE!' : 'RUN OVER',
        player:w.name, statLine: survived ? `Final score: ${w.running} — survived all 20` : `Died on D${Object.keys(w.roundResults).length} · final score ${w.running}` };
    },
  });
}

// --- Bob's 27 ---
function bobs27PanelSpec(game){
  const p = game.players[0];
  const results = Array.from({length:20}, (_,i) => p.roundResults[i+1]);
  const played = results.filter(r => r != null);
  const hitRounds = played.filter(r => r > 0).length;
  return {
    heroes: [
      { title: p.name, sub: p.running > 0 ? 'Final score · survived all 20' : 'Final score · went bust', value: p.running },
      { title: 'Doubles hit', sub: `${hitRounds} of ${played.length} round${played.length===1?'':'s'} scored`,
        value: `${hitRounds}/${played.length}` },
    ],
    shelf: {
      title: 'The twenty doubles', long: true,
      cells: results.map((r,i) => panelResultCell(`D${i+1}`, r != null, (r||0) > 0,
        r == null ? 'not reached' : r > 0 ? `+${r}` : `−${(i+1)*2}`)),
    },
    // A full house is all three darts in the round's double — a gain of
    // 3 × 2 × round. Counted over `results` (index === round − 1), never over
    // the filtered `played`, whose indices no longer name their own round.
    tallies: [
      { emoji:'🎯', value:results.filter((r,i) => r != null && r === (i+1)*6).length, label:'full houses' },
      { emoji:'🥇', value:played.length ? Math.max(...played) : 0, label:'best round' },
      { emoji:'💀', value:played.filter(r => r === 0).length, label:'missed doubles' },
    ],
  };
}

function newMatchPlayerBobs27(name){
  return { name, running:27, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0, roundResults:{} };
}

function resetPlayerForNextLegBobs27(p, game, newSet){
  p.running = 27; p.legDarts = 0; p.roundResults = {};
  if(newSet) p.setDarts = 0;
}

function playerSnapshotBobs27(p){
  return {
    name:p.name, running:p.running, legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0,
    roundResults:Object.assign({}, p.roundResults)
  };
}
