'use strict';
/* Around the World (docs/game-modes-roadmap.md) — every sector×ring combination, tracked across a lifetime.
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
// Guided Around the World's Home page leaderboard — one board (lifetime progress
// out of 63), not two: unlike Around the Clock's per-round darts/completions,
// there's no obvious second ranking axis for an open-ended, cross-session tracker.
function renderHomeTabBodyAroundTheWorld(){
  const el=document.getElementById('home-tab-body');
  const data=homeData.aroundTheWorld;
  if(!data){ el.innerHTML=`<p class="pp-meta">Loading…</p>`; return; }

  const progBoard=data.progress||[];
  const progLeaderboard=leaderboardSectionHtml(progBoard, {
    score:r=>`${r.progress}/${r.total}`, emptyMsg:'None recorded yet.',
  });

  el.innerHTML=`
    <div class="pp-section">
      <div class="pp-section-title">Lifetime Progress</div>
      ${progLeaderboard}
    </div>
  `;
}

// Around the World progress (docs/archive/achievements-badges-roadmap.md): a compact grid
// rather than a full dartboard-shaped heatmap — the doc explicitly calls the ideal
// dartboard visualization a separately-scoped sub-project; this is the simpler v1.
function loadAroundTheWorldProgress(){
  const container=document.getElementById('player-atw-progress');
  if(!container) return;
  cachedProfileLoad('atw',
    () => Backend.get(`/api/players/around-the-world?name=${encodeURIComponent(currentPlayer)}`),
    data=>renderAroundTheWorldProgress(data),
    ()=>{ container.innerHTML=`<p class="pp-meta" style="padding:4px 0">Could not load progress.</p>`; });
}

function renderAroundTheWorldProgress(data){
  const container=document.getElementById('player-atw-progress');
  if(!container) return;
  const hitSet = new Set((data && data.hit || []).map(h=>`${h.sector}:${h.mult}`));
  container.innerHTML = buildOutcomeGridHtml(hitSet, { cells: 'all' });
}

// --- Around the World ---
// 63 outcome cells would be a wall of green (the game only ends at 63/63), so
// the shelf here counts the twenty numbers instead — three outcomes each — and
// the bull and the miss ride in the tallies alongside them.
function aroundTheWorldPanelSpec(game){
  const p = game.players[0];
  const darts = p.sessionDarts||0;
  const hit = p.sessionHitSet || new Set();
  const countFor = sector => [1,2,3].filter(m => hit.has(`${sector}:${m}`)).length;
  return {
    heroes: [
      { title: p.name, sub: 'Darts to hit all 63 outcomes', value: darts },
      { title: 'Outcomes', sub: `${(darts/63).toFixed(1)} darts per outcome`, value: `${hit.size}/63` },
    ],
    shelf: {
      title: 'The twenty numbers — single, double, treble', long: true,
      cells: Array.from({length:20}, (_,i) => {
        const n = i + 1, c = countFor(n);
        return panelResultCell(n, c > 0, c === 3, `${c}/3`);
      }),
    },
    // The three outcomes that aren't one of the twenty numbers. Keys match
    // buildOutcomeGridHtml()'s exactly — outer bull 25:1, double bull 25:2,
    // miss 0:1 — since both read the same sessionHitSet.
    tallies: [
      { emoji:'🎯', value:['25:1','25:2'].filter(k => hit.has(k)).length, label:'bulls hit' },
      { emoji:'💨', value:hit.has('0:1') ? 1 : 0, label:'miss logged' },
      { emoji:'🌍', value:`${hit.size}/63`, label:'outcomes this session' },
    ],
  };
}

function newMatchPlayerAroundTheWorld(name){
  const p = { name, sessionDarts:0, sessionHitSet: new Set(), baselineHitSet: new Set() };
  // Fetched once at game start (not re-queried per dart) — same rate-limiter-safety
  // reasoning as Chuckin's lifetimeDartsBase/lifetimeTreblesBase precedent
  // (newMatchPlayerChuckin() above): this mode is built around rapid successive
  // throws, and hitting the network on every single dart would needlessly burn
  // through the server's per-IP rate limit during a long practice session.
  Backend.get(`/api/players/around-the-world?name=${encodeURIComponent(name)}`).then(prog=>{
    if(!prog) return;
    p.baselineHitSet = new Set((prog.hit||[]).map(h=>`${h.sector}:${h.mult}`));
    if(game && game.players && game.players[0] === p) renderGameAroundTheWorld();
  }).catch(logErr);
  return p;
}

// Not called by startNextLeg() (this mode never advances a leg) — provided only
// to satisfy the GAME_TYPES contract, matching Chuckin's own precedent.
function resetPlayerForNextLegAroundTheWorld(p){
  p.sessionDarts = 0; p.sessionHitSet = new Set();
}

function playerSnapshotAroundTheWorld(p){
  // hitOutcomes (not just a count) so the Live Scoreboard can render the same
  // outcome grid the controller itself shows via buildOutcomeGridHtml(). Reports
  // the SESSION set, so the second screen shows the same checklist the player is
  // filling rather than a lifetime total they can't affect this game.
  return { name:p.name, sessionDarts:p.sessionDarts||0,
    hitOutcomes:[...p.sessionHitSet], progress: p.sessionHitSet.size, total: 63,
    lifetimeProgress: new Set([...p.baselineHitSet, ...p.sessionHitSet]).size };
}

// One world = one game (2026-07 redesign, superseding "progress is lifetime and
// never resets"). The old shape had two reported problems, and they were the same
// problem seen from both ends: the run started at whatever your LIFETIME progress
// happened to be, so finishing it meant hitting only the handful of outcomes you
// had never hit before — and once that lifetime set was complete, every new game
// opened at 63/63 with nothing left to do. The mode retired itself permanently
// after one completion.
//
// The goal is now the SESSION's own 63 outcomes, which is the same "one clock =
// one game" shape Around the Clock was redesigned into: a real drill you can play
// again tomorrow, and a completion that means you actually hit all 63 in one
// sitting. Lifetime progress is still tracked and still shown — it just isn't the
// win condition any more.
function throwDartAroundTheWorld(sector, zone, missZone, missDepth, bounced){
  if(game.roundOver) return;
  const dart = makeDart(sector, bounced ? 1 : mult);
  mult = 1; updateMultUI();
  const p = game.players[0];
  const outcomeKey = `${dart.sector}:${dart.mult}`;
  // Two different "new"s, both worth telling the player about: new to THIS
  // session (progress toward the goal) and never hit in their life (a
  // completionist milestone that still matters, just no longer the objective).
  const isNewThisSession = !p.sessionHitSet.has(outcomeKey);
  const isNewLifetimeOutcome = isNewThisSession && !p.baselineHitSet.has(outcomeKey);

  // snapshot state before mutation so undoLastTurnAroundTheWorld() can restore it.
  pushTurnSnapshot({ sessionDarts:p.sessionDarts, sessionHitSet: new Set(p.sessionHitSet),
    roundOver:game.roundOver, atwLastDart:game.atwLastDart, badgeReverts:[], voided:false });

  p.sessionDarts += 1;
  p.sessionHitSet.add(outcomeKey);
  const progress = p.sessionHitSet.size;
  const completed = progress === 63;
  recordSingleDartTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:0, bust: completed, checkout:false, checkoutPoints:null, legWon:false }, dart, zone, missZone, missDepth, bounced);
  game.atwLastDart = { label:dart.label, isNewThisSession, isNewLifetimeOutcome };
  const _snap = game.lastTurnSnapshot;
  announce(`${dart.label}. ${progress} of 63 this session.`);

  if(completed){
    game.roundOver = true;
    awardOnceBadge(p.name, 'guided_world', 'guided_world', _snap,
      { icon:'🗺️', headline:'GUIDED WORLD', statLine:`All 63 outcomes in one session — ${p.sessionDarts} darts` });
    // Same completion sequence Around the Clock's own "one clock = one game"
    // redesign uses (webhooks, event log, DB.completeGame(), matchResult,
    // finishUnit('game', ...)) — without it the game never becomes `done`, which
    // is the bug that redesign fixed for the Clock.
    sendHaWebhook('legend', p.name, game.category, { setNo: game.setNo, legNo: game.legNo });
    sendHaWebhook('setend', p.name, game.category, { setNo: game.setNo });
    sendHaWebhook('gameend', p.name, game.category);
    DB.recordEvent('leg_end', game.setNo, game.legNo);
    DB.recordEvent('set_end', game.setNo, null);
    DB.recordEvent('game_end', null, null);
    DB.completeGame(p.name);
    game.matchResult = { ts:Date.now(), kind:'game', legNo:game.legNo, setNo:game.setNo, winner:p.name, bigFish:false };
    fireMomentCard('matchwin', { icon:'🗺️', headline:'WORLD COMPLETE!', player:p.name,
      statLine: `All 63 outcomes — ${p.sessionDarts} darts` });
    finishUnit('game', p.name, {
      heading: 'WORLD COMPLETE', subtext: `${escapeHtml(p.name)} hit every outcome. Stats saved.`,
      bannerText: `${escapeHtml(p.name)} completes the world!`, liveMessage: `${p.name} completes the world!`,
    });
    return;
  }
  renderGameAroundTheWorld();
}

// Undoes the single most recently thrown dart — mirrors undoLastTurnChuckin()'s
// shape, plus revoking guided_world if this dart earned it.
function undoLastTurnAroundTheWorld(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[0];
  p.sessionDarts = snap.sessionDarts;
  p.sessionHitSet = snap.sessionHitSet;
  game.roundOver = snap.roundOver;
  game.atwLastDart = snap.atwLastDart;

  _finishUndo(snap, renderGameAroundTheWorld, { msg: 'Last dart undone.' });
}

function renderGameAroundTheWorld(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  const p = game.players[0];
  // Session progress is the goal; the grid is this session's own checklist.
  const progress = p.sessionHitSet.size;
  // Lifetime is still tracked and still shown, just as context rather than the
  // objective — a first-ever outcome is a real milestone worth surfacing.
  const lifetime = new Set([...p.baselineHitSet, ...p.sessionHitSet]).size;
  const row = document.createElement('div');
  row.className = 'pscore active';
  row.innerHTML = `
    <div>
      <div class="nm">${escapeHtml(p.name)} <span class="nm-out">around the world</span></div>
      <div class="turnflag">▸ throwing</div>
    </div>
    <div class="meta">
      <div class="avgs">${progress} / 63 this session &nbsp;·&nbsp; ${p.sessionDarts} dart${p.sessionDarts===1?'':'s'}</div>
      <div class="standing">${lifetime} / 63 lifetime</div>
    </div>
    <div class="rem-wrap">
      <div class="rem">${progress}</div>
    </div>
    <div id="atw-live-progress" style="margin-top:10px"></div>`;
  if(sb) sb.appendChild(row);
  const progressEl = document.getElementById('atw-live-progress');
  if(progressEl) progressEl.innerHTML = buildOutcomeGridHtml(p.sessionHitSet, { cells: 'all', live: true });

  const status = document.getElementById('status');
  if(status){
    if(game.atwLastDart){
      const d = game.atwLastDart;
      status.className = d.isNewThisSession ? 'status win' : 'status';
      const tag = d.isNewLifetimeOutcome ? ' — first ever!' : d.isNewThisSession ? ' — new!' : ' — already had it';
      status.textContent = `${d.label}${tag} · ${progress} of 63.`;
    } else {
      status.className = 'status';
      status.textContent = padOrBoardHint('Hit all 63 outcomes in one session.');
    }
  }
  renderPad();
  pushLive();
}
