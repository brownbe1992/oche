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

| Check | Guards |
|---|---|
| `results-takeover` | Scoreboard and winner banner survive a leg win; play controls hide and restore across Next leg; results card is scrollable when it overflows; a whole-session summary clears the stale scoreboard. Portrait and landscape. |
| `new-game` | Step 1 keeps a working Continue *and* reachable per-game options when the selected row's category collapses; keyboard activation of buttons nested inside activatable cards. |
| `ghost-picker` | Deep-linked "Race this leg" arms the exact leg asked for; an unfindable one arms nothing and says so; an empty filter clears a stale selection; the deep link costs one fetch. |
| `scoring-modes` | X01, Cricket, Around the Clock and Checkout Trainer each still render and accept darts, with the right shell (slots row, undo labels, enter button) for their type. |
| `home-settings` | Home ticker hides with no activity and shows with some; a Settings tile summary tracks a script-driven change. |

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

**Rate limiting is the trap that wastes the most time.** `backend/server.js`
allows 300 requests per 60s per IP. Driving a few full games burns that, and
once tripped the server 429s *everything* — including the next check's initial
page load, which then fails in a way that looks nothing like rate limiting.
`lib.waitForServer()` blocks until a real 200 and the runner calls it between
checks; keep fixtures small (three legs is plenty) and never run checks
concurrently.

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
