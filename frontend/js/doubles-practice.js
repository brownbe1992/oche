'use strict';
/* Doubles Practice (docs/game-modes-roadmap.md) — a chosen set of doubles, round by round.
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
// Doubles Practice's Home page leaderboards (game-modes-roadmap.md, previously a
// known gap). No H2H/Practice split — this mode is always solo practice, so
// homeData.doublesPractice is a single flat dataset, not h2h/practice-keyed like
// homeData.cricket is. Two boards, not Cricket's four: no win-rate leaderboard
// (no opponent to win against) and no achievement-count sections (this mode has
// no achievements yet, per its own "known gaps" note).
function renderHomeTabBodyDoublesPractice(){
  const el=document.getElementById('home-tab-body');
  const data=homeData.doublesPractice;
  if(!data){ el.innerHTML=`<p class="pp-meta">Loading…</p>`; return; }

  const accBoard=data.accuracy||[];
  const accLeaderboard=leaderboardSectionHtml(accBoard, {
    score:r=>`${r.pct.toFixed(1)}%`, meta:r=>`${r.rounds} rounds`,
    emptyMsg:'None recorded yet (needs at least 5 rounds played).',
  });

  const bestBoard=data.bestRound||[];
  const bestLeaderboard=leaderboardSectionHtml(bestBoard, {
    score:r=>`${r.hits}/${r.darts}`, meta:r=>fmtDate(r.createdAt),
    emptyMsg:'None recorded yet.',
  });

  el.innerHTML=`
    <div class="home-pair">
      <div class="pp-section">
        <div class="pp-section-title">Doubles %</div>
        ${accLeaderboard}
      </div>
      <div class="pp-section">
        <div class="pp-section-title">Best Round</div>
        ${bestLeaderboard}
      </div>
    </div>
  `;
}

function newMatchPlayerDoublesPractice(name){
  const p = { name, roundDarts:0, roundHits:0, sessionRounds:[],
    sessionHits:0, lifetimeHitsBase:0, // Lifetime doubles-hit ladder (docs/archive/culture-badges-roadmap.md Part B)
    // Ring Master (item 51): baseline lifetime distinct-doubled-sectors set
    // fetched once here, sessionHitSectors tracks this session's own newly-hit
    // sectors locally — throwDartDoublesPractice()'s per-hit check (below)
    // then never re-queries the server, a lifetime-DISTINCT-scan it used to run
    // on every hit dart until this player earned the badge.
    sessionHitSectors: new Set(), baselineHitSectors: new Set() };
  // Fetched once at game start, not re-queried per dart — same "avoid a network
  // round-trip per throw" reasoning newMatchPlayerChuckin()/newMatchPlayerBaseball()
  // document for their own lifetime bases. No mode param -> genuinely unscoped
  // lifetime (this mode is always practice=1 anyway, but matches the pattern).
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=doubles_practice`).then(stats=>{
    if(!stats) return;
    p.lifetimeHitsBase = (stats.hits || 0) - p.sessionHits;
  }).catch(logErr);
  Backend.get(`/api/players/doubles-hit-sectors?name=${encodeURIComponent(name)}`).then(prog=>{
    p.baselineHitSectors = new Set(prog.hit || []);
  }).catch(logErr);
  return p;
}

// Not called by startNextLeg() (Doubles Practice never uses it — see
// startNextRoundDoublesPractice() instead); provided only to satisfy the
// GAME_TYPES contract in case a future generic caller expects every entry to
// have one.
function resetPlayerForNextLegDoublesPractice(p){
  p.roundDarts = 0; p.roundHits = 0;
}

function playerSnapshotDoublesPractice(p){
  return { name:p.name, roundDarts:p.roundDarts||0, roundHits:p.roundHits||0 };
}

// Per-dart evaluation (evaluateDartDoublesPractice(), frontend/scoring.js) — every
// dart commits immediately as its own 1-dart turn (addTurn() already supports 1-3
// darts per turn), unlike every other game type's batched-3-dart visit. Undo
// support (docs/game-modes-roadmap.md, previously a known gap): since each dart is
// its own committed turn, "undo the last turn" and "undo the last dart" are the
// same action here — one snapshot per dart, same "one level of undo only"
// convention as X01/Cricket's game.lastTurnSnapshot.
function throwDartDoublesPractice(sector, zone, missZone, missDepth, bounced){
  if(game.roundOver) return;
  const dart = makeDart(sector, bounced ? 1 : mult);
  mult = 1; updateMultUI();
  const p = game.players[0];
  const targets = game.config.doubles || [];
  const ev = evaluateDartDoublesPractice(dart, targets);

  // snapshot state before mutation so undoLastTurnDoublesPractice() can restore it
  // sessionHits is session-scoped, not round-scoped, but still belongs here: it
  // feeds DOUBLES_HIT_MILESTONE_LADDERS as lifetimeHitsBase + sessionHits, so an
  // undone hit that stayed counted could fire a lifetime tier early.
  pushTurnSnapshot({ roundDarts:p.roundDarts, roundHits:p.roundHits,
    roundOver:game.roundOver, roundEndReason:game.roundEndReason,
    dpLastDart:game.dpLastDart, sessionRoundsLen:p.sessionRounds.length,
    sessionHits:p.sessionHits||0 });

  p.roundDarts += 1;
  if(ev.hit) p.roundHits += 1;
  recordSingleDartTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:0, bust: !!ev.ended, checkout:false, checkoutPoints:null, legWon:false }, dart, zone, missZone, missDepth, bounced);
  game.dpLastDart = { label:dart.label, hit:ev.hit, ended:ev.ended, reason:ev.reason };
  if(ev.ended){
    game.roundOver = true;
    game.roundEndReason = ev.reason;
    p.sessionRounds.push({ darts:p.roundDarts, hits:p.roundHits, reason:ev.reason });
    announce(`Round over. ${doublesPracticeReasonText(ev.reason)} ${p.roundDarts} darts, ${p.roundHits} hit${p.roundHits===1?'':'s'} this round.`);
  } else if(ev.hit){
    announce(`Hit, ${dart.label}. ${p.roundHits} hit${p.roundHits===1?'':'s'} so far this round.`);
  }
  if(ev.hit){
    // Lifetime doubles-hit ladder (docs/archive/culture-badges-roadmap.md Part B) —
    // permanent milestone tiers, accumulated across the whole client session
    // (not reset per round, unlike p.roundHits).
    p.sessionHits = (p.sessionHits||0) + 1;
    checkChuckinMilestoneTier(DOUBLES_HIT_MILESTONE_LADDERS[0], p.name, (p.lifetimeHitsBase||0) + p.sessionHits);
    // 🎪 Ring Master (docs/archive/culture-badges-roadmap.md Part B): lifetime completion
    // over every double D1-D20 plus bull. Tracked via newMatchPlayerDoublesPractice()'s
    // fetch-baseline-once (baselineHitSectors) + this session's own newly-hit
    // sectors (sessionHitSectors) — item 51 — instead of a fresh lifetime-DISTINCT-
    // scan query on every hit dart. Explicitly a ONE-OFF PERMANENT badge per the
    // roadmap doc — unlike Around the Clock/World, this one deliberately skips
    // trackBadgeForUndo/badgeReverts (no undo-revocation), matching the milestone
    // ladders' own "permanent, once-earned" treatment.
    if(!(earnedBadgeCache[p.name] && earnedBadgeCache[p.name].has('doublespracticeringmaster'))){
      p.sessionHitSectors.add(dart.sector);
      const hitCount = new Set([...p.baselineHitSectors, ...p.sessionHitSectors]).size;
      if(hitCount >= 21){
        awardOnceBadge(p.name, 'doublespracticeringmaster', 'doublespracticeringmaster', null,
          { icon:'🎪', headline:'RING MASTER', statLine:'Every double, D1 to Bull, lifetime' },
          { cacheCheck:true });
      }
    }
  }
  renderGameDoublesPractice();
}

// Undoes the single most recently thrown dart (this mode's "turn" is always exactly
// one dart) — mirrors undoLastTurn()/undoLastTurnCricket()'s snapshot-restore shape.
// This mode's own snapshot has no badgeReverts field at all (Doubles Practice's one
// badge, Ring Master, is deliberately permanent/non-revocable — see its own award
// site's comment), so _finishUndo()'s badge-revert loop and voided flag are no-ops
// here — kept anyway so a future snapshot-based Doubles Practice badge gets undo
// protection for free instead of needing this function special-cased again. Only
// available until the next round starts (startNextRoundDoublesPractice() clears the
// snapshot), same "one level of undo, gone once you move on" rule X01/Cricket follow.
function undoLastTurnDoublesPractice(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[0];
  p.roundDarts = snap.roundDarts;
  p.roundHits = snap.roundHits;
  game.roundOver = snap.roundOver;
  game.roundEndReason = snap.roundEndReason;
  game.dpLastDart = snap.dpLastDart;
  p.sessionRounds.length = snap.sessionRoundsLen;
  p.sessionHits = snap.sessionHits;

  _finishUndo(snap, renderGameDoublesPractice, { msg: 'Last dart undone.' });
}

function startNextRoundDoublesPractice(){
  const p = game.players[0];
  p.roundDarts = 0; p.roundHits = 0;
  game.roundOver = false; game.roundEndReason = null; game.dpLastDart = null;
  game.legNo += 1;   // each round is its own "leg" for turn grouping/personal bests
  clearTurnSnapshots();  // undo only reaches back into the round just finished
  DB.recordEvent('leg_start', game.setNo, game.legNo);
  renderGameDoublesPractice();
}

// Only a double on a target number keeps a Doubles Practice round alive
// (evaluateDartDoublesPractice(), frontend/scoring.js) — every other outcome
// ends it, each with its own explanation for why.
function doublesPracticeReasonText(reason){
  if(reason === 'so-close') return 'So close — landed on the number, missed the double.';
  if(reason === 'wrong-double') return "Wrong double — that number wasn't a target.";
  if(reason === 'miss') return 'Missed the board entirely.';
  return "That number wasn't a target double.";
}

function renderGameDoublesPractice(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  const p = game.players[0];
  const targets = game.config.doubles || [];
  const targetsLabel = targets.map(doublesTargetLabel).join(', ');
  const pct = p.roundDarts ? Math.round(p.roundHits/p.roundDarts*100) : 0;
  const row = document.createElement('div');
  row.className = 'pscore active';
  row.innerHTML = `
    <div>
      <div class="nm">${escapeHtml(p.name)} <span class="nm-out">practicing ${escapeHtml(targetsLabel)}</span></div>
      <div class="turnflag">▸ throwing</div>
    </div>
    <div class="meta">
      <div class="avgs">this round <b>${pct}%</b> doubles &nbsp;·&nbsp; ${p.roundHits} hit${p.roundHits===1?'':'s'} / ${p.roundDarts} dart${p.roundDarts===1?'':'s'}</div>
      <div class="standing">Round ${game.legNo}</div>
    </div>
    <div class="rem-wrap">
      <div class="rem">${p.roundHits}</div>
    </div>`;
  if(sb) sb.appendChild(row);

  const status = document.getElementById('status');
  if(status){
    if(game.roundOver){
      const reasonTxt = doublesPracticeReasonText(game.roundEndReason);
      status.className = 'status bust';
      status.textContent = `Round over — ${reasonTxt} ${p.roundDarts} dart${p.roundDarts===1?'':'s'}, ${p.roundHits} hit${p.roundHits===1?'':'s'} this round.`;
    } else if(game.dpLastDart && game.dpLastDart.hit){
      status.className = 'status win';
      status.textContent = `Hit! ${game.dpLastDart.label}. Keep going.`;
    } else if(game.dpLastDart){
      status.className = 'status';
      status.textContent = `${game.dpLastDart.label} — no effect, keep going.`;
    } else {
      status.className = 'status';
      status.textContent = padOrBoardHint();
    }
  }
  renderPad();
  const nextBtn = document.getElementById('dp-next-round-btn');
  if(nextBtn) nextBtn.hidden = !game.roundOver;
  pushLive();
}
