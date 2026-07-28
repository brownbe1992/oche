'use strict';
/* Around the Clock (docs/game-modes-roadmap.md) — 1 to 20 in order; one clock is one game.
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
// The race variant reaches a next leg; a solo clock never does (it ends the
// whole game on completion). roundOver gates every further dart, so a leg that
// starts with it still true is a leg nobody can throw in.
function resetLegStateAroundTheClock(game){
  game.roundOver = false; game.roundEndReason = null;
  game.atcLastDart = null; game.atcVisitDarts = 0;
}

// --- Around the Clock ---
// The one mode with no shelf, deliberately: twenty cells that are all "hit" by
// definition (the game only ends when every number is) would say nothing. Its
// tallies stand alone instead — see completionPanelHtml()'s own header.
function aroundTheClockPanelSpec(game, winner, kind){
  // A race leads with the same figure the solo run does — darts to clear the
  // clock — but one hero per player, so the margin is the story. The loser's
  // dart count is their progress, not a completion, which is why their shelf
  // line says how far they got rather than how fast they finished.
  if(game.players.length > 1){
    const w = panelLeadPlayer(winner);
    return {
      heroes: panelHeroesByPlayer(winner, p => p.roundDarts||0,
        p => (p.hitSet && p.hitSet.size >= 20)
          ? 'Darts to clear the clock'
          : `Darts · ${p.hitSet ? p.hitSet.size : 0} of 20 cleared`),
      shelf: { title: 'The twenty numbers', cells: Array.from({length:20}, (_,i)=>{
        const n = i + 1;
        const got = game.players.filter(p => p.hitSet && p.hitSet.has(n));
        return panelResultCell(String(n), got.length > 0, got.some(p => p.name === w.name),
          got.length === 0 ? 'nobody'
            : got.length === game.players.length ? 'everyone'
            : got.map(p => p.name).join(', '));
      }) },
      tallies: [
        { emoji:'🎯', value:w.roundTrebles||0, label:'trebles (winner)' },
        { emoji:'💨', value:w.roundMisses||0,  label:'misses (winner)' },
        { emoji:'📐', value:((w.roundDarts||0)/20).toFixed(1), label:'darts per number' },
      ],
      columns: h2hPanelColumns(winner, kind==='game' ? 'game' : 'leg'),
    };
  }
  const p = game.players[0];
  const darts = p.roundDarts||0;
  const sec = Math.max(0, Math.round((Date.now() - (p.roundStartedAt||Date.now()))/1000));
  return {
    heroes: [
      { title: p.name, sub: 'Darts to clear the clock', value: darts },
      // Darts per minute needs a real elapsed minute to divide by. Under a
      // second (a resumed clock whose start time was lost, or a scripted run)
      // the rate is meaningless, so the card says "elapsed" rather than
      // reporting the dart count itself as a per-minute figure.
      { title: 'Time', sub: darts && sec >= 1 ? `${(darts/(sec/60)).toFixed(1)} darts per minute` : 'Elapsed',
        value: `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}` },
    ],
    talliesTitle: 'Where the darts went',
    tallies: [
      { emoji:'🎯', value:p.roundTrebles||0, label: (p.roundTrebles||0)===1?'treble':'trebles' },
      { emoji:'⭕', value:p.roundDoubles||0, label: (p.roundDoubles||0)===1?'double':'doubles' },
      { emoji:'💨', value:p.roundMisses||0,  label: (p.roundMisses||0)===1?'miss':'misses' },
      { emoji:'📐', value:(darts/20).toFixed(1), label:'darts per number' },
    ],
  };
}

function newMatchPlayerAroundTheClock(name){
  // legsWon/setsWon: the race variant plays real best-of-N, so these carry the
  // same meaning they do in every other head-to-head mode. A solo clock never
  // increments them (it ends the whole game on completion) but still needs them
  // present — the scoreboard row prints a standing, and `undefined/3` is what a
  // missing one looks like on screen.
  return { name, hitSet: new Set(), roundDarts:0, roundTrebles:0, roundDoubles:0, roundMisses:0,
    roundStartedAt: Date.now(), sessionRounds:[], legsWon:0, setsWon:0 };
}

// Called between legs of a RACE only — a solo clock ends the whole game the
// moment it completes and never reaches a next leg (see the header comment).
// roundStartedAt restarts too, so each leg's elapsed time is that leg's.
function resetPlayerForNextLegAroundTheClock(p){
  p.hitSet = new Set(); p.roundDarts = 0; p.roundTrebles = 0; p.roundDoubles = 0; p.roundMisses = 0;
  p.roundStartedAt = Date.now();
}

function playerSnapshotAroundTheClock(p){
  // hitNumbers (not just a count) so the Live Scoreboard can render exactly which
  // numbers are still outstanding, the same live-progress-grid feedback the
  // controller itself shows via buildOutcomeGridHtml().
  // roundTrebles/roundDoubles/roundMisses: the Ring stage has read these since
  // the 2026-07 redesign, but they were never sent — every board showed "0
  // trebles, 0 misses" for a run that had plenty of both. Silent zeros, which
  // no test catches and only looking at the screen reveals.
  return { name:p.name, hitNumbers:[...p.hitSet], hit:p.hitSet.size||0, total:20,
    roundDarts:p.roundDarts||0, roundTrebles:p.roundTrebles||0,
    roundDoubles:p.roundDoubles||0, roundMisses:p.roundMisses||0,
    legsWon:p.legsWon||0, setsWon:p.setsWon||0 };
}

function throwDartAroundTheClock(sector, zone, missZone, missDepth, bounced){
  if(game.roundOver) return;
  const dart = makeDart(sector, bounced ? 1 : mult);
  mult = 1; updateMultUI();
  const p = game.players[game.current];
  const ev = evaluateDartAroundTheClock(dart, p.hitSet);

  // snapshot state before mutation so undoLastTurnAroundTheClock() can restore it.
  // badgeReverts/voided follow the same convention as every other game type's
  // snapshot (see trackBadgeForUndo()) — guided_clock is a moment-style
  // completion badge, so it DOES get revoked on undo.
  pushTurnSnapshot({ pi:game.current, hitSet: new Set(p.hitSet), roundDarts:p.roundDarts,
    roundTrebles:p.roundTrebles, roundDoubles:p.roundDoubles, roundMisses:p.roundMisses,
    roundOver:game.roundOver, roundEndReason:game.roundEndReason,
    atcLastDart:game.atcLastDart, sessionRoundsLen:p.sessionRounds.length,
    atcVisitDarts:game.atcVisitDarts || 0,
    badgeReverts:[], voided:false });

  p.roundDarts += 1;
  if(dart.sector === 0) p.roundMisses += 1;
  else if(dart.isTreble) p.roundTrebles += 1;
  else if(dart.isDouble) p.roundDoubles += 1;
  if(ev.isNewHit) p.hitSet.add(dart.sector);
  recordSingleDartTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:0, bust: !!ev.completed, checkout:false, checkoutPoints:null,
    // `bust` is this mode's repurposed "this dart completed the clock" marker
    // (REFERENCE.md's turns table). That is NOT a winner signal, though, and a
    // RACE has a winner: without leg_won, backend/db.js's _h2hWonLegs() — which
    // matches on `checkout=1 OR leg_won=1` and gives Around the Clock no bespoke
    // derivation — credited every race leg to nobody, so a race showed "N legs
    // played, 0 legs won" for ever. leg_won is the game-type-agnostic "this turn
    // won the leg" signal and this is exactly what it is for. Solo stays false:
    // one clock is one game, there is no leg to win.
    legWon: !!ev.completed && game.players.length > 1 }, dart, zone, missZone, missDepth, bounced);
  // by/hit describe the player who threw it, not whoever is at the oche when
  // this is next read — in a race the turn may have passed in between.
  game.atcLastDart = { label:dart.label, isNewHit:ev.isNewHit, completed:ev.completed,
    by:p.name, hit:p.hitSet.size };
  const _snap = game.lastTurnSnapshot;
  if(ev.completed){
    game.roundOver = true;
    game.roundEndReason = 'completed';
    p.sessionRounds.push({ darts:p.roundDarts });
    announce(`Around the Clock complete! ${p.roundDarts} darts.`);
    awardOnceBadge(p.name, 'guided_clock', 'guided_clock', _snap,
      { icon:'🧭', headline:'GUIDED CLOCK', statLine:`Completed a guided Around the Clock drill in ${p.roundDarts} darts` });
    // A race ends the LEG, not necessarily the game — best-of-N is a real
    // format here, the same as every other head-to-head type. The solo drill
    // below keeps its own "one clock = one game" ending untouched.
    if(atcIsRace()){ onLegWonAroundTheClock(game.current); return; }
    // One clock = one game (2026-07): completing the clock IS the game ending,
    // the same "a run IS the game" shape Gauntlet/Bob's 27/Dead Man Walking
    // already use — mirrors their exact completion sequence (webhooks, event
    // log, DB.completeGame(), matchResult, finishUnit('game', ...)) rather than
    // the old "Start Next Clock" continuation.
    sendHaWebhook('legend', p.name, game.category, { setNo: game.setNo, legNo: game.legNo });
    sendHaWebhook('setend', p.name, game.category, { setNo: game.setNo });
    sendHaWebhook('gameend', p.name, game.category);
    DB.recordEvent('leg_end', game.setNo, game.legNo);
    DB.recordEvent('set_end', game.setNo, null);
    DB.recordEvent('game_end', null, null);
    DB.completeGame(p.name);
    game.matchResult = { ts:Date.now(), kind:'game', legNo:game.legNo, setNo:game.setNo, winner:p.name, bigFish:false };
    fireMomentCard('matchwin', { icon:'🕐', headline:'CLOCK COMPLETE!', player:p.name,
      statLine: `${p.roundDarts} darts — ${p.roundTrebles} treble${p.roundTrebles===1?'':'s'}, ${p.roundDoubles} double${p.roundDoubles===1?'':'s'}, ${p.roundMisses} miss${p.roundMisses===1?'':'es'}` });
    // Custom completion wording (finishUnit()'s opts) — a solo drill has no
    // opponent to "win" against, so "Ben wins the game"/"GAME OVER" reads oddly.
    finishUnit('game', p.name, {
      heading: 'CLOCK COMPLETE', subtext: `${escapeHtml(p.name)} cleared the clock. Stats saved.`,
      bannerText: `${escapeHtml(p.name)} clears the clock!`, liveMessage: `${p.name} clears the clock!`,
    });
    return;
  }
  // Pass the turn after three darts. Solo runs the same line — with one seat
  // the walk returns to it, so the drill's uninterrupted stream is unchanged.
  const race = atcIsRace();
  let handover = '';
  game.atcVisitDarts = (game.atcVisitDarts || 0) + 1;
  if(game.atcVisitDarts >= ATC_DARTS_PER_VISIT){
    game.atcVisitDarts = 0;
    if(race){
      advanceToNextActivePlayer(game);
      game.turnSeq += 1;
      handover = ` ${game.players[game.current].name} to throw.`;
    }
  }
  // One announcement, not two: the live region is cleared and re-set on the
  // same frame, so a separate handover call would replace the hit it follows
  // rather than queue behind it (the same rule announceTurn() documents).
  if(ev.isNewHit){
    announce((race ? `${p.name} hits ${dart.label}. ${p.hitSet.size} of 20.`
                   : `${dart.label}. ${p.hitSet.size} of 20 numbers hit.`) + handover);
  } else if(handover){
    announce(`${p.name} ${dart.label} — no effect.${handover}`);
  }
  renderGameAroundTheClock();
}

// A race's leg win. Everything competitive about it — legs, sets, the match
// tree, Elo, the moment card — is the shared advanceLegSetGame() every other
// H2H mode already routes through; nothing here is Around the Clock-specific
// except the wording and the darts figure the card leads with.
function onLegWonAroundTheClock(wi){
  const w = game.players[wi];
  const active = game.players.filter(p=>!p.dnf);
  const opp = active.length===2 ? active.find(p=>p!==w) : null;
  const legsAtWin = new Map(game.players.map(p => [p, p.legsWon + (p===w ? 1 : 0)]));
  w.legsWon += 1;
  advanceLegSetGame(w, {
    legsAtWin, opp,
    momentCard: () => ({ icon:'🕐', headline:'CLOCK RACE WON!', player:w.name,
      statLine: matchWinStatLine(w, legsAtWin) }),
  });
}

// Undoes the single most recently thrown dart — mirrors undoLastTurnDoublesPractice()'s
// shape, plus revoking guided_clock if this dart earned it.
function undoLastTurnAroundTheClock(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  // The thrower the snapshot belongs to, not whoever is at the oche now — in a
  // race the turn may already have passed to somebody else, and restoring the
  // hit set onto the wrong player would hand one of them the other's clock.
  const p = game.players[snap.pi != null ? snap.pi : 0];
  if(snap.pi != null) game.current = snap.pi;
  game.atcVisitDarts = snap.atcVisitDarts || 0;
  p.hitSet = snap.hitSet;
  p.roundDarts = snap.roundDarts;
  p.roundTrebles = snap.roundTrebles;
  p.roundDoubles = snap.roundDoubles;
  p.roundMisses = snap.roundMisses;
  game.roundOver = snap.roundOver;
  game.roundEndReason = snap.roundEndReason;
  game.atcLastDart = snap.atcLastDart;
  p.sessionRounds.length = snap.sessionRoundsLen;

  _finishUndo(snap, renderGameAroundTheClock, { msg: 'Last dart undone.' });
}

function renderGameAroundTheClock(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  const race = atcIsRace();
  const showStanding = game.legsPerSet>1 || game.setsPerGame>1;
  // One row per player — in a race everyone needs their own outstanding-numbers
  // grid, since "which numbers are left" is the whole state of the game and
  // reading only the current thrower's would hide the race itself.
  game.players.forEach((p,i)=>{
    const active = i === game.current;
    const standing = game.setsPerGame>1 ? `Sets ${p.setsWon} · Legs ${p.legsWon}`
      : `Legs ${p.legsWon}/${game.legsPerSet}`;
    const row = document.createElement('div');
    row.className = 'pscore' + (active ? ' active' : '');
    row.innerHTML = `
      <div>
        <div class="nm">${escapeHtml(p.name)} <span class="nm-out">around the clock</span></div>
        ${active ? '<div class="turnflag">▸ throwing</div>' : ''}
      </div>
      <div class="meta">
        <div class="avgs">${p.hitSet.size} / 20 numbers hit &nbsp;·&nbsp; ${p.roundDarts} dart${p.roundDarts===1?'':'s'} thrown</div>
        ${race && showStanding ? `<div class="standing">${standing}</div>` : ''}
      </div>
      <div class="rem-wrap">
        <div class="rem">${p.hitSet.size}</div>
      </div>
      <div class="atc-live-progress" style="margin-top:10px"></div>`;
    // A class, not an id: a race renders one of these per player, and duplicate
    // ids would break both getElementById() and the landscape rail's :has() rule.
    const progressEl = row.querySelector('.atc-live-progress');
    if(progressEl) progressEl.innerHTML = buildOutcomeGridHtml(
      new Set([...p.hitSet].map(n=>`${n}:1`)), { cells: 'numbers', live: true });
    if(sb) sb.appendChild(row);
  });

  const cur = game.players[game.current];
  const status = document.getElementById('status');
  if(status){
    if(game.roundOver){
      status.className = 'status win';
      status.textContent = `Around the Clock complete! ${cur.roundDarts} dart${cur.roundDarts===1?'':'s'}.`;
    } else if(game.atcLastDart && game.atcLastDart.isNewHit){
      status.className = 'status win';
      const hit = game.atcLastDart.hit != null ? game.atcLastDart.hit : cur.hitSet.size;
      // "X to throw" only once the turn has actually passed — saying it while
      // the same player still has darts in hand reads as an instruction to
      // somebody who is already at the oche.
      const passed = race && game.atcLastDart.by !== cur.name;
      status.textContent = race
        ? `Hit! ${game.atcLastDart.by} ${game.atcLastDart.label} — ${hit} of 20.${passed ? ` ${cur.name} to throw.` : ''}`
        : `Hit! ${game.atcLastDart.label}. ${hit} of 20 hit.`;
    } else if(game.atcLastDart){
      status.className = 'status';
      const passed = race && game.atcLastDart.by !== cur.name;
      status.textContent = race
        ? `${game.atcLastDart.by} ${game.atcLastDart.label} — no effect.${passed ? ` ${cur.name} to throw.` : ''}`
        : `${game.atcLastDart.label} — no effect, keep going.`;
    } else {
      status.className = 'status';
      status.textContent = padOrBoardHint(race
        ? `${cur.name} to throw — hit every 1-20 as a single.`
        : 'Hit every 1-20 as a single.');
    }
  }
  renderPad();
  // No "Start next round" button here (2026-07): completing the clock now ends
  // the whole game via finishUnit('game', ...) instead of offering another round
  // in the same session — see this mode's header comment above.
  pushLive();
}
