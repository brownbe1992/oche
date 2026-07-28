'use strict';
/* Tournament mode — bracket setup, seeding and match progression.
 *
 * Split out of frontend/index.html (docs/frontend-module-split-roadmap.md). A CLASSIC
 * script, deliberately not an ES module: classic scripts share one global scope, so
 * every name here stays visible to the rest of the app exactly as it was inside the one
 * big <script> block, and the ~335 inline on*= handlers keep resolving. The roadmap doc
 * records why ES modules were measured and rejected.
 *
 * Not self-contained, and not meant to be read as if it were: it calls freely into the
 * rest of the app and the rest of the app calls freely into it. The split buys
 * navigability, not isolation. Nothing here runs at load time beyond declaring names.
 */

/* =========================================================================
   TOURNAMENT MODE (docs/archive/tournament-mode-roadmap.md) — single-elimination only.
   A tournament match IS a normal X01 game under the hood (see beginTournamentMatch
   below) — this section is purely the bracket setup/view/orchestration UI on top;
   the actual scoring screen, live scoreboard, undo, achievements, etc. are all the
   existing X01 machinery, unmodified.
   ========================================================================= */
let tournamentView = 'list';        // 'list' | 'setup' | 'detail'
let currentTournamentId = null;
let tournamentDetailCache = null;   // last-fetched detail for currentTournamentId
let tournamentSetup = null;         // built fresh each time the setup view opens
let tournamentBracketTab = null;    // active bracket tab in a double-elim detail view ('winners'|'losers'|'grand_final')

function renderTournamentScreen(){
  if(tournamentView==='setup') return renderTournamentSetup();
  if(tournamentView==='detail' && currentTournamentId!=null) return loadTournamentDetail();
  return loadTournamentList();
}

function loadTournamentList(){
  const body=document.getElementById('tournament-body');
  body.innerHTML = `<p class="pp-meta" style="padding:4px 0">Loading…</p>`;
  Backend.get('/api/tournaments').then(renderTournamentList)
    .catch(()=>{ body.innerHTML = `<p class="pp-meta">Could not load tournaments.</p>`; });
}
function renderTournamentList(list){
  const body=document.getElementById('tournament-body');
  const rows = (list||[]).map(t=>{
    const statusLabel = t.status==='completed' ? `🏆 ${escapeHtml(t.champion_name||'')}` : 'In progress';
    return `<button class="rp-main" onclick="openTournament(${t.id})">
      <div class="rp-name-row">${escapeHtml(t.name)}</div>
      <div class="rp-stat">${escapeHtml(t.category)} · ${t.player_count} players · ${statusLabel}</div>
    </button>`;
  }).join('');
  body.innerHTML = `
    <h2 style="font-size:18px;margin-bottom:4px">Tournaments</h2>
    <p style="color:var(--muted);font-size:13px;margin:0 0 16px">Single-elimination brackets, any X01 format.</p>
    <div class="roster-list">${rows || '<div class="empty">No tournaments yet.<br>Create your first one below.</div>'}</div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="openTournamentSetup()">+ New Tournament</button>
    </div>`;
}
function openTournament(id){ currentTournamentId=id; tournamentBracketTab=null; tournamentView='detail'; renderTournamentScreen(); }
function openTournamentSetup(){ tournamentSetup=null; tournamentView='setup'; renderTournamentScreen(); }

/* ---------- setup ---------- */
function tournamentNextPow2(n){ let p=1; while(p<n) p*=2; return p; }
function tournamentRoundCount(n){ return Math.log2(tournamentNextPow2(Math.max(n,2))); }
function tournamentRoundLabel(roundNo, roundCount){
  const fromFinal = roundCount - roundNo;
  if(fromFinal===0) return 'Final';
  if(fromFinal===1) return 'Semifinal';
  if(fromFinal===2) return 'Quarterfinal';
  return `Round ${roundNo}`;
}
// docs/archive/tournament-mode-roadmap.md §2: double-elimination is v1-restricted to exact
// powers of two (matches the backend's TOURNAMENT_DOUBLE_ELIM_COUNTS).
const TOURNAMENT_DOUBLE_ELIM_COUNTS = [4, 8, 16, 32, 64, 128];
function tournamentIsValidDoubleElimCount(n){ return TOURNAMENT_DOUBLE_ELIM_COUNTS.includes(n); }
// The ordered per-round plan the format table needs, as [{label}, ...]. Single-elim
// derives it from the round count; double-elim reuses the SAME doubleElimStructure()
// the backend generates from (frontend/scoring.js), so the round order/count/labels
// can never drift between the two.
function tournamentRoundPlan(bracketType, n){
  if(bracketType === 'double_elim'){
    return doubleElimStructure(Math.log2(tournamentNextPow2(Math.max(n,2))));
  }
  const count = tournamentRoundCount(n);
  return Array.from({length:count}, (_,i)=>({ label: tournamentRoundLabel(i+1, count) }));
}
// Sensible default: best-of-3 legs every round, stepping up to best-of-5 in the
// last round (single-elim's final, or double-elim's reset decider) — the admin can
// edit any of these before creating the bracket.
function defaultTournamentRounds(n, bracketType){
  const count = tournamentRoundPlan(bracketType, n).length;
  return Array.from({length:count}, (_,i)=>({ legsPerSet: i===count-1?5:3, setsPerGame:1 }));
}

function renderTournamentSetup(){
  if(!tournamentSetup) tournamentSetup = { name:'', category:'501', selected:[], seedMethod:'random', rounds:[], avgByName:null, bracketType:'single_elim' };
  const ts = tournamentSetup;
  if(!ts.bracketType) ts.bracketType = 'single_elim';
  const n = ts.selected.length;
  // Single-elim accepts any 2+ players; double-elim is restricted to exact powers
  // of two (docs/archive/tournament-mode-roadmap.md §2), so a non-conforming count blocks
  // Create with an explanatory note rather than silently generating a broken bracket.
  const doubleElimCountOk = ts.bracketType !== 'double_elim' || tournamentIsValidDoubleElimCount(n);
  const canBuild = n >= 2 && doubleElimCountOk;
  const expectedRounds = tournamentRoundPlan(ts.bracketType, n).length;
  if(canBuild && ts.rounds.length !== expectedRounds) ts.rounds = defaultTournamentRounds(n, ts.bracketType);

  const checklist = roster.map(name=>{
    const checked = ts.selected.includes(name);
    const j = jsArg(name);
    return `<label class="tourney-check-row">
      <input type="checkbox" ${checked?'checked':''} onchange="toggleTournamentPlayer('${j}', this.checked)">
      <span>${escapeHtml(name)}</span>
    </label>`;
  }).join('');

  document.getElementById('tournament-body').innerHTML = `
    <button class="pp-back" onclick="tournamentView='list'; renderTournamentScreen()">← Tournaments</button>
    <h2 style="font-size:18px;margin:8px 0 4px">New Tournament</h2>
    <label class="field">Tournament name</label>
    <input type="text" id="tourney-name" maxlength="64" value="${escapeHtml(ts.name)}" oninput="tournamentSetup.name=this.value" style="margin-bottom:14px">
    <label class="field">Format (X01)</label>
    <select class="date-input" id="tourney-category" style="width:auto;margin-bottom:14px" onchange="tournamentSetup.category=this.value">
      ${X01_CATEGORIES.map(c=>`<option value="${c}"${ts.category===c?' selected':''}>${c}</option>`).join('')}
    </select>
    <label class="field">Bracket</label>
    <div class="seg out-seg" role="group" aria-label="Bracket type" style="margin-bottom:6px">
      <button type="button" aria-pressed="${ts.bracketType==='single_elim'}" onclick="setTournamentBracketType('single_elim')">Single elimination</button>
      <button type="button" aria-pressed="${ts.bracketType==='double_elim'}" onclick="setTournamentBracketType('double_elim')">Double elimination</button>
    </div>
    <p class="pp-meta" style="margin:0 0 14px">${ts.bracketType==='double_elim'
      ? 'Every player gets a second life in the losers bracket; a loss only eliminates you the second time. Requires exactly 4, 8, 16, 32, 64, or 128 players.'
      : 'One loss and you\'re out. Any number of players (2+); byes fill an uneven bracket.'}</p>
    <label class="field">Players (${n} selected)</label>
    <div class="roster-list" style="margin-bottom:14px">${checklist || '<div class="empty">No players yet — add some from the Players tab first.</div>'}</div>
    ${(n >= 2 && !doubleElimCountOk) ? `<p class="pp-meta" style="color:var(--warn,#e0a800);margin-bottom:12px">Double elimination needs exactly ${TOURNAMENT_DOUBLE_ELIM_COUNTS.join(', ')} players — ${n} selected. Adjust the roster, or switch to single elimination.</p>` : ''}
    ${canBuild ? `
    <label class="field">Seeding</label>
    <div class="seg out-seg" role="group" aria-label="Seeding method" style="margin-bottom:10px">
      <button type="button" aria-pressed="${ts.seedMethod==='random'}" onclick="setTournamentSeedMethod('random')">Random</button>
      <button type="button" aria-pressed="${ts.seedMethod==='manual'}" onclick="setTournamentSeedMethod('manual')">Manual order</button>
      <button type="button" aria-pressed="${ts.seedMethod==='average'}" onclick="setTournamentSeedMethod('average')">By 3-dart average</button>
    </div>
    <div id="tourney-seed-preview">${renderTournamentSeedPreview()}</div>
    <label class="field" style="margin-top:14px">Match format per round</label>
    <div id="tourney-rounds-table">${renderTournamentRoundsTable()}</div>
    ` : ''}
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-primary" ${canBuild?'':'disabled'} onclick="submitTournamentSetup()">Create Tournament</button>
    </div>`;
}

function toggleTournamentPlayer(name, checked){
  const ts = tournamentSetup;
  if(checked){ if(!ts.selected.includes(name)) ts.selected.push(name); }
  else { ts.selected = ts.selected.filter(n=>n!==name); }
  ts.avgByName = null;   // stale once the player set changes
  renderTournamentSetup();
}
function setTournamentBracketType(type){
  tournamentSetup.bracketType = (type === 'double_elim') ? 'double_elim' : 'single_elim';
  tournamentSetup.rounds = [];   // round plan differs by bracket type — rebuilt on re-render
  renderTournamentSetup();
}
function setTournamentSeedMethod(method){
  const ts = tournamentSetup;
  ts.seedMethod = method;
  if(method==='random') shuffleTournamentSeed();
  else if(method==='average') loadTournamentSeedByAverage();
  else renderTournamentSetup();   // manual: keep the current order, just show reorder controls
}
function shuffleTournamentSeed(){
  const ts = tournamentSetup;
  const arr = ts.selected.slice();
  for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  ts.selected = arr;
  ts.avgByName = null;
  renderTournamentSetup();
}
// Seeds by each selected player's existing lifetime 3-dart average (reusing the
// already-public personal-bests endpoint — no new backend surface needed), best
// average first; a player with no recorded legs yet sorts last rather than being
// treated as a (misleadingly literal) zero average.
function loadTournamentSeedByAverage(){
  const ts = tournamentSetup;
  const names = ts.selected.slice();
  // One batch round trip instead of one getPersonalBestsFor() call per selected
  // player (item 51) — same X01-lifetime record each of those calls asked for.
  Backend.get(`/api/players/personal-bests-batch?names=${names.map(encodeURIComponent).join(',')}`)
    .catch(()=>({}))
    .then(results=>{
      const withAvg = names.map(nm=>({ name:nm, avg: results[nm] && results[nm].lifetimeAvg!=null ? results[nm].lifetimeAvg : null }));
      withAvg.sort((a,b)=>{
        if(a.avg==null && b.avg==null) return 0;
        if(a.avg==null) return 1;
        if(b.avg==null) return -1;
        return b.avg - a.avg;
      });
      ts.selected = withAvg.map(x=>x.name);
      ts.avgByName = Object.fromEntries(withAvg.map(x=>[x.name, x.avg]));
      renderTournamentSetup();
    });
}
function renderTournamentSeedPreview(){
  const ts = tournamentSetup;
  const rows = ts.selected.map((name,i)=>{
    const avg = ts.avgByName ? (ts.avgByName[name]!=null ? ` <span class="pp-meta">(${ts.avgByName[name].toFixed(1)} avg)</span>` : ` <span class="pp-meta">(no data yet)</span>`) : '';
    const moveButtons = ts.seedMethod==='manual' ? `
      <button class="iconbtn" title="Move up" ${i===0?'disabled':''} onclick="moveTournamentSeed(${i},-1)">▲</button>
      <button class="iconbtn" title="Move down" ${i===ts.selected.length-1?'disabled':''} onclick="moveTournamentSeed(${i},1)">▼</button>` : '';
    return `<div class="da-row"><span class="da-rank">${i+1}</span><span class="da-label" style="flex:1;font-size:14px">${escapeHtml(name)}${avg}</span>${moveButtons}</div>`;
  }).join('');
  return `<div class="da-list">${rows}</div>`;
}
function moveTournamentSeed(i, dir){
  const ts = tournamentSetup;
  const j = i + dir;
  if(j<0 || j>=ts.selected.length) return;
  [ts.selected[i], ts.selected[j]] = [ts.selected[j], ts.selected[i]];
  renderTournamentSetup();
}
function renderTournamentRoundsTable(){
  const ts = tournamentSetup;
  const plan = tournamentRoundPlan(ts.bracketType, ts.selected.length);
  const rows = ts.rounds.map((r,i)=>{
    const label = (plan[i] && plan[i].label) || `Round ${i+1}`;
    return `<div class="da-row">
      <span class="da-label" style="flex:1;font-size:13px">${escapeHtml(label)}</span>
      <label class="pp-meta" style="margin-right:4px">Legs</label>
      <input type="number" min="1" max="15" value="${r.legsPerSet}" style="width:48px" onchange="setTournamentRoundField(${i},'legsPerSet',this.value)">
      <label class="pp-meta" style="margin:0 4px">Sets</label>
      <input type="number" min="1" max="15" value="${r.setsPerGame}" style="width:48px" onchange="setTournamentRoundField(${i},'setsPerGame',this.value)">
    </div>`;
  }).join('');
  return `<div class="da-list">${rows}</div>`;
}
function setTournamentRoundField(i, field, value){
  tournamentSetup.rounds[i][field] = Math.max(1, Math.round(Number(value)||1));
}
function submitTournamentSetup(){
  const ts = tournamentSetup;
  const name = (ts.name||'').trim();
  if(!name){ uiAlert('Enter a tournament name.'); return; }
  if(ts.selected.length < 2){ uiAlert('Select at least 2 players.'); return; }
  // Same Auth.ensureCanWrite gate submitLeagueSetup()/beginTournamentMatch()
  // use — without it, this write 401-alerted under required-auth instead of
  // prompting login and resuming the action.
  Auth.ensureCanWrite(()=>{
  Backend.send('POST', '/api/tournaments', { name, category: ts.category, players: ts.selected, rounds: ts.rounds, bracketType: ts.bracketType || 'single_elim' })
    .then(r=>{
      tournamentSetup = null;
      currentTournamentId = r.tournamentId;
      tournamentView = 'detail';
      renderTournamentScreen();
    })
    .catch(e=>{ uiAlertErr('Could not create tournament', e); });
  });
}

/* ---------- detail / bracket / up next ---------- */
const TOURNEY_STATUS_ICON  = { pending:'⏳', ready:'▶️', in_progress:'🎯', complete:'✅' };
const TOURNEY_STATUS_LABEL = { pending:'Waiting', ready:'Ready', in_progress:'In progress', complete:'Complete' };

function loadTournamentDetail(){
  const body=document.getElementById('tournament-body');
  body.innerHTML = `<p class="pp-meta" style="padding:4px 0">Loading…</p>`;
  Backend.get(`/api/tournaments/${currentTournamentId}`)
    .then(t=>{ tournamentDetailCache = t; renderTournamentDetail(t); })
    .catch(()=>{ body.innerHTML = `<p class="pp-meta">Could not load tournament.</p>`; });
}
function tournamentMatchCardHtml(m){
  const p1 = m.player1Name ? escapeHtml(m.player1Name) : 'TBD';
  const p2 = m.player2Name ? escapeHtml(m.player2Name) : 'TBD';
  const p1Style = m.winnerName && m.winnerName===m.player1Name ? 'font-weight:700' : '';
  const p2Style = m.winnerName && m.winnerName===m.player2Name ? 'font-weight:700' : '';
  return `<div class="tourney-match-card">
    <div style="${p1Style}">${p1}</div>
    <div style="${p2Style}">${p2}</div>
    <div class="pp-meta" style="font-size:11px">${TOURNEY_STATUS_ICON[m.status]||''} ${TOURNEY_STATUS_LABEL[m.status]||m.status}</div>
  </div>`;
}
function renderTournamentDetail(t){
  const body=document.getElementById('tournament-body');
  // "in_progress" matches (a game was started but never completed — e.g. End
  // Game was used) get listed here too, Walkover-only, no Start button — that's
  // the recovery path for an abandoned match (recordWalkover() on the backend
  // allows overriding one exactly like this).
  const actionableMatches = t.matches.filter(m=>m.status==='ready' || m.status==='in_progress');
  const upNextHtml = actionableMatches.length ? actionableMatches.map(m=>`
    <div class="da-row" style="align-items:center">
      <span class="da-label" style="flex:1;font-size:14px">${escapeHtml(m.label)}: ${escapeHtml(m.player1Name)} vs ${escapeHtml(m.player2Name)}${m.status==='in_progress'?' <span class="pp-meta">(in progress)</span>':''}</span>
      ${m.status==='ready' ? `<button class="btn btn-primary" style="margin-right:6px" onclick="beginTournamentMatch(${m.id})">Start</button>` : ''}
      <button class="btn btn-ghost" onclick="askTournamentWalkover(${m.id}, '${jsArg(m.player1Name)}', '${jsArg(m.player2Name)}')">Walkover</button>
    </div>`).join('') : `<p class="pp-meta">Nothing ready to play right now.</p>`;

  // Group matches into per-round columns, then group those columns by bracket
  // (winners / losers / grand final). Single-elimination has only the winners
  // bracket, so it renders exactly as before — no bracket subheadings. A
  // double-elimination bracket adds a labeled section per bracket
  // (docs/archive/tournament-mode-roadmap.md §2/§4 — a functional grouped-column view; the
  // fancier winners/losers-tab tree is tracked as its own separate open item).
  const roundColumns = (matches)=>{
    const rounds = {};
    matches.forEach(m=>{ (rounds[m.round_no] = rounds[m.round_no] || []).push(m); });
    return Object.keys(rounds).map(Number).sort((a,b)=>a-b).map(rn=>{
      const ms = rounds[rn].slice().sort((a,b)=>a.slot-b.slot);
      return `<div class="tourney-round-col"><div class="pp-section-title">${escapeHtml(ms[0].label)}</div>${ms.map(tournamentMatchCardHtml).join('')}</div>`;
    }).join('');
  };
  const BRACKET_ORDER = ['winners','losers','grand_final'];
  const BRACKET_LABEL = { winners:'Winners', losers:'Losers', grand_final:'Grand Final' };
  const bracketsPresent = BRACKET_ORDER.filter(b => t.matches.some(m => (m.bracket||'winners')===b));
  const isMultiBracket = bracketsPresent.length > 1;
  let bracketHtml;
  if(isMultiBracket){
    // Double-elimination: a Winners / Losers / Grand Final tab switcher, one bracket
    // panel shown at a time (docs/archive/tournament-mode-roadmap.md §4). Keeps the deep
    // double-elim tree readable rather than stacking every bracket in one long scroll.
    if(!bracketsPresent.includes(tournamentBracketTab)) tournamentBracketTab = bracketsPresent[0];
    const tabs = bracketsPresent.map(b=>{
      const sel = b===tournamentBracketTab;
      return `<button role="tab" class="tourney-tab" id="tourney-tab-${b}" aria-selected="${sel}" aria-controls="tourney-panel" tabindex="${sel?0:-1}" onclick="setTournamentBracketTab('${b}')" onkeydown="tournamentTabKeydown(event)">${BRACKET_LABEL[b]}</button>`;
    }).join('');
    const activeBm = t.matches.filter(m => (m.bracket||'winners')===tournamentBracketTab);
    bracketHtml = `
      <div class="tourney-tabs" role="tablist" aria-label="Bracket section">${tabs}</div>
      <div id="tourney-panel" role="tabpanel" aria-labelledby="tourney-tab-${tournamentBracketTab}" class="tourney-bracket">${roundColumns(activeBm)}</div>`;
  } else {
    // Single-elimination: the one winners bracket, no tabs (unchanged).
    bracketHtml = `<div class="tourney-bracket">${roundColumns(t.matches)}</div>`;
  }

  // Linearized "who plays whom next" text list — the bracket tree above is a
  // spatial/visual layout with no non-visual equivalent of its own, so this list
  // (plus the Up Next list above it) is what a screen-reader user actually
  // follows the tournament through, per docs/accessibility-roadmap.md's standing
  // checklist on not relying on a spatial UI as the only way to understand state.
  const orderedMatches = t.matches.slice().sort((a,b)=> (a.round_no-b.round_no) || (a.slot-b.slot));
  const linearHtml = `<details style="margin-top:12px"><summary class="pp-section-title">Full bracket (list view)</summary>
    <div class="da-list">${orderedMatches.map(m=>
      `<div class="da-row"><span class="da-label" style="flex:1;font-size:13px">${escapeHtml(m.label)}: ${escapeHtml(m.player1Name||'TBD')} vs ${escapeHtml(m.player2Name||'TBD')}${m.winnerName?` — winner: ${escapeHtml(m.winnerName)}`:''}</span></div>`
    ).join('')}</div>
  </details>`;

  const header = t.status==='completed'
    ? `<p class="pp-meta">🏆 Champion: <b>${escapeHtml(t.champion_name)}</b> · Runner-up: ${escapeHtml(t.runner_up_name)}</p>`
    : `<p class="pp-meta">In progress · ${t.player_count} players · ${escapeHtml(t.category)}</p>`;

  body.innerHTML = `
    <button class="pp-back" onclick="tournamentView='list'; renderTournamentScreen()">← Tournaments</button>
    <h2 style="font-size:18px;margin:8px 0 4px">${escapeHtml(t.name)}</h2>
    ${header}
    <div class="pp-section">
      <div class="pp-section-title">Up Next</div>
      ${upNextHtml}
    </div>
    <div class="pp-section">
      <div class="pp-section-title">Bracket</div>
      ${bracketHtml}
      ${linearHtml}
    </div>`;
}

// Switches the active Winners/Losers/Grand Final bracket panel (double-elim only).
// Re-renders from the cached detail — no network round-trip — so switching tabs is
// instant; pass focus=true (arrow-key navigation) to move keyboard focus onto the
// newly-selected tab after the re-render.
function setTournamentBracketTab(bracket, focus){
  tournamentBracketTab = bracket;
  if(tournamentDetailCache) renderTournamentDetail(tournamentDetailCache);
  if(focus){ const el = document.getElementById('tourney-tab-'+bracket); if(el) el.focus(); }
}
// Roving-tabindex keyboard support for the bracket tablist (ArrowLeft/Right +
// Home/End), the standard WAI-ARIA tabs pattern — so the bracket switcher is
// operable without a pointer, per docs/accessibility-roadmap.md.
function tournamentTabKeydown(e){
  const keys = ['ArrowRight','ArrowLeft','Home','End'];
  if(!keys.includes(e.key)) return;
  e.preventDefault();
  const tabs = [...document.querySelectorAll('.tourney-tabs [role="tab"]')];
  const i = tabs.indexOf(e.target);
  if(i < 0) return;
  let ni;
  if(e.key==='Home') ni = 0;
  else if(e.key==='End') ni = tabs.length - 1;
  else ni = (i + (e.key==='ArrowRight'?1:-1) + tabs.length) % tabs.length;
  const bracket = tabs[ni].id.replace('tourney-tab-','');
  setTournamentBracketTab(bracket, true);
}

function askTournamentWalkover(matchId, p1, p2){
  openModal(`
    <p class="modal-msg">Record a walkover — who advances without playing?</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitTournamentWalkover(${matchId}, '${jsArg(p1)}')">${escapeHtml(p1)}</button>
      <button class="btn btn-primary" onclick="submitTournamentWalkover(${matchId}, '${jsArg(p2)}')">${escapeHtml(p2)}</button>
    </div>`);
}
function submitTournamentWalkover(matchId, winner){
  closeModal();
  // Same Auth.ensureCanWrite gate every sibling tournament/league write uses.
  Auth.ensureCanWrite(()=>{
    Backend.send('POST', `/api/tournaments/matches/${matchId}/walkover`, { winner })
      .then(loadTournamentDetail)
      .catch(e=>uiAlertErr('Could not record walkover', e));
  });
}

// Starts a ready match's underlying game and drops straight into the existing X01
// scoring screen — the game already exists server-side (created by the /start
// call below), so DB.gameId is set directly rather than via DB.beginGame()'s own
// POST /api/games (which would create a second, untracked game row).
async function beginTournamentMatch(matchId){
  if(Auth.requireAuth && !Auth.loggedIn){ Auth.ensureCanWrite(()=>beginTournamentMatch(matchId)); return; }
  const t = tournamentDetailCache;
  const match = t && t.matches.find(mm=>mm.id===matchId);
  if(!match){ uiAlert('Match not found.'); return; }
  // Same PIN gate the New Game slot picker already applies per-player — a
  // tournament match skips that picker entirely (players are fixed by bracket
  // position), so this is the one place left to actually enforce it.
  withPinCheck(match.player1Name, ()=>{
    withPinCheck(match.player2Name, ()=>_reallyBeginTournamentMatch(matchId), ()=>{});
  }, ()=>{});
}
async function _reallyBeginTournamentMatch(matchId){
  const t = tournamentDetailCache;
  const match = t.matches.find(mm=>mm.id===matchId);
  let result;
  try{ result = await Backend.send('POST', `/api/tournaments/matches/${matchId}/start`); }
  catch(e){ uiAlertErr('Could not start match', e); return; }
  const startScore = Number(t.category);
  const names = [match.player1Name, match.player2Name];
  game = {
    ...baseGameRuntimeState(),
    gameType:'x01',
    config:{ startingScore: startScore },
    start: startScore,
    category: String(startScore),
    legsPerSet: match.legsPerSet, setsPerGame: match.setsPerGame,
    practice: 0,
    players: names.map(nm=>GAME_TYPES.x01.newMatchPlayer(nm, startScore)),
    starter: 0, current: 0, setNo: 1, legNo: 1,
    // Tournament linkage — tournamentMatchId drives the "back to bracket" post-game
    // button (finishUnit()) and the End-game guard (askEndGame()); tournamentRoundLabel
    // feeds the live snapshot's tournamentRoundLabel field (liveSnapshot()) for /display.
    tournamentMatchId: matchId,
    tournamentId: currentTournamentId,
    tournamentRoundLabel: match.label,
  };
  DB.gameId = result.gameId;
  names.forEach(ensurePlayerStats);
  prefetchEarnedBadges(names);
  beginGameSession('always');
}
