# Multiple Live Scoreboards — Design Roadmap

> Status (2026-07): **Not started.** Owner request. Tracked as item 12 on
> `docs/open-roadmap-items.md`.
>
> Current behaviour, for contrast: `REFERENCE.md` §7 (Live Scoreboard &
> Real-Time Sync).

---

## What's being asked

Four tournament matches on four boards, each with its own live scoreboard, plus
an optional "master" board showing every match at once for spectators.
Specifically:

1. **N simultaneous scoreboards**, one per active match.
2. **Nothing changes when only one game is active** — the existing single-screen
   setup must keep working exactly as it does now, with no new steps.
3. **When a second game starts**, the second screen can be pointed at whichever
   match it should show.
4. **A master scoreboard** showing all active matches, tied to no single game.

## The problem, in one line

`liveState` is a single object.

```js
// backend/server.js
let liveState = { active: false, ts: Date.now() };
function liveBroadcast() {
  const line = `data: ${JSON.stringify(liveState)}\n\n`;
  for (const res of liveClients) { try { res.write(line); } catch (e) {} }
}
```

Every `POST /api/live` overwrites the one slot, and `liveBroadcast()` writes that
one slot to every connected screen. Two controllers pushing concurrently don't
produce two scoreboards — they produce **one scoreboard flickering between two
matches**, at whatever rate the two devices happen to be throwing. That is the
whole of the current limitation, and it is a smaller thing than it first looks.

## What already works — this is not a concurrency feature

Worth establishing before designing anything, because it changes the size of the
job: **the app can already play four games at once.** There is nothing to build
for that.

- `tournament_matches.game_id` is a **nullable FK per match**
  (`backend/db.js`), so every match in a round can hold its own game
  independently. The bracket has no notion of "the current match."
- `createGame()` has **no single-active-game guard**. Nothing rejects a second
  concurrent game, and nothing serialises them.
- The controller is per-device state (`game`, a plain global in `index.html`), so
  four tablets are four independent scorers that happen to write to one database.
  They already don't interfere with each other's turns, legs, or stats.

So four people can start four quarterfinals on four tablets **today**, and every
match will be scored and recorded correctly. The only thing that breaks is the
television. This item is therefore scoped as *"stop the single live slot being a
bottleneck,"* not *"make concurrent play possible"* — and it should not grow into
the latter.

## What's actually missing

Five gaps, all in the live channel:

1. **One state slot** (above).
2. **No identity on the payload.** `liveSnapshot()` (`frontend/index.html`) emits
   `active`, `gameType`, `category`, `players`, … and **no game id and no device
   id**. Even with somewhere to put a second state, there is nothing on a push
   saying which match it belongs to.
3. **The server doesn't know what's live.** It knows only the last snapshot it was
   handed. There is no "list the active matches" anywhere — `getSavedGames()` is
   *paused* games, a different thing entirely. Both the screen picker and the
   master board need that list, so it has to be built.
4. **No per-screen selection.** `openScoreboard()` is `window.open('display')` —
   no parameters. (`?layout=` already exists as precedent for a per-screen URL
   override; see below.)
5. **No aggregate view.** `frontend/display.html` renders exactly one match: one
   `#grid`, one top bar, one `render(s)` taking a single snapshot.

---

## Design

### Channels, keyed by game id

Replace the single slot with a keyed map of channels:

```js
// channelId -> { state, updatedAt }
const liveChannels = new Map();
```

**The channel key is `games.id`.** The controller already has it —
`DB.gameId`, set from `POST /api/games`'s response in `beginGame()` — so this
costs the frontend one field on the snapshot.

Why the game id and not a per-device UUID:

- **It survives a controller reload.** A tablet that refreshes mid-match, or
  resumes a saved game, comes back with the *same* game id and therefore the same
  channel — the wall-mounted screen watching it never notices. A device UUID
  would mint a *new* channel on every refresh and orphan the old one, which is
  strictly worse behaviour for the exact failure it would be introducing.
- **It's meaningful to the reader.** A master board can join
  `tournament_matches` on it and label a row "Quarterfinal — A vs B" rather than
  "device 4f3c…". The picker can say what each channel *is*.
- **It's already the thing the rest of the app keys on.** No new identity concept,
  no second way to name a game.

One consequence to accept: a mode that pushes live state without a `games` row
would have no key. Today that set is empty — every mode calls `beginGame()` — and
modes with `noLiveDisplay` (Checkout Trainer, The Gauntlet) never push at all and
must stay absent from every channel list. If a future mode ever pushes without a
game row, give it the `'default'` fallback below rather than inventing a second
key space.

### API surface

| Route | Behaviour |
|---|---|
| `POST /api/live` | body gains `gameId`; writes `liveChannels[gameId]`, broadcasts to that channel's subscribers **and** to master subscribers. A body with no `gameId` writes channel `'default'`, so an un-upgraded controller keeps working. |
| `GET /api/live` | unchanged shape when one channel exists; `?game=<id>` selects one. Kept because `display.html`'s polling fallback uses it. |
| `GET /api/live/stream` | no param — the connection takes an **implicit claim** and auto-follows, or is told to show the picker. See "Which match a screen shows". |
| `GET /api/live/stream?game=<id>` | that channel only, as an **explicit claim**. |
| `GET /api/live/stream?master=1` | one stream carrying the summary of every channel. Takes **no claim** — a spectator board watching everything must not make the next screen choose. |
| `GET /api/live/channels` | the picker's list: `[{gameId, label, players, gameType, updatedAt, claimed}]`. `claimed` is what lets the picker mark a match another screen is already showing — not a restriction (two screens on one match is fine), just information. |
| `DELETE /api/live?game=<id>` | explicit teardown at game end (`requireWrite`). |

Claims are held per SSE connection, so there is deliberately **no** "release my
claim" route: closing the stream *is* releasing it. A screen switching match
re-subscribes, which releases the old claim and takes the new one in one step —
no way to leak one, and no second code path that has to remember to.

`gameId` **must be added to `ALLOWED_LIVE_KEYS`** or the server will silently
strip it and every push will land in `'default'` — a plausible-looking wrong
picture with no error anywhere. That exact sync point has shipped two bugs
already (`docs/bug-roadmap.md` BUG-28's seven keys, then
`killerLives`/`checkoutLadder*`), which is why `modeState` exists to avoid it for
per-mode fields. This is a top-level key, so it needs the entry.

### Which match a screen shows — claims

**Decided by the owner (2026-07), resolving this doc's original open question 1.**
The rule:

> A screen is pinned to a match **manually**, never automatically — *but only once
> some screen is already pinned to a match.* While nothing is claimed, a screen
> just picks up the game that's running.

The point is the garage case: one game, one screen, and **never being asked to
choose a game you only have one of** — not on the first game of the night, and not
on the fifth.

The mechanism is a **claim**. Every connected screen either holds a claim on one
match or holds none, and there are two kinds:

| | How | When the match ends | Counts as "already pinned"? |
|---|---|---|---|
| **Implicit** | auto-followed, nobody chose it | released — the screen becomes eligible to auto-follow again | **yes** |
| **Explicit** | `?game=<id>`, `openScoreboard()` from the controller, or **switched by hand on the scoreboard** | held; the screen says the match finished and offers the switcher | **yes** |

A manual switch therefore **upgrades** an implicit claim to an explicit one — the
viewer has stated what they want to watch, and the app stops guessing on their
behalf. See "Switching from the scoreboard" for why that asymmetry is deliberate.

The full rule, including the case the owner's sentence doesn't cover:

> An unclaimed screen **auto-follows** iff **no other screen holds a claim** *and*
> **exactly one match is active**. Otherwise it shows the picker.

The second clause is needed because "no claims" alone leaves auto-follow undefined
when two matches started before any screen connected — there is no single game to
pick up. That case gets the picker, which is the right answer anyway.

What this produces, walked through:

- **Garage, first game.** No claims, one match → the screen auto-follows. No
  choosing. Byte-identical to today.
- **Garage, next game.** The first match ended, so that implicit claim was
  *released*; the new game is again the only match with no claims outstanding →
  auto-followed. **This is the part that makes "not every time I start one" true
  across a whole evening**, and it is why implicit claims must release on match
  end rather than sticking.
- **Tournament, second screen.** Screen 1 auto-followed match 1 and so holds an
  implicit claim. Match 2 starts; screen 2 connects → a claim exists, so screen 2
  gets the picker and is pinned deliberately. Exactly the requested behaviour.
- **A claimed screen never switches on its own**, implicit claim or not. Yanking
  the picture out from under a wall-mounted TV because someone across the room
  started a game is the failure mode of any "show the newest" rule, and it stays
  ruled out.
- **Two matches, no screens, then a screen connects** → picker. Nothing to
  auto-follow unambiguously.
- **An un-upgraded controller** (a cached tab pushing with no `gameId`) writes
  `'default'` and still drives an auto-following screen. Old client, old behaviour.

One deliberate softening, because the rule read literally has a rough edge: if a
screen is already showing the garage game and you open a *second* screen, the
picker would list exactly one option. **A picker with one option renders as a
single "Show: A vs B" button, not a list.** That is still manual — the owner's
rule is intact, nobody is auto-adopted — it just isn't a menu of one.

#### This moves state to the server, and that is the real cost

The original sketch here was a purely client-side latch: each screen remembered
what it was showing and nothing needed to coordinate. **"Only if another screen is
already pinned" is cross-screen state**, so the server has to track claims and
tell a connecting screen whether any exist. That is a genuine increase in scope
over the latch, and it is worth knowing before step 4 rather than discovering it
there.

It is, however, cheap to do correctly, because claims are **per SSE connection**
and that lifecycle already exists. `liveClients` is a `Set` of response objects
with a `req.on('close')` handler that already removes them; making it a
`Map<res, {claim, kind}>` gives per-connection claims whose cleanup is the same
close handler.

**The failure mode to guard is a claim outliving its screen.** If a closed browser
tab could leave a claim behind, then the household that once opened a second
display would be asked to choose a game *forever after* — precisely the friction
the owner is ruling out, arriving by the back door. Claims therefore live and die
with the connection, never in the database, and never on a timer of their own.
A stale claim is worse than no claim, so when in doubt, release.

The assertion that protects requirement 2: with one game and no URL parameters
anywhere, the observable behaviour is byte-identical to today — and it must still
hold after a second screen has been opened and closed again. Write that test
first (see Testing).

### Liveness, expiry, and ghost matches

The server currently has no concept of a channel ending, and with one slot it
didn't need one — the next push overwrote it. With N channels, a tablet that goes
flat mid-match would otherwise leave a match on the master board forever.

- **Explicit close**: game end / abandon calls `DELETE /api/live?game=`. This is
  the clean path and covers the normal case.
- **TTL sweep**: a channel with no push for ~90 seconds is dropped. Controllers
  already push on every state change; a genuinely idle-but-live match (a player
  gone to the bar) needs a keepalive push or a generous TTL, and 90s is chosen to
  survive a slow visit rather than to be tight. Getting this wrong in the
  tight direction makes matches vanish from the master board mid-play, which is
  more annoying than a stale row.
- **`active:false`** pushes already exist and should close the channel rather than
  leave an inactive one listed.
- **Server restart wipes everything** — state is deliberately never persisted
  (`REFERENCE.md` §7). With one channel a restart meant one blank screen that
  recovered on the next push. With N, every board goes blank at once, so
  reconnecting screens must re-establish their claim gracefully rather than show an
  error, and a controller should re-push its full snapshot on reconnect rather than
  waiting for the next dart. Note a restart clears every claim too, which means the
  garage screen auto-follows again on reconnect — the right outcome, and worth
  asserting so a future "remember claims across restarts" idea doesn't break it.

### Master scoreboard

`/display?master=1` — a grid of compact per-match rows, no dartboard, no
per-dart throw strip.

Two decisions worth stating up front, because the obvious implementations of both
are wrong:

**One stream, not N.** A master board opening one SSE per match would burn
`MAX_SSE_PER_IP` (currently **5**) at four matches plus itself, and multiplies the
server's fan-out for no benefit. The master subscribes once and the server
multiplexes.

**Summary frames, not full snapshots.** `MAX_LIVE_BYTES` is 65536 *per push*, and
a full snapshot is not small — full player arrays, per-mode `modeState`, and for
some modes a per-player heatmap array. Four of those in one frame is wasteful and
could approach the cap for reasons that have nothing to do with the master board's
needs. Define a server-side projection instead:

```js
liveSummary(state) // -> { gameId, label, gameType, players: [{name, primary, secondary}],
                   //      setNo, legNo, status, updatedAt }
```

`primary`/`secondary` are deliberately generic — remaining score for X01, marks
and points for Cricket, runs for Baseball — because the master board must not
grow a per-mode renderer for every game type. That is the mistake the 2026-07
display redesign explicitly undid (every non-X01 mode shoehorned into an
X01-shaped card); the master board's answer is to show only what every mode can
state, and let the per-match board show the real thing.

**The master board never speaks** (see Voice).

### Choosing what a screen shows

Three ways in, and the third is the one that makes the other two safe.

- `?game=<id>` in the URL, parsed the way `?layout=` already is:
  `new URLSearchParams(location.search).get('layout')` in `display.html`. Same
  pattern, same place — a per-screen override that survives a reload, which
  matters for a screen that is mounted and then forgotten.
- **From the controller**: `openScoreboard()` gains the current game's id, so
  "open scoreboard" from the tablet scoring a match opens *that* match, as an
  explicit claim, with no picker at all. This is the path most people will actually
  use in the multi-board case, and it means the tournament flow is "score on this
  tablet, open its scoreboard" per board — no choosing anywhere, even though every
  screen after the first is technically pinned manually.
- **Switching match from the scoreboard itself** — see below. Available *always*,
  not only when the screen has nothing to show.

#### Switching from the scoreboard — always available

**Owner request (2026-07), and it closes a real hole in the first draft.** That
draft only offered the picker when a screen had *nothing* to show. But the whole
point of auto-follow is that the app decides for you, and an app that decides can
decide wrong — a screen that auto-followed the match on board 2 when you wanted
board 1 had no way out except editing the URL by hand on a wall-mounted TV. **If
something is chosen automatically, changing it must be easy.**

So `display.html` gains a match switcher, reachable at any time:

- **Idle-hidden, revealed on any input.** The scoreboard is a passive, chromeless
  view and a permanent "change match" button would be clutter on a screen nobody
  is touching for an hour at a time. The video-player pattern fits exactly: a small
  control appears on any tap, pointer move or keypress and fades again after a few
  seconds. Invisible while you are watching, present the moment you reach for it.
- **Two deliberate steps, never one.** Revealing the control is one interaction;
  choosing a match is a second. A spectator leaning on a mounted tablet must not
  be able to reassign the screen by accident — a single-tap switcher is a screen
  that changes match on its own in a crowded room, which is worse than no switcher.
- **The list includes "All matches."** Switching to the master view is the same
  kind of choice as switching between matches, so it belongs in the same list
  rather than needing a different URL. That also means the master board can be
  reached from any screen without anyone remembering `?master=1`.
- **The list is live and never reshuffles under a finger.** It is driven by the
  same channel data the screen is already receiving, so a match that ends while
  the picker is open becomes **disabled in place** rather than vanishing and
  shifting every row below it — the classic "the thing I was tapping moved" bug.
- **An abandoned picker closes itself.** If it is opened and not used, it times out
  and dismisses, so a half-opened overlay never sits across the darts for the rest
  of the night. Escape and a tap outside also dismiss it.
- **With exactly one match available it is still a switcher, not a list** — one
  "Show: A vs B" entry plus "All matches" (see the claim rules above).

An idle-hidden control has one obvious cost: **nobody knows it is there.** That
matters most in precisely the case this feature exists for — a screen that
auto-followed a match the viewer didn't want. So the moment a screen auto-follows
*while more than one match is active*, it shows a brief, self-dismissing hint —
"Showing A vs B · tap to change" — and then gets out of the way. Deliberately not
shown when only one match exists: there is nothing to change to, and the garage
screen should stay completely chromeless. This is the one piece of chrome the
feature genuinely needs, and it is tied to the exact condition that makes it
useful.

##### Switching upgrades an implicit claim to an explicit one

This is the subtle part, and it falls straight out of the claim model. A screen
that auto-followed holds an *implicit* claim, which is released when that match
ends so the screen is free to pick up the next game — the behaviour the garage case
depends on. **A screen that was switched by hand holds an *explicit* claim**, and
an explicit claim is held when the match ends: the screen says the match finished
and offers the switcher, rather than silently jumping to some other game.

That asymmetry is correct rather than incidental. Auto-follow is the app guessing,
so it should keep guessing. A manual switch is the viewer stating what they want to
watch, and the app should not quietly overrule that the moment the leg is over.

Mechanically a switch is just a re-subscribe, which the claim model already makes
atomic — the old claim is released and the new one taken in one step, with no
"release" route to forget to call.

##### The URL follows a manual switch, and only a manual switch

A hand-switched screen should come back to the same match after a reload, a browser
restart, or a tab restore — that is most of the value of switching on a screen you
then walk away from. So a manual switch writes `?game=<id>` into the URL with
`history.replaceState()`: same effect as having launched it that way, no reload, no
navigation entry.

Note this would be **the codebase's first use of the History API** — nothing in
`frontend/` currently touches `window.history` (the `history` identifiers in
`index.html` and `scoring.js` are local variables holding rating and dart history,
which is worth knowing before grepping for precedent and concluding there is some).
It is a plain, well-supported browser API and needs no abstraction, but it is a new
tool here rather than an established pattern. The alternative — setting
`location.search`, which reloads the page — was rejected because a reload drops the
SSE connection and blanks the board for a beat, which is a visible flicker on a
wall-mounted screen for no benefit. `replaceState` rather than `pushState`
deliberately: a scoreboard has no back-button journey, and building one would mean a
remote's Back button silently changing which match is showing.

**An auto-follow must never write the URL.** Doing so would pin the garage screen
to tonight's first game permanently, and the next game would find it claimed and
unable to follow — silently converting the one household that must never choose a
match into the one that always has to. Selecting "All matches" likewise replaces
`?game=` with `?master=1`, so that choice is equally durable.

- Consider a small "which screens are watching what" readout in Settings. Useful
  in the four-board case and cheap once `/api/live/channels` exists; genuinely
  separable, so track it separately rather than letting it hold this up.

### Voice — exactly one speaker

`display.html` announces through `SpeechSynthesis`, off by default, with a
sequential `_announceQueue` so overlapping events don't talk over each other
(`REFERENCE.md` §7). That queue is **per page**. Four boards in one room are four
pages, and the queue does nothing across them: four "One! Hundred! and! Eighty!!"
call-outs firing over each other is the predictable result.

- The **master board never announces.** Not a setting — a rule.
- Per-match boards keep today's setting-driven behaviour, and the doc should say
  plainly that in a multi-board room the household picks one board to speak.
- A `?voice=0` URL override is the cheap way to make that pickable per screen
  without a new setting.

---

## Security surface

Per `CLAUDE.md`, considered as part of the design rather than afterwards. Three
things change shape here:

- **A writer can now target any channel.** `POST /api/live` is `requireWrite`, so
  this is a household-authenticated caller, but nothing would stop a buggy (or
  malicious) controller overwriting another match's channel. Validate that
  `gameId` names a real, not-yet-completed game and reject otherwise. Binding a
  channel to a writer token is the stronger option and probably more than this
  threat model needs — note it and move on.
- **Channel count needs a cap.** This is a *new* resource-exhaustion surface:
  unbounded channels means unbounded memory and an unbounded master frame. Cap it
  (16 is far beyond any real household) and reject past it, for exactly the reason
  `MAX_SSE_TOTAL`/`MAX_SSE_PER_IP` exist. `MAX_LIVE_BYTES` stays per channel; the
  master frame needs its own, larger bound.
- **`GET /api/live/channels` widens an existing leak.** The live stream is a
  deliberately public, unauthenticated endpoint (SEC-2) — the display screen isn't
  logged in — so today an unauthenticated client on the network can already read
  the one active game's player names. A channel list makes that *all* active
  matches' names. That's a widening of an accepted gap rather than a new class of
  exposure, but it should be recorded as such in `REFERENCE.md`'s "Known, accepted
  gaps" rather than discovered later by an audit pass.
- `MAX_SSE_PER_IP = 5` may need raising: four boards opened as four tabs on one
  machine plus a master is exactly 5. Four separate devices are four IPs and fine.
  Worth a deliberate decision rather than a 503 nobody can explain.

## Accessibility

- **The master board is the hard one.** Four matches on a 1920×1080 screen means
  small text by construction. Set a minimum type size and let the grid show
  *fewer* matches (with paging or rotation) rather than shrinking below it — a
  board nobody can read from the sofa has failed at its only job.
- **Who's winning must not be colour-only.** The obvious master-board design tints
  the leader's row green. Pair it with a glyph or position, so it survives
  colourblind mode.
- **The switcher must be fully operable with arrow keys and Enter alone.** This is
  where the accessibility requirement and the hardware requirement turn out to be
  the same requirement, which is worth noticing: these screens are frequently a TV
  driven by a Chromecast, a Fire Stick or an old tablet in a stand. Some have no
  touch at all and no pointer — what they have is a remote that sends arrow keys and
  Enter. A switcher reachable only by tapping is a switcher that does not exist on
  half the screens it is for. Designing it for the remote gets keyboard operability
  for free, and vice versa.
- **The reveal must not depend on hover.** A pointer-move trigger is fine as *one*
  of the triggers, but a touch-only or remote-only screen never produces one, so any
  keypress and any tap must also reveal it.
- **A visible focus ring** meeting the suite's luminance check, and a sensible focus
  order. It appears over live content, so Escape must dismiss it — and focus must
  return to the scoreboard rather than being left on a hidden control.
- **Announce a match change** through the existing `#sr-announcer` pattern, and
  announce the switcher opening. A screen-reader user otherwise has no idea either
  the picture or the available choice changed.
- **The auto-follow hint** ("tap to change") is text, not an icon alone, and is
  announced once when it appears — an affordance nobody can perceive is not an
  affordance.

## Testing

`backend/test/`:

1. **Channel isolation** — two channels; a subscriber to A never receives a frame
   from B. The core property.
2. **Back-compat** — one channel, no URL params: a no-param subscriber receives
   exactly what today's subscriber receives, and a push with no `gameId` still
   reaches it. This is the test that protects requirement 2 and it should be
   written before the refactor, against the current server, so it is known to pass
   beforehand.
3. **Claim rules** — the owner's decision, and the largest group here because the
   whole feel of the feature is in it:
   - a no-param subscriber with no claims outstanding and one active match
     auto-follows it;
   - it does *not* switch when a second match appears;
   - a second no-param subscriber, arriving while that claim is held, is told to
     show the picker rather than auto-following;
   - a no-param subscriber connecting when **two** matches are already active and
     unclaimed also gets the picker (the case the rule's wording doesn't cover);
   - `?master=1` takes no claim, so a connected master board does **not** cause the
     next screen to be sent to the picker;
   - an explicit `?game=` subscriber holds its match when that match ends, rather
     than adopting another.
4. **The garage regression, asserted directly** — the reason the rule exists, and
   the one most likely to break silently later. Play a game with one auto-following
   screen; end it; start another; assert the screen auto-followed again with no
   picker. Then repeat the whole sequence **after opening and closing a second
   screen**, to prove a departed screen left no claim behind. A leaked claim would
   turn "never choose a game you only have one of" into "choose a game forever
   after," and nothing else in this list would notice.
5. **Switching** — the owner's addition, and the half of it that is server-side:
   re-subscribing releases the old claim and takes the new one, with no window in
   which a screen holds two or none; a screen that switches by hand ends up holding
   an **explicit** claim even if it arrived with an implicit one, so its new match
   ending leaves it on the switcher rather than auto-following something else; and
   switching to `?master=1` releases the claim entirely, so the next screen to
   connect can auto-follow again.
6. **Expiry** — a channel with no push past the TTL disappears from
   `/api/live/channels`; an explicit `DELETE` removes it immediately; an
   `active:false` push closes it; a channel closing releases the implicit claim on
   it.
7. **Caps** — channel-count cap rejects past the limit; master frame stays under
   its own byte bound with the maximum number of channels at their largest
   plausible summary.
8. **`liveSummary()` projection** — correct `primary`/`secondary` for every game
   type in the registry, driven off `GAME_TYPES` rather than a hand-kept list, so
   a new mode arrives covered. `noLiveDisplay` modes never appear.

Browser (`.claude/skills/verify-ui`): drive two games in two pages, open two
displays, assert each shows its own match and neither flickers; assert the master
shows both; assert a no-param display with one game is unchanged. The switcher needs
its own assertions here, because all of it is behaviour that only exists once a
browser has laid the page out: it is **hidden until an input arrives** and revealed
by a keypress as well as a tap; it takes **two interactions** to change match, never
one; **arrow keys and Enter alone** can complete a switch (the remote-control path,
which a mouse-driven check would never exercise); a manual switch **writes `?game=`
via `replaceState`** while an auto-follow leaves the URL untouched; and an abandoned
switcher **dismisses itself**. Raise the
check's assertion count in `run.js` in the same commit.

## Suggested build order

Each step is independently shippable and leaves the app working.

1. **Add `gameId` to `liveSnapshot()` and `ALLOWED_LIVE_KEYS`.** Inert — still one
   channel, still one slot. Ships alone, changes nothing.
2. **Write the back-compat test (Testing 2) against the current server** and watch
   it pass. It is worth much more before the refactor than after.
3. **Channel map on the server**, with the `'default'` fallback. Back-compat test
   still green. At this point two games no longer fight, even though nothing can
   yet *choose* the second — a no-param screen simply follows the one channel.
4. **The claim registry** — `liveClients` becomes `Map<res, {claim, kind}>`, claims
   released by the existing close handler, and the auto-follow-vs-picker decision
   sent to the connecting screen. Ships with Testing 3 and 4. This is the step that
   implements the owner's rule, and the step where a leaked claim would first be
   able to break the garage case, so **Testing 4 lands here, not later.**
5. **`GET /api/live/channels`, expiry sweep, `DELETE`, and the caps.**
6. **`?game=` in `display.html`, plus `openScoreboard()` passing the current id.**
   The URL and controller routes in, with no on-screen UI yet.
7. **The on-screen switcher** — idle-hidden reveal, the two-step choice, the live
   list, the `replaceState` URL write on manual switches only, the implicit→explicit
   upgrade, and the auto-follow hint. Its own step rather than a bullet on step 6,
   because it is where all of the fiddly interaction lives (reveal triggers, remote
   operability, self-dismissal) and it is the safety net for auto-follow guessing
   wrong. Requirement 3 is fully met here, and steps 1–7 are a complete, useful
   feature without the master board.
8. **The master board** (`?master=1`, `liveSummary()`, the aggregate stream).
   It also becomes reachable from the switcher's "All matches" entry, so this step
   adds one row to a list step 7 already built.
9. **Voice rules and the accessibility pass.**
10. **Audit for other single-active-game assumptions.** Grep the frontend for
   places that assume one live game — the achievement broadcast path, the Home
   ticker, any Settings readout. This step exists because the assumption is
    plausibly wider than the live channel, and finding out during step 8 is worse
    than looking on purpose.

Steps 1–7 and step 8 are separately trackable, and should be split into two
tracker rows the moment either ships — per `CLAUDE.md`, never one "partially
completed" item.

## Open questions

1. ~~**Should a second scoreboard auto-adopt the second game?**~~ **Answered by the
   owner (2026-07): no — manual pinning, but only once some screen already holds a
   match.** A screen auto-follows while nothing is claimed, so the single-game
   household never chooses; once a claim exists, the next screen is pinned
   deliberately. Designed out in full under "Which match a screen shows — claims,"
   including the consequence the answer carries: claims are cross-screen state, so
   the server now tracks them, which the original client-side latch did not need.
2. **Does the master board need to be `/display?master=1`, or its own page?** One
   page means shared plumbing (transport, reconnect, escaping, orientation) but
   the render paths have almost nothing in common. A separate page duplicates the
   transport; a shared one risks a large `if (master)` seam through
   `display.html`'s render. Lean towards extracting the transport into something
   both use rather than picking either horn.
3. **How should the master label matches?** Tournament matches have a natural
   label (round + players) via `tournament_matches`; a casual concurrent game has
   only players and category. Falling back to "A vs B — 501" is fine, but it means
   the master board's labelling code needs the tournament join, which is the only
   place this feature touches tournament code at all.
4. **Should the TTL be per game type?** A Marathon session pushes constantly; a
   between-legs pause in a slow match is longer. One conservative TTL is simpler
   and probably right — noted only so the next person knows it was considered.
5. **Is four the real ceiling?** The channel cap and the master grid's layout both
   want a number. Four matches suits a household bracket; the cap should be well
   above it, but the *grid* should be designed for 2–4 and degrade honestly past
   that rather than shrinking indefinitely.
