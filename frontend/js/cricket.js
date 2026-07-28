'use strict';
/* Cricket (docs/game-modes-roadmap.md build-order step 2) — marks and points.
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
function setCricketPreset(preset){
  setup.cricketPreset = preset;
  setPressed({classic:'cricket-preset-classic', custom:'cricket-preset-custom'}, preset);
  document.getElementById('cricket-custom-body').hidden = (preset !== 'custom');
  if(preset === 'custom' && setup.cricketCustomNumbers.length===0) fillCricketClassicIntoCustom();
}

// docs/archive/cutthroat-cricket-roadmap.md's Standard/Cut-throat toggle. Resolved open
// question: 2-player cut-throat is allowed (simplest — it's still a legal,
// nearly-standard-equivalent game with inverted totals), just nudged toward 3+
// in the blurb below, where the variant's real bite (points landing on EVERY
// open opponent at once) actually shows up.
function setCricketVariant(variant){
  setup.cricketVariant = variant;
  setPressed({standard:'cricket-variant-standard', cutthroat:'cricket-variant-cutthroat'}, variant);
  const blurb = document.getElementById('cricket-variant-blurb');
  if(blurb) blurb.textContent = variant==='cutthroat'
    ? "Closing a number an opponent hasn't puts YOUR points on every opponent who still has it open instead — lowest points wins. Shines with 3+ players."
    : "Closing a number your opponent hasn't lets you keep scoring on it — highest points wins.";
}

function fillCricketClassicIntoCustom(){
  setup.cricketCustomNumbers = CRICKET_STANDARD_NUMBERS.slice();
  renderCricketNumberGrid();
}

function renderCricketNumberGrid(){
  const grid = document.getElementById('cricket-number-grid');
  if(!grid) return;
  grid.innerHTML = '';
  for(let n=1;n<=20;n++) grid.appendChild(cricketNumberToggleBtn(n));
  grid.appendChild(cricketNumberToggleBtn(25));
  updateCricketCustomCount();
}

function cricketNumberToggleBtn(n){
  const b=document.createElement('button');
  b.type='button';
  b.className='cricket-number-toggle';
  b.setAttribute('aria-pressed', String(setup.cricketCustomNumbers.includes(n)));
  b.textContent = cricketNumberLabel(n);
  b.onclick = ()=>toggleCricketNumber(n);
  return b;
}

function toggleCricketNumber(n){
  const i = setup.cricketCustomNumbers.indexOf(n);
  if(i>=0) setup.cricketCustomNumbers.splice(i,1);
  else setup.cricketCustomNumbers.push(n);
  renderCricketNumberGrid();
}

function updateCricketCustomCount(){
  const el = document.getElementById('cricket-custom-count');
  if(el) el.textContent = `${setup.cricketCustomNumbers.length} of 7`;
}

// The definitive set of numbers this match will use, after the classic/custom
// choice — used both for New Game validation and to build game.config.numbers.
function resolveCricketNumbers(){
  return setup.cricketPreset === 'custom' ? setup.cricketCustomNumbers.slice() : CRICKET_STANDARD_NUMBERS.slice();
}

function renderGameCricket(){
  const sb = document.getElementById('scoreboard'); sb.innerHTML='';
  const configNumbers = game.config.numbers || CRICKET_STANDARD_NUMBERS;
  // Traditional chalkboard order: highest number down to lowest, Bull last.
  const numbers = configNumbers.filter(n=>n!==25).sort((a,b)=>b-a);
  if(configNumbers.includes(25)) numbers.push(25);

  const bodyRows = numbers.map(n=>{
    const lbl = cricketNumberLabel(n);
    const cells = game.players.map((p,i)=>{
      const m = p.marks[n] || 0;
      const active = i===game.current;
      return `<div class="cs-cell${active?' active':''}">${cricketMarkGlyph(m, lbl)}</div>`;
    }).join('');
    return `<div class="cs-row"><div class="cs-label">${lbl}</div>${cells}</div>`;
  }).join('');

  const pointCells = game.players.map((p,i)=>{
    const active = i===game.current;
    return `<div class="cs-cell${active?' active':''}"><span class="cs-points">${p.points||0}</span></div>`;
  }).join('');

  // docs/archive/cutthroat-cricket-roadmap.md: the footer label is the one place the
  // scoreboard needs to say which direction "winning" points go, since cutthroat
  // otherwise renders identically to standard (same marks, same points cells).
  const ptsLabel = game.config.variant === 'cutthroat' ? 'Pts (lowest wins)' : 'Pts';
  csTableInto(sb, csHeadCellsHtml(), bodyRows, ptsLabel, pointCells);

  renderSlots();
  renderPad();
  pushLive();
}

// Traditional chalkboard marks: blank (0), / (1), X (2), circled X (3+/closed).
function cricketMarkGlyph(n, numberLabel){
  const sr = n>=3 ? `<span class="sr-only">${numberLabel} closed</span>` : (n>0 ? `<span class="sr-only">${numberLabel}: ${n} of 3 marks</span>` : '');
  if(n<=0) return sr;
  if(n===1) return `<span class="cs-mark cs-mark-1" aria-hidden="true">/</span>${sr}`;
  if(n===2) return `<span class="cs-mark cs-mark-2" aria-hidden="true">✕</span>${sr}`;
  return `<span class="cs-mark cs-mark-3" aria-hidden="true">✕</span>${sr}`;
}

function renderPadCricket(full){
  const board = document.getElementById('dart-board-wrap');
  if(board) board.classList.add('hidden');
  const bounceBtn = document.getElementById('bounce-out-btn');
  if(bounceBtn) bounceBtn.disabled = full;
  const multi = document.getElementById('multi-row');
  if(multi) multi.classList.remove('hidden');
  const pad = document.getElementById('pad');
  if(!pad) return;
  pad.classList.remove('hidden');
  pad.classList.add('cricket-pad');
  const p = game.players[game.current];
  const numbers = game.config.numbers || CRICKET_STANDARD_NUMBERS;

  // Item 67 (docs/code-quality-roadmap.md), the same "build once, then toggle"
  // treatment item 57b gave the default pad. What is REBUILT here is only what
  // can actually change shape: the seven target buttons and their `throwDart(n)`
  // closures are fixed for the whole match, and the off-target picker's presence
  // is fixed until somebody taps the toggle. The marks glyph and the closed state
  // DO change on every dart, so those are written onto the existing buttons below
  // instead of being a reason to tear the whole pad down and re-attach fourteen
  // fresh event handlers per throw.
  const key = `cricket:${numbers.join(',')}:${cricketOffTargetOpen ? 1 : 0}`;
  const rebuild = pad.dataset.padKey !== key;
  if(rebuild){
    pad.innerHTML = '';
    numbers.forEach(n=>{
      const b = document.createElement('button');
      b.className = 'cricket-target';
      b.innerHTML = `<span class="ct-num">${cricketNumberLabel(n)}</span><span class="ct-marks" aria-hidden="true"></span>`;
      b.onclick = () => throwDart(n);
      pad.appendChild(b);
    });
    const miss=document.createElement('button');
    miss.className='miss'; miss.textContent='Miss';
    miss.onclick=()=>throwDart(0); pad.appendChild(miss);
  }
  // Per-dart state, written onto whichever buttons are there — freshly built or not.
  const targetBtns = pad.querySelectorAll('.cricket-target');
  numbers.forEach((n, i)=>{
    const b = targetBtns[i];
    if(!b) return;
    const m = p.marks[n] || 0;
    const closed = m >= 3;
    b.classList.toggle('closed', closed);
    const glyph = b.querySelector('.ct-marks');
    if(glyph) glyph.textContent = marksGlyph(m);
    b.setAttribute('aria-label', `${cricketNumberLabel(n)}${closed ? ' — closed' : ` — ${Math.min(3,m)} of 3 marks`}`);
  });

  // docs/bug-roadmap.md BUG-23: a dart landing on a real number that just isn't
  // in play this match (e.g. 1-14 in classic Cricket, since only 7 of the 21
  // possible numbers are ever live) is a genuine board hit, not a miss — but
  // the 7 target buttons + Miss above have no way to say which non-target
  // number it actually was, forcing every one of them to be logged as "Miss"
  // and corrupting Dart Analytics' sector/treble-rate stats. This collapsed-by-
  // default picker lets it be logged with its real sector instead; scoring is
  // unaffected either way (evaluateVisitCricket() already no-ops any sector not
  // in `numbers`, regardless of which specific non-target number it is).
  if(rebuild){
    const offTargetNumbers = CRICKET_ALL_NUMBERS.filter(n => !numbers.includes(n));
    const wrap = document.createElement('div');
    wrap.className = 'cricket-offtarget-wrap';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cricket-offtarget-toggle';
    toggle.textContent = cricketOffTargetOpen ? 'Hit a different number ▴' : 'Hit a different number ▾';
    toggle.setAttribute('aria-expanded', String(cricketOffTargetOpen));
    toggle.onclick = () => { cricketOffTargetOpen = !cricketOffTargetOpen; renderPad(); };
    wrap.appendChild(toggle);
    if(cricketOffTargetOpen){
      const grid = document.createElement('div');
      grid.className = 'cricket-offtarget-grid';
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Hit a different number — not in play this match, no marks');
      offTargetNumbers.forEach(n=>{
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cricket-offtarget-btn';
        b.textContent = cricketNumberLabel(n);
        b.setAttribute('aria-label', `${cricketNumberLabel(n)} — not in play, no marks`);
        b.onclick = () => throwDart(n);
        grid.appendChild(b);
      });
      wrap.appendChild(grid);
    }
    pad.appendChild(wrap);
    pad.dataset.padKey = key;
  }
  // One sweep for every button the pad owns — targets, Miss, the off-target
  // toggle and its grid — rather than a `disabled = full` repeated at each
  // creation site, which only ran on the frames that rebuilt.
  for(const b of pad.querySelectorAll('button')) b.disabled = full;
}

/* ----- Cricket turn commit (dispatched from enterTurn()) ----- */
function enterTurnCricket(){
  if(noDartsThrown()) return;
  const p = game.players[game.current];
  const ev = GAME_TYPES.cricket.evaluateVisit(p, game.darts, game);
  const cutthroat = game.config.variant === 'cutthroat';

  // Same screen-reader convention as X01's enterTurn(): announce the committed
  // outcome, with a distinct phrasing for the leg-winning visit and — cutthroat
  // only — for a visit that put points ONTO opponents rather than the shooter's
  // own total (docs/archive/cutthroat-cricket-roadmap.md's accessibility section: "a new
  // event class... announce it, not just a number ticking up").
  const _hitOpponents = cutthroat ? ev.opponentGains.filter(g=>g.gained>0) : [];
  if(ev.win) announce(cutthroat
    ? `${p.name} closes out and wins the leg with only ${ev.points} point${ev.points===1?'':'s'} against.`
    : `${p.name} closes out and wins the leg with ${ev.points} points.`);
  else if(_hitOpponents.length) announceTurn(`${p.name} puts ${ev.pointsThisVisit} point${ev.pointsThisVisit===1?'':'s'} on ${_hitOpponents.map(g=>g.name).join(' and ')}.`);
  else announceTurn(`${p.name} scores ${ev.pointsThisVisit} point${ev.pointsThisVisit===1?'':'s'} this visit.`);

  // snapshot state before mutations so undoLastTurn() can restore it. badgeReverts/
  // voided mirror X01's enterTurn() snapshot (see its comment) — needed now that
  // Cricket has its own achievements to revoke on undo. playersPoints snapshots
  // EVERY player's points/gamePointsReceived, not just the shooter's — a cutthroat
  // visit can change opponents' totals too (see evaluateVisitCricket()'s own
  // comment), so undo must be able to restore all of them, not just p.
  const _snap = { pi:game.current, marks:Object.assign({}, p.marks),
    playersPoints: game.players.map(pl => ({ points:pl.points, gamePointsReceived:pl.gamePointsReceived })),
    legDarts:p.legDarts, setDarts:p.setDarts, gameDarts:p.gameDarts,
    legWorstPointsDeficit:p.legWorstPointsDeficit, roundMarksLen:p.legRoundMarks.length,
    ltLen:game.currentLegTurns.length, stLen:game.sessionTurns.length,
    badgeReverts:[], voided:false };
  pushTurnSnapshot(_snap);

  // Comeback Kid (Cricket) tracking: the worst points deficit seen at any point
  // this leg (needs an opponent to trail behind — mirrors X01's Comeback Kid,
  // game-modes-roadmap.md "New Cricket-native badges"). Sampled BEFORE this
  // visit's points update, same "deepest behind as you step up to throw"
  // timing X01 uses — neither player's points have changed yet at sampling time,
  // regardless of variant. Standard: higher points is better, so "trailing" means
  // the opponent is ahead (opp - me). Cutthroat inverts which side "ahead" means
  // (lower is better), so "trailing" means I've received MORE than they have
  // (me - opp) — docs/archive/cutthroat-cricket-roadmap.md's open question, resolved as a
  // variant-aware condition rather than a scope-out.
  // Active-player count, not game.players.length — same fix/reasoning as
  // X01's own Comeback Kid sampling in enterTurn(): a bowed-out player stays
  // IN game.players, so this must match onLegWonCricket()'s active-count
  // awarding check or the sampling freezes stale after a bow-out.
  const _activeForDeficit = game.players.filter(x=>!x.dnf);
  if(_activeForDeficit.length===2){
    const _opp = _activeForDeficit.find(x=>x!==p);
    if(_opp){
      const deficit = cutthroat ? (p.points - _opp.points) : ((_opp.points||0) - p.points);
      p.legWorstPointsDeficit = Math.max(p.legWorstPointsDeficit, deficit);
    }
  }

  p.marks = ev.marks;
  p.points = ev.points;
  // Cutthroat: apply this visit's points onto every opponent it hit — both their
  // leg-scoped `points` (what the scoreboard shows) and their game-scoped
  // `gamePointsReceived` (never leg-reset — 🔪 Stone Cold's tracker, checked at
  // game-win time in onLegWonCricket()).
  if(cutthroat){
    _hitOpponents.forEach(g=>{
      const opp = game.players.find(x=>x.name===g.name);
      opp.points += g.gained;
      opp.gamePointsReceived = (opp.gamePointsReceived||0) + g.gained;
    });
  }
  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;

  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.scored, bust:false, checkout:false, checkoutPoints:null, legWon:ev.win,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.scored, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  // Novelty time-of-day badges — shared with X01's enterTurn(), see
  // awardTimeOfDayBadges() (docs/game-modes-roadmap.md "Cricket badge parity").
  awardTimeOfDayBadges(p);

  // Cricket achievements (game-modes-roadmap.md build-order step 3) — the direct
  // analogs of X01's 180/nine-darter, detected the same way (inspect this visit's
  // raw darts / legDarts right after they're committed above).
  const _inPlayNumbers = game.config.numbers || CRICKET_STANDARD_NUMBERS;
  // 9 Marks: 3 darts, each a treble on an in-play number — the maximum possible
  // marks in one visit, same framing as 180 being the max possible X01 visit score.
  const marksThisVisit = game.darts.reduce((s,d)=> s + (_inPlayNumbers.includes(d.sector) ? d.mult : 0), 0);
  p.legRoundMarks.push(marksThisVisit);
  if(game.darts.length===3 && marksThisVisit===9){
    queueBadge('cricket9marks', p.name);
    awardRecurringBadge(p.name, 'cricket9marks', 'cricket9marks',
      { icon:'🎯', headline:'9 MARKS!', player:p.name, statLine:'Three trebles, one visit' });
  }
  if(ev.win){
    // Perfect Leg: closed every in-play number using the fewest darts physically
    // possible for this match's target set (each non-Bull number closes in a
    // single treble; Bull can't be trebled — makeDart() already downgrades a
    // "treble bull" tap to a single — so it needs a minimum of 2 darts). A win at
    // exactly this minimum already implies enough bonus marks were scored to
    // strictly lead (evaluateVisitCricket()'s win condition guarantees that), so
    // no separate points check is needed. Cricket's analog of a nine-darter.
    const _nonBullCount = _inPlayNumbers.filter(n=>n!==25).length;
    const _minDarts = _nonBullCount + (_inPlayNumbers.includes(25) ? 2 : 0);
    if(p.legDarts === _minDarts){
      queueBadge('cricketperfectclose', p.name);
      awardRecurringBadge(p.name, 'cricketperfectclose', 'cricketperfectclose',
        { icon:'🏆', headline:'PERFECT LEG!', player:p.name, statLine:`Closed every number in ${_minDarts} darts` });
    }
    onLegWonCricket(game.current);
    return;
  }

  game.darts=[]; game.busted=false; game.won=false;
  advanceToNextActivePlayer(game);
  game.turnSeq += 1;
  document.getElementById('status').className='status';
  document.getElementById('status').textContent='Tap a number to score.';
  renderGameCricket();
}

function undoLastTurnCricket(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[snap.pi];
  p.marks = snap.marks;
  // Restore every player's points/gamePointsReceived, not just the shooter's —
  // a cutthroat visit can change opponents' totals too (see enterTurnCricket()'s
  // own comment on why _snap.playersPoints covers the whole roster).
  game.players.forEach((pl, i) => {
    pl.points = snap.playersPoints[i].points;
    pl.gamePointsReceived = snap.playersPoints[i].gamePointsReceived;
  });
  p.legDarts = snap.legDarts; p.setDarts = snap.setDarts; p.gameDarts = snap.gameDarts;
  p.legWorstPointsDeficit = snap.legWorstPointsDeficit;
  // Per-visit marks log feeding the leg-complete panel's MPR hero and best-round
  // tally. Truncate rather than pop: same discipline as currentLegTurns below,
  // so a snapshot taken before the push and one taken after both restore right.
  p.legRoundMarks.length = snap.roundMarksLen;
  game.currentLegTurns.length = snap.ltLen;
  game.sessionTurns.length = snap.stLen;

  _finishUndo(snap, renderGameCricket, { restoreCurrent: true, resetDarts: true });
}

function onLegWonCricket(wi){
  const w = game.players[wi];
  // Active-player count, not game.players.length: a departed (bowed-out)
  // player stays IN game.players (only their `dnf` flag is set), so a match
  // that started with 4 players and has since shrunk to a genuine 2-player
  // decider via bow-outs must still be recognized as H2H here — otherwise
  // every opponent-gated badge below (Whitewash, Comeback Kid) silently never
  // fires again for the rest of that match.
  const active = game.players.filter(p=>!p.dnf);
  const opp = active.length===2 ? active.find(p=>p!==w) : null;
  w.legsWon += 1;

  // Whitewash: the opponent closed zero numbers by the time this leg ended.
  if(opp && isCricketWhitewash(opp.marks)){
    queueBadge('cricketwhitewash', w.name);
    awardRecurringBadge(w.name, 'cricketwhitewash', 'cricketwhitewash',
      { icon:'🧹', headline:'WHITEWASH', player:w.name, statLine:`${opp.name} never closed a number` });
  }
  // Comeback Kid (Cricket): won after trailing on points by CRICKET_COMEBACK_THRESHOLD+
  // at some point this leg (tracked per-visit in enterTurnCricket()).
  if(opp && cricketComebackAchieved(w.legWorstPointsDeficit)){
    queueBadge('cricketcomebackkid', w.name);
    awardRecurringBadge(w.name, 'cricketcomebackkid', 'cricketcomebackkid',
      { icon:'🔥', headline:'COMEBACK KID', player:w.name, statLine:`Trailed by ${CRICKET_COMEBACK_THRESHOLD}+ points, won anyway` });
  }

  advanceLegSetGame(w, {
    gate: () => !game.practice && w.legsWon >= game.legsPerSet,   // set won (H2H only)
    opp,
    momentCard: false,   // no matchwin moment card built for Cricket yet
    // 🔪 Stone Cold (docs/archive/cutthroat-cricket-roadmap.md): won a 3+ player cut-throat
    // GAME having received zero points across every leg of it — checked here (not
    // per-leg) since "the game" is what the badge is scoped to; w.gamePointsReceived
    // is never leg-reset (see newMatchPlayerCricket()), so it already reflects the
    // whole match by the time the winning leg gets here.
    extraGameWonBadge: () => {
      if(game.config.variant === 'cutthroat' && cricketStoneColdAchieved(w.gamePointsReceived, game.players.length)){
        queueBadge('cricketstonecold', w.name);
        awardRecurringBadge(w.name, 'cricketstonecold', 'cricketstonecold',
          { icon:'🔪', headline:'STONE COLD', player:w.name, statLine:'Won a cut-throat game without receiving a point' });
      }
    },
  });
}

// --- Cricket ---
// MPR is Cricket's 3-dart average, so it is the hero, exactly as the X01 panel
// leads with its own. p.legRoundMarks is the per-visit marks log kept by
// enterTurnCricket() — p.marks can't stand in for it, since it caps at the
// closing 3 and hides every overkill mark scored after that.
function cricketPanelSpec(game, winner, kind){
  const scope = kind==='game' ? 'game' : 'leg';
  const numbers = (game.config && game.config.numbers) || CRICKET_STANDARD_NUMBERS;
  const mprOf = p => {
    const rounds = p.legRoundMarks || [];
    return rounds.length ? (rounds.reduce((s,m)=>s+m,0) / rounds.length).toFixed(2) : '—';
  };
  const lead = panelLeadPlayer(winner);
  const rounds = lead.legRoundMarks || [];
  const nineMarkRounds = rounds.filter(m => m >= 9).length;
  const bestRound = rounds.length ? Math.max(...rounds) : 0;
  return {
    heroes: panelHeroesByPlayer(winner, mprOf,
      p => `Marks per round · ${p.points||0} point${(p.points||0)===1?'':'s'}`),
    shelf: {
      title: 'The seven numbers',
      cells: numbers.map(n => {
        const closers = game.players.filter(p => (p.marks[n]||0) >= 3);
        return panelResultCell(cricketNumberLabel(n), closers.length > 0, true,
          closers.length === 0 ? 'open'
            : closers.length === game.players.length ? 'all closed'
            : closers.map(p => p.name).join(', '));
      }),
    },
    tallies: [
      { emoji:'9️⃣', value:nineMarkRounds, label: nineMarkRounds===1?'9-mark round':'9-mark rounds' },
      { emoji:'🔥', value:bestRound,       label:'best round (marks)' },
      { emoji:'🎯', value:rounds.length,   label:'rounds thrown' },
    ],
    columns: h2hPanelColumns(winner, scope),
  };
}

function cricketNumberLabel(n){ return n===25 ? 'Bull' : String(n); }

function newMatchPlayerCricket(name, config){
  const marks = {};
  (config && config.numbers || CRICKET_STANDARD_NUMBERS).forEach(n=>{ marks[n]=0; });
  return { name, marks, points:0, legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0,
    // Marks scored in each visit this leg, in order — the raw material for the
    // leg-complete panel's MPR hero and its best-round tally. Cricket's MPR is
    // its 3-dart average, so a completion screen without it is the same gap the
    // X01 panel had. Not derivable after the fact from p.marks (which caps at
    // the closing 3 and hides overkill), so it has to be logged per visit.
    legRoundMarks:[],
    legWorstPointsDeficit:0,   // largest deficit seen this leg (Comeback Kid — Cricket; direction depends on variant, see enterTurnCricket())
    gamePointsReceived:0 };    // cutthroat only: total points received across the WHOLE match (never leg-reset) — 🔪 Stone Cold's tracker
}

function resetPlayerForNextLegCricket(p, game, newSet){
  const marks = {};
  (game.config.numbers || CRICKET_STANDARD_NUMBERS).forEach(n=>{ marks[n]=0; });
  p.marks = marks; p.points = 0; p.legDarts = 0; p.legWorstPointsDeficit = 0;
  if(newSet) p.setDarts = 0;
  p.legRoundMarks = [];
}

function playerSnapshotCricket(p){
  const rounds = p.legRoundMarks || [];
  return {
    name:p.name, marks:Object.assign({}, p.marks), points:p.points||0,
    legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0,
    // MPR is Cricket's three-dart average, so the live scoreboard leads with it
    // exactly as X01's lane leads with its own — the same per-visit marks log
    // the leg-complete panel's hero reads (see newMatchPlayerCricket()), meaning
    // the TV and the results screen can't disagree about it.
    mpr: rounds.length ? Number((rounds.reduce((a,m)=>a+m,0) / rounds.length).toFixed(2)) : null,
    roundsThrown: rounds.length,
    bestRound: rounds.length ? Math.max(...rounds) : 0,
    nineMarkRounds: rounds.filter(m => m >= 9).length
  };
}
