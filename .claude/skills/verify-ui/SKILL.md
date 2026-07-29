---
name: verify-ui
description: Run Oche's browser-driven UI regression checks against a real running app, and write new ones. Use this whenever you change frontend/index.html, frontend/scoring.js or frontend/display.html — especially the scoring screen, the results/GAME OVER screens, the New Game wizard, or the Ghost leg picker — and before merging any frontend branch. Also use it when asked to "verify the UI", "check nothing's broken on screen", "test the scoring screen", or to confirm a layout change didn't regress anything. The backend node:test suite cannot see rendered behaviour at all, so this is the only thing standing between a layout edit and a broken screen in a real game.
---

# Verifying Oche's UI

`backend/test/` (1,735 tests, `cd backend && npm test`) covers the maths: stat
formulas, achievement triggers, DB queries, replay logic. It never loads a
browser, so it cannot see whether a screen still *works* — and several real
regressions have lived precisely in that blind spot:

- A results screen that destroyed the scoreboard and the "X wins the leg"
  banner it had just built, leaving the summary reporting on nothing.
- A New Game step that lost its only Continue button, stranding the wizard.
- A second fix for that which restored the button but not the options it sits
  with, so games silently started on stale defaults.
- Nested buttons that worked by mouse and were completely dead by keyboard.
- A results card that overflowed a short screen with no way to scroll to the
  rest of it.

Every one of those passed `npm test`. This suite exists for that gap.

## Run it

```bash
node .claude/skills/verify-ui/scripts/run.js              # all checks
node .claude/skills/verify-ui/scripts/run.js ghost-picker # one check
node .claude/skills/verify-ui/scripts/run.js --list
```

Exit code 0 means green. Failures are listed at the end with the measured value,
so a failure usually tells you what broke without needing a rerun.

The runner starts its own server on port 8146 against a scratch database, so it
neither disturbs a dev server on 8046 nor writes its throwaway players and legs
into a database you care about. If something is already listening on 8146 it
reuses that instead. Expect a few minutes: the checks drive real games, in
series, on purpose (see Rate limiting below).

## What it covers

506 assertions across nineteen checks.

**Each check's assertion count is recorded in `scripts/run.js`'s `CHECKS` table, and
running fewer than that fails the suite.** That is the check on the checks: a suite
that only reports what it happened to run cannot tell "everything passed" from "most
of it never executed", and both print green. When two checks threw on a CI runner, the
suite reported *385/387 assertions passed* — the denominator had quietly shrunk with
the numerator, so 72 missing assertions looked like a healthy run with two failures.
Worse, a check that ran *nothing at all* used to print `0/0 assertions passed` and
`All checks green`. Adding assertions therefore means raising that number in the same
commit; the suite tells you which way it disagrees and by how much.

| Check | Guards |
|---|---|
| `results-takeover` | Scoreboard and winner banner survive a leg win; play controls hide and restore across Next leg; results card is scrollable when it overflows; a whole-session summary clears the stale scoreboard. Portrait and landscape. |
| `new-game` | Step 1 opens with no game selected and every category collapsed; expanding a category then picking a game renders its settings panel *inside that category* — never stranded below the ledger — with Continue and reachable per-game options; collapsing hides the panel and re-expanding restores the selection; enforced for every category, not just the first. Plus keyboard activation of buttons nested inside activatable cards. |
| `ghost-picker` | Deep-linked "Race this leg" arms the exact leg asked for; an unfindable one arms nothing and says so; an empty filter clears a stale selection; the deep link costs one fetch. |
| `scoring-modes` | X01, Cricket, Around the Clock and Checkout Trainer in depth — the right shell (slots row, undo labels, enter button) for each shape. |
| `live-shell` | Every live-capable type in `GAME_TYPES` renders a lane or a stage on /display at 1920x1080, draws its board where it declares a stage, shows the throw strip, and leaks no markup into visible text; plus the post-leg result view (verdict line, one lane per player, tally band replacing the strip, and the full-screen banner NOT covering it). |
| `all-game-types` | Every non-dispatchOnly type in `GAME_TYPES` starts, reaches the game screen with exactly one input surface live, takes a dart without throwing, and renders its completion panel (or declares `noCompletionStats`) against real player objects. |
| `turn-loop` | Every type in `GAME_TYPES` goes throw → commit → undo and comes back to byte-identical state. Deliberately carries no per-mode expected numbers (the rules have unit tests in `backend/test/`); what it pins is that the RIGHT FUNCTION ran, which is the failure mode of registry-dispatched turn handling — a wrong branch there produces a wrong score, not a wrong picture. A mode whose undo is deliberately unreachable past a visit boundary (Killer) is detected and reported rather than skipped silently. |
| `save-resume` | Pausing a game does not lose the visits just thrown. Throws three visits, calls `DB.saveGame()` and reads the resume payload with zero delay, and requires every turn to be there. The defect it guards is browser request ordering (a save resolving ahead of its still-queued turn writes), which no `backend/test` coverage can see — the backend was correct throughout. |
| `leg-reset` | A new leg starts from a new leg's state, for every type that reaches one. Fingerprints `game`'s own state at leg 1, dirties it with a real visit, crosses a leg boundary and requires the fingerprint back — generic rather than a per-mode field list, so a mode that adds a game-level counter and forgets to reset it is caught without extending this file. Sweeps only the types that actually call `startNextLeg()`, and requires every type declaring a real `resetLegState` to be among them. |
| `resume-fidelity` | A saved game comes back as the game that was paused, for every type in `SAVABLE_GAME_TYPES`. Resume is replay, not snapshot — the whole position is reconstructed by re-running the recorded turns through `scoring.js`'s `rebuild*State` functions — so a wrong one yields a completely normal-looking game that simply isn't the one the player paused. Plays a scripted multi-sector run, saves through the real endpoint, resumes through the real `resumeGame()`, and requires an identical fingerprint. Every savable type goes through one assertion. It previously carried a precisely-asserted known gap for the four solo-run modes whose rebuilds never replayed dart counters; asserting that gap rather than excluding it is what drove the fix (item 75) — including rejecting a first attempt that got Dead Man Walking's leg boundary wrong. It also drives a real three-player Baseball bow-out through save and resume: `dnf` used to be write-only, so saving such a match was blocked outright (409) rather than resumed into a state where the departed player was reinstated **and** the inning counter had silently drifted. |
| `pad-reuse` | The dart pads are built once and toggled, not rebuilt per dart — and still update. Asserts BOTH, because they pull against each other: the buttons must be the same nodes after a dart (stamped before, looked for after — a rebuild is invisible to a check that only reads the rendered result, which is why the per-dart rebuild survived so long), and Cricket's marks glyph, `closed` class and `aria-label` must still move when a number closes (the naive way to stop rebuilding is to stop rendering, which freezes the pad while the real state moves underneath). Reads the pad-owning types from the app's own `MODE_PAD_RENDERERS`. |
| `profile-a11y` | The Player Profile is navigable and audible, not just visible. Asserts a heading outline (an H2 name, no skipped levels, every collapsible section carrying a heading as well as its `<summary>` disclosure button) *structurally* rather than as a list of expected titles, so adding a section doesn't mean editing the check; that every visible button has an accessible name and the per-checkout drill buttons are told apart by theirs; and that all three scope controls announce through `#sr-announcer` when they replace the page's entire contents. |
| `route-recall` | Checkout Trainer's Route Recall sub-mode, played through the real screen. Pins the things its unit tests cannot see: that a hunt HOLDS its target across submissions (if it moved on, the mode would silently be Freeform and every unit test would still pass), that the found-so-far list is rendered at all, that a duplicate does not take the bust styling every other wrong answer uses, and that the 1-2 dart tiers reveal the total while the 3-dart tier shows no denominator — that split being the whole reason the mode has tiers. |
| `mode-state-hygiene` | Leaving a mode leaves nothing of it behind — per-mode state that survives into the next game shows up as a scoreboard describing a game nobody is playing. |
| `challenge-scoreboards` | Every Daily Challenge format says the same true thing on both scoreboards (the in-app one and `/display`), which previously disagreed — `/display` showing "1 ton · 2/6 visits" while the app showed a filler countdown from 1000 that reads as a target the player is meant to be chasing. |
| `keyboard` | The app is operable without a pointer: focus is visible and light enough to see on the dark board (asserted by relative luminance, not a string match), modals move focus in, trap Tab both ways, close on Escape and restore focus to whatever opened them, and SOME input mode offers a full keyboard scoring path. That last one names no mode on purpose — the pad is the path today and the board is not, but that is a known gap, not a rule, and an assertion pinning it would fail on the day someone closes it. |
| `live-scoreboard` | The `/display` second screen picks up players, updates on a scored visit, renders an end-of-leg card, and switches renderer for Cricket. The end-of-leg assertions read the **card**, not its heading: a leg is announced in two pushes (the controller's own "X wins the leg" wording, then later pushes with `message:''` that fall through to "X takes the leg"), so any check pinning one heading string is pinning a race — this one did, matching only the transient first state and failing on the settled one. What it asserts instead is the payload the contract actually carries: both players lane'd, the winner marked, and the winner's darts and average — which come straight from the `legSummary` winner row, the field mapping that has silently broken before. |
| `home-settings` | Home ticker hides with no activity and shows with some; a Settings tile summary tracks a script-driven change. Also that `app.css` reached the page at all — a wrong `<link href>` doesn't 404, it serves index.html in answer to a CSS request, and every other assertion here still passes against a completely unstyled app. |
| `home-leaderboards` | Every game type's Home leaderboard renders, on both tabs, driven through the app's own `homeGameTypeVisible()` predicate so a new type is covered the day it is added. Exists because a 2026-07 page-coverage measurement found the fourteen `renderHomeTabBody<Type>()` functions had **never executed** in any check or test — leaderboard renderers on the landing screen with nothing exercising them, which is the shape of bug (a board sorted the wrong way round looks entirely normal) that committed tests exist here to catch. It spies on each registered renderer, so "was it called, and did it throw" is a fact rather than an inference from the panel afterwards: an earlier version asserted only "rendered markup, not stuck on Loading…" and a deliberately broken renderer passed it, because `undefined` reaches the shared leaderboard helper and becomes its empty state — which is what a healthy board looks like too against a suite with no seeded history. It does NOT assert the numbers or the sort order; that needs a seeded database (`backend/seed-dev-db.js`) and is its own piece of work. |

`all-game-types` reads the list from the app's own registry rather than one kept
here, so a new game type arrives with coverage already in place — the same
registry-driven discipline the app uses internally instead of hand-maintained
parallel lists. It goes shallow across all 16; `scoring-modes` goes deep on four
representative shapes.

`live-scoreboard` drives the controller in one page and reads `/display` in
another, which is the only way to exercise the contract between them. That seam
has a history: the controller's `legSummary` shape is an unstated contract with
the display's `summary()` card, and mismatches have produced blank end-of-leg
cards before — the sort of thing nobody notices until a match is on the TV.

## Checking a screen that needs real history behind it

The runner's scratch database starts empty, so every Home, Pulse, leaderboard
and personal-best panel renders in its zero state. That is the right default —
the checks here are about structure, and an empty DB makes them fast and
reproducible — but it means this suite cannot see a leaderboard sorted the wrong
way, a "best ever" that never updates, or a date bucket off by a day.

For those, seed a database first and point the runner at it:

```bash
cd backend && npm run seed -- --db /tmp/oche-seeded.db --games 80
VERIFY_UI_DB=/tmp/oche-seeded.db node .claude/skills/verify-ui/scripts/run.js
```

`backend/seed-dev-db.js` simulates real X01 and Cricket matches through `db.js`'s
own write path, so it cannot produce a state the app couldn't — nothing found
against it is a false positive from an impossible row. It is deterministic per
`--seed`, and the default roster's skills are spaced so every derived metric
comes out in the same order (strongest player first), which is what makes
"is this leaderboard the right way up?" a question you can actually answer.
Full mechanism: `REFERENCE.md` §35.

Note the suite still creates its own throwaway players and legs on top, so a
seeded run is a starting point, not a fixed fixture. A database you name via
`VERIFY_UI_DB` is left on disk when the run ends; only the scratch one the
runner invents for itself is deleted.

## When something fails

Failures print the measured value, and a screenshot of the screen **at the
moment the assertion failed** is written to
`/tmp/oche-verify-ui-artifacts/` (override with `VERIFY_UI_ARTIFACTS`). Look at
it before theorising: a layout failure is usually obvious on sight and ambiguous
from the numbers. Nothing is written on a green run.

Capture timing matters when adding checks — put `await rep.captureIfFailed(page,
tag)` at the point of interest, not at the end of the block. A shot taken after
the check has clicked onward shows a perfectly normal screen and explains
nothing.

## What does NOT belong here

Anything a `node:test` case can assert. Per `CLAUDE.md`, **every new stat
formula, achievement/badge trigger or other calculation gets a committed
`node:test` case in the same change** — that convention exists because eyeballed
one-off checks let real maths bugs sit undetected, and moving those assertions
into a browser suite would quietly undo it.

The dividing line: if you could assert it by calling a function with inputs and
comparing the output, it belongs in `backend/test/`. This suite is for things
that only exist once a browser has laid the page out — visibility, computed
style, focus and keyboard behaviour, what survives a re-render, how many
requests a user action costs.

## Writing a new check

Add a module under `scripts/checks/` exporting `async function run()`, register
it in the `CHECKS` map in `scripts/run.js`, and use the helpers in
`scripts/lib.js` (`withPage`, `startX01`, `winLeg`, `uniqueName`,
`makeReporter`). Existing checks are the best template — `new-game.js` is the
simplest.

Each check should be able to explain, in its header comment, what real breakage
it would have caught. A check nobody can justify tends to be one nobody
maintains.

### Five things that will otherwise cost you an afternoon

These are the environment's actual behaviour, learned by hitting each one.

**Assert computed style, not the `hidden` attribute.** An author `display` rule
outranks the UA stylesheet's `[hidden]{display:none}` no matter how weak its
selector, so an element can carry `hidden` and be fully on screen. That is
exactly how a "hidden" dartboard stayed visible behind a results card. Use
`getComputedStyle(el).display === 'none'`, or measure the rect.

**Rate limiting used to be the trap that wasted the most time**, and the fix is
worth understanding because the symptom was so misleading. `backend/server.js`
allows 300 requests per 60s per IP; driving a dozen full games burns that, and
once tripped the server 429s *everything* — including the next check's page
load, which then fails in a way that looks nothing like rate limiting. The
original defence, `waitForServer()`, blocked until a real 200 — but a 200 only
proves the window has **rolled**, not that there is budget left in it, so a
check could still exhaust the remainder partway through. That produced a
maddening pattern: exactly one check failing per full run, a different one each
time, every check passing in isolation.

`startServer()` now sets `OCHE_RATE_LIMIT_GLOBAL` high for its own throwaway
server, so the limiter is out of the picture entirely. Keep fixtures small
(three legs is plenty) and never run checks concurrently anyway — both still
make the suite faster and easier to reason about. If you point the suite at a
server you started yourself, it keeps the normal 300/60s limit and the old trap
is back.

**Top-level `let` is not on `window`.** `homeData`, `setup`, `roster` and
friends are top-level `let`/`const` in a classic script, so `window.homeData = x`
creates an unrelated property while the function under test keeps reading its
own unchanged binding. Assign bare inside `page.evaluate` — `homeData = x`. This
produced a confident false FAIL once.

**`waitUntil:'load'` intermittently hangs here**; a resource occasionally resets
in this container. Use `domcontentloaded` plus a `waitForFunction` on a real app
global (`typeof startGame === 'function'`), which is also what tells you the
inline script has finished defining what you are about to call. `withPage()`
does both.

**Drive the app through its own globals**, not by clicking the dartboard:
`setMode` / `setup` / `startGame` / `setMult` / `throwDart` / `enterTurn`.
Clicking exercises SVG hit-testing, which is a different concern and far
slower and flakier. Note also that scoring a 180 fires a full-screen moment card
that covers the page for seconds — `winLeg()` avoids it by default for that
reason.

## Environment

Playwright and its browsers live outside the repo (which has no `node_modules`
by design — the app depends only on Node built-ins):

- Chromium: `chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })`
- `NODE_PATH=/opt/node22/lib/node_modules` so `require('playwright')` resolves.
  `.claude/hooks/session-start.sh` exports this; `lib.js` falls back to it
  explicitly if the hook has not run.

Override with `VERIFY_UI_PORT`, `VERIFY_UI_DB` or `VERIFY_UI_CHROMIUM` if
needed.

## After a run

A green run is not proof the screen looks right — these assert behaviour and
geometry, not aesthetics. For anything visual, take a screenshot and actually
look at it. `page.screenshot()` inside a check, or drive the app manually and
inspect. Layout intent is still a human call.
