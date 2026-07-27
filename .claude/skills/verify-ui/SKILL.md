---
name: verify-ui
description: Run Oche's browser-driven UI regression checks against a real running app, and write new ones. Use this whenever you change frontend/index.html, frontend/scoring.js or frontend/display.html — especially the scoring screen, the results/GAME OVER screens, the New Game wizard, or the Ghost leg picker — and before merging any frontend branch. Also use it when asked to "verify the UI", "check nothing's broken on screen", "test the scoring screen", or to confirm a layout change didn't regress anything. The backend node:test suite cannot see rendered behaviour at all, so this is the only thing standing between a layout edit and a broken screen in a real game.
---

# Verifying Oche's UI

`backend/test/` (1305 tests, `cd backend && npm test`) covers the maths: stat
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

250 assertions across eight checks:

| Check | Guards |
|---|---|
| `results-takeover` | Scoreboard and winner banner survive a leg win; play controls hide and restore across Next leg; results card is scrollable when it overflows; a whole-session summary clears the stale scoreboard. Portrait and landscape. |
| `new-game` | Step 1 keeps a working Continue *and* reachable per-game options when the selected row's category collapses; keyboard activation of buttons nested inside activatable cards. |
| `ghost-picker` | Deep-linked "Race this leg" arms the exact leg asked for; an unfindable one arms nothing and says so; an empty filter clears a stale selection; the deep link costs one fetch. |
| `scoring-modes` | X01, Cricket, Around the Clock and Checkout Trainer in depth — the right shell (slots row, undo labels, enter button) for each shape. |
| `live-shell` | Every live-capable type in `GAME_TYPES` renders a lane or a stage on /display at 1920x1080, draws its board where it declares a stage, shows the throw strip, and leaks no markup into visible text; plus the post-leg result view (verdict line, one lane per player, tally band replacing the strip, and the full-screen banner NOT covering it). |
| `all-game-types` | Every non-dispatchOnly type in `GAME_TYPES` starts, reaches the game screen with exactly one input surface live, takes a dart without throwing, and renders its completion panel (or declares `noCompletionStats`) against real player objects. |
| `turn-loop` | Every type in `GAME_TYPES` goes throw → commit → undo and comes back to byte-identical state. Deliberately carries no per-mode expected numbers (the rules have unit tests in `backend/test/`); what it pins is that the RIGHT FUNCTION ran, which is the failure mode of registry-dispatched turn handling — a wrong branch there produces a wrong score, not a wrong picture. A mode whose undo is deliberately unreachable past a visit boundary (Killer) is detected and reported rather than skipped silently. |
| `save-resume` | Pausing a game does not lose the visits just thrown. Throws three visits, calls `DB.saveGame()` and reads the resume payload with zero delay, and requires every turn to be there. The defect it guards is browser request ordering (a save resolving ahead of its still-queued turn writes), which no `backend/test` coverage can see — the backend was correct throughout. |
| `live-scoreboard` | The `/display` second screen picks up players, updates on a scored visit, renders an end-of-leg card, and switches renderer for Cricket. |
| `home-settings` | Home ticker hides with no activity and shows with some; a Settings tile summary tracks a script-driven change. |

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
