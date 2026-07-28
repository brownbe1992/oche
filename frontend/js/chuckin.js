'use strict';
/* Just Chuckin’ It (docs/game-modes-roadmap.md) — no rules, every dart recorded, milestone badges.
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
// Checks one ladder against a current value, awarding (once:true) any tier not
// already cached as earned. Shared by the session ladder and the darts/trebles
// (lifetime) ladders — see checkChuckinMilestones() below. The actual >=
// threshold comparison is scoring.js's chuckinTiersReached() (loaded via
// <script src="scoring.js">), not reimplemented here, so it's covered by a
// committed test (backend/test/scoring.test.js) rather than only a Playwright check.
function checkChuckinMilestoneTier(ladder, playerName, value){
  const reached = chuckinTiersReached(ladder.tiers, value);
  ladder.tiers.forEach(tier=>{
    const id = ladder.idPrefix + tier.threshold;
    if(!reached.includes(tier.threshold)) return;
    awardOnceBadge(playerName, id, id, null,
      { icon:tier.icon, headline:tier.label.toUpperCase(), statLine:`${value.toLocaleString()} ${ladder.statNoun}` },
      { cacheCheck:true });
  });
}

// Called after every dart from throwDartChuckin(). Every ladder is checked
// entirely from local state — the session ladder from p.sessionDarts directly,
// and the darts/trebles (lifetime) ladders from p.lifetimeDartsBase/
// lifetimeTreblesBase (fetched once at game start by newMatchPlayerChuckin())
// plus this session's running counters. This mode commits one turn per dart, so
// a network round-trip on every single throw (as earlier revisions of this
// function did, re-querying stat-bubbles per dart) could burn through the
// server's per-IP rate limit during a long rapid-fire practice session — worse,
// a 429 on the recordTurn write itself is swallowed silently by DB._queue's
// catch, so needless extra traffic here was directly competing with the writes
// that actually need to land. The only network calls left are the badge-award
// POST itself, and only when a threshold is actually newly crossed. No undo
// support: unlike X01/Cricket/Doubles Practice's badges, these are deliberately
// never revoked if the dart that crossed a threshold is later undone — a
// low-stakes practice mode milestone staying earned on an undone dart is a
// harmless edge case, not worth the added badgeReverts/snap.voided plumbing
// those other modes need for genuine competitive-play corrections.
function checkChuckinMilestones(p){
  const sessionLadder = CHUCKIN_MILESTONE_LADDERS.find(l=>l.metric==='session');
  checkChuckinMilestoneTier(sessionLadder, p.name, p.sessionDarts);

  const dartsLadder = CHUCKIN_MILESTONE_LADDERS.find(l=>l.metric==='darts');
  const treblesLadder = CHUCKIN_MILESTONE_LADDERS.find(l=>l.metric==='trebles');
  checkChuckinMilestoneTier(dartsLadder, p.name, (p.lifetimeDartsBase||0) + p.sessionDarts);
  checkChuckinMilestoneTier(treblesLadder, p.name, (p.lifetimeTreblesBase||0) + p.sessionTrebles);
}

function newMatchPlayerChuckin(name){
  const p = { name, sessionDarts:0, sessionTrebles:0, lifetimeDartsBase:0, lifetimeTreblesBase:0,
    // sessionScore feeds the 3-dart average; heatmap is a live, session-only
    // {sector_mult: hits} tally for the Live Scoreboard's dartboard (a separate,
    // shorter-lived concept from the lifetime one Player Profile fetches via
    // getChuckinHeatmap()); dartBuffer groups darts into non-overlapping runs of
    // 3 (mirroring the backend's CHUCKIN_GROUPS_OF_3) purely to detect a 180 —
    // see throwDartChuckin() below.
    // heatmapVersion (item 57): bumped on every heatmap mutation so
    // playerSnapshotChuckin() — called on every per-dart live push — can cache
    // its serialized array instead of re-walking+re-parsing the whole session
    // heatmap's keys each time.
    sessionScore:0, heatmap:{}, heatmapVersion:0, dartBuffer:[] };
  // Fetched once at game start (not re-queried per dart) so checkChuckinMilestones()
  // can compute lifetime darts/trebles as base+session entirely from local state —
  // this mode is built around rapid successive throws, and hitting the network on
  // every single dart (this mode commits one turn per dart) would needlessly burn
  // through the server's per-IP rate limit during a long practice session. If this
  // hasn't resolved by the time a dart is thrown, the milestone check just uses 0 as
  // the base and catches up once it lands — worst case a lifetime tier is checked a
  // dart or two late, never a false positive.
  Backend.get(`/api/players/stat-bubbles?name=${encodeURIComponent(name)}&gameType=chuckin`).then(stats=>{
    if(!stats) return;
    p.lifetimeDartsBase = (stats.dartsThrown || 0) - p.sessionDarts;
    p.lifetimeTreblesBase = (stats.trebles || 0) - p.sessionTrebles;
  }).catch(logErr);
  return p;
}

// Not called by startNextLeg() (this mode never advances a leg) — provided only
// to satisfy the GAME_TYPES contract, matching Doubles Practice's own precedent.
function resetPlayerForNextLegChuckin(p){
  p.sessionDarts = 0; p.sessionTrebles = 0; p.sessionScore = 0; p.heatmap = {}; p.heatmapVersion++; p.dartBuffer = [];
}

// heatmap is sent as a flat {sector,multiplier,hits} array (same shape
// getChuckinHeatmap() returns) so the Live Scoreboard can feed it straight into
// the same buildChuckinHeatmap()-style renderer, just session-scoped instead of
// lifetime-scoped. sessionAvg is the standard 3-dart average computed live
// (see getChuckinStatBubbles()'s `avg` field for the backend/lifetime version
// of the identical formula).
function playerSnapshotChuckin(p){
  // Cached on p._heatmapCache, invalidated only when p.heatmapVersion has moved
  // since the last build (item 57) — this snapshot fires on every per-dart live
  // push, and re-parsing every key of the whole session's heatmap each time was
  // pure waste once nothing about it had changed since the last push.
  if(p._heatmapCacheVersion !== p.heatmapVersion){
    p._heatmapCache = Object.entries(p.heatmap||{}).map(([key,hits])=>{
      // docs/bug-roadmap.md BUG-20: keys are sector_mult_zone_missZone_missDepth — zone/
      // missDepth are strings ('' when absent), missZone a number. Parse zone/missDepth as
      // strings, missZone as a number, so both the single-region (zone) and miss-ring
      // (missZone/missDepth) breakdowns survive into the live-scoreboard cell shape.
      const parts = key.split('_');
      return { sector:Number(parts[0]), multiplier:Number(parts[1]), zone: parts[2] || null,
        missZone: parts[3] ? Number(parts[3]) : null, missDepth: parts[4] || null, hits };
    });
    p._heatmapCacheVersion = p.heatmapVersion;
  }
  const sessionAvg = p.sessionDarts>0 ? (p.sessionScore/p.sessionDarts*3) : null;
  return { name:p.name, sessionDarts:p.sessionDarts||0, sessionTrebles:p.sessionTrebles||0, heatmap:p._heatmapCache, sessionAvg };
}

function throwDartChuckin(sector, zone, missZone, missDepth, bounced){
  const dart = makeDart(sector, bounced ? 1 : mult);
  mult = 1; updateMultUI();
  const p = game.players[0];

  // snapshot state before mutation so undoLastTurnChuckin() can restore it.
  // badgeReverts/voided follow the same convention as every other game type's
  // snapshot (see trackBadgeForUndo()) — the chuckin180 achievement below is a
  // moment-style badge like Hat Trick, not a slow-building milestone, so unlike
  // the 18 laddered milestones (deliberately not undo-revocable, see
  // checkChuckinMilestones()'s own comment) it DOES get revoked on undo.
  pushTurnSnapshot({ sessionDarts:p.sessionDarts, sessionTrebles:p.sessionTrebles,
    sessionScore:p.sessionScore, dartBuffer:p.dartBuffer.slice(), heatmap:{...p.heatmap},
    chuckinLastDart:game.chuckinLastDart, chuckinRecent:(game.chuckinRecent||[]).slice(),
    badgeReverts:[], voided:false });

  p.sessionDarts += 1;
  if(dart.isTreble) p.sessionTrebles += 1;
  p.sessionScore += dart.value;
  // docs/bug-roadmap.md BUG-20: key singles by zone (inner/outer), and misses by their
  // wedge+depth (missZone/missDepth), so the live scoreboard heatmap can shade the two
  // single regions AND the outer miss ring independently — mirroring the lifetime
  // buildDartHeatmap()'s sector_mult_zone / missZone_missDepth keying. zone is only ever
  // set for a Dartboard-mode single; missZone/missDepth only for a Dartboard-mode miss;
  // trebles/doubles/bull and Pad-mode darts carry none. Key layout is always exactly
  // sector_mult_zone_missZone_missDepth (5 segments), so playerSnapshotChuckin() can
  // split it back apart unambiguously.
  const hKey = dart.sector+'_'+dart.mult+'_'+(zone||'')+'_'+(missZone!=null?missZone:'')+'_'+(missDepth||'');
  p.heatmap[hKey] = (p.heatmap[hKey]||0) + 1;
  p.heatmapVersion++;

  // "Assuming three darts per turn" (explicitly requested): group darts into
  // non-overlapping runs of 3, purely to detect a 180 — this mode otherwise has
  // no turn/visit boundary at all. Mirrors the backend's CHUCKIN_GROUPS_OF_3
  // exactly (both reset at a fresh session, so a group never spans two games).
  p.dartBuffer.push(dart.value);
  let got180 = false;
  if(p.dartBuffer.length === 3){
    got180 = (p.dartBuffer[0] + p.dartBuffer[1] + p.dartBuffer[2] === 180);
    p.dartBuffer = [];
  }

  recordSingleDartTurn({ player:p.name, set:game.setNo, leg:game.legNo,
    scored:0, bust:false, checkout:false, checkoutPoints:null, legWon:false }, dart, zone, missZone, missDepth, bounced);
  game.chuckinLastDart = { label:dart.label, isTreble:!!dart.isTreble };
  // A rolling run of the last nine darts. Just Chuckin' It has no visit and no
  // round, so this is the only "what just happened" the live scoreboard can
  // show — it is what the throw strip's right-hand pane carries for this mode
  // in place of the requirement every other mode has.
  game.chuckinRecent = (game.chuckinRecent || []).concat([
    { label:dart.label, isTreble:!!dart.isTreble, isMiss: dart.sector === 0 }]).slice(-9);
  announce(`${dart.label}. ${p.sessionDarts} dart${p.sessionDarts===1?'':'s'} this session.`);
  renderGameChuckin();
  checkChuckinMilestones(p);
  if(got180){
    queueBadge('chuckin180', p.name);
    awardRecurringBadge(p.name, 'chuckin180', 'chuckin180', { icon:'🎯', headline:'180!', player:p.name, statLine:"Bet you wish that counted in a real game, eh mate?" });
  }
}

// Undoes the single most recently thrown dart — mirrors undoLastTurnDoublesPractice()'s
// shape, plus revoking any badge (chuckin180) this dart awarded, same convention
// as X01/Cricket. The 18 laddered milestones stay permanently earned on undo —
// see checkChuckinMilestones()'s own comment for why that's a deliberate,
// separate decision from this one.
function undoLastTurnChuckin(){
  if(!game || !game.lastTurnSnapshot) return;
  const snap = game.lastTurnSnapshot;
  const p = game.players[0];
  p.sessionDarts = snap.sessionDarts;
  p.sessionTrebles = snap.sessionTrebles;
  p.sessionScore = snap.sessionScore;
  p.dartBuffer = snap.dartBuffer;
  p.heatmap = snap.heatmap;
  p.heatmapVersion++;
  game.chuckinLastDart = snap.chuckinLastDart;
  game.chuckinRecent = (snap.chuckinRecent || []).slice();

  _finishUndo(snap, renderGameChuckin, { msg: 'Last dart undone.' });
}

function renderGameChuckin(){
  const sb = document.getElementById('scoreboard'); if(sb) sb.innerHTML='';
  const p = game.players[0];
  const pct = p.sessionDarts ? Math.round(p.sessionTrebles/p.sessionDarts*100) : 0;
  const row = document.createElement('div');
  row.className = 'pscore active';
  row.innerHTML = `
    <div>
      <div class="nm">${escapeHtml(p.name)} <span class="nm-out">just chuckin' it</span></div>
      <div class="turnflag">▸ throwing</div>
    </div>
    <div class="meta">
      <div class="avgs">this session <b>${pct}%</b> trebles &nbsp;·&nbsp; ${p.sessionTrebles} treble${p.sessionTrebles===1?'':'s'} / ${p.sessionDarts} dart${p.sessionDarts===1?'':'s'}</div>
    </div>
    <div class="rem-wrap">
      <div class="rem">${p.sessionDarts}</div>
    </div>`;
  if(sb) sb.appendChild(row);

  const status = document.getElementById('status');
  if(status){
    if(game.chuckinLastDart){
      status.className = game.chuckinLastDart.isTreble ? 'status win' : 'status';
      status.textContent = `${game.chuckinLastDart.label}${game.chuckinLastDart.isTreble ? ' — treble!' : ''} · ${p.sessionDarts} dart${p.sessionDarts===1?'':'s'} this session.`;
    } else {
      status.className = 'status';
      status.textContent = padOrBoardHint('No score, no pressure — just throw.');
    }
  }
  renderPad();
  pushLive();
}
