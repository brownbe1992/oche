# Saved Games (Pause & Resume) — Design Roadmap

> Status: **design phase, not started.**
>
> Product decisions below marked **[decided 2026-07]** were confirmed
> explicitly with the product owner before this doc was written — they are
> settled, not recommendations to re-litigate.

## Goal

Pause an in-progress game and come back to it later. Playing someone and
need to stop? Save the game; the app returns to the New Game screen, and
you're free to start other H2H matches against other people or new practice
sessions while it waits. Starting a new game that matches a saved one
prompts you to **resume or abandon** it; resuming takes both players back to
exactly where they left off — same leg, same scores, same thrower.

## Scope — what's savable

- **Any H2H game**, any game type (X01, Cricket, Baseball today; Killer
  when `docs/game-modes-roadmap.md`'s item ships — its design should treat
  savability as a requirement, not a retrofit). Any participant count the
  mode allows, not just 2 — "matchup" below always means the game's exact
  participant set.
- **Solo practice games** (exactly one player): X01, Cricket, Baseball,
  guided Around the Clock, guided Around the World. (Around the World's
  progress is lifetime-cumulative with no round state, so saving one
  restores little beyond the open session — included anyway for
  consistency, and it costs nothing extra since it's the degenerate case of
  the same mechanism.)
- **Tournament matches and league fixture games** — normal H2H games under
  the hood — **are savable [decided 2026-07]**: the bracket/fixture simply
  stays waiting on the unfinished match, and resuming continues it
  (`tournamentMatchId` / fixture linkage restored with the rest of the
  state). Abandoning a saved *tournament* match can't just orphan the
  bracket — the abandon flow for a tournament-linked save routes the admin
  to the existing walkover control (`recordWalkover()`), the same answer
  `askEndGame()` already gives for quitting a live tournament match.
- **Not savable** (each has a reason, not an oversight): **Daily Challenge**
  (one attempt per calendar day is the whole format — pausing indefinitely
  would defeat it), **Ghost mode** (the opponent is a replay with its own
  in-memory script position; racing is inherently one sitting), **Doubles
  Practice / Just Chuckin' It / Checkout Trainer** (open-ended solo drills
  with no meaningful "position" to return to — ending and starting fresh
  loses nothing; Chuckin and Checkout Trainer sessions are their own unit
  for session-scoped stats/badges, which pausing would muddy).

## Design

### Schema — a context table, never a boolean on `games`

Per `CLAUDE.md`'s standing convention (`tournament_matches.game_id` /
`league_fixtures.game_id` precedent):

```sql
CREATE TABLE IF NOT EXISTS saved_games (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id   INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  saved_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

That's the whole table. "This game is paused" is the only new fact;
everything needed to resume is **derived from the turns/darts already
recorded live** (see Resume below), matching this schema's standing
"nothing pre-aggregated, derive at read time" philosophy. No snapshot blob,
no schema-versioned client state to drift. A `state_json` column was
considered and rejected for v1 — every current game type's position is a
pure function of its recorded turns; if a future type genuinely isn't
(Killer should verify this during its own design — lives are per-dart
derivable, so it likely is), a nullable column can be added then.

Standing-rule follow-through in the same change that creates the table:
add `savedGames` to `getFullDatabaseExport()`; `wipeAllData()`/`resetStats()`
are covered for free (`game_id ON DELETE CASCADE` off the games wipe), noted
in their comments. The **per-player portable export**
(`getPlayerExport()`) deliberately does NOT carry saved-game rows — a pause
is local workflow state, not portable history; an imported incomplete game
simply arrives unsaved (its stats intact), same as any other incomplete
game.

### One saved game per matchup **[decided 2026-07]**

At most one saved game per **(exact participant set, game type)** — the
participant-set key is what the product decision named ("one per matchup");
scoping it per game type as well is the natural reading once solo saves
exist (a solo player with a paused practice X01 shouldn't be blocked from
also pausing an Around the Clock; for the canonical two-player case it
changes nothing, since the resume prompt below is keyed the same way).
Saving a second game for an already-occupied slot prompts: *"You already
have a saved 501 game with Alaina from July 3rd — abandon it and save this
one instead?"* — never silently replaces, never stacks.

### Saving

A **"⏸ Save for later" button on the scoring screen, visible in both Pad
and Dartboard input modes** (it lives with the header/turn actions, not
inside either input widget, so both modes get it for free — the same
placement reasoning as "End game"). Only rendered when the current game is
eligible per Scope above.

On save (`POST /api/games/:id/save`, `requireWrite`, inserts the
`saved_games` row):

- **Staged, un-submitted darts are discarded [decided 2026-07]** — only
  committed turns are stored server-side today, and resume puts the thrower
  back at the start of the interrupted visit with an empty slot row. Nobody
  loses more than a partial visit, and no new "uncommitted client state"
  storage mechanism is needed. The confirm dialog says so: *"Save this game
  for later? The 2 darts of the current turn haven't been entered and won't
  be kept."*
- The client clears `game`, pushes an **inactive live snapshot** (so a TV
  on `/display` stops showing the paused match — same reasoning as
  `askEndGame()`'s existing `pushLive()`), and returns to the New Game
  screen.
- Saving is idempotent-safe: saving an already-saved game id is a no-op
  200, not an error (double-tap protection).

### Where saved games surface **[decided 2026-07: prompt + list]**

1. **The resume prompt** — when the New Game wizard's Start would create a
   game whose (participant set, game type) matches a saved game, a modal
   interrupts: *"Ben & Alaina already have a saved 501 game from July 3rd
   (Ben leads 2–1). **Resume it**, **abandon it and start fresh**, or
   cancel?"* Checked at Start time (not buried in step 1) so it sees the
   final participant set and game type. The check reuses the same
   endpoint the list below uses — no bespoke lookup.
2. **A "Saved games" list** — a section on the New Game screen (step 1,
   above the player slots — visible before any setup effort is spent) shown
   only when at least one saved game exists, listing each with players,
   game type/format, a one-line position summary (legs/sets or points), and
   saved date, with **Resume** and **Abandon** buttons per row. This is how
   a forgotten save stays findable without recreating the exact matchup.
   `GET /api/saved-games` returns everything the list and the prompt both
   need.

### Resuming — replay, not snapshot

`GET /api/games/:id/resume-state` returns the game row + every committed
turn (with darts) in order — the same data shape `getGhostLegScript()`
already proves is faithfully replayable, extended from one leg to the whole
game. The client rebuilds the live `game` object by **feeding each recorded
turn back through the same `GAME_TYPES` engine functions that scored it
live** (`evaluateVisit` / `evaluateVisitCricket` / `evaluateVisitBaseball` /
`evaluateDartAroundTheClock`), then re-derives:

- remaining scores / Cricket marks+points / Baseball innings+runs per
  player, legs and sets won, current set/leg numbers;
- **whose turn it is** — deterministic from the turn sequence plus the same
  leg-starter rotation `startNextLeg()` applies live (replay literally
  calls the same code, so it can't disagree);
- game-type extras: X01 checkout hints re-render from the rebuilt scores;
  Around the Clock's current-round `hitSet` rebuilds from the current
  round's darts.

`DB.gameId` is pointed back at the existing game id, so `recordTurn()`
appends to the same game; the `saved_games` row is **deleted at resume**
(the game is simply live again — pausing again just re-saves). The live
scoreboard picks the match back up on the next `pushLive()`. A resumed
tournament match restores its `tournamentMatchId` (from
`tournament_matches.game_id`) so completion advances the bracket exactly as
if never paused; league-fixture games need nothing special (the fixture
already points at the game id).

**What resume deliberately does NOT rebuild** (cosmetic, session-scoped,
already lost today by a page refresh mid-game): past-leg summary cards
(`game.legSummary`), the one-level undo snapshot (undo is unavailable for
the first turn after resume — same as the first turn of any game), and
voice-announcement/celebration state. Worth stating so nobody files these
as bugs.

**Divergence guard**: resume re-checks that the game is still incomplete
and still saved before rehydrating (two devices could race); a 409-style
"already resumed/completed elsewhere" message beats silently double-driving
one game from two controllers.

### Abandoning

Abandon (from the prompt or the list) deletes the `saved_games` row and
nothing else — the game stays a permanently incomplete `games` row.
**Stats recorded during it are kept** (explicit product requirement,
matching `askEndGame()`'s existing behavior for quitting live games: "a
game that never reached completion", not an erased one). Abandoning a saved
*tournament* match instead routes to the bracket/walkover flow per Scope
above. `DELETE /api/saved-games/:id` (or `?gameId=`), `requireWrite`, with
a `uiConfirm()` spelling out that the game can't be resumed afterward but
its stats remain.

### Interactions with existing features (checked, not guessed)

- **Player deletion**: `deletePlayer()` gains a guard (via the existing
  `registerDeletePlayerGuard` mechanism) refusing to delete a player who's
  in a saved game — the admin abandons it first. Cheaper and louder than
  auto-abandon side effects buried in a delete.
- **Player merge** (`docs/archive/player-merge-roadmap.md`): a saved game
  between source and target is a *shared game* and already blocks the
  merge. A saved game against a third player just follows its `games` row
  through the reassignment — but the merge could create a situation where
  target now has TWO saved games for the same (participants, game type)
  slot; the merge preview/blockers need a check for that collision (block,
  consistent with every other "shared row" case).
- **Backups/restore**: nothing special — `saved_games` rides along in the
  SQLite file like every other table.
- **`getSummary()`/stats**: no changes — an incomplete-but-saved game's
  turns already count exactly like any other incomplete game's (they were
  recorded live as they happened).

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility**: the Save button is icon + text ("⏸ Save for later"),
  never icon-only; the resume prompt is a real modal with a heading and
  three clearly-labeled actions (Resume / Abandon & start fresh / Cancel) —
  not color-coded buttons alone; resuming announces the restored position
  via the existing `announce()` aria-live channel ("Resumed — set 1 leg 3,
  Ben to throw, 220 left."); the Saved Games list rows are navigable
  headings/buttons, not click-anywhere divs.
- **Security**: no new credential/token surface. Save/resume/abandon are
  `requireWrite` (same tier as recording turns — pausing is gameplay, not
  admin surgery); the resume-state endpoint exposes only data already
  readable via existing stats endpoints. The one thing worth care:
  `POST /api/games/:id/save` must verify the game exists, is incomplete,
  and is an eligible type server-side — never trust the client's
  eligibility check.
- **Testing**: the replay rebuild is exactly what `CLAUDE.md`'s
  every-new-calculation rule targets — committed tests must prove, for
  every savable game type, that a game played to some mid-point, saved, and
  rehydrated produces **identical state to never having paused** (scores,
  marks, innings, legs/sets, current thrower — including across a leg
  boundary and a set boundary, and the leg-starter rotation). Plus the
  one-per-slot constraint, the resume prompt trigger (exact participant-set
  match, order-independent), abandon leaving stats intact, the
  tournament-match resume advancing its bracket on completion, the
  player-deletion guard, the merge-collision block, and the
  two-device divergence guard. End-to-end: a real browser pause/resume in
  BOTH input modes (the button must work from Pad and Dartboard alike).

## Suggested build order

1. `saved_games` table + save/abandon endpoints + full-database-export
   wiring, proven with direct API tests before any UI.
2. Resume-state endpoint + the client replay rebuild for **X01 only**,
   with the state-equivalence tests above — X01 has the most derived state
   (checkout hints, leg/set rotation) and proves the pattern.
3. The Save button (both input modes), the New Game resume prompt, and the
   Saved Games list.
4. Cricket, Baseball, Around the Clock, Around the World replay rebuilds —
   each is the same pattern with a smaller state surface.
5. Tournament/league-fixture linkage restore + the walkover-routed abandon.
6. Guards: player-deletion, merge collision, two-device divergence.
7. Killer, when it ships, treats savability as part of its own definition
   of done (`docs/game-modes-roadmap.md` item 12b should reference this).

## Open questions for whoever picks this up

- **Expiry/limits**: saved games currently persist indefinitely with no
  cap. Fine for a household roster; revisit only if the Saved Games list
  ever becomes cluttered in practice (a "saved N months ago" hint in the
  list is probably enough).
- **Resume prompt scope**: keyed on (exact participant set, game type). A
  saved 501 between Ben & Alaina does NOT prompt when they start a Cricket
  game — the list keeps it findable. If real use shows people expecting
  any-same-players to prompt, widen the trigger; starting narrow avoids
  nagging.
- Whether the Home page should also tease saved games ("⏸ 2 games waiting")
  alongside its other teasers — nice-to-have, not v1.
