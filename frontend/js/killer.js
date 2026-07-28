'use strict';
/* Killer (docs/game-modes-roadmap.md) — per-player numbers, lives, and elimination.
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
// Killer's Home page leaderboard (docs/game-modes-roadmap.md "Killer") —
// win rate, H2H only, same "Most Wins"-style shape Cricket/Baseball's own win
// leaderboards use (getKillerWinLeaderboard() shares their exact {name,played,
// won,rate} row shape, since Killer's win/loss lives on games.winner_id too).
function renderHomeTabBodyKiller(){
  renderSimpleHomeLeaderboardTab('killer', 'winLeaderboard', '🔪 Killer — Most Wins', {
    score:r=>r.won, meta:r=>`${r.rate}% of ${r.played}`,
    emptyMsg:'None recorded yet — play a Killer match to claim the top spot.',
  });
}

function setKillerLives(n){
  setup.killerLives = n;
  setPressed({2:'killer-lives-2', 3:'killer-lives-3', 5:'killer-lives-5'}, n);
}

// --- Killer ---
// The only mode where survival, not a score, is the result — so the hero is
// lives remaining and the shelf is the table itself, one cell per player.
function killerPanelSpec(game, winner){
  const survivors = game.players.filter(p => !p.eliminated);
  return {
    heroes: panelHeroesByPlayer(winner, p => p.eliminated ? 'OUT' : (p.lives||0),
      p => p.eliminated ? `Number ${p.number} · eliminated` : `Lives left · number ${p.number}`),
    shelf: {
      title: 'The table',
      cells: game.players.map(p => panelResultCell(p.number, true, !p.eliminated,
        `${p.name} · ${p.kills||0} kill${(p.kills||0)===1?'':'s'}`)),
    },
    tallies: [
      { emoji:'🗡️', value:game.players.reduce((s,p)=>s+(p.kills||0),0), label:'kills' },
      { emoji:'🛡️', value:survivors.length, label:'survivors' },
    ],
  };
}

function newMatchPlayerKiller(name){
  return { name, number:null, lives:0, isKiller:false, eliminated:false, kills:0, gameLivesLost:0,
    legsWon:0, setsWon:0, legDarts:0, setDarts:0, gameDarts:0 };
}

// Resets per-leg state but keeps `number` (assigned once for the whole match,
// docs/game-modes-roadmap.md: "assigned once at Start ... not re-derived
// per leg"), `kills`, and `gameLivesLost` (both match-lifetime tallies, not
// per-leg — 🛡️ Untouchable needs the whole match's own history, not just
// whichever leg happened to decide it).
function resetPlayerForNextLegKiller(p, game, newSet){
  p.lives = 0; p.isKiller = false; p.eliminated = false;
  p.legDarts = 0;
  if(newSet) p.setDarts = 0;
}

function playerSnapshotKiller(p){
  return { name:p.name, number:p.number, lives:p.lives, isKiller:p.isKiller, eliminated:p.eliminated,
    kills:p.kills||0, legsWon:p.legsWon, setsWon:p.setsWon,
    legDarts:p.legDarts||0, setDarts:p.setDarts||0, gameDarts:p.gameDarts||0 };
}

// Advances game.current to the next non-eliminated player, wrapping — a
// static (current+1)%n the way X01 advances doesn't work here, since
// eliminated players must be skipped entirely.
function advanceKillerTurn(){
  game.killerDartsThisVisit = 0;
  advanceToNextActivePlayer(game, p => p.eliminated);
  clearTurnSnapshots(); // can't undo across a visit boundary
  game.turnSeq += 1;
  renderGameKiller();
}

function throwDartKiller(sector, zone, missZone, missDepth, bounced){
  const thrower = game.players[game.current];
  const dart = makeDart(sector, bounced ? 1 : mult);
  if(zone) dart.zone = zone;
  if(missZone != null){ dart.missZone = missZone; dart.missDepth = missDepth; }
  if(bounced) dart.bounced = true;
  mult = 1; updateMultUI();

  const ev = evaluateDartKiller(dart, thrower.name, game.players);
  const affected = ev ? game.players.find(pl => pl.name === ev.affectedName) : null;

  // snapshot state before mutation so undoLastTurnKiller() can restore it —
  // only reachable while this visit is still live (a visit-ending dart clears
  // it via advanceKillerTurn()/onKillerLegWon(), the same "can't undo past a
  // boundary" rule every other game type follows).
  const _snap = { affectedName: affected ? affected.name : null,
    lives: affected ? affected.lives : null, isKiller: affected ? affected.isKiller : null,
    eliminated: affected ? affected.eliminated : null, affectedGameLivesLost: affected ? affected.gameLivesLost : null,
    throwerKills: thrower.kills,
    legDarts: thrower.legDarts, setDarts: thrower.setDarts, gameDarts: thrower.gameDarts,
    dartsThisVisit: game.killerDartsThisVisit,
    // 🩸 First Blood latches on the match, not the leg, so undoing the dart that
    // drew it left the latch stuck: whoever actually drew first blood next — a
    // different player, after this dart was taken back — could never earn it.
    firstBloodAwarded: game.killerFirstBloodAwarded,
    ltLen: game.currentLegTurns.length, stLen: game.sessionTurns.length,
    badgeReverts:[], voided:false };
  pushTurnSnapshot(_snap);

  let delta = 0;
  if(ev){
    delta = ev.delta;
    if(ev.isGain){
      affected.lives += delta;
      if(!affected.isKiller && affected.lives >= game.killerLives) affected.isKiller = true;
      announce(`${thrower.name} builds toward killer status — ${affected.lives} of ${game.killerLives}.`);
    } else {
      // docs/game-modes-roadmap.md's Killer primer: "a player REDUCED TO 0 lives is
      // eliminated", and "every player starts at 0". Checking `lives === 0` alone
      // conflates the two — a player still on their starting 0 was never reduced,
      // and the first player to reach killer status (one treble on their own
      // number does it) could eliminate them with a single dart before they had
      // thrown at all, winning a two-player leg on dart 2. Elimination now requires
      // that the player HAD a life to lose.
      const livesBefore = affected.lives;
      affected.lives = Math.max(0, affected.lives - delta);
      affected.gameLivesLost += delta;
      if(livesBefore > 0 && affected.lives === 0 && !affected.eliminated){
        affected.eliminated = true;
        if(ev.affectedName !== thrower.name){
          thrower.kills += 1;
          // 🩸 First Blood: the first elimination of this MATCH (not per-leg) —
          // game.killerFirstBloodAwarded lives on the game object itself
          // (never reset by resetPlayerForNextLegKiller), so it only ever
          // fires once per match, whichever leg it happens in.
          if(!game.killerFirstBloodAwarded){
            game.killerFirstBloodAwarded = true;
            queueBadge('killerfirstblood', thrower.name);
            awardRecurringBadge(thrower.name, 'killerfirstblood', 'killerfirstblood',
              { icon:'🩸', headline:'FIRST BLOOD!', player:thrower.name, statLine:'First elimination of the match' });
          }
        } else {
          queueBadge('killerownworstenemy', thrower.name);
          awardRecurringBadge(thrower.name, 'killerownworstenemy', 'killerownworstenemy',
            { icon:'🙈', headline:'OWN WORST ENEMY', player:thrower.name, statLine:'Eliminated by your own double' });
        }
        announce(ev.selfKill ? `${thrower.name} self-kills and is eliminated!` : `${thrower.name} eliminates ${affected.name}!`);
      } else {
        announce(ev.selfKill ? `${thrower.name} hits their own double — down to ${affected.lives}.`
          : `${thrower.name} attacks ${affected.name} for ${delta} — down to ${affected.lives}.`);
      }
    }
  } else {
    announce(`${thrower.name} throws ${dart.label} — no effect.`);
  }

  thrower.legDarts += 1; thrower.setDarts += 1; thrower.gameDarts += 1;

  recordSingleDartTurn({ player:thrower.name, set:game.setNo, leg:game.legNo,
    scored: delta, bust:false, checkout:false, checkoutPoints:null,
    affectedPlayer: ev ? ev.affectedName : null }, dart, zone, missZone, missDepth, bounced);

  const turnRecord = { player:thrower.name, scored:delta, darts:[dart] };
  game.currentLegTurns.push(turnRecord);
  game.sessionTurns.push(turnRecord);

  awardTimeOfDayBadges(thrower);

  const alive = game.players.filter(pl => !pl.eliminated);
  if(alive.length === 1){
    onKillerLegWon(alive[0]);
    return;
  }

  game.killerDartsThisVisit += 1;
  if(thrower.eliminated || game.killerDartsThisVisit >= 3){
    advanceKillerTurn();
  } else {
    renderGameKiller();
  }
}

function undoLastTurnKiller(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const thrower = game.players[game.current];
  if(snap.affectedName != null){
    const affected = game.players.find(pl => pl.name === snap.affectedName);
    affected.lives = snap.lives; affected.isKiller = snap.isKiller; affected.eliminated = snap.eliminated;
    affected.gameLivesLost = snap.affectedGameLivesLost;
  }
  thrower.kills = snap.throwerKills;
  thrower.legDarts = snap.legDarts; thrower.setDarts = snap.setDarts; thrower.gameDarts = snap.gameDarts;
  game.killerDartsThisVisit = snap.dartsThisVisit;
  game.killerFirstBloodAwarded = snap.firstBloodAwarded;
  game.currentLegTurns.length = snap.ltLen;
  game.sessionTurns.length = snap.stLen;

  _finishUndo(snap, renderGameKiller, { msg: 'Last dart undone.' });
}

/* ----- Killer leg / set / match progression (dispatched from throwDartKiller()) ----- */
function onKillerLegWon(w){
  w.legsWon += 1;
  const legsAtWin = new Map(game.players.map(p => [p, p.legsWon]));

  advanceLegSetGame(w, {
    legsAtWin,
    checkElo: false,
    momentCard: () => ({ icon:'🔪', headline:'MATCH WON!', player:w.name, statLine: matchWinStatLine(w, legsAtWin) }),
    // 🛡️ Untouchable: won the match having never lost a single life,
    // across every leg (gameLivesLost is match-lifetime, never reset per leg).
    extraGameWonBadge: () => {
      if(w.gameLivesLost === 0){
        queueBadge('killeruntouchable', w.name);
        awardRecurringBadge(w.name, 'killeruntouchable', 'killeruntouchable',
          { icon:'🛡️', headline:'UNTOUCHABLE!', player:w.name, statLine:'Won without ever losing a life' });
      }
    },
  });
}

function renderGameKiller(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  game.players.forEach((p,i)=>{
    const row = document.createElement('div');
    row.className = 'pscore' + (i===game.current && !p.eliminated ? ' active' : '') + (p.eliminated ? ' bust' : '');
    const pips = Array.from({length: Math.max(p.lives, game.killerLives)}, (_,k) =>
      `<span aria-hidden="true">${k < p.lives ? '●' : '○'}</span>`).join(' ');
    row.innerHTML = `
      <div>
        <div class="nm">${escapeHtml(p.name)} <span class="nm-out">№ ${p.number}${p.isKiller ? ' · 🔪 Killer' : ''}${p.eliminated ? ' · ☠️ Eliminated' : ''}</span>
          ${i===game.current && !p.eliminated ? '<span class="throwflag">▸ throwing</span>' : ''}</div>
        <div class="turnflag" aria-label="${p.lives} of ${game.killerLives} lives">${pips || '—'}</div>
      </div>
      <div class="meta">
        <div class="avgs">${p.kills} kill${p.kills===1?'':'s'}</div>
        <div class="standing">Set ${p.setsWon} · Leg ${p.legsWon}</div>
      </div>`;
    if(sb) sb.appendChild(row);
  });
  renderPad();
  pushLive();
}
