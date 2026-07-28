'use strict';
/* Halve-It (docs/archive/halve-it-roadmap.md) — hit the round’s target or lose half your total. Includes the custom-target editor.
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
function setHalveItPreset(preset){
  setup.halveItPreset = preset;
  setPressed({classic:'halve-it-preset-classic', custom:'halve-it-preset-custom'}, preset);
  const body = document.getElementById('halve-it-custom-body');
  if(body) body.hidden = (preset !== 'custom');
  // Seed the custom list from the classic default the first time it's opened empty, so the
  // editor starts from a familiar, valid sequence rather than a blank slate.
  if(preset === 'custom' && setup.halveItCustomTargets.length === 0) fillHalveItClassicIntoCustom();
  else renderHalveItTargetRows();
}

function fillHalveItClassicIntoCustom(){
  setup.halveItCustomTargets = HALVE_IT_DEFAULT_TARGETS.map(t => ({ sector:t.sector, ring:t.ring }));
  renderHalveItTargetRows();
}

function addHalveItTargetRow(){
  if(setup.halveItCustomTargets.length >= HALVE_IT_MAX_ROUNDS){
    uiAlert(`Halve-It supports at most ${HALVE_IT_MAX_ROUNDS} rounds.`);
    return;
  }
  setup.halveItCustomTargets.push({ sector:20, ring:undefined });
  renderHalveItTargetRows();
}

function removeHalveItTargetRow(idx){
  setup.halveItCustomTargets.splice(idx, 1);
  renderHalveItTargetRows();
}

function updateHalveItTarget(idx, field, value){
  const t = setup.halveItCustomTargets[idx];
  if(!t) return;
  if(field === 'sector') t.sector = Number(value);
  else t.ring = value || undefined;  // '' (Any) -> undefined
  // The Bull has no treble ring — the server rejects it, so snap an invalid pick back to a
  // valid one and re-render rather than letting an unwinnable round be built.
  if(t.sector === 25 && t.ring === 'treble') t.ring = 'double';
  renderHalveItTargetRows();
}

function renderHalveItTargetRows(){
  const host = document.getElementById('halve-it-target-rows');
  const count = document.getElementById('halve-it-round-count');
  if(count) count.textContent = String(setup.halveItCustomTargets.length);
  if(!host) return;
  const sectorOpts = (sel) => {
    const opts = ['<option value="25"' + (sel===25?' selected':'') + '>Bull (25)</option>'];
    for(let n=20;n>=1;n--) opts.push(`<option value="${n}"${sel===n?' selected':''}>${n}</option>`);
    return opts.join('');
  };
  const ringOpts = (t) => {
    const rings = [['','Any'],['single','Single'],['double','Double']];
    if(t.sector !== 25) rings.push(['treble','Treble']);  // no treble-bull ring exists
    return rings.map(([v,l]) => `<option value="${v}"${(t.ring||'')===v?' selected':''}>${l}</option>`).join('');
  };
  host.innerHTML = setup.halveItCustomTargets.map((t,i) => `
    <div class="halve-it-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span class="pp-meta" style="min-width:64px">Round ${i+1}</span>
      <select aria-label="Round ${i+1} target number" onchange="updateHalveItTarget(${i},'sector',this.value)">${sectorOpts(t.sector)}</select>
      <select aria-label="Round ${i+1} required ring" onchange="updateHalveItTarget(${i},'ring',this.value)">${ringOpts(t)}</select>
      <button class="iconbtn" type="button" aria-label="Remove round ${i+1}" title="Remove round" onclick="removeHalveItTargetRow(${i})">✕</button>
    </div>`).join('');
}

// Returns the target sequence startGame() sends as config.targets, or null to use the
// classic default (omitting config.targets keeps HALVE_IT_DEFAULT_TARGETS server-side).
function resolveHalveItTargets(){
  if(setup.halveItPreset !== 'custom') return null;
  return setup.halveItCustomTargets.map(t => t.ring ? { sector:t.sector, ring:t.ring } : { sector:t.sector });
}

function renderGameHalveIt(){
  const sb = document.getElementById('scoreboard'); sb.innerHTML='';
  const targets = (game.config && game.config.targets) || HALVE_IT_DEFAULT_TARGETS;
  const maxRounds = targets.length;
  const lastRound = Math.max(maxRounds, game.halveItRound); // extend into extra rounds once reached

  const rows = [];
  for(let round=1; round<=lastRound; round++){
    const isCurrentRound = round === game.halveItRound;
    const target = halveItRoundTarget(round, targets);
    const cells = game.players.map((p,i)=>{
      const r = p.roundTotals[round];
      const halved = p.roundHalved && p.roundHalved[round];
      const active = i===game.current && isCurrentRound;
      return `<div class="cs-cell${active?' active':''}">${r!=null ? `<span class="cs-points">${halved?'½ ':''}${r}</span>` : ''}</div>`;
    }).join('');
    rows.push(`<div class="cs-row"><div class="cs-label">${escapeHtml(halveItTargetLabel(target))}</div>${cells}</div>`);
  }
  const bodyRowsHtml = rows.join('');

  const totalCells = game.players.map((p,i)=>{
    const active = i===game.current;
    return `<div class="cs-cell${active?' active':''}"><span class="cs-points">${p.total||0}</span></div>`;
  }).join('');

  csTableInto(sb, csHeadCellsHtml(), bodyRowsHtml, 'Total', totalCells);
  const liveTarget = halveItRoundTarget(game.halveItRound, targets);
  roundBannerInto(sb, `Round ${Math.min(game.halveItRound,maxRounds)} of ${maxRounds} — target ${halveItTargetLabel(liveTarget)}${game.halveItRound>maxRounds?' (extra rounds)':''}`);

  renderSlots();
  renderPad();
  pushLive();
}

function renderPadHalveIt(full){
  const targets = (game.config && game.config.targets) || HALVE_IT_DEFAULT_TARGETS;
  const target = halveItRoundTarget(game.halveItRound, targets);
  const ringPrefix = target.ring === 'double' ? 'D' : target.ring === 'treble' ? 'T' : '';
  const numLabel = target.sector === 25 ? 'Bull' : String(target.sector);
  renderSingleTargetPad(full, target.sector, `${ringPrefix}${numLabel}`, `${halveItTargetLabel(target)} — this round's target`);
}

// Halve-It's own target label (docs/archive/halve-it-roadmap.md) — a plain
// sector shows just the number; a ring-restricted target shows "Double 7"/
// "Treble 10"; sector 25 shows "Bull" (matching every other UI's own Bull
// label rather than the numeric 25).
function halveItTargetLabel(target){
  if(!target) return '';
  const num = target.sector === 25 ? 'Bull' : String(target.sector);
  if(!target.ring) return num;
  const ringLabel = target.ring === 'double' ? 'Double' : target.ring === 'treble' ? 'Treble' : 'Single';
  return `${ringLabel} ${num}`;
}

function enterTurnHalveIt(){
  if(noDartsThrown()) return;
  const p = game.players[game.current];
  const ev = GAME_TYPES.halve_it.evaluateVisit(p, game.darts, game);
  const maxRounds = ((game.config && game.config.targets) || HALVE_IT_DEFAULT_TARGETS).length;

  announceTurn(ev.halved
    ? `${p.name} misses ${halveItTargetLabel(ev.target)} entirely — halved to ${ev.total}.`
    : `${p.name} scores ${ev.gained} point${ev.gained===1?'':'s'} on ${halveItTargetLabel(ev.target)} — total ${ev.total}.`);

  // snapshot state before mutations so undoLastTurn() can restore it.
  pushVisitSnapshot(p,
    ['total', 'roundTotals', 'roundHalved', 'everHalved', 'lastVisitHalved',
     'legDarts', 'setDarts', 'gameDarts'],
    ['halveItRound']);

  p.total = ev.total; p.roundTotals = ev.roundTotals;
  // roundHalved (display-only, not part of evaluateVisitHalveIt()'s own pure
  // return): which rounds' cells the live scorecard marks with a ½ icon, per
  // the roadmap doc's own "icon + text, not a red flash alone" accessibility
  // note. It IS reconstructed on resume as of 2026-07 (item 65) — it used to be
  // a documented cosmetic gap, which meant a resumed leg's card showed a round
  // scoring 30 without showing that it had been halved to get there. Both
  // halves of the fix matter: rebuildHalveItState() now replays the marks, and
  // the halve_it `resume` member copies them across.
  p.roundHalved = Object.assign({}, p.roundHalved, { [game.halveItRound]: ev.halved });
  p.lastVisitHalved = ev.halved;
  if(ev.halved) p.everHalved = true;
  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;

  // docs/archive/halve-it-roadmap.md's own "bust=1 marks the halved visit" data-model
  // precedent — turns.scored stores the GAIN (0 on a halved visit), never the
  // halving delta itself, mirroring the Baseball/Shanghai "store the gain, derive
  // the rest" shape.
  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.gained, bust:ev.halved, checkout:false, checkoutPoints:null, legWon:false,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.gained, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  awardTimeOfDayBadges(p);

  if(ev.matchComplete){
    onLegWonHalveIt(ev.winnerIndex);
    return;
  }

  if(ev.roundComplete) game.halveItRound += 1;
  game.darts=[]; game.busted=false; game.won=false;
  advanceToNextActivePlayer(game);
  game.turnSeq += 1;
  document.getElementById('status').className='status';
  document.getElementById('status').textContent = `Round ${Math.min(game.halveItRound,maxRounds)} of ${maxRounds} — target ${halveItTargetLabel(halveItRoundTarget(game.halveItRound, (game.config&&game.config.targets)||HALVE_IT_DEFAULT_TARGETS))}.`;
  renderGameHalveIt();
}

function undoLastTurnHalveIt(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  restoreVisitSnapshot(snap);
  _finishUndo(snap, renderGameHalveIt, { restoreCurrent: true, resetDarts: true });
}

function onLegWonHalveIt(wi){
  const w = game.players[wi];
  w.legsWon += 1;

  // 🪓 Halved at the Death — the winner's own most recent visit (which
  // decided this leg) halved their total, and they still won.
  if(w.lastVisitHalved){
    queueBadge('halveitdeath', w.name);
    awardRecurringBadge(w.name, 'halveitdeath', 'halveitdeath',
      { icon:'🪓', headline:'HALVED AT THE DEATH!', player:w.name, statLine:`Won on ${w.total} after the final visit halved it` });
  }
  // 🛡️ No Half Measures — won without ever being halved, the whole leg.
  if(!w.everHalved){
    queueBadge('halveitnohalf', w.name);
    awardRecurringBadge(w.name, 'halveitnohalf', 'halveitnohalf',
      { icon:'🛡️', headline:'NO HALF MEASURES!', player:w.name, statLine:`Won on ${w.total} without ever being halved` });
  }

  const legsAtWin = new Map(game.players.map(p => [p, p.legsWon]));

  advanceLegSetGame(w, { legsAtWin, opp: game.players.length===2 ? game.players.find(p=>p!==w) : null });
}

function resetLegStateHalveIt(game){ game.halveItRound = 1; }

function halveItPanelSpec(game, winner, kind){
  const lead = panelLeadPlayer(winner);
  const targets = (game.config && game.config.targets) || HALVE_IT_DEFAULT_TARGETS;
  // roundTotals holds the RUNNING total after each round, so a halving shows up
  // as a drop rather than as a zero — which is exactly why the cell caption says
  // "halved" in words instead of leaving the number to imply it.
  const cells = targets.map((t, i) => {
    const round = i + 1;
    const total = lead.roundTotals[round];
    const halved = !!(lead.roundHalved && lead.roundHalved[round]);
    return panelResultCell(halveItTargetLabel(halveItRoundTarget(round, targets)), total != null, !halved,
      total == null ? 'not played' : halved ? `halved · ${total}` : String(total));
  });
  return {
    heroes: panelHeroesByPlayer(winner, p => p.total||0,
      p => p.everHalved ? 'Total · halved at least once' : 'Total · never halved'),
    shelf: { title: `${lead.name}'s card`, cells },
    tallies: [
      { emoji:'🪓', value:targets.filter((_,i)=> lead.roundHalved && lead.roundHalved[i+1]).length, label:'rounds halved' },
      { emoji:'🛡️', value:lead.everHalved ? 0 : 1, label:'clean cards' },
    ],
    columns: h2hPanelColumns(winner, kind==='game' ? 'game' : 'leg'),
  };
}

function newMatchPlayerHalveIt(name){
  // everHalved/lastVisitHalved (docs/archive/halve-it-roadmap.md's own 🛡️ No Half
  // Measures / 🪓 Halved at the Death badges): per-leg tracking, reset every leg
  // by resetPlayerForNextLegHalveIt() below.
  return { name, total:0, roundTotals:{}, roundHalved:{}, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0,
    everHalved:false, lastVisitHalved:false };
}

function resetPlayerForNextLegHalveIt(p, game, newSet){
  p.total = 0; p.roundTotals = {}; p.roundHalved = {}; p.legDarts = 0;
  p.everHalved = false; p.lastVisitHalved = false;
  if(newSet) p.setDarts = 0;
}

function playerSnapshotHalveIt(p){
  return {
    name:p.name, total:p.total||0, roundTotals:Object.assign({}, p.roundTotals),
    roundHalved:Object.assign({}, p.roundHalved),
    legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0
  };
}
