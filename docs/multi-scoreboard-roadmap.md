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
| **Explicit** | `?game=<id>`, or picked from the picker | held; the screen says the match finished and offers the picker | **yes** |

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

- `?game=<id>` in the URL, parsed the way `?layout=` already is:
  `new URLSearchParams(location.search).get('layout')` in `display.html`. Same
  pattern, same place — a per-screen override that survives a reload, which
  matters for a screen that is mounted and then forgotten.
- **An on-screen picker** whenever the screen isn't showing a match and can't
  auto-follow one — i.e. another screen already holds a claim, or more than one
  match is unclaimed. Rendered from `GET /api/live/channels`, keyboard-operable,
  and dismissible: a spectator screen showing a modal over the darts is worse than
  showing the wrong match. **With exactly one option it renders as a single "Show:
  A vs B" button rather than a list** (see the claim rules above).
- **From the controller**: `openScoreboard()` gains the current game's id, so
  "open scoreboard" from the tablet scoring a match opens *that* match, as an
  explicit claim, with no picker at all. This is the path most people will actually
  use in the multi-board case, and it means the tournament flow is "score on this
  tablet, open its scoreboard" per board — no choosing anywhere, even though every
  screen after the first is technically pinned manually.
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
- **The picker** needs keyboard operability, a visible focus ring meeting the
  suite's luminance check, and a sensible focus order — it appears over live
  content, so it must also be dismissible by Escape.
- **Announce channel changes** through the existing `#sr-announcer` pattern when a
  screen switches match, or a screen-reader user has no idea the picture changed.

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
5. **Expiry** — a channel with no push past the TTL disappears from
   `/api/live/channels`; an explicit `DELETE` removes it immediately; an
   `active:false` push closes it; a channel closing releases the implicit claim on
   it (renumbering the rest of this list).
6. **Caps** — channel-count cap rejects past the limit; master frame stays under
   its own byte bound with the maximum number of channels at their largest
   plausible summary.
7. **`liveSummary()` projection** — correct `primary`/`secondary` for every game
   type in the registry, driven off `GAME_TYPES` rather than a hand-kept list, so
   a new mode arrives covered. `noLiveDisplay` modes never appear.

Browser (`.claude/skills/verify-ui`): drive two games in two pages, open two
displays, assert each shows its own match and neither flickers; assert the master
shows both; assert a no-param display with one game is unchanged. Raise the
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
6. **`?game=` in `display.html`, the picker, plus `openScoreboard()` passing the
   current id.** Requirement 3 is met here, and steps 1–6 are a complete, useful
   feature without the master board.
7. **The master board** (`?master=1`, `liveSummary()`, the aggregate stream).
8. **Voice rules and the accessibility pass.**
9. **Audit for other single-active-game assumptions.** Grep the frontend for
   places that assume one live game — the achievement broadcast path, the Home
   ticker, any Settings readout. This step exists because the assumption is
   plausibly wider than the live channel, and finding out during step 7 is worse
   than looking on purpose.

Steps 1–6 and step 7 are separately trackable, and should be split into two
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
