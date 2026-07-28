'use strict';
/* End-of-night Session Recap — extracted from index.html
   (docs/frontend-module-split-roadmap.md step 2, the last of the leaf areas).

   A CLASSIC script, not a module: it shares one global scope with index.html's
   inline script, which is what lets renderHomeRecapTeaser() be called from an inline
   on*= handler and lets recapDate be read by the code that reopens the recap. See
   that roadmap for why ES modules are the wrong target for this codebase.

   Nothing at the top level of this file may READ a name the main script declares:
   split files load first, so such a line throws ReferenceError and takes every
   function in the file down with it. backend/check.js's load-order rule enforces
   that, after one such line silently killed all 15 league functions. Reading those
   names from INSIDE a function is fine — by then everything has loaded. */

/* =========================================================================
   END-OF-NIGHT SESSION RECAP (docs/archive/session-recap-roadmap.md)
   A one-tap digest of a night's activity — read-time only, nothing stored;
   getSessionRecap(date) (backend/db.js) does all the real work. The teaser
   below fetches today's own recap on every Home load (a genuine network
   round-trip, unlike the Daily Challenge teaser above, since "did anyone
   finish a game tonight" can't be derived client-side the way the challenge
   shape can) and hides itself entirely when nothing's been played yet — the
   same conditional-teaser pattern the League/Elo teasers already use.
   ========================================================================= */
let recapDate = null;
function renderHomeRecapTeaser(){
  const card = document.getElementById('home-recap-teaser-card');
  const el = document.getElementById('home-recap-teaser-body');
  if(!card || !el) return;
  const today = localDateStr();
  Backend.get(`/api/session-recap?date=${today}&tz=${-new Date().getTimezoneOffset()}`).then(r=>{
    if(!r || !r.totalGames){ card.hidden = true; return; }
    card.hidden = false;
    const players = new Set();
    r.h2hGames.forEach(g=>g.players.forEach(p=>players.add(p)));
    el.innerHTML = `
      <p style="margin:0;color:var(--ink);font-size:14px">${r.totalGames} game${r.totalGames===1?'':'s'} played tonight, ${players.size} player${players.size===1?'':'s'} in the mix.</p>
      <p class="pp-meta" style="margin:8px 0 12px">${r.badgesEarnedTonight.length ? `${r.badgesEarnedTonight.length} badge${r.badgesEarnedTonight.length===1?'':'s'} earned. ` : ''}${r.personalBestsSetTonight.length ? `${r.personalBestsSetTonight.length} personal best${r.personalBestsSetTonight.length===1?'':'s'} set.` : ''}</p>
      <button class="btn btn-primary" onclick="openSessionRecap('${today}')">View recap →</button>`;
  }).catch(()=>{ card.hidden = true; });
}
function openSessionRecap(date){
  recapDate = date || localDateStr();
  show('session-recap');
}
function loadSessionRecap(date){
  recapDate = date;
  const el = document.getElementById('session-recap-body');
  if(!el) return;
  el.innerHTML = `<p class="pp-meta">Loading…</p>`;
  Backend.get(`/api/session-recap?date=${encodeURIComponent(date)}&tz=${-new Date().getTimezoneOffset()}`)
    .then(r=>{ _lastRecap = r; renderSessionRecapBody(r); })
    .catch(()=>{ el.innerHTML = `<p class="pp-meta">Couldn't load the recap for this date.</p>`; });
}
let _lastRecap = null;
const RECAP_MOMENT_ICON = { '180':'🎯', bigfish:'🐟', tonplus:'💯', matchwin:'🏆', badge:'🏅' };
const RECAP_PB_METRIC_LABEL = { legAvg:'Best leg average', fewestDartsCheckout:'Fewest darts to check out', highestCheckout:'Highest checkout' };
function badgeLabelFor(id){
  const b = BADGE_INFO[id];
  return b ? `${b.icon} ${escapeHtml(b.label)}` : escapeHtml(id);
}
// Timestamps come back as UTC "YYYY-MM-DD HH:MM:SS" — parsed via the shared
// parseSqliteTimestamp() (scoring.js), NOT an inline re-implementation: that
// helper exists precisely because this parsing gap was inline-fixed three
// separate times before Ghost mode reshipped the same 'Invalid Date' bug.
// Shows the local time-of-day instead of the date, since the moments list is
// already grouped under one date heading.
function fmtRecapTime(ts){
  if(!ts) return '';
  const d = parseSqliteTimestamp(ts);
  if(isNaN(d)) return '';
  return d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}
function renderSessionRecapBody(r){
  const el = document.getElementById('session-recap-body');
  if(!el) return;
  const dateObj = new Date(r.date + 'T12:00:00');
  const dateLabel = isNaN(dateObj) ? r.date : dateObj.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });

  if(!r.totalGames && !r.soloActivity.length && !r.moments.length){
    el.innerHTML = `<p class="pp-meta">Nothing recorded on ${escapeHtml(dateLabel)}.</p>`;
    return;
  }

  const twoPlayerHtml = r.h2hResultsByMatchup.length ? `
    <div class="pp-section">
      <div class="pp-section-title">Results</div>
      ${r.h2hResultsByMatchup.map(m=>{
        const recordStr = m.players.map(p=>`${escapeHtml(p)} ${m.record[p]||0}`).join(' — ');
        return `<div style="margin:10px 0">
          <div style="font-weight:600;color:var(--ink)">${recordStr}</div>
          <div class="pp-meta">${m.games.map(g=>`${escapeHtml(g.category)}: ${g.winner ? escapeHtml(g.winner)+' won' : 'no result'}`).join(' · ')}</div>
        </div>`;
      }).join('')}
    </div>` : '';

  // A 3+ player game has no single pairwise "matchup" — listed separately
  // rather than folded into the record grid above.
  const multiGames = r.h2hGames.filter(g=>g.players.length > 2);
  const multiGamesHtml = multiGames.length ? `
    <div class="pp-section">
      <div class="pp-section-title">Other games</div>
      ${multiGames.map(g=>`<div class="pp-meta" style="margin:6px 0">${escapeHtml(g.players.join(', '))} — ${escapeHtml(g.category)} — won by ${g.winnerName ? escapeHtml(g.winnerName) : '—'}</div>`).join('')}
    </div>` : '';

  const perPlayerHtml = r.perPlayer.length ? `
    <div class="pp-section">
      <div class="pp-section-title">Tonight, per player</div>
      <div class="roster-list">
        ${r.perPlayer.map(p=>{
          const bits = [`${p.gamesWon}-${p.gamesLost}`, `${p.dartsThrown} darts`];
          if(p.bestVisit != null) bits.push(`best visit ${p.bestVisit}`);
          if(p.bestLegAvg != null) bits.push(`best leg ${p.bestLegAvg}`);
          if(p.oneEighties) bits.push(`${p.oneEighties}× 180`);
          if(p.tonPlusCheckouts) bits.push(`${p.tonPlusCheckouts} ton+`);
          return `<div class="rp-main" style="cursor:default">
            <div class="rp-name-row">${escapeHtml(p.name)}</div>
            <div class="rp-stat">${bits.join(' · ')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const soloHtml = r.soloActivity.length ? `
    <div class="pp-section">
      <div class="pp-section-title">Also tonight</div>
      ${r.soloActivity.map(s=>{
        const label = (GAME_TYPES[s.gameType] && GAME_TYPES[s.gameType].label) || s.gameType;
        const legsBit = s.legs != null ? `${s.legs} leg${s.legs===1?'':'s'} · ` : '';
        return `<div class="pp-meta" style="margin:4px 0">${escapeHtml(s.name)} — ${escapeHtml(label)}: ${legsBit}${s.darts} darts</div>`;
      }).join('')}
    </div>` : '';

  const badgesHtml = r.badgesEarnedTonight.length ? `
    <div class="pp-section">
      <div class="pp-section-title">Badges earned tonight</div>
      ${r.badgesEarnedTonight.map(b=>`<div class="pp-meta" style="margin:4px 0">${escapeHtml(b.player)} — ${badgeLabelFor(b.badgeId)}</div>`).join('')}
    </div>` : '';

  const pbHtml = r.personalBestsSetTonight.length ? `
    <div class="pp-section">
      <div class="pp-section-title">Personal bests set tonight</div>
      ${r.personalBestsSetTonight.map(pb=>`<div class="pp-meta" style="margin:4px 0">${escapeHtml(pb.player)} — ${RECAP_PB_METRIC_LABEL[pb.metric]||pb.metric}: ${pb.value}${pb.previousBest!=null?` (was ${pb.previousBest})`:' (first ever recorded)'}</div>`).join('')}
    </div>` : '';

  const momentsHtml = r.moments.length ? `
    <div class="pp-section">
      <div class="pp-section-title">Moments</div>
      <ul style="list-style:none;padding:0;margin:8px 0 0">
        ${r.moments.map(m=>`<li style="padding:6px 0;border-bottom:1px solid var(--wire);font-size:13px;display:flex;justify-content:space-between;gap:10px">
          <span><span aria-hidden="true">${RECAP_MOMENT_ICON[m.type]||'•'}</span> <b style="color:var(--ink)">${escapeHtml(m.player)}</b> ${m.type==='badge' ? badgeLabelFor(m.text) : escapeHtml(m.text)}</span>
          <span class="pp-meta">${fmtRecapTime(m.ts)}</span>
        </li>`).join('')}
      </ul>
    </div>` : '';

  el.innerHTML = `
    <p class="pp-meta" style="margin:0 0 14px">${escapeHtml(dateLabel)} · ${r.totalGames} game${r.totalGames===1?'':'s'} played</p>
    ${twoPlayerHtml}${multiGamesHtml}${perPlayerHtml}${soloHtml}${badgesHtml}${pbHtml}${momentsHtml}
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="shareSessionRecap()">📤 Share</button>
    </div>`;
}
// Renders the recap through the existing shareable-moment card generator
// (docs/archive/session-recap-roadmap.md: "one new card layout, the rest of the
// pipeline ... already built") — no new canvas code, just a recap-shaped
// headline/statLine fed into buildMomentCard() via fireMomentCard().
function shareSessionRecap(){
  if(!_lastRecap) return;
  const r = _lastRecap;
  const dateObj = new Date(r.date + 'T12:00:00');
  const dateLabel = isNaN(dateObj) ? r.date : dateObj.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
  const players = new Set();
  r.h2hGames.forEach(g=>g.players.forEach(p=>players.add(p)));
  const bits = [`${r.totalGames} game${r.totalGames===1?'':'s'}`];
  if(players.size) bits.push(`${players.size} player${players.size===1?'':'s'}`);
  const topScorer = r.perPlayer.slice().sort((a,b)=>b.oneEighties-a.oneEighties)[0];
  if(topScorer && topScorer.oneEighties) bits.push(`${topScorer.name} hit ${topScorer.oneEighties}× 180`);
  if(r.badgesEarnedTonight.length) bits.push(`${r.badgesEarnedTonight.length} badge${r.badgesEarnedTonight.length===1?'':'s'} earned`);
  fireMomentCard('sessionrecap', { icon:'🌙', headline:"TONIGHT'S RECAP", player:dateLabel, statLine:bits.join(' · ') })
    .then(()=>shareMomentCard('sessionrecap'));
}
