'use strict';
/* League mode — list, setup, standings and fixture screens.
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

/* ---------- leagues (docs/archive/league-mode-roadmap.md, X01 or Cricket) ----------
   Structurally a lighter-weight sibling of the tournament screen just above: same
   list/setup/detail 3-state view machine, same roster-checklist setup pattern —
   but no bracket, no per-round format table, no seeding. Games auto-tag into a
   league via the server-side onGameCreated hook (see the New Game "log to league?"
   picker in the New Game section below), so this screen is read-mostly: create a
   league, enroll players, watch standings, end the season when it's over. */
let leagueView = 'list';        // 'list' | 'setup' | 'detail'
let currentLeagueId = null;
let leagueSetup = null;         // built fresh each time the setup view opens

function renderLeagueScreen(){
  if(leagueView==='setup') return renderLeagueSetup();
  if(leagueView==='detail' && currentLeagueId!=null) return loadLeagueDetail();
  return loadLeagueList();
}

function loadLeagueList(){
  const body=document.getElementById('league-body');
  body.innerHTML = `<p class="pp-meta" style="padding:4px 0">Loading…</p>`;
  Backend.get('/api/leagues').then(renderLeagueList)
    .catch(()=>{ body.innerHTML = `<p class="pp-meta">Could not load leagues.</p>`; });
}
const LEAGUE_STATUS_ICON  = { active:'▶️', ended:'🏁' };
const LEAGUE_STATUS_LABEL = { active:'Active', ended:'Ended' };
// League fixtures / pending matches (docs/archive/league-mode-roadmap.md). Status is derived
// server-side (getLeagueFixtures()), never stored — see the same icon+text-together
// convention TOURNEY_STATUS_ICON/LABEL use for tournament matches, so color is never
// the only signal.
const FIXTURE_STATUS_ICON  = { pending:'⏳', in_progress:'🎯', fulfilled:'✅' };
const FIXTURE_STATUS_LABEL = { pending:'Pending', in_progress:'In progress', fulfilled:'Played' };
function renderLeagueList(list){
  const body=document.getElementById('league-body');
  const rows = (list||[]).map(l=>{
    const statusBadge = `${LEAGUE_STATUS_ICON[l.status]||''} ${LEAGUE_STATUS_LABEL[l.status]||l.status}`;
    const gameTypeBadge = l.gameType==='cricket' ? '🎯 ' : '';
    return `<button class="rp-main" onclick="openLeague(${l.id})">
      <div class="rp-name-row">${escapeHtml(l.name)}</div>
      <div class="rp-stat">${gameTypeBadge}${escapeHtml(l.category)} · ${l.playerCount} player${l.playerCount===1?'':'s'} · ${statusBadge}</div>
    </button>`;
  }).join('');
  body.innerHTML = `
    <h2 style="font-size:18px;margin-bottom:4px">Leagues</h2>
    <p style="color:var(--muted);font-size:13px;margin:0 0 16px">A season of casual X01 or Cricket matches — any two enrolled players, any time. Games log to a league automatically.</p>
    <div class="roster-list">${rows || '<div class="empty">No leagues yet.<br>Create your first one below.</div>'}</div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="openLeagueSetup()">+ New League</button>
    </div>`;
}
function openLeague(id){ currentLeagueId=id; leagueView='detail'; renderLeagueScreen(); }
function openLeagueSetup(){ leagueSetup=null; leagueView='setup'; renderLeagueScreen(); }

/* ---------- setup ---------- */
// League game type (docs/archive/league-mode-roadmap.md "Game-type scope") — X01 or Cricket,
// mirroring the New Game screen's own X01/Cricket toggle in spirit. Cricket leagues
// reuse the exact two-value games.category label a Cricket H2H game is already
// tagged with at creation (classic vs. custom target numbers) rather than a numeric
// starting score.
// League setup reuses the shared X01_CATEGORIES list, referenced directly at its two
// call sites rather than aliased here. The alias was a top-level `const A = B`, which
// EXECUTES when this file loads — and this file loads before the main script that
// declares X01_CATEGORIES, so it threw ReferenceError and aborted the whole file,
// taking all 15 league functions with it. One line, every league screen dead. Reading
// the same name from inside a function is fine: by then everything has loaded.
const LEAGUE_CRICKET_CATEGORIES = [
  { value:'Cricket (15-20, Bull)', label:'Classic (15-20, Bull)' },
  { value:'Custom Cricket', label:'Custom numbers' },
];
function setLeagueGameType(gameType){
  const ls = leagueSetup;
  ls.gameType = gameType;
  ls.category = gameType==='cricket' ? LEAGUE_CRICKET_CATEGORIES[0].value : X01_CATEGORIES[0];
  renderLeagueSetup();
}
function renderLeagueSetup(){
  if(!leagueSetup) leagueSetup = { name:'', gameType:'x01', category:'501', selected:[], startsAt: localDateStr(), endsAt:'', pointsWin:1, pointsLoss:0 };
  const ls = leagueSetup;

  const checklist = roster.map(name=>{
    const checked = ls.selected.includes(name);
    const j = jsArg(name);
    return `<label class="tourney-check-row">
      <input type="checkbox" ${checked?'checked':''} onchange="toggleLeaguePlayer('${j}', this.checked)">
      <span>${escapeHtml(name)}</span>
    </label>`;
  }).join('');

  const categoryOptions = ls.gameType==='cricket'
    ? LEAGUE_CRICKET_CATEGORIES.map(c=>`<option value="${escapeHtml(c.value)}"${ls.category===c.value?' selected':''}>${escapeHtml(c.label)}</option>`).join('')
    : X01_CATEGORIES.map(c=>`<option value="${c}"${ls.category===c?' selected':''}>${c}</option>`).join('');

  document.getElementById('league-body').innerHTML = `
    <button class="pp-back" onclick="leagueView='list'; renderLeagueScreen()">← Leagues</button>
    <h2 style="font-size:18px;margin:8px 0 4px">New League</h2>
    <label class="field">League name</label>
    <input type="text" id="league-name" maxlength="64" value="${escapeHtml(ls.name)}" oninput="leagueSetup.name=this.value" style="margin-bottom:14px">
    <label class="field">Game type</label>
    <div class="seg" role="group" aria-label="League game type" style="margin-bottom:14px">
      <button type="button" aria-pressed="${ls.gameType==='x01'}" onclick="setLeagueGameType('x01')">X01</button>
      <button type="button" aria-pressed="${ls.gameType==='cricket'}" onclick="setLeagueGameType('cricket')">🎯 Cricket</button>
    </div>
    <label class="field">${ls.gameType==='cricket' ? 'Format (Cricket)' : 'Format (X01)'}</label>
    <select class="date-input" id="league-category" style="width:auto;margin-bottom:14px" onchange="leagueSetup.category=this.value">
      ${categoryOptions}
    </select>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
      <div>
        <label class="field">Starts</label>
        <input type="date" class="date-input" value="${escapeHtml(ls.startsAt)}" onchange="leagueSetup.startsAt=this.value">
      </div>
      <div>
        <label class="field">Ends <span class="pp-meta">(optional — open-ended if blank)</span></label>
        <input type="date" class="date-input" value="${escapeHtml(ls.endsAt)}" onchange="leagueSetup.endsAt=this.value">
      </div>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
      <div>
        <label class="field">Points for a win</label>
        <input type="number" style="width:64px" value="${ls.pointsWin}" onchange="leagueSetup.pointsWin=Number(this.value)||0">
      </div>
      <div>
        <label class="field">Points for a loss</label>
        <input type="number" style="width:64px" value="${ls.pointsLoss}" onchange="leagueSetup.pointsLoss=Number(this.value)||0">
      </div>
    </div>
    <label class="field">Players (${ls.selected.length} selected — more can be enrolled later)</label>
    <div class="roster-list" style="margin-bottom:14px">${checklist || '<div class="empty">No players yet — add some from the Players tab first.</div>'}</div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-primary" onclick="submitLeagueSetup()">Create League</button>
    </div>`;
}
function toggleLeaguePlayer(name, checked){
  const ls = leagueSetup;
  if(checked){ if(!ls.selected.includes(name)) ls.selected.push(name); }
  else { ls.selected = ls.selected.filter(n=>n!==name); }
  renderLeagueSetup();
}
function submitLeagueSetup(){
  const ls = leagueSetup;
  const name = (ls.name||'').trim();
  if(!name){ uiAlert('Enter a league name.'); return; }
  Auth.ensureCanWrite(()=>{
    Backend.send('POST', '/api/leagues', {
      name, gameType: ls.gameType, category: ls.category, startsAt: ls.startsAt, endsAt: ls.endsAt,
      pointsWin: ls.pointsWin, pointsLoss: ls.pointsLoss, players: ls.selected,
    }).then(r=>{
      leagueSetup = null;
      currentLeagueId = r.leagueId;
      leagueView = 'detail';
      renderLeagueScreen();
    }).catch(e=>{ uiAlertErr('Could not create league', e); });
  });
}

/* ---------- detail / standings ---------- */
// Formats a plain calendar date ("YYYY-MM-DD", e.g. leagues.starts_at/ends_at) —
// deliberately NOT fmtDate(), which is built for UTC timestamps and reinterprets
// them via local Date getters. Doing that to a bare calendar date shifts it by a
// day in any negative-UTC-offset timezone (e.g. "2026-01-01" renders as "Dec 31,
// 2025" for a US-based self-hoster) — a real bug for a date with no time-of-day
// component. Parsed directly from the string, no Date object, no timezone math.
function fmtCalendarDate(dateStr){
  if(!dateStr) return '';
  const [yr,mo,dy] = dateStr.slice(0,10).split('-');
  return `${MONTHS[Number(mo)-1]} ${Number(dy)}, ${yr}`;
}
function loadLeagueDetail(){
  const body=document.getElementById('league-body');
  body.innerHTML = `<p class="pp-meta" style="padding:4px 0">Loading…</p>`;
  Backend.get(`/api/leagues/${currentLeagueId}`)
    .then(l=>renderLeagueDetail(l))
    .catch(()=>{ body.innerHTML = `<p class="pp-meta">Could not load league.</p>`; });
}
function renderLeagueDetail(l){
  const body=document.getElementById('league-body');
  const th = (label) => `<th scope="col" style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--wire);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em">${label}</th>`;
  const rows = l.standings.map((r,i)=>`<tr>
    <td style="padding:8px 10px;border-bottom:1px solid var(--wire);color:var(--muted)">${i+1}</td>
    <td style="padding:8px 10px;border-bottom:1px solid var(--wire);font-weight:600">${escapeHtml(r.name)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid var(--wire)">${r.played}</td>
    <td style="padding:8px 10px;border-bottom:1px solid var(--wire)">${r.won}</td>
    <td style="padding:8px 10px;border-bottom:1px solid var(--wire)">${r.lost}</td>
    <td style="padding:8px 10px;border-bottom:1px solid var(--wire)">${r.winPct!=null?r.winPct+'%':'—'}</td>
    <td style="padding:8px 10px;border-bottom:1px solid var(--wire);font-weight:700">${r.points}</td>
  </tr>`).join('');
  const statusBadge = `${LEAGUE_STATUS_ICON[l.status]||''} ${LEAGUE_STATUS_LABEL[l.status]||l.status}`;
  const dateRange = l.endsAt ? `${fmtCalendarDate(l.startsAt)} – ${fmtCalendarDate(l.endsAt)}` : `${fmtCalendarDate(l.startsAt)} – ongoing`;
  const enrolledNames = new Set(l.standings.map(r=>r.name));
  const notEnrolled = roster.filter(n=>!enrolledNames.has(n));

  const gameTypeBadge = l.gameType==='cricket' ? '🎯 ' : '';
  const fixtures = l.fixtures || [];
  const fixturesHtml = fixtures.length ? `<div class="da-list">${fixtures.map(f=>`
    <div class="da-row"><span class="da-label" style="flex:1;font-size:13px">${escapeHtml(f.player1Name)} vs ${escapeHtml(f.player2Name)}</span>
      <span class="pp-meta" style="font-size:11px">${FIXTURE_STATUS_ICON[f.status]||''} ${FIXTURE_STATUS_LABEL[f.status]||f.status}</span>
    </div>`).join('')}</div>` : `<p class="pp-meta">No fixtures yet — enroll at least two players to generate the round-robin schedule.</p>`;

  body.innerHTML = `
    <button class="pp-back" onclick="leagueView='list'; renderLeagueScreen()">← Leagues</button>
    <h2 style="font-size:18px;margin:8px 0 4px">${escapeHtml(l.name)}</h2>
    <p class="pp-meta" style="margin:0 0 16px">${gameTypeBadge}${escapeHtml(l.category)} · ${statusBadge} · ${dateRange} · win ${l.pointsWin} / loss ${l.pointsLoss} pts</p>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <caption class="sr-only">Standings for ${escapeHtml(l.name)}</caption>
        <thead><tr>${th('#')}${th('Player')}${th('P')}${th('W')}${th('L')}${th('Win%')}${th('Pts')}</tr></thead>
        <tbody>${rows || `<tr><td colspan="7" style="padding:12px 10px;color:var(--muted)">No players enrolled yet.</td></tr>`}</tbody>
      </table>
    </div>
    <div class="pp-section-title" style="margin-top:20px">Fixtures</div>
    <p class="pp-meta" style="margin:0 0 8px">Every enrolled pairing's round-robin match for this season.</p>
    ${fixturesHtml}
    <div class="btn-row" style="margin-top:16px;flex-wrap:wrap">
      ${notEnrolled.length ? `
        <select class="date-input" id="league-enroll-pick" style="width:auto">
          ${notEnrolled.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
        </select>
        <button class="btn btn-ghost" onclick="submitEnrollLeaguePlayer(${l.id})">+ Enroll player</button>
      ` : ''}
      ${l.status==='active'
        ? `<button class="btn btn-ghost danger" onclick="askEndLeague(${l.id},'${jsArg(l.name)}')">End league</button>`
        : `<button class="btn btn-ghost" onclick="askReopenLeague(${l.id},'${jsArg(l.name)}')">Reopen league</button>`}
    </div>`;
}
function submitEnrollLeaguePlayer(leagueId){
  const sel = document.getElementById('league-enroll-pick');
  if(!sel || !sel.value) return;
  Auth.ensureCanWrite(()=>{
    Backend.send('POST', `/api/leagues/${leagueId}/players`, { name: sel.value })
      .then(loadLeagueDetail)
      .catch(e=>uiAlertErr('Could not enroll player', e));
  });
}
function askEndLeague(leagueId, name){
  uiConfirm(`End the league "${name}"? Standings stay visible, but new games will stop logging to it automatically. You can reopen it later.`, ()=>{
    Auth.ensureCanWrite(()=>{
      Backend.send('PUT', `/api/leagues/${leagueId}/status`, { status: 'ended' })
        .then(loadLeagueDetail)
        .catch(e=>uiAlertErr('Could not end league', e));
    });
  });
}
function askReopenLeague(leagueId, name){
  uiConfirm(`Reopen the league "${name}"? New matching games will resume auto-logging to it.`, ()=>{
    Auth.ensureCanWrite(()=>{
      Backend.send('PUT', `/api/leagues/${leagueId}/status`, { status: 'active' })
        .then(loadLeagueDetail)
        .catch(e=>uiAlertErr('Could not reopen league', e));
    });
  });
}
