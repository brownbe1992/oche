# New Game Page Revamp — Design Roadmap

> Status: **design phase, not started**. This doc captures the user's requested
> flow for a less-crowded, more interactive New Game page and grounds it in the
> current implementation (`frontend/index.html`'s `#screen-setup`) so whoever
> picks this up can see exactly what changes and what doesn't.

## Goal

Replace today's single, all-controls-visible New Game screen with a short,
step-by-step interactive flow — "Who's playing?" → "Choose a game" → "More
options" → Play — so a player only ever sees the controls relevant to what
they've already chosen, instead of the full stack of sections at once.

## Current state (what this replaces)

`#screen-setup` (`frontend/index.html`, lines ~700-885) is one card holding
every control simultaneously, shown/hidden via CSS `hidden` toggles driven by a
single global `setup` state object. Concretely, today's stack is:

1. **Players** — `#players-list`: each of `setup.slots` is its own always-visible
   `<select class="pselect">` row (`renderPlayers()`), with a persistent
   "+ Add player" control (`toggleAddPlayerMenu()` → "Add existing"/"New
   player") and a 6-player cap.
2. **Game type** — `#game-type-section`: a segmented X01/Cricket toggle
   (`setGameType()`), separate from the Mode row below it.
3. **Starting score** — `#start-score-section`: a `<select id="start-score-
   select">` (501/301/170/101, `pickStartSelect()`), always visible whenever
   X01 is the game type.
4. **Cricket targets** — `#cricket-options-section`: classic/custom toggle +
   21-button grid, exact-7 validation (`setCricketPreset()`).
5. **Mode** — one 5-button segmented row: H2H, Practice, 🎯 Daily Challenge,
   👻 Ghost, 🧮 Checkout Trainer (`setMode()`).
6. **Practice type** — `#practice-type-section`, a *second*, nested 5-button
   sub-toggle only shown when Practice-family is active: Practice, Doubles
   Practice, Just Chuckin' It, Around the Clock, Around the World.
7. Up to seven more mode-specific sections (`#challenge-info-section`,
   `#ghost-options-section`, `#doubles-options-section`, `#chuckin-info-
   section`, `#checkout-trainer-options-section`, `#clock-info-section`,
   `#world-info-section`) — each a `hidden`-by-default block.
8. **Format** — `#h2h-options`: legs/sets presets + steppers, shown for H2H
   only.
9. **Start Game** button → `startGame()`.

There's already *some* progressive disclosure (10+ conditionally-hidden
sections), but nothing collapses once shown — depth only grows as choices
narrow, and Mode is split awkwardly across two separate toggle rows plus a
third standalone X01/Cricket toggle, rather than one place to pick "what am I
playing." Only 4 of the ~11 selectable modes (Just Chuckin' It, Checkout
Trainer, Around the Clock, Around the World) currently show any "how to play"
explanation — the rest (H2H, Practice, X01, Cricket, Doubles Practice, Daily
Challenge, Ghost) show none.

## Proposed flow

A three-step wizard, replacing the single stacked card. Each step's controls
replace the previous step's on screen (not accumulate) — the crowding problem
being solved is exactly today's "everything stays visible forever" behavior.

### Step 1 — "Who's playing?"

- A dropdown to select a player (reuses the existing player-list data source
  `renderPlayers()` already draws from — this is a UI-flow change, not a new
  data source).
- Once one is selected, ask **"Add someone else?"** with three buttons:
  **Add existing**, **Add new**, **No, continue** — reusing the existing
  `addExistingPlayer()`/`addNewPlayer()` handlers, just re-triggered from this
  prompt instead of a persistent "+ Add player" control. Repeats (select →
  "add someone else?") until "No, continue" is pressed or the existing
  6-player cap is hit.
- Modes that force a single player today (Daily Challenge, Ghost, Doubles
  Practice, Just Chuckin' It, Checkout Trainer, Around the Clock/World) aren't
  chosen yet at this point in the new flow — see the open question below on
  sequencing, since today those are *mode* choices that happen to imply
  exactly 1 player, and Step 1 now comes first.

### Step 2 — "Choose a game"

- **Player-count-driven default**: with exactly one player selected, default
  to Practice and label the step **"Practice Mode"** rather than showing an
  H2H/Practice chooser at all (H2H structurally requires 2+ players, so
  there's nothing to choose between with only one).
- **One flat dropdown of every game type**, replacing today's three separate
  controls (Mode row + Practice-type sub-toggle + X01/Cricket segmented
  toggle) with a single list: **Daily Challenge** (listed first, but only
  when not already attempted today — reuses the existing
  `/api/challenges/status` check `startGame()` already makes, just moved
  earlier so the dropdown can conditionally omit/reorder it instead of
  discovering "already played" only after the player commits), **X01**,
  **Cricket**, **Just Chuckin' It**, **Doubles Practice**, **Ghost Mode**,
  and an **"other game modes"** group for the rest (Checkout Trainer, Around
  the Clock, Around the World).
- **X01 flavor**: selecting X01 reveals a second dropdown — 501/301/170/101 —
  the same four values `#start-score-select`/`pickStartSelect()` already
  offer, just surfaced conditionally instead of always-visible.
- **How-to-play blurb**: after picking a game type, show a brief explanation
  of how to play it. Today this exists for only 4 modes (Chuckin/Checkout
  Trainer/Clock/World's `-info-section` blocks); this generalizes the same
  pattern to *every* mode, including the ones that currently have none (X01,
  Cricket, Doubles Practice, Daily Challenge, Ghost, and H2H/Practice
  generally) — new copy needs writing for each.
- A **Continue** button advances to Step 3.

### Step 3 — "More options"

- **Practice games**: mode-specific extras surface here — Checkout Trainer's
  Freeform vs. Checkout Blitz toggle plus its four difficulty tiers (Under 40
  / Under 100 / Over 100 / Full Range, already shipped per
  `docs/checkout-trainer-roadmap.md`), Ghost's leg picker
  (`#ghost-options-section`), Doubles Practice's target multi-select
  (`#doubles-options-section`), and Cricket's classic-vs-custom picker
  (`#cricket-options-section`) when the practice game is Cricket.
- **H2H games**: Cricket's classic-vs-custom picker (same control, shared
  with practice per above — not a second implementation) plus the
  legs/sets-per-game Format controls (`#h2h-options`'s presets + steppers),
  which stay H2H-only exactly as they are today.
- A **Play Now** button (renamed from today's "Start Game") replaces
  `#start-btn`, wired to the existing `startGame()` — its validation logic
  (slot-fill checks, Cricket exact-7, Ghost leg required, Doubles Practice
  ≥1 target, H2H ≥2 players, Daily Challenge same-day-duplicate check) is
  reused as-is; only the surrounding screen structure changes, not what gets
  validated or what `game` object gets built.

## What doesn't change

- **No data model impact.** `setup`'s shape, `startGame()`'s validation, and
  the `game` object it builds (via `GAME_TYPES[gameType].newMatchPlayer(...)`)
  stay the same — this is purely a restructuring of *when/how* the existing
  controls are shown, not a change to what data New Game collects or sends.
  No `games`/`config` schema changes, no new API endpoints.
- **No change to any individual control's own logic** — Cricket's exact-7
  validation, Checkout Trainer's difficulty tiers, Ghost's leg-picker data
  source, the 6-player cap, and `startGame()`'s per-mode checks all carry over
  unmodified; only their surrounding screen/step changes.

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility**: a multi-step wizard raises new concerns beyond today's
  single static page — focus must move to each new step's first control as it
  appears (not silently stay on a now-hidden Step 1 button), step changes need
  an `aria-live` announcement so screen-reader users know the screen advanced,
  and there must be a way to go back a step without losing already-entered
  data (see open question below). The "how-to-play" blurbs are plain text and
  accessible by default as long as they're real DOM content read in document
  order, not an overlay/tooltip that needs hover.
- **Security**: no new credential/token surface — reuses the existing New Game
  flow's auth/player-selection model untouched.
- **Testing**: this is a UI restructuring with no new calculations, so it
  doesn't trigger `CLAUDE.md`'s "every new calculation gets a committed test"
  rule directly — but the *existing* `startGame()` validation paths this
  reuses (Cricket exact-7, H2H ≥2 players, Doubles Practice ≥1 target, etc.)
  should get Playwright coverage of the new step-by-step path specifically,
  since a wizard restructuring is exactly the kind of change that can
  silently break a validation path that used to be reachable and now isn't
  wired up from the new screen.

## Open questions for whoever picks this up

- **Sequencing conflict**: today, several modes (Daily Challenge, Ghost,
  Doubles Practice, Checkout Trainer, Around the Clock/World) force exactly 1
  player as a *side effect* of the mode choice. The new flow asks "who's
  playing" *before* "choose a game," so picking 2+ players first and then one
  of those single-player-only modes second is a real conflict this doc
  doesn't resolve — does choosing such a mode in Step 2 silently drop extra
  players back to 1 (surprising, loses what was just entered), or does Step 2
  simply not offer those modes once 2+ players are already selected?
- **"Other game modes" grouping**: confirmed to include Checkout Trainer and
  Around the Clock/World, based on today's implementation — but should this
  be a flat sub-list in the same dropdown, a nested "more..." option, or its
  own secondary dropdown? Not specified in the original notes.
- **Back navigation**: can a player go back from Step 2 to Step 1 (e.g. to add
  a player after seeing what game types are available), or from Step 3 back
  to Step 2? The notes describe only forward progression (Continue, Play Now).
  If back navigation exists, it must preserve prior selections, not reset them.
- **H2H entry point**: the notes specify "for one player, default to
  practice," but don't say how H2H gets chosen once 2+ players are selected —
  is it still an explicit choice in Step 2's dropdown (an "H2H" entry
  alongside the game types), or does selecting 2+ players in Step 1
  automatically imply H2H unless a practice-only mode is chosen in Step 2?
  Needs a decision, not an assumption.
- **Daily Challenge ordering data fetch**: showing Daily Challenge "first, if
  not already attempted" means Step 2's dropdown needs the same-day-attempt
  check *before* rendering, not just at Play Now time as today — is that
  check made once when Step 2 first loads, or re-checked live (e.g. if the
  session spans midnight)?
- **League picker / H2H banner**: today's `#league-picker-wrap`/`#h2h-banner`
  live inside the Players section — which step do they belong to in the new
  flow, Step 1 (players) or somewhere in Step 2/3 (since league-tagging is
  really a property of the *match*, not the roster)?

## Suggested build order

1. Build the wizard shell (step container + Continue/Play Now/back
   navigation, focus management, `aria-live` step announcements) without
   changing any control's own behavior yet.
2. Move Step 1 (Who's playing?) into the new shell, converting the
   always-visible player rows into the select → "add someone else?" prompt
   loop.
3. Move Step 2 (Choose a game) in: collapse the Mode row + Practice-type
   sub-toggle + X01/Cricket toggle into one dropdown, add the X01-flavor
   second dropdown, and write the missing how-to-play copy for every mode
   that doesn't have it yet.
4. Move Step 3 (More options) in: relocate each mode's existing options
   section under the new step, resolving the classic-vs-custom Cricket
   sharing between practice and H2H.
5. Wire Play Now to the existing `startGame()`, then Playwright-test the full
   new path per mode (X01 H2H, X01 practice, Cricket both variants, Doubles
   Practice, Just Chuckin' It, Ghost, Daily Challenge, Checkout Trainer,
   Around the Clock/World) to confirm no validation path regressed.
