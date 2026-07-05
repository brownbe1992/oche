# Testing & Observability — Design Roadmap & Standing Checklist

> Status: **Part A (observability) ✅ Done**, including the "longer-term, not urgent"
> items — the top-level `catch` in `backend/server.js` logs 5xx errors both to
> `console.error` (v0.6.2) and, as of 2026-07, to a persistent `server_errors` table
> (`backend/db.js`) via `db.logServerError()`, pruned to the most recent 500 rows on
> every insert (the "rotating log" — persists across container restarts, unlike
> stdout). An admin-only `GET /api/errors` feeds a **Server Errors** section in
> Settings → Admin & Danger Zone. **Part B (automated testing) ✅ Done for its
> stated v1 scope** (2026-07) — both originally-planned first targets are complete:
> `evaluateVisit()`/`evaluateVisitCricket()`/the checkout route calculator are
> extracted to `frontend/scoring.js` (a dual-mode file: a plain `<script src>` in
> the browser, `require()`-able from a test, zero behavior change — verified via a
> full Playwright regression of real gameplay after the extraction), and
> `backend/db.js`'s core stat formulas, Cricket stats, Daily Challenge streak/
> personal-best logic, badge semantics, checkout-history/dart-analytics functions,
> `getOnThisDay`'s priority ordering, H2H record/summary, the game-lifecycle
> hooks, `addTurn()`'s input validation, the auth model, and player CRUD/cascade
> + the settings store all have committed `node:test` suites
> (`backend/test/*.test.js`, 11 files, 161 assertions total — every formula named
> in an earlier draft of this doc's "not yet tested" list is now covered).
> `npm test` runs the whole suite (zero new dependency), and
> `.github/workflows/test.yml` runs it on every push/PR, closing this doc's own
> open CI question. Writing this suite found and fixed 3 small, real bugs
> (`addTurn()` silently coercing an explicit `0`/garbage input to a valid default
> instead of rejecting it; `addPlayer()` missing an `await` on its PIN-hash write)
> — exactly the kind of regression this suite exists to catch going forward.
> Like `docs/accessibility-roadmap.md`,
> this was partly a concrete near-term project (now done) and partly a standing
> practice for every future feature (test coverage for core logic, ongoing per
> CLAUDE.md) — the "not aiming for exhaustive coverage" framing below still holds:
> this is a safety net around the highest-risk shared logic, not 100% coverage, and
> new calculations keep extending the same suite going forward.
>
> **Size**: both parts are now done — observability was trivial, testing's v1 slice
> was the "session or two of work" this doc estimated. **Usefulness**: high for
> both — observability gives real self-hosted visibility, and the test suite now
> actively protects the highest-risk shared logic (bust/win rules, Cricket's mark
> accumulation, checkout routes, the core stat formulas) against regressions —
> including retroactive coverage for item 10 (the X01-to-plugin refactor), whose
> `GAME_TYPES.x01.evaluateVisit` is the exact function `scoring.test.js` now covers.

## Goal

Give the project a regression safety net as more features land on top of it, and
give a self-hosting admin some visibility when something breaks — without
introducing new dependencies, matching the project's existing "dependency-free"
identity.

## The evidence (this session's audit)

- **Zero automated tests exist in the repo** — no test files, no test script in
  `backend/package.json`. Every verification this session (and prior sessions) has
  been manual: spinning up a real server on a scratch database and driving it with a
  headless browser.
- **Server errors are never logged server-side.** The top-level `catch` in
  `backend/server.js` sends the error to the client (`send(res, err.status || 500,
  { error: err.message })`) but never calls `console.error` or anything similar. If a
  request 500s, the only record of it is whatever the client happened to see — an
  admin running this at home has no way to know something broke unless a player
  reports it.

## A. Automated testing

> **Status: ✅ Done for v1 scope** (2026-07). Both targets below are complete.

- ~~**Use Node's built-in `node:test` + `node:assert`**~~ ✅ Done — no new
  dependency; `backend/package.json`'s `"test": "node --test"` script runs every
  `backend/test/*.test.js` file.
- ~~**Highest-value, lowest-effort first target**: the pure scoring logic in
  `frontend/index.html`~~ ✅ Done — `evaluateVisit()`, `evaluateVisitCricket()`, and
  the checkout route calculator (`coFinish2`/`coFinish3`/`checkoutHint()`) are
  extracted to `frontend/scoring.js` (see REFERENCE.md §1 for the exact
  dual-mode-loading mechanism) and covered by `backend/test/scoring.test.js` (28
  assertions: every `evaluateVisit` bust/win branch, Cricket mark accumulation/
  opponent-gating/win-condition edge cases, and checkout-route correctness
  including known routes, bogey numbers, and `maxDarts` limiting).
- ~~**Second target**: `backend/db.js`'s query functions~~ ✅ Done, and then some —
  `db.x01-stats.test.js` (computeStats/getSummary/getHomeExtra/
  getPlayerStatBubbles/getPersonalBests/getMetricHistory parity),
  `db.cricket-stats.test.js` (Cricket's stat bubbles/personal bests/leaderboards,
  plus the X01/Cricket isolation regression), `db.leaderboards.test.js` (the X01
  180s/Big Fish/nine-darter global leaderboards, Around the World progress),
  `db.finishes.test.js` (getTopFinishes/getTopFinishesAll/getCheckoutRoutes/
  getDartAnalytics — busted-turns-excluded rule included), `db.on-this-day.test.js`
  (the full priority-ordering/tiebreak/date-matching logic), `db.h2h.test.js`
  (getH2HRecord/getH2HSummary), `db.challenges.test.js` (Daily Challenge streak/
  personal-best/reset-cascade semantics), `db.badges.test.js` (award/revoke count
  semantics), `db.lifecycle-hooks.test.js` (the game-lifecycle hooks, item 4),
  `db.turn-validation.test.js` (addTurn()'s full input validation), `db.auth.test.js`
  (login/PIN lockout thresholds, session lifecycle, admin CRUD), and
  `db.players-and-settings.test.js` (player CRUD/cascade, the settings store) —
  each against its own scratch SQLite database, hand-verified expected values,
  same technique used manually throughout this project's sessions, now permanent.
  Writing these surfaced 3 small real bugs, fixed in the same pass: `addTurn()`'s
  `set`/`leg`/`scored` fields used a bare `x || default` fallback that silently
  coerced an explicit `0` or non-numeric garbage into a valid default instead of
  rejecting it (now `x != null ? x : default`, so the existing range checks
  actually see the bad value); and `addPlayer()` created a player with a PIN
  without `await`-ing the PIN-hash write, so its own `hasPin` field (and
  `POST /api/players`'s HTTP response) could report `false` for a player that was,
  in fact, just given one.
- **Still not aiming for exhaustive coverage.** The goal remains a safety net
  around the highest-risk shared logic, not literally every line in `db.js` —
  e.g. `getSettings`/`updateSettings`'s full validation surface (mirrored in
  `server.js`'s route-level checks) and the exact concurrent-request race the
  `RETURNING`-based lockout-counter fix closes (REFERENCE.md §9) aren't
  exercised here; node:test's sequential execution can't meaningfully reproduce
  genuine concurrency. Per CLAUDE.md's standing convention, any new calculation
  (or any deeper edge case in the above, if touched again) gets a test added to
  the relevant file at that point.

## B. Observability

- ~~**Trivial, immediate fix**: add `console.error` (with a timestamp) to the
  top-level `catch` block in `server.js`~~ ✅ **Done** (v0.6.2).
- ~~**Longer-term, not urgent**: a rotating log file or a "recent errors" view in
  Settings~~ ✅ **Done** (2026-07) — turned out cheap enough to just build rather than
  leave as a "keep in mind" item. `backend/db.js`'s `server_errors` table (pruned to
  the most recent 500 rows on every insert — the rotation) plus a **Server Errors**
  section in Settings → Admin & Danger Zone, fed by an admin-only `GET /api/errors`.
  See §1 of `REFERENCE.md` for the exact mechanism.

## Suggested build order

1. ~~**(Trivial)** Add server-side error logging to the top-level `catch` in
   `server.js`.~~ ✅ **Done** (v0.6.2). ~~Persist it (a rotating log file) and add a
   "recent errors" view in Settings~~ ✅ **Done** (2026-07) — see §B above.
2. ~~Introduce `node:test` as the runner; extract `evaluateVisit()`/checkout math
   into a testable form and write the first suite against it.~~ ✅ **Done**
   (2026-07) — `frontend/scoring.js` + `backend/test/scoring.test.js`.
3. ~~Add a `db.js` integration-test suite using scratch databases.~~ ✅ **Done**
   (2026-07) — 10 `db.*.test.js` files covering stat formulas (X01 and Cricket),
   leaderboards, checkout/dart-analytics, On This Day, H2H, Daily Challenge,
   badges, the game-lifecycle hooks, `addTurn()` validation, auth, and player/
   settings CRUD (plus `db.server-errors.test.js` from Part A). Retroactive
   coverage for item 10 (the X01-to-plugin refactor) is satisfied by
   `scoring.test.js` testing `GAME_TYPES.x01.evaluateVisit` itself.
4. ~~Add `npm test` to `backend/package.json`~~ ✅ **Done** (2026-07, `node --test`,
   zero new dependency). ~~Whether CI is worth adding~~ ✅ **Done** —
   `.github/workflows/test.yml` runs `npm test` on every push/PR. Revisit coverage
   each time a major roadmap item lands, per the standing practice below.

## Standing practice going forward

Every new calculation (a stat formula, an achievement/badge trigger condition, any
other game-logic math) gets a committed, re-runnable test in the same change that
adds it — not retrofitted later, and not replaced by manual/Playwright verification
alone. If no runner exists yet at the point this comes up, build the minimal version
needed to hold that one test rather than deferring it to a separate "do testing
properly" session. See `CLAUDE.md` for the binding version of this statement.

## Decisions made (2026-07, resolved rather than left open)

- **Minimal shim, not real ES modules.** `frontend/scoring.js` is a dual-mode file:
  every function/const is a plain top-level declaration (a browser-loaded global
  via `<script src>`, unchanged from how it worked inline), with a CommonJS
  `module.exports` block at the bottom that only activates under Node (guarded by
  `typeof module !== 'undefined'`). Chosen over real ES modules because the app's
  explicit "no build step, no framework" identity (REFERENCE.md §1) would be
  compromised by introducing `import`/`export` + a bundler; the shim adds zero new
  tooling and is a straight cut-and-paste move of existing code, not a rewrite.
- **CI added.** `.github/workflows/test.yml` runs `npm test` on every push and PR —
  no code prerequisite was blocking this once the suite existed, so it was built
  in the same pass rather than left for a future session.

## Remaining open questions

- The formulas named in an earlier draft of this section (`getDartAnalytics`,
  `getTopFinishes`/`getCheckoutRoutes`, `getOnThisDay`'s priority ordering) are
  now covered (2026-07) — see §A. Whether to proactively chase the smaller
  remaining gaps noted there (`getSettings`/`updateSettings` validation, genuine
  concurrent-request lockout races) or only add coverage when one of them is
  next touched is still open; the standing practice below is the minimum bar,
  not a ceiling.
