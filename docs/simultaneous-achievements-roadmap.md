# Simultaneous Achievements — Design Roadmap

> Status: **shipped**, per the design below. `enterTurn()`'s expanded-achievements
> chain is now a `CHAIN_CHECKS` list collected and filtered by the suppression-pairs
> table (Busted Maximum still suppresses Ton-titled to Nothing, Bullseye Gauntlet
> still suppresses Double Trouble) rather than an `if/else if` chain. Every
> `showAchievement()` call site — the expanded chain, Metronome, Cruise Control, Ice
> in the Veins, Night Owl/Early Bird, `onLegWon()`'s Comeback Kid/Nerves of
> Steel/Giant Slayer, The Rematch/Grudge Match, the async milestones, and
> 180/Big Fish/Nine-Darter — now goes through `queueBadge()`/`pumpAchievementQueue()`
> instead. `pendingAchievement` is now set generically for every queued item as it's
> shown (previously only 180/Big Fish/Nine-Darter ever reached `display.html` at
> all — that broadcast-coverage gap is fixed as part of the same change, not just the
> ordering). Verified end-to-end: a real `onLegWon()` triple collision (Comeback
> Kid + Nerves of Steel + Giant Slayer, all genuinely true on the same
> match-deciding leg) shows and broadcasts all three in sequence; a same-visit Big
> Fish + Nine-Darter collision shows both; both suppression pairs still hold.
>
> Built alongside `docs/next-session-plan.md` item 1 (explanatory text + count on
> the overlay/moment card), since both touch the same `showAchievement()`/
> `awardRecurringBadge()` code — see that doc for what shipped there.

## Goal

When a single turn genuinely earns more than one badge, every one of them should be
recorded and celebrated — none should be silently dropped or overwritten because
another badge happened to fire in the same moment.

## The problem, concretely

`enterTurn()` in `frontend/index.html` isn't one gate, it's several, and they don't
coordinate:

1. **The "expanded achievements" chain** (Hat Trick, Bullseye Gauntlet, Double
   Trouble, Where'd It Go?, So Close..., Busted Maximum, Ton-titled to Nothing) is a
   single `if/else if` chain by design — only one of these can ever fire per turn,
   which is intentional (see "Suppression pairs" below).
2. But **outside that chain**, several more checks run as independent `if` blocks in
   the same synchronous pass through `enterTurn()`: Metronome, Cruise Control, Ice in
   the Veins, Night Owl/Early Bird, plus the always-separate 180/Big Fish/Nine-darter
   checks above them. Any of these can be true in the same turn as a chain badge —
   e.g. a leg-ending checkout via consecutive doubles (Double Trouble) that also
   happens to be the leg's 5th visit within 15 points of the last four (Metronome) and
   the whole leg stayed above 40 (Cruise Control). All three conditions are real and
   independently true today; only the last one checked survives on screen, because
   they all end up calling the *same* `showAchievement()`.
3. `showAchievement(type, player)` is a **single-slot overlay**: it always sets
   `achOverlayEl`'s text/name and always calls `clearTimeout(achTimer)` before
   starting a new one. A second call before the first badge's `ACH_DURATION` has
   elapsed doesn't queue — it silently replaces the first, both in `index.html`'s own
   overlay and in `pendingAchievement`, the single-slot field broadcast to
   `display.html` over SSE (`frontend/display.html` matches `showAchievement` off
   `s.achievement.ts`, one entry, no queue on that side either).
4. Several milestone badges (`first_100_checkout`, `around_the_clock`,
   `around_the_world`) award **asynchronously** — the `showAchievement()` call for
   them happens inside a `Backend.send(...).then(r => ...)` callback, after a network
   round trip. That callback can resolve *after* a synchronous badge from the same
   turn is already showing, and will clobber it mid-display — the exact race is
   already latent in production today, it just needs the right visit to expose it
   (e.g. a first-ever 100+ checkout that's also a Double Trouble: Double Trouble
   flashes immediately, then gets silently replaced a moment later when the
   `first_100_checkout` award confirms).

None of this is a persistence problem — `POST /api/badges/award` is already called
once per badge, independently, and is naturally additive (`backend/db.js`'s counting
mode does `ON CONFLICT DO UPDATE count=count+1`). A turn that earns three badges
already correctly persists three award rows and three Badge Case counts today. **The
break is entirely in the notification layer**: what gets shown, and what gets
broadcast to the live scoreboard.

Undo already handles multiple badges correctly too — `trackBadgeForUndo()` pushes
onto `snap.badgeReverts`, an array, and `undoLastTurn()` already revokes everything in
it. No change needed there.

## Suppression pairs to preserve

Two conditions in the expanded-achievements chain are *deliberately* exclusive with
each other, not just accidentally chained — collecting "all matching badges" instead
of "first match wins" must not resurrect these as double-fires for what's really one
event wearing two labels:

| More specific (wins) | More generic (suppressed) | Why |
|---|---|---|
| Busted Maximum | Ton-titled to Nothing | A busted three-treble-20 is a 100+ bust by definition; the specific "genuine 180 that didn't count" story is strictly more interesting than the generic one. |
| Bullseye Gauntlet | Double Trouble | Double bull hit twice is technically "last two darts both doubles" too, but it's its own, more specific badge. |
| (existing, already comment-documented) Any expanded-chain badge | 180 | The whole chain's conditions are already written to exclude `ev.scored === 180` so a genuine 180 never also fires Hat Trick/So Close.../etc. |

This becomes an explicit precedence list in code (see Decisions below) rather than
relying on `if/else if` ordering to encode it implicitly, since implicit ordering is
exactly what breaks once the chain stops short-circuiting.

## Decisions to make

| Decision | Recommendation |
|---|---|
| How to collect multiple badges per turn | Replace the `if/else if` chain with a list of independent condition checks pushed into a `firedBadges` array for the turn; apply the suppression-pairs table as a post-filter (drop the generic member of a pair if the specific member is also present) rather than encoding it as check order. |
| How to display multiple badges | A **sequential queue**, not a combined/stacked card. Simpler than redesigning the overlay to show N badges at once, keeps each badge's own icon/headline/duration intact, and matches how a real "you just earned two things" moment reads to a player standing at the board — one clear announcement at a time beats a cluttered one. |
| Queue depth / overflow | Cap at a small number (e.g. 4) per turn — realistically 2 is the common case and 3+ is a curiosity; anything beyond the cap just doesn't get a celebration (still persists and still counts in the Badge Case, so nothing is actually lost, only the live flash). |
| Async milestone badges (First 100+ Checkout, Around the Clock, Around the World) | Route their `showAchievement()` calls through the same queue instead of calling it directly from the `.then()` callback. This is what actually fixes the race in point 4 above — "queue it whenever it's ready" instead of "show it immediately and hope nothing else is on screen." |
| `fireMomentCard()` / HA webhooks | **No change.** Already keyed per-`momentType` in the `momentCards` dict, so nothing overwrites. Multiple badges in one turn already correctly send multiple independent HA webhooks and produce multiple independently-shareable cards — arguably the *correct* behavior already (each badge is its own shareable moment). |
| Badge persistence / Badge Case / undo | **No change.** Already additive and already list-based (`snap.badgeReverts`). |

## 1. Detection: `enterTurn()`'s badge collection

Today (`frontend/index.html`, inside `enterTurn()`):

```js
if(hatTrickCond){ ...; }
else if(bullseyeCond){ ...; }
else if(doubleTroubleCond){ ...; }
else if(whereDidItGoCond){ ...; }
else if(soCloseCond){ ...; }
else if(bustedMaxCond){ ...; }
else if(tonTitledCond){ ...; }
```

Becomes a data-driven list so adding future badges doesn't mean remembering to keep
extending one giant `else if` — and so "collect all, then filter suppression pairs"
is expressible without re-deriving check order by hand:

```js
const CHAIN_CHECKS = [
  { id:'hattrick',       test: () => hatTrickCond },
  { id:'bullseyegauntlet', test: () => bullseyeCond },
  { id:'doubletrouble',  test: () => doubleTroubleCond, suppresses: [] },
  { id:'wherediditgo',   test: () => whereDidItGoCond },
  { id:'socloseshot',    test: () => soCloseCond },
  { id:'bustedmaximum',  test: () => bustedMaxCond, suppresses: ['tontitled'] },
  { id:'tontitled',      test: () => tonTitledCond },
];
// bullseyegauntlet suppresses doubletrouble in the double-bull-twice overlap case
CHAIN_CHECKS.find(c=>c.id==='bullseyegauntlet').suppresses = ['doubletrouble'];

let matched = CHAIN_CHECKS.filter(c => c.test()).map(c => c.id);
const suppressed = new Set(CHAIN_CHECKS.filter(c=>matched.includes(c.id)).flatMap(c=>c.suppresses||[]));
matched = matched.filter(id => !suppressed.has(id));
matched.forEach(id => queueBadge(id, p.name, /* moment card opts for id */));
```

The Metronome/Cruise Control/Ice in the Veins/Night Owl/Early Bird checks stay as
independent `if` blocks (they're genuinely independent conditions, not a mutually
exclusive family) but each calls `queueBadge()` instead of `showAchievement()`
directly.

## 2. The queue: `queueBadge()` replacing direct `showAchievement()` calls

```js
let achievementQueue = [];
let achievementQueueRunning = false;

function queueBadge(type, player, momentOpts){
  achievementQueue.push({ type, player, momentOpts, ts: Date.now() });
  fireMomentCard(type, momentOpts);           // unchanged: independent per-type, fires immediately
  awardRecurringBadge(player, type);           // unchanged: independent POST per badge
  pumpAchievementQueue();
}
function pumpAchievementQueue(){
  if(achievementQueueRunning || achievementQueue.length===0) return;
  achievementQueueRunning = true;
  const next = achievementQueue.shift();
  showAchievement(next.type, next.player);   // unchanged overlay function, one at a time
  pendingAchievement = { type: next.type, player: next.player, ts: next.ts }; // still single-slot,
                                                                                // but now only ever
                                                                                // set one-at-a-time
  clearTimeout(achTimer);
  achTimer = setTimeout(()=>{
    achOverlayEl.classList.remove('show');
    achievementQueueRunning = false;
    pumpAchievementQueue();                  // advance to the next queued badge, if any
  }, ACH_DURATION[next.type] || 2500);
}
```

`showAchievement()` itself doesn't need to change — it was never the problem, it was
always designed to show one thing for a fixed duration. The fix is not calling it
more than once until the previous call's duration has actually elapsed.

Milestone badges' async `.then()` callbacks change from calling `showAchievement()`
directly to calling `queueBadge()` — same one-line swap, but now they merge into
whatever's already queued instead of racing it.

## 3. Live broadcast to `display.html`

`pendingAchievement` (the field read by `liveSnapshot()` and pushed over SSE) stays a
single object, not an array — the queue above already serializes badges to one at a
time before `pendingAchievement` gets set, so by the time it's broadcast there's
never more than one pending. `display.html`'s existing `s.achievement.ts`-keyed dedup
logic needs no change; it already correctly shows each distinct timestamp it sees, and
because the controller now only ever advances `pendingAchievement` once per queue pop
(not once per badge earned), display.html will naturally receive and show all of them
in sequence, matching the controller's own queue pacing exactly.

## Suggested build order

1. Convert the expanded-achievements `if/else if` chain to the `CHAIN_CHECKS`
   list + suppression-pairs filter (self-contained, one function).
2. Add `queueBadge()`/`pumpAchievementQueue()`; swap every existing
   `showAchievement()` call site (chain badges, Metronome, Cruise Control, Ice in the
   Veins, Night Owl/Early Bird, and the three async milestone callbacks) to go through
   it instead. 180/Big Fish/Nine-darter can go through the same queue too, for
   consistency, even though they're rare enough that collisions are unlikely.
3. Test the two concrete collision scenarios called out above end-to-end: (a) a leg
   that's simultaneously Double Trouble + Metronome + Cruise Control in one turn, (b)
   a first-ever 100+ checkout that's also Double Trouble (sync badge + async milestone
   racing). Confirm both badges show, in order, each for its own duration, on both
   `index.html` and `display.html`, and both persist in the Badge Case with correct
   counts.
4. No backend changes, no schema changes, no changes to `fireMomentCard`, Badge Case
   rendering, or undo — confirm via the existing test suite/manual pass that those
   continue to behave exactly as before.

## Open questions for whoever picks this up

- Is a 4-badge-per-turn cap the right number, or should the queue be unbounded (every
  earned badge always gets its moment, however long the queue takes to drain)? An
  unbounded queue is simpler to reason about and the realistic worst case is small —
  worth reconsidering the cap once this is actually built and playtested.
- Should the HA webhook volume from multiple simultaneous `fireMomentCard()` calls be
  throttled or batched into a single "multi-badge" webhook payload? Left as-is for v1
  per the Decisions table above; revisit only if real usage shows it's noisy.
