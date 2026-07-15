# New Game Page Revamp — Design Roadmap

> Status (2026-07): **Shipped.** The 3-step wizard (Who's playing? → Choose a
> game → More options) described below is fully built —
> `frontend/index.html`'s `#screen-setup`, `renderPlayers()` (Step 1),
> `NEW_GAME_MODE_OPTIONS`/`renderSetupStep2Content()` (Step 2, including the
> "League Game" entry backed by `docs/league-mode-roadmap.md`'s fixture work),
> and the relocated per-mode option blocks (Step 3) — with every one of this
> doc's own resolved open questions implemented as designed: the flat
> player-count-filtered dropdown, Daily Challenge's check-on-selection
> blocking message, the dropped H2H banner, and the League Game top-of-
> dropdown entry. Full mechanics: `REFERENCE.md` §20. This doc's own design
> below is kept as-written for context, same standing convention as every
> other shipped roadmap doc in this repo.

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
   player") and a 6-player cap. Also holds two conditional, easy-to-miss
   elements keyed off the two currently-selected names: `#h2h-banner`
   (`updateH2HBanner()` — a live H2H record line, e.g. "Alice leads 3–1")
   and `#league-picker-wrap` (`updateLeaguePicker()` — a "Log to league:"
   dropdown, shown only when the pair's category matches 2+ active leagues).
   Both are being redesigned — see Step 2 below.
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
  chosen yet at this point in the new flow — **resolved**: rather than letting
  a player pick 2+ players here and then hit a conflict in Step 2, Step 2's
  dropdown simply never offers those modes once 2+ players are selected — see
  "Practice-only vs. H2H-eligible modes" under Step 2 below.

### Step 2 — "Choose a game"

- **Player-count-driven default**: with exactly one player selected, default
  to Practice and label the step **"Practice Mode"** rather than showing an
  H2H/Practice chooser at all (H2H structurally requires 2+ players, so
  there's nothing to choose between with only one).
- **One flat dropdown of every game type**, replacing today's three separate
  controls (Mode row + Practice-type sub-toggle + X01/Cricket segmented
  toggle) with a single list, every entry listed individually with no
  sub-grouping: **Daily Challenge** (listed first — see its own subsection
  below for how the "already attempted" check works), **X01**, **Cricket**,
  **Just Chuckin' It**, **Doubles Practice**, **Ghost Mode**, **Checkout
  Trainer**, **Around the Clock**, **Around the World**. **Resolved**: the
  original notes' "other game modes" line was shorthand for "whatever I
  forgot to list, or hasn't been built yet" — not a literal menu entry or
  group. There's no catch-all bucket to design: today's already-built modes
  (Checkout Trainer, Around the Clock, Around the World) each get their own
  flat entry like everything else, and any future mode (Killer, Baseball,
  etc., once actually built per `docs/game-modes-roadmap.md`) just adds one
  more flat entry to this same list when it ships — nothing structural to
  reserve a place for now.
- **X01 flavor**: selecting X01 reveals a second dropdown — 501/301/170/101 —
  the same four values `#start-score-select`/`pickStartSelect()` already
  offer, just surfaced conditionally instead of always-visible.
- **How-to-play blurb**: after picking a game type, show a brief explanation
  of how to play it. Today this exists for only 4 modes (Chuckin/Checkout
  Trainer/Clock/World's `-info-section` blocks); this generalizes the same
  pattern to *every* mode, including the ones that currently have none (X01,
  Cricket, Doubles Practice, Daily Challenge, Ghost, and H2H/Practice
  generally) — new copy needs writing for each.
- A **Continue** button advances to Step 3. A **Back** button at the bottom of
  the screen returns to Step 1, preserving whatever was already selected here
  (see "Back navigation" below).

#### Daily Challenge: check on selection, not before

**Resolved**: the same-day-attempt check is **not** made upfront to decide
whether to show or reorder the Daily Challenge entry — it's always listed
first, unconditionally. The check happens the moment a player *selects* it
(reusing the existing `/api/challenges/status` call `startGame()` already
makes today, just moved from Play Now time to selection time):

- **Not yet attempted today**: proceeds exactly like any other mode — shows
  its how-to-play blurb, Continue enabled.
- **Already attempted today**: instead of the how-to-play blurb, show a
  blocking message — something like *"You've already attempted today's Daily
  Challenge. Please come back tomorrow."* — with Continue disabled for this
  selection. The player can still pick a different entry from the dropdown
  and proceed normally; only Daily Challenge itself is blocked for the rest
  of the day.

#### H2H banner: dropped

**Resolved**: `#h2h-banner`'s live H2H-record line is not carried into the
new flow — dropped entirely, at least for now. It's used nowhere else in the
codebase (`updateH2HBanner()`, `/api/players/h2h`, and the `#h2h-banner`
element/CSS exist only inside `#screen-setup`), so removing it from the new
flow means deleting this dead code as part of implementation rather than
leaving it unreachable.

#### "League Game": a top-of-dropdown quick-start entry

**Resolved** (supersedes the small inline `#league-picker-wrap` dropdown):
rather than a "log to league?" picker tucked into the Players section,
**"League Game" becomes its own entry at the top of Step 2's dropdown** —
above Daily Challenge — whenever the two currently-selected players have a
**pending fixture** (a scheduled-but-unplayed match) in a shared active
league. This is new backend work, not just a frontend move — see
`docs/league-mode-roadmap.md`'s new "League fixtures / pending matches"
section for the full design (a new `league_fixtures` table and a
pending-fixture lookup endpoint; today's league mode has no concept of an
unplayed pairing to check against, only after-the-fact category matching).

- **Check timing**: runs once Step 1 completes (both players picked,
  "No, continue" pressed) — the same moment `contexts` filtering already
  needs the final player count for, so this is one combined lookup, not a
  separate round trip.
- **`contexts`**: `h2h` only (a league fixture always involves exactly the 2
  players it was generated for) — see the updated table below.
- **Selecting it**: auto-fills the game type/category from the matching
  league (skipping X01-flavor/Cricket-classic-vs-custom questions when the
  league's category already pins them) and carries the fixture's id through
  to `startGame()`, so the resulting game gets linked back to that fixture
  directly — "an easy way to begin the league match with the custom league
  settings," per the original request. Step 3 still asks for legs/sets,
  since a league never fixes match format (unchanged existing behavior). If
  the pair shares 2+ pending fixtures across different leagues, selecting
  "League Game" reveals a secondary "Which league match?" dropdown, the same
  pattern as X01's flavor dropdown.
- **Not shown at all** when there's no pending fixture for the pair — this
  fully replaces today's narrower "only when 2+ leagues are simultaneously
  eligible by category" trigger, since the new fixture-based check doesn't
  need a category to already be chosen to know a match is owed.

#### Practice-only vs. H2H-eligible modes

**Resolved**: rather than resolving the sequencing conflict at the moment a
conflicting mode is picked, Step 2's dropdown is filtered by player count
before it's ever shown — the conflict simply never arises. Each entry in the
unified "what am I playing" list carries a `contexts` flag (a small new data
structure, e.g. `NEW_GAME_MODE_OPTIONS`, decoupled from — but referencing —
the existing `GAME_TYPES`/`setup.mode` split, since Daily Challenge and Ghost
Mode aren't `GAME_TYPES` entries today, they're `setup.mode` values that
happen to force `gameType='x01'`) saying whether it's offered solo, in H2H,
or both:

| Entry | `contexts` |
|---|---|
| League Game | `h2h` only, and only shown when a pending fixture exists for the pair (see below) |
| X01 | `practice`, `h2h` |
| Cricket | `practice`, `h2h` |
| Daily Challenge | `practice` only |
| Just Chuckin' It | `practice` only |
| Doubles Practice | `practice` only |
| Ghost Mode | `practice` only |
| Checkout Trainer | `practice` only |
| Around the Clock | `practice` only |
| Around the World | `practice` only |

With exactly 1 player selected, Step 2 shows every entry (all of them support
`practice`). With 2+ players selected, Step 2 shows **only X01 and
Cricket** — today's actual H2H-eligible set — nothing else is offered, so
there's no "silently drop players back to 1" behavior to design around. This
also directly answers the earlier "how does H2H get chosen" question: with
2+ players, the only two entries available are H2H-eligible by construction,
so picking either one *is* choosing H2H — no separate explicit H2H toggle is
needed in the new flow (today's standalone `H2H` mode button goes away).
A useful side effect worth noting for whoever implements this: today's
per-mode `if` branches that hide `#h2h-options` (`setMode()`, several call
sites) could likely read this same `contexts` flag instead of repeating the
mode list — not required for this roadmap item, just a cleanup opportunity
it exposes.

### Step 3 — "More options"

- **Practice games**: mode-specific extras surface here — Checkout Trainer's
  Freeform vs. Checkout Blitz toggle plus its four difficulty tiers (Under 40
  / Under 100 / Over 100 / Full Range, already shipped per
  `docs/archive/checkout-trainer-roadmap.md`), Ghost's leg picker
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
  validated or what `game` object gets built. A **Back** button at the bottom
  of the screen returns to Step 2, preserving the game-type/flavor choice
  already made there.

## What doesn't change

- **No data model impact, except for "League Game."** `setup`'s shape,
  `startGame()`'s validation, and the `game` object it builds (via
  `GAME_TYPES[gameType].newMatchPlayer(...)`) stay the same for every other
  entry — this is purely a restructuring of *when/how* the existing controls
  are shown, not a change to what data New Game collects or sends for them.
  The one exception is "League Game" above: it depends on new backend work
  (a `league_fixtures` table and a pending-fixture lookup endpoint) tracked
  separately in `docs/league-mode-roadmap.md`, not something this doc's own
  frontend restructuring can deliver alone.
- **No change to any individual control's own logic** — Cricket's exact-7
  validation, Checkout Trainer's difficulty tiers, Ghost's leg-picker data
  source, the 6-player cap, and `startGame()`'s per-mode checks all carry over
  unmodified; only their surrounding screen/step changes.

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility**: a multi-step wizard raises new concerns beyond today's
  single static page — focus must move to each new step's first control as it
  appears (not silently stay on a now-hidden Step 1 button, and not silently
  stay on a now-hidden Step 2/3 control after Back is pressed either), and
  step changes need an `aria-live` announcement so screen-reader users know
  the screen advanced. **Resolved**: back navigation is a persistent Back
  button at the bottom of Steps 2 and 3 (Step 1 has none, being the first
  step) — it must restore, not reset, whatever was already selected on the
  step being returned to. The "how-to-play" blurbs are plain text and
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

None remaining specific to this doc — the open questions for "League Game"
(fixture generation, single vs. double round-robin, manual fixtures, and its
interaction with today's category-based ambiguity picker) live in
`docs/league-mode-roadmap.md`'s new "League fixtures / pending matches"
section, since they're backend design questions, not New Game screen ones.

## Suggested build order (all 7 steps shipped 2026-07)

1. ✅ Wizard shell (step container + Continue/Play Now/Back buttons, focus
   management, `aria-live` step announcements via the existing `announce()`/
   `#sr-announcer`) — `showSetupStep()`/`setupBackTo()`, restoring rather than
   resetting prior-step state.
2. ✅ Step 1 (Who's playing?) — `renderPlayers()` rewritten into the select →
   "Add someone else?" prompt loop, same function name so every existing
   caller (`onSlotChange`, `addExistingPlayer`/`addNewPlayer`, `removePlayer`,
   `shufflePlayers`, `setMode()`'s solo-mode truncation) needed no signature
   change.
3. ✅ Step 2 (Choose a game) — `NEW_GAME_MODE_OPTIONS`'s `contexts` flag per
   entry, `setupVisibleOptions()` filtering by player count, the collapsed
   flat dropdown (Daily Challenge through Around the World, plus Baseball —
   shipped after this doc was first written, folded in as one more flat entry
   per this doc's own "any future mode just adds one more entry" framing), the
   X01-flavor second dropdown, the Daily Challenge same-day check moved to
   selection time (`renderSetupChallengeBlurb()`), and a how-to-play blurb for
   every entry.
4. ✅ Step 3 (More options) — every mode's existing options block relocated
   under the new step with zero behavior change; Cricket's classic/custom
   picker is the same shared control for practice and H2H it always was.
5. ✅ `#h2h-banner`/`updateH2HBanner()` and `#league-picker-wrap`/
   `updateLeaguePicker()` deleted as dead code (the latter superseded by the
   League Game entry rather than merely dropped); the now-frontend-unreachable
   `GET /api/players/h2h` HTTP route was also removed — `getH2HRecord()` the
   DB function stays, since per-player export/import and other backend code
   still call it directly (see `REFERENCE.md` §18).
6. ✅ Play Now wired to the existing `startGame()` unmodified; every mode
   (X01 H2H/practice, Cricket both variants, Baseball, Doubles Practice, Just
   Chuckin' It, Ghost — including the `raceLeg()` entry point's jump straight
   to Step 3 — Daily Challenge both allowed and same-day-blocked, Checkout
   Trainer, Around the Clock/World, and League Game with both 1 and 2+
   pending fixtures) verified end-to-end with Playwright against a live
   server; no committed Playwright suite exists in this repo (ad hoc
   verification only, matching `docs/testing-and-observability-roadmap.md`'s
   own current state).
7. ✅ League Game wired up against `docs/league-mode-roadmap.md`'s shipped
   fixture endpoint/param — `setupGoToStep2()`'s pending-fixture fetch,
   `applyLeagueGameSelection()`, the "which league match?" secondary dropdown.
