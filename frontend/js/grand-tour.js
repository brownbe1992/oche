'use strict';
/* Grand Tour — a practice tour of every bed on the board.
 *
 *   Singles S1-S20, then Trebles T1-T20, then Doubles D1-D20: three darts at each,
 *   1 / 3 / 2 points per hit on that exact bed. Then 15 darts at the bull (five
 *   visits): outer bull 2, inner bull 4. 65 visits, 195 darts, a perfect tour 420.
 *
 * The rule itself lives in frontend/scoring.js (grandTourRoundTarget(),
 * grandTourDartPoints(), evaluateVisitGrandTour()) — shared with the server's
 * per-visit check and the Player Profile stats, so nothing in this file decides
 * what a dart is worth.
 *
 * One or two players. Solo is a practice tour; two players is a head-to-head tour,
 * both throwing at the same target in turn (the round only advances once both have
 * thrown, exactly like Shanghai), decided on points after the last bull visit — see
 * grandTourDecideWinnerIndex() for the tie-break. Either way it is ONE tour: the
 * registry pins both practice and head-to-head to one leg of one set, since "first
 * to two tours" would be a 390-dart-a-player evening.
 *
 * A CLASSIC SCRIPT sharing one global scope with index.html and every sibling file,
 * and it must contain only function declarations, because these load BEFORE the
 * inline script. frontend/js/bobs-27.js carries the full explanation of both points.
 */

// The Home page leaderboard: each player's best finished tour, split by tab the
// same way every other dual-mode type's board is — solo tours on Practice,
// two-player tours on H2H. A best is a best, but beating your own score alone and
// beating it while someone is throwing against you are different feats.
function renderHomeTabBodyGrandTour(){
  const el = document.getElementById('home-tab-body');
  const data = homeData.grandTour && homeData.grandTour[homeTab];
  if(!data){ el.innerHTML = `<p class="pp-meta">Loading…</p>`; return; }
  const board = leaderboardSectionHtml(data.leaderboard || [], {
    score: r => `${r.bestScore}<span class="pp-meta"> / ${GRAND_TOUR_MAX_POINTS}</span>`,
    meta: r => fmtDate(r.achievedAt),
    emptyMsg: homeTab === 'h2h'
      ? 'No two-player tours finished yet — take someone on the Grand Tour.'
      : 'None recorded yet — finish a Grand Tour to claim the top spot.',
  });
  el.innerHTML = `
    <div class="pp-section">
      <div class="pp-section-title">🚴 Grand Tour — Best Tour Score</div>
      ${board}
    </div>`;
}

// "S 63 · T 18 · D — · B 44" — the four stage accuracies on one line. A stage not
// reached yet reads as a dash rather than 0%, because nothing has been missed there.
// Each figure is its own .fig so a narrow card wraps between figures, never inside
// one (app.css has the "why"). Returns markup: every part of it is a constant or a
// number, so there is nothing to escape.
function grandTourStageLine(tally){
  return GRAND_TOUR_STAGES.map(s => {
    const pct = grandTourAccuracy(tally, s.key).pct;
    return `<span class="fig">${s.label[0]} ${pct == null ? '—' : Math.round(pct)}</span>`;
  }).join(' · ');
}

// The in-app scoreboard. One card per player (name, points, overall accuracy, the
// four stage figures), then a line naming the target. The TV screen (/display) is
// where the lit-up board lives; on the phone the input itself is the board, so a
// second one here would only compete with it for space.
function renderGameGrandTour(){
  const sb = document.getElementById('scoreboard'); sb.innerHTML = '';
  const target = grandTourRoundTarget(game.grandTourRound);
  game.players.forEach((p, i) => {
    const active = i === game.current;
    const all = grandTourAccuracy(p.tally);
    const row = document.createElement('div');
    row.className = 'pscore' + (active ? ' active' : '');
    row.innerHTML = `
      <div>
        <div class="nm">${escapeHtml(p.name)} <span class="nm-out">grand tour</span></div>
        ${active ? '<div class="turnflag">▸ throwing</div>' : ''}
      </div>
      <div class="meta">
        <div class="avgs"><span class="fig"><b>${all.pct == null ? '—' : Math.round(all.pct) + '%'}</b> accuracy</span> · <span class="fig">${all.darts} dart${all.darts === 1 ? '' : 's'}</span></div>
        <div class="standing">${grandTourStageLine(p.tally)}</div>
      </div>
      <div class="rem-wrap">
        <div class="rem">${p.totalPoints}</div>
      </div>`;
    sb.appendChild(row);
  });
  roundBannerInto(sb, grandTourTargetLine(target));
  renderSlots();
  renderPad();
  pushLive();
}

// "Trebles · Treble 9 (9 of 20) — 3 points a hit". The bull stage counts darts
// rather than visits, because the owner's spec is "fifteen throws at bullseye".
// It names the visit's RANGE ("darts 10–12"), not the next dart: this line is only
// redrawn when a visit is entered (a dart in between just moves the slots — see
// afterDartSlotsOnly()), so a single-dart count would sit there going stale.
function grandTourTargetLine(target){
  const first = (target.stageRound - 1) * 3 + 1;
  const where = target.stage === 'bull'
    ? `darts ${first}–${first + 2} of ${GRAND_TOUR_BULL_DARTS}`
    : `${target.stageRound} of ${target.stageRounds}`;
  return `${target.stageLabel} · ${target.label} (${where}) — ${target.pointsNote}`;
}

function enterTurnGrandTour(){
  if(noDartsThrown()) return;
  const p = game.players[game.current];
  const ev = GAME_TYPES.grand_tour.evaluateVisit(p, game.darts, game);

  announceTurn(`${p.name} scores ${ev.scored} at ${ev.target.label} — ${ev.totalPoints} in all.`);

  // Snapshot before mutating, for undo. The snapshot is a SHALLOW copy, which is
  // safe here only because `tally` is replaced wholesale below (evaluateVisit hands
  // back a fresh copy) rather than edited in place — keep it that way.
  pushVisitSnapshot(p,
    ['totalPoints', 'tally', 'legDarts', 'setDarts', 'gameDarts'],
    ['grandTourRound']);

  p.totalPoints = ev.totalPoints;
  p.tally = ev.tally;
  const dartsThrown = game.darts.length;
  p.legDarts += dartsThrown; p.setDarts += dartsThrown; p.gameDarts += dartsThrown;

  // No bust, checkout or legWon — a tour is decided on totals after the last round,
  // never by one visit. addTurn()'s grand_tour guard (backend/db.js) refuses all three
  // and re-scores the darts itself, so `scored` here is checked, not trusted.
  DB.recordTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:ev.scored, bust:false, checkout:false, checkoutPoints:null,
    darts: mapDartsForRecord(game.darts) });

  const turnRecord = { player:p.name, scored:ev.scored, darts:game.darts.slice() };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  awardTimeOfDayBadges(p);

  if(ev.matchComplete){
    onLegWonGrandTour(ev.winnerIndex);
    return;
  }

  if(ev.roundComplete) game.grandTourRound += 1;
  game.darts = []; game.busted = false; game.won = false;
  advanceToNextActivePlayer(game);
  game.turnSeq += 1;
  const next = grandTourRoundTarget(game.grandTourRound);
  const status = document.getElementById('status');
  status.className = 'status';
  status.textContent = game.players.length > 1
    ? `${game.players[game.current].name} — ${next.label}. ${next.pointsNote}.`
    : `${next.label} — ${next.pointsNote}.`;
  renderGameGrandTour();
}

function undoLastTurnGrandTour(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  restoreVisitSnapshot(snap);
  _finishUndo(snap, renderGameGrandTour, { restoreCurrent: true, resetDarts: true });
}

function onLegWonGrandTour(wi){
  const w = game.players[wi];
  w.legsWon += 1;
  const legsAtWin = new Map(game.players.map(p => [p, p.legsWon]));
  const opp = game.players.length === 2 ? game.players.find(p => p !== w) : null;
  advanceLegSetGame(w, {
    legsAtWin, opp,
    // Solo, "MATCH WON!" would read wrong for a practice tour, so it gets its own
    // card; two players get the result as a score line.
    momentCard: () => {
      const pct = grandTourAccuracy(w.tally).pct;
      return opp
        ? { icon:'🚴', headline:'GRAND TOUR WON!', player:w.name,
            statLine:`${w.totalPoints} – ${opp.totalPoints} against ${opp.name}` }
        : { icon:'🚴', headline:'TOUR COMPLETE!', player:w.name,
            statLine:`${w.totalPoints} of ${GRAND_TOUR_MAX_POINTS} points · ${Math.round(pct)}% accuracy` };
    },
  });
}

// The finish screen: points as the hero, the four stages as the shelf (each with
// its points out of the stage maximum and its accuracy), and — two players — the
// usual side-by-side columns.
function grandTourPanelSpec(game, winner, kind){
  const lead = panelLeadPlayer(winner);
  const maxFor = s => s.key === 'bull' ? GRAND_TOUR_BULL_DARTS * s.innerPoints : s.rounds * 3 * s.points;
  return {
    heroes: panelHeroesByPlayer(winner, p => p.totalPoints || 0,
      p => { const pct = grandTourAccuracy(p.tally).pct; return `Points of ${GRAND_TOUR_MAX_POINTS} · ${pct == null ? '—' : Math.round(pct) + '%'} accuracy`; }),
    shelf: {
      title: `${lead.name}'s tour`,
      cells: GRAND_TOUR_STAGES.map(s => {
        const st = lead.tally[s.key];
        const pct = grandTourAccuracy(lead.tally, s.key).pct;
        return panelResultCell(s.label, st.darts > 0, st.hits > 0,
          st.darts === 0 ? 'not reached' : `${st.points}/${maxFor(s)} pts · ${Math.round(pct)}%`);
      }),
    },
    tallies: [
      { emoji:'🎯', value: grandTourAccuracy(lead.tally).hits, label:'hits' },
      { emoji:'🔱', value: lead.tally.treble.hits, label:'trebles' },
      { emoji:'🐂', value: lead.tally.bull.hits, label:'bulls' },
    ],
    columns: game.players.length > 1 ? h2hPanelColumns(winner, kind === 'game' ? 'game' : 'leg') : undefined,
  };
}

function newMatchPlayerGrandTour(name){
  return { name, totalPoints:0, tally:newGrandTourTally(), legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0 };
}

function resetPlayerForNextLegGrandTour(p, game, newSet){
  p.totalPoints = 0; p.tally = newGrandTourTally(); p.legDarts = 0;
  if(newSet) p.setDarts = 0;
}

// What the live scoreboard receives per player. The tally is copied (not the
// live object), so a snapshot already sent can never change underneath /display.
function playerSnapshotGrandTour(p){
  return {
    name:p.name, totalPoints:p.totalPoints||0, tally:cloneGrandTourTally(p.tally),
    legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0
  };
}
