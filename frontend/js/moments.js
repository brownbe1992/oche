'use strict';
/* Shareable Moments — canvas card generation, sharing, and badge awarding.
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
   SHAREABLE MOMENTS  (docs/archive/shareable-moments-roadmap.md)
   Client-side canvas card generation + Web Share/save-image + an automatic
   Home Assistant webhook carrying the same image as base64 — no server
   round-trip, no image hosting, no new dependency.
   ========================================================================= */
// 800x800 is still crisp for social sharing; JPEG (not PNG) keeps the file small
// enough to fit in the same request-body cap as everything else the app POSTs
// (readJson()'s 1MB limit in server.js) once base64-encoded for the HA webhook —
// the gradient background compresses far better as JPEG than as lossless PNG.
const MOMENT_CARD_W = 800, MOMENT_CARD_H = 800;
const MOMENT_CARD_MIME = 'image/jpeg', MOMENT_CARD_QUALITY = 0.88, MOMENT_CARD_EXT = 'jpg';

function wrapCanvasText(ctx, text, cx, y, maxWidth, lineHeight){
  const words = String(text).split(' ');
  let line = '', lines = [];
  for(const w of words){
    const test = line ? line+' '+w : w;
    if(ctx.measureText(test).width > maxWidth && line){ lines.push(line); line = w; }
    else line = test;
  }
  if(line) lines.push(line);
  const startY = y - (lines.length-1)*lineHeight/2;
  lines.forEach((l,i)=>ctx.fillText(l, cx, startY + i*lineHeight));
  return startY + (lines.length-1)*lineHeight; // y of the last line, for laying out what follows
}

// Builds the card as an off-screen canvas — never appended to the DOM. Waits for
// the app's own web fonts (already requested via <link> in <head>) to finish
// loading so canvas text doesn't silently fall back to a system font on the very
// first card generated in a session.
async function buildMomentCard({ icon, headline, player, statLine, desc, footer }){
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = MOMENT_CARD_W; canvas.height = MOMENT_CARD_H;
  const ctx = canvas.getContext('2d');
  const cx = MOMENT_CARD_W/2;

  const bg = ctx.createRadialGradient(cx, 165, 60, cx, MOMENT_CARD_H/2, 580);
  bg.addColorStop(0, '#1b1d19'); bg.addColorStop(1, '#0d0e0b');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, MOMENT_CARD_W, MOMENT_CARD_H);
  ctx.strokeStyle = '#d9b46a'; ctx.lineWidth = 4;
  ctx.strokeRect(20, 20, MOMENT_CARD_W-40, MOMENT_CARD_H-40);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#9a9387';
  ctx.font = '700 22px Inter, sans-serif';
  ctx.fillText('OCHE', cx, 82);

  ctx.font = '110px sans-serif';
  ctx.fillText(icon || '🎯', cx, 250);

  ctx.fillStyle = '#efe7d2';
  ctx.font = '60px "Bebas Neue", sans-serif';
  let y = wrapCanvasText(ctx, headline, cx, 350, MOMENT_CARD_W-120, 65);

  ctx.fillStyle = '#d9b46a';
  ctx.font = '600 34px Inter, sans-serif';
  ctx.fillText(player, cx, y + 66);
  let lastY = y + 66;

  if(statLine){
    ctx.fillStyle = '#f3efe4';
    ctx.font = '400 26px Inter, sans-serif';
    ctx.fillText(statLine, cx, y + 115);
    lastY = y + 115;
  }

  // Achievement explanation — what the achievement actually IS/how it's earned
  // (e.g. "Throw 500 lifetime darts in Just Chuckin' It."), distinct from
  // statLine's specific-occurrence recap above it (e.g. "500 lifetime darts").
  // fireMomentCard() resolves this via achDescFor(momentType) so every card gets
  // one automatically; muted/smaller so it reads as supporting text, and chained
  // off whichever of player/statLine was drawn last so it never overlaps either.
  if(desc){
    ctx.fillStyle = '#9a9387';
    ctx.font = '400 20px Inter, sans-serif';
    wrapCanvasText(ctx, desc, cx, lastY + 48, MOMENT_CARD_W-100, 26);
  }

  // Tagline (Settings -> Shareable Moments -> Card tagline) — a short promotional
  // line, editable so it can point at a real website/handle once one exists.
  ctx.strokeStyle = 'rgba(217,180,106,.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx-140, 668); ctx.lineTo(cx+140, 668); ctx.stroke();
  ctx.fillStyle = '#d9b46a';
  ctx.font = '600 20px Inter, sans-serif';
  wrapCanvasText(ctx, cardTagline || DEFAULT_CARD_TAGLINE, cx, 706, MOMENT_CARD_W-140, 26);

  ctx.fillStyle = '#655f54';
  ctx.font = '400 18px Inter, sans-serif';
  const dateStr = new Date().toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  ctx.fillText(footer || dateStr, cx, MOMENT_CARD_H-30);

  return canvas;
}

// Native share sheet (X/Instagram/Facebook/Messages/anything the OS offers) where
// supported, falling back to a plain image download everywhere else. If the user
// backs out of the native share sheet (AbortError), do nothing rather than forcing
// a download they didn't ask for.
async function shareOrSaveCanvas(canvas, filename, shareTitle, shareText){
  const blob = await new Promise(resolve => canvas.toBlob(resolve, MOMENT_CARD_MIME, MOMENT_CARD_QUALITY));
  if(!blob) return;
  const file = new File([blob], filename, { type:MOMENT_CARD_MIME });
  if(navigator.canShare && navigator.canShare({ files:[file] })){
    try{ await navigator.share({ files:[file], title:shareTitle, text:shareText }); return; }
    catch(e){ if(e && e.name === 'AbortError') return; /* else fall through to save */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// Generates the card once, stashes it keyed by moment type (a Big Fish that also
// wins the match fires two cards on the very same turn — keying by type instead of
// a single "last" pointer avoids one overwriting the other whenever their async
// generation happens to resolve out of order), and — since this is the one path
// that fires regardless of whether the player ever taps Share — automatically
// posts it to Home Assistant if a moment-card webhook ID is configured (same
// fire-and-forget pattern as every other HA event webhook).
// Registers a just-awarded badge against a specific turn's undo snapshot, so
// undoLastTurn() can revoke it later. `snap` must be captured by the caller at
// the moment the award call was made (not re-read from game.lastTurnSnapshot
// inside an async callback) — by the time an award's response comes back, the
// player may already be several turns further on, and game.lastTurnSnapshot
// would point at the wrong (later) turn's snapshot.
//
// If undo already ran for that turn before this award's response arrived (snap
// is marked .voided), the badge never gets a chance to sit in the revert list —
// so it's revoked immediately instead, closing the race the other direction.
// Novelty time-of-day badges — shared between X01's enterTurn() and Cricket's
// enterTurnCricket() (docs/game-modes-roadmap.md "Cricket badge parity": this was
// previously X01-only by accident of code structure, not a deliberate scoping
// decision — a Cricket player who only ever plays at 4am could never earn either
// badge). The overlay only fires once per session (not once per turn, which would
// spam the same celebration all night), but every actual occurrence still counts
// toward the Badge Case total. The per-turn persistence call below deliberately
// omits the momentType/momentOpts args (no momentType == no card fired) — only the
// session-gated celebration below fires a card, or every turn thrown after
// midnight would spam an HA webhook. Relies on the caller having already set
// game.lastTurnSnapshot (both enterTurn() and enterTurnCricket() do this before
// any achievement checks), since awardRecurringBadge() reads it for undo tracking.
function awardTimeOfDayBadges(p){
  const _hour = new Date().getHours();
  if(_hour < 5 || (_hour >= 5 && _hour < 7)){
    awardRecurringBadge(p.name, _hour < 5 ? 'nightowl' : 'earlybird');
  }
  if(!sessionBadgesShown.nightOwl && _hour < 5){
    sessionBadgesShown.nightOwl = true;
    queueBadge('nightowl', p.name);
    fireMomentCard('nightowl', { icon:'🦉', headline:'NIGHT OWL', player:p.name, statLine:'Darts after midnight' });
  } else if(!sessionBadgesShown.earlyBird && _hour >= 5 && _hour < 7){
    sessionBadgesShown.earlyBird = true;
    queueBadge('earlybird', p.name);
    fireMomentCard('earlybird', { icon:'🐦', headline:'EARLY BIRD', player:p.name, statLine:'Darts before 7am' });
  }
}
function trackBadgeForUndo(snap, playerName, badgeId){
  if(!snap) return;
  if(snap.voided){ Backend.send('POST','/api/badges/revoke', { player:playerName, badgeId }).catch(logErr); return; }
  snap.badgeReverts.push({ player:playerName, badgeId });
}
// Persists a recurring badge occurrence (count-mode: increments every call, since
// these all fire on a per-visit/per-leg/per-match event that won't spuriously
// re-trigger). The overlay celebration itself already happened via queueBadge()
// synchronously, before this network round-trip even starts — deliberately not
// blocked on it (docs/archive/next-session-plan.md item 1). Once the award API's
// { newlyEarned, count } response comes back: the shareable moment card (if a
// momentType/momentOpts pair was given) fires with the real count folded into its
// statLine, and the live overlay itself gets the same count patched in via
// patchAchievementCount() (docs/archive/achievements-badges-roadmap.md's live-overlay
// count item) — both deliberately only shown once count > 1, matching the
// existing moment-card convention of staying silent on a badge's first-ever earn.
function awardRecurringBadge(playerName, badgeId, momentType, momentOpts){
  const snap = game && game.lastTurnSnapshot;
  Backend.send('POST','/api/badges/award', { player:playerName, badgeId, once:false })
    .then(r=>{
      const count = r && r.count;
      patchAchievementCount(badgeId, playerName, count>1 ? `Earned ${count}× total` : '');
      if(!momentType) return;
      const statLine = (count>1 && momentOpts.statLine) ? `${momentOpts.statLine} · Earned ${count}× total` : momentOpts.statLine;
      fireMomentCard(momentType, { ...momentOpts, statLine });
    })
    .catch(()=>{ if(momentType) fireMomentCard(momentType, momentOpts); });
  trackBadgeForUndo(snap, playerName, badgeId);
}
// One-shot ({once:true}) badge award — generalizes the ~10 hand-rolled
// `Backend.send('POST','/api/badges/award', {once:true}).then(r=>{ if(r.newlyEarned)
// ... })` copies this app had drifted into (three different undo-snapshot naming
// conventions, one site silently skipping queueBadge, only some sites maintaining
// earnedBadgeCache to avoid re-firing the POST every re-trigger).
// - backendBadgeId/achId: usually identical, but a few badges (Around the Clock/
//   World, First 100+ Checkout, Grudge Match) were already sending an underscored
//   id to the backend while queueBadge()/fireMomentCard() use a different,
//   no-underscore id — kept as two params rather than silently unifying them.
// - snap: the undo snapshot, or `null` for a permanent/non-revocable badge
//   (Doubles Practice's Ring Master, Chuckin's milestone ladders) — safe to pass
//   through unconditionally since trackBadgeForUndo()/queueBadge() already treat
//   a null/falsy snap as "nothing to track."
// - momentOpts: {icon, headline, statLine} — `player` is filled in automatically.
// - opts.cacheCheck (default false): pre-check/populate earnedBadgeCache so the
//   POST doesn't re-fire every re-trigger (Around the World, Chuckin milestones,
//   Doubles Practice's Ring Master already did this; most one-shot badges don't
//   need it since their own trigger condition is already a rare one-time event).
// - opts.silent (default false): skip queueBadge/fireMomentCard on success —
//   Grudge Match's opponent-side award only wants undo-tracking, no UI celebration
//   for a badge earned via someone else's match win.
function awardOnceBadge(player, backendBadgeId, achId, snap, momentOpts, opts){
  const { cacheCheck=false, silent=false } = opts || {};
  if(cacheCheck && earnedBadgeCache[player] && earnedBadgeCache[player].has(backendBadgeId)) return;
  Backend.send('POST','/api/badges/award', { player, badgeId:backendBadgeId, once:true }).then(r=>{
    if(cacheCheck){
      if(!earnedBadgeCache[player]) earnedBadgeCache[player] = new Set();
      earnedBadgeCache[player].add(backendBadgeId);
    }
    if(r && r.newlyEarned){
      // The snapshot can have been voided while this POST was in flight — the
      // player pressed undo before the award came back. trackBadgeForUndo()
      // handles the persistence half by revoking immediately, but the
      // celebration used to run regardless, so an undone turn still threw a
      // "First time!" overlay and a shareable moment card for a badge the
      // server no longer holds. Nothing to celebrate once it's been taken back.
      trackBadgeForUndo(snap, player, backendBadgeId);
      if(snap && snap.voided) return;
      if(silent) return;
      queueBadge(achId, player, snap, 'First time!');
      fireMomentCard(achId, { ...momentOpts, player });
    }
  }).catch(logErr);
}

const momentCards = {};
async function fireMomentCard(momentType, opts){
  try{
    // Every card gets an achievement explanation automatically — achDescFor()
    // is the same lookup the live overlay/voice announcement already use, so this
    // is one description per achievement, not a second copy to keep in sync. A
    // caller can still pass its own opts.desc to override (not currently used by
    // any call site, but keeps the door open the same way statLine already does).
    const desc = opts.desc || achDescFor(momentType);
    const canvas = await buildMomentCard({ ...opts, desc });
    momentCards[momentType] = { canvas, ...opts, desc };
    // The canvas itself is always built/cached — the in-app Share button
    // (shareMomentCard()) needs it regardless of HA integration. Only the
    // JPEG-encode + ~250KB webhook POST are skipped when nothing's listening
    // (item 57) — those are pure waste the server would discard unread anyway.
    if(haWebhookStatus.enabled && haWebhookStatus.events.momentcard){
      const image = canvas.toDataURL(MOMENT_CARD_MIME, MOMENT_CARD_QUALITY);
      sendHaWebhook('momentcard', opts.player, (game && game.category) || '', {
        momentType, headline: opts.headline, statLine: opts.statLine || '', image });
    }
  }catch(e){ console.warn('moment card generation failed:', e); }
}
// Keeps the match-win card's stat line simple: an exact score for the common
// 2-player case, a plain "match complete" for 3+ players rather than trying to
// lay out every player's standing on a fixed-size card.
function matchWinStatLine(winner, legsAtWin){
  const useSets = game.setsPerGame > 1;
  if(game.players.length === 2){
    const opp = game.players.find(p=>p!==winner);
    const w = useSets ? winner.setsWon : legsAtWin.get(winner);
    const l = useSets ? opp.setsWon    : legsAtWin.get(opp);
    return `${game.category} · Won ${w}-${l} ${useSets?'in sets':'in legs'}`;
  }
  return `${game.category} · Match complete`;
}
function shareMomentCard(momentType){
  const card = momentCards[momentType];
  if(!card) return;
  shareOrSaveCanvas(card.canvas, `oche-${momentType}-${Date.now()}.${MOMENT_CARD_EXT}`, `${card.player} — ${card.headline}`, 'Shared from Oche');
}
