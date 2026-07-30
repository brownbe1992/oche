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
| `POST /api/live` | body gains `gameId`; writes `liveChannels[gameId]`, broadcasts to that channel's subscribers **and** to master subscribers. A body with no `gameId` writes channel `'default'` (see back-compat). |
| `GET /api/live` | unchanged shape when one channel exists; `?game=<id>` selects one. Kept because `display.html`'s polling fallback uses it. |
| `GET /api/live/stream` | **no param — today's behaviour** (see back-compat). |
| `GET /api/live/stream?game=<id>` | that channel only. |
| `GET /api/live/stream?master=1` | one stream carrying the summary of every channel. |
| `GET /api/live/channels` | the picker's list: `[{gameId, label, players, gameType, updatedAt}]`. |
| `DELETE /api/live?game=<id>` | explicit teardown at game end (`requireWrite`). |

`gameId` **must be added to `ALLOWED_LIVE_KEYS`** or the server will silently
strip it and every push will land in `'default'` — a plausible-looking wrong
picture with no error anywhere. That exact sync point has shipped two bugs
already (`docs/bug-roadmap.md` BUG-28's seven keys, then
`killerLives`/`checkoutLadder*`), which is why `modeState` exists to avoid it for
per-mode fields. This is a top-level key, so it needs the entry.

### Backwards compatibility — requirement 2, and the part most likely to be got wrong

"Ideally nothing would change if only one game is active" is a real constraint,
not a nicety: there is a screen on a wall that currently works.

- **A no-param `/display` with one active channel behaves exactly as today.** The
  no-param stream latches onto the single active channel and follows it.
- **When a second channel appears, a latched screen does not switch.** It keeps
  showing the match it is already showing, and surfaces a small, ignorable "2nd
  match available" affordance. Yanking the picture out from under a wall-mounted
  TV because someone across the room started a game is the obvious failure mode
  of a naive "always show the newest" rule, and it is worse than doing nothing.
- **A no-param screen that starts with *zero* channels** and then sees exactly one
  appear latches onto it — that is today's behaviour for the ordinary "turn the TV
  on, then start a game" order, and it must not regress into "now you have to pick
  something."
- **An un-upgraded controller** (a cached tab pushing with no `gameId`) writes
  `'default'` and still drives a no-param screen. Old client, old behaviour.

The assertion that protects all of this: with one game and no URL parameters
anywhere, the observable behaviour is byte-identical to today. Write that test
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
  reconnecting screens must re-latch gracefully rather than show an error, and a
  controller should re-push its full snapshot on reconnect rather than waiting for
  the next dart.

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
- **An on-screen picker** when more than one channel is active and the screen
  isn't pinned. Rendered from `GET /api/live/channels`, must be keyboard-operable,
  and needs to be dismissible — a spectator screen showing a modal over the darts
  is worse than showing the wrong match.
- **From the controller**: `openScoreboard()` gains the current game's id, so
  "open scoreboard" from the tablet scoring a match opens *that* match. This is
  the path most people will actually use and it should require no choosing at all.
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
3. **Latch behaviour** — a no-param subscriber latched onto A does *not* switch
   when B appears; a no-param subscriber that connected with zero channels *does*
   latch onto the first to appear.
4. **Expiry** — a channel with no push past the TTL disappears from
   `/api/live/channels`; an explicit `DELETE` removes it immediately; an
   `active:false` push closes it.
5. **Caps** — channel-count cap rejects past the limit; master frame stays under
   its own byte bound with the maximum number of channels at their largest
   plausible summary.
6. **`liveSummary()` projection** — correct `primary`/`secondary` for every game
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
3. **Channel map on the server**, with the `'default'` fallback and the no-param
   latch. Back-compat test still green. At this point two games no longer fight,
   even though nothing can yet *choose* the second.
4. **`GET /api/live/channels`, expiry sweep, `DELETE`, and the caps.**
5. **`?game=` in `display.html`, plus `openScoreboard()` passing the current id.**
   Requirement 3 is met here, and steps 1–5 are a complete, useful feature without
   the master board.
6. **The master board** (`?master=1`, `liveSummary()`, the aggregate stream).
7. **Voice rules and the accessibility pass.**
8. **Audit for other single-active-game assumptions.** Grep the frontend for
   places that assume one live game — the achievement broadcast path, the Home
   ticker, any Settings readout. This step exists because the assumption is 
   plausibly wider than the live channel, and finding out during step 6 is worse
   than looking on purpose.

Steps 1–5 and step 6 are separately trackable, and should be split into two
tracker rows the moment either ships — per `CLAUDE.md`, never one "partially
completed" item.

## Open questions

1. **Should a second scoreboard auto-adopt the second game?** The design above
   deliberately doesn't (a latched screen holds its match), on the grounds that a
   mounted TV changing itself is worse than one that needs a tap. But in the
   four-board tournament case, walking to each screen to point it at a match is
   real friction. A middle option: a screen that has *never* been pinned adopts the
   newest unwatched channel, while a pinned one never moves. Worth deciding before
   step 5, since it is the difference between the tournament case being pleasant
   and being a chore.
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
