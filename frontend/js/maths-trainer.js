'use strict';
/* ---------- Maths Trainer (docs/minigames-roadmap.md Part A, REFERENCE.md §19b) ----------
   A recall drill for the values a scoring player needs off the top of their head.
   Two skills in order: know what treble 19 IS, then total three darts at a glance.

   What makes this mode structurally different from every other one here: it has
   no darts. Nothing is thrown, so there is no visit, no `game.darts`, no pad and
   no dartboard — and it writes to maths_trainer_rounds rather than turns/darts,
   which is what gives it zero footprint on every other statistic by construction.
   The whole play surface is one container (#maths-quiz) that replaces the standard
   rail/oche, the same way showGameResult() takes those two regions over.

   The pure question/distractor/threshold logic lives in scoring.js and is covered
   by backend/test/scoring.maths-trainer.test.js — this file is the loop and the
   screen only. */

// Home page: the Sprint leaderboard.
function renderHomeTabBodyMathsTrainer(){
  renderSimpleHomeLeaderboardTab('mathsTrainer', 'leaderboard', '🧠 Maths Sprint — Best Score', {
    score:r=>r.bestScore, meta:r=>fmtDate(r.achievedAt),
    emptyMsg:'None recorded yet — play a Maths Sprint to claim the top spot.',
  });
}

/* ---------- New Game options ---------- */
function setMathsQuestionType(t){
  setup.mathsQuestionType = (t === 'counting') ? 'counting' : 'segment';
  // A board prompt only means something for a visit of several darts, so leaving
  // it selected while switching back to single-segment recall would produce a
  // config the server rightly rejects. Reset rather than let it linger.
  if(setup.mathsQuestionType !== 'counting') setup.mathsPromptStyle = 'text';
  setPressed({ segment:'maths-qt-segment', counting:'maths-qt-counting' }, setup.mathsQuestionType);
  renderMathsOptionSections();
}
function setMathsPromptStyle(s){
  setup.mathsPromptStyle = (s === 'board') ? 'board' : 'text';
  setPressed({ text:'maths-ps-text', board:'maths-ps-board' }, setup.mathsPromptStyle);
  renderMathsOptionSections();
}
function setMathsDifficulty(d){
  setup.mathsDifficulty = (d === 'hard') ? 'hard' : 'easy';
  setPressed({ easy:'maths-diff-easy', hard:'maths-diff-hard' }, setup.mathsDifficulty);
  renderMathsOptionSections();
}
function setMathsMode(m){
  setup.mathsMode = (m === 'sprint') ? 'sprint' : 'freeform';
  setPressed({ freeform:'maths-mode-freeform', sprint:'maths-mode-sprint' }, setup.mathsMode);
  renderMathsOptionSections();
}
// The blurb under the toggles, and the prompt-style row's visibility. Written as
// one function rather than four so the copy for a given combination lives in one
// place — the four setters above all just re-run it.
function renderMathsOptionSections(){
  const psRow = document.getElementById('maths-prompt-style-row');
  if(psRow) psRow.hidden = (setup.mathsQuestionType !== 'counting');
  const blurb = document.getElementById('maths-options-blurb');
  if(!blurb) return;
  const counting = setup.mathsQuestionType === 'counting';
  const hard = setup.mathsDifficulty === 'hard';
  const parts = [];
  if(counting){
    parts.push(hard ? 'Three darts to total.' : 'Two darts to total.');
    parts.push(setup.mathsPromptStyle === 'board'
      ? 'Read them off the board — that’s the skill.'
      : 'Named in words, so you only have to add.');
  } else {
    parts.push(hard
      ? `All ${mathsSegmentPool('hard').length} segments, including the bull and the awkward low doubles.`
      : `The ${mathsSegmentPool('easy').length} doubles and trebles of 10–20 — the ones worth knowing cold.`);
  }
  parts.push(setup.mathsMode === 'sprint'
    ? 'Sprint: 60 seconds, one point per correct answer.'
    : `Answer inside ${(mathsInstantMs(counting ? 'counting' : 'segment')/1000).toFixed(1)}s and it counts as known.`);
  blurb.textContent = parts.join(' ');
}

/* ---------- session state ----------
   Everything lives on `game` (per the app's convention) rather than in module
   scope, so leaving the screen cannot leave a half-session behind. */
function newMatchPlayerMathsTrainer(name, config){
  const p = { name,
    rounds:0, correctCount:0, instantCount:0, currentStreak:0,
    lifetimeRoundsBase:0, lifetimeInstantBase:0, lifetimeKnownBase:0,
    sessionRounds:[] };
  // Fetched once at game start rather than per answer — the same "avoid a network
  // round-trip per dart" reasoning newMatchPlayerChuckin() and Checkout Trainer's
  // own ladders already document.
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=maths_trainer`).then(stats=>{
    if(!stats) return;
    p.lifetimeRoundsBase = (stats.rounds || 0) - p.rounds;
    p.lifetimeInstantBase = (stats.instantCount || 0) - p.instantCount;
    p.lifetimeKnownBase = stats.segmentsKnown || 0;
  }).catch(logErr);
  return p;
}
function resetPlayerForNextLegMathsTrainer(p){ p.currentStreak = 0; }
function playerSnapshotMathsTrainer(p){
  return { name:p.name, rounds:p.rounds||0, correctCount:p.correctCount||0,
    instantCount:p.instantCount||0, currentStreak:p.currentStreak||0 };
}

// Serve the next question. `game.q` is the live question, `game.qShownAt` the
// clock it is timed against, and `game.lastResult` the previous round's verdict
// (which is what the reveal renders).
function nextMathsQuestion(){
  if(!game || game.gameType !== 'maths_trainer') return;
  game.q = pickMathsQuestion(Math.random, {
    questionType: game.config.questionType,
    difficulty: game.config.difficulty,
  });
  game.qOptions = mathsOptions(game.q, Math.random);
  game.lastResult = null;
  game.qShownAt = Date.now();
  renderGameMathsTrainer();
}

// One tap. Grades locally for instant feedback, then records the round — the
// server re-derives correctness from the prompt, so the local grade is a display
// convenience and never the authority.
function answerMaths(value){
  if(!game || game.gameType !== 'maths_trainer') return;
  if(game.lastResult || !game.q) return;            // already answered; wait for Next
  if(game.sprintEnded) return;
  // Sprint's hard stop, check one of three (see tickMathsSprint()/endMathsSprint()).
  if(game.sprintDeadline != null && Date.now() >= game.sprintDeadline){ endMathsSprint(); return; }

  const ms = Math.max(0, Date.now() - game.qShownAt);
  const res = gradeMathsAnswer(game.q, value, ms);
  const p = game.players[0];
  p.rounds++;
  if(res.correct) p.correctCount++;
  if(res.instant){ p.instantCount++; p.currentStreak++; } else { p.currentStreak = 0; }
  p.sessionRounds.push({ prompt: game.q.prompt, verdict: res.verdict, ms });
  game.lastResult = Object.assign({}, res, { chosen: value, ms, prompt: game.q.prompt,
    segments: game.q.segments });
  game.mathsRoundNo = (game.mathsRoundNo || 0) + 1;

  // DB.gameId, not game.id — the created game's id lives on the DB object
  // (beginGame() sets `this.gameId`), and `game` carries no id at all.
  DB.recordMathsRound(DB.gameId, {
    player: p.name, roundNo: game.mathsRoundNo,
    questionType: game.q.questionType, promptStyle: game.config.promptStyle || 'text',
    prompt: game.q.prompt, options: game.qOptions,
    chosenAnswer: value, answeredMs: ms,
  });

  checkMathsMilestones(p);
  renderGameMathsTrainer();
  // Sprint keeps moving: a reveal you have to dismiss would spend the clock.
  if(game.config.mode === 'sprint' && !game.sprintEnded){
    game.sprintAdvance = setTimeout(()=>{ if(game && !game.sprintEnded) nextMathsQuestion(); }, 900);
  }
}

/* ---------- Sprint ----------
   The deadline is a WALL CLOCK, checked on each tick rather than a decrementing
   counter, so a backgrounded or throttled tab cannot buy time. It is a hard stop
   enforced at three independent points, whichever notices first ending the run —
   Checkout Blitz shipped without the last two and a paused player could resume
   and answer arbitrarily long after the buzzer, still scored and still eligible
   for its under-the-buzzer badge. Do not re-earn that. */
function startMathsSprint(){
  game.sprintDeadline = Date.now() + MATHS_SPRINT_SECONDS*1000;
  game.sprintEnded = false;
  game.sprintTimer = setInterval(tickMathsSprint, 250);
}
function tickMathsSprint(){
  if(!game || game.gameType !== 'maths_trainer' || game.sprintEnded) return;
  if(game.sprintDeadline != null && Date.now() >= game.sprintDeadline){ endMathsSprint(); return; }
  const el = document.getElementById('maths-clock');
  if(el) el.textContent = mathsClockText();
  const bar = document.getElementById('maths-timebar-fill');
  if(bar) bar.style.width = `${Math.max(0, Math.min(100, mathsSprintRemainingPct()))}%`;
}
function mathsSprintRemainingPct(){
  if(game.sprintDeadline == null) return 0;
  return (game.sprintDeadline - Date.now()) / (MATHS_SPRINT_SECONDS*10);
}
function mathsClockText(){
  const left = Math.max(0, Math.ceil((game.sprintDeadline - Date.now())/1000));
  return `${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;
}
// Idempotent: three callers can all reach it, and the first one wins.
function endMathsSprint(){
  if(!game || game.sprintEnded) return;
  game.sprintEnded = true;
  if(game.sprintTimer){ clearInterval(game.sprintTimer); game.sprintTimer = null; }
  if(game.sprintAdvance){ clearTimeout(game.sprintAdvance); game.sprintAdvance = null; }
  const p = game.players[0];
  // 💎 Flawless Minute — every answer in a 10+-round run correct.
  if(p.rounds >= MATHS_FLAWLESS_MIN_ROUNDS && p.correctCount === p.rounds){
    awardOnceBadge(p.name, 'maths_flawless_minute', 'maths_flawless_minute', null,
      { icon:'⚡', headline:'FLAWLESS MINUTE', statLine:`${p.rounds} for ${p.rounds} against the clock` }, {cacheCheck:true});
  }
  const sprintLadder = MATHS_SPRINT_MILESTONE_LADDERS.find(l=>l.metric==='sprint');
  if(sprintLadder) checkChuckinMilestoneTier(sprintLadder, p.name, p.correctCount);
  showMathsSessionSummary();
}

/* ---------- achievements ----------
   Data-driven off the ladder tables in index.html, reusing
   checkChuckinMilestoneTier() wholesale — the helper is fully generic despite its
   name, and Chuckin, Checkout Trainer and Route Recall all already reuse it.
   Computed from local state (a lifetime base fetched once, plus this session's
   counters) rather than a query per answer. */
function checkMathsMilestones(p){
  const byMetric = m => MATHS_MILESTONE_LADDERS.find(l=>l.metric===m);
  checkChuckinMilestoneTier(byMetric('rounds'), p.name, (p.lifetimeRoundsBase||0) + p.rounds);
  checkChuckinMilestoneTier(byMetric('instant'), p.name, (p.lifetimeInstantBase||0) + p.instantCount);
  checkChuckinMilestoneTier(byMetric('streak'), p.name, p.currentStreak);
  // 👁️ At a Glance — instant 3-dart totals read off the BOARD. Deliberately
  // board-only: the text prompt does the reading for you, so it cannot
  // demonstrate the skill this badge is about.
  const r = game.lastResult;
  if(r && r.instant && game.config.questionType === 'counting'
     && game.config.promptStyle === 'board' && r.segments && r.segments.length >= 3){
    p.boardGlances = (p.boardGlances||0) + 1;
    if(p.boardGlances >= MATHS_AT_A_GLANCE_MIN){
      awardOnceBadge(p.name, 'maths_at_a_glance', 'maths_at_a_glance', null,
        { icon:'👁️', headline:'AT A GLANCE', statLine:`${MATHS_AT_A_GLANCE_MIN} three-dart totals read straight off the board` }, {cacheCheck:true});
    }
  }
  // 🔢 Ton Counter — correct 3-dart totals of 100+.
  if(r && r.correct && r.segments && r.segments.length >= 3 && r.answer >= 100){
    p.tonCounts = (p.tonCounts||0) + 1;
    if(p.tonCounts >= MATHS_TON_COUNTER_MIN){
      awardOnceBadge(p.name, 'maths_ton_counter', 'maths_ton_counter', null,
        { icon:'🔢', headline:'TON COUNTER', statLine:`${MATHS_TON_COUNTER_MIN} tons totalled correctly` }, {cacheCheck:true});
    }
  }
}

/* ---------- the play screen ----------
   Rendered into #maths-quiz, with the standard rail/oche hidden. Mirrors the
   approved mockups (docs/minigames-roadmap.md): eyebrow, the question in Kalam,
   the value as a Bebas hero, the timing rule, four printed options, then the
   verdict. */
function renderGameMathsTrainer(){
  const host = document.getElementById('maths-quiz');
  if(!host) return;
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML = '';
  const railPlay = document.getElementById('rail-play');
  const oche = document.querySelector('.oche');
  if(railPlay) railPlay.hidden = true;
  if(oche) oche.hidden = true;
  host.hidden = false;

  const p = game.players[0];
  const q = game.q, r = game.lastResult;
  const isSprint = game.config.mode === 'sprint';
  const counting = game.config.questionType === 'counting';
  const board = counting && game.config.promptStyle === 'board';
  const threshold = mathsInstantMs(counting ? 'counting' : 'segment');
  if(!q){ host.innerHTML = ''; return; }

  const known = (p.lifetimeKnownBase || 0);
  const poolSize = mathsSegmentPool('hard').length;

  host.innerHTML = `
    <div class="mq-eyebrow">
      <span class="mq-mode">${isSprint ? 'Maths sprint' : 'Maths trainer'}</span>
      <span class="mq-rnd">Round ${game.mathsRoundNo ? game.mathsRoundNo + (r?0:1) : 1}</span>
    </div>
    ${isSprint ? mathsSprintHeaderHtml(p) : ''}
    <div class="mq-ask">${escapeHtml(mathsAskText(q, board))}</div>
    ${board ? mathsBoardHtml(q) : `<div class="mq-hero">${mathsHeroHtml(q)}</div>`}
    ${!isSprint ? `<div class="mq-sub">${escapeHtml(r ? '' : (counting ? 'Total the darts — don’t count them one at a time.' : 'Answer without working it out.'))}</div>` : ''}
    ${mathsRuleHtml(threshold, r)}
    <div class="mq-opts" role="group" aria-label="Choose the answer">
      ${game.qOptions.map((v,i)=>mathsOptionHtml(v, i, q, r)).join('')}
    </div>
    ${r ? mathsVerdictHtml(r, threshold) : ''}
    ${r && !isSprint ? `
      <div class="mq-acts">
        <button class="btn btn-primary" id="maths-next" onclick="nextMathsQuestion()">Next question</button>
        <button class="btn btn-ghost" onclick="askEndGame()">End session</button>
      </div>` : ''}
    <div class="mq-foot">
      <span>Known cold <b>${known}</b> of ${poolSize}</span>
      <span>Streak <b>${p.currentStreak}</b></span>
    </div>`;

  // The verdict is the one thing a screen-reader user would otherwise miss
  // entirely — the options do not change text, only styling.
  if(r) announce(mathsVerdictWords(r));
  if(r && !isSprint){
    const next = document.getElementById('maths-next');
    if(next && typeof next.focus === 'function') next.focus();
  }
}
function mathsAskText(q, board){
  if(q.segments.length > 1) return board ? 'What did this visit score?' : `${q.segments.map(mathsSegmentWords).join(', ')} — what’s that?`;
  return `What’s ${mathsSegmentWords(q.segments[0])}?`;
}
// 'T19' as a hero: the ring letter takes the accent so it reads as "ring plus
// number" at a glance rather than as one token.
function mathsHeroHtml(q){
  const s = q.segments[0];
  const m = /^([TD])(\d{1,2})$/.exec(s);
  if(m) return `<span class="mq-ring">${m[1]}</span>${m[2]}`;
  return escapeHtml(s);
}
function mathsSprintHeaderHtml(p){
  return `
    <div class="mq-clock">
      <span class="mq-clock-n" id="maths-clock">${escapeHtml(mathsClockText())}</span>
      <span class="mq-clock-u">left</span>
      <span class="mq-score"><b>${p.correctCount}</b><span>score</span></span>
    </div>
    <div class="mq-timebar"><i id="maths-timebar-fill" style="width:${Math.max(0,Math.min(100,mathsSprintRemainingPct()))}%"></i></div>
    <div class="mq-pips">${p.sessionRounds.map(x=>{
      const mark = x.verdict === 'known' ? '✓' : x.verdict === 'worked' ? '◐' : '●';
      return `<i class="${x.verdict}">${mark}</i>`;
    }).join('')}</div>`;
}
/* The timing rule — this mode's signature, and the only instrument in the app
   that expresses time as quality. A printed ruler: half-second ticks, a marked
   threshold, and once answered, a tick dropped where the answer landed. */
function mathsRuleHtml(threshold, r){
  const span = threshold * 2;                        // the scale runs to 2x the threshold
  const pct = v => Math.max(0, Math.min(100, v / span * 100));
  // Eight divisions, whichever threshold is in force. A fixed 500ms interval looked
  // right on the 3s segment scale and turned the 7s counting scale into hatching.
  const step = span / 8;
  const ticks = [];
  for(let i = 1; i < 8; i++){
    ticks.push(`<i class="mq-tick${i === 4 ? ' major' : ''}" style="left:${pct(i*step)}%"></i>`);
  }
  const landed = r && r.ms != null ? pct(r.ms) : null;
  const fill = landed != null ? landed : 0;
  return `
    <div class="mq-rule">
      <div class="mq-scale">
        <div class="mq-base"></div>
        <i class="mq-tick major" style="left:0"></i>
        ${ticks.join('')}
        <div class="mq-band" style="width:${pct(threshold)}%"></div>
        <div class="mq-fill" style="width:${fill}%"></div>
        ${landed != null ? `<div class="mq-landed" style="left:${landed}%"></div>` : ''}
      </div>
      <div class="mq-legend">
        <span class="in">◀ Knew it</span>
        <span>${r && r.ms != null
          ? `<span class="raw">${(r.ms/1000).toFixed(1)}s</span> — ${r.instant ? 'knew it' : 'worked it out'} ▶`
          : 'Worked it out ▶'}</span>
      </div>
    </div>`;
}
function mathsOptionHtml(v, i, q, r){
  let cls = 'mq-opt';
  let mark = '';
  if(r){
    if(v === q.answer){ cls += ' truth'; mark = '✓'; }
    else if(v === r.chosen){ cls += ' wrong'; mark = '✗'; }
    if(v === r.chosen) cls += ' chosen';
  }
  // The small numeral IS the keyboard shortcut, not decoration: this mode is
  // played fast, and a keyboard/remote user needs to see what to press.
  return `<button type="button" class="${cls}" ${r ? 'disabled' : ''}
    onclick="answerMaths(${v})" aria-label="${v}${mark ? (v===q.answer?', correct':', your answer, wrong') : ''}">
    <span class="mq-k">${i+1}</span>${v}${mark ? `<span class="mq-mk">${mark}</span>` : ''}</button>`;
}
function mathsVerdictWords(r){
  if(r.verdict === 'known') return 'Correct, and fast.';
  if(r.verdict === 'worked') return 'Right, but you worked that one out.';
  if(r.verdict === 'timeout') return `Time. The answer was ${r.answer}.`;
  return `Wrong. The answer was ${r.answer}.`;
}
function mathsVerdictHtml(r, threshold){
  const cls = r.verdict === 'known' ? 'good' : r.verdict === 'worked' ? 'slow' : 'bad';
  const line = r.verdict === 'known' ? 'Knew it.'
    : r.verdict === 'worked' ? 'Right — but you worked that one out.'
    : r.verdict === 'timeout' ? 'Time’s up on that one.'
    : 'Not that one.';
  const coach = r.verdict === 'worked'
    ? `Aim for under ${(threshold/1000).toFixed(1)}s. ${escapeHtml(r.prompt)} doesn’t count as learned until you stop counting.`
    : r.verdict === 'known' ? '' : `The answer was ${r.answer}.`;
  return `
    <div class="mq-verdict ${cls}">${line}</div>
    <div class="mq-working"><b>${escapeHtml(r.working)}</b>${coach ? `<br>${escapeHtml(coach)}` : ''}</div>`;
}

/* The board prompt — a PRINTED diagram, not the app's real dartboard. Rendering
   the live board on the cream sheet produces a dark slab in the middle of the
   paper, the identical mistake Paper Mode's own CSS warns about for `.oche`. So:
   ink hairlines, the two scoring rings washed in tone, and each dart a solid dot
   with a paper halo so it never merges into a wedge line. Position rather than
   colour separates a treble from a double, which is also what keeps it readable
   in colorblind mode. Geometry is BOARD_GEOM's own, so this cannot drift from
   the real board. */
function mathsBoardHtml(q){
  const { CX, CY, R, DEG, xy, f, annulus } = BOARD_GEOM;
  const RULE = '#b9ad8d', WASH = 'rgba(20,22,15,.22)', WASH2 = 'rgba(20,22,15,.11)';
  const numAt = R.doubleOut + 24;
  let s = `<svg viewBox="${CX-258} ${CY-258} 516 516" role="img" aria-label="A dartboard diagram with ${q.segments.length} darts in it: ${q.segments.map(mathsSegmentWords).join(', ')}.">`;
  s += `<circle cx="${CX}" cy="${CY}" r="${R.doubleOut}" fill="none" stroke="#a2957a" stroke-width="2"/>`;
  DB_SECTORS.forEach((num,i)=>{
    const s0 = i*DEG - DEG/2, e0 = s0 + DEG;
    const wash = i%2 ? WASH2 : WASH;
    s += `<path d="${annulus(R.trebleIn,R.trebleOut,s0,e0)}" fill="${wash}" stroke="${RULE}" stroke-width=".6"/>`;
    s += `<path d="${annulus(R.doubleIn,R.doubleOut,s0,e0)}" fill="${wash}" stroke="${RULE}" stroke-width=".6"/>`;
    const [ax,ay] = xy(R.bullOut,s0), [bx,by] = xy(R.doubleOut,s0);
    s += `<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(bx)}" y2="${f(by)}" stroke="${RULE}" stroke-width=".7"/>`;
    const [nx,ny] = xy(numAt, s0 + DEG/2);
    s += `<text x="${f(nx)}" y="${f(ny)}" text-anchor="middle" dominant-baseline="central"
      font-family="Bebas Neue,sans-serif" font-size="31" fill="#5d543c">${num}</text>`;
  });
  [R.trebleIn,R.trebleOut,R.doubleIn,R.bullOut].forEach(rr=>{
    s += `<circle cx="${CX}" cy="${CY}" r="${rr}" fill="none" stroke="${RULE}" stroke-width=".9"/>`;
  });
  s += `<circle cx="${CX}" cy="${CY}" r="${R.bullIn}" fill="${WASH}" stroke="${RULE}" stroke-width=".9"/>`;
  q.segments.forEach(seg=>{
    const m = /^([TD]?)(\d{1,2})$/.exec(seg);
    let x, y;
    if(seg === 'Bull'){ [x,y] = [CX,CY]; }
    else if(seg === '25'){ [x,y] = xy((R.bullIn+R.bullOut)/2, 0); }
    else {
      const ring = m[1];
      const rr = ring === 'T' ? (R.trebleIn+R.trebleOut)/2
               : ring === 'D' ? (R.doubleIn+R.doubleOut)/2
               : (R.trebleOut+R.doubleIn)/2;
      [x,y] = xy(rr, DB_SECTORS.indexOf(Number(m[2])) * DEG);
    }
    s += `<circle cx="${f(x)}" cy="${f(y)}" r="13" fill="#efe7d2"/>`;
    s += `<circle cx="${f(x)}" cy="${f(y)}" r="9.5" fill="#14160f"/>`;
  });
  s += `</svg>`;
  return `<div class="mq-board">${s}</div>`;
}

/* ---------- the session summary (the crib sheet) ----------
   Not a Trophy Cabinet panel: this mode's report is the crib sheet, because for
   someone learning these values "which ones do I still not know" IS the product.
   Shown through showGameResult(), the same host every other completion screen
   uses. */
function showMathsSessionSummary(){
  const host = showGameResult({ wholeSession: true });
  if(!host) return;
  const quiz = document.getElementById('maths-quiz');
  if(quiz) quiz.hidden = true;
  const p = game.players[0];
  const answered = p.sessionRounds.filter(r=>r.verdict !== 'timeout').length;
  host.innerHTML = `
    <div class="mq-summary">
      <div class="mq-eyebrow"><span class="mq-mode">${game.config.mode === 'sprint' ? 'Maths sprint' : 'Maths trainer'}</span><span class="mq-rnd">Session</span></div>
      <div class="mq-crib-head">
        <div class="mq-crib-n" id="maths-crib-count">—</div>
        <div class="mq-crib-lab">Segments<br>known cold</div>
      </div>
      <div class="mq-sub" id="maths-crib-sub">Loading your crib sheet…</div>
      <div class="mq-session">
        <span>${p.rounds} round${p.rounds===1?'':'s'}</span>
        <span>${p.instantCount} knew</span>
        <span>${Math.max(0, p.correctCount - p.instantCount)} worked out</span>
        <span>${Math.max(0, answered - p.correctCount)} wrong</span>
      </div>
      <div class="mq-grid" id="maths-crib-grid"></div>
      <div class="mq-legend-key">
        <span><b class="g">✓</b> known cold</span>
        <span><b class="f">◐</b> still counting</span>
        <span><b class="r">●</b> not yet</span>
      </div>
      <div class="mq-acts">
        <button class="btn btn-primary" onclick="playAgain()">Another session</button>
        <button class="btn btn-ghost" onclick="show('home')">\u{1F3E0} Return Home</button>
      </div>
    </div>`;
  renderMathsCribSheet(p.name, game.config.difficulty || 'easy');
}
// The crib sheet itself: every pool segment with its VALUE, its state and its
// median time. The value is what makes this a crib sheet rather than a bar chart
// — it is the printed card a learner carries, listing the answers.
function renderMathsCribSheet(name, difficulty){
  Backend.get(`/api/stats/maths-segments?name=${encodeURIComponent(name)}&difficulty=${encodeURIComponent(difficulty)}`)
    .then(sheet=>{
      const grid = document.getElementById('maths-crib-grid');
      const count = document.getElementById('maths-crib-count');
      const sub = document.getElementById('maths-crib-sub');
      if(!sheet || !grid) return;
      if(count) count.innerHTML = `${sheet.knownCount}<small>/${sheet.poolSize}</small>`;
      const togo = sheet.poolSize - sheet.knownCount;
      if(sub) sub.textContent = togo === 0
        ? 'Every segment in this pool, known cold. Try Hard.'
        : `${togo} to go. The slowest are listed first.`;
      // Worst first — the whole point is naming what to work on next.
      const order = { cold:0, slow:1, known:2 };
      const rows = sheet.segments.slice().sort((a,b)=>
        (order[a.state]-order[b.state]) || ((b.medianMs||0)-(a.medianMs||0)));
      grid.innerHTML = rows.map(s=>{
        const mark = s.state === 'known' ? '✓' : s.state === 'slow' ? '◐' : '●';
        // The bar is "how close to instant", so it needs a scale: full at the
        // threshold, empty at twice it.
        const pct = s.medianMs == null ? 0
          : Math.max(6, Math.min(100, Math.round((1 - (s.medianMs - sheet.thresholdMs) / sheet.thresholdMs) * 100)));
        return `<div class="mq-row ${s.state}">
          <span class="mq-seg">${escapeHtml(s.segment)}</span>
          <span class="mq-val">${s.value}</span>
          <div class="mq-bar"><i style="width:${s.attempts ? pct : 0}%"></i></div>
          <span class="mq-t">${s.medianMs == null ? '—' : (s.medianMs/1000).toFixed(1)+'s'}</span>
          <span class="mq-st">${mark}</span>
        </div>`;
      }).join('');
    }).catch(logErr);
}
