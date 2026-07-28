'use strict';
/* Daily Challenge — the format registry, the attempt state, and the Home surfaces.
   Extracted from index.html (docs/frontend-module-split-roadmap.md step 2).

   A CLASSIC script, not a module: it shares one global scope with index.html's
   inline script. That is what lets an inline on*= handler call startDailyChallenge(),
   and what lets the X01 turn loop assign activeChallenge — an ES module could do
   neither. See that roadmap for the measurements behind choosing classic scripts.

   WHAT STAYED BEHIND, and why the old section banner was a poor guide to it: the
   region this came from also held X01_CATEGORIES (the New Game flavor select,
   tournament setup and leagues.js all read it) and the sessionBadgesShown /
   earnedBadgeCache badge state, neither of which is challenge code. A banner comment
   marks where a topic starts, not where it ends, and two earlier attempts at this
   split failed by trusting one. The boundary here is per-declaration.

   The challenge functions that render INSIDE another screen (the New Game setup
   section, the Settings reset control, the profile history panel) live here too, so
   there is one place to look for "how does the Daily Challenge work" rather than
   two.

   Nothing at the top level of this file may READ a name the main script declares:
   split files load first, so such a line throws ReferenceError and takes every
   function in the file down with it. backend/check.js's load-order rule enforces
   that. _seededIndex is the one top-level read here and it is safe because
   scoring.js is loaded ABOVE these files, not below. */

/* =========================================================================
   DAILY CHALLENGE  (docs/archive/daily-challenge-roadmap.md)
   A pool of genuinely different challenge shapes, picked deterministically by
   date (pure function, no server-side randomness) so the format itself varies
   day to day, not just a number inside the same task shape every time.
   ========================================================================= */
// CHALLENGE_CHECKOUTS now lives in scoring.js (docs/archive/dead-man-walking-roadmap.md
// "Cold start" — Dead Man Walking's own cold-start fallback reuses this exact
// pool server-side, so it moved to the shared module both index.html and
// backend/db.js already require in, rather than being duplicated).
// Order is load-bearing: todaysChallenge() seeds an index into this exact
// array by date, so a future format must always be APPENDED, never inserted
// or reordered — doing either would retroactively change which format every
// past date "was", corrupting history. Kept as its own explicit array
// (rather than Object.keys(CHALLENGE_FORMAT_DEFS)) so that invariant can't be
// broken by silently reordering the registry below for readability.
const CHALLENGE_FORMATS = ['checkout_sprint','speed_to_zero','bullseye_gauntlet','steady_hand','treble_run','long_game',
  'doubles_gauntlet','ton_hunter','around_the_horn'];
// Fixed visit count for Ton Hunter — enough attempts to make a 100+ visit a
// real, earned outcome rather than a one-in-three coin flip.
const TON_HUNTER_VISITS = 6;
// Everything that makes a Daily Challenge format ITS OWN format, in one place
// per entry — the registry-dispatch pattern this codebase already uses for
// per-game-type behavior (GAME_TYPES), applied here so a new format (this
// session added ideas 1-3: Doubles Gauntlet/Ton Hunter/Around the Horn) is one
// new entry, not a change to 6 scattered functions across enterTurn()/
// liveModeState/finishUnit()/todaysChallenge(). `gameType` names which
// underlying game engine the attempt runs on — every format so far resolves
// to 'x01' (a genuinely Cricket/Baseball-based format is still a real future
// option this field exists for, per the codebase's full-frontend code
// review's "Daily Challenge X01-coupling" audit), but nothing here assumes
// it's the only value; setMode()/startGame() read it generically.
//   label(target)       — full description (New Game screen)
//   shortLabel(target)  — short form (moment cards, stat lines, comparisons)
//   metricLabel(value)  — formats an achieved metric value for display
//   pickTarget(dateStr) — this format's own per-day target, or null
//   startScore(target)  — the X01 starting score to construct the game with
//   checkCompletion(game, p, ev) — called from enterTurn() on every non-win
//     visit by the challenge's own player; return null if not done yet,
//     { dnf:true } to abandon (a bust before reaching the goal), or
//     { metric } once the format's own win condition is met. Formats that
//     complete via the normal X01 double-out path (checkout_sprint,
//     speed_to_zero) leave this null — enterTurn()'s existing ev.win branch
//     already handles them with no format-specific code needed.
//   winOverrideMetric(p) — for a format whose metric isn't simply "darts to
//     finish" but that CAN also end via a genuine ev.win (long_game: a real
//     checkout that also happens to drop under 40) — returns the true metric
//     to record instead of the generic dart-count fallback.
//   extraResultData(game) — optional extra data for the results screen's
//     format-specific visual (Treble Run's hit-number chips); null otherwise.
//   liveMetric(game, p) — the in-progress value of this format's metric at
//     any point mid-attempt (not just once checkCompletion's threshold is
//     met), for the live scoreboard (/display)'s running readout.
//   usesFillerScore — true when startScore() is a meaningless filler (the
//     real win condition is checkCompletion, not the score reaching 0), so
//     the live scoreboard should show the metric as the hero number instead
//     of the filler countdown. Omitted (falsy) for the 3 formats whose score
//     genuinely means something (Checkout Sprint/Speed to Zero/The Long Game).
//   visitCap — the fixed visit count this format completes at exactly (3 for
//     Bullseye Gauntlet/Steady Hand/Treble Run/Doubles Gauntlet, 6 for Ton
//     Hunter), driving the live scoreboard's visit-progress pip row. null/
//     omitted for open-ended formats (Around the Horn, and the 3 real-score
//     formats, none of which show pips).
const CHALLENGE_FORMAT_DEFS = {
  checkout_sprint: {
    gameType: 'x01',
    label: (t) => `Checkout Sprint — finish ${t} in the fewest darts`,
    shortLabel: (t) => `Checkout ${t}`,
    // shortLabel is per-day-target ("Checkout 40"); this is the target-independent
    // name for cross-day aggregates (Player Profile's per-format best table).
    genericName: 'Checkout Sprint',
    metricLabel: (v) => `${v} darts`,
    pickTarget: (dateStr) => CHALLENGE_CHECKOUTS[_seededIndex(dateStr+'|target', CHALLENGE_CHECKOUTS.length)],
    startScore: (target) => target,
    checkCompletion: null,
    liveMetric: (game, p) => p.legDarts,
  },
  speed_to_zero: {
    gameType: 'x01',
    label: () => `Speed to Zero — full 501 leg, fewest total darts`,
    shortLabel: () => `Speed to Zero`,
    metricLabel: (v) => `${v} darts`,
    pickTarget: () => null,
    startScore: () => 501,
    checkCompletion: null,
    liveMetric: (game, p) => p.legDarts,
  },
  bullseye_gauntlet: {
    gameType: 'x01',
    label: () => `Bullseye Gauntlet — most bulls hit in 3 visits (9 darts)`,
    shortLabel: () => `Bullseye Gauntlet`,
    metricLabel: (v) => `${v} bull${v===1?'':'s'}`,
    pickTarget: () => null,
    // A filler start comfortably above any realistic 9-dart total (max
    // 9x60=540), purely so the X01 engine never spuriously busts/wins
    // mid-challenge — this format's real win condition is checkCompletion.
    startScore: () => 1000,
    usesFillerScore: true,
    visitCap: 3,
    checkCompletion: (game) => {
      if(game.legVisitLogs.length < 3) return null;
      return { metric: game.legVisitLogs.flat().filter(d=>d.sector===25).length };
    },
    liveMetric: (game) => game.legVisitLogs.flat().filter(d=>d.sector===25).length,
  },
  treble_run: {
    gameType: 'x01',
    label: () => `Treble Run — most different trebles hit in 3 visits (9 darts)`,
    shortLabel: () => `Treble Run`,
    metricLabel: (v) => `${v} treble${v===1?'':'s'}`,
    pickTarget: () => null,
    startScore: () => 1000,
    usesFillerScore: true,
    visitCap: 3,
    checkCompletion: (game) => {
      if(game.legVisitLogs.length < 3) return null;
      return { metric: new Set(game.legVisitLogs.flat().filter(d=>d.isTreble).map(d=>d.sector)).size };
    },
    extraResultData: (game) => challengeTrebleNumbersFrom(game.legVisitLogs),
    liveMetric: (game) => new Set(game.legVisitLogs.flat().filter(d=>d.isTreble).map(d=>d.sector)).size,
  },
  steady_hand: {
    gameType: 'x01',
    label: () => `Steady Hand — score as close to 20 as possible each visit, without going over`,
    shortLabel: () => `Steady Hand`,
    metricLabel: (v) => `${v} pts`,
    pickTarget: () => null,
    startScore: () => 1000,
    usesFillerScore: true,
    visitCap: 3,
    checkCompletion: (game) => {
      if(game.legVisitLogs.length < 3) return null;
      const metric = game.legVisitLogs.reduce((s,visit)=>{ const t=visit.reduce((x,d)=>x+d.value,0); return s + (t<=20 ? t : 0); }, 0);
      return { metric };
    },
    liveMetric: (game) => game.legVisitLogs.reduce((s,visit)=>{ const t=visit.reduce((x,d)=>x+d.value,0); return s + (t<=20 ? t : 0); }, 0),
  },
  long_game: {
    gameType: 'x01',
    label: () => `The Long Game — fewest visits from 501 to under 40, no busts`,
    shortLabel: () => `The Long Game`,
    metricLabel: (v) => `${v} visit${v===1?'':'s'}`,
    pickTarget: () => null,
    startScore: () => 501,
    checkCompletion: (game, p, ev) => {
      if(ev.bust) return { dnf: true };   // busted before reaching the target — DNF, stop tracking
      if(p.score < 40) return { metric: p.legVisits };
      return null;
    },
    // The metric is always "how many visits it took," even on the rare path
    // where the final visit both drops under 40 AND is a legitimate
    // double-out checkout to exactly 0 (a real ev.win, not checkCompletion) —
    // without this, that one path would fall through to the generic
    // dart-count fallback instead, storing a different kind of number for
    // the same format depending on how the leg happened to end.
    winOverrideMetric: (p) => p.legVisits,
    liveMetric: (game, p) => p.legVisits,
  },
  doubles_gauntlet: {
    gameType: 'x01',
    label: () => `Doubles Gauntlet — most different doubles hit in 3 visits (9 darts)`,
    shortLabel: () => `Doubles Gauntlet`,
    metricLabel: (v) => `${v} double${v===1?'':'s'}`,
    pickTarget: () => null,
    startScore: () => 1000,
    usesFillerScore: true,
    visitCap: 3,
    checkCompletion: (game) => {
      if(game.legVisitLogs.length < 3) return null;
      return { metric: distinctDoubleSectors(game.legVisitLogs).length };
    },
    liveMetric: (game) => distinctDoubleSectors(game.legVisitLogs).length,
  },
  ton_hunter: {
    gameType: 'x01',
    label: () => `Ton Hunter — most 100+ visits in ${TON_HUNTER_VISITS} visits`,
    shortLabel: () => `Ton Hunter`,
    metricLabel: (v) => `${v} ton${v===1?'':'s'}`,
    pickTarget: () => null,
    // Derived, not the flat 1000 the 3-visit formats use. A filler score exists so the
    // X01 engine can never naturally bust or win mid-attempt — the whole format is
    // decided by checkCompletion() at the visit cap. At 6 visits Ton Hunter's own
    // theoretical maximum is 6 × 180 = 1080, so a flat 1000 was 80 points BELOW it:
    // a perfect attempt could drive the underlying score under 170 and start drawing
    // checkout hints, or reach 0 and end the leg through the engine instead of through
    // checkCompletion(). Unreachable in practice, but the premise the filler rests on
    // was simply false here. Computed from the cap so a future change to
    // TON_HUNTER_VISITS can't quietly reintroduce it. (The 3-visit formats have
    // 3 × 180 = 540 against the same 1000 and were never close.)
    startScore: () => TON_HUNTER_VISITS * 180 + 180,
    usesFillerScore: true,
    visitCap: TON_HUNTER_VISITS,
    checkCompletion: (game) => {
      if(game.legVisitLogs.length < TON_HUNTER_VISITS) return null;
      return { metric: countTonPlusVisits(game.legVisitLogs) };
    },
    liveMetric: (game) => countTonPlusVisits(game.legVisitLogs),
  },
  around_the_horn: {
    gameType: 'x01',
    label: () => `Around the Horn — hit 20 down to 1 in order (singles only), fewest darts`,
    shortLabel: () => `Around the Horn`,
    metricLabel: (v) => `${v} darts`,
    pickTarget: () => null,
    // Open-ended — completion isn't visit-capped like the 3-visit formats, so
    // the filler start needs to comfortably outlast however many darts a real
    // attempt (including plenty of misses/wrong-number darts) actually takes.
    startScore: () => 100000,
    usesFillerScore: true,
    checkCompletion: (game) => {
      const prog = aroundTheHornProgress(game.legVisitLogs);
      if(!prog.done) return null;
      return { metric: prog.dartsThrown };
    },
    liveMetric: (game) => aroundTheHornProgress(game.legVisitLogs).dartsThrown,
  },
};
// The running state of the challenge attempt in progress, or null when there
// isn't one. ONE computation, read by both scoreboards: GAME_TYPES.x01's
// liveModeState() (which ships it to /display) and renderGameX01() (the in-app
// scoreboard behind both the keypad and the dartboard). They used to disagree —
// /display showed "1 ton · 2/6 visits" while the app itself showed the raw
// filler countdown ticking down from 1000, which reads as a target the player is
// supposed to be chasing and isn't one. A challenge is plain X01 underneath, so
// there is no game type for either scoreboard to branch on; this is the branch.
function challengeLiveState(game){
  if(!activeChallenge || !game || !game.players[0] || activeChallenge.player !== game.players[0].name) return null;
  const def = CHALLENGE_FORMAT_DEFS[activeChallenge.format];
  const metric = def.liveMetric(game, game.players[0]);
  return {
    format: activeChallenge.format,
    target: activeChallenge.target,
    label: challengeShortLabel(activeChallenge.format, activeChallenge.target),
    metric,
    metricLabel: challengeMetricLabel(activeChallenge.format, metric),
    visitsCompleted: (game.legVisitLogs || []).length,
    visitCap: def.visitCap || null,
    // The formats whose score is a deliberately-too-high filler so the X01
    // engine never busts or wins mid-attempt. For those the countdown is noise
    // and the metric is the hero; for the three real-score formats (Checkout
    // Sprint / Speed to Zero / The Long Game) the score is the point, so both
    // scoreboards keep showing it.
    usesFillerScore: !!def.usesFillerScore,
    trebleNumbers: def.extraResultData ? def.extraResultData(game) : null,
  };
}
function challengeShortLabel(format, target){ return (CHALLENGE_FORMAT_DEFS[format] || CHALLENGE_FORMAT_DEFS.speed_to_zero).shortLabel(target); }
function challengeMetricLabel(format, value){ return (CHALLENGE_FORMAT_DEFS[format] || CHALLENGE_FORMAT_DEFS.speed_to_zero).metricLabel(value); }
// The async-patched portion of the Daily Challenge results screen
// (docs/daily-challenge-results-roadmap.md): the personal-best banner already
// existed here; this extends the same placeholder to also show a "your
// best"/"last time" comparison, the current streak, and a small per-format
// recent-attempts strip — all sourced from the exact fields
// getChallengeResultSummary() (backend/db.js) already computes server-side
// (personalBest/previousBest/lastResult/recentAttempts/currentStreak), so no
// history math is duplicated client-side. `r` is /api/challenges/complete's
// response; a no-op if `el` no longer exists (player already navigated away
// before the round-trip resolved) or `r` is falsy (request failed).
function renderChallengeResultExtra(el, r, format, target){
  if(!el || !r) return;
  const pbBanner = r.isPersonalBest
    ? `<p style="color:var(--gold);font-weight:700;font-size:13px;margin:0 0 10px">🏆 New personal best for ${escapeHtml(challengeShortLabel(format, target))}!</p>` : '';
  // Streak psychology: a bare "1-day streak" reads as filler, not a callout —
  // only worth celebrating once it's actually a streak (2+).
  const streakHtml = r.currentStreak >= 2
    ? `<p style="color:var(--gold);font-weight:700;font-size:13px;margin:0 0 10px">🔥 ${r.currentStreak}-day streak</p>` : '';
  const compareBlocks = [];
  if(r.personalBest != null) compareBlocks.push(['Your Best', challengeMetricLabel(format, r.personalBest)]);
  if(r.lastResult != null)   compareBlocks.push(['Last Time', challengeMetricLabel(format, r.lastResult)]);
  const compareHtml = compareBlocks.length ? `<div class="summary-grid" style="margin-bottom:10px">
    ${compareBlocks.map(([label,val])=>`<div class="stat-block"><div class="stat-val">${escapeHtml(val)}</div><div class="stat-label">${label}</div></div>`).join('')}
  </div>` : '';
  // A single lonely chip (first-ever attempt at this format) shows no trend —
  // skip the strip entirely rather than render one uninformative box.
  const recentHtml = (r.recentAttempts && r.recentAttempts.length > 1) ? `
    <div style="display:flex;gap:5px;justify-content:center;flex-wrap:wrap;margin-top:2px">
      ${r.recentAttempts.map((a,i)=>{
        const isToday = i === r.recentAttempts.length - 1;
        const isBest = r.personalBest != null && a.result === r.personalBest;
        return `<div title="${escapeHtml(a.date)}" style="min-width:34px;padding:3px 6px;border-radius:6px;font-size:11px;font-weight:700;text-align:center;
          background:${isToday?'var(--gold)':'rgba(255,255,255,.06)'};color:${isToday?'#111':isBest?'var(--gold)':'var(--muted)'}">${escapeHtml(String(a.result))}</div>`;
      }).join('')}
    </div>` : '';
  el.innerHTML = `${pbBanner}${streakHtml}${compareHtml}${recentHtml}`;
}

// Deterministic hash of a string -> a small non-negative int, used to pick an
// index into a pool. Shared with scoring.js's _pcSeededIndex (loaded first, so
// it's already a global here) — one formula, structurally, instead of the
// "identical hash so both sides agree" invariant being comment-enforced.
const _seededIndex = _pcSeededIndex;
function todaysChallenge(dateStr){
  dateStr = dateStr || localDateStr();
  const format = CHALLENGE_FORMATS[_seededIndex(dateStr+'|format', CHALLENGE_FORMATS.length)];
  const target = CHALLENGE_FORMAT_DEFS[format].pickTarget(dateStr);
  return { date:dateStr, format, target, label: CHALLENGE_FORMAT_DEFS[format].label(target) };
}

let activeChallenge = null;   // { date, format, target, player, gameType } while a challenge attempt is in progress
let lastLegWasChallenge = false; // set true right when a challenge attempt's card fires, so finishUnit() knows to show its Share button
// Captured at the same point lastLegWasChallenge is set (before activeChallenge is
// nulled out) so finishUnit()'s results screen can show the actual challenge outcome
// (docs/daily-challenge-results-roadmap.md) instead of falling through to the
// generic X01 leg-complete panel. { format, target, metric, trebleNumbers } —
// trebleNumbers is Treble Run only (mirrors GAME_TYPES.x01.liveModeState's own
// dartsSoFar computation, kept in sync via the shared challengeTrebleNumbersFrom()
// helper below rather than a second hand-copied Set-building expression).
let lastChallengeResult = null;
function challengeTrebleNumbersFrom(visitLogs){
  return [...new Set((visitLogs||[]).flat().filter(d=>d.isTreble).map(d=>d.sector))];
}

// Home page: a read-only teaser (today's challenge shape only, no player tied to
// it) — the interactive picker lives on the New Game screen instead, where picking
// a PIN-protected player is already gated by withPinCheck(). Purely derived from
// todaysChallenge(), so no backend round-trip and nothing to get stuck loading.
function renderHomeChallengeTeaser(){
  const el = document.getElementById('home-challenge-body');
  const titleEl = document.getElementById('home-challenge-title');
  if(!el) return;
  const challenge = todaysChallenge();
  if(titleEl) titleEl.textContent = challenge.label;
  el.innerHTML = `<p class="pp-meta" style="margin:10px 0 0">Start it from <b>New Game</b>.</p>`;
  renderHomeChallengeBoard(challenge);
}
// Daily Challenge idea 10: the household comparison board — every player's
// completed result for TODAY's format, ranked best-to-worst (no gating on
// having played it yourself, per the design decision — everyone sees the
// board any time). A genuine network round-trip (unlike the label above),
// so it's patched in once the response lands rather than blocking the
// synchronous teaser render.
function renderHomeChallengeBoard(challenge){
  const el = document.getElementById('home-challenge-board');
  if(!el) return;
  el.innerHTML = '';
  Backend.get(`/api/challenges/today-board?date=${challenge.date}&format=${challenge.format}`).then(board=>{
    if(!el.isConnected) return; // navigated away before this resolved
    if(!board || !board.length){
      el.innerHTML = `<p class="pp-meta" style="margin-top:10px">No one's completed today's challenge yet — be the first!</p>`;
      return;
    }
    const rows = board.map((row,i)=>`
      <div class="stat-block" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px">
        <span><b>${i+1}.</b> ${escapeHtml(row.player)}</span>
        <span style="color:var(--gold);font-weight:700">${escapeHtml(challengeMetricLabel(challenge.format, row.result))}</span>
      </div>`).join('');
    el.innerHTML = `
      <p class="pp-meta" style="margin-top:12px;margin-bottom:4px">Today's household board</p>
      <div style="display:flex;flex-direction:column;gap:2px">${rows}</div>`;
  }).catch(()=>{ /* board is a nice-to-have — a failed fetch just leaves the teaser as-is */ });
}


/* ---------- Settings: admin reset of an attempt ---------- */
// Settings -> Daily Challenge: admin reset of a player's attempt for a given date.
// Deletes the attempt AND the game/turns/darts recorded during it (server-side
// cascade), unlocking a clean retake of that day's challenge.
function renderChallengeResetControls(){
  const sel = document.getElementById('challenge-reset-player');
  const dateEl = document.getElementById('challenge-reset-date');
  if(!sel || !dateEl) return;
  sel.innerHTML = roster.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
    || '<option value="">No players yet</option>';
  if(!dateEl.value) dateEl.value = localDateStr(new Date());
}
function askResetChallengeAttempt(){
  const player = (document.getElementById('challenge-reset-player')||{}).value;
  const date   = (document.getElementById('challenge-reset-date')||{}).value;
  if(!player){ uiAlert('Choose a player.'); return; }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')){ uiAlert('Choose a challenge date.'); return; }
  uiConfirm(`Reset ${player}'s Daily Challenge attempt for ${date}? This deletes the attempt AND every stat recorded during it (the game, turns, and darts). ${player} will be able to retake that day's challenge. This can't be undone.`, ()=>{
    Backend.send('DELETE', `/api/challenges/attempt?player=${encodeURIComponent(player)}&date=${encodeURIComponent(date)}`)
      .then(()=>uiAlert(`Reset complete — ${player} can retake the ${date} challenge.`))
      .catch(e=>uiAlertErr('Could not reset', e));
  });
}

/* ---------- New Game step 1: the Daily Challenge card ---------- */
// Reused by renderSetupDailyChallengeSection() below as the Daily Challenge
// card's own Rules text — kept as one named constant rather than an inline
// string so it can't drift from what used to live in renderSetupGameLedger()'s
// now-removed dead 'challenge' branch (that function never actually renders
// a 'challenge' row — the DC card is a separate spotlight, not a ledger row).
const DAILY_CHALLENGE_RULES = "One shared X01 challenge, the same for everyone, once a day. Who's playing and today's completion status are shown on the next step.";
let _dcCompletionsAbort = null;
// Step 1's Daily Challenge section: who's already completed TODAY's challenge,
// across every registered player — purely informational (distinct from Step
// 2's own per-player "you've already attempted today" block below, which
// blocks Continue for the specific person about to play).
function renderSetupDailyChallengeSection(){
  const el = document.getElementById('setup-dc-section');
  if(!el) return;
  const challenge = todaysChallenge();
  const selected = currentSetupOptionKey() === 'challenge';
  // Selected state: a plain filled check-circle, the same symbol every
  // ordinary ledger row already uses — the card's own permanent gold
  // border/glow (there regardless of selection, to keep it eye-catching as
  // today's featured item) made the old, subtler "extra inset shadow"
  // treatment nearly invisible against it.
  // withAnchor:false — the Daily Challenge is always plain X01 under the hood
  // and exposes no per-mode options, so it's the one panel with nothing for
  // mountSetupInlineOptions() to mount.
  const expanded = selected
    ? setupGamePanelHtml({ rulesText: DAILY_CHALLENGE_RULES, withAnchor: false, style: 'margin-top:10px' })
    : '';
  el.innerHTML = `<div class="card challenge-spotlight setup-dc" role="button" tabindex="0" aria-pressed="${selected}"
      onclick="selectSetupGame('challenge')" onkeydown="containerKeyActivate(event, ()=>selectSetupGame('challenge'))">
    <div class="setup-dc-selectcheck${selected?' on':''}" aria-hidden="true">${selected?'✓':''}</div>
    <div class="setup-dc-top">🎯 <span class="setup-dc-title">Daily Challenge</span></div>
    <div class="setup-dc-name">${escapeHtml(challenge.label)}</div>
    <div class="setup-dc-completed" id="setup-dc-completed">Loading who's played today…</div>
    ${expanded}
  </div>`;
  if(_dcCompletionsAbort) _dcCompletionsAbort.aborted = true;
  const tok = { aborted:false }; _dcCompletionsAbort = tok;
  Backend.get(`/api/challenges/today-board?date=${challenge.date}&format=${challenge.format}`).then(rows=>{
    if(tok.aborted) return;
    const body = document.getElementById('setup-dc-completed');
    if(!body) return;
    if(!rows || !rows.length){ body.textContent = "Nobody has played today's challenge yet — be the first."; return; }
    body.innerHTML = rows.map(r=>`<span class="setup-dc-check">✓</span><b>${escapeHtml(r.player)}</b>`).join('&nbsp;&nbsp;&nbsp;') + ' already played today';
  }).catch(()=>{ if(!tok.aborted){ const body=document.getElementById('setup-dc-completed'); if(body) body.textContent=''; } });
}

/* ---------- New Game step 2: today's attempt check for the chosen player ---------- */
let _challengeAvailAbort = null;
// Daily Challenge: the same-day-attempt check for the ONE player chosen in
// Step 2 (moved here from the old Step 2/game-choice screen — Step 1 no
// longer knows who's playing before this fires, now that game-choice comes
// first) — reuses the same /api/challenges/status call startGame() used to
// only make at Play Now time. Already attempted today -> a blocking message
// replaces this section and Continue is disabled; the player can still go
// Back and choose someone else.
function renderSetupChallengeStatus(){
  const section = document.getElementById('setup-challenge-status-section');
  const el = document.getElementById('setup-challenge-status-body');
  const continueBtn = document.getElementById('setup-step2-continue');
  if(!section || !el) return;
  const namedPlayers = setup.slots.filter(Boolean);
  if(currentSetupOptionKey() !== 'challenge' || !namedPlayers.length){
    section.hidden = true;
    if(continueBtn) continueBtn.disabled = false;
    return;
  }
  section.hidden = false;
  const challenge = todaysChallenge();
  const player = namedPlayers[0];
  el.innerHTML = `<div class="setup-label" style="color:var(--gold)">🎯 Today's Challenge</div>
    <p style="margin:0;color:var(--ink);font-size:14px">${escapeHtml(challenge.label)}</p>
    <p class="pp-meta" style="margin-top:8px">Loading…</p>`;
  if(_challengeAvailAbort) _challengeAvailAbort.aborted = true;
  const tok = { aborted:false }; _challengeAvailAbort = tok;
  Backend.get(`/api/challenges/status?player=${encodeURIComponent(player)}&date=${challenge.date}`).then(status=>{
    if(tok.aborted) return;
    if(status && status.today){
      if(continueBtn) continueBtn.disabled = true;
      el.innerHTML = `<div class="setup-label" style="color:var(--gold)">🎯 Today's Challenge</div>
        <p style="margin:0;color:var(--ink);font-size:14px">${escapeHtml(challenge.label)}</p>
        <p style="margin-top:10px;color:var(--ink)">${escapeHtml(player)} has already attempted today's Daily Challenge. Please come back tomorrow, or choose someone else.</p>`;
      return;
    }
    if(continueBtn) continueBtn.disabled = false;
    const streakHtml = status.streak > 0 ? `<span style="color:var(--gold);font-weight:600">🔥 ${status.streak} day streak</span>` : '';
    const historyHtml = status.history.length ? `<div style="display:flex;gap:6px;margin-top:12px">${
      status.history.slice().reverse().map(h=>{
        const day = new Date(h.challenge_date+'T00:00:00Z').toLocaleDateString(undefined,{weekday:'short'})[0];
        const cls = h.completed ? 'background:var(--gold);color:var(--board)' : 'background:var(--surface-2);color:var(--muted)';
        return `<div title="${h.challenge_date}${h.completed?' — '+challengeMetricLabel(h.format, h.result_darts):' — not finished'}" style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;${cls}">${day}</div>`;
      }).join('')
    }</div>` : '';
    el.innerHTML = `
      <div style="margin-bottom:8px">${streakHtml}</div>
      <p style="margin:0;color:var(--ink);font-size:14px">${escapeHtml(challenge.label)}</p>
      <p class="pp-meta" style="margin-top:8px">Press Continue below to play.</p>
      ${historyHtml}`;
  }).catch(()=>{ if(!tok.aborted) el.innerHTML = `<p class="pp-meta">Could not load today's challenge.</p>`; });
}

/* ---------- Player profile: badges and attempt history ---------- */
// Daily Challenge history (docs/archive/daily-challenge-roadmap.md "Player Profile: Daily
// Challenge history"): lifetime completion record, best result per format (reusing
// challengeMetricLabel()/challengeShortLabel() — no new copy to write), and the
// full attempt-by-attempt log.
// Daily Challenge badges (challengeweek/challengemonth/challengeallformats) are
// detected from the same getChallengeHistory() shape the history view below
// already renders — fetched fresh right after a challenge attempt completes
// rather than duplicating streak/format bookkeeping client-side. The pure
// threshold checks themselves live in scoring.js's challengeBadgeSignals() so
// they're covered by a committed node:test (docs/archive/achievements-badges-roadmap.md).
function checkChallengeBadges(playerName){
  const today = localDateStr(new Date());
  Backend.get(`/api/challenges/history?player=${encodeURIComponent(playerName)}&date=${today}`).then(history=>{
    const sig = challengeBadgeSignals(history, CHALLENGE_FORMATS);
    if(sig.week){
      queueBadge('challengeweek', playerName, null);
      awardRecurringBadge(playerName, 'challengeweek', 'challengeweek', { icon:'🔥', headline:'CHALLENGE STREAK: WEEK', player:playerName, statLine:'7 days in a row' });
    }
    if(sig.month){
      queueBadge('challengemonth', playerName, null);
      awardRecurringBadge(playerName, 'challengemonth', 'challengemonth', { icon:'🏆', headline:'CHALLENGE STREAK: MONTH', player:playerName, statLine:'30 days in a row' });
    }
    if(sig.allFormats){
      awardOnceBadge(playerName, 'challengeallformats', 'challengeallformats', game && game.lastTurnSnapshot,
        { icon:'🗓️', headline:'FULL ROTATION', statLine:'Every Daily Challenge format completed' });
    }
  }).catch(logErr);
}
function loadChallengeHistory(){
  const container = document.getElementById('player-challenge-history');
  if(!container) return;
  const today = localDateStr(new Date());
  // Date folded into the cache section key (not just the fetch URL) — without
  // it, a profile re-rendered later in the same session (a tab/game-type
  // switch, or simply re-opening the same player after midnight) would replay
  // yesterday's cached played/completed/currentStreak/bestByFormat forever,
  // since cachedProfileLoad's cache is otherwise only cleared on a player
  // switch, never a date change.
  cachedProfileLoad('challengeHistory:'+today,
    () => Backend.get(`/api/challenges/history?player=${encodeURIComponent(currentPlayer)}&date=${today}`),
    data=>renderChallengeHistory(data),
    ()=>{ container.innerHTML = `<p class="pp-meta" style="padding:4px 0">Could not load Daily Challenge history.</p>`; });
}
function renderChallengeHistory(data){
  const container = document.getElementById('player-challenge-history');
  if(!container) return;
  if(!data || !data.played){
    container.innerHTML = `<p class="pp-meta" style="padding:4px 0">No Daily Challenge attempts yet.</p>`;
    return;
  }
  const rate = data.played ? Math.round((data.completed / data.played) * 100) : 0;
  const summaryHtml = `<div class="summary-grid" style="margin-bottom:14px">
    ${[['Played',data.played],['Completed',`${data.completed} (${rate}%)`],
       ['Current Streak',data.currentStreak],['Longest Streak',data.longestStreak]]
      .map(([label,val])=>`<div class="stat-block"><div class="stat-val">${val}</div><div class="stat-label">${label}</div></div>`).join('')}</div>`;

  const bestHtml = CHALLENGE_FORMATS.map(fmt=>{
    const best = data.bestByFormat[fmt];
    const def = CHALLENGE_FORMAT_DEFS[fmt];
    return `<div class="stat-block"><div class="stat-val">${best!=null ? challengeMetricLabel(fmt, best) : '—'}</div>
      <div class="stat-label">${def.genericName || def.shortLabel()}</div></div>`;
  }).join('');

  const rows = (data.attempts||[]).map(a=>{
    const label = challengeShortLabel(a.format, a.target);
    const result = a.completed ? challengeMetricLabel(a.format, a.result_darts) : 'Not finished';
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--wire);font-size:12.5px">
      <span class="pp-meta">${a.challenge_date}</span><span>${escapeHtml(label)}</span>
      <span style="color:${a.completed?'var(--gold)':'var(--muted)'};font-weight:${a.completed?'700':'400'}">${escapeHtml(result)}</span></div>`;
  }).join('');

  container.innerHTML = `${summaryHtml}
    <h3 class="pp-section-title" style="font-size:13px;margin-bottom:8px">Best result per format</h3>
    <div class="summary-grid" style="margin-bottom:14px">${bestHtml}</div>
    <h3 class="pp-section-title" style="font-size:13px;margin-bottom:4px">Full history</h3>
    <div>${rows || '<p class="pp-meta" style="padding:4px 0">No attempts recorded yet.</p>'}</div>`;
}

/* ---------- The results panel after an attempt ---------- */
// The synchronous half of the Daily Challenge results panel (the async half —
// personal-best/streak/comparison/recent-attempts — is renderChallengeResultExtra()
// above, patched in once /api/challenges/complete resolves). Reads lastChallengeResult
// (captured right before activeChallenge was nulled, in the same block that sets
// lastLegWasChallenge) so finishUnit() can show the actual challenge outcome instead
// of falling through to the generic X01 leg-complete panel.
function buildChallengeResultPanel(){
  if(!lastChallengeResult) return '';
  const { format, target, metric, trebleNumbers } = lastChallengeResult;
  const headline = `<div class="summary-grid" style="margin-bottom:10px">
    <div class="stat-block"><div class="stat-val">${escapeHtml(challengeMetricLabel(format, metric))}</div><div class="stat-label">${escapeHtml(challengeShortLabel(format, target))}</div></div>
  </div>`;
  // A format's own extraResultData (currently only Treble Run's: WHICH numbers
  // were hit, not just the count) — mirrors display.html's live .challenge-chips
  // treatment of the same data. trebleNumbers is null for every other format.
  const chips = (trebleNumbers && trebleNumbers.length)
    ? `<div style="display:flex;gap:5px;justify-content:center;flex-wrap:wrap;margin-bottom:10px">
        ${trebleNumbers.map(n=>`<span style="font-size:12px;font-weight:700;color:var(--gold);border:1px solid var(--wire);border-radius:6px;padding:3px 7px">T${n}</span>`).join('')}
      </div>` : '';
  return `${headline}${chips}`;
}
